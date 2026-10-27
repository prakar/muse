#!/usr/bin/env node
'use strict';
// E2: does an embedding model separate "same fact" pairs from other pairs better than TF-IDF?
//   positives      = cross-note clone pairs already in burr_dupes (kind='clone')
//   random negs    = random burr pairs from different notes, not in burr_dupes
//   hard negatives = pairs from different notes sharing a hook key but NOT in burr_dupes (the case that matters:
//                    "same hook, different fact"). Caveat: some may be unlabelled true duplicates, which depresses AUC for all models equally.
// Usage: node code/lab/e2_bakeoff.js --db eval.db [--version nug-v6] [--models embeddinggemma,qwen3-embedding:0.6b,bge-m3] [--max-pos 1500] [--seed 7]
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), M = require('./metrics'), S = require('./sim'), B = require('../lib/bristles');
const { ollamaBackend } = require('./embed_ollama');

function rng(seed) { let s = seed || 1; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }
const pkey = (a, b) => (a < b ? a + ':' + b : b + ':' + a);

function hookKeys(b) { return (b.hooks || []).map(h => B.foldKey(h.value)).filter(k => B.usableKey(k)); }

// Pure: build labelled pairs from loaded burrs + dupe rows. Returns { pos, rand, hard } of [idA, idB].
function buildPairs(burrs, dupes, opts) {
  opts = opts || {};
  const rnd = rng(opts.seed), byId = new Map(burrs.map(b => [b.id, b]));
  const dupSet = new Set(dupes.map(d => pkey(d.burr_id, d.dup_of)));
  let pos = dupes.filter(d => d.kind === 'clone' && byId.has(d.burr_id) && byId.has(d.dup_of) && byId.get(d.burr_id).note_id !== byId.get(d.dup_of).note_id).map(d => [d.burr_id, d.dup_of]);
  if (opts.maxPos && pos.length > opts.maxPos) pos = pos.slice().sort(() => rnd() - 0.5).slice(0, opts.maxPos);
  const want = Math.max(pos.length * 3, 30), rand = [], seen = new Set();
  for (let tries = 0; rand.length < want && tries < want * 20; tries++) {
    const a = burrs[Math.floor(rnd() * burrs.length)], b = burrs[Math.floor(rnd() * burrs.length)];
    if (!a || !b || a.id === b.id || a.note_id === b.note_id) continue;
    const k = pkey(a.id, b.id); if (dupSet.has(k) || seen.has(k)) continue;
    seen.add(k); rand.push([a.id, b.id]);
  }
  const byKey = new Map();
  burrs.forEach(b => hookKeys(b).forEach(k => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(b); }));
  const hard = [], hseen = new Set(), keys = Array.from(byKey.keys()).filter(k => byKey.get(k).length > 1 && byKey.get(k).length <= 40);
  for (let tries = 0; hard.length < want && tries < want * 20 && keys.length; tries++) {
    const g = byKey.get(keys[Math.floor(rnd() * keys.length)]);
    const a = g[Math.floor(rnd() * g.length)], b = g[Math.floor(rnd() * g.length)];
    if (a.id === b.id || a.note_id === b.note_id) continue;
    const k = pkey(a.id, b.id); if (dupSet.has(k) || hseen.has(k)) continue;
    hseen.add(k); hard.push([a.id, b.id]);
  }
  return { pos: pos, rand: rand, hard: hard };
}

