'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { createDipaka, buildPacket, INTRO, QUESTION, MAX_FACTS } = require('../code/lib/dipaka');

const FACTS = { 1: { claim: 'Thebaine is an opiate.', quote: 'Morphine, codeine, and thebaine are opiates', note: 'Opioid vs Opiate' }, 2: { claim: 'Cirebon cargo held bars of opiates.', quote: 'bars of opiates', note: 'cirebon shipwreck' } };
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dipaka-')), 'muse-dipaka.jsonl');
const mk = (over = {}) => {
  const calls = []; let t = Date.parse('2026-11-16T10:00:00Z');
  const d = createDipaka(Object.assign({ file: tmp(), model: { burrInfo: id => FACTS[id] || null }, hasKey: () => true, priceFor: () => ({ in: 3, out: 15 }), now: () => t,
    callLLM: async (p, packet, o) => { calls.push({ p, packet, o }); return { text: 'Thebes gave thebaine its name.', model: 'claude-x', tokensIn: 1000, tokensOut: 500 }; } }, over));
  return { d, calls, tick: ms => { t += ms; } };
};

test('the packet is the intro, the facts in order, and the one ask, nothing else', () => {
  const { d } = mk(), p = d.preview({ ids: [1, 2], links: { '1>2': 'both opiates' } });
  assert.equal(p.facts, 2); assert.deepEqual(p.missing, []);
  assert.ok(p.packet.startsWith(INTRO)); assert.ok(p.packet.endsWith(QUESTION));
  assert.match(p.packet, /\n1\. [^\n:]+: Thebaine is an opiate\. \(both opiates\)\n2\. /);
  assert.ok(!/From my note|My own thought|Please do two things/.test(p.packet), 'no quotes or link boilerplate');
  assert.match(p.packet, /Thebaine is an opiate\. \(both opiates\)\n2\. /, 'the author’s line is appended to the fact before it');
  assert.ok(p.packet.indexOf('Thebaine') < p.packet.indexOf('Cirebon'));
  assert.ok(p.estimate.usd > 0 && p.estimate.tokensIn > 0);
});
test('unknown ids are reported, and an empty, oversized or duplicated Collection is refused in plain words', () => {
  const { d } = mk();
  assert.deepEqual(d.preview({ ids: [1, 99] }).missing, [99]);
  assert.throws(() => d.preview({ ids: [] }), /Collect some facts/);
  assert.throws(() => d.preview({ ids: [99] }), /None of those facts/);
  assert.throws(() => d.preview({ ids: [1, 1] }), /different facts/);
  assert.throws(() => d.preview({ ids: Array.from({ length: MAX_FACTS + 1 }, (_, i) => i + 1) }), /different facts/);
});
test('a link line is appended in brackets to the fact it follows, cleaned of Markdown', () => {
  const p = buildPacket([{ claim: 'A', note: 'N' }, { claim: 'B', note: 'M' }], ['**Thebaine** is an unusual name, look into it', '']);
  assert.match(p, /1\. N: A \(Thebaine is an unusual name, look into it\)\n2\. M: B\n/);
});
test('facts are cleaned of Markdown litter before they are sent', () => {
  const p = buildPacket([{ claim: '- **Gold** bowls in [[Cirebon]] and ==bars of== opiates', quote: 'ignored', note: 'cirebon shipwreck' }]);
  assert.match(p, /\n1\. cirebon shipwreck: Gold bowls in Cirebon and bars of opiates\n/); assert.ok(!/ignored|\*\*|\[\[|==/.test(p));
});

test('a run calls the model once, keeps the thread, and records cost from the tokens', async () => {
  const { d, calls } = mk(), p = d.preview({ ids: [1, 2] }), t = await d.run({ packet: p.packet, seeds: [1, 2] });
  assert.equal(calls.length, 1); assert.equal(calls[0].p, 'claude'); assert.equal(calls[0].o.label, 'dipaka');
  assert.equal(t.response, 'Thebes gave thebaine its name.'); assert.equal(t.model, 'claude-x'); assert.deepEqual(t.seeds, [1, 2]);
  assert.ok(Math.abs(t.cost - (1000 * 3 + 500 * 15) / 1e6) < 1e-12);
  assert.equal(d.list().length, 1); assert.equal(d.list()[0].label, null);
});
test('the edited packet is what is sent, and threads and labels survive a restart', async () => {
  const file = tmp(), a = mk({ file }); const t = await a.d.run({ packet: 'My own edited packet, long enough to send.', seeds: [1] });
  assert.equal(a.calls[0].packet, 'My own edited packet, long enough to send.');
  a.d.label(t.id, 'yielded');
  const b = mk({ file }); assert.equal(b.d.list()[0].id, t.id); assert.equal(b.d.list()[0].label, 'yielded');
  b.d.label(t.id, 'clear'); assert.equal(mk({ file }).d.list()[0].label, null);
});
test('a torn line in the file is skipped, the rest still loads', async () => {
  const file = tmp(), a = mk({ file }); await a.d.run({ packet: 'x'.repeat(40), seeds: [] }); fs.appendFileSync(file, '{"kind":"thr');
  assert.equal(mk({ file }).d.list().length, 1);
});
test('refusals leave the model uncalled and nothing stored', async () => {
  const none = mk({ hasKey: () => false });
  await assert.rejects(none.d.run({ packet: 'x'.repeat(40) }), /No claude key/); assert.equal(none.calls.length, 0);
  const { d, calls } = mk();
  await assert.rejects(d.run({ packet: 'short' }), /nothing to send/);
  await assert.rejects(d.run({ packet: 'x'.repeat(30001) }), /too long/);
  assert.equal(calls.length, 0); assert.equal(d.list().length, 0);
  const empty = mk({ callLLM: async () => ({ text: '  ', model: 'm', tokensIn: 5, tokensOut: 0 }) });
  await assert.rejects(empty.d.run({ packet: 'x'.repeat(40) }), /sent back nothing/); assert.equal(empty.d.list().length, 0);
});
test('the daily ceiling stops a run that would pass it, and a new day starts clean', async () => {
  const { d, calls, tick } = mk({ config: { maxUsdPerDay: 0.045 } });
  await d.run({ packet: 'x'.repeat(40) });                       // estimate 0.0375 passes the cap, actual cost 0.0105
  await assert.rejects(d.run({ packet: 'x'.repeat(40) }), (e) => e.status === 429 && /budget/.test(e.message)); assert.equal(calls.length, 1);
  tick(26 * 3600 * 1000); await d.run({ packet: 'x'.repeat(40) }); assert.equal(calls.length, 2);
});
test('labels are validated and a thread must exist', async () => {
  const { d } = mk(), t = await d.run({ packet: 'x'.repeat(40) });
  assert.throws(() => d.label(t.id, 'great'), /Unknown label/); assert.throws(() => d.label('nope', 'yielded'), /No such thread/);
});

// The HTTP layer: preview is free, run and label need the X-Muse header, a body that is JSON, and (from another machine) the login.
const http = require('http'), K = require('../code/lib/marks'), { createServer } = require('../code/lib/muse_server'), { createAccess } = require('../code/lib/muse_access'), { fakeModel, fakeNotes } = require('./helpers/muse_fake');
async function withDipaka(fn, { access, over } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-')), calls = [];
  const dipaka = createDipaka(Object.assign({ file: path.join(dir, 'd.jsonl'), model: fakeModel(), hasKey: () => true, priceFor: () => ({ in: 3, out: 15 }), callLLM: async (p, pk) => { calls.push(pk); return { text: 'A lamp-lit answer.', model: 'm', tokensIn: 100, tokensOut: 50 }; } }, over || {}));
  const srv = createServer({ model: fakeModel(), marks: K.open(path.join(dir, 'm.jsonl'), 't'), notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), dipaka, access });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (p, o = {}) => new Promise((resolve, reject) => { const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: Object.assign({ Host: 'localhost:' + port }, body ? { 'Content-Type': 'application/json' } : {}, o.headers) }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b, json: () => JSON.parse(b) })); }); req.on('error', reject); req.end(body); });
  try { await fn(call, calls); } finally { srv.close(); }
}
const X = { 'X-Muse': '1' };
test('http: preview, run, label and list work end to end; the packet comes from the database', () => withDipaka(async (call, calls) => {
  const pv = await call('/api/dipaka/preview', { method: 'POST', headers: X, body: { ids: [3, 4] } });
  assert.equal(pv.status, 200); assert.match(pv.json().packet, /Fact 3/);
  const run = await call('/api/dipaka/run', { method: 'POST', headers: X, body: { packet: pv.json().packet, seeds: [3, 4] } });
  assert.equal(run.status, 200); assert.equal(run.json().thread.response, 'A lamp-lit answer.'); assert.equal(calls.length, 1);
  const id = run.json().thread.id;
  assert.equal((await call('/api/dipaka/label', { method: 'POST', headers: X, body: { id, label: 'yielded' } })).json().thread.label, 'yielded');
  const list = await call('/api/dipaka'); assert.equal(list.status, 200); assert.equal(list.json().threads[0].label, 'yielded'); assert.deepEqual(list.json().labels, ['yielded', 'generic', 'already-knew', 'wrong']);
}));
test('http: without the X-Muse header, a JSON body or a good request nothing is spent', () => withDipaka(async (call, calls) => {
  assert.equal((await call('/api/dipaka/run', { method: 'POST', body: { packet: 'x'.repeat(40) } })).status, 403);
  assert.equal((await call('/api/dipaka/run', { method: 'POST', headers: X })).status, 415);
  assert.equal((await call('/api/dipaka/run', { method: 'POST', headers: X, body: { packet: 'short' } })).status, 400);
  assert.equal((await call('/api/dipaka/preview', { method: 'POST', headers: X, body: { ids: [] } })).status, 400);
  assert.equal((await call('/api/dipaka/nope', { method: 'POST', headers: X, body: {} })).status, 404);
  assert.equal(calls.length, 0);
}));
test('http: from another machine run and label need the login, preview does not', () => withDipaka(async (call, calls) => {
  const remote = { 'X-Muse': '1', 'x-forwarded-for': '203.0.113.9' };
  assert.equal((await call('/api/dipaka/run', { method: 'POST', headers: remote, body: { packet: 'x'.repeat(40) } })).status, 403, 'no login set means locked');
  assert.equal((await call('/api/dipaka/label', { method: 'POST', headers: remote, body: { id: 'a', label: 'yielded' } })).status, 403);
  assert.equal(calls.length, 0);
}, { access: createAccess({ env: { MUSE_HOST: '0.0.0.0' } }) }));
test('http: a model failure is reported plainly and nothing is kept', () => withDipaka(async (call) => {
  const r = await call('/api/dipaka/run', { method: 'POST', headers: X, body: { packet: 'x'.repeat(40) } });
  assert.equal(r.status, 502); assert.match(r.json().error, /could not finish/); assert.equal((await call('/api/dipaka')).json().threads.length, 0);
}, { over: { callLLM: async () => { throw new Error('boom'); } } }));

