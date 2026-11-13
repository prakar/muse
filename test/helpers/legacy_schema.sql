-- Schema of vault.db as it was before M015 (absolute filepath). Tables, indexes and triggers only, no data. Generated 13 Nov 2026 from the real database; the test for M015 builds its fixture from this.
CREATE TABLE vault_notes (
  id              INTEGER PRIMARY KEY,
  filepath        TEXT    UNIQUE NOT NULL,
  title           TEXT,
  created         TEXT,
  source_url      TEXT,
  author          TEXT,
  word_count      INTEGER DEFAULT 0,
  first_paragraph TEXT,
  content_type    TEXT    DEFAULT 'unknown',
  origin          TEXT    DEFAULT 'unknown',
  has_frontmatter INTEGER DEFAULT 0,
  has_tags        INTEGER DEFAULT 0,
  folder_hint     TEXT    DEFAULT 'unknown',
  file_mtime      TEXT,
  indexed_at      TEXT    NOT NULL
, tag_source TEXT, classification_at TEXT, quarry_exclude INTEGER DEFAULT 0, video_links TEXT, video_transcripts TEXT, retagged_at TEXT);

CREATE TABLE note_tags (
  id              INTEGER PRIMARY KEY,
  note_id         INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  tag_full        TEXT,
  tag_root        TEXT,
  tag_leaf        TEXT,
  is_hierarchical INTEGER DEFAULT 0
);

CREATE TABLE narrative_queue (
  id             INTEGER PRIMARY KEY,
  note_ids       TEXT    NOT NULL,
  seed_theme     TEXT,
  priority_score REAL    DEFAULT 0,
  status         TEXT    DEFAULT 'queued',
  created_at     TEXT    NOT NULL
, mode TEXT DEFAULT 'wow');

CREATE TABLE narratives (
  id               INTEGER PRIMARY KEY,
  queue_id         INTEGER REFERENCES narrative_queue(id),
  note_ids         TEXT    NOT NULL,
  seed_theme       TEXT,
  body             TEXT    NOT NULL,
  register         TEXT,
  model_used       TEXT,
  produced_at      TEXT    NOT NULL,
  used_for_kcircle INTEGER DEFAULT 0
, mode TEXT DEFAULT 'wow', approval_status TEXT DEFAULT 'pending', approved_at TEXT, rejection_reason TEXT);

CREATE TABLE schema_migrations (
      id         TEXT PRIMARY KEY,
      desc       TEXT,
      applied_at TEXT NOT NULL
    );

CREATE TABLE note_classifications (
          id           INTEGER PRIMARY KEY,
          note_id      INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
          bucket       TEXT    NOT NULL,
          claim        TEXT    NOT NULL,
          annotation   TEXT,
          confidence   TEXT,
          switch_level INTEGER DEFAULT 3,
          created_at   TEXT    NOT NULL
        );

