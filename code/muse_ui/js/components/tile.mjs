import { h } from '../dom.mjs';
import { icon } from '../icons.mjs';

// A whole-box link. `selected` is the one you came from; `visited` the ones you have opened before; `kept` shows a star.
export function Tile({ href, title, tilde, subtitle, meta = [], selected, visited, kept }) {
  return h('a', { class: `tile${selected ? ' is-selected' : ''}${visited ? ' is-visited' : ''}`, href, 'aria-current': selected ? 'true' : null },
    h('span', { class: 'tile__title' }, ...(tilde ? [title, h('span', { class: 'tile__tilde', text: '~' }), tilde] : [title])),
    subtitle && h('span', { class: 'tile__meta', text: subtitle }),
    meta.length && h('span', { class: 'tile__meta' }, meta.map(m => h('span', { class: 'badge', text: m }))),
    kept && h('span', { class: 'tile__flags', title: 'In your basket' }, icon('star')));
}
