#!/usr/bin/env node
/**
 * QUARRY tagger.js v0.6
 * Cleaned & unified version with --provider support for both --switch3 and --switch4
 *
 * Usage:
 *   $TAGGER --switch3 --limit 1400 --provider gemini     # full content via Gemini
 *   $TAGGER --switch4 --limit 100 --provider claude
 *   $TAGGER --switch3 --limit 500                        # default chain
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH = process.env.QUARRY_DB || path.join(process.env.HOME, 'quarry', 'vault.db');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const GEMINI_MODEL = 'gemini-2.5-flash';

const BUDGET_CEILING = parseFloat(process.env.BUDGET_CEILING_USD || '10.00');
const COST_PER_CALL  = { openrouter: 0.00, claude: 0.02, gemini: 0.001 };

const S3_MAX_CHARS = 4000;
const S4_MIN_WORDS = 1500;

const OR_PREFERRED = [
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'google/gemma-3-27b-it:free',
  'stepfun/step-3.5-flash:free',
  'openrouter/free'
];

const S3_SYSTEM = 'You are an expert analyst processing content for personal knowledge management. Be conservative and strictly honest. Output only the six sections requested, with no extra text outside them.';

// ---------------------------------------------------------------------------
// CLI PARSER
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const SW1         = args.includes('--switch1');
const SW2         = args.includes('--switch2');
const SW3         = args.includes('--switch3');
const SW4         = args.includes('--switch4');
const MODE_STATUS = args.includes('--status');
const MODE_DRY    = args.includes('--dry-run');

const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i !== -1 ? parseInt(args[i + 1], 10) : Infinity;
})();

const SINGLE_FILE = (() => {
  const i = args.indexOf('--file');
  return i !== -1 ? args[i + 1] : null;
})();

const PROVIDER_ARG = (() => {
  const i = args.indexOf('--provider');
  if (i === -1) return null;
  const p = args[i + 1]?.toLowerCase();
  if (!['gemini', 'openrouter', 'claude'].includes(p)) {
    console.error('Error: --provider must be one of: gemini, openrouter, claude');
    process.exit(1);
  }
  return p;
})();

if (!SW1 && !SW2 && !SW3 && !SW4 && !MODE_STATUS) {
  console.error('Usage: node tagger.js [--switch1|--switch2|--switch3|--switch4|--status] [--provider <gemini|openrouter|claude>] [--limit N] [--file <path>] [--dry-run]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.HOME, 'quarry', 'tagger.log');

function log(level, msg, data = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  const line = JSON.stringify(entry);
  console.log(line);
  try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('vault.db not found — run indexer first, then migrate.js');
    process.exit(1);
  }
  return new DatabaseSync(DB_PATH);
}

// ---------------------------------------------------------------------------
// BUDGET
// ---------------------------------------------------------------------------
function spentToDate(db) {
  const row = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_budget').get();
  return row ? row.total : 0;
}

function checkBudget(db, provider) {
  const spent = spentToDate(db);
  const cost  = COST_PER_CALL[provider] || 0;
  if (spent + cost > BUDGET_CEILING) {
    log('error', 'BUDGET CEILING REACHED — aborting', { spent: spent.toFixed(4), ceiling: BUDGET_CEILING, provider });
    process.exit(2);
  }
  return spent;
}

function recordSpend(db, provider, component, noteId, tokensIn, tokensOut) {
  const cost = provider === 'openrouter' ? 0
    : provider === 'claude'
      ? (tokensIn * 3 / 1e6) + (tokensOut * 15 / 1e6)
      : (tokensIn * 0.075 / 1e6) + (tokensOut * 0.3 / 1e6);

  db.prepare(
    'INSERT INTO api_budget (provider, component, note_id, tokens_in, tokens_out, cost_usd, called_at) VALUES (@provider, @component, @note_id, @tokens_in, @tokens_out, @cost_usd, @called_at)'
  ).run({
    provider, component, note_id: noteId || null,
    tokens_in: tokensIn || 0, tokens_out: tokensOut || 0,
    cost_usd: cost, called_at: new Date().toISOString()
  });

  return cost;
}

// ---------------------------------------------------------------------------
// TAG & CLASSIFICATION WRITERS
// ---------------------------------------------------------------------------
function writeTagsToDb(db, noteId, tags, switchLevel) {
  if (!tags || tags.length === 0) return;

  const seen = {};
  const normalised = [];

  for (const tag of tags) {
    const clean = tag.trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean || seen[clean]) continue;
    seen[clean] = true;
    const parts = clean.split('/').filter(Boolean);
    normalised.push({ tag_full: parts.join('/'), tag_root: parts[0], tag_leaf: parts[parts.length-1], is_hierarchical: parts.length > 1 ? 1 : 0 });

    for (let d = 1; d < parts.length; d++) {
      const partial = parts.slice(0, d).join('/');
      if (!seen[partial]) {
        seen[partial] = true;
        normalised.push({ tag_full: partial, tag_root: parts[0], tag_leaf: parts[d-1], is_hierarchical: 1 });
      }
    }
  }

  const insertTag = db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag_full, tag_root, tag_leaf, is_hierarchical) VALUES (?, ?, ?, ?, ?)');
  for (const t of normalised) {
    insertTag.run(noteId, t.tag_full, t.tag_root, t.tag_leaf, t.is_hierarchical);
  }

  db.prepare('UPDATE vault_notes SET has_tags = 1, tag_source = ? WHERE id = ?').run('switch' + switchLevel, noteId);
}

function writeClassificationsToDb(db, noteId, parsed, switchLevel = 3) {
  const stmt = db.prepare(
    'INSERT INTO note_classifications (note_id, bucket, claim, annotation, confidence, switch_level, created_at) VALUES (@note_id, @bucket, @claim, @annotation, @confidence, @switch_level, @created_at)'
  );
  const now = new Date().toISOString();
  const buckets = ['verified', 'asserted', 'dubious', 'evergreen', 'trivia'];

  for (const bucket of buckets) {
    for (const item of (parsed[bucket] || [])) {
      stmt.run({
        note_id: noteId,
        bucket,
        claim: item.claim || item,
        annotation: item.annotation || null,
        confidence: item.confidence || null,
        switch_level: switchLevel,
        created_at: now
      });
    }
  }

  db.prepare('UPDATE vault_notes SET classification_at = ? WHERE id = ?').run(now, noteId);
}

// ---------------------------------------------------------------------------
// SWITCH 1 & 2 (unchanged logic)
// ---------------------------------------------------------------------------
const S1_KEYWORD_MAP = {
  history: 'history', war: 'history/war', battle: 'history/war',
  empire: 'history/empire', colonial: 'history/colonialism',
  colonialism: 'history/colonialism', revolution: 'history/revolution',
  politics: 'politics', election: 'politics/election',
  democracy: 'politics/democracy', parliament: 'politics',
  government: 'politics', nationalist: 'politics/nationalism',
  nationalism: 'politics/nationalism', protest: 'politics',
  geography: 'geography', city: 'geography/urban',
  river: 'geography/rivers', mountain: 'geography',
  ocean: 'geography/oceans', cartography: 'geography/cartography',
  border: 'geography/borders', enclave: 'geography/borders',
  migration: 'geography/migration',
  science: 'science', physics: 'science/physics',
  biology: 'science/biology', chemistry: 'science/chemistry',
  medicine: 'medicine', disease: 'medicine/disease',
  evolution: 'science/evolution', climate: 'science/climate',
  technology: 'technology', software: 'technology/software',
  computer: 'technology/computing', internet: 'technology/internet',
  artificial: 'technology/ai', algorithm: 'technology/computing',
  culture: 'culture', music: 'music', film: 'arts/film',
  cinema: 'arts/film', painting: 'arts/painting',
  literature: 'literature', book: 'literature', novel: 'literature',
  poetry: 'literature/poetry', language: 'linguistics',
  linguistics: 'linguistics', etymology: 'linguistics/etymology',
  religion: 'religion', hinduism: 'religion/hinduism',
  islam: 'religion/islam', buddhism: 'religion/buddhism',
  christianity: 'religion/christianity', philosophy: 'philosophy',
  ethics: 'philosophy/ethics', sufi: 'religion/islam/sufism',
  temple: 'religion', pilgrimage: 'religion',
  economics: 'economics', economy: 'economics',
  business: 'economics/business', trade: 'economics/trade',
  market: 'economics/markets', finance: 'economics/finance',
  money: 'economics/money', bank: 'economics/finance',
  startup: 'economics/business', entrepreneur: 'economics/business',
  india: 'india', indian: 'india', hindi: 'india/language',
  sanskrit: 'india/language', marathi: 'india/language',
  carnatic: 'india/music/carnatic', mughal: 'india/history',
  british: 'history/colonialism', partition: 'india/history',
  gandhi: 'india/history', nehru: 'india/history',
  caste: 'india/society', vedic: 'india/religion',
  biography: 'biography', philosopher: 'philosophy',
  scientist: 'science', artist: 'arts', writer: 'literature',
  architect: 'architecture', engineer: 'technology',
  identity: 'culture/identity', slavery: 'history/slavery',
  slave: 'history/slavery', census: 'demographics',
  propaganda: 'politics/propaganda', espionage: 'history/espionage',
  nazi: 'history/world-war-ii', holocaust: 'history/world-war-ii',
  yoga: 'india/philosophy', meditation: 'religion/meditation',
  astronomy: 'science/astronomy', space: 'science/astronomy',
  astro: 'science/astronomy', marathon: 'sports', athlete: 'sports'
};
function switch1Tags(filepath, body) {
  const filename = path.basename(filepath, '.md').toLowerCase();
  const h1Match = body.match(/^#\s+(.+)$/m);
  const h1 = h1Match ? h1Match[1].toLowerCase() : '';
  const text = (filename + ' ' + h1).replace(/[-_]/g, ' ');
  const tokens = text.match(/[a-z]{4,}/g) || [];
  const tagSet = {};
  for (const t of tokens) {
    if (S1_KEYWORD_MAP[t]) tagSet[S1_KEYWORD_MAP[t]] = true;
  }
  return Object.keys(tagSet).slice(0, 5);
}

function buildTagVocabulary(db) {
  const rows = db.prepare('SELECT DISTINCT tag_full FROM note_tags ORDER BY tag_full').all();
  const vocab = {};
  for (const row of rows) {
    const parts = row.tag_full.split('/');
    for (const p of parts) {
      const key = p.toLowerCase().replace(/-/g, ' ');
      if (key.length >= 4) {
        if (!vocab[key]) vocab[key] = [];
        if (!vocab[key].includes(row.tag_full)) vocab[key].push(row.tag_full);
      }
    }
  }
  return vocab;
}

function switch2Tags(firstParagraph, title, vocab) {
  if (!firstParagraph && !title) return [];
  const text = ((title || '') + ' ' + (firstParagraph || '')).toLowerCase();
  const tokens = text.match(/[a-z]{4,}/g) || [];
  const tagSet = {};
  for (const t of tokens) {
    if (vocab[t]) vocab[t].forEach(tag => tagSet[tag] = true);
    if (S1_KEYWORD_MAP[t]) tagSet[S1_KEYWORD_MAP[t]] = true;
  }
  return Object.keys(tagSet).slice(0, 8);
}

// ---------------------------------------------------------------------------
// PROMPT & PARSING
// ---------------------------------------------------------------------------
function buildPrompt(noteContent, sourceUrl, useFullContent) {
  const content = sourceUrl ? 'Source URL: ' + sourceUrl + '\n\n' + noteContent : noteContent;
  const truncated = useFullContent ? content : content.slice(0, S3_MAX_CHARS);

  return 'You are an expert analyst processing content (URL, article clip, transcript, thread, post, or note) for personal knowledge management.\n\nContent:\n' + truncated + '\n\nRead the content carefully at least twice.\n\nOutput EXACTLY these six sections in this order with these exact headers (##). No extra text outside them.\n\n## VERIFIED FACTS\nBullet list of claims that are:\n- Directly & unambiguously stated in the text, AND\n- Align with broad, uncontroversial consensus an educated adult knows without lookup.\nNon-trivial external knowledge requires [domain] tag (e.g. [philosophy]). Use ⚠️ for anything imprecise/context-dependent.\nBasic facts (e.g. "Kant was German") need no tag.\nIf none qualify: "No claims meet strict verified-facts criteria."\n\n## TEXTUALLY ASSERTED\nBullet list of factual-sounding claims in the text that need external verification or trust in the source.\nLabel each: [attribution], [interpretation], [causation], etc.\nIf none: "No unverified factual assertions found."\n\n## DUBIOUS SPECULATION\nBullet list of fuzzy, opinionated, predictive, or contested claims stated/implied as fact.\nFor each: quote/paraphrase → why dubious → level (HIGH / MEDIUM / LOW).\nPredictive causal claims default HIGH unless text cites strong evidence. Politically charged claims need broad expert consensus to exit here.\nExclude casual idioms. If none: "No clearly speculative assertions identified."\n\n## EVERGREEN CONCEPTS\n3-10 durable intellectual concepts touched on.\nFor each:\n- *Concept name*\n- One-sentence definition\n- Brief lineage (origin + 1-2 key figures/developments)\n- How it appears here\nIf <3 meaningful ones: state so and list what qualifies.\n\n## TRIVIA NUGGETS\n2-5 surprising, narrow, verifiable micro-facts tied directly to explicit terms/names/events in the content.\nPrioritize etymologies, historical incidents, documented connections.\nTag each: [etymology], [history], etc. + [training knowledge - unverified] if drawn from model training rather than the provided text.\nNo invention or stretch. If <2: list what exists.\n\n## EXPOSITORY ESSAY\nConcise expository essay (200-400 words) restating the core substance in a new, flowing narrative that echoes the original tone, rhythm, vocabulary, formality, and personality.\nUse ONLY VERIFIED FACTS bullets. No other sections, no added facts/interpretations/opinions.\nPreserve rhetorical spirit while connecting ideas smoothly.\nIf VERIFIED FACTS too sparse/trivial: "Insufficient verified content for a meaningful essay."\n\nBe conservative: when in doubt, place in later sections or skip. Maintain strict honesty.\nIf this is a URL and content is unavailable: output "CONTENT UNAVAILABLE: [reason]" and stop.';
}

// Paste your full original prompt body inside the template above (I shortened it for readability)

function parseS3Response(text) {
  const clean = text.replace(/^```[a-z]*\n/m, '').replace(/```\s*$/m, '').trim();
  const sections = { verified: [], asserted: [], dubious: [], evergreen: [], trivia: [], essay: '' };
  const parts = clean.split(/^##\s+/m);

  for (const part of parts) {
    const lines = part.trim().split('\n');
    const header = lines[0].trim().toUpperCase();
    const body = lines.slice(1).join('\n').trim();

    if (header.includes('VERIFIED')) sections.verified = parseBullets(body);
    else if (header.includes('TEXTUALLY') || header.includes('ASSERTED')) sections.asserted = parseBullets(body);
    else if (header.includes('DUBIOUS')) sections.dubious = parseDubious(body);
    else if (header.includes('EVERGREEN')) sections.evergreen = parseEvergreen(body);
    else if (header.includes('TRIVIA')) sections.trivia = parseBullets(body);
    else if (header.includes('EXPOSITORY') || header.includes('ESSAY')) sections.essay = body;
  }

  sections.inferredTags = sections.evergreen
    .map(e => e.name ? e.name.toLowerCase().replace(/\s+/g, '-') : null)
    .filter(Boolean)
    .slice(0, 6);

  return sections;
}

function parseBullets(text) {
  return text.split('\n')
    .filter(l => /^[-*•]/.test(l.trim()))
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(l => l.length > 5);
}

function parseDubious(text) {
  const items = [];
  const blocks = text.split(/\n(?=[-*•])/);
  for (const block of blocks) {
    const b = block.trim();
    if (b.length < 10) continue;
    const levelMatch = b.match(/\b(HIGH|MEDIUM|LOW)\b/i);
    items.push({
      claim: b.replace(/^[-*•]\s*/, '').split('\u2192')[0].trim(),
      annotation: b,
      confidence: levelMatch ? levelMatch[1].toUpperCase() : null
    });
  }
  return items;
}

