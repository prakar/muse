'use strict';
// The bug this guards against: the database stored absolute paths, so moving it (or the vault) to another folder or machine made every note look new and every stored note look deleted.
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const INDEXER = path.join(__dirname, '..', 'code', 'indexer.js'), MIGRATE = path.join(__dirname, '..', 'code', 'migrate.js');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-keys-')), vault = path.join(base, 'machine-a', 'knowledge'), home = path.join(base, 'home');
  for (const d of ['2013', '2026/sub']) fs.mkdirSync(path.join(vault, d), { recursive: true }); fs.mkdirSync(home);
  const notes = { '+Home.md': '# Home\nroot note', '2013/Old note.md': '---\ntitle: Old\n---\nbody one two three', "2026/it's Café.md": '# Cafe\nunicode name', '2026/sub/Deep.md': '# Deep\ndeep note' };
  for (const [k, v] of Object.entries(notes)) fs.writeFileSync(path.join(vault, k), v);
  return { base, vault, home, keys: Object.keys(notes) };
}
const idx = (c, args, vaultPath) => spawnSync(process.execPath, ['--no-warnings', INDEXER, ...args], { encoding: 'utf8', env: { ...process.env, VAULT_PATH: vaultPath || c.vault, QUARRY_HOME: c.home, QUARRY_DB: path.join(c.home, 'vault.db') } });
const migrate = c => { const r = spawnSync(process.execPath, ['--no-warnings', MIGRATE, '--run'], { encoding: 'utf8', env: { ...process.env, QUARRY_HOME: c.home, QUARRY_DB: path.join(c.home, 'vault.db'), VAULT_PATH: c.vault } }); assert.strictEqual(r.status, 0, r.stdout + r.stderr); return r.stdout; };
const rows = c => { const d = new DatabaseSync(path.join(c.home, 'vault.db'), { readOnly: true }), r = d.prepare('SELECT rel_path, folder_hint, title FROM vault_notes ORDER BY rel_path').all(); d.close(); return r; };

test('the indexer stores the path inside the vault, with forward slashes and NFC, and the folder hint ignores the machine\'s own folders', () => {
  const c = setup(), r = idx(c, ['--full']); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(rows(c).map(x => x.rel_path), [...c.keys].sort());
  const by = Object.fromEntries(rows(c).map(x => [x.rel_path, x])); assert.strictEqual(by['2013/Old note.md'].folder_hint, '2013'); assert.strictEqual(by['+Home.md'].folder_hint, 'unknown');
  assert.strictEqual(by["2026/it's Café.md"].title, 'Cafe');
});

test('moving the vault to another folder or machine changes nothing: no note looks new, none looks deleted', () => {
  const c = setup(); idx(c, ['--full']); assert.match(migrate(c), /Skip M015|Applied M015/, 'a database made by the new indexer passes through M015');
  const other = path.join(c.base, 'machine-b', 'home', 'quarry-data', 'knowledge'); fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.cpSync(c.vault, other, { recursive: true, preserveTimestamps: true });
  const r = idx(c, ['--diff'], other); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /"after":0/, 'no file is re-indexed'); assert.match(r.stdout, /No orphaned notes found/); assert.deepStrictEqual(rows(c).map(x => x.rel_path), [...c.keys].sort());
  fs.writeFileSync(path.join(other, '2026', 'New one.md'), '# New\nadded on machine b'); fs.rmSync(path.join(other, '2013', 'Old note.md'));
  const r2 = idx(c, ['--diff'], other); assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepStrictEqual(rows(c).map(x => x.rel_path), [...c.keys.filter(k => k !== '2013/Old note.md'), '2026/New one.md'].sort(), 'one added, one removed, nothing else');
});

test('a path outside the vault is refused with a clear message, and a dry run shows rel_path', () => {
  const c = setup(), stray = path.join(c.base, 'stray.md'); fs.writeFileSync(stray, '# x');
  const r = idx(c, ['--file', stray]); assert.match(r.stdout + r.stderr, /Cannot key file/); assert.ok(!fs.existsSync(path.join(c.home, 'vault.db')) || rows(c).length === 0);
  const d = idx(c, ['--dry-run']); assert.strictEqual(d.status, 0, d.stderr); assert.match(d.stdout, /"rel_path": "2013\/Old note\.md"/); assert.doesNotMatch(d.stdout, /"filepath"/);
});

test('portability report: case-only twins and Windows-hostile names are warned about once, not refused', () => {
  const c = setup(); fs.writeFileSync(path.join(c.vault, '2026', 'Twin.md'), '# a'); fs.writeFileSync(path.join(c.vault, '2026', 'twin.md'), '# b'); fs.writeFileSync(path.join(c.vault, '2026', 'Why? Because.md'), '# c');
  const r = idx(c, ['--full']); assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /differ only by letter case or Unicode form/); assert.match(r.stdout, /would not work on Windows/); assert.strictEqual(rows(c).filter(x => /twin/i.test(x.rel_path)).length, 2);
});

test('a database from before M015 is refused by the indexer with the way out, untouched', () => {
  const c = setup(), db = new DatabaseSync(path.join(c.home, 'vault.db'));
  db.exec('CREATE TABLE vault_notes (id INTEGER PRIMARY KEY, filepath TEXT UNIQUE NOT NULL, indexed_at TEXT NOT NULL)'); db.exec("INSERT INTO vault_notes (filepath, indexed_at) VALUES ('/x/knowledge/a.md', 't')"); db.close();
  const r = idx(c, ['--diff']); assert.strictEqual(r.status, 3, r.stdout + r.stderr); assert.match(r.stdout + r.stderr, /migrate\.js --run/);
  const after = new DatabaseSync(path.join(c.home, 'vault.db'), { readOnly: true }); assert.strictEqual(after.prepare('SELECT COUNT(*) n FROM vault_notes').get().n, 1); after.close();
});
