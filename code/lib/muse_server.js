'use strict';
// The Muse app's HTTP layer: static files for the interface, a small JSON API, and nothing else. Dependencies are passed in, so tests use fakes.
const http = require('http'), fs = require('fs'), path = require('path');
const C = require('./connect');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const PAGE_SIZES = [12, 24, 48, 96];
const MODES = [['connect', 'Connect', 'Facts that share a handle, hard to easy', true], ['stick', 'Stick', 'Hold one fact, see what clings', false], ['thread', 'Thread', 'Follow a chain, hook by hook', false],
  ['slice', 'Slice', 'Everything touching a year, week or day', false], ['shelf', 'Shelf', 'Etymology and other typed shelves', false], ['loops', 'Loops', "The vault's unanswered why?", false],
  ['drift', 'Drift', 'One unprompted spark a day', false], ['wander', 'Wander', 'A random walk over words with several meanings', false]];

function createServer({ model, marks, notes, version, uiRoot }) {
  const root = path.resolve(uiRoot);
  const send = (res, code, type, body) => { res.writeHead(code, Object.assign({ 'Content-Type': type }, SECURITY)); res.end(body); };
  const json = (res, o, code) => send(res, code || 200, 'application/json; charset=utf-8', JSON.stringify(o));
  // Dull and wrong-sense items drop out of lists (unless asked for); kept ones come first and carry their mark.
  const withMarks = (items, all) => items.map(i => Object.assign({}, i, { mark: marks.get(i.id) || null }))
    .filter(i => all || (i.mark !== 'dull' && i.mark !== 'wrong-sense')).sort((a, b) => (b.mark === 'use') - (a.mark === 'use'));
  const readBody = (req, cb) => { let b = ''; req.on('data', d => { b += d; if (b.length > 10000) req.destroy(); }); req.on('end', () => { try { cb(JSON.parse(b)); } catch (e) { cb(null); } }); };

  function serveStatic(res, urlPath) {
    let rel; try { rel = decodeURIComponent(urlPath); } catch (e) { return send(res, 400, MIME['.txt'], 'bad path'); }
    const file = path.resolve(root, '.' + path.posix.normalize('/' + (rel === '/' ? 'index.html' : rel)));
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, MIME['.txt'], 'forbidden');
    fs.readFile(file, (err, buf) => err ? send(res, 404, MIME['.txt'], 'not found') : send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', buf));
  }

  return http.createServer(function (req, res) {
    // A local server holding private notes must not answer a page on another site that points its own hostname at this machine.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) return send(res, 421, MIME['.txt'], 'misdirected request');
    const u = new URL(req.url, 'http://localhost'), q = u.searchParams, all = q.get('hidden') === '1';
    if (!u.pathname.startsWith('/api/')) return req.method === 'GET' ? serveStatic(res, u.pathname) : send(res, 405, MIME['.txt'], 'method not allowed');

    if (u.pathname === '/api/meta') return json(res, { version, notes: model.notes, burrs: model.burrs.length, sparks: model.sparks.length, wordplay: model.wordplay.length,
      wordplayState: model.wordplayState, wordplayKinds: model.wordplayKinds(), marks: marks.counts(), modes: MODES });
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
      const out = marks.all().filter(e => e.mark === 'use').map(e => { const h = model.handle(e.handle), it = h && e.item != null ? h.items.find(x => x.id === e.item) : null;
        return h && (e.item == null || it) ? { handle: e.handle, label: h.surface, item: e.item, claim: it ? it.claim : null, quote: it ? it.quote : null, note: it ? it.note : null, noteId: it ? it.noteId : null, ts: e.ts } : null; })
        .filter(Boolean).reverse();
      return json(res, { items: out, marks: marks.counts() });
    }
    if (u.pathname === '/api/mark' && req.method === 'POST') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return json(res, { error: 'json only' }, 415);
      return readBody(req, b => {
        if (!b || typeof b.handle !== 'string' || !model.handle(b.handle) || !(b.item == null || Number.isInteger(b.item))) return json(res, { error: 'unknown handle' }, 400);
        const hh = model.handle(b.handle), item = b.item == null ? null : b.item;
        try { marks.set(b.handle, item, b.mark, Object.assign({}, b.ctx && typeof b.ctx === 'object' ? b.ctx : {}, { hkind: hh.kind, wordplay: hh.wordplay || null, grade: hh.grade || null, surface: hh.surface })); }
        catch (e) { return json(res, { error: e.message }, 400); }
        json(res, { ok: true, mark: marks.get(b.handle, item) || null, marks: marks.counts() });
      });
    }
    json(res, { error: 'not found' }, 404);
  });
}
module.exports = { createServer, MODES };
