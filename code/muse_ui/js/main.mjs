// Composition root: builds the shell, wires the router to the views, owns nothing else.
import { h, mount } from './dom.mjs';
import { api } from './api.mjs';
import { createStore } from './store.mjs';
import { parse, build, sameScreen, withQuery } from './router.mjs';
import { trail } from './crumbs.mjs';
import { createActions } from './actions.mjs';
import { Crumbs } from './components/crumbs.mjs';
import { Search } from './components/search.mjs';
import { NoteDrawer } from './components/drawer.mjs';
import { Button } from './components/button.mjs';
import { homeView } from './views/home.mjs';
import { setView } from './views/set.mjs';
import { basketView } from './views/basket.mjs';
import { anglesView } from './views/angles.mjs';
import { stickView, stickHref } from './views/stick.mjs';
import { adminView } from './views/admin.mjs';
import { helpView } from './views/help.mjs';
import { dipakaView } from './views/dipaka.mjs';
import { searchView, searchHref } from './views/search.mjs';
import { getPref } from './prefs.mjs';
import { setPackInfo, hasLenses } from './pack_info.mjs';
import { W } from './words.mjs';
import { tray, loadTray } from './components/tray.mjs';
import { PileDrawer } from './components/pile.mjs';
import { installKeys } from './keys.mjs';
import { labelSections, createAnnouncer, SkipLink } from './a11y.mjs';

const VIEWS = { home: homeView, set: setView, basket: basketView, search: searchView, stick: stickView, admin: adminView, help: helpView, dipaka: dipakaView, angles: anglesView };
const store = createStore({ meta: null, marks: { use: 0, dull: 0, 'wrong-sense': 0 } });
const announcer = createAnnouncer();
let route = null, seq = 0, screenCtx = {}, keys = null;

const go = href => { location.hash = href; };
const replace = href => { history.replaceState(null, '', href); onHash(); };
const nav = {
  go, replace, refresh: () => render(route, { keepScroll: true }),
  openNote: (id, at) => go(withQuery(route, { note: id, at })),
  closeNote: () => go(withQuery(route, { note: '', at: '' }))
};
const actions = createActions({ api, store, refresh: () => nav.refresh() });

const content = h('main', { class: 'content', id: 'content', tabindex: '-1' }), drawerHost = h('aside', { class: 'drawer' });
const shell = h('div', { class: 'shell' });
document.addEventListener('muse:open-note', e => nav.openNote(e.detail.noteId, e.detail.at));
const drawer = NoteDrawer({ api, host: drawerHost, shell, onClose: () => nav.closeNote(), onOpenNote: nav.openNote,
  onWiki: async title => { try { const n = await api.noteByTitle(title); nav.openNote(n.id); } catch (e) { /* unknown note: nothing to open */ } } });

let panel = null;      // which side panel is open: 'note', 'pile' or null
const pile = PileDrawer({ host: drawerHost, shell, onClose: () => go(withQuery(route, { pile: '' })) });
const pileBtn = Button({ label: W.collection, ic: 'layers', size: 'sm', onClick: () => go(withQuery(route, { pile: route.query.pile ? '' : '1' })) });
const pileBadge = h('span', { class: 'badge badge--count', text: '0' }); pileBtn.append(pileBadge);
const showPile = () => { pileBadge.textContent = String(tray.count()); pileBadge.hidden = !tray.count(); pileBtn.setAttribute('aria-pressed', String(!!(route && route.query.pile))); };
tray.subscribe(showPile); showPile();
window.addEventListener('muse:marks', e => store.set({ marks: e.detail }));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && pile.isOpen() && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) go(withQuery(route, { pile: '' })); });
const anglesBtn = Button({ label: 'Angles', ic: 'link', size: 'sm', href: build('angles') });
const adminBtn = Button({ label: W.admin, ic: 'layers', size: 'sm', href: build('admin') });
const basketBtn = Button({ label: W.starred, ic: 'basket', size: 'sm', href: build('basket') });
const badge = h('span', { class: 'badge badge--count', text: '0' }); basketBtn.append(badge);
store.subscribe(s => { badge.textContent = String(s.marks.use); badge.hidden = !s.marks.use; });

