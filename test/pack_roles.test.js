'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const Pack = require('../code/lib/pack');
const ROOT = path.join(__dirname, '..');

function scratch(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-roles-'));
  fs.mkdirSync(path.join(dir, 'packs', 'x'), { recursive: true });
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', 'general', 'pack.json'), 'utf8'));
  p.name = 'x'; delete p.lenses; delete p.vocabulary; delete p.files; p.capabilities = [];
  mutate(p);
  fs.writeFileSync(path.join(dir, 'packs', 'x', 'pack.json'), JSON.stringify(p));
  return dir;
}

test('hookRoles default from the pack hooks, quiz states its own', () => {
  const g = Pack.loadPack('general', ROOT).hookRoles;
  assert.deepStrictEqual(Array.from(g.deadEnd), ['topic']);
  assert.deepStrictEqual(Array.from(g.common), []);
  assert.deepStrictEqual(Array.from(g.surface), ['entity', 'place']);
  const q = Pack.loadPack('quiz', ROOT).hookRoles;
  assert.ok(q.deadEnd.includes('etymon') && q.surface.includes('title'));
});

test('hookRoles naming a hook the pack lacks is refused', () => {
  const dir = scratch((p) => { p.hookRoles = { common: ['etymon'] }; });
  assert.throws(() => Pack.loadPack('x', dir), /hookRoles\.common names "etymon"/);
  const dir2 = scratch((p) => { p.hookRoles = { bogus: ['entity'] }; });
  assert.throws(() => Pack.loadPack('x', dir2), /not a role/);
});

test('tag vocabulary comes from the pack; a pack without one starts empty', () => {
  const T = require('../code/lib/tagging');
  assert.ok(T.loadVocabulary().size > 400);
  assert.strictEqual(Pack.loadPack('general', ROOT).files.tagVocabulary, undefined);
  assert.strictEqual(T.loadVocabulary(null) instanceof Set, true);
});