function summarise(name, scorePairs, mask) {
  const f = (pos, neg) => M.auc(pos, neg);
  const out = { model: name, n_pos: scorePairs.pos.length };
  if (mask) {   // positives TF-IDF finds hard (paraphrase-like): the only place embeddings can add anything
    const sub = scorePairs.pos.filter((_, i) => mask[i]);
    out.n_pos_para = sub.length;
    out.auc_para = sub.length >= 10 ? f(sub, scorePairs.hard) : NaN;
  }
  ['rand', 'hard'].forEach(k => {
    out['auc_' + k] = f(scorePairs.pos, scorePairs[k]);
    out['ci_' + k] = M.bootstrapCI(f, scorePairs.pos, scorePairs[k], 200, 3);
    out['n_' + k] = scorePairs[k].length;
  });
  return out;
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const dbPath = arg('db'), version = arg('version', D.DEFAULT_VERSION);
  if (!dbPath) { console.error('Usage: node code/lab/e2_bakeoff.js --db eval.db [--version nug-v6] [--models m1,m2]'); process.exit(1); }
  const models = arg('models', 'embeddinggemma,qwen3-embedding:0.6b,bge-m3').split(',').filter(Boolean);
  const db = D.openCopy(dbPath), burrs = D.loadBurrs(db, version), dupes = D.loadDupes(db, burrs.map(b => b.id));
  const pairs = buildPairs(burrs, dupes, { maxPos: +arg('max-pos', 1500), seed: +arg('seed', 7) });
  console.log(`${version}: ${burrs.length} burrs, ${pairs.pos.length} clone pairs, ${pairs.rand.length} random negs, ${pairs.hard.length} hard negs`);
  if (pairs.pos.length < 30) { console.error('Too few clone pairs - run dedupe on ' + version + ' first.'); process.exit(2); }
  const byId = new Map(burrs.map(b => [b.id, b])), involved = Array.from(new Set([].concat(pairs.pos, pairs.rand, pairs.hard).flat()));
  const texts = involved.map(id => D.burrText(byId.get(id))), idx = new Map(involved.map((id, i) => [id, i]));
  const results = [];
  // TF-IDF with IDF over ALL burrs (as production would), vectors for involved ones
  const toksAll = burrs.map(b => B.tokens(D.burrText(b))), idf = B.buildIdf(toksAll);
  const tv = new Map(burrs.map((b, i) => [b.id, B.vectorOf(toksAll[i], idf)]));
  const score = (pl, simf) => ({ pos: pl.pos.map(p => simf(p[0], p[1])), rand: pl.rand.map(p => simf(p[0], p[1])), hard: pl.hard.map(p => simf(p[0], p[1])) });
  const tfSim = (x, y) => B.cosine(tv.get(x), tv.get(y)), thr = +arg('para-below', 0.85);
  const mask = pairs.pos.map(p => tfSim(p[0], p[1]) < thr);   // "paraphrase-like" positives
  console.log(`positives with TF-IDF cosine < ${thr}: ${mask.filter(Boolean).length} of ${pairs.pos.length} (exact/near-exact clones are trivial for any model)`);
  results.push(summarise('tfidf', score(pairs, tfSim), mask));
  const cacheDir = path.join(__dirname, 'out', 'cache');
  for (const m of models) {
    try {
      const cache = new S.EmbedCache(cacheDir, m), r = await S.embedAll(ollamaBackend(m), texts, cache);
      console.log(`${m}: embedded ${r.embedded}, cached ${r.cached}`);
      results.push(summarise(m, score(pairs, (x, y) => S.cosDense(r.vecs[idx.get(x)], r.vecs[idx.get(y)])), mask));
    } catch (e) { console.error(`${m}: skipped - ${e.message}`); }
  }
  const outDir = path.join(__dirname, 'out', version); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'e2_results.json'), JSON.stringify({ version: version, ts: new Date().toISOString(), burrs: burrs.length, results: results }, null, 1));
  const fx = x => x.toFixed(3);
  console.log('\nmodel\tAUC vs random\t[95% CI]\tAUC vs same-hook (hard)\t[95% CI]\tparaphrase-like pos AUC (n)');
  results.forEach(r => console.log(`${r.model}\t${fx(r.auc_rand)}\t[${fx(r.ci_rand[0])},${fx(r.ci_rand[1])}]\t${fx(r.auc_hard)}\t[${fx(r.ci_hard[0])},${fx(r.ci_hard[1])}]\t${fx(r.auc_para)} (${r.n_pos_para})`));
  console.log('\nwritten to ' + path.join(outDir, 'e2_results.json'));
}
module.exports = { buildPairs, summarise };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
