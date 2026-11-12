import { tidyQuote } from '../tidy.mjs';
import { NoteLink, ClaimLink } from '../components/notelink.mjs';
import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { Fact } from '../components/fact.mjs';
import { CollectButton } from '../components/tray.mjs';
import { FocusButton, FocusHint } from '../components/focus.mjs';
import { StarButton } from '../components/star.mjs';
import { getPref, setPref } from '../prefs.mjs';
import { W } from '../words.mjs';
import { TYPE_LABEL, typeLabel } from '../kind_labels.mjs';

// Stick: put one fact in focus and see what clings to it. A hook clings when it appears in other notes; hooks are grouped by type, rarest first.
export { TYPE_LABEL, typeLabel };
export const stickHref = (id, from) => build('home', {}, { focus: id, from });   // a fact in focus opens inside Home, under the Facts and Wordplay panels
let lastHold = null;      // log a hold once per visit, not on every redraw (Dull and Star redraw the page)
const farBadge = it => it.far ? h('span', { class: 'badge badge--far', title: 'From a note far from this fact\u2019s subject (tag distance ' + it.dist + ')', text: 'far apart' }) : null;
export const COMMON_MAX = 60;

export async function stickView({ route, api, nav, actions, embedded = false }) {
  const id = (route.query.id || '').trim();
  const surprise = Button({ label: id ? 'Another fact' : 'Surprise me', ic: 'link', onClick: async () => { try { const s = await api.stickRandom(); nav.go(stickHref(s.burr.id)); } catch (e) { nav.refresh(); } } });
  const head = h('div', { class: 'page-head' }, h('h1', { text: W.stick }),
    h('p', { text: 'Put one fact in focus and see what clings to it: the names, places, years and other hooks it shares with facts in other notes, grouped by kind. Find a fact with Search or Browse, then press ' + W.focus + ' on it.' }));
  if (!id) return nothingInFocus({ head, surprise });

  const data = await api.stick(id), b = data.burr;
  rememberHeld(b); if (lastHold !== id + '|' + (route.query.from || '')) { lastHold = id + '|' + (route.query.from || ''); api.event({ kind: 'hold', id: b.id, from: route.query.from || 'direct' }); }
  const held = h('section', { class: 'held', 'aria-label': 'The fact in focus' },
    h('div', { class: 'fact__top' }, h('span', { class: 'badge badge--basis', text: W.inFocus.toLowerCase() }), NoteLink({ text: b.note || '', noteId: b.noteId, at: b.id })),
    ClaimLink({ text: b.claim, noteId: b.noteId, at: b.id }), b.quote ? h('p', { class: 'fact__quote', text: '“' + tidyQuote(b.quote) + '”' }) : null,
    h('div', { class: 'fact__actions' }, StarButton(b, 'stick'), CollectButton(b, 'focus'), surprise));
  const hookNode = hk => {
    const facts = hk.items.map((it, i) => { it.rank = i + 1; let el; const make = () => Fact({ it, locked: false, hookHref: hid => build('set', { id: hid }, { from: '' }),
      onKeep: async () => { it.mark = await actions.toggle(hk.id, it.id, it.mark, 'use', { via: 'stick', note: it.note }); const n = make(); el.replaceWith(n); el = n; n.querySelector('.btn--star').focus(); },
      onMark: (item, m) => actions.hide(hk.id, item.id, item.mark, m, { via: 'stick', note: item.note }), onNote: item => nav.openNote(item.noteId, item.id), ctx: { from: 'cling' }, extra: [farBadge(it)] }); return (el = make()); });
    return h('div', { class: 'hook' },
      h('h3', {}, h('a', { href: build('set', { id: hk.id }, { from: '' }), title: 'Open everything that shares this hook', text: hk.label }), h('small', { text: ` ${hk.df} notes` }), hk.more ? h('small', { text: ` · ${hk.more} more not shown` }) : null),
      h('ol', { class: 'facts' }, facts));
  };
  const groups = data.groups.map(g => h('section', { class: 'section' }, h('h2', {}, typeLabel(g.type), h('small', { text: `${g.hooks.length} ${g.hooks.length === 1 ? 'hook' : 'hooks'}` })), g.hooks.map(hookNode)));
  const none = h('p', { class: 'empty', text: 'Nothing clings to this fact: none of its hooks appears in another note. That is a finding too (it is on its own in the vault), but it is a poor seed for a question.' });
  const common = data.common.length ? h('section', { class: 'section' }, h('h2', {}, 'Too common to cling', h('small', { text: `in more than ${COMMON_MAX} notes` })),
    h('div', { class: 'chips' }, data.common.map(c => h('a', { class: 'chip', href: build('set', { id: c.id }, {}), title: c.df + ' notes', text: c.label })))) : null;
  return { node: h('div', {}, embedded ? null : head, held, h('p', { class: 'hint', text: data.clings ? `${data.clings} ${data.clings === 1 ? 'hook joins' : 'hooks join'} this fact to other notes.` : '' }), data.clings ? groups : none, common), title: W.stick };
}

export const RECENT_MAX = 12;
export function rememberHeld(b) {
  const list = getPref('heldRecent', []).filter(x => x.id !== b.id); list.unshift({ id: b.id, claim: String(b.claim).slice(0, 140), note: b.note, noteId: b.noteId }); setPref('heldRecent', list.slice(0, RECENT_MAX));
}

// Nothing in focus yet: say how to put a fact in focus, and offer the facts you had in focus recently.
function nothingInFocus({ head, surprise }) {
  const recent = getPref('heldRecent', []);
  return { node: h('div', {}, head, h('div', { class: 'toolbar' }, surprise, Button({ label: W.home, ic: 'layers', href: build('home') })), FocusHint(),
    h('h2', {}, W.recentFocus, h('small', { text: String(recent.length) })),
    recent.length ? h('ol', { class: 'facts' }, recent.map(r => h('li', { class: 'fact' }, NoteLink({ text: r.note || '', noteId: r.noteId, at: r.id }), ClaimLink({ text: r.claim, noteId: r.noteId, at: r.id }), h('div', { class: 'fact__actions' }, FocusButton({ id: r.id, from: 'recent' })))))
      : h('p', { class: 'empty', text: 'Nothing in focus yet. Press ' + W.focus + ' on any fact, on Home or in Search, or try Surprise me.' })), title: W.stick };
}
