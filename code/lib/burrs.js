'use strict';
const { jsonrepair } = require('jsonrepair');
/**
 * QUARRY lib/burrs.js — the burr contract: schema, prompt, parser and VERIFIER.
 *
 * A burr is one atomic, citable claim from one note, with a verbatim quote as evidence.
 * Constitution (Muse): the LLM proposes, code verifies. Nothing the verifier cannot tie
 * back to the note's own text is ever stored.
 *
 * Pure functions only (no I/O), so they are unit-tested in nuggetizer.test.js.
 */
const crypto = require('crypto');
const L = require('./bristles');
const U = require('./units');

const PROMPT_VERSION = 'nug-v6';
const SCHEMA_VERSION = 'burr-v1';
const MAX_BODY_CHARS = 6000;
const MAX_BURRS      = 6;
const MAX_BURRS_LONG = 10;   // notes over LONG_NOTE_CHARS
const MAX_BURRS_XL   = 14;   // notes over XL_NOTE_CHARS (nug-v5: the late burrs of long notes were as good as the early ones)
const LONG_NOTE_CHARS = 1200;
const XL_NOTE_CHARS   = 2500;
function burrCap(cleaned) { const n = String(cleaned || '').length; return n > XL_NOTE_CHARS ? MAX_BURRS_XL : n > LONG_NOTE_CHARS ? MAX_BURRS_LONG : MAX_BURRS; }

// nug-v5: entity, place and material hooks carry a coarse category, so "Panini" the grammarian and "Panini" the
// sandwich can be told apart without context similarity. Anything else the model writes becomes 'other'.
const CATEGORIES = ['person', 'place', 'organisation', 'work', 'event', 'food', 'animal', 'plant', 'substance', 'object', 'concept', 'language', 'myth', 'other'];
const CAT_HOOKS  = ['entity', 'place', 'material'];

const KINDS         = ['fact', 'etymology', 'aside', 'pattern', 'opinion'];
// Hook values of these types must be found in the note text; the others are abstract phrases.
const STRICT_HOOKS  = ['entity', 'time', 'number', 'etymon', 'material', 'place', 'homonym'];
const LOOSE_HOOKS   = ['set', 'uniqueness', 'mechanism', 'former-role'];
const HOOK_TYPES    = STRICT_HOOKS.concat(LOOSE_HOOKS);

