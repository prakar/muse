import { h } from '../dom.mjs';
import { InfoTip } from './infotip.mjs';

// The "Results" panel, one build for every page that lists facts (Home, Search), so they look and navigate the same:
// a labelled area (the R key jumps to it), a heading with an optional "?" tip, a count, and optional controls on the right.
// The pager is NOT inside it: it sits above/below as its own landmark, so keys treat it as a separate area.
export function ResultsPanel({ count, tip = null, extra = null }, ...body) {
  return h('section', { class: 'panel panel--results', 'aria-label': 'Results', 'data-zone': 'results' },
    h('div', { class: 'panel__head' }, tip ? InfoTip({ text: tip, about: 'About Results' }, h('h2', { text: 'Results' })) : h('h2', { text: 'Results' }), h('small', { text: count }), extra),
    ...body);
}
