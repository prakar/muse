#!/usr/bin/env node
/**
 * QUARRY migrate.js v0.1
 * One-time schema migration. Safe to re-run — all changes are additive.
 * Run this before using tagger.js, narrator.js v0.2, or curator.js v0.2.
 *
 * Usage:
 *   node migrate.js --run       Apply all pending migrations
 *   node migrate.js --status    Show which migrations have been applied
 */

'use strict';

const fs   = require('fs');
const path = require('path');
// QUARRY_HOME is the quarry directory itself (default ~/dev/quarry): the DB, logs and chunk caches live
// directly under it. (These scripts once treated it as a PARENT and appended dev/quarry, which doubles
// the path when QUARRY_HOME=$HOME/dev/quarry - the convention writeback.js and the docs use.)
const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./lib/db');   // sets a busy timeout - see lib/db.js

const DB_PATH = process.env.QUARRY_DB
  || path.join(QUARRY_HOME, 'vault.db');

const args       = process.argv.slice(2);
const MODE_RUN    = args.includes('--run');
const MODE_STATUS = args.includes('--status');

if (!MODE_RUN && !MODE_STATUS) {
  console.error('Usage: node migrate.js [--run|--status]');
  process.exit(1);
}

function log(msg, data) {
  const entry = Object.assign({ ts: new Date().toISOString(), msg }, data || {});
  console.log(JSON.stringify(entry));
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('vault.db not found at', DB_PATH, '— run indexer first');
    process.exit(1);
  }
  return openDatabase(DB_PATH);
}

