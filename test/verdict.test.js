const test = require('node:test');
const assert = require('node:assert');
const V = require('../code/lab/verdict');

test('has: stem-tolerant for long words, whole-word for short ones', () => {
  assert.ok(V.has('Quinoa originates in the Andes', 'quinoa'));
  assert.ok(V.has('Gravitational waves', 'gravitation'.slice(0, 11)));
  assert.ok(V.has('The pyramids were built', 'pyramid'));
  assert.ok(!V.has('the airport', 'air'));
  assert.ok(V.has('air and water', 'air'));
  assert.ok(V.has('100 grams', '100'));
});

test('anchorTerms keeps rare words only', () => {
  const df = { musk: 20, spectrum: 60, per: 9000, zzz: 0 };
  assert.deepStrictEqual(V.anchorTerms(['musk', 'spectrum', 'per', 'zzz'], t => df[t], 500), ['musk', 'spectrum']);
});

test('coverage splits covered and missing anchors', () => {
  const c = V.coverage(['musk', 'spectrum'], ['Elon Musk is the CEO of Tesla']);
  assert.deepStrictEqual(c.covered, ['musk']);
  assert.deepStrictEqual(c.missing, ['spectrum']);
});

test('decide: found, related, nothing', () => {
  const T = V.THRESH;
  assert.strictEqual(V.decide({ sim: 0.6, anchors: ['a'], covered: ['a'], missing: [] }, T), 'found');
  assert.strictEqual(V.decide({ sim: 0.6, anchors: ['a', 'b'], covered: ['a'], missing: ['b'] }, T), 'related');
  assert.strictEqual(V.decide({ sim: 0.45, anchors: ['a'], covered: ['a'], missing: [] }, T), 'related');
  assert.strictEqual(V.decide({ sim: 0.6, anchors: ['a'], covered: [], missing: ['a'] }, T), 'nothing');
  assert.strictEqual(V.decide({ sim: 0.35, anchors: ['a'], covered: ['a'], missing: [] }, T), 'nothing');
  assert.strictEqual(V.decide({ sim: 0.55, anchors: [], covered: [], missing: [] }, T), 'found');
  assert.strictEqual(V.decide({ sim: 0.3, anchors: [], covered: [], missing: [] }, T), 'nothing');
});

test('message names what is missing', () => {
  assert.strictEqual(V.message('related', ['spectrum'], ['musk']), 'Related notes, but nothing about: spectrum.');
  assert.strictEqual(V.message('nothing', ['edison'], []), 'Nothing in the vault matches (no mention of edison).');
  assert.strictEqual(V.message('found', [], ['a']), 'Found.');
});
