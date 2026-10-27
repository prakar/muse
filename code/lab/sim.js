'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../lib/bristles');

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function cosDense(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? d / Math.sqrt(na * nb) : 0; }

// Backend interface: { name, embed(texts: string[]) -> Promise<number[][]> }
// TF-IDF baseline: sparse vectors, same tokeniser as production bristles.
function tfidfBackend(texts) {
  const toks = texts.map(t => B.tokens(t));
  const idf = B.buildIdf ? B.buildIdf(toks) : new Map();
  const vecs = toks.map(t => B.vectorOf(t, idf));
  return { name: 'tfidf', vecs, sim: (i, j) => B.cosine(vecs[i], vecs[j]) };
}

// Disk cache keyed by sha(text)+model, so a new nuggetize version only embeds changed claims.
class EmbedCache {
  constructor(dir, model) { this.dir = dir; this.model = model; this.file = path.join(dir, model.replace(/[^\w.-]/g, '_') + '.jsonl'); this.map = new Map(); this.load(); }
  load() { try { fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).forEach(l => { const o = JSON.parse(l); this.map.set(o.k, o.v); }); } catch (e) { /* empty */ } }
  get(text) { return this.map.get(sha(text)); }
  put(text, v) { const k = sha(text); this.map.set(k, v); fs.mkdirSync(this.dir, { recursive: true }); fs.appendFileSync(this.file, JSON.stringify({ k: k, v: v }) + '\n'); }
}

async function embedAll(backend, texts, cache) {
  const out = new Array(texts.length), todo = [];
  texts.forEach((t, i) => { const c = cache && cache.get(t); if (c) out[i] = c; else todo.push(i); });
  const BATCH = 32;
  for (let i = 0; i < todo.length; i += BATCH) {
    const idx = todo.slice(i, i + BATCH), vs = await backend.embed(idx.map(j => texts[j]));
    idx.forEach((j, n) => { out[j] = vs[n]; if (cache) cache.put(texts[j], vs[n]); });
  }
  return { vecs: out, embedded: todo.length, cached: texts.length - todo.length };
}

module.exports = { sha, cosDense, tfidfBackend, EmbedCache, embedAll };
