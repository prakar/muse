import { h } from './dom.mjs';
import { W, SHELF_NAME } from './words.mjs';

// The keyboard layer. One table drives the handler, the ? overlay and Help, so they cannot disagree.
//
// The page is a small tree, read from its own landmarks (the same structure a screen reader's landmark list shows):
//   page  ->  areas (search, tools, breadcrumb, and each labelled section: Facts, Wordplay, Results, a note panel, ...)  ->  items (a control or a fact card).
// Esc climbs one level (after closing any panel that is open); Enter, or an area's letter, goes down. j and k move along the current level.
// The cursor is REAL focus, so a screen reader follows it; the ring is drawn as well because not every browser shows focus for scripted moves.
// Keys never fire while you type in a box, or with Ctrl/Cmd/Alt held (so the browser's own shortcuts keep working).
export const KEY_GROUPS = [
  { title: 'Levels: page, area, item', keys: [['Esc', 'Close a panel; then up one level'], ['Enter', 'Down a level: into the area, or open the fact'], ['F', 'Facts'], ['W', 'Wordplay'], ['R', 'Results'], ['P', 'Pages']] },
  { title: 'Move', keys: [['h  j  k  l', 'Left, down, up, right: to the nearest item that way (at page level: the nearest area)'], ['n  p', 'Next, previous page']] },
  { title: 'On the fact under the cursor', keys: [['f', W.focus], ['c', W.collect], ['s', W.star], ['o', 'Open the full note']] },
  { title: 'Filter on Home', keys: [['0', SHELF_NAME.all], ['1  2  3', SHELF_NAME.veins + ', ' + SHELF_NAME.grip + ', ' + SHELF_NAME.lone], ['a', 'All kinds']] },
  { title: 'Go', keys: [['/', 'Search'], ['u', 'Back'], ['r', 'A random fact to focus on'], ['g h', 'Home'], ['g f', W.stick], ['g s', W.starred], ['g c', 'The ' + W.collection], ['g a', W.admin], ['g ?', 'Help'], ['?', 'This list']] }
];
const CHORD = { h: 'home', f: 'stick', s: 'basket', a: 'admin', '?': 'help' };

// Pure: what does this key mean right now? `pending` is 'g' after a g was pressed. Returns { act, arg } or { pending } or null.
export function resolve(key, pending) {
  if (pending === 'g') { if (key === 'c') return { act: 'collection' }; return CHORD[key] ? { act: 'go', arg: CHORD[key] } : null; }
  if (key === 'g') return { pending: 'g' };
  const move = { j: 'down', k: 'up', l: 'right', h: 'left' }[key]; if (move) return { act: 'move', arg: move };
  const zone = { F: 'facts', W: 'words', R: 'results', P: 'pages' }[key]; if (zone) return { act: 'zone', arg: zone };
  const one = { f: 'focus', c: 'collect', s: 'star', o: 'note', n: 'next', p: 'prev', u: 'back', r: 'random', '?': 'help', '/': null, a: 'allkinds', 0: 'shelf0', 1: 'shelf1', 2: 'shelf2', 3: 'shelf3' }[key];
  return one ? { act: one } : null;
}

const AREA = '[role="search"], nav[aria-label], section[aria-label], section[aria-labelledby], aside[aria-label]';   // the landmarks
const CARD = '.facts > li, .grid > a.tile, .held, .tray__list > li:not(.tray__gap)';
const CONTROL = 'a[href], button, input:not([type="hidden"]), select';
const AREA_NAME = { facts: 'Facts', words: 'Wordplay', results: 'Results', pages: 'Pagination' };
const SHELF_KEY = { shelf0: SHELF_NAME.all, shelf1: SHELF_NAME.veins, shelf2: SHELF_NAME.grip, shelf3: SHELF_NAME.lone };
const typing = el => !!el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable);
const textOf = e => (e.textContent || '').replace(/\s+/g, ' ').trim();

