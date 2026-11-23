'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const G = require('../packs/quiz/data/glossary.json'), H = require('../packs/quiz/data/heuristics.json'), { pickExamples } = require('../code/lab/glossary_examples');

test('the glossary covers every heuristic once, in the repo, with no examples in it', () => {
  assert.deepStrictEqual(G.rows.map((r) => r.id), H.rows.map((r) => r.id));
  G.rows.forEach((r) => { assert.ok(r.name && r.definition.length > 10, r.id + ' has a definition'); assert.ok(['draft', 'locked'].includes(r.status)); assert.ok(['found', 'pile', 'half', 'none'].includes(r.detects)); assert.strictEqual(r.example, undefined, 'examples stay out of the repo file'); });
  assert.ok(fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8').split('\n').includes('backtest/'), 'the examples file lives in a gitignored folder');
});

test('pickExamples prefers a confident sentence over a bare name and marks your own', () => {
  const ex = pickExamples([{ h: 1, src: 'KK', text: 'Anaimudi', conf: 'H' }, { h: 1, src: 'P', text: 'Vespasian tariff leads to a land name', conf: 'H' }, { h: 2, src: 'KK', text: 'A long enough sentence about a ripple effect', conf: 'M' }]);
  assert.strictEqual(ex[1].text, 'Vespasian tariff leads to a land name'); assert.strictEqual(ex[1].own, true); assert.strictEqual(ex[2].own, false);
});

test('GET /api/glossary returns every entry', async () => {
  const { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gl-')), marks = K.open(path.join(dir, 'm.jsonl'), 't');
  const srv = createServer({ model: { burrInfo: () => null, stickRandom: () => null, burrs: [], sparks: [], wordplay: [], notes: 0 }, marks, notes: { get: () => null }, version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui') });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: 'localhost:' + port } }, (r) => { let x = ''; r.on('data', (d) => x += d); r.on('end', () => res(JSON.parse(x))); }));
  try { const j = await get('/api/glossary'); assert.strictEqual(j.rows.length, 71); assert.ok(j.rows.every((r) => r.example === null || typeof r.example.text === 'string')); } finally { srv.close(); }
});
