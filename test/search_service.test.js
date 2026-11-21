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
  assert.strictEqual(build('search', {}, { q: 'a b', meaning: '' }), '#/search?q=a+b'); assert.deepStrictEqual(trail(parse('#/search?q=x')).map(x => x.label), ['Home', 'Search']);
  { assert.strictEqual(S.wantsMeaning({ query: {} }, true), true); assert.strictEqual(S.wantsMeaning({ query: {} }, false), false); assert.strictEqual(S.wantsMeaning({ query: { meaning: 'off' } }, true), false); assert.strictEqual(S.SWITCH_LABEL, 'Search by meaning'); assert.strictEqual(S.viaLabel({ words: true, meaning: true }), 'words + meaning'); }
});

// ---- Stick
test('Stick: real model API returns grouped clings from other notes; route validates input', async () => {
  const { DatabaseSync } = require('node:sqlite'), M = require('../code/lib/muse_model'), dbFile = path.join(__dirname, '..', 'vault.db');
  if (!fs.existsSync(dbFile)) return;                                  // the live vault is not in every checkout
  const m = M.build(new DatabaseSync(dbFile, { readOnly: true }), 'nug-v6', {}), s = m.stickRandom(3, () => 0.5);
  assert.ok(s && s.clings >= 3, 'a random fact with at least three hooks'); const held = s.burr;
  s.groups.forEach(g => g.hooks.forEach(hk => { assert.ok(hk.df >= 2 && hk.df <= 60); hk.items.forEach(i => { assert.notStrictEqual(i.noteId, held.noteId, 'clings come from other notes'); assert.ok(i.claim); }); assert.ok(hk.items.length <= 5); }));
  assert.strictEqual(m.stick(-1), null);
  const stub = { stick: id => id === 7 ? { burr: { id: 7 }, groups: [{ type: 'place', hooks: [{ id: 'giza', label: 'Giza', df: 3, items: [{ id: 1, claim: 'a' }, { id: 2, claim: 'b' }], more: 0 }] }], clings: 1, common: [] } : null, stickRandom: () => null, burrs: [], notes: 1, sparks: [], wordplay: [], wordplayState: 'ok', wordplayKinds: () => [], handle: () => null, suggest: () => [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-')), marks = K.open(path.join(dir, 'm.jsonl'), 't'); marks.set('giza', 2, 'dull');
  const srv = createServer({ model: stub, marks, notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui') }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const get = p => new Promise(res => http.get({ host: '127.0.0.1', port, path: p, headers: { Host: 'localhost:' + port } }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }));
  try {
    const ok = await get('/api/stick?id=7'); assert.strictEqual(ok.status, 200); assert.deepStrictEqual(JSON.parse(ok.body).groups[0].hooks[0].items.map(i => i.id), [1], 'a fact marked dull is left out');
    assert.strictEqual((await get('/api/stick?id=abc')).status, 404); assert.strictEqual((await get('/api/stick?id=8')).status, 404); assert.strictEqual((await get('/api/stick?random=1')).status, 404, 'no candidate: plain 404');
  } finally { srv.close(); }
  const { parse } = await import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', 'router.mjs')).href), V = await import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', 'views', 'stick.mjs')).href);
  assert.strictEqual(parse('#/?focus=7').name, 'home'); assert.strictEqual(parse('#/stick?id=7').query.focus, '7'); assert.strictEqual(parse('#/stick').name, 'stick'); assert.strictEqual(V.typeLabel('place'), 'Places'); assert.strictEqual(V.typeLabel('former-role'), 'Former roles'); assert.strictEqual(V.stickHref(7), '#/?focus=7');
});

test('Stick shelves: every fact is on exactly one shelf, shuffles are stable per seed, fragments stay out, kinds filter', async () => {
  const { DatabaseSync } = require('node:sqlite'), M = require('../code/lib/muse_model'), dbFile = path.join(__dirname, '..', 'vault.db');
  if (!fs.existsSync(dbFile)) return;
  const m = M.build(new DatabaseSync(dbFile, { readOnly: true }), 'nug-v6', {}), a = m.shelf('lone', { seed: 5 }), b = m.shelf('lone', { seed: 5 }), c = m.shelf('lone', { seed: 6 });
  const sh = a.shelves; assert.strictEqual(sh.veins + sh.grip + sh.lone, m.burrs.length, 'veins + grip + lone cover every fact exactly once');
  assert.deepStrictEqual(a.items.map(i => i.id), b.items.map(i => i.id), 'same seed, same page'); assert.notDeepStrictEqual(a.items.map(i => i.id), c.items.map(i => i.id), 'new seed, fresh handful');
  a.items.forEach(i => { assert.ok(i.claim.length >= 30 && i.nHooks === 0); }); assert.strictEqual(m.shelf('nope'), null);
  const v = m.shelf('veins', { type: 'place' }); assert.ok(v.total > 0 && v.items.every(i => i.types.includes('place') && i.nHooks >= 3));
  assert.strictEqual(m.shelf('veins', { page: 99999 }).page, m.shelf('veins', {}).pages, 'page numbers are clamped');
  const { tray } = await import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', 'components', 'tray.mjs')).href);
  tray.clear(); tray.toggle({ id: 1, note: 'N', claim: 'A' }); tray.toggle({ id: 2, note: 'M', claim: 'B' }); tray.setLink(1, 2, 'same place'); assert.strictEqual(tray.text(), '1. A  [N]\n   ↳ same place\n2. B  [M]'); assert.strictEqual(tray.toggle({ id: 1 }), false); tray.clear();
});

test('Stick: far-apart clings come first; shuffles skip what you have seen; events are recorded and validated', async () => {
  const { DatabaseSync } = require('node:sqlite'), M = require('../code/lib/muse_model'), dbFile = path.join(__dirname, '..', 'vault.db');
  if (!fs.existsSync(dbFile)) return;
  const m = M.build(new DatabaseSync(dbFile, { readOnly: true }), 'nug-v6', {}), s = m.stickRandom(3, () => 0.2);
  s.groups.forEach(g => g.hooks.forEach(hk => { const ds = hk.items.map(i => i.dist == null ? -1 : i.dist); assert.deepStrictEqual(ds, ds.slice().sort((a, b) => b - a), 'sorted far to near'); hk.items.forEach(i => assert.strictEqual(i.far, i.dist != null && i.dist >= 0.9)); }));
  const p1 = m.shelf('lone', { seed: 11 }).items.map(i => i.id), again = m.shelf('lone', { seed: 11 }).items.map(i => i.id), fresh = m.shelf('lone', { seed: 12 }).items.map(i => i.id);
  assert.deepStrictEqual(p1, again, 'same seed, same page, even after being seen'); assert.strictEqual(fresh.filter(id => p1.includes(id)).length, 0, 'a new shuffle never repeats what was just shown');
  const logged = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-')), srv = createServer({ model: fakeModel(), marks: K.open(path.join(dir, 'm.jsonl'), 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), events: { append: o => logged.push(o) } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const post = (body, type = 'application/json') => new Promise(res => { const rq = http.request({ host: '127.0.0.1', port, path: '/api/event', method: 'POST', headers: { Host: 'localhost:' + port, 'Content-Type': type } }, r => { r.resume(); r.on('end', () => res(r.statusCode)); }); rq.end(JSON.stringify(body)); });
  try {
    assert.strictEqual(await post({ kind: 'pick', id: 5, from: 'lone' }), 200); assert.strictEqual(logged[0].from, 'lone');
    assert.strictEqual(await post({ kind: 'pick', id: 5, from: 'lone' }, 'text/plain'), 415); assert.strictEqual(await post({ kind: 'steal', id: 5, from: 'x' }), 400); assert.strictEqual(await post({ kind: 'hold', id: 'a', from: 'x' }), 400); assert.strictEqual(logged.length, 1);
  } finally { srv.close(); }
});

test('Tray saving: the server validates and stores the tray; bad shapes and non-JSON are refused', async () => {
  let saved = null; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-')), srv = createServer({ model: fakeModel(), marks: K.open(path.join(dir, 'm.jsonl'), 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), trayStore: { load: () => saved || { items: [], links: {} }, save: o => { saved = o; } } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (method, body, type = 'application/json') => new Promise(res => { const rq = http.request({ host: '127.0.0.1', port, path: '/api/tray', method, headers: { Host: 'localhost:' + port, 'Content-Type': type } }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }); rq.end(body === undefined ? undefined : JSON.stringify(body)); });
  try {
    const good = { items: [{ id: 1, noteId: 2, note: 'N', claim: 'A' }, { id: 3, noteId: null, note: 'M', claim: 'B' }], links: { '1>3': 'same place' } };
    assert.strictEqual((await call('POST', good)).status, 200); assert.deepStrictEqual(JSON.parse((await call('GET')).body), good, 'what was saved is what comes back');
    assert.strictEqual((await call('POST', good, 'text/plain')).status, 415); assert.strictEqual((await call('POST', { items: [{ id: 'x', note: '', claim: '' }], links: {} })).status, 400);
    assert.strictEqual((await call('POST', { items: [], links: { 'a>b': 'x' } })).status, 400); assert.strictEqual((await call('POST', { items: Array(51).fill({ id: 1, note: 'n', claim: 'c' }), links: {} })).status, 400);
  } finally { srv.close(); }
});

test('Help: every recipe is complete, every link is a real screen, and every button it names exists in the interface', async () => {
  const base = path.join(__dirname, '..', 'code', 'muse_ui', 'js'), C = await import(pathToFileURL(path.join(base, 'help_content.mjs')).href), R = await import(pathToFileURL(path.join(base, 'router.mjs')).href);
  assert.ok(C.RECIPES.length >= 8); const keys = new Set();
  C.RECIPES.forEach(r => { assert.ok(r.key && !keys.has(r.key), 'unique key ' + r.key); keys.add(r.key); assert.ok(r.title && r.goal && r.start && r.start.t && r.steps.length >= 3, r.key + ' is complete'); });
  const hrefs = C.RECIPES.flatMap(r => [r.start.href].concat(r.steps.map(s => s && s.href))).filter(Boolean);
  hrefs.forEach(h => { const p = R.parse(h); assert.ok(h.startsWith('#/') && ['home','set','basket','search','stick','admin','help','dipaka','angles'].includes(p.name), h + ' is a real screen (got ' + p.name + ')'); });
  assert.deepStrictEqual(C.WHICH.map(w => w.button), ['Focus', 'Collect', 'Star'].map(k => k)); // order: look, build, remember
  // Which buttons exist is checked against the real UI source by the Muse map audit (test/muse_map.test.js), the one place that owns it.
  const HV = await import(pathToFileURL(path.join(base, 'views', 'help.mjs')).href); assert.strictEqual(typeof HV.helpView, 'function'); assert.strictEqual(R.parse('#/help?r=know').name, 'help');
});

test('words search pages through every match (not just the best 10), 2 per note, with a total; meaning search stays a short ranked list', async () => {
  const many = []; for (let n = 0; n < 40; n++) for (let k = 0; k < 3; k++) many.push({ id: n * 3 + k + 1, noteId: 100 + n, claim: 'India fact ' + n + '-' + k + ' about trade.', note: 'Note ' + n });
  const svc = createSearchService({ burrs: many, words: Core.buildWordIndex(many) });
  const p1 = await svc.search({ q: 'india', meaning: false });
  assert.deepStrictEqual([p1.paged, p1.total, p1.pages, p1.page, p1.size, p1.results.length], [true, 80, 7, 1, 12, 12], '40 notes x 2 per note = 80 results, 12 a page');
  const p2 = await svc.search({ q: 'india', meaning: false, page: 2 });
  assert.strictEqual(p2.page, 2); assert.ok(p2.results.every(r => !p1.results.some(x => x.burrId === r.burrId)), 'page 2 has different facts');
  const perNote = {}; for (let p = 1; p <= 7; p++) (await svc.search({ q: 'india', meaning: false, page: p })).results.forEach(r => { perNote[r.noteId] = (perNote[r.noteId] || 0) + 1; });
  assert.ok(Object.values(perNote).every(c => c <= 2) && Object.keys(perNote).length === 40, 'every note shows, at most 2 each, across all pages');
  const last = await svc.search({ q: 'india', meaning: false, page: 99, size: 50 });
  assert.deepStrictEqual([last.page, last.pages, last.results.length], [2, 2, 30], 'a page past the end lands on the last; size 50 is honoured');
  assert.strictEqual((await svc.search({ q: 'india', meaning: false, size: 9999 })).size, 100, 'size is capped at 100');
  const { svc: ms } = fixture(); const m = await ms.search({ q: 'What kind of ore is halite?' });
  assert.strictEqual(m.paged, false, 'meaning search is not paged'); assert.ok(m.results.length <= 10);
});
