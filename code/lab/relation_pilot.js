'use strict';
/**
 * QUARRY lab/relation_pilot.js — can a model read the RELATION between facts (cause, named-for, inspired-by...) reliably?
 * About 30 of the 71 heuristics join facts on a relation that only exists in the prose, so burrs carry no hook for it.
 * The test: take the paraphrased fragments in the Illustrations note (local vault note, never in the repo), ask for relations from a closed list,
 * and compare with the relation each heuristic implies. Heuristics with no relation (3, 36, 47...) are controls: the answer should be "none".
 * Every call goes through lib/llm.js (the resolver picks the model). Output: backtest/relation-pilot.jsonl (gitignored).
 *   node code/lab/relation_pilot.js run [--provider grok] [--limit N] [--dry-run] [--max-usd 0.10]
 */
const fs = require('node:fs'), path = require('node:path');
const DIR = path.join(__dirname, '..', '..', 'backtest');

const RELATIONS = {
  cause: 'one thing led to, produced or triggered another (a cause and its consequence, a limit that became a trait)',
  'explains-practice': 'a legend or story that accounts for a custom, rule or object',
  'named-for': 'something is named after a person, place, thing or deed, or a name was carried to a new place',
  'inspired-by': 'a work or person imitates, echoes or descends from another',
  'copy-of': 'a local version, rebadge or clone of an original',
  'applied-elsewhere': 'a solution studied in one place or field and used in another',
  'reason-chosen': 'the reason a place, actor or moment was selected',
  'ignored-because': 'something was overlooked or unrecognised because of language, medium or politics',
};
// the relation each heuristic implies; heuristics with no relation are controls (expected "none")
const GOLD = { 1: 'cause', 14: 'cause', 18: 'cause', 19: 'cause', 11: 'explains-practice', 6: 'inspired-by', 5: 'copy-of', 8: 'named-for', 54: 'named-for', 13: 'applied-elsewhere', 9: 'reason-chosen', 15: 'ignored-because' };
const CONTROLS = [3, 36, 47, 48, 49, 50, 59, 60, 63];

const SYSTEM = 'You read one short note about a fact or a small group of facts. Say which relations it states between the things it mentions. ' +
  'Choose only from this list, and only when the note states or plainly implies it:\n' +
  Object.keys(RELATIONS).map(k => '- ' + k + ': ' + RELATIONS[k]).join('\n') +
  '\nIf none applies, answer with none. Do not guess a relation the note does not support. ' +
  'Reply with JSON only: {"relations":["cause"]} or {"relations":[]}.';

// rows of the Illustrations tables: | # | Heuristic | Src | Fragment | How extracted | Conf |  (an empty # continues the heuristic above)
function parseFragments(md) {
  const out = []; let cur = null;
  md.split('\n').forEach(line => {
    if (!/^\|/.test(line)) return; const c = line.split('|').slice(1, -1).map(s => s.trim());
    if (c.length < 6 || c[3] === 'Fragment (paraphrase)' || c[3] === 'Fragment' || /^-+$/.test(c[0])) return;
    if (/^\d+$/.test(c[0])) cur = +c[0]; if (cur == null || !c[3]) return;
    out.push({ h: cur, src: c[2], text: c[3], conf: (c[5] || '').charAt(0) });
  });
  return out;
}
function firstObject(t) { const s = t.indexOf('{'); if (s < 0) return null; let d = 0; for (let i = s; i < t.length; i++) { if (t[i] === '{') d++; else if (t[i] === '}' && --d === 0) return t.slice(s, i + 1); } return null; }
function parseRelations(text) {
  const j = firstObject(String(text || '')); if (j == null) return { ok: false };
  try { const o = JSON.parse(j); if (!Array.isArray(o.relations)) return { ok: false }; return { ok: true, relations: o.relations.filter(r => RELATIONS[r]) }; } catch (e) { return { ok: false }; }
}
function pick(frags) { return frags.filter(f => (GOLD[f.h] && f.conf !== 'L') || CONTROLS.includes(f.h)); }

