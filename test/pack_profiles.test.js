'use strict';
// Packs for several professions run on the same core. None of these is "the" second pack: the contract names no profession, and these tests keep core from
// quietly favouring one. Each profile gets its own words in the extraction prompt and validator, and its own shapes in the lens engine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../code/lib/pack');
const B = require('../code/lib/burrs');
const Lenses = require('../code/lib/lenses');

const caps = { base: 12, long: 20, xl: 30, longChars: 1200, xlChars: 2500 };
const ex = (o) => Object.assign({ schemaVersion: 'burr-v1', skipRule: '', caps, example: { note: '[T] Example', reply: '{"burrs":[],"reason":""}' } }, o);
const PROFILES = {
  teacher: { who: "a teacher's planning tool", reader: 'a teacher', kinds: ['fact', 'misconception', 'objective'], notes: '"misconception" = a wrong idea a pupil holds.', strict: ['entity', 'time', 'number', 'concept'], loose: ['skill'], cats: ['pupil', 'topic', 'text', 'other'], word: 'misconception', hook: 'concept' },
  accountant: { who: "an accountant's case-history tool", reader: 'an accountant', kinds: ['fact', 'ruling', 'adjustment'], notes: '"ruling" = a tax or audit decision.', strict: ['entity', 'time', 'number', 'account'], loose: ['treatment'], cats: ['client', 'authority', 'account', 'other'], word: 'ruling', hook: 'account' },
  linguist: { who: "a linguist's corpus notebook", reader: 'a linguist', kinds: ['fact', 'gloss', 'cognate'], notes: '"gloss" = a translation of a form; "cognate" = a form with a shared origin.', strict: ['entity', 'time', 'number', 'morpheme'], loose: ['rule'], cats: ['language', 'form', 'family', 'other'], word: 'cognate', hook: 'morpheme' },
  lawyer: { who: "a lawyer's research tool", reader: 'a lawyer', kinds: ['fact', 'holding', 'obligation'], notes: '"holding" = what a court decided.', strict: ['entity', 'time', 'number', 'statute'], loose: ['issue'], cats: ['party', 'court', 'statute', 'other'], word: 'holding', hook: 'statute' },
};
const packFor = (name, p) => ({ name, contract: 1, version: '0.1.0', description: 'A test pack for ' + name + '.',
  extraction: ex({ promptVersion: name.slice(0, 3) + '-v1', audience: p.who, claimReader: p.reader, kinds: p.kinds, kindNotes: p.notes, hooks: { strict: p.strict, loose: p.loose, categorised: ['entity'] }, categories: p.cats, categoryExample: 'so one name can mean two things' }) });
function scratch(pack) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-prof-'));
  fs.mkdirSync(path.join(root, 'packs', pack.name), { recursive: true });
  fs.writeFileSync(path.join(root, 'packs', pack.name, 'pack.json'), JSON.stringify(pack));
  return root;
}

for (const [name, p] of Object.entries(PROFILES)) {
  test(name + ' pack: own words in the prompt, core rules intact, no quiz words', () => {
    const k = P.loadPack(name, scratch(packFor(name, p)));
    const r = B.buildPrompt({ title: 'T', source_url: null }, 'Some text.', k.extraction);
    assert.ok(r.system.includes(p.who) && r.prompt.includes('ONE claim ' + p.reader + ' could cite') && r.prompt.includes(p.kinds.join(' | ')));
    assert.ok(r.prompt.includes('T is one of: ' + p.strict.concat(p.loose).join(', ')));
    assert.ok(r.prompt.includes('Use ONLY what the note states') && r.prompt.includes('must appear in the cited lines'));
    assert.ok(!/quiz|etymon|homonym|Quokka|former-role/.test(r.system + r.prompt));
  });
  test(name + ' pack: validator takes its kind and hook, and still checks them against the note', () => {
    const k = P.loadPack(name, scratch(packFor(name, p)));
    const cleaned = 'The record shows a ' + p.word + ' about alpha-beta in 2020.';
    const v = B.verifyBurrs([{ claim: 'The record shows a ' + p.word + ' about alpha-beta in 2020.', src: [1], kind: p.word, hooks: [{ type: p.hook, value: 'alpha-beta' }, { type: p.hook, value: 'not in the note' }, { type: 'etymon', value: 'record' }] }], { title: 'Case', cleaned }, { ex: k.extraction });
    assert.strictEqual(v.accepted.length, 1);
    assert.strictEqual(v.accepted[0].kind, p.word);
    assert.deepStrictEqual(v.accepted[0].hooks.map((h) => h.value), ['alpha-beta']);
    assert.strictEqual(v.hooksDropped, 2);
  });
}

