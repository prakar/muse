#!/usr/bin/env node
'use strict';
// Tags every backtest quiz item with the heuristics it uses (checklist H5), at item level. Patterns only (Muse Constitution, Decision 7): the items come from
// backtest/items-*.jsonl, results go to backtest/quiz-tags-<provider>.jsonl, all gitignored and outside the burr store and the vault. Every LLM call goes through
// lib/llm.js (the model is chosen by the resolver). The model proposes; code checks that each id is real and that the quoted evidence is in the item. Two providers
// tag the same items and agreement is the confidence signal (a model's own confidence was useless: 27 of 28 tags came back "H").
//   node code/lab/quiz_tag.js tag [--provider gemini] [--dry-run] [--limit N] [--max-usd 0.60]    -> quiz-tags-<provider>.jsonl
//   node code/lab/quiz_tag.js summary [--provider gemini]
//   node code/lab/quiz_tag.js compare --a gemini --b claude                                     -> quiz-tags.jsonl (merged, with who agreed)
//   node code/lab/quiz_tag.js review [--source arre-bhai-2025]                                  -> tag-review-<source>.md, for your Wrong / Missed notes
//   node code/lab/quiz_tag.js score-review [--source arre-bhai-2025]                            -> precision and recall from your notes
const fs = require('node:fs'), path = require('node:path');
const DIR = path.join(__dirname, '..', '..', 'backtest'), REG = path.join(__dirname, '..', 'data', 'heuristics.json');
// Whole-set shapes and media are not visible in one item; a later per-quiz pass handles them. 63 to 66 are about one item's layout and stay.
const SET_LEVEL = [61, 62, 67, 68, 69, 70, 71];

