#!/usr/bin/env node
'use strict';
// Keyword-search baseline for the search pilot (roadmap track C2). No LLM, no embeddings, no spend; reads the DB, writes lab output only.
// Builds an in-memory SQLite FTS5 index over burr claims (plus note title) and runs the author's questions as BM25 queries,
// then writes a judging sheet: for each query the top hits, with an empty relevance column for the author (0 none, 1 related, 2 answers it).
//   node --no-warnings code/lab/search_baseline.js --db eval.db [--queries code/lab/queries/author_queries_2026-10-29.json] [--k 5] [--version nug-v6]
// Outputs: code/lab/out/<version>/search_baseline.md (judging sheet) and search_baseline.json (hits, for scoring later).
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const D = require('./data'), BR = require('../lib/bristles');

// Words that make a sentence a question but carry no topic. BM25 would otherwise match "does", "how", "is" in every claim.
const QUESTION_WORDS = new Set('what whats how why who when where which does did do is are was were am can could would should will has have had any there case if much many not no yes also ever always one'.split(' '));

// Pure: a natural-language question -> the search terms (stopwords and question words removed, de-duplicated, order kept).
function terms(question) {
  const seen = new Set(), out = [];
  (String(question || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).forEach(function (w) {
    if (w.length < 2 || BR.STOP.has(w) || QUESTION_WORDS.has(w) || seen.has(w)) return;
    seen.add(w); out.push(w);
  });
  return out;
}

// Pure: FTS5 MATCH expression. Every term is quoted (so no query syntax can leak in) and joined with OR; BM25 ranks the best overlap first.
function matchExpr(ts) { return ts.map(function (t) { return '"' + t.replace(/"/g, '') + '"'; }).join(' OR '); }

function buildIndex(db, version) {
  const idx = new DatabaseSync(':memory:');
  idx.exec("CREATE VIRTUAL TABLE f USING fts5(claim, title, tokenize='porter unicode61 remove_diacritics 2')");
  idx.exec('CREATE TABLE meta (id INTEGER PRIMARY KEY, burr_id INTEGER, note_id INTEGER)');
  const titles = new Map(); db.prepare('SELECT id, title FROM vault_notes WHERE COALESCE(quarry_exclude,0)=0').all().forEach(function (r) { titles.set(r.id, r.title); });
  const ins = idx.prepare('INSERT INTO f(rowid, claim, title) VALUES (?,?,?)'), insM = idx.prepare('INSERT INTO meta VALUES (?,?,?)');
  idx.exec('BEGIN'); let n = 0;
  D.loadBurrs(db, version).forEach(function (b) { if (!titles.has(b.note_id)) return; n++; ins.run(n, b.claim, titles.get(b.note_id) || ''); insM.run(n, b.id, b.note_id); });
  idx.exec('COMMIT');
  return { idx: idx, n: n, titles: titles };
}

function search(index, question, k) {
  const ts = terms(question);
  if (!ts.length) return { terms: ts, hits: [] };
  const rows = index.idx.prepare('SELECT f.rowid AS r, f.claim, f.title, bm25(f, 1.0, 0.5) AS score FROM f WHERE f MATCH ? ORDER BY score LIMIT ?').all(matchExpr(ts), k);
  const hits = rows.map(function (r) {
    const m = index.idx.prepare('SELECT burr_id, note_id FROM meta WHERE id=?').get(r.r);
    const hay = (r.claim + ' ' + r.title).toLowerCase(), matched = ts.filter(function (t) { return hay.indexOf(t.slice(0, Math.max(4, t.length - 2))) >= 0; });
    return { burr_id: m.burr_id, note_id: m.note_id, claim: r.claim, title: r.title, score: +r.score.toFixed(2), matched: matched };
  });
  return { terms: ts, hits: hits };
}

function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/search_baseline.js --db eval.db [--queries file.json] [--k 5] [--version nug-v6]'); process.exit(1); }
  const version = arg('version', D.DEFAULT_VERSION), k = +arg('k', 5);
  const qs = JSON.parse(fs.readFileSync(arg('queries', path.join(__dirname, 'queries', 'author_queries_2026-10-29.json')), 'utf8')).queries;
  const db = D.openCopy(arg('db')), index = buildIndex(db, version);
  const results = qs.map(function (q, i) { return Object.assign({ id: i + 1, query: q }, search(index, q, k)); });
  const outDir = path.join(__dirname, 'out', version); fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'search_baseline.json'), JSON.stringify(results, null, 2));
  const md = ['# Search baseline: judging sheet', '', 'Keyword search (SQLite FTS5, BM25, OR of the question\'s content words) over ' + index.n + ' burrs. For each hit write a grade after the arrow: 0 = unrelated, 1 = related, 2 = answers or directly bears on the question. Also say if the vault has no answer at all.', ''];
  results.forEach(function (r) {
    md.push('## ' + r.id + '. ' + r.query, 'terms: ' + (r.terms.join(', ') || '(none)'), '');
    if (!r.hits.length) md.push('- (no hits)');
    r.hits.forEach(function (h, j) { md.push('- ' + (j + 1) + '. [' + h.matched.length + '/' + r.terms.length + ' terms] ' + h.claim + '  *(' + String(h.title).slice(0, 70) + ')*  -> ');});
    md.push('', 'Vault has an answer? -> ', '');
  });
  fs.writeFileSync(path.join(outDir, 'search_baseline.md'), md.join('\n'));
  const none = results.filter(function (r) { return !r.hits.length; }).length;
  console.log(index.n + ' burrs indexed; ' + results.length + ' queries; ' + none + ' with no hits. Written to ' + outDir + '/search_baseline.md and .json');
}

module.exports = { terms, matchExpr, buildIndex, search };
if (require.main === module) main();
