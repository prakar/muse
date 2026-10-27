'use strict';
// Link-judge contract (Muse Constitution Art. 3-4): input schema, output schema, cache key, verification, fallback = skip and flag.
// Task: given the burrs of one candidate spark (they share a handle), say yes / none / held. Pure functions only; no I/O here.
const crypto = require('node:crypto');
const { jsonrepair } = require('jsonrepair');

const PROMPT_VERSION = 'judge-spark-v2', SCHEMA_VERSION = '1';
const VERDICTS = ['yes', 'none', 'held'];
// The author's spark-view labels, mapped to verdicts. "apply"/"leave" answer rule recommendations, not the spark itself.
const LABEL_TO_VERDICT = { 'spark': 'yes', 'dull': 'none', 'trivial': 'none', 'held (keep juxtaposition)': 'held' };

function sparkLabels(rows, labelVersion) {
  const m = new Map();
  rows.filter(r => r.view === 'sparks' && (!labelVersion || r.version === labelVersion) && LABEL_TO_VERDICT[r.label])
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).forEach(r => m.set(r.id, LABEL_TO_VERDICT[r.label]));
  return m;
}

// Labels grouped by the nuggetizer version they were made on: Map version -> Map(id -> verdict). Each is rebuilt from its own version.
function sparkLabelsByVersion(rows) {
  const out = new Map();
  Array.from(new Set(rows.filter(r => r.view === 'sparks' && LABEL_TO_VERDICT[r.label]).map(r => r.version))).sort().forEach(v => out.set(v, sparkLabels(rows, v)));
  return out;
}

// Fixed dev/test split by hash of the label id, so prompt tuning never sees the test half.
function split(id) { return parseInt(crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 2), 16) % 2 === 0 ? 'dev' : 'test'; }

// Input: what the author's card shows. Max 6 burrs, the order of the card.
function buildInput(row) {
  return { handle: row.surface, types: row.types || [], burrs: (row.burrs || []).slice(0, 6).map(b => ({ id: b.id, note: b.note, claim: b.claim, quote: b.quote })) };
}

function systemPrompt(stance) {
  const held = stance !== 'strict';
  return [
    "You are the link judge in a quiz writer's idea tool. You see several facts (burrs), each from a different note in the writer's own vault. They were gathered because they share one handle: a word, name, date or value.",
    'Decide whether the facts form a real, usable connection.',
    'Verdicts:',
    '- "yes": the facts connect to EACH OTHER through the handle in a specific way beyond "they are all about X": the same event, a cause and its effect, a namesake or borrowed name, the same object or mechanism turning up in different settings, a role or fact that explains another. Test: can you state the link without merely repeating the handle? "Both are about Sydney" or "all mention Bolivia" fails this test.',
    held ? '- "held": the handle is a hub (a place, person, country, institution, period) and the facts show it in very different worlds, so there is no bridge between the facts, but putting them side by side is interesting. Name what is not known. Do not invent a bridge.' : '(Only "yes" and "none" are allowed.)',
    '- "none": no bridge and nothing worth holding. Use it when the handle is the same word with different meanings, when the facts only share a broad topic, when they sit in the same domain and add nothing to each other (two cricket facts about one cricketer), when they merely repeat each other, or when the link needs knowledge the facts do not contain.',
    'The same entity appearing in several facts is NOT a bridge by itself. Without a specific connection between the facts the answer is ' + (held ? '"held" (different worlds) or "none" (same world)' : '"none"') + ', never "yes".',
    'Rules: use only the facts given. Never add outside knowledge or embellish. Thematic overlap is not a bridge. Do not invent a link to be helpful; "none" is a good answer.',
    'Reply with JSON only: {"verdict":"' + (held ? 'yes|none|held' : 'yes|none') + '","link":"short relation phrase, or empty","burrs":[ids of the facts that carry the link],"gap":"what is not known (held only, else empty)","why":"one sentence, at most 40 words"}'
  ].join('\n');
}
function userPrompt(input) {
  const lines = ['Shared handle: ' + input.handle + (input.types.length ? ' (' + input.types.join(', ') + ')' : ''), '', 'Facts:'];
  input.burrs.forEach(b => lines.push('[' + b.id + '] (note: ' + b.note + ') ' + b.claim + '\n    source: "' + String(b.quote || '').replace(/\s+/g, ' ').slice(0, 300) + '"'));
  return lines.join('\n');
}
function cacheKey(provider, input, stance) {
  return crypto.createHash('sha1').update([PROMPT_VERSION, SCHEMA_VERSION, provider, stance || 'open', systemPrompt(stance), JSON.stringify(input)].join('\u0001')).digest('hex');
}

// Verify the model's answer against the input. Failure = { ok:false, error } and the caller skips and flags (never guesses).
function parseVerdict(text, input, stance) {
  let j;
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'no JSON object' };
  try { j = JSON.parse(m[0]); } catch (e) { try { j = JSON.parse(jsonrepair(m[0])); } catch (e2) { return { ok: false, error: 'unparseable JSON' }; } }
  const v = String(j.verdict || '').toLowerCase().trim();
  if (!VERDICTS.includes(v)) return { ok: false, error: 'bad verdict: ' + j.verdict };
  if (v === 'held' && stance === 'strict') return { ok: false, error: 'held under strict stance' };
  const ids = new Set(input.burrs.map(b => b.id)), cited = Array.isArray(j.burrs) ? j.burrs.map(Number).filter(n => Number.isFinite(n)) : [];
  if (cited.some(id => !ids.has(id))) return { ok: false, error: 'cites a burr that was not provided' };
  if (v === 'yes') {
    const notes = new Set(input.burrs.filter(b => cited.includes(b.id)).map(b => b.note));
    if (cited.length < 2 || notes.size < 2) return { ok: false, error: 'yes needs at least two cited facts from different notes' };
  }
  const why = String(j.why || '').trim();
  if (!why) return { ok: false, error: 'empty why' };
  return { ok: true, verdict: v, link: String(j.link || '').trim(), burrs: cited, gap: String(j.gap || '').trim(), why: why.slice(0, 400) };
}

module.exports = { PROMPT_VERSION, SCHEMA_VERSION, VERDICTS, LABEL_TO_VERDICT, sparkLabels, sparkLabelsByVersion, split, buildInput, systemPrompt, userPrompt, cacheKey, parseVerdict };
