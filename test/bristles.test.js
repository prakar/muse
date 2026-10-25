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
