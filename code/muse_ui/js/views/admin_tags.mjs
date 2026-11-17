import { h } from '../dom.mjs';
import { Button } from '../components/button.mjs';
import { Pager, PAGE_SIZES } from '../components/pager.mjs';
import { toast } from '../components/toast.mjs';
import { getPref, setPref } from '../prefs.mjs';

// Admin, the Tags tab: the new tags waiting for your decision. The model proposes tags; rules approve the ones already in your vocabulary; only a tag that is NEW (or a short
// name that could mean several tags) waits here. The list is paged and filtered by the server, so it stays quick at thousands of tags. Decisions are QUEUED on the page and
// applied together (a few jobs, because the Muse server never writes the database itself): you can change your mind before anything is written.
// Keys on a focused row: a accept, r reject, 1-3 use the suggested tag, c clear, j/k or the arrows move.
const n = x => Number(x || 0).toLocaleString('en-US');
const wait = ms => new Promise(r => setTimeout(r, ms));
const FILTERS = [['all', 'All new tags'], ['suggestion', 'Has a look-alike'], ['ambiguous', 'Ambiguous short name'], ['once', 'Used on one note'], ['none', 'No look-alike']];
const CHUNK = 100;   // decisions per job, so one request stays small

export async function tagsSection({ api, onDone = null }) {
  const queue = new Map();   // tag -> { action, to }
  let page = 1, size = getPref('tagsPerPage', 24), filter = 'all', q = '', data = null;
  if (!PAGE_SIZES.includes(size)) size = 24;
  const head = h('p', { class: 'hint', role: 'status' }), bar = h('div', { class: 'tags__bar' }), list = h('div', { class: 'tags__list-box' }), foot = h('div', { class: 'tags__foot' });
  const section = h('section', { class: 'section tags', 'aria-label': 'New tags to review' }, h('h2', {}, 'New tags to review'), head, bar, list, foot);

  const setQ = (tag, action, to) => { const cur = queue.get(tag); if (cur && cur.action === action && (cur.to || '') === (to || '')) queue.delete(tag); else queue.set(tag, to ? { action, to } : { action }); paintQueue(); };
  const Row = g => {
    const cur = queue.get(g.tag), opts = (g.candidates.length ? g.candidates : g.suggestions).slice(0, 3), on = (a, to) => !!cur && cur.action === a && (cur.to || '') === (to || '');
    const li = h('li', { class: 'tags__row' + (cur ? ' is-queued' : ''), tabindex: '0', 'aria-label': g.tag },
      h('div', { class: 'tags__what' }, h('strong', { text: g.tag }), h('span', { class: 'tags__n', text: ' ' + n(g.notes) + (g.notes === 1 ? ' note' : ' notes') }),
        h('div', { class: 'hint', text: g.titles.map(t => '“' + t.slice(0, 48) + '”').join(' · ') + (g.candidates.length ? '  — ambiguous: your vocabulary has several tags ending this way' : '') })),
      h('div', { class: 'toolbar' },
        Button({ label: 'Accept tag', size: 'sm', pressed: on('accept'), title: 'Add it to your vocabulary and approve it on these notes (key a).', onClick: () => setQ(g.tag, 'accept') }),
        Button({ label: 'Reject tag', size: 'sm', pressed: on('reject'), title: 'Never put it on these notes (key r).', onClick: () => setQ(g.tag, 'reject') }),
        ...opts.map((v, i) => Button({ label: v, size: 'sm', pressed: on('map', v), title: 'Use ' + v + ' (already in your vocabulary) instead (key ' + (i + 1) + ').', onClick: () => setQ(g.tag, 'map', v) }))));
    li.addEventListener('keydown', e => {
      if (e.target !== li || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key, move = d => { const rows = Array.from(list.querySelectorAll('.tags__row')), i = rows.indexOf(li); if (rows[i + d]) { e.preventDefault(); rows[i + d].focus(); } };
      if (k === 'j' || k === 'ArrowDown') move(1); else if (k === 'k' || k === 'ArrowUp') move(-1);
      else if (k === 'a') setQ(g.tag, 'accept'); else if (k === 'r') setQ(g.tag, 'reject'); else if (k === 'c') { queue.delete(g.tag); paintQueue(); }
      else if (/^[1-3]$/.test(k) && opts[Number(k) - 1]) setQ(g.tag, 'map', opts[Number(k) - 1]);
    });
    return li;
  };
  // Pressing a button repaints the rows (their pressed state), and keeps focus on the same row so the keys keep working.
  function paintQueue() {
    const focused = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('aria-label') : null;
    drawBar(); drawList();
    if (focused) { const el = Array.from(list.querySelectorAll('.tags__row')).find(r => r.getAttribute('aria-label') === focused); if (el) el.focus(); }
  }
  function drawBar() {
    const count = queue.size, apply = Button({ label: 'Apply decisions', size: 'sm', disabled: !count, title: 'Write the queued decisions to the database. Nothing changes until you press this.', onClick: applyAll }),
      clear = Button({ label: 'Clear decisions', size: 'sm', disabled: !count, title: 'Forget the queued decisions.', onClick: () => { queue.clear(); paintQueue(); } });
    const sel = h('select', { class: 'field', 'aria-label': 'Which new tags', onchange: e => { filter = e.target.value; page = 1; load(); } }, FILTERS.map(([v, t]) => h('option', { value: v, selected: v === filter ? '' : null, text: t })));
    const search = h('input', { class: 'field', type: 'search', 'aria-label': 'Find a tag', placeholder: 'Find a tag', value: q, onkeydown: e => { if (e.key === 'Enter') { q = e.target.value.trim().toLowerCase(); page = 1; load(); } } });
    bar.replaceChildren(sel, search, h('span', { class: 'hint', text: count ? n(count) + ' queued, not yet applied' : 'Decisions are queued here, then applied together.' }), apply, clear);
  }
  function drawList() {
    if (!data) return;
    list.replaceChildren(data.waiting.length ? h('ul', { class: 'tags__list' }, data.waiting.map(Row)) : h('p', { class: 'empty', text: data.total ? 'No new tags match this filter.' : 'No new tags are waiting for review.' }));
  }
  function drawFoot() {
    if (!data || !data.matching) { foot.replaceChildren(); return; }
    const pages = Math.max(1, Math.ceil(data.matching / size));
    const pg = Pager({ page, pages, total: data.matching, size, hrefFor: p => '#tags-page-' + p, onSize: s => { size = s; setPref('tagsPerPage', s); page = 1; load(); }, onGo: p => { page = p; load(); } });
    pg.addEventListener('click', e => { const a = e.target.closest ? e.target.closest('a.pager__page') : null; if (!a) return; e.preventDefault(); const m = /tags-page-(\d+)/.exec(a.getAttribute('href') || ''); if (m) { page = Number(m[1]); load(); } });
    foot.replaceChildren(pg);
  }
  async function load() {
    let t; try { t = await api.adminTags({ page, size, filter, q }); } catch (e) { section.replaceChildren(h('p', { class: 'empty empty--error', text: 'Could not read the waiting tags: ' + e.message })); return; }
    if (!t.available) { section.replaceChildren(h('p', { class: 'empty', text: 'The tag tables are not in this database yet. Run “Create or update the database” in Ongoing maintenance first.' })); return; }
    data = t; head.textContent = n(t.untagged) + ' notes have no tags. ' + n(t.approvedUnwritten) + ' notes have approved tags not yet written into your notes. ' + n(t.total) + ' new tags are waiting' + (t.matching !== t.total ? ', ' + n(t.matching) + ' match this filter' : '') + '.';
    drawBar(); drawList(); drawFoot();
  }
  async function applyAll() {
    const all = Array.from(queue.entries()).map(([tag, d]) => tag + '|' + d.action + '|' + (d.to || ''));
    try {
      for (let i = 0; i < all.length; i += CHUNK) {
        const r = await api.adminStart({ task: 'tag-decide', params: { decisions: all.slice(i, i + CHUNK).join(';') }, go: false });
        for (let k = 0; k < 150; k++) { const j = (await api.adminJob(r.job.id, 5)).job; if (j.state !== 'running') { if (j.state !== 'done') throw new Error('Some decisions did not finish (' + j.state + '). See the job list. Nothing already applied is lost.'); break; } await wait(400); }
      }
      toast({ text: n(all.length) + ' decisions applied.' }); queue.clear(); if (onDone) onDone();
    } catch (e) { toast({ text: e.message }); }
    await load();
  }
  await load();
  return section;
}
