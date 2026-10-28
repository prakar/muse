#!/usr/bin/env node
'use strict';
// Quiz backtest (Muse Constitution, Decision 7): do QUARRY's link finders recover the connections quiz setters built?
// Burrs are extracted from the quiz items THEMSELVES with the production nuggetize prompt, into backtest/quiz-burrs.jsonl (gitignored,
// never the vault or vault.db). Truth: burrs from the same quiz item are linked; burrs from different items are not.
//   node code/lab/quiz_backtest.js build [--dry-run] [--max-usd 0.30] [--model M] [--limit N]
//   node code/lab/quiz_backtest.js score [--seed 7]
const fs = require('node:fs'), path = require('node:path');
const { isBoilerplate } = require('./boiler'), B = require('../lib/burrs'), BR = require('../lib/bristles'), Bud = require('../lib/budget'), S = require('./sim'), M = require('./metrics'), { JsonlCache } = require('./judge');
const DIR = path.join(__dirname, '..', '..', 'backtest');

function loadItems(dir) {
  const items = [];
  fs.readdirSync(dir).filter(f => /^items-.*\.jsonl$/.test(f)).forEach(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).forEach(l => {
    const o = JSON.parse(l); if (!o.question) return;
    o.id = (o.source || f) + '#' + o.n; items.push(o);
  }));
  const seen = new Set(); return items.filter(i => (seen.has(i.id) ? false : seen.add(i.id)));
}
const noteOf = it => { const cleaned = B.cleanBody((it.answer ? it.question + '\n\nAnswer: ' + it.answer : it.question).replace(/\u000b/g, '\n')); return { id: it.id, title: 'Quiz item', source_url: null, cleaned: cleaned, real_words: B.realWordCount(cleaned) }; };

async function build(items, deps, opts) {
  let spent = 0; const out = [];
  for (const it of items) {
    const note = noteOf(it); if (note.real_words < 8) continue;
    const key = ['quizbt', B.cacheKey(opts.provider, B.buildInput(note, note.cleaned)), opts.model || ''].join(':');
    let hit = deps.cache.get(key);
    if (!hit) {
      if (opts.dryRun) { out.push({ id: it.id, planned: true }); spent += 0.0004; continue; }
      if (spent >= opts.maxUsd) { out.push({ id: it.id, stopped: 'budget' }); break; }
      const p = B.buildPrompt(note, note.cleaned);
      const r = await deps.callLLM(opts.provider, p.prompt, { system: p.system, maxTokens: 8000, temperature: 0, thinkingBudget: 0, model: opts.model, label: 'lab-quiz-backtest' });
      const cost = Bud.costOf ? Bud.costOf(opts.provider, r.model, r.tokensIn, r.tokensOut) : opts.rate(r.tokensIn || 0, r.tokensOut || 0);
      hit = { text: r.text, model: r.model, cost: cost }; deps.cache.put(key, hit); spent += cost;
      if (deps.ledger) deps.ledger({ ts: new Date().toISOString(), task: 'quiz-backtest', provider: opts.provider, model: r.model, cost: cost, id: it.id });
    }
    if (!hit) continue;
    const parsed = B.parseModelJson(hit.text);
    if (!parsed.ok) { out.push({ id: it.id, error: parsed.error }); continue; }
    const v = B.verifyBurrs(parsed.burrs, note);
    v.accepted.filter(b => !isBoilerplate(b.claim)).forEach((b, i) => out.push({ id: it.id + '/' + i, note_id: it.id, source: it.source, claim: b.claim, kind: b.kind, hooks: b.hooks || [], triple: /\(triple\)/i.test(it.question) }));
  }
  return { burrs: out.filter(b => b.claim), problems: out.filter(b => !b.claim), spent: spent };
}

