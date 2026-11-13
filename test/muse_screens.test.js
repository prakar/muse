'use strict';
// Render Home, Browse and Admin against a stub server and check what the reader would see. Not a browser: it proves the screens build without errors and say the right things.
const test = require('node:test'), assert = require('node:assert'), path = require('node:path'), { pathToFileURL } = require('node:url');
const D = require('./helpers/mini_dom'), UI = path.join(__dirname, '..', 'code', 'muse_ui', 'js'), imp = f => import(pathToFileURL(path.join(UI, f)).href);

const item = (id, o = {}) => ({ id, noteId: id, note: 'Note ' + id, claim: 'A fact numbered ' + id + ' that is long enough to read.', quote: '', loop: null, nHooks: 3, types: ['place'], shelf: 'veins', hooks: [{ label: 'Paris', type: 'place', df: 4 }], ...o });
const stubApi = calls => ({
  shelf: async o => { calls.push(o); const none = o.yours === true; return { name: o.name, total: none ? 0 : 41, page: 1, pages: none ? 1 : 4, size: 12, items: none ? [] : [item(1), item(2, { nHooks: 0, shelf: 'lone', hooks: [] })], hiddenFragments: 0,
    typeCounts: { place: 20, time: 12 }, shelves: { veins: 10, grip: 20, lone: o.type ? 0 : 11, all: o.type ? 30 : 41, loops: 7 } }; },
  searchStatus: async () => ({ meaning: { state: 'ready' } }), stickRandom: async () => ({ burr: { id: 1 } })
});
const store = { get: () => ({ meta: { version: 'nug-v6', notes: 6000, burrs: 55989, wordplay: 10, wordplayState: 'ok', wordplayKinds: [{ kind: 'homophone', n: 42 }] }, marks: { use: 3 } }) };
const text = n => n.textContent.replace(/\s+/g, ' ');

test('screens: Home keeps Facts and Wordplay on screen together, whichever is chosen', async () => {
  D.install(); const { homeView } = await imp('views/home.mjs'), { parse } = await imp('router.mjs'), calls = [];
  const run = async hash => homeView({ route: parse(hash), api: { ...stubApi(calls), pairs: async () => ({ total: 42, page: 1, pages: 2, size: 24, items: [{ id: 'A ~ B', a: 'A', b: 'B', df: 3, grade: 2, wp: 'homophone' }] }) }, store, nav: { go() { } } });
  let { node } = await run('#/'), t = text(node), links = D.all(node, e => e.tag === 'a').map(a => a.attrs.href);
  assert.ok(/Facts/.test(t) && /Wordplay/.test(t) && /Connects by/.test(t) && /Veins/.test(t) && /Rivulets/.test(t));
  assert.ok(links.includes('#/?shelf=veins') && links.includes('#/?type=place') && links.includes('#/?loops=1') && links.includes('#/?yours=1'));
  assert.strictEqual(calls[0].name, 'all');
  assert.deepStrictEqual(D.all(node, e => e.attrs && e.attrs['data-zone']).map(e => e.attrs['data-zone']), ['facts', 'words', 'results'], 'Home has three areas the keyboard can enter');
  assert.ok(/Results/.test(t) && /55,037|41 facts/.test(t), 'the results sit in a container named Results');
  ({ node } = await run('#/?wp=homophone&shelf=veins')); t = text(node);
  assert.ok(/Facts/.test(t) && /Wordplay/.test(t) && /Veins/.test(t) && /42 pairs/.test(t), 'both blocks stay, and the pairs show below');
  assert.ok(D.all(node, e => /panel--idle/.test(e.className || '')).length === 1);
  const setData = { kind: 'wordplay', handle: { surface: 'A ~ B', wordplay: 'homophone', grade: 2 }, shown: 1, total: 1, items: [], hidden: 0, rank: 1, handleMark: null };
  ({ node } = await homeView({ route: parse('#/?wp=homophone&pair=' + encodeURIComponent('A ~ B')), api: { ...stubApi([]), pairs: async () => ({ total: 42, page: 1, pages: 2, size: 24, items: [] }), set: async () => setData }, store, nav: { go() { }, replace() { } }, actions: {} })); t = text(node);
  assert.ok(/Facts/.test(t) && /Wordplay/.test(t) && /Results/.test(t) && /A ~ B/.test(t), 'opening a pair keeps both panels and shows its facts in Results');
  assert.deepStrictEqual(D.all(node, e => e.attrs && e.attrs['data-zone']).map(e => e.attrs['data-zone']), ['facts', 'words', 'results']);
  assert.strictEqual(D.all(node, e => e.tag === 'h1').length, 1, 'one h1 per page');
});

