import { h } from '../dom.mjs';

// A filter chip. It is a link (so the choice is in the address) that behaves as a toggle button: it announces pressed or not, and Space works as well as Enter.
export function ToggleChip({ label, href, on, all, title }) {
  return h('a', { class: 'chip' + (all ? ' chip--all' : ''), href, role: 'button', 'aria-pressed': String(!!on), title,
    onkeydown: e => { if (e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } }, text: label });
}
