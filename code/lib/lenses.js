'use strict';
/**
 * QUARRY lib/lenses.js: the lens engine. A lens is one way of looking at a pile of facts and saying "this shows a shape". The shapes a profession cares
 * about belong to its pack (packs/<name>/lenses.json); the ways of finding them are the detector types below, which are general: matching a date, a repeated
 * name, a hook, a cue word, a chain through a shared name, strings that play on each other. A pack picks detector types and fills in their words.
 *
 *   compile(config, registryRows) -> lens { names, detectors, browse(pile, ctx), shapeHowTo(rel, shape), relationsIn(text), POINTS_AT, CUES }
 *   run(pile, lens) -> rows { h, name, label, half, why, ids, seed, also?, alsoNames?, howTo?, rel?, strength? }   (widest first)
 *
 * Pure and deterministic: no model, no database, no network. A detector only points at a shape; whether it is worth using stays the author's call.
 */
const W = require('./wordplay');
const D = require('./daydates');

const TYPES = ['same-date', 'namesakes', 'hook-flag', 'relations', 'chains', 'cue-shapes', 'string-play'];
const PLAYS = ['shared-parts', 'anagrams', 'digit-names', 'one-letter-off'];

const hooks = (b) => (Array.isArray(b.hooks) ? b.hooks : []);
const key = (s) => W.fold(String(s)).trim();
// {name} is replaced by the value; {name|fallback} uses the fallback when the value is empty.
const fill = (s, v) => String(s).replace(/\{(\w+)(?:\|([^}]*))?\}/g, (m, k, d) => (v[k] != null && v[k] !== '' ? String(v[k]) : (d != null ? d : '')));
const fillSeed = (seed, v) => (seed ? { answer: fill(seed.answer, v), join: fill(seed.join, v), hide: fill(seed.hide, v) } : null);

function validate(config, registryRows) {
  const bad = (m) => { throw new Error('lenses: ' + m); };
  if (!config || typeof config !== 'object' || config.version !== 1) bad('version must be 1');
  if (!Array.isArray(config.entries)) bad('entries must be a list');
  const known = new Set((registryRows || []).map((r) => r.id));
  const checkH = (h, where) => { if (!Number.isInteger(h)) bad(where + ': h must be a whole number'); if (known.size && !known.has(h)) bad(where + ': shape ' + h + ' is not in the registry'); };
  const checkSeed = (s, where) => { if (!s || !['answer', 'join', 'hide'].every((k) => typeof s[k] === 'string')) bad(where + ': seed needs answer, join and hide'); };
  const checkRe = (r, where) => { if (!r || typeof r.re !== 'string') bad(where + ': re must be a string'); try { new RegExp(r.re, r.flags || ''); } catch (e) { bad(where + ': bad pattern: ' + e.message); } };
  config.entries.forEach((e, i) => {
    const w = 'entries[' + i + '] (' + (e && e.type) + ')';
    if (!e || !TYPES.includes(e.type)) bad(w + ': type must be one of ' + TYPES.join(', '));
    if (e.type === 'same-date' || e.type === 'namesakes' || e.type === 'hook-flag') { checkH(e.h, w); checkSeed(e.seed, w); if (typeof e.why !== 'string') bad(w + ': why is required'); }
    if (e.type === 'hook-flag' && typeof e.hook !== 'string') bad(w + ': hook is required');
    if (e.type === 'cue-shapes') { if (!Array.isArray(e.shapes) || !e.shapes.length) bad(w + ': shapes must be a list'); e.shapes.forEach((s, j) => { checkH(s.h, w + '.shapes[' + j + ']'); checkRe(s, w + '.shapes[' + j + ']'); checkSeed(s.seed, w + '.shapes[' + j + ']'); }); }
    if (e.type === 'string-play') { if (!Array.isArray(e.parts) || !e.parts.length) bad(w + ': parts must be a list'); e.parts.forEach((p, j) => { if (!PLAYS.includes(p.play)) bad(w + '.parts[' + j + ']: play must be one of ' + PLAYS.join(', ')); checkH(p.h, w + '.parts[' + j + ']'); checkSeed(p.seed, w + '.parts[' + j + ']'); }); }
  });
  const needs = config.entries.some((e) => e.type === 'relations' || e.type === 'chains');
  if (needs) {
    const r = config.relations;
    if (!r || typeof r.cues !== 'object' || typeof r.pointsAt !== 'object' || typeof r.states !== 'object' || typeof r.next !== 'object') bad('relations needs cues, pointsAt, states and next');
    Object.keys(r.cues).forEach((k) => { checkRe(r.cues[k], 'relations.cues.' + k); if (!r.pointsAt[k]) bad('relations.pointsAt.' + k + ' is missing'); checkH(r.pointsAt[k].h, 'relations.pointsAt.' + k); if (!r.states[k] || !r.next[k]) bad('relations.states and next need ' + k); });
    if (!Array.isArray(r.chainRel) || !r.chainShape) bad('relations needs chainRel and chainShape');
  }
}