export function installKeys({ content, go, build, panelOpen = () => false, toggleCollection, random = null }) {
  let level = 'items', areaLabel = '', idx = -1, label = '', pending = null, timer = null, overlay = null, returnTo = null;
  const root = () => content.closest('.shell') || document.body;
  const usable = e => !e.disabled && e.getAttribute('aria-disabled') !== 'true' && !e.closest('[hidden]');

  // ---- the tree, read from the page ----
  const areaName = a => a.getAttribute('aria-label') || (a.getAttribute('aria-labelledby') && document.getElementById(a.getAttribute('aria-labelledby'))?.textContent.trim()) || (a === content ? 'Page' : '');
  const areas = () => {
    const all = [...root().querySelectorAll(AREA)].filter(e => !e.closest('.keys') && !e.closest('[hidden]') && areaName(e) && itemsOf(e).length);   // a landmark with nothing to move to (the lone current crumb) is not a stop
    const top = all.filter(e => !all.some(o => o !== e && o.contains(e)));
    if (!top.some(a => content.contains(a))) top.push(content);                       // a page with no labelled section is one area
    return top.sort((a, b) => (a.compareDocumentPosition(b) & 4 ? -1 : 1));
  };
  const hasCards = a => !!a.querySelector(CARD);
  const defaultArea = () => { const list = areas(); return list.find(a => content.contains(a) && hasCards(a)) || list.find(a => content.contains(a)) || list[0]; };
  const curArea = () => areas().find(a => areaName(a) === areaLabel) || defaultArea();
  const itemsOf = a => a ? (hasCards(a) ? [...a.querySelectorAll(CARD)] : [...a.querySelectorAll(CONTROL)].filter(usable)) : [];
  const isControl = el => !!el && el.matches(CONTROL);

  // ---- showing the cursor: real focus, a ring, and enough scrolling to see it ----
  const clearMarks = () => root().querySelectorAll('.is-cursor, .is-zone').forEach(e => e.classList.remove('is-cursor', 'is-zone'));
  const focusEl = el => { if (!el.matches(CONTROL) && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); };
  const reveal = (el, top = false) => {    // between the sticky header and the bottom edge (scrollIntoView ignores the header)
    const r = el.getBoundingClientRect(), edge = (document.querySelector('.top')?.getBoundingClientRect().bottom || 0) + 10, low = window.innerHeight - 14;
    if (top || r.top < edge || r.height > low - edge) window.scrollBy(0, r.top - edge); else if (r.bottom > low) window.scrollBy(0, r.bottom - low);
  };
  const paintArea = (a, quiet = false) => { clearMarks(); areaLabel = areaName(a); level = 'areas'; idx = -1; label = ''; a.classList.add('is-zone'); focusEl(a); if (!quiet) reveal(a, true); };   // quiet: a redraw after a click puts the mark back without moving the page
  const paintItem = (a, i, quiet = false) => {   // quiet: put the cursor back after a click redraws the page, and never move the page
    const list = itemsOf(a), el = list[i]; clearMarks(); areaLabel = areaName(a); level = 'items'; a.classList.add('is-zone'); if (!el) return focusEl(a);
    idx = i; label = textOf(el); el.classList.add('is-cursor'); focusEl(el); if (quiet) return; if (i === 0 && content.contains(a)) reveal(a, true); else reveal(el);
  };
  const reset = () => { level = 'items'; areaLabel = ''; idx = -1; label = ''; clearMarks(); };
  // After a click redraws the page in place, put the cursor (and focus) back on the same area and control, found again by name.
  const refresh = () => {
    if (level === 'areas') { if (areaLabel) paintArea(curArea(), true); return; }
    if (idx < 0) return;
    const a = curArea(), list = itemsOf(a), at = label ? list.findIndex(e => textOf(e) === label) : -1;
    paintItem(a, at >= 0 ? at : Math.min(idx, list.length - 1), true);
  };

  // ---- moving between and within levels ----
  // Like vi: h left, j down, k up, l right, to the nearest thing that way, judged by where it sits on screen (so rows of chips, grids of tiles and single columns all work).
  const nearest = (cur, list, dir) => {
    const R = e => e.getBoundingClientRect(), c = R(cur), tol = 6, cx = c.left + c.width / 2;
    const rows = list.filter(e => e !== cur).map(e => ({ e, r: R(e) })).filter(o => o.r.width || o.r.height);
    if (dir === 'left' || dir === 'right') {
      const same = rows.filter(({ r }) => Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) > 0.4 * Math.min(r.height, c.height));
      const ahead = same.map(o => ({ ...o, d: (o.r.left + o.r.width / 2) - cx })).filter(o => dir === 'right' ? o.d > tol : o.d < -tol);
      return ahead.length ? ahead.reduce((a, b) => Math.abs(b.d) < Math.abs(a.d) ? b : a).e : null;
    }
    const down = dir === 'down';
    const ahead = rows.map(o => ({ ...o, gap: down ? o.r.top - c.bottom : c.top - o.r.bottom })).filter(o => o.gap >= -tol);
    if (!ahead.length) return null;
    const best = Math.min(...ahead.map(o => o.gap)), band = ahead.filter(o => o.gap <= best + Math.max(8, c.height * 0.6));   // the next row, however it is staggered
    return band.reduce((a, b) => Math.abs(b.r.left + b.r.width / 2 - cx) < Math.abs(a.r.left + a.r.width / 2 - cx) ? b : a).e;
  };
  const move = dir => {
    const first = dir === 'down' || dir === 'right';
    if (level === 'areas') { const list = areas(), cur = curArea(), t = nearest(cur, list, dir); return paintArea(t || cur); }
    const a = curArea(), list = itemsOf(a); if (!list.length) return;
    if (idx < 0 || !list[idx]) return paintItem(a, first ? 0 : list.length - 1);
    const t = nearest(list[idx], list, dir); if (t) paintItem(a, list.indexOf(t));
  };
  const enter = a => { level = 'items'; idx = -1; const list = itemsOf(a); if (list.length) paintItem(a, 0); else paintArea(a); };
  const up = () => paintArea(curArea());
  const current = () => level === 'items' && idx >= 0 ? itemsOf(curArea())[idx] : null;

  // ---- acting on the item under the cursor ----
  const find = (root_, test) => [...root_.querySelectorAll('a,button')].find(e => test(textOf(e)));
  const click = e => { if (e && usable(e)) { e.click(); return true; } return false; };
  const onCard = fn => { const el = current(); if (!el) return move('down'); if (!isControl(el) || el.matches('a.tile')) fn(el); };
  const pageLink = title => content.querySelector(`.pager [aria-label="${title}"]:not(.is-off)`);
  const openNote = el => click(el.querySelector('.fact__note--link') || el.querySelector('.fact__claimlink'));

  // ---- the ? list, as a proper dialog: focus goes in, and comes back out ----
  const closeOverlay = () => { overlay?.remove(); overlay = null; if (returnTo?.isConnected) returnTo.focus({ preventScroll: true }); returnTo = null; };
  const showOverlay = () => {
    if (overlay) return closeOverlay();
    returnTo = document.activeElement;
    const box = h('div', { class: 'keys__box', tabindex: '-1', onclick: e => e.stopPropagation() }, h('h2', { id: 'keys-title', text: 'Keyboard shortcuts' }),
      h('div', { class: 'keys__cols' }, KEY_GROUPS.map(g => h('section', {}, h('h3', { text: g.title }), h('dl', {}, g.keys.map(([k, w]) => [h('dt', {}, k.split('  ').map(x => h('kbd', { text: x }))), h('dd', { text: w })]))))),
      h('p', { class: 'hint', text: 'Keys do nothing while you type in a box. Press ? or Esc to close.' }));
    overlay = h('div', { class: 'keys', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'keys-title', onclick: closeOverlay }, box);
    document.body.append(overlay); box.focus();
  };

  const act = ({ act: a, arg }) => {
    switch (a) {
      case 'move': return move(arg);
      case 'zone': { const t = areas().find(x => areaName(x) === AREA_NAME[arg]); return t && enter(t); }
      case 'focus': return onCard(el => click(find(el, t => t === W.focus || t.endsWith(' ' + W.focus))));
      case 'collect': return onCard(el => click(find(el, t => t === W.collect || t === W.collected)));
      case 'star': return onCard(el => click(find(el, t => t === W.star || t === W.starred)));
      case 'note': return onCard(openNote);
      case 'next': return click(pageLink('Next page'));
      case 'prev': return click(pageLink('Previous page'));
      case 'back': return history.back();
      case 'random': return click(find(document, t => t === 'Surprise me' || t === 'Another fact')) || (random ? random() : go(build('stick')));   // no button on this page: fetch a fact and open it in focus directly, rather than landing on the empty In focus page first
      case 'help': return showOverlay();
      case 'allkinds': return click(find(content, t => t === 'All kinds'));
      case 'collection': return toggleCollection();
      case 'go': return go(build(arg));
      default: if (SHELF_KEY[a]) return click(find(content, t => t.startsWith(SHELF_KEY[a])));
    }
  };

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ae = document.activeElement;
    if (e.key === 'Escape') {
      if (overlay) { closeOverlay(); e.preventDefault(); return; }
      if (panelOpen()) return;                                                             // the note or the Collection closes first, by its own handler
      if (typing(ae)) { const s = ae.closest('[role="search"]'); if (s) { ae.blur(); paintArea(s); e.preventDefault(); } return; }
      if (level === 'items') { up(); e.preventDefault(); }                                 // item -> area -> page: the first Esc lands on the area you were in
      return;
    }
    if (typing(ae)) return;
    if (overlay && e.key !== '?') return;
    if (e.key === 'Enter') {
      if (level === 'areas' && areaLabel) { e.preventDefault(); enter(curArea()); return; }
      const el = current(); if (!el) return;
      if (!isControl(el)) { e.preventDefault(); openNote(el); } else if (ae !== el) { e.preventDefault(); el.click(); }      // a focused link or button handles Enter itself
      return;
    }
    const r = resolve(e.key, pending); clearTimeout(timer);
    if (!r) { pending = null; return; }
    e.preventDefault();
    if (r.pending) { pending = r.pending; timer = setTimeout(() => { pending = null; }, 1200); return; }
    pending = null; act(r);
  });
  return { reset, refresh, showOverlay };
}
