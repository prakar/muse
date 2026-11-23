'use strict';
// Stage 0 of the domain-pack refactor: freeze today's quiz behaviour so that moving code behind packs cannot change it unnoticed.
// If one of these fails after a refactor, behaviour changed. Update a hash only on purpose, and say why in the commit.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const B = require('../code/lib/burrs');
const { angles } = require('../code/lib/angles');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const note = { title: 'Quokka selfie craze, Rottnest, 2015', source_url: null };
const cleaned = 'Quokkas live on Rottnest Island off Western Australia. In 2015 the island saw a selfie craze. The animal weighs about 3 kg.';

const EXPECTED = { prompt: 'a53583d1e1a57090', verify: '5fff7b778f8b084e', angles: 'b088b87d513141f1', constants: '1dc26c61f8b4861c' };

test('extraction prompt is byte-for-byte nug-v6', () => {
  const p = B.buildPrompt(note, cleaned);
  assert.strictEqual(sha(p.system + '\u0000' + p.prompt), EXPECTED.prompt);
});

test('extraction vocabulary and caps are unchanged', () => {
  const c = JSON.stringify([B.PROMPT_VERSION, B.SCHEMA_VERSION, B.KINDS, B.HOOK_TYPES, B.CATEGORIES, B.MAX_BURRS, B.MAX_BURRS_LONG, B.MAX_BURRS_XL, B.burrCap(cleaned), B.burrCap('x'.repeat(1500)), B.burrCap('x'.repeat(3000))]);
  assert.strictEqual(sha(c), EXPECTED.constants);
});

test('verifyBurrs gives the same accepted and rejected burrs on a fixed response', () => {
  const model = [
    { claim: 'Quokkas became a selfie craze on Rottnest Island in 2015.', src: [2], kind: 'fact', hooks: [{ type: 'entity', value: 'Quokkas', cat: 'animal' }, { type: 'place', value: 'Rottnest', cat: 'place' }, { type: 'time', value: '2015', era: 'AD' }, { type: 'uniqueness', value: 'only here' }], perishable: false },
    { claim: 'A quokka weighs about 3 kg.', src: [3], kind: 'fact', hooks: [{ type: 'number', value: '3', unit: 'kg' }, { type: 'entity', value: 'Dragon', cat: 'animal' }], perishable: false },
    { claim: 'A quokka weighs about 9 kg.', src: [3], kind: 'fact', hooks: [], perishable: false },
    { claim: 'The note is titled about quokkas.', src: ['T'], kind: 'fact', hooks: [], perishable: false },
    { claim: 'Quokkas live on Rottnest Island.', src: [1], kind: 'weird', hooks: [{ type: 'bogus', value: 'x' }], perishable: true },
  ];
  const v = B.verifyBurrs(model, { title: note.title, cleaned });
  assert.strictEqual(sha(JSON.stringify(v)), EXPECTED.verify);
});

test('Angles output on a fixed pile is unchanged', () => {
  const b = (id, claim, kind, hooks) => ({ id, claim, kind: kind || 'fact', hooks: hooks || [] });
  const pile = [
    b(1, 'Einstein was born on 14 March 1879.'), b(2, 'The firm was founded on 14 March 1903.'),
    b(3, 'Mercury is a planet.', 'fact', [{ type: 'entity', value: 'Mercury', cat: 'place' }]),
    b(4, 'Mercury is an element.', 'fact', [{ type: 'entity', value: 'Mercury', cat: 'substance' }]),
    b(5, 'Gargantuan comes from Gargantua.', 'etymology'), b(6, 'It is the only one.', 'fact', [{ type: 'uniqueness', value: 'only one' }]),
    b(7, 'The Golden Horse was named for a trade.', 'fact', [{ type: 'homonym', value: 'The Golden Horse' }]),
    b(8, 'The bridge was built because the ferry sank.'), b(9, 'Amu Darya', 'fact', [{ type: 'entity', value: 'Amu Darya', cat: 'place' }]),
    b(10, 'Syr Darya', 'fact', [{ type: 'entity', value: 'Syr Darya', cat: 'place' }]),
  ];
  assert.strictEqual(sha(JSON.stringify(angles(pile))), EXPECTED.angles);
});

