'use strict';
/**
 * QUARRY lib/angles.js — which quiz heuristics a PILE of facts already hints at (Angles v1, detectors only).
 *
 * A pile is any list of burr-like objects: { id, claim, kind, hooks: [{type, value, cat?}] }. Pure and deterministic: no model,
 * no database, no network. Each detector looks for the shape one heuristic needs and says which facts show it:
 *   angles(pile) -> [{ h: 45, name, why, ids: [burr ids] }]   (widest first; one row per finding)
 * The detectors only point at a shape. Whether it makes a good question stays the author's call, so nothing here writes one.
 */
const W = require('./wordplay');
const D = require('./daydates');
const R = require('./relations');
const H = require('../data/heuristics.json');

const NAMES = new Map((H.rows || []).map(function (r) { return [r.id, r.name]; }));
const hooks = function (b) { return Array.isArray(b.hooks) ? b.hooks : []; };
// seed: the small construction this shape suggests, filled from the pile (what the answer would be, what joins the facts, what to hide). Not a question.
const row = function (h, why, ids, seed) { return { h: h, name: NAMES.get(h) || String(h), why: why, ids: Array.from(new Set(ids)), seed: seed || null }; };
const key = function (s) { return W.fold(String(s)).trim(); };

// 3. Two facts on the same calendar day (a birth and a founding on 14 March).
function sameMoment(pile) {
  const by = new Map();
  pile.forEach(function (b) {
    const seen = new Set();
    D.findDays(String(b.claim || '')).forEach(function (d) {
      if (d.clip || seen.has(d.key)) return; seen.add(d.key);
      if (!by.has(d.key)) by.set(d.key, []); by.get(d.key).push(b.id);
    });
  });
  const out = [];
  by.forEach(function (ids, k) { if (ids.length >= 2) out.push(row(3, 'both fall on ' + k, ids, { answer: 'the date, ' + k, join: 'the same calendar day', hide: 'the date' })); });
  return out;
}

// 7. The same name for different kinds of thing (Mercury the planet, the element, the god).
function namesakes(pile) {
  const by = new Map();
  pile.forEach(function (b) {
    hooks(b).forEach(function (hk) {
      if (hk.type !== 'entity' || !hk.cat) return;
      const k = key(hk.value); if (k.length < 3) return;
      if (!by.has(k)) by.set(k, { name: hk.value, cats: new Set(), ids: [] });
      const g = by.get(k); g.cats.add(hk.cat); g.ids.push(b.id);
    });
  });
  const out = [];
  by.forEach(function (g) { if (g.cats.size >= 2) out.push(row(7, g.name + ' is a ' + Array.from(g.cats).join(' and a '), g.ids, { answer: g.name, join: 'one name for unlike things', hide: 'the name' })); });
  return out;
}

// 36 and 63. A fact that says something is the only one, or the most, of its kind.
function uniqueness(pile) {
  const out = [];
  pile.forEach(function (b) {
    const u = hooks(b).find(function (hk) { return hk.type === 'uniqueness'; });
    if (u) out.push(row(36, u.value, [b.id], { answer: 'what the fact is about', join: 'a first, only or extreme claim', hide: 'the name; keep the claim' }));
  });
  return out;
}

// 45. The word has a story: an etymology fact, or a fact with an etymon.
function etymology(pile) {
  const out = [];
  pile.forEach(function (b) {
    const e = hooks(b).find(function (hk) { return hk.type === 'etymon'; });
    if (b.kind === 'etymology' || e) out.push(row(45, e ? 'the word ' + e.value + ' has a story' : 'an etymology fact', [b.id], { answer: e ? e.value : 'the word', join: 'a word and the story of its root', hide: 'the word; keep the root' }));
  });
  return out;
}

// 1, 5, 6, 8, 9, 11, 13, 15 and neighbours. A fact that states its own relation (because, named after, inspired by...): the join the question would be built on.
function relations(pile) {
  const out = [];
  pile.forEach(function (b) {
    R.relationsIn(b.claim).forEach(function (x) { const p = R.POINTS_AT[x.r], r = row(p.h, x.r + ' ("' + x.cue + '")', [b.id], { answer: 'one side of the link', join: x.r, hide: 'the cause, the effect or the name, whichever you choose' }); r.also = p.also; out.push(r); });
  });
  return out;
}

// 48. A name that is also an ordinary word or another thing.
function homonyms(pile) {
  const out = [];
  pile.forEach(function (b) {
    const x = hooks(b).find(function (hk) { return hk.type === 'homonym'; });
    if (x) out.push(row(48, x.value + ' means more than one thing', [b.id], { answer: x.value, join: 'one name, several meanings', hide: 'the name' }));
  });
  return out;
}

// 49, 50, 58, 59, 60. String play between the names in the pile, using the wordplay detectors the vault pass already has.
function wordplay(pile) {
  const owner = new Map(), names = [];
  pile.forEach(function (b) {
    hooks(b).forEach(function (hk) {
      if (hk.type !== 'entity') return;
      const k = key(hk.value);
      if (!owner.has(k)) owner.set(k, []); owner.get(k).push(b.id);
      names.push({ name: hk.value, category: hk.cat || 'other', notes: [b.id] });
    });
  });
  const ids = function (list) { return [].concat.apply([], list.map(function (n) { return owner.get(key(n)) || []; })); };
  const out = [];
  W.sharedParts(names).forEach(function (g) { out.push(row(g.route === 'across-kinds' ? 59 : 50, '"' + g.token + '" in ' + g.names.join(', '), ids(g.names), { answer: g.token, join: 'a word shared by different names', hide: 'the shared word' })); });
  W.anagrams(names).forEach(function (g) { out.push(row(58, g.names.join(' / ') + ' use the same letters', ids(g.names), { answer: g.names[0], join: 'the same letters, rearranged', hide: 'one of the names' })); });
  W.digitNames(names).forEach(function (g) { out.push(row(60, g.name + ' carries a number', ids([g.name]), { answer: g.name, join: 'a number inside a name', hide: 'the name or the number' })); });
  (W.oneLetterOff(names) || []).forEach(function (g) { const pair = g.names || [g.a, g.b].filter(Boolean); if (pair.length) out.push(row(49, pair.join(' / ') + ' differ by one letter', ids(pair), { answer: pair[0], join: 'names one letter apart', hide: 'one of the names' })); });
  return out;
}

const DETECTORS = [sameMoment, namesakes, uniqueness, etymology, homonyms, relations, wordplay];

function angles(pile) {
  pile = (pile || []).filter(function (b) { return b && b.id != null; });
  const all = [].concat.apply([], DETECTORS.map(function (d) { return d(pile); }));
  all.forEach(function (r) { if (r.also) r.alsoNames = r.also.map(function (h) { return { h: h, name: NAMES.get(h) || String(h) }; }); });
  return all.sort(function (a, b) { return b.ids.length - a.ids.length || a.h - b.h; });
}

module.exports = { angles, DETECTORS, sameMoment, namesakes, uniqueness, etymology, homonyms, relations, wordplay };
