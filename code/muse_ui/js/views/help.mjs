import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { FEATURES } from '../muse_map.mjs';
import { W } from '../words.mjs';
import { INTRO, QUICK_KEYS, WHICH, RECIPES, SAVED, GLOSSARY, COMING, SYSADMIN } from '../help_content.mjs';

// Help: three buttons that look alike (side by side), then recipes in cookbook form (goal, where to start, steps, what next), then reference.
// A recipe can be opened directly: #/help?r=know
const table = (head, rows) => h('table', { class: 'helptable' }, h('thead', {}, h('tr', {}, head.map(c => h('th', { scope: 'col', text: c })))), h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => i === 0 ? h('th', { scope: 'row', text: c }) : h('td', { text: c }))))));

// Contents: the Muse map as a tree. Each feature links to its recipes (#/help?r=key) and, where it has a screen of its own, to that screen.
const TITLE = Object.fromEntries(RECIPES.map(r => [r.key, r.title]));
const NEEDS_PARAM = new Set(['set', 'wordplay']);   // screens that need a chosen handle, so there is no plain address for them
function contents() {
  const live = FEATURES.filter(f => !f.legacy), kids = k => live.filter(f => f.parent === k);
  const item = f => h('li', {}, h('strong', { text: f.title }), f.route && !NEEDS_PARAM.has(f.route) ? [' ', h('a', { class: 'toc__open', href: build(f.route), text: 'open' })] : null,
    h('span', { class: 'toc__blurb', text: ' \u2014 ' + f.blurb }),
    (f.recipes || []).length ? h('ul', { class: 'toc__recipes' }, f.recipes.map(k => h('li', {}, h('a', { href: build('help', {}, { r: k }), text: TITLE[k] || k })))) : null,
    kids(f.key).length ? h('ul', {}, kids(f.key).map(item)) : null);
  return h('section', { class: 'section toc' }, h('h2', { text: 'Contents' }), h('p', { class: 'hint', text: 'Everything Muse can do, by screen. Click a recipe to jump to it.' }), h('ul', { class: 'toc__tree' }, live.filter(f => !f.parent).map(item), h('li', {}, h('strong', { text: 'Sys Admin' }), h('span', { class: 'toc__blurb', text: ' \u2014 commands, the Muse map and its budget.' }), h('ul', { class: 'toc__recipes' }, h('li', {}, h('a', { href: build('help', {}, { s: 'sysadmin' }), text: 'Sys Admin' }))))));
}

export async function helpView({ route }) {
  const open = route.query.r, jump = route.query.s;
  const which = h('section', { class: 'section' }, h('h2', { text: `${W.focus}, ${W.collect} or ${W.star}?` }),
    h('p', { class: 'hint', text: 'Three buttons that look alike and do different jobs.' }),
    h('div', { class: 'helpcards' }, WHICH.map(w => h('article', { class: 'helpcard' }, h('h3', {}, w.button),
      h('p', { class: 'helpcard__what', text: w.what }), h('dl', {}, h('dt', { text: 'Use it when' }), h('dd', { text: w.use }), h('dt', { text: 'Where it appears' }), h('dd', { text: w.where }), h('dt', { text: 'What is saved' }), h('dd', { text: w.saved }))))),
    h('p', { class: 'hint', text: `In one line: ${W.focus} to look, ${W.collect} to build, ${W.star} to remember. ${W.collect} and ${W.star} change what you have saved; ${W.focus} changes where you are.` }));
  const recipes = h('section', { class: 'section' }, h('h2', {}, 'Recipes', h('small', { text: String(RECIPES.length) })),
    h('p', { class: 'hint', text: 'To do something, start where the recipe says and follow the steps. Open one to read it.' }),
    RECIPES.map(r => h('details', { class: 'recipe', id: 'recipe-' + r.key, open: open === r.key }, h('summary', { text: r.title }),
      h('p', { class: 'recipe__goal' }, h('strong', { text: 'Goal: ' }), r.goal),
      h('p', {}, h('strong', { text: 'Start at: ' }), r.start.href ? h('a', { href: r.start.href, text: r.start.t }) : r.start.t),
      h('ol', { class: 'recipe__steps' }, r.steps.map(s => h('li', {}, typeof s === 'string' ? s : s.href ? h('a', { href: s.href, text: s.t }) : s.t))),
      r.then ? h('p', { class: 'recipe__then' }, h('strong', { text: 'Then: ' }), r.then) : null)));
  const node = h('div', {}, h('div', { class: 'page-head' }, h('h1', { text: 'Help' }), h('p', { text: INTRO })),
    contents(), which, recipes,
    h('section', { class: 'section' }, h('h2', { text: 'Keys' }), table(['Key', 'What it does'], QUICK_KEYS)),
    h('section', { class: 'section' }, h('h2', { text: 'Where things are saved' }), table(['What', 'Where', 'Notes'], SAVED)),
    h('section', { class: 'section' }, h('h2', { text: 'Words used in Muse' }), h('dl', { class: 'wordlist' }, GLOSSARY.flatMap(([t, d]) => [h('dt', { text: t }), h('dd', { text: d })]))),
    h('section', { class: 'section' }, h('h2', { text: 'What is coming' }), table(['', ''], COMING)),
    h('section', { class: 'section', id: 'sysadmin' }, h('h2', { text: 'Sys Admin' }), h('p', { class: 'hint', text: SYSADMIN.intro }),
      table(['Command', 'What it does'], SYSADMIN.commands), h('p', { class: 'hint', text: SYSADMIN.refuses }),
      h('h3', { text: 'The Muse map and its budget' }), SYSADMIN.map.map(t => h('p', { text: t }))));
  return { node, title: 'Help', after: () => { const el = open ? document.getElementById('recipe-' + open) : jump ? document.getElementById(jump) : null; el?.scrollIntoView({ block: 'start' }); } };
}
