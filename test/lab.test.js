'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const M = require('../code/lab/metrics');
const S = require('../code/lab/sim');
const D = require('../code/lab/data');

test('auc: perfect, inverted, ties', () => {
  assert.strictEqual(M.auc([3, 4], [1, 2]), 1);
  assert.strictEqual(M.auc([1, 2], [3, 4]), 0);
  assert.strictEqual(M.auc([1], [1]), 0.5);
});
test('precision/recall at k', () => {
  assert.strictEqual(M.precisionAtK([true, false, true], 2), 0.5);
  assert.strictEqual(M.recallAtK([true, false, true], 3, 4), 0.5);
});
test('tfidf baseline ranks a paraphrase above an unrelated claim', () => {
  const t = S.tfidfBackend(['The Hope diamond weighs 45 carats', 'Hope diamond weight is 45 carats', 'Rivers flow to the sea through deltas']);
  assert.ok(t.sim(0, 1) > t.sim(0, 2));
});
test('embed cache: unchanged texts are not re-embedded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));
  let calls = 0;
  const backend = { name: 'fake', embed: async ts => { calls += ts.length; return ts.map(t => [t.length, 1]); } };
  const c1 = new S.EmbedCache(dir, 'fake');
  const r1 = await S.embedAll(backend, ['a', 'bb'], c1);
  assert.deepStrictEqual([r1.embedded, r1.cached, calls], [2, 0, 2]);
  const c2 = new S.EmbedCache(dir, 'fake');
  const r2 = await S.embedAll(backend, ['a', 'bb', 'ccc'], c2);
  assert.deepStrictEqual([r2.embedded, r2.cached, calls], [1, 2, 3]);
});
test('data adapter loads burrs by version from an in-memory db', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE burrs (id INTEGER PRIMARY KEY, note_id INT, claim TEXT, quote TEXT, kind TEXT, hooks_json TEXT, prompt_version TEXT)");
  db.prepare('INSERT INTO burrs VALUES (?,?,?,?,?,?,?)').run(1, 10, 'c1', 'q', 'fact', '[{"type":"time"}]', 'nug-v6');
  db.prepare('INSERT INTO burrs VALUES (?,?,?,?,?,?,?)').run(2, 10, 'c2', 'q', 'fact', 'bad json', 'nug-v5');
  assert.strictEqual(D.loadBurrs(db, 'nug-v6').length, 1);
  assert.strictEqual(D.loadBurrs(db, 'nug-v5')[0].hooks.length, 0);
  assert.deepStrictEqual(D.loadDupes(db), []);
});

const E2 = require('../code/lab/e2_bakeoff');
const E1 = require('../code/lab/e1_fold');
const { ollamaBackend } = require('../code/lab/embed_ollama');
const mk = (id, note, claim, vals) => ({ id: id, note_id: note, claim: claim, hooks: (vals || []).map(v => ({ type: 'entity', value: v })) });

test('e2 buildPairs: positives are cross-note clones; negatives exclude dupes; hard negatives share a hook', () => {
  const burrs = [];
  for (let i = 1; i <= 40; i++) burrs.push(mk(i, Math.ceil(i / 2), 'claim number ' + i, i % 4 === 0 ? ['Hastinapur'] : ['Delhi']));
  const dupes = [{ burr_id: 3, dup_of: 6, kind: 'clone' }, { burr_id: 1, dup_of: 2, kind: 'echo' }];
  const p = E2.buildPairs(burrs, dupes, { seed: 3 });
  assert.deepStrictEqual(p.pos, [[3, 6]]);
  p.rand.concat(p.hard).forEach(([a, b]) => { assert.notStrictEqual(Math.ceil(a / 2), Math.ceil(b / 2)); assert.ok(!(a === 3 && b === 6) && !(a === 6 && b === 3)); });
  assert.ok(p.hard.length > 0);
});
test('e1 foldGroups groups transliteration variants and skips numeric hook types', () => {
  const burrs = [mk(1, 1, 'x', ['Bhima']), mk(2, 2, 'y', ['Bima']), mk(3, 3, 'z', ['Delhi']), { id: 4, note_id: 4, claim: 'q', hooks: [{ type: 'time', value: 'Bhima 1900' }] }];
  const g = E1.foldGroups(burrs);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual(g[0].forms.map(f => f.fold).sort(), ['bhima', 'bima']);
  assert.ok(E1.render(g, 'nug-v6').includes('OK'));
});
test('ollama backend: posts to /api/embed and returns vectors; surfaces errors', async () => {
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', d => body += d); req.on('end', () => {
      const j = JSON.parse(body);
      if (j.model === 'bad') { res.statusCode = 404; res.end('model not found'); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ embeddings: j.input.map(t => [t.length, 1]) }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    assert.deepStrictEqual(await ollamaBackend('m', { url: url }).embed(['ab', 'c']), [[2, 1], [1, 1]]);
    await assert.rejects(ollamaBackend('bad', { url: url }).embed(['x']), /404/);
  } finally { srv.close(); }
  await assert.rejects(ollamaBackend('m', { url: 'http://127.0.0.1:1' }).embed(['x']), /unreachable/);
});
