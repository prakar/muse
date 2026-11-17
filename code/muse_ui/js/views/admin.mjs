import { h } from '../dom.mjs';
import { Button } from '../components/button.mjs';
import { kindLabel } from '../kinds.mjs';
import { W } from '../words.mjs';
import { tasksSection } from './admin_tasks.mjs';
import { tagsSection } from './admin_tags.mjs';

// Admin, section 1: Status and health. It reads and reports; the one thing it runs is the drift check, which only reads too. The actions (ingest, pre-process,
// back up and restore, restart) are added one section at a time from the coverage list in the vault note "QUARRY - Muse Admin Coverage", and each lands in the
// Muse map as it arrives, so the drift audit catches any that are missing.
const n = x => Number(x || 0).toLocaleString('en-US');
export const size = b => b == null ? '-' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
export const when = iso => { if (!iso) return 'never'; const d = new Date(iso); return isNaN(d) ? '-' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
export const uptime = s => s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : s < 172800 ? (s / 3600).toFixed(1) + ' h' : Math.round(s / 86400) + ' days';
// The width is set through the element's style object, not an inline style attribute, which the Content-Security-Policy forbids.
const meter = pct => { const bar = h('span'); if (bar.style) bar.style.width = pct + '%'; return h('div', { class: 'meter', role: 'img', 'aria-label': pct + ' percent of the budget ceiling used' }, bar); };
const Row = (k, v, note) => h('tr', {}, h('th', { scope: 'row', text: k }), h('td', { text: v == null || v === '' ? '-' : String(v) }), h('td', { class: 'kv__note', text: note || '' }));
const Table = rows => h('table', { class: 'kv' }, h('tbody', {}, rows));
const Section = (title, small, ...kids) => h('section', { class: 'section' }, h('h2', {}, title, small ? h('small', { text: small }) : null), ...kids);

export async function adminView({ api }) {
  let s = null, err = '';
  try { s = await api.adminStatus(); } catch (e) { err = e.message; }
  if (!s) return { node: h('div', {}, h('div', { class: 'page-head' }, h('h1', { text: W.admin })), h('p', { class: 'empty empty--error', text: 'Could not read the status: ' + err })), title: W.admin };
  const c = s.counts, d = s.database, m = s.money, sv = s.server, pct = m.ceiling ? Math.min(100, Math.round(m.spent / m.ceiling * 100)) : 0;

  const out = h('div', { class: 'drift', role: 'status', 'aria-live': 'polite' });
  const driftBtn = Button({ label: 'Run drift check', ic: 'eye', size: 'sm', onClick: async () => {
    driftBtn.disabled = true; out.replaceChildren(h('p', { class: 'hint', text: 'Checking the map against the code...' }));
    try {
      const r = await api.adminDrift();
      out.replaceChildren(...[h('p', { class: r.ok ? 'drift__ok' : 'drift__bad', text: r.ok ? 'No drift: the Muse map matches the code.' : r.problems.length + ' problem' + (r.problems.length === 1 ? '' : 's') + ' found.' }),
        r.problems.length ? h('ul', {}, r.problems.map(t => h('li', { text: t }))) : null, r.warnings.length ? h('ul', { class: 'drift__warn' }, r.warnings.map(t => h('li', { text: t }))) : null].filter(Boolean));   // a null would show as the text "null"
    } catch (e) { out.replaceChildren(h('p', { class: 'drift__bad', text: 'The check could not run: ' + e.message })); }
    driftBtn.disabled = false;
  } });

  // The status strip stays in view while you scroll (see .statusbar), and refreshes when a job ends, so the numbers a run changes are never stale.
  const bar = h('section', { class: 'statusbar', 'aria-label': 'Status at a glance' });
  const fillBar = x => {
    const cc = x.counts, dd = x.database, mm = x.money, pp = mm.ceiling ? Math.min(100, Math.round(mm.spent / mm.ceiling * 100)) : 0;
    const stat = (k, v, note) => h('div', { class: 'stat' }, h('dt', { text: k }), h('dd', { text: v }), note ? h('small', { class: 'stat__note', text: note }) : null);
    bar.replaceChildren(h('dl', { class: 'statusbar__list' },
      stat('Notes', n(cc.notes), cc.pending == null ? '' : n(cc.pending) + ' waiting'),
      stat('Facts', n((cc.byVersion.find(v => v.version === cc.version) || {}).n), cc.version),
      stat('Database', size(dd.bytes), dd.backups[0] ? 'backed up ' + when(dd.backups[0].at) : 'no backup yet'),
      stat('Spent', '$' + mm.spent.toFixed(2), 'of $' + mm.ceiling.toFixed(2) + ' (' + pp + '%)'),
      stat('Server', uptime(x.server.upSeconds), 'version ' + x.server.version)), meter(pp));
  };
  fillBar(s);
  let tasks = null;   // the notice that Muse is behind the database is repainted with the numbers when a job ends
  const refreshBar = () => api.adminStatus().then(x => { fillBar(x); if (tasks) tasks.setFreshness(x.freshness); }).catch(() => {});
  const tagsPanel = await tagsSection({ api, onDone: refreshBar });   // drawn inside step 2 of the Tags group (the note step 'review-tags')
  tasks = await tasksSection({ api, onJobEnd: refreshBar, freshness: s.freshness, extras: { 'review-tags': tagsPanel } });
  const { actions, output } = tasks;
  const node = h('div', { class: 'admin' },
    h('div', { class: 'page-head' }, h('h1', { text: W.admin }), h('p', { text: 'What you can run from here comes first; the reports on the state of things are below. Every task checks first, shows what it would do, and asks before it spends money or deletes anything.' })),
    s.integrity && s.integrity.degraded ? h('div', { class: 'fresh fresh--stale integrity', role: 'alert' }, h('p', { text: 'Muse is in repair mode: the database does not match this code, so only Admin is working.' }), ...s.integrity.findings.map(x => h('p', { text: (x.level === 'fatal' ? 'Problem: ' : 'Note: ') + x.msg + (x.fix ? '  Fix: ' + x.fix : '') }))) : s.integrity && s.integrity.findings.length ? h('p', { class: 'fresh', role: 'status', text: 'Integrity notes: ' + s.integrity.findings.map(x => x.msg).join(' ') }) : null,
    sv.setupMode ? h('p', { class: 'fresh fresh--stale', role: 'status', text: 'Muse started with no database, so it is running on an empty one. Choose Initial setup below and run "Create or update the database", then restart Muse (run  muse restart) so it reads the real one.' }) : null,
    bar,
    h('div', { class: 'admin__grid' },
      h('div', { class: 'admin__actions' }, h('h2', { class: 'admin__h' }, 'Actions', h('small', { text: 'the same tasks as the `muse ops` command' })), h('div', { class: 'toolbar' }, driftBtn), out, actions),
      output ? h('aside', { class: 'admin__output', 'aria-label': 'Output of the last run' }, output) : null),
    h('h2', { class: 'section__split', text: 'Reports' }),
    h('div', { class: 'reports' },
    Section('Counts', c.version, Table([Row('Notes', n(c.notes)), ...c.byVersion.map(v => Row('Facts, ' + v.version, n(v.n), v.version === c.version ? 'the version Muse shows' : '')),
      Row('Notes not yet processed for ' + c.version, c.pending == null ? null : n(c.pending), 'waiting for nuggetize'), ...c.dupes.map(x => Row('Duplicates, ' + x.status, n(x.n), 'hidden from Muse')),
      Row('Wordplay pairs', n(c.wordplay.reduce((t, x) => t + x.n, 0)))]),
      c.wordplay.length ? h('p', { class: 'hint', text: c.wordplay.map(x => kindLabel(x.kind) + ' ' + n(x.n)).join(' · ') }) : null),
    Section('Database', d.path, Table([Row('Size', size(d.bytes), 'last written ' + when(d.at)), Row('Migrations applied', d.migrations ? d.migrations.n : null, d.migrations ? 'latest ' + d.migrations.last : ''),
      Row('Backups', d.backups.length + ' files, ' + size(d.backupBytes), d.backups[0] ? 'newest ' + when(d.backups[0].at) : 'none yet')]),
      d.backups.length ? h('details', {}, h('summary', { text: 'All backups' }), Table(d.backups.map(b => Row(b.name, size(b.bytes), when(b.at))))) : null),
    Section('Money', null, Table([Row('Spent so far', '$' + m.spent.toFixed(2), 'of a $' + m.ceiling.toFixed(2) + ' ceiling (' + pct + '%)'), Row('Last paid call', when(m.lastCall)),
      Row('Last run', m.lastRun ? m.lastRun.kind + ', ' + when(m.lastRun.started_at) : null, m.lastRun && m.lastRun.finished_at ? 'finished ' + when(m.lastRun.finished_at) : m.lastRun ? 'not marked finished' : '')]),
      meter(pct)),
    Section('Your saved files', null, Table(s.files.map(f => Row(f.file, f.bytes == null ? 'missing' : size(f.bytes), f.at ? f.what + ' Last written ' + when(f.at) : f.what)))),
    s.leftovers.length ? Section('Leftovers', 'clear them from Actions, under Safety and recovery', Table(s.leftovers.map(f => Row(f.name, size(f.bytes), when(f.at))))) : null,
    Section('Server', null, Table([Row('Muse version', sv.version), Row('Port', sv.port), Row('Up for', uptime(sv.upSeconds), 'process ' + sv.pid + ', node ' + sv.node),
      Row('Search by meaning', sv.search ? (sv.search.meaning && (sv.search.meaning.state || (sv.search.meaning.ready ? 'ready' : 'not ready'))) : 'not set up')]))));
  return { node, title: W.admin };
}
