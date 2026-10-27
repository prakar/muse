'use strict';
// AUC by rank-sum (ties averaged). pos/neg are arrays of scores.
function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = pos.map(s => [s, 1]).concat(neg.map(s => [s, 0])).sort((a, b) => a[0] - b[0]);
  let rankSum = 0, i = 0;
  while (i < all.length) {
    let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (all[k][1]) rankSum += avg;
    i = j + 1;
  }
  return (rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
// ranked: array of booleans (is relevant) best-first
function precisionAtK(ranked, k) { const t = ranked.slice(0, k); return t.length ? t.filter(Boolean).length / t.length : NaN; }
function recallAtK(ranked, k, totalRelevant) { return totalRelevant ? ranked.slice(0, k).filter(Boolean).length / totalRelevant : NaN; }
function bootstrapCI(fn, pos, neg, n, seed) {
  let s = seed || 1; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = a => a.map(() => a[Math.floor(rnd() * a.length)]);
  const v = []; for (let i = 0; i < (n || 200); i++) v.push(fn(pick(pos), pick(neg)));
  v.sort((a, b) => a - b); return [v[Math.floor(v.length * 0.025)], v[Math.floor(v.length * 0.975)]];
}
module.exports = { auc, precisionAtK, recallAtK, bootstrapCI };
