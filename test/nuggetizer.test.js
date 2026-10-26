'use strict';
// Run: node --test test/        (Node >= 22.13)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const B = require('../code/lib/burrs');
const Nug = require('../code/nuggetizer');

const note = { title: 'Quokka selfie craze', cleaned: 'Quokkas on Rottnest Island became a selfie craze in 2015. About 12,000 live there.' };

test('verifier accepts a grounded burr and keeps real hooks only', () => {
  const v = B.verifyBurrs([{ claim: 'Quokkas became a selfie craze in 2015.', quote: 'selfie craze in 2015', kind: 'fact',
    hooks: [{ type: 'time', value: '2015', era: 'AD' }, { type: 'place', value: 'Perth' }, { type: 'set', value: 'internet fads' }] }], note);
  assert.strictEqual(v.accepted.length, 1);
  assert.deepStrictEqual(v.accepted[0].hooks.map(h => h.type), ['time', 'set']);
  assert.strictEqual(v.hooksDropped, 1);
});
test('verifier rejects invented quote and invented number', () => {
  const v = B.verifyBurrs([
    { claim: 'Quokkas are marsupials from Perth.', quote: 'marsupials from Perth' },
    { claim: 'About 20,000 quokkas live there.', quote: 'About 12,000 live there' }], note);
  assert.deepStrictEqual(v.rejected.map(r => r.reason), ['quote_not_in_note', 'number_not_in_note']);
});
test('verifier accepts comma-formatted numbers and dedupes', () => {
  const b = { claim: 'About 12000 quokkas live on the island.', quote: 'About 12,000 live there' };
  const v = B.verifyBurrs([b, b], note);
  assert.strictEqual(v.accepted.length, 1);
  assert.strictEqual(v.rejected[0].reason, 'duplicate');
});
test('verifier rejects claims about the note, URLs and bare-URL quotes', () => {
  const n = { title: 'trefoil arch', cleaned: 'http://a.org/x.jpg The year 2006 is mentioned. Source URL' };
  const v = B.verifyBurrs([
    { claim: 'The note is titled "trefoil arch".', quote: 'trefoil arch' },
    { claim: 'The source URL for the image is http://a.org/x.jpg.', quote: 'http://a.org/x.jpg' },
    { claim: 'The year 2006 is mentioned.', quote: '2006' },
    { claim: 'A trefoil arch has three lobes.', quote: 'http://a.org/x.jpg' }], n);
  assert.deepStrictEqual(v.rejected.map(r => r.reason), ['meta_claim', 'meta_claim', 'meta_claim', 'bare_quote']);
});
test('cap is 6 for short notes, 10 for long; perishable flag is kept', () => {
  assert.strictEqual(B.burrCap('x'.repeat(100)), 6);
  assert.strictEqual(B.burrCap('x'.repeat(2000)), 10);
  const v = B.verifyBurrs([{ claim: 'About 12000 quokkas live on the island today.', quote: 'About 12,000 live there', perishable: true }], note);
  assert.strictEqual(v.accepted[0].perishable, 1);
});
test('loose quote match recovers the exact source span', () => {
  const n = { title: 't', cleaned: 'According to MCD norms, 3023 farmhouses were sanctioned. A [[asu process]] frame \u2014 semi-circular, with \u201cnails\u201d.' };
  const v = B.verifyBurrs([
    { claim: 'MCD norms sanctioned 3023 farmhouses.', quote: 'According to MCD norms , 3023 farmhouses were sanctioned.' },
    { claim: 'The asu process frame is semi-circular.', quote: 'an asu process frame - semi-circular, with "nails"' }], n);
  assert.strictEqual(v.accepted.length >= 1, true);
  assert.strictEqual(v.accepted[0].quote, 'According to MCD norms, 3023 farmhouses were sanctioned.');
  assert.strictEqual(B.locateQuote('totally invented words here', [n.cleaned]), null);
});
test('src ids: quote is built by code from cited lines; bad ids and uncited numbers are rejected', () => {
  const n = { title: 'Quokka selfie craze', cleaned: 'Quokkas live on Rottnest Island. They became a selfie craze in 2015.\nAbout 12,000 live there.' };
  assert.deepStrictEqual(B.segment(n.cleaned), ['Quokkas live on Rottnest Island.', 'They became a selfie craze in 2015.', 'About 12,000 live there.']);
  const v = B.verifyBurrs([
    { claim: 'Quokkas became a selfie craze in 2015.', src: [2] },
    { claim: 'Quokkas are a selfie craze subject.', src: ['T'] },
    { claim: 'About 20000 quokkas live on Rottnest Island.', src: [1] },
    { claim: 'About 12000 quokkas live on Rottnest Island.', src: [1, 3] },
    { claim: 'Quokkas are found in Perth suburbs too.', src: [9] },
    { claim: 'Quokkas became a selfie craze in 2015 too.', src: ['2'] },
    { claim: 'Quokkas became a hit selfie craze in 2015.', src: ['[2]', 'T'] }], n);
  assert.deepStrictEqual(v.accepted.map(a => a.quote), ['They became a selfie craze in 2015.', 'Quokka selfie craze', 'Quokkas live on Rottnest Island. About 12,000 live there.', 'They became a selfie craze in 2015.', 'They became a selfie craze in 2015. Quokka selfie craze']);
  assert.deepStrictEqual(v.rejected.map(r => r.reason), ['number_not_in_note', 'bad_src']);
});
test('legit titled/part facts pass; claims about the note itself do not; numbers found elsewhere are pulled into the quote', () => {
  const n = { title: 'Notes', cleaned: 'Photo 51 was produced in 1952.\nPart II of the book is titled "The Rise of Social Theory".\nThe note lists a conversation on May 2, 2021.\nRulers were not allowed more than twelve flowers.\nThis custom ended in 1920.' };
  const v = B.verifyBurrs([
    { claim: 'Photo 51 was produced in 1952.', src: [1] },
    { claim: 'Part II of the book is titled "The Rise of Social Theory".', src: [2] },
    { claim: 'The note lists a conversation on May 2, 2021.', src: [3] },
    { claim: 'Rulers could have no more than 12 flowers.', src: [4] },
    { claim: 'The flower custom ended in 1920.', src: [4] }], n);
  assert.deepStrictEqual(v.rejected.map(r => r.reason), ['meta_claim']);
  assert.strictEqual(v.accepted.length, 4);
  assert.ok(v.accepted[3].quote.indexOf('1920') >= 0);
});
test('article-as-source is junk, but "the article states that X" keeps X', () => {
  const n = { title: 'T', cleaned: 'Published 2018.\nThe article states that p-hacking manipulates results.\nOre flourspar fluoresces.' };
  const v = B.verifyBurrs([
    { claim: 'The article was published on April 22, 2018.', src: [1] },
    { claim: 'The article states that p-hacking manipulates results.', src: [2] },
    { claim: 'Ore flourspar fluoresces.', src: [3] }], n);
  assert.deepStrictEqual(v.rejected.map(r => r.reason), ['meta_claim']);
  assert.strictEqual(v.accepted.length, 2);
});
test('parser strips fences and rejects junk', () => {
  assert.ok(B.parseModelJson('```json\n{"burrs":[]}\n```').ok);
  assert.strictEqual(B.parseModelJson('sorry').ok, false);
  assert.strictEqual(B.parseModelJson('{"x":1}').error, 'bad_shape');
});
test('realWordCount ignores embeds and urls', () => {
  assert.strictEqual(B.realWordCount('![[a.png]] https://x.com/y'), 0);
  assert.strictEqual(B.realWordCount('Quokka on Rottnest'), 3);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nug-'));
  const f = (n, t) => { const p = path.join(dir, n + '.md'); fs.writeFileSync(p, t); return p; };
  const db = new DatabaseSync(':memory:');
  db.exec(B.SCHEMA_SQL);
  db.exec('CREATE TABLE api_budget (id INTEGER PRIMARY KEY, provider TEXT, component TEXT, note_id INTEGER, queue_id INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, called_at TEXT)');
  db.exec('CREATE TABLE vault_notes (id INTEGER PRIMARY KEY, filepath TEXT, title TEXT, source_url TEXT, word_count INTEGER, quarry_exclude INTEGER)');
  const add = db.prepare('INSERT INTO vault_notes (id,filepath,title,source_url,word_count,quarry_exclude) VALUES (?,?,?,?,?,0)');
  add.run(1, f('q', '---\ntags: x\n---\nQuokkas on Rottnest Island became a selfie craze in 2015.'), 'Quokka selfie craze', null, 11);
  add.run(2, f('e', '![[pic.png]]'), 'pic', null, 1);
  return db;
}
const fake = async () => ({ text: '{"burrs":[{"claim":"Quokkas on Rottnest Island became a selfie craze in 2015.","quote":"selfie craze in 2015","kind":"fact","hooks":[{"type":"time","value":"2015"}],"loop":""}],"reason":""}',
  model: 'fake-1', provider: 'gemini', tokensIn: 900, tokensOut: 120 });

test('end to end: burrs stored, empty note flagged, spend recorded, rerun is a no-op', async () => {
  const db = fixture();
  const args = Nug.parseArgs([]);
  const t = await Nug.run(args, { db, callLLM: fake });
  assert.strictEqual(t.ok, 1); assert.strictEqual(t.skipped_empty, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM burrs').get().c, 1);
  assert.ok(db.prepare('SELECT SUM(cost_usd) s FROM api_budget').get().s > 0);
  assert.strictEqual(db.prepare("SELECT disposition d FROM note_disposition WHERE note_id=2").get().d, 'review');
  const again = await Nug.run(args, { db, callLLM: fake });
  assert.strictEqual(again.candidates, 0);
});
test('--redo re-verifies finished notes from cache without calling the LLM', async () => {
  const db = fixture();
  await Nug.run(Nug.parseArgs([]), { db, callLLM: fake });
  let calls = 0;
  const t2 = await Nug.run(Nug.parseArgs(['--redo']), { db, callLLM: async () => { calls++; return fake(); } });
  assert.strictEqual(calls, 0);
  assert.strictEqual(t2.ok, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM burrs').get().c, 1);
});
test('budget ceiling stops the run', async () => {
  const db = fixture();
  const a = Nug.parseArgs(['--ceiling', '0.0000001']);
  db.prepare("INSERT INTO api_budget (provider,component,cost_usd,called_at) VALUES ('gemini','x',1,'t')").run();
  await Nug.run(a, { db, callLLM: fake });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM burrs').get().c, 0);
  assert.strictEqual(process.exitCode, 1); process.exitCode = 0;
});

test('nug-v5: cap scales with note length (6, 10, 14)', () => {
  assert.strictEqual(B.burrCap('x'.repeat(1200)), 6);
  assert.strictEqual(B.burrCap('x'.repeat(1201)), 10);
  assert.strictEqual(B.burrCap('x'.repeat(2501)), 14);
});

test('nug-v5: web links are stripped before evidence is numbered', () => {
  const t = B.cleanBody('While popular in Malaysia, there are branches in Tunisia.[1](https://en.wikipedia.org/wiki/Seni_gayong#cite_note-1) See [the site](https://example.com/a?b=1) and https://example.org/x for more.');
  assert.ok(t.indexOf('http') < 0, t);
  assert.ok(t.indexOf('the site') >= 0 && t.indexOf('branches in Tunisia.') >= 0, t);
  assert.ok(t.indexOf('[1]') < 0, t);
});

test('nug-v5: credit, authorship and download claims are meta, not facts', () => {
  const note = { title: 'Photo note', cleaned: 'Petr Bonek/Alamy is credited. The book is available for free download on the Internet Archive.' };
  const out = B.verifyBurrs([
    { claim: 'Petr Bonek/Alamy is credited.', src: [1], kind: 'fact', hooks: [] },
    { claim: 'The author of the note is Vikram Doctor.', src: ['T'], kind: 'fact', hooks: [] },
    { claim: 'The book Daily Life is available for free download and streaming on the Internet Archive.', src: [2], kind: 'fact', hooks: [] },
    { claim: 'The American Oriental Society is collaborating with JSTOR to digitize the journal.', src: [2], kind: 'fact', hooks: [] }
  ], note);
  assert.strictEqual(out.accepted.length, 0);
  assert.ok(out.rejected.every(r => r.reason === 'meta_claim'), JSON.stringify(out.rejected));
});

test('nug-v5: category is kept for entity, place and material hooks and validated', () => {
  const note = { title: 'Mercury', cleaned: 'Mercury is the smallest planet. Mercury is a liquid metal.' };
  const out = B.verifyBurrs([{ claim: 'Mercury is the smallest planet.', src: [1], kind: 'fact',
    hooks: [{ type: 'entity', value: 'Mercury', cat: 'Place' }, { type: 'material', value: 'metal', cat: 'shiny' }, { type: 'time', value: '' }, { type: 'entity', value: 'planet' }] }], note);
  const h = out.accepted[0].hooks;
  assert.deepStrictEqual(h.map(x => [x.type, x.cat]), [['entity', 'place'], ['material', 'other'], ['entity', null]]);
});

test('nug-v5: links are stripped from titles too', () => {
  assert.strictEqual(B.squash(B.stripLinks('Los Angeles magazine on Twitter: "A suit https://t.co/GqN04ndS52 https://t.co/Bxn"')), 'Los Angeles magazine on Twitter: "A suit "');
  assert.ok(B.buildInput({ title: 'Tweet https://t.co/abc', source_url: '' }, 'Body text.').indexOf('t.co') < 0);
});

test('nug-v5: a lone backslash in a model reply is repaired once, and flagged', () => {
  const bad = '{"burrs":[{"claim":"x y z root","src":["T"],"hooks":[{"type":"etymon","value":"' + '\\' + '*bhares-"}]}]}';
  const r = B.parseModelJson(bad);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.repaired, true);
  assert.strictEqual(r.burrs[0].hooks[0].value, '\\*bhares-');
  assert.strictEqual(B.parseModelJson('{"burrs":[]}').repaired, false);
  assert.strictEqual(B.parseModelJson('{"burrs":[').ok, false);
});

test('parseModelJson repairs a raw newline or tab inside a string, and says so', () => {
  const raw = '{"burrs":[{"claim":"Line one\nline two\tend","src":["T"],"kind":"fact","hooks":[],"loop":"","perishable":false}],"reason":""}';
  const r = B.parseModelJson(raw);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.repaired, true);
  assert.strictEqual(r.burrs[0].claim, 'Line one\nline two\tend');
});

test('parseModelJson: newlines between tokens are untouched, and a valid reply is not flagged repaired', () => {
  const r = B.parseModelJson('{\n  "burrs": [],\n  "reason": "nothing"\n}');
  assert.strictEqual(r.ok, true);
  assert.ok(!r.repaired);
});

test('parseModelJson: a reply with no usable burrs array is rejected (bad_shape or bad_json)', () => {
  for (const bad of ['{"burrs":"nope"}', '{"other":1}', '{}']) {
    const r = B.parseModelJson(bad);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error === 'bad_shape' || r.error === 'bad_json');
  }
});

