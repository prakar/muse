#!/usr/bin/env node
// QUARRY tagger.js v0.7
// Flags: --switch1 --switch2 --switch3 --switch4 --status --sync-wc --mindful-wc
// Options: --provider <gemini|openrouter|claude> --limit N --file <path> --dry-run
// --sync-wc    recount words in all .md files, update vault_notes.word_count
// --mindful-wc compress notes >3000 words via Gemini, write back to filesystem
// --mindful-wc respects --limit N and --dry-run (lists candidates without acting)

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH    = process.env.QUARRY_DB || path.join(process.env.HOME, 'quarry', 'vault.db');
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const GEMINI_MODEL = 'gemini-2.5-flash';
const BUDGET_CEILING = parseFloat(process.env.BUDGET_CEILING_USD || '10.00');
const S3_MAX_CHARS = 4000;
const S4_MIN_WORDS = 1500;
const MINDFUL_THRESHOLD = 15000; // words above which --mindful-wc acts (below this, notes have legitimate density)

const OR_PREFERRED = [
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-coder:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'google/gemma-3-27b-it:free',
  'stepfun/step-3.5-flash:free',
  'openrouter/free'
];

const S3_SYSTEM = 'Expert analyst for personal knowledge management. Be conservative and strictly honest. Output only the six sections requested, no extra text.';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const SW1         = args.includes('--switch1');
const SW2         = args.includes('--switch2');
const SW3         = args.includes('--switch3');
const SW4         = args.includes('--switch4');
const MODE_STATUS = args.includes('--status');
const MODE_DRY    = args.includes('--dry-run');
const SYNC_WC     = args.includes('--sync-wc');
const MINDFUL_WC  = args.includes('--mindful-wc');

const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i !== -1 ? parseInt(args[i+1], 10) : Infinity;
})();

const SINGLE_FILE = (() => {
  const i = args.indexOf('--file');
  return i !== -1 ? args[i+1] : null;
})();

const PROVIDER_ARG = (() => {
  const i = args.indexOf('--provider');
  if (i === -1) return null;
  const p = (args[i+1]||'').toLowerCase();
  if (!['gemini','openrouter','claude'].includes(p)) {
    console.error('--provider must be: gemini | openrouter | claude');
    process.exit(1);
  }
  return p;
})();

if (!SW1 && !SW2 && !SW3 && !SW4 && !MODE_STATUS && !SYNC_WC && !MINDFUL_WC) {
  console.error('Usage: node tagger.js [--switch1|2|3|4|--status|--sync-wc|--mindful-wc]');
  console.error('       [--provider gemini|openrouter|claude] [--limit N] [--file <path>] [--dry-run]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.HOME, 'quarry', 'tagger.log');
function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line = JSON.stringify(entry);
  console.log(line);
  try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch(_) {}
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) { console.error('vault.db not found'); process.exit(1); }
  return new DatabaseSync(DB_PATH);
}

// ---------------------------------------------------------------------------
// BUDGET
// ---------------------------------------------------------------------------
function spentToDate(db) {
  return db.prepare('SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget').get().t;
}
function checkBudget(db, provider) {
  const spent = spentToDate(db);
  const cost  = provider === 'claude' ? 0.02 : provider === 'gemini' ? 0.001 : 0;
  if (spent + cost > BUDGET_CEILING) {
    log('error', 'Budget ceiling reached', { spent: spent.toFixed(4), ceiling: BUDGET_CEILING });
    process.exit(2);
  }
}
function recordSpend(db, provider, component, noteId, tokIn, tokOut) {
  const cost = provider === 'openrouter' ? 0
    : provider === 'claude' ? (tokIn*3/1e6) + (tokOut*15/1e6)
    : (tokIn*0.075/1e6) + (tokOut*0.3/1e6);
  db.prepare('INSERT INTO api_budget (provider,component,note_id,tokens_in,tokens_out,cost_usd,called_at) VALUES (?,?,?,?,?,?,?)').run(provider, component, noteId||null, tokIn||0, tokOut||0, cost, new Date().toISOString());
  return cost;
}

// ---------------------------------------------------------------------------
// TAG + CLASSIFICATION WRITERS
// ---------------------------------------------------------------------------
function writeTagsToDb(db, noteId, tags, switchLevel) {
  if (!tags || !tags.length) return;
  const seen = {};
  const rows = [];
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase().replace(/\s+/g,'-');
    if (!clean || seen[clean]) continue;
    seen[clean] = true;
    const parts = clean.split('/').filter(Boolean);
    rows.push({ tag_full: parts.join('/'), tag_root: parts[0], tag_leaf: parts[parts.length-1], is_hierarchical: parts.length>1?1:0 });
    for (let d=1; d<parts.length; d++) {
      const partial = parts.slice(0,d).join('/');
      if (!seen[partial]) { seen[partial]=true; rows.push({ tag_full:partial, tag_root:parts[0], tag_leaf:parts[d-1], is_hierarchical:1 }); }
    }
  }
  const ins = db.prepare('INSERT OR IGNORE INTO note_tags (note_id,tag_full,tag_root,tag_leaf,is_hierarchical) VALUES (?,?,?,?,?)');
  for (const t of rows) ins.run(noteId, t.tag_full, t.tag_root, t.tag_leaf, t.is_hierarchical);
  db.prepare('UPDATE vault_notes SET has_tags=1, tag_source=? WHERE id=?').run('switch'+switchLevel, noteId);
}

