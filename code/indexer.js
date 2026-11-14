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
const { normalizeCreated } = require('./lib/created_date');
const Paths = require('./lib/note_path');   // notes are keyed by their path INSIDE the vault (rel_path), never by one machine's absolute path
const path = require('path');
// QUARRY_HOME is the quarry directory itself (default ~/dev/quarry): the DB, logs and chunk caches live
// directly under it. (These scripts once treated it as a PARENT and appended dev/quarry, which doubles
// the path when QUARRY_HOME=$HOME/dev/quarry - the convention writeback.js and the docs use.)
const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./lib/db');   // sets a busy timeout - see lib/db.js

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const VAULT_PATH = (function () {            // VAULT_PATH, else the dev convention when it exists, else the old default
  try { return Paths.vaultRoot(process.env, QUARRY_HOME); } catch (e) { return path.join(process.env.HOME, 'vault'); }
})();

const DB_PATH = process.env.QUARRY_DB
  || path.join(QUARRY_HOME, 'vault.db');

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
// --force-prune: allow removing more notes than the safety limit in one run (see pruneOrphans)
const FORCE_PRUNE = args.includes('--force-prune');
const SINGLE_FILE = (() => {
  const i = args.indexOf('--file');
  return i !== -1 ? args[i + 1] : null;
})();

