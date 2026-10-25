'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../code/lib/bristles');

test('foldKey strips diacritics, apostrophes, hyphens and case', () => {
  assert.strictEqual(L.foldKey("Rāmānujan's  Jean-Paul"), 'ramanujans jean paul');
  assert.strictEqual(L.foldKey('Café “Noir”'), 'cafe noir');
});
test('variantKey merges transliteration variants and not unrelated names', () => {
  assert.strictEqual(L.variantKey('Bhatiyali'), L.variantKey('Batiyali'));
  assert.strictEqual(L.variantKey('Wadiyar'), L.variantKey('Vadiyar'));
  assert.notStrictEqual(L.variantKey('Mysore'), L.variantKey('Madras'));
  assert.notStrictEqual(L.variantKey('300 feet'), L.variantKey('30 feet'));
  assert.notStrictEqual(L.variantKey('daesh'), L.variantKey('daes'));
});
test('yearsIn finds years, not parts of other numbers', () => {
  assert.deepStrictEqual(L.yearsIn('In 1952 and 1953; 12,000 people; pi 3.1415; war 1914-1918'), ['1952', '1953', '1914', '1918']);
  assert.deepStrictEqual(L.yearsIn('born in the 1990s, died 2019.'), ['1990', '2019']);
});
test('usableKey rejects stopwords, short and bare small numbers', () => {
  assert.strictEqual(L.usableKey('the'), false);
  assert.strictEqual(L.usableKey('68'), false);
  assert.strictEqual(L.usableKey('1952'), true);
  assert.strictEqual(L.usableKey('golden temple'), true);
});
test('titleKey keeps the naming head of a title', () => {
  assert.strictEqual(L.titleKey('Bhatiyali: A short survey of rivers'), 'bhatiyali');
  assert.strictEqual(L.titleKey('Karak | Inc.com'), 'karak');
  assert.strictEqual(L.titleKey('a b c d e f g h long title here'), '');
});
test('cosine: same-context burrs are close, different-context far; tagDistance handles unknown', () => {
  const docs = [L.tokens('mercury is a liquid metal used in thermometers'), L.tokens('mercury liquid metal thermometer gauge'), L.tokens('roman god mercury messenger of the gods')];
  const idf = L.buildIdf(docs), ex = new Set(['mercury']);
  const v = docs.map(d => L.vectorOf(d, idf, ex));
  assert.ok(L.cosine(v[0], v[1]) > L.cosine(v[0], v[2]));
  assert.strictEqual(L.tagDistance(new Set(['a', 'b']), new Set(['c'])), 1);
  assert.strictEqual(L.tagDistance(new Set(['a']), new Set(['a'])), 0);
  assert.strictEqual(L.tagDistance(new Set(), new Set(['a'])), null);
});

test('numbers and dates carry a unit or an era, so look-alikes do not join', () => {
  const L = require('../code/lib/bristles');
  const k = (v, c) => L.qualifyNumber(v, c).key;
  assert.strictEqual(k('1170', 'Founded in 1170 BC'), '1170 bc');
  assert.strictEqual(k('1170', 'Founded in 1170 by Henry'), '1170');
  assert.strictEqual(k('1120', 'a distance of 1120 km'), '1120 km');
  assert.strictEqual(k('1743', 'scored 1743 runs in tests'), '1743 runs');
  assert.strictEqual(k('12.25', 'it cost $12.25 per kg'), '12.25 usd');
  assert.strictEqual(k('1085', 'Toledo fell in 1085 Toledo'), '1085');
  assert.strictEqual(k('1000', 'about 1,000 people came'), '1000 people');
  assert.strictEqual(k('156.8', 'a value of 156.8'), '');
  assert.notStrictEqual(k('156.8', 'measured 156.8 cm'), k('156.8', 'measured 156.8 kg'));
  assert.deepStrictEqual(L.datesIn('In 1085 Toledo fell; he scored 1085 runs; a 1120 km road; 1170 BC; $12.25.').map(x => x.key), ['1085', '1170 bc']);
});
