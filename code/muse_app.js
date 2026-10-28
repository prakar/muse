#!/usr/bin/env node
'use strict';
/**
 * Muse, the author-facing app.   node --no-warnings code/muse_app.js [--port 3005] [--version nug-v6]     then open http://localhost:3005
 * Read-only on vault.db (the author's marks go to muse-marks.jsonl beside it). Binds to 127.0.0.1. Zero dependencies.
 * Wordplay appears once `npm run wordplay -- --apply` has been run. The interface is static files in code/muse_ui; the HTTP layer is lib/muse_server.js.
 * The inspection tool (judging burrs, hooks, sparks) stays in code/muse_view.js.
 */
const path = require('path'), os = require('os');
const { DatabaseSync } = require('node:sqlite');
const M = require('./lib/muse_model'), K = require('./lib/marks'), { createServer } = require('./lib/muse_server'), { createNoteStore } = require('./lib/note_store');

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(opt('--port', '3005'), 10), VERSION = opt('--version', 'nug-v6');
const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const MARKS_FILE = process.env.MUSE_MARKS || path.join(HOME, 'muse-marks.jsonl');

console.log('Building model from ' + DB + ' (' + VERSION + ') ...');
const db = new DatabaseSync(DB, { readOnly: true }), t0 = Date.now();
const model = M.build(db, VERSION, { showDupes: !!process.env.MUSE_SHOW_DUPES });
console.log('Ready in ' + (Date.now() - t0) + ' ms: ' + model.burrs.length + ' burrs, ' + model.sparks.length + ' sparks, ' + model.wordplay.length + ' wordplay edges (' + model.wordplayState + ')');

createServer({ model, marks: K.open(MARKS_FILE, VERSION), notes: createNoteStore(db, { vaultRoot: process.env.MUSE_VAULT_ROOT || path.join(os.homedir(), 'md-vaults', 'knowledge') }), version: VERSION, uiRoot: path.join(__dirname, 'muse_ui') })
  .listen(PORT, '127.0.0.1', () => console.log('Open http://localhost:' + PORT + '   (marks are saved to ' + MARKS_FILE + ')'));
