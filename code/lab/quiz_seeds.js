#!/usr/bin/env node
'use strict';
// "Does the vault hand me material for my next question?" (roadmap C2, Muse-side probe).
// Each of the author's own quiz items (backtest/items-arre.jsonl: question + answer read as one unit) is used as a query into the vault's burrs.
// Per item: top hits by meaning (max 2 per note, so one note cannot fill the list) and by keyword, for the author to grade.
// Read-only: quiz text stays in backtest/ and in code/lab/out/, both gitignored (Muse Constitution, Decision 7). Nothing touches the vault or the DB.
// Run AFTER semantic_pilot.js has finished (it reuses that run's vectors from code/lab/out/cache), with Ollama running:
//   node --no-warnings code/lab/quiz_seeds.js --db eval.db [--items backtest/items-arre.jsonl] [--model embeddinggemma] [--k 5]
// Output: out/<version>/quiz_seeds_<model>.md and .json
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const D = require('./data'), SB = require('./search_baseline'), SP = require('./semantic_pilot'), { ollamaBackend } = require('./embed_ollama');

// Pure: the text used as the query: question and answer as one unit, tidy, capped so a long slide cannot swamp the vector.
function seedText(item, cap) {
  const t = [item.question, item.answer ? 'Answer: ' + item.answer : ''].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim();
  return t.length > cap ? t.slice(0, cap) : t;
}

// Pure: best-first indexes, at most perNote from each note, up to k.
function diversify(order, noteOf, perNote, k) {
  const seen = new Map(), out = [];
  for (const i of order) { const n = noteOf(i), c = seen.get(n) || 0; if (c >= perNote) continue; seen.set(n, c + 1); out.push(i); if (out.length >= k) break; }
  return out;
}

function loadVectors(file, model, texts) {
  const m = new Map();
  fs.readFileSync(file, 'utf8').split('\n').forEach(l => { if (!l) return; try { const j = JSON.parse(l); m.set(j.h, j.v); } catch (e) { /* torn last line */ } });
  const key = t => crypto.createHash('sha1').update(model + '\u0000' + t).digest('hex');
  return texts.map(t => m.get(key(t)) || null);
}

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/quiz_seeds.js --db eval.db [--items backtest/items-arre.jsonl] [--model embeddinggemma] [--k 5]'); process.exit(1); }
  const model = arg('model', 'embeddinggemma'), version = arg('version', D.DEFAULT_VERSION), k = +arg('k', 5), cap = +arg('cap', 1500);
  const P = SP.promptsFor(model), be = ollamaBackend(model, { url: arg('url', undefined), timeoutMs: 300000 });
  const itemsFile = path.resolve(arg('items', path.join(__dirname, '..', '..', 'backtest', 'items-arre.jsonl')));
  const items = fs.readFileSync(itemsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const db = D.openCopy(arg('db')), index = SB.buildIndex(db, version);
  const rows = index.idx.prepare('SELECT f.rowid AS r, f.claim, f.title FROM f ORDER BY f.rowid').all();
  const byRow = new Map(index.idx.prepare('SELECT id, burr_id, note_id FROM meta').all().map(m => [m.id, m]));
  const cacheFile = path.join(__dirname, 'out', 'cache', 'pilot_' + model.replace(/[^\w.-]/g, '_') + '.jsonl');
  if (!fs.existsSync(cacheFile)) { console.error('No vectors yet at ' + cacheFile + '. Run semantic_pilot.js first.'); process.exit(1); }
  const dv = loadVectors(cacheFile, model, rows.map(r => P.doc(r.claim, r.title)));
  const missing = dv.filter(v => !v).length;
  if (missing) { console.error(missing + ' of ' + rows.length + ' claims have no vector. Let semantic_pilot.js finish first.'); process.exit(1); }
  const texts = items.map(it => seedText(it, cap));
  const qv = await be.embed(texts.map(P.query));
  const noteOf = i => byRow.get(rows[i].r).note_id;
  const rowOfBurr = new Map(rows.map((r, i) => [byRow.get(r.r).burr_id, i]));
  const results = items.map((it, qi) => {
    const sims = dv.map(v => SP.cosine(qv[qi], v)), order = SP.topK(sims, 60);
    const fmt = i => ({ burr_id: byRow.get(rows[i].r).burr_id, claim: rows[i].claim, title: rows[i].title, sim: +sims[i].toFixed(3) });
    const kw = SB.search(index, texts[qi], 60).hits.map(h => rowOfBurr.get(h.burr_id)).filter(x => x != null);
    return { n: it.n, source: it.source, seed: texts[qi].slice(0, 400), meaning: diversify(order, noteOf, 2, k).map(fmt), keyword: diversify(kw, noteOf, 2, k).map(fmt) };
  });
  const outDir = path.join(__dirname, 'out', version); fs.mkdirSync(outDir, { recursive: true });
  const base = 'quiz_seeds_' + model.replace(/[^\w.-]/g, '_');
  fs.writeFileSync(path.join(outDir, base + '.json'), JSON.stringify({ model, k, items: results }, null, 2));
  const md = ['# Quiz seeds: what does the vault offer for each of your questions? (' + model + ')', '',
    'Grade each hit: S = spark (would help me write or extend a question), R = related only, N = noise. "meaning" = embeddings; "keyword" = BM25. At most 2 hits per note. sim = cosine, for reading only.', ''];
  results.forEach(r => {
    md.push('## Q' + r.n + '  ' + r.seed.slice(0, 220).replace(/\n/g, ' '), '');
    ['meaning', 'keyword'].forEach(m => { md.push('**' + m + '**'); r[m].forEach((h, j) => md.push((j + 1) + '. ' + h.claim.slice(0, 170) + '  *(' + String(h.title).slice(0, 45) + ')*  ' + h.sim + '  -> ')); md.push(''); });
  });
  fs.writeFileSync(path.join(outDir, base + '.md'), md.join('\n'));
  console.log(items.length + ' quiz items; written ' + path.join(outDir, base + '.md') + ' (gitignored; do not copy into the vault)');
}

module.exports = { seedText, diversify };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
