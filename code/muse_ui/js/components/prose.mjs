import { h } from '../dom.mjs';

// Draws the tree from markdown.mjs as DOM. `hit` is the leaf to highlight; `onWiki(title)` handles a click on a [[wikilink]].
export function Prose(tree, { hit, onWiki } = {}) {
  const inl = nodes => nodes.map(n => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return h('code', { text: n.v });
      case 'strong': return h('strong', {}, inl(n.c));
      case 'em': return h('em', {}, inl(n.c));
      case 'mark': return h('mark', {}, inl(n.c));
      case 'link': return h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, inl(n.c));
      case 'wiki': return h('a', { class: 'wiki', href: '#', title: 'Open note: ' + n.target, onclick: e => { e.preventDefault(); onWiki?.(n.target); } }, inl(n.c));
      default: return null;
    }
  });
  const flag = (node, props = {}) => ({ ...props, class: node === hit ? 'is-hit' : null, 'data-hit': node === hit ? '1' : null });
  const blk = b => {
    switch (b.t) {
      case 'h': return h('h' + Math.min(b.level + 1, 6), flag(b), inl(b.c));
      case 'p': return h('p', flag(b), inl(b.c));
      case 'hr': return h('hr');
      case 'code': return h('pre', {}, h('code', { text: b.text }));
      case 'quote': return h('blockquote', {}, b.c.map(blk));
      case 'ul': case 'ol': return h(b.t, {}, b.items.map(li => h('li', flag(li), li.checked === null ? null : h('input', { type: 'checkbox', disabled: '', checked: li.checked ? '' : null, 'aria-label': li.checked ? 'done' : 'not done' }), inl(li.c), li.sub.map(blk))));
      case 'table': return h('table', {}, h('thead', {}, h('tr', {}, b.head.map(c => h('th', {}, inl(c))))), h('tbody', {}, b.rows.map(r => h('tr', {}, r.map(c => h('td', {}, inl(c)))))));
      default: return null;
    }
  };
  return h('div', { class: 'prose' }, tree.map(blk));
}
