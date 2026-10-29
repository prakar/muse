#!/usr/bin/env node
'use strict';
// Query-rewrite test for the search pilot (roadmap C2, "tune"). Two cheap levers on the 30 author questions:
//   Lever 1 (free): show a wider list, grouped by note (top 10, at most 2 per note) instead of the top 3.
//   Lever 2 (about one cent): one LLM call per question rewrites it as a short plain-language passage with concrete terms and idioms spelled out
//   (the "hypothetical answer" technique), and that passage is embedded and searched. Each rewrite is cached, so reruns cost nothing.
// Needs: semantic_pilot.js already run (vectors in code/lab/out/cache), Ollama running, and the LLM key Quarry's other lab scripts use.
//   node --no-warnings code/lab/query_rewrite.js --db eval.db --dry-run
//   node --no-warnings code/lab/query_rewrite.js --db eval.db [--provider gemini] [--max-usd 0.10]
// Output: out/<version>/query_rewrite_<model>.md and .json. Reads the DB copy; writes only code/lab/out.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const D = require('./data'), SB = require('./search_baseline'), SP = require('./semantic_pilot'), { ollamaBackend } = require('./embed_ollama'), { diversify } = require('./quiz_seeds');

const SYSTEM = 'You help search a personal collection of short factual notes. You never answer the question to the user; you only write text that will be matched against notes.';

