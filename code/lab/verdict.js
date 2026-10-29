#!/usr/bin/env node
'use strict';
// Verdict layer for search ("fail loudly"), roadmap C2/C3. Deterministic, no LLM, no spend, reads lab output + a DB copy.
// Given a question, the top hits and the rewrite-leg similarity, it says one of:
//   found    every distinctive word of the question appears in the top hits, and the match is strong
//   related  some of the question is in the hits, but a distinctive part is missing (the verdict names it)
//   nothing  none of the distinctive words appear in the hits, or the match is weak
// "Distinctive" = a question word that is rare in the vault (document frequency <= MAX_DF), so "Musk" and "spectrum" count and "per" does not.
// Thresholds were fixed BEFORE the first look at the 30 questions (anchor df <= 500; found sim >= 0.50; nothing sim < 0.40). Any later change is a fit.
//   node --no-warnings code/lab/verdict.js --db eval.db [--rewrite out/nug-v6/query_rewrite_embeddinggemma.json]
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), SB = require('./search_baseline');

const THRESH = { maxDf: 500, found: 0.5, nothing: 0.4 };

// Pure: does the text contain the term (stem-tolerant for words of 5+ letters, whole word otherwise)?
function has(text, term) {
  const t = String(text || '').toLowerCase();
  if (term.length >= 5) return t.indexOf(term.slice(0, Math.max(4, term.length - 2))) >= 0;
  return new RegExp('(^|[^\\p{L}\\p{N}])' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\p{L}\\p{N}])', 'u').test(t);
}
// Pure: the distinctive words of a question = rare in the vault. dfOf(term) -> number of burrs containing it.
function anchorTerms(terms, dfOf, maxDf) { return terms.filter(function (t) { const df = dfOf(t); return df > 0 && df <= maxDf; }); }
// Pure: which anchors the evidence texts cover.
function coverage(anchors, texts) { const cov = anchors.filter(a => texts.some(x => has(x, a))); return { covered: cov, missing: anchors.filter(a => cov.indexOf(a) < 0) }; }
// Pure: the three-way verdict.
function decide(o, th) {
  th = th || THRESH;
  const none = !o.anchors.length;
  if (none) return o.sim >= th.found ? 'found' : o.sim < th.nothing ? 'nothing' : 'related';
  if (!o.covered.length || o.sim < th.nothing) return 'nothing';
  if (!o.missing.length && o.sim >= th.found) return 'found';
  return 'related';
}
// Pure: the sentence the UI would show.
function message(v, missing, covered) {
  if (v === 'found') return 'Found.';
  if (v === 'related') return 'Related notes, but nothing about: ' + (missing.length ? missing.join(', ') : 'the exact point') + '.';
  return 'Nothing in the vault matches' + (missing.length ? ' (no mention of ' + missing.join(', ') + ')' : '') + '.';
}

function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/verdict.js --db eval.db [--rewrite path/to/query_rewrite_<model>.json]'); process.exit(1); }
  const version = arg('version', D.DEFAULT_VERSION), model = arg('model', 'embeddinggemma');
  const tag = arg('tag', '');
  const rw = JSON.parse(fs.readFileSync(path.resolve(arg('rewrite', path.join(__dirname, 'out', version, 'query_rewrite_' + model + (tag ? '_' + tag : '') + '.json'))), 'utf8')).results;
  // Labels: either the grades file of the first 30 (default) or a holdout file with a parallel vault_has array (--labels file).
  const lf = JSON.parse(fs.readFileSync(path.resolve(arg('labels', path.join(__dirname, 'queries', 'author_grades_keyword_2026-10-29.json'))), 'utf8'));
  const labels = new Map(lf.grades ? lf.grades.map(g => [g.id, g.vault_has]) : lf.vault_has.map((v, i) => [i + 1, v]));
  const claims = D.loadBurrs(D.openCopy(arg('db')), version).map(b => b.claim.toLowerCase());
  const dfCache = new Map(), dfOf = t => { if (!dfCache.has(t)) dfCache.set(t, claims.filter(c => has(c, t)).length); return dfCache.get(t); };
  const rows = rw.map(r => {
    const terms = SB.terms(r.query), anchors = anchorTerms(terms, dfOf, THRESH.maxDf);
    const evidence = r.fused_top10_grouped.slice(0, 5).map(h => h.claim + ' ' + h.title), cov = coverage(anchors, evidence);
    const sim = r.rewrite_top3[0] ? r.rewrite_top3[0].sim : 0;
    const v = decide({ sim: sim, anchors: anchors, covered: cov.covered, missing: cov.missing });
    return { id: r.id, query: r.query, label: labels.get(r.id), sim: sim, anchors: anchors, covered: cov.covered, missing: cov.missing, verdict: v, message: message(v, cov.missing, cov.covered) };
  });
  const t = {}; rows.forEach(r => { const k = r.label + ' -> ' + r.verdict; t[k] = (t[k] || 0) + 1; });
  const md = ['# Verdict layer on the 30 questions', '', 'Thresholds fixed in advance: ' + JSON.stringify(THRESH), '', '| # | label | verdict | sim | anchors (missing in bold) | message |', '|---|---|---|---|---|---|'];
  rows.forEach(r => md.push('| ' + r.id + ' | ' + r.label + ' | ' + r.verdict + ' | ' + r.sim + ' | ' + r.anchors.map(x => r.missing.indexOf(x) >= 0 ? '**' + x + '**' : x).join(', ') + ' | ' + r.message + ' |'));
  md.push('', 'Confusion (vault label -> verdict):', '', '```', JSON.stringify(t, null, 1), '```');
  // The simpler rule that did better on the first 30: rewrite-leg similarity alone, cutoff fixed at 0.50 before this holdout was run.
  const pos = rows.filter(r => r.label !== 'absent'), neg = rows.filter(r => r.label === 'absent');
  const auc = pos.length && neg.length ? pos.reduce((s, p) => s + neg.reduce((q, n) => q + (p.sim > n.sim ? 1 : p.sim === n.sim ? 0.5 : 0), 0), 0) / (pos.length * neg.length) : null;
  md.push('', 'Similarity alone (cutoff ' + THRESH.found + '): answerable kept ' + pos.filter(r => r.sim >= THRESH.found).length + '/' + pos.length + ', unanswerable passing ' + neg.filter(r => r.sim >= THRESH.found).length + '/' + neg.length + (auc == null ? '' : '; AUC ' + auc.toFixed(3)) + '.');
  const out = path.join(__dirname, 'out', version, 'verdict_' + model + (tag ? '_' + tag : '') + '.md'); fs.writeFileSync(out, md.join('\n'));
  fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(rows, null, 2));
  console.log(md.join('\n'));
}

module.exports = { THRESH, has, anchorTerms, coverage, decide, message };
if (require.main === module) main();
