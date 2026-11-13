#!/usr/bin/env node
'use strict';
// Re-point the note paths stored in vault.db at the vault copy this machine indexes.   node --no-warnings code/rebase_note_paths.js [--apply]
// The indexer matches notes by their full stored path. A database that came from another machine (the Mac stores /Users/<you>/.../quarry-data/knowledge/...)
// would look entirely new, and every stored note entirely missing, on this one. This rewrites the common prefix once. Nothing else in the row changes.
// Dry run by default. --apply backs vault.db up first (vault.db.bak-<time>-pre-path-rebase, SQLite's backup API), then updates in one transaction.
// SUPERSEDED by migration M015 (notes keyed by rel_path, see lib/note_path.js): once a database has been migrated this script has nothing to do and says so. Delete it after M015 has run everywhere.
// New prefix: VAULT_PATH. Old prefix: everything before "/knowledge/" in the first stored path, plus "/knowledge" (override: --from <prefix>).
const path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');
const { openDatabase } = require('./lib/db');

const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const APPLY = process.argv.includes('--apply'), fi = process.argv.indexOf('--from');

// Pure, for the test: decide the rewrite from a sample stored path and the wanted prefix. Returns { from, to } or null when already right.
function planRebase(samplePath, to, from) {
  const marker = '/knowledge/', i = (samplePath || '').indexOf(marker);
  const old = from || (i < 0 ? '' : samplePath.slice(0, i + marker.length - 1));
  if (!old) throw new Error('Cannot find "' + marker + '" in the stored path: ' + samplePath + ' (pass --from <prefix>)');
  const dest = path.resolve(to).replace(/\/+$/, '');
  return old === dest ? null : { from: old.replace(/\/+$/, ''), to: dest };
}
async function main() {
  if (!process.env.VAULT_PATH) { console.error('Set VAULT_PATH to the vault copy this machine indexes.'); process.exit(2); }
  const db = openDatabase(DB);
  if (!db.prepare('PRAGMA table_info(vault_notes)').all().some(c => c.name === 'filepath')) { console.log('Notes are already keyed by rel_path (M015); nothing to do.'); return; }
  const sample = db.prepare("SELECT filepath FROM vault_notes WHERE filepath LIKE '%/knowledge/%' ORDER BY id LIMIT 1").get();
  if (!sample) { console.log('No stored path contains /knowledge/; nothing to do (use --from <prefix> to force).'); if (fi < 0) return; }
  const p = planRebase(sample ? sample.filepath : '', process.env.VAULT_PATH, fi > 0 ? process.argv[fi + 1] : '');
  if (!p) { console.log('Paths already point at ' + process.env.VAULT_PATH + '; nothing to do.'); return; }
  const total = db.prepare('SELECT COUNT(*) n FROM vault_notes').get().n;
  const hit = db.prepare('SELECT COUNT(*) n FROM vault_notes WHERE substr(filepath, 1, ?) = ?').get(p.from.length + 1, p.from + '/').n;
  console.log('from: ' + p.from + '\nto:   ' + p.to + '\n' + hit + ' of ' + total + ' note paths start with the old prefix.' + (hit < total ? ' The other ' + (total - hit) + ' stay as they are.' : ''));
  if (!APPLY) { console.log('Dry run: nothing written. Add --apply.'); return; }
  const bak = DB + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-pre-path-rebase';
  const src = new DatabaseSync(DB, { readOnly: true }); await backup(src, bak); src.close(); console.log('backup: ' + bak);
  db.exec('BEGIN');
  try {
    const r = db.prepare('UPDATE vault_notes SET filepath = ? || substr(filepath, ?) WHERE substr(filepath, 1, ?) = ?').run(p.to, p.from.length + 1, p.from.length + 1, p.from + '/');
    db.exec('COMMIT'); console.log('rewrote ' + r.changes + ' path(s).');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
module.exports = { planRebase };
if (require.main === module) main().catch(e => { console.error('failed: ' + e.message + ' (nothing was changed). Run it on a disk that supports SQLite writes.'); process.exit(1); });
