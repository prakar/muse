import { NoteLink, ClaimLink } from './notelink.mjs';
import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from './button.mjs';
import { toast } from './toast.mjs';
import { api } from '../api.mjs';
import { FocusButton } from './focus.mjs';
import { W } from '../words.mjs';

// The Collection: the facts you have collected while walking the stick through the vault, with one line between neighbours for how they link.
// Saved automatically to Muse's own small file (muse-tray.json) a moment after every change, and loaded when a Stick page opens, so it survives a refresh,
// a restart and a change of browser or port. Nothing is saved until the saved copy has been read, so an early edit can never wipe it.
const state = { items: [], links: {} }, subs = []; let loaded = false, timer = null, status = '';
const lk = (a, b) => a + '>' + b, emit = () => subs.slice().forEach(f => f());
const save = () => { if (!loaded) return; clearTimeout(timer); status = 'Autosaving\u2026'; emit(); timer = setTimeout(async () => { try { await api.saveTray({ items: state.items, links: state.links }); status = 'Autosaved'; } catch (e) { status = 'Could not save: ' + e.message; } emit(); }, 400); };
export async function loadTray() {
  if (loaded) return; try { const d = await api.tray(); state.items = Array.isArray(d.items) ? d.items : []; state.links = d.links || {}; loaded = true; emit(); } catch (e) { status = 'Saving is unavailable: ' + e.message; emit(); }
}
export const tray = {
  items: () => state.items.slice(), has: id => state.items.some(x => x.id === id),
  toggle(it) { const i = state.items.findIndex(x => x.id === it.id); if (i >= 0) state.items.splice(i, 1); else state.items.push({ id: it.id, noteId: it.noteId == null ? null : it.noteId, note: it.note, claim: it.claim }); emit(); save(); return i < 0; },
  setLink(a, b, t) { state.links[lk(a, b)] = t; save(); }, link: (a, b) => state.links[lk(a, b)] || '',
  clear() { state.items = []; state.links = {}; emit(); save(); },
  text() { return state.items.map((x, i) => `${i + 1}. ${x.claim}  [${x.note}]` + (i < state.items.length - 1 && tray.link(x.id, state.items[i + 1].id) ? `\n   ↳ ${tray.link(x.id, state.items[i + 1].id)}` : '')).join('\n'); },
  count: () => state.items.length, loaded: () => loaded,
  // Several things watch the Collection (the header count, the open panel, every Collect button). Returns a function that stops watching.
  subscribe(f) { subs.push(f); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; }
};

export function Tray() {
  const box = h('section', { class: 'tray', 'aria-label': W.collection });
  const draw = () => {
    const its = tray.items();
    // Autosave redraws this panel on every keystroke; remember which line box you are typing in (and the caret) so the redraw gives it straight back.
    const ae = document.activeElement, keep = ae && box.contains(ae) && ae.classList.contains('tray__link') ? { i: [...box.querySelectorAll('.tray__link')].indexOf(ae), a: ae.selectionStart, z: ae.selectionEnd } : null;
    box.replaceChildren();
    box.append(h('h2', {}, W.collection, h('small', { text: its.length ? String(its.length) : '' }), status ? h('small', { class: 'tray__status', role: 'status', text: ' \u00b7 ' + status }) : null));
    if (!its.length) { box.append(h('p', { class: 'hint', text: 'Nothing yet. Press ' + W.collect + ' on a fact, and it joins your ' + W.collection.toLowerCase() + ' here.' })); return; }
    const ol = h('ol', { class: 'tray__list' });
    its.forEach((x, i) => {
      ol.append(h('li', {}, NoteLink({ text: x.note, noteId: x.noteId, at: x.id }), ClaimLink({ text: x.claim, noteId: x.noteId, at: x.id }),
        h('div', { class: 'fact__actions' }, FocusButton({ id: x.id, from: 'tray' }), Button({ label: 'Remove', size: 'sm', variant: 'ghost', onClick: () => tray.toggle(x) }))));
      if (i < its.length - 1) {
        const inp = h('input', { type: 'text', class: 'tray__link', placeholder: 'How do these two link? (optional)', 'aria-label': 'How these two facts link', value: tray.link(x.id, its[i + 1].id), maxlength: '200' });
        inp.addEventListener('input', () => tray.setLink(x.id, its[i + 1].id, inp.value)); ol.append(h('li', { class: 'tray__gap' }, '↳ ', inp));
      }
    });
    box.append(ol, h('div', { class: 'toolbar' },
      Button({ label: 'Copy cluster', ic: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(tray.text()); toast({ text: `Copied ${its.length} facts.` }); } catch (e) { toast({ text: 'The browser blocked copying.' }); } } }),
      Button({ label: W.illuminate, ic: 'search', href: build('dipaka'), title: 'Send these facts to the model and ask what you did not think to ask. You see the packet and the cost first.' }),
      Button({ label: 'Clear', variant: 'ghost', onClick: () => tray.clear() })));
    if (keep && keep.i >= 0) { const n = box.querySelectorAll('.tray__link')[keep.i]; if (n) { n.focus(); try { n.setSelectionRange(keep.a, keep.z); } catch (e) { /* not selectable */ } } }
  };
  let seen = false; const off = tray.subscribe(() => { if (box.isConnected) { seen = true; draw(); } else if (seen) off(); });
  draw(); loadTray(); return box;
}
export function CollectButton(it, from = 'direct') {
  const b = Button({ label: tray.has(it.id) ? W.collected : W.collect, size: 'sm', pressed: tray.has(it.id), title: 'Add this fact to your ' + W.collection.toLowerCase() });
  const show = on => { b.setAttribute('aria-pressed', String(on)); b.querySelector('span').textContent = on ? W.collected : W.collect; };
  b.addEventListener('click', () => { const on = tray.toggle(it); api.event({ kind: on ? 'pick' : 'unpick', id: it.id, from }); show(on); });
  let seen = false; const off = tray.subscribe(() => { if (b.isConnected) { seen = true; show(tray.has(it.id)); } else if (seen) off(); });   // stays in step when the Collection changes elsewhere; stops watching once its page is gone
  return b;
}
