'use strict';
const test = require('node:test'), assert = require('node:assert');
const M = require('../code/lib/muse_model');
const NN = 6000, base = { df: 2, rarity: Math.log(NN / 2), dist: 0.8, recs: [], clone: false, types: ['entity'], burrs: [{ id: 1, claim: 'x'.repeat(100) }, { id: 2, claim: 'y'.repeat(100) }] };
const nB = new Map([[1, 5], [2, 5]]);
const row = (o) => Object.assign({}, base, o);

test('proper multi-word name outranks a lowercase common word', () => {
  const a = M.sparkParts(row({ surface: 'Steven Weinberg' }), nB, NN), b = M.sparkParts(row({ surface: 'pope', recs: ['common-word'] }), nB, NN);
  assert.ok(a.score > b.score + 1.5);
});
test('unknown distance is neutral, not worse than a known small one', () => {
  const unknown = M.sparkParts(row({ surface: 'Nimrud', dist: null }), nB, NN), near = M.sparkParts(row({ surface: 'Nimrud', dist: 0.1 }), nB, NN);
  assert.ok(unknown.score > near.score);
  assert.strictEqual(unknown.parts.far, 0.5);
});
test('restated pairs and thin facts rank lower; parts explain the score', () => {
  const good = M.sparkParts(row({ surface: 'Nimrud' }), nB, NN), clone = M.sparkParts(row({ surface: 'Nimrud', clone: true }), nB, NN), thin = M.sparkParts(row({ surface: 'Nimrud', burrs: [{ id: 1, claim: 'abc' }, { id: 2, claim: 'abc' }] }), new Map([[1, 0], [2, 0]]), NN);
  assert.ok(good.score > clone.score && good.score > thin.score);
  assert.strictEqual(clone.parts.restated, -0.5);
});
test('wordplay grade A beats B', () => {
  const A = M.sparkParts(row({ surface: 'Berlin ~ Merlin', wordplay: { grade: 'A' } }), nB, NN), B = M.sparkParts(row({ surface: 'Berlin ~ Merlin', wordplay: { grade: 'B' } }), nB, NN);
  assert.ok(A.score > B.score);
});
