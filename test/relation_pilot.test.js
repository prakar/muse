'use strict';
const test = require('node:test'), assert = require('node:assert');
const R = require('../code/lab/relation_pilot');
const MD = ['| # | Heuristic | Src | Fragment (paraphrase) | How extracted | Conf |', '|---|---|---|---|---|---|',
  '| 1 | Chain with pivot | P | Tariff leads to a land name | x | H |', '| | | P | Kerosene displaces whale oil | y | H |',
  '| 36 | Uniqueness claims | KK | Highest peak | z | H |', '| 40 | Hidden kinship | KK | Seth and Ghosh | w | L |'].join('\n');

test('parseFragments reads rows and continues the heuristic above', () => {
  const f = R.parseFragments(MD); assert.deepStrictEqual(f.map(x => x.h), [1, 1, 36, 40]); assert.strictEqual(f[1].text, 'Kerosene displaces whale oil');
  assert.deepStrictEqual(R.pick(f).map(x => x.h), [1, 1, 36]);   // the weak row (L) and non-relation, non-control rows are left out
});
test('parseRelations keeps only listed relations and survives extra text', () => {
  assert.deepStrictEqual(R.parseRelations('ok {"relations":["cause","bogus"]} done'), { ok: true, relations: ['cause'] });
  assert.strictEqual(R.parseRelations('nothing').ok, false);
});
test('run asks once per fragment, caches, and report scores relations and controls', async () => {
  const mem = new Map(), cache = { get: k => mem.get(k), put: (k, v) => mem.set(k, v) }; let calls = 0;
  const callLLM = async (p, text) => { calls++; return { text: text.includes('Highest') ? '{"relations":["cause"]}' : '{"relations":["cause"]}', model: 'm', tokensIn: 10, tokensOut: 5 }; };
  const opts = { provider: 'x', maxUsd: 1, rate: () => 0.001 }, frags = R.parseFragments(MD);
  const r = await R.run(frags, { callLLM, cache }, opts); assert.strictEqual(calls, 3);
  await R.run(frags, { callLLM, cache }, opts); assert.strictEqual(calls, 3);
  const s = R.report(r.rows); assert.deepStrictEqual([s.found, s.relationRows, s.controlsFlagged, s.controls], [2, 2, 1, 1]);
});
