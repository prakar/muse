'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const Bud = require('../code/lib/budget');

test('gemini-2.5-flash is priced at the billed rate; flash-lite is not mistaken for flash', () => {
  assert.deepStrictEqual(Bud.priceFor('gemini', 'gemini-2.5-flash', 1000), { in: 0.30, out: 2.50, known: true });
  assert.deepStrictEqual(Bud.priceFor('gemini', 'gemini-2.5-flash-lite', 1000), { in: 0.10, out: 0.40, known: true });
  assert.strictEqual(Bud.priceFor('gemini', 'gemini-2.5-pro', 1000).out, 10.00);
});
test('an unrecognised gemini model is charged the highest known rate, flagged unknown', () => {
  const r = Bud.priceFor('gemini', 'gemini-9-experimental', 1000);
  assert.deepStrictEqual([r.in, r.out, r.known], [1.25, 10.00, false]);
});
test('calibration: the recorded nuggetize tokens cost about what Google billed, not the old $6.7', () => {
  // 2026-10-27: 36,978,016 in / 13,006,563 out over 20,692 calls. Google bill INR 3.73K (about $39 at INR 95/USD); list price gives $43.6.
  const r = Bud.priceFor('gemini', 'gemini-2.5-flash', 1800);
  const cost = (36978016 * r.in + 13006563 * r.out) / 1e6;
  assert.ok(cost > 39 && cost < 46, String(cost));
});
test('tagger.js and lib/budget.js carry the same gemini prices (kept in sync by hand)', () => {
  const pick = f => fs.readFileSync(__dirname + '/../code/' + f, 'utf8').split('\n').filter(l => /gemini-2\\\.5|^\s*gemini:\s+\{/.test(l)).map(l => l.replace(/\s+/g, ' ').replace(/largeContext: true, ?/, '').replace(/ ?\/\/.*$/, '').trim());
  const a = pick('lib/budget.js'), b = pick('tagger.js');
  assert.ok(a.length >= 4, 'found the gemini rows');
  assert.deepStrictEqual(a, b);
});
