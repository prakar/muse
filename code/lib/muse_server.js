'use strict';
// The Muse app's HTTP layer: static files for the interface, a small JSON API, and nothing else. Dependencies are passed in, so tests use fakes.
const http = require('http'), fs = require('fs'), path = require('path');
const angles = require('./angles'), C = require('./connect'), I = require('./ops_internal'), { createAccess } = require('./muse_access');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const PAGE_SIZES = [12, 24, 48, 96];
// Marks are keyed by a handle. A star on one fact with no handle uses this reserved one.
const FACT_HANDLE = '*';
// Calls that change the author's data or run jobs. Reading is open; these need the login from another machine (see lib/muse_access.js).
const WRITE_PATHS = new Set(['/api/mark', '/api/tray', '/api/event', '/api/dipaka/run', '/api/dipaka/label', '/api/dipaka/delete']);
// `access` decides who may do what; the default is the old closed behaviour (this machine only), so a caller that passes nothing stays safe.
// `tls` ({ key, cert }) serves https from Node itself; without it the server speaks plain http.
function createServer({ model, marks, notes, version, uiRoot, search = null, events = null, trayStore = null, dipaka = null, admin = null, ops = null, access = createAccess({ env: {} }), tls = null }) {
  const root = path.resolve(uiRoot);
  const send = (res, code, type, body) => { res.writeHead(code, Object.assign({ 'Content-Type': type }, SECURITY)); res.end(body); };
  const json = (res, o, code) => send(res, code || 200, 'application/json; charset=utf-8', JSON.stringify(o));
  // A refused call: 401 asks the browser for the login (it shows its own box and retries), 403 means no login is set up, 429 means too many wrong tries.
  const deny = (res, a) => { const h = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SECURITY);
    if (a.challenge) h['WWW-Authenticate'] = 'Basic realm="Muse (author)", charset="UTF-8"'; if (a.retryAfter) h['Retry-After'] = String(a.retryAfter);
    res.writeHead(a.status, h); res.end(JSON.stringify({ error: a.message })); };
  // Dull and wrong-sense items drop out of lists (unless asked for); kept ones come first and carry their mark.
  const withMarks = (items, all) => items.map(i => Object.assign({}, i, { mark: marks.get(i.id) || null }))
    .filter(i => all || (i.mark !== 'dull' && i.mark !== 'wrong-sense')).sort((a, b) => (b.mark === 'use') - (a.mark === 'use'));
  // Facts starred anywhere (under a handle or on their own), so a search result, a fact in focus or a shelf card can show its star.
  const starredIds = () => new Set(marks.all().filter(e => e.mark === 'use' && e.item != null).map(e => e.item));
  const readBody = (req, cb, max = 10000) => { let b = ''; req.on('data', d => { b += d; if (b.length > max) req.destroy(); }); req.on('end', () => { try { cb(JSON.parse(b)); } catch (e) { cb(null); } }); };

  function serveStatic(res, urlPath) {
    let rel; try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, MIME['.txt'], 'bad path'); }
    const file = path.resolve(root, '.' + path.posix.normalize('/' + (rel === '/' ? 'index.html' : rel)));
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, MIME['.txt'], 'forbidden');
    fs.readFile(file, (err, buf) => err ? send(res, 404, MIME['.txt'], 'not found') : send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', buf));
  }

  const handler = function (req, res) {
    // WAS (closed design): every request needed Host = localhost or 127.0.0.1, else 421, because the server only listened on 127.0.0.1 and held
    // private notes: a page on another site could point its own hostname at this machine and read them.
    // NOW (open design): the notes are public, so any Host is fine. The check still runs when MUSE_HOST is a loopback address, or when MUSE_ALLOWED_HOSTS lists names.
    if (!access.hostAllowed(req)) return send(res, 421, MIME['.txt'], 'misdirected request');
    const u = new URL(req.url, 'http://localhost'), q = u.searchParams, all = q.get('hidden') === '1';
    if (!u.pathname.startsWith('/api/')) return req.method === 'GET' ? serveStatic(res, u.pathname) : send(res, 405, MIME['.txt'], 'method not allowed');
    // The login gate. From this machine it is open; from any other it asks for the author's login. Everything else under /api/ is read-only and open.
    if (u.pathname.startsWith('/api/admin/') || (req.method === 'POST' && WRITE_PATHS.has(u.pathname))) { const a = access.authorize(req); if (!a.ok) return deny(res, a); }

    if (u.pathname === '/api/meta') return json(res, { version, notes: model.notes, burrs: model.burrs.length, sparks: model.sparks.length, wordplay: model.wordplay.length,
      wordplayState: model.wordplayState, wordplayKinds: model.wordplayKinds(), marks: marks.counts(), search: search ? search.status().meaning : null });
    if (u.pathname === '/api/suggest') return json(res, { items: withMarks(model.suggest(q.get('q') || '', 40), all).slice(0, 14) });
    if (u.pathname === '/api/wordplay') {
      const list = withMarks(model.wordplayPairs(q.get('kind') || '', 1e6), all), size = PAGE_SIZES.includes(+q.get('size')) ? +q.get('size') : 24;
      const pages = Math.max(1, Math.ceil(list.length / size)), page = Math.min(Math.max(parseInt(q.get('page'), 10) || 1, 1), pages);
      return json(res, { items: list.slice((page - 1) * size, page * size), total: list.length, page, pages, size });
    }
    if (u.pathname === '/api/connect') {
      const id = q.get('id') || '', r = C.connect(model.handle(id), { n: parseInt(q.get('n') || '6', 10), reveal: q.get('reveal') === '1', order: q.get('order') || 'hard', showHidden: all, markOf: x => marks.get(id, x) });
      r.handleMark = marks.get(id) || null;
      return json(res, r, r.error ? 404 : 200);
    }
    if (u.pathname === '/api/note') {
      const n = notes.get({ id: q.get('id'), title: q.get('title'), at: q.get('at') });
      return n ? json(res, n) : json(res, { error: 'That note is not available.' }, 404);
    }
    if (u.pathname === '/api/kept') {
      const out = marks.all().filter(e => e.mark === 'use').map(e => { if (e.handle === FACT_HANDLE) { const f = e.item != null ? model.burrInfo(e.item) : null; return f ? { handle: FACT_HANDLE, label: null, item: e.item, claim: f.claim, quote: f.quote, note: f.note, noteId: f.noteId, ts: e.ts } : null; }
        const h = model.handle(e.handle), it = h && e.item != null ? h.items.find(x => x.id === e.item) : null;
        return h && (e.item == null || it) ? { handle: e.handle, label: h.surface, item: e.item, claim: it ? it.claim : null, quote: it ? it.quote : null, note: it ? it.note : null, noteId: it ? it.noteId : null, ts: e.ts } : null; })
        .filter(Boolean).reverse();
      return json(res, { items: out, marks: marks.counts() });
    }
    // Angles: which quiz heuristics a pile of facts already hints at. Read-only, no model, no spend; the ids are the Collection's facts.
    if (u.pathname === '/api/angles') {
      const ids = (q.get('ids') || '').split(',').filter(Boolean).map(Number); if (ids.length > 50 || !ids.every(Number.isInteger)) return json(res, { error: 'bad ids' }, 400);
      if (!model.pile) return json(res, { error: 'angles are not available' }, 503);
      const facts = model.pile(ids); return json(res, { facts: facts.length, angles: angles.angles(facts) });
    }
    if (u.pathname === '/api/tray') {
      if (!trayStore) return json(res, { error: 'saving is not set up' }, 503);
      if (req.method !== 'POST') return json(res, trayStore.load());
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'json only' }, 415);
      return readBody(req, b => {
        const ok = b && Array.isArray(b.items) && b.items.length <= 50 && b.items.every(i => i && Number.isInteger(i.id) && typeof i.note === 'string' && i.note.length <= 300 && typeof i.claim === 'string' && i.claim.length <= 1000 && (i.noteId == null || Number.isInteger(i.noteId)))
          && b.links && typeof b.links === 'object' && Object.keys(b.links).length <= 100 && Object.entries(b.links).every(([k, v]) => /^\d+>\d+$/.test(k) && typeof v === 'string' && v.length <= 200);
        if (!ok) return json(res, { error: 'bad tray' }, 400);
        trayStore.save({ items: b.items.map(i => ({ id: i.id, noteId: i.noteId == null ? null : i.noteId, note: i.note, claim: i.claim })), links: b.links }); json(res, { ok: true });
      });
    }
    if (u.pathname.startsWith('/api/dipaka')) {
      // Dipaka: one paid model call on the facts in the Collection. The answer is kept in muse-dipaka.jsonl and never goes into the vault. Preview costs nothing; run and label
      // change the author's data (and run spends money), so they need the login from other machines, and every POST needs the X-Muse header a cross-site page cannot send.
      if (!dipaka) return json(res, { error: 'Dipaka is not set up on this server.' }, 503);
      if (u.pathname === '/api/dipaka' && req.method === 'GET') return json(res, { threads: dipaka.list(20), labels: dipaka.LABELS, provider: dipaka.provider, providers: dipaka.providers(), promptVersion: dipaka.PROMPT_VERSION, spentToday: dipaka.spentToday() });
      if (req.method !== 'POST' || !['/api/dipaka/preview', '/api/dipaka/run', '/api/dipaka/label', '/api/dipaka/delete'].includes(u.pathname)) return json(res, { error: 'not found' }, 404);
      if (req.headers['x-muse'] !== '1') return json(res, { error: 'missing X-Muse header' }, 403);
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'json only' }, 415);
      const fail = e => e && e.userError ? json(res, { error: e.message }, e.status || 400) : (console.error('[muse] dipaka failed', e && e.stack || e), json(res, { error: 'Dipaka could not finish: ' + (e && e.message || 'unknown error') }, 502));
      return readBody(req, b => {
        if (!b || typeof b !== 'object') return json(res, { error: 'bad request' }, 400);
        try {
          if (u.pathname === '/api/dipaka/preview') return dipaka.previewResolved({ ids: b.ids, links: b.links && typeof b.links === 'object' ? b.links : {}, provider: b.provider }).then(r => json(res, r), fail);
          if (u.pathname === '/api/dipaka/delete') return json(res, dipaka.remove(String(b.id)));
          if (u.pathname === '/api/dipaka/label') return json(res, { thread: dipaka.label(String(b.id), String(b.label)) });
          if (u.pathname === '/api/dipaka/run') return dipaka.run({ packet: b.packet, seeds: b.seeds, provider: b.provider }).then(t => json(res, { thread: t }), fail);
          return json(res, { error: 'not found' }, 404);
        } catch (e) { return fail(e); }
      }, 40000);
    }
    if (u.pathname === '/api/event' && req.method === 'POST') {
      // Where a fact came from (which shelf, search, a cling) when it was grabbed or picked up, so a month on you can see which routes led to questions. Counts only; no query text.
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'json only' }, 415);
      return readBody(req, b => {
        if (!events || !b || !['hold', 'pick', 'unpick'].includes(b.kind) || !Number.isInteger(b.id) || typeof b.from !== 'string' || b.from.length > 24) return json(res, { error: 'bad event' }, 400);
        events.append({ ts: new Date().toISOString(), kind: b.kind, id: b.id, from: b.from.replace(/[^\w-]/g, '') }); json(res, { ok: true });
      });
    }
    if (u.pathname === '/api/mark' && req.method === 'POST') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'json only' }, 415);
      return readBody(req, b => {
        if (b && b.handle === FACT_HANDLE) {      // a star on one fact that belongs to no handle (from search, the fact in focus, a shelf)
          if (!Number.isInteger(b.item) || !model.burrInfo(b.item) || !['use', 'clear'].includes(b.mark)) return json(res, { error: 'unknown fact' }, 400);
          try {
            if (b.mark === 'clear') marks.all().filter(e => e.mark === 'use' && e.item === b.item).forEach(e => marks.set(e.handle, e.item, 'clear', { via: (b.ctx && b.ctx.via) || null }));   // un-starring here un-stars it everywhere
            else marks.set(FACT_HANDLE, b.item, 'use', Object.assign({}, b.ctx && typeof b.ctx === 'object' ? b.ctx : {}, { hkind: 'fact' }));
          } catch (e) { return json(res, { error: e.message }, 400); }
          return json(res, { ok: true, mark: starredIds().has(b.item) ? 'use' : null, marks: marks.counts() });
        }
        if (!b || typeof b.handle !== 'string' || !model.handle(b.handle) || !(b.item == null || Number.isInteger(b.item))) return json(res, { error: 'unknown handle' }, 400);
        const hh = model.handle(b.handle), item = b.item == null ? null : b.item;
        try { marks.set(b.handle, item, b.mark, Object.assign({}, b.ctx && typeof b.ctx === 'object' ? b.ctx : {}, { hkind: hh.kind, wordplay: hh.wordplay || null, grade: hh.grade || null, surface: hh.surface })); }
        catch (e) { return json(res, { error: e.message }, 400); }
        json(res, { ok: true, mark: marks.get(b.handle, item) || null, marks: marks.counts() });
      });
    }
    if (u.pathname === '/api/shelf') {
      const r = model.shelf(q.get('name') || 'all', { type: q.get('type') || '', match: q.get('match') === 'every' ? 'every' : 'any', sort: q.get('sort') || '', dir: q.get('dir') || '', only: q.get('yours') === '1' ? starredIds() : null, page: parseInt(q.get('page'), 10) || 1, size: parseInt(q.get('size'), 10) || 12, seed: parseInt(q.get('seed'), 10) || 1 });
      if (!r) return json(res, { error: 'unknown shelf' }, 404);
      const st = starredIds(); (r.items || []).forEach(i => { i.starred = st.has(i.id); });
      return json(res, r);
    }
    if (u.pathname === '/api/stick') {
      const s = q.get('random') === '1' ? model.stickRandom(3) : /^\d+$/.test(q.get('id') || '') ? model.stick(parseInt(q.get('id'), 10)) : null;
      if (!s) return json(res, { error: 'That fact is not available.' }, 404);
      s.groups.forEach(g => g.hooks.forEach(hk => { hk.items = hk.items.map(i => Object.assign({}, i, { mark: marks.get(hk.id, i.id) || null })).filter(i => all || (i.mark !== 'dull' && i.mark !== 'wrong-sense')); }));
      s.burr.starred = starredIds().has(s.burr.id);
      return json(res, s);
    }
    // Minimal, no paths and no header needed: lets the deploy script and the UI see whether Muse is serving normally or degraded.
    if (u.pathname === '/api/health' && req.method === 'GET') { const st = admin ? admin.status() : null, g = st && st.integrity; return json(res, { ok: !g || (g.level !== 'fatal' && g.state !== 'setup'), mode: !g ? 'unknown' : g.state === 'setup' ? 'setup' : g.degraded ? 'degraded' : 'normal', level: g ? g.level : null, problems: g ? g.findings.map(x => ({ id: x.id, level: x.level, msg: x.msg, fix: x.fix })) : [] }); }
    if (u.pathname.startsWith('/api/admin/')) {
      // Local paths and counts, and (later) actions: a custom header keeps a cross-site page from reaching these.
      if (!admin) return json(res, { error: 'Admin is not set up on this server.' }, 503);
      if (req.headers['x-muse'] !== '1') return json(res, { error: 'missing X-Muse header' }, 403);
      if (u.pathname === '/api/admin/status' && req.method === 'GET') return json(res, admin.status());
      if (u.pathname === '/api/admin/drift' && req.method === 'POST') return admin.runDrift().then(r => json(res, r), e => json(res, { error: e.message }, 500));
      // Maintenance jobs: the same catalogue and runner the `muse ops` command uses. Starting, watching and stopping are all here, so anything that can call HTTP can drive them.
      if (ops && u.pathname === '/api/admin/ops' && req.method === 'GET') { let pending = null; try { pending = I.candidates({ dbPath: ops.ctx.dbPath, args: ['--all'], log: () => {} }); } catch (e) { /* no database */ }
        return json(res, Object.assign(ops.catalogue(), { pending, setup: I.setupState({ dbPath: ops.ctx.dbPath, home: ops.ctx.home }), running: ops.running().map(j => j.id), backups: I.listBackups(ops.ctx.home).map(b => b.name) })); }
      if (ops && u.pathname === '/api/admin/tags' && req.method === 'GET') {
        const sp = u.searchParams, num = (k, d, lo, hi) => { const v = parseInt(sp.get(k), 10); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }, f = sp.get('filter'), q = String(sp.get('q') || '').slice(0, 60);
        return json(res, I.tagsWaiting({ dbPath: ops.ctx.dbPath, page: num('page', 1, 1, 100000), size: num('size', 24, 1, 200), filter: ['all', 'suggestion', 'ambiguous', 'once', 'none'].includes(f) ? f : 'all', q }));
      }
      if (ops && u.pathname === '/api/admin/jobs' && req.method === 'GET') return json(res, { jobs: ops.list(30) });
      if (ops && u.pathname === '/api/admin/jobs' && req.method === 'POST') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'json only' }, 415);
        return readBody(req, b => {
          if (!b || typeof b.task !== 'string' || (b.params != null && (typeof b.params !== 'object' || Array.isArray(b.params)))) return json(res, { error: 'bad job request' }, 400);
          try { return json(res, { job: ops.start(b.task, b.params || {}, { go: b.go === true, expect: b.expect == null ? null : b.expect }) }, 201); }
          catch (e) { return e.userError ? json(res, { error: e.message, conflict: e.conflict || null }, e.conflict ? 409 : 400) : (console.error('[muse] could not start job', b.task, e && e.stack || e), json(res, { error: 'could not start the job' }, 500)); }
        });
      }
      const jm = ops && u.pathname.match(/^\/api\/admin\/jobs\/([\w-]{6,80})(\/cancel)?$/);
      if (jm && !jm[2] && req.method === 'GET') { const job = ops.get(jm[1]); return job ? json(res, { job, log: ops.tail(jm[1], Math.min(2000, parseInt(q.get('tail'), 10) || 200)) }) : json(res, { error: 'no such job' }, 404); }
      if (jm && jm[2] && req.method === 'POST') { try { return json(res, { job: ops.cancel(jm[1]) }); } catch (e) { return json(res, { error: e.message }, 400); } }
    }
    if (u.pathname === '/api/search/status') return json(res, search ? search.status() : { meaning: { ready: false }, disabled: true });
    if (u.pathname === '/api/search') {
      // A cross-site page can make a browser send a plain GET here, and a search can spend money (one cheap rewrite). A custom header cannot ride a cross-site simple request.
      if (!search) return json(res, { error: 'Search is not set up on this server.' }, 503);
      if (req.headers['x-muse'] !== '1') return json(res, { error: 'missing X-Muse header' }, 403);
      return search.search({ q: q.get('q'), meaning: q.get('meaning') !== '0', page: q.get('page'), size: q.get('size') }).then(r => { const st = starredIds(); (r.results || []).forEach(x => { x.starred = st.has(x.burrId); }); json(res, r); }, e => json(res, { error: e.message }, e.code === 'bad_request' ? 400 : 500));
    }
    json(res, { error: 'not found' }, 404);
  };
  return tls ? require('https').createServer(tls, handler) : http.createServer(handler);
}
module.exports = { createServer };
