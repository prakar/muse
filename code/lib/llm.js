'use strict';
/**
 * QUARRY lib/llm.js — the single entry point for every LLM call.
 *
 *   const { callLLM, hasKey, setLogger } = require('./lib/llm');
 *   const r = await callLLM('gemini', prompt, { system, maxTokens, temperature });
 *   // r = { text, model, provider, tokensIn, tokensOut }
 *
 * Providers: claude | gemini | grok | openrouter
 *
 * What lives here (and nowhere else):
 *   - the one httpPost helper (with socket timeout + optional heartbeat log)
 *   - llm-model-resolver integration: resolveModel for claude/gemini/grok,
 *     getNextFreeModel round-robin for openrouter
 *   - model-level failure handling: a model that is listed live but rejected at call
 *     time (404; for Gemini also 403) is markModelBad'd and the next live candidate is
 *     tried ONCE. markModelBad is process-wide, so later calls benefit too.
 *   - optional transient retry (network errors, timeouts, 429/5xx) with linear back-off
 *
 * Callers own: prompts, budget/cost accounting (they get tokensIn/tokensOut/model back),
 * and provider *selection* (e.g. narrator: claude, then fall back to gemini).
 *
 * Options (all optional):
 *   system           system prompt string
 *   maxTokens        default 8192
 *   temperature      omitted from the request when undefined (provider default applies)
 *   timeoutMs        socket-idle timeout per request, default 10 min
 *   transientRetries extra attempts on transient failure, default 0 (fail fast)
 *   retryBackoffMs   attempt N waits N * this, default 30000
 *   label            tag added to log lines (e.g. 'mindful-wc')
 */

const https = require('https');

// llm-model-resolver is optional for claude/gemini/grok (falls back to the pinned model
// below, so a missing package degrades instead of breaking). openrouter needs it.
let resolver = null;
try { resolver = require('llm-model-resolver'); } catch (_) {}

const PROVIDERS = {
  claude:     { keyEnv: 'ANTHROPIC_API_KEY',  resolverId: 'anthropic', fallback: 'claude-sonnet-4-5', heartbeatMs: 0 },
  gemini:     { keyEnv: 'GEMINI_API_KEY',     resolverId: 'gemini',    fallback: 'gemini-2.5-flash',  heartbeatMs: 0 },
  grok:       { keyEnv: 'XAI_API_KEY',        resolverId: 'xai',       fallback: 'grok-4',            heartbeatMs: 5000 },
  openrouter: { keyEnv: 'OPENROUTER_API_KEY',                                                         heartbeatMs: 5000 },
};

const DEFAULTS = {
  maxTokens:        8192,
  timeoutMs:        10 * 60 * 1000,
  transientRetries: 0,
  retryBackoffMs:   30000,
};

const OPENROUTER_MAX_MODELS = 10;

// ---------------------------------------------------------------------------
// LOGGING — callers inject their own logger so lines land in their own log file
// ---------------------------------------------------------------------------
let _log = function (level, msg, data) {
  console.log(JSON.stringify(Object.assign({ ts: new Date().toISOString(), level, msg }, data || {})));
};
function setLogger(fn) { if (typeof fn === 'function') _log = fn; }
function log(level, msg, data) { try { _log(level, msg, data); } catch (_) {} }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function httpPost(hostname, pathStr, headers, body, o) {
  o = o || {};
  const timeoutMs = o.timeoutMs || DEFAULTS.timeoutMs;
  return new Promise(function (resolve, reject) {
    const bodyStr = JSON.stringify(body);
    const started = Date.now();
    let beat = null;
    if (o.heartbeatMs) {
      beat = setInterval(function () {
        log('info', (o.tag || 'LLM') + ' still waiting...', { elapsedSec: Math.round((Date.now() - started) / 1000) });
      }, o.heartbeatMs);
    }
    const done = function (fn, v) { if (beat) clearInterval(beat); fn(v); };

    const req = https.request({
      hostname: hostname, path: pathStr, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, headers)
    }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch (_) {}
        done(resolve, { status: res.statusCode, body: parsed, elapsedSec: Math.round((Date.now() - started) / 1000) });
      });
    });
    // Without a timeout a stalled connection hangs the whole run forever (an overnight
    // batch just stops). Generous, because reasoning models take minutes on long notes.
    req.setTimeout(timeoutMs, function () {
      const e = new Error('API request timed out after ' + Math.round(timeoutMs / 1000) + 's (' + hostname + ')');
      e.code = 'LLM_TIMEOUT';
      req.destroy(e);
    });
    req.on('error', function (e) { done(reject, e); });
    req.write(bodyStr);
    req.end();
  });
}

function httpError(label, res) {
  const detail = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  const e = new Error(label + ' error ' + res.status + ': ' + detail.slice(0, 300));
  e.status = res.status;
  return e;
}

function isTransient(e) {
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'EAI_AGAIN' || e.code === 'LLM_TIMEOUT') return true;
  return [429, 500, 502, 503, 504, 529].indexOf(e.status) !== -1;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---------------------------------------------------------------------------
