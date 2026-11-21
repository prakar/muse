'use strict';
/**
 * QUARRY lab/relation_burrs.js — read the relation each burr STATES (cause, named-for, inspired-by...) from its own sentence.
 * Burrs are sent in batches of 8 (one short instruction, eight facts). The model quotes the words that state the relation; code checks the quote is in the fact.
 * A relation with no found quote is kept but marked weak. Every call goes through lib/llm.js (the resolver picks the model).
 *   node code/lab/relation_burrs.js run [--provider grok] [--limit N] [--dry-run] [--max-usd 0.50]   -> backtest/relation-burrs.jsonl (gitignored)
 *   node code/lab/relation_burrs.js sample [--n 12] [--seed 1]   (prints a spread of results by relation, for checking)
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { RELATIONS } = require('./relation_pilot');
const DIR = path.join(__dirname, '..', '..', 'backtest'), BATCH = 8;

const SYSTEM = 'You read short facts, each with a number. For each fact, say which relations the fact itself states between the things it mentions. ' +
  'Choose only from this list, and only when the words of the fact state or plainly imply it:\n' + Object.keys(RELATIONS).map(k => '- ' + k + ': ' + RELATIONS[k]).join('\n') +
  '\nFor each relation give "quote": the exact words from the fact that state it (at most 20 words, copied, "..." allowed to join pieces). Most facts state none; do not force one. ' +
  'Reply with JSON only: {"facts":[{"n":1,"relations":[{"r":"cause","quote":"..."}]},{"n":2,"relations":[]}]} with one entry for every fact.';

const userPrompt = batch => batch.map((b, i) => (i + 1) + '. ' + b.claim).join('\n');
const norm = s => String(s).toLowerCase().replace(/[“”‘’"']/g, '').replace(/\s+/g, ' ').trim();
const found = (quote, claim) => { const c = norm(claim); return norm(quote).split(/\s*(?:\.\.\.|\[\.\.\.\]|…)\s*/).filter(Boolean).every(p => c.indexOf(p) >= 0); };
function firstObject(t) { const s = t.indexOf('{'); if (s < 0) return null; let d = 0; for (let i = s; i < t.length; i++) { if (t[i] === '{') d++; else if (t[i] === '}' && --d === 0) return t.slice(s, i + 1); } return null; }

// -> { ok, byId: Map(burr id -> [{r, quote, weak}]) }
function parseBatch(text, batch) {
  const j = firstObject(String(text || '')); if (j == null) return { ok: false };
  let o; try { o = JSON.parse(j); } catch (e) { return { ok: false }; } if (!Array.isArray(o.facts)) return { ok: false };
  const byId = new Map(batch.map(b => [b.id, []]));
  o.facts.forEach(f => {
    const b = batch[(+f.n) - 1]; if (!b || !Array.isArray(f.relations)) return;
    f.relations.forEach(x => { if (x && RELATIONS[x.r]) byId.get(b.id).push({ r: x.r, quote: String(x.quote || ''), weak: !x.quote || !found(x.quote, b.claim) }); });
  });
  return { ok: true, byId };
}

