'use strict';
// KNOWN GAPS: tests that pin today's behaviour where the Extraction Mechanism Register
// (vault note "QUARRY - Extraction Mechanism Register") found a weakness.
// Each test passes while the gap exists. When a gap is fixed on purpose, the test fails;
// flip the assertion to the new rule and drop the "KNOWN GAP" label. Do not fix a gap by editing this file alone.
// Run: node --test test/known_gaps.test.js
const test = require('node:test');
const assert = require('node:assert');
const B = require('../code/lib/burrs');
const Br = require('../code/lib/bristles');
const D = require('../code/lib/dedupe');

const txt = (u) => (u && typeof u === 'object') ? (u.text || u.t || '') : String(u);

test('KNOWN GAP S1-03: the sentence splitter breaks at abbreviations (Dr. Mr. St. U.S. Fig.)', () => {
  const units = B.segment('Dr. Smith met Mr. Jones in St. Louis. The U.S. Army arrived in 1865. See Fig. 2 for details.').map(txt);
  // a quote built from one unit can end mid-name
  assert.ok(units.includes('Dr.'), 'Dr. ends a unit');
  assert.ok(units.includes('Smith met Mr.'), 'Mr. ends a unit');
  assert.ok(units.includes('Jones in St.'), 'St. ends a unit');
  assert.ok(units.includes('The U.S.'), 'U.S. ends a unit');
  assert.ok(units.includes('See Fig.'), 'Fig. ends a unit');
});
test('S1-03 (holds): a decimal point does not split a unit', () => {
  assert.ok(B.segment('It was 3.5 km long.').map(txt).includes('It was 3.5 km long.'));
});

test('KNOWN GAP S3-05: a single-digit number that differs from the note is accepted', () => {
  const note = { title: 'Zoo', cleaned: 'The zoo keeps 5 tigers near the north gate.' };
  const v = B.verifyBurrs([{ claim: 'The zoo keeps 3 tigers near the north gate.', quote: 'keeps 5 tigers near the north gate' }], note);
  assert.strictEqual(v.accepted.length, 1, 'accepted although 3 is not in the note');
});
test('S3-05 (holds): a two-digit number that differs from the note is rejected', () => {
  const note = { title: 'Zoo', cleaned: 'The zoo keeps 50 tigers near the north gate.' };
  const v = B.verifyBurrs([{ claim: 'The zoo keeps 30 tigers near the north gate.', quote: 'keeps 50 tigers near the north gate' }], note);
  assert.deepStrictEqual(v.rejected.map(r => r.reason), ['number_not_in_note']);
});

test('KNOWN GAP S3-06: a strict hook value matches as a substring, not a whole word', () => {
  const note = { title: 'Plays', cleaned: 'Romeo and Juliet is a tragedy by Shakespeare.' };
  const v = B.verifyBurrs([{ claim: 'Romeo and Juliet is a tragedy by Shakespeare.', quote: 'Romeo and Juliet is a tragedy by Shakespeare',
    hooks: [{ type: 'entity', value: 'Rome', category: 'place' }, { type: 'entity', value: 'Hamlet', category: 'work' }] }], note);
  assert.deepStrictEqual(v.accepted[0].hooks.map(h => h.value), ['Rome'], 'Rome kept inside Romeo; Hamlet dropped');
});

test('KNOWN GAP S4-02: keys under 4 characters never join (US, UK, USA, DNA)', () => {
  ['ra', 'oz', 'us', 'uk', 'usa', 'dna', 'ai'].forEach(k => assert.strictEqual(Br.usableKey(k), false, k));
  ['rome', 'iron'].forEach(k => assert.strictEqual(Br.usableKey(k), true, k));
});
test('S4-02 (holds): a bare year-like number is usable, 999 and 2040 are not years', () => {
  assert.strictEqual(Br.isYearKey('1000'), true);
  assert.strictEqual(Br.isYearKey('999'), false);
  assert.strictEqual(Br.isYearKey('2040'), false);
});

test('KNOWN GAP S5-05: two near-identical claims are never compared if their three rarest words differ', () => {
  const shared = Array.from({ length: 30 }, (_, i) => 'term' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  const a = { id: 1, note_id: 1, claim: 'Ledger ' + shared.join(' ') + ' zephyr quartz plinth.' };
  const c = { id: 2, note_id: 2, claim: 'Ledger ' + shared.join(' ') + ' marlin obsidian gantry.' };
  assert.ok(D.sameFact(D.prep(a), D.prep(c)) > 0.8, 'sameFact rates the pair as the same fact');
  assert.deepStrictEqual(D.findDupes([a, c]), [], 'but findDupes never compares them');
});

test('KNOWN GAP D-01: the extraction cache key has the provider but not the model id', () => {
  const k1 = B.cacheKey('gemini', 'input');
  assert.notStrictEqual(k1, B.cacheKey('grok', 'input'), 'provider is in the key');
  assert.strictEqual(B.cacheKey.length, 2, 'signature is (provider, input): there is no model parameter');
});
