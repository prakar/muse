'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../code/lib/pack');
const B = require('../code/lib/burrs');

const QUIZ = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'packs/quiz/pack.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

// A scratch project root with a data file and one pack folder.
function scratch(pack, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-pack-'));
  fs.mkdirSync(path.join(root, 'packs', name || pack.name), { recursive: true });
  fs.writeFileSync(path.join(root, 'data.json'), '{}');
  fs.writeFileSync(path.join(root, 'packs', name || pack.name, 'pack.json'), JSON.stringify(pack));
  return root;
}
const fails = (pack, re, name) => assert.throws(() => P.loadPack(name || pack.name, scratch(pack, name)), (e) => e instanceof P.PackError && re.test(e.message), String(re));

const LEGAL = {
  name: 'legal', contract: 1, version: '0.1.0', description: 'Case notes: parties, statutes and holdings that meet across matters.',
  extraction: {
    promptVersion: 'leg-v1', schemaVersion: 'burr-v1', audience: "a lawyer's research tool", claimReader: 'a lawyer',
    kinds: ['fact', 'holding', 'obligation', 'argument'], kindNotes: '"holding" = what a court decided; "obligation" = what a party must do.',
    hooks: { strict: ['entity', 'time', 'number', 'statute', 'court'], loose: ['issue'], categorised: ['entity'] },
    categories: ['person', 'company', 'court', 'statute', 'contract', 'other'], categoryExample: 'so "Apple" the company and "Apple" the fruit differ',
    caps: { base: 20, long: 30, xl: 40, longChars: 1200, xlChars: 2500 }, skipRule: '',
    example: { note: '[T] Smith v Jones, 2019', reply: '{"burrs":[],"reason":""}' },
  },
  files: { data: 'data.json' },
};

test('with no muse.yaml the quiz pack is active and valid', () => {
  const saved = process.env.MUSE_PACK; delete process.env.MUSE_PACK;
  try { assert.strictEqual(P.current({ fresh: true }).name, 'quiz'); } finally { if (saved) process.env.MUSE_PACK = saved; }
  assert.ok(P.current().capabilities.includes('wordplay'));
});

test('a pack that breaks the contract is refused with a message that names the problem', () => {
  assert.throws(() => P.loadPack('nosuch', P.ROOT), /not found/);
  assert.throws(() => P.loadPack('../etc', P.ROOT), /plain folder name/);
  let p = clone(LEGAL); p.name = 'other'; fails(p, /folder is "legal"/, 'legal');
  p = clone(LEGAL); p.contract = 9; fails(p, /contract is 9/);
  p = clone(LEGAL); p.description = ''; fails(p, /description is required/);
  p = clone(LEGAL); p.extraction.kinds = ['holding']; fails(p, /includes "fact"/);
  p = clone(LEGAL); p.extraction.categories = ['person']; fails(p, /includes "other"/);
  p = clone(LEGAL); p.extraction.hooks.loose = ['entity']; fails(p, /listed twice/);
  p = clone(LEGAL); p.extraction.hooks.categorised = ['nothing']; fails(p, /not declared/);
  p = clone(LEGAL); p.extraction.caps.base = 50; fails(p, /base <= long <= xl/);
  p = clone(LEGAL); p.extraction.example.reply = 'not json'; fails(p, /valid JSON/);
  p = clone(LEGAL); delete p.extraction.audience; fails(p, /audience must be/);
  p = clone(LEGAL); p.files.data = 'missing.json'; fails(p, /does not exist/);
  p = clone(LEGAL); p.files.data = '../../etc/passwd'; fails(p, /outside the project/);
});

test('a valid second pack loads', () => {
  const k = P.loadPack('legal', scratch(LEGAL));
  assert.strictEqual(k.name, 'legal');
  assert.deepStrictEqual(k.capabilities, []);
  assert.ok(k.files.data.endsWith('data.json'));
});