// Single source of truth for the Muse tables: migrate.js (M012) and the tests both use it.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS muse_runs (
  run_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  seed         INTEGER,
  params_json  TEXT,
  versions_json TEXT
);
CREATE TABLE IF NOT EXISTS burrs (
  id             INTEGER PRIMARY KEY,
  note_id        INTEGER NOT NULL,
  claim          TEXT NOT NULL,
  quote          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'fact',
  hooks_json     TEXT,
  loop_text      TEXT,
  perishable     INTEGER NOT NULL DEFAULT 0,
  provenance     TEXT NOT NULL DEFAULT 'vault',
  method         TEXT NOT NULL DEFAULT 'llm',
  prompt_version TEXT NOT NULL,
  model          TEXT,
  run_id         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_burrs_note ON burrs(note_id);
CREATE INDEX IF NOT EXISTS idx_burrs_kind ON burrs(kind);
CREATE TABLE IF NOT EXISTS nuggetize_status (
  note_id        INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL,
  n_burrs        INTEGER DEFAULT 0,
  n_rejected     INTEGER DEFAULT 0,
  reasons_json   TEXT,
  model          TEXT,
  run_id         TEXT,
  at             TEXT NOT NULL,
  PRIMARY KEY (note_id, prompt_version)
);
CREATE TABLE IF NOT EXISTS nuggetize_cache (
  cache_key     TEXT PRIMARY KEY,
  response_text TEXT NOT NULL,
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_disposition (
  note_id    INTEGER PRIMARY KEY,
  bucket     TEXT,
  disposition TEXT NOT NULL,
  reason     TEXT,
  decided_by TEXT NOT NULL DEFAULT 'rule',
  decided_at TEXT NOT NULL
);
`;

// Claims about the note/URL/image rather than about the world (observed in the first 300-note trial).
const META_CLAIM = /^(the |this )(note|page|article|post|file|url|source url|web ?page|website|link itself)\b(?!\s+(states|says|argues|claims|explains|reports|notes that|describes)\b)|\b(is|are|was) (mentioned|referenced)\b|\b(is|are|was|were) credited\b|^the (author|writer) of (the|this) (note|article|page|post)\b|\b(is|are) (freely )?available (for|to) (free )?(download|streaming|read)|\bto digiti[sz]e\b|\bdigiti[sz]ed (by|with)\b/i;

const NUM_WORDS = { 10: ['ten', 'tenth'], 11: ['eleven', 'eleventh'], 12: ['twelve', 'twelfth'], 13: ['thirteen', 'thirteenth'],
  14: ['fourteen', 'fourteenth'], 15: ['fifteen', 'fifteenth'], 16: ['sixteen', 'sixteenth'], 17: ['seventeen', 'seventeenth'],
  18: ['eighteen', 'eighteenth'], 19: ['nineteen', 'nineteenth'], 20: ['twenty', 'twentieth'], 30: ['thirty', 'thirtieth'],
  40: ['forty', 'fortieth'], 50: ['fifty', 'fiftieth'], 60: ['sixty'], 70: ['seventy'], 80: ['eighty'], 90: ['ninety'], 100: ['hundred'] };
// True if the number n (a digit string) appears in text as digits or as a number word.
function hasNum(text, n) {
  const t = String(text).replace(/(\d),(?=\d)/g, '$1');
  if (t.indexOf(n) >= 0) return true;
  const w = NUM_WORDS[parseInt(n, 10)];
  if (!w) return false;
  const low = t.toLowerCase();
  return w.some(function (x) { return new RegExp('\\b' + x + '\\b').test(low); });
}

// S3-05: lone digits (the 3 in "3 tigers") are checked too, as whole numbers: never inside a longer number, never a decimal part (3.5),
// never the hour of a clock time (6:30; the minutes are checked as a two-digit number). Superscripts count as digits (10⁶ = 10^6).
const SMALL_WORDS = { 1: ['one', 'first'], 2: ['two', 'second'], 3: ['three', 'third'], 4: ['four', 'fourth'], 5: ['five', 'fifth'],
  6: ['six', 'sixth'], 7: ['seven', 'seventh'], 8: ['eight', 'eighth'], 9: ['nine', 'ninth'] };
const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };
function plainDigits(s) { return String(s).replace(/(\d),(?=\d)/g, '$1').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, function (c) { return '^' + SUPERSCRIPT[c]; }); }
function singleDigitsIn(text) { return plainDigits(text).match(/(?<![\d.])\d(?!\d|\.\d|:\d\d)/g) || []; }
function hasSingleDigit(text, d) {
  const t = plainDigits(text);
  if (new RegExp('(?<![\\d.])' + d + '(?!\\d|\\.\\d)').test(t)) return true;
  const low = t.toLowerCase();
  return (SMALL_WORDS[d] || []).some(function (w) { return new RegExp('\\b' + w + '\\b').test(low); });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function splitFrontmatter(raw) {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? { fm: m[0], body: raw.slice(m[0].length) } : { fm: '', body: raw };
}

// Body as the model sees it: image embeds removed (they carry no text), long runs of blank lines
// collapsed, capped at MAX_BODY_CHARS. The verifier checks quotes against THIS text.
// nug-v5: web links are not evidence. [text](url) becomes text, footnote links like [1](url) vanish, bare URLs are dropped.
function stripLinks(t) {
  return String(t == null ? '' : t)
    .replace(/\[\d+\]\((?:https?:\/\/|www\.)[^)\s]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)\s]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)[^\s)\]>"'\u201d\u2019]+/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

function cleanBody(body) {
  let t = String(body || '').replace(/!\[\[[^\]]*\]\]/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = stripLinks(t);
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_BODY_CHARS ? t.slice(0, MAX_BODY_CHARS) : t;
}

function realWordCount(text) {
  const plain = String(text || '')
    .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[\[|\]\]|[*_#>`|\\-]/g, ' ');
  return (plain.match(/[\p{L}\p{N}']+/gu) || []).length;
}

// Deterministic evidence units: one per line, long lines split at sentence ends, then at ~300 chars.
// The model cites unit numbers; code builds the quote from them, so a quote can never be misquoted.
const UNIT_MAX = 300;
function segment(cleaned) {
  const units = [];
  String(cleaned || '').split(/\r?\n/).forEach(function (line) {
    const t = squash(line);
    if (!t) return;
    const sents = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c(\[])/);
    sents.forEach(function (sent) {
      let rest = sent;
      while (rest.length > UNIT_MAX) {
        let cut = rest.lastIndexOf(' ', UNIT_MAX);
        if (cut < UNIT_MAX / 2) cut = UNIT_MAX;
        units.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) units.push(rest);
    });
  });
  return units;
}

function buildInput(note, cleaned) {
  const lines = segment(cleaned).map(function (u, i) { return '[' + (i + 1) + '] ' + u; });
  return 'SOURCE_URL: ' + (note.source_url || 'none') + '\n[T] ' + squash(stripLinks(note.title)) + '\n' + lines.join('\n');
}

function buildPrompt(note, cleaned) {
  const system = 'You extract atomic, citable claims from ONE personal note for a quiz author\'s research tool. You never add facts.';
  const prompt =
`Extract the specific facts ("burrs") that this note states. Rules:
1. Use ONLY what the note states (title included). Never add outside knowledge, never correct the note, never infer unstated causes or dates.
2. A burr is ONE claim a quiz author could cite, written as a complete plain sentence with the specifics (names, dates, numbers, places). A topic label or a bare link title is not a burr. Write each claim so it makes sense with no other context: name the people and things, no pronouns, no "the fungus" or "the author". State facts neutrally: no judgement words like "iconic" unless the note attributes them to someone.
3. "src": the ids of the 1 to 3 numbered lines that state the claim, e.g. ["T"] for the title or [2,3]. Give ids only; do not copy text. Cite only lines that really contain the claim.
4. Every number or year in "claim" must appear in the cited lines.
5. "kind": fact | etymology | aside | pattern | opinion. "aside" = a side detail in a digression; "pattern" = a streak, gap or count across a list or table; "etymology" = where a word or name comes from.
6. "hooks": handles another note could share: [{"type": T, "value": V, "cat": C}] where T is one of: entity, time, number, etymon, material, place, homonym, set, uniqueness, mechanism, former-role. For entity, time, number, etymon, material, place and homonym, V must be copied exactly from the note. For set, uniqueness, mechanism and former-role, V is a short phrase. For entity, place and material add "cat", the kind of thing V is here, one of: person, place, organisation, work, event, food, animal, plant, substance, object, concept, language, myth, other (so "Mercury" the planet and "Mercury" the metal differ: place vs substance).
6b. nug-v6, time hooks: V is a calendar year or decade as written in the note ("1066", "476", "1960s"); add "era": "AD" or "BC". Use "AD" for a year after 1000 when the note gives no era; if you cannot tell the era, leave the hook out. A duration or an age ("150 years", "three decades", "1400 years ago", "aged 30", "2000 years old") is NOT a time hook: make it a number hook with unit "year". A century ("the 2nd century BC") is a time hook whose value is the century as written and whose era is AD or BC.
6c. nug-v6, number hooks: V is a quantity written in the note; add "unit": what is counted or measured, as one lowercase singular word or a standard symbol (km, kg, usd, %, °c, run, person, tiger, page, year). Do not invent a unit the note does not imply. A number that is only a label or identifier (Windows 95, store #2000, Route 66, a jersey number, a year used as part of a name) is NOT a number hook: leave it out. Only number hooks carry "unit" and only time hooks carry "era".
7. "perishable": true if the claim is a present-tense figure or status that can go stale (a population, price, record, office holder, "currently", "today", "latest"); otherwise false.
8. Telegraphic notes are fine: turn shorthand into a sentence using only the words and facts in the note.
9a. Skip text that documents software, markup or website features (for example how links or headers work); it is not a fact about the world.
9. If the note holds no specific citable claim, return {"burrs": [], "reason": "<short reason>"}.
10. A burr must say something about the world: a person, thing, event, word, number or place. Never write a claim about the note itself, its title, a URL, a file name, an image or a web page ("The note is titled...", "The URL is about...", "The image is dated...", "The year 2006 is mentioned"). Link-only, image-only and bare-title notes have no burrs: return an empty list.
11. At most ${burrCap(cleaned)} burrs. Reply with JSON only, no prose, no code fences.

Example note:
[T] Quokka selfie craze, Rottnest, 2015
Reply: {"burrs":[{"claim":"Quokkas on Rottnest Island became a selfie craze in 2015.","src":["T"],"kind":"fact","hooks":[{"type":"entity","value":"Quokka","cat":"animal"},{"type":"place","value":"Rottnest","cat":"place"},{"type":"time","value":"2015","era":"AD"}],"perishable":false}],"reason":""}

Schema: {"burrs":[{"claim":"","src":[],"kind":"fact","hooks":[{"type":"","value":"","cat":"","unit":"","era":""}],"perishable":false}],"reason":""}

${buildInput(note, cleaned)}`;
  return { system, prompt };
}

function cacheKey(provider, input) {
  return sha256([PROMPT_VERSION, SCHEMA_VERSION, provider, input].join('\u0001'));
}

// Double a backslash that is not a valid JSON escape.
function fixBackslashes(s) { return s.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\'); }

// Gemini sometimes garbles a hook object's keys: {"type":"place":"Hassan",...}, {"type":"":"number","value":..},
// {"type":"type":"former-role",..}. The type (or the missing "value" key) is recoverable, so restore it. An object
// whose type is genuinely lost ({"type":"value":"X",...}) is dropped: one hook lost, the burr kept.
function fixHookKeys(s) {
  return s
    .replace(/,?\s*\{"type":"value":"(?:[^"\\]|\\.)*"(?:,"cat":"(?:[^"\\]|\\.)*")?\}/g, '')
    .replace(/"type":"type":"/g, '"type":"')
    .replace(/"type":"":"([\w-]+)","value"/g, '"type":"$1","value"')
    .replace(/"type":"([\w-]+)":"/g, '"type":"$1","value":"');
}
function parseModelJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, error: 'no_json' };
  let obj;
  let repaired = false;
  const body = t.slice(a, b + 1);
  try { obj = JSON.parse(body); }
  catch (e) {
    // Syntax damage (raw newline/tab in a string, unescaped inner quotes, truncation, trailing commas, single quotes, bad
    // tokens) is repaired by the jsonrepair library. Two repairs stay ours because they are about meaning, not syntax:
    // fixHookKeys (garbled hook keys) and fixBackslashes (keeps a lone backslash such as \\*bhares- instead of dropping it).
    // Content is still verified against the note afterwards, so a repaired parse cannot put anything into the store
    // that is not in the note.
    let lastErr = e;
    const attempts = [
      function (x) { return jsonrepair(fixBackslashes(fixHookKeys(x))); },
      function (x) { return jsonrepair(x); }
    ];
    for (let i = 0; i < attempts.length && !obj; i++) {
      try { obj = JSON.parse(attempts[i](body)); repaired = true; } catch (e2) { lastErr = e2; }
    }
    if (!obj) {
      const m = /position (\d+)/.exec(String(e.message || ''));
      const at = m ? Number(m[1]) : -1;
      const around = at >= 0 ? ' || near: ' + body.slice(Math.max(0, at - 70), at + 50).replace(/\s+/g, ' ') : '';
      return { ok: false, error: 'bad_json', detail: (String(e.message || e).slice(0, 110) + around) };
    }
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.burrs)) return { ok: false, error: 'bad_shape' };
  return { ok: true, repaired: repaired, burrs: obj.burrs, reason: typeof obj.reason === 'string' ? squash(obj.reason).slice(0, 200) : '' };
}

