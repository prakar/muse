'use strict';
// Browse: the shelf call narrows by shelf, kind (any or every), Loops and Yours, and reports counts that already have the other filters applied.
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
  assert.ok(all.items.length > 0 && all.items[0].shelf === 'veins', 'veins come first');
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

test('browse model: Loops keeps only facts with an unanswered why, and Yours keeps only the ids given, fragments included', () => {
  const m = model(); if (!m) return;
  const loops = m.shelf('all', { loops: true }); assert.ok(loops.items.length > 0 && loops.items.every(i => i.loop));
  const some = m.shelf('lone', { seed: 3 }).items.slice(0, 2).map(i => i.id), mine = m.shelf('all', { only: new Set(some) });
  assert.deepStrictEqual(mine.items.map(i => i.id).sort(), some.slice().sort());
  assert.strictEqual(m.shelf('all', { only: new Set() }).total, 0);
  assert.ok(m.shelf('loops', {}).total > 0, 'the old loops shelf name still works');
});

test('home address: round-trips, the trail zooms out one step at a time, old addresses still work', async () => {
  const { parse } = await imp('router.mjs'), { trail } = await imp('crumbs.mjs'), { factsHref } = await imp('views/home.mjs');
  const href = factsHref({ shelf: 'veins', type: ['place', 'time'], match: 'every', loops: true });
  const r = parse(href); assert.strictEqual(r.name, 'home'); assert.deepStrictEqual(r.query, { shelf: 'veins', type: 'place,time', match: 'every', loops: '1' });
  assert.strictEqual(factsHref({ shelf: 'all' }), '#/', 'All shelves is the default and stays out of the address');
  assert.strictEqual(factsHref({ type: ['place'], match: 'every' }), '#/?type=place', 'match only matters with two kinds');
  assert.strictEqual(parse('#/browse?shelf=veins').name, 'home'); assert.strictEqual(parse('#/browse?shelf=veins').query.shelf, 'veins');
  assert.deepStrictEqual(parse('#/wordplay/homophone').query, { wp: 'homophone' });
  assert.deepStrictEqual(trail(parse('#/')).map(x => x.label), ['Home']);
  assert.deepStrictEqual(trail(parse('#/?type=place')).map(x => x.label), ['Home', 'Places']);
});
