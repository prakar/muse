#!/usr/bin/env node
/**
 * QUARRY indexer.js v0.2
 * Walks the Obsidian vault, parses all markdown files,
 * builds/updates the SQLite index in vault.db.
 *
 * Usage:
 *   node indexer.js --full        Full re-index of all files
 *   node indexer.js --diff        Only index new/modified files
 *   node indexer.js --dry-run     Parse and report, write nothing
 *   node indexer.js --file <path> Index a single file (for testing)
 *   node indexer.js --stats       Print index stats and exit
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const VAULT_PATH = process.env.VAULT_PATH
  || path.join(process.env.HOME, 'vault');

const DB_PATH = process.env.QUARRY_DB
  || path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'vault.db');

const BATCH_SIZE     = 200;
const MAX_FIRST_PARA = 400;

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args       = process.argv.slice(2);
const MODE_FULL  = args.includes('--full');
const MODE_DIFF  = args.includes('--diff');
const MODE_DRY   = args.includes('--dry-run');
const MODE_STATS = args.includes('--stats');
const SINGLE_FILE = (() => {
  const i = args.indexOf('--file');
  return i !== -1 ? args[i + 1] : null;
})();

if (!MODE_FULL && !MODE_DIFF && !MODE_DRY && !MODE_STATS && !SINGLE_FILE) {
  console.error('Usage: node indexer.js [--full|--diff|--dry-run|--stats|--file <path>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'indexer.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
  console.log(line);
  if (!MODE_DRY) {
    try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (MODE_DRY) return new DatabaseSync(':memory:');
  if (MODE_STATS) {
    if (fs.existsSync(DB_PATH)) return new DatabaseSync(DB_PATH);
    return new DatabaseSync(':memory:');
  }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return new DatabaseSync(DB_PATH);
}

function initSchema(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS vault_notes (",
    "  id              INTEGER PRIMARY KEY,",
    "  filepath        TEXT    UNIQUE NOT NULL,",
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

// ---------------------------------------------------------------------------
// FILE WALKING
// ---------------------------------------------------------------------------
function walkVault(vaultPath) {
  var results = [];
  function walk(dir) {
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { log('warn', 'Cannot read dir', { dir: dir, err: e.message }); return; }
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (entry.name.charAt(0) === '.') continue;
      if (entry.name === 'node_modules') continue;
      if (entry.name === '_resources') continue;
      var fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); }
      else if (entry.isFile() && entry.name.endsWith('.md')) { results.push(fullPath); }
    }
  }
  walk(vaultPath);
  return results;
}

// ---------------------------------------------------------------------------
// FRONTMATTER PARSER
// ---------------------------------------------------------------------------
function parseFrontmatter(content) {
  var FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  var match = content.match(FM_RE);
  if (!match) return { frontmatter: null, body: content, hasFrontmatter: false };

  var rawBlock = match[1].trim();
  var body     = content.slice(match[0].length);
  if (!rawBlock) return { frontmatter: {}, body: body, hasFrontmatter: true };

  var fm    = {};
  var lines = rawBlock.split(/\r?\n/);
  var i = 0;
  while (i < lines.length) {
    var kvMatch = lines[i].match(/^(\w[\w\s-]*):\s*(.*)/);
    if (!kvMatch) { i++; continue; }
    var key   = kvMatch[1].trim().toLowerCase();
    var value = kvMatch[2].trim();
    if (value.charAt(0) === '[' && value.charAt(value.length - 1) !== ']') {
      var accumulated = value;
      i++;
      while (i < lines.length) {
        accumulated += ' ' + lines[i].trim();
        if (lines[i].trim().charAt(lines[i].trim().length - 1) === ']') break;
        i++;
      }
      value = accumulated;
    }
    fm[key] = value;
    i++;
  }
  return { frontmatter: fm, body: body, hasFrontmatter: true };
}

// ---------------------------------------------------------------------------
// TAG PARSER
// ---------------------------------------------------------------------------
function parseTags(fm, body) {
  var tags = [];

  if (fm && fm.tags !== undefined) {
    var raw = fm.tags.trim();
    if (!raw || raw === '[]') return [];

    if (raw.charAt(0) === '#') {
      raw.split(/\s+/).forEach(function(t) {
        if (t.charAt(0) === '#') tags.push(t.slice(1));
      });
      return tags;
    }

    if (raw.charAt(0) === '[') {
      var inner = raw.replace(/^\[/, '').replace(/\]$/, '');
      inner.split(',').forEach(function(t) {
        var clean = t.trim().replace(/^["']/, '').replace(/["']$/, '');
        if (clean) tags.push(clean);
      });
      return tags;
    }

    if (raw) tags.push(raw);
    return tags;
  }

  var firstHeadingIdx = body.search(/^#{1,6}\s/m);
  var preamble = firstHeadingIdx > 0 ? body.slice(0, firstHeadingIdx) : body.slice(0, 500);
  var floatRe  = /^(#[a-zA-Z][a-zA-Z0-9_/-]*)\s*$/gm;
  var m;
  while ((m = floatRe.exec(preamble)) !== null) { tags.push(m[1].slice(1)); }
  return tags;
}

// ---------------------------------------------------------------------------
// TAG NORMALISER
// ---------------------------------------------------------------------------
function normaliseTags(rawTags) {
  var result = [];
  var seen   = {};

  for (var i = 0; i < rawTags.length; i++) {
    var tag = rawTags[i];
    if (!tag || typeof tag !== 'string') continue;
    var clean = tag.trim().toLowerCase();
    if (!clean) continue;

    var parts          = clean.split('/').filter(function(p) { return p.length > 0; });
    var isHierarchical = parts.length > 1;
    var full           = parts.join('/');

    if (!seen[full]) {
      seen[full] = true;
      result.push({
        tag_full:        full,
        tag_root:        parts[0],
        tag_leaf:        parts[parts.length - 1],
        is_hierarchical: isHierarchical ? 1 : 0
      });
    }

    if (isHierarchical) {
      for (var depth = 1; depth < parts.length; depth++) {
        var partial = parts.slice(0, depth).join('/');
        if (!seen[partial]) {
          seen[partial] = true;
          result.push({
            tag_full:        partial,
            tag_root:        parts[0],
            tag_leaf:        parts[depth - 1],
            is_hierarchical: 1
          });
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// METADATA EXTRACTORS
// ---------------------------------------------------------------------------
function extractTitle(fm, body, filepath) {
  if (fm && fm.title) return fm.title.replace(/^["']|["']$/g, '').trim();
  var headingMatch = body.match(/^#{1,2}\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  return path.basename(filepath, '.md');
}

function extractCreated(fm, rawContent) {
  if (fm && fm.created) return fm.created.trim();
  var m = rawContent.match(/_Created at ([^._]+)\._/);
  if (m) return m[1].trim();
  return null;
}

function extractSourceUrl(fm, rawContent) {
  if (fm && fm.source) {
    var s = fm.source.trim();
    if (s && s !== '[]' && s !== '') return s;
  }
  var m = rawContent.match(/_Source URL:\s*\[.*?\]\(([^)]+)\)\._?/);
  if (m && m[1]) return m[1].trim();
  return null;
}

function extractFirstParagraph(body) {
  var lines = body.split(/\r?\n/);
  var paras = [];
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed.charAt(0) === '#') continue;
    if (trimmed.slice(0, 3) === '![[') continue;
    if (trimmed.slice(0, 2) === '[[') continue;
    if (trimmed.slice(0, 3) === '---') continue;
    if (trimmed.slice(0, 11) === '_Created at') break;
    if (trimmed.slice(0, 13) === '_Last updated') break;
    if (trimmed.slice(0, 11) === '_Source URL') break;
    paras.push(trimmed);
    if (paras.join(' ').length >= MAX_FIRST_PARA) break;
  }
  return paras.join(' ').slice(0, MAX_FIRST_PARA);
}

function inferFolderHint(filepath) {
  if (filepath.indexOf('01_Networked_Notes') !== -1) return 'networked';
  if (filepath.indexOf('00_Primary_Sources') !== -1) return 'primary';
  var m = filepath.match(/\/(20\d\d|19\d\d)\//);
  if (m) return m[1];
  return 'unknown';
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(function(w) { return w.length > 0; }).length;
}

function inferContentType(fm, body, rawContent) {
  if (/^\s*!\[\[.+\]\]\s*$/.test(body)) return 'attachment';
  if (/youtu\.be|youtube\.com\/watch/.test(rawContent)) return 'video';
  if (/^#{1,3}\s*(GROK|Perplexity|ChatGPT|Claude)\b/m.test(body)) return 'processed';
  var sourceUrl = extractSourceUrl(fm, rawContent);
  var wc = countWords(body);
  if (sourceUrl && wc > 150) return 'article';
  if (wc < 80) return 'stub';
  return 'note';
}

function inferOrigin(rawContent) {
  if (
    rawContent.indexOf('Inbox_files/') !== -1 ||
    rawContent.indexOf('_resources/') !== -1 ||
    /[A-Z][a-z]+\d+-\d+-yyyy/.test(rawContent)
  ) return 'evernote';
  if (
    /\[\[.+\]\]/.test(rawContent) ||
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(rawContent)
  ) return 'obsidian';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// FILE PARSER
// ---------------------------------------------------------------------------
function parseFile(filepath) {
  var rawContent;
  try { rawContent = fs.readFileSync(filepath, 'utf8'); }
  catch (e) { log('error', 'Cannot read file', { filepath: filepath, err: e.message }); return null; }

  var stat = fs.statSync(filepath);
  var parsed = parseFrontmatter(rawContent);
  var fm     = parsed.frontmatter;
  var body   = parsed.body;
  var hasFM  = parsed.hasFrontmatter;

  var rawTags        = parseTags(fm, body);
  var normalisedTags = normaliseTags(rawTags);

  return {
    filepath:        filepath,
    title:           extractTitle(fm, body, filepath),
    created:         extractCreated(fm, rawContent),
    source_url:      extractSourceUrl(fm, rawContent),
    author:          (fm && fm.author) ? fm.author.trim() : null,
    word_count:      countWords(body),
    first_paragraph: extractFirstParagraph(body),
    content_type:    inferContentType(fm, body, rawContent),
    origin:          inferOrigin(rawContent),
    folder_hint:     inferFolderHint(filepath),
    has_frontmatter: hasFM ? 1 : 0,
    has_tags:        normalisedTags.length > 0 ? 1 : 0,
    file_mtime:      stat.mtime.toISOString(),
    indexed_at:      new Date().toISOString(),
    tags:            normalisedTags
  };
}

// ---------------------------------------------------------------------------
// DB WRITE HELPERS — positional ? params only
// ---------------------------------------------------------------------------
function upsertNote(db, r) {
  var now = new Date().toISOString();
  db.prepare([
    "INSERT INTO vault_notes",
    "  (filepath, title, created, source_url, author,",
    "   word_count, first_paragraph, content_type, origin,",
    "   has_frontmatter, has_tags, folder_hint, file_mtime, indexed_at)",
    "VALUES",
    "  (@filepath, @title, @created, @source_url, @author,",
    "   @word_count, @first_paragraph, @content_type, @origin,",
    "   @has_frontmatter, @has_tags, @folder_hint, @file_mtime, @indexed_at)",
    "ON CONFLICT(filepath) DO UPDATE SET",
    "  title           = excluded.title,",
    "  created         = excluded.created,",
    "  source_url      = excluded.source_url,",
    "  author          = excluded.author,",
    "  word_count      = excluded.word_count,",
    "  first_paragraph = excluded.first_paragraph,",
    "  content_type    = excluded.content_type,",
    "  origin          = excluded.origin,",
    "  has_frontmatter = excluded.has_frontmatter,",
    "  has_tags        = excluded.has_tags,",
    "  folder_hint     = excluded.folder_hint,",
    "  file_mtime      = excluded.file_mtime,",
    "  indexed_at      = excluded.indexed_at"
  ].join('\n')).run({
    filepath:        r.filepath,
    title:           r.title,
    created:         r.created,
    source_url:      r.source_url,
    author:          r.author,
    word_count:      r.word_count,
    first_paragraph: r.first_paragraph,
    content_type:    r.content_type,
    origin:          r.origin,
    has_frontmatter: r.has_frontmatter,
    has_tags:        r.has_tags,
    folder_hint:     r.folder_hint,
    file_mtime:      r.file_mtime,
    indexed_at:      r.indexed_at || now
  });

  return db.prepare('SELECT id FROM vault_notes WHERE filepath = ?').get(r.filepath).id;
}

function replaceTags(db, noteId, tags) {
  db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
  var insertTag = db.prepare(
    'INSERT INTO note_tags (note_id, tag_full, tag_root, tag_leaf, is_hierarchical) VALUES (@note_id, @tag_full, @tag_root, @tag_leaf, @is_hierarchical)'
  );
  for (var i = 0; i < tags.length; i++) {
    var t = tags[i];
    insertTag.run({ note_id: noteId, tag_full: t.tag_full, tag_root: t.tag_root, tag_leaf: t.tag_leaf, is_hierarchical: t.is_hierarchical });
  }
}

function rebuildFts(db) {
  try { db.exec("INSERT INTO vault_fts(vault_fts) VALUES('rebuild')"); }
  catch (e) { log('warn', 'FTS rebuild warning', { err: e.message }); }
}

// ---------------------------------------------------------------------------
// DIFF MODE
// ---------------------------------------------------------------------------
function getModifiedFiles(db, allFiles) {
  var getStmt = db.prepare('SELECT file_mtime FROM vault_notes WHERE filepath = ?');
  return allFiles.filter(function(filepath) {
    var mtime;
    try { mtime = fs.statSync(filepath).mtime.toISOString(); } catch (_) { return true; }
    var row = getStmt.get(filepath);
    if (!row) return true;
    return row.file_mtime !== mtime;
  });
}

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------
function printStats(db) {
  var total = db.prepare('SELECT COUNT(*) as n FROM vault_notes').get().n;
  if (total === 0) { console.log('\n  No notes indexed yet.\n'); return; }

  var tagged   = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE has_tags = 1').get().n;
  var untagged = total - tagged;
  var byType   = db.prepare('SELECT content_type, COUNT(*) as n FROM vault_notes GROUP BY content_type ORDER BY n DESC').all();
  var byOrigin = db.prepare('SELECT origin, COUNT(*) as n FROM vault_notes GROUP BY origin ORDER BY n DESC').all();
  var byFolder = db.prepare('SELECT folder_hint, COUNT(*) as n FROM vault_notes GROUP BY folder_hint ORDER BY n DESC').all();
  var tagCount = db.prepare('SELECT COUNT(DISTINCT tag_full) as n FROM note_tags').get().n;
  var topTags  = db.prepare('SELECT tag_root, COUNT(*) as n FROM note_tags GROUP BY tag_root ORDER BY n DESC LIMIT 10').all();
  var queueD   = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'queued'").get().n;
  var narr     = db.prepare('SELECT COUNT(*) as n FROM narratives').get().n;

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  QUARRY VAULT INDEX STATS');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  Total notes:      ' + total);
  console.log('  Tagged:           ' + tagged + ' (' + Math.round(tagged / total * 100) + '%)');
  console.log('  Untagged:         ' + untagged + ' (' + Math.round(untagged / total * 100) + '%)');
  console.log('  Unique tag paths: ' + tagCount);
  console.log('');
  console.log('  By content type:');
  byType.forEach(function(r) { console.log('    ' + String(r.content_type).padEnd(12) + ' ' + r.n); });
  console.log('');
  console.log('  By origin:');
  byOrigin.forEach(function(r) { console.log('    ' + String(r.origin).padEnd(12) + ' ' + r.n); });
  console.log('');
  console.log('  By folder:');
  byFolder.forEach(function(r) { console.log('    ' + String(r.folder_hint).padEnd(12) + ' ' + r.n); });
  console.log('');
  console.log('  Top tag roots:');
  topTags.forEach(function(r) { console.log('    ' + String(r.tag_root).padEnd(25) + ' ' + r.n); });
  console.log('');
  console.log('  Narrative queue depth: ' + queueD);
  console.log('  Narratives produced:   ' + narr);
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log('info', 'QUARRY indexer starting', { mode: SINGLE_FILE ? 'single' : args.join(' ') });

  var db = openDb();
  if (!MODE_DRY) initSchema(db);

  if (MODE_STATS) { printStats(db); db.close(); return; }

  var files = [];
  if (SINGLE_FILE) {
    files = [path.resolve(SINGLE_FILE)];
  } else {
    log('info', 'Walking vault', { vaultPath: VAULT_PATH });
    files = walkVault(VAULT_PATH);
    log('info', 'Vault walk complete', { totalFiles: files.length });
    if (MODE_DIFF && !MODE_DRY) {
      var before = files.length;
      files = getModifiedFiles(db, files);
      log('info', 'Diff filter applied', { before: before, after: files.length });

      // Prune orphaned rows: notes in the DB whose files no longer
      // exist on disk (removed/moved out of the vault on GitHub).
      var currentPaths = {};
      walkVault(VAULT_PATH).forEach(function(p) { currentPaths[p] = true; });

      var allDbNotes = db.prepare('SELECT id, filepath, title FROM vault_notes').all();
      var orphans = allDbNotes.filter(function(n) { return !currentPaths[n.filepath]; });

      if (orphans.length > 0) {
        log('info', 'Pruning orphaned notes (removed from vault)', { count: orphans.length });
        db.exec('BEGIN');
        try {
          var delTags = db.prepare('DELETE FROM note_tags WHERE note_id = ?');
          var delClass = db.prepare('DELETE FROM note_classifications WHERE note_id = ?');
          var delWriteback = db.prepare('DELETE FROM writeback_log WHERE note_id = ?');
          var delNote = db.prepare('DELETE FROM vault_notes WHERE id = ?');
          orphans.forEach(function(o) {
            try { delTags.run(o.id); } catch(e) {}
            try { delClass.run(o.id); } catch(e) {}
            try { delWriteback.run(o.id); } catch(e) {}
            delNote.run(o.id);
            log('info', 'Pruned', { title: o.title, filepath: o.filepath });
          });
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          log('error', 'Orphan prune failed, rolled back', { err: e.message });
        }
      } else {
        log('info', 'No orphaned notes found');
      }
    }
  }

  if (files.length === 0) { log('info', 'No files to index'); db.close(); return; }
  if (MODE_DRY) log('info', 'DRY RUN — parsing files, no writes');

  var processed = 0;
  var errors    = 0;
  var skipped   = 0;
  var batch     = [];

  function flushBatch(b) {
    db.exec('BEGIN');
    try {
      for (var k = 0; k < b.length; k++) {
        try {
          var noteId = upsertNote(db, b[k]);
          replaceTags(db, noteId, b[k].tags);
          processed++;
        } catch (e) {
          log('error', 'Failed to write record', { filepath: b[k].filepath, err: e.message });
          errors++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  for (var i = 0; i < files.length; i++) {
    var record = parseFile(files[i]);
    if (!record) { skipped++; continue; }

    if (MODE_DRY) {
      console.log(JSON.stringify({
        title:        record.title,
        content_type: record.content_type,
        origin:       record.origin,
        folder_hint:  record.folder_hint,
        has_tags:     record.has_tags,
        tag_count:    record.tags.length,
        tags:         record.tags.map(function(t) { return t.tag_full; }),
        word_count:   record.word_count,
        filepath:     record.filepath
      }, null, 2));
      processed++;
      continue;
    }

    batch.push(record);
    if (batch.length >= BATCH_SIZE || i === files.length - 1) {
      flushBatch(batch);
      batch = [];
      log('info', 'Batch committed', { processed: processed, remaining: files.length - i - 1, errors: errors });
    }
  }

  if (!MODE_DRY) {
    log('info', 'Rebuilding FTS index...');
    rebuildFts(db);
  }

  log('info', 'Indexing complete', { total: files.length, processed: processed, errors: errors, skipped: skipped });
  if (!MODE_DRY) printStats(db);
  db.close();
}

main().catch(function(e) {
  log('error', 'Indexer crashed', { err: e.message, stack: e.stack });
  process.exit(1);
});