'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../code/lib/muse_model');

const ent = (surface, types, df, srcs) => ({ surface: surface, types: new Set(types), notes: new Set(Array.from({ length: df }, (_, i) => i)), srcs: new Set(srcs || ['hook']) });

test('recommendation rules fire on the cases found in the sniff test', () => {
  assert.deepStrictEqual(M.recsForKey('mass produced', ent('mass produced', ['set'], 1)), ['dead-end-type']);
  assert.ok(M.recsForKey('150 years', ent('150 years', ['time'], 6)).includes('split-time'));
  assert.ok(!M.recsForKey('1952', ent('1952', ['time'], 3, ['year'])).includes('split-time'));
  assert.ok(M.recsForKey('honey', ent('honey', ['material', 'etymon'], 7)).includes('common-word'));
  assert.ok(M.recsForKey('panini', ent('Panini', ['entity'], 7)).includes('needs-category'));
  assert.ok(!M.recsForKey('panini', ent('Panini', ['entity'], 7)).includes('common-word'));
  assert.ok(M.recsForKey('india', ent('india', ['title'], 300, ['title'])).includes('title-hub'));
  assert.ok(M.recsForKey('1947', ent('1947', ['time'], 20, ['year'])).includes('year-slice'));
  assert.deepStrictEqual(M.recsForKey('taipei 101', ent('Taipei 101', ['entity'], 2)), []);
});
test('duration pattern matches durations, not dates or centuries', () => {
  ['150 years', 'over 2,500 years ago', '1,500-year-old', '14-minute', '3 decades'].forEach(s => assert.ok(M.DURATION.test(s), s));
  ['16th century', 'March 15, 1896', 'in 1952'].forEach(s => assert.ok(!M.DURATION.test(s), s));
});
test('every recommendation tag used by the rules is documented', () => {
  ['dead-end-type', 'split-time', 'title-hub', 'common-word', 'needs-category', 'hub', 'year-slice', 'raise-cap', 'dating-regex', 'loop-restates', 'no-bristle', 'clone-of', 'verify-collision', 'url-in-quote']
    .forEach(t => assert.ok(M.REC[t] && M.REC[t].label && M.REC[t].finding && M.REC[t].fix, t));
});
test('every recommendation has a plain question and two verb buttons; item labels are complete', () => {
  Object.keys(M.REC).forEach(k => { const r = M.REC[k]; assert.ok(r.ask && r.yes && r.no && Array.isArray(r.pick), k); assert.notStrictEqual(r.yes, r.no, k); });
  ['burrs', 'bristles', 'sparks', 'knots'].forEach(v => assert.ok(M.ITEM_LABELS[v].every(l => l[0] && l[1]), v));
});
