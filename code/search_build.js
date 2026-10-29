#!/usr/bin/env node
'use strict';
/**
 * Builds the meaning index for Muse search: one vector per fact, in files beside vault.db (search-vectors-<model>.f32 / .json). Derived data: safe to delete, rebuild any time.
 *   node --no-warnings code/search_build.js [--db vault.db] [--version nug-v6] [--model embeddinggemma] [--url http://127.0.0.1:11434] [--no-embed]
 * Vectors already computed by the lab pilot (code/lab/out/cache/pilot_<model>.jsonl) are reused, so only new or changed facts reach the embedding server.
 * --no-embed uses that cache only and lists how many facts are missing. Read-only on vault.db; private notes (quarry_exclude) are never in the model, so never embedded.
 */
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const M = require('./lib/muse_model'), E = require('./lib/search_embed'), V = require('./lib/search_vectors');

async function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = arg('db', process.env.QUARRY_DB || path.join(HOME, 'vault.db'));
  const version = arg('version', 'nug-v6'), model = arg('model', process.env.MUSE_EMBED_MODEL || 'embeddinggemma'), noEmbed = a.includes('--no-embed');
  const labCache = path.join(__dirname, 'lab', 'out', 'cache', 'pilot_' + model.replace(/[^\w.-]/g, '_') + '.jsonl');
  const built = M.build(new DatabaseSync(DB, { readOnly: true }), version, { showDupes: !!process.env.MUSE_SHOW_DUPES });
  const key = t => crypto.createHash('sha1').update(model + '\u0000' + t).digest('hex'), have = new Map();
  if (fs.existsSync(labCache)) fs.readFileSync(labCache, 'utf8').split('\n').forEach(l => { if (!l) return; try { const j = JSON.parse(l); have.set(j.h, j.v); } catch (e) { /* torn last line */ } });
  const rows = built.burrs.map(b => { const text = E.docText(model, b); return { id: b.id, text, vec: have.get(key(text)) || null }; });
  const missing = rows.filter(r => !r.vec);
  console.log(rows.length + ' facts; ' + (rows.length - missing.length) + ' have vectors already; ' + missing.length + ' to embed.');
  if (missing.length && noEmbed) { console.error('--no-embed: leaving ' + missing.length + ' facts out of the index.'); }
  else if (missing.length) {
    const emb = E.ollamaEmbedder({ url: arg('url', process.env.OLLAMA_URL || 'http://127.0.0.1:11434'), model, timeoutMs: 300000 }), BATCH = 32;
    fs.mkdirSync(path.dirname(labCache), { recursive: true });
    for (let i = 0; i < missing.length; i += BATCH) {
      const part = missing.slice(i, i + BATCH), vs = await emb.embed(part.map(r => r.text));
      part.forEach((r, j) => { r.vec = vs[j]; fs.appendFileSync(labCache, JSON.stringify({ h: key(r.text), v: vs[j].map(x => +x.toFixed(5)) }) + '\n'); });
      process.stdout.write('\r  embedded ' + Math.min(i + BATCH, missing.length) + '/' + missing.length);
    }
    process.stdout.write('\n');
  }
  const ok = rows.filter(r => r.vec), out = V.write(HOME, model, ok);
  console.log('Wrote ' + out.count + ' vectors (' + out.dim + ' numbers each) to ' + V.fileBase(HOME, model) + '.{f32,json}' + (ok.length < rows.length ? ' (' + (rows.length - ok.length) + ' facts left out; they still show up in word search)' : ''));
}
if (require.main === module) main().catch(e => { console.error('search_build failed: ' + e.message); process.exit(1); });
