'use strict';
const test = require('node:test'), assert = require('node:assert');
const { relationsIn } = require('../code/lib/relations');
test('relations come only from the sentence\'s own connecting words', () => {
  assert.deepStrictEqual(relationsIn('It collapsed because of the heat.').map((x) => x.r), ['cause']);
  assert.deepStrictEqual(relationsIn('A film inspired by a poem, named after a river.').map((x) => x.r).sort(), ['inspired-by', 'named-for']);
  assert.deepStrictEqual(relationsIn('A BASE jump occurred at Trango Tower.'), []);
  assert.deepStrictEqual(relationsIn(null), []);
});