test('muse.yaml chooses the pack; MUSE_PACK overrides it', (t) => {
  let YAML; try { YAML = require('yaml'); } catch (e) { return t.skip('yaml package not installed: npm install yaml'); }
  const root = scratch(LEGAL);
  fs.writeFileSync(path.join(root, 'muse.yaml'), '# comment\npack: legal\n');
  const saved = { c: process.env.MUSE_CONFIG, p: process.env.MUSE_PACK }; delete process.env.MUSE_CONFIG; delete process.env.MUSE_PACK;
  try {
    assert.strictEqual(P.readConfig(root).pack, 'legal');
    process.env.MUSE_PACK = 'quiz'; assert.strictEqual(P.readConfig(root).pack, 'quiz');
    delete process.env.MUSE_PACK; fs.writeFileSync(path.join(root, 'muse.yaml'), '- not\n- a mapping\n');
    assert.throws(() => P.readConfig(root), /must be a mapping/);
    fs.writeFileSync(path.join(root, 'muse.yaml'), 'pack: [unclosed\n');
    assert.throws(() => P.readConfig(root), /not valid YAML/);
  } finally { if (saved.c) process.env.MUSE_CONFIG = saved.c; if (saved.p) process.env.MUSE_PACK = saved.p; }
});

test('a second pack changes the words but not the faithfulness rules', () => {
  const ex = P.loadPack('legal', scratch(LEGAL)).extraction;
  const note = { title: 'Smith v Jones, 2019', source_url: null };
  const q = B.buildPrompt(note, 'Smith sued Jones.');
  const l = B.buildPrompt(note, 'Smith sued Jones.', ex);
  assert.match(l.system, /a lawyer's research tool/);
  assert.match(l.prompt, /ONE claim a lawyer could cite/);
  assert.match(l.prompt, /"kind": fact \| holding \| obligation \| argument\. "holding" = what a court decided/);
  assert.match(l.prompt, /T is one of: entity, time, number, statute, court, issue\./);
  assert.match(l.prompt, /For entity, time, number, statute and court, V must be copied exactly/);
  assert.match(l.prompt, /At most 20 burrs/);
  assert.ok(!/quiz|etymon|homonym|Quokka|Skip text that documents software/.test(l.system + l.prompt), 'no quiz words leak into the second pack');
  for (const rule of ['Use ONLY what the note states', 'Every number or year in "claim" must appear in the cited lines', 'Never write a claim about the note itself']) {
    assert.ok(l.prompt.includes(rule) && q.prompt.includes(rule), 'core rule kept: ' + rule);
  }
});

test('the validator uses the pack vocabulary and still checks hooks against the note', () => {
  const ex = P.loadPack('legal', scratch(LEGAL)).extraction;
  const cleaned = 'The court held that the lease was void under the Rent Act 1977.';
  const model = [{ claim: 'The court held the lease void under the Rent Act 1977.', src: [1], kind: 'holding',
    hooks: [{ type: 'statute', value: 'Rent Act 1977' }, { type: 'statute', value: 'Housing Act' }, { type: 'etymon', value: 'lease' }, { type: 'issue', value: 'void lease' }], perishable: false }];
  const v = B.verifyBurrs(model, { title: 'Lease case', cleaned }, { ex });
  assert.strictEqual(v.accepted.length, 1);
  assert.strictEqual(v.accepted[0].kind, 'holding');
  assert.deepStrictEqual(v.accepted[0].hooks.map((h) => h.type + ':' + h.value), ['statute:Rent Act 1977', 'issue:void lease']);
  assert.strictEqual(v.hooksDropped, 2);   // 'Housing Act' is not in the note; 'etymon' is not a hook type of this pack
  const q = B.verifyBurrs(model, { title: 'Lease case', cleaned });
  assert.strictEqual(q.accepted[0].kind, 'fact');   // the quiz pack has no "holding" kind
});
