#!/usr/bin/env node
/**
 * QUARRY tagger.js v0.3
 * Tags vault notes using three switch levels:
 *
 * --switch1   Filename + H1 heuristic. Zero API. Instant.
 * --switch2   First-paragraph keyword extraction against known tag vocabulary.
 *             Zero API. Fast.
 * --switch3   Full LLM classification using Switch-3 prompt.
 *             Budget-guarded. Routes: OpenRouter (free, self-healing) →
 *             Gemini → Claude.
 *
 * Usage:
 *   node tagger.js --switch1 [--limit N] [--file <path>]
 *   node tagger.js --switch2 [--limit N] [--file <path>]
 *   node tagger.js --switch3 [--limit N] [--file <path>] [--dry-run]
 *   node tagger.js --status
 *
 * --limit N     Process at most N notes (default: all eligible)
 * --file <path> Process a single file (any switch level)
 * --dry-run     Switch-3 only: print payload, no API call, no DB write
 * --status      Show tagging coverage and budget
 *
 * v0.3 — OpenRouter picker extracted to ~/zeroclaw/lib/openrouter.js
 *         httpGet/httpPost also sourced from shared lib.
 *         callGemini/callClaude/callS3Api remain local (tagger-specific).
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// SHARED LIB — OpenRouter free-model picker
// ---------------------------------------------------------------------------
const orLib = require(path.join(process.env.HOME, 'zeroclaw', 'lib', 'openrouter.js'));
const { httpPost, httpGet } = orLib;

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH = process.env.QUARRY_DB
  || path.join(process.env.HOME, 'quarry', 'vault.db');

const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const GEMINI_MODEL = 'gemini-2.5-flash';

// Budget ceiling in USD — hard stop before any API call that would exceed it
const BUDGET_CEILING = parseFloat(process.env.BUDGET_CEILING_USD || '10.00');

// Cost per Switch-3 call (conservative estimates)
// OpenRouter free = $0.00, Claude Sonnet ~$0.02/call, Gemini ~$0.0005/call
const COST_PER_CALL = { openrouter: 0.00, claude: 0.02, gemini: 0.001 };

// Max chars of note body sent to Switch-3
const S3_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const SW1         = args.includes('--switch1');
const SW2         = args.includes('--switch2');
const SW3         = args.includes('--switch3');
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

if (!SW1 && !SW2 && !SW3 && !MODE_STATUS) {
  console.error('Usage: node tagger.js [--switch1|--switch2|--switch3|--status] [options]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.HOME, 'quarry', 'tagger.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
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
// BUDGET GUARD
// ---------------------------------------------------------------------------
function spentToDate(db) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_budget'
  ).get();
  return row ? row.total : 0;
}

function checkBudget(db, provider) {
  const spent = spentToDate(db);
  const cost  = COST_PER_CALL[provider] || 0;
  if (spent + cost > BUDGET_CEILING) {
    log('error', 'BUDGET CEILING REACHED — aborting', {
      spent:   spent.toFixed(4),
      ceiling: BUDGET_CEILING,
      provider
    });
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
    provider,
    component:  component,
    note_id:    noteId || null,
    tokens_in:  tokensIn  || 0,
    tokens_out: tokensOut || 0,
    cost_usd:   cost,
    called_at:  new Date().toISOString()
  });

  return cost;
}

// ---------------------------------------------------------------------------
// TAG WRITE HELPERS
// ---------------------------------------------------------------------------
function writeTagsToDb(db, noteId, tags, switchLevel) {
  if (!tags || tags.length === 0) return;

  const seen       = {};
  const normalised = [];

  for (var i = 0; i < tags.length; i++) {
    const clean = tags[i].trim().toLowerCase().replace(/\s+/g, '-');
    if (!clean || seen[clean]) continue;
    seen[clean] = true;
    const parts = clean.split('/').filter(Boolean);
    normalised.push({
      tag_full:        parts.join('/'),
      tag_root:        parts[0],
      tag_leaf:        parts[parts.length - 1],
      is_hierarchical: parts.length > 1 ? 1 : 0
    });
    if (parts.length > 1) {
      for (var d = 1; d < parts.length; d++) {
        const partial = parts.slice(0, d).join('/');
        if (!seen[partial]) {
          seen[partial] = true;
          normalised.push({
            tag_full:        partial,
            tag_root:        parts[0],
            tag_leaf:        parts[d - 1],
            is_hierarchical: 1
          });
        }
      }
    }
  }

  const insertTag = db.prepare(
    'INSERT OR IGNORE INTO note_tags (note_id, tag_full, tag_root, tag_leaf, is_hierarchical) VALUES (?, ?, ?, ?, ?)'
  );
  for (var j = 0; j < normalised.length; j++) {
    const t = normalised[j];
    insertTag.run(noteId, t.tag_full, t.tag_root, t.tag_leaf, t.is_hierarchical);
  }

  db.prepare(
    'UPDATE vault_notes SET has_tags = 1, tag_source = ? WHERE id = ?'
  ).run('switch' + switchLevel, noteId);
}

function writeClassificationsToDb(db, noteId, parsed) {
  const stmt = db.prepare(
    'INSERT INTO note_classifications (note_id, bucket, claim, annotation, confidence, switch_level, created_at) VALUES (@note_id, @bucket, @claim, @annotation, @confidence, @switch_level, @created_at)'
  );

  const now     = new Date().toISOString();
  const buckets = ['verified', 'asserted', 'dubious', 'evergreen', 'trivia'];

  for (var b = 0; b < buckets.length; b++) {
    const bucket = buckets[b];
    const items  = parsed[bucket] || [];
    for (var i = 0; i < items.length; i++) {
      stmt.run({
        note_id:      noteId,
        bucket:       bucket,
        claim:        items[i].claim || items[i],
        annotation:   items[i].annotation || null,
        confidence:   items[i].confidence || null,
        switch_level: 3,
        created_at:   now
      });
    }
  }

  db.prepare(
    'UPDATE vault_notes SET classification_at = ? WHERE id = ?'
  ).run(now, noteId);
}

// ---------------------------------------------------------------------------
// SWITCH 1 — Filename + H1 heuristic. Zero API.
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
  const h1Match  = body.match(/^#\s+(.+)$/m);
  const h1       = h1Match ? h1Match[1].toLowerCase() : '';
  const text     = (filename + ' ' + h1).replace(/[-_]/g, ' ');
  const tokens   = text.match(/[a-z]{4,}/g) || [];
  const tagSet   = {};
  for (var i = 0; i < tokens.length; i++) {
    if (S1_KEYWORD_MAP[tokens[i]]) tagSet[S1_KEYWORD_MAP[tokens[i]]] = true;
  }
  return Object.keys(tagSet).slice(0, 5);
}

// ---------------------------------------------------------------------------
// SWITCH 2 — First-paragraph extraction against tag vocabulary. Zero API.
// ---------------------------------------------------------------------------
function buildTagVocabulary(db) {
  const rows  = db.prepare('SELECT DISTINCT tag_full FROM note_tags ORDER BY tag_full').all();
  const vocab = {};
  for (var i = 0; i < rows.length; i++) {
    const parts = rows[i].tag_full.split('/');
    for (var j = 0; j < parts.length; j++) {
      const p = parts[j].toLowerCase().replace(/-/g, ' ');
      if (p.length >= 4) {
        if (!vocab[p]) vocab[p] = [];
        if (!vocab[p].includes(rows[i].tag_full)) vocab[p].push(rows[i].tag_full);
      }
    }
  }
  return vocab;
}

function switch2Tags(firstParagraph, title, vocab) {
  if (!firstParagraph && !title) return [];
  const text   = ((title || '') + ' ' + (firstParagraph || '')).toLowerCase();
  const tokens = text.match(/[a-z]{4,}/g) || [];
  const tagSet = {};
  for (var i = 0; i < tokens.length; i++) {
    const candidates = vocab[tokens[i]];
    if (candidates) {
      for (var j = 0; j < candidates.length; j++) tagSet[candidates[j]] = true;
    }
    if (S1_KEYWORD_MAP[tokens[i]]) tagSet[S1_KEYWORD_MAP[tokens[i]]] = true;
  }
  return Object.keys(tagSet).slice(0, 8);
}

// ---------------------------------------------------------------------------
// SWITCH 3 — LLM classification
// ---------------------------------------------------------------------------
const S3_SYSTEM = 'You are an expert analyst processing content for personal knowledge management. Be conservative and strictly honest. Output only the six sections requested, with no extra text outside them.';

function buildS3Prompt(noteContent, sourceUrl) {
  const content   = sourceUrl ? 'Source URL: ' + sourceUrl + '\n\n' + noteContent : noteContent;
  const truncated = content.slice(0, S3_MAX_CHARS);

  return 'You are an expert analyst processing content (URL, article clip, transcript, thread, post, or note) for personal knowledge management.\n\nContent:\n' + truncated + '\n\nRead the content carefully at least twice.\n\nOutput EXACTLY these six sections in this order with these exact headers (##). No extra text outside them.\n\n## VERIFIED FACTS\nBullet list of claims that are:\n- Directly & unambiguously stated in the text, AND\n- Align with broad, uncontroversial consensus an educated adult knows without lookup.\nNon-trivial external knowledge requires [domain] tag (e.g. [philosophy]). Use ⚠️ for anything imprecise/context-dependent.\nBasic facts (e.g. "Kant was German") need no tag.\nIf none qualify: "No claims meet strict verified-facts criteria."\n\n## TEXTUALLY ASSERTED\nBullet list of factual-sounding claims in the text that need external verification or trust in the source.\nLabel each: [attribution], [interpretation], [causation], etc.\nIf none: "No unverified factual assertions found."\n\n## DUBIOUS SPECULATION\nBullet list of fuzzy, opinionated, predictive, or contested claims stated/implied as fact.\nFor each: quote/paraphrase → why dubious → level (HIGH / MEDIUM / LOW).\nPredictive causal claims default HIGH unless text cites strong evidence. Politically charged claims need broad expert consensus to exit here.\nExclude casual idioms. If none: "No clearly speculative assertions identified."\n\n## EVERGREEN CONCEPTS\n3-10 durable intellectual concepts touched on.\nFor each:\n- *Concept name*\n- One-sentence definition\n- Brief lineage (origin + 1-2 key figures/developments)\n- How it appears here\nIf <3 meaningful ones: state so and list what qualifies.\n\n## TRIVIA NUGGETS\n2-5 surprising, narrow, verifiable micro-facts tied directly to explicit terms/names/events in the content.\nPrioritize etymologies, historical incidents, documented connections.\nTag each: [etymology], [history], etc. + [training knowledge - unverified] if drawn from model training rather than the provided text.\nNo invention or stretch. If <2: list what exists.\n\n## EXPOSITORY ESSAY\nConcise expository essay (200-400 words) restating the core substance in a new, flowing narrative that echoes the original tone, rhythm, vocabulary, formality, and personality.\nUse ONLY VERIFIED FACTS bullets. No other sections, no added facts/interpretations/opinions.\nPreserve rhetorical spirit while connecting ideas smoothly.\nIf VERIFIED FACTS too sparse/trivial: "Insufficient verified content for a meaningful essay."\n\nBe conservative: when in doubt, place in later sections or skip. Maintain strict honesty.\nIf this is a URL and content is unavailable: output "CONTENT UNAVAILABLE: [reason]" and stop.';
}

// ---------------------------------------------------------------------------
// API CALLERS
// callOpenRouter — delegated entirely to shared lib.
//   orLib.callOpenRouter(prompt, { systemPrompt, maxTokens }) handles
//   OR_PREFERRED list, live model fetch, rate-limit self-healing, and fallback.
// callGemini / callClaude — local, use tagger-specific config.
// callS3Api — tagger's own cascade: OpenRouter → Gemini → Claude.
// ---------------------------------------------------------------------------

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

async function callS3Api(prompt) {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      return await orLib.callOpenRouter(prompt, { systemPrompt: S3_SYSTEM, maxTokens: 8192 });
    } catch (e) {
      log('warn', 'OpenRouter exhausted, trying Gemini', { err: e.message });
    }
  }
  if (GEMINI_API_KEY) {
    try { return await callGemini(prompt); }
    catch (e) { log('warn', 'Gemini failed, trying Claude', { err: e.message }); }
  }
  if (ANTHROPIC_API_KEY) {
    return await callClaude(prompt);
  }
  throw new Error('No API key set. Export OPENROUTER_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY.');
}

// ---------------------------------------------------------------------------
// SWITCH-3 RESPONSE PARSER
// ---------------------------------------------------------------------------
function parseS3Response(text) {
  // Strip markdown code fences if model wrapped output
  const clean = text.replace(/^```[a-z]*\n/m, '').replace(/```\s*$/m, '').trim();

  const sections = { verified: [], asserted: [], dubious: [], evergreen: [], trivia: [], essay: '' };
  const parts    = clean.split(/^##\s+/m);

  for (var i = 0; i < parts.length; i++) {
    const part   = parts[i].trim();
    const lines  = part.split('\n');
    const header = lines[0].trim().toUpperCase();
    const body   = lines.slice(1).join('\n').trim();

    if      (header.includes('VERIFIED'))                                sections.verified  = parseBullets(body);
    else if (header.includes('TEXTUALLY') || header.includes('ASSERTED')) sections.asserted = parseBullets(body);
    else if (header.includes('DUBIOUS'))                                  sections.dubious   = parseDubious(body);
    else if (header.includes('EVERGREEN'))                                sections.evergreen = parseEvergreen(body);
    else if (header.includes('TRIVIA'))                                   sections.trivia    = parseBullets(body);
    else if (header.includes('EXPOSITORY') || header.includes('ESSAY'))  sections.essay     = body;
  }

  // Infer tags from evergreen concept names
  sections.inferredTags = sections.evergreen
    .map(function(e) { return e.name ? e.name.toLowerCase().replace(/\s+/g, '-') : null; })
    .filter(Boolean)
    .slice(0, 6);

  return sections;
}

function parseBullets(text) {
  return text.split('\n')
    .filter(function(l) { return /^[-*•]/.test(l.trim()); })
    .map(function(l) { return l.replace(/^[-*•]\s*/, '').trim(); })
    .filter(function(l) { return l.length > 5; });
}

