import { h, mount } from '../dom.mjs';
import { Button } from './button.mjs';

// The Angles glossary: a fly-out that says what each shape name means in Muse. One entry per heuristic: the definition, an example (from a local file, so it may be
// missing), whether the definition is still a draft, and how fully Muse can find the shape. Opens at one entry when a card's shape name is pressed. Esc closes it.
export const DETECTS = { found: 'Muse finds this across the vault', pile: 'Muse finds this when your own facts show it', half: 'Muse finds only the start of this', none: 'Muse does not detect this yet' };

export function Glossary({ api }) {
  const node = h('aside', { class: 'glossary', 'aria-label': 'Glossary of shapes', hidden: true });
  let rows = null, open = false, q = '', at = null;
  const close = () => { open = false; node.hidden = true; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) close(); };
  const entry = r => h('article', { class: 'glossary__entry', id: 'gloss-' + r.id },
    h('h3', {}, r.name, ' ', h('span', { class: 'badge', text: r.status === 'locked' ? 'locked' : 'draft', title: r.status === 'locked' ? 'Muse’s agreed meaning' : 'Wording not yet agreed' })),
    h('p', { text: r.definition }),
    r.example ? h('p', { class: 'hint', text: 'Example: ' + r.example.text + (r.example.own ? '' : ' (from another setter; shown on this machine only)') }) : null,
    h('p', { class: 'hint', text: DETECTS[r.detects] || DETECTS.none }));
  function draw() {
    const needle = q.trim().toLowerCase(), list = (rows || []).filter(r => !needle || (r.name + ' ' + r.definition).toLowerCase().includes(needle));
    const input = h('input', { type: 'search', class: 'field', placeholder: 'Find a shape', 'aria-label': 'Find a shape', value: q });
    input.addEventListener('input', () => { q = input.value; draw(); const i = node.querySelector('input'); if (i) { i.focus(); i.setSelectionRange(q.length, q.length); } });
    mount(node, h('div', { class: 'glossary__head' }, h('h2', { text: 'Glossary' }), Button({ ic: 'x', variant: 'ghost', title: 'Close (Esc)', onClick: close })), input,
      rows ? h('div', { class: 'glossary__list' }, list.length ? list.map(entry) : h('p', { class: 'empty', text: 'Nothing matches.' })) : h('p', { class: 'hint', text: 'Loading…' }));
    if (at != null) { const el = node.querySelector('#gloss-' + at); if (el) { el.classList.add('is-on'); el.scrollIntoView({ block: 'start' }); } }
  }
  async function openAt(id) {
    at = id; q = ''; open = true; node.hidden = false; document.addEventListener('keydown', onKey); draw();
    if (!rows) { try { rows = (await api.glossary()).rows; } catch (e) { mount(node, h('p', { class: 'hint', text: 'The glossary is unavailable: ' + e.message })); return; } draw(); }
  }
  return { node, openAt, close };
}
