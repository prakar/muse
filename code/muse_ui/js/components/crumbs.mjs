import { h } from '../dom.mjs';
export const Crumbs = items => h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('ol', {},
  items.map(it => h('li', {}, it.href ? h('a', { href: it.href, text: it.label }) : h('span', { 'aria-current': 'page', text: it.label })))));
