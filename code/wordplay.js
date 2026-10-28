#!/usr/bin/env node
'use strict';
/**
 * QUARRY wordplay — find wordplay among the vault's names and store it in wordplay_edges. No model, free.
 *
 *   node code/wordplay.js                      report only: edge counts per kind and grade, nothing written
 *   node code/wordplay.js --apply              replace the wordplay_edges rows (back up vault.db first); takes about 3 seconds
 *   node code/wordplay.js --undo               clear the rows
 *   --cmudict FILE                             pronunciation dictionary for rhymes and sound-alikes (default code/lab/out/cmudict.dict, or $CMUDICT);
 *                                              without it those kinds are skipped
 * Muse reads wordplay_edges; it never runs the detectors. Re-run after nuggetize. Grades: A nearly all genuine, B mostly, C rough.
 */
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const D = require('./lab/data'), { isBoilerplate } = require('./lab/boiler'), S = require('./lab/wordplay_scan');
const PH = require('./lib/phonetics'), E = require('./lib/wordplay_edges');

function build(db, version, dictPath) {
  const all = D.loadBurrs(db, version), skip = new Set(D.loadDupes(db, all.map(b => b.id)).map(d => d.burr_id));
  const burrs = all.filter(b => !skip.has(b.id) && !isBoilerplate(b.claim));
  let titles = []; try { titles = db.prepare('SELECT id, title FROM vault_notes').all(); } catch (e) { /* no notes table */ }
  const tn = S.titleNumbers(titles), dict = dictPath && fs.existsSync(dictPath) ? PH.parseDict(fs.readFileSync(dictPath, 'utf8')) : null;
  const res = S.scan(burrs, { titleNumbers: tn, dict: dict });
  const idx = new Map();
  S.namesFrom(burrs).concat(S.numericStrings(burrs), tn).forEach(n => { const k = n.name.toLowerCase(); idx.set(k, Array.from(new Set((idx.get(k) || []).concat(n.notes)))); });
  return { rows: E.edgesFrom(res, idx), burrs: burrs.length, dict: !!dict };
}
function summary(rows) {
  const m = {}; rows.forEach(r => { const k = r.kind; m[k] = m[k] || { A: 0, B: 0, C: 0 }; m[k][r.grade]++; }); return m;
}
function apply(db, rows) {
  const runId = 'wordplay-' + Date.now().toString(36);
  db.exec(E.SCHEMA_SQL); db.exec('BEGIN');
  try {
    db.exec('DELETE FROM wordplay_edges');
    const ins = db.prepare('INSERT INTO wordplay_edges (kind, a_name, b_name, a_notes, b_notes, grade, detail, detector_version, run_id) VALUES (?,?,?,?,?,?,?,?,?)');
    rows.forEach(r => ins.run(r.kind, r.a_name, r.b_name, JSON.stringify(r.a_notes), JSON.stringify(r.b_notes), r.grade, r.detail, E.DETECTOR_VERSION, runId));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return runId;
}
module.exports = { build, summary, apply };

if (require.main === module) {
  const a = process.argv.slice(2), flag = f => a.includes(f), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const dbPath = process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db'), db = new DatabaseSync(dbPath);
  if (flag('--undo')) { db.exec(E.SCHEMA_SQL); db.exec('DELETE FROM wordplay_edges'); console.log('UNDONE wordplay_edges cleared'); process.exit(0); }
  const dictPath = arg('cmudict', process.env.CMUDICT || path.join(__dirname, 'lab', 'out', 'cmudict.dict'));
  const r = build(db, arg('version', D.DEFAULT_VERSION), dictPath);
  console.log((flag('--apply') ? 'APPLIED ' : 'report only · ') + r.rows.length + ' edges from ' + r.burrs + ' burrs' + (r.dict ? '' : ' · no pronunciation dictionary, rhymes and sound-alikes skipped (' + dictPath + ')'));
  const s = summary(r.rows); Object.keys(s).sort().forEach(k => console.log('  ' + k.padEnd(18) + ' A ' + String(s[k].A).padStart(5) + '  B ' + String(s[k].B).padStart(5) + '  C ' + String(s[k].C).padStart(5)));
  if (flag('--apply')) console.log('run ' + apply(db, r.rows)); else console.log('\nNothing written. Back up vault.db, then run with --apply.');
}
