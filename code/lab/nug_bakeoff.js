#!/usr/bin/env node
'use strict';
// Nuggetizer bake-off: does a cheaper model extract as well as the baseline, as far as CODE can tell?
// Baseline = the cached gemini-2.5-flash responses already in nuggetize_cache (free). Candidate = the pinned model, run on the same notes.
// Both go through the same parser and verifier (burrs.js), so the comparison is deterministic: parse failures, burrs per note,
// rejects and their reasons, hook typing, and how much of one model's evidence (quote spans) the other also found.
// It never writes to vault.db or the vault.
//   node code/lab/nug_bakeoff.js --db eval.db --dry-run
//   node code/lab/nug_bakeoff.js --db eval.db --n 100 --model gemini-2.5-flash-lite
// Options: --n 100  --seed 7  --max-usd 0.25  --provider gemini  --baseline-model (label only)
const fs = require('node:fs'), path = require('node:path');
const B = require('../lib/burrs'), Bud = require('../lib/budget'), D = require('./data'), M = require('./metrics');
const { JsonlCache } = require('./judge');
const OUT = path.join(__dirname, 'out');

function loadNote(row) {   // same reading as nuggetizer.js loadNote
  const raw = fs.readFileSync(row.filepath, 'utf8'), { body } = B.splitFrontmatter(raw), cleaned = B.cleanBody(body);
  return { id: row.id, title: row.title || path.basename(row.filepath, '.md'), source_url: row.source_url, cleaned: cleaned, real_words: B.realWordCount(cleaned) };
}
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const toks = s => new Set(norm(s).split(' ').filter(w => w.length > 2));
function covered(q, others) {   // is this quote span (mostly) contained in, or overlapping, some span of the other model?
  const a = toks(q); if (!a.size) return false;
  return others.some(o => { const b = toks(o); let i = 0; a.forEach(x => { if (b.has(x)) i++; }); return i / Math.min(a.size, b.size) >= 0.6; });
}

// Pure: parse + verify one response text for a note. Returns stats and the accepted burrs.
function evaluate(text, note) {
  const parsed = B.parseModelJson(text);
  if (!parsed.ok) return { parsed: false, error: parsed.error, accepted: [], rejected: [] };
  const v = B.verifyBurrs(parsed.burrs, note);
  return { parsed: true, accepted: v.accepted, rejected: v.rejected };
}

function summarise(evals) {
  const ok = evals.filter(e => e.parsed), reasons = {};
  let hooks = 0, typed = 0, xc = 0, tn = 0, accepted = 0, rejected = 0;
  ok.forEach(e => { accepted += e.accepted.length; rejected += e.rejected.length; e.rejected.forEach(r => { const k = String(r.reason).replace(/[0-9]+/g, 'N').slice(0, 60); reasons[k] = (reasons[k] || 0) + 1; });
    e.accepted.forEach(b => (b.hooks || []).forEach(h => { hooks++; if (h.type === 'time' || h.type === 'number') { tn++; if (h.era || h.unit) typed++; if (h.xc) xc++; } })); });
  return { notes: evals.length, parse_failures: evals.length - ok.length, accepted_per_note: ok.length ? accepted / ok.length : NaN, reject_rate: (accepted + rejected) ? rejected / (accepted + rejected) : NaN,
    hooks_per_burr: accepted ? hooks / accepted : NaN, time_number_hooks: tn, typed_share: tn ? typed / tn : NaN, xc_share: tn ? xc / tn : NaN,
    top_reject_reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5) };
}

// Evidence overlap over notes where both parsed: share of A's burrs whose quote the other model also found, and vice versa.
function overlap(pairs) {
  let aN = 0, aHit = 0, bN = 0, bHit = 0;
  pairs.forEach(([a, b]) => { if (!a.parsed || !b.parsed) return; const aq = a.accepted.map(x => x.quote), bq = b.accepted.map(x => x.quote);
    aq.forEach(q => { aN++; if (covered(q, bq)) aHit++; }); bq.forEach(q => { bN++; if (covered(q, aq)) bHit++; }); });
  return { baseline_found_by_candidate: aN ? aHit / aN : NaN, candidate_found_by_baseline: bN ? bHit / bN : NaN };
}

