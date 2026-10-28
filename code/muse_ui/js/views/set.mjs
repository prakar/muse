import { h } from '../dom.mjs';
import { build, withQuery } from '../router.mjs';
import { kindLabel } from '../kinds.mjs';
import { Button, Segmented } from '../components/button.mjs';
import { Fact } from '../components/fact.mjs';
import { toast } from '../components/toast.mjs';
import { visited } from '../visited.mjs';

const ORDERS = [{ value: 'hard', label: 'Hard to easy' }, { value: 'easy', label: 'Easy to hard' }, { value: 'found', label: 'As found' }];
const COUNTS = [3, 4, 6, 8, 10].map(n => ({ value: n, label: String(n) }));
const revealedIds = new Set();      // sets whose hidden handle you chose to show, for this visit
const clamp = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export async function setView({ route, api, nav, actions }) {
  const id = route.params.id, q = route.query;
  const opts = { n: clamp(q.n, 3, 12, 6), o: ['hard', 'easy', 'found'].includes(q.o) ? q.o : 'hard', r: q.r === '1' && !revealedIds.has(id), h: q.h === '1' };
  const data = await api.set(id, opts);
  const blind = !!data.reveal, surface = blind ? null : data.handle.surface;
  if (!blind) visited.add(id, surface, data.kind);
  const set = patch => nav.replace(withQuery(route, patch));
  const info = { via: 'connect' };
  const sideLabel = s => { const [a, b] = (surface || '').split(' ~ '); return s === 'a' ? a : b; };
  const hookHref = hid => build('set', { id: hid }, { from: q.from === 'basket' ? 'basket' : '' });

  const factNode = it => {
    let el;
    const make = () => Fact({ it, locked: blind, ctx: { sideLabel }, hookHref,
      onKeep: async () => { it.mark = await actions.toggle(id, it.id, it.mark, 'use', { ...info, band: it.band, note: it.note }); const n = make(); el.replaceWith(n); el = n; n.querySelector('.btn--star').focus(); },
      onMark: (item, m) => actions.hide(id, item.id, item.mark, m, { ...info, band: item.band, note: item.note }),
      onNote: item => nav.openNote(item.noteId, item.id) });
    return (el = make());
  };

  const head = [h('h1', { text: blind ? 'Handle hidden' : surface })];
  const meta = h('div', { class: 'tile__meta' },
    data.handle?.wordplay ? h('span', { class: 'badge', text: `${kindLabel(data.handle.wordplay)} · grade ${data.handle.grade}` }) : null,
    data.handle?.types ? h('span', { class: 'badge', text: data.handle.types.join(', ') }) : null,
    h('span', { text: `${data.shown} of ${data.total} facts` }));

  const handleMark = data.handleMark, markHandle = async m => { await actions.toggle(id, null, handleMark, m, { ...info, kind: data.kind }); nav.refresh(); };
  const toolbar = h('div', { class: 'toolbar' },
    h('span', { class: 'toolbar__label', text: 'Facts' }), Segmented({ label: 'How many facts', options: COUNTS, value: opts.n, onChange: n => set({ n: n === 6 ? '' : n }) }),
    h('span', { class: 'toolbar__label', text: 'Order' }), Segmented({ label: 'Order', options: ORDERS, value: opts.o, onChange: o => set({ o: o === 'hard' ? '' : o }) }),
    Button({ label: 'Reveal last', ic: blind || q.r === '1' ? 'eye-off' : 'eye', pressed: q.r === '1', title: 'Hide the handle and test whether the set points to it unaided', onClick: () => { revealedIds.delete(id); set({ r: q.r === '1' ? '' : 1 }); } }),
    Button({ label: 'Show dull', pressed: opts.h, title: 'Also show facts you marked dull or wrong sense', onClick: () => set({ h: opts.h ? '' : 1 }) }),
    Button({ label: 'Copy as text', ic: 'copy', onClick: async () => {
      const lines = (blind ? [] : [`Handle: ${surface}${data.leadIn ? ` (${data.leadIn})` : ''}`]).concat(data.items.map(i => `${i.rank}. ${i.claim}  [${i.note}]`));
      try { await navigator.clipboard.writeText(lines.join('\n')); toast({ text: `Copied ${data.items.length} facts.` }); } catch (e) { toast({ text: 'The browser blocked copying.' }); } } }));
  const pairActions = h('div', { class: 'fact__actions' },
    Button({ label: data.kind === 'wordplay' ? 'Keep this pair' : 'Keep this handle', ic: 'star', extra: 'btn--star', pressed: handleMark === 'use', onClick: () => markHandle('use') }),
    h('span', { class: 'spacer' }),
    Button({ label: 'Dull', size: 'sm', variant: 'ghost', pressed: handleMark === 'dull', onClick: () => markHandle('dull') }),
    Button({ label: 'Wrong sense', size: 'sm', variant: 'ghost', pressed: handleMark === 'wrong-sense', onClick: () => markHandle('wrong-sense') }));

  const node = h('div', {}, h('div', { class: 'page-head' }, head, meta),
    data.leadIn ? h('div', { class: 'lead', text: 'Lead-in: ' + data.leadIn }) : null, toolbar, pairActions,
    data.hidden ? h('p', { class: 'hint', text: `${data.hidden} fact${data.hidden > 1 ? 's' : ''} you marked dull or wrong sense ${data.hidden > 1 ? 'are' : 'is'} left out. Use “Show dull” to see ${data.hidden > 1 ? 'them' : 'it'}.` }) : null,
    data.warning ? h('p', { class: 'empty', text: data.warning }) : null,
    h('ol', { class: 'facts' }, data.items.map(factNode)),
    blind ? h('div', {}, Button({ label: 'Show the handle', ic: 'eye', variant: 'primary', onClick: () => { revealedIds.add(id); nav.refresh(); } })) : null);
  return { node, surface, hidden: blind, title: blind ? 'Hidden handle' : surface };
}
