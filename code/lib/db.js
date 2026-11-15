// Shared SQLite opener. Every Quarry script opens vault.db through here so they all
// agree on how to behave when another Quarry process is writing at the same moment.
//
// Without a busy timeout SQLite fails instantly with "database is locked" the moment
// two processes write together (for example
// Vault Sync indexing while a fact-extraction run commits). With it, the second writer waits its turn.
'use strict';
const { DatabaseSync } = require('node:sqlite');

const BUSY_TIMEOUT_MS = 15000;

function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = ' + BUSY_TIMEOUT_MS);
  return db;
}

module.exports = { openDatabase, BUSY_TIMEOUT_MS };
