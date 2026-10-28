import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { kindLabel, kindBlurb } from '../kinds.mjs';
import { clampPage } from '../paging.mjs';
import { Tile } from '../components/tile.mjs';
import { Pager, PAGE_SIZES } from '../components/pager.mjs';
import { visited } from '../visited.mjs';

const DEFAULT_SIZE = 24;

// One kind of wordplay, paged. Tiles link to the set; the one you came back from stays highlighted and scrolled into view.
export async function listView({ route, api, nav }) {
  const kind = route.params.kind, q = route.query;
  const size = PAGE_SIZES.includes(+q.size) ? +q.size : DEFAULT_SIZE;
  const data = await api.pairs({ kind, page: clampPage(q.page, 9999), size });
  const page = data.page, hrefFor = p => build('wordplay', { kind }, { page: p > 1 ? p : '', size: size === DEFAULT_SIZE ? '' : size });
  const tiles = data.items.map(i => Tile({
    href: build('set', { id: i.id }, { from: kind, page: page > 1 ? page : '', size: size === DEFAULT_SIZE ? '' : size }),
    title: i.a, tilde: i.b, subtitle: kind === 'all' ? kindLabel(i.wp) : '', meta: [`${i.df} notes`, `grade ${i.grade}`],
    selected: q.sel === i.id, visited: visited.has(i.id), kept: i.mark === 'use'
  }));
  const node = h('div', {},
    h('div', { class: 'page-head' }, h('h1', { text: kindLabel(kind) }), h('p', { text: kindBlurb(kind) + ` ${data.total} pairs, best first. Open one to see the facts behind it.` })),
    data.items.length ? h('div', { class: 'grid', role: 'list' }, tiles) : h('p', { class: 'empty', text: 'No pairs of this kind.' }),
    Pager({ page, pages: data.pages, total: data.total, size, hrefFor, onSize: s => nav.go(build('wordplay', { kind }, { size: s === DEFAULT_SIZE ? '' : s })), onGo: p => nav.go(hrefFor(p)) }));
  return { node, title: kindLabel(kind), after: () => node.querySelector('.is-selected')?.scrollIntoView({ block: 'center' }) };
}