test('the provider can be chosen per run: the estimate and the call use it, an unknown one is refused, one without a key is refused before any call', async () => {
  const prices = { claude: { in: 3, out: 15 }, gemini: { in: 1, out: 2 } }, calls = [];
  const d = createDipaka({ file: tmp(), model: { burrInfo: id => FACTS[id] || null }, hasKey: p => p !== 'grok', priceFor: p => prices[p] || { in: 0, out: 0 },
    callLLM: async (p, pk) => { calls.push(p); return { text: 'ok', model: p + '-m', tokensIn: 1000, tokensOut: 100 }; } });
  assert.deepEqual(d.providers(), [{ id: 'claude', key: true }, { id: 'gemini', key: true }, { id: 'grok', key: false }]);
  const a = d.preview({ ids: [1], provider: 'claude' }), b = d.preview({ ids: [1], provider: 'gemini' });
  assert.equal(a.provider, 'claude'); assert.equal(b.provider, 'gemini'); assert.ok(a.estimate.usd > b.estimate.usd, 'the estimate follows the provider’s price');
  assert.equal(d.preview({ ids: [1] }).provider, 'claude', 'default when none is given'); assert.equal(d.preview({ ids: [1], provider: 'grok' }).key, false);
  assert.throws(() => d.preview({ ids: [1], provider: 'nope' }), /Unknown provider/);
  const t = await d.run({ packet: 'x'.repeat(40), provider: 'gemini' }); assert.deepEqual(calls, ['gemini']); assert.equal(t.provider, 'gemini'); assert.ok(Math.abs(t.cost - (1000 * 1 + 100 * 2) / 1e6) < 1e-12);
  await assert.rejects(d.run({ packet: 'x'.repeat(40), provider: 'grok' }), /No grok key/); await assert.rejects(d.run({ packet: 'x'.repeat(40), provider: 'nope' }), /Unknown provider/);
  assert.deepEqual(calls, ['gemini']);
});

