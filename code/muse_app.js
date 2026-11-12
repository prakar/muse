#!/usr/bin/env node
'use strict';
/**
 * Muse, the author-facing app.   node --no-warnings code/muse_app.js [--port 3005] [--version nug-v6]     then open http://localhost:3005
 * Read-only on vault.db (the author's marks go to muse-marks.jsonl beside it). Binds to 127.0.0.1. Zero dependencies.
 * Wordplay appears once `npm run wordplay -- --apply` has been run. The interface is static files in code/muse_ui; the HTTP layer is lib/muse_server.js.
 * The inspection tool (judging burrs, hooks, sparks) stays in code/muse_view.js.
 */
const path = require('path'), os = require('os'), fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const Core = require('./lib/search_core'), SV = require('./lib/search_vectors'), SE = require('./lib/search_embed'), SC = require('./lib/search_cache'), { createRewriter } = require('./lib/search_rewrite'), { createSearchService } = require('./lib/search_service');
const LLM = require('./lib/llm'), Bud = require('./lib/budget');
const { createAdmin } = require('./lib/muse_admin'), { createJobs } = require('./lib/ops_jobs');
const M = require('./lib/muse_model'), K = require('./lib/marks'), { createServer } = require('./lib/muse_server'), { createNoteStore } = require('./lib/note_store');

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(opt('--port', '3005'), 10), VERSION = opt('--version', 'nug-v6');
const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const TRAY_FILE = process.env.MUSE_TRAY || path.join(HOME, 'muse-tray.json');
const MARKS_FILE = process.env.MUSE_MARKS || path.join(HOME, 'muse-marks.jsonl');

console.log('Building model from ' + DB + ' (' + VERSION + ') ...');
const db = new DatabaseSync(DB, { readOnly: true }), t0 = Date.now();
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

createServer({ ops: createJobs({ home: HOME, dbPath: DB, version: VERSION }), admin: createAdmin({ home: HOME, dbPath: DB, db, version: VERSION, port: PORT, search, drift: () => require('./muse_map_check').check() }), model, marks: K.open(MARKS_FILE, VERSION), notes: createNoteStore(db, { vaultRoot: process.env.MUSE_VAULT_ROOT || path.join(os.homedir(), 'md-vaults', 'knowledge') }), version: VERSION, search, trayStore: { load: () => { try { return JSON.parse(fs.readFileSync(TRAY_FILE, 'utf8')); } catch (e) { return { items: [], links: {} }; } }, save: o => { fs.writeFileSync(TRAY_FILE + '.tmp', JSON.stringify(o)); fs.renameSync(TRAY_FILE + '.tmp', TRAY_FILE); } }, events: { append: o => fs.appendFile(path.join(HOME, 'muse-events.jsonl'), JSON.stringify(o) + '\n', () => {}) }, uiRoot: path.join(__dirname, 'muse_ui') })
  .listen(PORT, '127.0.0.1', () => console.log('Open http://localhost:' + PORT + '   (marks are saved to ' + MARKS_FILE + ')'));
