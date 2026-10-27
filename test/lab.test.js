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

test('fold2: roman numerals and short words are not merged; long transliteration variants are', () => {
  const { variantKey2 } = require('../code/lab/fold2');
  assert.notStrictEqual(variantKey2('World War II'), variantKey2('World War I'));
  assert.notStrictEqual(variantKey2('George III'), variantKey2('George II'));
  assert.notStrictEqual(variantKey2('copper'), variantKey2('cooper'));
  assert.notStrictEqual(variantKey2('tiger'), variantKey2('Tigger'));
  assert.strictEqual(variantKey2('Thanjavur'), variantKey2('Tanjavur'));
  assert.strictEqual(variantKey2('Parvati'), variantKey2('Parvathi'));
  assert.strictEqual(variantKey2('Saraswati'), variantKey2('Sarasvati'));
});

test('knot_sense: labels, stripping, and scoring separate coherent from mixed keys', () => {
  const K = require('../code/lab/knot_sense'), B = require('../code/lib/bristles');
  const L = K.senseLabels([
    { view: 'knots', id: 'foam', label: 'same sense', ts: '1', version: 'nug-v4' },
    { view: 'knots', id: 'diamond', label: 'polyseme', ts: '1', version: 'nug-v4' },
    { view: 'knots', id: 'foam', label: 'apply', ts: '2', version: 'nug-v4' },
    { view: 'knots', id: 'x', label: 'same sense', ts: '1', version: 'nug-v5' }], 'nug-v4');
  assert.deepStrictEqual(Array.from(L.entries()), [['foam', 1], ['diamond', 0]]);
  assert.strictEqual(K.strip('The Foam is white foam.', 'foam'), 'The is white .');
  const mk = (id, note, claim, v) => ({ id: id, note_id: note, claim: claim, hooks: [{ type: 'entity', value: v }] });
  const burrs = [mk(1, 1, 'Foam insulation traps air bubbles in polymer', 'foam'), mk(2, 2, 'Foam insulation polymer bubbles trap air', 'foam'),
    mk(3, 3, 'A diamond is a carbon crystal of extreme hardness', 'diamond'), mk(4, 4, 'The baseball diamond has ninety foot bases', 'diamond')];
  const by = K.burrsByKey(burrs, ['foam', 'diamond']);
  const idf = B.buildIdf(burrs.map(b => B.tokens(b.claim)));
  const rows = K.scoreKnots(by, new Map([['foam', 1], ['diamond', 0]]), texts => { const v = texts.map(t => B.vectorOf(B.tokens(t), idf)); return (i, j) => B.cosine(v[i], v[j]); });
  const f = rows.find(r => r.key === 'foam'), d = rows.find(r => r.key === 'diamond');
  assert.ok(f.score > d.score);
  assert.strictEqual(K.aucOf(rows).auc, 1);
});

