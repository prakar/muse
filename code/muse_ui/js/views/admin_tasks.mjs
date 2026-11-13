import { h } from '../dom.mjs';
import { Button } from '../components/button.mjs';

// Admin actions, drawn from the one catalogue the server sends (the same list `muse ops` uses). Nothing here knows what a task does: it shows the title, the cost,
// the options, and starts a job. A task with a dry run offers only "Check first"; "Do it for real" appears once that check has finished, and asks for the number
// or name you saw when the run spends money or deletes. The server enforces every rule again, so this page cannot skip one.
const EFFECT = { 'read-only': 'Reads only', 'writes files': 'Writes files', 'writes DB': 'Writes the database', 'spends money': 'Spends money' };
const ON_PAGE = new Set(['status', 'drift']);          // already shown as reports and the drift button above
// The columns group the catalogue's tasks by purpose and how often they are needed. They are a layout choice only: the catalogue still decides what exists,
// so a task with an area this list does not know lands in the last column ("More") instead of disappearing, and a new task appears with no change here.
// `pin` lifts named tasks to the top of their column; `tasks` pulls a task into a column whatever its area says.
export const COLUMNS = [
  { id: 'daily', title: 'Every day', hint: 'Bring the vault in and keep a safety copy.', areas: ['ingest'], tasks: ['backup'], pin: ['refresh', 'backup'] },
  { id: 'prep', title: 'Prepare the data', hint: 'Extract, flag and index. Some of these cost money.', areas: ['prep'], tasks: [], pin: [] },
  { id: 'care', title: 'Care and checks', hint: 'Needed now and then: recovery, cleanup and tests.', areas: ['safety', 'dev'], tasks: [], pin: [] }
];
const MORE = { id: 'more', title: 'More', hint: 'Tasks that do not belong to a column yet.', areas: [], tasks: [], pin: [] };
export function planColumns(cat, hide = ON_PAGE) {
  const cols = [...COLUMNS, MORE].map(c => ({ id: c.id, title: c.title, hint: c.hint, tasks: [] }));
  const home = t => { const i = COLUMNS.findIndex(c => c.tasks.includes(t.id)); if (i >= 0) return i; const j = COLUMNS.findIndex(c => c.areas.includes(t.area)); return j >= 0 ? j : COLUMNS.length; };
  for (const t of cat.tasks) if (!hide.has(t.id)) cols[home(t)].tasks.push(t);
  cols.forEach((c, i) => { const pin = (COLUMNS[i] || MORE).pin; c.tasks.sort((a, b) => { const x = pin.indexOf(a.id), y = pin.indexOf(b.id); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y); }); });
  return cols.filter(c => c.tasks.length);
}
const NEEDS = { count: 'Type the number the check showed', name: 'Type the backup name to confirm' };
const STATE = { running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', lost: 'Lost (the runner stopped)' };
const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

// Returns { actions, output }: the columns of tasks, and the panel that shows what a run says. The page puts the output beside the actions so it stays in view.
// onJobEnd(job) runs when a job stops, so the status strip can refresh its numbers.
export async function tasksSection({ api, onJobEnd = null }) {
  let cat; try { cat = await api.adminOps(); } catch (e) { return { actions: h('p', { class: 'empty empty--error', text: 'The actions are not available: ' + e.message }), output: null }; }
  const log = h('pre', { class: 'log', tabindex: '0', role: 'log', 'aria-label': 'Job log', hidden: '' });
  const head = h('p', { class: 'job__head', role: 'status', text: 'Nothing has run yet. Start a task and its log shows here.' });
  const stop = Button({ label: 'Cancel job', size: 'sm', onClick: () => cancel() });
  const recent = h('ul', { class: 'jobs__list' });
  stop.hidden = true;
  const panel = h('div', { class: 'jobs' }, h('h2', { class: 'jobs__title', text: 'Output' }), head, log, h('div', { class: 'toolbar' }, stop));
  const lastDry = new Map(), afterJob = new Set();
  let current = null, timer = null;

  const show = (j, text) => {
    log.removeAttribute('hidden'); head.textContent = `${j.title}: ${STATE[j.state] || j.state}${j.dry ? ' (check only)' : j.go ? ' (real run)' : ''}${j.state === 'running' ? ', step ' + (j.step + 1) + ' of ' + j.steps.length : ''}`;
    log.textContent = text; log.scrollTop = log.scrollHeight; stop.hidden = j.state !== 'running';
  };
  async function follow(id) {
    current = id; clearInterval(timer);
    const tick = async () => {
      if (current !== id) return;
      try {
        const r = await api.adminJob(id, 300); show(r.job, r.log);
        if (r.job.state !== 'running') { clearInterval(timer); if (onJobEnd) onJobEnd(r.job); if (r.job.dry && r.job.state === 'done') { lastDry.set(r.job.task, r.job); afterJob.forEach(f => f()); } listJobs(); }
      } catch (e) { clearInterval(timer); head.textContent = 'Could not read the job: ' + e.message; }
    };
    await tick(); timer = setInterval(tick, 1000);
  }
  async function cancel() { try { await api.adminCancel(current); } catch (e) { head.textContent = e.message; } }
  async function listJobs() {
    try { const { jobs } = await api.adminJobs(); recent.replaceChildren(...jobs.slice(0, 8).map(j => h('li', {}, h('span', { class: 'jobs__what', text: `${j.title}${j.go ? ' (real)' : j.dry ? ' (check)' : ''}` }), h('span', { class: 'jobs__state jobs__state--' + j.state, text: STATE[j.state] || j.state }), h('span', { class: 'jobs__when', text: when(j.started) }), Button({ label: 'View log', size: 'sm', onClick: () => follow(j.id) })))); } catch (e) { /* the list is a convenience */ }
  }

  function field(d, inputs) {
    const id = 'f-' + Math.random().toString(36).slice(2, 8);
    let input;
    if (d.type === 'enum') input = h('select', { id, class: 'field' }, d.values.map(v => h('option', { value: v, selected: v === d.default ? '' : null, text: v })));
    else if (d.type === 'bool') input = h('input', { id, type: 'checkbox', checked: d.default ? '' : null });
    else if (d.name === 'name' && cat.backups) input = h('select', { id, class: 'field' }, [h('option', { value: '', text: 'Choose a backup' }), ...cat.backups.map(b => h('option', { value: b, text: b }))]);
    else input = h('input', { id, class: 'field', type: d.type === 'int' || d.type === 'number' ? 'number' : 'text', ...(d.type === 'number' ? { step: 'any' } : {}), ...(d.min != null ? { min: d.min } : {}), ...(d.max != null && d.type !== 'text' ? { max: d.max } : {}), placeholder: d.default !== undefined ? String(d.default) : '', value: '' });
    inputs[d.name] = { el: input, def: d };
    return h('div', { class: 'task__field' }, h('label', { for: id, text: d.label || d.name }), input, d.help ? h('small', { class: 'hint', text: d.help }) : null);
  }
  const collect = inputs => { const p = {}; Object.entries(inputs).forEach(([k, { el, def }]) => { if (def.type === 'bool') { if (el.checked) p[k] = true; } else if (el.value !== '') p[k] = el.value; }); return p; };

  function card(t) {
    const inputs = {}, msg = h('p', { class: 'hint task__msg', role: 'alert' }), real = h('div', { class: 'task__real' });
    const confirm = t.needs ? h('input', { class: 'field', type: 'text', 'aria-label': NEEDS[t.needs], placeholder: NEEDS[t.needs], autocomplete: 'off' }) : null;
    const run = async go => {
      msg.textContent = '';
      try { const r = await api.adminStart({ task: t.id, params: collect(inputs), go, expect: go && confirm ? confirm.value.trim() : undefined }); real.replaceChildren(); follow(r.job.id); listJobs(); if (panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }   // on a narrow screen the output is below the cards: bring it into view
      catch (e) { msg.textContent = e.message; }
    };
    afterJob.add(() => { const d = lastDry.get(t.id); if (t.dry && d && d.task === t.id) real.replaceChildren(...[confirm ? h('label', { class: 'task__field' }, h('span', { text: NEEDS[t.needs] }), confirm) : null, Button({ label: 'Do it for real', size: 'sm', variant: 'primary', onClick: () => run(true) })].filter(Boolean)); });   // replaceChildren(null) would print the word "null"
    return h('article', { class: 'task' }, h('h3', {}, t.title, h('span', { class: 'badge badge--' + t.effect.replace(/\s/g, '-').toLowerCase(), text: EFFECT[t.effect] })), h('p', { class: 'task__does', text: t.does }),
      t.params.length ? h('div', { class: 'task__fields' }, t.params.map(d => field(d, inputs))) : null,
      h('div', { class: 'toolbar' }, Button({ label: t.dry ? 'Check first' : 'Run', size: 'sm', onClick: () => run(false) }), t.backup ? h('small', { class: 'hint', text: 'A real run backs up the database first.' }) : null), real, msg);
  }

  const cols = planColumns(cat);
  const actions = h('div', { class: 'tasks' },
    cat.pending != null ? h('p', { class: 'hint tasks__pending', text: `Notes ready to process right now: ${cat.pending}. A paid run asks for this number back.` }) : null,
    h('div', { class: 'cols' }, cols.map(c => h('section', { class: 'col col--' + c.id, 'aria-label': c.title }, h('h3', { class: 'col__title', text: c.title }), h('p', { class: 'col__hint hint', text: c.hint }), c.tasks.map(card)))));
  const output = h('div', { class: 'output' }, panel, h('h3', { class: 'jobs__title jobs__title--small', text: 'Recent jobs' }), recent);
  listJobs();
  return { actions, output };
}
