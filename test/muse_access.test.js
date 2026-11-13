'use strict';
// The open-by-design access rules (lib/muse_access.js) and how the server applies them. See that file for the history: closed to this machine, then open with a login for admin and writes.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { createAccess, hashPassword, verifyPassword, resolveHost, OPEN_HOST } = require('../code/lib/muse_access');
const { createServer } = require('../code/lib/muse_server'), K = require('../code/lib/marks'), { fakeModel, fakeNotes } = require('./helpers/muse_fake');

const PW = 'correct horse battery', HASH = hashPassword(PW), basic = (u, p) => 'Basic ' + Buffer.from(u + ':' + p).toString('base64');
const req = (headers = {}, addr = '203.0.113.9') => ({ headers, socket: { remoteAddress: addr } });

test('the default is open: MUSE_HOST unset means every interface; the old closed value is one setting away', () => {
  assert.strictEqual(OPEN_HOST, '0.0.0.0');
  assert.strictEqual(resolveHost({}), '0.0.0.0');
  assert.strictEqual(resolveHost({ MUSE_HOST: '127.0.0.1' }), '127.0.0.1');
  assert.strictEqual(createAccess({ env: {} }).loopbackOnly, false);
  assert.strictEqual(createAccess({ env: { MUSE_HOST: '127.0.0.1' } }).loopbackOnly, true);
});

test('the Host check only runs when closed (or when names are listed): open servers answer to any hostname', () => {
  const open = createAccess({ env: {} }), closed = createAccess({ env: { MUSE_HOST: '127.0.0.1' } }), listed = createAccess({ env: { MUSE_ALLOWED_HOSTS: 'muse.example, homelab.local' } });
  assert.ok(open.hostAllowed(req({ host: 'homelab.local:3005' })) && open.hostAllowed(req({ host: '192.168.1.20:3005' })));
  assert.ok(closed.hostAllowed(req({ host: 'localhost:3005' })) && closed.hostAllowed(req({ host: '127.0.0.1:3005' })));
  assert.ok(!closed.hostAllowed(req({ host: 'evil.example' })) && !closed.hostAllowed(req({ host: 'homelab.local:3005' })));
  assert.ok(listed.hostAllowed(req({ host: 'homelab.local:3005' })) && !listed.hostAllowed(req({ host: 'evil.example' })));
});

test('password hashes verify, differ each time, and contain nothing a shell or systemd would mangle', () => {
  assert.ok(verifyPassword(PW, HASH)); assert.ok(!verifyPassword('wrong', HASH)); assert.ok(!verifyPassword(PW, '')); assert.ok(!verifyPassword(PW, 'scrypt:1:2:3:x:y'));
  assert.notStrictEqual(hashPassword(PW), hashPassword(PW));
  assert.match(HASH, /^scrypt:\d+:\d+:\d+:[\w-]+:[\w-]+$/);
});

test('from this machine nothing asks for a login; from another machine it does, and without a configured login it stays locked', () => {
  const a = createAccess({ env: { MUSE_ADMIN_PASSWORD: PW } });
  assert.ok(a.authorize(req({}, '127.0.0.1')).ok && a.authorize(req({}, '::1')).ok && a.authorize(req({}, '::ffff:127.0.0.1')).ok);
  assert.strictEqual(a.authorize(req({ 'x-forwarded-for': '203.0.113.9' }, '127.0.0.1')).status, 401, 'a proxy on this machine must not make everyone local');
  const none = a.authorize(req()); assert.strictEqual(none.status, 401); assert.ok(none.challenge);
  assert.ok(a.authorize(req({ authorization: basic('admin', PW) })).ok);
  assert.strictEqual(a.authorize(req({ authorization: basic('admin', 'nope') })).status, 401);
  assert.strictEqual(a.authorize(req({ authorization: basic('root', PW) })).status, 401, 'the name must match too');
  const unset = createAccess({ env: {} }); assert.strictEqual(unset.authorize(req({ authorization: basic('admin', PW) })).status, 403, 'no login set means locked, never open');
  assert.ok(unset.authorize(req({}, '127.0.0.1')).ok);
});

test('five wrong passwords lock that address for five minutes; a right one afterwards still waits; asking without credentials is not a failure', () => {
  let t = 1e6; const a = createAccess({ env: { MUSE_ADMIN_PASSWORD_HASH: HASH, MUSE_LOGIN_LOCKOUT: 'on' }, now: () => t });
  for (let i = 0; i < 10; i++) a.authorize(req());                                               // no credentials: never counts
  for (let i = 0; i < 4; i++) assert.strictEqual(a.authorize(req({ authorization: basic('admin', 'bad' + i) })).status, 401);
  assert.strictEqual(a.authorize(req({ authorization: basic('admin', 'bad4') })).status, 401);
  const locked = a.authorize(req({ authorization: basic('admin', PW) })); assert.strictEqual(locked.status, 429); assert.ok(locked.retryAfter > 0);
  assert.ok(a.authorize(req({ authorization: basic('admin', PW) }, '198.51.100.7')).ok, 'another address is not affected');
  t += 5 * 60 * 1000 + 1; assert.ok(a.authorize(req({ authorization: basic('admin', PW) })).ok, 'the lock ends');
});

