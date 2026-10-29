import { h, mount, debounce } from '../dom.mjs';
import { icon } from '../icons.mjs';

// Search box with a suggestion list, built to the ARIA combobox pattern: arrow keys move, Enter opens, Esc closes, "/" focuses from anywhere.
const GROUPS = [['wordplay', 'Wordplay pairs'], ['hook', 'Names, places and things']];

export function Search({ api, onPick, onSubmit }) {
  const input = h('input', { type: 'search', placeholder: 'Search a name, a place, or a pair like Berlin ~ Merlin', autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'sugg', 'aria-autocomplete': 'list', 'aria-label': 'Search' });
  const pop = h('div', { class: 'pop', id: 'sugg', role: 'listbox', hidden: '' });
  let items = [], active = -1;
  const close = () => { pop.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const setActive = i => {
    active = items.length ? (i + items.length) % items.length : -1;
    pop.querySelectorAll('[role=option]').forEach((el, n) => el.setAttribute('aria-selected', String(n === active)));
    active >= 0 ? input.setAttribute('aria-activedescendant', 'opt' + active) : input.removeAttribute('aria-activedescendant');
    pop.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
  };
  const submit = q => { close(); input.value = ''; onSubmit(q); };
  const choose = it => { if (it.kind === 'search') return submit(it.label); close(); input.value = ''; onPick(it); };
  const draw = () => {
    items = GROUPS.flatMap(([kind]) => data.filter(i => i.kind === kind));
    const typed = input.value.trim(); if (typed.length >= 2) items.push({ kind: 'search', label: typed });
    if (!items.length) return close();
    let n = 0;
    mount(pop, [GROUPS.map(([kind, title]) => { const part = items.filter(i => i.kind === kind); return part.length && [
      items.some(i => i.kind !== kind) ? h('div', { class: 'pop__group', role: 'presentation', text: title }) : null,
      part.map(it => { const i = n++; return h('div', { class: 'pop__item', role: 'option', id: 'opt' + i, 'aria-selected': 'false', onmousedown: e => { e.preventDefault(); choose(it); } },
        h('span', { text: (it.mark === 'use' ? '★ ' : '') + it.label }), h('small', { text: `${it.sub ? it.sub + ' · ' : ''}${it.df} notes` })); })]; }),
      typed.length >= 2 ? h('div', { class: 'pop__item pop__item--search', role: 'option', id: 'opt' + n, 'aria-selected': 'false', onmousedown: e => { e.preventDefault(); submit(typed); } }, h('span', { text: 'Search the notes for “' + typed + '”' }), h('small', { text: 'Enter' })) : null]);
    pop.hidden = false; input.setAttribute('aria-expanded', 'true'); setActive(-1);
  };
  let data = [];
  const fetchNow = debounce(async () => {
    const q = input.value.trim(); if (q.length < 2) { data = []; return close(); }
    try { data = (await api.suggest(q)).items; draw(); } catch (e) { if (e.name !== 'AbortError') close(); }
  }, 140);
  input.addEventListener('input', fetchNow);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); pop.hidden ? fetchNow() : setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { const q = input.value.trim(); if (active >= 0 && items[active]) { e.preventDefault(); choose(items[active]); } else if (q.length >= 2) { e.preventDefault(); submit(q); } }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  document.addEventListener('keydown', e => { if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); } });
  return h('div', { class: 'search' }, h('div', { class: 'search__box' }, icon('search'), input, h('kbd', { text: '/', 'aria-hidden': 'true' })), pop);
}
