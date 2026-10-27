#!/usr/bin/env node
'use strict';
// Knot-sense test: for a key shared by several notes, do its burrs use ONE sense ("same sense") or several ("polyseme"/"homonym")?
// Score per key = mean pairwise similarity of the claims of its burrs (one burr per note, max 12), with the key's own words
// stripped so a shared surface word cannot do the work. Ground truth = the user's knot labels in muse-judgements.jsonl.
// Usage: node code/lab/knot_sense.js --db eval.db [--labels muse-judgements.jsonl] [--version nug-v4] [--models m1,m2]
// (labels were made on nug-v4, so burrs default to the label version; try --version nug-v6 for robustness)
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), M = require('./metrics'), S = require('./sim'), B = require('../lib/bristles');
const { ollamaBackend } = require('./embed_ollama');
const POS = new Set(['same sense']), NEG = new Set(['polyseme', 'homonym']);

// Pure: latest same-sense / polyseme / homonym label per key. Returns Map key -> 1 (same sense) | 0 (several senses).
function senseLabels(rows, labelVersion) {
  const m = new Map();
  rows.filter(r => r.view === 'knots' && (!labelVersion || r.version === labelVersion) && (POS.has(r.label) || NEG.has(r.label)))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts))).forEach(r => m.set(r.id, POS.has(r.label) ? 1 : 0));
  return m;
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function strip(claim, key) { return key.split(' ').filter(Boolean).reduce((t, w) => t.replace(new RegExp('\\b' + esc(w) + '\\b', 'gi'), ' '), String(claim)).replace(/\s+/g, ' ').trim(); }

// Pure: burrs per labelled key, one per note, max 12, deterministic.
function burrsByKey(burrs, keys) {
  const want = new Set(keys), out = new Map(), seen = new Map();
  burrs.slice().sort((a, b) => a.id - b.id).forEach(b => (b.hooks || []).forEach(h => {
    const k = B.foldKey(h.value); if (!want.has(k)) return;
    if (!seen.has(k)) { seen.set(k, new Set()); out.set(k, []); }
    if (seen.get(k).has(b.note_id) || out.get(k).length >= 12) return;
    seen.get(k).add(b.note_id); out.get(k).push(b);
  }));
  return out;
}
function meanPairwise(n, sim) { let s = 0, c = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { s += sim(i, j); c++; } return c ? s / c : NaN; }

// Pure given a similarity factory: texts[] -> (i,j)->sim. Returns [{key, label, n, score}].
function scoreKnots(byKey, labels, simFor) {
  const rows = [];
  byKey.forEach((bs, key) => {
    if (bs.length < 2) return;
    const texts = bs.map(b => strip(D.burrText(b), key));
    rows.push({ key: key, label: labels.get(key), n: bs.length, score: meanPairwise(texts.length, simFor(texts)) });
  });
  return rows;
}
function aucOf(rows) {
  const pos = rows.filter(r => r.label === 1).map(r => r.score), neg = rows.filter(r => r.label === 0).map(r => r.score);
  return { auc: M.auc(pos, neg), ci: M.bootstrapCI(M.auc, pos, neg, 400, 5), n_pos: pos.length, n_neg: neg.length };
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const dbPath = arg('db'); if (!dbPath) { console.error('Usage: node code/lab/knot_sense.js --db eval.db [--labels file] [--version nug-v4] [--models m1,m2]'); process.exit(1); }
  const labelVersion = arg('label-version', 'nug-v4'), version = arg('version', labelVersion);
  const models = arg('models', 'embeddinggemma,qwen3-embedding:0.6b,bge-m3').split(',').filter(Boolean);
  const rowsL = fs.readFileSync(arg('labels', 'muse-judgements.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const labels = senseLabels(rowsL, labelVersion), burrs = D.loadBurrs(D.openCopy(dbPath), version), byKey = burrsByKey(burrs, Array.from(labels.keys()));
  console.log(`labels: ${labels.size} keys (${Array.from(labels.values()).filter(Boolean).length} same sense); keys with >=2 notes of ${version} burrs: ${Array.from(byKey.values()).filter(x => x.length >= 2).length}`);
  const idf = B.buildIdf(burrs.map(b => B.tokens(D.burrText(b))));
  const results = [], perKey = {};
  const run = (name, rows) => { results.push(Object.assign({ model: name }, aucOf(rows))); perKey[name] = rows; };
  run('tfidf', scoreKnots(byKey, labels, texts => { const v = texts.map(t => B.vectorOf(B.tokens(t), idf)); return (i, j) => B.cosine(v[i], v[j]); }));
  const cacheDir = path.join(__dirname, 'out', 'cache');
  for (const m of models) {
    try {
      const cache = new S.EmbedCache(cacheDir, m), be = ollamaBackend(m), rows = [];
      const all = []; byKey.forEach((bs, key) => { if (bs.length >= 2) bs.forEach(b => all.push(strip(D.burrText(b), key))); });
      const r = await S.embedAll(be, all, cache); const lookup = new Map(all.map((t, i) => [t, r.vecs[i]]));
      console.log(`${m}: embedded ${r.embedded}, cached ${r.cached}`);
      run(m, scoreKnots(byKey, labels, texts => { const v = texts.map(t => lookup.get(t)); return (i, j) => S.cosDense(v[i], v[j]); }));
    } catch (e) { console.error(`${m}: skipped - ${e.message}`); }
  }
  const outDir = path.join(__dirname, 'out', version); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'knot_sense.json'), JSON.stringify({ version: version, labelVersion: labelVersion, results: results, perKey: perKey }, null, 1));
  const fx = x => x.toFixed(3);
  console.log('\nmodel\tAUC (same sense vs polyseme/homonym)\t[95% CI]\tn_same\tn_multi');
  results.forEach(r => console.log(`${r.model}\t${fx(r.auc)}\t[${fx(r.ci[0])},${fx(r.ci[1])}]\t${r.n_pos}\t${r.n_neg}`));
  // keys where models disagree most with the label (for eyeballing)
  const best = results.slice().sort((x, y) => y.auc - x.auc)[0];
  if (best) { console.log('\nlowest-scoring "same sense" and highest-scoring "multi-sense" keys under ' + best.model + ':');
    const rs = perKey[best.model]; rs.filter(r => r.label === 1).sort((x, y) => x.score - y.score).slice(0, 5).forEach(r => console.log('  same sense, low  ', fx(r.score), r.key));
    rs.filter(r => r.label === 0).sort((x, y) => y.score - x.score).slice(0, 5).forEach(r => console.log('  multi sense, high', fx(r.score), r.key)); }
}
module.exports = { senseLabels, strip, burrsByKey, scoreKnots, aucOf };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