async function run(rows, deps, opts) {
  const out = []; let spent = 0;
  for (const row of rows) {
    const note = deps.loadNote(row), input = B.buildInput(note, note.cleaned);
    const baseKey = B.cacheKey(opts.provider, input), base = deps.baseline(baseKey);
    if (!base) { out.push({ id: row.id, skipped: 'no cached baseline' }); continue; }
    const key = ['bakeoff', opts.model, baseKey].join(':'); let hit = deps.cache.get(key);
    if (!hit) {
      if (spent >= opts.maxUsd) { out.push({ id: row.id, skipped: 'run cap reached' }); continue; }
      try {
        const p = B.buildPrompt(note, note.cleaned);
        const r = await deps.callLLM(opts.provider, p.prompt, { system: p.system, maxTokens: 8000, temperature: 0, thinkingBudget: 0, model: opts.model, label: 'lab-nug-bakeoff' });
        const rate = opts.rate, cost = ((r.tokensIn || 0) * rate.in + (r.tokensOut || 0) * rate.out) / 1e6; spent += cost;
        hit = { text: r.text, model: r.model, tokensIn: r.tokensIn || 0, tokensOut: r.tokensOut || 0, cost: cost }; deps.cache.put(key, hit);
        if (deps.ledger) deps.ledger({ ts: new Date().toISOString(), task: 'nug-bakeoff', provider: opts.provider, model: r.model, tokensIn: hit.tokensIn, tokensOut: hit.tokensOut, cost: cost, id: row.id });
      } catch (e) { out.push({ id: row.id, skipped: 'call failed: ' + e.message }); continue; }
    }
    out.push({ id: row.id, title: note.title, base: evaluate(base, note), cand: evaluate(hit.text, note), cost: hit.cost, tokens: [hit.tokensIn, hit.tokensOut] });
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const dbPath = arg('db'); if (!dbPath) { console.error('Usage: node code/lab/nug_bakeoff.js --db eval.db [--dry-run] [--n 100] [--model gemini-2.5-flash-lite]'); process.exit(1); }
  const provider = arg('provider', 'gemini'), model = arg('model', 'gemini-2.5-flash-lite'), n = +arg('n', 100), maxUsd = +arg('max-usd', 0.25);
  const db = D.openCopy(dbPath), rnd = M.rng(+arg('seed', 7));
  const rows = db.prepare("SELECT n.id, n.title, n.filepath, n.source_url FROM vault_notes n JOIN nuggetize_status s ON s.note_id=n.id WHERE s.prompt_version='nug-v6' AND s.status='ok' ORDER BY n.id").all()
    .map(r => [rnd(), r]).sort((x, y) => x[0] - y[0]).slice(0, n).map(x => x[1]);
  const baseline = key => { const r = db.prepare('SELECT response_text FROM nuggetize_cache WHERE cache_key=?').get(key); return r ? r.response_text : null; };
  const rate = (Bud.priceFor(provider, model, 0) || { in: 0, out: 0 });
  console.log(`notes sampled: ${rows.length} (seed ${arg('seed', 7)}); candidate ${model} at $${rate.in}/$${rate.out} per 1M; baseline = cached flash responses`);
  const est = rows.length * (1800 * rate.in + 650 * rate.out) / 1e6; console.log(`estimate for ${rows.length} fresh calls: about $${est.toFixed(3)}`);
  if (a.includes('--dry-run')) return;
  const { callLLM } = require('../lib/llm');
  const ledger = rec => { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify(rec) + '\n'); };
  const res = await run(rows, { loadNote: loadNote, baseline: baseline, callLLM: callLLM, cache: new JsonlCache(path.join(OUT, 'cache', 'nug_bakeoff.jsonl')), ledger: ledger }, { provider: provider, model: model, maxUsd: maxUsd, rate: rate });
  const done = res.filter(r => r.base), skipped = res.filter(r => r.skipped), fx = x => Number.isFinite(x) ? x.toFixed(3) : 'n/a';
  const sb = summarise(done.map(r => r.base)), sc = summarise(done.map(r => r.cand)), ov = overlap(done.map(r => [r.base, r.cand]));
  console.log(`\ncompared ${done.length} notes, skipped ${skipped.length}${skipped.length ? ' (' + Array.from(new Set(skipped.map(s => s.skipped))).join('; ') + ')' : ''}; spent $${done.reduce((s, r) => s + (r.cost || 0), 0).toFixed(4)}`);
  console.log('\nmetric\tbaseline(flash)\tcandidate');
  ['parse_failures', 'accepted_per_note', 'reject_rate', 'hooks_per_burr', 'typed_share', 'xc_share'].forEach(k => console.log(`${k}\t${fx(sb[k])}\t${fx(sc[k])}`));
  console.log(`\nevidence overlap: ${fx(ov.baseline_found_by_candidate)} of flash's quote spans also found by ${model}; ${fx(ov.candidate_found_by_baseline)} of ${model}'s found by flash`);
  console.log('top reject reasons, flash: ' + JSON.stringify(sb.top_reject_reasons) + '\ntop reject reasons, candidate: ' + JSON.stringify(sc.top_reject_reasons));
  console.log('\nfive notes to eyeball (claims, flash vs candidate):');
  done.slice(0, 5).forEach(r => { console.log('\n# ' + r.title); console.log('  flash: ' + r.base.accepted.slice(0, 3).map(b => b.claim).join(' | ').slice(0, 400)); console.log('  cand : ' + r.cand.accepted.slice(0, 3).map(b => b.claim).join(' | ').slice(0, 400)); });
  const outDir = path.join(OUT, 'nug-v6'); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `nug_bakeoff_${model}.json`), JSON.stringify({ model: model, baseline: sb, candidate: sc, overlap: ov, notes: done.map(r => ({ id: r.id, title: r.title, base: r.base.accepted.length, cand: r.cand.accepted.length })) }, null, 1));
}
module.exports = { evaluate, summarise, overlap, run, covered };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