CREATE TABLE api_budget (
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

CREATE TABLE tag_vocabulary (
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

CREATE TABLE writeback_log (
          id           INTEGER PRIMARY KEY,
          note_id      INTEGER REFERENCES vault_notes(id),
          stage        TEXT NOT NULL,
          tags_before  TEXT,
          tags_after   TEXT,
          written_at   TEXT NOT NULL,
          git_commit   TEXT
        );

CREATE TABLE note_tag_proposals (
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

CREATE VIRTUAL TABLE vault_fts USING fts5(
  title, first_paragraph,
  content=vault_notes, content_rowid=id
);

CREATE TABLE muse_runs (
  run_id       TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  seed         INTEGER,
  params_json  TEXT,
  versions_json TEXT
);

CREATE TABLE burrs (
  id             INTEGER PRIMARY KEY,
  note_id        INTEGER NOT NULL,
  claim          TEXT NOT NULL,
  quote          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'fact',
  hooks_json     TEXT,
  loop_text      TEXT,
  provenance     TEXT NOT NULL DEFAULT 'vault',
  method         TEXT NOT NULL DEFAULT 'llm',
  prompt_version TEXT NOT NULL,
  model          TEXT,
  run_id         TEXT,
  created_at     TEXT NOT NULL
, perishable INTEGER NOT NULL DEFAULT 0);

CREATE TABLE nuggetize_status (
  note_id        INTEGER NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL,
  n_burrs        INTEGER DEFAULT 0,
  n_rejected     INTEGER DEFAULT 0,
  reasons_json   TEXT,
  model          TEXT,
  run_id         TEXT,
  at             TEXT NOT NULL,
  PRIMARY KEY (note_id, prompt_version)
);

CREATE TABLE nuggetize_cache (
  cache_key     TEXT PRIMARY KEY,
  response_text TEXT NOT NULL,
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  created_at    TEXT NOT NULL
);

CREATE TABLE note_disposition (
  note_id    INTEGER PRIMARY KEY,
  bucket     TEXT,
  disposition TEXT NOT NULL,
  reason     TEXT,
  decided_by TEXT NOT NULL DEFAULT 'rule',
  decided_at TEXT NOT NULL
);

CREATE TABLE burr_dupes (
  burr_id INTEGER PRIMARY KEY,
  dup_of  INTEGER NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('echo','clone')),
  score   REAL,
  status  TEXT NOT NULL DEFAULT 'dup',
  run_id  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE wordplay_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  a_name TEXT NOT NULL,
  b_name TEXT,
  a_notes TEXT NOT NULL DEFAULT '[]',
  b_notes TEXT NOT NULL DEFAULT '[]',
  grade TEXT NOT NULL CHECK (grade IN ('A','B','C')),
  detail TEXT,
  fit REAL,
  detector_version TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_note_tags_note_id  ON note_tags(note_id);

CREATE INDEX idx_note_tags_root     ON note_tags(tag_root);

CREATE INDEX idx_note_tags_leaf     ON note_tags(tag_leaf);

CREATE INDEX idx_note_tags_full     ON note_tags(tag_full);

CREATE INDEX idx_notes_content_type ON vault_notes(content_type);

CREATE INDEX idx_notes_origin       ON vault_notes(origin);

CREATE INDEX idx_notes_has_tags     ON vault_notes(has_tags);

CREATE INDEX idx_notes_folder       ON vault_notes(folder_hint);

CREATE INDEX idx_classifications_note_id
          ON note_classifications(note_id);

CREATE INDEX idx_classifications_bucket
          ON note_classifications(bucket);

CREATE INDEX idx_budget_provider
          ON api_budget(provider);

CREATE INDEX idx_budget_component
          ON api_budget(component);

CREATE INDEX idx_budget_called_at
          ON api_budget(called_at);

CREATE INDEX idx_notes_word_count
          ON vault_notes(word_count);

CREATE INDEX idx_tag_vocab_root ON tag_vocabulary(tag_root);

CREATE INDEX idx_tag_vocab_status ON tag_vocabulary(status);

CREATE INDEX idx_writeback_note ON writeback_log(note_id);

CREATE INDEX idx_writeback_stage ON writeback_log(stage);

CREATE INDEX idx_proposals_note ON note_tag_proposals(note_id);

CREATE INDEX idx_proposals_status ON note_tag_proposals(status);

CREATE INDEX idx_proposals_tag ON note_tag_proposals(tag_full);

CREATE UNIQUE INDEX idx_note_tags_unique ON note_tags(note_id, tag_full);

CREATE INDEX idx_burrs_note ON burrs(note_id);

CREATE INDEX idx_burrs_kind ON burrs(kind);

CREATE INDEX idx_burr_dupes_of ON burr_dupes(dup_of);

CREATE INDEX idx_wordplay_a ON wordplay_edges(a_name COLLATE NOCASE);

CREATE INDEX idx_wordplay_b ON wordplay_edges(b_name COLLATE NOCASE);

CREATE INDEX idx_wordplay_kind ON wordplay_edges(kind, grade);