function writeClassificationsToDb(db, noteId, parsed, switchLevel) {
  const stmt = db.prepare('INSERT INTO note_classifications (note_id,bucket,claim,annotation,confidence,switch_level,created_at) VALUES (?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  for (const bucket of ['verified','asserted','dubious','evergreen','trivia']) {
    for (const item of (parsed[bucket]||[])) {
      stmt.run(noteId, bucket, item.claim||item, item.annotation||null, item.confidence||null, switchLevel, now);
    }
  }
  db.prepare('UPDATE vault_notes SET classification_at=? WHERE id=?').run(now, noteId);
}

// ---------------------------------------------------------------------------
// SWITCH-1 (filename/H1 heuristic, zero API)
// ---------------------------------------------------------------------------
const S1_MAP = {
  history:'history', war:'history/war', battle:'history/war', empire:'history/empire',
  colonial:'history/colonialism', colonialism:'history/colonialism', revolution:'history/revolution',
  politics:'politics', election:'politics/election', democracy:'politics/democracy',
  parliament:'politics', government:'politics', nationalist:'politics/nationalism',
  nationalism:'politics/nationalism', protest:'politics', geography:'geography',
  city:'geography/urban', river:'geography/rivers', mountain:'geography',
  ocean:'geography/oceans', cartography:'geography/cartography', border:'geography/borders',
  enclave:'geography/borders', migration:'geography/migration', science:'science',
  physics:'science/physics', biology:'science/biology', chemistry:'science/chemistry',
  medicine:'medicine', disease:'medicine/disease', evolution:'science/evolution',
  climate:'science/climate', technology:'technology', software:'technology/software',
  computer:'technology/computing', internet:'technology/internet',
  artificial:'technology/ai', algorithm:'technology/computing', culture:'culture',
  music:'music', film:'arts/film', cinema:'arts/film', painting:'arts/painting',
  literature:'literature', book:'literature', novel:'literature',
  poetry:'literature/poetry', language:'linguistics', linguistics:'linguistics',
  etymology:'linguistics/etymology', religion:'religion', hinduism:'religion/hinduism',
  islam:'religion/islam', buddhism:'religion/buddhism', christianity:'religion/christianity',
  philosophy:'philosophy', ethics:'philosophy/ethics', sufi:'religion/islam/sufism',
  temple:'religion', pilgrimage:'religion', economics:'economics', economy:'economics',
  business:'economics/business', trade:'economics/trade', market:'economics/markets',
  finance:'economics/finance', money:'economics/money', bank:'economics/finance',
  startup:'economics/business', entrepreneur:'economics/business', india:'india',
  indian:'india', hindi:'india/language', sanskrit:'india/language', marathi:'india/language',
  carnatic:'india/music/carnatic', mughal:'india/history', british:'history/colonialism',
  partition:'india/history', gandhi:'india/history', nehru:'india/history',
  caste:'india/society', vedic:'india/religion', biography:'biography',
  philosopher:'philosophy', scientist:'science', artist:'arts', writer:'literature',
  architect:'architecture', engineer:'technology', identity:'culture/identity',
  slavery:'history/slavery', slave:'history/slavery', census:'demographics',
  propaganda:'politics/propaganda', espionage:'history/espionage',
  nazi:'history/world-war-ii', holocaust:'history/world-war-ii',
  yoga:'india/philosophy', meditation:'religion/meditation', astronomy:'science/astronomy',
  space:'science/astronomy', astro:'science/astronomy', marathon:'sports', athlete:'sports'
};

