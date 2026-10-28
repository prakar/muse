#!/usr/bin/env node
'use strict';
// Restatement check on the vault judge's "yes" verdicts: which of a handle's facts say the same thing in different words?
// Why: word overlap and embeddings cannot tell a restatement from two complementary facts (e.g. "loyal to Wilde" vs "painted Wilde's portrait").
// The model proposes groups of restated facts; code verifies them. Lab output only; never vault.db. Does not change vault_judge.jsonl.
//   node code/lab/restate_check.js --dry-run            count and cost estimate, no LLM
//   node code/lab/restate_check.js --limit 40           small first run
//   node code/lab/restate_check.js --max-usd 1          full run over every "yes" verdict (cached; rerun retries errors)
// Result per handle: status restated (fewer than 2 distinct facts remain: the "link" is one fact twice), partly (some facts restate
// each other but 2+ distinct remain: check the link), distinct (no restatements), error (skipped and flagged, never guessed).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { jsonrepair } = require('jsonrepair');
const { JsonlCache, labRate } = require('./judge');
const D = require('./data');
const OUT = path.join(__dirname, 'out');
const PROMPT_VERSION = 'restate-v2';

function systemPrompt() {
  return [
    "You help a quiz writer. You see numbered facts that were gathered from different notes because they share a name or value. Find facts that RESTATE THE SAME fact or event, even when worded differently or when one contains the other.",
    'Restatement: "The Eiffel Tower opened in 1889." and "In 1889 the Eiffel Tower was inaugurated." Also a restatement: "Marie Curie was born in 1867." and "Marie Curie lived from 1867 to 1934." (the second contains the first).',
    'NOT a restatement: two facts about the same subject that add different information, such as "The Eiffel Tower is 330 m tall." and "Gustave Eiffel\'s firm built the tower."; a title and a subtitle; a person and a portrait of that person; a cause and its effect.',
    'Test before grouping two facts: remove the first and ask whether a quiz writer would lose anything the second does not already say. Group them only if nothing is lost in either direction, or if one fact is entirely contained in the other. Do NOT group facts that merely share a subject, a year or an event but state different things: "Abdus Salam was the first Muslim to win a Nobel Prize in Physics." and "Abdus Salam was a Nobel winner in 1980." (one adds the year, one adds the first-Muslim distinction); "Vail and Morse developed telegraphy between 1837 and 1844." and "Vail sent a message on May 24, 1844." (a period versus a dated event); two facts that only share a year but concern different things.',
    'Rules: use only the facts given. Put each fact in at most one group. Each group has two or more facts. When unsure, do not group.',
    'Reply with JSON only: {"groups":[[1,3],[2,5]],"why":"one short sentence"}. Use {"groups":[],"why":"..."} when no facts restate each other.'
  ].join('\n');
}
function userPrompt(claims) { return 'Facts:\n' + claims.map(function (c, i) { return '[' + (i + 1) + '] ' + c; }).join('\n'); }
function cacheKey(provider, claims) { return crypto.createHash('sha1').update([PROMPT_VERSION, provider, systemPrompt(), JSON.stringify(claims)].join('\u0001')).digest('hex'); }

// Verify the model's answer. Indices are 1-based positions in the claims list.
function parseGroups(text, n) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'no JSON object' };
  let j; try { j = JSON.parse(m[0]); } catch (e) { try { j = JSON.parse(jsonrepair(m[0])); } catch (e2) { return { ok: false, error: 'unparseable JSON' }; } }
  if (!Array.isArray(j.groups)) return { ok: false, error: 'groups missing' };
  const seen = new Set(), groups = [];
  for (const g of j.groups) {
    if (!Array.isArray(g) || g.length < 2) return { ok: false, error: 'group needs two or more facts' };
    const ids = g.map(Number);
    if (ids.some(function (i) { return !Number.isInteger(i) || i < 1 || i > n; })) return { ok: false, error: 'group cites a fact that was not provided' };
    if (new Set(ids).size !== ids.length || ids.some(function (i) { return seen.has(i); })) return { ok: false, error: 'a fact is in two groups' };
    ids.forEach(function (i) { seen.add(i); }); groups.push(ids.slice().sort(function (a, b) { return a - b; }));
  }
  return { ok: true, groups: groups };
}
function distinctCount(n, groups) { return n - groups.reduce(function (s, g) { return s + g.length - 1; }, 0); }
function statusOf(n, groups) { const d = distinctCount(n, groups); return d < 2 ? 'restated' : groups.length ? 'partly' : 'distinct'; }

