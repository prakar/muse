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
const row = function (h, why, ids, seed) { var nm = NAMES.get(h) || String(h); return { h: h, name: nm, label: nm, half: false, why: why, ids: Array.from(new Set(ids)), seed: seed || null }; };
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

// What a fact with a cue states, and what to look for next to build it into the shape (filled with the fact's own entity names).
const CHAIN_REL = { cause: 1, 'named-for': 1, 'inspired-by': 1 };
const STATES = { cause: 'A stated cause', 'named-for': 'A stated naming', 'inspired-by': 'A stated inspiration', 'explains-practice': 'A stated explanation of a practice', 'copy-of': 'A stated copy',
  'applied-elsewhere': 'A stated borrowing', 'reason-chosen': 'A stated reason for a choice', 'ignored-because': 'A stated reason for neglect' };
const NEXT = { cause: 'picks up from the effect, such as what happened next or what else it led to', 'named-for': 'is about the person or thing it was named for, or about something else with the same name',
  'inspired-by': 'is about what it inspired, or about what inspired it', 'explains-practice': 'is about the custom or rule the story accounts for', 'copy-of': 'is about the original, or about another copy',
  'applied-elsewhere': 'is about where the solution came from, or where else it was used', 'reason-chosen': 'is about the choice itself: who made it, and what else was considered',
  'ignored-because': 'is about how the finding was used later' };
