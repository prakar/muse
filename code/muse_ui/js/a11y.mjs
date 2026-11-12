import { h } from './dom.mjs';

// Accessibility helpers. Landmarks and headings are the page's real structure; the keyboard layer reads the same structure, so they cannot drift apart.

// A <section> with a heading but no name has no landmark. Name it after its heading (aria-labelledby), once per redraw.
let ids = 0;
export function labelSections(root) {
  root.querySelectorAll('section').forEach(s => {
    if (s.hasAttribute('aria-label') || s.hasAttribute('aria-labelledby')) return;
    const hd = s.querySelector('h1, h2, h3'); if (!hd) return;
    if (!hd.id) hd.id = 'hd-' + (++ids);
    s.setAttribute('aria-labelledby', hd.id);
  });
}

// One polite live region for the whole app. Screen readers hear it when the screen changes in place (a filter click redraws the list; nothing else says so).
export function createAnnouncer() {
  const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  return { node: live, say: text => { live.textContent = ''; if (text) setTimeout(() => { live.textContent = text; }, 60); } };
}

// "Skip to the content": the first thing a keyboard or screen-reader user meets. The address is the app's state, so it moves focus instead of changing the hash.
export const SkipLink = content => h('a', { class: 'skip', href: '#content', text: 'Skip to the content', onclick: e => { e.preventDefault(); content.focus(); } });
