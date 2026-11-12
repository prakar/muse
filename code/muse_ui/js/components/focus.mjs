import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from './button.mjs';
import { W } from '../words.mjs';

// The one Focus button: a target, a link into the Stick page for this fact. Every place that shows a fact uses this, so its look and its tooltip cannot differ.
export const focusHref = (id, from) => build('home', {}, { focus: id, from });
export function FocusButton({ id, from, size = 'sm' }) { return Button({ label: W.focus, emoji: W.focusEmoji, size, title: W.focusTip, href: focusHref(id, from) }); }

// A line of plain help on pages full of facts: what Focus is, and when to use it.
export const FocusHint = () => h('p', { class: 'hint hint--focus' }, h('span', { class: 'btn__emoji', 'aria-hidden': 'true', text: W.focusEmoji }), ' ' + W.focusHint);
