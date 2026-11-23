'use strict';
// A ratchet, not a wish: how many places in CORE code still name the quiz world. The numbers may only go down. When you move words into a pack and a
// count drops, lower it here; when this test says a count went UP, the new words belong in the pack, not in core.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORDS = /\bquiz|\btrivia\b|\bsetters?\b|\bpuns?\b/gi;
const SKIP = /(^|\/)(lab|node_modules|data)(\/|$)|pack_vocab\.mjs$/;   // lab is scratch work; data files are the quiz pack's registry and tags, referenced from packs/quiz
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const rel = path.relative(ROOT, path.join(dir, e.name));
    if (SKIP.test(rel)) return;
    if (e.isDirectory()) walk(path.join(dir, e.name), out); else if (/\.(js|mjs|html|css)$/.test(e.name)) out.push(rel);
  });
  return out;
}
const found = {};
walk(path.join(ROOT, 'code'), []).forEach((rel) => { const n = (fs.readFileSync(path.join(ROOT, rel), 'utf8').match(WORDS) || []).length; if (n) found[rel] = n; });

// file -> the most quiz words core may still hold there
const ALLOWED = require('./pack_leak.allowed.json');

test('core code names the quiz world no more than it did', () => {
  const worse = Object.keys(found).filter((f) => found[f] > (ALLOWED[f] || 0)).map((f) => f + ': ' + found[f] + ' (allowed ' + (ALLOWED[f] || 0) + ')');
  assert.deepStrictEqual(worse, [], 'New quiz wording in core. Put it in the pack (packs/<name>/) instead, or lower nothing.');
});
test('the allowance only shrinks: no stale entry for a file that got cleaner', () => {
  const slack = Object.keys(ALLOWED).filter((f) => (found[f] || 0) < ALLOWED[f]).map((f) => f + ': now ' + (found[f] || 0) + ', allowed ' + ALLOWED[f]);
  assert.deepStrictEqual(slack, [], 'Lower these in test/pack_leak.allowed.json');
});
