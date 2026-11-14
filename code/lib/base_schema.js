'use strict';
// The base tables Muse starts from, before any migration runs. Both the indexer and `node code/migrate.js --run` (which creates a missing database) use this one
// definition, so a new install and an old one cannot start from different tables. Every statement is CREATE ... IF NOT EXISTS: running it on an existing database
// changes nothing. Columns and tables added later belong in migrations (code/migrate.js), not here; test/schema_parity.test.js checks that this plus the migrations
// builds the same structure as the real database.

function initSchema(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS vault_notes (",
    "  id              INTEGER PRIMARY KEY,",
    "  rel_path        TEXT    UNIQUE NOT NULL,",
    "  title           TEXT,",
    "  created         TEXT,",
    "  source_url      TEXT,",
    "  author          TEXT,",
    "  word_count      INTEGER DEFAULT 0,",
    "  first_paragraph TEXT,",
    "  content_type    TEXT    DEFAULT 'unknown',",
    "  origin          TEXT    DEFAULT 'unknown',",
    "  has_frontmatter INTEGER DEFAULT 0,",
    "  has_tags        INTEGER DEFAULT 0,",
    "  folder_hint     TEXT    DEFAULT 'unknown',",
    "  file_mtime      TEXT,",
    "  indexed_at      TEXT    NOT NULL",
    ");",
    "CREATE TABLE IF NOT EXISTS note_tags (",
    "  id              INTEGER PRIMARY KEY,",
    "  note_id         INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,",
    "  tag_full        TEXT,",
    "  tag_root        TEXT,",
    "  tag_leaf        TEXT,",
    "  is_hierarchical INTEGER DEFAULT 0",
    ");",
    "CREATE TABLE IF NOT EXISTS narrative_queue (",
    "  id             INTEGER PRIMARY KEY,",
    "  note_ids       TEXT    NOT NULL,",
    "  seed_theme     TEXT,",
    "  priority_score REAL    DEFAULT 0,",
    "  status         TEXT    DEFAULT 'queued',",
    "  created_at     TEXT    NOT NULL",
    ");",
    "CREATE TABLE IF NOT EXISTS narratives (",
    "  id               INTEGER PRIMARY KEY,",
    "  queue_id         INTEGER REFERENCES narrative_queue(id),",
    "  note_ids         TEXT    NOT NULL,",
    "  seed_theme       TEXT,",
    "  body             TEXT    NOT NULL,",
    "  register         TEXT,",
    "  model_used       TEXT,",
    "  produced_at      TEXT    NOT NULL,",
    "  used_for_kcircle INTEGER DEFAULT 0",
    ");",
    "CREATE INDEX IF NOT EXISTS idx_note_tags_note_id  ON note_tags(note_id);",
    "CREATE INDEX IF NOT EXISTS idx_note_tags_root     ON note_tags(tag_root);",
    "CREATE INDEX IF NOT EXISTS idx_note_tags_leaf     ON note_tags(tag_leaf);",
    "CREATE INDEX IF NOT EXISTS idx_note_tags_full     ON note_tags(tag_full);",
    "CREATE INDEX IF NOT EXISTS idx_notes_content_type ON vault_notes(content_type);",
    "CREATE INDEX IF NOT EXISTS idx_notes_origin       ON vault_notes(origin);",
    "CREATE INDEX IF NOT EXISTS idx_notes_has_tags     ON vault_notes(has_tags);",
    "CREATE INDEX IF NOT EXISTS idx_notes_folder       ON vault_notes(folder_hint);",
    "CREATE VIRTUAL TABLE IF NOT EXISTS vault_fts USING fts5(",
    "  title, first_paragraph,",
    "  content=vault_notes, content_rowid=id",
    ");"
  ].join('\n'));
}

module.exports = { initSchema };