function parseDubious(text) {
  const items  = [];
  const blocks = text.split(/\n(?=[-*•])/);
  for (var i = 0; i < blocks.length; i++) {
    const block      = blocks[i].trim();
    if (!block || block.length < 10) continue;
    const levelMatch = block.match(/\b(HIGH|MEDIUM|LOW)\b/i);
    items.push({
      claim:      block.replace(/^[-*•]\s*/, '').split('\u2192')[0].trim(),
      annotation: block,
      confidence: levelMatch ? levelMatch[1].toUpperCase() : null
    });
  }
  return items;
}

function parseEvergreen(text) {
  const items  = [];
  const blocks = text.split(/\n(?=[-*•]|\d+\.)/);
  for (var i = 0; i < blocks.length; i++) {
    const block     = blocks[i].trim();
    if (!block || block.length < 10) continue;
    const nameMatch = block.match(/\*([^*]+)\*/) || block.match(/^[-*•\d.]+\s*([^:\n]+)/);
    items.push({
      name:       nameMatch ? nameMatch[1].trim() : null,
      claim:      block,
      annotation: block
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// NOTE READER
// ---------------------------------------------------------------------------
function readNoteBody(filepath) {
  try {
    const raw  = fs.readFileSync(filepath, 'utf8');
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    return body
      .replace(/_Created at[^_]*\._/g, '')
      .replace(/_Source URL:[^_]*\._/g, '')
      .trim();
  } catch (_) { return ''; }
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function printStatus(db) {
  const total      = db.prepare('SELECT COUNT(*) as n FROM vault_notes').get().n;
  const tagged     = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE has_tags = 1').get().n;
  const bySrc      = db.prepare('SELECT tag_source, COUNT(*) as n FROM vault_notes WHERE tag_source IS NOT NULL GROUP BY tag_source ORDER BY n DESC').all();
  const classed    = db.prepare('SELECT COUNT(DISTINCT note_id) as n FROM note_classifications').get().n;
  const spent      = spentToDate(db);
  const budgetRows = db.prepare('SELECT provider, component, COUNT(*) as calls, SUM(cost_usd) as cost FROM api_budget GROUP BY provider, component').all();

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  QUARRY TAGGER STATUS');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  Total notes:      ' + total);
  console.log('  Tagged:           ' + tagged + ' (' + Math.round(tagged / total * 100) + '%)');
  console.log('  Untagged:         ' + (total - tagged));
  console.log('  Classified (S3):  ' + classed);
  console.log('');
  console.log('  By tag source:');
  var origTagged = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE has_tags = 1 AND (tag_source IS NULL OR tag_source = \'\')').get().n;
  if (origTagged > 0) console.log('    ' + 'original'.padEnd(12) + ' ' + origTagged);
  bySrc.forEach(function(r) { console.log('    ' + String(r.tag_source).padEnd(12) + ' ' + r.n); });
  console.log('');
  console.log('  API Budget:');
  console.log('    Ceiling:   $' + BUDGET_CEILING.toFixed(2));
  console.log('    Spent:     $' + spent.toFixed(4));
  console.log('    Remaining: $' + Math.max(0, BUDGET_CEILING - spent).toFixed(4));
  if (budgetRows.length > 0) {
    console.log('    Breakdown:');
    budgetRows.forEach(function(r) {
      console.log('      ' + r.provider + '/' + r.component + ': ' + r.calls + ' calls, $' + (r.cost || 0).toFixed(4));
    });
  }
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log('info', 'QUARRY tagger v0.3 starting', { sw1: SW1, sw2: SW2, sw3: SW3 });

  const db = openDb();

  if (MODE_STATUS) { printStatus(db); db.close(); return; }

  // Select eligible notes
  var notes;
  if (SINGLE_FILE) {
    const fp   = path.resolve(SINGLE_FILE);
    const note = db.prepare('SELECT * FROM vault_notes WHERE filepath = ?').get(fp);
    if (!note) { log('error', 'File not in index', { filepath: fp }); db.close(); return; }
    notes = [note];
  } else if (SW3) {
    notes = db.prepare(
      'SELECT * FROM vault_notes WHERE classification_at IS NULL AND content_type IN (\'article\', \'note\') AND word_count > 200 ORDER BY word_count DESC LIMIT ?'
    ).all(LIMIT === Infinity ? 999999 : LIMIT);
  } else {
    notes = db.prepare(
      'SELECT * FROM vault_notes WHERE has_tags = 0 ORDER BY word_count DESC LIMIT ?'
    ).all(LIMIT === Infinity ? 999999 : LIMIT);
  }

  log('info', 'Notes selected', { count: notes.length });

  if (notes.length === 0) {
    log('info', 'No eligible notes found');
    printStatus(db);
    db.close();
    return;
  }

  var vocab     = null;
  var processed = 0;
  var tagged    = 0;
  var errors    = 0;

  if (SW2) vocab = buildTagVocabulary(db);

  for (var i = 0; i < notes.length; i++) {
    const note = notes[i];

    try {
      if (SW1) {
        const body = readNoteBody(note.filepath);
        const tags = switch1Tags(note.filepath, body);
        if (tags.length > 0) {
          db.exec('BEGIN');
          writeTagsToDb(db, note.id, tags, 1);
          db.exec('COMMIT');
          tagged++;
          log('info', 'Switch-1 tagged', { title: note.title, tags: tags });
        }
        processed++;
      }

      if (SW2) {
        const tags = switch2Tags(note.first_paragraph, note.title, vocab);
        if (tags.length > 0) {
          db.exec('BEGIN');
          writeTagsToDb(db, note.id, tags, 2);
          db.exec('COMMIT');
          tagged++;
          log('info', 'Switch-2 tagged', { title: note.title, tags: tags });
        }
        processed++;
      }

      if (SW3) {
        const body   = readNoteBody(note.filepath);
        const prompt = buildS3Prompt(body, note.source_url);

        if (MODE_DRY) {
          console.log('\n=== DRY RUN — Switch-3 for: ' + note.title + ' ===');
          console.log(prompt.slice(0, 600) + '...');
          console.log('=== END ===\n');
          processed++;
          continue;
        }

        const provider = process.env.OPENROUTER_API_KEY ? 'openrouter' : GEMINI_API_KEY ? 'gemini' : 'claude';
        checkBudget(db, provider);

        log('info', 'Calling Switch-3 API', { title: note.title, provider: provider });
        const result = await callS3Api(prompt);
        const parsed = parseS3Response(result.text);

        db.exec('BEGIN');
        writeClassificationsToDb(db, note.id, parsed);
        if (parsed.inferredTags && parsed.inferredTags.length > 0) {
          writeTagsToDb(db, note.id, parsed.inferredTags, 3);
        }
        db.exec('COMMIT');

        const cost = recordSpend(db, result.provider, 'classifier', note.id, result.tokensIn, result.tokensOut);

        tagged++;
        processed++;
        log('info', 'Switch-3 complete', {
          title:     note.title,
          verified:  (parsed.verified  || []).length,
          asserted:  (parsed.asserted  || []).length,
          dubious:   (parsed.dubious   || []).length,
          evergreen: (parsed.evergreen || []).length,
          trivia:    (parsed.trivia    || []).length,
          cost_usd:  cost.toFixed(5),
          provider:  result.provider,
          model:     result.modelUsed || null
        });
      }

    } catch (e) {
      log('error', 'Failed to tag note', { title: note.title, err: e.message });
      errors++;
      if (SW3) { try { db.exec('ROLLBACK'); } catch (_) {} }
    }
  }

  log('info', 'Tagger complete', { processed: processed, tagged: tagged, errors: errors });
  printStatus(db);
  db.close();
}

main().catch(function(e) {
  log('error', 'Tagger crashed', { err: e.message, stack: e.stack });
  process.exit(1);
});