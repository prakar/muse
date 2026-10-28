import { h } from '../dom.mjs';
import { Button } from './button.mjs';

// One fact (a burr) with everything you can do to it: keep it, read its whole note, mark it dull or the wrong sense, pivot on its other hooks.
// `locked` withholds "Full note" while the handle is hidden, because the note title would give the answer away.
export function Fact({ it, locked, ctx = {}, onMark, onKeep, onNote, hookHref, extra = [] }) {
  const kept = it.mark === 'use', hiddenMark = it.mark === 'dull' || it.mark === 'wrong-sense';
  const star = Button({ ic: 'star', extra: 'btn--star', size: 'sm', pressed: kept, title: kept ? 'Remove from basket' : 'Keep in basket', label: kept ? 'Kept' : 'Keep',
    onClick: () => onKeep(it) });
  const mk = (m, label) => Button({ label, size: 'sm', variant: 'ghost', pressed: it.mark === m, onClick: () => onMark(it, m) });
  return h('li', { class: `fact${kept ? ' is-kept' : ''}${hiddenMark ? ' is-hidden' : ''}`, 'data-burr': it.id },
    h('div', { class: 'fact__top' },
      h('span', { class: 'fact__n', text: String(it.rank) }), it.band ? h('span', { class: `badge badge--${it.band}`, text: it.band }) : null,
      h('span', { class: 'fact__note', text: it.note + (it.side && ctx.sideLabel ? ' · ' + ctx.sideLabel(it.side) : '') })),
    h('p', { class: 'fact__claim', text: it.claim }),
    it.quote ? h('p', { class: 'fact__quote', text: '“' + it.quote + '”' }) : null,
    it.hooks?.length && hookHref ? h('div', { class: 'fact__hooks' }, 'Also about', it.hooks.map(k => h('a', { class: 'chip', href: hookHref(k.id), title: `${k.df} notes`, text: k.label }))) : null,
    h('div', { class: 'fact__actions' }, star, extra,
      Button({ label: 'Full note', ic: 'note', size: 'sm', disabled: locked, title: locked ? 'Available once the handle is revealed' : 'Read the whole note beside this page', onClick: () => onNote(it) }),
      onMark ? [h('span', { class: 'spacer' }), mk('dull', 'Dull'), mk('wrong-sense', 'Wrong sense')] : null));
}
