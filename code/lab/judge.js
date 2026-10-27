#!/usr/bin/env node
'use strict';
// Link-judge harness. Reproduces the sparks the author labelled (spark/dull/trivial/held), asks the judge, compares.
//   node code/lab/judge.js --db eval.db --dry-run               count, token and cost estimate; no LLM
//   node code/lab/judge.js --db eval.db --limit 30              first run (small); cached, seeded, capped by --max-usd
//   node code/lab/judge.js --db eval.db                         all labelled sparks
// Options: --label-version all|nug-v4|nug-v5 (default all: each label is rebuilt from the version it was made on)
//          --split dev|test (fixed hash of the id; tune on dev, score on test once)  --stance open|strict  --provider gemini  --seed 7  --max-usd 0.30  --labels muse-judgements.jsonl
// Lab spend is capped per run and logged to code/lab/out/spend.jsonl; it does NOT go through api_budget (that table is in vault.db).
const fs = require('node:fs'), path = require('node:path');
const J = require('./judge_spec'), M = require('./metrics'), D = require('./data');
const Bud = require('../lib/budget');

const OUT = path.join(__dirname, 'out');
const CLASSES = ['yes', 'none', 'held', 'error'];
// Safety floor for lab caps: the higher of lib/budget.js and the gemini-2.5-flash list price ($0.30 in / $2.50 out per 1M, confirmed
// against the Google bill 2026-10-27). budget.js was corrected the same day; the floor stays so a later table edit cannot loosen lab caps.
const LAB_RATES = { gemini: { in: 0.30, out: 2.50 } };
function labRate(provider, model, tokIn) {
  const b = Bud.priceFor(provider, model, tokIn) || { in: 0, out: 0 }, l = LAB_RATES[provider] || { in: 0, out: 0 };
  return { in: Math.max(b.in, l.in), out: Math.max(b.out, l.out) };
}

class JsonlCache {
  constructor(file) { this.file = file; this.map = new Map(); try { fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).forEach(l => { const o = JSON.parse(l); this.map.set(o.k, o); }); } catch (e) { /* empty */ } }
  get(k) { return this.map.get(k); }
  put(k, rec) { rec.k = k; this.map.set(k, rec); fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); }
}
const memCache = () => { const m = new Map(); return { get: k => m.get(k), put: (k, r) => m.set(k, r) }; };

// Pure given deps: rows [{id, truth, input}] -> records. deps = { callLLM, cache, ledger(fn) }.
async function judgeRows(rows, deps, opts) {
  const stance = opts.stance || 'open', provider = opts.provider || 'gemini', maxUsd = opts.maxUsd == null ? 0.3 : opts.maxUsd;
  let spent = 0; const out = [];
  for (const r of rows) {
    const key = J.cacheKey(provider, r.input, stance);
    let hit = deps.cache.get(key), fresh = false, cost = 0;
    if (!hit) {
      if (spent >= maxUsd) { out.push({ id: r.id, truth: r.truth, verdict: 'error', error: 'run cap reached', cached: false, cost: 0 }); continue; }
      try {
        const resp = await deps.callLLM(provider, J.userPrompt(r.input), { system: J.systemPrompt(stance), maxTokens: 600, temperature: 0, thinkingBudget: 0, label: 'lab-judge' });
        const rate = labRate(provider, resp.model, resp.tokensIn || 0);
        cost = ((resp.tokensIn || 0) * rate.in + (resp.tokensOut || 0) * rate.out) / 1e6;
        spent += cost; fresh = true;
        hit = { text: resp.text, model: resp.model, tokensIn: resp.tokensIn || 0, tokensOut: resp.tokensOut || 0, cost: cost };
        deps.cache.put(key, hit);
        if (deps.ledger) deps.ledger({ ts: new Date().toISOString(), task: J.PROMPT_VERSION, provider: provider, model: resp.model, tokensIn: hit.tokensIn, tokensOut: hit.tokensOut, cost: cost, id: r.id });
      } catch (e) { out.push({ id: r.id, truth: r.truth, verdict: 'error', error: 'call failed: ' + e.message, cached: false, cost: 0 }); continue; }
    }
    const p = J.parseVerdict(hit.text, r.input, stance);
    out.push(p.ok ? { id: r.id, truth: r.truth, verdict: p.verdict, link: p.link, burrs: p.burrs, gap: p.gap, why: p.why, model: hit.model, cached: !fresh, cost: cost }
                  : { id: r.id, truth: r.truth, verdict: 'error', error: p.error, model: hit.model, cached: !fresh, cost: cost });
  }
  return out;
}

