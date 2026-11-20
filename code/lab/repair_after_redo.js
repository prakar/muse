#!/usr/bin/env node
'use strict';
// Repairs what a --redo did on 20 Nov 2026, before nuggetizer.js kept burr ids stable: it re-inserted burrs with NEW ids and wrote loop_text as NULL.
//   1. Marks (stars) and burr judgements that pointed at the old ids are re-pointed at the same fact (matched by note + claim + prompt version) by APPENDING events
//      to muse-marks.jsonl and muse-judgements.jsonl. Nothing is rewritten or deleted from those logs.
//   2. loop_text archived in the pre-redo backup is copied back into burrs that now have none.
// The burr_dupes links are rebuilt by `muse ops run dedupe`, not here.
//   node code/lab/repair_after_redo.js --backup FILE [--files] [--loops] [--go]      dry run unless --go; --files = step 1, --loops = step 2 (default: both)
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

const keyOf = r => r.note_id + '\u0001' + r.prompt_version + '\u0001' + r.claim;

// old id -> new id, for ids that no longer exist but whose fact (note + claim + version) does.
function idMap(backup, db) {
  const cur = new Map(), live = new Set();
  db.prepare('SELECT id, note_id, prompt_version, claim FROM burrs').all().forEach(r => { cur.set(keyOf(r), r.id); live.add(r.id); });
  const map = new Map();
  backup.prepare('SELECT id, note_id, prompt_version, claim FROM burrs').all().forEach(r => { if (!live.has(r.id) && cur.has(keyOf(r))) map.set(r.id, cur.get(keyOf(r))); });
  return map;
}

// Marks: the events that put each still-active mark on an old id, re-issued on the new id (the old key is cleared first so it is not left dangling).
function marksAppend(events, map, nowIso) {
  const state = new Map(), out = [];
  events.forEach(e => { if (!e || !e.handle) return; const k = e.handle + '#' + e.item; if (e.mark === 'clear') state.delete(k); else state.set(k, e); });
  state.forEach(e => {
    const to = e.item != null && map.get(Number(e.item)); if (!to) return;
    out.push({ ts: nowIso, version: e.version, handle: e.handle, item: e.item, mark: 'clear', ctx: e.ctx, remappedTo: to });
    out.push(Object.assign({}, e, { ts: nowIso, item: typeof e.item === 'number' ? to : String(to), remappedFrom: e.item }));
  });
  return out;
}
// Judgements on facts (view 'burrs'): the original event again, on the new id, keeping its own time.
function judgementsAppend(events, map) {
  return events.filter(e => e && e.view === 'burrs' && /^\d+$/.test(String(e.id)) && map.has(Number(e.id)))
    .map(e => Object.assign({}, e, { id: typeof e.id === 'number' ? map.get(Number(e.id)) : String(map.get(Number(e.id))), remappedFrom: e.id }));
}
const readLog = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const append = (f, rows) => { if (rows.length) fs.appendFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); };

function loopsToRestore(backup, db) {
  const cur = new Map();
  db.prepare("SELECT id, note_id, prompt_version, claim, loop_text FROM burrs").all().forEach(r => { if (!r.loop_text) cur.set(keyOf(r), r.id); });
  const out = [];
  backup.prepare("SELECT note_id, prompt_version, claim, loop_text FROM burrs WHERE loop_text IS NOT NULL AND loop_text <> ''").all()
    .forEach(r => { const id = cur.get(keyOf(r)); if (id) out.push({ id, loop_text: r.loop_text }); });
  return out;
}

function main(argv) {
  const get = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const go = argv.includes('--go'), doFiles = argv.includes('--files') || !argv.includes('--loops'), doLoops = argv.includes('--loops') || !argv.includes('--files');
  const home = process.env.QUARRY_HOME || path.join(__dirname, '..', '..');
  const bak = get('--backup'); if (!bak) throw new Error('--backup FILE is required (the vault.db copy from before the redo)');
  const backup = new DatabaseSync(bak, { readOnly: true }), db = new DatabaseSync(path.join(home, 'vault.db'), { readOnly: !(go && doLoops) });
  const map = idMap(backup, db), nowIso = new Date().toISOString();
  const mf = path.join(home, 'muse-marks.jsonl'), jf = path.join(home, 'muse-judgements.jsonl');
  const marks = doFiles ? marksAppend(readLog(mf), map, nowIso) : [], judg = doFiles ? judgementsAppend(readLog(jf), map) : [];
  const loops = doLoops ? loopsToRestore(backup, db) : [];
  console.log('ids that changed and can be matched: ' + map.size);
  if (doFiles) console.log('marks to re-point: ' + marks.length / 2 + ' (' + marks.length + ' events) | fact judgements to re-point: ' + judg.length);
  if (doLoops) console.log('loop_text to restore: ' + loops.length);
  if (!go) { console.log('Dry run. Add --go to apply' + (doLoops ? ' (loops write vault.db: back it up first, e.g. muse ops run backup)' : '') + '.'); return { map: map.size, marks: marks.length, judg: judg.length, loops: loops.length }; }
  if (doFiles) { const stamp = nowIso.replace(/[-:.TZ]/g, '').slice(0, 14); [mf, jf].forEach(f => { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + stamp + '-before-repair'); }); append(mf, marks); append(jf, judg); }
  if (doLoops && loops.length) { const up = db.prepare('UPDATE burrs SET loop_text=? WHERE id=? AND (loop_text IS NULL OR loop_text=\'\')'); db.exec('BEGIN'); try { loops.forEach(l => up.run(l.loop_text, l.id)); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  console.log('Done.'); return { map: map.size, marks: marks.length, judg: judg.length, loops: loops.length };
}
module.exports = { idMap, marksAppend, judgementsAppend, loopsToRestore, main };
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error('FATAL: ' + e.message); process.exit(1); } }