// MODEL RESOLUTION
// ---------------------------------------------------------------------------
async function resolveFor(provider, key) {
  const cfg = PROVIDERS[provider];
  if (!resolver) return { id: cfg.fallback, source: 'pinned (llm-model-resolver not installed)' };
  try {
    const r = await resolver.resolveModel(cfg.resolverId, key, { fallback: cfg.fallback });
    return { id: (r && r.id) || cfg.fallback, source: (r && r.source) || 'resolver' };
  } catch (e) {
    log('warn', 'resolveModel threw, using pinned fallback', { provider: provider, err: e.message });
    return { id: cfg.fallback, source: 'pinned (resolver error)' };
  }
}

// A model can be genuinely listed by the provider's live /models endpoint and still fail
// the real call (Gemini has returned 404 "no longer available to new users" for models its
// own listing still shows - an account-tier mismatch resolveModel cannot see). Only a
// failure ABOUT THE MODEL is a reason to stop using it: a 429, a 5xx or a network error
// says nothing about the model, and marking it bad would sideline a good model for the
// rest of the run. Bounded to one re-resolve; if the second pick also fails, fail loudly.
function isModelFailure(provider, status) {
  return status === 404 || (provider === 'gemini' && status === 403);
}

async function withResolvedModel(provider, key, opts, send) {
  const cfg = PROVIDERS[provider];
  let resolved = await resolveFor(provider, key);
  log('info', 'LLM model resolved', { provider: provider, model: resolved.id, via: resolved.source, label: opts.label });
  try {
    return await send(resolved.id);
  } catch (e) {
    if (!resolver || !isModelFailure(provider, e.status)) throw e;
    log('warn', 'Resolved model failed, marking bad and re-resolving', { provider: provider, failedModel: resolved.id, err: e.message });
    resolver.markModelBad(cfg.resolverId, resolved.id);
    const next = await resolveFor(provider, key);
    if (next.id === resolved.id) throw e;   // nothing else to try - don't repeat the same failing call
    log('info', 'LLM model re-resolved after failure', { provider: provider, model: next.id, via: next.source });
    resolved = next;
    return await send(resolved.id);          // let this one throw for real if it also fails
  }
}

// ---------------------------------------------------------------------------
// PROVIDER ADAPTERS — each returns { text, model, provider, tokensIn, tokensOut }
// ---------------------------------------------------------------------------
async function callClaude(prompt, key, opts) {
  return withResolvedModel('claude', key, opts, async function (modelId) {
    const body = { model: modelId, max_tokens: opts.maxTokens, messages: [{ role: 'user', content: prompt }] };
    if (opts.system) body.system = opts.system;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const res = await httpPost('api.anthropic.com', '/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body,
      { timeoutMs: opts.timeoutMs, heartbeatMs: PROVIDERS.claude.heartbeatMs, tag: 'Claude' });
    if (res.status !== 200) throw httpError('Claude', res);

    const text  = (res.body.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    const usage = res.body.usage || {};
    if (res.body.stop_reason === 'max_tokens') log('warn', 'Claude response hit max_tokens - output truncated', { model: modelId, maxTokens: opts.maxTokens });
    if (!text) throw new Error('Claude empty response');
    return { text: text, model: modelId, provider: 'claude', tokensIn: usage.input_tokens || 0, tokensOut: usage.output_tokens || 0 };
  });
}

async function callGemini(prompt, key, opts) {
  return withResolvedModel('gemini', key, opts, async function (modelId) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: opts.maxTokens }
    };
    if (opts.temperature !== undefined) body.generationConfig.temperature = opts.temperature;
    if (opts.system) body.system_instruction = { parts: [{ text: opts.system }] };

    // Key goes in a header, not the URL, so it can never leak into a logged path or error.
    const res = await httpPost('generativelanguage.googleapis.com',
      '/v1beta/models/' + modelId + ':generateContent',
      { 'x-goog-api-key': key }, body,
      { timeoutMs: opts.timeoutMs, heartbeatMs: PROVIDERS.gemini.heartbeatMs, tag: 'Gemini' });
    if (res.status !== 200) throw httpError('Gemini', res);

    const cand  = (res.body.candidates || [])[0] || {};
    const text  = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
    const usage = res.body.usageMetadata || {};
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      log('warn', 'Gemini non-STOP finish', { model: modelId, reason: cand.finishReason, tokensOut: usage.candidatesTokenCount });
    }
    // An empty body (safety block, etc.) must be an error, not a result: callers like
    // mindful-wc would otherwise overwrite a note on disk with nothing.
    if (!text) throw new Error('Gemini empty response (finishReason: ' + (cand.finishReason || 'none') + ')');
    return {
      text: text, model: modelId, provider: 'gemini',
      tokensIn:  usage.promptTokenCount || 0,
      // thinking tokens are billed as output but reported separately from candidatesTokenCount
      tokensOut: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)
    };
  });
}

function openAiMessages(prompt, system) {
  const m = [];
  if (system) m.push({ role: 'system', content: system });
  m.push({ role: 'user', content: prompt });
  return m;
}

