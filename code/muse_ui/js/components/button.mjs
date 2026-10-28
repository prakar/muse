import { h } from '../dom.mjs';
import { icon } from '../icons.mjs';

// One button for the whole app. `pressed` makes it a toggle that stays highlighted; `current` marks a selected link-style button.
export function Button({ label, ic, variant = 'default', size, pressed, current, onClick, title, disabled, href, extra }) {
  return h(href ? 'a' : 'button', {
    class: `btn btn--${variant}${size ? ' btn--' + size : ''}${label ? '' : ' btn--icon'}${extra ? ' ' + extra : ''}`,
    ...(href ? { href } : { type: 'button' }), title, 'aria-label': label ? null : title,
    'aria-pressed': pressed === undefined ? null : String(!!pressed), 'aria-current': current ? 'true' : null, disabled, onclick: onClick
  }, ic && icon(ic), label && h('span', { text: label }));
}
export const setPressed = (el, on) => el.setAttribute('aria-pressed', String(!!on));

// A single-choice group of toggle buttons (facts 3/4/6/8/10, order hard/easy/found).
export function Segmented({ label, options, value, onChange }) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(o => Button({ label: o.label, size: 'sm', pressed: o.value === value, onClick: () => onChange(o.value) })));
}