// Confusion matrix truth x verdict, accuracy, per-class precision/recall, and the share of errors.
function report(recs) {
  const cm = {}; ['yes', 'none', 'held'].forEach(t => { cm[t] = {}; CLASSES.forEach(c => cm[t][c] = 0); });
  recs.forEach(r => { if (cm[r.truth]) cm[r.truth][r.verdict]++; });
  const n = recs.length, correct = recs.filter(r => r.truth === r.verdict).length, per = {};
  ['yes', 'none', 'held'].forEach(c => {
    const tp = cm[c][c], predicted = recs.filter(r => r.verdict === c).length, actual = recs.filter(r => r.truth === c).length;
    per[c] = { precision: predicted ? tp / predicted : NaN, recall: actual ? tp / actual : NaN, n_truth: actual, n_pred: predicted };
  });
  const majority = ['yes', 'none', 'held'].map(c => recs.filter(r => r.truth === c).length).sort((a, b) => b - a)[0] / (n || 1);
  return { n: n, accuracy: n ? correct / n : NaN, majority_baseline: majority, errors: recs.filter(r => r.verdict === 'error').length, confusion: cm, per_class: per };
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; }, flag = n => a.includes('--' + n);
  const dbPath = arg('db'); if (!dbPath) { console.error('Usage: node code/lab/judge.js --db eval.db [--dry-run] [--limit N] [--stance open|strict]'); process.exit(1); }
  const labelVersion = arg('label-version', 'all'), stance = arg('stance', 'open'), provider = arg('provider', 'gemini');
  const lrows = fs.readFileSync(arg('labels', 'muse-judgements.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const byVer = J.sparkLabelsByVersion(lrows);   // each label is rebuilt from the nuggetizer version it was made on
  const versions = labelVersion === 'all' ? Array.from(byVer.keys()) : [labelVersion], version = versions.join('+');
  let rows = [], total = 0;
  for (const v of versions) {
    const labels = byVer.get(v) || new Map(), sparks = new Map(require('../lib/muse_model').build(D.openCopy(dbPath), v, {}).sparks.map(s => [s.id, s]));
    total += labels.size;
    Array.from(labels.entries()).filter(([id]) => sparks.has(id)).forEach(([id, truth]) => rows.push({ id: v + ':' + id, truth: truth, input: J.buildInput(sparks.get(id)) }));
  }
  const missing = total - rows.length, rnd = M.rng(+arg('seed', 7));
  rows = rows.sort((x, y) => x.id.localeCompare(y.id)).map(r => [rnd(), r]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  if (arg('split')) rows = rows.filter(r => J.split(r.id) === arg('split'));   // dev: tune prompts here; test: score once, never tune
  if (arg('limit')) rows = rows.slice(0, +arg('limit'));
  const dist = {}; rows.forEach(r => dist[r.truth] = (dist[r.truth] || 0) + 1);
  console.log(`labelled sparks: ${total} (versions ${versions.join(', ')}); still reproducible: ${total - missing}${missing ? ` (${missing} no longer exist as sparks)` : ''}; judging ${rows.length} ${JSON.stringify(dist)}`);
  const estIn = rows.reduce((s, r) => s + Math.ceil((J.systemPrompt(stance).length + J.userPrompt(r.input).length) / 3.6), 0), estOut = rows.length * 110;
  const rate = labRate(provider, null, 0), est = (estIn * rate.in + estOut * rate.out) / 1e6;
  console.log(`estimate: ~${estIn} input + ~${estOut} output tokens, about $${est.toFixed(3)} at list price (cached rows cost nothing)`);
  if (flag('dry-run')) return;
  const { callLLM } = require('../lib/llm');
  const ledger = rec => { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify(rec) + '\n'); };
  const recs = await judgeRows(rows, { callLLM: callLLM, cache: new JsonlCache(path.join(OUT, 'cache', 'judge.jsonl')), ledger: ledger }, { stance: stance, provider: provider, maxUsd: +arg('max-usd', 0.3) });
  const rep = report(recs), outDir = path.join(OUT, version); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `judge_${J.PROMPT_VERSION}_${stance}.json`), JSON.stringify({ prompt: J.PROMPT_VERSION, stance: stance, version: version, report: rep, records: recs }, null, 1));
  const f = x => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
  console.log(`\naccuracy ${f(rep.accuracy)} (always-${'majority'} baseline ${f(rep.majority_baseline)}), errors ${rep.errors}, spent $${recs.reduce((s, r) => s + r.cost, 0).toFixed(4)}`);
  console.log('\ntruth \\ judge\tyes\tnone\theld\terror'); ['yes', 'none', 'held'].forEach(t => console.log(t + '\t\t' + CLASSES.map(c => rep.confusion[t][c]).join('\t')));
  console.log('\nclass\tprecision\trecall\tn_truth\tn_judged'); ['yes', 'none', 'held'].forEach(c => console.log(`${c}\t${f(rep.per_class[c].precision)}\t\t${f(rep.per_class[c].recall)}\t${rep.per_class[c].n_truth}\t${rep.per_class[c].n_pred}`));
  console.log('\nwritten to ' + path.join(outDir, `judge_${J.PROMPT_VERSION}_${stance}.json`));
}
module.exports = { judgeRows, report, JsonlCache, memCache };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