// Pure. "12. **Name:** what it is. [LLM]" lines of the Heuristics Commons -> [{ id, name, what }]. Read at run time, never copied into the repo.
function parseDefs(md) {
  const out = [];
  String(md).split('\n').forEach(l => {
    const m = /^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/.exec(l.trim()); if (!m) return;
    const what = m[3].replace(/\[(?:SQL|STR|LLM|USER)(?:\/[A-Z]+)?[^\]]*\]\.?\s*$/, '').replace(/\s+/g, ' ').trim(), name = m[2].replace(/[:.]\s*$/, '').trim();
    out.push({ id: parseInt(m[1], 10), name, what: what.replace(/^[:.]\s*/, '') });
  });
  return out;
}
const SYSTEM = defs => 'You tag quiz questions with the construction patterns ("heuristics") a quiz setter used. A fixed numbered list follows. Use only these ids. Tag every heuristic the item clearly uses; most items use one to four, and some use none. Heuristics 63 to 66 are about how the item is laid out (sub-answers, a hint plus a nudge, a clue ladder, a "what is it" plus "what list does it top"), so check them too. For each tag give a short evidence quote (at most 25 words) copied exactly from the item; you may join two stretches of the item with "...". Reply with JSON only: {"tags":[{"id":12,"evidence":"..."}]}. Reply {"tags":[]} when none apply.\n\nHeuristics:\n' + defs.map(d => `${d.id}. ${d.name}: ${d.what}`).join('\n');
const userPrompt = it => 'Quiz item:\n' + it.question.trim() + (it.answer ? '\n\nAnswer:\n' + String(it.answer).trim() : '');
const norm = s => String(s).toLowerCase().replace(/[‘’“”"'`]/g, '').replace(/\s+/g, ' ').trim();
// Evidence may quote two stretches of an item with "..." or "[...]" between them: each stretch of three words or more must be in the item, and at least one must exist.
function found(ev, hay) {
  const segs = String(ev || '').split(/\[\s*\.{2,}\s*\]|\.{2,}|…/).map(norm).filter(x => x.split(' ').filter(Boolean).length >= 3);
  return segs.length > 0 && segs.every(x => hay.includes(x));
}

// Pure. model text -> { ok, tags, dropped }. Unknown ids and repeats are dropped (and counted); evidence that is not in the item marks the tag weak.
function parseTags(text, item, known) {
  let o; try { const t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim(); o = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) { return { ok: false, error: 'not json' }; }
  if (!o || !Array.isArray(o.tags)) return { ok: false, error: 'no tags array' };
  const hay = norm(item.question + ' ' + (item.answer || '')), tags = [], seen = new Set(); let dropped = 0;
  o.tags.slice(0, 8).forEach(t => {
    if (!t || !known.has(t.id) || seen.has(t.id)) { dropped++; return; }
    seen.add(t.id); const ev = String(t.evidence || '').split(/\s+/).slice(0, 25).join(' ');
    tags.push({ id: t.id, evidence: ev, weak: !found(ev, hay) });
  });
  return { ok: true, tags, dropped };
}

function loadItems(dir) {
  const items = [];
  fs.readdirSync(dir).filter(f => /^items-.*\.jsonl$/.test(f)).sort().forEach(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).forEach(l => {
    const o = JSON.parse(l); if (!o.question || o.question.split(/\s+/).length < 8) return; o.id = (o.source || f) + '#' + o.n; items.push(o);
  }));
  const seen = new Set(); return items.filter(i => (seen.has(i.id) ? false : seen.add(i.id)));
}

// deps = { callLLM, cache {get,put}, ledger(rec) }; opts = { provider, maxUsd, dryRun, rate(tokIn, tokOut, model), defs }. Returns { records, spent, planned, problems }.
async function tagItems(items, deps, opts) {
  const defs = opts.defs.filter(d => !SET_LEVEL.includes(d.id)), known = new Set(defs.map(d => d.id)), system = SYSTEM(defs), records = [], problems = []; let spent = 0, planned = 0;
  for (const it of items) {
    const key = ['quiztag2', opts.provider, it.id, require('node:crypto').createHash('sha1').update(system + userPrompt(it)).digest('hex').slice(0, 16)].join(':');
    let hit = deps.cache.get(key);
    if (!hit) {
      if (opts.dryRun) { planned += opts.rate(Math.ceil((system.length + userPrompt(it).length) / 4), 100, null); continue; }
      if (spent >= opts.maxUsd) { problems.push({ id: it.id, stopped: 'budget' }); break; }
      const r = await deps.callLLM(opts.provider, userPrompt(it), { system, maxTokens: 800, temperature: 0, thinkingBudget: 0, label: 'lab-quiz-tag' });
      const cost = opts.rate(r.tokensIn || 0, r.tokensOut || 0, r.model); hit = { text: r.text, model: r.model, cost }; deps.cache.put(key, hit); spent += cost;
      if (deps.ledger) deps.ledger({ ts: new Date().toISOString(), task: 'quiz-tag', provider: opts.provider, model: r.model, cost, id: it.id });
    }
    const p = parseTags(hit.text, it, known);
    if (!p.ok) { problems.push({ id: it.id, error: p.error }); continue; }
    records.push({ id: it.id, source: it.source, provider: opts.provider, tags: p.tags, dropped: p.dropped, model: hit.model });
  }
  return { records, spent, planned, problems };
}

function summary(records, defs) {
  const by = new Map(defs.map(d => [d.id, { id: d.id, name: d.name, n: 0, weak: 0 }]));
  let weak = 0, tags = 0, none = 0; records.forEach(r => { if (!r.tags.length) none++; r.tags.forEach(t => { tags++; if (t.weak) weak++; const b = by.get(t.id); if (!b) return; b.n++; if (t.weak) b.weak++; }); });
  return { items: records.length, none, tags, weak, rows: Array.from(by.values()).filter(r => r.n).sort((a, b) => b.n - a.n) };
}

// Pure. Two providers' records -> one record per item that both tagged, each tag carrying who gave it. `agreed` is the confidence signal.
function merge(a, b, nameA, nameB) {
  const mb = new Map(b.map(r => [r.id, r])), out = [];
  a.forEach(ra => { const rb = mb.get(ra.id); if (!rb) return; const tags = new Map();
    ra.tags.forEach(t => tags.set(t.id, { id: t.id, by: [nameA], evidence: t.evidence, weak: t.weak }));
    rb.tags.forEach(t => { const x = tags.get(t.id); if (x) { x.by.push(nameB); x.weak = x.weak && t.weak; } else tags.set(t.id, { id: t.id, by: [nameB], evidence: t.evidence, weak: t.weak }); });
    out.push({ id: ra.id, source: ra.source, tags: Array.from(tags.values()).map(t => Object.assign(t, { agreed: t.by.length === 2 })).sort((x, y) => x.id - y.id) }); });
  return out;
}
function agreement(merged) {
  let both = 0, single = 0; const per = new Map();
  merged.forEach(r => r.tags.forEach(t => { if (t.agreed) both++; else single++; const p = per.get(t.id) || { id: t.id, both: 0, single: 0 }; if (t.agreed) p.both++; else p.single++; per.set(t.id, p); }));
  return { items: merged.length, both, single, share: both + single ? both / (both + single) : 0, per: Array.from(per.values()).sort((x, y) => (y.both + y.single) - (x.both + x.single)) };
}

// The sheet you annotate. One block per item; fill "Wrong:" with ids you would NOT call (comma separated) and "Missed:" with ids you did use that are not listed.
function reviewSheet(items, merged, defs, source) {
  const name = new Map(defs.map(d => [d.id, d.name])), by = new Map(merged.map(r => [r.id, r]));
  const lines = ['# Heuristic tags for ' + source + ' (your review)', '', 'For each item: put the numbers of tags you disagree with after "Wrong:", and the numbers of heuristics the item uses that are not listed after "Missed:". Leave a line empty if nothing to say. Numbers are in the Heuristics Commons.', ''];
  items.filter(i => i.source === source).forEach(it => { const r = by.get(it.id); if (!r) return;
    lines.push('### ' + it.id, 'Q: ' + it.question.replace(/\s+/g, ' ').trim().slice(0, 420), 'A: ' + String(it.answer || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      'Tags: ' + (r.tags.length ? r.tags.map(t => `${t.id} ${name.get(t.id)} [${t.agreed ? 'both' : t.by[0] + ' only'}]`).join('; ') : '(none)'), 'Wrong:', 'Missed:', ''); });
  return lines.join('\n');
}
const ids = s => String(s || '').split(/[^0-9]+/).filter(Boolean).map(Number);
function parseReview(md) {
  const out = []; let cur = null;
  String(md).split('\n').forEach(l => { let m;
    if ((m = /^###\s+(\S+)/.exec(l))) { cur = { id: m[1], wrong: [], missed: [] }; out.push(cur); }
    else if (cur && (m = /^Wrong:(.*)$/.exec(l))) cur.wrong = ids(m[1]);
    else if (cur && (m = /^Missed:(.*)$/.exec(l))) cur.missed = ids(m[1]); });
  return out;
}
// Precision of the tags (split into "both models" and "one model"), and recall against what you added. Items you did not touch count as "right as listed"
// only when `reviewedAll` says you went through every block.
function scoreReview(review, merged) {
  const by = new Map(merged.map(r => [r.id, r])), s = { items: 0, tags: { both: { n: 0, wrong: 0 }, single: { n: 0, wrong: 0 } }, missed: 0, missedBy: {}, wrongBy: {} };
  review.forEach(rv => { const r = by.get(rv.id); if (!r) return; s.items++;
    r.tags.forEach(t => { const k = t.agreed ? 'both' : 'single'; s.tags[k].n++; if (rv.wrong.includes(t.id)) { s.tags[k].wrong++; s.wrongBy[t.id] = (s.wrongBy[t.id] || 0) + 1; } });
    rv.missed.forEach(m => { s.missed++; s.missedBy[m] = (s.missedBy[m] || 0) + 1; }); });
  const right = k => s.tags[k].n - s.tags[k].wrong, tot = right('both') + right('single');
  s.precision = { both: s.tags.both.n ? right('both') / s.tags.both.n : null, single: s.tags.single.n ? right('single') / s.tags.single.n : null };
  s.recall = tot + s.missed ? tot / (tot + s.missed) : null; return s;
}

const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const writeJsonl = (f, rows) => fs.writeFileSync(f, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
const pct = x => x == null ? 'n/a' : (100 * x).toFixed(0) + '%';
const rateFor = provider => (ti, to, model) => { const p = require('../lib/budget').priceFor(provider, model, ti) || { in: 0.30, out: 2.50 }; return (ti * p.in + to * p.out) / 1e6; };

async function main() {
  const cmd = process.argv[2], a = process.argv.slice(3), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const commons = fs.readFileSync(path.join(require('../heuristics_build').NOTES, 'QUARRY - Heuristics Commons.md'), 'utf8'), defs = parseDefs(commons);
  const regIds = new Set(JSON.parse(fs.readFileSync(REG, 'utf8')).rows.map(r => r.id)); if (defs.length !== regIds.size || !defs.every(d => regIds.has(d.id))) { console.error('The Commons list and code/data/heuristics.json disagree; run node --no-warnings code/heuristics_build.js --check'); process.exit(1); }
  const fileOf = p => path.join(DIR, 'quiz-tags-' + p + '.jsonl'), merged = path.join(DIR, 'quiz-tags.jsonl'), source = arg('source', 'arre-bhai-2025'), sheet = path.join(DIR, 'tag-review-' + source + '.md');
  if (cmd === 'summary') {
    const s = summary(readJsonl(fileOf(arg('provider', 'gemini'))), defs);
    console.log(`${s.items} items tagged; ${s.none} with no heuristic; ${s.tags} tags, ${s.weak} with evidence not found in the item`);
    s.rows.forEach(r => console.log(String(r.id).padStart(3), r.name.padEnd(42), 'n=' + String(r.n).padStart(3), r.weak ? 'weak ' + r.weak : '')); return;
  }
  if (cmd === 'compare') {
    const A = arg('a', 'gemini'), B = arg('b'); if (!B) { console.error('usage: compare --a gemini --b claude'); process.exit(1); }
    const m = merge(readJsonl(fileOf(A)), readJsonl(fileOf(B)), A, B), g = agreement(m); writeJsonl(merged, m);
    console.log(`${g.items} items tagged by both ${A} and ${B}; ${g.both + g.single} tags, ${g.both} given by both (${pct(g.share)})`);
    const name = new Map(defs.map(d => [d.id, d.name])); g.per.slice(0, 25).forEach(p => console.log(String(p.id).padStart(3), String(name.get(p.id)).padEnd(40), 'both ' + p.both, 'one ' + p.single)); return;
  }
  if (cmd === 'review') { const items = loadItems(DIR); fs.writeFileSync(sheet, reviewSheet(items, readJsonl(merged), defs, source)); console.log('wrote ' + sheet + '. Open it, fill in Wrong: and Missed: for each item, save, then run score-review.'); return; }
  if (cmd === 'score-review') {
    const s = scoreReview(parseReview(fs.readFileSync(sheet, 'utf8')), readJsonl(merged)), name = new Map(defs.map(d => [d.id, d.name]));
    console.log(`${s.items} items reviewed. Tags given by both models: ${s.tags.both.n}, right ${pct(s.precision.both)}. Tags from one model: ${s.tags.single.n}, right ${pct(s.precision.single)}. You added ${s.missed} that were missed; recall ${pct(s.recall)}.`);
    console.log('Most often wrong:', Object.entries(s.wrongBy).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${name.get(+k)} x${v}`).join('; ') || 'none');
    console.log('Most often missed:', Object.entries(s.missedBy).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${name.get(+k)} x${v}`).join('; ') || 'none'); return;
  }
  if (cmd !== 'tag') { console.error('usage: quiz_tag.js tag|summary|compare|review|score-review (see the top of the file)'); process.exit(1); }
  let items = loadItems(DIR); if (arg('limit')) items = items.slice(0, +arg('limit'));
  const provider = arg('provider', 'gemini'), { callLLM } = require('../lib/llm'), { JsonlCache } = require('./judge'), dry = a.includes('--dry-run');
  const ledger = r => { fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true }); fs.appendFileSync(path.join(__dirname, 'out', 'spend.jsonl'), JSON.stringify(r) + '\n'); };
  const r = await tagItems(items, { callLLM, cache: new JsonlCache(path.join(DIR, 'tag-cache.jsonl')), ledger }, { provider, maxUsd: +arg('max-usd', 0.60), dryRun: dry, rate: rateFor(provider), defs });
  console.log(`${provider}: ${items.length} items; ${dry ? 'planned cost ~$' + r.planned.toFixed(4) + ' (uncached items only; the price used is the provider default, so a cheaper model may cost less)' : r.records.length + ' tagged, ' + r.problems.length + ' problems, spent $' + r.spent.toFixed(4)}`);
  if (!dry) writeJsonl(fileOf(provider), r.records);
}
module.exports = { parseDefs, SYSTEM, SET_LEVEL, userPrompt, parseTags, loadItems, tagItems, summary, merge, agreement, reviewSheet, parseReview, scoreReview };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
