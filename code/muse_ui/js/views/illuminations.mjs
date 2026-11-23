import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { W } from '../words.mjs';
import { Answer, usd, LABEL_NAME } from './dipaka.mjs';

// Illuminations: every answer the model has given you, kept in muse-dipaka.jsonl. A reading shelf, not a workbench: the packet and the Illuminate button
// stay on the Dipaka page. The answers are the model's, unverified, and never part of your notes (each one carries the standing caution).
// The same two-tab strip sits on Starred and here, so the two shelves of things you keep are one click apart.
export const SavedTabs = active => h('nav', { class: 'seg', 'aria-label': 'Saved' },
  Button({ label: W.starred, href: build('basket'), current: active === 'basket' }),
  Button({ label: W.illuminations, href: build('illuminations'), current: active === 'illuminations' }));

const FILTERS = [['all', 'All'], ['yielded', LABEL_NAME.yielded], ['unlabelled', 'Not yet labelled']];

export async function illuminationsView({ api }) {
  const info = await api.dipaka(true), threads = info.threads;
  let filter = 'all';
  const list = h('div', { class: 'illuminations' });
  const count = h('small', { text: String(threads.length) });
  const keep = t => filter === 'all' || (filter === 'yielded' ? t.label === 'yielded' : !t.label);
  const draw = () => {
    const rows = threads.filter(keep);
    list.replaceChildren(...(rows.length ? rows.map(t => h('article', { class: 'section illuminations__item' },
      h('h2', {}, new Date(t.ts).toLocaleString(), h('small', { text: t.seeds.length + ' facts · ' + usd(t.cost) + (t.label ? ' · ' + LABEL_NAME[t.label] : '') })),
      Answer(t, api, draw),
      h('details', {}, h('summary', { text: 'What was sent' }), h('pre', { class: 'dipaka__sent', text: t.packet || '' })))) :
      [h('p', { class: 'empty', text: threads.length ? 'None with that label.' : 'Nothing here yet. Gather facts in your ' + W.collection + ' and press ' + W.illuminate + '; each answer is kept here.' })]));
  };
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([k, label]) => {
    const b = Button({ label, size: 'sm', pressed: k === filter, onClick: () => { filter = k; filters.querySelectorAll('button').forEach((x, i) => x.setAttribute('aria-pressed', String(FILTERS[i][0] === k))); draw(); } });
    return b; }));
  draw();
  const node = h('div', {},
    h('div', { class: 'page-head' }, SavedTabs('illuminations'), h('h1', {}, W.illuminations, ' ', count),
      h('p', { text: 'Everything the model has told you about facts you gathered. It is learning material, not from your notes and not checked. New ones are made on the ' + W.dipaka + ' page.' }),
      h('div', { class: 'toolbar' }, filters, Button({ label: W.dipaka, href: build('dipaka'), ic: 'search', size: 'sm' }))),
    list);
  return { node, title: W.illuminations };
}