if (!MODE_FULL && !MODE_DIFF && !MODE_DRY && !MODE_STATS && !SINGLE_FILE) {
  console.error('Usage: node indexer.js [--full|--diff|--dry-run|--stats|--file <path>] [--force-prune]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(QUARRY_HOME, 'indexer.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
  console.log(line);
  if (!MODE_DRY) {
    if (!process.env.QUARRY_LAUNCHED) { try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {} }
  }
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (MODE_DRY) return new DatabaseSync(':memory:');
  if (MODE_STATS) {
    if (fs.existsSync(DB_PATH)) return openDatabase(DB_PATH);
    return new DatabaseSync(':memory:');
  }
  // A real run never creates the database: that is `node code/migrate.js --run` (Admin: "Create or update the database"), so a new install gets every table and
  // column before the first note is written, and nothing is created by accident.
  if (!fs.existsSync(DB_PATH)) {
    log('error', 'No database yet. Create it first: node code/migrate.js --run (Admin: Create or update the database). Nothing was changed.', { db: DB_PATH });
    process.exit(3);
  }
  return openDatabase(DB_PATH);
}

// A database made before M015 stores absolute paths (filepath). Every query below uses rel_path, so say so plainly instead of failing inside SQL.
function assertKeyedSchema(db) {
  var cols = db.prepare('PRAGMA table_info(vault_notes)').all().map(function(c) { return c.name; });
  if (cols.length && cols.indexOf('rel_path') < 0) {
    log('error', 'This database still stores absolute note paths (filepath). Run the migration first: node code/migrate.js --run (Admin: Create or update the database). Nothing was changed.', {});
    process.exit(3);
  }
}

// A database that has the base tables but not the migrations (no tag_source and so on) fails note by note inside SQL. Say so once, up front.
function assertMigrated(db) {
  var cols = db.prepare('PRAGMA table_info(vault_notes)').all().map(function(c) { return c.name; });
  if (cols.length && cols.indexOf('tag_source') < 0) {
    log('error', 'This database has not been migrated yet. Run: node code/migrate.js --run (Admin: Create or update the database). Nothing was changed.', {});
    process.exit(3);
  }
}

const { initSchema } = require('./lib/base_schema');

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
  // normalizeCreated keeps ISO dates and bare years, converts "17 July 2016" to ISO, and turns template leftovers like "We0-47-yyyy" into null.
  if (fm && fm.created) return normalizeCreated(fm.created);
  var m = rawContent.match(/_Created at ([^._]+)\._/);
  if (m) return normalizeCreated(m[1]);
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
  var rawContent, key;
  try { key = Paths.toKey(filepath, VAULT_PATH); }
  catch (e) { log('error', 'Cannot key file (skipped)', { file: filepath, err: e.message }); return null; }
  try { rawContent = fs.readFileSync(filepath, 'utf8'); }
  catch (e) { log('error', 'Cannot read file', { rel_path: key, err: e.message }); return null; }

  var stat = fs.statSync(filepath);
  var parsed = parseFrontmatter(rawContent);
  var fm     = parsed.frontmatter;
  var body   = parsed.body;
  var hasFM  = parsed.hasFrontmatter;

  var rawTags        = parseTags(fm, body);
  var normalisedTags = normaliseTags(rawTags);

  return {
    rel_path:        key,
    title:           extractTitle(fm, body, key),
    created:         extractCreated(fm, rawContent),
    source_url:      extractSourceUrl(fm, rawContent),
    author:          (fm && fm.author) ? fm.author.trim() : null,
    word_count:      countWords(body),
    first_paragraph: extractFirstParagraph(body),
    content_type:    inferContentType(fm, body, rawContent),
    origin:          inferOrigin(rawContent),
    folder_hint:     inferFolderHint('/' + key),   // leading slash: the year rule looks for /2026/ and must not see the machine's own folders
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
    "  (rel_path, title, created, source_url, author,",
    "   word_count, first_paragraph, content_type, origin,",
    "   has_frontmatter, has_tags, folder_hint, file_mtime, indexed_at)",
    "VALUES",
    "  (@rel_path, @title, @created, @source_url, @author,",
    "   @word_count, @first_paragraph, @content_type, @origin,",
    "   @has_frontmatter, @has_tags, @folder_hint, @file_mtime, @indexed_at)",
    "ON CONFLICT(rel_path) DO UPDATE SET",
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
    rel_path:        r.rel_path,
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

  return db.prepare('SELECT id FROM vault_notes WHERE rel_path = ?').get(r.rel_path).id;
}

// A note's tags come from two places: its frontmatter (the file on disk), and Quarry itself -
// Quick Tag Match, AI suggestions a human approved, custom tags typed in Tag Review. Quarry's own
// tags exist ONLY in this database; they have never been written back to the files.
//
// This used to DELETE every tag and re-insert the frontmatter ones, so any edit to a note
// (in Obsidian, by git pull, by writeback.js) followed by Vault Sync silently erased every tag
// Quarry had added to it - and "Full re-index" erased them vault-wide.
//
// Now: notes whose tag_source says Quarry tagged them keep all their tags and get the
// frontmatter ones merged in. Only notes still tagged purely from frontmatter ('original' or
// never tagged) are replaced wholesale, so removing a tag in Obsidian still works for those.
// Trade-off, deliberately accepted: removing a frontmatter tag from a Quarry-tagged note does
// not remove it here - untag it in Quarry instead. A lost tag is worse than a stale one.
function isQuarryTagged(tagSource) {
  return !!tagSource && tagSource !== 'original';
}

function writeNoteTags(db, noteId, tags) {
  var row = db.prepare('SELECT tag_source FROM vault_notes WHERE id = ?').get(noteId);
  var keepExisting = isQuarryTagged(row && row.tag_source);
  if (!keepExisting) db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
  // INSERT OR IGNORE relies on the unique (note_id, tag_full) index added by migration M011.
  var insertTag = db.prepare(
    'INSERT OR IGNORE INTO note_tags (note_id, tag_full, tag_root, tag_leaf, is_hierarchical) VALUES (@note_id, @tag_full, @tag_root, @tag_leaf, @is_hierarchical)'
  );
  for (var i = 0; i < tags.length; i++) {
    var t = tags[i];
    insertTag.run({ note_id: noteId, tag_full: t.tag_full, tag_root: t.tag_root, tag_leaf: t.tag_leaf, is_hierarchical: t.is_hierarchical });
  }
  // upsertNote set has_tags from the frontmatter alone; correct it from what the note really has,
  // or a Quarry-tagged note with no frontmatter tags would look untagged and be re-queued.
  var has = db.prepare('SELECT 1 FROM note_tags WHERE note_id = ? LIMIT 1').get(noteId) ? 1 : 0;
  db.prepare('UPDATE vault_notes SET has_tags = ? WHERE id = ?').run(has, noteId);
  return keepExisting;
}

// ---------------------------------------------------------------------------
// SAFETY: vault must be readable, and a snapshot is taken before any write
// ---------------------------------------------------------------------------
// An unreadable vault (unmounted, VAULT_PATH unset in the tmux server's environment, a typo)
// used to walk as ZERO files - and --diff then treated every note in the database as deleted.
function assertVaultReadable() {
  var st;
  try { st = fs.statSync(VAULT_PATH); } catch (e) { st = null; }
  if (!st || !st.isDirectory()) {
    log('error', 'Vault path is not a readable directory - refusing to index (nothing was changed)', { vaultPath: VAULT_PATH });
    process.exit(3);
  }
}

// Copy of vault.db taken before the first write of a run (VACUUM INTO makes a consistent copy
// even while other Quarry processes are using the database). Keeps the newest SNAPSHOT_KEEP.
var SNAPSHOT_DIR  = path.join(QUARRY_HOME, 'backups');
var SNAPSHOT_KEEP = 3;
var snapshotTaken = false;
function snapshotOnce(db, reason) {
  if (snapshotTaken || MODE_DRY || DB_PATH === ':memory:') return;
  snapshotTaken = true;
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    var dest = path.join(SNAPSHOT_DIR, 'vault-before-index-' + stamp + '.db');
    db.exec("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
    var old = fs.readdirSync(SNAPSHOT_DIR).filter(function(n) { return /^vault-before-index-.*\.db$/.test(n); }).sort();
    old.slice(0, Math.max(0, old.length - SNAPSHOT_KEEP)).forEach(function(n) { fs.unlinkSync(path.join(SNAPSHOT_DIR, n)); });
    log('info', 'Database snapshot taken', { file: dest, reason: reason, kept: Math.min(old.length, SNAPSHOT_KEEP) });
  } catch (e) {
    log('error', 'Could not snapshot the database - refusing to write without one', { err: e.message });
    process.exit(3);
  }
}

// Removes notes whose files are gone from the vault. Refuses mass deletions: a real clean-up
// rarely removes more than a few notes at once, while a broken walk or a half-finished git
// operation looks like "thousands of notes deleted".
function pruneOrphans(db, currentPaths) {
  var allDbNotes = db.prepare('SELECT id, rel_path, title FROM vault_notes').all();
  var orphans = allDbNotes.filter(function(n) { return !currentPaths[n.rel_path]; });
  if (orphans.length === 0) { log('info', 'No orphaned notes found'); return; }

  var limit = Math.max(10, Math.ceil(allDbNotes.length * 0.02));
  if (orphans.length > limit && !FORCE_PRUNE) {
    log('error', 'Refusing to prune: far more notes missing than a normal clean-up (nothing was removed)', {
      missing: orphans.length, ofTotal: allDbNotes.length, limit: limit,
      examples: orphans.slice(0, 5).map(function(o) { return o.rel_path; }),
      fix: 'check VAULT_PATH and the vault checkout; if the deletions are real, run indexer.js --diff --force-prune'
    });
    return;
  }

  snapshotOnce(db, 'prune ' + orphans.length + ' note(s)');
  log('info', 'Pruning orphaned notes (removed from vault)', { count: orphans.length });
  var q = {
    facts:    db.prepare('SELECT COUNT(*) AS n FROM note_classifications WHERE note_id = ?'),
    approved: db.prepare("SELECT COUNT(*) AS n FROM note_tag_proposals WHERE note_id = ? AND status = 'approved'"),
  };
  var del = ['note_tags', 'note_classifications', 'writeback_log', 'note_tag_proposals'].map(function(t) {
    return db.prepare('DELETE FROM ' + t + ' WHERE note_id = ?');
  });
  var delNote = db.prepare('DELETE FROM vault_notes WHERE id = ?');
  db.exec('BEGIN');
  try {
    orphans.forEach(function(o) {
      // A renamed or moved note looks like delete + add, so its facts and approved tags go too.
      // Logged per note so the loss is visible and can be restored from the snapshot.
      var lost = { facts: q.facts.get(o.id).n, approvedTags: q.approved.get(o.id).n };
      del.forEach(function(s) { s.run(o.id); });
      delNote.run(o.id);
      log('info', 'Pruned', { title: o.title, rel_path: o.rel_path, discarded: lost });
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    log('error', 'Orphan prune failed, rolled back', { err: e.message });
  }
}

function rebuildFts(db) {
  try { db.exec("INSERT INTO vault_fts(vault_fts) VALUES('rebuild')"); }
  catch (e) { log('warn', 'FTS rebuild warning', { err: e.message }); }
}

// ---------------------------------------------------------------------------
// PORTABILITY REPORT: names that are fine on this machine but would clash or fail elsewhere (macOS and Windows ignore letter case; Windows refuses ? : * and a
// trailing dot; very long names pass 260 characters once the vault folder is added). Reported once per run, never a reason to stop.
// ---------------------------------------------------------------------------
function reportPortability(files) {
  var keys = [], unkeyable = [];
  files.forEach(function(f) { try { keys.push(Paths.toKey(f, VAULT_PATH)); } catch (e) { unkeyable.push(f); } });
  if (unkeyable.length) log('warn', unkeyable.length + ' file name(s) cannot be keyed (a backslash or control character) and will be skipped', { examples: unkeyable.slice(0, 3) });
  var clashes = Paths.findCollisions(keys);
  if (clashes.length) log('warn', clashes.length + ' group(s) of notes differ only by letter case or Unicode form (a clash on macOS and Windows)', { examples: clashes.slice(0, 3) });
  var weak = keys.filter(function(k) { return Paths.portabilityIssues(k).length > 0; });
  if (weak.length) log('warn', weak.length + ' note name(s) would not work on Windows', { examples: weak.slice(0, 3).map(function(k) { return k + ' (' + Paths.portabilityIssues(k).join('; ') + ')'; }) });
}

// ---------------------------------------------------------------------------
// DIFF MODE
// ---------------------------------------------------------------------------
function getModifiedFiles(db, allFiles) {
  var getStmt = db.prepare('SELECT file_mtime FROM vault_notes WHERE rel_path = ?');
  return allFiles.filter(function(filepath) {
    var mtime, key;
    try { key = Paths.toKey(filepath, VAULT_PATH); } catch (_) { return true; }   // unkeyable: let parseFile report it
    try { mtime = fs.statSync(filepath).mtime.toISOString(); } catch (_) { return true; }
    var row = getStmt.get(key);
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
  assertKeyedSchema(db);
  if (!MODE_DRY) assertMigrated(db);
  if (!MODE_DRY) initSchema(db);

  if (MODE_STATS) { printStats(db); db.close(); return; }

  var files = [];
  if (!SINGLE_FILE) assertVaultReadable();
  if (SINGLE_FILE) {
    files = [path.resolve(SINGLE_FILE)];
  } else {
    log('info', 'Walking vault', { vaultPath: VAULT_PATH });
    files = walkVault(VAULT_PATH);
    log('info', 'Vault walk complete', { totalFiles: files.length });
    reportPortability(files);
    if (files.length === 0) {
      // A real run refuses an empty vault: an unmounted or emptied folder must never make every note look deleted. A dry run changes nothing, so it says what a real
      // run would do and succeeds, which lets a task that copies first (Bring Muse up to date) pass its check on a new, still-empty copy folder.
      if (MODE_DRY) {
        log('warn', 'The vault copy has no .md files yet, so there is nothing to index. Run "Copy the vault in", or run this task for real: it copies first.', { vaultPath: VAULT_PATH });
        db.close(); return;
      }
      log('error', 'Vault contains no .md files - refusing to index (nothing was changed). If this is a new copy folder, run "Copy the vault in" for real first.', { vaultPath: VAULT_PATH });
      db.close(); process.exit(3);
    }
    if (MODE_DIFF && !MODE_DRY) {
      var before = files.length;
      files = getModifiedFiles(db, files);
      log('info', 'Diff filter applied', { before: before, after: files.length });

      // Prune orphaned rows: notes in the DB whose files no longer
      // exist on disk (removed/moved out of the vault on GitHub).
      var currentPaths = {};
      walkVault(VAULT_PATH).forEach(function(p) { try { currentPaths[Paths.toKey(p, VAULT_PATH)] = true; } catch (e) { /* an unkeyable name is not a note Muse knows */ } });
      pruneOrphans(db, currentPaths);
    }
  }

  if (files.length === 0) { log('info', 'No files to index'); db.close(); return; }
  if (MODE_DRY) log('info', 'DRY RUN — parsing files, no writes');

  var processed = 0;
  var errors    = 0;
  var skipped   = 0;
  var keptQuarryTags = 0;   // notes whose Quarry-added tags were kept (frontmatter merged in)
  var batch     = [];

  function flushBatch(b) {
    snapshotOnce(db, 'index ' + files.length + ' file(s)');
    db.exec('BEGIN');
    try {
      for (var k = 0; k < b.length; k++) {
        try {
          var noteId = upsertNote(db, b[k]);
          if (writeNoteTags(db, noteId, b[k].tags)) keptQuarryTags++;
          processed++;
        } catch (e) {
          log('error', 'Failed to write record', { rel_path: b[k].rel_path, err: e.message });
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
        rel_path:     record.rel_path
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

  log('info', 'Indexing complete', { total: files.length, processed: processed, errors: errors, skipped: skipped, keptQuarryTags: keptQuarryTags });
  if (!MODE_DRY) printStats(db);
  db.close();
}

main().catch(function(e) {
  log('error', 'Indexer crashed', { err: e.message, stack: e.stack });
  process.exit(1);
});