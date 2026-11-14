#!/usr/bin/env node
'use strict';
/**
 * Muse ops: the maintenance tasks that repeat, behind one front door.   muse ops <command>     (or: npm run ops -- <command>)
 *
 *   list [--json]                      every task, by area, with what it costs
 *   describe TASK [--json]             one task: parameters, safety rules
 *   run TASK [--param value ...]      start a task and follow it. A task with a dry run does ONLY the dry run unless you add --go.
 *       --go                           do it for real (takes a backup first when it writes the database)
 *       --expect N                     the count or name you saw, for paid or destructive runs; refused if it has changed
 *       --detach                       print the job id and return at once (automation); otherwise it waits and shows the log
 *       --json                         machine-readable result
 *   jobs [--json]                      recent jobs         job ID [--json]   one job's state
 *   logs ID [-n 200] [--follow]        the job's log       cancel ID         stop a running job
 *
 * Jobs run as detached processes with a log under logs/jobs, so they outlive this command and the server. Exit code: 0 done, 1 failed or refused.
 * The Admin page and the HTTP API (/api/admin/jobs) use the same jobs, so anything started in one place can be watched in another.
 */
const path = require('path'), fs = require('fs');
const { createJobs } = require('./lib/ops_jobs'), I = require('./lib/ops_internal');

const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db'), VERSION = process.env.MUSE_VERSION || 'nug-v6';
const jobs = createJobs({ home: HOME, dbPath: DB, version: VERSION });
const argv = process.argv.slice(2), cmd = argv[0];
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); });
const out = s => process.stdout.write(s + '\n');