async function withOpenServer(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-acc-')), marks = K.open(path.join(dir, 'm.jsonl'), 't'), events = [], tray = { saved: null };
  const access = createAccess({ env, isLocal: () => false });                                      // every request counts as coming from another machine
  const admin = { status: () => ({ ok: true }), runDrift: async () => ({ ok: true }) };
  const srv = createServer({ model: fakeModel(), marks, notes: fakeNotes(), version: 't', uiRoot: path.join(__dirname, '..', 'code', 'muse_ui'), access, admin,
    events: { append: o => events.push(o) }, trayStore: { load: () => ({ items: [], links: {} }), save: o => { tray.saved = o; } } });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const call = (p, o = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method: o.method || 'GET', headers: Object.assign({ Host: 'homelab.local:3005' }, o.headers || {}) }, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: () => JSON.parse(b) })); }); r.on('error', reject); if (o.body) r.write(o.body); r.end(); });
  try { await fn(call, { marks, events, tray }); } finally { srv.close(); }
}

test('open server, login set: reading is open; admin and every write ask for the login; the right login gets through', () => withOpenServer({ MUSE_ADMIN_PASSWORD: PW }, async (call, st) => {
  assert.strictEqual((await call('/')).status, 200, 'the page is open to any hostname');
  assert.strictEqual((await call('/api/meta')).status, 200); assert.strictEqual((await call('/api/note?id=3')).status, 200); assert.strictEqual((await call('/api/tray')).status, 200, 'reading the tray is open');
  const json = { 'Content-Type': 'application/json' };
  for (const [p, m, body] of [['/api/admin/status', 'GET'], ['/api/admin/drift', 'POST'], ['/api/mark', 'POST', '{"handle":"*","item":1,"mark":"use"}'], ['/api/tray', 'POST', '{"items":[],"links":{}}'], ['/api/event', 'POST', '{"kind":"hold","id":1,"from":"shelf"}']]) {
    const r = await call(p, { method: m, headers: Object.assign({ 'X-Muse': '1' }, json), body }); assert.strictEqual(r.status, 401, p); assert.match(r.headers['www-authenticate'], /^Basic /, p); assert.ok(r.json().error, p);
  }
  assert.strictEqual(st.marks.counts().use, 0); assert.strictEqual(st.events.length, 0); assert.strictEqual(st.tray.saved, null, 'nothing was written');
  const ok = await call('/api/admin/status', { headers: { 'X-Muse': '1', Authorization: basic('admin', PW) } }); assert.strictEqual(ok.status, 200);
  const m = await call('/api/mark', { method: 'POST', headers: Object.assign({ Authorization: basic('admin', PW) }, json), body: '{"handle":"*","item":1,"mark":"use"}' }); assert.notStrictEqual(m.status, 401);
}));

test('open server, no login set: admin and writes are locked (403), reading still works', () => withOpenServer({}, async call => {
  assert.strictEqual((await call('/api/meta')).status, 200);
  const r = await call('/api/admin/status', { headers: { 'X-Muse': '1', Authorization: basic('admin', PW) } }); assert.strictEqual(r.status, 403); assert.ok(!r.headers['www-authenticate']);
  assert.strictEqual((await call('/api/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
}));

test('modes: plain password is the default, the hash wins when both are set, lockout is off unless asked for', () => {
  const plain = createAccess({ env: { MUSE_ADMIN_PASSWORD: PW } }), hashed = createAccess({ env: { MUSE_ADMIN_PASSWORD_HASH: HASH, MUSE_ADMIN_PASSWORD: 'other-plain-pw' } });
  assert.strictEqual(plain.mode, 'plain'); assert.strictEqual(hashed.mode, 'hashed'); assert.strictEqual(createAccess({ env: {} }).mode, 'none');
  assert.ok(hashed.authorize(req({ authorization: basic('admin', PW) })).ok); assert.ok(!hashed.authorize(req({ authorization: basic('admin', 'other-plain-pw') })).ok);
  for (let i = 0; i < 8; i++) assert.strictEqual(plain.authorize(req({ authorization: basic('admin', 'bad') })).status, 401, 'no lockout unless MUSE_LOGIN_LOCKOUT=on');
  assert.ok(plain.authorize(req({ authorization: basic('admin', PW) })).ok);
});

test('muse_set_password: validation and .env upsert keep other lines', () => {
  const { checkPassword, upsertEnv } = require('../code/muse_set_password');
  assert.ok(checkPassword('short')); assert.ok(checkPassword('has "quote" 12345')); assert.ok(checkPassword(' leading space1')); assert.strictEqual(checkPassword('long enough pw'), null);
  assert.strictEqual(upsertEnv('A=1\nMUSE_ADMIN_PASSWORD=old\nB=2\n', 'MUSE_ADMIN_PASSWORD', 'new'), 'A=1\nMUSE_ADMIN_PASSWORD=new\nB=2\n');
  assert.strictEqual(upsertEnv('', 'K', 'v'), 'K=v\n'); assert.strictEqual(upsertEnv('A=1', 'K', 'v'), 'A=1\nK=v\n');
});
