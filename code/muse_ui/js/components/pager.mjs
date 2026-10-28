import { h } from '../dom.mjs';
import { pageStops, rangeOf } from '../paging.mjs';
import { Button } from './button.mjs';

export const PAGE_SIZES = [12, 24, 48, 96];

// Prev / 1 2 3 … 10 … 50 … 100 … 181 / Next, a "go to page" box, and a page-size choice. Page links are real links, so middle-click and Back work.
export function Pager({ page, pages, total, size, hrefFor, onSize, onGo }) {
  const { from, to } = rangeOf(page, size, total);
  const link = (p, label, extra = {}) => h('a', { class: 'pager__page', href: hrefFor(p), 'aria-label': extra.aria || `Page ${p}`, 'aria-current': p === page ? 'page' : null }, label ?? String(p));
  // Step buttons stay in place at the ends (greyed out) so the row never shifts under the pointer: « back 10, ‹ back 1, › on 1, » on 10.
  const FAST = 10, clampTo = p => Math.min(pages, Math.max(1, p));
  const step = (to, glyph, aria) => to === page ? h('span', { class: 'pager__page is-off', 'aria-disabled': 'true', 'aria-label': aria, text: glyph }) : link(to, glyph, { aria });
  const input = h('input', { class: 'field field--num', type: 'number', min: 1, max: pages, inputmode: 'numeric', 'aria-label': 'Go to page', placeholder: '#' });
  const go = e => { e.preventDefault(); const p = parseInt(input.value, 10); if (p >= 1 && p <= pages) onGo(p); };
  return h('nav', { class: 'pager', 'aria-label': 'Pagination' },
    h('div', { class: 'pager__pages' },
      step(clampTo(page - FAST), '«', 'Back 10 pages'), step(clampTo(page - 1), '‹', 'Previous page'),
      pageStops(page, pages).map(s => s === 'gap' ? h('span', { class: 'pager__gap', 'aria-hidden': 'true', text: '…' }) : link(s)),
      step(clampTo(page + 1), '›', 'Next page'), step(clampTo(page + FAST), '»', 'Forward 10 pages')),
    h('div', { class: 'pager__tools' },
      h('span', { text: total ? `${from}–${to} of ${total}` : 'None' }),
      h('form', { onsubmit: go, class: 'pager__tools' }, input, Button({ label: 'Go', size: 'sm' })),
      h('label', { class: 'pager__tools' }, 'Per page',
        h('select', { class: 'field', onchange: e => onSize(parseInt(e.target.value, 10)), 'aria-label': 'Items per page' }, PAGE_SIZES.map(n => h('option', { value: n, selected: n === size ? '' : null, text: String(n) }))))));
}
