'use strict';
// M015: key every note by its path INSIDE the vault (rel_path) instead of the absolute path of one machine (filepath). See lib/note_path.js for why.
//
// What it does, in one transaction (migrate.js takes a backup first and turns foreign keys OFF for it, see below):
//   1. Reads every stored filepath, finds the prefix they share (VAULT_PATH when all of them sit under it, else the longest shared folder;
//      MUSE_LEGACY_PREFIX overrides), and turns each into a key. Refuses, changing nothing, if a path is outside the prefix or two paths give one key.
//   2. Builds vault_notes_new: the same columns and ids, with rel_path TEXT NOT NULL UNIQUE where filepath was. Copies every row.
//   3. Checks: row counts equal; every child table (note_tags, note_classifications, writeback_log, note_tag_proposals, ...) has exactly as many rows as before;
//      SQLite's quick_check and foreign_key_check pass.
//   4. Replaces the old table, recreates its indexes, rebuilds the full-text index, records the old prefix in vault_meta (nothing is lost: prefix + "/" + rel_path
//      is the old filepath for every row).
// Why foreign keys must be OFF: node:sqlite turns them ON, and four tables reference vault_notes with ON DELETE CASCADE. Dropping the old table with
// foreign keys ON would silently delete every note's tags, facts and approvals. PRAGMA foreign_keys cannot change inside a transaction, so migrate.js sets it
// before BEGIN (migration flag foreignKeysOff) and up() refuses to run if it is still on.
const N = require('./note_path');
const q = name => '"' + String(name).replace(/"/g, '""') + '"';

const columnsOf = db => db.prepare('PRAGMA table_info(vault_notes)').all();
function childTables(db) {
  const out = [];
  for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())
    for (const fk of db.prepare('PRAGMA foreign_key_list(' + q(t.name) + ')').all()) if (fk.table === 'vault_notes') out.push(t.name);
  return [...new Set(out)];
}

// Read-only. Says what the migration would do and whether it can: { state, notes, prefix, problems[], warnings[] }.
function plan(db, env) {
  env = env || process.env;
  const cols = columnsOf(db), has = n => cols.some(c => c.name === n);
  if (!cols.length) return { state: 'none', notes: 0, prefix: '', problems: ['There is no vault_notes table yet. Run the indexer first.'], warnings: [] };
  if (has('rel_path') && !has('filepath')) return { state: 'keyed', notes: db.prepare('SELECT COUNT(*) n FROM vault_notes').get().n, prefix: '', problems: [], warnings: [] };
  if (has('rel_path') && has('filepath')) return { state: 'mixed', notes: 0, prefix: '', problems: ['vault_notes has both filepath and rel_path: a half-finished earlier attempt. Restore the backup taken before it.'], warnings: [] };
  const rows = db.prepare('SELECT id, filepath FROM vault_notes ORDER BY id').all(), problems = [], warnings = [];
  const prefix = rows.length ? N.chooseLegacyPrefix(rows.map(r => r.filepath), env.VAULT_PATH, env.MUSE_LEGACY_PREFIX) : '';
  const keys = new Map(), outside = [], dupes = [], bad = [];
  for (const r of rows) {
    const k = N.keyFromLegacy(r.filepath, prefix);
    if (k == null) { outside.push(r.filepath); continue; }
    try { N.checkKey(k); } catch (e) { bad.push(r.filepath + ' (' + e.message + ')'); continue; }
    if (keys.has(k)) dupes.push(k + ' <- ' + keys.get(k) + ' and ' + r.filepath); else keys.set(k, r.filepath);
  }
  if (rows.length && !prefix) problems.push('The stored paths share no common folder, so no prefix can be found. Set MUSE_LEGACY_PREFIX to the folder they are under.');
  if (outside.length) problems.push(outside.length + ' stored path(s) are not under ' + prefix + '/ , for example ' + outside.slice(0, 3).join(' ; '));
  if (bad.length) problems.push(bad.length + ' path(s) cannot become a valid key, for example ' + bad.slice(0, 3).join(' ; '));
  if (dupes.length) problems.push(dupes.length + ' path(s) collapse onto one key (Unicode forms of the same name), for example ' + dupes.slice(0, 3).join(' ; '));
  const clashes = N.findCollisions([...keys.keys()]), weak = [...keys.keys()].filter(k => N.portabilityIssues(k).length);
  if (clashes.length) warnings.push(clashes.length + ' group(s) of notes differ only by letter case or Unicode form (fine here, a clash on macOS and Windows), for example ' + clashes[0].join(' | '));
  if (weak.length) warnings.push(weak.length + ' note name(s) would not work on Windows (' + N.portabilityIssues(weak[0]).join('; ') + '), for example ' + weak[0]);
  return { state: 'legacy', notes: rows.length, prefix, problems, warnings };
}

