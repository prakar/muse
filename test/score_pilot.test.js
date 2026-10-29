const test = require('node:test');
const assert = require('node:assert');
const P = require('../code/lab/score_pilot');

test('successAt counts queries with a hit at or above the grade within k', () => {
  const g = [[0, 2, 0], [0, 0, 0], [1, 0, 0], []];
  assert.strictEqual(P.successAt(g, 3, 2).hits, 1);
  assert.strictEqual(P.successAt(g, 1, 1).hits, 1);
  assert.strictEqual(P.successAt(g, 3, 1).hits, 2);
  assert.strictEqual(P.successAt(g, 3, 1).n, 3);       // the empty (unjudged) query is skipped
  assert.strictEqual(P.successAt([], 3, 1).n, 0);
});

test('wilson interval is wide for small n and bounded in [0,1]', () => {
  const [lo, hi] = P.wilson(6, 12);
  assert.ok(lo > 0.2 && lo < 0.3 && hi > 0.7 && hi < 0.8);
  assert.deepStrictEqual(P.wilson(0, 0), [0, 0]);
  assert.ok(P.wilson(12, 12)[1] <= 1);
});
