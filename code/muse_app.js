#!/usr/bin/env node
'use strict';
/**
 * Muse, the author-facing app.   node --no-warnings code/muse_app.js [--port 3005] [--version nug-v6]     then open http://localhost:3005
 * Read-only on vault.db (the author's marks go to muse-marks.jsonl beside it). Listens on MUSE_HOST (default 0.0.0.0, all interfaces; it was 127.0.0.1). Zero dependencies.
 * Open to read; the Admin page and anything that writes need the author's login from other machines: see lib/muse_access.js. Set the password with `node code/muse_set_password.js`.
 * Wordplay appears once `npm run wordplay -- --apply` has been run. The interface is static files in code/muse_ui; the HTTP layer is lib/muse_server.js.
 * The inspection tool (judging burrs, hooks, sparks) stays in code/muse_view.js.
 */
const path = require('path'), os = require('os'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const Core = require('./lib/search_core'), SV = require('./lib/search_vectors'), SE = require('./lib/search_embed'), SC = require('./lib/search_cache'), { createRewriter } = require('./lib/search_rewrite'), { createSearchService } = require('./lib/search_service');
const LLM = require('./lib/llm'), Bud = require('./lib/budget');
const { createAdmin } = require('./lib/muse_admin'), { createJobs } = require('./lib/ops_jobs');
const { createAccess } = require('./lib/muse_access');
const M = require('./lib/muse_model'), K = require('./lib/marks'), { createServer } = require('./lib/muse_server'), { createNoteStore } = require('./lib/note_store');

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(opt('--port', '3005'), 10), VERSION = opt('--version', 'nug-v6');
const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const TRAY_FILE = process.env.MUSE_TRAY || path.join(HOME, 'muse-tray.json');
const MARKS_FILE = process.env.MUSE_MARKS || path.join(HOME, 'muse-marks.jsonl');

console.log('Building model from ' + DB + ' (' + VERSION + ') ...');
// No database yet (a new install): start in SETUP MODE on an empty in-memory one, so the Admin page opens and its "Initial setup" steps can be run. Nothing is written
// to disk by this; the real database is made, explicitly, by Admin's "Create or update the database". Restart Muse after that so it reads the real one.
const t0 = Date.now();
const VAULT_ROOTS = [process.env.MUSE_VAULT_ROOT || path.join(os.homedir(), 'md-vaults', 'knowledge'), process.env.VAULT_PATH];
// Integrity check first (read-only). A fatal finding means the database does not match this code, so serving it would give wrong answers or crash: Muse then starts
// Admin-only on an empty in-memory model, with the findings and their fixes shown in Admin. (No crash loop under systemd; Admin stays reachable as the recovery tool.)
const INTEGRITY = require('./lib/integrity').check({ dbPath: DB, vaultRoots: VAULT_ROOTS });
const SETUP_MODE = INTEGRITY.state === 'setup', DEGRADED = INTEGRITY.level === 'fatal' && !SETUP_MODE;
const db = SETUP_MODE || DEGRADED ? require('./migrate').buildFresh(new DatabaseSync(':memory:')) : new DatabaseSync(DB, { readOnly: true });
if (DEGRADED) { console.log('DEGRADED MODE: the database does not match this code. Muse is running Admin-only on an empty model.'); for (const l of require('./lib/integrity').lines(INTEGRITY)) console.log('  ' + l); }
else if (INTEGRITY.findings.length) { console.log('Integrity warnings:'); for (const l of require('./lib/integrity').lines(INTEGRITY)) console.log('  ' + l); }
if (SETUP_MODE) console.log('SETUP MODE: there is no database at ' + DB + ' yet. Muse is running on an empty one so Admin works. Open Admin, choose Initial setup, run "Create or update the database", then restart Muse (muse restart).');
// Notes are keyed by their path inside the vault (rel_path). A database from before that (absolute filepath) still serves facts and search, but notes cannot open.
if (!db.prepare('PRAGMA table_info(vault_notes)').all().some(c => c.name === 'rel_path')) console.log('WARNING: this database still stores absolute note paths. Notes will not open until you run the migration (Admin: Create or update the database, or node code/migrate.js --run).');
const model = M.build(db, VERSION, { showDupes: !!process.env.MUSE_SHOW_DUPES });
console.log('Ready in ' + (Date.now() - t0) + ' ms: ' + model.burrs.length + ' burrs, ' + model.sparks.length + ' sparks, ' + model.wordplay.length + ' wordplay edges (' + model.wordplayState + ')');

// Search. Words always work. "Search by meaning" needs the vector index (node code/search_build.js), an embedding server (Ollama) and, for new questions, one cheap LLM call.
// MUSE_MEANING=off removes the meaning leg entirely; the in-page switch only turns it off per search. Every missing piece is reported on the search page, never hidden.
const EMBED_MODEL = process.env.MUSE_EMBED_MODEL || 'embeddinggemma', MEANING = process.env.MUSE_MEANING !== 'off';
const searchBurrs = model.burrs.map(b => ({ id: b.id, noteId: b.noteId, claim: b.claim, quote: b.quote, note: b.note })), byId = new Map(searchBurrs.map(b => [b.id, b]));
const vectors = MEANING ? SV.load(HOME, EMBED_MODEL, id => { const b = byId.get(id); return b ? SE.docText(EMBED_MODEL, b) : undefined; }) : null;
const cache = SC.open(process.env.MUSE_CACHE || path.join(HOME, 'muse-cache.db'));
const search = createSearchService({ burrs: searchBurrs, words: Core.buildWordIndex(searchBurrs), vectors,
  embedder: MEANING ? SE.ollamaEmbedder({ url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434', model: EMBED_MODEL }) : null,
  rewriter: MEANING ? createRewriter({ cache, callLLM: LLM.callLLM, hasKey: LLM.hasKey, priceFor: Bud.priceFor, breaker: SE.createBreaker(), config: { provider: 'gemini', maxUsdPerDay: process.env.MUSE_REWRITE_MAX_USD_DAY ? +process.env.MUSE_REWRITE_MAX_USD_DAY : 0.25 } }) : null, cache });
console.log('Search: words ready (' + searchBurrs.length + ' facts); meaning ' + (!MEANING ? 'switched off (MUSE_MEANING=off)' : vectors ? vectors.count + ' vectors' + (vectors.stale || vectors.gone ? ' (' + vectors.stale + ' out of date, ' + vectors.gone + ' gone: rerun search_build.js)' : '') : 'index not built yet (run: node --no-warnings code/search_build.js)'));

// Where to listen, and who may do what. This is the change from the closed design to the open one:
//   WAS:  .listen(PORT, '127.0.0.1', ...)    only this machine could connect (a NAT written into the code)
//   NOW:  .listen(PORT, HOST, ...)           HOST = MUSE_HOST, default '0.0.0.0' = every network interface. MUSE_HOST=127.0.0.1 restores the old behaviour.
const access = createAccess({ env: process.env }), HOST = access.host;
// Optional https straight from Node (no proxy needed): MUSE_TLS_KEY and MUSE_TLS_CERT are paths to a private key and a certificate.
const TLS = process.env.MUSE_TLS_KEY && process.env.MUSE_TLS_CERT ? { key: fs.readFileSync(process.env.MUSE_TLS_KEY), cert: fs.readFileSync(process.env.MUSE_TLS_CERT) } : null;

createServer({ access, tls: TLS, ops: createJobs({ home: HOME, dbPath: DB, version: VERSION }), admin: createAdmin({ home: HOME, dbPath: DB, db, setupMode: SETUP_MODE, integrity: INTEGRITY, degraded: DEGRADED, loadedAt: new Date(t0).toISOString(), version: VERSION, port: PORT, search, drift: () => require('./muse_map_check').check() }), model, marks: K.open(MARKS_FILE, VERSION), notes: createNoteStore(db, { vaultRoot: [process.env.MUSE_VAULT_ROOT || path.join(os.homedir(), 'md-vaults', 'knowledge'), process.env.VAULT_PATH] }), version: VERSION, search, trayStore: { load: () => { try { return JSON.parse(fs.readFileSync(TRAY_FILE, 'utf8')); } catch (e) { return { items: [], links: {} }; } }, save: o => { fs.writeFileSync(TRAY_FILE + '.tmp', JSON.stringify(o)); fs.renameSync(TRAY_FILE + '.tmp', TRAY_FILE); } }, events: { append: o => fs.appendFile(path.join(HOME, 'muse-events.jsonl'), JSON.stringify(o) + '\n', () => {}) }, uiRoot: path.join(__dirname, 'muse_ui') })
  .listen(PORT, HOST, () => {
    console.log('Open ' + (TLS ? 'https' : 'http') + '://localhost:' + PORT + '   (marks are saved to ' + MARKS_FILE + ')');
    console.log(access.loopbackOnly ? 'Listening on ' + HOST + ' only: this machine.' : 'Listening on ' + HOST + ':' + PORT + ' (all network interfaces). Reading is open to anyone who can reach it.');
    if (!access.loopbackOnly) console.log('Admin and saving from other machines: ' + (access.loginConfigured ? 'login required (user "' + access.user + '", ' + (access.mode === 'hashed' ? 'hashed password' : 'plain-text password') + (access.lockout ? ', lockout on' : '') + ')' : 'LOCKED (403) until a password is set: node code/muse_set_password.js') + '. From this machine: open.');
    if (!access.loopbackOnly && !TLS) console.log('Plain http: a login sent from another machine crosses the network unencrypted. Use https (MUSE_TLS_KEY, MUSE_TLS_CERT) or a private network before opening this to the internet.');
  });
