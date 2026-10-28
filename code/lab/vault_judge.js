#!/usr/bin/env node
'use strict';
// Judge the vault's shared handles. Candidate = a folded hook key carried by burrs of 2..MAX notes (hubs skipped). One judge call per handle,
// up to 6 burrs, one per note, picked deterministically. Writes lab output only (code/lab/out/<version>/vault_judge.jsonl); never vault.db.
//   node code/lab/vault_judge.js --db eval.db --dry-run
//   node code/lab/vault_judge.js --db eval.db --max-usd 6 [--max-notes 20] [--limit N] [--shards 3]
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), BR = require('../lib/bristles'), J = require('./judge_spec'), { judgeRows, JsonlCache } = require('./judge'), { isBoilerplate } = require('./boiler'), S = require('./sim');
const OUT = path.join(__dirname, 'out');

// Pure: handles from burrs. skip = Set of burr ids to leave out (dupes).
function buildHandles(burrs, opts) {
  opts = opts || {}; const maxNotes = opts.maxNotes || 20, skip = opts.skip || new Set(), by = new Map();
  burrs.forEach(b => {
    if (skip.has(b.id) || isBoilerplate(b.claim)) return;
    const seen = new Set();
    b.hooks.forEach(h => { const k = BR.foldKey(h.value); if (!BR.usableKey(k) || seen.has(k)) return; seen.add(k);
      if (!by.has(k)) by.set(k, { key: k, surfaces: new Map(), types: new Set(), notes: new Map() });
      const g = by.get(k); g.surfaces.set(h.value, (g.surfaces.get(h.value) || 0) + 1); g.types.add(h.type);
      if (!g.notes.has(b.note_id) || b.id < g.notes.get(b.note_id).id) g.notes.set(b.note_id, b); });
  });
  const out = [];
  by.forEach(g => { if (g.notes.size < 2 || g.notes.size > maxNotes) return;
    const picked = Array.from(g.notes.values()).sort((a, b) => S.sha(g.key + '|' + a.note_id).localeCompare(S.sha(g.key + '|' + b.note_id))).slice(0, 6);
    const surface = Array.from(g.surfaces.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
    out.push({ id: 'h:' + g.key, truth: 'unlabelled', notes_total: g.notes.size, input: { handle: surface, types: Array.from(g.types).sort(), burrs: picked.map((b, i) => ({ id: i + 1, note: b.note_id, claim: b.claim, quote: '' })), burr_ids: picked.map(b => b.id) } });
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
module.exports = { buildHandles };

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; }, flag = n => a.includes('--' + n);
  if (!arg('db')) { console.error('Usage: node code/lab/vault_judge.js --db eval.db [--dry-run] [--max-usd 6] [--max-notes 20] [--limit N] [--shards 3]'); process.exit(1); }
  const version = arg('version', D.DEFAULT_VERSION), db = D.openCopy(arg('db')), burrs = D.loadBurrs(db, version);
  const skip = new Set(D.loadDupes(db, burrs.map(b => b.id)).map(d => d.burr_id));
  let rows = buildHandles(burrs, { maxNotes: +arg('max-notes', 20), skip: skip }); if (arg('limit')) rows = rows.slice(0, +arg('limit'));
  const chars = rows.reduce((s, r) => s + J.systemPrompt('open').length + J.userPrompt(r.input).length, 0), tin = chars / 4, tout = rows.length * 160;
  const est = (tin * 0.30 + tout * 2.50) / 1e6;
  console.log(`${burrs.length} burrs (${skip.size} dupes skipped); ${rows.length} handles with 2..${arg('max-notes', 20)} notes; est. cost $${est.toFixed(2)} (${Math.round(tin / rows.length)} in / 160 out tokens per call)`);
  if (flag('dry-run')) return;
  const { callLLM } = require('../lib/llm'), cache = new JsonlCache(path.join(OUT, 'cache', 'vault_judge.jsonl'));
  const ledger = r => { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify(r) + '\n'); };
  const maxUsd = +arg('max-usd', 6), shards = +arg('shards', 3), parts = Array.from({ length: shards }, (_, i) => rows.filter((_, j) => j % shards === i));
  const res = (await Promise.all(parts.map(p => judgeRows(p, { callLLM: callLLM, cache: cache, ledger: ledger }, { stance: 'open', provider: 'gemini', maxUsd: maxUsd / shards })))).flat();
  const byId = new Map(rows.map(r => [r.id, r])), outDir = path.join(OUT, version); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'vault_judge.jsonl'), res.map(r => JSON.stringify({ id: r.id, handle: byId.get(r.id).input.handle, notes_total: byId.get(r.id).notes_total, verdict: r.verdict, link: r.link, gap: r.gap, why: r.why, burrs: byId.get(r.id).input.burr_ids, claims: byId.get(r.id).input.burrs.map(b => b.claim), error: r.error, cost: r.cost })).join('\n') + '\n');
  const tally = {}; res.forEach(r => { tally[r.verdict] = (tally[r.verdict] || 0) + 1; });
  console.log('verdicts', tally, `spent $${res.reduce((s, r) => s + r.cost, 0).toFixed(4)}; written to ${path.join(outDir, 'vault_judge.jsonl')}`);
  if (tally.error) console.log('errors are not cached: rerun the same command to retry them');
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
