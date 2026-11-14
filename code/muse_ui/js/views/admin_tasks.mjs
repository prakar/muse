import { h } from '../dom.mjs';
import { Button, Segmented } from '../components/button.mjs';
import { getPref, setPref } from '../prefs.mjs';

// Admin actions, drawn from the one catalogue the server sends (the same list `muse ops` uses). Nothing here knows what a task does: it shows the title, the cost,
// the options, and starts a job. A task with a dry run offers only "Check first"; "Do it for real" appears once that check has finished, and asks for the number
// or name you saw when the run spends money or deletes. The server enforces every rule again, so this page cannot skip one.
const EFFECT = { 'read-only': 'Reads only', 'writes files': 'Writes files', 'writes DB': 'Writes the database', 'spends money': 'Spends money' };
// The ORDER lives on the server (the catalogue's `flows`), so the page, the `muse ops` command and a bot calling the API all see the same one; this file only draws it.
// Two modes: "Initial setup" (a vault and no database yet: do these once, in order) and "Ongoing maintenance" (the weekly routine first, then the rest by how often
// you need it). planFlow is pure: it turns a catalogue and a mode into groups of steps. A task the server lists but no flow places still appears, under "More", so a
// task added to the catalogue can never vanish from the page.
export function planFlow(cat, mode, hide = (cat && cat.onPage) || ['status', 'drift']) {
  const flow = cat && cat.flows && cat.flows[mode]; if (!flow) return null;
  const byId = new Map((cat.tasks || []).map(t => [t.id, t])), placed = new Set(), groups = [];
  for (const g of flow.groups) {
    const items = [];
    for (const st of (g.steps || (g.tasks || []).map(task => ({ task })))) {
      if (st.note) { items.push({ kind: 'note', note: st.note, title: st.title || st.note, why: st.why || '' }); continue; }
      const t = byId.get(st.task); if (!t) continue; placed.add(t.id); items.push({ kind: 'task', task: t, why: st.why || '' });
    }
    if (items.length) groups.push({ id: g.id, title: g.title, hint: g.hint || '', ordered: !!g.ordered, collapsed: !!g.collapsed, items });
  }
  if (mode === 'ongoing') {
    const lost = (cat.tasks || []).filter(t => !placed.has(t.id) && !hide.includes(t.id));
    if (lost.length) groups.push({ id: 'more', title: 'More', hint: 'Tasks that do not belong to a group yet.', ordered: false, collapsed: false, items: lost.map(task => ({ kind: 'task', task, why: '' })) });
  }
  return { id: flow.id, title: flow.title, hint: flow.hint || '', groups };
}
export const suggestedMode = cat => (cat && cat.setup && cat.setup.suggested) || 'ongoing';
const NEEDS = { count: 'Type the number the check showed', name: 'Type the backup name to confirm' };
const STATE = { running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Cancelled', lost: 'Lost (the runner stopped)' };
const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

// Returns { actions, output }: the columns of tasks, and the panel that shows what a run says. The page puts the output beside the actions so it stays in view.
// onJobEnd(job) runs when a job stops, so the status strip can refresh its numbers.
export async function tasksSection({ api, onJobEnd = null, freshness = null }) {
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
      t.params.length ? (fields => t.params.length > 2 ? h('details', { class: 'task__opts' }, h('summary', { text: 'Options (' + t.params.length + ')' }), fields) : fields)(h('div', { class: 'task__fields' }, t.params.map(d => field(d, inputs)))) : null,
      h('div', { class: 'toolbar' }, Button({ label: t.dry ? 'Check first' : 'Run', size: 'sm', onClick: () => run(false) }), t.backup ? h('small', { class: 'hint', text: 'A real run backs up the database first.' }) : null), real, msg);
  }

  // The notice that Muse is behind the database. It is painted wherever it is shown (the top of the actions and the "Restart Muse" step) and repainted when a job ends.
  const fresh = [], paintFresh = f => {
    const clock = f && f.loadedAt ? when(f.loadedAt) : '';
    const bits = f ? [f.newFacts && f.newFacts + ' new fact' + (f.newFacts === 1 ? '' : 's'), f.newWordplay && f.newWordplay + ' wordplay pair' + (f.newWordplay === 1 ? '' : 's'), f.newDuplicateFlags && f.newDuplicateFlags + ' duplicate flag' + (f.newDuplicateFlags === 1 ? '' : 's')].filter(Boolean) : [];
    fresh.forEach(el => {
      el.className = 'fresh ' + (f && f.stale ? 'fresh--stale' : 'fresh--ok'); el.hidden = !f; el.setAttribute('role', 'status');
      el.textContent = !f ? '' : f.stale ? `Muse is behind the database. It loaded at ${clock}; since then the database gained ${bits.join(', ')}. Restart Muse to see them: run  muse restart` : `Muse is up to date with the database (loaded ${clock}).`;
    });
  };
  const freshBox = () => { const el = h('p'); fresh.push(el); return el; };
  const topFresh = freshBox();

  const stepOf = (it, i, group, done) => it.kind === 'note'
    ? h('li', { class: 'step' }, h('span', { class: 'step__n', 'aria-hidden': 'true', text: String(i + 1) }), h('article', { class: 'task task--note' }, h('h3', {}, it.title), h('p', { class: 'task__does', text: it.why }), freshBox()))
    : (() => { const c = card(it.task), body = h('div', { class: 'step__body' }, it.why ? h('p', { class: 'step__why', text: it.why }) : null, c);
        return group.ordered ? h('li', { class: 'step' + (it.why ? ' step--why' : '') }, h('span', { class: 'step__n', 'aria-hidden': 'true', text: String(i + 1) }), done && done[it.task.id] ? h('span', { class: 'step__done', text: 'looks done' }) : null, body) : h('li', { class: 'step step--plain' + (it.why ? ' step--why' : '') }, body); })();
  const groupEl = (g, mode, n = 0) => {
    const list = h(g.ordered ? 'ol' : 'ul', { class: 'steps' + (g.ordered ? ' steps--ordered' : '') }, g.items.map((it, i) => stepOf(it, i, g, mode === 'setup' ? (cat.setup || {}).done : null)));
    const head = [h('div', { class: 'band__head' }, h('h3', { class: 'col__title', text: g.title }), g.hint ? h('p', { class: 'col__hint hint', text: g.hint }) : null)];
    return g.collapsed ? h('details', { class: 'flow__group band--' + (n % 3) }, h('summary', {}, h('span', { class: 'col__title', text: g.title }), g.hint ? h('small', { class: 'hint', text: '  ' + g.hint }) : null), list)
      : h('section', { class: 'flow__group band--' + (n % 3), 'aria-label': g.title }, ...head, list);
  };
  let mode = getPref('adminMode', null); if (mode !== 'setup' && mode !== 'ongoing') mode = suggestedMode(cat);
  const flowBox = h('div', { class: 'flow' }), modeBox = h('div', { class: 'modes' });
  const drawFlow = () => {
    const plan = planFlow(cat, mode);
    flowBox.replaceChildren(...(plan ? [h('p', { class: 'flow__hint hint', text: plan.hint }), ...plan.groups.map((g, n) => groupEl(g, mode, n))] : [h('p', { class: 'empty', text: 'This server did not send an order for the tasks.' })]));
    paintFresh(freshnessNow);
  };
  let freshnessNow = freshness;
  const drawModes = () => modeBox.replaceChildren(Segmented({ label: 'Admin mode', options: [{ label: 'Ongoing maintenance', value: 'ongoing' }, { label: 'Initial setup', value: 'setup' }], value: mode, onChange: v => { mode = v; setPref('adminMode', v); drawModes(); drawFlow(); } }));
  const actions = h('div', { class: 'tasks' }, modeBox, topFresh,
    cat.pending != null ? h('p', { class: 'hint tasks__pending', text: `Notes ready to process right now: ${cat.pending}. A paid run asks for this number back.` }) : null, flowBox);
  drawModes(); drawFlow();
  const output = h('div', { class: 'output' }, panel, h('h3', { class: 'jobs__title jobs__title--small', text: 'Recent jobs' }), recent);
  listJobs();
  return { actions, output, setFreshness: f => { freshnessNow = f; paintFresh(f); } };
}
