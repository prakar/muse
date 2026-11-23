'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks'), { fakeModel, fakeNotes } = require('./helpers/muse_fake');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-')), marks = K.open(path.join(dir, 'm.jsonl'), 't');
  const srv = createServer({ model: fakeModel(), marks, notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui') });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = (p, o = {}) => new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: Object.assign({ Host: 'localhost:' + port }, o.headers) }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: () => JSON.parse(b) })); }); req.on('error', reject); req.end(o.body); });
  try { await fn(call, marks); } finally { srv.close(); }
}

test('serves the interface with a strict content policy, and keeps files inside its folder', () => withServer(async call => {
  const home = await call('/'); assert.strictEqual(home.status, 200); assert.match(home.body, /main\.mjs/);
  assert.match(home.headers['content-security-policy'], /script-src|default-src 'self'/); assert.ok(!/unsafe-inline/.test(home.headers['content-security-policy']));
  assert.match((await call('/js/paging.mjs')).headers['content-type'], /text\/javascript/);
  assert.strictEqual((await call('/css/tokens.css')).status, 200);
  for (const [f, type] of [['/favicon.svg', /image\/svg\+xml/], ['/favicon.ico', /image\/x-icon/], ['/apple-touch-icon.png', /image\/png/]]) {
    const r = await call(f); assert.strictEqual(r.status, 200, f); assert.match(r.headers['content-type'], type, f);
  }
  assert.match(home.body, /rel="icon" href="\/favicon\.svg"/);
  for (const p of ['/../lib/muse_server.js', '/%2e%2e/lib/muse_server.js', '/..%2f..%2fcode/lib/muse_server.js', '/js/..%2f..%2f..%2flib/muse_server.js']) {
    const r = await call(p); assert.notStrictEqual(r.status, 200, p); assert.ok(!r.body.includes('createServer'), p + ' must not leak server source');
  }
  assert.strictEqual((await call('/nope.js')).status, 404);
  assert.strictEqual((await call('/', { headers: { Host: 'evil.example' } })).status, 200, 'open by design: any hostname is answered (the closed setting, MUSE_HOST=127.0.0.1, is tested in muse_access.test.js)');
}));

test('pairs are paged, clamped and carry their parts; dull ones drop out', () => withServer(async (call, marks) => {
  let r = (await call('/api/wordplay?kind=anagram-pair&page=2&size=24')).json();
  assert.strictEqual(r.total, 181); assert.strictEqual(r.pages, 8); assert.strictEqual(r.page, 2); assert.strictEqual(r.items.length, 24); assert.ok(r.items[0].a && r.items[0].b && r.items[0].grade);
  assert.strictEqual((await call('/api/wordplay?kind=anagram-pair&page=999&size=24')).json().page, 8);
  assert.strictEqual((await call('/api/wordplay?kind=anagram-pair&size=7')).json().size, 24, 'unknown page sizes fall back');
  assert.strictEqual((await call('/api/wordplay')).json().total, 181 + 108 + 65 + 42);
  const first = r.items[0].id; marks.set(first, null, 'dull');
  assert.strictEqual((await call('/api/wordplay?kind=anagram-pair')).json().total, 180);
  assert.strictEqual((await call('/api/wordplay?kind=anagram-pair&hidden=1')).json().total, 181);
}));

test('marking and the basket: keep a fact, list it with its note, remove it', () => withServer(async (call, marks) => {
  const id = 'wp:one-letter-off:Berlin|Merlin', post = body => call('/api/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual((await post({ handle: id, item: 20, mark: 'use' })).json().marks.use, 1);
  const kept = (await call('/api/kept')).json().items; assert.strictEqual(kept.length, 1); assert.strictEqual(kept[0].noteId, 2); assert.ok(kept[0].claim && kept[0].note);
  assert.strictEqual((await call('/api/connect?id=' + encodeURIComponent(id) + '&n=4')).json().items.find(i => i.id === 20).mark, 'use');
  assert.strictEqual((await post({ handle: id, item: 20, mark: 'clear' })).json().marks.use, 0);
  assert.strictEqual((await post({ handle: 'nope', item: null, mark: 'use' })).status, 400);
  assert.strictEqual((await post({ handle: id, item: 'x', mark: 'use' })).status, 400);
  assert.strictEqual((await call('/api/mark', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415, 'a plain form post from another page is refused');
}));

test('note API serves a note with its passage, and 404s the unknown', () => withServer(async call => {
  const n = (await call('/api/note?id=3&at=30')).json(); assert.strictEqual(n.id, 3); assert.ok(n.quote && n.body.includes('# Note 3'));
  assert.strictEqual((await call('/api/note?title=Linked%20Note')).status, 200);
  assert.strictEqual((await call('/api/note?id=')).status, 404);
}));

test('the UI words come from the active pack, and /api/meta says which pack is active', () => withServer(async call => {
  const m = await call('/js/pack_vocab.mjs');
  assert.strictEqual(m.status, 200); assert.match(m.headers['content-type'], /text\/javascript/);
  assert.match(m.body, /export default \{/); assert.match(m.body, /"purpose"/);
  const meta = JSON.parse((await call('/api/meta')).body);
  assert.strictEqual(meta.pack.name, 'quiz'); assert.strictEqual(meta.pack.lenses, true); assert.ok(meta.pack.capabilities.includes('wordplay'));
}));