// Pure: truth pairs. pos = same item; neg = random cross-item (rand), plus hard = cross-item sharing a usable hook key.
function pairsOf(burrs, seed) {
  const rnd = M.rng(seed || 7), by = new Map(); burrs.forEach(b => { if (!by.has(b.note_id)) by.set(b.note_id, []); by.get(b.note_id).push(b); });
  const pos = []; by.forEach(g => { for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) pos.push([g[i], g[j]]); });
  const rand = [], want = Math.max(pos.length * 3, 50);
  for (let t = 0; rand.length < want && t < want * 30; t++) { const a = burrs[Math.floor(rnd() * burrs.length)], b = burrs[Math.floor(rnd() * burrs.length)]; if (a && b && a.note_id !== b.note_id) rand.push([a, b]); }
  const hk = b => b.hooks.map(h => BR.foldKey(h.value)).filter(k => BR.usableKey(k));
  const idx = new Map(); burrs.forEach(b => hk(b).forEach(k => { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(b); }));
  const hard = []; idx.forEach(g => { for (let i = 0; i < g.length && hard.length < want; i++) for (let j = i + 1; j < g.length && hard.length < want; j++) if (g[i].note_id !== g[j].note_id) hard.push([g[i], g[j]]); });
  return { pos: pos, rand: rand, hard: hard };
}
function scoreAll(burrs, pairs, extra) {
  const ix = new Map(burrs.map((b, i) => [b.id, i])), tf = S.tfidfBackend(burrs.map(b => b.claim));
  const hk = b => new Set(b.hooks.map(h => BR.foldKey(h.value)).filter(k => BR.usableKey(k)));
  const fns = { tfidf: (a, b) => tf.sim(ix.get(a.id), ix.get(b.id)), shared_hooks: (a, b) => { const x = hk(a), y = hk(b); let n = 0; x.forEach(k => { if (y.has(k)) n++; }); return n; } };
  Object.assign(fns, extra || {});
  const res = {};
  Object.keys(fns).forEach(name => {
    const sc = p => p.map(([a, b]) => fns[name](a, b)), pos = sc(pairs.pos);
    res[name] = { auc_vs_random: M.auc(pos, sc(pairs.rand)), auc_vs_hard: M.auc(pos, sc(pairs.hard)) };
  });
  return res;
}