// ---------------------------------------------------------------------------
// MIGRATION REGISTRY
// Each migration has an id, description, and up() function.
// Migrations are tracked in a schema_migrations table.
// Safe to re-run — already-applied migrations are skipped.
// ---------------------------------------------------------------------------
const MIGRATIONS = [

  // -------------------------------------------------------------------------
  // M001: Add tag_source and classification_at to vault_notes
  // -------------------------------------------------------------------------
  {
    id:   'M001',
    desc: 'Add tag_source and classification_at to vault_notes',
    up: function(db) {
      // SQLite doesn't support IF NOT EXISTS on ALTER TABLE
      // so we check column existence first
      const cols = db.prepare("PRAGMA table_info(vault_notes)").all()
        .map(function(c) { return c.name; });

      if (!cols.includes('tag_source')) {
        db.exec("ALTER TABLE vault_notes ADD COLUMN tag_source TEXT");
        log('  Added column vault_notes.tag_source');
      } else {
        log('  vault_notes.tag_source already exists — skipping');
      }

      if (!cols.includes('classification_at')) {
        db.exec("ALTER TABLE vault_notes ADD COLUMN classification_at TEXT");
        log('  Added column vault_notes.classification_at');
      } else {
        log('  vault_notes.classification_at already exists — skipping');
      }
    }
  },

  // -------------------------------------------------------------------------
  // M002: Add mode to narrative_queue and narratives
  // -------------------------------------------------------------------------
  {
    id:   'M002',
    desc: 'Add mode column to narrative_queue and narratives',
    up: function(db) {
      var qCols = db.prepare("PRAGMA table_info(narrative_queue)").all()
        .map(function(c) { return c.name; });
      var nCols = db.prepare("PRAGMA table_info(narratives)").all()
        .map(function(c) { return c.name; });

      if (!qCols.includes('mode')) {
        db.exec("ALTER TABLE narrative_queue ADD COLUMN mode TEXT DEFAULT 'wow'");
        log('  Added column narrative_queue.mode');
      } else {
        log('  narrative_queue.mode already exists — skipping');
      }

      if (!nCols.includes('mode')) {
        db.exec("ALTER TABLE narratives ADD COLUMN mode TEXT DEFAULT 'wow'");
        log('  Added column narratives.mode');
      } else {
        log('  narratives.mode already exists — skipping');
      }
    }
  },

  // -------------------------------------------------------------------------
  // M003: Create note_classifications table
  // -------------------------------------------------------------------------
  {
    id:   'M003',
    desc: 'Create note_classifications table',
    up: function(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS note_classifications (
          id           INTEGER PRIMARY KEY,
          note_id      INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
          bucket       TEXT    NOT NULL,
          claim        TEXT    NOT NULL,
          annotation   TEXT,
          confidence   TEXT,
          switch_level INTEGER DEFAULT 3,
          created_at   TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_classifications_note_id
          ON note_classifications(note_id);
        CREATE INDEX IF NOT EXISTS idx_classifications_bucket
          ON note_classifications(bucket);
      `);
      log('  Created note_classifications table (or already exists)');
    }
  },

  // -------------------------------------------------------------------------
  // M004: Create api_budget table
  // -------------------------------------------------------------------------
  {
    id:   'M004',
    desc: 'Create api_budget table',
    up: function(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_budget (
          id         INTEGER PRIMARY KEY,
          provider   TEXT    NOT NULL,
          component  TEXT    NOT NULL,
          note_id    INTEGER,
          queue_id   INTEGER,
          tokens_in  INTEGER DEFAULT 0,
          tokens_out INTEGER DEFAULT 0,
          cost_usd   REAL    DEFAULT 0,
          called_at  TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_budget_provider
          ON api_budget(provider);
        CREATE INDEX IF NOT EXISTS idx_budget_component
          ON api_budget(component);
        CREATE INDEX IF NOT EXISTS idx_budget_called_at
          ON api_budget(called_at);
      `);
      log('  Created api_budget table (or already exists)');
    }
  },

  // -------------------------------------------------------------------------
  // M005: Create schema_migrations tracking table
  // (Created first in ensureMigrationsTable, listed here for completeness)
  // -------------------------------------------------------------------------
  {
    id:   'M005',
    desc: 'Add register column to narratives (was missing from v0.1 schema)',
    up: function(db) {
      var nCols = db.prepare("PRAGMA table_info(narratives)").all()
        .map(function(c) { return c.name; });
      if (!nCols.includes('register')) {
        db.exec("ALTER TABLE narratives ADD COLUMN register TEXT");
        log('  Added column narratives.register');
      } else {
        log('  narratives.register already exists — skipping');
      }
    }
  },

  // -------------------------------------------------------------------------
  // M006: Add word_count index for efficient Switch-2 tagger queries
  // -------------------------------------------------------------------------
  {
    id:   'M006',
    desc: 'Add word_count index on vault_notes',
    up: function(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notes_word_count
          ON vault_notes(word_count);
      `);
      log('  Created idx_notes_word_count (or already exists)');
    }
  },

  {
    id:   'M007',
    desc: 'Add tag_vocabulary table for canonical vocabulary + writeback_log',
    up: function(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tag_vocabulary (
          id              INTEGER PRIMARY KEY,
          tag_full        TEXT UNIQUE NOT NULL,
          tag_root        TEXT NOT NULL,
          tag_leaf        TEXT NOT NULL,
          is_hierarchical INTEGER DEFAULT 0,
          note_count      INTEGER DEFAULT 0,
          status          TEXT DEFAULT 'approved',
          replaces        TEXT,
          created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tag_vocab_root ON tag_vocabulary(tag_root);
        CREATE INDEX IF NOT EXISTS idx_tag_vocab_status ON tag_vocabulary(status);

        CREATE TABLE IF NOT EXISTS writeback_log (
          id           INTEGER PRIMARY KEY,
          note_id      INTEGER REFERENCES vault_notes(id),
          stage        TEXT NOT NULL,
          tags_before  TEXT,
          tags_after   TEXT,
          written_at   TEXT NOT NULL,
          git_commit   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_writeback_note ON writeback_log(note_id);
        CREATE INDEX IF NOT EXISTS idx_writeback_stage ON writeback_log(stage);
      `);
      log('  Created tag_vocabulary and writeback_log tables (or already exist)');
    }
  },

  {
    id:   'M008',
    desc: 'Add quarry_exclude column to vault_notes',
    up: function(db) {
      var cols = db.prepare("PRAGMA table_info(vault_notes)").all().map(function(c) { return c.name; });
      if (cols.indexOf('quarry_exclude') === -1) {
        db.exec('ALTER TABLE vault_notes ADD COLUMN quarry_exclude INTEGER DEFAULT 0');
        log('  Added column vault_notes.quarry_exclude');
      } else {
        log('  vault_notes.quarry_exclude already exists — skipping');
      }
    }
  },

  {
    id:   'M009',
    desc: 'Add note_tag_proposals table for Switch-3 HIL tag review',
    up: function(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS note_tag_proposals (
          id              INTEGER PRIMARY KEY,
          note_id         INTEGER NOT NULL REFERENCES vault_notes(id),
          tag_full        TEXT NOT NULL,
          tag_root        TEXT NOT NULL,
          tag_leaf        TEXT NOT NULL,
          is_hierarchical INTEGER DEFAULT 0,
          in_vocabulary   INTEGER DEFAULT 0,
          status          TEXT DEFAULT 'pending',
          created_at      TEXT NOT NULL,
          reviewed_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_proposals_note ON note_tag_proposals(note_id);
        CREATE INDEX IF NOT EXISTS idx_proposals_status ON note_tag_proposals(status);
        CREATE INDEX IF NOT EXISTS idx_proposals_tag ON note_tag_proposals(tag_full);
      `);
      log('  Created note_tag_proposals table (or already exists)');
    }
  },

  {
    id:   'M010',
    desc: 'Add retagged_at column to vault_notes (tracks the ontology re-review pass)',
    up: function(db) {
      var cols = db.prepare("PRAGMA table_info(vault_notes)").all().map(function(c) { return c.name; });
      if (cols.indexOf('retagged_at') === -1) {
        db.exec('ALTER TABLE vault_notes ADD COLUMN retagged_at TEXT');
        log('  Added column vault_notes.retagged_at');
      } else {
        log('  vault_notes.retagged_at already exists — skipping');
      }
    }
  },

  {
    id:   'M011',
    desc: 'Remove duplicate note_tags rows and make (note_id, tag_full) unique',
    // note_tags had no uniqueness constraint, so every "INSERT OR IGNORE" into it (Quick Tag
    // Match, approving a tag in Tag Review) silently added a second copy whenever the note
    // already had that tag. This keeps the oldest row of each duplicate set, then adds the
    // constraint so INSERT OR IGNORE really ignores from now on. The indexer relies on this
    // too: it now MERGES frontmatter tags into notes whose tags came from Quarry instead of
    // deleting them, and a merge without a unique key would re-add every tag on every sync.
    up: function(db) {
      var dupes = db.prepare(
        'SELECT COUNT(*) AS n FROM note_tags WHERE id NOT IN (SELECT MIN(id) FROM note_tags GROUP BY note_id, tag_full)'
      ).get().n;
      db.exec('DELETE FROM note_tags WHERE id NOT IN (SELECT MIN(id) FROM note_tags GROUP BY note_id, tag_full)');
      log('  Removed ' + dupes + ' duplicate note_tags row(s)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_note_tags_unique ON note_tags(note_id, tag_full)');
      log('  Added unique index note_tags(note_id, tag_full)');
    }
  }

];

// ---------------------------------------------------------------------------
// MIGRATION TRACKER
// ---------------------------------------------------------------------------
function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      desc       TEXT,
      applied_at TEXT NOT NULL
    )
  `);
}

function appliedMigrations(db) {
  return new Set(
    db.prepare('SELECT id FROM schema_migrations').all()
      .map(function(r) { return r.id; })
  );
}

function markApplied(db, migration) {
  db.prepare(
    'INSERT OR REPLACE INTO schema_migrations (id, desc, applied_at) VALUES (@id, @desc, @applied_at)'
  ).run({
    id:         migration.id,
    desc:       migration.desc,
    applied_at: new Date().toISOString()
  });
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function printStatus(db) {
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db);

  console.log('\n═══════════════════════════════════════');
  console.log('  QUARRY SCHEMA MIGRATION STATUS');
  console.log('═══════════════════════════════════════');
  MIGRATIONS.forEach(function(m) {
    const status = applied.has(m.id) ? '✓' : '○';
    console.log('  ' + status + ' ' + m.id + '  ' + m.desc);
  });
  const pending = MIGRATIONS.filter(function(m) { return !applied.has(m.id); }).length;
  console.log('');
  console.log('  Pending: ' + pending + ' / ' + MIGRATIONS.length);
  console.log('═══════════════════════════════════════\n');
}

// ---------------------------------------------------------------------------
// RUN
// ---------------------------------------------------------------------------
function runMigrations(db) {
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db);

  let ran = 0;
  let skipped = 0;

  for (var i = 0; i < MIGRATIONS.length; i++) {
    var m = MIGRATIONS[i];
    if (applied.has(m.id)) {
      log('Skip ' + m.id + ' (already applied)', { desc: m.desc });
      skipped++;
      continue;
    }

    log('Applying ' + m.id, { desc: m.desc });
    db.exec('BEGIN');
    try {
      m.up(db);
      markApplied(db, m);
      db.exec('COMMIT');
      log('Applied ' + m.id + ' OK');
      ran++;
    } catch (e) {
      db.exec('ROLLBACK');
      log('FAILED ' + m.id, { err: e.message });
      console.error('\nMigration ' + m.id + ' failed — rolled back. Stopping.');
      process.exit(1);
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('  MIGRATION COMPLETE');
  console.log('  Applied: ' + ran);
  console.log('  Skipped: ' + skipped);
  console.log('═══════════════════════════════════════\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
const db = openDb();

if (MODE_STATUS) {
  printStatus(db);
} else {
  runMigrations(db);
  printStatus(db);
}

db.close();