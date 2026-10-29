#!/usr/bin/env node
'use strict';
// Semantic leg of the search pilot (roadmap C2). Embeds every burr claim (with the model's own document prompt) and the author's
// questions (with its query prompt) through a local Ollama, ranks by cosine, and fuses with the BM25 keyword ranking (RRF).
// No LLM calls, no spend. Needs: `ollama serve` running and `ollama pull embeddinggemma`. Reads the DB copy; writes only code/lab/out.
//   node --no-warnings code/lab/semantic_pilot.js --db eval.db [--model embeddinggemma] [--k 5] [--limit 0] [--url http://127.0.0.1:11434]
// First run embeds ~56k claims (cached in code/lab/out/cache/pilot_<model>.jsonl, so reruns are instant). Use --limit 2000 to smoke-test.
// Output: out/<version>/semantic_pilot_<model>.json and .md (side-by-side: keyword | meaning | hybrid, top k each).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const D = require('./data'), SB = require('./search_baseline'), { ollamaBackend } = require('./embed_ollama');

// Prompt formats from the model cards. Unknown models get raw text.
const PROMPTS = {
  embeddinggemma: { query: q => 'task: search result | query: ' + q, doc: (c, t) => 'title: ' + (t || 'none') + ' | text: ' + c },
  'qwen3-embedding': { query: q => 'Instruct: Given a question, retrieve facts from a personal knowledge base that answer it\nQuery:' + q, doc: c => c },
};
function promptsFor(model) { const k = Object.keys(PROMPTS).find(m => String(model).startsWith(m)); return k ? PROMPTS[k] : { query: q => q, doc: c => c }; }

function cosine(a, b) { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? s / Math.sqrt(na * nb) : 0; }

// Pure: indexes of the k highest scores, best first.
function topK(scores, k) { return scores.map((s, i) => [s, i]).sort((x, y) => y[0] - x[0]).slice(0, k).map(x => x[1]); }

// Pure: reciprocal rank fusion of several ranked id lists. Higher is better; ties keep first-seen order.
function rrf(lists, k) {
  const c = 60, sc = new Map();
  lists.forEach(l => l.forEach((id, r) => sc.set(id, (sc.get(id) || 0) + 1 / (c + r + 1))));
  return Array.from(sc.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map(e => e[0]);
}

class Cache {
  constructor(file) { this.file = file; this.m = new Map(); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.readFileSync(file, 'utf8').split('\n').forEach(l => { if (!l) return; try { const j = JSON.parse(l); this.m.set(j.h, j.v); } catch (e) { /* torn last line */ } }); }
  key(model, text) { return crypto.createHash('sha1').update(model + '\u0000' + text).digest('hex'); }
  async embedAll(be, model, texts, batch, log) {
    const todo = [], keys = texts.map(t => this.key(model, t));
    keys.forEach((h, i) => { if (!this.m.has(h)) todo.push(i); });
    const fd = fs.openSync(this.file, 'a'); const t0 = Date.now();
    for (let s = 0; s < todo.length; s += batch) {
      const idx = todo.slice(s, s + batch), vecs = await be.embed(idx.map(i => texts[i]));
      idx.forEach((i, j) => { this.m.set(keys[i], vecs[j]); fs.writeSync(fd, JSON.stringify({ h: keys[i], v: vecs[j].map(x => +x.toFixed(5)) }) + '\n'); });
      if (log && (s / batch) % 20 === 0) log('  embedded ' + Math.min(s + batch, todo.length) + '/' + todo.length + ' (' + Math.round((Date.now() - t0) / 1000) + 's)');
    }
    fs.closeSync(fd);
    return keys.map(h => this.m.get(h));
  }
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/semantic_pilot.js --db eval.db [--model embeddinggemma] [--k 5] [--limit 0]'); process.exit(1); }
  const model = arg('model', 'embeddinggemma'), version = arg('version', D.DEFAULT_VERSION), k = +arg('k', 5), limit = +arg('limit', 0);
  const P = promptsFor(model), be = ollamaBackend(model, { url: arg('url', undefined), timeoutMs: 300000 });
  const qs = JSON.parse(fs.readFileSync(arg('queries', path.join(__dirname, 'queries', 'author_queries_2026-10-29.json')), 'utf8')).queries;
  const db = D.openCopy(arg('db')), index = SB.buildIndex(db, version);
  // The same burr order as the keyword index (rowid n = nth burr), so ids line up for fusion.
  const rows = index.idx.prepare('SELECT f.rowid AS r, f.claim, f.title FROM f ORDER BY f.rowid' + (limit ? ' LIMIT ' + limit : '')).all();
  const meta = index.idx.prepare('SELECT id, burr_id, note_id FROM meta');
  const byRow = new Map(meta.all().map(m => [m.id, m]));
  console.log(rows.length + ' claims; model ' + model + '; embedding (cached after the first run)...');
  const cache = new Cache(path.join(__dirname, 'out', 'cache', 'pilot_' + model.replace(/[^\w.-]/g, '_') + '.jsonl'));
  const dv = await cache.embedAll(be, model, rows.map(r => P.doc(r.claim, r.title)), 64, console.log);
  const qv = await cache.embedAll(be, model, qs.map(P.query), 16);
  const results = qs.map((q, qi) => {
    const sims = dv.map(v => cosine(qv[qi], v)), sem = topK(sims, 50);
    const kw = SB.search(index, q, 50).hits.map(h => h.burr_id);
    const rowOfBurr = new Map(rows.map((r, i) => [byRow.get(r.r).burr_id, i]));
    const kwIdx = kw.map(b => rowOfBurr.get(b)).filter(x => x != null);
    const fmt = i => ({ burr_id: byRow.get(rows[i].r).burr_id, claim: rows[i].claim, title: rows[i].title, sim: +sims[i].toFixed(3) });
    return { id: qi + 1, query: q, keyword: kwIdx.slice(0, k).map(fmt), meaning: sem.slice(0, k).map(fmt), hybrid: rrf([kwIdx, sem], k).map(fmt) };
  });
  const outDir = path.join(__dirname, 'out', version); fs.mkdirSync(outDir, { recursive: true });
  const base = 'semantic_pilot_' + model.replace(/[^\w.-]/g, '_');
  fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({ model, k, claims: rows.length, results }, null, 2));
  const md = ['# Semantic pilot: ' + model, '', 'Top ' + k + ' per method over ' + rows.length + ' claims. sim = cosine (for reading only, not a score to trust).', ''];
  results.forEach(r => {
    md.push('## ' + r.id + '. ' + r.query, '');
    ['keyword', 'meaning', 'hybrid'].forEach(m => { md.push('**' + m + '**'); r[m].forEach((h, j) => md.push((j + 1) + '. ' + h.claim.slice(0, 160) + '  *(' + String(h.title).slice(0, 50) + ')*  ' + h.sim)); md.push(''); });
  });
  fs.writeFileSync(path.join(outDir, base + '.md'), md.join('\n'));
  console.log('Written ' + path.join(outDir, base + '.md'));
}

module.exports = { promptsFor, cosine, topK, rrf };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