async function run(burrs, deps, opts) {
  const rows = [], problems = []; let spent = 0, planned = 0;
  for (let i = 0; i < burrs.length; i += BATCH) {
    const batch = burrs.slice(i, i + BATCH), u = userPrompt(batch), key = 'relburr1:' + opts.provider + ':' + crypto.createHash('sha1').update(SYSTEM + u).digest('hex').slice(0, 16);
    let hit = deps.cache.get(key), p = hit ? parseBatch(hit.text, batch) : null;
    if (!hit || !p.ok) {
      if (opts.dryRun) { planned += opts.rate(Math.ceil((SYSTEM.length + u.length) / 4), 250, null); continue; }
      if (spent >= opts.maxUsd) { problems.push({ from: batch[0].id, stopped: 'budget' }); break; }
      const r = await deps.callLLM(opts.provider, u, { system: SYSTEM, maxTokens: 1500, temperature: 0, thinkingBudget: 0, label: 'lab-relation-burrs' });
      const cost = opts.rate(r.tokensIn || 0, r.tokensOut || 0, r.model); hit = { text: r.text, model: r.model, cost }; deps.cache.put(key, hit); spent += cost; p = parseBatch(hit.text, batch);
    }
    if (!p.ok) { problems.push({ from: batch[0].id, error: 'unreadable' }); continue; }
    batch.forEach(b => rows.push({ id: b.id, claim: b.claim, relations: p.byId.get(b.id) }));
  }
  return { rows, spent, planned, problems };
}
function summary(rows) {
  const per = {}; let withAny = 0, weak = 0;
  rows.forEach(r => { if (r.relations.length) withAny++; r.relations.forEach(x => { per[x.r] = (per[x.r] || 0) + 1; if (x.weak) weak++; }); });
  return { burrs: rows.length, withAny, weak, per };
}
// a spread: round-robin across relations so rare ones show up, deterministic for a seed
function sample(rows, n, seed) {
  let s = seed || 1; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, by = {};
  rows.forEach(r => r.relations.filter(x => !x.weak).forEach(x => (by[x.r] = by[x.r] || []).push({ id: r.id, claim: r.claim, r: x.r, quote: x.quote })));
  Object.values(by).forEach(a => a.sort(() => rnd() - 0.5)); const out = [], keys = Object.keys(by);
  for (let k = 0; out.length < n && keys.some(r => by[r].length); k++) { const a = by[keys[k % keys.length]]; if (a.length) out.push(a.shift()); }
  return out;
}
const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rateFor = provider => (ti, to, model) => { const p = require('../lib/budget').priceFor(provider, model, ti) || { in: 0.30, out: 2.50 }; return (ti * p.in + to * p.out) / 1e6; };

async function main() {
  const cmd = process.argv[2], a = process.argv.slice(3), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; }, out = path.join(DIR, 'relation-burrs.jsonl');
  if (cmd === 'sample') { sample(readJsonl(out), +arg('n', 12), +arg('seed', 1)).forEach((x, i) => console.log((i + 1) + '. [' + x.r + '] ' + x.claim + '\n     quote: ' + x.quote)); return; }
  if (cmd !== 'run') { console.error('usage: relation_burrs.js run|sample'); process.exit(1); }
  let burrs = readJsonl(path.join(DIR, 'quiz-burrs.jsonl')); if (arg('limit')) burrs = burrs.slice(0, +arg('limit'));
  const provider = arg('provider', 'grok'), { callLLM } = require('../lib/llm'), { JsonlCache } = require('./judge'), dry = a.includes('--dry-run');
  const ledger = r => { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.appendFileSync(path.join(__dirname, 'out', 'spend.jsonl'), JSON.stringify(r) + '\n'); };
  const r = await run(burrs, { callLLM, cache: new JsonlCache(path.join(DIR, 'tag-cache.jsonl')) }, { provider, maxUsd: +arg('max-usd', 0.50), dryRun: dry, rate: rateFor(provider) });
  if (dry) { console.log(burrs.length + ' burrs in ' + Math.ceil(burrs.length / BATCH) + ' calls; planned cost ~$' + r.planned.toFixed(4) + ' (price used is the provider default)'); return; }
  fs.writeFileSync(out, r.rows.map(x => JSON.stringify(x)).join('\n') + '\n'); ledger({ ts: new Date().toISOString(), task: 'relation-burrs', provider, cost: r.spent });
  const s = summary(r.rows); console.log(`${provider}: ${s.burrs} burrs, ${s.withAny} with a relation, ${s.weak} with a quote not found; ${r.problems.length} problems; spent $${r.spent.toFixed(4)}`);
  Object.keys(s.per).forEach(k => console.log(' ' + k.padEnd(18), s.per[k]));
}
module.exports = { SYSTEM, userPrompt, found, parseBatch, run, summary, sample };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
