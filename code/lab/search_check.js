#!/usr/bin/env node
'use strict';
// Runs the 43 labelled pilot questions through the REAL search service (the one Muse uses) and tables band against what the vault holds.
// Needs Ollama (for question vectors) and a Gemini key (new questions cost ~$0.0003 each; the rewrite cache from earlier runs is NOT reused here: this fills muse-cache.db).
//   node --no-warnings code/lab/search_check.js [--db vault.db] [--max-usd 0.05]
// Output: code/lab/out/search_check.json and a table. Success = answerable questions land in "likely", unanswerable ones in "nothing" (calibration: 12/18 kept, 2/25 passed).
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const M = require('../lib/muse_model'), Core = require('../lib/search_core'), SV = require('../lib/search_vectors'), SE = require('../lib/search_embed'), SC = require('../lib/search_cache');
const { createRewriter } = require('../lib/search_rewrite'), { createSearchService } = require('../lib/search_service'), LLM = require('../lib/llm'), Bud = require('../lib/budget');

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..', '..'), model = 'embeddinggemma', Q = path.join(__dirname, 'queries');
  const g = JSON.parse(fs.readFileSync(path.join(Q, 'author_grades_keyword_2026-10-29.json'), 'utf8')).grades, h = JSON.parse(fs.readFileSync(path.join(Q, 'author_holdout_2026-10-29.json'), 'utf8'));
  const qs = g.map(x => ({ q: x.query, has: x.vault_has })).concat(h.queries.map((q, i) => ({ q, has: h.vault_has[i] })));
  const m = M.build(new DatabaseSync(arg('db', path.join(HOME, 'vault.db')), { readOnly: true }), 'nug-v6', {});
  const burrs = m.burrs.map(b => ({ id: b.id, noteId: b.noteId, claim: b.claim, quote: b.quote, note: b.note })), byId = new Map(burrs.map(b => [b.id, b]));
  const vectors = SV.load(HOME, model, id => { const b = byId.get(id); return b ? SE.docText(model, b) : undefined; });
  if (!vectors) { console.error('No vector index: run node --no-warnings code/search_build.js first.'); process.exit(1); }
  const cache = SC.open(path.join(HOME, 'muse-cache.db'));
  const svc = createSearchService({ burrs, words: Core.buildWordIndex(burrs), vectors, embedder: SE.ollamaEmbedder({ model }), cache,
    rewriter: createRewriter({ cache, callLLM: LLM.callLLM, hasKey: LLM.hasKey, priceFor: Bud.priceFor, breaker: SE.createBreaker(), config: { provider: 'gemini', maxUsdPerDay: +arg('max-usd', 0.05) } }) });
  const rows = [];
  for (const x of qs) {
    const r = await svc.search({ q: x.q, meaning: true });
    rows.push({ q: x.q, has: x.has, mode: r.mode, band: r.band, top: r.results[0] ? r.results[0].sim : null, cost: r.cost, notices: r.notices.map(n => n.text) });
    console.log((x.has || '?').padEnd(8) + String(r.band).padEnd(9) + (r.results[0] && r.results[0].sim != null ? r.results[0].sim.toFixed(3) : '  -  ') + '  ' + x.q.slice(0, 70));
  }
  const yes = rows.filter(r => r.has === 'present' || r.has === 'partial'), no = rows.filter(r => r.has === 'absent');
  const kept = yes.filter(r => r.band === 'likely').length, passed = no.filter(r => r.band === 'likely').length;
  console.log('\nAnswerable in "closest matches": ' + kept + '/' + yes.length + '   Unanswerable wrongly in "closest matches": ' + passed + '/' + no.length + '   unrated: ' + rows.filter(r => r.band === 'unrated').length + '   spent $' + rows.reduce((s, r) => s + r.cost, 0).toFixed(4));
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'out', 'search_check.json'), JSON.stringify(rows, null, 1));
}
main().catch(e => { console.error('search_check failed: ' + e.message); process.exit(1); });
