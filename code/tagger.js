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
const { insertNoteTags } = require('./lib/tags');
const { resolveModel, fetchFreeModels, getNextFreeModel, resetFreeModelIndex } = require('failsafe-llm-model-resolver');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH    = process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'vault.db');
const GEMINI_API_KEY     = process.env.GEMINI_API_KEY     || '';
const XAI_API_KEY        = process.env.XAI_API_KEY        || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY  || '';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const GEMINI_MODEL = 'gemini-2.5-flash';
const BUDGET_CEILING = parseFloat(process.env.BUDGET_CEILING_USD || '10.00');
const S3_MAX_CHARS = 4000;
const S4_MIN_WORDS = 1500;
const MINDFUL_THRESHOLD = 15000; // words above which --mindful-wc acts (below this, notes have legitimate density)
const CHUNK_WORD_LIMIT  = 5000;  // smaller chunks = shorter output per call, fewer timeouts

const S3_SYSTEM = 'Expert analyst extracting narrative-ready material from personal knowledge notes. Be conservative on facts, generous on trivia. Output only the two sections requested, no extra text.';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const SW_VOCAB    = args.includes('--switch-vocab');
const SW3         = args.includes('--switch3');
const SW3_RETAG   = args.includes('--switch3-retag');
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
  if (!['gemini','openrouter','claude','grok'].includes(p)) {
    console.error('--provider must be: gemini | openrouter | claude | grok');
    process.exit(1);
  }
  return p;
})();