// Pure: the rewrite prompt. The output is used for matching, so it must name concrete things a note would contain.
function buildPrompt(question) {
  return 'A person asked this question of their notes:\n\n"' + String(question).trim() + '"\n\n' +
    'Write 2 to 3 short factual sentences that a note answering it might contain. Use concrete names, technical terms, places and dates a note would use. ' +
    'If the question contains an idiom or slang, state what it means in plain words. If its premise looks wrong, write what the notes would more likely say. ' +
    'End with a line "Terms:" listing 6 to 10 search terms. Plain text only.';
}
// Pure: tidy a model reply (fences, leading labels) into the text that gets embedded.
function cleanRewrite(t) { return String(t || '').replace(/```[a-z]*\n?/gi, '').replace(/^\s*(here[^\n]*:|sentences?:)\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 900); }

function loadVectors(file, model, texts) {
  const m = new Map();
  fs.readFileSync(file, 'utf8').split('\n').forEach(l => { if (!l) return; try { const j = JSON.parse(l); m.set(j.h, j.v); } catch (e) { /* torn last line */ } });
  const key = t => crypto.createHash('sha1').update(model + '\u0000' + t).digest('hex');
  return { vecs: texts.map(t => m.get(key(t)) || null), key: key, map: m };
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/query_rewrite.js --db eval.db [--dry-run] [--provider gemini] [--max-usd 0.10] [--model embeddinggemma]'); process.exit(1); }
  const model = arg('model', 'embeddinggemma'), version = arg('version', D.DEFAULT_VERSION), provider = arg('provider', 'gemini'), maxUsd = +arg('max-usd', 0.1), dry = a.includes('--dry-run');
  const P = SP.promptsFor(model);
  const qs = JSON.parse(fs.readFileSync(path.resolve(arg('queries', path.join(__dirname, 'queries', 'author_queries_2026-10-29.json'))), 'utf8')).queries;
  const outRoot = path.join(__dirname, 'out'), rewriteCache = path.join(outRoot, 'cache', 'query_rewrite.jsonl');
  const have = new Map(); if (fs.existsSync(rewriteCache)) fs.readFileSync(rewriteCache, 'utf8').split('\n').forEach(l => { if (!l) return; try { const j = JSON.parse(l); have.set(j.q, j); } catch (e) { /* skip */ } });
  const todo = qs.filter(q => !have.has(q));
  if (dry) { console.log(qs.length + ' questions, ' + todo.length + ' need a rewrite. Rough cost: $' + (todo.length * 0.0006).toFixed(3) + ' (about 250 tokens in, 200 out each on a flash-class model).'); return; }
  if (todo.length) {
    const Bud = require('../lib/budget'), callLLM = require('../lib/llm').callLLM; let spent = 0; fs.mkdirSync(path.dirname(rewriteCache), { recursive: true });
    for (const q of todo) {
      if (spent >= maxUsd) { console.error('budget cap $' + maxUsd + ' reached; rerun to continue (rewrites are cached)'); break; }
      const r = await callLLM(provider, buildPrompt(q), { system: SYSTEM, maxTokens: 400, temperature: 0, thinkingBudget: 0, label: 'query-rewrite' });
      const rate = Bud.priceFor(provider, r.model, r.tokensIn || 0), cost = rate ? ((r.tokensIn || 0) * rate.in + (r.tokensOut || 0) * rate.out) / 1e6 : 0; spent += cost;
      const rec = { q: q, rewrite: cleanRewrite(r.text), model: r.model }; have.set(q, rec);
      fs.appendFileSync(rewriteCache, JSON.stringify(rec) + '\n');
      fs.appendFileSync(path.join(outRoot, 'spend.jsonl'), JSON.stringify({ ts: new Date().toISOString(), task: 'query-rewrite', provider: provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: cost }) + '\n');
    }
    console.log('rewrites done; spent $' + spent.toFixed(4));
  }
  const db = D.openCopy(arg('db')), index = SB.buildIndex(db, version);
  const rows = index.idx.prepare('SELECT f.rowid AS r, f.claim, f.title FROM f ORDER BY f.rowid').all();
  const byRow = new Map(index.idx.prepare('SELECT id, burr_id, note_id FROM meta').all().map(m => [m.id, m]));
  const cacheFile = path.join(outRoot, 'cache', 'pilot_' + model.replace(/[^\w.-]/g, '_') + '.jsonl');
  const L = loadVectors(cacheFile, model, rows.map(r => P.doc(r.claim, r.title)));
  if (L.vecs.some(v => !v)) { console.error('Some claims have no vector; run semantic_pilot.js to completion first.'); process.exit(1); }
  const be = ollamaBackend(model, { url: arg('url', undefined), timeoutMs: 300000 });
  const withRw = qs.map(q => ({ q: q, rw: (have.get(q) || {}).rewrite || '' }));
  const variants = {
    plain: withRw.map(x => P.query(x.q)),
    rewrite: withRw.map(x => P.doc(x.rw || x.q, '')),          // the hypothetical passage, embedded like a document
    combined: withRw.map(x => P.query(x.q + '\n' + x.rw))      // question plus passage, embedded like a query
  };
  const qvecs = {}; for (const k of Object.keys(variants)) qvecs[k] = await be.embed(variants[k]);
  const noteOf = i => byRow.get(rows[i].r).note_id;
  const fmt = (i, sims) => ({ burr_id: byRow.get(rows[i].r).burr_id, claim: rows[i].claim, title: rows[i].title, sim: +sims[i].toFixed(3) });
  const rowOfBurr = new Map(rows.map((r, i) => [byRow.get(r.r).burr_id, i]));
  const results = qs.map((q, qi) => {
    const out = { id: qi + 1, query: q, rewrite: withRw[qi].rw };
    const orders = {};
    Object.keys(qvecs).forEach(k => {
      const sims = L.vecs.map(v => SP.cosine(qvecs[k][qi], v)), order = SP.topK(sims, 80); orders[k] = order;
      out[k + '_top3'] = order.slice(0, 3).map(i => fmt(i, sims));
      out[k + '_top10_grouped'] = diversify(order, noteOf, 2, 10).map(i => fmt(i, sims));
    });
    // Fusion: the plain question, the rewrite and keyword search vote together (reciprocal rank fusion). Safer than the rewrite alone:
    // an exact hit the rewrite loses (Q15 Water ATM) survives if the plain or keyword list still has it.
    const kwOrder = SB.search(index, q, 80).hits.map(h => rowOfBurr.get(h.burr_id)).filter(x => x != null);
    const simsRw = L.vecs.map(v => SP.cosine(qvecs.rewrite[qi], v));
    out.fused_top3 = SP.rrf([orders.plain, orders.rewrite, kwOrder], 3).map(i => fmt(i, simsRw));
    out.fused_top10_grouped = diversify(SP.rrf([orders.plain, orders.rewrite, kwOrder], 40), noteOf, 2, 10).map(i => fmt(i, simsRw));
    return out;
  });
  const outDir = path.join(outRoot, version); fs.mkdirSync(outDir, { recursive: true });
  const base = 'query_rewrite_' + model.replace(/[^\w.-]/g, '_') + (arg('tag', '') ? '_' + arg('tag', '') : '');
  fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({ model, provider, results }, null, 2));
  const md = ['# Query rewrite test: ' + model, '', 'plain = the question as asked (top 3, and top 10 grouped by note, max 2 per note); rewrite = the model\'s passage; combined = question + passage.', ''];
  results.forEach(r => {
    md.push('## ' + r.id + '. ' + r.query, '*rewrite:* ' + r.rewrite.slice(0, 400), '');
    [['plain_top3', 'plain top 3'], ['plain_top10_grouped', 'plain top 10 grouped'], ['rewrite_top3', 'rewrite top 3'], ['combined_top3', 'combined top 3'], ['fused_top3', 'FUSED (plain + rewrite + keyword) top 3'], ['fused_top10_grouped', 'FUSED top 10 grouped']].forEach(([k, label]) => { md.push('**' + label + '**'); r[k].forEach((h, j) => md.push((j + 1) + '. ' + h.claim.slice(0, 150) + '  *(' + String(h.title).slice(0, 40) + ')*  ' + h.sim)); md.push(''); });
  });
  fs.writeFileSync(path.join(outDir, base + '.md'), md.join('\n'));
  console.log('Written ' + path.join(outDir, base + '.md'));
}

module.exports = { buildPrompt, cleanRewrite };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
