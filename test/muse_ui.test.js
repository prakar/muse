'use strict';
const test = require('node:test'), assert = require('node:assert'), path = require('path'), { pathToFileURL } = require('url');
const load = f => import(pathToFileURL(path.join(__dirname, '..', 'code', 'muse_ui', 'js', f)).href);

test('pageStops: all pages when few; ends + window + landmarks when many; one-page gaps show the page', async () => {
  const { pageStops, pageCount, clampPage, rangeOf } = await load('paging.mjs');
  assert.deepStrictEqual(pageStops(2, 5), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(pageStops(1, 181), [1, 2, 3, 'gap', 10, 'gap', 25, 'gap', 50, 'gap', 100, 'gap', 181]);
  assert.deepStrictEqual(pageStops(100, 181), [1, 'gap', 10, 'gap', 25, 'gap', 50, 'gap', 98, 99, 100, 101, 102, 'gap', 181]);
  assert.deepStrictEqual(pageStops(8, 12), [1, 'gap', 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(pageStops(50, 181).includes(48) && pageStops(50, 181).includes(52));
  assert.strictEqual(pageCount(181, 24), 8); assert.strictEqual(pageCount(0, 24), 1);
  assert.strictEqual(clampPage('99', 8), 8); assert.strictEqual(clampPage('x', 8), 1); assert.strictEqual(clampPage(-3, 8), 1);
  assert.deepStrictEqual(rangeOf(8, 24, 181), { from: 169, to: 181 }); assert.deepStrictEqual(rangeOf(1, 24, 0), { from: 0, to: 0 });
});

test('router: build and parse round-trip, ids with odd characters, unknown routes fall back home', async () => {
  const { parse, build, sameScreen, withQuery } = await load('router.mjs');
  const id = 'wp:one-letter-off:Berlin|Merlin';
  const h = build('set', { id }, { from: 'anagram-pair', page: 3, r: true, n: '' });
  assert.strictEqual(h, '#/set/wp%3Aone-letter-off%3ABerlin%7CMerlin?from=anagram-pair&page=3&r=1');
  assert.deepStrictEqual(parse(h), { name: 'set', params: { id }, query: { from: 'anagram-pair', page: '3', r: '1' } });
  assert.strictEqual(build('home'), '#/'); assert.strictEqual(parse('').name, 'home'); assert.strictEqual(parse('#/nonsense/x').name, 'home');
  assert.strictEqual(parse('#/set').name, 'home', 'a set route without an id is not valid');
  assert.deepStrictEqual(parse('#/wordplay/head-tail?wpage=2'), { name: 'home', params: {}, query: { wpage: '2', wp: 'head-tail' } });
  const a = parse(h), b = parse(withQuery(a, { note: '12', at: '7' }));
  assert.ok(sameScreen(a, b), 'opening a note keeps the same screen'); assert.ok(!sameScreen(a, parse(withQuery(a, { n: 8 }))));
});

test('breadcrumbs: every level links back to the state you left it in; reveal mode hides the handle', async () => {
  const { trail } = await load('crumbs.mjs'), { parse } = await load('router.mjs');
  const r = parse('#/set/Arabs%20~%20Basra?from=anagram-pair&wpage=3&wsize=48');
  const t = trail(r, { surface: 'Arabs ~ Basra' });
  assert.deepStrictEqual(t.map(x => x.label), ['Home', 'Anagram pairs', 'Arabs ~ Basra']);
  assert.strictEqual(t[0].href, '#/'); assert.strictEqual(t[1].href, '#/?wp=anagram-pair&wpage=3&wsize=48&sel=Arabs+%7E+Basra');
  assert.strictEqual(t[2].href, undefined, 'the current page is not a link');
  const hid = trail(r, { surface: 'Arabs ~ Basra', hidden: true });
  assert.strictEqual(hid[2].label, 'Hidden handle'); assert.ok(!/sel=/.test(hid[1].href));
  assert.deepStrictEqual(trail(parse('#/set/mercury?from=basket'), { surface: 'Mercury' }).map(x => x.label), ['Home', 'Starred', 'Mercury']);
  assert.deepStrictEqual(trail(parse('#/set/mercury'), { surface: 'Mercury' }).map(x => x.label), ['Home', 'Mercury']);
  assert.deepStrictEqual(trail(parse('#/')).map(x => x.label), ['Home']);
});

test('markdown: structure, nesting, safety and quote location', async () => {
  const M = await load('markdown.mjs');
  const md = '---\ntags: x\n---\n# Title\n\nSome **bold** and [[Other Note|alias]] and `code` and [bad](javascript:alert(1)) and https://a.com/x.\n\n- one\n  - nested\n- [x] done\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
  const t = M.parse(md);
  assert.deepStrictEqual(t.map(b => b.t), ['h', 'p', 'ul', 'quote', 'table']);
  const p = t[1].c; assert.ok(p.some(n => n.t === 'strong') && p.some(n => n.t === 'wiki' && n.target === 'Other Note') && p.some(n => n.t === 'code'));
  assert.ok(!JSON.stringify(p).includes('javascript:'), 'unsafe links become plain text');
  assert.strictEqual(M.plain(p).includes('bad'), true);
  assert.strictEqual(t[2].items[0].sub[0].items[0].c[0].v, 'nested'); assert.strictEqual(t[2].items[1].checked, true);
  assert.strictEqual(t[4].rows[0].length, 2);
  const hit = M.locate(t, 'Some bold and alias and code and bad and');
  assert.strictEqual(hit, t[1]); assert.strictEqual(M.locate(t, 'nothing like it appears anywhere here'), null);
  assert.strictEqual(M.locate(t, 'short'), null);
});
