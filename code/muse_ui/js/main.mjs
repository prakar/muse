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
import { listView } from './views/list.mjs';
import { setView } from './views/set.mjs';
import { basketView } from './views/basket.mjs';

const VIEWS = { home: homeView, wordplay: listView, set: setView, basket: basketView };
const store = createStore({ meta: null, marks: { use: 0, dull: 0, 'wrong-sense': 0 } });
let route = null, seq = 0, screenCtx = {};

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
const drawer = NoteDrawer({ api, host: drawerHost, shell, onClose: () => nav.closeNote(), onOpenNote: nav.openNote,
  onWiki: async title => { try { const n = await api.noteByTitle(title); nav.openNote(n.id); } catch (e) { /* unknown note: nothing to open */ } } });

const basketBtn = Button({ label: 'Basket', ic: 'basket', href: build('basket') });
const badge = h('span', { class: 'badge badge--count', text: '0' }); basketBtn.append(badge);
store.subscribe(s => { badge.textContent = String(s.marks.use); badge.hidden = !s.marks.use; });

async function render(r, { keepScroll = false } = {}) {
  const mine = ++seq;
  if (!keepScroll) mount(content, h('div', { class: 'skeleton' }));
  try {
    const out = await VIEWS[r.name]({ route: r, api, store, nav, actions });
    if (mine !== seq) return;
    const y = window.scrollY, pagerTop = content.querySelector('.pager')?.getBoundingClientRect().top;   // where the pager sits on screen, if there is one
    mount(content, Crumbs(trail(r, { surface: out.surface, hidden: out.hidden })), out.node);
    document.title = `${out.title || 'Muse'} · Muse`;
    // Keep the place: with a pager on both screens, hold the pager itself still under the pointer (pages differ a little in height); otherwise hold the scroll offset.
    const pagerNow = content.querySelector('.pager');
    if (keepScroll) { pagerTop !== undefined && pagerNow ? window.scrollBy(0, pagerNow.getBoundingClientRect().top - pagerTop) : window.scrollTo(0, y); } else { window.scrollTo(0, 0); content.focus({ preventScroll: true }); }
    basketBtn.setAttribute('aria-current', String(r.name === 'basket'));
    out.after?.();
  } catch (e) {
    if (mine !== seq || e.name === 'AbortError') return;
    mount(content, h('div', { class: 'empty empty--error' }, h('p', { text: e.message || 'Something went wrong.' }), Button({ label: 'Try again', onClick: () => render(r) })));
  }
}

function onHash() {
  const prev = route; route = parse(location.hash);
  route.query.note ? drawer.open(route.query.note, route.query.at) : drawer.close();
  // Staying on the same set or the same list (an option, the next page, a page size) keeps your place exactly where you scrolled it, so you can click
  // through the pager without losing it; going anywhere else starts at the top.
  if (!prev || !sameScreen(prev, route)) render(route, { keepScroll: !!prev && prev.name === route.name && JSON.stringify(prev.params) === JSON.stringify(route.params) && (route.name === 'set' || route.name === 'wordplay') });
}

async function boot() {
  const meta = await api.meta();
  store.set({ meta, marks: meta.marks });
  const side = h('nav', { class: 'side', 'aria-label': 'Modes' }, h('div', { class: 'side__brand', text: 'Muse' }),
    h('div', { class: 'side__sub', text: `${meta.version} · ${meta.notes} notes · ${meta.burrs} facts` }),
    meta.modes.map(([key, label, blurb, live]) => live
      ? h('a', { class: 'mode', href: build('home'), 'data-nav': key, 'aria-current': 'true' }, label, h('small', { text: blurb }))
      : h('div', { class: 'mode', 'aria-disabled': 'true' }, label, h('small', { text: 'planned · ' + blurb }))));
  const top = h('header', { class: 'top' }, Search({ api, onPick: it => go(build('set', { id: it.id })) }), basketBtn);
  mount(shell, side, h('div', { class: 'main' }, top, content), drawerHost);
  document.body.append(shell);
  window.addEventListener('hashchange', onHash);
  onHash();
}
boot().catch(e => document.body.append(h('p', { class: 'empty empty--error', text: 'Could not reach the Muse server: ' + e.message })));
