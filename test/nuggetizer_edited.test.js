'use strict';
// Re-processing edited notes: a note is "edited" only when its file is newer than its last extraction AND its current text has no saved model answer.
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const B = require('../code/lib/burrs'), Nug = require('../code/nuggetizer'), I = require('../code/lib/ops_internal');

const SENT = 'Quokkas on Rottnest Island became a selfie craze in 2015.';
let calls = 0;
const fake = async () => { calls++; return { text: '{"burrs":[{"claim":"' + SENT + '","quote":"selfie craze in 2015","kind":"fact","hooks":[{"type":"time","value":"2015"}],"loop":""}],"reason":""}', model: 'fake-1', provider: 'gemini', tokensIn: 900, tokensOut: 120 }; };
const OLD = '2026-01-01T00:00:00.000Z', NEWER = '2026-06-01T00:00:00.000Z';

async function fixture() {
  calls = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nug-ed-')), put = (n, t) => { fs.writeFileSync(path.join(dir, n + '.md'), t); return n + '.md'; };
  const db = new DatabaseSync(':memory:'); db.exec(B.SCHEMA_SQL);
  db.exec('CREATE TABLE api_budget (id INTEGER PRIMARY KEY, provider TEXT, component TEXT, note_id INTEGER, queue_id INTEGER, tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, called_at TEXT)');
  db.exec('CREATE TABLE vault_notes (id INTEGER PRIMARY KEY, rel_path TEXT, title TEXT, source_url TEXT, word_count INTEGER, quarry_exclude INTEGER, file_mtime TEXT)');
  const add = db.prepare('INSERT INTO vault_notes (id,rel_path,title,source_url,word_count,quarry_exclude,file_mtime) VALUES (?,?,?,?,?,0,?)');
  add.run(1, put('a', SENT), 'A', null, 11, OLD); add.run(2, put('b', SENT + ' A second sentence about wallabies.'), 'B', null, 16, OLD); add.run(3, put('e', '![[pic.png]]'), 'pic', null, 1, OLD);
  await Nug.run(Nug.parseArgs([]), { db, root: dir, callLLM: fake });
  db.prepare('UPDATE nuggetize_status SET at=?').run(NEWER.replace('06', '03'));   // extracted in March; files carry January mtimes, so nothing is edited yet
  return { db, dir, put, edit: (id, text, mtime) => { const r = db.prepare('SELECT rel_path p FROM vault_notes WHERE id=?').get(id).p; fs.writeFileSync(path.join(dir, r), text); db.prepare('UPDATE vault_notes SET file_mtime=? WHERE id=?').run(mtime, id); } };
}
const ids = (db, note) => db.prepare('SELECT id FROM burrs WHERE note_id=? ORDER BY id').all(note).map(r => r.id);

