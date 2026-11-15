'use strict';
// The one catalogue of repeatable maintenance tasks. The CLI (`muse ops`), the job API and the Admin page all read this list, so they cannot disagree.
// A task turns validated parameters into STEPS; each step is one process (an existing script, or `muse_ops.js _do <name>` for the small internal ones).
//
// effect:  read-only | writes files | writes DB | spends money.
// Safety rules, enforced in plan() so no front door can skip them:
//   - A task with a dry twin runs as a dry run unless go is set. Tasks without one (read-only, backup) just run.
//   - Tasks that write the database take a backup first (a step in the job), unless it is a dry run.
//   - Destructive or paid runs need `expect`: the count or name the person saw, checked against the live value, refused if it has changed.
//   - Tasks in the same `group` never run together (checked by the job runner).
const fs = require('fs'), path = require('path');
const I = require('./ops_internal');

const ROOT = path.join(__dirname, '..', '..');
const AREAS = [['status', 'Status and checks'], ['ingest', 'Bring the vault in'], ['prep', 'Pre-processing'], ['safety', 'Safety and recovery'], ['dev', 'Server and development']];
const PROVIDERS = ['gemini', 'claude', 'grok', 'openrouter'];

const bad = m => { const e = new Error(m); e.userError = true; return e; };
const script = (label, file, args = []) => ({ label, script: file, args });
const internal = (label, name, args = []) => ({ label, script: 'muse_ops.js', args: ['_do', name, ...args] });

function parseParam(def, raw) {
  const v = raw === undefined || raw === '' ? def.default : raw;
  if (v === undefined || v === null) { if (def.required) throw bad(`${def.name} is required`); return undefined; }
  if (def.type === 'bool') return v === true || v === 'true' || v === '1' || v === 'yes';
  if (def.type === 'int' || def.type === 'number') {
    const n = Number(v); if (!Number.isFinite(n) || (def.type === 'int' && !Number.isInteger(n))) throw bad(`${def.name} must be ${def.type === 'int' ? 'a whole number' : 'a number'}`);
    if ((def.min != null && n < def.min) || (def.max != null && n > def.max)) throw bad(`${def.name} must be between ${def.min} and ${def.max}`); return n;
  }
  if (def.type === 'enum') { if (!def.values.includes(String(v))) throw bad(`${def.name} must be one of ${def.values.join(', ')}`); return String(v); }
  const s = String(v); if (s.length > (def.max || 200)) throw bad(`${def.name} is too long`);
  if (def.pattern && !def.pattern.test(s)) throw bad(`${def.name} has characters that are not allowed`); return s;
}

const vaultPaths = env => {
  const src = env.MUSE_VAULT_SRC || path.join(env.HOME || '', 'md-vaults', 'knowledge'), dst = env.VAULT_PATH || '';
  if (!dst) throw bad('VAULT_PATH is not set: it must point at the copy of the vault that Muse indexes.');
  if (!fs.existsSync(src)) throw bad('The vault source is not there: ' + src);
  if (path.resolve(dst) === path.resolve(src) || path.resolve(dst).startsWith(path.resolve(src) + path.sep)) throw bad('Refusing: VAULT_PATH is the real vault or inside it. It must be a separate copy.');
  if (fs.existsSync(path.join(dst, '.git'))) throw bad('Refusing: ' + dst + ' contains .git. Muse indexes a copy with no git folder.');
  return { src, dst };
};
// The selection and options for a nuggetize run, shared by the plan and by the count a person confirms.
function nuggetArgs(p, ctx) {
  if (p.mode === 'note' && !p.note) throw bad('mode note needs a note id');
  const sel = { limit: ['--limit', String(p.limit)], short: [], all: ['--all'], note: ['--note', String(p.note)], redo: ['--redo'], 'review-list': ['--review-list', path.join(REPORTS(ctx.home), 'review-list.csv')] }[p.mode];
  const filt = [...(p.minWords ? ['--min-words', String(p.minWords)] : []), ...(p.maxWords ? ['--max-words', String(p.maxWords)] : []), ...(p.shuffle ? ['--shuffle'] : [])];
  return { sel: [...sel, ...filt], opts: ['--provider', p.provider, ...(p.ceiling ? ['--ceiling', String(p.ceiling)] : [])] };
}
const REPORTS = home => path.join(home, 'logs', 'reports');
const P = (name, type, label, o = {}) => Object.assign({ name, type, label }, o);

