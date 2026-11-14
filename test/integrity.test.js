'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const M = require('../code/migrate'), I = require('../code/lib/integrity');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
function goodDb(dir) { const p = path.join(dir, 'v.db'), d = new DatabaseSync(p); M.buildFresh(d); d.close(); return p; }
function edit(p, sql) { const d = new DatabaseSync(p); d.exec(sql); d.close(); }
const ids = r => r.findings.map(x => x.id);

test('no database is setup state, not a crash', () => {
  const r = I.check({ dbPath: path.join(tmp(), 'none.db') });
  assert.equal(r.state, 'setup'); assert.equal(ids(r)[0], 'no-database');
});
test('a database built by the migrations is ok', () => {
  const r = I.check({ dbPath: goodDb(tmp()), deep: true });
  assert.equal(r.level, 'ok'); assert.deepEqual(r.findings, []);
});
test('a migration not applied is fatal and names the fix', () => {
  const p = goodDb(tmp()); edit(p, "DELETE FROM schema_migrations WHERE id='M018'");
  const r = I.check({ dbPath: p });
  assert.equal(r.level, 'fatal'); assert.ok(ids(r).includes('pending-migrations'));
  assert.match(r.findings[0].fix, /Create or update the database/);
});
test('a database newer than the code is fatal', () => {
  const p = goodDb(tmp()); edit(p, "INSERT INTO schema_migrations (id, desc, applied_at) VALUES ('M999','future','2030-01-01')");
  assert.ok(ids(I.check({ dbPath: p })).includes('database-newer-than-code'));
});
test('a missing table and a missing column are fatal', () => {
  const p = goodDb(tmp()); edit(p, 'DROP TABLE wordplay_edges; ALTER TABLE narratives DROP COLUMN approval_status');
  const r = I.check({ dbPath: p });
  assert.equal(r.level, 'fatal'); assert.ok(ids(r).includes('missing-tables')); assert.ok(ids(r).includes('missing-columns'));
  assert.match(r.findings.find(x => x.id === 'missing-tables').msg, /wordplay_edges/);
});
test('an extra table is only a warning', () => {
  const p = goodDb(tmp()); edit(p, 'CREATE TABLE stray (a INTEGER)');
  const r = I.check({ dbPath: p }); assert.equal(r.level, 'warn'); assert.deepEqual(ids(r), ['extra-structure']);
});
test('a file that is not a database is fatal', () => {
  const p = path.join(tmp(), 'bad.db'); fs.writeFileSync(p, 'this is not sqlite '.repeat(500));
  const r = I.check({ dbPath: p }); assert.equal(r.level, 'fatal'); assert.ok(ids(r).some(i => i === 'corrupt' || i === 'cannot-open'));
});
test('a missing vault folder, and notes that are not under it, warn', () => {
  const dir = tmp(), p = goodDb(dir);
  edit(p, "INSERT INTO vault_notes (rel_path, title, word_count, indexed_at) VALUES ('a/x.md','x',3,'2026-01-01')");
  assert.ok(ids(I.check({ dbPath: p, vaultRoots: [path.join(dir, 'nowhere')] })).includes('vault-missing'));
  const vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
  assert.ok(ids(I.check({ dbPath: p, vaultRoots: [vault] })).includes('notes-unreachable'));
  fs.mkdirSync(path.join(vault, 'a')); fs.writeFileSync(path.join(vault, 'a', 'x.md'), 'hi');
  assert.equal(I.check({ dbPath: p, vaultRoots: [vault] }).level, 'ok');
});
test('the check never writes: the file is byte-identical afterwards', () => {
  const p = goodDb(tmp()), before = fs.readFileSync(p); I.check({ dbPath: p, deep: true });
  assert.ok(before.equals(fs.readFileSync(p)));
});
test('admin status carries the findings and the degraded flag', () => {
  const { createAdmin } = require('../code/lib/muse_admin');
  const dir = tmp(), p = goodDb(dir); edit(p, "DELETE FROM schema_migrations WHERE id='M018'");
  const integrity = I.check({ dbPath: p }), mem = M.buildFresh(new DatabaseSync(':memory:'));
  const s = createAdmin({ home: dir, dbPath: p, db: mem, version: 'x', port: 1, integrity, degraded: true }).status();
  assert.equal(s.integrity.degraded, true); assert.equal(s.integrity.level, 'fatal'); assert.ok(s.integrity.findings[0].fix);
});