async function render(r, { keepScroll = false, holdPager = true } = {}) {
  const mine = ++seq;
  if (!keepScroll) mount(content, h('div', { class: 'skeleton' }));
  try {
    const out = await VIEWS[r.name]({ route: r, api, store, nav, actions });
    if (mine !== seq) return;
    const y = window.scrollY, pagerTop = content.querySelector('.pager')?.getBoundingClientRect().top;   // where the pager sits on screen, if there is one
    mount(content, Crumbs(trail(r, { surface: out.surface, hidden: out.hidden })), out.node);
    document.title = `${out.title || 'Muse'} · Muse`;
    labelSections(content);
    announcer.say(out.announce || (keepScroll ? '' : out.title || ''));
    // Keep the place: with a pager on both screens, hold the pager itself still under the pointer (pages differ a little in height); otherwise hold the scroll offset.
    const pagerNow = content.querySelector('.pager');
    if (keepScroll) { holdPager && pagerTop !== undefined && pagerNow ? window.scrollBy(0, pagerNow.getBoundingClientRect().top - pagerTop) : window.scrollTo(0, y); } else { window.scrollTo(0, 0); content.focus({ preventScroll: true }); }
    basketBtn.setAttribute('aria-current', String(r.name === 'basket')); anglesBtn.setAttribute('aria-current', String(r.name === 'angles')); adminBtn.setAttribute('aria-current', String(r.name === 'admin'));
    if (!keepScroll) keys?.reset(); else keys?.refresh();
    out.after?.({ keepScroll });
  } catch (e) {
    if (mine !== seq || e.name === 'AbortError') return;
    mount(content, h('div', { class: 'empty empty--error' }, h('p', { text: e.message || 'Something went wrong.' }), Button({ label: 'Try again', onClick: () => render(r) })));
  }
}

// On Home, hold the pager still only when the click was in the pager (page or size). A shelf, kind or trick changes how long the results are, so the pager
// moves a long way by itself; chasing it is what threw the page down the list. Then the scroll offset is held instead.
const PAGING = ['page', 'wpage', 'size', 'wsize', 'seed', 'sel'];
const without = q => JSON.stringify(Object.entries(q).filter(([k]) => !PAGING.includes(k)).sort());
const pagingOnly = (a, b) => !!a && !!b && without(a.query) === without(b.query);

function onHash() {
  const prev = route; route = parse(location.hash);
  const want = route.query.note ? 'note' : route.query.pile ? 'pile' : null;      // the note and the Collection share one side column
  if (panel && panel !== want) (panel === 'note' ? drawer : pile).close();
  panel = want; showPile();
  if (want === 'note') drawer.open(route.query.note, route.query.at); else if (want === 'pile') pile.open();
  // Staying on the same set or the same list (an option, the next page, a page size) keeps your place exactly where you scrolled it, so you can click
  // through the pager without losing it; going anywhere else starts at the top.
  if (!prev || !sameScreen(prev, route)) render(route, { keepScroll: !!prev && prev.name === route.name && JSON.stringify(prev.params) === JSON.stringify(route.params) && (route.name === 'set' || route.name === 'home'), holdPager: route.name !== 'home' || pagingOnly(prev, route) });
}

async function boot() {
  await loadTray();
  const meta = await api.meta();
  setPackInfo(meta.pack);
  store.set({ meta, marks: meta.marks });
  const top = h('header', { class: 'top' }, h('a', { class: 'top__brand', href: build('home'), title: meta.version + ' · ' + meta.notes + ' notes · ' + meta.burrs + ' facts', text: 'Muse' }), h('div', { class: 'top__search', role: 'search', 'aria-label': 'Search' }, Search({ api, onPick: it => go(build('set', { id: it.id })), onSubmit: q => go(searchHref(q, getPref('meaning', true))) })), h('nav', { class: 'top__actions', 'aria-label': 'Tools' }, pileBtn, basketBtn, ...(hasLenses() ? [anglesBtn] : []), Button({ label: 'Help', ic: 'note', size: 'sm', href: build('help') }), adminBtn));
  mount(shell, h('div', { class: 'main' }, top, content), drawerHost);
  document.body.prepend(SkipLink(content));
  document.body.append(shell, announcer.node);
  keys = installKeys({ content, go, build, panelOpen: () => !!panel, route: () => route, toggleCollection: () => go(withQuery(route, { pile: route.query.pile ? '' : '1' })), random: async () => { try { const r = await api.stickRandom(); go(stickHref(r.burr.id)); } catch (e) { go(build('stick')); } } });
  window.addEventListener('hashchange', onHash);
  onHash();
}
boot().catch(e => document.body.append(h('p', { class: 'empty empty--error', text: 'Could not reach the Muse server: ' + e.message })));