test('screens: Facts offers All shelves and All kinds, toggles kinds in the address, and explains an empty result', async () => {
  D.install(); const { homeView } = await imp('views/home.mjs'), { parse } = await imp('router.mjs'), calls = [];
  const run = async hash => homeView({ route: parse(hash), api: stubApi(calls), store, nav: { go() { } } });
  let { node } = await run('#/?type=place&shelf=veins'), links = D.all(node, e => e.tag === 'a'), byText = s => links.find(a => text(a).startsWith(s));
  assert.deepStrictEqual([byText('All shelves').attrs.href, byText('All kinds').attrs.href], ['#/?type=place', '#/?shelf=veins'], 'each All drops only its own filter');
  assert.strictEqual(byText('Places').attrs['aria-pressed'], 'true'); assert.strictEqual(byText('Years and dates').attrs.href, '#/?shelf=veins&type=place%2Ctime');
  assert.strictEqual(byText('Places').attrs.href, '#/?shelf=veins', 'choosing a chosen kind removes it');
  assert.ok(/Match/.test(text(node)) === false, 'Match appears only with two kinds');
  ({ node } = await run('#/?type=place,time&match=every')); assert.ok(/Match/.test(text(node)) && /Every chosen/.test(text(node)));
  assert.strictEqual(calls[calls.length - 1].match, 'every'); assert.strictEqual(calls[calls.length - 1].type, 'place,time');
  ({ node } = await run('#/?yours=1')); assert.ok(/Nothing starred matches/.test(text(node)));
});

test('screens: Admin shows the status read-only, and In focus with nothing chosen points to Home', async () => {
  D.install(); const { adminView } = await imp('views/admin.mjs'), { stickView } = await imp('views/stick.mjs'), { parse } = await imp('router.mjs');
  const status = { counts: { notes: 6929, version: 'nug-v6', byVersion: [{ version: 'nug-v6', n: 56559 }], pending: 12, dupes: [{ status: 'dup', n: 1604 }], wordplay: [{ kind: 'homophone', n: 42 }] },
    database: { path: 'vault.db', bytes: 177954816, at: '2026-10-28T12:00:00Z', migrations: { n: 14, last: 'M014' }, backups: [{ name: 'vault.db.bak-1', bytes: 22536192, at: '2026-10-22T17:41:00Z' }], backupBytes: 22536192 },
    money: { spent: 7.99, ceiling: 10, lastCall: '2026-10-27T13:53:00Z', lastRun: { kind: 'nuggetize', started_at: '2026-10-27T12:16:00Z', finished_at: null } },
    files: [{ file: 'muse-marks.jsonl', what: 'Your stars.', bytes: 2048, at: '2026-10-30T10:00:00Z' }, { file: 'muse-events.jsonl', what: 'Usage.', bytes: null, at: null }], leftovers: [{ name: 'vault.db-journal.stale-1', bytes: 12824, at: '2026-10-24T12:59:00Z' }],
    server: { version: 'nug-v6', port: 3005, pid: 1, node: 'v24', upSeconds: 4000, search: { meaning: { ready: true } } } };
  const a = await adminView({ api: { ...stubApi([]), adminStatus: async () => status, adminDrift: async () => ({ ok: true, problems: [], warnings: [] }), adminOps: async () => ({ areas: [{ id: 'status', title: 'Status and checks' }, { id: 'ingest', title: 'Bring the vault in' }, { id: 'prep', title: 'Pre-processing' }], pending: 12, backups: ['vault.db.bak-1'], tasks: [
    { id: 'status', area: 'status', title: 'Counts and health', does: 'Counts.', effect: 'read-only', dry: false, params: [] },
    { id: 'index', area: 'ingest', title: 'Index the vault', does: 'Read the vault copy.', effect: 'writes DB', dry: true, backup: true, params: [{ name: 'mode', type: 'enum', values: ['diff', 'full'], default: 'diff', label: 'What to index' }] },
    { id: 'nuggetize', area: 'prep', title: 'Extract facts (paid)', does: 'Send notes.', effect: 'spends money', dry: true, needs: 'count', backup: true, params: [{ name: 'limit', type: 'int', min: 1, max: 5000, default: 20, label: 'How many' }] }] }), adminJobs: async () => ({ jobs: [] }) }, store }), at = text(a.node);
  assert.ok(/Index the vault/.test(at) && /Writes the database/.test(at) && /Spends money/.test(at) && /Check first/.test(at) && !/Do it for real/.test(at) && !/Counts and health/.test(at), 'actions come from the catalogue; the real run waits for a check');
  assert.ok(/Notes ready to process right now: 12/.test(at) && /backs up the database first/.test(at));
  assert.ok(/56,559/.test(at) && /170\.\d MB|169\.\d MB/.test(at) && /\$7\.99/.test(at) && /80%/.test(at) && /missing/.test(at) && /Leftovers/.test(at) && /Run drift check/.test(at) && /Reads only|Writes the database/.test(at) && at.indexOf('Run drift check') < at.indexOf('Counts'), 'actions come before the reports');
  assert.ok(/6,929/.test(at) && /12 waiting/.test(at) && /Nothing has run yet/.test(at) && /Recent jobs/.test(at), 'the status strip and the output panel are on the page');
  const cls = c => D.all(a.node, e => String(e.className || '').split(' ').includes(c)).length;
  assert.strictEqual(cls('statusbar'), 1); assert.strictEqual(cls('admin__output'), 1); assert.strictEqual(cls('col'), 2, 'Every day and Prepare the data; no empty columns');
  const bad = await adminView({ api: { adminStatus: async () => { throw new Error('nope'); } }, store }); assert.ok(/Could not read the status: nope/.test(text(bad.node)));
  const s = await stickView({ route: parse('#/stick'), api: stubApi([]), nav: {}, actions: {} }); assert.ok(/Nothing in focus yet/.test(text(s.node)) && D.all(s.node, e => e.tag === 'a' && e.attrs.href === '#/').length === 1);
});

