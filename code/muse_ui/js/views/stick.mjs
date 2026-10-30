import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { Fact } from '../components/fact.mjs';
import { Tray, PickButton } from '../components/tray.mjs';
import { getPref, setPref } from '../prefs.mjs';

// Stick: hold one fact and see what clings to it. A hook clings when it appears in other notes; hooks are grouped by type, rarest first.
export const TYPE_LABEL = { entity: 'Names and things', place: 'Places', time: 'Years and dates', day: 'Days', number: 'Numbers', material: 'Materials', etymon: 'Word roots', set: 'Sets and groups',
  mechanism: 'Mechanisms', title: 'Titles', 'former-role': 'Former roles', uniqueness: 'Superlatives and firsts', homonym: 'Same word, other sense' };
export const typeLabel = t => TYPE_LABEL[t] || String(t || '').replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
export const stickHref = (id, from) => build('stick', {}, { id, from });
let lastHold = null;      // log a hold once per visit, not on every redraw (Dull and Keep redraw the page)
const farBadge = it => it.far ? h('span', { class: 'badge badge--far', title: 'From a note far from this fact\u2019s subject (tag distance ' + it.dist + ')', text: 'far apart' }) : null;
export const COMMON_MAX = 60;

export async function stickView({ route, api, nav, actions }) {
  const id = (route.query.id || '').trim();
  const surprise = Button({ label: id ? 'Another fact' : 'Surprise me', ic: 'link', onClick: async () => { try { const s = await api.stickRandom(); nav.go(stickHref(s.burr.id)); } catch (e) { nav.refresh(); } } });
  const head = h('div', { class: 'page-head' }, h('h1', { text: 'Stick' }),
    h('p', { text: 'Hold one fact and see what clings to it: the names, places, years and other hooks it shares with facts in other notes, grouped by kind. Find a fact with Search, then press Stick on it.' }));
  if (!id) return shelvesView({ route, api, nav, head, surprise });

  const data = await api.stick(id), b = data.burr;
  rememberHeld(b); if (lastHold !== id + '|' + (route.query.from || '')) { lastHold = id + '|' + (route.query.from || ''); api.event({ kind: 'hold', id: b.id, from: route.query.from || 'direct' }); }
  const held = h('section', { class: 'held', 'aria-label': 'The fact you are holding' },
    h('div', { class: 'fact__top' }, h('span', { class: 'badge badge--basis', text: 'holding' }), h('span', { class: 'fact__note', text: b.note || '' })),
    h('p', { class: 'fact__claim', text: b.claim }), b.quote ? h('p', { class: 'fact__quote', text: '“' + b.quote + '”' }) : null,
    h('div', { class: 'fact__actions' }, Button({ label: 'Full note', ic: 'note', size: 'sm', onClick: () => nav.openNote(b.noteId, b.id) }), surprise));
  const hookNode = hk => {
    const facts = hk.items.map((it, i) => { it.rank = i + 1; let el; const make = () => Fact({ it, locked: false, hookHref: hid => build('set', { id: hid }, { from: '' }),
      onKeep: async () => { it.mark = await actions.toggle(hk.id, it.id, it.mark, 'use', { via: 'stick', note: it.note }); const n = make(); el.replaceWith(n); el = n; n.querySelector('.btn--star').focus(); },
      onMark: (item, m) => actions.hide(hk.id, item.id, item.mark, m, { via: 'stick', note: item.note }), onNote: item => nav.openNote(item.noteId, item.id), ctx: { from: 'cling' }, extra: [farBadge(it), PickButton(it, 'cling')] }); return (el = make()); });
    return h('div', { class: 'hook' },
      h('h3', {}, h('a', { href: build('set', { id: hk.id }, { from: '' }), title: 'Open everything that shares this hook', text: hk.label }), h('small', { text: ` ${hk.df} notes` }), hk.more ? h('small', { text: ` · ${hk.more} more not shown` }) : null),
      h('ol', { class: 'facts' }, facts));
  };
  const groups = data.groups.map(g => h('section', { class: 'section' }, h('h2', {}, typeLabel(g.type), h('small', { text: `${g.hooks.length} ${g.hooks.length === 1 ? 'hook' : 'hooks'}` })), g.hooks.map(hookNode)));
  const none = h('p', { class: 'empty', text: 'Nothing clings to this fact: none of its hooks appears in another note. That is a finding too (it is on its own in the vault), but it is a poor seed for a question.' });
  const common = data.common.length ? h('section', { class: 'section' }, h('h2', {}, 'Too common to cling', h('small', { text: `in more than ${COMMON_MAX} notes` })),
    h('div', { class: 'chips' }, data.common.map(c => h('a', { class: 'chip', href: build('set', { id: c.id }, {}), title: c.df + ' notes', text: c.label })))) : null;
  return { node: h('div', {}, head, held, Tray(), h('p', { class: 'hint', text: data.clings ? `${data.clings} ${data.clings === 1 ? 'hook joins' : 'hooks join'} this fact to other notes.` : '' }), data.clings ? groups : none, common), title: 'Stick' };
}

