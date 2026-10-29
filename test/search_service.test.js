'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const Core = require('../code/lib/search_core'), Cache = require('../code/lib/search_cache'), V = require('../code/lib/search_vectors'), E = require('../code/lib/search_embed');
const { createRewriter, cleanRewrite } = require('../code/lib/search_rewrite'), { createSearchService } = require('../code/lib/search_service');

const burrs = [
  { id: 1, noteId: 10, claim: 'Halite is the mineral form of sodium chloride, rock salt.', note: 'Minerals' },
  { id: 2, noteId: 10, claim: 'Gypsum is a soft sulfate mineral.', note: 'Minerals' },
  { id: 3, noteId: 10, claim: 'Quartz is silicon dioxide.', note: 'Minerals' },
  { id: 4, noteId: 11, claim: 'The Great Wall was built against Mongol raids.', note: 'China' },
  { id: 5, noteId: 12, claim: 'Rust was started by Graydon Hoare.', note: 'Languages' }
];
// Tiny 3-d "meaning space": salt/rock facts point at x, wall facts at y, language facts at z.
const axis = { 1: [1, 0.1, 0], 2: [0.9, 0, 0.1], 3: [0.8, 0.2, 0], 4: [0, 1, 0], 5: [0, 0, 1] };
function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')), text = id => burrs.find(b => b.id === id).claim;
  V.write(dir, 'fake', burrs.map(b => ({ id: b.id, text: b.claim, vec: axis[b.id] })));
  const vectors = V.load(dir, 'fake', text), calls = { embed: 0, llm: 0 };
  const embedder = { model: 'fake', breaker: E.createBreaker(), async embed(ts) { calls.embed += ts.length; return ts.map(t => /salt|halite|ore/i.test(t) ? [1, 0, 0] : /wall/i.test(t) ? [0, 1, 0] : [-1, -1, -1]); } };
  const cache = Cache.open(':memory:');
  const rewriter = createRewriter({ cache, hasKey: () => true, priceFor: () => ({ in: 0.3, out: 2.5 }), config: { provider: 'gemini' },
    callLLM: async (p, prompt) => { calls.llm++; if (over.llmFails) throw new Error('boom'); return { text: /halite/i.test(prompt) ? 'Halite is rock salt, sodium chloride. Terms: salt, halite' : 'Something unrelated entirely. Terms: x', model: 'm', tokensIn: 250, tokensOut: 100 }; } });
  const svc = createSearchService({ burrs, words: Core.buildWordIndex(burrs), vectors, embedder: over.noEmbedder ? null : embedder, rewriter: over.noRewriter ? null : rewriter, cache });
  return { svc, calls, cache };
}

test('cache: questions normalise, rewrites and vectors round-trip, spend sums by day', () => {
  assert.strictEqual(Cache.normQuestion('  Who MADE   X? '), 'who made x');
  assert.strictEqual(Cache.rewriteKey('Who made X?', 'rw1', 'm'), Cache.rewriteKey('who made x', 'rw1', 'm'));
  assert.notStrictEqual(Cache.rewriteKey('who made x', 'rw1', 'm'), Cache.rewriteKey('who made x', 'rw2', 'm'));
  const c = Cache.open(':memory:'); c.putVec('k', 'm', [0.5, 0.25]); assert.deepStrictEqual(Array.from(c.getVec('k')), [0.5, 0.25]); assert.strictEqual(c.getVec('none'), null);
  c.addSpend({ task: 't', cost: 0.01 }); assert.ok(Math.abs(c.spentSince('2000-01-01') - 0.01) < 1e-9); assert.strictEqual(c.spentSince('2999-01-01'), 0);
});