test('screens: Pagination and Recently in focus are their own landmarks, outside Results', async () => {
  D.install(); const { homeView } = await imp('views/home.mjs'), { parse } = await imp('router.mjs');
  const api = { ...stubApi([]), pairs: async () => ({ total: 0, page: 1, pages: 1, size: 24, items: [] }) };
  const { node } = await homeView({ route: parse('#/'), api, store, nav: { go() {}, openNote() {} }, build: (n, p) => '#/' + n });
  const results = D.all(node, e => e.attrs && e.attrs['aria-label'] === 'Results')[0], pager = D.all(node, e => e.attrs && e.attrs['aria-label'] === 'Pagination')[0];
  assert.ok(results && pager, 'both exist'); assert.strictEqual(D.all(results, e => e === pager).length, 0, 'the pager is not inside Results');
  assert.strictEqual(D.all(results, e => e.className && /\bfacts\b/.test(e.className)).length, 1, 'the cards are inside Results');
});

test('screens: the word chips on a Home fact card are links to that word', async () => {
  D.install(); const { homeView } = await imp('views/home.mjs'), { parse } = await imp('router.mjs');
  const api = { ...stubApi([]) }, base = api.shelf;
  api.shelf = async o => { const r = await base(o); return { ...r, items: r.items.map(i => ({ ...i, hooks: [{ id: 'jammu', label: 'Jammu', type: 'place', df: 5 }] })) }; };
  const { node } = await homeView({ route: parse('#/'), api, store, nav: { go() { } }, actions: {} });
  assert.ok(D.all(node, e => e.tag === 'a' && e.attrs.href === '#/set/jammu?from=home').length >= 1, 'a hook chip links to its set page');
});

test('screens: Admin columns group tasks by purpose, pin the everyday ones first, and never lose a task', async () => {
  D.install(); const { planColumns } = await imp('views/admin_tasks.mjs');
  const cat = { tasks: [{ id: 'index', area: 'ingest' }, { id: 'refresh', area: 'ingest' }, { id: 'backup', area: 'safety' }, { id: 'restore', area: 'safety' }, { id: 'dedupe', area: 'prep' }, { id: 'check', area: 'dev' }, { id: 'mystery', area: 'brand-new' }, { id: 'status', area: 'status' }] };
  const by = Object.fromEntries(planColumns(cat).map(c => [c.id, c.tasks.map(t => t.id)]));
  assert.deepStrictEqual(by, { daily: ['refresh', 'backup', 'index'], prep: ['dedupe'], care: ['restore', 'check'], more: ['mystery'] }, 'status is shown elsewhere; a task from an unknown area still appears, under More');
  assert.deepStrictEqual(planColumns({ tasks: [] }), [], 'no tasks, no columns');
});
