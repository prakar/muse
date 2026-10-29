'use strict';
// The question rewriter: one cheap LLM call turns a question into a short plain-language passage (concrete terms, idioms spelled out) that is then searched
// by meaning. Cached forever per (question, prompt version, model) in the search cache. The passage is only ever used for matching; it is never shown as an answer.
// The prompt is the one the pilot was calibrated on (lab/query_rewrite.js, prompt version rw1): change it and the confidence bands need recalibrating.
const Cache = require('./search_cache');

const PROMPT_VERSION = 'rw1';
const SYSTEM = 'You help search a personal collection of short factual notes. You never answer the question to the user; you only write text that will be matched against notes.';

function buildPrompt(question) {
  return 'A person asked this question of their notes:\n\n"' + String(question).trim() + '"\n\n' +
    'Write 2 to 3 short factual sentences that a note answering it might contain. Use concrete names, technical terms, places and dates a note would use. ' +
    'If the question contains an idiom or slang, state what it means in plain words. If its premise looks wrong, write what the notes would more likely say. ' +
    'End with a line "Terms:" listing 6 to 10 search terms. Plain text only.';
}
function cleanRewrite(t) { return String(t || '').replace(/```[a-z]*\n?/gi, '').replace(/^\s*(here[^\n]*:|sentences?:)\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 900); }

const startOfDay = now => { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.toISOString(); };

// deps: cache (search_cache), callLLM(provider, prompt, opts), hasKey(provider), priceFor(provider, model, tokensIn) -> {in,out} per million, breaker.
// config: provider, maxUsdPerDay, enabled. Returns async rewrite(question) -> { text, cached, cost } or throws Error with a plain-language reason.
function createRewriter({ cache, callLLM, hasKey, priceFor, breaker, now = Date.now, config = {} }) {
  const provider = config.provider || 'gemini', maxPerDay = config.maxUsdPerDay == null ? 0.25 : config.maxUsdPerDay;
  return {
    PROMPT_VERSION, provider,
    available: () => config.enabled !== false && hasKey(provider),
    async rewrite(question) {
      const model = config.model || provider, key = Cache.rewriteKey(question, PROMPT_VERSION, model), hit = cache.getRewrite(key);
      if (hit) return { text: hit.rewrite, cached: true, cost: 0 };
      if (config.enabled === false) throw new Error('rewriting is switched off');
      if (!hasKey(provider)) throw new Error('no ' + provider + ' key is set, so new questions are searched without the rewrite step');
      if (cache.spentSince(startOfDay(now)) >= maxPerDay) throw new Error('today’s rewrite budget ($' + maxPerDay.toFixed(2) + ') is used up');
      const run = async function () { return callLLM(provider, buildPrompt(question), { system: SYSTEM, maxTokens: 400, temperature: 0, thinkingBudget: 0, label: 'search-rewrite' }); };
      const r = breaker ? await breaker.run(run) : await run();
      const rate = priceFor ? priceFor(provider, r.model, r.tokensIn || 0) : null;
      const cost = rate ? ((r.tokensIn || 0) * rate.in + (r.tokensOut || 0) * rate.out) / 1e6 : 0, text = cleanRewrite(r.text);
      if (!text) throw new Error('the rewrite came back empty');
      cache.putRewrite({ key, question: Cache.normQuestion(question), promptVersion: PROMPT_VERSION, model, rewrite: text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost });
      cache.addSpend({ task: 'search-rewrite', provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost });
      return { text, cached: false, cost };
    }
  };
}

module.exports = { PROMPT_VERSION, SYSTEM, buildPrompt, cleanRewrite, createRewriter };