// Loose form of a string for matching only: straight quotes and dashes, no markdown/bracket marks,
// no space before punctuation, collapsed whitespace, lower case. Keeps a map back to the original
// so the STORED quote is always the exact source text, never the model's version of it.
function looseMap(text) {
  const out = [], idx = [];
  const src = String(text);
  for (let i = 0; i < src.length; i++) {
    let c = src[i];
    if (c === '\u2018' || c === '\u2019' || c === '\u02bc') c = "'";
    else if (c === '\u201c' || c === '\u201d') c = '"';
    else if (c === '\u2013' || c === '\u2014') c = '-';
    else if ('*_`[]()'.indexOf(c) >= 0) continue;
    if (/\s/.test(c)) { if (out.length && out[out.length - 1] !== ' ') { out.push(' '); idx.push(i); } continue; }
    if (',.;:!?'.indexOf(c) >= 0 && out.length && out[out.length - 1] === ' ') { out.pop(); idx.pop(); }
    out.push(c.toLowerCase()); idx.push(i);
  }
  while (out.length && out[out.length - 1] === ' ') { out.pop(); idx.pop(); }
  return { s: out.join(''), idx: idx };
}

// Returns the exact source substring matching the quote, or null.
// Order: exact, case-insensitive, then the loose form above (maps back to the original span).
function locateQuote(quote, hays) {
  const q = squash(quote);
  if (q.length < 3) return null;
  for (const h of hays) if (h.indexOf(q) >= 0) return q;
  const ql = q.toLowerCase();
  for (const h of hays) {
    const i = h.toLowerCase().indexOf(ql);
    if (i >= 0) return h.substr(i, q.length);
  }
  const lq = looseMap(q).s;
  if (lq.length < 6) return null;
  for (const h of hays) {
    const m = looseMap(h);
    const i = m.s.indexOf(lq);
    if (i >= 0) {
      const start = m.idx[i], end = m.idx[i + lq.length - 1] + 1;
      return squash(h.slice(start, end));
    }
  }
  return null;
}