// Each task: id, area, title, does, effect, group, params[], dry (has a dry twin), backup (take one before a real run), needs (what is typed back), build(p, go, ctx) -> steps.
const TASKS = [
  { id: 'status', area: 'status', title: 'Counts and health', does: 'Notes, facts, notes still pending, wordplay, migrations, money spent, backups.', effect: 'read-only', group: null, params: [],
    build: () => [internal('Counts and health', 'status')] },
  { id: 'drift', area: 'status', title: 'Drift check', does: 'Muse map against the code, and the heuristic registry. About a second.', effect: 'read-only', group: null, params: [],
    build: () => [script('Drift check', 'muse_map_check.js')] },
  { id: 'check', area: 'dev', title: 'Full test run', does: 'The drift check and every test. About 16 seconds; the log shows any failure.', effect: 'read-only', group: 'dev', params: [],
    build: () => [script('Drift check', 'muse_map_check.js'), { label: 'Tests', script: null, args: ['--no-warnings', '--test', ...fs.readdirSync(path.join(ROOT, 'test')).filter(f => /\.test\.js$/.test(f)).map(f => path.join('test', f))] }] },
  { id: 'vault-sync', area: 'ingest', title: 'Copy the vault in', does: 'Mirror the real vault into the copy Muse indexes (no .git, no .obsidian). Notes deleted from the vault disappear from the copy.', effect: 'writes files', group: 'db', params: [], dry: true,
    build: (p, go, ctx) => { const v = vaultPaths(ctx.env); return [...(go && !fs.existsSync(v.dst) ? [{ label: 'Make the copy folder', cmd: 'mkdir', args: ['-p', v.dst] }] : []), ...(go ? [] : [internal('What would be copied', 'vault-diff', [v.src, v.dst])]), { label: go ? 'Copy the vault' : 'Copy the vault (dry run)', cmd: 'rsync', args: ['-a', '--delete', '--exclude', '.git', '--exclude', '.obsidian', ...(go ? [] : ['-n', '-i']), v.src + '/', v.dst + '/'] }]; } },
  { id: 'reprocess-edited', area: 'prep', title: 'Re-process edited notes (paid)', does: 'Notes you changed after their facts were extracted: send just those to the model again and replace their facts. Unchanged notes are never touched. The check shows the count and cost; a real run needs the count typed back. A note\'s facts get new ids, so a star on one of them is lost. Afterwards run Flag duplicate facts, Find wordplay and Rebuild search.', effect: 'spends money', group: 'db', dry: true, backup: true, needs: 'count',
    params: [P('provider', 'enum', 'Model provider', { values: PROVIDERS, default: 'gemini', help: 'Use the provider the facts were first extracted with: a note counts as edited when its current text has no saved answer for this provider.' }), P('ceiling', 'number', 'Spending ceiling, USD', { min: 0.01, max: 100 })],
    build: (p, go) => {
      const opts = ['--edited', '--provider', p.provider, ...(p.ceiling ? ['--ceiling', String(p.ceiling)] : [])];
      return [internal('Edited notes', 'candidates', ['--edited', '--provider', p.provider]), script(go ? 'Re-extract facts' : 'Re-extract facts (dry run)', 'nuggetizer.js', [...opts, ...(go ? [] : ['--dry-run'])])];
    },
    expectValue: (p, ctx) => { try { return I.candidates({ dbPath: ctx.dbPath, args: ['--edited', '--provider', p.provider], env: ctx.env, home: ctx.home, log: () => {} }); } catch (e) { throw bad(e.message); } } },
  { id: 'index', area: 'ingest', title: 'Index the vault', does: 'Read the vault copy into vault.db: only what changed (default) or everything.', effect: 'writes DB', group: 'db', dry: true, safe: 'only adds and updates notes from the vault, which can be read in again; the indexer takes its own copy before it removes notes',
    params: [P('mode', 'enum', 'What to index', { values: ['diff', 'full'], default: 'diff', help: 'diff = changed notes only' })],
    build: (p, go) => [script(go ? 'Index' : 'Index (dry run)', 'indexer.js', [p.mode === 'full' ? '--full' : '--diff', ...(go ? [] : ['--dry-run'])])] },
  { id: 'private-scan', area: 'ingest', title: 'Scan for private notes', does: 'List notes that look private so you can review and move them. Never edits or moves a note; evidence is masked.', effect: 'writes files', group: null,
    params: [P('min', 'int', 'Points needed to be listed', { min: 1, max: 20, default: 2 })],
    build: (p, go, ctx) => [script('Scan', 'private_scan.js', ['--vault', ctx.env.VAULT_PATH || path.join(ctx.env.HOME || '', 'md-vaults', 'knowledge'), '--min', String(p.min), '--out', path.join(REPORTS(ctx.home), 'private-candidates.csv')])] },
  { id: 'find-notes', area: 'ingest', title: 'Find notes by pattern', does: 'List notes whose text matches a pattern (id, words, title). For picking a trial note.', effect: 'read-only', group: null,
    params: [P('pattern', 'text', 'Pattern (regular expression)', { required: true, max: 120 }), P('limit', 'int', 'How many', { min: 1, max: 200, default: 15 }), P('minWords', 'int', 'At least this many words', { min: 0, max: 5000, default: 0 })],
    build: p => [script('Find', 'find_notes.js', [p.pattern, '--limit', String(p.limit), ...(p.minWords ? ['--min-words', String(p.minWords)] : [])])] },
  { id: 'migrate', area: 'prep', title: 'Create or update the database', does: 'Make the database if there is none (the tables Muse starts from), then apply every pending migration. Safe to repeat: nothing is ever dropped. The check shows what would be applied.', effect: 'writes DB', group: 'db', dry: true, safe: 'each migration that rewrites a table takes its own copy first (backupFirst); the rest only add columns', params: [],
    build: (p, go) => [script(go ? 'Create or update the database' : 'Check what would change', 'migrate.js', [go ? '--run' : '--status'])] },
  { id: 'nuggetize', area: 'prep', title: 'Extract facts (paid)', does: 'Send pending notes to the model and keep the verified facts. The dry run shows how many notes and the estimated cost; a real run needs that count typed back.', effect: 'spends money', group: 'db', dry: true, backup: p => p.mode === 'note' || p.mode === 'redo', backupNote: 'Only the modes that re-run finished notes (note, redo) back up first, because they replace those notes\' facts. The other modes only fill notes that have none.', safe: 'the other modes only fill notes that have no facts yet', needs: 'count',
    params: [P('mode', 'enum', 'Which notes', { values: ['limit', 'short', 'all', 'note', 'redo', 'review-list'], default: 'limit', help: 'limit = the N shortest pending; short = every pending note under the short-note cut; all = every pending note; note = one note; redo = re-verify from cache; review-list = write a CSV' }),
      P('limit', 'int', 'How many (mode limit)', { min: 1, max: 5000, default: 20 }), P('note', 'int', 'Note id (mode note)', { min: 1 }), P('provider', 'enum', 'Model provider', { values: PROVIDERS, default: 'gemini' }),
      P('ceiling', 'number', 'Spending ceiling, USD', { min: 0.01, max: 100 }), P('minWords', 'int', 'Only notes with at least this many words', { min: 0, max: 5000 }),
      P('maxWords', 'int', 'Short-note cut, words', { min: 1, max: 5000 }), P('shuffle', 'bool', 'Spread the trial out', { default: false })],
    build: (p, go, ctx) => {
      const free = p.mode === 'review-list', a = nuggetArgs(p, ctx);
      return [internal('Notes to process', 'candidates', a.sel), script(go || free ? 'Extract facts' : 'Extract facts (dry run)', 'nuggetizer.js', [...a.sel, ...a.opts, ...(go || free ? [] : ['--dry-run'])])];
    },
    expectValue: (p, ctx) => p.mode === 'review-list' ? null : I.candidates({ dbPath: ctx.dbPath, args: nuggetArgs(p, ctx).sel, log: () => {} }) },
  { id: 'dedupe', area: 'prep', title: 'Flag duplicate facts', does: 'Report duplicates (default), record the flags, or clear them. No fact is ever deleted. Free.', effect: 'writes DB', group: 'db', safe: 'only the duplicate flags change, and a re-run rebuilds them; no fact is deleted', dry: true,
    params: [P('mode', 'enum', 'Real run does', { values: ['apply', 'undo'], default: 'apply' })],
    build: (p, go) => [script(go ? (p.mode === 'undo' ? 'Clear flags' : 'Record flags') : 'Duplicate report', 'dedupe.js', go ? [p.mode === 'undo' ? '--undo' : '--apply'] : [])] },
  { id: 'wordplay', area: 'prep', title: 'Find wordplay', does: 'Report wordplay pairs (default), store them, or clear them. Free; needs the pronunciation dictionary for rhymes and sound-alikes.', effect: 'writes DB', group: 'db', safe: 'only the wordplay table changes, and a re-run rebuilds it', dry: true,
    params: [P('mode', 'enum', 'Real run does', { values: ['apply', 'undo'], default: 'apply' })],
    build: (p, go) => [script(go ? (p.mode === 'undo' ? 'Clear wordplay' : 'Store wordplay') : 'Wordplay report', 'wordplay.js', go ? [p.mode === 'undo' ? '--undo' : '--apply'] : [])] },
  { id: 'heuristics', area: 'prep', title: 'Heuristic registry', does: 'Check the registry against its source (default), or rebuild it.', effect: 'writes files', group: null, dry: true, params: [],
    build: (p, go) => [script(go ? 'Rebuild the registry' : 'Check the registry', 'heuristics_build.js', go ? [] : ['--check'])] },
  { id: 'search-build', area: 'prep', title: 'Rebuild search by meaning', does: 'Compute vectors for new or changed facts (needs the embedding server), or use only what is cached. Safe to repeat.', effect: 'writes files', group: 'search',
    params: [P('noEmbed', 'bool', 'Cached vectors only, no embedding server', { default: false })],
    build: p => [script('Build vectors', 'search_build.js', p.noEmbed ? ['--no-embed'] : [])] },
  { id: 'refresh', area: 'ingest', title: 'Bring Muse up to date', does: 'Copy the vault in, index what changed, then count the new notes waiting and the notes you have edited, and estimate the cost. Stops before anything paid.', effect: 'writes DB', group: 'db', dry: true, safe: 'copies files, then indexes; the indexer takes its own copy before it removes notes', params: [],
    build: (p, go, ctx) => [...byId('vault-sync').build({}, go, ctx), ...byId('index').build({ mode: 'diff' }, go, ctx), internal('Notes waiting', 'candidates', ['--all']), internal('Edited notes waiting', 'candidates', ['--edited']), script('Estimate the cost', 'nuggetizer.js', ['--all', '--dry-run'])] },
  { id: 'refresh-process', area: 'prep', title: 'Process what is waiting (paid)', does: 'Extract facts from every pending note, then flag duplicates, store wordplay, rebuild search. Needs the pending count typed back.', effect: 'spends money', group: 'db', dry: true, safe: 'fills notes that have no facts yet, then rebuilds flags, wordplay and the search index; nothing existing is replaced', needs: 'count',
    params: [P('provider', 'enum', 'Model provider', { values: PROVIDERS, default: 'gemini' }), P('ceiling', 'number', 'Spending ceiling, USD', { min: 0.01, max: 100 })],
    build: (p, go) => {
      const opts = ['--provider', p.provider, ...(p.ceiling ? ['--ceiling', String(p.ceiling)] : [])];
      return go ? [internal('Notes to process', 'candidates', ['--all']), script('Extract facts', 'nuggetizer.js', ['--all', ...opts]), script('Record duplicate flags', 'dedupe.js', ['--apply']), script('Store wordplay', 'wordplay.js', ['--apply']), script('Build vectors', 'search_build.js', [])]
        : [internal('Notes to process', 'candidates', ['--all']), script('Extract facts (dry run)', 'nuggetizer.js', ['--all', '--dry-run', ...opts]), script('Duplicate report', 'dedupe.js', []), script('Wordplay report', 'wordplay.js', [])];
    },
    expectValue: (p, ctx) => I.candidates({ dbPath: ctx.dbPath, args: ['--all'], log: () => {} }) },
  { id: 'backup', area: 'safety', title: 'Back up the database now', does: 'A consistent, timestamped copy of vault.db beside it.', effect: 'writes files', group: null,
    params: [P('reason', 'text', 'Name tag (letters, digits, dashes)', { max: 24, pattern: /^[A-Za-z0-9-]*$/, default: 'manual' })],
    build: p => [internal('Back up', 'backup', [p.reason])] },
  { id: 'backups-prune', area: 'safety', title: 'Delete old backups', does: 'Keep the newest N backups; the dry run lists what would go.', effect: 'writes files', group: 'db', dry: true, needs: 'count',
    params: [P('keep', 'int', 'Keep the newest', { min: 1, max: 100, default: 5 })],
    build: (p, go) => [internal(go ? 'Delete old backups' : 'Old backups (dry run)', 'prune', [String(p.keep), go ? 'go' : 'dry'])],
    expectValue: (p, ctx) => Math.max(0, I.listBackups(ctx.home).length - p.keep) },
  { id: 'restore', area: 'safety', title: 'Restore a backup', does: 'Replace vault.db with a backup. The current database is backed up first, so this can be undone. Restart Muse afterwards.', effect: 'writes DB', group: 'db', dry: true, needs: 'name',
    params: [P('name', 'text', 'Backup name', { required: true, max: 80, pattern: I.BACKUP_RE })],
    build: (p, go) => [internal(go ? 'Restore' : 'Restore (dry run)', 'restore', [p.name, go ? 'go' : 'dry'])],
    expectValue: p => p.name },
  { id: 'clean-leftovers', area: 'safety', title: 'Clear stale journals and interrupted files', does: 'Delete *.journal, *.interrupted-* and *.stale-* files left by interrupted runs.', effect: 'writes files', group: 'db', dry: true, needs: 'count', params: [],
    build: (p, go) => [internal(go ? 'Delete leftovers' : 'Leftovers (dry run)', 'clean', [go ? 'go' : 'dry'])],
    expectValue: (p, ctx) => I.leftovers(ctx.home).length }
];
const TASK = new Map(TASKS.map(t => [t.id, t]));
function byId(id) { return TASK.get(id); }