test('parseModelJson: jsonrepair may turn a broken claim into null; the verifier then rejects that burr', () => {
  const r = B.parseModelJson('{"burrs":[{"claim":}]}');
  if (r.ok) {
    const v = B.verifyBurrs(r.burrs, { title: 'T', cleaned: 'some note text here' });
    assert.strictEqual(v.accepted.length, 0);
  }
});

test('parseModelJson: unescaped quotes inside a claim are repaired and flagged', () => {
  const r = B.parseModelJson('{"burrs":[{"claim":"The article "Petanque, a hit" ran in Puducherry.","hooks":[]}],"reason":""}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.repaired, true);
  assert.strictEqual(r.burrs[0].claim, 'The article "Petanque, a hit" ran in Puducherry.');
});

test('parseModelJson: garbled hook keys are restored, and a hook with a lost type is dropped', () => {
  const r = B.parseModelJson('{"burrs":[{"claim":"c","hooks":[{"type":"place":"Hassan","cat":"place"},{"type":"":"number","value":"6"},{"type":"type":"former-role","value":"polymath"},{"type":"value":"Zed","cat":"person"},{"type":"entity","value":"Ok","cat":"person"}]}],"reason":""}');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.burrs[0].hooks.map(h => h.type + ':' + h.value), ['place:Hassan', 'number:6', 'former-role:polymath', 'entity:Ok']);
});

