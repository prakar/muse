import { tidyQuote } from '../tidy.mjs';
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
import { CollectButton } from '../components/tray.mjs';
import { FocusButton, FocusHint } from '../components/focus.mjs';
import { StarButton } from '../components/star.mjs';
import { visited } from '../visited.mjs';
import { getPref } from '../prefs.mjs';
import { NoteLink, ClaimLink } from '../components/notelink.mjs';
import { W, SHELF_NAME } from '../words.mjs';

// Home: two blocks that never move, with the results below.
//   Facts     - narrow by how well connected (a shelf: each fact is on exactly one, so these add up), by what connects (a kind: a fact can have several, so these
//               overlap), and by the Loops and Yours overlays. Counts on each control already include the other controls.
//   Wordplay  - pairs of names that look or sound alike, by kind of trick.
// Both blocks stay on screen whichever you use; the results below belong to the one you touched last. Everything is in the address, so Back undoes a click.
// Facts keys: shelf type match loops yours page seed size. Wordplay keys: wp wpage wsize sel.
const SHELVES = [{ key: 'all', label: SHELF_NAME.all, ic: 'grid', tip: 'Every fact' }, { key: 'veins', label: SHELF_NAME.veins, ic: 'veins', tip: 'Three or more hooks into other notes' },
  { key: 'grip', label: SHELF_NAME.grip, ic: 'grip', tip: 'One or two hooks, a thin flow' }, { key: 'lone', label: SHELF_NAME.lone, ic: 'lone', tip: 'No hooks yet, a trickle: the link may be in your head' }];
const TRICK_ICON = { all: 'grid', 'anagram-pair': 'shuffle', 'one-letter-off': 'differ', 'head-tail': 'drop', homophone: 'sound', 'anagram-of-word': 'toword', 'hidden-word': 'eye', reversal: 'reverse', 'digit-lookalike': 'digits' };
export const FACT_SIZES = [12, 24, 48, 96], PAIR_SIZES = [12, 24, 48, 96], PAIR_SIZE = 24;
const n = x => Number(x || 0).toLocaleString('en-US');
const parseTypes = s => String(s || '').split(',').filter(Boolean);

export function factsState(q) {
  const type = parseTypes(q.type);
  return { shelf: SHELVES.some(s => s.key === q.shelf) ? q.shelf : 'all', type, match: q.match === 'every' && type.length > 1 ? 'every' : 'any', loops: !!q.loops, yours: !!q.yours,
    page: parseInt(q.page, 10) || 1, seed: parseInt(q.seed, 10) || 0, size: FACT_SIZES.includes(parseInt(q.size, 10)) ? parseInt(q.size, 10) : 12 };
}
const factsQuery = f => ({ shelf: f.shelf && f.shelf !== 'all' ? f.shelf : '', type: (f.type || []).join(','), match: f.match === 'every' && (f.type || []).length > 1 ? 'every' : '', loops: !!f.loops, yours: !!f.yours,
  page: f.page > 1 ? f.page : '', seed: f.seed || '', size: f.size && f.size !== 12 ? f.size : '' });
const pairsQuery = p => ({ wp: p.kind || '', wpage: p.page > 1 ? p.page : '', wsize: p.size && p.size !== PAIR_SIZE ? p.size : '', sel: p.sel || '', pair: p.pair || '' });
// An address for Home: the facts choices, and (when given) a wordplay trick. Without a trick the facts are in charge of the results.
export const factsHref = (f = {}, pairs = null) => build('home', {}, { ...factsQuery({ type: [], ...f }), ...(pairs ? pairsQuery(pairs) : {}) });

function ShelfCard(it) {
  const lone = it.nHooks === 0, from = it.shelf || 'home';
  return h('li', { class: 'fact shelfcard' + (lone ? ' fact--lone' : '') },
    h('div', { class: 'fact__top' }, NoteLink({ text: it.note || '', noteId: it.noteId, at: it.id }), lone ? h('span', { class: 'badge', text: 'no links yet' }) : h('span', { class: 'badge', text: it.nHooks + (it.nHooks === 1 ? ' hook' : ' hooks') })),
    ClaimLink({ text: it.claim, noteId: it.noteId, at: it.id }), it.quote && it.quote !== it.claim ? h('p', { class: 'fact__quote', text: '“' + tidyQuote(it.quote) + '”' }) : null,
    it.loop ? h('p', { class: 'fact__loop', text: 'Unanswered: ' + it.loop }) : null,
    it.hooks.length ? h('div', { class: 'fact__hooks' }, it.hooks.map(k => k.id ? h('a', { class: 'chip', href: build('set', { id: k.id }, { from: 'home' }), title: typeLabel(k.type) + ', in ' + k.df + ' notes. Open the facts about it.', text: k.label }) : h('span', { class: 'chip chip--static', title: typeLabel(k.type) + ', in ' + k.df + ' notes', text: k.label }))) : null,
    h('div', { class: 'fact__actions' }, StarButton(it, from), CollectButton(it, from), FocusButton({ id: it.id, from })));
}
const withCount = (btn, c) => { btn.append(h('span', { class: 'btn__n', text: n(c) })); return btn; };

