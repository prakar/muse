'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const P = require('../code/lib/pack');
const V = require('../code/lib/pack_vocab');

const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js');

test('the on-disk UI vocabulary is the default pack\'s, not stale', () => {
  const disk = fs.readFileSync(path.join(UI, 'pack_vocab.mjs'), 'utf8');
  assert.strictEqual(disk, V.moduleText(P.loadPack(P.DEFAULT_PACK).vocabulary), 'run: node code/pack_vocab_build.js');
});

test('vocabulary mistakes are refused with the file and the key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-voc-'));
  fs.mkdirSync(path.join(root, 'packs', 'x'), { recursive: true });
  const base = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'packs/quiz/pack.json'), 'utf8')); delete base.files; delete base.lenses; delete base.vocabulary; delete base.dipaka; base.capabilities = []; base.name = 'x';
  const load = (voc) => { fs.writeFileSync(path.join(root, 'v.json'), JSON.stringify(voc)); fs.writeFileSync(path.join(root, 'packs/x/pack.json'), JSON.stringify(Object.assign({}, base, { vocabulary: 'v.json' }))); return P.loadPack('x', root); };
  assert.strictEqual(load({ purpose: 'so you can plan lessons.' }).vocabulary.purpose, 'so you can plan lessons.');
  assert.throws(() => load({ colour: 'red' }), /unknown key "colour"/);
  assert.throws(() => load({ purpose: 3 }), /purpose must be a string/);
  assert.throws(() => load([]), /must be an object/);
  assert.deepStrictEqual(P.loadPack('x', (fs.writeFileSync(path.join(root, 'packs/x/pack.json'), JSON.stringify(base)), root)).vocabulary, {});   // no vocabulary: neutral words
});

test('Help\'s first sentence takes its purpose from the pack, and ends cleanly with none', async () => {
  const src = fs.readFileSync(path.join(UI, 'help_content.mjs'), 'utf8');
  assert.ok(!/quiz/i.test(src.split('\n')[10]), 'the intro line in core names no profession');
  const H = await import(pathToFileURL(path.join(UI, 'help_content.mjs')).href);
  assert.match(H.INTRO, /^Muse shows you the connections hidden in your notes, so you can write quiz questions of your own\. It never writes a question for you\. Home shows/);
});

test('the generated UI module is plain ES module text', () => {
  assert.match(V.moduleText({ purpose: 'x' }), /export default \{\s+"purpose": "x"\s+\};/);
});

test('the wordplay capability brings its own labels and Home block to any pack that lists it, and a pack can still reword them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-cap-'));
  fs.mkdirSync(path.join(root, 'packs', 'y'), { recursive: true });
  const base = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'packs/general/pack.json'), 'utf8')); base.name = 'y'; delete base.files; delete base.lenses; delete base.vocabulary; delete base.dipaka;
  const load = (caps, voc) => { fs.writeFileSync(path.join(root, 'v.json'), JSON.stringify(voc || {})); fs.writeFileSync(path.join(root, 'packs/y/pack.json'), JSON.stringify(Object.assign({}, base, { capabilities: caps, vocabulary: 'v.json' }))); return P.loadPack('y', root); };
  assert.deepStrictEqual(load([]).vocabulary, {});
  const on = load(['wordplay'], { recipes: [{ key: 'wordplay', title: 'Mine' }], features: [{ key: 'home', 'buttons+': ['Extra'] }] }).vocabulary;
  assert.strictEqual(on.wordplayKinds['anagram-pair'].label, 'Anagram pairs');
  assert.strictEqual(on.recipes.find((r) => r.key === 'wordplay').title, 'Mine');
  assert.ok(on.recipes.find((r) => r.key === 'wordplay').steps.length > 2, 'the capability supplies the steps');
  const b = on.features.find((f) => f.key === 'home')['buttons+']; assert.strictEqual(b[0], 'Sound-alikes'); assert.strictEqual(b[b.length - 1], 'Extra');
});

test('the Help page\'s word list does not borrow the class of the fixed Glossary fly-out (it opened over Help on load)', () => {
  const help = fs.readFileSync(path.join(UI, 'views', 'help.mjs'), 'utf8');
  assert.ok(!/class: 'glossary'/.test(help), 'Help must not use class glossary: .glossary is position:fixed');
  const css = fs.readFileSync(path.join(UI, '..', 'css', 'search.css'), 'utf8');
  assert.ok(/\.wordlist dt/.test(css));
});
