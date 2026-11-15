'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const Cat = require('../code/lib/ops_catalogue'), I = require('../code/lib/ops_internal'), { createJobs } = require('../code/lib/ops_jobs');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ops-')), dbPath = path.join(home, 'vault.db'), db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE vault_notes(id INTEGER PRIMARY KEY, rel_path TEXT, title TEXT, source_url TEXT, word_count INTEGER, quarry_exclude INTEGER); CREATE TABLE nuggetize_status(note_id INTEGER, prompt_version TEXT, status TEXT); CREATE TABLE burrs(id INTEGER PRIMARY KEY, prompt_version TEXT);
    CREATE TABLE schema_migrations(id INTEGER); CREATE TABLE wordplay_edges(id INTEGER); CREATE TABLE api_budget(cost_usd REAL);
    INSERT INTO vault_notes VALUES (1,'a','A',NULL,50,0),(2,'b','B',NULL,60,0),(3,'c','C',NULL,70,0),(4,'d','D',NULL,500,0),(5,'e','E',NULL,80,1); INSERT INTO nuggetize_status VALUES (1,'nug-v6','ok'),(2,'nug-v6','empty'); INSERT INTO schema_migrations VALUES (14);`);
  db.close(); const src = path.join(home, 'real'), dst = path.join(home, 'copy'); fs.mkdirSync(src); fs.mkdirSync(dst);
  return { home, dbPath, version: 'nug-v6', src, dst, env: { HOME: home, MUSE_VAULT_SRC: src, VAULT_PATH: dst } };
}
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('ops catalogue: every task is wired to a real script, and the safety rules are declared', () => {
  const ids = Cat.TASKS.map(t => t.id); assert.strictEqual(new Set(ids).size, ids.length, 'ids are unique');
  const areas = new Set(Cat.AREAS.map(a => a[0])), f = fixture();
  Cat.TASKS.forEach(t => {
    assert.ok(areas.has(t.area), t.id + ' has a known area'); assert.ok(t.title && t.does, t.id + ' says what it does');
    assert.ok(['read-only', 'writes files', 'writes DB', 'spends money'].includes(t.effect), t.id + ' declares its effect');
    if (t.needs) assert.ok(t.expectValue && t.dry, t.id + ' asks for confirmation only when it has a dry twin and a value to check');
    if (t.effect === 'spends money') assert.ok(t.needs && t.dry && (t.backup || t.safe), t.id + ': paid tasks have a dry run, a typed confirmation, and either a backup or a stated reason none is needed');
    if (t.effect === 'writes DB') assert.ok(t.backup || (t.safe && t.safe.length > 20) || t.id === 'restore', t.id + ': a task that writes the database backs up first, or says why what it writes can be rebuilt (restore does its own)');
    const steps = Cat.plan(t.id, t.id === 'find-notes' ? { pattern: 'x' } : t.id === 'restore' ? { name: 'vault.db.bak-1' } : {}, { ctx: { home: f.home, dbPath: f.dbPath, version: f.version, env: f.env } }).steps;
    steps.forEach(s => { if (s.script) assert.ok(fs.existsSync(path.join(__dirname, '..', 'code', s.script)), t.id + ' uses a script that exists: ' + s.script); });
  });
});

const ctxOf = f => ({ home: f.home, dbPath: f.dbPath, version: f.version, env: f.env });
const err = fn => { try { fn(); } catch (e) { return e; } return null; };

test('ops plan: a task with a dry twin only dries unless told to go, and every input is checked', () => {
  const f = fixture(), c = ctxOf(f);
  const dry = Cat.plan('index', {}, { ctx: c }); assert.strictEqual(dry.dry, true); assert.ok(dry.steps.some(s => s.args.includes('--dry-run')) && !dry.steps.some(s => /backup/.test(s.args.join(' '))), 'a dry run neither writes nor backs up');
  const real = Cat.plan('index', { mode: 'full' }, { go: true, ctx: c }); assert.strictEqual(real.dry, false);
  assert.deepStrictEqual(real.steps.map(s => s.args[0]), ['--full'], 'a real index run does not back up first: it only adds and updates notes, and the indexer snapshots before it removes any'); assert.ok(!real.steps.some(x => /backup/.test(x.args.join(' '))));
  assert.match(err(() => Cat.plan('index', { mode: 'sideways' }, { ctx: c })).message, /one of diff, full/);
  assert.match(err(() => Cat.plan('index', { colour: 'red' }, { ctx: c })).message, /no parameter colour/);
  assert.match(err(() => Cat.plan('nuggetize', { limit: '2.5' }, { ctx: c })).message, /whole number/);
  assert.match(err(() => Cat.plan('nuggetize', { limit: '999999' }, { ctx: c })).message, /between/);
  assert.match(err(() => Cat.plan('nuggetize', { mode: 'note' }, { ctx: c })).message, /note id/);
  assert.match(err(() => Cat.plan('status', {}, { go: true, ctx: c })).message, /no dry run/);
  assert.match(err(() => Cat.plan('find-notes', {}, { ctx: c })).message, /required/);
  assert.match(err(() => Cat.plan('backup', { reason: 'a b; rm -rf' }, { ctx: c })).message, /not allowed/);
  assert.match(err(() => Cat.plan('nope', {}, { ctx: c })).message, /Unknown task/);
});

test('ops plan: re-processing edited notes is its own paid task: check first, count typed back, never part of another task\'s real run', () => {
  const f = fixture(), c = ctxOf(f);
  { const w = new DatabaseSync(f.dbPath); w.exec('ALTER TABLE vault_notes ADD COLUMN file_mtime TEXT; ALTER TABLE nuggetize_status ADD COLUMN at TEXT'); w.close(); }   // the fixture is a minimal schema; the real one has both
  const bare = Object.assign({}, c, { env: {}, home: fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ed-home-')) });
  const miss = err(() => Cat.plan('reprocess-edited', {}, { go: true, expect: 0, ctx: bare })); assert.ok(miss && miss.userError); assert.match(miss.message, /VAULT_PATH/, 'without a vault copy folder the refusal says what is missing');
  c.env = Object.assign({}, c.env, { VAULT_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ed-')) });
  const t = Cat.catalogue().tasks.find(x => x.id === 'reprocess-edited'); assert.ok(t && t.dry && t.needs === 'count' && t.effect === 'spends money' && t.backup);
  const dry = Cat.plan('reprocess-edited', {}, { ctx: c }); assert.ok(dry.dry);
  assert.ok(dry.steps.some(s => s.args && s.args.includes('--edited') && s.args.includes('--dry-run')), 'the check passes --dry-run');
  assert.ok(dry.steps.some(s => s.args && s.args[0] === '_do' && s.args.includes('--edited')), 'and counts the edited notes first');
  for (const expect of [undefined, 0]) { const e = err(() => Cat.plan('reprocess-edited', {}, { go: true, expect, ctx: c })); assert.ok(e && e.userError); assert.match(e.message, /Nothing to do/, 'with no edited notes a real run is refused, whatever number is typed'); }
  const real = Cat.TASK.get('reprocess-edited').build({ provider: 'gemini' }, true, c); assert.ok(real.some(s => s.args && s.args.includes('--edited') && !s.args.includes('--dry-run')), 'the real run steps drop --dry-run');
  for (const id of ['refresh', 'refresh-process', 'nuggetize']) assert.ok(!Cat.plan(id, id === 'nuggetize' ? { mode: 'all' } : {}, { ctx: c }).steps.some(s => s.args && s.args.includes('--edited') && !s.args.includes('--dry-run') && s.script === 'nuggetizer.js'), id + ' never re-processes edited notes by itself');
});
test('ops plan: a paid run needs the count the person saw, and is refused if the count has changed', () => {
  const f = fixture(), c = ctxOf(f);   // 5 notes, 2 done: 3 pending
  assert.strictEqual(I.pendingNotes(f.dbPath, f.version), 3);   // notes minus done; the run itself skips the excluded note and, by default, long ones
  assert.strictEqual(I.candidates({ dbPath: f.dbPath, args: ['--all'], log() {} }), 2, 'the number to confirm is what the script would process: 3 and 4 (5 is excluded)');
  assert.strictEqual(I.candidates({ dbPath: f.dbPath, args: [], log() {} }), 1, 'by default only short notes');
  const e = err(() => Cat.plan('nuggetize', { mode: 'all' }, { go: true, ctx: c })); assert.ok(e && e.userError); assert.match(e.message, /affects 2/);
  assert.match(err(() => Cat.plan('nuggetize', { mode: 'all' }, { go: true, expect: 4, ctx: c })).message, /affects 2/, 'a stale number is refused');
  const ok = Cat.plan('nuggetize', { mode: 'all' }, { go: true, expect: 2, ctx: c }); assert.ok(ok.steps.some(s => s.args.includes('--all') && !s.args.includes('--dry-run')));
  assert.ok(Cat.plan('nuggetize', { mode: 'limit', limit: 1 }, { go: true, expect: '1', ctx: c }), 'a limit below the count confirms against the limit');
  assert.match(err(() => Cat.plan('refresh-process', {}, { go: true, ctx: c })).message, /affects 2/);
  assert.ok(Cat.plan('refresh-process', {}, { go: true, expect: 2, ctx: c }).steps.length === 5, 'count, extract, dedupe, wordplay, search (it only fills notes with no facts, so no backup)');
  assert.ok(Cat.plan('nuggetize', { mode: 'all' }, { ctx: c }).dry, 'asking without go never needs a number');
});

test('a stub (under 3 words) is not waiting work, so no paid run is asked for it', () => {
  const f = fixture(), db = new DatabaseSync(f.dbPath);
  db.exec("INSERT INTO vault_notes VALUES (6,'f','Untitled',NULL,0,0),(7,'g','Two',NULL,2,0),(8,'h','Three',NULL,3,0)"); db.close();
  assert.strictEqual(I.candidates({ dbPath: f.dbPath, args: ['--all'], log() {} }), 3, 'notes 3, 4 and the 3-word note; the 0- and 2-word stubs are left out');
});

test('ops plan: the vault copy is never the real vault, never a git folder', () => {
  const f = fixture(), c = ctxOf(f);
  assert.match(err(() => Cat.plan('vault-sync', {}, { ctx: { ...c, env: { ...f.env, VAULT_PATH: f.src } } })).message, /real vault/);
  fs.mkdirSync(path.join(f.dst, '.git')); assert.match(err(() => Cat.plan('vault-sync', {}, { ctx: c })).message, /\.git/);
  fs.rmdirSync(path.join(f.dst, '.git')); assert.match(err(() => Cat.plan('vault-sync', {}, { ctx: { ...c, env: { ...f.env, VAULT_PATH: '' } } })).message, /VAULT_PATH is not set/);
  { const f2 = fixture(), c2 = ctxOf(f2); fs.rmSync(f2.dst, { recursive: true, force: true });
    const real = Cat.plan('vault-sync', {}, { go: true, ctx: c2 }).steps; assert.strictEqual(real[0].cmd, 'mkdir'); assert.strictEqual(real[1].cmd, 'rsync');
    const dry = Cat.plan('vault-sync', {}, { ctx: c2 }).steps; assert.ok(!dry.some(x => x.cmd === 'mkdir'), 'a dry run makes nothing'); assert.ok(dry.some(x => x.cmd === 'rsync' && x.args.includes('-n'))); }
  const dry = Cat.plan('vault-sync', {}, { ctx: c }).steps.find(x => x.cmd === 'rsync'); assert.ok(dry.args.includes('-n') && dry.args.includes('--exclude') && dry.args.includes('.git'));
});

test('ops internal: backup, prune, restore and clean do what they say, and restore can itself be undone', () => {
  const f = fixture(), log = []; const L = s => log.push(s), b = { home: f.home, dbPath: f.dbPath, log: L };
  const n1 = I.backup({ ...b, reason: 'First One', now: new Date(2026, 9, 1, 10, 0, 0) }), n2 = I.backup({ ...b, reason: 'x', now: new Date(2026, 9, 2, 10, 0, 0) });
  assert.match(n1, /^vault\.db\.bak-20261001-100000-firstone$/); fs.utimesSync(path.join(f.home, n1), new Date(2026, 9, 1), new Date(2026, 9, 1)); fs.utimesSync(path.join(f.home, n2), new Date(2026, 9, 2), new Date(2026, 9, 2));
  assert.deepStrictEqual(I.prune({ ...b, keep: 1 }), [n1], 'a dry prune lists the oldest'); assert.ok(fs.existsSync(path.join(f.home, n1)), 'and deletes nothing');
  I.prune({ ...b, keep: 1, go: true }); assert.ok(!fs.existsSync(path.join(f.home, n1)) && fs.existsSync(path.join(f.home, n2)));
  const db = new DatabaseSync(f.dbPath); db.exec("INSERT INTO vault_notes VALUES (6,'f','F',NULL,10,0)"); db.close();
  assert.strictEqual(I.restore({ ...b, name: n2 }), null, 'a dry restore changes nothing');
  const saved = I.restore({ ...b, name: n2, go: true }); const chk = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.strictEqual(chk.prepare('SELECT COUNT(*) n FROM vault_notes').get().n, 5, 'the backup is back'); chk.close();
  const old = new DatabaseSync(path.join(f.home, saved), { readOnly: true }); assert.strictEqual(old.prepare('SELECT COUNT(*) n FROM vault_notes').get().n, 6, 'the database it replaced is kept'); old.close();
  assert.throws(() => I.restore({ ...b, name: '../vault.db' }), /Not a backup name/);
  fs.writeFileSync(path.join(f.home, 'vault.db-journal.stale-1'), 'x'); assert.deepStrictEqual(I.clean({ ...b }), ['vault.db-journal.stale-1']); I.clean({ ...b, go: true });
  assert.deepStrictEqual(I.leftovers(f.home), []);
});

test('ops jobs: a job runs detached, leaves a log and a state, and tasks in one group never overlap', async () => {
  const f = fixture(), jobs = createJobs({ home: f.home, dbPath: f.dbPath, version: f.version, env: f.env });
  const j = jobs.start('status', {}); assert.strictEqual(j.state, 'running');
  const done = await waitFor(() => { const g = jobs.get(j.id); return g && g.state !== 'running' ? g : null; });
  assert.strictEqual(done.state, 'done'); assert.match(jobs.tail(j.id), /Notes: 5\s+Facts \(nug-v6\): 0\s+Not yet processed: 3\s+Ready to process: 2/);
  const b = jobs.start('backup', { reason: 'job' }); await waitFor(() => jobs.get(b.id).state !== 'running');
  assert.strictEqual(jobs.get(b.id).state, 'done'); assert.strictEqual(I.listBackups(f.home).length, 1);
  // a runner that is "running" blocks its group; a runner that vanished becomes "lost" and no longer blocks
  const meta = { id: '20261031-120000-index', task: 'index', params: {}, go: true, dry: false, effect: 'writes DB', group: 'db', steps: [{ label: 'x' }], step: 0, state: 'running', pid: process.pid, started: new Date().toISOString(), finished: null, code: null };
  fs.writeFileSync(path.join(f.home, 'logs', 'jobs', meta.id + '.json'), JSON.stringify(meta));
  const clash = err(() => jobs.start('clean-leftovers', {})); assert.ok(clash && clash.userError && clash.conflict === meta.id, 'the second db task is refused'); assert.match(clash.message, /same data/);
  assert.ok(jobs.start('status', {}), 'a read-only task is not blocked');
  fs.writeFileSync(path.join(f.home, 'logs', 'jobs', meta.id + '.json'), JSON.stringify({ ...meta, pid: 2 ** 22 + 7, started: new Date(Date.now() - 60000).toISOString() }));
  assert.strictEqual(jobs.get(meta.id).state, 'lost'); assert.ok(jobs.start('clean-leftovers', {}), 'a lost job no longer blocks');
  assert.strictEqual(jobs.get('../../etc/passwd'), null, 'ids are checked');
});

test('ops endpoints: the same jobs over HTTP, behind the X-Muse header, with clear refusals', async () => {
  const http = require('node:http'), { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks'), { fakeModel, fakeNotes } = require('./helpers/muse_fake');
  const f = fixture(), ops = createJobs({ home: f.home, dbPath: f.dbPath, version: f.version, env: f.env });
  const srv = createServer({ model: fakeModel(), marks: K.open(path.join(f.home, 'm.jsonl'), 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), admin: { status: () => ({}), runDrift: async () => ({}) }, ops });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (p, method = 'GET', body = null, h = { 'X-Muse': '1' }) => new Promise(r => { const data = body ? JSON.stringify(body) : null;
    const q = http.request({ port, path: p, method, headers: { Host: 'localhost:' + port, ...(data ? { 'Content-Type': 'application/json' } : {}), ...h } }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => r({ code: res.statusCode, body: JSON.parse(b) })); }); q.end(data); });
  try {
    assert.strictEqual((await call('/api/admin/ops', 'GET', null, {})).code, 403, 'no header, no access');
    assert.strictEqual((await call('/api/admin/jobs', 'POST', { task: 'status' }, {})).code, 403);
    const cat = await call('/api/admin/ops'); assert.strictEqual(cat.code, 200); assert.ok(cat.body.tasks.length >= 15 && cat.body.areas.length === 5); assert.strictEqual(cat.body.pending, 2);
    assert.ok(cat.body.tasks.every(t => !('build' in t) && t.params.every(p => !('pattern' in p))), 'no functions or patterns leak');
    const bad = await call('/api/admin/jobs', 'POST', { task: 'nuggetize', params: { mode: 'all' }, go: true }); assert.strictEqual(bad.code, 400); assert.match(bad.body.error, /affects 2/);
    assert.strictEqual((await call('/api/admin/jobs', 'POST', { task: 'index', params: { mode: 'x' } })).code, 400);
    assert.strictEqual((await call('/api/admin/jobs', 'POST', 'not an object')).code, 400);
    const made = await call('/api/admin/jobs', 'POST', { task: 'status' }); assert.strictEqual(made.code, 201);
    const id = made.body.job.id; await waitFor(() => ops.get(id).state !== 'running');
    const one = await call('/api/admin/jobs/' + id + '?tail=50'); assert.strictEqual(one.body.job.state, 'done'); assert.match(one.body.log, /Ready to process: 2/);
    assert.ok((await call('/api/admin/jobs')).body.jobs.some(j => j.id === id));
    assert.strictEqual((await call('/api/admin/jobs/nosuchjob123')).code, 404);
    assert.strictEqual((await call('/api/admin/jobs/nosuchjob123/cancel', 'POST', {})).code, 400);
  } finally { srv.close(); }
});

test('the catalogue places every task in the Ongoing view, every step in a flow is a real task, and each flow reads in a sensible order', () => {
  const ids = new Set(Cat.TASKS.map(t => t.id)), c = Cat.catalogue(), placed = id => c.flows.ongoing.groups.some(g => (g.tasks || []).includes(id) || (g.steps || []).some(s => s.task === id));
  for (const f of Object.values(c.flows)) for (const g of f.groups) { for (const t of (g.tasks || [])) assert.ok(ids.has(t), 'unknown task ' + t); for (const s of (g.steps || [])) assert.ok(s.note || ids.has(s.task), 'unknown step ' + s.task); }
  assert.deepStrictEqual([...ids].filter(id => !placed(id) && !c.onPage.includes(id)), [], 'no task can disappear from the page');
  const setup = c.flows.setup.groups[0].steps.map(s => s.task);
  assert.ok(setup.indexOf('migrate') < setup.indexOf('vault-sync') && setup.indexOf('vault-sync') < setup.indexOf('index') && setup.indexOf('index') < setup.indexOf('nuggetize') && setup.indexOf('nuggetize') < setup.indexOf('refresh-process'), 'a new install runs: database, copy, index, trial, the rest');
  assert.ok(setup.indexOf('private-scan') > setup.indexOf('index') && setup.indexOf('private-scan') < setup.indexOf('nuggetize'), 'the private scan comes before anything is sent to a model');
  const routine = c.flows.ongoing.groups[0].steps; assert.deepStrictEqual(routine.map(s => s.task || s.note), ['refresh', 'refresh-process', 'reprocess-edited', 'restart'], 'the weekly routine: bring in, process, re-process edited (its own step), restart');
});

test('setup state: no database is "setup"; a database with notes and facts is "ongoing"; done marks follow what is in the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-setup-')), dbPath = path.join(dir, 'vault.db'); let s = I.setupState({ dbPath, home: dir });
  assert.strictEqual(s.database, false); assert.strictEqual(s.suggested, 'setup'); assert.strictEqual(s.done.migrate, false);
  const db = new DatabaseSync(dbPath); db.exec('CREATE TABLE schema_migrations(id TEXT); INSERT INTO schema_migrations VALUES (\'M001\'); CREATE TABLE vault_notes(id INTEGER); INSERT INTO vault_notes VALUES (1);'); db.close();
  s = I.setupState({ dbPath, home: dir }); assert.strictEqual(s.suggested, 'setup', 'notes but no facts yet is still setup'); assert.ok(s.done.migrate && s.done.index && !s.done.nuggetize);
  const d2 = new DatabaseSync(dbPath); d2.exec('CREATE TABLE burrs(id INTEGER); INSERT INTO burrs VALUES (1);'); d2.close();
  assert.strictEqual(I.setupState({ dbPath, home: dir }).suggested, 'ongoing');
});

test('vault copy check: says in numbers what would be copied, and says when the copy is up to date', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-vd-')), src = path.join(base, 'src'), dst = path.join(base, 'dst');
  fs.mkdirSync(path.join(src, '.git'), { recursive: true }); fs.mkdirSync(path.join(src, '.obsidian')); fs.mkdirSync(path.join(src, '2026'), { recursive: true });
  fs.writeFileSync(path.join(src, '.git', 'x'), 'ignored'); fs.writeFileSync(path.join(src, '2026', 'a.md'), 'aaa'); fs.writeFileSync(path.join(src, 'b.md'), 'bbb');
  const lines = [], run = () => I.vaultDiff({ src, dst, log: l => lines.push(l) });
  assert.deepStrictEqual(run(), { new: 2, changed: 0, gone: 0, same: 0 }, 'no copy yet: everything is new, .git and .obsidian are skipped');
  fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true }); fs.rmSync(path.join(dst, '.git'), { recursive: true }); fs.rmSync(path.join(dst, '.obsidian'), { recursive: true });
  lines.length = 0; assert.deepStrictEqual(run(), { new: 0, changed: 0, gone: 0, same: 2 }); assert.match(lines[0], /copy is up to date: 2 file/);
  fs.writeFileSync(path.join(src, 'b.md'), 'bbbb longer'); fs.writeFileSync(path.join(src, 'c.md'), 'new'); fs.rmSync(path.join(src, '2026', 'a.md'));
  lines.length = 0; assert.deepStrictEqual(run(), { new: 1, changed: 1, gone: 1, same: 0 }); assert.match(lines[0], /add 1, update 1 and remove 1/);
  const t = Cat.TASK.get('vault-sync'), env = { MUSE_VAULT_SRC: src, VAULT_PATH: dst };
  assert.ok(t.build({}, false, { env, home: base }).some(s => s.args && s.args.includes('vault-diff')), 'the check shows the numbers'); assert.ok(!t.build({}, true, { env, home: base }).some(s => s.args && s.args.includes('vault-diff')), 'a real copy does not need them');
});

test('internal candidates step receives its flags (regression: --edited was stripped)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'code', 'muse_ops.js'), 'utf8');
  assert.match(src, /name === 'candidates'\) I\.candidates\(\{ dbPath: DB, args: argv\.slice\(2\)/, 'candidates must get the raw tokens, not the flag-stripped positionals');
});

test('backup policy: only steps that can destroy non-rebuildable data back up first', () => {
  const f = fixture(), c = ctxOf(f), has = steps => steps.some(x => x.args.includes('backup'));
  assert.ok(Cat.TASK.get('reprocess-edited').backup, 're-processing edited notes replaces facts, so it always backs up');
  assert.strictEqual(typeof Cat.TASK.get('nuggetize').backup, 'function', 'nuggetize backs up only in the modes that replace finished notes');
  const T = Cat.TASK.get('nuggetize'); assert.ok(T.backup({ mode: 'note' }) && T.backup({ mode: 'redo' }) && !T.backup({ mode: 'limit' }) && !T.backup({ mode: 'all' }) && !T.backup({ mode: 'short' }));
  ['index', 'migrate', 'dedupe', 'wordplay', 'refresh', 'refresh-process'].forEach(id => { const t = Cat.TASK.get(id); assert.ok(!t.backup && t.safe, id + ' carries its reason instead of a backup'); });
  assert.ok(Cat.TASK.get('backup') && Cat.TASK.get('restore'), 'the explicit Back up button and Restore remain');
});