function compile(config, registryRows) {
  validate(config, registryRows);
  const names = new Map((registryRows || []).map((r) => [r.id, r.name]));
  const nameOf = (h) => names.get(h) || String(h);
  const row = (h, why, ids, seed) => { const nm = nameOf(h); return { h, name: nm, label: nm, half: false, why, ids: Array.from(new Set(ids)), seed: seed || null }; };

  // ---- relations: what a fact states, read from cue words only (a model reading the same facts guessed right about one time in three)
  const rc = config.relations || { cues: {}, pointsAt: {}, states: {}, next: {}, chainRel: [], chainShape: {} };
  const CUES = {}; Object.keys(rc.cues).forEach((k) => { CUES[k] = new RegExp(rc.cues[k].re, rc.cues[k].flags || ''); });
  const POINTS_AT = rc.pointsAt;
  const relationsIn = (text) => { const out = [], s = String(text || ''); Object.keys(CUES).forEach((r) => { const m = CUES[r].exec(s); if (m) out.push({ r, cue: m[0] }); }); return out; };
  const tail = (rel) => ((rc.chainRel || []).includes(rel) ? 'Collect both, and the Collection will name the shared pivot.' : 'Collect both to keep them together.');
  const shapeHowTo = (rel, shape) => 'Each card is one fact that states a link (the quoted word). To build one into ' + shape + ': find a second fact about the same subject that ' + (rc.next[rel] || 'continues the story') + '. ' + tail(rel);
  const howTo = (x, shape, b) => {
    const seen = new Set(), ents = hooks(b).filter((hk) => { if (hk.type !== 'entity') return false; const k = key(hk.value); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 2).map((hk) => hk.value);
    const about = ents.length ? ents.join(' or ') : 'the subject of this fact';
    return 'This fact states a link (“' + x.cue + '”). To build it into ' + shape + ': find a second fact about ' + about + ' that ' + rc.next[x.r] + '. ' + tail(x.r);
  };

  const make = {
    'same-date': (e) => (pile) => {
      const by = new Map();
      pile.forEach((b) => { const seen = new Set(); D.findDays(String(b.claim || '')).forEach((d) => { if (d.clip || seen.has(d.key)) return; seen.add(d.key); if (!by.has(d.key)) by.set(d.key, []); by.get(d.key).push(b.id); }); });
      const out = []; by.forEach((ids, k) => { if (ids.length >= 2) out.push(row(e.h, fill(e.why, { key: k }), ids, fillSeed(e.seed, { key: k }))); }); return out;
    },
    'namesakes': (e) => (pile) => {
      const by = new Map(), hook = e.hook || 'entity';
      pile.forEach((b) => hooks(b).forEach((hk) => { if (hk.type !== hook || !hk.cat) return; const k = key(hk.value); if (k.length < (e.minLength || 3)) return; if (!by.has(k)) by.set(k, { name: hk.value, cats: new Set(), ids: [] }); const g = by.get(k); g.cats.add(hk.cat); g.ids.push(b.id); }));
      const out = []; by.forEach((g) => { if (g.cats.size >= 2) { const v = { name: g.name, cats: Array.from(g.cats).join(' and a ') }; out.push(row(e.h, fill(e.why, v), g.ids, fillSeed(e.seed, v))); } }); return out;
    },
    'hook-flag': (e) => (pile) => {
      const out = [];
      pile.forEach((b) => { const x = hooks(b).find((hk) => hk.type === e.hook); if ((e.kind && b.kind === e.kind) || x) { const v = { value: x ? x.value : '' }; out.push(row(e.h, x || !e.whyBare ? fill(e.why, v) : e.whyBare, [b.id], fillSeed(e.seed, v))); } });
      return out;
    },
    'relations': () => (pile) => {
      const out = [];
      pile.forEach((b) => relationsIn(b.claim).forEach((x) => {
        const p = POINTS_AT[x.r], r = row(p.h, '“' + x.cue + '”', [b.id], fillSeed(rc.seed, { rel: x.r }));
        r.also = p.also; r.half = true; r.label = rc.states[x.r]; r.rel = x.r; r.howTo = howTo(x, r.name, b); out.push(r);
      }));
      return out;
    },
    'chains': (e) => (pile) => {
      const CH = rc.chainShape, cues = new Map(), ents = new Map(), out = [], done = new Set(), hook = e.hook || 'entity';
      pile.forEach((b) => { const rs = relationsIn(b.claim).filter((x) => CH[x.r]); if (rs.length) cues.set(b.id, rs[0]); });
      pile.forEach((b) => { const seen = new Set(); hooks(b).forEach((hk) => { if (hk.type !== hook) return; const k = key(hk.value); if (k.length < (e.minPivotLength || 4) || seen.has(k)) return; seen.add(k); if (!ents.has(k)) ents.set(k, []); ents.get(k).push({ b, name: hk.value }); }); });
      ents.forEach((list, k) => {
        if (list.length < (e.minGroup || 2) || list.length > (e.maxGroup || 6)) return;
        list.forEach((a) => {
          const ra = cues.get(a.b.id); if (!ra) return;
          list.forEach((o) => {
            if (o.b.id === a.b.id) return;
            const strong = cues.has(o.b.id); if (strong && a.b.id > o.b.id) return;
            const dk = [Math.min(a.b.id, o.b.id), Math.max(a.b.id, o.b.id), k].join('|'); if (done.has(dk)) return; done.add(dk);
            const v = { name: a.name, rel: ra.r };
            out.push(row(CH[ra.r], fill(strong ? rc.chainWhyStrong : rc.chainWhyWeak, v), [a.b.id, o.b.id], fillSeed(rc.chainSeed, v)));
            out[out.length - 1].strength = strong ? 'both facts state a link' : 'one fact states a link';
          });
        });
      });
      return out;
    },
    'cue-shapes': (e) => { const shapes = e.shapes.map((s) => ({ h: s.h, re: new RegExp(s.re, s.flags || ''), seed: s.seed })); return (pile) => {
      const out = []; pile.forEach((b) => { const s = String(b.claim || ''); shapes.forEach((c) => { const m = c.re.exec(s); if (m) out.push(row(c.h, '“' + m[0] + '”', [b.id], c.seed)); }); }); return out; }; },
    'string-play': (e) => (pile) => {
      const owner = new Map(), ns = [], hook = e.hook || 'entity';
      pile.forEach((b) => hooks(b).forEach((hk) => { if (hk.type !== hook) return; const k = key(hk.value); if (!owner.has(k)) owner.set(k, []); owner.get(k).push(b.id); ns.push({ name: hk.value, category: hk.cat || 'other', notes: [b.id] }); }));
      const ids = (list) => [].concat.apply([], list.map((n) => owner.get(key(n)) || []));
      const out = [], P = {}; e.parts.forEach((p) => { P[p.play] = p; });
      const add = (p, h, v, nms) => out.push(row(h, fill(p.why, v), ids(nms), fillSeed(p.seed, v)));
      if (P['shared-parts']) W.sharedParts(ns).forEach((g) => add(P['shared-parts'], g.route === 'across-kinds' ? P['shared-parts'].hAcrossKinds : P['shared-parts'].h, { token: g.token, names: g.names.join(P['shared-parts'].namesSep || ', ') }, g.names));
      if (P['anagrams']) W.anagrams(ns).forEach((g) => add(P['anagrams'], P['anagrams'].h, { names: g.names.join(P['anagrams'].namesSep || ' / '), first: g.names[0] }, g.names));
      if (P['digit-names']) W.digitNames(ns).forEach((g) => add(P['digit-names'], P['digit-names'].h, { name: g.name }, [g.name]));
      if (P['one-letter-off']) (W.oneLetterOff(ns) || []).forEach((g) => { const pair = g.names || [g.a, g.b].filter(Boolean); if (pair.length) add(P['one-letter-off'], P['one-letter-off'].h, { names: pair.join(P['one-letter-off'].namesSep || ' / '), first: pair[0] }, pair); });
      return out;
    },
  };
  const built = config.entries.map((e) => ({ e, fn: make[e.type](e) }));
  const detectors = built.map((b) => b.fn);

  // The vault-wide browse takes only the detectors a pack marks `browse`, with the pack's limits (shared days: few facts, from different notes).
  function browse(pile, ctx) {
    const noteOf = (ctx && ctx.noteOf) || new Map(), out = [];
    built.forEach((b) => {
      if (!b.e.browse) return;
      let rows = b.fn(pile);
      if (b.e.type === 'same-date' && typeof b.e.browse === 'object') rows = rows.filter((r) => r.ids.length <= b.e.browse.maxFacts && new Set(r.ids.map((i) => noteOf.get(i))).size >= b.e.browse.minNotes);
      rows.forEach((r) => out.push(r));
    });
    return out;
  }
  return Object.freeze({ names, nameOf, detectors, browse, shapeHowTo, relationsIn, CUES, POINTS_AT, config });
}

function run(pile, lens) {
  pile = (pile || []).filter((b) => b && b.id != null);
  const all = [].concat.apply([], lens.detectors.map((d) => d(pile)));
  const inChain = new Set(); all.forEach((r) => { if (r.strength) r.ids.forEach((i) => inChain.add(i)); });
  for (let i = all.length - 1; i >= 0; i--) if (all[i].half && inChain.has(all[i].ids[0])) all.splice(i, 1);   // a link already shown inside a chain is not shown again on its own
  all.forEach((r) => { if (r.also) r.alsoNames = r.also.map((h) => ({ h, name: lens.nameOf(h) })); });
  return all.sort((a, b) => b.ids.length - a.ids.length || a.h - b.h);
}

const EMPTY = compile({ version: 1, entries: [] }, []);
module.exports = { TYPES, PLAYS, validate, compile, run, fill, EMPTY };
