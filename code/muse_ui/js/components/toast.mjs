import { h } from '../dom.mjs';
import { Button } from './button.mjs';
// Short messages with an optional Undo. One polite live region, so screen readers hear them.
let host;
export function toast({ text, action, ms = 6000 }) {
  host ||= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: 'toast' }, h('span', { text }), action && Button({ label: action.label, size: 'sm', onClick: () => { el.remove(); action.onClick(); } }));
  host.append(el); setTimeout(() => el.remove(), ms);
}
