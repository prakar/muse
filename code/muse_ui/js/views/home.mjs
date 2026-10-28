import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { KINDS, kindLabel, kindBlurb } from '../kinds.mjs';
import { Tile } from '../components/tile.mjs';
import { Button } from '../components/button.mjs';
import { visited } from '../visited.mjs';

export async function homeView({ store }) {
  const meta = store.get().meta, kinds = meta.wordplayKinds || [], total = kinds.reduce((s, k) => s + k.n, 0);
  const node = h('div', {},
    h('div', { class: 'page-head' }, h('h1', { text: 'Connect' }),
      h('p', { text: 'Pick a handle (a name, a place, a pair of look-alike words) and see the facts in your vault that share it. Search above, or browse the wordplay kinds below.' })),
    kinds.length ? h('section', { class: 'section' }, h('h2', {}, 'Browse wordplay', h('small', { text: `${total} pairs` })),
      h('div', { class: 'grid' }, [{ kind: 'all', n: total }, ...kinds].map(k => Tile({ href: build('wordplay', { kind: k.kind }), title: kindLabel(k.kind), subtitle: kindBlurb(k.kind), meta: [`${k.n} pairs`] }))))
      : h('p', { class: 'empty', text: meta.wordplayState && /missing/.test(meta.wordplayState) ? 'Wordplay is not built yet. Run: npm run wordplay -- --apply' : 'No wordplay pairs.' }),
    visited.recent().length ? h('section', { class: 'section' }, h('h2', { text: 'Recently opened' }),
      h('div', { class: 'chips' }, visited.recent().map(v => h('a', { class: 'chip', href: build('set', { id: v.id }), text: v.label })))) : null,
    h('section', { class: 'section' }, Button({ label: 'Open your basket', ic: 'basket', href: build('basket') })));
  return { node, title: 'Connect' };
}
export { KINDS };
