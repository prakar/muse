'use strict';
// The neutral example pack ships beside the quiz pack. It must load, ask for facts without any quiz wording, find its two simple shapes, and offer no wordplay.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../code/lib/pack');
const B = require('../code/lib/burrs');
const Lenses = require('../code/lib/lenses');

const g = P.loadPack('general');

test('the general pack loads and has no wordplay or quiz wording', () => {
  assert.strictEqual(g.name, 'general');
  assert.deepStrictEqual(g.capabilities, []);
  const r = B.buildPrompt({ title: 'Board approves new office, Leeds, 2021', source_url: null }, 'The board met.', g.extraction);
  assert.ok(!/quiz|etymon|homonym|Quokka|former-role|uniqueness/i.test(r.system + r.prompt));
  assert.ok(r.prompt.includes('Use ONLY what the note states') && r.prompt.includes('"definition" = what a term'));
  assert.strictEqual(g.vocabulary.purpose.startsWith('so you can see'), true);
});

test('the general pack finds a shared day and a name with two meanings', () => {
  const pile = [{ id: 1, claim: 'Founded on 14 March 1903.' }, { id: 2, claim: 'A merger closed on 14 March 1950.' },
    { id: 3, claim: 'Mercury is a planet.', hooks: [{ type: 'entity', value: 'Mercury', cat: 'place' }] }, { id: 4, claim: 'Mercury Ltd is a firm.', hooks: [{ type: 'entity', value: 'Mercury', cat: 'organisation' }] }];
  const rows = Lenses.run(pile, g.lens);
  assert.deepStrictEqual(rows.map((r) => r.name).sort(), ['One name, different things', 'Same day']);
});

test('the quiz pack stays the default, and the general pack can be chosen by name', () => {
  const saved = process.env.MUSE_PACK; delete process.env.MUSE_PACK;
  try { assert.strictEqual(P.current({ fresh: true }).name, 'quiz'); process.env.MUSE_PACK = 'general'; assert.strictEqual(P.current({ fresh: true }).name, 'general'); }
  finally { if (saved) process.env.MUSE_PACK = saved; else delete process.env.MUSE_PACK; }
});