test('the preview names the model the provider would use right now (from the resolver) and prices the estimate for it', async () => {
  const seen = [], prices = { 'big-model': { in: 10, out: 50 }, 'small-model': { in: 1, out: 2 } };
  const mkd = resolve => createDipaka({ file: tmp(), model: { burrInfo: id => FACTS[id] || null }, hasKey: () => true, priceFor: (p, m) => prices[m] || { in: 3, out: 15 }, callLLM: async () => ({ text: 'ok', model: 'big-model', tokensIn: 1, tokensOut: 1 }), resolveModel: resolve });
  const a = await mkd(async p => { seen.push(p); return { id: 'big-model', source: 'resolver' }; }).previewResolved({ ids: [1] });
  const b = await mkd(async () => ({ id: 'small-model', source: 'pinned (resolver error)' })).previewResolved({ ids: [1] });
  assert.deepEqual(seen, ['claude']); assert.deepEqual(a.model, { id: 'big-model', source: 'resolver' }); assert.ok(a.estimate.usd > b.estimate.usd, 'priced for the resolved model');
  assert.equal((await mkd(null).previewResolved({ ids: [1] })).model, null, 'no resolver: no model named, nothing breaks');
  assert.equal((await mkd(async () => { throw new Error('offline'); }).previewResolved({ ids: [1] })).model, null, 'a resolver failure never blocks the preview');
});

