'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { angles } = require('../code/lib/angles');

const b = (id, claim, kind, hooks) => ({ id, claim, kind: kind || 'fact', hooks: hooks || [] });
const hs = (pile) => angles(pile).map((a) => a.h);

test('same calendar day in two facts is heuristic 3', () => {
  const a = angles([b(1, 'Einstein was born on 14 March 1879.'), b(2, 'The firm was founded on 14 March 1903.'), b(3, 'Born 2 May 1900.')]);
  assert.deepStrictEqual(a.filter((x) => x.h === 3).map((x) => x.ids), [[1, 2]]);
});

test('same name, different kinds of thing is heuristic 7', () => {
  const a = angles([b(1, 'Mercury is a planet.', 'fact', [{ type: 'entity', value: 'Mercury', cat: 'place' }]),
    b(2, 'Mercury is an element.', 'fact', [{ type: 'entity', value: 'Mercury', cat: 'substance' }])]);
  assert.deepStrictEqual(a.filter((x) => x.h === 7).map((x) => x.ids), [[1, 2]]);
});

test('etymology kind or etymon hook is 45; uniqueness 36; homonym 48', () => {
  assert.ok(hs([b(1, 'x', 'etymology')]).includes(45));
  assert.ok(hs([b(1, 'x', 'fact', [{ type: 'etymon', value: 'Gargantuan' }])]).includes(45));
  assert.ok(hs([b(1, 'x', 'fact', [{ type: 'uniqueness', value: 'only one' }])]).includes(36));
  assert.ok(hs([b(1, 'x', 'fact', [{ type: 'homonym', value: 'The Golden Horse' }])]).includes(48));
});

test('shared morpheme across names is 50 and a plain pile finds nothing', () => {
  const e = (id, n) => b(id, n, 'fact', [{ type: 'entity', value: n, cat: 'place' }]);
  assert.ok(hs([e(1, 'Amu Darya'), e(2, 'Syr Darya')]).includes(50));
  assert.deepStrictEqual(angles([b(1, 'Plain fact.'), b(2, 'Another plain fact.')]), []);
  assert.deepStrictEqual(angles(null), []);
});

test('a fact that states its relation points at the matching heuristic', () => {
  const a = angles([b(1, 'The sole is red because an assistant used nail polish.'), b(2, 'The town is named after a saint.'), b(3, 'A BASE jump occurred at Trango Tower.')]);
  assert.deepStrictEqual(a.filter((x) => x.h === 1).map((x) => [x.ids, x.also]), [[[1], [14, 18, 19]]]);
  assert.deepStrictEqual(a.filter((x) => x.h === 8).map((x) => x.ids), [[2]]);
  assert.ok(!a.some((x) => x.ids.includes(3)));
});

test('GET /api/angles reads the pile from the model and refuses bad ids', async () => {
  const http = require('node:http'), os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks');
  const facts = { 1: b(1, 'It is red because an assistant used nail polish.'), 2: b(2, 'Plain fact.') };
  const stub = { pile: (ids) => ids.map((i) => facts[i]).filter(Boolean), burrInfo: () => null, stickRandom: () => null, burrs: [], sparks: [], wordplay: [], notes: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-')), marks = K.open(path.join(dir, 'm.jsonl'), 't');
  const srv = createServer({ model: stub, marks, notes: { get: () => null }, version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui') });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: 'localhost:' + port } }, (r) => { let x = ''; r.on('data', (d) => x += d); r.on('end', () => res({ status: r.statusCode, body: x })); }));
  try {
    const ok = await get('/api/angles?ids=1,2,99'), j = JSON.parse(ok.body);
    assert.strictEqual(ok.status, 200); assert.strictEqual(j.facts, 2); assert.deepStrictEqual(j.angles.map((a) => [a.h, a.ids]), [[1, [1]]]); assert.deepStrictEqual(j.angles[0].alsoNames.map((n) => n.h), [14, 18, 19]);
    assert.strictEqual((await get('/api/angles?ids=1,x')).status, 400); assert.strictEqual(JSON.parse((await get('/api/angles')).body).facts, 0);
  } finally { srv.close(); }
});
