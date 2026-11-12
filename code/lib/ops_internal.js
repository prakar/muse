'use strict';
// The small tasks that have no script of their own: status, pending count, backup, prune, restore, clean. Each prints plain lines (they run as job steps, so the
// job log shows them) and returns normally or throws. Dependencies are passed in, so tests use a temp folder.
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACKUP_RE = /^vault\.db\.bak-[\w.-]+$/;
const LEFTOVER_RE = /(-journal|\.journal)(\.|$)|\.interrupted-|\.stale-/;
const stamp = (d = new Date()) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const mb = b => (b / 1048576).toFixed(1) + ' MB';
const names = (home, re) => { let l = []; try { l = fs.readdirSync(home); } catch (e) { /* unreadable */ } return l.filter(n => re.test(n)); };
const size = f => { try { return fs.statSync(f).size; } catch (e) { return 0; } };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };

function openRead(dbPath) { return new DatabaseSync(dbPath, { readOnly: true }); }

// Notes the current prompt version has not processed yet: the number a person confirms before any paid run.
function pendingNotes(dbPath, version) {
  const db = openRead(dbPath);
  try {
    const notes = db.prepare('SELECT COUNT(*) AS n FROM vault_notes').get().n;
    const done = db.prepare('SELECT COUNT(DISTINCT note_id) AS n FROM nuggetize_status WHERE prompt_version = ?').get(version).n;
    return Math.max(0, notes - done);
  } finally { db.close(); }
}

function listBackups(home) {
  return names(home, BACKUP_RE).map(n => ({ name: n, bytes: size(path.join(home, n)), at: mtime(path.join(home, n)) })).sort((a, b) => b.at - a.at);
}

// A consistent copy, safe even if something is reading the database. The reason becomes part of the name.
function backup({ home, dbPath, reason = 'manual', log = console.log, now = new Date() }) {
  const why = String(reason || 'manual').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'manual';
  const dest = path.join(home, `vault.db.bak-${stamp(now)}-${why}`);
  if (fs.existsSync(dest)) throw new Error('A backup with that name already exists: ' + path.basename(dest));
  const db = openRead(dbPath);
  try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
  log(`Backed up ${path.basename(dbPath)} to ${path.basename(dest)} (${mb(size(dest))})`);
  return path.basename(dest);
}

// Keep the newest N; with go, delete the rest. Returns the names that would go (or went).
function prune({ home, keep = 5, go = false, log = console.log }) {
  const all = listBackups(home), doomed = all.slice(Math.max(0, keep));
  log(`${all.length} backup(s); keeping the newest ${keep}; ${doomed.length} ${go ? 'deleted' : 'would be deleted'}${doomed.length ? ':' : '.'}`);
  doomed.forEach(b => { log('  ' + b.name + '  ' + mb(b.bytes)); if (go) fs.unlinkSync(path.join(home, b.name)); });
  return doomed.map(b => b.name);
}

// Put a backup back as vault.db. The current database is backed up first, under "pre-restore", so a restore can itself be undone.
function restore({ home, dbPath, name, go = false, log = console.log }) {
  if (!BACKUP_RE.test(String(name || ''))) throw new Error('Not a backup name: ' + name);
  const src = path.join(home, name); if (!fs.existsSync(src)) throw new Error('No such backup: ' + name);
  log(`${go ? 'Restoring' : 'Would restore'} ${name} (${mb(size(src))}) as ${path.basename(dbPath)}`);
  if (!go) return null;
  const saved = backup({ home, dbPath, reason: 'pre-restore', log });
  fs.copyFileSync(src, dbPath + '.restoring'); fs.renameSync(dbPath + '.restoring', dbPath);
  ['-wal', '-shm'].forEach(x => { try { fs.unlinkSync(dbPath + x); } catch (e) { /* none */ } });
  log('Restored. The previous database is kept as ' + saved + '. Restart Muse to see it.');
  return saved;
}

function leftovers(home) { return names(home, LEFTOVER_RE).map(n => ({ name: n, bytes: size(path.join(home, n)) })); }
function clean({ home, go = false, log = console.log }) {
  const list = leftovers(home);
  log(`${list.length} leftover file(s) ${go ? 'deleted' : 'found'}${list.length ? ':' : '.'}`);
  list.forEach(f => { log('  ' + f.name + '  ' + mb(f.bytes)); if (go) fs.unlinkSync(path.join(home, f.name)); });
  return list.map(f => f.name);
}

function status({ home, dbPath, version, log = console.log }) {
  const db = openRead(dbPath);
  try {
    const one = (sql, a = []) => { try { return db.prepare(sql).get(...a); } catch (e) { return null; } };
    const notes = (one('SELECT COUNT(*) AS n FROM vault_notes') || {}).n, burrs = (one('SELECT COUNT(*) AS n FROM burrs WHERE prompt_version = ?', [version]) || {}).n;
    const pending = pendingNotes(dbPath, version), mig = one('SELECT COUNT(*) AS n, MAX(id) AS last FROM schema_migrations');
    const spent = one('SELECT COALESCE(SUM(cost_usd),0) AS s FROM api_budget'), wp = one('SELECT COUNT(*) AS n FROM wordplay_edges');
    let ready = '?'; try { ready = candidates({ dbPath, args: ['--all'], log: () => {} }); } catch (e) { /* older database */ }
    log(`Notes: ${notes}   Facts (${version}): ${burrs}   Not yet processed: ${pending}   Ready to process: ${ready}`);
    log(`Wordplay edges: ${wp ? wp.n : 'none'}   Migrations applied: ${mig ? mig.n : '?'} (last ${mig ? mig.last : '?'})`);
    log(`Spent so far: $${(spent ? spent.s : 0).toFixed(4)}`);
    log(`Database: ${path.basename(dbPath)} ${mb(size(dbPath))}   Backups: ${listBackups(home).length}   Leftovers: ${leftovers(home).length}`);
  } finally { db.close(); }
}

// The notes a nuggetize run with these arguments would actually process: the script's own selection, so the number a person confirms is the number it will do.
function candidates({ dbPath, args = [], log = console.log }) {
  const N = require('../nuggetizer'), db = openRead(dbPath);
  try { const n = N.pickCandidates(db, N.parseArgs(args)).length; log(`Notes this run would process: ${n}`); return n; } finally { db.close(); }
}

function pending({ dbPath, version, log = console.log }) { const n = pendingNotes(dbPath, version); log(`Pending notes: ${n}`); return n; }

module.exports = { stamp, candidates, pendingNotes, listBackups, backup, prune, restore, leftovers, clean, status, pending, BACKUP_RE };
