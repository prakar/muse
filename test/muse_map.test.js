'use strict';
const test = require('node:test'), assert = require('node:assert'), path = require('path'), { pathToFileURL } = require('url');
const { check } = require('../code/muse_map_check');
const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js');

test('the Muse map matches the code: no unmapped or stale screen, button, server call or file, and no feature without help', async () => {
  const { problems, stats } = await check();
  assert.deepStrictEqual(problems.map(p => `${p.kind}: ${p.msg}`), [], 'drift found; fix the map or the code (node code/muse_map_check.js lists it)');
  assert.ok(stats.features >= 10 && stats.apis >= 10, 'the scan found the real code');
});

test('the checker catches drift: a button, a server call and a recipe the map does not know are all reported', async () => {
  const M = await import(pathToFileURL(path.join(UI, 'muse_map.mjs')).href);
  const f = M.FEATURES.find(x => x.key === 'basket'), saved = { b: f.buttons.slice(), a: M.FEATURES.find(x => x.key === 'marks').api.slice() };
  try {
    f.buttons.pop(); M.FEATURES.find(x => x.key === 'marks').api.length = 0; M.FEATURES.find(x => x.key === 'search').recipes.length = 0;
    const kinds = (await check()).problems.map(p => p.kind);
    assert.ok(kinds.includes('unmapped button') && kinds.includes('unmapped api') && kinds.includes('no help'), kinds.join());
  } finally { f.buttons.splice(0, f.buttons.length, ...saved.b); M.FEATURES.find(x => x.key === 'marks').api.push(...saved.a); M.FEATURES.find(x => x.key === 'search').recipes.push('ask', 'words'); }
  assert.deepStrictEqual((await check()).problems, [], 'restored');
});

test('Help is generated from the map: the saved-files table comes from DATA and the contents list reaches every recipe', async () => {
  const M = await import(pathToFileURL(path.join(UI, 'muse_map.mjs')).href), H = await import(pathToFileURL(path.join(UI, 'help_content.mjs')).href);
  assert.strictEqual(H.SAVED.length, M.DATA.length); assert.deepStrictEqual(H.SAVED[0], [M.DATA[0].what, M.DATA[0].where, M.DATA[0].notes]);
  const reach = new Set(M.FEATURES.filter(f => !f.legacy).flatMap(f => f.recipes || []));
  H.RECIPES.forEach(r => assert.ok(reach.has(r.key), `recipe ${r.key} is not reachable from the contents list`));
});

test('bloat: the audit warns near a budget limit, fails above it, and names the smallest features to trim', async () => {
  const M = await import(pathToFileURL(path.join(UI, 'muse_map.mjs')).href), keep = { ...M.BUDGET };
  try {
    M.BUDGET.features = 13; let r = await check(); assert.ok(r.warnings.some(w => /\d+ features/.test(w.msg)), 'warns at over 80%'); assert.deepStrictEqual(r.problems, []);
    M.BUDGET.features = 8; r = await check(); const p = r.problems.find(x => x.kind === 'bloat'); assert.ok(p && /smallest features: \w+/.test(p.msg) && /reasons/.test(p.msg), 'fails over the limit and says how to trim');
  } finally { Object.assign(M.BUDGET, keep); }
  assert.deepStrictEqual((await check()).problems, []);
});

test('Help has a Sys Admin section that documents every muse command the scripts offer', async () => {
  const H = await import(pathToFileURL(path.join(UI, 'help_content.mjs')).href), text = H.SYSADMIN.commands.map(c => c[0]).join(' ');
  ['drift', 'check', 'commit', 'hook', 'restart'].forEach(w => assert.ok(text.includes(w), `Sys Admin must document muse ${w}`));
  assert.ok(H.SYSADMIN.map.some(t => /BUDGET/.test(t)));
});

test('one vocabulary: no old action name survives on screen or in Help, Help tokens must exist, and the server\u2019s mode label matches', async () => {
  const fs = require('fs'), W = (await import(pathToFileURL(path.join(UI, 'words.mjs')).href)), H = await import(pathToFileURL(path.join(UI, 'help_content.mjs')).href);
  assert.throws(() => W.fill('Press {nonsense}'), /Unknown word/);
  assert.strictEqual(W.fill('Press {focus}, then {collect}'), `Press ${W.W.focus}, then ${W.W.collect}`);
  const OLD = /\b(Grab(bed|bing)?|Pick(ed)? up|Basket|Keep(ing)? (this|in)|Kept|Recently held|holding)\b/;
  const strings = o => typeof o === 'string' ? [o] : Array.isArray(o) ? o.flatMap(strings) : o && typeof o === 'object' ? Object.values(o).flatMap(strings) : [];
  strings([H.INTRO, H.QUICK_KEYS, H.WHICH, H.RECIPES, H.GLOSSARY, H.COMING, H.SAVED, H.SYSADMIN]).forEach(t => assert.ok(!OLD.test(t), 'Help still uses an old name: ' + t.slice(0, 80)));
  fs.readdirSync(UI, { recursive: true }).filter(f => /\.mjs$/.test(f) && !/help_content|words\.mjs$/.test(f)).forEach(f => {
    const code = fs.readFileSync(path.join(UI, f), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    [...code.matchAll(/'([^'\n]*)'/g)].forEach(m => assert.ok(!OLD.test(m[1]), `${f} still shows an old name: ${m[1].slice(0, 80)}`));
  });
  assert.strictEqual(require('../code/lib/muse_server').MODES, undefined, 'the sidebar modes are gone');
});

test('the Muse map matches the code for every profile installed, not only the default', async () => {
  const fs = require('fs'), packs = path.join(__dirname, '..', 'packs');
  const names = fs.readdirSync(packs).filter(n => fs.existsSync(path.join(packs, n, 'pack.json')));
  assert.ok(names.includes('quiz') && names.includes('general'));
  for (const n of names) {
    const { problems } = await check({ pack: n });
    assert.deepStrictEqual(problems.map(p => `${p.kind}: ${p.msg}`), [], `profile "${n}" has drift`);
  }
});
