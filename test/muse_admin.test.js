'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { DatabaseSync } = require('node:sqlite'), { createAdmin } = require('../code/lib/muse_admin'), { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks');
const { fakeModel, fakeNotes } = require('./helpers/muse_fake');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-admin-')), db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE vault_notes (id INTEGER); INSERT INTO vault_notes VALUES (1),(2),(3);
    CREATE TABLE burrs (id INTEGER PRIMARY KEY, prompt_version TEXT); INSERT INTO burrs (prompt_version) VALUES ('nug-v5'),('nug-v6'),('nug-v6');
    CREATE TABLE nuggetize_status (note_id INTEGER, prompt_version TEXT); INSERT INTO nuggetize_status VALUES (1,'nug-v6'),(2,'nug-v6');
    CREATE TABLE burr_dupes (status TEXT); INSERT INTO burr_dupes VALUES ('dup');
    CREATE TABLE wordplay_edges (kind TEXT); INSERT INTO wordplay_edges VALUES ('homophone'),('homophone'),('head-tail');
    CREATE TABLE schema_migrations (id TEXT); INSERT INTO schema_migrations VALUES ('M001'),('M002');
    CREATE TABLE api_budget (cost_usd REAL, called_at TEXT); INSERT INTO api_budget VALUES (1.25,'2026-10-27T10:00:00Z'),(0.75,'2026-10-27T11:00:00Z');
    CREATE TABLE muse_runs (run_id TEXT, kind TEXT, started_at TEXT, finished_at TEXT); INSERT INTO muse_runs VALUES ('r1','nuggetize','2026-10-27T10:00:00Z',NULL);`);
  fs.writeFileSync(path.join(dir, 'vault.db'), 'x'.repeat(100)); fs.writeFileSync(path.join(dir, 'vault.db.bak-20261022'), 'y'.repeat(50)); fs.writeFileSync(path.join(dir, 'vault.db-journal.stale-1'), 'z');
  fs.writeFileSync(path.join(dir, 'muse-marks.jsonl'), '{}\n');
  return { dir, db };
}

test('admin status: counts, database and backups, money, saved files and leftovers come from the real places', () => {
  const { dir, db } = setup(), a = createAdmin({ home: dir, dbPath: path.join(dir, 'vault.db'), db, version: 'nug-v6', port: 3005, ceiling: 10 }), s = a.status();
  assert.strictEqual(s.counts.notes, 3); assert.deepStrictEqual(JSON.parse(JSON.stringify(s.counts.byVersion)), [{ version: 'nug-v5', n: 1 }, { version: 'nug-v6', n: 2 }]); assert.strictEqual(s.counts.pending, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.counts.wordplay)), [{ kind: 'homophone', n: 2 }, { kind: 'head-tail', n: 1 }]); assert.strictEqual(s.counts.dupes[0].n, 1);
  assert.strictEqual(s.database.bytes, 100); assert.strictEqual(s.database.migrations.n, 2); assert.strictEqual(s.database.backups.length, 1); assert.strictEqual(s.database.backupBytes, 50);
  assert.strictEqual(s.money.spent, 2); assert.strictEqual(s.money.ceiling, 10); assert.strictEqual(s.money.lastRun.kind, 'nuggetize');
  assert.strictEqual(s.files.find(f => f.file === 'muse-marks.jsonl').bytes, 3); assert.strictEqual(s.files.find(f => f.file === 'muse-events.jsonl').bytes, null, 'a missing file is reported, not an error');
  assert.deepStrictEqual(s.leftovers.map(l => l.name), ['vault.db-journal.stale-1']); assert.strictEqual(s.server.port, 3005);
});

test('admin status: a database missing a table still reports everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-admin-')), db = new DatabaseSync(':memory:'), s = createAdmin({ home: dir, dbPath: path.join(dir, 'none.db'), db, version: 'nug-v6', port: 1 }).status();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.counts.byVersion)), []); assert.strictEqual(s.counts.pending, null); assert.strictEqual(s.database.bytes, undefined); assert.strictEqual(s.money.spent, 0);
});

test('admin endpoints: need the X-Muse header, report status, run the drift check, and say so when Admin is not set up', async () => {
  const { dir, db } = setup(), admin = createAdmin({ home: dir, dbPath: path.join(dir, 'vault.db'), db, version: 'nug-v6', port: 1, drift: async () => ({ problems: [{ kind: 'stale button', msg: 'x' }], warnings: [], stats: {} }) });
  const mk = extra => createServer({ model: fakeModel(), marks: K.open(path.join(dir, 'm.jsonl'), 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), ...extra });
  const call = (srv, p, method, h) => new Promise(r => srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; http.request({ port, path: p, method, headers: { Host: 'localhost:' + port, ...h } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { srv.close(); r({ code: res.statusCode, body: JSON.parse(b) }); }); }).end(); }));
  assert.strictEqual((await call(mk({ admin }), '/api/admin/status', 'GET', {})).code, 403);
  const ok = await call(mk({ admin }), '/api/admin/status', 'GET', { 'X-Muse': '1' }); assert.strictEqual(ok.code, 200); assert.strictEqual(ok.body.counts.notes, 3);
  const d = await call(mk({ admin }), '/api/admin/drift', 'POST', { 'X-Muse': '1' }); assert.strictEqual(d.body.ok, false); assert.deepStrictEqual(d.body.problems, ['stale button: x']);
  assert.strictEqual((await call(mk({}), '/api/admin/status', 'GET', { 'X-Muse': '1' })).code, 503);
});

test('admin freshness: says when the database has gained facts, wordplay or duplicate flags since Muse loaded, and stays quiet when it has not', () => {
  const { dir, db } = setup(); db.exec('ALTER TABLE burrs ADD COLUMN created_at TEXT; ALTER TABLE wordplay_edges ADD COLUMN created_at TEXT; ALTER TABLE burr_dupes ADD COLUMN created_at TEXT;');
  db.exec("UPDATE burrs SET created_at='2026-11-14T06:00:00.000Z'; UPDATE wordplay_edges SET created_at='2026-11-14 06:00:00'; UPDATE burr_dupes SET created_at='2026-11-14T06:00:00.000Z';");
  const mk = at => createAdmin({ home: dir, dbPath: path.join(dir, 'vault.db'), db, version: 'nug-v6', port: 1, loadedAt: at }).status().freshness;
  let f = mk('2026-11-14T07:00:00.000Z'); assert.strictEqual(f.stale, false, 'everything is older than the load'); assert.strictEqual(f.newFacts + f.newWordplay + f.newDuplicateFlags, 0);
  db.exec("INSERT INTO burrs (prompt_version, created_at) VALUES ('nug-v6','2026-11-14T07:30:00.000Z'); INSERT INTO wordplay_edges (kind, created_at) VALUES ('rhyme','2026-11-14 07:31:00');");
  f = mk('2026-11-14T07:00:00.000Z'); assert.strictEqual(f.stale, true); assert.strictEqual(f.newFacts, 1); assert.strictEqual(f.newWordplay, 1, 'the plain and ISO time forms are compared alike');
  assert.strictEqual(createAdmin({ home: dir, dbPath: path.join(dir, 'vault.db'), db, version: 'nug-v6', port: 1 }).status().freshness, null, 'no load time given, nothing claimed');
});
