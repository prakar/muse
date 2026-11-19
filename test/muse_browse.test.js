'use strict';
// Browse: the shelf call narrows by shelf, kind (any or every) and Starred only, orders by a lens or shuffles, and reports counts that already have the other filters applied.
const test = require('node:test'), assert = require('node:assert'), path = require('node:path'), fs = require('node:fs'), { pathToFileURL } = require('node:url');
const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js'), imp = f => import(pathToFileURL(path.join(UI, f)).href);

function model() {
  const { DatabaseSync } = require('node:sqlite'), M = require('../code/lib/muse_model'), dbFile = path.join(__dirname, '..', 'vault.db');
  if (!fs.existsSync(dbFile)) return null;
  return M.build(new DatabaseSync(dbFile, { readOnly: true }), 'nug-v6', {});
}

test('browse model: All shelves is the three shelves in one list, and the shelf counts add up', () => {
  const m = model(); if (!m) return;
  const all = m.shelf('all', {}), s = all.shelves;
  assert.strictEqual(s.veins + s.grip + s.lone, m.burrs.length, 'every fact is on exactly one shelf');
  assert.strictEqual(s.all, m.burrs.length);
  assert.ok(all.items.length > 0 && all.sort.key === 'shuffle' && all.sort.dir === null, 'the default order is a shuffle');
  assert.strictEqual(m.shelf('all', { sort: 'hooks' }).items[0].shelf, 'veins', 'ordered by hooks, the veins come first');
  assert.strictEqual(m.shelf('all', { page: 99999 }).page, all.pages, 'page numbers are clamped');
});

test('browse model: a kind filter leaves lone facts out, any is wider than every, and the counts follow the filters', () => {
  const m = model(); if (!m) return;
  const place = m.shelf('all', { type: 'place' }), time = m.shelf('all', { type: 'time' });
  assert.strictEqual(place.shelves.lone, 0, 'lone facts have no kinds');
  assert.ok(place.items.every(i => i.types.includes('place') && i.shelf !== 'lone'));
  const any = m.shelf('all', { type: 'place,time', match: 'any' }), every = m.shelf('all', { type: 'place,time', match: 'every' });
  assert.ok(any.shelves.all >= Math.max(place.shelves.all, time.shelves.all), 'any covers each kind alone');
  assert.ok(every.shelves.all <= Math.min(place.shelves.all, time.shelves.all), 'every is inside each kind alone');
  assert.ok(every.items.every(i => i.types.includes('place') && i.types.includes('time')));
  assert.strictEqual(place.shelves.veins + place.shelves.grip, place.shelves.all);
  const plain = m.shelf('all', {});
  assert.ok(Object.values(plain.typeCounts).every(c => c > 0) && plain.typeCounts.place === m.shelf('all', { type: 'place' }).shelves.all, 'a chip count equals what you get by choosing it');
});

test('browse model: Starred only keeps only the ids given, fragments included, and the old loops shelf is gone', () => {
  const m = model(); if (!m) return;
  const some = m.shelf('lone', { seed: 3 }).items.slice(0, 2).map(i => i.id), mine = m.shelf('all', { only: new Set(some) });
  assert.deepStrictEqual(mine.items.map(i => i.id).sort(), some.slice().sort());
  assert.strictEqual(m.shelf('all', { only: new Set() }).total, 0);
  assert.strictEqual(m.shelf('loops', {}), null, 'loops were retired: there is no such shelf');
  assert.ok(!('loop' in m.shelf('all', {}).items[0]) && !('loops' in m.shelf('all', {}).shelves), 'no loop text or loop count reaches the list');
});

test('browse model: shuffle is seeded, covers every shelf (veins too), and puts facts you have not seen first', () => {
  const m = model(); if (!m) return;
  const ids = o => m.shelf('all', Object.assign({ size: 12 }, o)).items.map(i => i.id);
  assert.deepStrictEqual(ids({ seed: 41 }), ids({ seed: 41 }), 'the same seed gives the same page');
  const a = ids({ seed: 41 }), b = ids({ seed: 42 });
  assert.ok(a.some(x => !b.includes(x)), 'another seed gives another page');
  assert.ok(!b.some(x => a.includes(x)), 'facts shown under one seed come after the unseen ones under the next');
  const veins = m.shelf('veins', { seed: 5 }), veins2 = m.shelf('veins', { seed: 6 });
  assert.ok(veins.items.every(i => i.shelf === 'veins') && veins.items[0].id !== veins2.items[0].id, 'veins shuffle too: they are no longer in a fixed order');
});

