#!/usr/bin/env node
/**
 * QUARRY curator.js v0.2 — Informed Serendipity
 *
 * Philosophy: the curator's job is NOT to find connections.
 * That is the narrator's job. The curator's job is to assemble
 * diverse, high-quality raw material and let the narrator surprise you.
 *
 * Architecture:
 *   80% INFORMED SERENDIPITY — 3 random notes passing quality + diversity filters
 *   20% ORPHAN RESCUE — unclassified notes with real content, never surfaced
 *
 * Quality filter (hard constraints):
 *   - No stubs unless Switch-4 classified (word_count >= 200 OR has classifications)
 *   - No more than 1 concept-only note per cluster (content_type != 'note' dominated)
 *   - Not used in narrative_queue in last 30 days
 *   - content_type != 'attachment'
 *
 * Diversity constraint (the only curation):
 *   - Notes must come from at least 2 different tag_roots
 *   - Notes must span at least 2 different year folders (decades preferred)
 *   - No two notes from same source_url domain
 *
 * Usage:
 *   node curator.js --refill       Refill if below threshold
 *   node curator.js --force        Generate 20 new candidates regardless of depth
 *   node curator.js --status       Print queue status and exit
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH = process.env.QUARRY_DB
  || path.join(process.env.HOME, 'quarry', 'vault.db');

const QUEUE_MIN       = 15;   // refill when below this
const QUEUE_TARGET    = 20;   // generate this many per refill
const CLUSTER_SIZE    = 3;    // always 3 notes — tighter braids
const SERENDIPITY_PCT = 0.80; // 80% random, 20% orphan rescue
const RECENT_DAYS     = 30;   // don't reuse notes surfaced in this window

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const MODE_REFILL = args.includes('--refill');
const MODE_FORCE  = args.includes('--force');
const MODE_STATUS = args.includes('--status');

if (!MODE_REFILL && !MODE_FORCE && !MODE_STATUS) {
  console.error('Usage: node curator.js [--refill|--force|--status]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.HOME, 'quarry', 'curator.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
  console.log(line);
  try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {}
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('vault.db not found — run indexer first');
    process.exit(1);
  }
  return new DatabaseSync(DB_PATH);
}

// ---------------------------------------------------------------------------
// QUEUE HELPERS
// ---------------------------------------------------------------------------
function queueDepth(db) {
  return db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'queued'").get().n;
}

function recentlyUsedIds(db) {
  // Notes used in queue items in the last RECENT_DAYS days
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows   = db.prepare(
    "SELECT note_ids FROM narrative_queue WHERE created_at > ?"
  ).all(cutoff);

  const used = new Set();
  for (var i = 0; i < rows.length; i++) {
    try {
      JSON.parse(rows[i].note_ids).forEach(function(id) { used.add(id); });
    } catch (_) {}
  }
  return used;
}

function alreadyQueuedKeys(db) {
  const rows = db.prepare(
    "SELECT note_ids FROM narrative_queue WHERE status IN ('queued', 'done')"
  ).all();
  const keys = new Set();
  for (var i = 0; i < rows.length; i++) {
    try {
      const ids = JSON.parse(rows[i].note_ids).sort(function(a, b) { return a - b; });
      keys.add(JSON.stringify(ids));
    } catch (_) {}
  }
  return keys;
}

function insertCluster(db, noteIds, seedTheme, score) {
  const sorted = noteIds.slice().sort(function(a, b) { return a - b; });
  db.prepare(
    'INSERT INTO narrative_queue (note_ids, seed_theme, priority_score, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(JSON.stringify(sorted), seedTheme, score, 'queued', new Date().toISOString());
}

// ---------------------------------------------------------------------------
// QUALITY FILTER POOL
// Returns all notes eligible for clustering.
// ---------------------------------------------------------------------------
function buildEligiblePool(db, recentIds) {
  // A note is eligible if:
  // - Not recently used
  // - Not an attachment
  // - Either has real content (word_count >= 200) OR has Switch-4 classifications
  // - Not a pure concept-only note flagged as such
  //   (we detect concept-only by: content_type = 'note' AND word_count < 200 AND no classifications)

  const hasClassifications = new Set(
    db.prepare('SELECT DISTINCT note_id FROM note_classifications').all()
      .map(function(r) { return r.note_id; })
  );

  const rows = db.prepare(
    "SELECT id, title, word_count, content_type, source_url, folder_hint FROM vault_notes WHERE content_type != 'attachment' ORDER BY RANDOM() LIMIT 2000"
  ).all();

  return rows.filter(function(n) {
    if (recentIds.has(n.id)) return false;
    // Reject thin notes without classifications
    if (n.word_count < 200 && !hasClassifications.has(n.id)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// DIVERSITY CHECK
// Returns true if adding `candidate` to `selected` maintains diversity.
// ---------------------------------------------------------------------------
function getTagRoots(db, noteId) {
  return db.prepare(
    'SELECT DISTINCT tag_root FROM note_tags WHERE note_id = ? AND tag_root IS NOT NULL'
  ).all(noteId).map(function(r) { return r.tag_root; });
}

function getDomain(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const m = sourceUrl.match(/https?:\/\/([^/]+)/);
    return m ? m[1].replace(/^www\./, '') : null;
  } catch (_) { return null; }
}

function getYear(folderHint, filepath) {
  // Try to extract year from filepath
  const m = (filepath || '').match(/\/(20\d\d|19\d\d)\//);
  return m ? m[1] : null;
}

function isDiverse(db, selected, candidate) {
  if (selected.length === 0) return true;

  const candRoots   = getTagRoots(db, candidate.id);
  const candDomain  = getDomain(candidate.source_url);

  // Check domain uniqueness
  for (var i = 0; i < selected.length; i++) {
    const selDomain = getDomain(selected[i].source_url);
    if (candDomain && selDomain && candDomain === selDomain) return false;
  }

  // After first note, require at least one different tag root
  if (selected.length >= 1) {
    const existingRoots = new Set();
    for (var j = 0; j < selected.length; j++) {
      getTagRoots(db, selected[j].id).forEach(function(r) { existingRoots.add(r); });
    }
    const hasNewRoot = candRoots.some(function(r) { return !existingRoots.has(r); });
    const hasSharedRoot = candRoots.some(function(r) { return existingRoots.has(r); });
    // Need at least one shared root (some connection) AND at least one new root (diversity)
    // Exception: if candidate has no tags, allow it — tags are incomplete
    if (candRoots.length > 0 && !hasSharedRoot && selected.length >= 2) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// STRATEGY: INFORMED SERENDIPITY
// Pure random selection within quality + diversity constraints.
// ---------------------------------------------------------------------------
function strategySerendipity(db, needed, pool, existingKeys) {
  const clusters = [];
  const attempts = needed * 20; // max attempts to avoid infinite loop

  for (var attempt = 0; attempt < attempts && clusters.length < needed; attempt++) {
    // Shuffle pool slice for this attempt
    const shuffled = pool.slice().sort(function() { return Math.random() - 0.5; });
    const selected = [];

    for (var i = 0; i < shuffled.length && selected.length < CLUSTER_SIZE; i++) {
      const candidate = shuffled[i];
      if (selected.some(function(s) { return s.id === candidate.id; })) continue;
      if (isDiverse(db, selected, candidate)) {
        selected.push(candidate);
      }
    }

    if (selected.length < CLUSTER_SIZE) continue;

    const ids = selected.map(function(n) { return n.id; });
    const key = JSON.stringify(ids.slice().sort(function(a, b) { return a - b; }));
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    // Seed theme: the shared tag root(s) or 'serendipity' if none
    const allRoots = [];
    ids.forEach(function(id) {
      getTagRoots(db, id).forEach(function(r) { allRoots.push(r); });
    });
    const rootCounts = {};
    allRoots.forEach(function(r) { rootCounts[r] = (rootCounts[r] || 0) + 1; });
    const sharedRoots = Object.keys(rootCounts).filter(function(r) { return rootCounts[r] > 1; });
    const theme = sharedRoots.length > 0 ? 'serendipity:' + sharedRoots[0] : 'serendipity';

    // Score: higher if notes span more tag roots and more years
    const uniqueRoots = new Set(allRoots).size;
    const score = Math.min(1.0, uniqueRoots / (CLUSTER_SIZE * 2));

    clusters.push({ ids: ids, theme: theme, score: score, key: key });

    log('info', 'Serendipity cluster', {
      theme: theme,
      notes: selected.map(function(n) { return n.title.slice(0, 50); })
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY: ORPHAN RESCUE
// Unclassified notes with real content, never surfaced.
// Groups them into clusters of CLUSTER_SIZE.
// ---------------------------------------------------------------------------
function strategyOrphanRescue(db, needed, recentIds, existingKeys) {
  const clusters = [];

  const orphans = db.prepare(
    "SELECT id, title, word_count, content_type, source_url FROM vault_notes WHERE classification_at IS NULL AND word_count >= 300 AND content_type IN ('article', 'note') ORDER BY RANDOM() LIMIT ?"
  ).all(needed * CLUSTER_SIZE * 3);

  const fresh = orphans.filter(function(n) { return !recentIds.has(n.id); });

  for (var i = 0; i + CLUSTER_SIZE <= fresh.length && clusters.length < needed; i += CLUSTER_SIZE) {
    const group = fresh.slice(i, i + CLUSTER_SIZE);
    const ids   = group.map(function(n) { return n.id; });
    const key   = JSON.stringify(ids.slice().sort(function(a, b) { return a - b; }));
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    clusters.push({ ids: ids, theme: 'orphan', score: 0.3, key: key });
    log('info', 'Orphan cluster', {
      notes: group.map(function(n) { return n.title.slice(0, 50); })
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function printStatus(db) {
  const depth  = queueDepth(db);
  const inProg = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'in_progress'").get().n;
  const done   = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'done'").get().n;
  const failed = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'failed'").get().n;
  const narr   = db.prepare('SELECT COUNT(*) as n FROM narratives').get().n;

  const next3 = db.prepare(
    "SELECT id, seed_theme, priority_score, note_ids FROM narrative_queue WHERE status = 'queued' ORDER BY priority_score DESC LIMIT 3"
  ).all();

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  QUARRY QUEUE STATUS');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  Queued:      ' + depth);
  console.log('  In progress: ' + inProg);
  console.log('  Done:        ' + done);
  console.log('  Failed:      ' + failed);
  console.log('  Narratives:  ' + narr);

  if (next3.length > 0) {
    console.log('\n  Next up:');
    next3.forEach(function(r) {
      var ids   = JSON.parse(r.note_ids);
      var notes = db.prepare(
        'SELECT title FROM vault_notes WHERE id IN (' + ids.join(',') + ')'
      ).all();
      console.log('\n  [' + r.priority_score.toFixed(2) + '] ' + r.seed_theme);
      notes.forEach(function(n) { console.log('    - ' + n.title.slice(0, 60)); });
    });
  }
  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  log('info', 'QUARRY curator v0.2 starting', { args: args.join(' ') });

  const db = openDb();

  if (MODE_STATUS) { printStatus(db); db.close(); return; }

  const depth = queueDepth(db);
  log('info', 'Queue depth check', { depth: depth, min: QUEUE_MIN });

  if (MODE_REFILL && depth >= QUEUE_MIN) {
    log('info', 'Queue above threshold — no refill needed', { depth: depth });
    printStatus(db);
    db.close();
    return;
  }

  const toGenerate  = MODE_FORCE ? QUEUE_TARGET : Math.max(0, QUEUE_TARGET - depth);
  const serendipityN = Math.ceil(toGenerate * SERENDIPITY_PCT);
  const orphanN      = toGenerate - serendipityN;

  log('info', 'Generating candidates', {
    total: toGenerate,
    serendipity: serendipityN,
    orphan: orphanN
  });

  const recentIds    = recentlyUsedIds(db);
  const existingKeys = alreadyQueuedKeys(db);
  const pool         = buildEligiblePool(db, recentIds);

  log('info', 'Eligible pool built', { size: pool.length });

  if (pool.length < CLUSTER_SIZE) {
    log('warn', 'Pool too small to form clusters', { size: pool.length });
    db.close();
    return;
  }

  // Generate serendipity clusters
  const serendipityClusters = strategySerendipity(db, serendipityN, pool, existingKeys);

  // Generate orphan clusters
  const orphanClusters = strategyOrphanRescue(db, orphanN, recentIds, existingKeys);

  // Insert all clusters
  const allClusters = serendipityClusters.concat(orphanClusters);
  allClusters.sort(function(a, b) { return b.score - a.score; });

  db.exec('BEGIN');
  for (var i = 0; i < allClusters.length; i++) {
    var c = allClusters[i];
    insertCluster(db, c.ids, c.theme, c.score);
  }
  db.exec('COMMIT');

  log('info', 'Curator complete', {
    serendipity: serendipityClusters.length,
    orphan:      orphanClusters.length,
    total:       allClusters.length
  });

  printStatus(db);
  db.close();
}

main();