test('edited: a note not touched since its facts were extracted is never selected', async () => {
  const { db, dir } = await fixture();
  assert.deepStrictEqual(Nug.pickEdited(db, { provider: 'gemini' }, dir), []);
});
test('edited: a note that was only touched (newer file, same text) is NOT edited, because its text has a saved answer', async () => {
  const { db, dir } = await fixture();
  db.prepare('UPDATE vault_notes SET file_mtime=? WHERE id=1').run(NEWER);
  const none = Nug.pickEdited(db, { provider: 'gemini' }, dir);
  assert.deepStrictEqual([...none], []);
  assert.strictEqual(none.skipped.length, 1, 'the skipped note is listed, so the report can say why');
  assert.match(none.skipped[0].reason, /body text is unchanged/);
});
test('edited: a really changed note is selected; the run costs one call, replaces only its facts, and the others keep their ids', async () => {
  const { db, dir, edit } = await fixture();
  const before2 = ids(db, 2), before1 = ids(db, 1);
  edit(1, SENT + ' Added later: they are marsupials.', NEWER);
  const picked = Nug.pickEdited(db, { provider: 'gemini' }, dir); assert.deepStrictEqual(picked.map(r => r.id), [1]);
  calls = 0; const t = await Nug.run(Nug.parseArgs(['--edited']), { db, root: dir, callLLM: fake });
  assert.strictEqual(calls, 1); assert.strictEqual(t.ok, 1);
  assert.deepStrictEqual(ids(db, 1), before1, 'a fact the edit did not change keeps its id (new or changed claims get new ids: see nuggetizer.test.js)'); assert.deepStrictEqual(ids(db, 2), before2, 'an untouched note keeps its fact ids');
  assert.deepStrictEqual(Nug.pickEdited(db, { provider: 'gemini' }, dir), [], 'once re-processed it is no longer edited');
});
test('edited: the dry run changes nothing and a second run does nothing', async () => {
  const { db, dir, edit } = await fixture();
  edit(2, SENT + ' Rewritten completely, with new words.', NEWER);
  const before = ids(db, 2); calls = 0;
  const d = await Nug.run(Nug.parseArgs(['--edited', '--dry-run']), { db, root: dir, callLLM: fake }); assert.strictEqual(d.candidates, 1); assert.strictEqual(calls, 0); assert.deepStrictEqual(ids(db, 2), before);
  await Nug.run(Nug.parseArgs(['--edited']), { db, root: dir, callLLM: fake });
  const again = await Nug.run(Nug.parseArgs(['--edited']), { db, root: dir, callLLM: fake }); assert.strictEqual(again.candidates, 0);
});
test('edited: a note edited down to nothing loses its old facts; an empty note stays out until it gets text', async () => {
  const { db, dir, edit } = await fixture();
  edit(1, '![[pic.png]]', NEWER); edit(3, '![[other.png]]', NEWER);
  assert.deepStrictEqual(Nug.pickEdited(db, { provider: 'gemini' }, dir).map(r => r.id), [1], 'still-empty note 3 is not edited');
  await Nug.run(Nug.parseArgs(['--edited']), { db, root: dir, callLLM: fake });
  assert.strictEqual(ids(db, 1).length, 0); assert.strictEqual(db.prepare('SELECT status s FROM nuggetize_status WHERE note_id=1').get().s, 'skipped_empty');
  edit(3, SENT + ' Now it has text.', NEWER);
  assert.deepStrictEqual(Nug.pickEdited(db, { provider: 'gemini' }, dir).map(r => r.id), [3]);
});
test('edited: an excluded note and an unreadable file are left out; --edited without a vault folder says so', async () => {
  const { db, dir, edit } = await fixture();
  edit(1, SENT + ' changed text one', NEWER); edit(2, SENT + ' changed text two', NEWER);
  db.prepare('UPDATE vault_notes SET quarry_exclude=1 WHERE id=1').run(); fs.rmSync(path.join(dir, 'b.md'));
  assert.deepStrictEqual(Nug.pickEdited(db, { provider: 'gemini' }, dir), []);
  assert.throws(() => Nug.pickEdited(db, { provider: 'gemini' }, null), /VAULT_PATH/);
});
test('edited: the count a person confirms comes from the same selection (ops_internal.candidates)', async () => {
  const f = await fixture(), p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nug-db-')), 'v.db');
  f.edit(1, SENT + ' changed again entirely', NEWER);
  f.db.exec("VACUUM INTO '" + p.replace(/'/g, "''") + ".copy'");
  const lines = []; const n = I.candidates({ dbPath: p + '.copy', args: ['--edited', '--provider', 'gemini'], env: { VAULT_PATH: f.dir }, home: f.dir, log: l => lines.push(l) });
  assert.strictEqual(n, 1); assert.match(lines[0], /Edited notes this run would re-process: 1/);
});

test('edited: the report names every note it will re-process, as well as those it skips', async () => {
  const { db, dir, edit } = await fixture();
  edit(1, SENT + ' Added later: they are marsupials.', NEWER); db.prepare('UPDATE vault_notes SET file_mtime=? WHERE id=2').run(NEWER);
  const file = path.join(os.tmpdir(), 'ed-report-' + process.pid + '.db'); fs.rmSync(file, { force: true });
  const disk = new DatabaseSync(file); db.exec('VACUUM INTO ' + "'" + file.replace(/'/g, "''") + "'"); disk.close();
  const lines = []; I.candidates({ dbPath: file, args: ['--edited', '--provider', 'gemini'], log: m => lines.push(m), env: { VAULT_PATH: dir }, home: dir });
  const out = lines.join('\n');
  assert.match(out, /will re-process: a\.md - body text changed/);
  assert.match(out, /Skipped 1 .*\n  b\.md - file changed, but the body text is unchanged/);
  fs.rmSync(file, { force: true });
});
