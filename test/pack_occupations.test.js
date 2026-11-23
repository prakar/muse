'use strict';
// The occupation drop-down on Help: a list of names (core data), marked installed from what is on disk, and guidance that never switches anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), { pathToFileURL } = require('url'), { execFileSync } = require('child_process');
const Pack = require('../code/lib/pack');
const ROOT = path.join(__dirname, '..');
const guideModule = () => import(pathToFileURL(path.join(ROOT, 'code', 'muse_ui', 'js', 'pack_guide.mjs')).href);

test('the suggested occupations are plain names with unique ids, and name no pack content', () => {
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'code', 'data', 'occupations.json'), 'utf8')).rows;
  assert.ok(rows.length >= 10);
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length);
  rows.forEach((r) => { assert.ok(/^[a-z][a-z0-9-]{1,29}$/.test(r.id), r.id); assert.ok(r.label && r.label.length < 60); assert.deepStrictEqual(Object.keys(r).sort(), ['id', 'label']); });
  ['quiz', 'general', 'lawyer', 'teacher', 'linguist'].forEach((id) => assert.ok(rows.some((r) => r.id === id), id));
});

test('catalogue: installed is read from disk, active from the running profile, and a folder not in the list still shows', () => {
  const live = Pack.catalogue({ active: 'quiz' });
  assert.ok(live.find((r) => r.id === 'quiz').installed && live.find((r) => r.id === 'quiz').active);
  assert.ok(live.find((r) => r.id === 'general').installed && !live.find((r) => r.id === 'general').active);
  assert.ok(!live.find((r) => r.id === 'lawyer').installed, 'no lawyer profile ships');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-cat-'));
  fs.mkdirSync(path.join(root, 'packs', 'lawyer'), { recursive: true }); fs.writeFileSync(path.join(root, 'packs', 'lawyer', 'pack.json'), '{}');
  fs.mkdirSync(path.join(root, 'packs', 'bakery'), { recursive: true }); fs.writeFileSync(path.join(root, 'packs', 'bakery', 'pack.json'), '{}');
  fs.mkdirSync(path.join(root, 'packs', 'empty'), { recursive: true });
  const c = Pack.catalogue({ root, active: 'lawyer' });
  assert.ok(c.find((r) => r.id === 'lawyer').installed && c.find((r) => r.id === 'lawyer').active);
  assert.ok(!c.find((r) => r.id === 'teacher').installed);
  assert.deepStrictEqual(c.find((r) => r.id === 'bakery'), { id: 'bakery', label: 'bakery', installed: true, active: false });
  assert.ok(!c.find((r) => r.id === 'empty'), 'a folder with no pack.json is not a profile');
  assert.deepStrictEqual(Pack.catalogue({ root: path.join(root, 'nowhere'), active: null }).filter((r) => r.installed), []);
});

test('guide: active, installed-not-active and missing each say the right thing; a missing one explains how to build it and enables nothing', async () => {
  const { guide, slug, OTHER } = await guideModule();
  assert.strictEqual(OTHER, '__other__');
  const act = guide('Quiz writer', 'quiz', { id: 'quiz', label: 'Quiz writer', installed: true, active: true });
  assert.strictEqual(act.state, 'active');
  const inst = guide('Lawyer', 'lawyer', { id: 'lawyer', label: 'Lawyer', installed: true, active: false });
  assert.strictEqual(inst.state, 'installed'); assert.ok(/pack: lawyer/.test(inst.lines.join(' ')) && /muse\.yaml/.test(inst.lines.join(' ')));
  const miss = guide('Lawyer', 'lawyer', { id: 'lawyer', label: 'Lawyer', installed: false, active: false });
  assert.strictEqual(miss.state, 'missing'); assert.ok(/not enabled/.test(miss.heading));
  assert.ok(miss.steps.some((s) => /pack:new -- lawyer/.test(s)) && miss.steps.some((s) => /pack:check -- lawyer/.test(s)) && /PACKS\.md/.test(miss.foot));
  assert.ok(/benchmark/i.test(miss.steps[0]));
  const free = guide('Bee keeper', slug('Bee keeper'), null);
  assert.strictEqual(free.state, 'missing'); assert.ok(free.steps.some((s) => /pack:new -- bee-keeper/.test(s)));
  assert.strictEqual(guide('', '', null).heading, 'your field: not enabled');
  assert.strictEqual(slug('  Café Owner!! '), 'caf-owner'); assert.strictEqual(slug('???'), 'my-field');
});