test('rewriter: asks once, then answers from cache; respects the daily cap and a missing key', async () => {
  const { svc, calls, cache } = fixture();
  await svc.search({ q: 'What kind of ore is halite?' }); await svc.search({ q: 'what kind of ore is halite' });
  assert.strictEqual(calls.llm, 1, 'second ask is free'); assert.strictEqual(cache.counts().rewrites, 1);
  const rw = createRewriter({ cache: Cache.open(':memory:'), hasKey: () => false, callLLM: async () => { throw new Error('never'); } });
  await assert.rejects(rw.rewrite('x'), /key/);
  const c2 = Cache.open(':memory:'); c2.addSpend({ task: 't', cost: 1 });
  await assert.rejects(createRewriter({ cache: c2, hasKey: () => true, callLLM: async () => ({}), config: { maxUsdPerDay: 0.25 } }).rewrite('y'), /budget/);
  assert.strictEqual(cleanRewrite('```\nHere is it:\nfoo   bar\n```'), 'foo bar');
});

test('hybrid search: bands the best match, groups by note, shows what it understood', async () => {
  const { svc } = fixture(); const r = await svc.search({ q: 'What kind of ore is halite?' });
  assert.strictEqual(r.mode, 'hybrid'); assert.strictEqual(r.band, 'likely'); assert.match(r.understoodAs, /rock salt/); assert.strictEqual(r.results[0].burrId, 1);
  assert.ok(r.results.filter(x => x.noteId === 10).length <= 2, 'at most two per note'); assert.ok(r.results[0].via.meaning && r.results[0].via.words); assert.ok(r.results[0].basis && typeof r.bestSim === 'number', 'the rated fact is pinned first');
  const none = await svc.search({ q: 'Who composed the opera' }); assert.strictEqual(none.band, 'nothing'); assert.ok(none.folded); assert.match(none.bandText, /Nothing close/);
});

test('degradation ladder: every skipped rung says why, and results still come back', async () => {
  let r = await fixture({ llmFails: true }).svc.search({ q: 'halite ore' });
  assert.strictEqual(r.mode, 'question'); assert.strictEqual(r.band, 'unrated'); assert.ok(r.notices.some(n => /could not be rewritten/.test(n.text))); assert.ok(r.results.length);
  r = await fixture({ noRewriter: true }).svc.search({ q: 'halite ore' }); assert.strictEqual(r.band, 'unrated'); assert.ok(r.notices.some(n => /not available/.test(n.text)));
  r = await fixture({ noEmbedder: true }).svc.search({ q: 'halite ore' }); assert.strictEqual(r.mode, 'words'); assert.strictEqual(r.band, null); assert.ok(r.notices.some(n => /No embedding server/.test(n.text)));
  const f = fixture(); r = await f.svc.search({ q: 'halite ore', meaning: false });
  assert.strictEqual(r.mode, 'words'); assert.strictEqual(f.calls.embed, 0); assert.strictEqual(f.calls.llm, 0, 'switch off spends nothing'); assert.ok(r.notices.some(n => /is off/.test(n.text)));
});

test('a dead embedding server falls back to words and says so; bad questions are refused', async () => {
  const f = fixture(); const s2 = createSearchService({ burrs, words: Core.buildWordIndex(burrs), embedder: { model: 'fake', embed: async () => { throw new Error('unreachable'); } }, vectors: V.load(fs.mkdtempSync(path.join(os.tmpdir(), 'e-')), 'none', () => '') });
  let r = await s2.search({ q: 'halite' }); assert.strictEqual(r.mode, 'words'); assert.ok(r.notices.some(n => /not been built/.test(n.text)));
  const vecs = fixture().svc; assert.ok(vecs.status().meaning.ready);
  const dead = createSearchService({ burrs, words: Core.buildWordIndex(burrs), vectors: V.load((() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'd-')); V.write(d, 'fake', burrs.map(b => ({ id: b.id, text: b.claim, vec: axis[b.id] }))); return d; })(), 'fake', id => burrs.find(b => b.id === id).claim), embedder: { model: 'fake', embed: async () => { throw new Error('unreachable'); } } });
  r = await dead.search({ q: 'halite' }); assert.strictEqual(r.mode, 'words'); assert.ok(r.notices.some(n => /unavailable \(unreachable\)/.test(n.text))); assert.ok(r.results.length);
  await assert.rejects(f.svc.search({ q: '  ' }), { code: 'bad_request' }); await assert.rejects(f.svc.search({ q: 'x'.repeat(301) }), { code: 'bad_request' });
});