const registry = [{ id: 1, name: 'Recurring misconception' }, { id: 2, name: 'Same counterparty' }, { id: 3, name: 'Shared morpheme' }];
const pile = [
  { id: 1, claim: 'Pupils think multiplying always makes bigger.', kind: 'misconception', hooks: [{ type: 'concept', value: 'multiplication' }] },
  { id: 2, claim: 'Acme Ltd was audited in 2021.', kind: 'fact', hooks: [{ type: 'entity', value: 'Acme Ltd', cat: 'client' }] },
  { id: 3, claim: 'Acme Ltd disputed the 2021 ruling.', kind: 'fact', hooks: [{ type: 'entity', value: 'Acme Ltd', cat: 'client' }] },
];

test('a pack can ship its own lenses from the general detector types', () => {
  const lens = Lenses.compile({ version: 1, entries: [
    { type: 'hook-flag', h: 1, hook: 'concept', kind: 'misconception', why: 'a misconception about {value}', whyBare: 'a misconception', seed: { answer: '{value|the idea}', join: 'a wrong idea that recurs', hide: 'the idea' }, browse: true },
    { type: 'namesakes', h: 2, hook: 'entity', why: '{name} appears as {cats}', seed: { answer: '{name}', join: 'one party', hide: 'the party' } } ] }, registry);
  const rows = Lenses.run(pile, lens);
  assert.deepStrictEqual(rows.map((r) => [r.h, r.name, r.ids]), [[1, 'Recurring misconception', [1]]]);
  assert.strictEqual(rows[0].why, 'a misconception about multiplication');
  assert.strictEqual(lens.browse(pile, { noteOf: new Map() }).length, 1);
});

test('a pack with no lenses finds no shapes and nothing breaks', () => {
  assert.deepStrictEqual(Lenses.run(pile, Lenses.EMPTY), []);
  const k = P.loadPack('teacher', scratch(packFor('teacher', PROFILES.teacher)));
  assert.strictEqual(k.lens, null);
});

test('lens config mistakes are refused with a message that says where', () => {
  const bad = (entries, re) => assert.throws(() => Lenses.compile({ version: 1, entries }, registry), re);
  bad([{ type: 'telepathy' }], /type must be one of/);
  bad([{ type: 'hook-flag', h: 99, hook: 'x', why: 'w', seed: { answer: 'a', join: 'j', hide: 'h' } }], /shape 99 is not in the registry/);
  bad([{ type: 'hook-flag', h: 1, hook: 'x', why: 'w' }], /seed needs answer, join and hide/);
  bad([{ type: 'cue-shapes', shapes: [{ h: 1, re: '(', seed: { answer: 'a', join: 'j', hide: 'h' } }] }], /bad pattern/);
  bad([{ type: 'string-play', parts: [{ play: 'rhyme', h: 1, seed: { answer: 'a', join: 'j', hide: 'h' } }] }], /play must be one of/);
  assert.throws(() => Lenses.compile({ version: 2, entries: [] }, registry), /version must be 1/);
  assert.throws(() => Lenses.compile({ version: 1, entries: [{ type: 'relations' }] }, registry), /relations needs cues/);
});

test('the quiz pack lens config is valid against its own registry', () => {
  const k = P.current();
  assert.ok(k.lens && k.lens.detectors.length === 9);
  assert.ok(k.lens.names.get(45));
});
