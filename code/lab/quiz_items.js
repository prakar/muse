'use strict';
// Quiz PDFs (as pdftotext output) -> items for the backtest. Read-only material, held OUTSIDE the stores (Muse Constitution, Decision 7):
// items live in backtest/ (gitignored) and are never imported into burrs, bristles, knots, sparks or the vault.
//   node code/lab/quiz_items.js --txt quiz.txt --source arre --kind qa|slides [--out backtest/items-arre.jsonl]
const fs = require('node:fs');
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clean = s => String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// "Q 1 (triple) ... A1 ... Q2 ..." : one item per question, answer = text after the matching A line.
function parseQA(text) {
  const lines = String(text).replace(/\f/g, '\n').split('\n'), items = []; let cur = null, mode = null;
  const flush = () => { if (cur) { cur.question = clean(cur.q.join('\n')); cur.answer = clean(cur.a.join('\n')); delete cur.q; delete cur.a; if (cur.question.length > 20) items.push(cur); } };
  lines.forEach(l => {
    let m;
    if ((m = l.match(/^\s*Q\s*(\d+)\b(.*)$/))) { flush(); cur = { n: +m[1], q: [m[2].trim()], a: [] }; mode = 'q'; }
    else if (cur && (m = l.match(/^\s*A\s*(\d+)\b(.*)$/)) && +m[1] === cur.n) { mode = 'a'; if (m[2].trim()) cur.a.push(m[2].trim()); }
    else if (cur) (mode === 'a' ? cur.a : cur.q).push(l.trim());
  });
  flush(); return items;
}

// One slide per page; a question slide is often repeated inside its answer slide, so keep the longest and drop pages it contains.
function parseSlides(text) {
  const pages = String(text).split('\f').map((p, i) => ({ page: i + 1, text: clean(p.split('\n').filter(l => !/^\s*\d{1,3}\s*$/.test(l)).join('\n')) })).filter(p => p.text.length >= 40);
  const toks = p => new Set(norm(p.text).split(' ').filter(Boolean));
  const withT = pages.map(p => Object.assign(p, { t: toks(p) })).sort((a, b) => b.t.size - a.t.size), kept = [];
  withT.forEach(p => { const dup = kept.some(k => { let i = 0; p.t.forEach(x => { if (k.t.has(x)) i++; }); return i / p.t.size >= 0.9; }); if (!dup) kept.push(p); });
  return kept.sort((a, b) => a.page - b.page).map(p => ({ n: p.page, question: p.text, answer: '' }));
}

function parse(text, kind) { return kind === 'qa' ? parseQA(text) : parseSlides(text); }
module.exports = { parse, parseQA, parseSlides };

if (require.main === module) {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('txt') || !arg('source')) { console.error('Usage: node code/lab/quiz_items.js --txt quiz.txt --source name --kind qa|slides [--out file]'); process.exit(1); }
  const items = parse(fs.readFileSync(arg('txt'), 'utf8'), arg('kind', 'slides')).map(x => Object.assign({ source: arg('source') }, x));
  const out = arg('out', 'backtest/items-' + arg('source') + '.jsonl');
  fs.mkdirSync(require('node:path').dirname(out), { recursive: true });
  fs.writeFileSync(out, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(items.length + ' items -> ' + out);
}
