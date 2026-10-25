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

function isYearKey(k) { return /^(1[0-9]{3}|20[0-3][0-9])$/.test(k); }

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

module.exports = { STOP, foldKey, variantKey, yearsIn, isYearKey, tokens, usableKey, titleKey, buildIdf, vectorOf, cosine, tagDistance };
