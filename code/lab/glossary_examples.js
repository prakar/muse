'use strict';
/**
 * QUARRY lab/glossary_examples.js — one example per heuristic for the Angles glossary, from the Illustrations note (a local vault note).
 * The fragments are paraphrases of other setters' questions, so they stay on this machine: the output goes to backtest/glossary-examples.json (gitignored), never into the repo.
 * Prefers a high-confidence fragment, then the shortest. Your own (source P) fragments are marked own:true.
 *   QUARRY_VAULT_NOTES=... node code/lab/glossary_examples.js
 */
const fs = require('node:fs'), path = require('node:path');
const { parseFragments } = require('./relation_pilot');
const rank = f => (f.conf === 'H' ? 0 : f.conf === 'M' ? 1 : 2) * 1000 + (f.text.length < 30 ? 600 : 0) + f.text.length;   // a bare name is a poor example: prefer a sentence
function pickExamples(frags) {
  const best = {};
  frags.forEach(f => { if (!best[f.h] || rank(f) < rank(best[f.h])) best[f.h] = f; });
  const out = {}; Object.keys(best).forEach(h => { out[h] = { text: best[h].text, src: best[h].src, own: best[h].src === 'P', conf: best[h].conf }; });
  return out;
}
module.exports = { pickExamples };
if (require.main === module) {
  const md = fs.readFileSync(path.join(require('../heuristics_build').NOTES, 'QUARRY - Heuristics Illustrations.md'), 'utf8'), ex = pickExamples(parseFragments(md));
  const dir = path.join(__dirname, '..', '..', 'backtest'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'glossary-examples.json'), JSON.stringify(ex, null, 1) + '\n');
  console.log(Object.keys(ex).length + ' examples written to backtest/glossary-examples.json (local only)');
}
