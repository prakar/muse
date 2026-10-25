#!/usr/bin/env node
'use strict';
/**
 * QUARRY muse_view.js — SCRATCH viewer for burrs, bristles, sparks and knots.
 *   node code/muse_view.js [--port 3002] [--version nug-v5]     then open http://localhost:3002
 *
 * Read-only on vault.db. The ONLY thing it writes is muse-judgements.jsonl in QUARRY_HOME (your labels),
 * which is local and gitignored. Binds to 127.0.0.1. Zero dependencies. Not part of the quarry server.
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const M = require('./lib/muse_model');

const args = process.argv.slice(2);
const opt = function (k, d) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(opt('--port', '3002'), 10), VERSION = opt('--version', 'nug-v5');
const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..');
const DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const JFILE = path.join(HOME, 'muse-judgements.jsonl');

console.log('Building model from ' + DB + ' (' + VERSION + ') ...');
const t0 = Date.now();
const model = M.build(new DatabaseSync(DB, { readOnly: true }), VERSION, { showDupes: !!process.env.MUSE_SHOW_DUPES });
console.log('Model ready in ' + (Date.now() - t0) + ' ms: ' + model.burrs.length + ' burrs, ' + model.bristles.length + ' bristle keys, ' +
  model.sparks.length + ' spark candidates, ' + model.knots.length + ' knot candidates');

const judged = new Map();   // "view|id" -> {label, note}
try { fs.readFileSync(JFILE, 'utf8').split('\n').filter(Boolean).forEach(function (l) { try { const j = JSON.parse(l); judged.set(j.view + '|' + j.id + (j.rule ? '|' + j.rule : ''), { label: j.label, note: j.note || '' }); } catch (e) {} }); } catch (e) {}

const VIEWS = { burrs: model.burrs, bristles: model.bristles, sparks: model.sparks, knots: model.knots, slices: model.slices };
const BAND_ORDER = { none: 0, any: 1, spark: 2, single: 0, mid: 1, hub: 3 };
const SORTS = {
  burrs: { id: 'id', note: 'note', kind: 'kind', rank: 'rank', nB: 'nB', bestDf: 'bestDf', band: function (r) { return BAND_ORDER[r.band]; }, claim: 'claim', recs: function (r) { return r.recs.length; } },
  bristles: { surface: 'surface', df: 'df', rarity: 'rarity', nBurrs: 'nBurrs', band: function (r) { return BAND_ORDER[r.band]; }, types: function (r) { return r.types.join(); }, recs: function (r) { return r.recs.length; } },
  sparks: { surface: 'surface', df: 'df', rarity: 'rarity', dist: function (r) { return r.dist == null ? -1 : r.dist; }, cos: 'cos', score: 'score', recs: function (r) { return r.recs.length; } },
  slices: { surface: 'surface', df: 'df', why: 'why', types: function (r) { return r.types.join(); } },
  knots: { surface: 'surface', df: 'df', cos: 'cos', dist: function (r) { return r.dist == null ? -1 : r.dist; }, cls: 'cls', recs: function (r) { return r.recs.length; } }
};

function query(q) {
  const view = q.get('view') || 'burrs';
  let rows = VIEWS[view]; if (!rows) return { error: 'bad view' };
  const s = (q.get('q') || '').toLowerCase().trim(), rec = q.get('rec') || '', type = q.get('type') || '', band = q.get('band') || '', kind = q.get('kind') || '', cls = q.get('cls') || '', why = q.get('why') || '', jf = q.get('j') || '';
  rows = rows.filter(function (r) {
    if (s && r._s.indexOf(s) < 0) return false;
    if (rec === '_any' && !r.recs.length) return false;
    if (rec === '_none' && r.recs.length) return false;
    if (rec && rec[0] !== '_' && r.recs.indexOf(rec) < 0) return false;
    if (type && !(view === 'burrs' ? r.bristles.some(function (b) { return b.t === type; }) : (r.types || []).indexOf(type) >= 0)) return false;
    if (band && r.band !== band) return false;
    if (kind && r.kind !== kind) return false;
    if (cls && r.cls !== cls) return false;
    if (why && r.why !== why) return false;
    if (jf) { const j = judged.get(view + '|' + r.id); if (jf === '_unjudged' ? !!j : !j || j.label !== jf) return false; }
    return true;
  });
  const sk = q.get('sort'), dir = q.get('dir') === 'asc' ? 1 : -1;
  if (sk && SORTS[view][sk]) {
    const f = typeof SORTS[view][sk] === 'function' ? SORTS[view][sk] : function (r) { return r[SORTS[view][sk]]; };
    rows = rows.slice().sort(function (a, b) { let x = f(a), y = f(b); if (x == null) x = -Infinity; if (y == null) y = -Infinity; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  }
  const size = Math.min(200, Math.max(10, parseInt(q.get('size') || '50', 10))), page = Math.max(0, parseInt(q.get('page') || '0', 10));
  const out = rows.slice(page * size, page * size + size).map(function (r) {
    const o = Object.assign({}, r); delete o._s; const j = judged.get(view + '|' + r.id); o.j = j ? j.label : ''; o.jnote = j ? j.note : ''; o.rj = {}; (r.recs || []).forEach(function (t) { const q = judged.get(view + '|' + r.id + '|' + t); if (q) o.rj[t] = q.label; }); return o; });
  return { total: rows.length, page: page, size: size, rows: out };
}

function send(res, code, type, body) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); }

http.createServer(function (req, res) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'muse_view.html')));
  if (req.method === 'GET' && u.pathname === '/api/meta') {
    const recs = {}; Object.keys(M.REC).forEach(function (k) { recs[k] = Object.assign({}, M.REC[k], { counts: model.recCounts[k] || {} }); });
    return send(res, 200, 'application/json', JSON.stringify({ version: VERSION, notes: model.notes, totals: { burrs: model.burrs.length, bristles: model.bristles.length, sparks: model.sparks.length, knots: model.knots.length, slices: model.slices.length },
      recs: recs, labels: M.ITEM_LABELS, kinds: model.kinds, types: model.types, judged: judged.size }));
  }
  if (req.method === 'GET' && u.pathname === '/api/rows') return send(res, 200, 'application/json', JSON.stringify(query(u.searchParams)));
  if (req.method === 'GET' && u.pathname === '/api/detail') return send(res, 200, 'application/json', JSON.stringify(model.detail(u.searchParams.get('view'), u.searchParams.get('id')) || []));
  if (req.method === 'POST' && u.pathname === '/api/judge') {
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', function () {
      try {
        const j = JSON.parse(body);
        if (!VIEWS[j.view] || typeof j.id !== 'string' && typeof j.id !== 'number') throw new Error('bad judgement');
        if (j.rule && !M.REC[j.rule]) throw new Error('bad rule');
        const rec = { ts: new Date().toISOString(), view: j.view, id: j.id, label: String(j.label || '').slice(0, 40), note: String(j.note || '').slice(0, 500), version: VERSION };
        if (j.rule) rec.rule = j.rule;
        fs.appendFileSync(JFILE, JSON.stringify(rec) + '\n');
        judged.set(j.view + '|' + j.id + (j.rule ? '|' + j.rule : ''), { label: rec.label, note: rec.note });
        send(res, 200, 'application/json', '{"ok":true}');
      } catch (e) { send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    });
    return;
  }
  send(res, 404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', function () { console.log('Open http://localhost:' + PORT); });
