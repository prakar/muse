#!/usr/bin/env node
'use strict';
// Repair vault_notes.created where it is not a clean date.   node --no-warnings code/created_repair.js [--apply]
// Dry run by default: lists each row whose stored value differs from what the current note says, after normalising (see lib/created_date.js).
// --apply backs vault.db up first (vault.db.bak-<time>-pre-created-repair, SQLite's backup API), then updates only those rows, in one transaction.
// Reads each note from the vault at MUSE_VAULT_ROOT (or VAULT_PATH): the note's key (rel_path, the path inside the vault) is joined to that folder.
// Why it exists: the indexer used to store `created` verbatim, so template leftovers ("We0-47-yyyy") and spelled-out dates reached the database.
// The indexer now normalises; this fixes the rows already there without re-indexing the whole vault.
const fs = require('fs'), path = require('path');
const { DatabaseSync, backup } = require('node:sqlite');
const { openDatabase } = require('./lib/db');
const { normalizeCreated } = require('./lib/created_date');
const Paths = require('./lib/note_path');

const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const ROOT = process.env.MUSE_VAULT_ROOT || process.env.VAULT_PATH || '';
const APPLY = process.argv.includes('--apply');

function currentCreated(file) {
  const t = fs.readFileSync(file, 'utf8'), fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t), c = fm && /^created:[ \t]*(.*)$/m.exec(fm[1]);
  if (c) return normalizeCreated(c[1]);
  const m = t.match(/_Created at ([^._]+)\._/); return m ? normalizeCreated(m[1]) : null;
}
async function main() {
  if (!ROOT) { console.error('Set MUSE_VAULT_ROOT (or VAULT_PATH) to the knowledge vault folder.'); process.exit(2); }
  const db = openDatabase(DB), rows = db.prepare('SELECT id, rel_path, created FROM vault_notes WHERE created IS NOT NULL').all(), plan = [];
  let unreadable = 0;
  for (const r of rows) {
    if (normalizeCreated(r.created) === r.created) continue;                      // already clean
    const rel = r.rel_path, file = Paths.toAbs(rel, ROOT);
    let next; try { next = currentCreated(file); } catch (e) { unreadable++; console.log('cannot read', rel); continue; }
    plan.push({ id: r.id, rel, from: r.created, to: next });
  }
  for (const p of plan) console.log(String(p.id).padStart(5), JSON.stringify(p.from), '->', JSON.stringify(p.to), ' ', p.rel);
  console.log(plan.length + ' row(s) to change; ' + unreadable + ' unreadable. ' + (APPLY ? '' : 'Dry run: nothing written. Add --apply.'));
  if (!APPLY || !plan.length) return;
  const bak = DB + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-pre-created-repair';   // vault.db.bak-* is git-ignored, like the other backups
  const src = new DatabaseSync(DB, { readOnly: true }); await backup(src, bak); src.close(); console.log('backup: ' + bak);
  db.exec('BEGIN'); const up = db.prepare('UPDATE vault_notes SET created = ? WHERE id = ?');
  try { for (const p of plan) up.run(p.to, p.id); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  console.log('updated ' + plan.length + ' row(s).');
}
main().catch(e => { console.error('failed: ' + e.message + ' (nothing was changed). Run it on a disk that supports SQLite writes: a network or sandboxed mount may not.'); process.exit(1); });
