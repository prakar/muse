'use strict';
const test = require('node:test'), assert = require('node:assert'), path = require('node:path'), { pathToFileURL } = require('node:url');
const imp = f => import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', f)).href);

test('keys: each key means one thing, g starts a chord, and unknown keys do nothing', async () => {
  const { resolve } = await imp('keys.mjs');
  assert.deepStrictEqual(resolve('j'), { act: 'move', arg: 'down' }); assert.deepStrictEqual(resolve('k'), { act: 'move', arg: 'up' }); assert.deepStrictEqual(resolve('h'), { act: 'move', arg: 'left' }); assert.deepStrictEqual(resolve('l'), { act: 'move', arg: 'right' });
  assert.deepStrictEqual(resolve('f'), { act: 'focus' }); assert.deepStrictEqual(resolve('?'), { act: 'help' }); assert.deepStrictEqual(resolve('1'), { act: 'shelf1' });
  assert.deepStrictEqual(resolve('g'), { pending: 'g' });
  assert.deepStrictEqual(resolve('h', 'g'), { act: 'go', arg: 'home' }); assert.deepStrictEqual(resolve('c', 'g'), { act: 'collection' });
  assert.deepStrictEqual(resolve('F'), { act: 'zone', arg: 'facts' }); assert.deepStrictEqual(resolve('W'), { act: 'zone', arg: 'words' }); assert.deepStrictEqual(resolve('R'), { act: 'zone', arg: 'results' }); assert.deepStrictEqual(resolve('P'), { act: 'zone', arg: 'pages' });
  assert.strictEqual(resolve('z'), null); assert.strictEqual(resolve('z', 'g'), null); assert.strictEqual(resolve('/'), null, '/ belongs to the search box');
});

test('keys: the overlay lists exactly the keys the handler knows', async () => {
  const { KEY_GROUPS, resolve } = await imp('keys.mjs');
  const listed = KEY_GROUPS.flatMap(g => g.keys.map(k => k[0]));
  ['F', 'W', 'R', 'P', 'h  j  k  l', 'f', 'c', 's', 'o', 'u', 'r', 'g h', '?', '/', '0', 'a'].forEach(k => assert.ok(listed.includes(k), 'documented: ' + k));
  listed.filter(k => k.length === 1 && !'/'.includes(k)).forEach(k => assert.ok(resolve(k), 'handled: ' + k));
});