function parseFlags(list) {
  const flags = {}, pos = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i]; if (!/^--?[A-Za-z]/.test(a)) { pos.push(a); continue; }
    const eq = a.indexOf('='), key = (eq > 0 ? a.slice(0, eq) : a).replace(/^-+/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    if (eq > 0) flags[key] = a.slice(eq + 1); else if (list[i + 1] !== undefined && !/^--?[A-Za-z]/.test(list[i + 1])) flags[key] = list[++i]; else flags[key] = true;
  }
  return { flags, pos };
}
const RESERVED = new Set(['go', 'expect', 'detach', 'json', 'n', 'follow']);
const fail = (m, code = 1) => { process.stderr.write(m + '\n'); process.exit(code); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function follow(id, { quiet = false, until = true } = {}) {
  let shown = 0;
  for (;;) {
    const text = jobs.tail(id, 2000), j = jobs.get(id);
    if (!quiet && text.length > shown) { process.stdout.write(text.slice(shown)); shown = text.length; }
    if (!j || (until && j.state !== 'running')) return j;
    await sleep(400);
  }
}

async function main() {
  const { flags, pos } = parseFlags(argv.slice(1));
  switch (cmd) {
    case undefined: case 'help': case '-h': case '--help': out(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\n \* Muse ops/, ' Muse ops').replace(/^ \* ?/gm, '').trim()); return;
    case 'list': {
      const c = jobs.catalogue(); if (flags.json) return out(JSON.stringify(c, null, 1));
      c.areas.forEach(a => { out('\n' + a.title.toUpperCase()); c.tasks.filter(t => t.area === a.id).forEach(t => out(`  ${t.id.padEnd(16)} ${t.effect.padEnd(13)} ${t.dry ? 'dry run first   ' : '                '}${t.title}`)); });
      out('\nmuse ops describe TASK   for parameters.   Tasks with a dry run do only the dry run unless you add --go.'); return;
    }
    case 'describe': {
      const t = jobs.catalogue().tasks.find(x => x.id === pos[0]); if (!t) fail('Unknown task: ' + pos[0]); if (flags.json) return out(JSON.stringify(t, null, 1));
      out(`${t.title}  (${t.id})\n${t.does}\nEffect: ${t.effect}${t.dry ? '   Dry run first: yes' : ''}${t.backup ? '   Backs up before a real run' : ''}${t.needs ? '   Needs --expect (the ' + t.needs + ' you saw)' : ''}${t.group ? '   Never runs with other "' + t.group + '" tasks' : ''}`);
      t.params.forEach(d => out(`  --${d.name.padEnd(10)} ${d.type}${d.values ? ' (' + d.values.join('|') + ')' : ''}${d.default !== undefined ? '  default ' + d.default : ''}${d.required ? '  required' : ''}  ${d.label || ''}`)); return;
    }
    case 'run': {
      const task = pos[0]; if (!task) fail('Usage: muse ops run TASK [--param value] [--go] [--expect N]');
      const params = {}; Object.keys(flags).filter(k => !RESERVED.has(k)).forEach(k => { params[k] = flags[k]; });
      let j; try { j = jobs.start(task, params, { go: !!flags.go, expect: flags.expect === undefined ? null : flags.expect }); } catch (e) { if (e.userError) { if (flags.json) out(JSON.stringify({ ok: false, error: e.message, conflict: e.conflict || null })); else process.stderr.write('✗ ' + e.message + '\n'); process.exit(1); } throw e; }
      if (flags.detach) { out(flags.json ? JSON.stringify({ ok: true, job: j }) : `Started ${j.id}   (muse ops logs ${j.id} --follow)`); return; }
      if (!flags.json) out(`Job ${j.id}${j.dry ? '  (dry run: add --go to do it for real)' : ''}`);
      const done = await follow(j.id, { quiet: !!flags.json });
      if (flags.json) out(JSON.stringify({ ok: done.state === 'done', job: done, log: jobs.tail(j.id, 400) }));
      process.exit(done && done.state === 'done' ? 0 : 1);
    }
    case 'jobs': {
      const l = jobs.list(parseInt(flags.n, 10) || 15); if (flags.json) return out(JSON.stringify(l, null, 1));
      if (!l.length) return out('No jobs yet.'); l.forEach(j => out(`${j.id.padEnd(34)} ${j.state.padEnd(9)} ${j.go ? 'real' : j.dry ? 'dry ' : '    '}  ${j.title}`)); return;
    }
    case 'job': { const j = jobs.get(pos[0]); if (!j) fail('No such job.'); out(JSON.stringify(j, null, flags.json ? 0 : 1)); return; }
    case 'logs': {
      if (!jobs.get(pos[0])) fail('No such job.');
      if (flags.follow) { await follow(pos[0]); return; } out(jobs.tail(pos[0], parseInt(flags.n, 10) || 200)); return;
    }
    case 'cancel': { try { jobs.cancel(pos[0]); out('Asked ' + pos[0] + ' to stop.'); } catch (e) { fail(e.message); } return; }
    case '_run': await jobs.runJob(pos[0]); process.exit(0); return;
    case '_do': {
      const [name, ...a] = pos, base = { home: HOME, dbPath: DB, version: VERSION };
      if (name === 'status') I.status(base); else if (name === 'pending') I.pending(base); else if (name === 'candidates') I.candidates({ dbPath: DB, args: argv.slice(2), home: HOME });
      else if (name === 'vault-diff') I.vaultDiff({ src: a[0], dst: a[1] });
      else if (name === 'backup') I.backup({ ...base, reason: a[0] });
      else if (name === 'prune') I.prune({ home: HOME, keep: parseInt(a[0], 10), go: a[1] === 'go' });
      else if (name === 'restore') I.restore({ ...base, name: a[0], go: a[1] === 'go' });
      else if (name === 'clean') I.clean({ home: HOME, go: a[0] === 'go' });
      else fail('Unknown internal step ' + name); return;
    }
    default: fail('Unknown command: ' + cmd + '\nmuse ops help');
  }
}
main().catch(e => { process.stderr.write('✗ ' + (e && e.stack || e) + '\n'); process.exit(1); });
