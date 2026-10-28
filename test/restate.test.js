'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../code/lab/restate_check');
const { memCache } = require('../code/lab/judge');

test('parseGroups accepts valid groups and an empty list', () => {
  assert.deepStrictEqual(R.parseGroups('{"groups":[[3,1],[2,5]],"why":"x"}', 5), { ok: true, groups: [[1, 3], [2, 5]] });
  assert.deepStrictEqual(R.parseGroups('```json\n{"groups":[],"why":"none"}\n```', 3), { ok: true, groups: [] });
});
test('parseGroups rejects anything it cannot verify', () => {
  const bad = (t, n) => assert.strictEqual(R.parseGroups(t, n).ok, false, t);
  bad('no json', 3); bad('{"why":"x"}', 3); bad('{"groups":[[1]]}', 3);
  bad('{"groups":[[1,9]]}', 3);             // fact that was not provided
  bad('{"groups":[[1,2],[2,3]]}', 3);       // a fact in two groups
  bad('{"groups":[[1,1]]}', 3);             // repeats inside a group
  bad('{"groups":[["a","b"]]}', 3);
});
test('status: restated when fewer than two distinct facts remain, partly when some restate, else distinct', () => {
  assert.strictEqual(R.statusOf(2, [[1, 2]]), 'restated');
  assert.strictEqual(R.statusOf(3, [[1, 2, 3]]), 'restated');
  assert.strictEqual(R.statusOf(3, [[1, 3]]), 'partly');
  assert.strictEqual(R.statusOf(4, []), 'distinct');
  assert.strictEqual(R.distinctCount(6, [[1, 2], [3, 4, 5]]), 3);
});
test('checkRecords: verifies, caches, flags errors, honours the cap, never guesses', async () => {
  const recs = [{ id: 'a', handle: 'A', claims: ['Eiffel Tower opened in 1889 Paris', 'Eiffel Tower inaugurated 1889 in Paris, x one'] }, { id: 'b', handle: 'B', claims: ['p', 'q', 'r'] }, { id: 'c', handle: 'C', claims: ['m', 'n'] }];
  const answers = { a: '{"groups":[[1,2]],"why":"same"}', b: '{"groups":[[1,4]],"why":"bad index"}', c: '{"groups":[],"why":"different"}' };
  let calls = 0; const cache = memCache();
  const callLLM = async (prov, user) => { calls++; const id = user.includes('x one') ? 'a' : user.includes('[3] r') ? 'b' : 'c'; return { text: answers[id], model: 'gemini-2.5-flash', tokensIn: 100, tokensOut: 20 }; };
  const out = await R.checkRecords(recs, { callLLM, cache }, { maxUsd: 1 });
  assert.deepStrictEqual(out.map(o => o.status), ['restated', 'error', 'distinct']);
  assert.match(out[1].error, /not provided/);
  assert.ok(out[0].cost > 0);
  const again = await R.checkRecords(recs, { callLLM, cache }, { maxUsd: 1 });
  assert.strictEqual(calls, 3, 'second run answers from the cache');
  assert.deepStrictEqual(again.map(o => o.status), ['restated', 'error', 'distinct']);
  const capped = await R.checkRecords([{ id: 'z', handle: 'Z', claims: ['u', 'v'] }, { id: 'y', handle: 'Y', claims: ['w', 'v'] }], { callLLM: async () => ({ text: '{"groups":[],"why":"x"}', model: 'gemini-2.5-flash', tokensIn: 1e6, tokensOut: 0 }), cache: memCache() }, { maxUsd: 0.1 });
  assert.strictEqual(capped[1].error, 'run cap reached');
  const failed = await R.checkRecords([{ id: 'f', handle: 'F', claims: ['u', 'v'] }], { callLLM: async () => { throw new Error('boom'); }, cache: memCache() }, {});
  assert.match(failed[0].error, /call failed: boom/);
});

test('filterGroups: drops groups whose facts share no real wording, keeps connected pieces', () => {
  const c = ['Balkh was called Bactra, capital of Bactria.', 'Ninus was struck by Semiramis bravery at the capture of Bactra.', 'Rembrandt van Rijn lived from 1606 to 1669.', 'Rembrandt was born in 1606.', 'Rembrandt van Rijn painted portraits.'];
  assert.deepStrictEqual(R.filterGroups(c, [[1, 2]]), [], 'one shared word is not enough');
  assert.deepStrictEqual(R.filterGroups(c, [[3, 4]]), [[3, 4]], 'name plus year is real overlap');
  assert.deepStrictEqual(R.filterGroups(c, [[1, 2, 3]]), [], 'unrelated facts in one group all fall away');
});
