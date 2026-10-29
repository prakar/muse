const test = require('node:test');
const assert = require('node:assert');
const S = require('../code/lab/semantic_pilot');

test('promptsFor uses the model-card formats and falls back to raw text', () => {
  const g = S.promptsFor('embeddinggemma:latest');
  assert.strictEqual(g.query('why'), 'task: search result | query: why');
  assert.strictEqual(g.doc('claim', ''), 'title: none | text: claim');
  assert.strictEqual(g.doc('claim', 'T'), 'title: T | text: claim');
  assert.ok(S.promptsFor('qwen3-embedding:0.6b').query('why').startsWith('Instruct:'));
  assert.strictEqual(S.promptsFor('bge-m3').query('why'), 'why');
});

test('cosine and topK', () => {
  assert.ok(Math.abs(S.cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.strictEqual(S.cosine([1, 0], [0, 1]), 0);
  assert.strictEqual(S.cosine([0, 0], [1, 1]), 0);
  assert.deepStrictEqual(S.topK([0.1, 0.9, 0.5], 2), [1, 2]);
});

test('rrf rewards items that rank well in both lists', () => {
  assert.deepStrictEqual(S.rrf([[1, 2, 3], [3, 2, 9]], 3), [3, 2, 1]);
  assert.deepStrictEqual(S.rrf([[7], []], 5), [7]);
});