if (!SW_VOCAB && !SW3 && !SW3_RETAG && !SW4 && !MODE_STATUS && !SYNC_WC && !MINDFUL_WC) {
  console.error('Usage: node tagger.js [--switch-vocab|3|4|--status|--sync-wc|--mindful-wc] [--dry-run]');
  console.error('       [--provider gemini|openrouter|claude] [--limit N] [--file <path>] [--dry-run]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'tagger.log');
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
// PROVIDER CONFIGURATION — single source of truth. Every place that needs to
// know "does this provider have a large context window" or "what does this
// provider actually cost" reads from here. This replaces three independent,
// ad-hoc if/else chains that each went stale differently when Grok was added
// (the useFullContent truncation check, checkBudget's pre-flight estimate,
// and recordSpend's real pricing) - three separate bugs from one root cause.
//
// Pricing verified against docs.x.ai / third-party trackers, Sept 2026.
// xAI retired the literal "grok-4" model ID in a May 2026 migration; it now
// silently redirects to grok-4.3 pricing (not the original Grok 4 rate) -
// the model string in callGrok() is left as-is since the redirect works,
// but the PRICE below reflects what actually gets billed. Re-verify this
// table if xAI reprices again - they have done so mid-quarter before.
// ---------------------------------------------------------------------------
const PROVIDER_CONFIG = {
  grok:       { largeContext: true,  costPerMillionIn: 1.25, costPerMillionOut: 2.50,  budgetEstimate: 0.005 },
  gemini:     { largeContext: true,  costPerMillionIn: 0.075, costPerMillionOut: 0.30, budgetEstimate: 0.001 },
  claude:     { largeContext: true,  costPerMillionIn: 3.00, costPerMillionOut: 15.00, budgetEstimate: 0.02  },
  openrouter: { largeContext: false, costPerMillionIn: 0,    costPerMillionOut: 0,     budgetEstimate: 0     },
};
function providerHasLargeContext(provider) {
  const cfg = PROVIDER_CONFIG[provider];
  return !!(cfg && cfg.largeContext);
}

// ---------------------------------------------------------------------------
// BUDGET
// ---------------------------------------------------------------------------
function spentToDate(db) {
  return db.prepare('SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget').get().t;
}
function checkBudget(db, provider) {
  const spent = spentToDate(db);
  const cfg   = PROVIDER_CONFIG[provider];
  const cost  = cfg ? cfg.budgetEstimate : 0.005; // unknown provider: assume non-trivial, don't silently pass
  if (spent + cost > BUDGET_CEILING) {
    log('error', 'Budget ceiling reached', { spent: spent.toFixed(4), ceiling: BUDGET_CEILING, provider });
    process.exit(2);
  }
}
function recordSpend(db, provider, component, noteId, tokIn, tokOut) {
  const cfg  = PROVIDER_CONFIG[provider];
  const cost = cfg ? (tokIn * cfg.costPerMillionIn / 1e6) + (tokOut * cfg.costPerMillionOut / 1e6) : 0;
  if (!cfg) log('warn', 'recordSpend: unknown provider, cost recorded as $0 - PROVIDER_CONFIG needs an entry', { provider });
  db.prepare('INSERT INTO api_budget (provider,component,note_id,tokens_in,tokens_out,cost_usd,called_at) VALUES (?,?,?,?,?,?,?)').run(provider, component, noteId||null, tokIn||0, tokOut||0, cost, new Date().toISOString());
  return cost;
}

// ---------------------------------------------------------------------------
// TAG + CLASSIFICATION WRITERS
// ---------------------------------------------------------------------------
// Thin wrapper over lib/tags.js's insertNoteTags - single shared insertion
// path with server.js's /api/tags/review approve and custom branches.
function writeTagsToDb(db, noteId, tags, switchLevel) {
  insertNoteTags(db, noteId, tags, 'switch'+switchLevel);
}

function writeClassificationsToDb(db, noteId, parsed, switchLevel) {
  const stmt = db.prepare('INSERT INTO note_classifications (note_id,bucket,claim,annotation,confidence,switch_level,created_at) VALUES (?,?,?,?,?,?,?)');
  const now = new Date().toISOString();
  for (const bucket of ['verified','trivia']) {
    for (const item of (parsed[bucket]||[])) {
      stmt.run(noteId, bucket, item.claim||item, item.annotation||null, item.confidence||null, switchLevel, now);
    }
  }
  db.prepare('UPDATE vault_notes SET classification_at=? WHERE id=?').run(now, noteId);
}

// Writes every Switch-3 suggested tag into note_tag_proposals for HIL review.
// Nothing is applied to note_tags directly - the /review-tags page in server.js
// is the only path from here into a note's real tags (or into the canonical
// tag_vocabulary, for proposals not already covered).
function writeProposedTags(db, noteId, tags, vocabSet) {
  if (!tags || !tags.length) return;
  const ins = db.prepare(
    'INSERT INTO note_tag_proposals (note_id,tag_full,tag_root,tag_leaf,is_hierarchical,in_vocabulary,status,created_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const now = new Date().toISOString();
  const seen = new Set();
  for (const raw of tags) {
    const clean = raw.trim().toLowerCase().replace(/\s+/g,'-');
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    const parts = clean.split('/').filter(Boolean);
    const inVocab = vocabSet && vocabSet.has(clean) ? 1 : 0;
    ins.run(noteId, clean, parts[0], parts[parts.length-1], parts.length>1?1:0, inVocab, 'pending', now);
  }
}

// ---------------------------------------------------------------------------
// SWITCH-1 (filename/H1 heuristic, zero API)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// SWITCH-VOCAB (DB-driven, zero API) — replaces old Switch-1/Switch-2 split.
// Reads the canonical vocabulary from tag_vocabulary (seeded by FORM/TAG
// archaeology), matches against filename + H1 + first paragraph in one
// combined pass. No hardcoded keyword map — every tag ever applied flows
// through the same canonical vocabulary the vault's frontmatter now uses.
// ---------------------------------------------------------------------------
function loadTagVocabulary(db) {
  const rows = db.prepare(
    "SELECT tag_full, tag_root, tag_leaf FROM tag_vocabulary WHERE status = 'approved'"
  ).all();

  // Build a lookup: matchable keyword -> canonical tag_full.
  // IMPORTANT: only the tag's OWN leaf segment triggers it - a bare root
  // word (e.g. "religion") must NOT fan out to every child tag sharing
  // that root (religion/hinduism, religion/islam, ...). Each tag is
  // triggered only by its most specific identifying word.
  // First pass: count how many distinct tags share each leaf.
  const leafCounts = {};
  for (const row of rows) {
    const key = row.tag_leaf.toLowerCase().replace(/[-_]/g, '');
    if (key.length >= 4) leafCounts[key] = (leafCounts[key] || 0) + 1;
  }

  // Second pass: build vocab, EXCLUDING any leaf shared by 2+ tags.
  // A collided leaf (e.g. "history" -> history, science/history,
  // economics/history, ...) is inherently ambiguous for keyword
  // matching - "history of science" is a judgment call, not a keyword
  // hit. Those compound concepts are reserved for Switch-3/4, which
  // can actually read and understand the note.
  // Words that are technically unambiguous (single tag owns the leaf)
  // but are common/overloaded English words with a high false-positive
  // rate for single-word substring matching, verified empirically
  // against real switch-vocab output. Excluded from auto-matching.
  const SEMANTICALLY_OVERLOADED = new Set([
    'design', 'building', 'space', 'mind', 'culture', 'identity', 'product'
  ]);

  const vocab = {};
  let skipped = 0;
  for (const row of rows) {
    const key = row.tag_leaf.toLowerCase().replace(/[-_]/g, '');
    if (key.length < 4) continue;
    if (leafCounts[key] > 1) { skipped++; continue; }
    if (SEMANTICALLY_OVERLOADED.has(key)) { skipped++; continue; }
    vocab[key] = [row.tag_full];
  }
  log('info', 'Vocabulary loaded', { total: rows.length, matchable: Object.keys(vocab).length, skippedAmbiguous: skipped });
  return vocab;
}

function switchVocabTags(filepath, body, firstParagraph, title, vocab) {
  const filename = path.basename(filepath, '.md').toLowerCase();
  const h1 = (body.match(/^#\s+(.+)$/m) || ['', ''])[1].toLowerCase();
  const text = [filename, h1, title || '', firstParagraph || ''].join(' ').toLowerCase();

  const tokens = text.replace(/[-_]/g, '').match(/[a-z]{4,}/g) || [];
  const tagSet = {};
  for (const t of tokens) {
    if (vocab[t]) vocab[t].forEach(tag => { tagSet[tag] = true; });
  }
  return Object.keys(tagSet).slice(0, 8);
}

// ---------------------------------------------------------------------------
// PROMPT BUILDERS
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// RETAG PASS — re-reviews an ALREADY-TAGGED note's existing tags against the
// refined ontological principles, using two worked examples as few-shot
// guidance. Produces a corrected TAGS list via the same note_tag_proposals
// HIL queue as switch3 - never auto-applies. Does not touch verified/trivia.
// ---------------------------------------------------------------------------
function buildRetagPrompt(noteContent, sourceUrl, useFullContent, vocabList, existingTags) {
  const content = sourceUrl ? 'Source URL: '+sourceUrl+'\n\n'+noteContent : noteContent;
  const body = useFullContent ? content : content.slice(0, S3_MAX_CHARS);
  const vocabBlock = (vocabList && vocabList.length) ? vocabList.join(', ') : '(none loaded)';
  const existingBlock = (existingTags && existingTags.length) ? existingTags.join(', ') : '(none)';

  return `You are correcting the tags on a personal knowledge note against a strict ontology. The note already has tags, applied inconsistently over years - your job is to propose a corrected, high-quality replacement set, not to add to what's there.

Content:
${body}

EXISTING TAGS ON THIS NOTE (to be reviewed and corrected, not simply kept):
${existingBlock}

EXISTING TAG VOCABULARY (prefer these where they genuinely fit - reuse over inventing a near-duplicate):
${vocabBlock}

ONTOLOGICAL PRINCIPLES (apply strictly):
1. Geography is a co-tag, never a parent: "india" + "culture/food", never "india/food" - UNLESS the
   concept has no meaningful existence outside that geography and the term itself is unambiguous
   without it (e.g. "carnatic", "bharatanatyam" need no geography prefix at all).
2. Hierarchy resolves ambiguity only: use parent/leaf (e.g. "science/psychology") only when the bare
   leaf term is genuinely ambiguous on its own. If a term is self-identifying, keep it flat.
3. Drop attribution tags: a source's author or publisher name (e.g. "wolfram") is not a subject tag -
   it duplicates the note's own source/author frontmatter field. Never tag a person or publication
   as if it were the topic.
4. Drop specific-instance tags in favour of the general category: a numbered example, edition, or
   named instance of a broader concept (e.g. "rule-30" when the note is about elementary cellular
   automata generally) does not deserve its own tag - the specific instance belongs in trivia, not
   as a tag. Tag the category the note is actually teaching, not its most-cited example.
5. Never tag the same discipline twice under two different roots (e.g. don't keep both
   "computer-science" and "technology/computing" on one note - pick the one that fits the note's
   actual angle and drop the other).
6. A proper noun or place name is not on its own a tag - tag the CONCEPT it exemplifies, not the
   entity itself.
7. 1-3 words per tag, hyphenated if more than one word. No stopword joiners (and, of, in, on, for,
   with, the, by, at). No commas, no sentence fragments, no numbers as the leading token.

WORKED EXAMPLES (this is the correction quality expected):

Example A - a note on 19th-century boxing/savate "shift punching" techniques.
  WRONG (existing): boxing-history, combat-techniques, history, savate, sports
  CORRECT: sports/combat, sports/boxing, sports/savate, sports/history
  Why: "combat" is a leaf under sports (parallel to the existing "sports/mma"), not its own root.
  Bare "history" is wrong when the note is specifically about the history of a sport - "sports/history"
  disambiguates correctly. "combat-techniques" collapses into "sports/combat".

Example B - a MathWorld note on elementary cellular automata (rule 30 used as the running example).
  WRONG (existing): cellular-automata, computer-science, maths, rule-30, technology/computing, wolfram
  CORRECT: cellular-automata, maths, computer-science
  Why: "cellular-automata" is specific and unambiguous - stays flat, no parent needed. "maths" and
  "computer-science" are both genuinely relevant co-tags (the topic straddles both disciplines) -
  keep both, they aren't mutually exclusive. "rule-30" is one of 256 numbered instances, not a
  category - drop it (it belongs in trivia if narratively interesting). "wolfram" is an attribution
  (the source/author), not a subject - drop it. "technology/computing" duplicates "computer-science"
  under a different root - drop the redundant one.

Output EXACTLY one section with a ## header. No extra text.

## TAGS
The corrected tag list for this note. One tag per line. This REPLACES the existing tags entirely -
do not just echo what's already there unless it's genuinely correct as-is.
If the existing tags are already fully correct: list them again unchanged.`;
}

function buildS3Prompt(noteContent, sourceUrl, useFullContent, vocabList) {
  const content = sourceUrl ? 'Source URL: '+sourceUrl+'\n\n'+noteContent : noteContent;
  const body = useFullContent ? content : content.slice(0, S3_MAX_CHARS);
  const vocabBlock = (vocabList && vocabList.length) ? vocabList.join(', ') : '(none loaded)';
  return `You are an expert analyst extracting narrative-ready material and applying quality tags to a personal knowledge note.

Content:
${body}

EXISTING TAG VOCABULARY (prefer these where they genuinely fit \u2014 reuse over inventing a near-duplicate):
${vocabBlock}

Output EXACTLY these three sections with ## headers. No extra text.

## TAGS
List 3-8 tags that genuinely and specifically describe this note's actual subject matter.
Prefer an exact match from the EXISTING TAG VOCABULARY above when one truly fits.
When nothing in the existing vocabulary captures the specific concept, propose a new
tag rather than settling for a vague parent category \u2014 specificity matters more than
vocabulary reuse. One tag per line.

Two ontological rules, both non-negotiable:
- Geography is a co-tag, never a parent: write "india" + "culture/food", never
  "india/food" \u2014 UNLESS the concept has no meaningful existence outside that
  geography and the term itself is unambiguous without it (e.g. "carnatic",
  "bharatanatyam" need no geography prefix at all).
- Use parent/leaf hierarchy ONLY to resolve genuine ambiguity (e.g. "science/psychology"
  because bare "psychology" overlaps philosophy). If a term is self-identifying on its
  own, propose it flat, not nested.

Tag shape rules:
- 1-3 words, hyphenated if more than one (e.g. "crusader-states", not "crusader states").
- A proper noun or place name is not on its own a tag \u2014 tag the CONCEPT the place/person
  exemplifies, not the entity itself (reject "adyar-library-and-research-centre"; a note
  about a Chennai photography archive might instead earn "archival-photography" + "india").
- No stopword joiners (and, of, in, on, for, with, the, by, at) inside a tag.
- No commas, no sentence fragments, no numbers as the leading token.

If genuinely nothing fits: "No tags identified."

## VERIFIED FACTS
Bullet list: claims directly stated AND matching broad consensus an educated adult knows.
Tag non-trivial knowledge [domain]. Use \u26a0\ufe0f for imprecise/context-dependent claims.
If none: "No claims meet strict verified-facts criteria."

## TRIVIA NUGGETS
Exhaustive list (aim for 5-15, do not artificially limit): every surprising, specific,
verifiable micro-fact tied to explicit terms in the content \u2014 names, dates, numbers,
etymologies, firsts, records, ironies, coincidences, causal chains most readers would
not already know. These are the raw material for engaging narrative generation:
favour concrete and quotable over general. Tag: [etymology], [history], [science], etc.
+ [training knowledge - unverified] if drawn from model training rather than the text.
If none: "No trivia-grade facts identified."

Be conservative on VERIFIED FACTS. Be generous and thorough on TRIVIA NUGGETS \u2014 this section is the priority. Be expressive and specific on TAGS \u2014 do not default to vague generic tags when a precise one is available.`;
}
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
function parseS3Response(text, vocabSet) {
  const clean = text.replace(/^```[a-z]*\n/m,'').replace(/```\s*$/m,'').trim();
  const sections = { tags:[], verified:[], trivia:[] };
  for (const part of clean.split(/^##\s+/m)) {
    const lines = part.trim().split('\n');
    const header = lines[0].trim().toUpperCase();
    const body   = lines.slice(1).join('\n').trim();
    if (header.includes('TAGS'))             sections.tags     = parseTagLines(body);
    else if (header.includes('VERIFIED'))    sections.verified = parseBullets(body);
    else if (header.includes('TRIVIA'))      sections.trivia   = parseBullets(body);
  }
  // Every tag goes through HIL review (tag_vocabulary status='pending') before
  // being applied to a note. Exact vocabulary matches are marked auto-approvable
  // by the caller; novel proposals wait for a human in the /review-tags page.
  return sections;
}

// Parses a one-tag-per-line block into a clean array. No vocabulary gate here -
// deliberately expressive. Only rejects clear garbage shapes (commas, sentence
// fragments, stopword-joined phrases, numeric-leading tokens, overlong strings)
// so the human review queue isn't flooded with obvious noise, while still
// letting genuinely specific, correct tags like "crusader-states" or "sultan"
// through even when they aren't yet in the canonical vocabulary.
const TAG_STOPWORDS = new Set(['and','in','for','with','the','by','at','to','from','as','is','was','a','an']);
function isSaneTagShape(t) {
  if (!t || t.length < 2) return false;
  if (t.length > 35) return false;
  if (/[,.]/.test(t)) return false;
  if (/^[\d\u2013-]/.test(t)) return false;
  const parts = t.split('/').join('-').split('-');
  if (parts.length > 4) return false;
  if (parts.some(p => TAG_STOPWORDS.has(p))) return false;
  return true;
}
function parseTagLines(text) {
  if (/^no (canonical |new )?tags?/i.test(text.trim())) return [];
  return text.split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').trim().toLowerCase())
    .filter(l => l.length > 1 && !/^no /i.test(l))
    .filter(isSaneTagShape);
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
// OpenRouter free-model discovery + round-robin now delegated entirely to
// failsafe-llm-model-resolver (fetchFreeModels/getNextFreeModel) - same
// contract as the functions this replaces, live-fetched and cached there
// instead of duplicated here.

// ---------------------------------------------------------------------------
// OPENROUTER: self-healing using live free models from OpenRouter API
// ---------------------------------------------------------------------------
async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  let lastErr = null;
  resetFreeModelIndex();   // reset for this call

  // Reasonable max attempts using live free models
  for (let attempt = 0; attempt < 10; attempt++) {
    const model = await getNextFreeModel(OPENROUTER_API_KEY);

    try {
      const startTime = Date.now();
      log('info', 'OpenRouter trying model', { model });

      const heartbeat = setInterval(function() {
        log('info', 'OpenRouter still waiting...', { model, elapsedSec: Math.round((Date.now()-startTime)/1000) });
      }, 5000);

      let res;
      try {
        res = await httpPost(
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
      } finally {
        clearInterval(heartbeat);
      }

      const elapsedSec = Math.round((Date.now()-startTime)/1000);
      log('info', 'OpenRouter responded', { model, status: res.status, elapsedSec });

      if (res.status === 429) {
        log('warn', 'OpenRouter rate-limited, trying next', { model });
        lastErr = new Error('rate-limited: ' + model);
        continue;
      }

      if (res.status !== 200) {
        log('warn', 'OpenRouter error, trying next', { model, status: res.status });
        lastErr = new Error('OpenRouter error ' + res.status);
        continue;
      }

      const choice = (res.body.choices || [])[0];
      if (!choice?.message?.content) {
        log('warn', 'OpenRouter empty response, trying next', { model });
        lastErr = new Error('empty response from ' + model);
        continue;
      }

      const usage = res.body.usage || {};
      log('info', 'OpenRouter success', { model });

      return {
        text:       choice.message.content,
        tokensIn:   usage.prompt_tokens || 0,
        tokensOut:  usage.completion_tokens || 0,
        provider:   'openrouter'
      };

    } catch (e) {
      log('warn', 'OpenRouter attempt failed', { model, err: e.message });
      lastErr = e;
    }
  }

  throw lastErr || new Error('All OpenRouter models exhausted');
}

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  // NOTE: as of this integration, failsafe-llm-model-resolver's Gemini path has
  // a known bug (scoping error in its internal filter) that always falls
  // through to the pinned fallback below - live Gemini resolution doesn't yet
  // work end-to-end. Safe either way: resolveModel's own try/catch guarantees
  // a usable model id regardless, and GEMINI_MODEL is that fallback.
  const resolved = await resolveModel('gemini', GEMINI_API_KEY, { fallback: GEMINI_MODEL });
  log('info', 'Gemini model resolved', resolved);
  const res = await httpPost('generativelanguage.googleapis.com',
    '/v1beta/models/'+resolved.id+':generateContent?key='+GEMINI_API_KEY, {},
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

async function callGrok(prompt) {
  if (!XAI_API_KEY) throw new Error('XAI_API_KEY not set');

  const resolved = await resolveModel('xai', XAI_API_KEY, { fallback: 'grok-4' });

  const startTime = Date.now();
  log('info', 'Grok request sent', { model: resolved.id, resolvedVia: resolved.source });

  const heartbeat = setInterval(function() {
    log('info', 'Grok still waiting...', { elapsedSec: Math.round((Date.now()-startTime)/1000) });
  }, 5000);

  let res;
  try {
    res = await httpPost('api.x.ai', '/v1/chat/completions',
      { 'Authorization': 'Bearer ' + XAI_API_KEY },
      {
        model: resolved.id,
        messages: [
          { role: 'system', content: S3_SYSTEM },
          { role: 'user',   content: prompt }
        ],
        max_tokens: 8192,
        temperature: 0.1
      }
    );
  } finally {
    clearInterval(heartbeat);
  }

  const elapsedSec = Math.round((Date.now()-startTime)/1000);
  log('info', 'Grok responded', { status: res.status, elapsedSec });

  if (res.status !== 200) throw new Error('Grok error '+res.status+': '+JSON.stringify(res.body).slice(0,200));
  const choice = (res.body.choices||[])[0];
  if (!choice || !choice.message || !choice.message.content) throw new Error('Grok empty response');
  const usage = res.body.usage || {};
  return { text: choice.message.content, tokensIn: usage.prompt_tokens||0, tokensOut: usage.completion_tokens||0, provider: 'grok' };
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

// Chunk cache dir: ~/quarry/chunks/<note_id>/chunk-N.txt
// Written immediately after each successful chunk.
// On restart, already-written chunks are read from disk, skipping the API call.
function chunkCacheDir(noteId) {
  return path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'chunks', String(noteId));
}
function chunkCachePath(noteId, i) {
  return path.join(chunkCacheDir(noteId), 'chunk-'+i+'.txt');
}
function clearChunkCache(noteId) {
  const dir = chunkCacheDir(noteId);
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(function(f) { fs.unlinkSync(path.join(dir,f)); });
    fs.rmdirSync(dir);
  }
}

async function compressInChunks(body, listFmt, db, noteId) {
  const words  = body.split(/\s+/);
  const total  = Math.ceil(words.length / CHUNK_WORD_LIMIT);
  const dir    = chunkCacheDir(noteId);
  fs.mkdirSync(dir, {recursive:true});

  log('info', 'mindful-wc chunking', {chunks:total, totalWords:words.length, cacheDir:dir});

  const compressed = [];
  for (let i=0; i<total; i++) {
    const cachePath = chunkCachePath(noteId, i);

    // Resume: if chunk already on disk, reuse it
    if (fs.existsSync(cachePath)) {
      const cached = fs.readFileSync(cachePath, 'utf8');
      compressed.push(cached);
      log('info', 'mindful-wc chunk (cached)', {chunk:i+1, of:total});
      continue;
    }

    const chunkWords = words.slice(i*CHUNK_WORD_LIMIT, (i+1)*CHUNK_WORD_LIMIT);
    const chunkText  = chunkWords.join(' ');
    const prompt     = buildMindfulPrompt(chunkText, null, listFmt, i+1, total);

    log('info', 'mindful-wc chunk', {chunk:i+1, of:total});
    const result = await callGeminiMindful(prompt);
    const text   = result.text.trim();
    recordSpend(db, 'gemini', 'mindful-wc', noteId, result.tokensIn, result.tokensOut);

    // Persist immediately — survives crash/timeout on later chunks
    fs.writeFileSync(cachePath, text, 'utf8');
    compressed.push(text);
  }

  // All chunks done — clear cache
  clearChunkCache(noteId);
  return compressed.join('\n\n');
}

async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const resolved = await resolveModel('anthropic', ANTHROPIC_API_KEY, { fallback: CLAUDE_MODEL });
  log('info', 'Claude model resolved', resolved);
  const res = await httpPost('api.anthropic.com', '/v1/messages',
    {'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
    {model:resolved.id, max_tokens:8192, system:S3_SYSTEM, messages:[{role:'user',content:prompt}]}
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
  if (provider==='grok')        return callGrok(prompt);
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
    "SELECT id,title,filepath,word_count,source_url FROM vault_notes WHERE word_count>? AND (quarry_exclude IS NULL OR quarry_exclude=0) AND content_type IN ('article','note','video') ORDER BY word_count DESC LIMIT ?"
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
        newBody = await compressInChunks(body, listFmt, db, note.id);
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
let _vocabCache = null;
let _vocabSetCache = null;
function getVocabList(db) {
  if (_vocabCache) return _vocabCache;
  const rows = db.prepare("SELECT tag_full FROM tag_vocabulary WHERE status = 'approved' ORDER BY tag_full").all();
  _vocabCache = rows.map(r => r.tag_full);
  _vocabSetCache = new Set(_vocabCache);
  return _vocabCache;
}
function getVocabSet(db) {
  if (!_vocabSetCache) getVocabList(db);
  return _vocabSetCache;
}

async function processNote(db, note, switchLevel, provider, useFullContent) {
  const body     = readNoteBody(note.filepath);
  const vocab    = getVocabList(db);
  const vocabSet = getVocabSet(db);
  const prompt   = buildS3Prompt(body, note.source_url, useFullContent, vocab);

  if (MODE_DRY) {
    console.log('\n=== DRY RUN Switch-'+switchLevel+' ('+provider+') — '+note.title+' ===');
    console.log(prompt.slice(0,400)+'...\n');
    return;
  }

  checkBudget(db, provider);
  log('info', 'Calling Switch-'+switchLevel+' API', {title:note.title.slice(0,60), provider, words:note.word_count, chars:body.length});

  const result = await callApi(prompt, provider);
  const parsed = parseS3Response(result.text, vocabSet);

  db.exec('BEGIN');
  try {
    writeClassificationsToDb(db, note.id, parsed, switchLevel);
    // Tags no longer write directly to note_tags - every suggestion (whether
    // already in the canonical vocabulary or brand new) goes to the HIL
    // review queue. This keeps the vault's real tags human-approved while
    // still letting the model be as expressive as the note warrants.
    if (parsed.tags && parsed.tags.length) writeProposedTags(db, note.id, parsed.tags, vocabSet);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }

  const cost = recordSpend(db, result.provider, switchLevel===4?'classifier-s4':'classifier', note.id, result.tokensIn, result.tokensOut);
  log('info', 'Switch-'+switchLevel+' complete', {title:note.title.slice(0,60), provider:result.provider, tagsProposed:parsed.tags.length, verified:parsed.verified.length, trivia:parsed.trivia.length, cost_usd:cost.toFixed(5)});
}

// Re-review pass: corrects an ALREADY-TAGGED note's tags against the refined
// ontology (see buildRetagPrompt's worked examples). Does not touch
// verified/trivia - marks retagged_at, not classification_at.
async function processNoteRetag(db, note, provider, useFullContent) {
  const body     = readNoteBody(note.filepath);
  const vocab    = getVocabList(db);
  const vocabSet = getVocabSet(db);

  // Existing context = real note_tags UNION any not-yet-approved proposals
  // already sitting in the HIL queue for this note. A note can have zero
  // real tags but several pending proposals - both count as "existing" for
  // the purpose of correction, since the user may be looking at exactly
  // those pending proposals when deciding this note needs a retag.
  const realTags = db.prepare('SELECT tag_full FROM note_tags WHERE note_id=?').all(note.id).map(r=>r.tag_full);
  const pendingTags = db.prepare("SELECT tag_full FROM note_tag_proposals WHERE note_id=? AND status='pending'").all(note.id).map(r=>r.tag_full);
  const existingTags = Array.from(new Set([...realTags, ...pendingTags])).sort();

  const prompt = buildRetagPrompt(body, note.source_url, useFullContent, vocab, existingTags);

  if (MODE_DRY) {
    console.log('\n=== DRY RUN Retag ('+provider+') — '+note.title+' ===');
    console.log('Existing tags (real+pending): '+(existingTags.join(', ')||'(none)'));
    console.log(prompt.slice(0,600)+'...\n');
    return;
  }

  checkBudget(db, provider);
  log('info', 'Calling Retag API', {title:note.title.slice(0,60), provider, existingTags, words:note.word_count, chars:body.length});

  const result = await callApi(prompt, provider);
  const parsed = parseS3Response(result.text, vocabSet);

  db.exec('BEGIN');
  try {
    // Supersede any old pending proposals for this note first, so the
    // review queue doesn't end up showing both the pre-correction and
    // post-correction suggestions side by side.
    const now = new Date().toISOString();
    db.prepare("UPDATE note_tag_proposals SET status='superseded', reviewed_at=? WHERE note_id=? AND status='pending'").run(now, note.id);

    if (parsed.tags && parsed.tags.length) writeProposedTags(db, note.id, parsed.tags, vocabSet);
    db.prepare('UPDATE vault_notes SET retagged_at=? WHERE id=?').run(now, note.id);
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }

  const cost = recordSpend(db, result.provider, 'retag', note.id, result.tokensIn, result.tokensOut);
  log('info', 'Retag complete', {title:note.title.slice(0,60), provider:result.provider, existingTags, proposedTags:parsed.tags, cost_usd:cost.toFixed(5)});
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
  log('info', 'QUARRY tagger v0.8 starting', {swVocab:SW_VOCAB,sw3:SW3,sw3Retag:SW3_RETAG,sw4:SW4,syncWc:SYNC_WC,mindfulWc:MINDFUL_WC,dryRun:MODE_DRY,provider:PROVIDER_ARG||'auto'});

  const db = openDb();

  if (MODE_STATUS) { printStatus(db); db.close(); return; }
  if (SYNC_WC)     { await runSyncWc(db); printStatus(db); db.close(); return; }
  if (MINDFUL_WC)  { await runMindfulWc(db); if (!MODE_DRY) printStatus(db); db.close(); return; }

  const provider = PROVIDER_ARG || (OPENROUTER_API_KEY ? 'openrouter' : GEMINI_API_KEY ? 'gemini' : 'claude');
  const useFullContent = SW4 || ((SW3 || SW3_RETAG) && providerHasLargeContext(provider));

  // Select notes
  let notes = [];
  if (SINGLE_FILE) {
    const fp = path.resolve(SINGLE_FILE);
    const note = db.prepare('SELECT * FROM vault_notes WHERE filepath=?').get(fp);
    if (!note) { log('error','File not in index',{filepath:fp}); db.close(); return; }
    notes = [note];
  } else if (SW4) {
    notes = db.prepare(
      "SELECT * FROM vault_notes WHERE word_count>=? AND content_type IN ('article','note','video') AND id NOT IN (SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4) ORDER BY word_count DESC LIMIT ?"
    ).all(S4_MIN_WORDS, LIMIT===Infinity?999999:LIMIT);
  } else if (SW3) {
    notes = db.prepare(
      "SELECT * FROM vault_notes WHERE classification_at IS NULL AND content_type IN ('article','note','video') AND word_count>200 ORDER BY word_count DESC LIMIT ?"
    ).all(LIMIT===Infinity?999999:LIMIT);
  } else if (SW3_RETAG) {
    // Eligible = has real tags OR has at least one pending proposal sitting
    // in the HIL queue (not yet approved into note_tags). Either counts as
    // "has tag activity worth reviewing".
    notes = db.prepare(
      `SELECT * FROM vault_notes
       WHERE retagged_at IS NULL
       AND (quarry_exclude IS NULL OR quarry_exclude=0)
       AND (has_tags=1 OR id IN (SELECT DISTINCT note_id FROM note_tag_proposals WHERE status='pending'))
       ORDER BY word_count DESC LIMIT ?`
    ).all(LIMIT===Infinity?999999:LIMIT);
  } else {
    notes = db.prepare('SELECT * FROM vault_notes WHERE has_tags=0 ORDER BY word_count DESC LIMIT ?').all(LIMIT===Infinity?999999:LIMIT);
  }

  log('info', 'Notes selected', {count:notes.length});
  if (!notes.length) { log('info','No eligible notes'); printStatus(db); db.close(); return; }

  let vocab = SW_VOCAB ? loadTagVocabulary(db) : null;

  for (const note of notes) {
    try {
      if (SW_VOCAB) {
        const body = readNoteBody(note.filepath);
        const tags = switchVocabTags(note.filepath, body, note.first_paragraph, note.title, vocab);
        if (tags.length) {
          if (MODE_DRY) {
            log('info', 'Would tag (switch-vocab)', {title:note.title.slice(0,60), tags});
          } else {
            db.exec('BEGIN'); writeTagsToDb(db, note.id, tags, 'vocab'); db.exec('COMMIT');
            log('info','Vocab-tagged',{title:note.title.slice(0,60),tags});
          }
        }
      }
      if (SW3 || SW4) {
        await processNote(db, note, SW3?3:4, provider, useFullContent);
      }
      if (SW3_RETAG) {
        await processNoteRetag(db, note, provider, useFullContent);
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