// nug-v6: a time hook needs an era (AD or BC), a number hook needs a unit. Both are checked here; a hook whose era is missing
// or unknown, or whose unit is empty, a stray word, a digit string or a label word, is dropped (the burr is kept). The older
// claim-text rules in bristles.js still run as a cross-check: where they read the hook differently the result is stored in
// hook.xc, so the disagreements can be listed and reviewed.
const NOT_A_UNIT = new Set(['none', 'unknown', 'count', 'number', 'numeral', 'id', 'identifier', 'label', 'name', 'n/a', 'na', 'unit', 'units', 'value']);
function qualifyHook(type, value, claim, h) {
  const m = /^[$\u20ac\u00a3\u20b9\u00a5]?\s*(\d[\d,]*(?:\.\d+)?)\s*(s?)/.exec(value);
  if (!m) return null;
  const num = m[1].replace(/,/g, '');
  // Every place the number occurs in the claim ("between 200 BC and 200 AD" has two): the model agrees with the claim-text
  // reading if ANY occurrence reads the same way, so a repeated number is never flagged just because the first one differs.
  const reads = [];
  const re = new RegExp('(?<![\\d.,])' + num.replace(/^(\d+)/, function (d) { return d.split('').join(',?'); }).replace(/\./g, '\\.') + '(?!\\d)', 'g');
  let f; while ((f = re.exec(claim)) !== null) reads.push(L.qualifyNumber(f[0], claim, f.index, type));
  if (!reads.length) reads.push(L.qualifyNumber(value, claim, null, type));
  if (type === 'time') {
    const e = typeof h.era === 'string' ? h.era.trim().toLowerCase().replace(/[.\s]/g, '') : '';
    const era = (e === 'bc' || e === 'bce') ? 'bc' : (e === 'ad' || e === 'ce') ? 'ad' : '';
    if (!era || !/^\d{1,4}$/.test(num)) return null;
    if (/century/i.test(value)) return { era: era, grain: 'century', xc: '' };   // "2nd century BC": a coarse date; the claim scan reads it
    const y = (era === 'bc' ? -1 : 1) * parseInt(num, 10);
    const agree = reads.some(function (q) { return q.kind === 'year' && L.yearOfKey(q.key) === y; });
    const keys = reads.map(function (q) { return q.key; }).filter(Boolean);
    return { era: era, xc: agree || !keys.length ? '' : keys[0] };   // flagged only when the claim-text reading reads it differently, not when it reads nothing
  }
  const raw = typeof h.unit === 'string' ? h.unit.trim().toLowerCase() : '';
  if (!raw || raw.length > 24 || /\d/.test(raw) || NOT_A_UNIT.has(raw)) return null;
  const unit = U.normUnit(raw);
  if (!unit || U.junkUnit(unit.split(' ').pop())) return null;
  const agree = reads.some(function (q) { return q.kind === 'qty' && q.key === num + ' ' + unit; });
  const keys = reads.map(function (q) { return q.key; }).filter(Boolean);
  return { unit: unit, xc: agree || !keys.length ? '' : keys[0] };
}