const J = require('../code/lab/judge_spec');
const JD = require('../code/lab/judge');
const inp = { handle: 'mercury', types: ['entity'], burrs: [{ id: 1, note: 'A', claim: 'Mercury is a planet', quote: 'q' }, { id: 2, note: 'B', claim: 'Mercury is a metal', quote: 'q' }, { id: 3, note: 'C', claim: 'Freddie Mercury sang', quote: 'q' }] };
test('judge_spec: label mapping keeps only spark verdicts, latest label wins', () => {
  const m = J.sparkLabels([{ view: 'sparks', id: 'a', label: 'spark', ts: '1', version: 'v' }, { view: 'sparks', id: 'a', label: 'dull', ts: '2', version: 'v' }, { view: 'sparks', id: 'b', label: 'apply', ts: '1', version: 'v' }, { view: 'sparks', id: 'c', label: 'held (keep juxtaposition)', ts: '1', version: 'v' }, { view: 'knots', id: 'd', label: 'spark', ts: '1', version: 'v' }], 'v');
  assert.deepStrictEqual(Array.from(m.entries()), [['a', 'none'], ['c', 'held']]);
});
test('judge_spec: parseVerdict accepts valid answers and rejects unverifiable ones', () => {
  assert.strictEqual(J.parseVerdict('{"verdict":"none","why":"different senses","burrs":[]}', inp, 'open').verdict, 'none');
  assert.strictEqual(J.parseVerdict('```json\n{"verdict":"yes","link":"x","burrs":[1,2],"why":"w"}\n```', inp, 'open').ok, true);
  assert.match(J.parseVerdict('{"verdict":"yes","burrs":[1],"why":"w"}', inp, 'open').error, /two cited/);
  assert.match(J.parseVerdict('{"verdict":"yes","burrs":[1,9],"why":"w"}', inp, 'open').error, /not provided/);
  assert.match(J.parseVerdict('{"verdict":"held","why":"w"}', inp, 'strict').error, /strict/);
  assert.match(J.parseVerdict('{"verdict":"maybe","why":"w"}', inp, 'open').error, /bad verdict/);
  assert.match(J.parseVerdict('no json here', inp, 'open').error, /no JSON/);
  assert.match(J.parseVerdict('{"verdict":"none"}', inp, 'open').error, /empty why/);
});
test('judge_spec: prompts carry ids and stance; cache key varies with stance and input', () => {
  assert.ok(J.userPrompt(inp).includes('[2] (note: B)'));
  assert.ok(J.systemPrompt('open').includes('"held"') && !J.systemPrompt('strict').includes('"held":'));
  assert.notStrictEqual(J.cacheKey('gemini', inp, 'open'), J.cacheKey('gemini', inp, 'strict'));
  assert.strictEqual(J.cacheKey('gemini', inp, 'open'), J.cacheKey('gemini', JSON.parse(JSON.stringify(inp)), 'open'));
});
test('judge harness: caches, caps spend, flags failures, and reports a confusion matrix', async () => {
  let calls = 0;
  const callLLM = async (p, prompt) => { calls++; if (prompt.includes('BOOM')) throw new Error('503'); return { text: '{"verdict":"none","why":"different senses","burrs":[]}', model: 'gemini-2.5-flash', tokensIn: 1000000, tokensOut: 0 }; };
  const rows = [{ id: 'a', truth: 'none', input: inp }, { id: 'b', truth: 'yes', input: Object.assign({}, inp, { handle: 'x2' }) }, { id: 'c', truth: 'held', input: Object.assign({}, inp, { handle: 'BOOM' }) }];
  const deps = { callLLM: callLLM, cache: JD.memCache() };
  const recs = await JD.judgeRows(rows, deps, { maxUsd: 0.2 });
  assert.deepStrictEqual(recs.map(r => r.verdict), ['none', 'error', 'error']);   // second call hit the $0.20 cap after $0.30 of spend; third also capped
  assert.match(recs[1].error, /cap/);
  const again = await JD.judgeRows(rows.slice(0, 1), deps, { maxUsd: 0.2 });
  assert.strictEqual(again[0].cached, true); assert.strictEqual(calls, 1);
  const rep = JD.report(recs);
  assert.strictEqual(rep.n, 3); assert.strictEqual(rep.confusion.none.none, 1); assert.strictEqual(rep.errors, 2);
});

