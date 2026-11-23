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

test('ensureConfig writes an explicit muse.yaml once, and leaves an existing one alone', () => {
  const fsx = require('fs'), osx = require('os');
  const dir = fsx.mkdtempSync(path.join(osx.tmpdir(), 'muse-cfg-'));
  fsx.cpSync(path.join(ROOT, 'packs'), path.join(dir, 'packs'), { recursive: true });
  fsx.cpSync(path.join(ROOT, 'code', 'data'), path.join(dir, 'code', 'data'), { recursive: true });
  const saved = { p: process.env.MUSE_PACK, c: process.env.MUSE_CONFIG }; delete process.env.MUSE_PACK; delete process.env.MUSE_CONFIG;
  try {
    const a = Pack.ensureConfig({ root: dir });
    assert.ok(a.written && /choosing the "quiz" profile/.test(a.note));
    assert.match(fsx.readFileSync(path.join(dir, 'muse.yaml'), 'utf8'), /^pack: quiz$/m);
    assert.strictEqual(Pack.ensureConfig({ root: dir }).written, false);
  } finally { if (saved.p) process.env.MUSE_PACK = saved.p; if (saved.c) process.env.MUSE_CONFIG = saved.c; }
});

test('the registry builder finds its notes from the environment, then muse.yaml, never from a personal default', () => {
  const { resolveNotes } = require('../packs/quiz/tools/heuristics_build');
  assert.strictEqual(resolveNotes({ QUARRY_VAULT_NOTES: '/a' }, { notes_dir: '/b' }), '/a');
  assert.strictEqual(resolveNotes({}, { notes_dir: '/b' }), '/b');
  assert.strictEqual(resolveNotes({ HOME: '/h' }, { notes_dir: '~/n' }), '/h/n');
  assert.strictEqual(resolveNotes({}, {}), '');
});
