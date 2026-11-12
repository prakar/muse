import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { Fact } from '../components/fact.mjs';
import { toast } from '../components/toast.mjs';
import { W } from '../words.mjs';

// Everything you starred: single facts (with their notes one click away) and whole sets. A place to browse for what to write next.
export async function basketView({ api, nav, actions }) {
  const { items } = await api.kept();
  const facts = items.filter(i => i.item != null), sets = items.filter(i => i.item == null);
  const factNode = (k, n) => {
    const it = { id: k.item, rank: n + 1, note: k.note, noteId: k.noteId, claim: k.claim, quote: k.quote, mark: 'use' };
    const el = Fact({ it, locked: false, ctx: { from: 'basket' },
      onKeep: async () => { await actions.toggle(k.handle, k.item, 'use', 'use', { via: 'basket' }); el.remove(); nav.refresh();
        toast({ text: 'Star removed.', action: { label: 'Undo', onClick: async () => { await actions.send(k.handle, k.item, 'use', { via: 'basket' }); nav.refresh(); } } }); },
      onNote: () => nav.openNote(k.noteId, k.item),
      extra: k.handle === '*' ? [] : [Button({ label: 'Open set', size: 'sm', ic: 'link', href: build('set', { id: k.handle }, { from: 'basket' }) })] });
    return el;
  };
  const text = () => facts.map((k, i) => `${i + 1}. ${k.claim}  [${k.note}]`).join('\n');
  const node = h('div', {},
    h('div', { class: 'page-head' }, h('h1', { text: W.starred }), h('p', { text: 'What you starred: browse it for ideas, open the whole note behind any fact, or copy the lot.' })),
    items.length ? null : h('p', { class: 'empty', text: 'Nothing starred yet. Press ' + W.star + ' on a fact or a pair.' }),
    facts.length ? h('section', { class: 'section' }, h('h2', {}, 'Facts', h('small', { text: String(facts.length) })),
      h('div', { class: 'toolbar' }, Button({ label: 'Copy all as text', ic: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(text()); toast({ text: `Copied ${facts.length} facts.` }); } catch (e) { toast({ text: 'The browser blocked copying.' }); } } })),
      h('ol', { class: 'facts' }, facts.map(factNode))) : null,
    sets.length ? h('section', { class: 'section' }, h('h2', {}, 'Pairs and handles', h('small', { text: String(sets.length) })),
      h('div', { class: 'chips' }, sets.map(s => h('a', { class: 'chip', href: build('set', { id: s.handle }, { from: 'basket' }), text: s.label })))) : null);
  return { node, title: W.starred };
}