function howTo(x, shape, b) {
  const seen = new Set(), ents = hooks(b).filter(function (hk) { if (hk.type !== 'entity') return false; const k = key(hk.value); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 2).map(function (hk) { return hk.value; });
  const about = ents.length ? ents.join(' or ') : 'the subject of this fact';
  return 'This fact states a link (\u201c' + x.cue + '\u201d). To build it into ' + shape + ': find a second fact about ' + about + ' that ' + NEXT[x.r] + '. ' + tail(x.r);
}
const tail = function (rel) { return CHAIN_REL[rel] ? 'Collect both, and the Collection will name the shared pivot.' : 'Collect both to keep them together.'; };
// The same advice once for a whole page of such facts (no entity names).
function shapeHowTo(rel, shape) {
  return 'Each card is one fact that states a link (the quoted word). To build one into ' + shape + ': find a second fact about the same subject that ' + (NEXT[rel] || 'continues the story') + '. ' + tail(rel);
}
// 1, 5, 6, 8, 9, 11, 13, 15 and neighbours. A fact that states its own relation (because, named after, inspired by...): the join the question would be built on.
function relations(pile) {
  const out = [];
  pile.forEach(function (b) {
    R.relationsIn(b.claim).forEach(function (x) { const p = R.POINTS_AT[x.r], r = row(p.h, '\u201c' + x.cue + '\u201d', [b.id], { answer: 'one side of the link', join: x.r, hide: 'the cause, the effect or the name, whichever you choose' }); r.also = p.also; r.half = true; r.label = STATES[x.r]; r.rel = x.r; r.howTo = howTo(x, r.name, b); out.push(r); });
  });
  return out;
}

// 1 and 6, for real. A chain needs two facts handed off through a shared entity (the pivot). Both facts state a link: strong. One states a link and the other is
// about the same entity: weaker (the other may be the next hop). A single fact with a cue is only a stated link, not a chain (see relations above).
const CHAIN_H = { cause: 1, 'named-for': 1, 'inspired-by': 6 };
function chains(pile) {
  const cues = new Map(), ents = new Map(), out = [], done = new Set();
  pile.forEach(function (b) { const rs = R.relationsIn(b.claim).filter(function (x) { return CHAIN_H[x.r]; }); if (rs.length) cues.set(b.id, rs[0]); });
  pile.forEach(function (b) {
    const seen = new Set();
    hooks(b).forEach(function (hk) { if (hk.type !== 'entity') return; const k = key(hk.value); if (k.length < 4 || seen.has(k)) return; seen.add(k); if (!ents.has(k)) ents.set(k, []); ents.get(k).push({ b: b, name: hk.value }); });
  });
  ents.forEach(function (list, k) {
    if (list.length < 2 || list.length > 6) return;
    list.forEach(function (a) {
      const ra = cues.get(a.b.id); if (!ra) return;
      list.forEach(function (o) {
        if (o.b.id === a.b.id) return;
        const strong = cues.has(o.b.id); if (strong && a.b.id > o.b.id) return;
        const dk = [Math.min(a.b.id, o.b.id), Math.max(a.b.id, o.b.id), k].join('|'); if (done.has(dk)) return; done.add(dk);
        out.push(row(CHAIN_H[ra.r], strong ? '"' + a.name + '" joins two stated links (' + ra.r + ')' : '"' + a.name + '" follows a stated link (' + ra.r + '): the other fact may be the next hop', [a.b.id, o.b.id],
          { answer: 'the pivot, ' + a.name + ', or the end of the chain', join: ra.r + ' handed on through ' + a.name, hide: 'the pivot or the middle link' }));
        out[out.length - 1].strength = strong ? 'both facts state a link' : 'one fact states a link';
      });
    });
  });
  return out;
}

// 57, 55, 27, 63. Shapes a single sentence can state in plain words: a renaming, a debunked name or myth, a superlative with its list. Cue words only, as with relations.
const SUPER = 'longest|tallest|largest|highest|oldest|smallest|deepest|fastest|biggest|richest|heaviest|lightest|coldest|hottest|driest|wettest';
const CUE_SHAPES = [
  { h: 57, re: /\b(renamed|formerly (?:known|called)|changed (?:its|his|her|their) name|rebranded|name was changed|used to be called|was later (?:called|renamed))\b/i, seed: { answer: 'the old name or the new one', join: 'one thing with two names', hide: 'the old name' } },
  { h: 55, re: /\b(folk etymology|not named (?:after|for)|is not named)\b/i, seed: { answer: 'the real origin of the name', join: 'the expected source and the true one', hide: 'the true source' } },
  { h: 27, re: /\b(is a myth|popular myth|myth that|misattributed|contrary to popular (?:belief|opinion))\b/i, seed: { answer: 'what is actually true', join: 'a popular belief and the fact behind it', hide: 'the true answer' } },
  { h: 63, re: new RegExp('\\b(?:' + SUPER + ')\\b.{0,60}\\b(?:in the world|in (?:india|asia|europe|africa|america)|on earth|of all time)\\b', 'i'), seed: { answer: 'the item that tops the list', join: 'a superlative and the list it tops', hide: 'the item, or the list' } }];
function cueShapes(pile) {
  const out = [];
  pile.forEach(function (b) { const s = String(b.claim || ''); CUE_SHAPES.forEach(function (c) { const m = c.re.exec(s); if (m) out.push(row(c.h, '\u201c' + m[0] + '\u201d', [b.id], c.seed)); }); });
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

const DETECTORS = [sameMoment, namesakes, uniqueness, etymology, homonyms, relations, chains, cueShapes, wordplay];

function angles(pile) {
  pile = (pile || []).filter(function (b) { return b && b.id != null; });
  const all = [].concat.apply([], DETECTORS.map(function (d) { return d(pile); }));
  const inChain = new Set(); all.forEach(function (r) { if (r.strength) r.ids.forEach(function (i) { inChain.add(i); }); });
  for (let i = all.length - 1; i >= 0; i--) if (all[i].half && inChain.has(all[i].ids[0])) all.splice(i, 1);   // a link already shown inside a chain is not shown again on its own
  all.forEach(function (r) { if (r.also) r.alsoNames = r.also.map(function (h) { return { h: h, name: NAMES.get(h) || String(h) }; }); });
  return all.sort(function (a, b) { return b.ids.length - a.ids.length || a.h - b.h; });
}

module.exports = { shapeHowTo, angles, DETECTORS, sameMoment, namesakes, uniqueness, etymology, homonyms, relations, chains, cueShapes, wordplay };