async function run(frags, deps, opts) {
  const rows = []; let spent = 0, planned = 0;
  for (const f of pick(frags)) {
    const key = 'relpilot1:' + opts.provider + ':' + require('node:crypto').createHash('sha1').update(SYSTEM + f.text).digest('hex').slice(0, 16);
    let hit = deps.cache.get(key), p = hit ? parseRelations(hit.text) : null;
    if (!hit || !p.ok) {
      if (opts.dryRun) { planned += opts.rate(Math.ceil((SYSTEM.length + f.text.length) / 4), 30, null); continue; }
      if (spent >= opts.maxUsd) break;
      const r = await deps.callLLM(opts.provider, f.text, { system: SYSTEM, maxTokens: 200, temperature: 0, thinkingBudget: 0, label: 'lab-relation-pilot' });
      const cost = opts.rate(r.tokensIn || 0, r.tokensOut || 0, r.model); hit = { text: r.text, model: r.model, cost }; deps.cache.put(key, hit); spent += cost; p = parseRelations(hit.text);
    }
    rows.push({ h: f.h, src: f.src, text: f.text, got: p.ok ? p.relations : null, gold: GOLD[f.h] || 'none' });
  }
  return { rows, spent, planned };
}
function report(rows) {
  const per = {}; let hit = 0, n = 0, ctl = 0, ctlBad = 0, bad = 0;
  rows.forEach(r => {
    if (!r.got) { bad++; return; }
    if (r.gold === 'none') { ctl++; if (r.got.length) ctlBad++; return; }
    n++; const ok = r.got.includes(r.gold); if (ok) hit++; const p = per[r.h] = per[r.h] || { n: 0, hit: 0 }; p.n++; if (ok) p.hit++;
  });
  return { relationRows: n, found: hit, controls: ctl, controlsFlagged: ctlBad, unreadable: bad, per };
}
const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const rateFor = provider => (ti, to, model) => { const p = require('../lib/budget').priceFor(provider, model, ti) || { in: 0.30, out: 2.50 }; return (ti * p.in + to * p.out) / 1e6; };

async function main() {
  const a = process.argv.slice(3), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (process.argv[2] !== 'run') { console.error('usage: relation_pilot.js run [--provider grok] [--limit N] [--dry-run] [--max-usd 0.10]'); process.exit(1); }
  const md = fs.readFileSync(path.join(require('../../packs/quiz/tools/heuristics_build').NOTES, 'QUARRY - Heuristics Illustrations.md'), 'utf8'); let frags = parseFragments(md);
  if (arg('limit')) frags = pick(frags).slice(0, +arg('limit'));
  const provider = arg('provider', 'grok'), { callLLM } = require('../lib/llm'), { JsonlCache } = require('./judge'), dry = a.includes('--dry-run');
  const r = await run(frags, { callLLM, cache: new JsonlCache(path.join(DIR, 'tag-cache.jsonl')) }, { provider, maxUsd: +arg('max-usd', 0.10), dryRun: dry, rate: rateFor(provider) });
  if (dry) { console.log(pick(frags).length + ' fragments; planned cost ~$' + r.planned.toFixed(4)); return; }
  fs.writeFileSync(path.join(DIR, 'relation-pilot.jsonl'), r.rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  const s = report(r.rows);
  console.log(`${provider}: ${r.rows.length} fragments, spent $${r.spent.toFixed(4)}; relation rows found ${s.found}/${s.relationRows}; controls wrongly given a relation ${s.controlsFlagged}/${s.controls}; unreadable ${s.unreadable}`);
  Object.keys(s.per).forEach(h => console.log(' h' + String(h).padStart(2), s.per[h].hit + '/' + s.per[h].n));
}
module.exports = { RELATIONS, GOLD, CONTROLS, SYSTEM, parseFragments, parseRelations, pick, run, report };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
