'use strict';
// Search, the deterministic parts: question -> words, a word index over burr claims (SQLite FTS5 in memory, BM25), rank fusion,
// grouping by note, vector ranking and the three confidence bands. No network, no files, no LLM. Everything here is pure or builds an in-memory index.
const { DatabaseSync } = require('node:sqlite');
const L = require('./bristles');

// Words that make a sentence a question but carry no topic. BM25 would otherwise match "does", "how", "is" in every claim.
const QUESTION_WORDS = new Set('what whats how why who when where which does did do is are was were am can could would should will has have had any there case if much many not no yes also ever always one'.split(' '));

// The confidence bands, from the rewrite-leg similarity (embeddinggemma, rewrite prompt rw1). Calibrated on 43 questions (30 + 13 held out, 29 Oct 2026):
// at 0.50 the rule kept 12 of 18 answerable questions and passed 2 of 25 unanswerable ones. A starting point, not a law: edit here (or pass your own).
const BANDS = { likely: 0.5, weak: 0.4, calibratedFor: { model: 'embeddinggemma', prompt: 'rw1', n: 43 } };

// Pure: a question -> its search terms (stopwords and question words removed, de-duplicated, order kept).
function queryTerms(question) {
  const seen = new Set(), out = [];
  (String(question || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).forEach(function (w) {
    if (w.length < 2 || L.STOP.has(w) || QUESTION_WORDS.has(w) || seen.has(w)) return;
    seen.add(w); out.push(w);
  });
  return out;
}
// Pure: FTS5 MATCH expression. Every term is quoted (no query syntax can leak in) and joined with OR; BM25 ranks the best overlap first.
function matchExpr(terms) { return terms.map(function (t) { return '"' + t.replace(/"/g, '') + '"'; }).join(' OR '); }

// Builds the word index. burrs: [{id, noteId, claim, note}]. Returns { size, search(question, k) -> [{id, score}] }.
function buildWordIndex(burrs) {
  const idx = new DatabaseSync(':memory:');
  idx.exec("CREATE VIRTUAL TABLE f USING fts5(claim, title, tokenize='porter unicode61 remove_diacritics 2')");
  const ins = idx.prepare('INSERT INTO f(rowid, claim, title) VALUES (?,?,?)'), idOf = [];
  idx.exec('BEGIN');
  burrs.forEach(function (b, i) { ins.run(i + 1, b.claim, b.note || ''); idOf[i + 1] = b.id; });
  idx.exec('COMMIT');
  const q = idx.prepare('SELECT rowid AS r, bm25(f, 1.0, 0.5) AS score FROM f WHERE f MATCH ? ORDER BY score LIMIT ?');
  return {
    size: burrs.length,
    search: function (question, k) {
      const ts = queryTerms(question);
      return ts.length ? q.all(matchExpr(ts), k || 80).map(function (r) { return { id: idOf[r.r], score: r.score }; }) : [];
    }
  };
}

// Pure: reciprocal rank fusion of ranked id lists; ids that rank well in several lists rise. Ties keep first-seen order.
function rrf(lists, k) {
  const c = 60, sc = new Map();
  lists.forEach(function (l) { l.forEach(function (id, r) { sc.set(id, (sc.get(id) || 0) + 1 / (c + r + 1)); }); });
  return Array.from(sc.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, k).map(function (e) { return e[0]; });
}
// Pure: best-first ids, at most perNote from each note, up to k, so one note cannot fill the page.
function groupByNote(ids, noteOf, perNote, k) {
  const seen = new Map(), out = [];
  for (const id of ids) { const n = noteOf(id), c = seen.get(n) || 0; if (c >= perNote) continue; seen.set(n, c + 1); out.push(id); if (out.length >= k) break; }
  return out;
}

// Vector rows are stored unit length, so similarity is a dot product. mat: Float32Array(count*dim); q: unit-length array.
function rankVectors(mat, dim, count, q, k) {
  const sims = new Float32Array(count);
  for (let i = 0; i < count; i++) { let s = 0; const o = i * dim; for (let j = 0; j < dim; j++) s += mat[o + j] * q[j]; sims[i] = s; }
  const top = [];
  for (let i = 0; i < count; i++) {
    if (top.length < k) { top.push(i); if (top.length === k) top.sort(function (a, b) { return sims[b] - sims[a]; }); }
    else if (sims[i] > sims[top[k - 1]]) { top[k - 1] = i; let j = k - 1; while (j > 0 && sims[top[j]] > sims[top[j - 1]]) { const t = top[j]; top[j] = top[j - 1]; top[j - 1] = t; j--; } }
  }
  if (top.length < k) top.sort(function (a, b) { return sims[b] - sims[a]; });
  return top.map(function (i) { return { row: i, sim: sims[i] }; });
}
function normalise(v) { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; }

// Pure: similarity of the best match (rewrite leg) -> 'likely' | 'weak' | 'nothing'. The words are about matches, never about answers.
function bandOf(sim, bands) {
  bands = bands || BANDS;
  return sim >= bands.likely ? 'likely' : sim >= bands.weak ? 'weak' : 'nothing';
}
const BAND_TEXT = {
  likely: 'These facts are close to your question. Close is not the same as answering it, so read them.',
  weak: 'Nothing here clearly answers this. The closest facts are only loosely related and may just share a topic.',
  nothing: 'Nothing close in the vault. The nearest facts are folded away below in case they help.'
};

module.exports = { QUESTION_WORDS, BANDS, BAND_TEXT, queryTerms, matchExpr, buildWordIndex, rrf, groupByNote, rankVectors, normalise, bandOf };
