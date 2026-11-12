'use strict';
// Collect, Star and Focus on every fact: the handle-less star, the starred flags, the Collection panel's address, and one definition of each button.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), { pathToFileURL } = require('url');
const { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks'), { fakeModel, fakeNotes } = require('./helpers/muse_fake');
const UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js');

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-c-')), marks = K.open(path.join(dir, 'm.jsonl'), 't');
  const search = { status: () => ({ meaning: { ready: false } }), search: async () => ({ q: 'x', mode: 'words', band: null, results: [{ burrId: 10, noteId: 1, claim: 'Fact 10', note: 'N', via: {} }, { burrId: 20, noteId: 2, claim: 'Fact 20', note: 'N', via: {} }], notices: [] }) };
  const srv = createServer({ model: fakeModel(), marks, notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), search });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (p, o = {}) => new Promise((resolve, reject) => { const body = o.body ? JSON.stringify(o.body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: Object.assign({ Host: 'localhost:' + port }, body ? { 'Content-Type': 'application/json' } : {}, o.headers) }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); }); });
    req.on('error', reject); if (body) req.write(body); req.end(); });
  try { await fn(call, marks); } finally { srv.close(); }
}
const star = (call, item, mark = 'use') => call('/api/mark', { method: 'POST', body: { handle: '*', item, mark } });

test('a star on one fact with no handle is saved, listed with its note, and refused for an unknown fact', () => withServer(async (call, marks) => {
  let r = await star(call, 10); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.mark, 'use'); assert.strictEqual(r.json.marks.use, 1);
  const kept = (await call('/api/kept')).json.items; assert.strictEqual(kept.length, 1); assert.strictEqual(kept[0].handle, '*'); assert.strictEqual(kept[0].claim, 'Fact 10'); assert.strictEqual(kept[0].label, null);
  assert.strictEqual((await star(call, 99999)).status, 400); assert.strictEqual((await star(call, null)).status, 400); assert.strictEqual((await star(call, 10, 'dull')).status, 400, 'only star and unstar');
  r = await star(call, 10, 'clear'); assert.strictEqual(r.json.mark, null); assert.strictEqual((await call('/api/kept')).json.items.length, 0);
}));

test('un-starring on its own removes the star everywhere, even one made earlier under a handle', () => withServer(async (call, marks) => {
  await call('/api/mark', { method: 'POST', body: { handle: 'mercury', item: 10, mark: 'use' } }); await star(call, 10);
  assert.strictEqual((await call('/api/kept')).json.items.length, 2);
  const r = await star(call, 10, 'clear'); assert.strictEqual(r.json.mark, null); assert.strictEqual((await call('/api/kept')).json.items.length, 0); assert.strictEqual(marks.counts().use, 0);
  await call('/api/mark', { method: 'POST', body: { handle: 'mercury', item: 20, mark: 'use' } }); assert.strictEqual((await call('/api/kept')).json.items.length, 1, 'another fact is untouched by clearing the first');
}));

test('search results report which facts are starred, wherever the star was made', () => withServer(async call => {
  await call('/api/mark', { method: 'POST', body: { handle: 'mercury', item: 20, mark: 'use' } });
  const r = (await call('/api/search?q=x', { headers: { 'X-Muse': '1' } })).json; assert.deepStrictEqual(r.results.map(x => x.starred), [false, true]);
}));

test('the Collection panel is part of the address but not of the screen, so opening it does not redraw the page beneath', async () => {
  const R = await import(pathToFileURL(path.join(UI, 'router.mjs')).href);
  assert.ok(R.DRAWER_KEYS.includes('pile')); assert.ok(R.sameScreen(R.parse('#/search?q=opiate'), R.parse('#/search?q=opiate&pile=1'))); assert.ok(!R.sameScreen(R.parse('#/search?q=a'), R.parse('#/search?q=b&pile=1')));
});

test('each action has one definition: Focus, Collect and Star are built in one place each, and every fact card offers all three', () => {
  const files = fs.readdirSync(UI, { recursive: true }).filter(f => /\.mjs$/.test(f) && !/help_content|muse_map|words\.mjs$/.test(f)).map(f => [f, fs.readFileSync(path.join(UI, f), 'utf8')]);
  const using = re => files.filter(([, s]) => re.test(s)).map(([f]) => f.replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(using(/label: W\.focus\b/), ['components/focus.mjs'], 'only FocusButton builds the Focus button');
  assert.deepStrictEqual(using(/W\.collected : W\.collect\b/), ['components/tray.mjs'], 'only CollectButton builds Collect');
  const card = f => fs.readFileSync(path.join(UI, f), 'utf8');
  [['components/fact.mjs', ['CollectButton', 'FocusButton']], ['views/search.mjs', ['StarButton', 'CollectButton', 'FocusButton']], ['views/stick.mjs', ['StarButton', 'CollectButton', 'FocusButton']]].forEach(([f, need]) => need.forEach(n => assert.ok(card(f).includes(n + '('), `${f} must offer ${n}`)));
  assert.ok(card('components/fact.mjs').includes('W.starred : W.star'), 'facts under a handle carry the Star button too');
});