async function callGrok(prompt, key, opts) {
  return withResolvedModel('grok', key, opts, async function (modelId) {
    log('info', 'Grok request sent', { model: modelId, label: opts.label });
    const body = { model: modelId, messages: openAiMessages(prompt, opts.system), max_tokens: opts.maxTokens };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;

    const res = await httpPost('api.x.ai', '/v1/chat/completions',
      { 'Authorization': 'Bearer ' + key }, body,
      { timeoutMs: opts.timeoutMs, heartbeatMs: PROVIDERS.grok.heartbeatMs, tag: 'Grok' });
    const u = (res.body && res.body.usage) || {};
    log('info', 'Grok responded', { status: res.status, elapsedSec: res.elapsedSec, tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens, reasoningTokens: (u.completion_tokens_details || {}).reasoning_tokens });
    if (res.status !== 200) throw httpError('Grok', res);

    const choice = (res.body.choices || [])[0];
    if (!choice || !choice.message || !choice.message.content) throw new Error('Grok empty response');
    if (choice.finish_reason === 'length') log('warn', 'Grok response hit max_tokens - output truncated', { model: modelId, maxTokens: opts.maxTokens });
    return { text: choice.message.content, model: modelId, provider: 'grok', tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0 };
  });
}

// OpenRouter: no single model to resolve. Walk the live free-model list round-robin; a
// rate limit, error or empty answer from one model just moves on to the next.
async function callOpenRouter(prompt, key, opts) {
  if (!resolver) throw new Error('openrouter requires the llm-model-resolver package (npm install)');
  let lastErr = null;
  resolver.resetFreeModelIndex();   // fresh walk for this call

  for (let attempt = 0; attempt < OPENROUTER_MAX_MODELS; attempt++) {
    const model = await resolver.getNextFreeModel(key);
    try {
      log('info', 'OpenRouter trying model', { model: model, label: opts.label });
      const body = { model: model, messages: openAiMessages(prompt, opts.system), max_tokens: opts.maxTokens };
      if (opts.temperature !== undefined) body.temperature = opts.temperature;

      const res = await httpPost('openrouter.ai', '/api/v1/chat/completions',
        { 'Authorization': 'Bearer ' + key }, body,
        { timeoutMs: opts.timeoutMs, heartbeatMs: PROVIDERS.openrouter.heartbeatMs, tag: 'OpenRouter' });
      log('info', 'OpenRouter responded', { model: model, status: res.status, elapsedSec: res.elapsedSec });

      if (res.status === 429) { log('warn', 'OpenRouter rate-limited, trying next', { model: model }); lastErr = new Error('rate-limited: ' + model); lastErr.status = 429; continue; }
      if (res.status !== 200) { log('warn', 'OpenRouter error, trying next', { model: model, status: res.status }); lastErr = httpError('OpenRouter', res); continue; }

      const choice = (res.body.choices || [])[0];
      if (!choice || !choice.message || !choice.message.content) {
        log('warn', 'OpenRouter empty response, trying next', { model: model });
        lastErr = new Error('empty response from ' + model);
        continue;
      }
      const usage = res.body.usage || {};
      return { text: choice.message.content, model: model, provider: 'openrouter', tokensIn: usage.prompt_tokens || 0, tokensOut: usage.completion_tokens || 0 };
    } catch (e) {
      log('warn', 'OpenRouter attempt failed', { model: model, err: e.message });
      lastErr = e;
    }
  }
  throw lastErr || new Error('All OpenRouter models exhausted');
}

const ADAPTERS = {
  claude:     { fn: callClaude },
  gemini:     { fn: callGemini },
  grok:       { fn: callGrok },
  openrouter: { fn: callOpenRouter, selfRetrying: true },   // its own model rotation is the retry
};

// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------
function hasKey(provider) {
  const cfg = PROVIDERS[provider];
  return !!(cfg && process.env[cfg.keyEnv]);
}

async function callLLM(provider, prompt, options) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error('Unknown provider: ' + provider + ' (expected ' + Object.keys(PROVIDERS).join(' | ') + ')');
  const key = process.env[cfg.keyEnv];
  if (!key) throw new Error(cfg.keyEnv + ' not set');

  const opts = Object.assign({}, DEFAULTS, options || {});
  const adapter = ADAPTERS[provider];
  const maxAttempts = adapter.selfRetrying ? 1 : 1 + Math.max(0, opts.transientRetries);

  for (let attempt = 1; ; attempt++) {
    try {
      return await adapter.fn(prompt, key, opts);
    } catch (e) {
      if (attempt >= maxAttempts || !isTransient(e)) throw e;
      const delay = attempt * opts.retryBackoffMs;
      log('warn', provider + ' transient failure, retrying', { attempt: attempt, of: maxAttempts, nextInSec: Math.round(delay / 1000), err: e.code || e.status || e.message, label: opts.label });
      await sleep(delay);
    }
  }
}

module.exports = { callLLM, hasKey, setLogger, providers: Object.keys(PROVIDERS) };
