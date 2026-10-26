'use strict';
/**
 * QUARRY lib/dates.js — historic and coarse dates in prose: eras, centuries, decades, year ranges.
 *
 * Why hand-rolled: the bake-off (claude/bakeoff-results-2026-10-25.md) found no library that handles "AD 476", "79 AD",
 * "1600 BC" without dropping the era, "the 1980s", "the 7th century" or "1882-1935" correctly. This module covers only those
 * forms; a plain year such as "in 1998" is decided by lib/bristles.js (it needs the unit and date-cue rules there).
 *
 * Representation: signed integer years, BC negative, no year 0 (1 BC = -1). A date is a span [from, to): the year 1998 is
 * 1998..1999, the 1980s is 1980..1990, the 7th century AD is 601..701, the 5th century BC is -500..-400.
 * Every date has an era. `eraStated` says whether the text said it ("AD 476") or we assumed AD ("the 7th century").
 *
 *   findDates(text) -> [{ text, index, end, grain: 'year'|'decade'|'century', from, to, era: 'bc'|'ad', eraStated,
 *                         approx, mod: null|'before'|'after'|'early'|'mid'|'late', range }]
 */
const U = require('./units');

const ERA = '(?:BCE|BC|B\\.C\\.E\\.|B\\.C\\.|AD|A\\.D\\.|CE|C\\.E\\.)';
const ORD_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth',
  'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first'];
const eraOf = function (s) { return /^B/.test(s) ? 'bc' : 'ad'; };
const NOT_RANGE_NEXT = new Set(['was', 'has', 'his', 'who', 'this', 'its', 'had']);

function context(text, index) {
  const before = text.slice(Math.max(0, index - 16), index);
  const approx = /(?:\bc\.|\bca\.|\bcirca|\babout|\baround|\bapprox(?:imately|\.)?|\bsome)\s*$/i.test(before);
  let mod = null;
  if (/(?:\bbefore|\bby|\buntil|\btill|\bprior to)\s+(?:about\s+|c\.\s*)?$/i.test(before)) mod = 'before';
  else if (/(?:\bafter|\bsince)\s+(?:about\s+|c\.\s*)?$/i.test(before)) mod = 'after';
  return { approx: approx, mod: mod };
}
function yearSpan(n, era) { return era === 'bc' ? { from: -n, to: -n + 1 } : { from: n, to: n + 1 }; }
function centurySpan(n, era) { return era === 'bc' ? { from: -n * 100, to: -(n - 1) * 100 } : { from: (n - 1) * 100 + 1, to: n * 100 + 1 }; }

