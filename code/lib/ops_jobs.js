'use strict';
// Detached jobs. A job is a plan (a list of steps) run by its own process, with a log file and a small state file, both under <home>/logs/jobs.
// Because the runner is a separate, detached process, a job outlives the server that started it; anything can ask about it later by id (the CLI, the Admin page, ZeroClaw).
// Tasks in the same group never run together. State: running | done | failed | cancelled | lost (the runner vanished without finishing).
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const Cat = require('./ops_catalogue'), { stamp } = require('./ops_internal');

const KEEP_JOBS = 60;
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function createJobs({ home, dbPath, version, env: baseEnv = process.env, codeDir = path.join(__dirname, '..'), now = () => Date.now() }) {
  // The dev convention (see dev.sh): Muse indexes a copy of the vault in ../quarry-data/knowledge. VAULT_PATH wins when set.
  const env = Object.assign({}, baseEnv), copy = path.join(home, '..', 'quarry-data', 'knowledge');
  if (!env.VAULT_PATH && fs.existsSync(copy)) env.VAULT_PATH = path.resolve(copy);
  const dir = path.join(home, 'logs', 'jobs'), ctx = { home, dbPath, version, env };
  const fileOf = (id, ext) => path.join(dir, id + ext);
  const validId = id => /^[\w-]{6,80}$/.test(String(id || ''));
  const read = id => { try { return JSON.parse(fs.readFileSync(fileOf(id, '.json'), 'utf8')); } catch (e) { return null; } };
  const write = m => { const f = fileOf(m.id, '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1)); fs.renameSync(f + '.tmp', f); };

  // State as it is now: a job that says "running" but whose runner is gone is "lost" (a runner that has not started yet gets a few seconds).
  function live(m) {
    if (m && m.state === 'running' && !alive(m.pid) && now() - Date.parse(m.started) > 8000) { m.state = 'lost'; m.finished = new Date(now()).toISOString(); write(m); }
    return m;
  }
  function list(limit = 30) {
    let ids = []; try { ids = fs.readdirSync(dir).filter(f => /\.json$/.test(f)).map(f => f.slice(0, -5)); } catch (e) { /* no jobs yet */ }
    return ids.sort().reverse().slice(0, limit).map(id => live(read(id))).filter(Boolean).map(summary);
  }
  const summary = m => ({ id: m.id, task: m.task, title: (Cat.TASK.get(m.task) || {}).title || m.task, state: m.state, go: m.go, dry: m.dry, effect: m.effect, step: m.step, steps: m.steps.map(s => s.label), started: m.started, finished: m.finished || null, code: m.code == null ? null : m.code, params: m.params });
  const get = id => { if (!validId(id)) return null; const m = live(read(id)); return m ? summary(m) : null; };
  const running = () => list(200).filter(j => j.state === 'running');

  function tail(id, n = 200) {
    if (!validId(id)) return null; let t; try { t = fs.readFileSync(fileOf(id, '.log'), 'utf8'); } catch (e) { return ''; }
    const lines = t.split('\n'); return lines.slice(-Math.max(1, Math.min(2000, n))).join('\n');
  }

  function start(task, params, { go = false, expect = null } = {}) {
    const p = Cat.plan(task, params, { go, expect, ctx });
    const clash = p.group && running().find(j => (Cat.TASK.get(j.task) || {}).group === p.group);
    if (clash) { const e = Cat.bad(`Not started: "${clash.title}" is running and uses the same data (${clash.id}). Wait for it to finish, or cancel it.`); e.conflict = clash.id; throw e; }
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(home, 'logs', 'reports'), { recursive: true });
    const id = stamp(new Date(now())) + '-' + task;
    const m = { id, task, params: p.params, go: p.go, dry: p.dry, effect: p.effect, group: p.group, steps: p.steps, step: 0, state: 'running', pid: null, started: new Date(now()).toISOString(), finished: null, code: null };
    write(m); fs.writeFileSync(fileOf(id, '.log'), '');
    const child = spawn(process.execPath, ['--no-warnings', path.join(codeDir, 'muse_ops.js'), '_run', id], { detached: true, stdio: 'ignore', cwd: path.join(codeDir, '..'), env: Object.assign({}, env, { QUARRY_HOME: home, QUARRY_DB: dbPath }) });
    child.unref(); prune();
    return summary(m);
  }

  function cancel(id) {
    const m = validId(id) && live(read(id)); if (!m) throw Cat.bad('No such job.'); if (m.state !== 'running') throw Cat.bad('That job is not running.');
    try { process.kill(-m.pid, 'SIGTERM'); } catch (e) { try { process.kill(m.pid, 'SIGTERM'); } catch (e2) { /* already gone */ } }
    return summary(m);
  }
  function prune() {
    let ids = []; try { ids = fs.readdirSync(dir).filter(f => /\.json$/.test(f)).map(f => f.slice(0, -5)).sort().reverse(); } catch (e) { return; }
    ids.slice(KEEP_JOBS).forEach(id => ['.json', '.log'].forEach(x => { try { fs.unlinkSync(fileOf(id, x)); } catch (e) { /* gone */ } }));
  }

  // The runner: called in the detached process. Runs each step in turn, appending to the log, and records the outcome.
  async function runJob(id) {
    const m = read(id); if (!m) throw new Error('No such job ' + id);
    m.pid = process.pid; m.state = 'running'; write(m);
    const fd = fs.openSync(fileOf(id, '.log'), 'a'), say = s => fs.writeSync(fd, s + '\n');
    let child = null, cancelled = false;
    process.on('SIGTERM', () => { cancelled = true; if (child) try { child.kill('SIGTERM'); } catch (e) { /* gone */ } });
    say(`# ${m.task}  ${m.go ? 'real run' : m.dry ? 'dry run' : ''}  ${m.started}`.replace(/\s+$/, ''));
    let code = 0;
    for (let i = 0; i < m.steps.length && code === 0 && !cancelled; i++) {
      const s = m.steps[i]; m.step = i; write(m);
      say(`\n== Step ${i + 1} of ${m.steps.length}: ${s.label}`);
      const cmd = s.cmd || process.execPath, args = s.cmd ? s.args : s.script ? ['--no-warnings', path.join(codeDir, s.script), ...s.args] : s.args;
      code = await new Promise(res => { child = spawn(cmd, args, { cwd: path.join(codeDir, '..'), env: Object.assign({}, env, { QUARRY_HOME: home, QUARRY_DB: dbPath }), stdio: ['ignore', fd, fd] }); child.on('error', e => { say('Could not start: ' + e.message); res(127); }); child.on('exit', (c, sig) => res(c == null ? (sig ? 143 : 1) : c)); });
      child = null;
    }
    m.state = cancelled ? 'cancelled' : code === 0 ? 'done' : 'failed'; m.code = cancelled ? 143 : code; m.finished = new Date().toISOString(); write(m);
    say(`\n# ${m.state}${code && !cancelled ? ' (exit ' + code + ')' : ''}`); fs.closeSync(fd);
    return m.state;
  }

  return { list, get, tail, start, cancel, running, runJob, catalogue: Cat.catalogue, ctx };
}
module.exports = { createJobs };