function switch1Tags(filepath, body) {
  const filename = path.basename(filepath, '.md').toLowerCase();
  const h1 = (body.match(/^#\s+(.+)$/m)||['',''])[1].toLowerCase();
  const tokens = ((filename+' '+h1).replace(/[-_]/g,' ').match(/[a-z]{4,}/g)||[]);
  const tagSet = {};
  for (const t of tokens) { if (S1_MAP[t]) tagSet[S1_MAP[t]] = true; }
  return Object.keys(tagSet).slice(0, 5);
}

// ---------------------------------------------------------------------------
// SWITCH-2 (first-paragraph vocab match, zero API)
// ---------------------------------------------------------------------------
function buildTagVocab(db) {
  const rows = db.prepare('SELECT DISTINCT tag_full FROM note_tags ORDER BY tag_full').all();
  const vocab = {};
  for (const row of rows) {
    for (const p of row.tag_full.split('/')) {
      const key = p.toLowerCase().replace(/-/g,' ');
      if (key.length >= 4) { if (!vocab[key]) vocab[key]=[]; if (!vocab[key].includes(row.tag_full)) vocab[key].push(row.tag_full); }
    }
  }
  return vocab;
}
function switch2Tags(firstParagraph, title, vocab) {
  const text = ((title||'')+' '+(firstParagraph||'')).toLowerCase();
  const tokens = text.match(/[a-z]{4,}/g)||[];
  const tagSet = {};
  for (const t of tokens) {
    if (vocab[t]) vocab[t].forEach(tag => tagSet[tag]=true);
    if (S1_MAP[t]) tagSet[S1_MAP[t]] = true;
  }
  return Object.keys(tagSet).slice(0, 8);
}

// ---------------------------------------------------------------------------
// PROMPT BUILDERS
// ---------------------------------------------------------------------------
function buildS3Prompt(noteContent, sourceUrl, useFullContent) {
  const content = sourceUrl ? 'Source URL: '+sourceUrl+'\n\n'+noteContent : noteContent;
  const body = useFullContent ? content : content.slice(0, S3_MAX_CHARS);
  return `You are an expert analyst processing content for personal knowledge management.

Content:
${body}

Output EXACTLY these six sections with ## headers. No extra text.

## VERIFIED FACTS
Bullet list: claims directly stated AND matching broad consensus an educated adult knows.
Tag non-trivial knowledge [domain]. Use ⚠️ for imprecise/context-dependent claims.
If none: "No claims meet strict verified-facts criteria."

## TEXTUALLY ASSERTED
Bullet list: factual-sounding claims needing external verification. Label: [attribution], [interpretation], [causation].
If none: "No unverified factual assertions found."

## DUBIOUS SPECULATION
Bullet list: fuzzy, opinionated, or contested claims stated as fact.
Format: claim → why dubious → level (HIGH/MEDIUM/LOW).
If none: "No clearly speculative assertions identified."

## EVERGREEN CONCEPTS
3-10 durable intellectual concepts. For each: *name*, one-sentence definition, brief lineage, how it appears here.

## TRIVIA NUGGETS
2-5 surprising verifiable micro-facts tied to explicit terms in the content.
Tag: [etymology], [history], etc. + [training knowledge - unverified] if from model training.

## EXPOSITORY ESSAY
200-400 words restating core substance in flowing narrative. Use ONLY VERIFIED FACTS. No added facts/opinions.
If insufficient verified content: "Insufficient verified content for a meaningful essay."

Be conservative. When in doubt, place in later sections or skip.`;
}

// Detect if note is primarily a list (>15 bullet/numbered lines) or prose essay
function isListFormat(body) {
  const lines      = body.split('\n');
  const listLines  = lines.filter(l => /^[-*•]|\d+\./.test(l.trim())).length;
  return listLines > 15;
}

function buildMindfulPrompt(noteContent, sourceUrl, listFmt, chunkNum, totalChunks) {
  const chunkNote = (chunkNum && totalChunks > 1)
    ? 'This is chunk '+chunkNum+' of '+totalChunks+' from a longer note. Compress this chunk independently — do not add preamble or closing remarks.\n\n'
    : '';

  // URL mode: no body text, let the model fetch and compress from source
  if (sourceUrl && !noteContent) {
    return chunkNote+`You are compressing a web article into a dense personal knowledge note.

Fetch and read this URL: ${sourceUrl}

Then produce a compressed version at roughly 20% of the original article length.
- Preserve all specific names, dates, figures, titles, and factual claims.
- Keep the thesis and its key evidence expansive.
- Compress narration, scene-setting, and repeated points.
- Trivia, etymologies, and surprising facts: passthrough unchanged.
- Do NOT label your actions. Output only the compressed note body.`;
  }

  const listInstr = listFmt
    ? 'This note is list-format. Keep the full list structure and all entries. Strip only parenthetical explanations, redundant prose, and commentary between entries. Do not truncate or drop list items.'
    : 'This note is essay/prose format. Compress narration and exposition. Preserve all specific names, dates, figures, titles, and factual claims. Keep the thesis and its evidence expansive. Condense all other prose to minimum viable wording.';

  return chunkNote+`You are compressing a personal knowledge note to roughly 20% of its current length. Your output will directly overwrite the original file.

${noteContent}

Instructions:
- Target output: roughly 20% of the input word count. Do not impose a hard word ceiling — preserve completeness over brevity.
- ${listInstr}
- Trivia, surprising facts, and etymologies: passthrough unchanged, never compress.
- Retain the author's voice and any first-person observations.
- Do NOT editorialise, signal your actions, or label what you compressed. No notes like "(retained)", "(compressed)", "(passthrough)", "(as-is)". Simply do it.
- Output only the compressed note body. No preamble, no explanation, no metadata.`;
}


// ---------------------------------------------------------------------------
// RESPONSE PARSER (Switch-3/4)
// ---------------------------------------------------------------------------
function parseBullets(text) {
  return text.split('\n').filter(l=>/^[-*•]/.test(l.trim())).map(l=>l.replace(/^[-*•]\s*/,'').trim()).filter(l=>l.length>5);
}
function parseDubious(text) {
  return text.split(/\n(?=[-*•])/).map(b=>b.trim()).filter(b=>b.length>10).map(b=>({
    claim: b.replace(/^[-*•]\s*/,'').split('→')[0].trim(),
    annotation: b,
    confidence: (b.match(/\b(HIGH|MEDIUM|LOW)\b/i)||[null,null])[1]
  }));
}
function parseEvergreen(text) {
  return text.split(/\n(?=[-*•]|\d+\.)/).map(b=>b.trim()).filter(b=>b.length>10).map(b=>({
    name: ((b.match(/\*([^*]+)\*/))||b.match(/^[-*•\d.]+\s*([^:\n]+)/))?.[1]?.trim()||null,
    claim: b, annotation: b
  }));
}
function parseS3Response(text) {
  const clean = text.replace(/^```[a-z]*\n/m,'').replace(/```\s*$/m,'').trim();
  const sections = { verified:[], asserted:[], dubious:[], evergreen:[], trivia:[], essay:'' };
  for (const part of clean.split(/^##\s+/m)) {
    const lines = part.trim().split('\n');
    const header = lines[0].trim().toUpperCase();
    const body   = lines.slice(1).join('\n').trim();
    if (header.includes('VERIFIED'))                       sections.verified  = parseBullets(body);
    else if (header.includes('TEXTUALLY')||header.includes('ASSERTED')) sections.asserted  = parseBullets(body);
    else if (header.includes('DUBIOUS'))                   sections.dubious   = parseDubious(body);
    else if (header.includes('EVERGREEN'))                 sections.evergreen = parseEvergreen(body);
    else if (header.includes('TRIVIA'))                    sections.trivia    = parseBullets(body);
    else if (header.includes('EXPOSITORY')||header.includes('ESSAY')) sections.essay = body;
  }
  sections.inferredTags = sections.evergreen.map(e=>e.name?e.name.toLowerCase().replace(/\s+/g,'-'):null).filter(Boolean).slice(0,6);
  return sections;
}

// ---------------------------------------------------------------------------
// HTTP HELPERS
// ---------------------------------------------------------------------------
function httpPost(hostname, pathStr, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname, path:pathStr, method:'POST',
      headers: Object.assign({'Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyStr)}, headers)
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({status:res.statusCode,body:JSON.parse(data)}); } catch(e) { resolve({status:res.statusCode,body:data}); } });
    });
    req.on('error', reject);
    req.write(bodyStr); req.end();
  });
}
function httpGet(hostname, pathStr, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({hostname, path:pathStr, method:'GET', headers:headers||{}}, res => {
      let data = '';
      res.on('data', c => data+=c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

// ---------------------------------------------------------------------------
// API CALLERS
// ---------------------------------------------------------------------------
var _orFreeModels = null;
var _orModelIdx   = 0;

async function fetchOrFreeModels() {
  if (_orFreeModels) return _orFreeModels;
  try {
    const res = await httpGet('openrouter.ai', '/api/v1/models', {'Authorization':'Bearer '+OPENROUTER_API_KEY});
    const ids = new Set((res.data||[]).filter(m=>m.pricing&&m.pricing.prompt==='0'&&m.pricing.completion==='0').map(m=>m.id));
    _orFreeModels = ids;
    log('info', 'OpenRouter free models fetched', {count:ids.size});
    return ids;
  } catch(e) {
    log('warn', 'Could not fetch OpenRouter models', {err:e.message});
    _orFreeModels = new Set(['openrouter/free']);
    return _orFreeModels;
  }
}
async function getNextOrModel() {
  const available = await fetchOrFreeModels();
  while (_orModelIdx < OR_PREFERRED.length) {
    const c = OR_PREFERRED[_orModelIdx++];
    if (available.has(c) || c === 'openrouter/free') return c;
  }
  return 'openrouter/free';
}

async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');
  _orModelIdx = 0;
  let lastErr = null;
  for (let attempt=0; attempt<OR_PREFERRED.length+1; attempt++) {
    const model = await getNextOrModel();
    try {
      log('info', 'OpenRouter trying model', {model});
      const res = await httpPost('openrouter.ai', '/api/v1/chat/completions', {'Authorization':'Bearer '+OPENROUTER_API_KEY}, {
        model, messages:[{role:'system',content:S3_SYSTEM},{role:'user',content:prompt}], max_tokens:8192
      });
      if (res.status===429) { log('warn','OpenRouter rate-limited, trying next',{model}); lastErr=new Error('rate-limited'); continue; }
      if (res.status!==200) { log('warn','OpenRouter error',{model,status:res.status}); lastErr=new Error('error '+res.status); continue; }
      const choice = (res.body.choices||[])[0];
      if (!choice?.message?.content) { log('warn','OpenRouter empty response',{model}); lastErr=new Error('empty'); continue; }
      const usage = res.body.usage||{};
      log('info', 'OpenRouter success', {model});
      return {text:choice.message.content, tokensIn:usage.prompt_tokens||0, tokensOut:usage.completion_tokens||0, provider:'openrouter'};
    } catch(e) { log('warn','OpenRouter attempt failed',{model,err:e.message}); lastErr=e; }
  }
  throw lastErr||new Error('All OpenRouter models exhausted');
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  const res = await httpPost('generativelanguage.googleapis.com',
    '/v1beta/models/'+GEMINI_MODEL+':generateContent?key='+GEMINI_API_KEY, {},
    {
      system_instruction: {parts:[{text:S3_SYSTEM}]},
      contents: [{role:'user',parts:[{text:prompt}]}],
      generationConfig: {maxOutputTokens:8192, temperature:0.1}
    }
  );
  if (res.status!==200) throw new Error('Gemini error '+res.status+': '+JSON.stringify(res.body).slice(0,200));
  const text  = ((((res.body.candidates||[])[0]||{}).content||{}).parts||[]).map(p=>p.text||'').join('');
  const usage = res.body.usageMetadata||{};
  return {text, tokensIn:usage.promptTokenCount||0, tokensOut:usage.candidatesTokenCount||0, provider:'gemini'};
}

// Mindful-wc uses higher output limit, warmer temperature, longer timeout, and retry
async function callGeminiMindful(prompt, attempt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  attempt = attempt || 1;
  const MAX_ATTEMPTS = 3;
  const TIMEOUT_MS   = 5 * 60 * 1000; // 5 minutes — large outputs take time

  return new Promise(function(resolve, reject) {
    const bodyStr = JSON.stringify({
      contents: [{role:'user', parts:[{text:prompt}]}],
      generationConfig: {maxOutputTokens:65536, temperature:0.3}
    });

    const req = require('https').request({
      hostname: 'generativelanguage.googleapis.com',
      path:     '/v1beta/models/'+GEMINI_MODEL+':generateContent?key='+GEMINI_API_KEY,
      method:   'POST',
      headers:  {'Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyStr)}
    }, function(res) {
      let data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          const body      = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error('Gemini mindful error '+res.statusCode+': '+JSON.stringify(body).slice(0,200)));
            return;
          }
          const candidate = ((body.candidates||[])[0]||{});
          const text      = ((candidate.content||{}).parts||[]).map(function(p){return p.text||'';}).join('');
          const usage     = body.usageMetadata||{};
          if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            log('warn','Gemini mindful non-STOP finish',{reason:candidate.finishReason,tokensOut:usage.candidatesTokenCount});
          }
          resolve({text, tokensIn:usage.promptTokenCount||0, tokensOut:usage.candidatesTokenCount||0, provider:'gemini'});
        } catch(e) { reject(e); }
      });
    });

    // 5-minute socket timeout
    req.setTimeout(TIMEOUT_MS, function() {
      req.destroy(new Error('GEMINI_TIMEOUT'));
    });

    req.on('error', function(e) {
      const retriable = e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.message === 'GEMINI_TIMEOUT';
      if (retriable && attempt < MAX_ATTEMPTS) {
        const delay = attempt * 30000; // 30s, 60s back-off
        log('warn','Gemini mindful timeout, retrying',{attempt, nextIn:delay/1000+'s', err:e.code||e.message});
        setTimeout(function() {
          callGeminiMindful(prompt, attempt+1).then(resolve).catch(reject);
        }, delay);
      } else {
        reject(e);
      }
    });

    req.write(bodyStr);
    req.end();
  });
}