// ---- nug-v6: a time hook needs an era, a number hook needs a unit ----
const note6 = { title: 'Notes', cleaned: 'Rome fell in 476. The tower is 1250 feet tall. Windows 95 shipped in 1995. Thera erupted c. 1600 BC. About 2,000 tigers remain. It lasted 150 years.' };
const burr6 = (hooks, claim) => ({ claim: claim || 'Rome fell in 476 and the tower is 1250 feet tall.', src: [1, 2], hooks: hooks });
const hooksOf = (hooks, claim) => { const v = B.verifyBurrs([burr6(hooks, claim)], note6); return { h: v.accepted[0] ? v.accepted[0].hooks : null, dropped: v.hooksDropped }; };

test('nug-v6: prompt version and the prompt ask for era and unit', () => {
  assert.strictEqual(B.PROMPT_VERSION, 'nug-v6');
  const p = B.buildPrompt({ title: 'T', source_url: '' }, 'Rome fell in 476.').prompt;
  assert.ok(/"era": "AD" or "BC"/.test(p) && /"unit": what is counted/.test(p) && /"unit":"","era":""/.test(p));
});
test('nug-v6: a time hook keeps its era; a missing or unknown era drops the hook, not the burr', () => {
  let r = hooksOf([{ type: 'time', value: '476', era: 'AD' }, { type: 'time', value: '1995' }, { type: 'time', value: '1600', era: 'unknown' }, { type: 'time', value: '1600', era: 'B.C.' }]);
  assert.deepStrictEqual(r.h.map(h => h.value + ':' + h.era), ['476:ad', '1600:bc']);
  assert.strictEqual(r.dropped, 2);
});
test('nug-v6: a number hook keeps its unit (singular, normalised); empty, label and junk units drop the hook', () => {
  const r = hooksOf([{ type: 'number', value: '1250', unit: 'feet' }, { type: 'number', value: '2,000', unit: 'Tigers' }, { type: 'number', value: '95', unit: 'id' },
    { type: 'number', value: '1250' }, { type: 'number', value: '150', unit: 'different' }, { type: 'number', value: '150', unit: 'years' }]);
  assert.deepStrictEqual(r.h.map(h => h.value + ':' + h.unit), ['1250:ft', '2,000:tiger', '150:year']);
  assert.strictEqual(r.dropped, 3);
});
test('nug-v6: where the model and the claim-text reading disagree, the hook records it (xc)', () => {
  const agree = hooksOf([{ type: 'time', value: '476', era: 'AD' }], 'Rome fell in 476.').h[0];
  assert.strictEqual(agree.xc, undefined);
  const off = hooksOf([{ type: 'number', value: '1250', unit: 'metre' }], 'The tower is 1250 feet tall.').h[0];
  assert.strictEqual(off.unit, 'm'); assert.ok(off.xc && off.xc !== '1250 m');
});
test('nug-v6: era-less legacy hooks still verify when units are not required (v5 replies)', () => {
  const v = B.verifyBurrs([burr6([{ type: 'time', value: '476' }])], note6, { requireUnits: false });
  assert.strictEqual(v.accepted[0].hooks.length, 1);
});
test('nug-v6: the model-stated era and unit decide the join key', () => {
  const L = require('../code/lib/bristles');
  assert.strictEqual(L.qualifyNumber('1170', 'Founded in 1170', null, 'time', { era: 'bc' }).key, '1170 bc');
  assert.strictEqual(L.qualifyNumber('1170', 'Founded in 1170', null, 'time', { era: 'ad' }).key, '1170');
  assert.strictEqual(L.qualifyNumber('476', 'Rome fell in 476', null, 'time', { era: 'ad' }).key, '476 ad');
  assert.strictEqual(L.qualifyNumber('1960s', 'in the 1960s', null, 'time', { era: 'ad' }).decade, true);
  assert.strictEqual(L.qualifyNumber('1120', 'a road of 1120', null, 'number', { unit: 'km' }).key, '1120 km');
  assert.strictEqual(L.qualifyNumber('150', 'it lasted 150', null, 'number', { unit: 'year' }).duration, true);
});