// ---- shelves
export const SHELVES = [
  { key: 'veins', label: 'Veins', blurb: 'Facts with three or more hooks into other notes: a rich seam to work.' },
  { key: 'grip', label: 'Some grip', blurb: 'One or two hooks. A fresh handful each time you shuffle.' },
  { key: 'lone', label: 'Lone facts', blurb: 'No links in the vault yet. The connection may be in your head.' },
  { key: 'loops', label: 'Loops', blurb: 'Facts the vault itself leaves unexplained: a ready-made why.' },
  { key: 'yours', label: 'Yours', blurb: 'What you kept, and what you held recently.' }
];
export const RECENT_MAX = 12;
export function rememberHeld(b) {
  const list = getPref('heldRecent', []).filter(x => x.id !== b.id); list.unshift({ id: b.id, claim: String(b.claim).slice(0, 140), note: b.note }); setPref('heldRecent', list.slice(0, RECENT_MAX));
}
export const shelfHref = (o = {}) => build('stick', {}, { shelf: o.shelf, type: o.type, page: o.page > 1 ? o.page : '', seed: o.seed });

function ShelfCard(it, lone, shelf) {
  return h('li', { class: 'fact shelfcard' + (lone ? ' fact--lone' : '') },
    h('div', { class: 'fact__top' }, h('span', { class: 'fact__note', text: it.note || '' }), lone ? h('span', { class: 'badge', text: 'no links yet' }) : h('span', { class: 'badge', text: it.nHooks + (it.nHooks === 1 ? ' hook' : ' hooks') })),
    h('p', { class: 'fact__claim', text: it.claim }), it.quote && it.quote !== it.claim ? h('p', { class: 'fact__quote', text: '\u201c' + it.quote + '\u201d' }) : null,
    it.loop ? h('p', { class: 'fact__loop', text: 'Unanswered: ' + it.loop }) : null,
    it.hooks.length ? h('div', { class: 'fact__hooks' }, it.hooks.map(k => h('span', { class: 'chip chip--static', title: typeLabel(k.type) + ', in ' + k.df + ' notes', text: k.label }))) : null,
    h('div', { class: 'fact__actions' }, Button({ label: 'Grab', ic: 'link', size: 'sm', href: stickHref(it.id, shelf) }), PickButton(it, shelf)));
}

