'use strict';
/**
 * QUARRY lib/dedupe.js — find duplicate burrs, deterministically (Muse Constitution Art. 1, 5, 6, 7).
 *
 * Two kinds, both soft: nothing is deleted, rows are only linked to the burr that is kept.
 *   echo  — within ONE note, a burr says what a longer burr of the same note already says
 *           (the shorter claim is contained in the longer one). The shorter is hidden from counts and sparks.
 *   clone — the SAME fact stated in DIFFERENT notes. Both stay (each has its own provenance); they are
 *           grouped, count once, and a spark may not join a note to its own clone.
 *
 * A pair counts as a duplicate only when the claims share their content words AND carry the same
 * numbers and the same proper names (or one carries a strict subset of them). That is what keeps
 * "players from Kenya" and "players from Uganda", or "Monsanto" and "SeaWorld", apart.
 * The kept burr of a group is the longest claim (most specific); ties go to the lowest id.
 */
const STOP = new Set('the a an of in on at to is was were are and or for by with as from that this it its be has had have been also'.split(' '));

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function words(s) { return new Set(norm(s).split(' ').filter(function (w) { return w && !STOP.has(w); })); }
function digits(s) { return new Set(String(s || '').match(/\d+(?:[.,]\d+)*/g) || []); }
function names(s) {   // capitalised words, except the first word of the claim (a sentence-initial capital means nothing)
  const out = new Set(), caps = String(s || '').match(/\b[A-Z][A-Za-z'’-]+\b/g) || [];
  const first = (String(s || '').match(/^\s*([A-Za-z'’-]+)/) || [])[1];
  caps.forEach(function (w, k) { if (k === 0 && w === first) return; out.add(w.toLowerCase()); });
  return out;
}
function subset(a, b) { for (const x of a) if (!b.has(x)) return false; return true; }
function inter(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n; }

const NEG = /\b(not|no|never|none|neither|nor|without|cannot|can't|isn't|wasn't|aren't|weren't|didn't|doesn't|don't|hasn't|hadn't|won't)\b/i;
function prep(b) { return { id: b.id, note_id: b.note_id, claim: b.claim, n: norm(b.claim), w: words(b.claim), d: digits(b.claim), p: names(b.claim), neg: NEG.test(String(b.claim || '').replace(/’/g, "'")) }; }

// Are x and y the same fact? Returns a score in (0,1] or 0.
function sameFact(x, y) {
  if (x.n === y.n) return 1;
  if (x.neg !== y.neg) return 0;   // a negation in one claim only: opposite facts, never a match
  if (x.w.size < 3 || y.w.size < 3) return 0;
  const small = x.w.size <= y.w.size ? x : y, big = small === x ? y : x;
  const contain = inter(small.w, big.w) / small.w.size;
  const jac = inter(x.w, y.w) / (x.w.size + y.w.size - inter(x.w, y.w));
  const need = x.note_id === y.note_id ? 0.95 : 0.9;   // inside one note a shorter claim must be almost fully contained
  if (contain < need || jac < 0.8) return 0;
  // same numbers and names, or the shorter one carries a subset of the longer one's
  const dOk = subset(small.d, big.d), pOk = subset(small.p, big.p);
  if (!dOk || !pOk) return 0;
  // the longer claim must not bring in different numbers or names of its own that the shorter one contradicts
  if (small.d.size && big.d.size && !subset(big.d, small.d) && !subset(small.d, big.d)) return 0;
  return jac;
}

/**
 * burrs: [{id, note_id, claim}]. Returns [{id, dup_of, kind, score}] for the burrs that duplicate a kept one.
 */
function findDupes(burrs) {
  const P = burrs.map(prep), n = P.length;
  const parent = P.map(function (_, i) { return i; });
  const find = function (x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const score = new Map();
  const df = new Map(); P.forEach(function (p) { p.w.forEach(function (w) { df.set(w, (df.get(w) || 0) + 1); }); });
  const inv = new Map();
  P.forEach(function (p, i) {
    Array.from(p.w).filter(function (w) { return df.get(w) <= 60; }).sort(function (a, b) { return df.get(a) - df.get(b) || (a < b ? -1 : 1); }).slice(0, 3)
      .forEach(function (w) { if (!inv.has(w)) inv.set(w, []); inv.get(w).push(i); });
  });
  const seen = new Set();
  inv.forEach(function (ids) {
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const i = ids[a], j = ids[b], key = i * n + j; if (seen.has(key)) continue; seen.add(key);
      const s = sameFact(P[i], P[j]); if (!s) continue;
      const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj;
      score.set(key, s);
    }
  });
  const groups = new Map();
  P.forEach(function (p, i) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const out = [];
  groups.forEach(function (g) {
    if (g.length < 2) return;
    // keep the longest claim, ties to the lowest id
    g.sort(function (a, b) { return P[b].claim.length - P[a].claim.length || P[a].id - P[b].id; });
    const keep = P[g[0]];
    g.slice(1).forEach(function (i) {
      const key = Math.min(i, g[0]) * n + Math.max(i, g[0]);
      out.push({ id: P[i].id, dup_of: keep.id, kind: P[i].note_id === keep.note_id ? 'echo' : 'clone', score: Math.round((score.get(key) || 0.6) * 100) / 100 });
    });
  });
  out.sort(function (a, b) { return a.id - b.id; });
  return out;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS burr_dupes (
  burr_id INTEGER PRIMARY KEY,
  dup_of  INTEGER NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('echo','clone')),
  score   REAL,
  status  TEXT NOT NULL DEFAULT 'dup',
  run_id  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_burr_dupes_of ON burr_dupes(dup_of);
`;

module.exports = { findDupes, sameFact, prep, SCHEMA_SQL, norm };