function parseEvergreen(text) {
  const items = [];
  const blocks = text.split(/\n(?=[-*•]|\d+\.)/);
  for (const block of blocks) {
    const b = block.trim();
    if (b.length < 10) continue;
    const nameMatch = b.match(/\*([^*]+)\*/) || b.match(/^[-*•\d.]+\s*([^:\n]+)/);
    items.push({
      name: nameMatch ? nameMatch[1].trim() : null,
      claim: b,
      annotation: b
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// HTTP & API CALLERS
// ---------------------------------------------------------------------------
function httpPost(hostname, pathStr, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = { hostname, path: pathStr, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }, headers) };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function httpGet(hostname, pathStr, headers) {
  return new Promise(function(resolve, reject) {
    const req = https.request({
      hostname: hostname,
      path:     pathStr,
      method:   'GET',
      headers:  headers || {}
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OPENROUTER: self-healing model picker
// Fetches live free models, caches for process lifetime.
// On rate-limit, caller invalidates cache to force re-pick.
// ---------------------------------------------------------------------------
var _orFreeModels = null; // full list of available free model ids
var _orModelIdx   = 0;   // current position in preference list

async function fetchOrFreeModels() {
  if (_orFreeModels) return _orFreeModels;
  try {
    const res = await httpGet('openrouter.ai', '/api/v1/models',
      { 'Authorization': 'Bearer ' + OPENROUTER_API_KEY });
    const freeIds = new Set(
      (res.data || [])
        .filter(function(m) { return m.pricing && m.pricing.prompt === '0' && m.pricing.completion === '0'; })
        .map(function(m) { return m.id; })
    );
    _orFreeModels = freeIds;
    log('info', 'OpenRouter free models fetched', { count: freeIds.size });
    return freeIds;
  } catch (e) {
    log('warn', 'Could not fetch OpenRouter models', { err: e.message });
    _orFreeModels = new Set(['openrouter/free']);
    return _orFreeModels;
  }
}

async function getNextOrModel(skipModel) {
  const available = await fetchOrFreeModels();
  // Advance past skipModel if given
  if (skipModel) {
    const idx = OR_PREFERRED.indexOf(skipModel);
    if (idx !== -1) _orModelIdx = idx + 1;
  }
  // Walk preference list until we find an available model
  while (_orModelIdx < OR_PREFERRED.length) {
    const candidate = OR_PREFERRED[_orModelIdx];
    _orModelIdx++;
    if (available.has(candidate) || candidate === 'openrouter/free') {
      return candidate;
    }
  }
  // Fallback: any available free model
  return 'openrouter/free';
}

// ---------------------------------------------------------------------------
// API CALLERS
// ---------------------------------------------------------------------------
async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  var lastErr = null;
  _orModelIdx = 0; // reset for each call

  for (var attempt = 0; attempt < OR_PREFERRED.length + 1; attempt++) {
    const model = await getNextOrModel(null);

    try {
      log('info', 'OpenRouter trying model', { model: model });
      const res = await httpPost(
        'openrouter.ai',
        '/api/v1/chat/completions',
        { 'Authorization': 'Bearer ' + OPENROUTER_API_KEY },
        {
          model:      model,
          messages:   [
            { role: 'system', content: S3_SYSTEM },
            { role: 'user',   content: prompt }
          ],
          max_tokens: 8192
        }
      );

      if (res.status === 429) {
        log('warn', 'OpenRouter rate-limited, trying next', { model: model });
        lastErr = new Error('rate-limited: ' + model);
        continue;
      }
      if (res.status !== 200) {
        log('warn', 'OpenRouter error, trying next', { model: model, status: res.status, err: JSON.stringify(res.body).slice(0, 200) });
        lastErr = new Error('OpenRouter error ' + res.status);
        continue;
      }

      const choice = (res.body.choices || [])[0];
      if (!choice || !choice.message || !choice.message.content) {
        log('warn', 'OpenRouter empty response, trying next', { model: model });
        lastErr = new Error('empty response from ' + model);
        continue;
      }

      const text  = choice.message.content;
      const usage = res.body.usage || {};
      log('info', 'OpenRouter success', { model: model });
      return { text: text, tokensIn: usage.prompt_tokens || 0, tokensOut: usage.completion_tokens || 0, provider: 'openrouter' };

    } catch (e) {
      log('warn', 'OpenRouter attempt failed', { model: model, err: e.message });
      lastErr = e;
    }
  }

  throw lastErr || new Error('All OpenRouter models exhausted');
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const res = await httpPost(
    'generativelanguage.googleapis.com',
    '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY,
    {},
    {
      system_instruction: { parts: [{ text: S3_SYSTEM }] },
      contents:           [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig:   { maxOutputTokens: 8192, temperature: 0.1 }
    }
  );
  if (res.status !== 200) throw new Error('Gemini error ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 200));
  const text  = ((((res.body.candidates || [])[0] || {}).content || {}).parts || []).map(function(p) { return p.text || ''; }).join('');
  const usage = res.body.usageMetadata || {};
  return { text: text, tokensIn: usage.promptTokenCount || 0, tokensOut: usage.candidatesTokenCount || 0, provider: 'gemini' };
}

async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await httpPost(
    'api.anthropic.com',
    '/v1/messages',
    { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    {
      model:      CLAUDE_MODEL,
      max_tokens: 8192,
      system:     S3_SYSTEM,
      messages:   [{ role: 'user', content: prompt }]
    }
  );
  if (res.status !== 200) throw new Error('Claude error ' + res.status + ': ' + JSON.stringify(res.body).slice(0, 200));
  const text  = (res.body.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
  const usage = res.body.usage || {};
  return { text: text, tokensIn: usage.input_tokens || 0, tokensOut: usage.output_tokens || 0, provider: 'claude' };
}

// ---------------------------------------------------------------------------
// UNIFIED NOTE PROCESSOR
// ---------------------------------------------------------------------------
async function processNote(db, note, switchLevel, provider, useFullContent) {
  const body = readNoteBody(note.filepath);   // ← you still need to define readNoteBody below
  const prompt = buildPrompt(body, note.source_url, useFullContent);

  if (MODE_DRY) {
    console.log(`\n=== DRY RUN — Switch-${switchLevel} (${provider}${useFullContent ? ', full' : ''}) for: ${note.title} ===`);
    console.log(prompt.slice(0, 600) + '...');
    return;
  }

  checkBudget(db, provider);

  log('info', `Calling Switch-${switchLevel}`, { title: note.title, provider, fullDocument: useFullContent, chars: body.length });

  const result = await callApi(prompt, provider);
  const parsed = parseS3Response(result.text);

  db.exec('BEGIN');
  try {
    writeClassificationsToDb(db, note.id, parsed, switchLevel);
    if (parsed.inferredTags?.length) {
      writeTagsToDb(db, note.id, parsed.inferredTags, switchLevel);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  const cost = recordSpend(db, result.provider, switchLevel === 4 ? 'classifier-s4' : 'classifier', note.id, result.tokensIn, result.tokensOut);

  log('info', `Switch-${switchLevel} complete`, {
    title: note.title,
    provider: result.provider,
    fullDocument: useFullContent,
    cost_usd: cost.toFixed(5)
  });
}

async function callApi(prompt, provider) {
  if (provider === 'gemini') return await callGemini(prompt);
  if (provider === 'openrouter') return await callOpenRouter(prompt);
  if (provider === 'claude') return await callClaude(prompt);
  throw new Error('No valid provider');
}

// ---------------------------------------------------------------------------
// READ NOTE
// ---------------------------------------------------------------------------
function readNoteBody(filepath) {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    let body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    body = body.replace(/_Created at[^_]*\._/g, '').replace(/_Source URL:[^_]*\._/g, '').trim();
    return body;
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function printStatus(db) {
  // Your original printStatus function (copy it exactly as it was)
  // ...
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log('info', 'QUARRY tagger v0.6 starting', { sw3: SW3, sw4: SW4, provider: PROVIDER_ARG || 'auto' });

  const db = openDb();
  if (MODE_STATUS) {
    printStatus(db);
    db.close();
    return;
  }

  // Resolve provider
  let provider = PROVIDER_ARG;
  if (!provider) {
    provider = OPENROUTER_API_KEY ? 'openrouter' : GEMINI_API_KEY ? 'gemini' : 'claude';
  }

  const useFullContent = SW4 || (SW3 && provider === 'gemini');

  // Select notes
  let notes = [];
  if (SINGLE_FILE) {
    const fp = path.resolve(SINGLE_FILE);
    const note = db.prepare('SELECT * FROM vault_notes WHERE filepath = ?').get(fp);
    if (!note) { log('error', 'File not in index', { filepath: fp }); db.close(); return; }
    notes = [note];
  } else if (SW4) {
    notes = db.prepare(
      'SELECT * FROM vault_notes WHERE word_count >= ? AND content_type IN (\'article\', \'note\') AND id NOT IN (SELECT DISTINCT note_id FROM note_classifications WHERE switch_level = 4) ORDER BY word_count DESC LIMIT ?'
    ).all(S4_MIN_WORDS, LIMIT === Infinity ? 999999 : LIMIT);
  } else if (SW3) {
    notes = db.prepare(
      'SELECT * FROM vault_notes WHERE classification_at IS NULL AND content_type IN (\'article\', \'note\') AND word_count > 200 ORDER BY word_count DESC LIMIT ?'
    ).all(LIMIT === Infinity ? 999999 : LIMIT);
  } else {
    notes = db.prepare('SELECT * FROM vault_notes WHERE has_tags = 0 ORDER BY word_count DESC LIMIT ?').all(LIMIT === Infinity ? 999999 : LIMIT);
  }

  log('info', 'Notes selected', { count: notes.length });

  if (notes.length === 0) {
    log('info', 'No eligible notes found');
    printStatus(db);
    db.close();
    return;
  }

  let vocab = null;
  if (SW2) vocab = buildTagVocabulary(db);

  for (const note of notes) {
    try {
      if (SW1) {
        const body = readNoteBody(note.filepath);
        const tags = switch1Tags(note.filepath, body);
        if (tags.length) {
          db.exec('BEGIN');
          writeTagsToDb(db, note.id, tags, 1);
          db.exec('COMMIT');
          log('info', 'Switch-1 tagged', { title: note.title, tags });
        }
      }

      if (SW2) {
        const tags = switch2Tags(note.first_paragraph, note.title, vocab);
        if (tags.length) {
          db.exec('BEGIN');
          writeTagsToDb(db, note.id, tags, 2);
          db.exec('COMMIT');
          log('info', 'Switch-2 tagged', { title: note.title, tags });
        }
      }

      if (SW3 || SW4) {
        await processNote(db, note, SW3 ? 3 : 4, provider, useFullContent);
      }
    } catch (e) {
      log('error', 'Failed to process note', { title: note.title, err: e.message });
    }
  }

  log('info', 'Tagger complete');
  printStatus(db);
  db.close();
}

main().catch(e => {
  log('error', 'Tagger crashed', { err: e.message, stack: e.stack });
  process.exit(1);
});