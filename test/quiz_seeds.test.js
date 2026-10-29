const test = require('node:test');
const assert = require('node:assert');
const Q = require('../code/lab/quiz_seeds');

test('seedText joins question and answer into one capped line', () => {
  assert.strictEqual(Q.seedText({ question: 'Who  wrote\nit?', answer: 'Archer' }, 100), 'Who wrote it? Answer: Archer');
  assert.strictEqual(Q.seedText({ question: 'Q only', answer: '' }, 100), 'Q only');
  assert.strictEqual(Q.seedText({ question: 'x'.repeat(50), answer: '' }, 10).length, 10);
});

test('diversify caps hits per note, keeps best-first order and stops at k', () => {
  const noteOf = i => ({ 0: 'a', 1: 'a', 2: 'a', 3: 'b', 4: 'c' })[i];
  assert.deepStrictEqual(Q.diversify([0, 1, 2, 3, 4], noteOf, 2, 5), [0, 1, 3, 4]);
  assert.deepStrictEqual(Q.diversify([0, 1, 2, 3, 4], noteOf, 2, 2), [0, 1]);
  assert.deepStrictEqual(Q.diversify([], noteOf, 2, 5), []);
});