// What the front doors may show: no functions.
const describe = t => ({ id: t.id, area: t.area, title: t.title, does: t.does, effect: t.effect, group: t.group, dry: !!t.dry, backup: !!t.backup, backupNote: t.backupNote || null, safe: t.safe || null, needs: t.needs || null, params: t.params.map(({ pattern, ...d }) => d) });
// The order a person works in, for the two situations Admin serves. The server owns this, so the page, the CLI and any bot calling the API all see the same order; a front
// door only draws it. A step is { task, why } or { note, ... } for something done outside Admin. A group with `ordered` is numbered 1, 2, 3. A task may appear in more than
// one place. Every task that is not shown elsewhere on the page must appear in the Ongoing view (test/muse_ops.test.js checks), so a new task cannot vanish from Admin.
const ON_PAGE = ['status', 'drift'];   // shown as the status strip and the drift button, not as task cards
const FLOWS = {
  setup: {
    id: 'setup', title: 'Initial setup',
    hint: 'A new install: you have a markdown vault and no database yet. Do these once, in order. Every step checks first and shows what it would do.',
    groups: [{ id: 'setup-steps', title: 'Set up Muse', ordered: true, steps: [
      { task: 'migrate', why: 'Makes the database and every table in it. Nothing else can run before this.' },
      { task: 'vault-sync', why: 'Copies your vault into the folder Muse reads (without .git and .obsidian).' },
      { task: 'index', why: 'Reads the copy into the database: titles, tags, word counts.' },
      { task: 'private-scan', why: 'Optional, advised before the first paid step: lists notes that look private so you can exclude them before anything is sent to a model.' },
      { task: 'nuggetize', why: 'A small trial first (the 20 shortest notes by default). Read what it extracts before you spend more.' },
      { task: 'refresh-process', why: 'Then everything waiting, plus duplicate flags, wordplay and the search index. Paid; you type the count back.' },
      { task: 'heuristics', why: 'Checks the heuristic registry against its source.' },
      { task: 'backup', why: 'A first safety copy of the finished database.' }] }]
  },
  ongoing: {
    id: 'ongoing', title: 'Ongoing maintenance',
    hint: 'For an install that is already set up: bring in new notes, process them, and see them in Muse.',
    groups: [
      { id: 'routine', title: 'Your routine', hint: 'After you add notes in Obsidian, daily or weekly.', ordered: true, steps: [
        { task: 'refresh', why: 'Copies the vault in, indexes what changed, then counts the new notes waiting and the notes you have edited, and estimates the cost. Stops before anything paid.' },
        { task: 'refresh-process', why: 'Only if notes are waiting. Extracts facts, flags duplicates, stores wordplay and rebuilds search. Paid; you type the count back.' },
        { task: 'reprocess-edited', why: 'Only if the check above found edited notes. Re-sends just those, never the unchanged ones. Paid; you type the count back.' },
        { note: 'restart', title: 'Restart Muse', why: 'Muse loads its facts when it starts, so new ones appear after a restart: run `muse restart`. This page tells you when it is behind the database.' }] },
      { id: 'sometimes', title: 'Now and then', hint: 'Useful, but not part of every round.', tasks: ['backup', 'find-notes', 'private-scan'] },
      { id: 'update', title: 'After an update', hint: 'When you have deployed new code.', tasks: ['migrate', 'search-build', 'heuristics'] },
      { id: 'care', title: 'Recovery and cleanup', hint: 'Rare: something went wrong, or the backups folder is full.', tasks: ['backups-prune', 'restore', 'clean-leftovers', 'check'] },
      { id: 'pieces', title: 'Individual steps', hint: 'The parts of the routine, one at a time, for options such as redo or a single note.', collapsed: true, tasks: ['vault-sync', 'index', 'nuggetize', 'dedupe', 'wordplay'] }]
  }
};
const catalogue = () => ({ areas: AREAS.map(([id, title]) => ({ id, title })), tasks: TASKS.map(describe), onPage: ON_PAGE, flows: FLOWS });

