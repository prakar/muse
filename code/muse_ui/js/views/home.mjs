import { tidyQuote } from '../tidy.mjs';
import { can } from '../pack_info.mjs';
import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { kindLabel, kindBlurb } from '../kinds.mjs';
import { typeLabel } from '../kind_labels.mjs';
import { clampPage } from '../paging.mjs';
import { Button } from '../components/button.mjs';
import { ToggleChip } from '../components/chip.mjs';
import { Tile } from '../components/tile.mjs';
import { setView } from './set.mjs';
import { stickView } from './stick.mjs';
import { Pager } from '../components/pager.mjs';
import { ResultsPanel } from '../components/results_panel.mjs';
import { CollectButton } from '../components/tray.mjs';
import { FocusButton, FocusHint } from '../components/focus.mjs';
import { StarButton } from '../components/star.mjs';
import { InfoTip } from '../components/infotip.mjs';
import { visited } from '../visited.mjs';
import { getPref, setPref } from '../prefs.mjs';
import { NoteLink, ClaimLink } from '../components/notelink.mjs';
import { W, SHELF_NAME } from '../words.mjs';

// Home: two blocks that never move, with the results below.
//   Facts     - narrow by how well connected (a shelf: each fact is on exactly one, so these add up) and by what connects (a kind: a fact can have several, so these
//               overlap). Counts on each control already include the other controls.
//   Wordplay  - pairs of names that look or sound alike, by kind of trick.
// Both blocks stay on screen whichever you use; the results below belong to the one you touched last. Everything is in the address, so Back undoes a click.
// Results hold the controls that act on the list itself: how it is ordered (Shuffle by default, a random lens, or one lens), and Starred only.
// Facts keys: shelf type match yours sort dir page seed size. Wordplay keys: wp wpage wsize sel.
const SHELVES = [{ key: 'all', label: SHELF_NAME.all, ic: 'grid', tip: 'Every fact' }, { key: 'veins', label: SHELF_NAME.veins, ic: 'veins', tip: 'Three or more hooks into other notes' },
  { key: 'grip', label: SHELF_NAME.grip, ic: 'grip', tip: 'One or two hooks, a thin flow' }, { key: 'lone', label: SHELF_NAME.lone, ic: 'lone', tip: 'No hooks yet, a trickle: the link may be in your head' }];
const TRICK_ICON = { all: 'grid', 'anagram-pair': 'shuffle', 'one-letter-off': 'differ', 'head-tail': 'drop', homophone: 'sound', 'anagram-of-word': 'toword', 'hidden-word': 'eye', reversal: 'reverse', 'digit-lookalike': 'digits' };
export const FACT_SIZES = [12, 24, 48, 96], PAIR_SIZES = [12, 24, 48, 96], PAIR_SIZE = 24;

// How the facts can be ordered. Shuffle and Surprise are random; the rest are lenses, each with the two directions in plain words (asc is the first, desc the second).
export const SORTS = [
  { key: 'shuffle', name: 'Random order', group: 'Random' }, { key: 'surprise', name: 'Surprise', group: 'Random' },
  { key: 'hooks', name: 'Hooks', asc: 'fewest first', desc: 'most first' }, { key: 'kinds', name: 'Kinds', asc: 'fewest first', desc: 'most first' },
  { key: 'rarest', name: 'Rarest hook', asc: 'scarcest first', desc: 'commonest first' }, { key: 'length', name: 'Claim length', asc: 'shortest first', desc: 'longest first' },
  { key: 'note', name: 'Note A to Z', asc: 'A to Z', desc: 'Z to A' }, { key: 'order', name: 'Extraction order', asc: 'earliest first', desc: 'latest first' },
  { key: 'rank', name: 'Place in note', asc: 'opening facts first', desc: 'later facts first' }, { key: 'notesize', name: 'Note size', asc: 'smallest note first', desc: 'biggest note first' },
  { key: 'date', name: 'Note date', asc: 'oldest first', desc: 'newest first' }];
const SORT_BY = Object.fromEntries(SORTS.map(s => [s.key, s]));
const fresh = () => Math.floor(Math.random() * 1e6) + 2;
const sessionSeed = fresh();     // one random order per visit to Muse (a reload deals a new one); Shuffle deals another
const n = x => Number(x || 0).toLocaleString('en-US');
const parseTypes = s => String(s || '').split(',').filter(Boolean);

