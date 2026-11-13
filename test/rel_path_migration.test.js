'use strict';
// M015: notes keyed by rel_path. The fixture is the REAL schema (test/helpers/legacy_schema.sql, dumped from vault.db), so the cascades, indexes and the full-text table are the real ones.
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const R = require('../code/lib/rel_path_migration');
const SCHEMA = fs.readFileSync(path.join(__dirname, 'helpers', 'legacy_schema.sql'), 'utf8'), MAC = '/Users/me/Developer/prototypes/quarry-data/knowledge';
const MIGRATE = path.join(__dirname, '..', 'code', 'migrate.js');

function legacyDb(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-m015-')), file = path.join(dir, 'vault.db'), db = new DatabaseSync(file);   // foreign keys are ON, as in the real tools
  db.exec(SCHEMA);
  const ins = db.prepare("INSERT INTO vault_notes (filepath, title, word_count, first_paragraph, indexed_at, quarry_exclude, tag_source) VALUES (?, ?, ?, ?, '2026-01-01', ?, 't')");
  files.forEach((f, i) => ins.run(f, 'Note ' + i, 100 + i, 'first paragraph of ' + i, i === 1 ? 1 : 0));
  const ids = db.prepare('SELECT id FROM vault_notes ORDER BY id').all().map(r => r.id);
  const cols = t => db.prepare('PRAGMA table_info(' + t + ')').all().filter(c => c.notnull && !c.dflt_value && !c.pk).map(c => c.name);
  for (const id of ids) {   // a row in every child table: these are what a careless DROP TABLE would cascade away
    db.prepare("INSERT INTO note_tags (note_id, tag_full, tag_root) VALUES (?, 'a/b', 'a')").run(id);
    for (const t of ['note_classifications', 'writeback_log', 'note_tag_proposals']) {
      const need = cols(t).filter(c => c !== 'note_id'), vals = need.map(c => /_at$|date|time/.test(c) ? '2026-01-01' : /^(n|count|score|conf)/.test(c) ? 1 : 'x');
      db.prepare('INSERT INTO ' + t + ' (note_id' + need.map(c => ', ' + c).join('') + ') VALUES (?' + need.map(() => ', ?').join('') + ')').run(id, ...vals);
    }
  }
  db.exec("INSERT INTO vault_fts(vault_fts) VALUES('rebuild')");
  return { db, file, dir, ids };
}
const count = (db, t) => db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
const run = db => { db.exec('PRAGMA foreign_keys = OFF'); db.exec('BEGIN'); try { const r = R.up(db, {}); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON'); } };

test('M015 keys every note by rel_path, keeps ids, columns, tags and facts, and recreates indexes and full-text search', () => {
  const files = [MAC + '/+Home.md', MAC + '/2013/it\'s a note.md', MAC + '/2026/Caf\u00e9.md'], { db, ids } = legacyDb(files);
  const before = Object.fromEntries(['note_tags', 'note_classifications', 'writeback_log', 'note_tag_proposals'].map(t => [t, count(db, t)]));
  assert.ok(Object.values(before).every(n => n === 3), JSON.stringify(before));
  const p = R.plan(db, {}); assert.strictEqual(p.state, 'legacy'); assert.strictEqual(p.prefix, MAC); assert.deepStrictEqual(p.problems, []);
  run(db);
  const cols = db.prepare('PRAGMA table_info(vault_notes)').all().map(c => c.name);
  assert.ok(cols.includes('rel_path') && !cols.includes('filepath'), cols.join());
  for (const c of ['title', 'created', 'word_count', 'first_paragraph', 'quarry_exclude', 'tag_source', 'indexed_at', 'retagged_at']) assert.ok(cols.includes(c), c);
  assert.deepStrictEqual(db.prepare('SELECT id, rel_path, word_count, quarry_exclude, tag_source FROM vault_notes ORDER BY id').all().map(r => [r.id, r.rel_path, r.word_count, r.quarry_exclude, r.tag_source]),
    [[ids[0], '+Home.md', 100, 0, 't'], [ids[1], "2013/it's a note.md", 101, 1, 't'], [ids[2], '2026/Caf\u00e9.md', 102, 0, 't']]);
  for (const [t, n] of Object.entries(before)) assert.strictEqual(count(db, t), n, t + ' must keep every row');
  assert.strictEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const ix = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vault_notes'").all().map(r => r.name);
  for (const n of ['idx_notes_content_type', 'idx_notes_origin', 'idx_notes_has_tags', 'idx_notes_folder', 'idx_notes_word_count']) assert.ok(ix.includes(n), n);
  assert.strictEqual(db.prepare("SELECT COUNT(*) n FROM vault_fts WHERE vault_fts MATCH 'paragraph'").get().n, 3, 'full-text search still finds the notes');
  assert.throws(() => db.prepare("INSERT INTO vault_notes (rel_path, indexed_at) VALUES ('+Home.md', 'x')").run(), /UNIQUE/);
  assert.strictEqual(db.prepare("SELECT value FROM vault_meta WHERE key='legacy_path_prefix'").get().value, MAC);
  for (const r of db.prepare('SELECT id, rel_path FROM vault_notes').all()) assert.ok(files.includes(MAC + '/' + r.rel_path), 'prefix + key is the old path');
  assert.strictEqual(R.plan(db, {}).state, 'keyed'); assert.strictEqual(R.up(db, {}).state, 'keyed', 'a second run does nothing');
});

test('M015 refuses to run with foreign keys on (that would cascade-delete tags and facts), and a refusal changes nothing', () => {
  const { db } = legacyDb([MAC + '/a.md', MAC + '/b/c.md']);
  assert.throws(() => R.up(db, {}), /Foreign keys are ON/);
  assert.ok(db.prepare('PRAGMA table_info(vault_notes)').all().some(c => c.name === 'filepath')); assert.strictEqual(count(db, 'note_tags'), 2);
});

test('M015 refuses, changing nothing, when stored paths do not fit one prefix or collapse onto one key', () => {
  const a = legacyDb([MAC + '/a.md', '/elsewhere/b.md']); a.db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => R.up(a.db, { MUSE_LEGACY_PREFIX: MAC }), /not under/); assert.ok(a.db.prepare('PRAGMA table_info(vault_notes)').all().some(c => c.name === 'filepath'));
  const b = legacyDb([MAC + '/Caf\u00e9.md', MAC + '/Cafe\u0301.md']); b.db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => R.up(b.db, {}), /collapse onto one key/); assert.strictEqual(count(b.db, 'vault_notes'), 2);
});

