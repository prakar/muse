#!/usr/bin/env node
'use strict';
/**
 * Compare nug-v4 and nug-v5 on the notes that v5 has processed (read-only; run after the 50-note trial).
 *   node code/v5_compare.js [--a nug-v4] [--b nug-v5]
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2), opt = function (k, d) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const A = opt('--a', 'nug-v4'), Bv = opt('--b', 'nug-v5');
const db = new DatabaseSync(process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db'), { readOnly: true });
const B = require('./lib/burrs');
const pct = function (a, b) { return b ? Math.round(1000 * a / b) / 10 + '%' : '-'; };

const notes = db.prepare("SELECT note_id FROM nuggetize_status WHERE prompt_version = ? AND status = 'ok'").all(Bv).map(function (r) { return r.note_id; });
if (!notes.length) { console.log('No ' + Bv + ' notes yet. Run the trial first.'); process.exit(0); }
const inList = '(' + notes.join(',') + ')';
const burrs = function (v) { return db.prepare('SELECT id, note_id, claim, quote, hooks_json FROM burrs WHERE prompt_version = ? AND note_id IN ' + inList).all(v); };
const a = burrs(A), b = burrs(Bv);
console.log('notes compared: ' + notes.length);
console.log('burrs  ' + A + ': ' + a.length + '   ' + Bv + ': ' + b.length + '   (' + (b.length - a.length >= 0 ? '+' : '') + (b.length - a.length) + ')');

const reasons = function (v) {
  const out = {}; let rej = 0;
  db.prepare('SELECT n_rejected, reasons_json FROM nuggetize_status WHERE prompt_version = ? AND note_id IN ' + inList).all(v).forEach(function (r) {
    rej += r.n_rejected || 0; try { JSON.parse(r.reasons_json || '[]').forEach(function (x) { out[x] = (out[x] || 0) + 1; }); } catch (e) {}
  });
  return { rej: rej, out: out };
};
[[A, reasons(A)], [Bv, reasons(Bv)]].forEach(function (p) { console.log('rejected ' + p[0] + ': ' + p[1].rej + '  ' + JSON.stringify(p[1].out)); });

const urlRate = function (rows) { return pct(rows.filter(function (r) { return /https?:|\]\(|www\./i.test(r.quote); }).length, rows.length); };
console.log('evidence containing a web link:  ' + A + ' ' + urlRate(a) + '   ' + Bv + ' ' + urlRate(b));
const metaRate = function (rows) { return rows.filter(function (r) { return /\bcredited\b|^the (author|writer) of|available for (free )?download|digiti[sz]e/i.test(r.claim); }).length; };
console.log('credit/author/download claims:    ' + A + ' ' + metaRate(a) + '   ' + Bv + ' ' + metaRate(b));

const perNote = function (rows) { const m = new Map(); rows.forEach(function (r) { m.set(r.note_id, (m.get(r.note_id) || 0) + 1); }); return m; };
const pa = perNote(a), pb = perNote(b);
let more = 0, same = 0, fewer = 0; notes.forEach(function (n) { const x = pa.get(n) || 0, y = pb.get(n) || 0; if (y > x) more++; else if (y === x) same++; else fewer++; });
console.log('per note: more burrs in ' + Bv + ': ' + more + ', same: ' + same + ', fewer: ' + fewer);

// categories
let hooksN = 0, withCat = 0; const cats = {}, bySurface = new Map();
b.forEach(function (r) { let hs = []; try { hs = JSON.parse(r.hooks_json || '[]'); } catch (e) {} hs.forEach(function (h) {
  if (['entity', 'place', 'material'].indexOf(h.type) < 0) return; hooksN++;
  if (h.cat) { withCat++; cats[h.cat] = (cats[h.cat] || 0) + 1; const k = h.value.toLowerCase(); if (!bySurface.has(k)) bySurface.set(k, new Set()); bySurface.get(k).add(h.cat); }
}); });
console.log('\nentity/place/material hooks: ' + hooksN + ', with a category: ' + withCat + ' (' + pct(withCat, hooksN) + ')');
console.log('categories: ' + JSON.stringify(cats));
const multi = Array.from(bySurface.entries()).filter(function (e) { return e[1].size > 1; }).slice(0, 10);
console.log('same word, different categories (candidate knots): ' + (multi.length ? multi.map(function (e) { return e[0] + ' [' + Array.from(e[1]).join('/') + ']'; }).join(', ') : 'none in this sample'));

// late burrs: the extra capacity
const rank = function (rows) { const seen = new Map(); return rows.map(function (r) { const k = (seen.get(r.note_id) || 0) + 1; seen.set(r.note_id, k); return Object.assign({ rank: k }, r); }); };
const late = rank(b).filter(function (r) { return r.rank > B.MAX_BURRS; });
console.log('\nburrs beyond the old cap of ' + B.MAX_BURRS + ': ' + late.length + '. A sample to judge (are they as good as the first ones?):');
late.sort(function () { return Math.random() - 0.5; }).slice(0, 8).forEach(function (r) { console.log('  [' + r.rank + '] ' + r.claim.slice(0, 120)); });