// For very long notes (>25K words), split into ~8K-word chunks, compress each, reassemble
const CHUNK_WORD_LIMIT = 5000; // smaller chunks = shorter output per call, fewer timeouts

async function compressInChunks(body, sourceUrl, listFmt, db, noteId) {
  const words  = body.split(/\s+/);
  const chunks = [];
  for (let i=0; i<words.length; i+=CHUNK_WORD_LIMIT) {
    chunks.push(words.slice(i, i+CHUNK_WORD_LIMIT).join(' '));
  }
  log('info', 'mindful-wc chunking', {chunks:chunks.length, totalWords:words.length});

  const compressed = [];
  for (let ci=0; ci<chunks.length; ci++) {
    const chunkPrompt = buildMindfulPrompt(chunks[ci], ci===0 ? sourceUrl : null, listFmt, ci+1, chunks.length);
    log('info', 'mindful-wc chunk', {chunk:ci+1, of:chunks.length});
    const result = await callGeminiMindful(chunkPrompt);
    recordSpend(db, 'gemini', 'mindful-wc', noteId, result.tokensIn, result.tokensOut);
    compressed.push(result.text.trim());
  }
  return compressed.join('\n\n');
}

async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await httpPost('api.anthropic.com', '/v1/messages',
    {'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    {model:CLAUDE_MODEL, max_tokens:8192, system:S3_SYSTEM, messages:[{role:'user',content:prompt}]}
  );
  if (res.status!==200) throw new Error('Claude error '+res.status+': '+JSON.stringify(res.body).slice(0,200));
  const text  = (res.body.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const usage = res.body.usage||{};
  return {text, tokensIn:usage.input_tokens||0, tokensOut:usage.output_tokens||0, provider:'claude'};
}

async function callApi(prompt, provider) {
  if (provider==='gemini')      return callGemini(prompt);
  if (provider==='openrouter')  return callOpenRouter(prompt);
  if (provider==='claude')      return callClaude(prompt);
  throw new Error('Unknown provider: '+provider);
}

// ---------------------------------------------------------------------------
// NOTE FILE I/O
// ---------------------------------------------------------------------------
function readNoteBody(filepath) {
  try {
    return fs.readFileSync(filepath,'utf8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/,'')
      .replace(/_Created at[^_]*\._/g,'')
      .replace(/_Source URL:[^_]*\._/g,'')
      .trim();
  } catch(_) { return ''; }
}

function readFrontmatter(filepath) {
  try {
    const raw = fs.readFileSync(filepath,'utf8');
    const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/);
    return m ? m[1] : '';
  } catch(_) { return ''; }
}

function extractSourceUrl(filepath) {
  // Reads raw file to find HTTP/HTTPS URL in YAML frontmatter or body.
  // Handles: source:, source_url:, url:, link:, Source URL: (inline footer)
  try {
    const raw = fs.readFileSync(filepath,'utf8');
    // Try YAML frontmatter keys first (most reliable)
    const yamlPatterns = [
      /^source[_\s]?url\s*:\s*(.+)$/im,
      /^source\s*:\s*(https?:\/\/\S+)/im,
      /^url\s*:\s*(https?:\/\/\S+)/im,
      /^link\s*:\s*(https?:\/\/\S+)/im,
    ];
    for (const pat of yamlPatterns) {
      const m = raw.match(pat);
      if (m) return m[1].trim().replace(/['"]/g,'');
    }
    // Fallback: first bare https?:// URL anywhere in the file
    const bare = raw.match(/https?:\/\/[^\s"')\]>]+/);
    return bare ? bare[0] : null;
  } catch(_) { return null; }
}

function countWords(text) {
  return (text.match(/\S+/g)||[]).length;
}

function writeNoteFile(filepath, frontmatter, body) {
  // backup original
  const original = fs.readFileSync(filepath,'utf8');
  fs.writeFileSync(filepath+'.bak', original);
  fs.writeFileSync(filepath, frontmatter ? frontmatter+'\n'+body : body, 'utf8');
}

// ---------------------------------------------------------------------------
// SYNC-WC: recount words for all notes, update DB
// ---------------------------------------------------------------------------
async function runSyncWc(db) {
  const notes = db.prepare('SELECT id, filepath, word_count FROM vault_notes').all();
  log('info', 'sync-wc starting', {total:notes.length});
  let updated = 0;
  let missing  = 0;
  for (const note of notes) {
    if (!fs.existsSync(note.filepath)) { missing++; continue; }
    const body  = readNoteBody(note.filepath);
    const newWc = countWords(body);
    if (newWc !== note.word_count) {
      db.prepare('UPDATE vault_notes SET word_count=? WHERE id=?').run(newWc, note.id);
      updated++;
    }
  }
  log('info', 'sync-wc complete', {updated, missing, unchanged:notes.length-updated-missing});
}

// ---------------------------------------------------------------------------
// MINDFUL-WC: compress overlong notes via Gemini, write back
// ---------------------------------------------------------------------------
async function runMindfulWc(db) {
  const candidates = db.prepare(
    "SELECT id,title,filepath,word_count,source_url FROM vault_notes WHERE word_count>? AND (quarry_exclude IS NULL OR quarry_exclude=0) AND content_type IN ('article','note') ORDER BY word_count DESC LIMIT ?"
  ).all(MINDFUL_THRESHOLD, LIMIT===Infinity ? 9999 : LIMIT);

  log('info', 'mindful-wc candidates', {count:candidates.length, threshold:MINDFUL_THRESHOLD});

  if (candidates.length === 0) {
    log('info', 'No notes above threshold');
    return;
  }

  if (MODE_DRY) {
    console.log('\n=== DRY RUN — mindful-wc candidates ===');
    for (const n of candidates) {
      console.log(n.word_count+'w  '+n.title.slice(0,80));
    }
    console.log('=== '+candidates.length+' notes would be compressed ===\n');
    return;
  }

  // mindful-wc always uses Gemini (needs reliable large context)
  if (!GEMINI_API_KEY) { log('error','mindful-wc requires GEMINI_API_KEY'); process.exit(1); }

  for (const note of candidates) {
    try {
      const body      = readNoteBody(note.filepath);
      const sourceUrl = note.source_url || extractSourceUrl(note.filepath);
      const listFmt   = isListFormat(body);
      const wordCount = (body.match(/\S+/g)||[]).length;
      const useUrl    = false; // URL mode disabled — Gemini fetches from training, not the actual document
      const chunked   = !useUrl && wordCount > CHUNK_WORD_LIMIT;

      log('info', 'mindful-wc compressing', {
        title:   note.title.slice(0,60),
        words:   note.word_count,
        format:  listFmt ? 'list' : 'prose',
        mode:    useUrl ? 'url' : chunked ? 'chunked' : 'single'
      });
      checkBudget(db, 'gemini');

      var newBody;
      if (useUrl) {
        // URL mode: pass only the URL, let Gemini read from source.
        // Much faster — no large input token stream, no timeouts.
        const prompt = buildMindfulPrompt('', sourceUrl, listFmt);
        const result = await callGeminiMindful(prompt);
        recordSpend(db, 'gemini', 'mindful-wc', note.id, result.tokensIn, result.tokensOut);
        newBody = result.text.trim();
      } else if (chunked) {
        newBody = await compressInChunks(body, null, listFmt, db, note.id);
      } else {
        const prompt = buildMindfulPrompt(body, null, listFmt);
        const result = await callGeminiMindful(prompt);
        recordSpend(db, 'gemini', 'mindful-wc', note.id, result.tokensIn, result.tokensOut);
        newBody = result.text.trim();
      }
      const newWc   = countWords(newBody);
      const fm      = readFrontmatter(note.filepath);

      writeNoteFile(note.filepath, fm, newBody);
      db.prepare('UPDATE vault_notes SET word_count=? WHERE id=?').run(newWc, note.id);
      const cost = 0; // already recorded per-chunk or in single call above

      log('info', 'mindful-wc complete', {
        title:  note.title.slice(0,60),
        before: note.word_count,
        after:  newWc,
        pct:    Math.round((1-newWc/note.word_count)*100)+'% reduction',
        chunked
      });
    } catch(e) {
      log('error', 'mindful-wc failed', {title:note.title.slice(0,60), err:e.message});
    }
  }
}

// ---------------------------------------------------------------------------
// SWITCH-3/4 PROCESSOR
// ---------------------------------------------------------------------------
async function processNote(db, note, switchLevel, provider, useFullContent) {
  const body   = readNoteBody(note.filepath);
  const prompt = buildS3Prompt(body, note.source_url, useFullContent);

  if (MODE_DRY) {
    console.log('\n=== DRY RUN Switch-'+switchLevel+' ('+provider+') — '+note.title+' ===');
    console.log(prompt.slice(0,400)+'...\n');
    return;
  }

  checkBudget(db, provider);
  log('info', 'Calling Switch-'+switchLevel+' API', {title:note.title.slice(0,60), provider, words:note.word_count, chars:body.length});

  const result = await callApi(prompt, provider);
  const parsed = parseS3Response(result.text);

  db.exec('BEGIN');
  try {
    writeClassificationsToDb(db, note.id, parsed, switchLevel);
    if (parsed.inferredTags && parsed.inferredTags.length) writeTagsToDb(db, note.id, parsed.inferredTags, switchLevel);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }

  const cost = recordSpend(db, result.provider, switchLevel===4?'classifier-s4':'classifier', note.id, result.tokensIn, result.tokensOut);
  log('info', 'Switch-'+switchLevel+' complete', {title:note.title.slice(0,60), provider:result.provider, verified:parsed.verified.length, trivia:parsed.trivia.length, cost_usd:cost.toFixed(5)});
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function printStatus(db) {
  const total      = db.prepare('SELECT COUNT(*) as n FROM vault_notes').get().n;
  const tagged     = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE has_tags=1').get().n;
  const classified = db.prepare('SELECT COUNT(DISTINCT note_id) as n FROM note_classifications').get().n;
  const s4         = db.prepare('SELECT COUNT(DISTINCT note_id) as n FROM note_classifications WHERE switch_level=4').get().n;
  const budget     = spentToDate(db);
  const s4cost     = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget WHERE component='classifier-s4'").get().t;
  const s3calls    = db.prepare("SELECT COUNT(*) as n FROM api_budget WHERE component='classifier'").get().n;
  const s4calls    = db.prepare("SELECT COUNT(*) as n FROM api_budget WHERE component='classifier-s4'").get().n;
  const orcalls    = db.prepare("SELECT COUNT(*) as n FROM api_budget WHERE provider='openrouter'").get().n;
  const mwcalls    = db.prepare("SELECT COUNT(*) as n FROM api_budget WHERE component='mindful-wc'").get().n;
  const mwcost     = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget WHERE component='mindful-wc'").get().t;
  const bySrc      = db.prepare("SELECT COALESCE(tag_source,'original') as src, COUNT(*) as n FROM vault_notes WHERE has_tags=1 GROUP BY tag_source ORDER BY n DESC").all();

  console.log('\n'+'═'.repeat(39));
  console.log('  QUARRY TAGGER STATUS');
  console.log('═'.repeat(39));
  console.log('  Total notes:      '+total);
  console.log('  Tagged:           '+tagged+' ('+Math.round(tagged/total*100)+'%)');
  console.log('  Untagged:         '+(total-tagged));
  console.log('  Classified (S3):  '+classified);
  console.log('  Switch-4:         '+s4);
  console.log('\n  By tag source:');
  bySrc.forEach(r => console.log('    '+r.src.padEnd(14)+r.n));
  console.log('\n  API Budget:');
  console.log('    Ceiling:   $'+BUDGET_CEILING.toFixed(2));
  console.log('    Spent:     $'+budget.toFixed(4));
  console.log('    Remaining: $'+(BUDGET_CEILING-budget).toFixed(4));
  console.log('    gemini/classifier:    '+s4calls+' S4 calls, $'+s4cost.toFixed(4));
  console.log('    gemini/classifier S3: '+s3calls+' calls');
  console.log('    gemini/mindful-wc:    '+mwcalls+' calls, $'+mwcost.toFixed(4));
  console.log('    openrouter:           '+orcalls+' calls, $0.0000');
  console.log('═'.repeat(39)+'\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log('info', 'QUARRY tagger v0.7 starting', {sw1:SW1,sw2:SW2,sw3:SW3,sw4:SW4,syncWc:SYNC_WC,mindfulWc:MINDFUL_WC,provider:PROVIDER_ARG||'auto'});

  const db = openDb();

  if (MODE_STATUS) { printStatus(db); db.close(); return; }
  if (SYNC_WC)     { await runSyncWc(db); printStatus(db); db.close(); return; }
  if (MINDFUL_WC)  { await runMindfulWc(db); if (!MODE_DRY) printStatus(db); db.close(); return; }

  const provider = PROVIDER_ARG || (OPENROUTER_API_KEY ? 'openrouter' : GEMINI_API_KEY ? 'gemini' : 'claude');
  const useFullContent = SW4 || (SW3 && provider==='gemini');

  // Select notes
  let notes = [];
  if (SINGLE_FILE) {
    const fp = path.resolve(SINGLE_FILE);
    const note = db.prepare('SELECT * FROM vault_notes WHERE filepath=?').get(fp);
    if (!note) { log('error','File not in index',{filepath:fp}); db.close(); return; }
    notes = [note];
  } else if (SW4) {
    notes = db.prepare(
      "SELECT * FROM vault_notes WHERE word_count>=? AND content_type IN ('article','note') AND id NOT IN (SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4) ORDER BY word_count DESC LIMIT ?"
    ).all(S4_MIN_WORDS, LIMIT===Infinity?999999:LIMIT);
  } else if (SW3) {
    notes = db.prepare(
      "SELECT * FROM vault_notes WHERE classification_at IS NULL AND content_type IN ('article','note') AND word_count>200 ORDER BY word_count DESC LIMIT ?"
    ).all(LIMIT===Infinity?999999:LIMIT);
  } else {
    notes = db.prepare('SELECT * FROM vault_notes WHERE has_tags=0 ORDER BY word_count DESC LIMIT ?').all(LIMIT===Infinity?999999:LIMIT);
  }

  log('info', 'Notes selected', {count:notes.length});
  if (!notes.length) { log('info','No eligible notes'); printStatus(db); db.close(); return; }

  let vocab = SW2 ? buildTagVocab(db) : null;

  for (const note of notes) {
    try {
      if (SW1) {
        const body = readNoteBody(note.filepath);
        const tags = switch1Tags(note.filepath, body);
        if (tags.length) { db.exec('BEGIN'); writeTagsToDb(db, note.id, tags, 1); db.exec('COMMIT'); log('info','Switch-1 tagged',{title:note.title.slice(0,60),tags}); }
      }
      if (SW2) {
        const tags = switch2Tags(note.first_paragraph, note.title, vocab);
        if (tags.length) { db.exec('BEGIN'); writeTagsToDb(db, note.id, tags, 2); db.exec('COMMIT'); log('info','Switch-2 tagged',{title:note.title.slice(0,60),tags}); }
      }
      if (SW3 || SW4) {
        await processNote(db, note, SW3?3:4, provider, useFullContent);
      }
    } catch(e) {
      log('error','Failed to process note',{title:note.title.slice(0,60),err:e.message});
    }
  }

  log('info','Tagger complete');
  printStatus(db);
  db.close();
}

main().catch(e => { log('error','Tagger crashed',{err:e.message,stack:e.stack}); process.exit(1); });