async function shelvesView({ route, api, nav, head, surprise }) {
  const q = route.query, shelf = SHELVES.some(s => s.key === q.shelf) ? q.shelf : 'veins', page = parseInt(q.page, 10) || 1, seed = parseInt(q.seed, 10) || 1;
  const meta = SHELVES.find(s => s.key === shelf);
  const first = shelf === 'yours' ? null : await api.shelf({ name: shelf, type: q.type, page, size: 12, seed });
  const counts = first ? first.shelves : (await api.shelf({ name: 'veins', size: 12 })).shelves;
  const tabs = h('div', { class: 'shelves', role: 'tablist', 'aria-label': 'Shelves' }, SHELVES.map(s => h('a', { class: 'shelf', role: 'tab', 'aria-selected': String(s.key === shelf), href: shelfHref({ shelf: s.key }) },
    h('strong', { text: s.label }), counts[s.key] != null ? h('small', { text: counts[s.key].toLocaleString('en-US') }) : null)));
  const intro = h('p', { class: 'shelf__blurb', text: meta.blurb });
  let body;
  if (shelf === 'yours') {
    const kept = (await api.kept()).items.filter(k => k.item != null), recent = getPref('heldRecent', []);
    body = h('div', {}, h('h2', {}, 'Recently held', h('small', { text: String(recent.length) })), recent.length ? h('ol', { class: 'facts' }, recent.map(r => h('li', { class: 'fact' }, h('span', { class: 'fact__note', text: r.note || '' }), h('p', { class: 'fact__claim', text: r.claim }), h('div', { class: 'fact__actions' }, Button({ label: 'Grab', ic: 'link', size: 'sm', href: stickHref(r.id, 'yours') }))))) : h('p', { class: 'empty', text: 'Nothing held yet.' }),
      h('h2', {}, 'Kept', h('small', { text: String(kept.length) })), kept.length ? h('ol', { class: 'facts' }, kept.map(k => h('li', { class: 'fact' }, h('span', { class: 'fact__note', text: k.note || '' }), h('p', { class: 'fact__claim', text: k.claim }), h('div', { class: 'fact__actions' }, Button({ label: 'Grab', ic: 'link', size: 'sm', href: stickHref(k.item, 'yours') }))))) : h('p', { class: 'empty', text: 'Nothing kept yet. Press Keep on a fact in Connect.' }));
  } else {
    const types = Object.entries(first.typeCounts).sort((a, b) => b[1] - a[1]);
    const chips = shelf !== 'lone' && types.length ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Kind of hook' }, [h('a', { class: 'chip', 'aria-current': String(!q.type), href: shelfHref({ shelf, seed }), text: 'All kinds' }),
      ...types.map(([t, n]) => h('a', { class: 'chip', 'aria-current': String(q.type === t), href: shelfHref({ shelf, type: t, seed }), text: `${typeLabel(t)} ${n.toLocaleString('en-US')}` }))]) : null;
    const shuffle = shelf === 'grip' || shelf === 'lone' ? Button({ label: 'Shuffle', onClick: () => nav.go(shelfHref({ shelf, type: q.type, seed: Math.floor(Math.random() * 1e6) + 2 })) }) : null;
    const pager = first.pages > 1 ? h('div', { class: 'toolbar' }, Button({ label: 'Previous', size: 'sm', disabled: first.page <= 1, href: first.page > 1 ? shelfHref({ shelf, type: q.type, seed, page: first.page - 1 }) : undefined }),
      h('span', { text: `Page ${first.page} of ${first.pages.toLocaleString('en-US')}` }), Button({ label: 'Next', size: 'sm', disabled: first.page >= first.pages, href: first.page < first.pages ? shelfHref({ shelf, type: q.type, seed, page: first.page + 1 }) : undefined })) : null;
    body = h('div', {}, chips, h('div', { class: 'toolbar' }, shuffle, h('span', { class: 'hint', text: `${first.total.toLocaleString('en-US')} facts` + (first.hiddenFragments ? ` \u00b7 ${first.hiddenFragments.toLocaleString('en-US')} short fragments left out of the shuffle` : '') })),
      first.items.length ? h('ol', { class: 'facts' }, first.items.map(it => ShelfCard(it, shelf === 'lone', shelf))) : h('p', { class: 'empty', text: 'Nothing on this shelf.' }), pager);
  }
  return { node: h('div', {}, head, h('div', { class: 'toolbar' }, surprise), tabs, intro, Tray(), body), title: 'Stick: ' + meta.label };
}
