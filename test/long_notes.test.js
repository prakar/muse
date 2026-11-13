const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const LN = require('../code/lab/long_notes');

const A = 'Quokkas live on Rottnest Island.', Bp = 'Ibises nest in Perth parks daily.', C = 'Emus roam the Australian plains.';

test('windowsOf cuts at paragraph boundaries and never exceeds the limit', () => {
  const w = LN.windowsOf([A, Bp, C].join('\n\n'), 70);
  assert.deepStrictEqual(w, [A + '\n\n' + Bp, C]);
  w.forEach(x => assert.ok(x.length <= 70));
});

test('windowsOf splits an over-long paragraph at sentence ends, then hard', () => {
  const long = 'One sentence here. Two sentence here. Three sentence here.';
  const w = LN.windowsOf(long, 30);
  w.forEach(x => assert.ok(x.length <= 30));
  assert.strictEqual(w.join(' ').replace(/\s+/g, ' ').includes('Three sentence here.'), true);
  const hard = LN.windowsOf('x'.repeat(100), 40);
  assert.deepStrictEqual(hard.map(x => x.length), [40, 40, 20]);
  assert.deepStrictEqual(LN.windowsOf('', 40), []);
});

test('joins: a handle carried by 1 to 40 other notes counts; the note itself and years do not', () => {
  const idx = LN.handleIndex([
    { note_id: 1, hooks: [{ value: 'Quokkas' }, { value: '1066' }] },
    { note_id: 2, hooks: [{ value: 'Quokkas' }, { value: '1066' }] },
    { note_id: 3, hooks: [{ value: 'Solo handle' }] }]);
  assert.strictEqual(LN.joins([{ value: 'Quokkas' }], 1, idx), true);
  assert.strictEqual(LN.joins([{ value: 'Solo handle' }], 3, idx), false);    // only the note itself carries it
  assert.strictEqual(LN.joins([{ value: '1066' }], 1, idx), false);           // a year is a slice, not a handle
  assert.strictEqual(LN.joins([{ value: 'Unknown thing' }], 1, idx), false);
});

