import { h } from '../dom.mjs';

// A heading with a small "?" after it. The explanation shows on hover, on keyboard focus and on tap (a second tap, Esc or a tap elsewhere closes it).
// It is real text in the page (the button points to it with aria-describedby), so screen readers get it too and nothing is hidden behind hover alone.
let count = 0;
const closeAll = except => document.querySelectorAll('.infotip.is-open').forEach(el => { if (el !== except) { el.classList.remove('is-open'); el.querySelector('.infotip__btn')?.setAttribute('aria-expanded', 'false'); } });
let wired = false;
const wire = () => { if (wired) return; wired = true; document.addEventListener('click', e => closeAll(e.target.closest?.('.infotip'))); };

export function InfoTip({ text, about = 'More about this' }, heading) {
  wire();
  const id = 'infotip' + (++count);
  const wrap = h('span', { class: 'infotip' });
  const btn = h('button', { type: 'button', class: 'infotip__btn', 'aria-label': about, 'aria-describedby': id, 'aria-expanded': 'false', text: '?',
    onclick: () => { const on = !wrap.classList.contains('is-open'); closeAll(wrap); wrap.classList.toggle('is-open', on); btn.setAttribute('aria-expanded', String(on)); },
    onkeydown: e => { if (e.key === 'Escape') { wrap.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); } } });
  wrap.append(heading, btn, h('span', { class: 'infotip__text', id, role: 'tooltip', text }));
  return wrap;
}
