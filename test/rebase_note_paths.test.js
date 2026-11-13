'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { planRebase } = require('../code/rebase_note_paths');

test('planRebase: finds the old prefix from a stored path, and says nothing when it already matches', () => {
  const mac = '/Users/me/Developer/prototypes/quarry-data/knowledge/2013/a.md';
  assert.deepStrictEqual(planRebase(mac, '/home/me/dev/quarry-data/knowledge/'), { from: '/Users/me/Developer/prototypes/quarry-data/knowledge', to: '/home/me/dev/quarry-data/knowledge' });
  assert.strictEqual(planRebase('/home/me/dev/quarry-data/knowledge/x.md', '/home/me/dev/quarry-data/knowledge'), null);
  assert.deepStrictEqual(planRebase('/odd/place/x.md', '/new/knowledge', '/odd/place'), { from: '/odd/place', to: '/new/knowledge' });
  assert.throws(() => planRebase('/no/marker/x.md', '/new/knowledge'), /Cannot find/);
});

test('rebase_note_paths: dry run writes nothing; --apply backs up, rewrites the prefix only, and keeps unrelated rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-rebase-')), db = path.join(dir, 'vault.db'), d = new DatabaseSync(db);
  d.exec('CREATE TABLE vault_notes(id INTEGER PRIMARY KEY, filepath TEXT UNIQUE NOT NULL, title TEXT)');
  const ins = d.prepare('INSERT INTO vault_notes(filepath, title) VALUES (?, ?)'), old = '/Users/me/quarry-data/knowledge';
  ins.run(old + '/+Home.md', 'Home'); ins.run(old + '/2013/it\'s a note.md', 'N'); ins.run('/elsewhere/other.md', 'Other'); d.close();
  const run = args => spawnSync(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'code', 'rebase_note_paths.js'), ...args], { encoding: 'utf8', env: { ...process.env, QUARRY_DB: db, QUARRY_HOME: dir, VAULT_PATH: '/home/me/dev/quarry-data/knowledge' } });
  const paths = () => { const x = new DatabaseSync(db, { readOnly: true }), r = x.prepare('SELECT filepath FROM vault_notes ORDER BY id').all().map(o => o.filepath); x.close(); return r; };
  const dry = run([]); assert.strictEqual(dry.status, 0, dry.stderr); assert.match(dry.stdout, /2 of 3 note paths/); assert.match(dry.stdout, /Dry run/); assert.strictEqual(paths()[0], old + '/+Home.md');
  const real = run(['--apply']); assert.strictEqual(real.status, 0, real.stderr); assert.match(real.stdout, /rewrote 2 path/);
  assert.deepStrictEqual(paths(), ['/home/me/dev/quarry-data/knowledge/+Home.md', '/home/me/dev/quarry-data/knowledge/2013/it\'s a note.md', '/elsewhere/other.md']);
  assert.ok(fs.readdirSync(dir).some(f => /^vault\.db\.bak-.*-pre-path-rebase$/.test(f)), 'a backup was made');
  const again = run(['--apply']); assert.strictEqual(again.status, 0, again.stderr); assert.match(again.stdout, /already point/i, again.stdout + again.stderr);
});
