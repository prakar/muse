import { h, mount } from '../dom.mjs';
import { icon } from '../icons.mjs';
import { parse, locate } from '../markdown.mjs';
import { Button } from './button.mjs';
import { Prose } from './prose.mjs';

// The full note beside the page you are working on. It is driven by the address (?note=ID&at=BURR), so it survives reload, Back closes it,
// and following a [[wikilink]] inside it is just another history step.
export function NoteDrawer({ api, host, shell, onClose, onOpenNote, onWiki }) {
  let openedFrom = null, current = null;
  async function open(id, at) {
    const key = id + ':' + at; if (current === key) return; current = key;
    openedFrom ||= document.activeElement;
    shell.dataset.drawer = 'open';
    mount(host, h('div', { class: 'drawer__body' }, h('div', { class: 'skeleton' })));
    let n; try { n = await api.note(id, at); } catch (e) { if (e.name === 'AbortError' || current !== key) return; mount(host, head({ title: 'Note not available' }), h('div', { class: 'drawer__body' }, h('p', { class: 'empty empty--error', text: e.message }))); return; }
    if (current !== key) return;      // closed or moved to another note while this one was loading
    const tree = parse(n.body), hit = n.quote ? locate(tree, n.quote) : null;
    mount(host,
      head(n),
      h('div', { class: 'drawer__meta' }, n.words ? h('span', { text: n.words + ' words' }) : null, n.exists ? null : h('span', { class: 'badge', text: 'file not found, showing the opening paragraph' }),
        hit ? h('span', { class: 'badge', text: 'passage highlighted' }) : n.quote ? h('span', { class: 'badge', text: 'passage not located' }) : null,
        n.obsidian ? h('a', { class: 'chip', href: n.obsidian, text: 'Open in Obsidian' }) : null),
      h('div', { class: 'drawer__body' }, Prose(tree, { hit, onWiki })));
    host.querySelector('[data-hit]')?.scrollIntoView({ block: 'center' });
  }
  const head = n => h('div', { class: 'drawer__head' }, h('h2', { id: 'drawer-title', text: n.title || 'Note' }), Button({ ic: 'x', variant: 'ghost', title: 'Close note (Esc)', onClick: onClose }));
  function close() {
    current = null; delete shell.dataset.drawer; mount(host);
    if (openedFrom?.isConnected) openedFrom.focus({ preventScroll: true }); openedFrom = null;
  }
  host.setAttribute('role', 'complementary'); host.setAttribute('aria-labelledby', 'drawer-title');
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && current && !/^(INPUT|SELECT)$/.test(document.activeElement.tagName)) onClose(); });
  return { open, close };
}
