#!/usr/bin/env node
'use strict';
const { needTables } = require('./lib/schema_guard');
/**
 * QUARRY dedupe — flag duplicate burrs, deterministically. Free; no burr is ever deleted.
 *
 *   node code/dedupe.js               report only: counts and sample pairs, nothing written
 *   node code/dedupe.js --csv f.csv   report, and write every pair to a CSV for review
 *   node code/dedupe.js --notes f.csv write groups of duplicate NOTES (same title / same opening) for review
 *   node code/dedupe.js --apply       record the flags in burr_dupes (back up vault.db first); re-running replaces them
 *   node code/dedupe.js --undo        clear every flag
 *
 * echo = a shorter burr inside the same note that a longer one already covers (hidden from the viewer's counts).
 * clone = the same fact in different notes (grouped, counted once). Flagged burrs are hidden in the viewer
 * unless MUSE_SHOW_DUPES=1. See lib/dedupe.js for the matching rules.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const D = require('./lib/dedupe');
const B = require('./lib/burrs');

function run(db, opts) {
  opts = opts || {};
  const version = opts.version || B.PROMPT_VERSION;
  const burrs = db.prepare('SELECT id, note_id, claim FROM burrs WHERE prompt_version = ?').all(version);
  const dupes = D.findDupes(burrs);
  const runId = 'dedupe-' + Date.now().toString(36);
  const clear = "DELETE FROM burr_dupes WHERE burr_id IN (SELECT id FROM burrs WHERE prompt_version = ?)";
  if (opts.undo) { needTables(db, ['burr_dupes']); db.prepare(clear).run(version); }
  else if (opts.apply) {
    needTables(db, ['burr_dupes']);
    db.exec('BEGIN');
    try {
      db.prepare(clear).run(version);
      const ins = db.prepare('INSERT INTO burr_dupes (burr_id, dup_of, kind, score, status, run_id) VALUES (?, ?, ?, ?, ?, ?)');
      dupes.forEach(function (d) { ins.run(d.id, d.dup_of, d.kind, d.score, 'dup', runId); });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const echo = dupes.filter(function (d) { return d.kind === 'echo'; }).length;
  return { burrs: burrs.length, dupes: dupes.length, echo: echo, clone: dupes.length - echo, runId: runId, rows: dupes };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = function (f) { return args.indexOf(f) >= 0; };
  const csvAt = args.indexOf('--csv');
  const dbPath = process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db');
  const db = new DatabaseSync(dbPath);
  const r = run(db, { apply: flag('--apply'), undo: flag('--undo') });
  console.log((flag('--apply') ? 'APPLIED ' : flag('--undo') ? 'UNDONE ' : 'report only · ') + 'burrs ' + r.burrs + ' · duplicates ' + r.dupes + ' (echo ' + r.echo + ', clone ' + r.clone + ')' + (flag('--apply') ? ' · run ' + r.runId : ''));
  if (!flag('--apply') && !flag('--undo')) {
    const byId = new Map(db.prepare('SELECT id, note_id, claim FROM burrs WHERE prompt_version = ?').all(B.PROMPT_VERSION).map(function (b) { return [b.id, b]; }));
    ['echo', 'clone'].forEach(function (k) {
      console.log('\n' + k + ' examples:');
      r.rows.filter(function (d) { return d.kind === k; }).filter(function (_, i) { return i % Math.max(1, Math.floor(r.rows.length / 20)) === 0; }).slice(0, 6).forEach(function (d) {
        console.log('  ' + byId.get(d.id).claim.slice(0, 90) + '\n    = ' + byId.get(d.dup_of).claim.slice(0, 90));
      });
    });
    console.log('\nNothing written. Back up vault.db, then run with --apply.');
  }
  const notesAt = args.indexOf('--notes');
  if (notesAt >= 0 && args[notesAt + 1]) {   // duplicate NOTES, for your review; nothing is changed
    const norm = D.norm, rows = db.prepare('SELECT id, title, word_count, rel_path, first_paragraph FROM vault_notes').all();
    const groups = new Map();
    const add = function (kind, key, n) { if (!key) return; const k = kind + '|' + key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(n); };
    rows.forEach(function (n) { add('same title', norm(n.title), n); const fp = norm(n.first_paragraph).slice(0, 200); if (fp.length >= 40) add('same opening', fp, n); });
    const q2 = function (x) { return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"'; };
    const out = ['group,reason,note_id,title,words,path']; let g = 0;
    groups.forEach(function (v, k) { if (v.length < 2) return; g++; v.forEach(function (n) { out.push([g, k.split('|')[0], n.id, q2(n.title), n.word_count, q2(n.rel_path)].join(',')); }); });
    fs.writeFileSync(args[notesAt + 1], out.join('\n') + '\n');
    console.log('wrote ' + args[notesAt + 1] + ' (' + g + ' groups of duplicate notes; review only, nothing changed)');
  }
  if (csvAt >= 0 && args[csvAt + 1]) {
    const byId = new Map(db.prepare('SELECT id, note_id, claim FROM burrs WHERE prompt_version = ?').all(B.PROMPT_VERSION).map(function (b) { return [b.id, b]; }));
    const q = function (s) { return '"' + String(s).replace(/"/g, '""') + '"'; };
    const lines = ['kind,score,burr_id,kept_id,claim,kept_claim'].concat(r.rows.map(function (d) {
      return [d.kind, d.score, d.id, d.dup_of, q(byId.get(d.id).claim), q(byId.get(d.dup_of).claim)].join(',');
    }));
    fs.writeFileSync(args[csvAt + 1], lines.join('\n') + '\n');
    console.log('wrote ' + args[csvAt + 1]);
  }
}

module.exports = { run };