export async function homeView({ route, api, store, nav, actions }) {
  const q = route.query, focusId = (q.focus || '').trim(), F = factsState(q), kind = q.wp || '', pairsMode = !!kind, meta = store.get().meta, wpKinds = meta.wordplayKinds || [], wpTotal = wpKinds.reduce((s, k) => s + k.n, 0);
  const P = { kind, size: PAIR_SIZES.includes(parseInt(q.wsize, 10)) ? parseInt(q.wsize, 10) : PAIR_SIZE, page: parseInt(q.wpage, 10) || 1, sel: q.sel || '', pair: q.pair || '' };
  const [r, pr] = await Promise.all([
    api.shelf({ name: F.shelf, type: F.type.join(','), match: F.match === 'every' ? 'every' : '', loops: F.loops, yours: F.yours, page: pairsMode ? 1 : F.page, size: F.size, seed: F.seed || 1 }),
    pairsMode ? api.pairs({ kind, page: clampPage(P.page, 9999), size: P.size }) : null]);
  const fHref = patch => factsHref({ ...F, ...patch });                          // a facts choice: leaves wordplay mode
  const wHref = (k, patch) => factsHref(F, { ...P, kind: k, page: 1, sel: '', pair: '', ...patch });   // a wordplay choice: keeps your facts choices on screen
  const toggleType = t => F.type.includes(t) ? F.type.filter(x => x !== t) : F.type.concat(t);
  const ranked = Object.entries(r.typeCounts).sort((a, b) => b[1] - a[1]); F.type.forEach(t => { if (!ranked.some(([k]) => k === t)) ranked.push([t, 0]); });
  const touched = F.shelf !== 'all' || F.type.length || F.loops || F.yours;

  const shelfRow = h('div', { class: 'row' }, h('div', { class: 'seg seg--joined', role: 'group', 'aria-label': 'How well connected' }, SHELVES.map(s => {
    const c = r.shelves[s.key], dead = c === 0 && s.key !== 'all';
    return withCount(Button({ label: s.label, ic: s.ic, size: 'sm', pressed: !pairsMode && s.key === F.shelf, current: pairsMode && s.key === F.shelf, href: fHref({ shelf: s.key, page: 1 }),
      title: dead && F.type.length ? SHELF_NAME.lone + ' have no hooks, so no kind applies to them' : s.tip, extra: dead ? 'btn--dead' : '' }), c);
  })));
  const kindRow = h('div', { class: 'row row--top' }, h('span', { class: 'row__label', text: 'Connects by' }), h('div', { class: 'chips chips--tight', role: 'group', 'aria-label': 'What connects them' },
    ToggleChip({ label: 'All kinds', href: fHref({ type: [], page: 1 }), on: !F.type.length, all: true }),
    ranked.map(([t, c]) => ToggleChip({ label: `${typeLabel(t)} ${n(c)}`, href: fHref({ type: toggleType(t), page: 1 }), on: F.type.includes(t) }))));
  const optRow = h('div', { class: 'row row--end' }, h('span', { class: 'row__label', text: 'Overlays' }),
    Button({ label: 'Loops', ic: 'loop', size: 'sm', pressed: F.loops, title: 'Only facts the vault leaves unexplained', href: fHref({ loops: !F.loops, page: 1 }) }),
    Button({ label: 'Yours', ic: 'star', size: 'sm', pressed: F.yours, title: 'Only facts you have starred', href: fHref({ yours: !F.yours, page: 1 }) }),
    F.type.length > 1 ? h('span', { class: 'seg' }, h('span', { class: 'row__label', text: 'Match' }), Button({ label: 'Any chosen', size: 'sm', pressed: F.match === 'any', href: fHref({ match: 'any', page: 1 }) }),
      Button({ label: 'Every chosen', size: 'sm', pressed: F.match === 'every', href: fHref({ match: 'every', page: 1 }) })) : null,
    touched ? Button({ label: 'Start over', size: 'sm', href: pairsMode ? factsHref({}, P) : factsHref({}) }) : null);
  const factsBlock = h('section', { class: 'panel panel--facts' + (pairsMode ? ' panel--idle' : focusId ? '' : ' panel--on'), 'aria-label': 'Facts', 'data-zone': 'facts' },
    h('div', { class: 'panel__head' }, h('h2', { text: 'Facts' }), h('small', { text: `${n(meta.burrs)} in all` }), pairsMode || focusId ? null : h('span', { class: 'panel__on', text: 'Showing below' })), shelfRow, kindRow, optRow);

  const trickRow = h('div', { class: 'tricks' }, [{ kind: 'all', n: wpTotal }, ...wpKinds].map(k => withCount(Button({ label: kindLabel(k.kind), ic: TRICK_ICON[k.kind] || 'grid', size: 'sm', pressed: pairsMode && k.kind === kind,
    title: kindBlurb(k.kind), href: wHref(k.kind) }), k.n)));
  const wordBlock = h('section', { class: 'panel panel--words' + (pairsMode ? ' panel--on' : focusId ? '' : ' panel--idle'), 'aria-label': 'Wordplay', 'data-zone': 'words' },
    h('div', { class: 'panel__head' }, h('h2', { text: 'Wordplay' }), h('small', { text: `${n(wpTotal)} pairs of names` }), pairsMode ? h('span', { class: 'panel__on', text: 'Showing below' }) : null),
    wpKinds.length ? trickRow : h('p', { class: 'empty', text: meta.wordplayState && /missing/.test(meta.wordplayState) ? 'Wordplay is not built yet. Run: npm run wordplay -- --apply' : 'No wordplay pairs.' }),
    h('p', { class: 'panel__hint', text: pairsMode ? 'Each pair opens to the facts about its two names. Pick a shelf or a kind on the left to go back to facts.' : 'Pick a trick to list pairs of names. Your facts choices stay where they are.' }));

  let results, pager = null, recentNav = null, headExtra = [];
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
    const shuffle = r.items.some(i => i.shelf !== 'veins') && !F.yours ? Button({ label: 'Shuffle', size: 'sm', onClick: () => nav.go(fHref({ seed: Math.floor(Math.random() * 1e6) + 2, page: 1 })) }) : null;
    const recent = !touched ? getPref('heldRecent', []).slice(0, 6) : [];
    if (recent.length) recentNav = h('nav', { class: 'chips chips--also', 'aria-label': 'Recently in focus' }, h('span', { class: 'chips__label', text: W.recentFocus }), recent.map(x => h('a', { class: 'chip', href: build('stick', {}, { id: x.id, from: 'home' }), title: x.note || '', text: x.claim.length > 60 ? x.claim.slice(0, 58) + '…' : x.claim })));
    headExtra = [h('span', { class: 'hint panel__tip' }, h('span', { class: 'btn__emoji', 'aria-hidden': 'true', text: W.focusEmoji }), ' ' + W.focusHintShort),
      h('span', { class: 'panel__aside' }, r.hiddenFragments ? h('span', { class: 'hint', text: `${n(r.hiddenFragments)} short fragments skipped` }) : null, shuffle)];
    results = h('div', {},
      r.items.length ? h('ol', { class: 'facts' }, r.items.map(ShelfCard)) : h('div', { class: 'empty' }, h('p', { text: F.yours && !r.total ? 'Nothing starred matches. Press ' + W.star + ' on a fact, or switch Yours off.' : 'No facts match all of these.' }),
        touched ? h('p', {}, 'Try ', F.type.length ? h('a', { href: fHref({ type: [], page: 1 }), text: 'All kinds' }) : null, F.type.length && F.shelf !== 'all' ? ' or ' : null, F.shelf !== 'all' ? h('a', { href: fHref({ shelf: 'all', page: 1 }), text: 'All shelves' }) : null, '.') : null),
      null);
    if (r.pages > 1) pager = Pager({ page: r.page, pages: r.pages, total: r.total, size: r.size, hrefFor: p => fHref({ page: p }), onSize: s => nav.go(fHref({ size: s, page: 1 })), onGo: p => nav.go(fHref({ page: p })) });
  }
  const count = focused ? 'in focus' : opened ? (opened.surface || 'A hidden pair') : pairsMode ? `${n(pr.total)} ${pr.total === 1 ? 'pair' : 'pairs'}` : `${n(r.total)} ${r.total === 1 ? 'fact' : 'facts'}`;
  const resultsBox = h('section', { class: 'panel panel--results', 'aria-label': 'Results', 'data-zone': 'results' }, h('div', { class: 'panel__head' }, h('h2', { text: 'Results' }), h('small', { text: count +  (pairsMode && !opened ? ' of wordplay' : '') }), headExtra), results);
  const node = h('div', {}, h('h1', { class: 'sr-only', text: W.home }), h('div', { class: 'deck' }, factsBlock, wordBlock), recentNav, resultsBox, pager);
  return { node, title: W.home, announce: count + (touched || pairsMode ? '' : ' in all'), after: ({ keepScroll } = {}) => { if (opened || focused) { const r = resultsBox.getBoundingClientRect(); if (r.top > window.innerHeight - 160) resultsBox.scrollIntoView({ block: 'start' }); }   /* only when Results starts below the fold; never yank the page when you can already see it, so Facts and Wordplay stay put */ else if (!keepScroll) node.querySelector('.is-selected')?.scrollIntoView({ block: 'center' }); } };
}
