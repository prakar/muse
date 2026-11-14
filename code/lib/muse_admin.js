'use strict';
// Admin, section 1: Status and health. Read-only. Everything here only looks; the actions come later, section by section (see the vault note
// "QUARRY - Muse Admin Coverage"). Dependencies are passed in so tests use a temp folder and a small in-memory database.
const fs = require('fs'), path = require('path');

const SIDECARS = [['muse-marks.jsonl', 'Your stars and judgements. Permanent.'], ['muse-tray.json', 'The Collection and link lines.'], ['muse-events.jsonl', 'Usage log, for the prune review.'],
  ['muse-judgements.jsonl', 'Older judgements file.'], ['muse-cache.db', 'Cached question rewrites for search.']];
const stat = f => { try { const s = fs.statSync(f); return { bytes: s.size, at: s.mtime.toISOString() }; } catch (e) { return null; } };
const q = (db, sql, args = []) => { try { return db.prepare(sql).all(...args); } catch (e) { return null; } };
const one = (db, sql, args = []) => { const r = q(db, sql, args); return r && r[0] ? r[0] : null; };

function createAdmin({ home, dbPath, db, version, port, search = null, ceiling = parseFloat(process.env.BUDGET_CEILING_USD || '10.00'), now = () => Date.now(), drift = null, loadedAt = null, setupMode = false, integrity = null, degraded = false }) {
  const started = now();
  function backups() {
    let names = []; try { names = fs.readdirSync(home); } catch (e) { /* folder unreadable */ }
    return names.filter(n => /^vault\.db\.bak-/.test(n)).map(n => ({ name: n, ...stat(path.join(home, n)) })).filter(x => x.bytes != null).sort((a, b) => b.at.localeCompare(a.at));
  }
  function leftovers() {
    let names = []; try { names = fs.readdirSync(home); } catch (e) { /* folder unreadable */ }
    return names.filter(n => /(-journal|\.journal)(\.|$)|\.interrupted-|\.stale-/.test(n)).map(n => ({ name: n, ...stat(path.join(home, n)) })).filter(x => x.bytes != null);
  }
  function vectors() {
    let names = []; try { names = fs.readdirSync(home); } catch (e) { /* folder unreadable */ }
    return names.filter(n => /^search-vectors-/.test(n)).map(n => ({ file: n, what: 'Search by meaning: vector index.', ...stat(path.join(home, n)) })).filter(x => x.bytes != null);
  }
  // Muse loads its facts, wordplay and duplicate flags once, when it starts. This says whether the database has gained any since, so the page can tell you to restart.
  // Times are compared with datetime(), which reads both the ISO form (facts) and the plain form (wordplay) in UTC.
  function freshness() {
    if (!loadedAt) return null;
    const since = sql => (one(db, sql, [loadedAt]) || {}).n || 0;
    const f = { loadedAt, newFacts: since('SELECT COUNT(*) AS n FROM burrs WHERE datetime(created_at) > datetime(?)'), newWordplay: since('SELECT COUNT(*) AS n FROM wordplay_edges WHERE datetime(created_at) > datetime(?)'),
      newDuplicateFlags: since('SELECT COUNT(*) AS n FROM burr_dupes WHERE datetime(created_at) > datetime(?)') };
    f.stale = f.newFacts + f.newWordplay + f.newDuplicateFlags > 0; return f;
  }
  function status() {
    const byVersion = q(db, 'SELECT prompt_version AS version, COUNT(*) AS n FROM burrs GROUP BY prompt_version ORDER BY prompt_version') || [];
    const notes = (one(db, 'SELECT COUNT(*) AS n FROM vault_notes') || {}).n;
    const done = (one(db, 'SELECT COUNT(DISTINCT note_id) AS n FROM nuggetize_status WHERE prompt_version = ?', [version]) || {}).n;
    const dupes = q(db, 'SELECT status, COUNT(*) AS n FROM burr_dupes GROUP BY status') || [];
    const wp = q(db, 'SELECT kind, COUNT(*) AS n FROM wordplay_edges GROUP BY kind ORDER BY n DESC') || [];
    const mig = one(db, 'SELECT COUNT(*) AS n, MAX(id) AS last FROM schema_migrations');
    const spent = (one(db, 'SELECT COALESCE(SUM(cost_usd),0) AS s, MAX(called_at) AS last FROM api_budget') || {});
    const run = one(db, "SELECT run_id, kind, started_at, finished_at FROM muse_runs ORDER BY started_at DESC LIMIT 1");
    return {
      counts: { notes, version, byVersion, pending: notes != null && done != null ? Math.max(0, notes - done) : null, dupes, wordplay: wp },
      database: { path: path.basename(dbPath), ...stat(dbPath), migrations: mig, backups: backups(), backupBytes: backups().reduce((s, b) => s + b.bytes, 0) },
      money: { spent: spent.s || 0, ceiling, lastCall: spent.last || null, lastRun: run },
      files: SIDECARS.map(([file, what]) => ({ file, what, ...(stat(path.join(home, file)) || { bytes: null, at: null }) })).concat(vectors()),
      leftovers: leftovers(),
      freshness: freshness(),
      integrity: integrity && { state: integrity.state, level: integrity.level, degraded, findings: integrity.findings, ms: integrity.ms },
      server: { setupMode, version, port, pid: process.pid, node: process.version, upSeconds: Math.round((now() - started) / 1000), search: search ? search.status() : null }
    };
  }
  async function runDrift() {
    if (!drift) return { ok: false, error: 'The drift check is not available on this server.' };
    const r = await drift(); return { ok: !r.problems.length, problems: r.problems.map(p => p.kind + ': ' + p.msg), warnings: r.warnings.map(p => p.msg), stats: r.stats };
  }
  return { status, runDrift };
}
module.exports = { createAdmin };
