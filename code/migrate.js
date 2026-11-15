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

if (require.main === module && !MODE_RUN && !MODE_STATUS) {
  console.error('Usage: node migrate.js [--run|--status]');
  process.exit(1);
}

// `QUIET` lets Muse run these migrations in memory at startup (setup mode) without printing a screen of JSON; the command line never sets it.
let QUIET = false;
const say = function() { if (!QUIET) console.log.apply(console, arguments); };
function log(msg, data) {
  const entry = Object.assign({ ts: new Date().toISOString(), msg }, data || {});
  say(JSON.stringify(entry));
}

// A missing database is created here, from the one base definition (lib/base_schema.js), and then migrated like any other. That makes "Create or update the
// database" the first step of a new install. A status check never creates anything: with no database it shows what a real run would do, on an empty copy in memory.
let CREATED_NEW = false;
function openDb() {
  const { initSchema } = require('./lib/base_schema');
  if (!fs.existsSync(DB_PATH)) {
    if (MODE_STATUS) {
      console.log('\nNo database yet at ' + DB_PATH + '. A real run (--run) creates it and applies every migration below. Nothing is written by this check.');
      const mem = new DatabaseSync(':memory:'); initSchema(mem); return mem;
    }
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const created = openDatabase(DB_PATH); initSchema(created); CREATED_NEW = true;
    log('Created a new database', { db: DB_PATH });
    return created;
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
  },

  {
    id:   'M012',
    desc: 'Muse step 1: burrs, nuggetizer status/cache, runs, note dispositions',
    // Tables live in lib/burrs.js (SCHEMA_SQL) so the nuggetizer tests build the same schema.
    // Later Muse tables get their own migrations; do not edit SCHEMA_SQL for tables already shipped.
    up: function(db) {
      db.exec(require('./lib/burrs').SCHEMA_SQL);
      log('  Created muse_runs, burrs, nuggetize_status, nuggetize_cache, note_disposition');
    }
  },

  {
    id:   'M013',
    desc: 'burrs.perishable flag (present-tense figures that can go stale)',
    // A fresh DB already gets the column from M012 (SCHEMA_SQL); only older ones need the ALTER.
    up: function(db) {
      var has = db.prepare('PRAGMA table_info(burrs)').all().some(function(c) { return c.name === 'perishable'; });
      if (!has) db.exec('ALTER TABLE burrs ADD COLUMN perishable INTEGER NOT NULL DEFAULT 0');
      log(has ? '  perishable already present' : '  Added burrs.perishable');
    }
  },


  {
    id:   'M014',
    desc: 'burr_dupes: burrs flagged as duplicates of another burr (nothing is deleted)',
    up: function(db) { db.exec(require('./lib/dedupe').SCHEMA_SQL); log('  Added burr_dupes'); }
  },

  // -------------------------------------------------------------------------
  // M015: key notes by the path inside the vault (rel_path) instead of one machine's absolute path (filepath)
  // -------------------------------------------------------------------------
  {
    id:   'M015',
    desc: 'vault_notes: rel_path (path inside the vault) replaces filepath (absolute path); see lib/note_path.js',
    backupFirst: true,          // a file copy of the database is taken before BEGIN
    foreignKeysOff: true,       // dropping the old table with foreign keys ON would cascade-delete tags and facts
    up: function(db) { require('./lib/rel_path_migration').up(db, process.env, log); }
  },

  // -------------------------------------------------------------------------
  // M016: wordplay_edges is created here, not only the first time the wordplay script runs, so a new install has every table from its first migration.
  // CREATE ... IF NOT EXISTS from the script's own definition: a database that already has the table is left exactly as it is.
  // -------------------------------------------------------------------------
  {
    id:   'M016',
    desc: 'wordplay_edges table created by migration (it was created lazily by the wordplay script)',
    up: function(db) { db.exec(require('./lib/wordplay_edges').SCHEMA_SQL); }
  },

  // -------------------------------------------------------------------------
  // M017: the narrative approval columns, which the legacy QUARRY server (server.js) used to add to `narratives` itself each time it started.
  // Each column is checked first (SQLite cannot add a column twice), so a database that already has them is left as it is.
  // -------------------------------------------------------------------------
  {
    id:   'M017',
    desc: 'narratives: approval_status, approved_at, rejection_reason (were added lazily by the legacy server)',
    up: function(db) {
      var have = db.prepare('PRAGMA table_info(narratives)').all().map(function(c) { return c.name; });
      if (have.indexOf('approval_status') < 0)  db.exec("ALTER TABLE narratives ADD COLUMN approval_status TEXT DEFAULT 'pending'");
      if (have.indexOf('approved_at') < 0)      db.exec('ALTER TABLE narratives ADD COLUMN approved_at TEXT');
      if (have.indexOf('rejection_reason') < 0) db.exec('ALTER TABLE narratives ADD COLUMN rejection_reason TEXT');
    }
  },

  // -------------------------------------------------------------------------
  // M018: vault_notes.video_links and video_transcripts, which extract_video_links.js and the legacy server added themselves. Guarded the same way.
  // -------------------------------------------------------------------------
  {
    id:   'M018',
    desc: 'vault_notes: video_links, video_transcripts (were added lazily by extract_video_links.js and the legacy server)',
    up: function(db) {
      var have = db.prepare('PRAGMA table_info(vault_notes)').all().map(function(c) { return c.name; });
      if (have.indexOf('video_links') < 0)       db.exec('ALTER TABLE vault_notes ADD COLUMN video_links TEXT');
      if (have.indexOf('video_transcripts') < 0) db.exec('ALTER TABLE vault_notes ADD COLUMN video_transcripts TEXT');
    }
  },

  // -------------------------------------------------------------------------
  // M019: drop the tables of the retired QUARRY v1/v2 experiments (tag classification, tag proposals, the tag vocabulary, the writeback log, and the narrative queue and
  // narratives). Their scripts were removed; no live code reads them. This deletes data, so a copy of the database is taken first (backupFirst). The columns they added to
  // vault_notes (tag_source and so on) stay: the indexer still reads tag_source.
  // -------------------------------------------------------------------------
  {
    id:   'M019',
    desc: 'Drop the retired v1/v2 tables: narrative_queue, narratives, note_classifications, note_tag_proposals, writeback_log, tag_vocabulary',
    backupFirst: true,   // a file copy of the database is taken before BEGIN
    up: function(db) {
      // narratives has a foreign key to narrative_queue, so the child goes first (dropping the parent while it has rows fails)
      ['narratives', 'narrative_queue', 'note_classifications', 'note_tag_proposals', 'writeback_log', 'tag_vocabulary'].forEach(function(t) {
        var has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
        if (!has) { log('  ' + t + ' not present — skipping'); return; }
        var n = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
        db.exec('DROP TABLE ' + t);
        log('  Dropped ' + t + ' (' + n + ' row' + (n === 1 ? '' : 's') + ')');
      });
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
  if (!applied.has('M015')) {
    try {
      const pl = require('./lib/rel_path_migration').plan(db, process.env);
      console.log('\n  M015 plan: ' + (pl.state === 'legacy' ? pl.notes + ' notes, shared prefix ' + pl.prefix : 'state ' + pl.state));
      pl.problems.forEach(function(x) { console.log('    PROBLEM: ' + x); });
      pl.warnings.forEach(function(x) { console.log('    warning: ' + x); });
    } catch (e) { console.log('\n  M015 plan unavailable: ' + e.message); }
  }
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
    if (m.backupFirst && !CREATED_NEW) {          // a database made a moment ago has nothing to back up. Outside the transaction: VACUUM INTO cannot run inside one
      const bak = DB_PATH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-') + '-pre-' + m.id;
      try { db.exec("VACUUM INTO '" + bak.replace(/'/g, "''") + "'"); log('  backup: ' + bak); }
      catch (e) { console.error('\nCould not back up the database before ' + m.id + ': ' + e.message + '\nNothing was changed. Run on a disk that supports SQLite writes.'); process.exit(1); }
    }
    if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');   // a no-op inside a transaction, so it is set here
    db.exec('BEGIN');
    try {
      m.up(db);
      markApplied(db, m);
      db.exec('COMMIT');
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
      log('Applied ' + m.id + ' OK');
      ran++;
    } catch (e) {
      db.exec('ROLLBACK');
      if (m.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
      log('FAILED ' + m.id, { err: e.message });
      console.error('\nMigration ' + m.id + ' failed — rolled back. Stopping.');
      process.exit(1);
    }
  }

  say('\n═══════════════════════════════════════');
  say('  MIGRATION COMPLETE');
  say('  Applied: ' + ran);
  say('  Skipped: ' + skipped);
  say('═══════════════════════════════════════\n');
}

// For Muse itself: bring a NEW, empty database (usually in memory) to the current structure, quietly. Used when Muse starts with no vault.db, so the Admin page can
// open in setup mode; it never touches a file. The real database is still made, explicitly, by "Create or update the database".
function buildFresh(db, opts) {
  const { initSchema } = require('./lib/base_schema'); initSchema(db);
  const was = { q: QUIET, c: CREATED_NEW }; QUIET = !(opts && opts.verbose); CREATED_NEW = true;
  try { runMigrations(db); } finally { QUIET = was.q; CREATED_NEW = was.c; }
  return db;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
if (require.main === module) {
  const db = openDb();

  if (MODE_STATUS) {
    printStatus(db);
  } else {
    runMigrations(db);
    printStatus(db);
  }

  db.close();
}

module.exports = { MIGRATIONS, buildFresh };