test('Angles output on a rich pile (every detector family) is unchanged', () => {
  const e = (v, c) => ({ type: 'entity', value: v, cat: c });
  const b = (id, claim, kind, hooks) => ({ id, claim, kind: kind || 'fact', hooks: hooks || [] });
  const pile = [
    b(1, 'Einstein was born on 14 March 1879.'), b(2, 'The firm was founded on 14 March 1903.'),
    b(3, 'Mercury is a planet.', 'fact', [e('Mercury', 'place')]), b(4, 'Mercury is an element.', 'fact', [e('Mercury', 'substance')]),
    b(5, 'Gargantuan comes from Gargantua.', 'etymology'), b(6, 'The word salary has a story.', 'fact', [{ type: 'etymon', value: 'salary' }]),
    b(7, 'It is the only one.', 'fact', [{ type: 'uniqueness', value: 'only one' }]),
    b(8, 'The Golden Horse was named for a trade.', 'fact', [{ type: 'homonym', value: 'The Golden Horse' }, e('The Golden Horse', 'work')]),
    b(9, 'The bridge collapsed because the ferry sank at Harbourtown.', 'fact', [e('Harbourtown', 'place')]),
    b(10, 'The ferry at Harbourtown was named after a duke.', 'fact', [e('Harbourtown', 'place')]),
    b(11, 'Harbourtown inspired by a painting.', 'fact', [e('Harbourtown', 'place')]),
    b(12, 'Amu Darya', 'fact', [e('Amu Darya', 'place')]), b(13, 'Syr Darya', 'fact', [e('Syr Darya', 'place')]),
    b(14, 'Listen was a film.', 'fact', [e('Listen', 'work')]), b(15, 'Silent was a band.', 'fact', [e('Silent', 'work')]),
    b(16, 'The firm was renamed Acme in 1950.'), b(17, 'The claim that Napoleon was short is a myth.'),
    b(18, 'The Nile is the longest river in the world.'), b(19, 'Studio 54 opened in 1977.', 'fact', [e('Studio 54', 'place')]),
    b(20, 'Kent and Lent differ.', 'fact', [e('Kent', 'place'), e('Lent', 'event')]), b(21, 'Snow Hill', 'fact', [e('Snow Hill', 'place')]), b(22, 'Snow Mountain', 'fact', [e('Snow Mountain', 'work')]),
    b(23, 'This folk etymology is wrong; it is not named after a saint.'), b(24, 'The practice commemorates a battle.'), b(25, 'It was copied: a clone of the original.'),
  ];
  
  assert.strictEqual(sha(JSON.stringify(angles(pile))), 'af007f31e66f5c9d');
});

test('the quiz pack\'s Help and Muse map content is unchanged (every recipe, feature, glossary line)', async () => {
  const { pathToFileURL } = require('url'), path = require('path');
  const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js');
  const M = await import(pathToFileURL(path.join(UI, 'muse_map.mjs')).href), H = await import(pathToFileURL(path.join(UI, 'help_content.mjs')).href);
  const all = { FEATURES: M.FEATURES, DATA: M.DATA, BUDGET: M.BUDGET, INTRO: H.INTRO, QUICK_KEYS: H.QUICK_KEYS, WHICH: H.WHICH, RECIPES: H.RECIPES, SAVED: H.SAVED, GLOSSARY: H.GLOSSARY, COMING: H.COMING, SYSADMIN: H.SYSADMIN };
  assert.strictEqual(sha(JSON.stringify(all)), '1bb5aab26bfafc10');
});

test('the dipaka packet, wordplay kind labels and hook-type labels are unchanged for the quiz pack', async () => {
  const { pathToFileURL } = require('url'), path = require('path');
  const D = require('../code/lib/dipaka');
  const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js');
  const K = await import(pathToFileURL(path.join(UI, 'kinds.mjs')).href), L = await import(pathToFileURL(path.join(UI, 'kind_labels.mjs')).href);
  const packet = D.buildPacket([{ note: 'Lamp', claim: 'A lamp.' }, { note: 'Oil', claim: 'Oil burns.' }], ['burns in it']);
  const keys = ['all', 'anagram-pair', 'one-letter-off', 'head-tail', 'homophone', 'anagram-of-word', 'hidden-word', 'reversal', 'digit-lookalike', 'new-kind'];
  const types = ['entity', 'place', 'time', 'day', 'number', 'material', 'etymon', 'mechanism', 'title', 'former-role', 'uniqueness', 'homonym', 'set', 'odd-type'];
  const all = { packet, version: D.PROMPT_VERSION, labels: D.LABELS, kinds: keys.map((k) => [K.kindLabel(k), K.kindBlurb(k)]), types: types.map((t) => L.typeLabel(t)) };
  assert.strictEqual(sha(JSON.stringify(all)), 'ae531c73d414a5aa');
});