test('dipaka asks the resolver for the economy profile, for the preview and for the call', async () => {
  const asked = []; let sent = null;
  const d = createDipaka({ file: tmp(), model: { burrInfo: id => FACTS[id] || null }, hasKey: () => true, priceFor: () => ({ in: 3, out: 15 }),
    resolveModel: async (p, o) => { asked.push(o && o.profile); return { id: 'm', source: 'live' }; }, callLLM: async (p, pk, o) => { sent = o; return { text: 'ok', model: 'm', tokensIn: 1, tokensOut: 1 }; } });
  const pv = await d.previewResolved({ ids: [1] }); const t = await d.run({ packet: 'x'.repeat(40) });
  assert.deepEqual(asked, ['economy']); assert.equal(pv.profile, 'economy'); assert.equal(sent.profile, 'economy'); assert.equal(t.profile, 'economy');
});

test('delete removes the answer, packet and label from the file and the list, keeps the cost so the cap still counts it', async () => {
  const file = tmp(), { d } = mk({ file }), p = d.preview({ ids: [1, 2] }), t = await d.run({ packet: p.packet, seeds: [1, 2] });
  d.label(t.id, 'yielded'); const spent = d.spentToday();
  assert.ok(spent > 0); assert.deepEqual(d.remove(t.id), { id: t.id, deleted: true });
  assert.equal(d.list().length, 0); assert.equal(d.spentToday(), spent);
  { const raw = fs.readFileSync(file, 'utf8'); assert.ok(!raw.includes('Thebes gave') && !raw.includes('Thebaine') && !raw.includes('yielded'), 'no text left on disk'); assert.equal(raw.trim().split('\n').length, 1); }
  assert.throws(() => d.remove(t.id), /No such thread/); assert.throws(() => d.label(t.id, 'wrong'), /No such thread|Unknown/);
});
