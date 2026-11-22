import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Pager } from '../components/pager.mjs';
import { ResultsPanel } from '../components/results_panel.mjs';
import { NoteLink, ClaimLink } from '../components/notelink.mjs';
import { FocusButton, FocusHint } from '../components/focus.mjs';
import { StarButton } from '../components/star.mjs';
import { CollectButton } from '../components/tray.mjs';
import { Button } from '../components/button.mjs';
import { Glossary } from '../components/glossary.mjs';

// Angles across the whole vault: start from a shape (a word with a story, a first-or-only claim, two facts on one day, a stated cause) instead of from a pile.
// Each card is one finding with its seed (what the answer would be, what joins the facts, what to hide) and the facts themselves, ready to Collect.
export const anglesHref = (hh, page = 1, size = 0) => build('angles', {}, { h: hh || '', page: page > 1 ? page : '', size: size || '' });
export const seedLine = s => s ? 'Seed: answer – ' + s.answer + '; join – ' + s.join + '; hide – ' + s.hide : '';

export async function anglesView({ route, api, nav }) {
  const want = parseInt(route.query.h, 10) || 0, page = parseInt(route.query.page, 10) || 1, size = parseInt(route.query.size, 10) || 0;
  const r = await api.anglesBrowse({ h: want || undefined, page, size });
  const head = h('div', { class: 'page-head' }, h('h1', { text: 'Angles' }),
    h('p', { text: 'Start from a shape instead of a pile. Each card is one place in your notes where a quiz shape shows up; Collect the facts you like and the Collection will keep them together.' }));
  if (!r.counts.length) return { node: h('div', {}, head, h('p', { class: 'empty', text: 'No shapes found in the vault yet.' })), title: 'Angles' };
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Shapes' }, r.counts.map(c =>
    h('a', { class: 'chip' + (c.h === r.h ? ' is-on' : ''), href: anglesHref(c.h), 'aria-current': c.h === r.h ? 'true' : null, title: c.n + ' findings', text: c.name + ' · ' + Number(c.n).toLocaleString('en-US') })));
  const gloss = Glossary({ api }), offset = (r.page - 1) * r.size;
  const factNode = (f, from) => h('li', { class: 'fact', 'data-burr': f.id },
    h('div', { class: 'fact__top' }, NoteLink({ text: f.note || '', noteId: f.noteId, at: f.id })),
    ClaimLink({ text: f.claim, noteId: f.noteId, at: f.id }),
    h('div', { class: 'fact__actions' }, StarButton({ id: f.id, note: f.note, starred: f.starred }, from), CollectButton({ id: f.id, noteId: f.noteId, note: f.note, claim: f.claim }, from), FocusButton({ id: f.id, from })));
  const card = (row, n) => h('li', { class: 'angle' },
    h('div', { class: 'fact__top' }, h('span', { class: 'fact__n', text: String(offset + n + 1) }), (row.half ? h('strong', { text: row.label }) : h('button', { type: 'button', class: 'linkish', title: 'What does this shape mean?', onclick: () => gloss.openAt(row.h) }, row.label)), ' — ' + row.why),
    row.half ? h('p', { class: 'hint', text: 'Not a chain yet. It needs ' + row.next + '. It could become: ' + r.name.replace('A link starts: ', '') + (row.alsoNames.length ? ', ' + row.alsoNames.map(x => x.name).join(', ') : '') + '.' }) : null,
    row.seed && !row.half ? h('p', { class: 'hint', text: seedLine(row.seed) }) : null,
    row.alsoNames.length && !row.half ? h('p', { class: 'hint', text: 'Or maybe: ' + row.alsoNames.map(x => x.name).join('; ') }) : null,
    h('ul', { class: 'facts' }, row.facts.map(f => factNode(f, 'angles'))));
  const pager = label => r.pages > 1 ? Pager({ label, page: r.page, pages: r.pages, total: r.total, size: r.size, hrefFor: p => anglesHref(r.h, p, r.size), onSize: s => nav.go(anglesHref(r.h, 1, s)), onGo: p => nav.go(anglesHref(r.h, p, r.size)) }) : null;
  const node = h('div', {}, head, h('div', { class: 'toolbar' }, Button({ label: 'Glossary', ic: 'note', onClick: () => gloss.openAt(null) })), gloss.node, chips, h('p', { class: 'hint', text: 'Namesake split is not listed here: across the whole vault most are mislabelled kinds. They still show in the Collection when your own facts make one.' }),
    pager('Pagination'), FocusHint(), ResultsPanel({ count: Number(r.total).toLocaleString('en-US') + ' findings' }, h('ol', { class: 'angles' }, r.rows.map(card))), pager('Pagination (bottom)'));
  return { node, title: 'Angles: ' + r.name };
}