test('the picker lives in Admin (first tab), not in Help, and /api/meta carries the catalogue and where the choice comes from', () => {
  const help = fs.readFileSync(path.join(ROOT, 'code', 'muse_ui', 'js', 'views', 'help.mjs'), 'utf8');
  assert.ok(!/pack_guide|profileSection|catalogue/.test(help), 'Help no longer holds the picker');
  const tasks = fs.readFileSync(path.join(ROOT, 'code', 'muse_ui', 'js', 'views', 'admin_tasks.mjs'), 'utf8');
  assert.ok(tasks.indexOf("label: 'Profile'") > 0 && tasks.indexOf("label: 'Profile'") < tasks.indexOf("label: 'Ongoing maintenance'"), 'Profile comes before Ongoing maintenance');
  assert.ok(tasks.indexOf("label: 'Ongoing maintenance'") < tasks.indexOf("label: 'Initial setup'") && tasks.indexOf("label: 'Initial setup'") < tasks.indexOf("label: 'Tags'"));
  const srv = fs.readFileSync(path.join(ROOT, 'code', 'lib', 'muse_server.js'), 'utf8');
  assert.ok(/catalogue: Pack\.catalogue\(\), source: Pack\.source\(\)/.test(srv));
});

test('pack:new scaffolds a profile that loads and passes pack:check; it never overwrites', () => {
  const name = 'zz-scaffold-test', dir = path.join(ROOT, 'packs', name), run = (s, a) => execFileSync(process.execPath, ['--no-warnings', path.join(ROOT, 'code', s), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run('pack_new.js', [name]);
    const p = Pack.loadPack(name); assert.strictEqual(p.name, name); assert.strictEqual(p.extraction.promptVersion, name + '-v1'); assert.ok(p.lens, 'it brings the two neutral lenses');
    const out = run('pack_check.js', [name]); assert.ok(/✓ zz-scaffold-test/.test(out) && /TODO/.test(out), 'it loads and says the description is still to write');
    assert.throws(() => run('pack_new.js', [name]), /already exists|exit|Command failed/);
    assert.throws(() => run('pack_new.js', ['Bad Name']), /Command failed/);
    assert.throws(() => run('pack_check.js', ['does-not-exist']), /Command failed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.ok(!fs.existsSync(dir));
});

test('setActive writes pack: into muse.yaml, keeps the rest and a backup, refuses what would not load, and changes nothing running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-set-'));
  fs.cpSync(path.join(ROOT, 'packs'), path.join(root, 'packs'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'code', 'data'), path.join(root, 'code', 'data'), { recursive: true });   // the quiz profile points at its tag vocabulary there
  fs.mkdirSync(path.join(root, 'packs', 'broken'), { recursive: true }); fs.writeFileSync(path.join(root, 'packs', 'broken', 'pack.json'), '{"name":"broken"}');
  const file = path.join(root, 'muse.yaml'), saved = process.env.MUSE_PACK, savedCfg = process.env.MUSE_CONFIG; delete process.env.MUSE_PACK; delete process.env.MUSE_CONFIG;
  try {
    const before = Pack.current().name;
    const a = Pack.setActive('general', { root }); assert.ok(a.created && a.needsRestart && !a.backup); assert.ok(/pack: general/.test(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, '# my notes\npack: general\nbudget: 5   # keep\n');
    const b = Pack.setActive('quiz', { root }); assert.ok(!b.created && b.backup);
    const t = fs.readFileSync(file, 'utf8'); assert.ok(/^pack: quiz$/m.test(t) && /# my notes/.test(t) && /budget: 5 +# keep/.test(t), t);
    assert.ok(/pack: general/.test(fs.readFileSync(file + '.bak', 'utf8')));
    assert.throws(() => Pack.setActive('lawyer', { root }), /no profile named lawyer/);
    assert.throws(() => Pack.setActive('broken', { root }), Pack.PackError);
    assert.throws(() => Pack.setActive('../etc', { root }), /lowercase/);
    assert.ok(/pack: quiz/.test(fs.readFileSync(file, 'utf8')), 'a refused change leaves the file as it was');
    fs.writeFileSync(file, 'pack: [unclosed\n'); assert.throws(() => Pack.setActive('general', { root }), /not valid YAML/); assert.strictEqual(fs.readFileSync(file, 'utf8'), 'pack: [unclosed\n');
    process.env.MUSE_PACK = 'quiz'; assert.strictEqual(Pack.source(root), 'env'); assert.strictEqual(Pack.setActive('general', { root, file: path.join(root, 'other.yaml') }).envOverrides, true); delete process.env.MUSE_PACK;
    assert.strictEqual(Pack.source(root), 'file'); fs.rmSync(file); assert.strictEqual(Pack.source(root), 'default');
    assert.strictEqual(Pack.current().name, before, 'the running profile did not change');
  } finally { if (saved === undefined) delete process.env.MUSE_PACK; else process.env.MUSE_PACK = saved; if (savedCfg !== undefined) process.env.MUSE_CONFIG = savedCfg; }
});

test('POST /api/admin/profile: needs the header and json, refuses a job running or a bad name, and says a restart is needed', async () => {
  const http = require('http'), { createServer } = require('../code/lib/muse_server'), { fakeModel, fakeNotes } = require('./helpers/muse_fake');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ep-')); const cfg = path.join(root, 'muse.yaml'); process.env.MUSE_CONFIG = cfg; const savedPack = process.env.MUSE_PACK; delete process.env.MUSE_PACK;
  let running = [];
  const admin = { status: () => ({}), runDrift: async () => ({}) }, ops = { running: () => running, catalogue: () => ({}), list: () => [], ctx: {} };
  const srv = createServer({ model: fakeModel(), marks: require('../code/lib/marks').open(null, 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(ROOT, 'code', 'muse_ui'), admin, ops });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (body, headers) => new Promise((res) => { const q = http.request({ host: '127.0.0.1', port, path: '/api/admin/profile', method: 'POST', headers: Object.assign({ Host: 'localhost:' + port }, headers) }, (r) => { let x = ''; r.on('data', (d) => x += d); r.on('end', () => res({ status: r.statusCode, body: x ? JSON.parse(x) : null })); }); q.end(body); });
  const J = { 'Content-Type': 'application/json', 'X-Muse': '1' };
  try {
    assert.strictEqual((await call('{"pack":"general"}', { 'Content-Type': 'application/json' })).status, 403);
    assert.strictEqual((await call('{"pack":"general"}', { 'X-Muse': '1' })).status, 415);
    assert.strictEqual((await call('{"pack":3}', J)).status, 400);
    assert.strictEqual((await call('{"pack":"lawyer"}', J)).status, 400);
    running = [{ id: 'j1' }]; assert.strictEqual((await call('{"pack":"general"}', J)).status, 409); assert.ok(!fs.existsSync(cfg)); running = [];
    const ok = await call('{"pack":"general"}', J); assert.strictEqual(ok.status, 200); assert.ok(ok.body.ok && ok.body.needsRestart && ok.body.pack === 'general'); assert.ok(/pack: general/.test(fs.readFileSync(cfg, 'utf8')));
  } finally { srv.close(); delete process.env.MUSE_CONFIG; if (savedPack !== undefined) process.env.MUSE_PACK = savedPack; }
});