test('browse model: every lens is strict in its direction, ties are seeded, what a lens cannot measure comes last, and Surprise names its lens', () => {
  const m = model(); if (!m) return;
  const total = m.shelf('all', {}).total;
  ['hooks', 'kinds', 'rarest', 'length', 'note', 'order', 'rank', 'notesize', 'date'].forEach(k => {
    const r = m.shelf('all', { sort: k, size: 48 }); assert.strictEqual(r.total, total, k + ' keeps every fact'); assert.strictEqual(r.sort.key, k);
    assert.ok(r.sort.dir === 'asc' || r.sort.dir === 'desc', k);
    assert.notStrictEqual(m.shelf('all', { sort: k, dir: r.sort.dir === 'asc' ? 'desc' : 'asc', size: 48 }).items[0].id, r.items[0].id, k + ' reversed starts elsewhere');
  });
  const hooks = m.shelf('all', { sort: 'hooks', size: 96 }).items.map(i => i.nHooks); assert.deepStrictEqual(hooks, hooks.slice().sort((x, y) => y - x), 'hooks: most first');
  const len = m.shelf('all', { sort: 'length', dir: 'asc', size: 96 }).items.map(i => i.claim.length); assert.deepStrictEqual(len, len.slice().sort((x, y) => x - y), 'length: shortest first');
  const names = m.shelf('all', { sort: 'note', size: 96 }).items.map(i => i.note.toLowerCase()); assert.deepStrictEqual(names, names.slice().sort(), 'note: A to Z');
  const rare = m.shelf('all', { sort: 'rarest', size: 96 }).items; assert.ok(rare[0].nHooks > 0, 'rarest: facts with no hook come last');
  assert.deepStrictEqual(m.shelf('all', { sort: 'length', seed: 9 }).items.map(i => i.id), m.shelf('all', { sort: 'length', seed: 9 }).items.map(i => i.id), 'ties are seeded, so the page is stable');
  const s1 = m.shelf('all', { sort: 'surprise', seed: 1 }), s1b = m.shelf('all', { sort: 'surprise', seed: 1 });
  assert.ok(s1.sort.rolled && s1.sort.key !== 'surprise' && s1.sort.key !== 'shuffle' && (s1.sort.dir === 'asc' || s1.sort.dir === 'desc'), 'Surprise says which lens and which way');
  assert.deepStrictEqual(s1.items.map(i => i.id), s1b.items.map(i => i.id), 'the same seed rolls the same lens');
  assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(sd => m.shelf('all', { sort: 'surprise', seed: sd, size: 12 }).sort.key + m.shelf('all', { sort: 'surprise', seed: sd, size: 12 }).sort.dir)).size > 2, 'different seeds roll different lenses');
});

test('home address: round-trips, the trail zooms out one step at a time, old addresses still work', async () => {
  const { parse } = await imp('router.mjs'), { trail } = await imp('crumbs.mjs'), { factsHref } = await imp('views/home.mjs');
  const href = factsHref({ shelf: 'veins', type: ['place', 'time'], match: 'every', yours: true, sort: 'hooks', dir: 'asc' });
  const r = parse(href); assert.strictEqual(r.name, 'home'); assert.deepStrictEqual(r.query, { shelf: 'veins', type: 'place,time', match: 'every', yours: '1', sort: 'hooks', dir: 'asc' });
  assert.strictEqual(factsHref({ sort: 'shuffle' }), '#/', 'Shuffle is the default order and stays out of the address');
  assert.strictEqual(factsHref({ shelf: 'all' }), '#/', 'All shelves is the default and stays out of the address');
  assert.strictEqual(factsHref({ type: ['place'], match: 'every' }), '#/?type=place', 'match only matters with two kinds');
  assert.strictEqual(parse('#/browse?shelf=veins').name, 'home'); assert.strictEqual(parse('#/browse?shelf=veins').query.shelf, 'veins');
  assert.deepStrictEqual(parse('#/wordplay/homophone').query, { wp: 'homophone' });
  assert.deepStrictEqual(trail(parse('#/')).map(x => x.label), ['Home']);
  assert.deepStrictEqual(trail(parse('#/?type=place')).map(x => x.label), ['Home', 'Places']);
  assert.deepStrictEqual(trail(parse('#/?yours=1')).map(x => x.label), ['Home', 'Starred only']);
});