// Code disposes: a model group stands only where two facts share real wording (2+ content words and 15% of their combined words).
// Groups are split into connected pieces of facts that pass the check; pieces of one fact disappear.
const STOP = new Set('the and was were are has had have his her their its that which who also with from this for are not but into than then they them can may will would about between during after before over under'.split(' '));
function contentWords(s) { return new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter(function (w) { return w.length > 2 && !STOP.has(w); })); }
function overlapOk(a, b) {
  const A = contentWords(a), B = contentWords(b); let shared = 0; A.forEach(function (w) { if (B.has(w)) shared++; });
  const union = A.size + B.size - shared; return shared >= 2 && union > 0 && shared / union >= 0.15;
}
function filterGroups(claims, groups) {
  const out = [];
  groups.forEach(function (g) {
    const comp = g.map(function (_, i) { return i; });
    const find = function (i) { while (comp[i] !== i) i = comp[i]; return i; };
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (overlapOk(claims[g[i] - 1], claims[g[j] - 1])) comp[find(i)] = find(j);
    const by = new Map(); g.forEach(function (id, i) { const r = find(i); if (!by.has(r)) by.set(r, []); by.get(r).push(id); });
    by.forEach(function (m) { if (m.length >= 2) out.push(m.sort(function (x, y) { return x - y; })); });
  });
  return out;
}

// recs: [{id, handle, claims}]. deps: { callLLM, cache, ledger }. Returns [{id, handle, status, groups, n, distinct, cost, error?}].
async function checkRecords(recs, deps, opts) {
  const provider = opts.provider || 'gemini', maxUsd = opts.maxUsd == null ? 1 : opts.maxUsd; let spent = 0; const out = [];
  for (const r of recs) {
    const n = r.claims.length, key = cacheKey(provider, r.claims); let hit = deps.cache.get(key), cost = 0;
    if (!hit) {
      if (spent >= maxUsd) { out.push({ id: r.id, handle: r.handle, n: n, status: 'error', error: 'run cap reached', cost: 0 }); continue; }
      try {
        const resp = await deps.callLLM(provider, userPrompt(r.claims), { system: systemPrompt(), maxTokens: 300, temperature: 0, thinkingBudget: 0, label: 'lab-restate' });
        const rate = labRate(provider, resp.model, resp.tokensIn || 0);
        cost = ((resp.tokensIn || 0) * rate.in + (resp.tokensOut || 0) * rate.out) / 1e6; spent += cost;
        hit = { text: resp.text, model: resp.model, tokensIn: resp.tokensIn || 0, tokensOut: resp.tokensOut || 0, cost: cost }; deps.cache.put(key, hit);
        if (deps.ledger) deps.ledger({ ts: new Date().toISOString(), task: PROMPT_VERSION, provider: provider, model: resp.model, tokensIn: hit.tokensIn, tokensOut: hit.tokensOut, cost: cost, id: r.id });
      } catch (e) { out.push({ id: r.id, handle: r.handle, n: n, status: 'error', error: 'call failed: ' + e.message, cost: 0 }); continue; }
    }
    const p = parseGroups(hit.text, n);
    if (p.ok) { p.raw = p.groups.length; p.groups = filterGroups(r.claims, p.groups); }
    out.push(p.ok ? { id: r.id, handle: r.handle, n: n, status: statusOf(n, p.groups), groups: p.groups, dropped: p.raw - p.groups.length, distinct: distinctCount(n, p.groups), cost: cost }
                  : { id: r.id, handle: r.handle, n: n, status: 'error', error: p.error, cost: cost });
  }
  return out;
}

async function main() {
  const a = process.argv.slice(2), arg = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; }, flag = k => a.includes('--' + k);
  const version = arg('version', D.DEFAULT_VERSION), provider = arg('provider', 'gemini');
  const src = arg('judge', path.join(OUT, version, 'vault_judge.jsonl'));
  let recs = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.verdict === 'yes' && Array.isArray(r.claims) && r.claims.length >= 2);
  if (arg('limit')) recs = recs.slice(0, +arg('limit'));
  const estIn = recs.reduce((s, r) => s + Math.ceil((systemPrompt().length + userPrompt(r.claims).length) / 3.6), 0), estOut = recs.length * 40, rate = labRate(provider, arg('model', 'gemini-2.5-flash'), 0);
  console.log(`${recs.length} "yes" verdicts to check; est. ~${estIn} in + ~${estOut} out tokens, about $${((estIn * rate.in + estOut * rate.out) / 1e6).toFixed(3)} at list price (cached rows cost nothing)`);
  if (flag('dry-run')) return;
  const { callLLM } = require('../lib/llm'), ledger = r => { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify(r) + '\n'); };
  const res = await checkRecords(recs, { callLLM: callLLM, cache: new JsonlCache(path.join(OUT, 'cache', 'restate.jsonl')), ledger: ledger }, { provider: provider, maxUsd: +arg('max-usd', 1) });
  const dest = path.join(OUT, version, 'restate_check.jsonl'); fs.mkdirSync(path.dirname(dest), { recursive: true });
  const byId = new Map(recs.map(r => [r.id, r]));
  fs.writeFileSync(dest, res.map(r => JSON.stringify(Object.assign({}, r, { claims: byId.get(r.id).claims }))).join('\n') + '\n');
  const t = {}; res.forEach(r => { t[r.status] = (t[r.status] || 0) + 1; });
  console.log('status', t, `spent $${res.reduce((s, r) => s + r.cost, 0).toFixed(4)}; written to ${dest}`);
  if (t.error) console.log('errors are not cached: rerun the same command to retry them');
}
module.exports = { overlapOk, filterGroups, PROMPT_VERSION, systemPrompt, userPrompt, cacheKey, parseGroups, distinctCount, statusOf, checkRecords };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