test('vector store: a changed claim drops out of meaning search; a removed burr is counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-')); V.write(dir, 'fake', burrs.map(b => ({ id: b.id, text: b.claim, vec: axis[b.id] })));
  const v = V.load(dir, 'fake', id => id === 2 ? 'edited' : id === 3 ? undefined : burrs.find(b => b.id === id).claim);
  assert.strictEqual(v.stale, 1); assert.strictEqual(v.gone, 1); assert.strictEqual(v.count, 3); assert.strictEqual(v.nearest([1, 0, 0], 1)[0].id, 1); assert.strictEqual(V.load(dir, 'other', () => ''), null);
});

test('breaker opens after repeated failures and recovers after the cool-down', async () => {
  let t = 0; const b = E.createBreaker({ threshold: 2, coolMs: 100, now: () => t });
  for (let i = 0; i < 2; i++) await assert.rejects(b.run(async () => { throw new Error('x'); }));
  assert.ok(b.isOpen()); await assert.rejects(b.run(async () => 1), /paused/); t = 200; assert.strictEqual(await b.run(async () => 7), 7); assert.ok(!b.isOpen());
});

// ---- HTTP and interface
const http = require('http'), { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks'), { fakeModel, fakeNotes } = require('./helpers/muse_fake'), { pathToFileURL } = require('url');
async function withSearchServer(search, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')), srv = createServer({ model: fakeModel(), marks: K.open(path.join(dir, 'm.jsonl'), 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), search });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (p, headers = {}) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: p, headers: Object.assign({ Host: 'localhost:' + port }, headers) }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(b) })); }).on('error', reject); });
  try { await fn(call); } finally { srv.close(); }
}
test('/api/search needs the X-Muse header (a cross-site page cannot send it), reports plain errors, and is optional', async () => {
  const f = fixture();
  await withSearchServer(f.svc, async call => {
    assert.strictEqual((await call('/api/search?q=halite')).status, 403, 'a bare GET, as a cross-site page could make, is refused');
    assert.strictEqual(f.calls.llm, 0, 'and spends nothing');
    const ok = await call('/api/search?q=what+kind+of+ore+is+halite&meaning=1', { 'X-Muse': '1' }); assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json().band, 'likely');
    assert.strictEqual((await call('/api/search?q=', { 'X-Muse': '1' })).status, 400);
    assert.strictEqual((await call('/api/search?q=halite&meaning=0', { 'X-Muse': '1' })).json().mode, 'words');
    assert.strictEqual((await call('/api/search/status')).json().meaning.ready, true);
    assert.strictEqual((await call('/api/meta')).json().search.ready, true);
  });
  await withSearchServer(null, async call => { assert.strictEqual((await call('/api/search?q=x', { 'X-Muse': '1' })).status, 503); assert.strictEqual((await call('/api/search/status')).json().disabled, true); });
});
test('interface: the search route, the switch rule and the crumb', async () => {
  const ui = f => import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', f)).href);
  const { parse, build } = await ui('router.mjs'), { trail } = await ui('crumbs.mjs');
  const S = await import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', 'views', 'search.mjs')).href).catch(() => null);
  assert.deepStrictEqual(parse('#/search?q=halite&meaning=off'), { name: 'search', params: {}, query: { q: 'halite', meaning: 'off' } });
  assert.strictEqual(build('search', {}, { q: 'a b', meaning: '' }), '#/search?q=a+b'); assert.deepStrictEqual(trail(parse('#/search?q=x')).map(x => x.label), ['Connect', 'Search']);
  { assert.strictEqual(S.wantsMeaning({ query: {} }, true), true); assert.strictEqual(S.wantsMeaning({ query: {} }, false), false); assert.strictEqual(S.wantsMeaning({ query: { meaning: 'off' } }, true), false); assert.strictEqual(S.SWITCH_LABEL, 'Search by meaning'); assert.strictEqual(S.viaLabel({ words: true, meaning: true }), 'words + meaning'); }
});
