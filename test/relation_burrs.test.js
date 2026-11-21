'use strict';
const test = require('node:test'), assert = require('node:assert');
const R = require('../code/lab/relation_burrs');
const burrs = [{ id: 'a', claim: 'Louboutin chose red soles after an assistant used nail polish.' }, { id: 'b', claim: 'Everest is tall.' }];

test('quotes are checked against the fact, with elisions', () => {
  assert.ok(R.found('red soles ... nail polish', burrs[0].claim)); assert.ok(!R.found('invented words', burrs[0].claim));
});
test('parseBatch maps numbers to burrs, drops unknown relations, marks weak quotes', () => {
  const t = 'x {"facts":[{"n":1,"relations":[{"r":"cause","quote":"after an assistant used nail polish"},{"r":"bogus","quote":"x"},{"r":"named-for","quote":"made up"}]},{"n":2,"relations":[]}]}';
  const p = R.parseBatch(t, burrs); assert.ok(p.ok);
  assert.deepStrictEqual(p.byId.get('a').map(x => [x.r, x.weak]), [['cause', false], ['named-for', true]]); assert.deepStrictEqual(p.byId.get('b'), []);
  assert.strictEqual(R.parseBatch('no json', burrs).ok, false);
});
test('run batches, caches, and stops at the budget', async () => {
  const mem = new Map(), cache = { get: k => mem.get(k), put: (k, v) => mem.set(k, v) }; let calls = 0;
  const callLLM = async () => { calls++; return { text: '{"facts":[{"n":1,"relations":[{"r":"cause","quote":"nail polish"}]}]}', model: 'm', tokensIn: 1, tokensOut: 1 }; };
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'b' + i, claim: 'nail polish ' + i })), opts = { provider: 'x', maxUsd: 1, rate: () => 0.1 };
  const r = await R.run(many, { callLLM, cache }, opts); assert.strictEqual(calls, 3); assert.strictEqual(r.rows.length, 20);
  await R.run(many, { callLLM, cache }, opts); assert.strictEqual(calls, 3);
  const r2 = await R.run(many, { callLLM, cache: { get: () => null, put() {} } }, { provider: 'x', maxUsd: 0.15, rate: () => 0.1 }); assert.ok(r2.problems.some(p => p.stopped === 'budget'));
  const s = R.summary(r.rows); assert.strictEqual(s.per.cause, 3); assert.strictEqual(R.sample(r.rows, 2, 1).length, 2);
});