// Pure: judge sample. yes = same-item pairs that share a hook (truth: a setter linked them); none = cross-item pairs sharing a hook (truth: no link, per the user).
function judgeRowsOf(burrs, pairs, n, seed) {
  const rnd = M.rng(seed || 7), shared = (a, b) => { const x = new Map(a.hooks.map(h => [BR.foldKey(h.value), h])); for (const h of b.hooks) { const k = BR.foldKey(h.value); if (BR.usableKey(k) && x.has(k)) return x.get(k); } return null; };
  const take = (list, truth) => { const ok = list.map(([a, b]) => ({ a: a, b: b, h: shared(a, b) })).filter(r => r.h); const pick = ok.sort(() => rnd() - 0.5).slice(0, n);
    return pick.map(r => ({ id: truth + ':' + r.a.id + '|' + r.b.id, truth: truth, input: { handle: r.h.value, types: [r.h.type], burrs: [r.a, r.b].map((x, i) => ({ id: i + 1, note: x.id, claim: x.claim, quote: '' })) } })); };
  return take(pairs.pos, 'yes').concat(take(pairs.hard, 'none'));
}
async function main() {
  const cmd = process.argv[2], a = process.argv.slice(3), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  let items = loadItems(DIR); if (arg('limit')) items = items.slice(0, +arg('limit'));
  if (cmd === 'build') {
    const { callLLM } = require('../lib/llm'), provider = arg('provider', 'gemini'), model = arg('model');
    const ledger = r => { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.appendFileSync(path.join(__dirname, 'out', 'spend.jsonl'), JSON.stringify(r) + '\n'); };
    const rate = (i, o) => (i * 0.30 + o * 2.50) / 1e6;
    const r = await build(items, { callLLM: callLLM, cache: new JsonlCache(path.join(DIR, 'cache.jsonl')), ledger: ledger }, { provider: provider, model: model, maxUsd: +arg('max-usd', 0.60), dryRun: a.includes('--dry-run'), rate: rate });
    console.log(`${items.length} items; ${r.burrs.length} burrs; ${r.problems.length} problems; ${a.includes('--dry-run') ? 'planned cost ~' : 'spent '}$${r.spent.toFixed(4)}`);
    if (!a.includes('--dry-run')) fs.writeFileSync(path.join(DIR, 'quiz-burrs.jsonl'), r.burrs.map(b => JSON.stringify(b)).join('\n') + '\n');
  } else if (cmd === 'score') {
    const burrs = fs.readFileSync(path.join(DIR, 'quiz-burrs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const pairs = pairsOf(burrs, +arg('seed', 7)), f = x => Number.isFinite(x) ? x.toFixed(3) : 'n/a';
    const items = new Set(burrs.map(b => b.note_id)).size, multi = new Set(burrs.filter(b => burrs.filter(c => c.note_id === b.note_id).length > 1).map(b => b.note_id)).size;
    console.log(`${burrs.length} burrs from ${items} items (${multi} with >=2 burrs); pairs: ${pairs.pos.length} same-item, ${pairs.rand.length} random cross-item, ${pairs.hard.length} cross-item sharing a hook`);
    const extra = {}, ix = new Map(burrs.map((b, i) => [b.id, i]));
    for (const m of (arg('embed', '') ? arg('embed').split(',') : [])) {
      try { const r = await S.embedAll(require('./embed_ollama').ollamaBackend(m), burrs.map(b => b.claim), new S.EmbedCache(path.join(DIR, 'embed-cache'), m)); console.log(`${m}: embedded ${r.embedded}, cached ${r.cached}`); extra[m] = (x, y) => S.cosDense(r.vecs[ix.get(x.id)], r.vecs[ix.get(y.id)]); }
      catch (e) { console.error(m + ': skipped - ' + e.message); }
    }
    const all = scoreAll(burrs, pairs, extra); console.log('\nmethod\tAUC vs random\tAUC vs hook-sharing');
    Object.keys(all).forEach(k => console.log(`${k}\t${f(all[k].auc_vs_random)}\t\t${f(all[k].auc_vs_hard)}`));
    const tri = burrs.filter(b => b.triple); if (tri.length > 1) { const tp = pairsOf(tri, +arg('seed', 7)), t = scoreAll(tri, tp); console.log(`\ntriples only (${tri.length} burrs, ${tp.pos.length} same-item pairs)`); Object.keys(t).forEach(k => console.log(`${k}\t${f(t[k].auc_vs_random)}\t\t${f(t[k].auc_vs_hard)}`)); }
  } else if (cmd === 'judge') {
    const J = require('./judge'), JS = require('./judge_spec'), { callLLM } = require('../lib/llm');
    const burrs = fs.readFileSync(path.join(DIR, 'quiz-burrs.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const rows = judgeRowsOf(burrs, pairsOf(burrs, +arg('seed', 7)), +arg('n', 60), +arg('seed', 7));
    console.log(rows.length + ' pairs (' + rows.filter(r => r.truth === 'yes').length + ' same-item, ' + rows.filter(r => r.truth === 'none').length + ' cross-item), all sharing a hook');
    if (a.includes('--dry-run')) return;
    const ledger = r => { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.appendFileSync(path.join(__dirname, 'out', 'spend.jsonl'), JSON.stringify(r) + '\n'); };
    const recs = await J.judgeRows(rows, { callLLM: callLLM, cache: new JsonlCache(path.join(DIR, 'judge-cache.jsonl')), ledger: ledger }, { stance: arg('stance', 'open'), provider: 'gemini', maxUsd: +arg('max-usd', 0.5) });
    const rep = J.report(recs), c = rep.confusion, f = x => Number.isFinite(x) ? x.toFixed(2) : 'n/a';
    console.log(`spent $${recs.reduce((t, r) => t + r.cost, 0).toFixed(4)}, errors ${rep.errors}\ntruth\\judge\tyes\tnone\theld\terror`);
    ['yes', 'none'].forEach(t => console.log(t + '\t\t' + ['yes', 'none', 'held', 'error'].map(k => c[t][k]).join('\t')));
    console.log(`P(link | judge says yes) ${f(rep.per_class.yes.precision)}; recall of same-item pairs ${f(rep.per_class.yes.recall)}; cross-item pairs judged none ${f(rep.per_class.none.recall)}`);
    fs.writeFileSync(path.join(DIR, 'judge-results.json'), JSON.stringify({ report: rep, records: recs }, null, 1));
  } else { console.error('usage: quiz_backtest.js build|score|judge'); process.exit(1); }
}
module.exports = { judgeRowsOf, loadItems, noteOf, build, pairsOf, scoreAll };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
