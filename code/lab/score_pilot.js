#!/usr/bin/env node
'use strict';
// Scores semantic_pilot output against the author's vault labels. No spend.
//   node --no-warnings code/lab/score_pilot.js [--model embeddinggemma] [--version nug-v6]
// Needs: out/<version>/semantic_pilot_<model>.json (from semantic_pilot.js) and queries/author_grades_keyword_2026-10-29.json (vault_has labels).
// For queries whose vault_has is present/partial we cannot auto-judge a hit, so this prints each method's top hits for the 12 queries
// the author/Claude must judge by eye (the printed sheet), and for the 'absent' queries it reports what each method returns (it should
// ideally show nothing; with a fixed top-k it always returns something, so the sim of the best hit is shown to help set a cutoff).
// Once a 'judged' map {id: {keyword:[0|1|2 per hit]...}} is supplied via --judged file.json it also computes success@k per method.
const fs = require('node:fs'), path = require('node:path');

// Pure: success@k = share of queries where any of the first k hits has grade >= minGrade. grades: array (per query) of arrays (per hit).
function successAt(grades, k, minGrade) {
  const qs = grades.filter(g => g && g.length);
  if (!qs.length) return { n: 0, hits: 0, rate: 0, lo: 0, hi: 0 };
  const hits = qs.filter(g => g.slice(0, k).some(x => x >= minGrade)).length;
  const w = wilson(hits, qs.length);
  return { n: qs.length, hits: hits, rate: hits / qs.length, lo: w[0], hi: w[1] };
}
// Pure: Wilson 95% interval (small n, honest about it).
function wilson(x, n) { if (!n) return [0, 0]; const z = 1.96, p = x / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)]; }

function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const model = arg('model', 'embeddinggemma'), version = arg('version', 'nug-v6'), k = +arg('k', 3);
  const dir = path.join(__dirname, 'out', version), pilot = JSON.parse(fs.readFileSync(path.join(dir, 'semantic_pilot_' + model + '.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, 'queries', 'author_grades_keyword_2026-10-29.json'), 'utf8')).grades;
  const has = new Map(labels.map(l => [l.id, l.vault_has]));
  const judgedFile = arg('judged', null), judged = judgedFile ? JSON.parse(fs.readFileSync(judgedFile, 'utf8')) : null;
  const out = ['# Pilot scoring: ' + model, ''];
  const present = pilot.results.filter(r => has.get(r.id) !== 'absent');
  out.push('## Queries where the vault has something (' + present.length + '): top ' + k + ' per method, to judge', '');
  present.forEach(r => { out.push('### ' + r.id + '. ' + r.query + '  [' + has.get(r.id) + ']');
    ['keyword', 'meaning', 'hybrid'].forEach(m => { out.push('- ' + m); r[m].slice(0, k).forEach((h, j) => out.push('  ' + (j + 1) + '. ' + h.claim.slice(0, 140) + '  (' + String(h.title).slice(0, 40) + ')')); }); out.push(''); });
  const absent = pilot.results.filter(r => has.get(r.id) === 'absent');
  out.push('## Queries with nothing in the vault (' + absent.length + '): best similarity returned by "meaning"', '');
  absent.forEach(r => out.push('- ' + r.id + '. ' + r.query.slice(0, 60) + ' -> sim ' + (r.meaning[0] ? r.meaning[0].sim : '-') + '  ' + (r.meaning[0] ? r.meaning[0].claim.slice(0, 70) : '')));
  const pres = present.map(r => r.meaning[0] ? r.meaning[0].sim : 0).sort((x, y) => x - y), abs = absent.map(r => r.meaning[0] ? r.meaning[0].sim : 0).sort((x, y) => x - y);
  const med = v => v.length ? v[Math.floor(v.length / 2)] : 0;
  out.push('', 'Median top-1 similarity: vault-has-something ' + med(pres).toFixed(3) + ' vs vault-has-nothing ' + med(abs).toFixed(3) + ' (a cutoff only works if these separate).');
  if (judged) {
    out.push('', '## success@' + k + ' (grade >= 1 / >= 2), from the judged file', '');
    ['keyword', 'meaning', 'hybrid'].forEach(m => { const g = present.map(r => (judged[r.id] || {})[m]).filter(Boolean);
      [1, 2].forEach(mg => { const s = successAt(g, k, mg); out.push('- ' + m + ' grade>=' + mg + ': ' + s.hits + '/' + s.n + ' (' + Math.round(s.rate * 100) + '%, 95% CI ' + Math.round(s.lo * 100) + '-' + Math.round(s.hi * 100) + '%)'); }); });
  }
  const f = path.join(dir, 'score_pilot_' + model + '.md'); fs.writeFileSync(f, out.join('\n')); console.log(out.join('\n').slice(0, 6000)); console.log('\nWritten ' + f);
}
module.exports = { successAt, wilson };
if (require.main === module) main();
