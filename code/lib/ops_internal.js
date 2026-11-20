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

const NO_DB = 'No database yet. Run "Create or update the database" first (muse ops run migrate --go).';
function openRead(dbPath) { if (!fs.existsSync(dbPath)) throw new Error(NO_DB); return new DatabaseSync(dbPath, { readOnly: true }); }

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
  if (!fs.existsSync(dbPath)) { log('No database yet, so there is nothing to back up.'); return null; }
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

// What "Copy the vault in" would do, in plain numbers, without rsync's itemised list: new, changed (size or modified time differs, rsync's own rule), no longer in the vault
// (removed from the copy), and unchanged. Read-only; skips .git and .obsidian like the copy does.
function vaultDiff({ src, dst, log = console.log }) {
  const walk = root => { const out = new Map(); (function go(dir) { let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) { if (e.name === '.git' || e.name === '.obsidian') continue; const p = path.join(dir, e.name);
      if (e.isDirectory()) go(p); else if (e.isFile()) { try { const st = fs.statSync(p); out.set(path.relative(root, p), [st.size, Math.floor(st.mtimeMs / 1000)]); } catch (x) { /* vanished */ } } } })(root); return out; };
  const a = walk(src), b = fs.existsSync(dst) ? walk(dst) : new Map(), nw = [], ch = [], gone = [];
  let same = 0;
  for (const [k, v] of a) { const w = b.get(k); if (!w) nw.push(k); else if (w[0] !== v[0] || w[1] !== v[1]) ch.push(k); else same++; }
  for (const k of b.keys()) if (!a.has(k)) gone.push(k);
  const ex = l => l.length ? '  e.g. ' + l.slice(0, 3).join(', ') : '';
  if (!nw.length && !ch.length && !gone.length) log(`The copy is up to date: ${same} file(s), nothing to copy.`);
  else log(`A real copy would add ${nw.length}, update ${ch.length} and remove ${gone.length} file(s); ${same} are already up to date.` + (nw.length ? '\n  new' + ex(nw) : '') + (ch.length ? '\n  changed' + ex(ch) : '') + (gone.length ? '\n  removed from the copy' + ex(gone) : ''));
  return { new: nw.length, changed: ch.length, gone: gone.length, same };
}

// The notes a nuggetize run with these arguments would actually process: the script's own selection, so the number a person confirms is the number it will do.
function candidates({ dbPath, args = [], log = console.log, env = process.env, home = process.env.QUARRY_HOME }) {
  const N = require('../nuggetizer'), db = openRead(dbPath), edited = args.includes('--edited');
  // The number a person confirms before a paid run. Stubs and media-only notes (under 3 words) are in the run, because it records them for review without a model call,
  // but they cost nothing and are not "waiting work", so they are reported beside the count and left out of it.
  try {
    const rows = N.pickCandidates(db, N.parseArgs(args), edited ? require('./note_path').vaultRoot(env, home) : null), n = rows.filter(r => (r.word_count || 0) >= 3).length, free = rows.length - n;
    log((edited ? 'Edited notes this run would re-process: ' : 'Notes this run would process: ') + n + (free ? ` (and ${free} empty or media-only note${free === 1 ? '' : 's'} that cost nothing and are only flagged for review)` : ''));
    if (edited && rows.length) rows.forEach(r => log('  will re-process: ' + r.rel_path + (r.prev === 'skipped_empty' ? ' - was empty, now has text' : ' - body text changed since the last extraction')));
    if (edited && rows.skipped && rows.skipped.length) { log(`Skipped ${rows.skipped.length} edited-looking note${rows.skipped.length === 1 ? '' : 's'} (nothing to re-extract):`); rows.skipped.forEach(x => log('  ' + x.rel_path + ' - ' + x.reason)); }
    return n;
  } finally { db.close(); }
}

// Tagger numbers, for the paid run's typed confirmation and for the Admin page. Read-only, and tolerant of a database that has no tag_proposals yet (M020 not applied).
function tagCandidates({ dbPath, limit = 0, note = 0, log = console.log }) {
  const T = require('./tagging'), db = openRead(dbPath);
  try { const n = T.candidates(db, { limit, note }).length; log('Notes this run would tag: ' + n); return n; } finally { db.close(); }
}
function tagWriteCount({ dbPath, limit = 0, log = console.log }) {
  const db = openRead(dbPath);
  try { const n = db.prepare("SELECT COUNT(DISTINCT note_id) n FROM tag_proposals WHERE status='approved' AND written_at IS NULL").get().n, k = limit && limit < n ? limit : n; log('Notes this run would write tags into: ' + k); return k; } finally { db.close(); }
}
function tagsWaiting({ dbPath, page = 1, size = 24, filter = 'all', q = '' }) {
  const T = require('./tagging'); let db; try { db = openRead(dbPath); } catch (e) { return { available: false, total: 0, matching: 0, shown: 0, waiting: [] }; }
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tag_proposals'").get()) return { available: false, total: 0, matching: 0, shown: 0, waiting: [] };
    const vocab = T.vocabularyWithApproved(db, T.loadVocabulary()), r = T.pending(db, vocab, { limit: size, offset: (Math.max(1, page | 0) - 1) * size, filter, q });
    const one = s => db.prepare(s).get();   // not named q: q is the search text
    return Object.assign({ available: true, approvedUnwritten: one("SELECT COUNT(DISTINCT note_id) n FROM tag_proposals WHERE status='approved' AND written_at IS NULL").n, untagged: one("SELECT COUNT(*) n FROM vault_notes WHERE has_tags=0 AND COALESCE(quarry_exclude,0)=0").n }, r);
  } finally { db.close(); }
}

