'use strict';
/**
 * QUARRY lib/bristles.js — pure, deterministic helpers for the bristle and knot stage (SCRATCH).
 * No I/O, no LLM. Constitution Art. 1-2: exact first, then statistical (TF-IDF). Tested in bristles.test.js.
 */

const STOP = new Set(('the a an and or of in on at to for with by from as is are was were be been it its this that these ' +
  'those he she they his her their them who whom which what when where while also not no but if then than so such into ' +
  'over after before during about between through under up out more most other some any each both few many much very ' +
  'can could would should may might will has have had do did does being there here only just one two first later').split(' '));

// Exact key: lower case, diacritics and apostrophes gone, hyphens and punctuation become spaces. Any script.
function foldKey(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’`.]/g, '').replace(/[-–—_]/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// EXPERIMENTAL variant key for transliterated names (constitution decision 2, rules finalised after E1):
// w->v, drop h after an aspirable stop (b d g j k p t), collapse doubled letters; digits untouched. Used only to report what it would merge.
function variantKey(s) {
  return foldKey(s).split(' ').map(function (w) {
    if (!/^\p{L}+$/u.test(w)) return w;   // numbers and mixed tokens are never folded (E1 preview: "300" ~ "30" was a bug)
    return w.replace(/([bdgjkpt])h/g, '$1').replace(/w/g, 'v').replace(/(.)\1+/g, '$1');   // aspirates only: sh/ch stay
  }).join(' ');
}

// Four-digit years 1000-2039 in running text (not parts of 12,000 or 3.1415; both ends of 1914-1918 count).
function yearsIn(text) {
  const out = [], re = /(?<![\d,.\/])(1[0-9]{3}|20[0-3][0-9])(?![\d,]|\.\d)/g;
  let m;
  while ((m = re.exec(String(text))) !== null) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

function isYearKey(k) { return /^(1[0-9]{3}|20[0-3][0-9])( (bc|ad))?$/.test(k) || /^\d{1,4} (bc|ad)$/.test(k); }

// ---------- numbers and dates: always carry a unit or an era ----------
// "1170 BC" is not "1170 AD", "1120 km" is not the year 1120, "1743 runs" is not 1743. A number only joins others of
// the same kind: a dated year keeps its era, a quantity keeps its unit, and a bare number with neither is not a handle.
const MONTHS = new Set('january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec'.split(' '));
const NOT_UNIT = new Set(['and', 'or', 'the', 'a', 'an', 'in', 'on', 'at', 'by', 'to', 'of', 'for', 'from', 'was', 'were', 'is', 'are', 'as', 'with', 'that', 'which', 'who', 'when', 'where', 'but', 'also', 'after', 'before', 'during', 'since', 'until', 'it', 'he', 'she', 'they', 'his', 'her', 'its', 'their', 'st', 'nd', 'rd', 'th', 'century', 'centuries', 'ce', 'ad', 'bc', 'bce']);
const SCALE = new Set(['thousand', 'million', 'billion', 'trillion', 'lakh', 'lakhs', 'crore', 'crores', 'k', 'm', 'bn']);
const DURATION_UNITS = new Set(['year', 'years', 'yr', 'yrs', 'month', 'months', 'week', 'weeks', 'day', 'days', 'hour', 'hours', 'minute', 'minutes', 'decade', 'decades']);
const KNOWN_UNITS = new Set('km kms m cm mm mi mile miles metre metres meter meters kg g mg tonne tonnes tons lb lbs oz litre litres l ml mph kmh kph hz khz mhz ghz mb gb tb kb watt watts kw mw volt volts runs wickets goals points votes people soldiers men women deaths students acres hectares sq'.split(' '));
const CURRENCY = { '$': 'usd', '€': 'eur', '£': 'gbp', '₹': 'inr', '¥': 'jpy' };
const CUR_WORD = { rs: 'inr', inr: 'inr', rupee: 'inr', rupees: 'inr', usd: 'usd', dollar: 'usd', dollars: 'usd', eur: 'eur', euro: 'eur', euros: 'eur', gbp: 'gbp', pound: 'gbp', pounds: 'gbp' };
const ERA_RE = /^\s*(b\.?\s?c\.?e?\.?|bce|a\.?\s?d\.?|c\.?e\.?)(?![a-z])/i;

function escRe(x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function unitWord(w) { return String(w || '').toLowerCase().replace(/[.,;:)]+$/, ''); }

// -> { key, surface, kind: 'year'|'qty'|'bare'|'text', duration }   kind 'bare' and 'text' have no key to join on ('text': not a number).
function qualifyNumber(value, claim, pos, hookType) {
  const v = String(value == null ? '' : value).trim();
  const m = /^([$€£₹¥])?\s*(\d[\d,]*(?:\.\d+)?)\s*(.*)$/.exec(v);
  if (!m) return { key: '', surface: v, kind: 'text' };
  const num = m[2].replace(/,/g, ''), rest = m[3].trim();
  let cur = m[1] ? CURRENCY[m[1]] : '', after = rest, before = '', noYear = hookType === 'number' || /,/.test(m[2]);   // the model typed it a number, or it is written with a thousands comma: never a calendar year
  if (!rest || !m[1]) {
    // Look the number up in the claim to see what surrounds it.
    let f = null;
    if (pos != null) f = { index: pos, 0: m[2] };
    else f = new RegExp('(?<![\\d.,])' + m[2].replace(/,/g, '').replace(/^(\d+)/, function (d) { return d.split('').join(',?'); }).replace(/\./g, '\\.') + '(?!\\d)', 'g').exec(String(claim || ''));
    if (f && /,/.test(f[0])) noYear = true;
    if (f) { if (!rest) after = String(claim).slice(f.index + f[0].length, f.index + f[0].length + 30); before = String(claim).slice(Math.max(0, f.index - 10), f.index); }
  }
  if (/#\s*$/.test(before)) noYear = true;                    // store #2,000, item #1743
  if (!cur && before) { const c = before.trim().slice(-1); if (CURRENCY[c]) cur = CURRENCY[c]; }
  const era = ERA_RE.exec(after);
  if (era) return { key: num + (/^b/i.test(era[1]) ? ' bc' : ' ad'), surface: num + ' ' + (/^b/i.test(era[1]) ? 'BC' : 'AD'), kind: 'year' };
  if (cur) return { key: num + ' ' + cur, surface: (m[1] || '') + num, kind: 'qty' };
  const wm = /^\s*[-–]?\s*([A-Za-z%°][A-Za-z%°.\/²³]*)(?:\s+([A-Za-z]+))?/.exec(after);
  const yearLike = !noYear && isYearKey(num);
  if (wm) {
    const raw = wm[1];
    let w = unitWord(raw);
    if (CUR_WORD[w]) return { key: num + ' ' + CUR_WORD[w], surface: num + ' ' + raw, kind: 'qty' };
    const lower = /^[a-z%°]/.test(raw);                       // "1085 Toledo" / "12 Angry Men": a capitalised word is a name, not a unit
    if (SCALE.has(w) && wm[2]) w = w + ' ' + unitWord(wm[2]);
    const datePrep = /\b(in|by|since|until|till|from|during|around|circa|c\.|year|of|and|to)\s*$/i.test(before);
    const ok = w && lower && !NOT_UNIT.has(w) && !MONTHS.has(w);
    // A year-like number is a date unless the next word is a known unit, or a plural noun with no date word before it.
    if (yearLike && w === 's') return { key: num, surface: num + 's', kind: 'year', decade: true };   // 1960s: a decade, dated at its start
    const asQty = ok && (!yearLike || KNOWN_UNITS.has(w) || (/s$/.test(w) && !datePrep));
    if (asQty) return { key: num + ' ' + w, surface: num + ' ' + w, kind: 'qty', duration: DURATION_UNITS.has(w) };
  }
  if (/^[%°]/.test(after.trim())) return { key: num + ' ' + after.trim()[0], surface: num + after.trim()[0], kind: 'qty' };
  if (yearLike) return { key: num, surface: num, kind: 'year' };   // a plain year: read as a calendar date
  return { key: '', surface: v, kind: 'bare' };
}

const MON = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE_CUE = new RegExp('(?:\\b(?:in|by|since|during|from|until|till|circa|c\\.|year|before|after|around|early|late|mid|between)\\s+|\\b(?:' + MON + ')\\.?\\s+(?:\\d{1,2},?\\s+)?|\\b\\d{1,2}\\s+(?:' + MON + ')\\s+|\\(\\s*|\\b(?:1[0-9]{3}|20[0-3][0-9])\\s*(?:[-–—]|to|and)\\s*)$', 'i');
// Every dated year in a claim: "in 1085", "1170 BC"; not "1743 runs" or "1120 km".
function datesIn(text) {
  const out = [], seen = new Set(), re = /(?<![\d,.\/$€£₹¥])(\d{1,4})(?![\d,]|\.\d)/g;
  let m; const t = String(text || '');
  while ((m = re.exec(t)) !== null) {
    const q = qualifyNumber(m[1], t, m.index);
    if (q.kind === 'year' && q.key && !seen.has(q.key) && (/ (bc|ad)$/.test(q.key) || (isYearKey(q.key) && DATE_CUE.test(t.slice(Math.max(0, m.index - 24), m.index))))) { seen.add(q.key); out.push(q); }
  }
  return out;
}


// Group unit spellings together for browsing: kms/kilometres -> km, percent -> %, feet -> ft, plurals -> singular.
const UNIT_MAP = { percent: '%', 'per cent': '%', kms: 'km', kilometre: 'km', kilometres: 'km', kilometer: 'km', kilometers: 'km', metre: 'm', metres: 'm', meter: 'm', meters: 'm', feet: 'ft', foot: 'ft', mile: 'mile', miles: 'mile', kilogram: 'kg', kilograms: 'kg', kgs: 'kg', tonnes: 'tonne', tons: 'tonne', ton: 'tonne', dollar: 'usd', dollars: 'usd', people: 'person', persons: 'person' };
function normUnit(u) { const w = String(u || '').toLowerCase(); if (UNIT_MAP[w]) return UNIT_MAP[w]; return w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w; }

// A qualified key back into numbers. yearOfKey('1170 bc') -> -1170; quantityOfKey('1120 km') -> { v: 1120, u: 'km' }.
function yearOfKey(key) { const m = /^(\d{1,4})(?: (bc|ad))?$/.exec(key); if (!m || (!m[2] && !isYearKey(m[1]))) return null; return (m[2] === 'bc' ? -1 : 1) * parseInt(m[1], 10); }
function quantityOfKey(key) { const m = /^(\d+(?:\.\d+)?) (.+)$/.exec(key); return m && m[2] !== 'bc' && m[2] !== 'ad' ? { v: parseFloat(m[1]), u: m[2] } : null; }

function tokens(text) { return foldKey(text).split(' ').filter(Boolean); }

// A key worth joining on: not just stopwords, not a bare small number, at least 4 characters.
function usableKey(k) {
  if (!k || k.length < 4) return false;
  if (/^\d+$/.test(k) && !isYearKey(k)) return false;
  return k.split(' ').some(function (w) { return !STOP.has(w); });
}

// Strip a title down to the part that names something: before " | ", " - ", " _ ", ":" ; at most 6 tokens.
function titleKey(title) {
  const head = String(title || '').split(/\s[|–—_]\s|\s-\s|:\s/)[0];
  const k = foldKey(head);
  const n = k ? k.split(' ').length : 0;
  return n >= 1 && n <= 6 && usableKey(k) ? k : '';
}

// ---------- TF-IDF context vectors (for sense distance) ----------
function buildIdf(docsTokens) {
  const df = new Map(), N = docsTokens.length;
  docsTokens.forEach(function (toks) { new Set(toks).forEach(function (t) { df.set(t, (df.get(t) || 0) + 1); }); });
  const idf = new Map();
  df.forEach(function (c, t) { idf.set(t, Math.log((N + 1) / (c + 1)) + 1); });
  return idf;
}

function vectorOf(toks, idf, exclude) {
  const tf = new Map();
  toks.forEach(function (t) {
    if (STOP.has(t) || t.length < 3 || (exclude && exclude.has(t))) return;
    tf.set(t, (tf.get(t) || 0) + 1);
  });
  const v = new Map();
  let norm = 0;
  tf.forEach(function (c, t) { const w = (1 + Math.log(c)) * (idf.get(t) || 1); v.set(t, w); norm += w * w; });
  norm = Math.sqrt(norm);
  if (norm > 0) v.forEach(function (w, t) { v.set(t, w / norm); });
  return v;
}

function cosine(a, b) {
  if (a.size > b.size) { const t = a; a = b; b = t; }
  let s = 0;
  a.forEach(function (w, t) { const o = b.get(t); if (o) s += w * o; });
  return s;
}

// ---------- tag distance ----------
// 1 - Jaccard of tag-root sets. null when either side has no tags (unknown, not "far").
function tagDistance(a, b) {
  if (!a || !b || !a.size || !b.size) return null;
  let inter = 0;
  a.forEach(function (t) { if (b.has(t)) inter++; });
  return 1 - inter / (a.size + b.size - inter);
}

module.exports = { normUnit, yearOfKey, quantityOfKey, STOP, foldKey, variantKey, yearsIn, qualifyNumber, datesIn, isYearKey, tokens, usableKey, titleKey, buildIdf, vectorOf, cosine, tagDistance };