test('summarise compares head with tail', () => {
  const s = LN.summarise([
    { note_id: 1, title: 'T', k: 1, chars: 5000, accepted: 10, rejected: 2, joined: 5 },
    { note_id: 1, title: 'T', k: 2, chars: 5000, accepted: 5, rejected: 5, joined: 1 },
    { note_id: 1, title: 'T', k: 3, chars: 1000, accepted: 1, rejected: 0, joined: 0 }]);
  assert.strictEqual(s.head.burrsPer1kChars, 2);
  assert.strictEqual(s.head.joinShare, 0.5);
  assert.strictEqual(s.tail.windows, 2);
  assert.strictEqual(s.tail.burrs, 6);
  assert.strictEqual(s.tail.burrsPer1kChars, +(6000 / 6000).toFixed(3));
  assert.strictEqual(s.tail.rejectShare, +(5 / 11).toFixed(3));
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE vault_notes (id INTEGER PRIMARY KEY, rel_path TEXT, title TEXT, source_url TEXT, word_count INT, quarry_exclude INT DEFAULT 0);
    CREATE TABLE burrs (id INTEGER PRIMARY KEY, note_id INT, claim TEXT, quote TEXT, kind TEXT, hooks_json TEXT, prompt_version TEXT);`);
  db.prepare('INSERT INTO vault_notes (id,rel_path,title,word_count) VALUES (?,?,?,?)').run(1, 'big.md', 'Big note', 9000);
  db.prepare('INSERT INTO vault_notes (id,rel_path,title,word_count) VALUES (?,?,?,?)').run(2, 'small.md', 'Small note', 10);
  db.prepare('INSERT INTO vault_notes (id,rel_path,title,word_count,quarry_exclude) VALUES (?,?,?,?,1)').run(3, 'private.md', 'Private', 99999);
  db.prepare('INSERT INTO burrs (id,note_id,claim,quote,kind,hooks_json,prompt_version) VALUES (1,99,?,?,?,?,?)').run('Quokkas are marsupials.', 'x', 'fact', JSON.stringify([{ type: 'entity', value: 'Quokkas' }]), 'nug-v6');
  return db;
}
const files = { '/v/big.md': '---\ntitle: x\n---\n' + [A, Bp, C].join('\n\n'), '/v/small.md': 'Tiny note body here today.' };
const opts = o => Object.assign({ db: 'x', version: 'nug-v6', top: 1, notes: null, window: 70, provider: 'gemini', maxUsd: 1, parallel: 2, limitWindows: 0, root: '/v', dryRun: false }, o);

test('pickTop takes the largest non-private notes, or the ones asked for', () => {
  const db = fixture();
  assert.deepStrictEqual(LN.pickTop(db, 2).map(n => n.id), [1, 2]);          // note 3 is excluded (private)
  assert.deepStrictEqual(LN.pickTop(db, 5, [2, 3]).map(n => n.id), [2]);
});

test('dry run lists windows and estimates cost without calling the model', async () => {
  const r = await LN.run(opts({ dryRun: true }), { db: fixture(), readFile: p => files[p], callLLM: () => { throw new Error('no call in a dry run'); } });
  assert.strictEqual(r.estimate.windows, 2);
  assert.ok(r.estimate.usd > 0);
});

test('run: head and tail windows, verified burrs, joins, cache and ledger', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'longnotes-'));
  let calls = 0;
  const callLLM = async (provider, prompt) => {
    calls++;
    const emu = prompt.includes('Emus roam');
    const burr = emu ? { claim: 'Emus roam the Australian plains.', src: [1], kind: 'fact', hooks: [{ type: 'entity', value: 'Emus', cat: 'animal' }], loop: '', perishable: false }
      : { claim: 'Quokkas live on Rottnest Island.', src: [1], kind: 'fact', hooks: [{ type: 'entity', value: 'Quokkas', cat: 'animal' }], loop: '', perishable: false };
    return { text: JSON.stringify({ burrs: [burr], reason: '' }), model: 'gemini-2.5-flash', tokensIn: 1000, tokensOut: 500 };
  };
  const deps = { db: fixture(), readFile: p => files[p], callLLM, outDir: out };
  const r = await LN.run(opts(), deps);
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.summary.head.burrs, 1);
  assert.strictEqual(r.summary.tail.burrs, 1);
  assert.strictEqual(r.summary.head.joinShare, 1);        // Quokkas is carried by another note
  assert.strictEqual(r.summary.tail.joinShare, 0);        // Emus is not
  assert.strictEqual(fs.readFileSync(path.join(out, 'spend.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.strictEqual(fs.readFileSync(path.join(out, 'nug-v6', 'long_notes.jsonl'), 'utf8').trim().split('\n').length, 2);
  // a second run is answered from the cache: no calls, no new spend
  const again = await LN.run(opts(), deps);
  assert.strictEqual(calls, 2);
  assert.strictEqual(again.spent, 0);
});

test('the budget cap stops a run and says so', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'longnotes-'));
  const callLLM = async () => ({ text: '{"burrs":[],"reason":"none"}', model: 'gemini-2.5-flash', tokensIn: 1e6, tokensOut: 1e6 });
  const r = await LN.run(opts({ maxUsd: 0.0001, parallel: 1 }), { db: fixture(), readFile: p => files[p], callLLM, outDir: out });
  assert.match(r.stopped, /budget cap/);
});

test('parseArgs reads the flags and defaults', () => {
  const o = LN.parseArgs(['--db', 'eval.db', '--notes', '1,2', '--dry-run', '--max-usd', '0.5']);
  assert.deepStrictEqual([o.db, o.notes, o.dryRun, o.maxUsd, o.top, o.window, o.provider], ['eval.db', [1, 2], true, 0.5, 10, 5500, 'gemini']);
});
