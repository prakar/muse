import { tidyQuote } from '../tidy.mjs';
import { NoteLink, ClaimLink } from './notelink.mjs';
import { h } from '../dom.mjs';
import { Button } from './button.mjs';
import { CollectButton } from './tray.mjs';
import { FocusButton } from './focus.mjs';
import { W } from '../words.mjs';

// One fact (a burr) with everything you can do to it: star it, collect it, focus on it, read its whole note, mark it dull or the wrong sense, pivot on its other hooks.
// `locked` makes the note title plain text while the handle is hidden, because the note title would give the answer away.
export function Fact({ it, locked, ctx = {}, onMark, onKeep, onNote, hookHref, extra = [] }) {
  const kept = it.mark === 'use', hiddenMark = it.mark === 'dull' || it.mark === 'wrong-sense';
  const star = Button({ ic: 'star', extra: 'btn--star', size: 'sm', pressed: kept, title: kept ? 'Remove the star' : 'Star this fact: save it for good', label: kept ? W.starred : W.star,
    onClick: () => onKeep(it) });
  const mk = (m, label) => Button({ label, size: 'sm', variant: 'ghost', pressed: it.mark === m, onClick: () => onMark(it, m) });
  return h('li', { class: `fact${kept ? ' is-kept' : ''}${hiddenMark ? ' is-hidden' : ''}`, 'data-burr': it.id },
    h('div', { class: 'fact__top' },
      h('span', { class: 'fact__n', text: String(it.rank) }), it.band ? h('span', { class: `badge badge--${it.band}`, text: it.band }) : null,
      NoteLink({ text: it.note + (it.side && ctx.sideLabel ? ' · ' + ctx.sideLabel(it.side) : ''), noteId: it.noteId, at: it.id, locked })),
    ClaimLink({ text: it.claim, noteId: it.noteId, at: it.id, locked }),
    it.quote ? h('p', { class: 'fact__quote', text: '“' + tidyQuote(it.quote) + '”' }) : null,
    it.hooks?.length && hookHref ? h('div', { class: 'fact__hooks' }, 'Also about', it.hooks.map(k => h('a', { class: 'chip', href: hookHref(k.id), title: `${k.df} notes`, text: k.label }))) : null,
    h('div', { class: 'fact__actions' }, star, CollectButton(it, ctx.from || 'connect'), extra, locked ? null : FocusButton({ id: it.id, from: ctx.from || 'connect' }),
      onMark ? [h('span', { class: 'spacer' }), mk('dull', 'Dull'), mk('wrong-sense', 'Wrong sense')] : null));
}
