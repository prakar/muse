#!/usr/bin/env node
'use strict';
// E1: what would the experimental variantKey (w->v, aspirate-h drop, doubled letters) merge, beyond foldKey?
// Read-only review list for a human: each group = distinct foldKey surfaces that collapse to one variantKey.
// Usage: node code/lab/e1_fold.js --db eval.db [--version nug-v6] [--out file.md]
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), B = require('../lib/bristles'), F2 = require('./fold2');
const NUMERIC = new Set(['time', 'number', 'quantity', 'measure']);

// Pure: burrs -> groups [{vkey, forms:[{fold, surface, n, notes, types}]}], only groups with >1 fold form.
function foldGroups(burrs, rules) {
  const v2 = rules === 'v2', vk = v2 ? B.variantKey : B.variantKeyV1;
  const forms = new Map();   // fold -> {surface counts, notes, types}
  burrs.forEach(b => (b.hooks || []).forEach(h => {
    if (!h || !h.value || NUMERIC.has(h.type) || (v2 && F2.WORD_TYPES.has(h.type))) return;
    const f = B.foldKey(h.value); if (!B.usableKey(f) || !/\p{L}/u.test(f)) return;
    if (!forms.has(f)) forms.set(f, { fold: f, raw: h.value, surfaces: new Map(), notes: new Set(), types: new Set(), n: 0 });
    const e = forms.get(f); e.n++; e.notes.add(b.note_id); e.types.add(h.type); e.surfaces.set(h.value, (e.surfaces.get(h.value) || 0) + 1);
  }));
  const groups = new Map();
  forms.forEach(e => { const v = vk(e.raw); if (!groups.has(v)) groups.set(v, []); groups.get(v).push(e); });
  return Array.from(groups.entries()).filter(g => g[1].length > 1).map(g => ({
    vkey: g[0],
    forms: g[1].map(e => ({ fold: e.fold, surface: Array.from(e.surfaces.entries()).sort((a, b) => b[1] - a[1])[0][0], n: e.n, notes: e.notes.size, types: Array.from(e.types) })).sort((a, b) => b.notes - a.notes)
  })).sort((a, b) => b.forms.reduce((s, f) => s + f.notes, 0) - a.forms.reduce((s, f) => s + f.notes, 0));
}

function render(groups, version) {
  const lines = ['# E1 review: variantKey merges (' + version + ')', '', groups.length + ' groups. Mark each: OK (same name) / NO (different things). Bad merges show which letter rule to drop.', ''];
  groups.forEach((g, i) => {
    lines.push('## ' + (i + 1) + '. ' + g.vkey + '   [ ] OK  [ ] NO');
    g.forms.forEach(f => lines.push('- ' + f.surface + '  (notes ' + f.notes + ', hooks ' + f.n + ', ' + f.types.join('/') + ')'));
    lines.push('');
  });
  return lines.join('\n');
}

function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  const dbPath = arg('db'), version = arg('version', D.DEFAULT_VERSION);
  if (!dbPath) { console.error('Usage: node code/lab/e1_fold.js --db eval.db [--version nug-v6] [--out file.md]'); process.exit(1); }
  const rules = arg('rules', 'v1'), burrs = D.loadBurrs(D.openCopy(dbPath), version), groups = foldGroups(burrs, rules);
  const outDir = path.join(__dirname, 'out', version); fs.mkdirSync(outDir, { recursive: true });
  const out = arg('out', path.join(outDir, rules === 'v1' ? 'e1_review.md' : 'e1_review_' + rules + '.md'));
  fs.writeFileSync(out, render(groups, version + ' rules ' + rules));
  console.log(version + ': ' + burrs.length + ' burrs, ' + groups.length + ' merge groups -> ' + out);
}
module.exports = { foldGroups, render };
if (require.main === module) main();
