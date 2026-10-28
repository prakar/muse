'use strict';
const test = require('node:test'), assert = require('node:assert');
const P = require('../code/lib/phonetics');
const DICT = P.parseDict(['; comment', 'knight N AY1 T', 'night N AY1 T', 'paine P EY1 N', 'pain P EY1 N', 'keats K IY1 T S', 'beats B IY1 T S', 'sheets SH IY1 T S', 'read R EH1 D', 'read(2) R IY1 D', 'hampton HH AE1 M P T AH0 N', 'compton K AA1 M P T AH0 N', 'tea T IY1', 'bee B IY1'].join('\n'));
const nm = (name, category) => ({ name: name, category: category || 'other', notes: [1, 2] });

test('parseDict keeps first pronunciation and skips comments', () => {
  assert.deepStrictEqual(P.phones(DICT, 'Read'), ['R', 'EH1', 'D']);
  assert.strictEqual(P.phones(DICT, 'zzz'), null);
});
test('rhymeKey runs from the last stressed vowel', () => {
  assert.strictEqual(P.rhymeKey(P.phones(DICT, 'keats')), 'IY T S');
  assert.strictEqual(P.rhymeKey(P.phones(DICT, 'hampton')), 'AE M P T AH N');
});
test('homophones: name sounds like a differently spelt everyday word', () => {
  const r = P.homophones(DICT, [nm('Knight'), nm('Paine'), nm('Night'), nm('Keats')], new Set(['night', 'pain', 'knight']));
  assert.deepStrictEqual(r.map(x => x.name).sort(), ['Knight', 'Night', 'Paine']);
  assert.deepStrictEqual(r.find(x => x.name === 'Paine').words, ['pain']);
});
test('rhymePairs: rhyme spelt differently, skips same ending, homophones and bare vowels', () => {
  const r = P.rhymePairs(DICT, [nm('John Keats', 'person'), nm('Beats', 'organisation'), nm('Sheets', 'object'), nm('Hampton'), nm('Compton'), nm('Tea'), nm('Bee')]);
  assert.ok(r.some(p => p.a === 'John Keats' && p.b === 'Beats' && p.cross));
  assert.ok(!r.some(p => /Hampton|Compton/.test(p.a + p.b)), 'same-ending pair dropped');
  assert.ok(!r.some(p => /Tea|Bee/.test(p.a + p.b)), 'bare vowel key dropped');
  assert.ok(!r.some(p => p.a === 'Keats' && p.b === 'Knight'));
});
