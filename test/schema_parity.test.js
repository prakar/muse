'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { structure } = require('./helpers/schema_structure');
const ROOT = path.join(__dirname, '..'), real = require('./helpers/real_schema.json');
const migrate = (db, ...a) => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'code', 'migrate.js'), ...a], { env: { ...process.env, QUARRY_DB: db, QUARRY_HOME: path.dirname(db) }, encoding: 'utf8' });

test('a new install (no database) is created by migrate --run with the same structure as the real database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parity-')), db = path.join(dir, 'vault.db');
  const r = migrate(db, '--run'); assert.strictEqual(r.status, 0, r.stderr + r.stdout.slice(-400));
  const d = new DatabaseSync(db, { readOnly: true }), got = structure(d); d.close();
  assert.deepStrictEqual(Object.keys(got.tables).sort(), Object.keys(real.tables).sort(), 'the same tables');
  // Column ORDER is history (a column added later sits last), and nothing reads columns by position, so compare the set. Everything else must match exactly.
  const norm = t => ({ ...t, columns: [...t.columns].sort() });
  for (const t of Object.keys(real.tables)) assert.deepStrictEqual(norm(got.tables[t]), norm(real.tables[t]), 'table ' + t);
  assert.deepStrictEqual(got.triggers, real.triggers, 'triggers');
  assert.deepStrictEqual(got.virtual, real.virtual, 'virtual tables');
});

test('creating is idempotent: a second run changes nothing and applies nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parity-')), db = path.join(dir, 'vault.db');
  migrate(db, '--run'); const a = new DatabaseSync(db, { readOnly: true }), before = JSON.stringify(structure(a)); a.close();
  const r = migrate(db, '--run'); assert.strictEqual(r.status, 0); assert.match(r.stdout, /Applied: 0/);
  const b = new DatabaseSync(db, { readOnly: true }); assert.strictEqual(JSON.stringify(structure(b)), before); b.close();
});

test('the check on a missing database creates nothing and says what a real run would do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parity-')), db = path.join(dir, 'vault.db');
  const r = migrate(db, '--status'); assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /No database yet/); assert.match(r.stdout, /Pending: 18 \/ 18/); assert.strictEqual(fs.existsSync(db), false, 'no file was made');
});

test('the indexer refuses to run on a missing or unmigrated database, with one clear message and no file made', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parity-')), db = path.join(dir, 'vault.db'), vault = path.join(dir, 'v'); fs.mkdirSync(vault); fs.writeFileSync(path.join(vault, 'a.md'), 'hello there friend');
  const idx = () => spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'code', 'indexer.js'), '--diff'], { env: { ...process.env, QUARRY_DB: db, QUARRY_HOME: dir, VAULT_PATH: vault }, encoding: 'utf8' });
  let r = idx(); assert.strictEqual(r.status, 3); assert.match(r.stdout + r.stderr, /No database yet/); assert.strictEqual(fs.existsSync(db), false);
  const raw = new DatabaseSync(db); require('../code/lib/base_schema').initSchema(raw); raw.close();   // base tables but no migrations
  r = idx(); assert.strictEqual(r.status, 3); assert.match(r.stdout + r.stderr, /not been migrated/);
});

test('"Back up first" with no database says there is nothing to back up instead of failing', () => {
  const I = require('../code/lib/ops_internal'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-parity-')); let said = '';
  assert.strictEqual(I.backup({ home: dir, dbPath: path.join(dir, 'vault.db'), reason: 'before-index', log: m => { said = m; } }), null);
  assert.match(said, /nothing to back up/);
  assert.throws(() => I.candidates({ dbPath: path.join(dir, 'vault.db'), args: ['--all'], log() {} }), /No database yet/);
});

test('Muse can build an empty in-memory database quietly (setup mode), with the same structure as the real one', () => {
  const { buildFresh, MIGRATIONS } = require('../code/migrate.js'), mem = new DatabaseSync(':memory:'), out = [], keep = console.log;
  console.log = (...a) => out.push(a.join(' ')); try { buildFresh(mem); } finally { console.log = keep; }
  assert.deepStrictEqual(out, [], 'no output while Muse starts');
  assert.strictEqual(mem.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n, MIGRATIONS.length);
  const got = structure(mem), norm = t => ({ ...t, columns: [...t.columns].sort() });
  for (const t of Object.keys(real.tables)) assert.deepStrictEqual(norm(got.tables[t]), norm(real.tables[t]), 'table ' + t);
});