function up(db, env, log) {
  log = log || (() => {});
  const p = plan(db, env);
  if (p.state === 'keyed') { db.exec('CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'); log('Already keyed by rel_path; nothing to rewrite'); return p; }
  if (p.problems.length) throw new Error('Cannot key the notes by relative path, nothing was changed: ' + p.problems.join(' | '));
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys) throw new Error('Foreign keys are ON: dropping the old table would cascade-delete every note\'s tags and facts. migrate.js must turn them off before BEGIN.');
  for (const w of p.warnings) log('  warning: ' + w);

  const cols = columnsOf(db), others = cols.filter(c => c.name !== 'filepath'), kids = childTables(db);
  const countOf = t => db.prepare('SELECT COUNT(*) n FROM ' + q(t)).get().n, before = Object.fromEntries(kids.map(t => [t, countOf(t)]));
  const defs = [];
  for (const c of others) {
    defs.push(q(c.name) + ' ' + (c.type || '') + (c.pk ? ' PRIMARY KEY' : '') + (c.notnull && !c.pk ? ' NOT NULL' : '') + (c.dflt_value != null ? ' DEFAULT ' + c.dflt_value : ''));
    if (c.name === 'id') defs.push('"rel_path" TEXT NOT NULL UNIQUE');
  }
  if (!others.some(c => c.name === 'id')) throw new Error('vault_notes has no id column');
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='vault_notes' AND sql IS NOT NULL").all();

  db.exec('DROP TABLE IF EXISTS vault_notes_new'); db.exec('CREATE TABLE vault_notes_new (' + defs.join(', ') + ')');
  db.exec('CREATE TEMP TABLE _path_map (id INTEGER PRIMARY KEY, rel TEXT NOT NULL)');
  const put = db.prepare('INSERT INTO _path_map (id, rel) VALUES (?, ?)');
  for (const r of db.prepare('SELECT id, filepath FROM vault_notes').all()) put.run(r.id, N.keyFromLegacy(r.filepath, p.prefix));
  const names = others.map(c => q(c.name));
  db.exec('INSERT INTO vault_notes_new (' + ['"id"', '"rel_path"', ...names.filter(n => n !== '"id"')].join(', ') + ') SELECT ' +
          ['n."id"', 'm.rel', ...names.filter(n => n !== '"id"').map(n => 'n.' + n)].join(', ') + ' FROM vault_notes n JOIN _path_map m ON m.id = n.id');
  const copied = db.prepare('SELECT COUNT(*) n FROM vault_notes_new').get().n;
  if (copied !== p.notes) throw new Error('Copied ' + copied + ' of ' + p.notes + ' notes; rolled back.');

  db.exec('DROP TABLE vault_notes'); db.exec('ALTER TABLE vault_notes_new RENAME TO vault_notes'); db.exec('DROP TABLE _path_map');
  for (const ix of indexes) db.exec(ix.sql);
  try { db.exec("INSERT INTO vault_fts(vault_fts) VALUES('rebuild')"); } catch (e) { log('  note: full-text index not rebuilt (' + e.message + ')'); }

  for (const t of kids) { const now = countOf(t); if (now !== before[t]) throw new Error('Table ' + t + ' went from ' + before[t] + ' to ' + now + ' rows; rolled back.'); }
  const qc = db.prepare('PRAGMA quick_check').all().map(r => Object.values(r)[0]);
  if (qc.length !== 1 || qc[0] !== 'ok') throw new Error('quick_check failed: ' + qc.slice(0, 3).join('; '));
  const fk = db.prepare('PRAGMA foreign_key_check').all(); if (fk.length) throw new Error('foreign_key_check found ' + fk.length + ' broken reference(s); rolled back.');
  if (db.prepare("SELECT COUNT(*) n FROM vault_notes WHERE rel_path IS NULL OR rel_path = ''").get().n) throw new Error('A note has no rel_path; rolled back.');

  db.exec('CREATE TABLE IF NOT EXISTS vault_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const meta = db.prepare('INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?, ?)');
  meta.run('legacy_path_prefix', p.prefix); meta.run('rel_path_migrated_at', new Date().toISOString());
  log('  keyed ' + p.notes + ' notes by rel_path (old prefix ' + p.prefix + '); child tables unchanged: ' + (kids.map(t => t + ' ' + before[t]).join(', ') || 'none'));
  return p;
}

module.exports = { plan, up, childTables };