test('M015 plan: reports Windows-hostile names and case clashes as warnings, and understands a Windows database', () => {
  const m = legacyDb([MAC + '/Ok.md', MAC + '/2026/What? Why.md', MAC + '/x/Note.md', MAC + '/x/note.md']), pl = R.plan(m.db, {});
  assert.deepStrictEqual(pl.problems, []); assert.ok(pl.warnings.some(w => /would not work on Windows/.test(w)) && pl.warnings.some(w => /letter case/.test(w)), pl.warnings.join(' | '));
  const w = legacyDb(['C:\\Users\\me\\kn\\a.md', 'C:\\Users\\me\\kn\\2026\\b.md']), pw = R.plan(w.db, {});
  assert.strictEqual(pw.prefix, 'C:/Users/me/kn'); assert.deepStrictEqual(pw.problems, []); w.db.exec('PRAGMA foreign_keys = OFF'); w.db.exec('BEGIN'); R.up(w.db, {}); w.db.exec('COMMIT');
  assert.deepStrictEqual(w.db.prepare('SELECT rel_path FROM vault_notes ORDER BY id').all().map(r => r.rel_path), ['a.md', '2026/b.md']);
});

test('migrate.js --run: backs up first, applies M015 with foreign keys handled, and the --status plan shows before and after', () => {
  const { db, file, dir } = legacyDb([MAC + '/+Home.md', MAC + '/2026/a.md']);
  for (let i = 1; i <= 14; i++) db.prepare("INSERT INTO schema_migrations (id, desc, applied_at) VALUES (?, 'fixture', '2026-01-01')").run('M' + String(i).padStart(3, '0'));
  db.close();
  const go = args => spawnSync(process.execPath, ['--no-warnings', MIGRATE, ...args], { encoding: 'utf8', env: { ...process.env, QUARRY_DB: file, QUARRY_HOME: dir, VAULT_PATH: '' } });
  const st = go(['--status']); assert.strictEqual(st.status, 0, st.stderr); assert.match(st.stdout, /M015 plan: 2 notes, shared prefix /);
  const r = go(['--run']); assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Applied M015 OK/);
  assert.ok(fs.readdirSync(dir).some(f => /^vault\.db\.bak-.*-pre-M015$/.test(f)), 'a backup copy was made first');
  const after = new DatabaseSync(file, { readOnly: true }); assert.deepStrictEqual(after.prepare('SELECT rel_path FROM vault_notes ORDER BY id').all().map(x => x.rel_path), ['+Home.md', '2026/a.md']);
  assert.strictEqual(after.prepare('SELECT COUNT(*) n FROM note_tags').get().n, 2); after.close();
  const again = go(['--run']); assert.strictEqual(again.status, 0, again.stderr); assert.match(again.stdout, /Skip M015/);
});