export function factsState(q) {
  const type = parseTypes(q.type);
  return { shelf: SHELVES.some(s => s.key === q.shelf) ? q.shelf : 'all', type, match: q.match === 'every' && type.length > 1 ? 'every' : 'any', yours: !!q.yours,
    sort: SORT_BY[q.sort] ? q.sort : 'shuffle', dir: q.dir === 'asc' || q.dir === 'desc' ? q.dir : '',
    page: parseInt(q.page, 10) || 1, seed: parseInt(q.seed, 10) || 0, size: FACT_SIZES.includes(parseInt(q.size, 10)) ? parseInt(q.size, 10) : 12 };
}
const factsQuery = f => ({ shelf: f.shelf && f.shelf !== 'all' ? f.shelf : '', type: (f.type || []).join(','), match: f.match === 'every' && (f.type || []).length > 1 ? 'every' : '', yours: !!f.yours,
  sort: f.sort && f.sort !== 'shuffle' ? f.sort : '', dir: f.dir || '', page: f.page > 1 ? f.page : '', seed: f.seed || '', size: f.size && f.size !== 12 ? f.size : '' });
const pairsQuery = p => ({ wp: p.kind || '', wpage: p.page > 1 ? p.page : '', wsize: p.size && p.size !== PAIR_SIZE ? p.size : '', sel: p.sel || '', pair: p.pair || '' });
// An address for Home: the facts choices, and (when given) a wordplay trick. Without a trick the facts are in charge of the results.
export const factsHref = (f = {}, pairs = null) => build('home', {}, { ...factsQuery({ type: [], ...f }), ...(pairs ? pairsQuery(pairs) : {}) });

function ShelfCard(it) {
  const lone = it.nHooks === 0, from = it.shelf || 'home';
  return h('li', { class: 'fact shelfcard' + (lone ? ' fact--lone' : '') },
    h('div', { class: 'fact__top' }, NoteLink({ text: it.note || '', noteId: it.noteId, at: it.id }), lone ? h('span', { class: 'badge', text: 'no links yet' }) : h('span', { class: 'badge', text: it.nHooks + (it.nHooks === 1 ? ' hook' : ' hooks') })),
    ClaimLink({ text: it.claim, noteId: it.noteId, at: it.id }), it.quote && it.quote !== it.claim ? h('p', { class: 'fact__quote', text: '“' + tidyQuote(it.quote) + '”' }) : null,
    it.hooks.length ? h('div', { class: 'fact__hooks' }, it.hooks.map(k => k.id ? h('a', { class: 'chip', href: build('set', { id: k.id }, { from: 'home' }), title: typeLabel(k.type) + ', in ' + k.df + ' notes. Open the facts about it.', text: k.label }) : h('span', { class: 'chip chip--static', title: typeLabel(k.type) + ', in ' + k.df + ' notes', text: k.label }))) : null,
    h('div', { class: 'fact__actions' }, StarButton(it, from), CollectButton(it, from), FocusButton({ id: it.id, from })));
}
const withCount = (btn, c) => { btn.append(h('span', { class: 'btn__n', text: n(c) })); return btn; };

const FACTS_TIP = 'Every fact from your notes. Narrow by how well connected a fact is (the shelves, which add up) and by what connects it (the kinds, which overlap). How the list is ordered, and Starred only, are in Results.';
const WORDS_TIP = 'Pairs of names that look or sound alike, by kind of trick. Pick a trick to list the pairs; each pair opens to the facts about its two names. Your Facts choices stay where they are; pick a shelf or a kind to go back to facts.';