const NB = require('../code/lab/nug_bakeoff');
const BR = require('../code/lib/burrs');
test('nug_bakeoff: evaluates responses with the real verifier, compares models and caps spend', async () => {
  const note = { id: 1, title: 'Quokka selfie craze, Rottnest, 2015', source_url: null, cleaned: 'Quokkas on Rottnest Island became a selfie craze in 2015.', real_words: 9 };
  const good = JSON.stringify({ burrs: [{ claim: 'Quokkas on Rottnest Island became a selfie craze in 2015.', src: ['T'], kind: 'fact', hooks: [{ type: 'time', value: '2015', era: 'AD' }] }] });
  const bad = JSON.stringify({ burrs: [{ claim: 'Quokkas were famous by 1999.', src: ['T'], kind: 'fact', hooks: [] }] });
  const e1 = NB.evaluate(good, note), e2 = NB.evaluate(bad, note), e3 = NB.evaluate('not json at all', note);
  assert.strictEqual(e1.accepted.length, 1); assert.strictEqual(e2.accepted.length, 0); assert.strictEqual(e2.rejected.length, 1); assert.strictEqual(e3.parsed, false);
  const s = NB.summarise([e1, e2, e3]);
  assert.strictEqual(s.parse_failures, 1); assert.strictEqual(s.notes, 3);
  assert.ok(NB.overlap([[e1, e1]]).baseline_found_by_candidate === 1);
  const input = BR.buildInput(note, note.cleaned), baseKey = BR.cacheKey('gemini', input);
  let calls = 0; const mem = JD.memCache();
  const rows = [{ id: 1 }, { id: 2 }];
  const deps = { loadNote: () => note, baseline: k => k === baseKey ? good : null, callLLM: async (p, prompt, o) => { calls++; assert.strictEqual(o.model, 'gemini-2.5-flash-lite'); return { text: good, model: o.model, tokensIn: 1000000, tokensOut: 0 }; }, cache: mem };
  const out = await NB.run(rows, deps, { provider: 'gemini', model: 'gemini-2.5-flash-lite', maxUsd: 0.05, rate: { in: 0.1, out: 0.4 } });
  assert.strictEqual(out.filter(r => r.base).length, 2); assert.strictEqual(calls, 1);   // 2nd note: cache hit; no extra call
});

const QI = require('../code/lab/quiz_items');
test('quiz_items: Q/A parser splits questions and answers; slide parser drops repeated question slides', () => {
  const qa = QI.parseQA('Q 1 (triple)\nThe 1996 novel, X, by Jeffrey Archer is a thinly disguised account of two press barons.\nWhich book?\nA1\n- The Fourth Estate\n- Maxwell & Murdoch\nQ2 This and that\nOriginally a late 18th century German literary movement, now a synonym for turmoil.\nA2\n- Sturm und Drang');
  assert.strictEqual(qa.length, 2); assert.strictEqual(qa[0].n, 1); assert.ok(qa[0].answer.includes('Fourth Estate')); assert.ok(qa[1].answer.includes('Sturm'));
  const sl = QI.parseSlides('Kaze no denwa is an unconnected telephone box in Otsuchi Japan meant for lost loved ones. What do the Japanese trust to carry their messages?\n\f Kaze no denwa is an unconnected telephone box in Otsuchi Japan meant for lost loved ones. What do the Japanese trust to carry their messages?\nWind\n 7\n\f Hutch the One Armed Man with a Defense is a 1970 sculptural work by H.C. Westermann in Chicago.');
  assert.strictEqual(sl.length, 2); assert.ok(sl[0].question.includes('Wind'));
});

const QB = require('../code/lab/quiz_backtest');
test('quiz_backtest: pairs are same-item positives vs cross-item negatives; scoring ranks shared content above random', () => {
  const mk = (n, i, claim, hook) => ({ id: n + '/' + i, note_id: n, claim: claim, hooks: [{ type: 'entity', value: hook }] });
  const burrs = [mk('a', 0, 'Harappan seals depict a unicorn animal', 'Harappa'), mk('a', 1, 'Harappa was excavated in 1921 by Daya Ram Sahni', 'Harappa'),
    mk('b', 0, 'Quokkas on Rottnest became a selfie craze in 2015', 'Quokka'), mk('b', 1, 'Rottnest Island quokkas were named by Dutch sailor Willem de Vlamingh', 'Quokka'),
    mk('c', 0, 'Mount Kailash has never been climbed', 'Kailash'), mk('d', 0, 'The sitar has 18 to 21 strings', 'sitar')];
  const p = QB.pairsOf(burrs, 3);
  assert.strictEqual(p.pos.length, 2); assert.ok(p.rand.every(([x, y]) => x.note_id !== y.note_id));
  const s = QB.scoreAll(burrs, p); assert.ok(s.shared_hooks.auc_vs_random > 0.5);
});
