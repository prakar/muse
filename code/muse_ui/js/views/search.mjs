import { tidyQuote } from '../tidy.mjs';
import { NoteLink, ClaimLink } from '../components/notelink.mjs';
import { h } from '../dom.mjs';
import { build } from '../router.mjs';
import { Button } from '../components/button.mjs';
import { Pager } from '../components/pager.mjs';
import { FocusButton, FocusHint } from '../components/focus.mjs';
import { StarButton } from '../components/star.mjs';
import { CollectButton } from '../components/tray.mjs';
import { getPref, setPref } from '../prefs.mjs';
import { W } from '../words.mjs';

// The search results page. It says how sure it is (a band over the matches), shows the evidence for every match, and says plainly when nothing close exists.
export const SWITCH_LABEL = 'Search by meaning';
export const SWITCH_HINT = 'On: finds notes that mean the same thing, using your Mac’s embedding model and one cheap AI call for each new question (repeat questions are free). Off: matches the words you typed.';

// Pure. The URL says `meaning=off` when the switch was off for that search; otherwise the saved preference decides (default on).
export const wantsMeaning = (route, stored = true) => route.query.meaning === 'off' ? false : route.query.meaning === 'on' ? true : stored !== false;
export const searchHref = (q, meaning) => build('search', {}, { q, meaning: meaning ? '' : 'off' });
export const WORDS_DISCLAIMER = 'Words only. These facts contain some of the words you typed (a fact can match on just one of them), so this list can look relevant without answering anything. In this mode Muse cannot tell you whether the vault holds an answer; switch on \u201cSearch by meaning\u201d to get that.';
export const BAND_TITLE = { likely: 'Closest matches', weak: 'Weak matches', nothing: 'Nothing close in the vault', unrated: 'Matches, not rated' };
export const viaLabel = via => [via.words ? 'words' : null, via.meaning ? 'meaning' : null].filter(Boolean).join(' + ') || 'neither';

function Switch({ on, onChange }) {
  const el = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-describedby': 'switch-hint' }, h('span', { class: 'switch__track' }, h('span', { class: 'switch__thumb' })), h('span', { text: SWITCH_LABEL }));
  el.addEventListener('click', () => { on = !on; el.setAttribute('aria-checked', String(on)); onChange(on); });
  return el;
}

export async function searchView({ route, api, nav }) {
  const q = (route.query.q || '').trim(); let meaning = wantsMeaning(route, getPref('meaning', true));
  const input = h('input', { type: 'search', class: 'searchpage__input', value: q, placeholder: 'Ask a question, or type a few words', 'aria-label': 'Question', autocomplete: 'off', maxlength: '300' });
  const form = h('form', { class: 'searchpage', onsubmit: e => { e.preventDefault(); const v = input.value.trim(); if (v) nav.go(searchHref(v, meaning)); } },
    input, Button({ label: 'Search', ic: 'search' }),
    Switch({ on: meaning, onChange: on => { meaning = on; setPref('meaning', on); if (q) nav.go(searchHref(q, on)); } }));
  const head = h('div', { class: 'page-head' }, h('h1', { text: 'Search' }), form, h('p', { id: 'switch-hint', class: 'hint', text: SWITCH_HINT }));
  if (!q) return { node: h('div', {}, head, h('p', { class: 'empty', text: 'Ask a question of your notes. Muse will say how close the best match is, and when there is nothing.' })), title: 'Search', after: () => input.focus() };

  const page = parseInt(route.query.page, 10) || 1, size = parseInt(route.query.size, 10) || 0;
  const r = await api.search(q, meaning, page, size);
  const pageHref = (p, s = size) => build('search', {}, { q, meaning: meaning ? '' : 'off', page: p > 1 ? p : '', size: s || '' });
  const offset = r.paged ? (r.page - 1) * r.size : 0;
  const card = (it, n) => h('li', { class: 'fact', 'data-burr': it.burrId },
    h('div', { class: 'fact__top' }, h('span', { class: 'fact__n', text: String(offset + n + 1) }), NoteLink({ text: it.note || '', noteId: it.noteId, at: it.burrId }),
      it.basis ? h('span', { class: 'badge badge--basis', title: 'The confidence rating above is based on this fact: the closest to your question', text: 'best match' }) : null, h('span', { class: 'badge', title: 'How this fact was found', text: viaLabel(it.via) }), it.sim != null ? h('span', { class: 'badge', title: 'Closeness of this fact to the rewritten question (0 to 1)', text: 'closeness ' + it.sim.toFixed(2) }) : null),
    ClaimLink({ text: it.claim, noteId: it.noteId, at: it.burrId }), it.quote ? h('p', { class: 'fact__quote', text: '“' + tidyQuote(it.quote) + '”' }) : null,
    h('div', { class: 'fact__actions' }, StarButton({ id: it.burrId, note: it.note, starred: it.starred }, 'search'), CollectButton({ id: it.burrId, noteId: it.noteId, note: it.note, claim: it.claim }, 'search'), FocusButton({ id: it.burrId, from: 'search' })));
  const list = h('ol', { class: 'facts' }, r.results.map(card));
  const banner = r.band ? h('div', { class: 'banner banner--' + r.band, role: 'status' }, h('strong', { text: BAND_TITLE[r.band] }),
    r.band === 'unrated' ? h('span', { text: '. No confidence rating, because the AI rewrite step did not run for this question.' })
      : h('span', { text: (r.bestSim != null ? ' (best closeness ' + r.bestSim.toFixed(2) + '). ' : '. ') + r.bandText })) : null;
  const disclaimer = r.mode === 'words' && r.results.length ? h('p', { class: 'disclaimer', text: WORDS_DISCLAIMER }) : null;
  const body = r.folded && r.results.length ? h('details', { class: 'folded' }, h('summary', { text: 'Show the nearest ' + r.results.length + ' facts anyway' }), list) : list;
  const read = r.understoodAs ? h('details', { class: 'understood' }, h('summary', { text: 'How Muse read your question' + (r.cachedRewrite === false ? ' (new question, cost $' + r.cost.toFixed(4) + ')' : '') }),
    h('p', { text: r.understoodAs }), h('p', { class: 'hint', text: 'An AI guess at what a matching note might say, used only to find facts. It is not an answer and it does not come from your notes; it may contain invented details.' })) : null;
  const node = h('div', {}, head, banner, disclaimer, read, r.notices.map(n => h('p', { class: 'notice notice--' + n.kind, role: 'status', text: n.text })), r.results.length ? FocusHint() : null, r.results.length ? body : null, r.paged && r.pages > 1 ? Pager({ page: r.page, pages: r.pages, total: r.total, size: r.size, hrefFor: p => pageHref(p), onSize: s => nav.go(pageHref(1, s)), onGo: p => nav.go(pageHref(p)) }) : null);
  return { node, title: 'Search: ' + q };
}