// Where an install stands, for the Admin page's two modes. Read-only and tolerant of a missing or half-built database. `suggested` is the mode to open on: a database
// with notes and facts is "ongoing"; anything less is still "setup". `done` marks steps whose result is already in the database, so the setup list shows how far you are.
function setupState({ dbPath, home }) {
  const out = { database: fs.existsSync(dbPath), migrations: 0, notes: 0, facts: 0, wordplay: 0, backups: listBackups(home).length };
  if (out.database) {
    let db; try { db = openRead(dbPath); } catch (e) { db = null; }
    const n = (sql) => { try { return db.prepare(sql).get().n; } catch (e) { return 0; } };
    if (db) { try { out.migrations = n('SELECT COUNT(*) n FROM schema_migrations'); out.notes = n('SELECT COUNT(*) n FROM vault_notes'); out.facts = n('SELECT COUNT(*) n FROM burrs'); out.wordplay = n('SELECT COUNT(*) n FROM wordplay_edges'); } finally { db.close(); } }
  }
  out.done = { migrate: out.migrations > 0, 'vault-sync': out.notes > 0, index: out.notes > 0, nuggetize: out.facts > 0, 'refresh-process': out.facts > 0 && out.wordplay > 0, backup: out.backups > 0 };
  out.suggested = out.database && out.notes > 0 && out.facts > 0 ? 'ongoing' : 'setup';
  return out;
}

// The embedding server (Ollama) that "search by meaning" needs. If it already answers, say so; if not, start `ollama serve` detached (it keeps running after this job
// ends), wait until it answers, and report whether the embedding model is installed. No sudo, and only a server on this machine: a remote URL is never started.
const OLLAMA_PLACES = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'];
function findOllama({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.OLLAMA_BIN) return exists(env.OLLAMA_BIN) ? env.OLLAMA_BIN : null;
  for (const d of String(env.PATH || '').split(path.delimiter)) { if (d && exists(path.join(d, 'ollama'))) return path.join(d, 'ollama'); }
  return OLLAMA_PLACES.find(f => exists(f)) || null;
}
async function ollamaStart({ url = process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model = process.env.MUSE_EMBED_MODEL || 'embeddinggemma', env = process.env, log = console.log,
  fetchFn = globalThis.fetch, spawnFn = require('child_process').spawn, exists = fs.existsSync, waitMs = 30000, pollMs = 500 } = {}) {
  const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error('OLLAMA_URL points at another machine (' + url + '). Start the server there; Muse only starts one on this machine.');
  const tags = async () => { try { const r = await fetchFn(url + '/api/tags', { signal: AbortSignal.timeout(2000) }); if (!r.ok) return null; const j = await r.json(); return (j.models || []).map(m => m.name || m.model || ''); } catch (e) { return null; } };
  const report = (names, started) => {
    const has = names.some(n => n === model || n.startsWith(model + ':'));
    log((started ? 'Started the embedding server and it answers at ' : 'The embedding server is already running at ') + url + '.');
    log(has ? 'Model ' + model + ' is installed. Search by meaning is ready.' : 'Model ' + model + ' is NOT installed here. Run: ollama pull ' + model + '   (a server started as your user looks in your own models folder, not the system service\'s).');
    return { started, up: true, hasModel: has };
  };
  let names = await tags();
  if (names) return report(names, false);
  const bin = findOllama({ env, exists });
  if (!bin) throw new Error('Ollama is not installed here (no "ollama" on the PATH or in the usual places). Install it, or set OLLAMA_BIN to its full path.');
  log('The embedding server is not answering at ' + url + '. Starting: ' + bin + ' serve');
  let spawnErr = null;
  const child = spawnFn(bin, ['serve'], { detached: true, stdio: 'ignore', env });
  child.on('error', e => { spawnErr = e; }); child.unref();
  for (let waited = 0; waited <= waitMs; waited += pollMs) {
    if (spawnErr) throw new Error('Could not start ' + bin + ': ' + spawnErr.message);
    names = await tags(); if (names) return report(names, true);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('Started ' + bin + ' serve but nothing answered at ' + url + ' within ' + Math.round(waitMs / 1000) + ' seconds. Is another program using that port?');
}

function pending({ dbPath, version, log = console.log }) { const n = pendingNotes(dbPath, version); log(`Pending notes: ${n}`); return n; }

module.exports = { stamp, setupState, vaultDiff, candidates, tagCandidates, tagWriteCount, tagsWaiting, pendingNotes, listBackups, backup, prune, restore, leftovers, clean, status, pending, ollamaStart, findOllama, BACKUP_RE };