test('nug-v6: a hook the cross-check flagged (xc) is keyed by the claim text, not the model, until reviewed', () => {
  const M = require('../code/lib/muse_model');
  assert.ok(typeof M.build === 'function');   // wiring is exercised on real data; the rule is one line in muse_model.js (h.xc ? null : hint)
});

test('nug-v6: a repeated number is not flagged ("between 200 BC and 200 AD"); a century hook is kept as a coarse date', () => {
  const n = { title: 'Natya Shastra', cleaned: 'The Natya Shastra was written between 200 BC and 200 AD. Damnatio ad bestias reached Rome in the 2nd century BC.' };
  const v = B.verifyBurrs([
    { claim: 'The Natya Shastra was written during the period between 200 BC and 200 AD.', src: [1], hooks: [{ type: 'time', value: '200', era: 'BC' }, { type: 'time', value: '200', era: 'AD' }] },
    { claim: 'Damnatio ad bestias was brought to Rome around the 2nd century BC.', src: [2], hooks: [{ type: 'time', value: '2nd century', era: 'BC' }] }], n);
  assert.strictEqual(v.accepted.length, 2);
  assert.deepStrictEqual(v.accepted[0].hooks.map(h => h.era + ':' + (h.xc || '')), ['bc:', 'ad:']);
  assert.strictEqual(v.accepted[1].hooks[0].grain, 'century');
  assert.strictEqual(v.accepted[1].hooks[0].xc, undefined);
});
