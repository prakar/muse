#!/usr/bin/env node
'use strict';
// Pun fit: for a wordplay edge "name ~ everyday word" (Wales / whales), how close is the word to what the vault says about the name?
// A pun lands when the word's meaning belongs to the name's topic. Local embedding model (Ollama), no LLM, no cost.
//   node --no-warnings code/lab/pun_fit.js --db vault.db --dry-run             counts only, nothing embedded
//   node --no-warnings code/lab/pun_fit.js --db vault.db [--model embeddinggemma] [--limit 200] [--apply]
// fit = cosine(word, name's notes) minus the word's average cosine to random notes, so generic words do not score high just for being generic.
// Writes out/<version>/pun_fit.jsonl and pun_fit_top.md; --apply also fills wordplay_edges.fit if that table exists.
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), S = require('./sim'), { ollamaBackend } = require('./embed_ollama'), WP = require('../wordplay');
const KINDS = ['homophone', 'anagram-of-word', 'head-tail', 'hidden-word'];

// Pure. edges: [{kind,a_name,b_name,a_notes,grade}]. claimsOf(noteId)->[string]. embed(texts)->{vecs}. Returns scored rows, best fit first.
async function fitScores(edges, claimsOf, embed, opts) {
  opts = opts || {};
  const nBase = opts.baseline || 25, perCtx = opts.claimsPerContext || 4;
  const ctxText = e => e.a_name + '. ' + [].concat.apply([], (e.a_notes || []).slice(0, 3).map(n => claimsOf(n).slice(0, perCtx))).join(' ').slice(0, 1200);
  const use = edges.filter(e => e.b_name && (e.a_notes || []).length && ctxText(e).length > e.a_name.length + 5);
  const ctxs = use.map(ctxText), words = Array.from(new Set(use.map(e => e.b_name.toLowerCase())));
  const pool = ctxs.filter((_, i) => i % Math.max(1, Math.floor(ctxs.length / nBase)) === 0).slice(0, nBase);
  const all = Array.from(new Set(ctxs.concat(words, pool))), em = await embed(all), vec = new Map(all.map((t, i) => [t, em.vecs[i]]));
  const base = new Map(words.map(w => [w, pool.reduce((s, c) => s + S.cosDense(vec.get(w), vec.get(c)), 0) / Math.max(1, pool.length)]));
  return use.map((e, i) => { const w = e.b_name.toLowerCase(), sim = S.cosDense(vec.get(w), vec.get(ctxs[i])), b = base.get(w);
    return { kind: e.kind, a: e.a_name, b: e.b_name, sim: +sim.toFixed(4), base: +b.toFixed(4), fit: +(sim - b).toFixed(4), grade: e.grade, notes: e.a_notes.length }; })
    .sort((x, y) => y.fit - x.fit);
}
module.exports = { fitScores, KINDS };

if (require.main === module) (async function () {
  const a = process.argv.slice(2), flag = f => a.includes('--' + f), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/pun_fit.js --db vault.db [--model embeddinggemma] [--limit N] [--dry-run] [--apply]'); process.exit(1); }
  const version = arg('version', D.DEFAULT_VERSION), model = arg('model', 'embeddinggemma'), dbRO = D.openCopy(arg('db'));
  const built = WP.build(dbRO, version, arg('cmudict', path.join(__dirname, 'out', 'cmudict.dict')));
  let edges = built.rows.filter(r => KINDS.includes(r.kind)); if (arg('limit')) edges = edges.slice(0, +arg('limit'));
  const byNote = new Map(); D.loadBurrs(dbRO, version).forEach(b => { if (!byNote.has(b.note_id)) byNote.set(b.note_id, []); byNote.get(b.note_id).push(b.claim); });
  console.log(edges.length + ' edges to score (' + KINDS.join(', ') + '), model ' + model);
  if (flag('dry-run')) { console.log('Dry run, nothing embedded.'); return; }
  const cache = new S.EmbedCache(path.join(__dirname, 'out', 'cache'), model), backend = ollamaBackend(model);
  const rows = await fitScores(edges, n => byNote.get(n) || [], t => S.embedAll(backend, t, cache), {});
  const out = path.join(__dirname, 'out', version); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'pun_fit.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'pun_fit_top.md'), '# Pun fit, best first (' + model + ')\n\nfit = word-to-notes similarity minus the word\'s average similarity to random notes.\n\n' + rows.slice(0, 150).map(r => '- ' + r.a + ' ~ ' + r.b + '  [' + r.kind + ', fit ' + r.fit + ']').join('\n') + '\n');
  console.log(rows.length + ' scored; top: ' + rows.slice(0, 8).map(r => r.a + '~' + r.b).join(', ') + '\nwritten to ' + out);
  if (flag('apply')) {
    const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(arg('db'));
    try { const up = db.prepare('UPDATE wordplay_edges SET fit = ? WHERE kind = ? AND a_name = ? AND b_name = ?'); let n = 0; rows.forEach(r => { n += up.run(r.fit, r.kind, r.a, r.b).changes; }); console.log('fit written to ' + n + ' wordplay_edges rows'); }
    catch (e) { console.log('wordplay_edges not found or not writable (' + e.message + '); run npm run wordplay -- --apply first'); }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
