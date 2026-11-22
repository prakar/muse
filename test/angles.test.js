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

test('every angle carries a seed: answer, join and hide', () => {
  const a = angles([b(1, 'Born on 14 March 1879.'), b(2, 'Founded on 14 March 1903.'), b(3, 'x', 'etymology', [{ type: 'etymon', value: 'Gargantuan' }])]);
  const d3 = a.find((x) => x.h === 3), d45 = a.find((x) => x.h === 45);
  assert.deepStrictEqual(d3.seed, { answer: 'the date, march 14', join: 'the same calendar day', hide: 'the date' });
  assert.strictEqual(d45.seed.answer, 'Gargantuan');
  a.forEach((x) => assert.ok(x.seed && x.seed.answer && x.seed.join && x.seed.hide));
});

test('GET /api/angles/browse groups findings by shape, pages them and keeps same-note days out', async () => {
  const http = require('node:http'), os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks');
  const all = [{ ...b(1, 'Born on 14 March 1879.'), noteId: 10 }, { ...b(2, 'Founded on 14 March 1903.'), noteId: 11 }, { ...b(3, 'Both on 2 May 1900.'), noteId: 12 }, { ...b(4, 'Also 2 May 1901.'), noteId: 12 },
    { ...b(5, 'x', 'etymology', [{ type: 'etymon', value: 'Gargantuan' }]), noteId: 13 }];
  const info = (id) => { const f = all.find((x) => x.id === id); return f ? { id, noteId: f.noteId, note: 'N' + f.noteId, claim: f.claim, quote: null, hooks: [] } : null; };
  const stub = { allPile: () => all, pile: () => [], burrInfo: info, stickRandom: () => null, burrs: [], sparks: [], wordplay: [], notes: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')), marks = K.open(path.join(dir, 'm.jsonl'), 't');
  const srv = createServer({ model: stub, marks, notes: { get: () => null }, version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui') });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: 'localhost:' + port } }, (r) => { let x = ''; r.on('data', (d) => x += d); r.on('end', () => res(JSON.parse(x))); }));
  try {
    const d = await get('/api/angles/browse?h=3'); assert.deepStrictEqual(d.counts.map((c) => [c.h, c.n]), [[3, 1], [45, 1]]);
    assert.deepStrictEqual(d.rows.map((r) => r.facts.map((f) => f.id)), [[1, 2]]); assert.strictEqual(d.rows[0].seed.hide, 'the date');
    const e = await get('/api/angles/browse?h=45&size=24'); assert.strictEqual(e.name, 'Etymology unveil'); assert.strictEqual(e.size, 24);
    assert.strictEqual((await get('/api/angles/browse?h=999')).h, 3);
  } finally { srv.close(); }
});

test('a single cue fact is only "a link starts here"; two linked facts sharing an entity are a chain', () => {
  const e = (id, claim, name) => b(id, claim, 'fact', [{ type: 'entity', value: name, cat: 'event' }]);
  const one = angles([e(1, 'Madame X caused a scandal in Paris.', 'Madame X')]);
  assert.deepStrictEqual(one.map((x) => [x.h, x.half, x.label]), [[1, true, 'A link starts here']]);
  const loose = angles([e(1, 'Madame X caused a scandal in Paris.', 'Madame X'), e(2, 'Sargent left Paris for London.', 'Madame X')]);
  const c = loose.filter((x) => x.strength); assert.strictEqual(c.length, 1); assert.strictEqual(c[0].half, false); assert.strictEqual(c[0].strength, 'one fact states a link'); assert.deepStrictEqual(c[0].ids, [1, 2]);
  assert.ok(!loose.some((x) => x.half), 'the link inside a chain is not repeated');
  const strong = angles([e(1, 'The cake was named after a marriage.', 'Battenberg cake'), e(2, 'The markings are so-called because of the cake.', 'Battenberg cake')]);
  assert.deepStrictEqual(strong.filter((x) => x.strength).map((x) => x.strength), ['both facts state a link']);
  assert.deepStrictEqual(angles([e(1, 'Madame X caused a scandal.', 'Madame X'), e(2, 'Unrelated fact.', 'Somebody else')]).filter((x) => x.strength), []);
});