// Validate and plan. Returns { task, params, go, dry, effect, group, steps } or throws an Error with userError set.
function plan(id, rawParams = {}, { go = false, expect = null, ctx }) {
  const t = TASK.get(id); if (!t) throw bad('Unknown task: ' + id);
  const known = new Set(t.params.map(d => d.name)); Object.keys(rawParams || {}).forEach(k => { if (!known.has(k)) throw bad(`${id} has no parameter ${k}`); });
  const p = {}; t.params.forEach(d => { const v = parseParam(d, (rawParams || {})[d.name]); if (v !== undefined) p[d.name] = v; });
  if (go && !t.dry) throw bad(`${id} has no dry run; just run it without --go`);
  if (t.dry && go && t.needs) {
    const want = t.expectValue ? t.expectValue(p, ctx) : null;
    if (want === 0) throw bad('Nothing to do: the count is 0.');
    if (want !== null && String(expect) !== String(want)) throw bad(`Confirmation needed: this affects ${want}. Pass the number or name you saw (--expect ${want}) to go ahead. It may have changed since you looked.`);
  }
  const wantsBackup = typeof t.backup === 'function' ? !!t.backup(p) : !!t.backup;   // always, never, or only when this run replaces something that cannot be rebuilt
  const pre = wantsBackup && t.dry && go ? [internal('Back up first', 'backup', ['before-' + t.id])] : [];
  return { task: t.id, params: p, go: !!go, dry: !!t.dry && !go, effect: t.effect, group: t.group, steps: [...pre, ...t.build(p, !!go, ctx)] };
}

module.exports = { TASKS, TASK, AREAS, FLOWS, ON_PAGE, catalogue, plan, describe, bad, ROOT };
