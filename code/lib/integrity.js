'use strict';
// Startup integrity check: does the database on disk match what this code expects? Read-only; never writes, never creates.
// The expected structure is not a hand-kept list: it is a fresh database built by the code's own migrations (migrate.buildFresh), so there is one source of truth.
// Findings: { id, level: 'fatal' | 'warn', msg, fix }. Overall state: 'setup' (no database yet), 'fatal', 'warn' or 'ok'.
// Fatal = Muse would give wrong answers or crash; it then runs Admin-only so the fix can be applied from Admin.
const fs = require('fs'), { DatabaseSync } = require('node:sqlite');
const { structure } = require('./schema_structure');
const NP = require('./note_path');

const FIX_MIGRATE = 'Admin: Create or update the database (muse ops run migrate --go), then muse restart.';
const f = (id, level, msg, fix) => ({ id, level, msg, fix: fix || '' });
const cols = t => (t.columns || []).map(c => c.split(' ')[0]);

function compare(exp, got) {
  const out = [];
  const missingT = [], missingC = [], extraT = [], extraC = [];
  for (const [n, t] of Object.entries(exp.tables)) {
    if (!got.tables[n]) { missingT.push(n); continue; }
    const have = new Set(cols(got.tables[n]));
    for (const c of cols(t)) if (!have.has(c)) missingC.push(n + '.' + c);
  }
  for (const [n, t] of Object.entries(got.tables)) {
    if (!exp.tables[n]) { extraT.push(n); continue; }
    const want = new Set(cols(exp.tables[n]));
    for (const c of cols(t)) if (!want.has(c)) extraC.push(n + '.' + c);
  }
  const missingV = Object.keys(exp.virtual).filter(n => !got.virtual[n]);
  if (missingT.length || missingV.length) out.push(f('missing-tables', 'fatal', 'Missing tables: ' + missingT.concat(missingV).join(', ') + '.', FIX_MIGRATE));
  if (missingC.length) out.push(f('missing-columns', 'fatal', 'Missing columns: ' + missingC.join(', ') + '.', FIX_MIGRATE));
  if (extraT.length || extraC.length) out.push(f('extra-structure', 'warn', 'In the database but not in the code: ' + extraT.concat(extraC).join(', ') + '. Harmless, but something outside the migrations made them.', 'Check whether a script or an older version created them (see the data map).'));
  return out;
}

// opts: dbPath, vaultRoots (array of folders, may be empty), deep (also run foreign_key_check), sample (keys to test, default 200), migrations (override, for tests)
function check(opts) {
  const t0 = Date.now(), findings = [];
  const { dbPath } = opts, deep = !!opts.deep, sample = opts.sample || 200;
  const done = extra => {
    const level = findings.some(x => x.level === 'fatal') ? 'fatal' : findings.length ? 'warn' : 'ok';
    return Object.assign({ state: extra && extra.state || level, level, findings, ms: Date.now() - t0 }, extra && extra.more);
  };
  if (!fs.existsSync(dbPath)) return { state: 'setup', level: 'setup', findings: [f('no-database', 'fatal', 'There is no database yet.', FIX_MIGRATE)], ms: Date.now() - t0 };
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); }
  catch (e) { findings.push(f('cannot-open', 'fatal', 'The database file cannot be opened: ' + e.message, 'Restore the newest backup (Admin: Restore a backup, or muse ops run restore).')); return done(); }
  try {
    let qc;
    try { qc = db.prepare('PRAGMA quick_check').all().map(r => r.quick_check); } catch (e) { qc = [e.message]; }
    if (qc[0] !== 'ok') { findings.push(f('corrupt', 'fatal', 'SQLite reports the file is damaged: ' + qc.slice(0, 3).join('; '), 'Restore the newest backup (Admin: Restore a backup).')); return done(); }

    const M = require('../migrate');
    const known = (opts.migrations || M.MIGRATIONS).map(m => m.id);
    let ledger = [];
    try { ledger = db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id); } catch (e) { /* no ledger table: all pending */ }
    const pending = known.filter(id => !ledger.includes(id)), unknown = ledger.filter(id => !known.includes(id));
    if (pending.length) findings.push(f('pending-migrations', 'fatal', pending.length + ' migration(s) not applied: ' + pending.join(', ') + '.', FIX_MIGRATE));
    if (unknown.length) findings.push(f('database-newer-than-code', 'fatal', 'The database has migrations this code does not know: ' + unknown.join(', ') + '. The code is older than the database.', 'Update the code (git pull / deploy), then muse restart.'));

    const hasCol = (t, c) => { try { return db.prepare('PRAGMA table_info("' + t + '")').all().some(x => x.name === c); } catch (e) { return false; } };
    if (hasCol('vault_notes', 'filepath') && !hasCol('vault_notes', 'rel_path')) findings.push(f('legacy-paths', 'fatal', 'Notes are still keyed by absolute path (before M015).', FIX_MIGRATE));

    const mem = new DatabaseSync(':memory:'); let exp;
    try { M.buildFresh(mem); exp = structure(mem); } finally { mem.close(); }
    findings.push(...compare(exp, structure(db)));

    if (deep) {
      let fk = []; try { fk = db.prepare('PRAGMA foreign_key_check').all(); } catch (e) { /* ignore */ }
      if (fk.length) findings.push(f('foreign-keys', 'warn', fk.length + ' row(s) point at rows that do not exist (e.g. in ' + fk[0].table + ').', 'Run the Check task in Admin; note the table, and see the data map.'));
    }

    const notes = hasCol('vault_notes', 'rel_path') ? db.prepare('SELECT COUNT(*) AS n FROM vault_notes').get().n : 0;
    const roots = (opts.vaultRoots || []).filter(Boolean);
    if (notes > 0 && roots.length) {
      const live = roots.filter(r => { try { return fs.statSync(r).isDirectory(); } catch (e) { return false; } });
      if (!live.length) findings.push(f('vault-missing', 'warn', 'The vault folder is not there: ' + roots.join(' or ') + '. Notes will not open.', 'Set VAULT_PATH (or MUSE_VAULT_ROOT) to the vault copy, or run "Copy the vault in".'));
      else {
        const keys = db.prepare('SELECT rel_path FROM vault_notes ORDER BY random() LIMIT ?').all(sample).map(r => r.rel_path);
        let miss = 0;
        for (const k of keys) { let ok = false; for (const r of live) { try { if (NP.locate(k, r)) { ok = true; break; } } catch (e) { /* bad key counts as missing */ } } if (!ok) miss++; }
        if (keys.length && miss / keys.length > 0.05) findings.push(f('notes-unreachable', 'warn', miss + ' of ' + keys.length + ' sampled notes are not found under ' + live.join(' or ') + '.', 'Wrong vault folder, or the vault copy is out of date: run "Copy the vault in" (muse ops run vault-sync).'));
      }
    }
  } finally { try { db.close(); } catch (e) { /* ignore */ } }
  return done();
}

const lines = r => r.findings.map(x => (x.level === 'fatal' ? 'FATAL  ' : 'warn   ') + x.msg + (x.fix ? '\n       Fix: ' + x.fix : ''));
module.exports = { check, compare, lines, FIX_MIGRATE };