export async function homeView({ route, api, store, nav, actions }) {
  const q = route.query, focusId = (q.focus || '').trim(), F = factsState(q), kind = q.wp || '', pairsMode = !!kind, meta = store.get().meta, wpKinds = meta.wordplayKinds || [], wpTotal = wpKinds.reduce((s, k) => s + k.n, 0);
  const P = { kind, size: PAIR_SIZES.includes(parseInt(q.wsize, 10)) ? parseInt(q.wsize, 10) : PAIR_SIZE, page: parseInt(q.wpage, 10) || 1, sel: q.sel || '', pair: q.pair || '' };
  const [r, pr] = await Promise.all([
    api.shelf({ name: F.shelf, type: F.type.join(','), match: F.match === 'every' ? 'every' : '', yours: F.yours, sort: F.sort === 'shuffle' ? '' : F.sort, dir: F.dir, page: pairsMode ? 1 : F.page, size: F.size, seed: F.seed || sessionSeed }),
    pairsMode ? api.pairs({ kind, page: clampPage(P.page, 9999), size: P.size }) : null]);
  const fHref = patch => factsHref({ ...F, ...patch });                          // a facts choice: leaves wordplay mode
  const wHref = (k, patch) => factsHref(F, { ...P, kind: k, page: 1, sel: '', pair: '', ...patch });   // a wordplay choice: keeps your facts choices on screen
  const toggleType = t => F.type.includes(t) ? F.type.filter(x => x !== t) : F.type.concat(t);
  const ranked = Object.entries(r.typeCounts).sort((a, b) => b[1] - a[1]); F.type.forEach(t => { if (!ranked.some(([k]) => k === t)) ranked.push([t, 0]); });
  const touched = F.shelf !== 'all' || F.type.length || F.yours, changed = touched || F.sort !== 'shuffle';

  const shelfRow = h('div', { class: 'row' }, h('div', { class: 'seg seg--joined', role: 'group', 'aria-label': 'How well connected' }, SHELVES.map(s => {
    const c = r.shelves[s.key], dead = c === 0 && s.key !== 'all';
    return withCount(Button({ label: s.label, ic: s.ic, size: 'sm', pressed: !pairsMode && s.key === F.shelf, current: pairsMode && s.key === F.shelf, href: fHref({ shelf: s.key, page: 1 }),
      title: dead && F.type.length ? SHELF_NAME.lone + ' have no hooks, so no kind applies to them' : s.tip, extra: (dead ? 'btn--dead' : '') + (s.key === 'all' ? ' btn--nolabel' : '') }), c);
  })));
  // Every kind shows as a chip with its count; the counts say they filter. The group has an accessible name instead of a visible "Connects by" label.
  const kindChip = ([t, c]) => ToggleChip({ label: `${typeLabel(t)} ${n(c)}`, href: fHref({ type: toggleType(t), page: 1 }), on: F.type.includes(t) });
  const kindRow = h('div', { class: 'row row--top' }, h('div', { class: 'chips chips--tight', role: 'group', 'aria-label': 'Connects by' },
    ToggleChip({ label: 'All kinds', href: fHref({ type: [], page: 1 }), on: !F.type.length, all: true }), ranked.map(kindChip)));
  const matchRow = F.type.length > 1 ? h('div', { class: 'row' }, h('span', { class: 'row__label', text: 'Match' }), h('span', { class: 'seg' },
    Button({ label: 'Any chosen', size: 'sm', pressed: F.match === 'any', href: fHref({ match: 'any', page: 1 }) }), Button({ label: 'Every chosen', size: 'sm', pressed: F.match === 'every', href: fHref({ match: 'every', page: 1 }) }))) : null;
  const startOver = changed ? Button({ label: 'Start over', size: 'sm', href: pairsMode ? factsHref({}, P) : factsHref({}) }) : null;
  const factsBlock = h('section', { class: 'panel panel--facts' + (pairsMode ? ' panel--idle' : focusId ? '' : ' panel--on'), 'aria-label': 'Facts', 'data-zone': 'facts' },
    h('div', { class: 'panel__head' }, InfoTip({ text: FACTS_TIP, about: 'About Facts' }, h('h2', { text: 'Facts' })), h('small', { text: `${n(meta.burrs)} in all` }),
      h('span', { class: 'panel__tools' }, startOver, pairsMode || focusId ? null : h('span', { class: 'panel__on', text: 'Showing below' }))), shelfRow, kindRow, matchRow);

  const trickRow = h('div', { class: 'tricks' }, [{ kind: 'all', n: wpTotal }, ...wpKinds].map(k => withCount(Button({ label: kindLabel(k.kind), ic: TRICK_ICON[k.kind] || 'grid', size: 'sm', pressed: pairsMode && k.kind === kind,
    title: kindBlurb(k.kind), href: wHref(k.kind) }), k.n)));
  const wordBlock = h('section', { class: 'panel panel--words' + (pairsMode ? ' panel--on' : focusId ? '' : ' panel--idle'), 'aria-label': 'Wordplay', 'data-zone': 'words' },
    h('div', { class: 'panel__head' }, InfoTip({ text: WORDS_TIP, about: 'About Wordplay' }, h('h2', { text: 'Wordplay' })), h('small', { text: `${n(wpTotal)} pairs of names` }), pairsMode ? h('span', { class: 'panel__tools' }, h('span', { class: 'panel__on', text: 'Showing below' })) : null),
    wpKinds.length ? trickRow : h('p', { class: 'empty', text: meta.wordplayState && /missing/.test(meta.wordplayState) ? 'Wordplay is not built yet. Run: npm run wordplay -- --apply' : 'No wordplay pairs.' }));

  // How the facts are ordered. Shuffle is the default (a fresh random order, facts you have not seen first); Surprise me lets the server pick a lens and says which; the rest are strict lenses.
  const sortControls = () => {
    const cur = r.sort || { key: 'shuffle', dir: null, rolled: false }, lens = SORT_BY[cur.key], rolled = !!cur.rolled;
    const opt = o => h('option', { value: o.key, selected: o.key === F.sort ? '' : null, text: o.name });
    const select = h('select', { class: 'field field--sm', 'aria-label': 'Order the facts by', title: 'How the facts are ordered',
      onchange: e => { const k = e.target.value; nav.go(fHref({ sort: k, dir: '', page: 1, seed: k === 'shuffle' || k === 'surprise' ? fresh() : F.seed })); } },
      h('optgroup', { 'label': 'Random' }, SORTS.filter(o => o.group).map(opt)), h('optgroup', { 'label': 'Order by' }, SORTS.filter(o => !o.group).map(opt)));
    const dirText = cur.dir && lens && lens[cur.dir] ? (cur.dir === 'asc' ? '↑ ' : '↓ ') + lens[cur.dir] : '';
    const dirBtn = dirText ? Button({ label: dirText, size: 'sm', title: 'Reverse the order', onClick: () => nav.go(fHref({ sort: cur.key, dir: cur.dir === 'asc' ? 'desc' : 'asc', page: 1 })) }) : null;
    const lensNote = rolled && lens ? h('span', { class: 'hint', text: 'Lens: ' + lens.name.toLowerCase() }) : null;
    return [select, lensNote, dirBtn,
      F.sort === 'shuffle' ? Button({ label: 'Shuffle', ic: 'shuffle', size: 'sm', title: 'A new random order, facts you have not seen first', onClick: () => nav.go(fHref({ sort: 'shuffle', dir: '', seed: fresh(), page: 1 })) }) : null,
      F.sort === 'surprise' ? Button({ label: 'Re-roll', size: 'sm', title: 'Pick another lens at random', onClick: () => nav.go(fHref({ sort: 'surprise', dir: '', seed: fresh(), page: 1 })) }) : null,
      Button({ label: 'Starred only', ic: 'star', size: 'sm', pressed: F.yours, title: 'Only facts you have starred', href: fHref({ yours: !F.yours, page: 1 }) })];
  };

  let results, pager = null, recentNav = null, headExtra = [], resultsTip = null, skippedNote = null;
  let opened = null, focused = null;      // a pair you opened: its facts show in Results, under the same Facts and Wordplay panels
  if (focusId && !pairsMode) {      // a fact put in focus: what clings to it shows in Results, under the same Facts and Wordplay panels
    focused = await stickView({ route: { ...route, query: { ...route.query, id: focusId } }, api, nav, actions, embedded: true });
    results = focused.node;
  } else if (pairsMode && P.pair) {
    opened = await setView({ route: { ...route, params: { id: P.pair } }, api, nav, actions, embedded: true });
    results = h('div', {}, h('div', { class: 'toolbar' }, Button({ label: 'All ' + (kind === 'all' ? '' : kindLabel(kind).toLowerCase() + ' ') + 'pairs', ic: 'back', size: 'sm', href: wHref(kind, { page: P.page, sel: P.pair }) })), opened.node);
  } else if (pairsMode) {
    const page = pr.page, ph = p => wHref(kind, { page: p });
    results = h('div', {}, h('div', { class: 'toolbar' }, h('span', { class: 'hint', text: kindBlurb(kind) + ' Best first.' })),
      pr.items.length ? h('div', { class: 'grid', role: 'list' }, pr.items.map(i => Tile({ href: wHref(kind, { pair: i.id, sel: i.id, page }),
        title: i.a, tilde: i.b, subtitle: kind === 'all' ? kindLabel(i.wp) : '', meta: [`${i.df} notes`, `grade ${i.grade}`], selected: P.sel === i.id, visited: visited.has(i.id), kept: i.mark === 'use' }))) : h('p', { class: 'empty', text: 'No pairs of this kind.' }),
      null);
    if (!opened) pager = Pager({ page, pages: pr.pages, total: pr.total, size: P.size, hrefFor: ph, onSize: s => nav.go(wHref(kind, { size: s })), onGo: p => nav.go(ph(p)) });
  } else {
    const recent = !touched ? getPref('heldRecent', []).slice(0, 6) : [];
    if (recent.length) {   // one line: the label, the two latest, and "More N" opening a popover over the page (it never pushes the Results down)
      const link = x => h('a', { class: 'chip', href: build('stick', {}, { id: x.id, from: 'home' }), title: x.note || x.claim, text: x.claim.length > 60 ? x.claim.slice(0, 58) + '…' : x.claim });
      const rest = recent.slice(2), pop = rest.length ? h('div', { class: 'recent__pop', id: 'recentPop', hidden: '' }, rest.map(link)) : null;
      const btn = rest.length ? h('button', { type: 'button', class: 'chip chip--more', 'aria-expanded': 'false', 'aria-controls': 'recentPop', title: 'More recently focused facts', text: 'More ' + rest.length,
        onclick: () => { const on = pop.hidden; pop.hidden = !on; btn.setAttribute('aria-expanded', String(on)); },
        onkeydown: e => { if (e.key === 'Escape') { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); } } }) : null;
      if (pop) document.addEventListener('click', e => { if (!pop.hidden && !e.target.closest?.('.recent')) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
      recentNav = h('nav', { class: 'chips chips--also recent', 'aria-label': 'Recently in focus' }, h('span', { class: 'chips__label', text: W.recentFocus }), recent.slice(0, 2).map(link), btn ? h('span', { class: 'recent__more' }, btn, pop) : null);
    }
    resultsTip = W.focusHintShort;
    skippedNote = r.hiddenFragments ? `${n(r.hiddenFragments)} short fragments skipped` : null;
    headExtra = [h('span', { class: 'panel__aside' }, sortControls())];
    results = h('div', {},
      r.items.length ? h('ol', { class: 'facts' }, r.items.map(ShelfCard)) : h('div', { class: 'empty' }, h('p', { text: F.yours && !r.total ? 'Nothing starred matches. Press ' + W.star + ' on a fact, or switch Starred only off.' : 'No facts match all of these.' }),
        touched ? h('p', {}, 'Try ', F.type.length ? h('a', { href: fHref({ type: [], page: 1 }), text: 'All kinds' }) : null, F.type.length && F.shelf !== 'all' ? ' or ' : null, F.shelf !== 'all' ? h('a', { href: fHref({ shelf: 'all', page: 1 }), text: 'All shelves' }) : null, '.') : null),
      null);
    if (r.pages > 1) pager = Pager({ page: r.page, pages: r.pages, total: r.total, size: r.size, hrefFor: p => fHref({ page: p }), onSize: s => nav.go(fHref({ size: s, page: 1 })), onGo: p => nav.go(fHref({ page: p })) });
  }
  const count = focused ? 'in focus' : opened ? (opened.surface || 'A hidden pair') : pairsMode ? `${n(pr.total)} ${pr.total === 1 ? 'pair' : 'pairs'}` : `${n(r.total)} ${r.total === 1 ? 'fact' : 'facts'}`;
  const resultsBox = ResultsPanel({ count: count + (pairsMode && !opened ? ' of wordplay' : '') + (skippedNote ? ' · ' + skippedNote : ''), tip: resultsTip, extra: headExtra }, results);
  const node = h('div', {}, h('h1', { class: 'sr-only', text: W.home }), h('div', { class: 'deck' + (can('wordplay') ? '' : ' deck--solo') }, factsBlock, ...(can('wordplay') ? [wordBlock] : [])), recentNav, resultsBox, pager);
  return { node, title: W.home, announce: count + (changed || pairsMode ? '' : ' in all'), after: ({ keepScroll } = {}) => { if (opened || focused) { const r = resultsBox.getBoundingClientRect(); if (r.top > window.innerHeight - 160) resultsBox.scrollIntoView({ block: 'start' }); }   /* only when Results starts below the fold; never yank the page when you can already see it, so Facts and Wordplay stay put */ else if (!keepScroll) node.querySelector('.is-selected')?.scrollIntoView({ block: 'center' }); } };
}
