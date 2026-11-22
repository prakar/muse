import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Pager } from '../components/pager.mjs';
import { ResultsPanel } from '../components/results_panel.mjs';
import { NoteLink, ClaimLink } from '../components/notelink.mjs';
import { FocusButton, FocusHint } from '../components/focus.mjs';
import { StarButton } from '../components/star.mjs';
import { CollectButton } from '../components/tray.mjs';
import { Glossary } from '../components/glossary.mjs';

// Angles across the whole vault: start from a shape (a word with a story, a first-or-only claim, two facts on one day, a stated cause) instead of from a pile.
// One line picks the shape (the current one, "More N" for the rest in a popover, and the Glossary); the advice for the shape is said once above the cards, not on each card.
export const anglesHref = (hh, page = 1, size = 0) => build('angles', {}, { h: hh || '', page: page > 1 ? page : '', size: size || '' });
export const seedLine = s => s ? 'What each card suggests: join – ' + s.join + '; hide – ' + s.hide + '.' : '';

export async function anglesView({ route, api, nav }) {
  const want = parseInt(route.query.h, 10) || 0, page = parseInt(route.query.page, 10) || 1, size = parseInt(route.query.size, 10) || 0;
  const r = await api.anglesBrowse({ h: want || undefined, page, size });
  const head = h('div', { class: 'page-head' }, h('h1', { text: 'Angles' }), h('p', { text: 'Start from a shape instead of a pile. Collect the facts that spark something and the Collection keeps them together.' }));
  if (!r.counts.length) return { node: h('div', {}, head, h('p', { class: 'empty', text: 'No shapes found in the vault yet.' })), title: 'Angles' };
  const gloss = Glossary({ api }), offset = (r.page - 1) * r.size;
  const chip = c => h('a', { class: 'chip' + (c.h === r.h ? ' is-on' : ''), href: anglesHref(c.h), 'aria-current': c.h === r.h ? 'true' : null,
    title: c.half ? c.n + ' facts that could start this shape. The advice above the cards says how to build one.' : c.n + ' findings', text: c.name + ' · ' + Number(c.n).toLocaleString('en-US') });
  // As many shapes as fit on the line (about 15rem each, after the label, "More" and Glossary), so "More" sits near the right edge and its popover has room.
  const others = r.counts.filter(c => c.h !== r.h), room = Math.max(1, Math.min(others.length, Math.floor(((window.innerWidth || 1200) - 480) / 250)));
  const now = r.counts.find(c => c.h === r.h), inline = others.slice(0, room - 1), rest = others.slice(room - 1);
  const pop = h('div', { class: 'recent__pop', id: 'anglesPop', hidden: '' }, rest.map(chip), h('p', { class: 'hint', text: 'Namesake split is not listed: across the whole vault most are mislabelled kinds. It still shows in the Collection when your own facts make one.' }));
  const more = h('button', { type: 'button', class: 'chip chip--more', 'aria-expanded': 'false', 'aria-controls': 'anglesPop', title: 'The other shapes', text: 'More ' + rest.length,
    onclick: () => { const on = pop.hidden; pop.hidden = !on; more.setAttribute('aria-expanded', String(on)); if (on) pop.classList.toggle('is-left', more.getBoundingClientRect().left < (window.innerWidth || 1200) / 2); },
    onkeydown: e => { if (e.key === 'Escape') { pop.hidden = true; more.setAttribute('aria-expanded', 'false'); } } });
  document.addEventListener('click', e => { if (!pop.hidden && !e.target.closest?.('.recent')) { pop.hidden = true; more.setAttribute('aria-expanded', 'false'); } });
  const glossBtn = h('button', { type: 'button', class: 'chip chip--more', title: 'What each shape name means, with an example', text: 'Glossary', onclick: () => gloss.openAt(r.h) });
  const wordplay = h('a', { class: 'chip chip--more', href: build('home', {}, { wp: 'all' }), title: 'Anagrams, one-letter-off pairs, hidden words and the rest, across the whole vault (on Home)', text: 'Wordplay pairs' });
  const bar = h('nav', { class: 'chips chips--also recent', 'aria-label': 'Shapes' }, h('span', { class: 'chips__label', text: 'Shape' }), now ? chip(now) : null, inline.map(chip), rest.length ? h('span', { class: 'recent__more' }, more, pop) : null, wordplay, glossBtn);
  const advice = r.intro || seedLine(r.seed);
  const factNode = (f, from) => h('li', { class: 'fact', 'data-burr': f.id },
    h('div', { class: 'fact__top' }, NoteLink({ text: f.note || '', noteId: f.noteId, at: f.id })),
    ClaimLink({ text: f.claim, noteId: f.noteId, at: f.id }),
    h('div', { class: 'fact__actions' }, StarButton({ id: f.id, note: f.note, starred: f.starred }, from), CollectButton({ id: f.id, noteId: f.noteId, note: f.note, claim: f.claim }, from), FocusButton({ id: f.id, from })));
  const card = (row, n) => h('li', { class: 'angle' },
    h('div', { class: 'fact__top' }, h('span', { class: 'fact__n', text: String(offset + n + 1) }), h('strong', { text: row.label }), ' — ' + row.why),
    h('ul', { class: 'facts' }, row.facts.map(f => factNode(f, 'angles'))));
  const pager = label => r.pages > 1 ? Pager({ label, page: r.page, pages: r.pages, total: r.total, size: r.size, hrefFor: p => anglesHref(r.h, p, r.size), onSize: s => nav.go(anglesHref(r.h, 1, s)), onGo: p => nav.go(anglesHref(r.h, p, r.size)) }) : null;
  const node = h('div', {}, head, gloss.node, bar, advice ? h('p', { class: 'hint', text: advice }) : null,
    pager('Pagination'), FocusHint(), ResultsPanel({ count: Number(r.total).toLocaleString('en-US') + ' findings' }, h('ol', { class: 'angles' }, r.rows.map(card))), pager('Pagination (bottom)'));
  return { node, title: 'Angles: ' + r.name };
}