/**
 * Verify what the model proposed against the note's own text.
 * note = { title, cleaned }  (cleaned = cleanBody output)
 * Returns { accepted: [{claim, quote, kind, hooks, perishable}], rejected: [{reason, claim}], hooksDropped }
 */
function verifyBurrs(burrsIn, note, opts) {
  const requireUnits = !opts || opts.requireUnits !== false;
  const title = squash(stripLinks(note.title)), body = squash(note.cleaned);
  const hays = [title, body];
  const units = segment(note.cleaned);
  const noteText = title + ' ' + body;
  const noteLower = noteText.toLowerCase();
  const accepted = [], rejected = [];
  const seen = new Set();
  let hooksDropped = 0;
  const cap = burrCap(note.cleaned);

  for (const b of burrsIn) {
    if (accepted.length >= cap) { rejected.push({ reason: 'over_cap', claim: squash(b && b.claim).slice(0, 80) }); continue; }
    if (!b || typeof b !== 'object' || typeof b.claim !== 'string' || (typeof b.quote !== 'string' && !Array.isArray(b.src))) {
      rejected.push({ reason: 'bad_shape', claim: '' }); continue;
    }
    const claim = squash(b.claim);
    if (claim.length < 8 || claim.length > 400) { rejected.push({ reason: 'claim_length', claim: claim.slice(0, 80) }); continue; }
    const key = claim.toLowerCase();
    if (seen.has(key)) { rejected.push({ reason: 'duplicate', claim: claim.slice(0, 80) }); continue; }

    let quote, evidence;
    if (Array.isArray(b.src)) {
      const parts = [];
      let bad = b.src.length === 0 || b.src.length > 5;   // prompt asks for <= 3; tolerate a few more
      b.src.forEach(function (raw) {
        // The model sometimes writes ids as strings ("10", "[10]", "T"); accept those forms.
        const id = typeof raw === 'string' ? raw.replace(/[\[\]\s]/g, '') : raw;
        const num = typeof id === 'string' && /^\d+$/.test(id) ? parseInt(id, 10) : id;
        if (id === 'T' || id === 't') parts.push(title);
        else if (Number.isInteger(num) && num >= 1 && num <= units.length) parts.push(units[num - 1]);
        else bad = true;
      });
      if (bad) { rejected.push({ reason: 'bad_src', claim: claim.slice(0, 80) }); continue; }
      evidence = parts.join(' ');
      quote = evidence.length > 300 ? evidence.slice(0, 300).replace(/\s\S*$/, '') : evidence;
    } else {
      quote = locateQuote(b.quote, hays);   // legacy path (nug-v1..v3 responses)
      if (!quote) { rejected.push({ reason: 'quote_not_in_note', claim: claim.slice(0, 80) }); continue; }
      if (quote.length > 300) { rejected.push({ reason: 'quote_too_long', claim: claim.slice(0, 80) }); continue; }
      evidence = noteText;
    }

    if (META_CLAIM.test(claim) || claim.split(' ').length < 3) { rejected.push({ reason: 'meta_claim', claim: claim.slice(0, 80) }); continue; }
    if (/^(https?:\/\/\S+|[\d\s.,\-\/]+)$/i.test(quote)) { rejected.push({ reason: 'bare_quote', claim: claim.slice(0, 80) }); continue; }

    const nums = claim.replace(/(\d),(?=\d)/g, '$1').match(/\d{2,}/g) || [];
    const checks = nums.map(function (n) { return [n, hasNum]; }).concat(singleDigitsIn(claim).map(function (n) { return [n, hasSingleDigit]; }));
    // Every number must be in the cited evidence. If it is elsewhere in the note, the unit that holds it
    // is added to the evidence (deterministic), so the stored quote always contains the number.
    let numFail = false;
    const extra = [];
    for (const [n, has] of checks) {
      if (has(evidence + ' ' + title + ' ' + extra.join(' '), n)) continue;
      const hit = Array.isArray(b.src) ? units.find(function (u) { return has(u, n); }) : null;
      if (hit && extra.length < 2) extra.push(hit); else { numFail = true; break; }
    }
    if (numFail) { rejected.push({ reason: 'number_not_in_note', claim: claim.slice(0, 80) }); continue; }
    if (extra.length) quote = (quote + ' ' + extra.join(' ')).trim();

    const hooks = [];
    for (const h of (Array.isArray(b.hooks) ? b.hooks : [])) {
      const type = h && typeof h.type === 'string' ? h.type.trim().toLowerCase() : '';
      const value = h && typeof h.value === 'string' ? squash(h.value) : '';
      if (HOOK_TYPES.indexOf(type) < 0 || !value || value.length > 120) { hooksDropped++; continue; }
      if (STRICT_HOOKS.indexOf(type) >= 0 && noteLower.indexOf(value.toLowerCase()) < 0) { hooksDropped++; continue; }
      const hook = { type: type, value: value };
      if (CAT_HOOKS.indexOf(type) >= 0) { const c = typeof h.cat === 'string' ? h.cat.trim().toLowerCase() : ''; hook.cat = CATEGORIES.indexOf(c) >= 0 ? c : (c ? 'other' : null); }
      if (requireUnits && (type === 'time' || type === 'number') && /\d/.test(value)) {
        const q = qualifyHook(type, value, claim, h);
        if (!q) { hooksDropped++; continue; }
        if (q.era) hook.era = q.era;
        if (q.grain) hook.grain = q.grain;
        if (q.unit) hook.unit = q.unit;
        if (q.xc) hook.xc = q.xc;
      }
      hooks.push(hook);
    }

    const kind = KINDS.indexOf(b.kind) >= 0 ? b.kind : 'fact';
    seen.add(key);
    accepted.push({ claim: claim, quote: quote, kind: kind, hooks: hooks, perishable: b.perishable === true ? 1 : 0 });
  }
  return { accepted: accepted, rejected: rejected, hooksDropped: hooksDropped };
}

module.exports = {
  PROMPT_VERSION, SCHEMA_VERSION, MAX_BODY_CHARS, MAX_BURRS, MAX_BURRS_LONG, MAX_BURRS_XL, CATEGORIES, burrCap, KINDS, HOOK_TYPES, SCHEMA_SQL,
  sha256, squash, splitFrontmatter, cleanBody, stripLinks, realWordCount, buildInput, buildPrompt,
  cacheKey, parseModelJson, locateQuote, segment, hasNum, hasSingleDigit, singleDigitsIn, verifyBurrs
};
