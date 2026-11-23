'use strict';
const test = require('node:test'), assert = require('node:assert'), path = require('node:path'), { pathToFileURL } = require('node:url');
const D = require('./helpers/mini_dom');
const imp = f => import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', f)).href);
const text = n => n.textContent;

const THREADS = [
  { id: 'a', ts: '2026-11-23T11:20:41Z', seeds: [1, 2, 3], cost: 0.0014, label: 'yielded', model: 'm', response: 'Alpha answer.', packet: 'PACKET ONE' },
  { id: 'b', ts: '2026-11-22T09:00:00Z', seeds: [4, 5], cost: 0.02, label: null, model: 'm', response: 'Beta answer.', packet: 'PACKET TWO' }
];

test('Illuminations: the route exists, the page lists every earlier answer with its caution and packet, and the Starred page carries the same two tabs', async () => {
  D.install();
  const R = await imp('router.mjs'), { illuminationsView } = await imp('views/illuminations.mjs'), { basketView } = await imp('views/basket.mjs');
  assert.strictEqual(R.parse('#/illuminations').name, 'illuminations');
  assert.strictEqual(R.build('illuminations'), '#/illuminations');
  const calls = [], api = { dipaka: async all => { calls.push(all); return { threads: THREADS }; }, dipakaLabel: async () => ({}), dipakaDelete: async () => ({}) };
  const { node, title } = await illuminationsView({ api });
  assert.strictEqual(title, 'Illuminations'); assert.deepStrictEqual(calls, [true], 'asks for every answer, not only the latest 20');
  const t = text(node);
  assert.ok(/Alpha answer\./.test(t) && /Beta answer\./.test(t), 'both answers are shown without opening anything');
  assert.strictEqual((t.match(/can produce hallucinations/g) || []).length, 2, 'every answer carries the standing caution');
  assert.ok(/PACKET ONE/.test(t) && /PACKET TWO/.test(t) && /What was sent/.test(t));
  const links = D.all(node, e => e.tag === 'a').map(a => a.attrs.href);
  assert.ok(links.includes('#/basket') && links.includes('#/illuminations') && links.includes('#/dipaka'), 'both tabs and a link to make a new one');
  const empty = await illuminationsView({ api: { ...api, dipaka: async () => ({ threads: [] }) } });
  assert.ok(/Nothing here yet/.test(text(empty.node)));
  const starred = await basketView({ api: { kept: async () => ({ items: [] }) }, nav: {}, actions: {} });
  assert.ok(D.all(starred.node, e => e.tag === 'a').map(a => a.attrs.href).includes('#/illuminations'), 'Starred has the Illuminations tab');
});

test('Illuminations: the server returns every answer only when asked, the latest 20 otherwise', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'code', 'lib', 'muse_server.js'), 'utf8');
  assert.ok(/dipaka\.list\(u\.searchParams\.get\('all'\) \? 1000 : 20\)/.test(src));
});