function findDates(input) {
  const t = String(input == null ? '' : input);
  const out = [], used = [];
  const free = function (a, b) { return !used.some(function (u) { return a < u[1] && b > u[0]; }); };
  const take = function (a, b, item) {
    if (!free(a, b)) return;
    used.push([a, b]);
    const c = context(t, a);
    item.text = t.slice(a, b); item.index = a; item.end = b;
    if (item.approx === undefined) item.approx = c.approx;
    if (item.mod === undefined || item.mod === null) item.mod = c.mod;
    item.range = !!item.range;
    out.push(item);
  };

  // 0. a range of centuries: "the 1st and 4th century AD", "5th-3rd century BC"; both ends are kept
  const crRe = new RegExp('(\\d{1,2})(?:st|nd|rd|th)\\s*(?:and|to|[-\\u2013\\u2014])\\s*(\\d{1,2})(?:st|nd|rd|th)\\s+century(?:\\s+(' + ERA + ')(?![A-Za-z]))?', 'gi');
  let mr;
  while ((mr = crRe.exec(t)) !== null) {
    const a1 = parseInt(mr[1], 10), a2 = parseInt(mr[2], 10);
    if (a1 < 1 || a2 < 1 || a1 > 21 || a2 > 21) continue;
    const era = mr[3] ? eraOf(mr[3].toUpperCase()) : 'ad';
    if (!free(mr.index, mr.index + mr[0].length)) continue;
    const c = context(t, mr.index);
    [a1, a2].forEach(function (n) {
      const sp = centurySpan(n, era);
      out.push({ text: mr[0], index: mr.index, end: mr.index + mr[0].length, grain: 'century', from: sp.from, to: sp.to, era: era, eraStated: !!mr[3], approx: c.approx, mod: c.mod, range: true });
    });
    used.push([mr.index, mr.index + mr[0].length]);
  }

  // 1. centuries: "the 7th century", "5th century BC", "seventh century", "early 7th century"
  const cRe = new RegExp('(?:\\b(early|mid|late)[-\\s]+)?(?:(\\d{1,2})(?:st|nd|rd|th)|\\b(' + ORD_WORDS.join('|') + '))\\s+century(?:\\s+(' + ERA + ')(?![A-Za-z]))?', 'gi');
  let m;
  while ((m = cRe.exec(t)) !== null) {
    const n = m[2] ? parseInt(m[2], 10) : ORD_WORDS.indexOf(m[3].toLowerCase()) + 1;
    if (n < 1 || n > 21) continue;
    const era = m[4] ? eraOf(m[4].toUpperCase()) : 'ad';
    const sp = centurySpan(n, era);
    take(m.index, m.index + m[0].length, { grain: 'century', from: sp.from, to: sp.to, era: era, eraStated: !!m[4], mod: m[1] ? m[1].toLowerCase() : null });
  }

  // 2. year ranges: "1882-1935", "1963-64", "500-400 BC"
  const rRe = new RegExp('(?<![\\d,.#$/])(\\d{1,4})\\s*[-\\u2013\\u2014]\\s*(\\d{1,4})(?:\\s*(' + ERA + ')(?![A-Za-z]))?(?!\\d|,\\d|\\.\\d)', 'gd');
  while ((m = rRe.exec(t)) !== null) {
    let a = parseInt(m[1], 10), b = parseInt(m[2], 10), era = null, stated = false;
    if (m[3]) { era = eraOf(m[3]); stated = true; }
    else {
      if (a < 1000 || a > 2039) continue;
      if (m[2].length <= 2 && b < 100) b = Math.floor(a / 100) * 100 + b;   // 1963-64
      if (b > 2039) continue;
      era = 'ad';
    }
    if (era === 'bc' ? !(a > b) : !(a < b)) continue;
    if (era === 'ad' && !stated && (b - a) > 400) continue;
    const next = /^\s*([A-Za-z²³]+)/.exec(t.slice(m.index + m[0].length));
    if (next && !stated) {
      const w = next[1].toLowerCase();
      if (U.KNOWN_FORMS.has(w) || (w.length > 3 && /s$/.test(w) && !NOT_RANGE_NEXT.has(w))) continue;   // "1000-1500 people", "1000-1500 km"
    }
    const p1 = m.indices[1], p2 = m.indices[2];
    if (!free(m.index, m.index + m[0].length)) continue;
    used.push([m.index, m.index + m[0].length]);
    const c = context(t, m.index);
    const s1 = yearSpan(a, era), s2 = yearSpan(b, era);
    out.push({ text: m[1], index: p1[0], end: p1[1], grain: 'year', from: s1.from, to: s1.to, era: era, eraStated: stated, approx: c.approx, mod: c.mod, range: true });
    out.push({ text: m[2], index: p2[0], end: p2[1], grain: 'year', from: s2.from, to: s2.to, era: era, eraStated: stated, approx: c.approx, mod: c.mod, range: true });
  }

  // 3. a year with its era: "79 AD", "1600 BC", "AD 476"
  const sRe = new RegExp('(?<![\\d,.#$])(\\d{1,4})\\s*(' + ERA + ')(?![A-Za-z])', 'g');
  while ((m = sRe.exec(t)) !== null) {
    const era = eraOf(m[2]), n = parseInt(m[1], 10);
    if (n < 1) continue;
    const sp = yearSpan(n, era);
    take(m.index, m.index + m[0].length, { grain: 'year', from: sp.from, to: sp.to, era: era, eraStated: true });
  }
  const pRe = /\b(A\.D\.|AD)\s*(\d{1,4})(?!\d|,\d|\.\d)/g;
  while ((m = pRe.exec(t)) !== null) {
    const n = parseInt(m[2], 10);
    if (n < 1) continue;
    const sp = yearSpan(n, 'ad');
    take(m.index, m.index + m[0].length, { grain: 'year', from: sp.from, to: sp.to, era: 'ad', eraStated: true });
  }

  // 4. decades: "the 1980s", "late 1990s"
  const dRe = /(?:\b(early|mid|late)[-\s]+)?(?<![\d,.#$])\b((?:1[0-9]{3}|20[0-3][0-9]))s\b/gi;
  while ((m = dRe.exec(t)) !== null) {
    const y = parseInt(m[2], 10);
    if (y % 10 !== 0) continue;
    take(m.index, m.index + m[0].length, { grain: 'decade', from: y, to: y + 10, era: 'ad', eraStated: false, mod: m[1] ? m[1].toLowerCase() : null });
  }

  return out.sort(function (a, b) { return a.index - b.index; });
}

module.exports = { findDates, yearSpan, centurySpan };
