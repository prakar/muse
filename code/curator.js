#!/usr/bin/env node
/**
 * QUARRY curator.js v0.1
 * Keeps the narrative_queue populated with candidate note clusters.
 * Zero API calls — pure SQLite query logic.
 *
 * Usage:
 *   node curator.js --refill       Refill queue if below threshold (normal cron use)
 *   node curator.js --force        Generate 20 new candidates regardless of queue depth
 *   node curator.js --status       Print queue status and exit
 *   node curator.js --strategy <n> Run only strategy 1-5 (for testing)
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

const QUEUE_MIN    = 15;  // refill when queue drops below this
const QUEUE_TARGET = 20;  // how many to generate per refill
const CLUSTER_MIN  = 2;   // minimum notes per cluster
const CLUSTER_MAX  = 5;   // maximum notes per cluster

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args          = process.argv.slice(2);
const MODE_REFILL   = args.includes('--refill');
const MODE_FORCE    = args.includes('--force');
const MODE_STATUS   = args.includes('--status');
const STRATEGY_ONLY = (() => {
  const i = args.indexOf('--strategy');
  return i !== -1 ? parseInt(args[i + 1], 10) : null;
})();

if (!MODE_REFILL && !MODE_FORCE && !MODE_STATUS && STRATEGY_ONLY === null) {
  console.error('Usage: node curator.js [--refill|--force|--status|--strategy <1-5>]');
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
    console.error('vault.db not found at', DB_PATH, '— run indexer first');
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

function alreadyQueued(db) {
  // Returns a Set of JSON-stringified sorted note_id arrays already in queue
  const rows = db.prepare(
    "SELECT note_ids FROM narrative_queue WHERE status IN ('queued','done')"
  ).all();
  return new Set(rows.map(r => {
    const ids = JSON.parse(r.note_ids);
    ids.sort((a, b) => a - b);
    return JSON.stringify(ids);
  }));
}

function insertCluster(db, noteIds, seedTheme, score) {
  const sorted = [...noteIds].sort((a, b) => a - b);
  const key    = JSON.stringify(sorted);
  return { key, sorted, seedTheme, score };
}

function flushClusters(db, clusters, existingKeys) {
  const stmt = db.prepare(
    'INSERT INTO narrative_queue (note_ids, seed_theme, priority_score, status, created_at) VALUES (@note_ids, @seed_theme, @priority_score, @status, @created_at)'
  );

  let added = 0;
  for (const c of clusters) {
    if (existingKeys.has(c.key)) continue;
    stmt.run({
      note_ids:       c.key,
      seed_theme:     c.seedTheme,
      priority_score: c.score,
      status:         'queued',
      created_at:     new Date().toISOString()
    });
    existingKeys.add(c.key);
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------
function scoreCluster(noteIds, notes, tagRoots) {
  // novelty_score: 1.0 if none recently surfaced (we don't track this yet → 1.0 default)
  const noveltyScore = 1.0;

  // resonance_score: ratio of distinct tag_roots to total notes
  // High when notes come from very different tag domains
  const uniqueRoots = new Set(tagRoots.filter(Boolean)).size;
  const resonanceScore = noteIds.length > 1
    ? Math.min(1.0, uniqueRoots / noteIds.length)
    : 0.5;

  // freshness_bonus: +0.2 if any note has word_count > 500 (proxy for depth)
  const hasDepth = notes.some(n => n.word_count > 500);
  const freshBonus = hasDepth ? 0.2 : 0.0;

  return noveltyScore * resonanceScore * 0.5 + freshBonus;
}

// ---------------------------------------------------------------------------
// STRATEGY 1: TAG BRIDGE
// Find notes sharing a tag_leaf across different tag_roots.
// e.g. "rivers" appears in both india/rivers and music/folk/rivers
// ---------------------------------------------------------------------------
function strategyTagBridge(db, needed) {
  log('info', 'Strategy 1: Tag Bridge');

  // Find tag_leaves that appear under multiple different roots
  const bridgeLeaves = db.prepare(`
    SELECT tag_leaf, COUNT(DISTINCT tag_root) as root_count, COUNT(DISTINCT note_id) as note_count
    FROM note_tags
    WHERE tag_leaf IS NOT NULL AND tag_leaf != ''
      AND is_hierarchical = 1
    GROUP BY tag_leaf
    HAVING root_count >= 2 AND note_count >= 2
    ORDER BY root_count DESC, note_count DESC
    LIMIT 50
  `).all();

  if (bridgeLeaves.length === 0) {
    log('info', 'Tag Bridge: no bridge leaves found');
    return [];
  }

  const clusters = [];
  const seen     = new Set();

  for (const leaf of bridgeLeaves) {
    if (clusters.length >= needed) break;

    // Get notes with this leaf, grouped by root
    const notesByRoot = db.prepare(`
      SELECT n.id, n.title, n.word_count, n.content_type, nt.tag_root, nt.tag_full
      FROM vault_notes n
      JOIN note_tags nt ON nt.note_id = n.id
      WHERE nt.tag_leaf = ?
        AND n.content_type != 'attachment'
        AND n.word_count > 50
      ORDER BY nt.tag_root, RANDOM()
    `).all(leaf.tag_leaf);

    // Pick one note from each distinct root, up to CLUSTER_MAX
    const byRoot = {};
    for (const row of notesByRoot) {
      if (!byRoot[row.tag_root]) byRoot[row.tag_root] = row;
    }

    const selected = Object.values(byRoot).slice(0, CLUSTER_MAX);
    if (selected.length < CLUSTER_MIN) continue;

    const ids  = selected.map(n => n.id);
    const key  = JSON.stringify([...ids].sort((a, b) => a - b));
    if (seen.has(key)) continue;
    seen.add(key);

    const tagRoots = selected.map(n => n.tag_root);
    const score    = scoreCluster(ids, selected, tagRoots);

    clusters.push(insertCluster(db, ids, `leaf:${leaf.tag_leaf}`, score));
    log('info', 'Tag Bridge cluster', {
      leaf: leaf.tag_leaf,
      roots: tagRoots,
      notes: selected.map(n => n.title)
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY 2: TEMPORAL PROXIMITY
// Notes created in the same month/year — captures reading sessions.
// ---------------------------------------------------------------------------
function strategyTemporal(db, needed) {
  log('info', 'Strategy 2: Temporal Proximity');

  // Find month/year buckets with enough notes
  const buckets = db.prepare(`
    SELECT
      SUBSTR(created, 1, 7) as month_bucket,
      COUNT(*) as note_count
    FROM vault_notes
    WHERE created IS NOT NULL
      AND LENGTH(created) >= 7
      AND content_type != 'attachment'
      AND word_count > 100
    GROUP BY month_bucket
    HAVING note_count >= 3
    ORDER BY RANDOM()
    LIMIT 100
  `).all();

  const clusters = [];
  const seen     = new Set();

  for (const bucket of buckets) {
    if (clusters.length >= needed) break;

    // Pick random notes from this month
    const notes = db.prepare(`
      SELECT id, title, word_count, content_type
      FROM vault_notes
      WHERE SUBSTR(created, 1, 7) = ?
        AND content_type != 'attachment'
        AND word_count > 100
      ORDER BY RANDOM()
      LIMIT ?
    `).all(bucket.month_bucket, CLUSTER_MAX);

    if (notes.length < CLUSTER_MIN) continue;

    const ids = notes.map(n => n.id);
    const key = JSON.stringify([...ids].sort((a, b) => a - b));
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scoreCluster(ids, notes, []);
    clusters.push(insertCluster(db, ids, `period:${bucket.month_bucket}`, score));
    log('info', 'Temporal cluster', {
      period: bucket.month_bucket,
      notes:  notes.map(n => n.title)
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY 3: SEED WORD
// Pick a random meaningful word from FTS, find notes containing it.
// ---------------------------------------------------------------------------
function strategySeedWord(db, needed) {
  log('info', 'Strategy 3: Seed Word');

  // Sample random notes and extract candidate seed words from their titles
  const sampleNotes = db.prepare(`
    SELECT id, title, first_paragraph
    FROM vault_notes
    WHERE content_type IN ('article', 'note')
      AND word_count > 150
    ORDER BY RANDOM()
    LIMIT 200
  `).all();

  // Extract meaningful words (length > 5, not stopwords)
  const stopwords = new Set([
    'about', 'after', 'again', 'being', 'between', 'could', 'every',
    'first', 'found', 'great', 'group', 'haven', 'hence', 'house',
    'large', 'later', 'local', 'might', 'never', 'often', 'other',
    'place', 'right', 'shall', 'since', 'small', 'still', 'their',
    'there', 'these', 'thing', 'think', 'those', 'three', 'through',
    'under', 'until', 'using', 'water', 'where', 'which', 'while',
    'world', 'would', 'years', 'before', 'during', 'people', 'should',
    'states', 'system', 'toward', 'within', 'without'
  ]);

  const wordFreq = {};
  for (const note of sampleNotes) {
    const text = ((note.title || '') + ' ' + (note.first_paragraph || '')).toLowerCase();
    const words = text.match(/[a-z]{6,}/g) || [];
    for (const w of words) {
      if (!stopwords.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1;
    }
  }

  // Pick words that appear 3-20 times (specific enough to be meaningful)
  const candidates = Object.entries(wordFreq)
    .filter(([, n]) => n >= 3 && n <= 20)
    .sort(() => Math.random() - 0.5)
    .slice(0, 30)
    .map(([w]) => w);

  const clusters = [];
  const seen     = new Set();

  for (const word of candidates) {
    if (clusters.length >= needed) break;

    // FTS search for this word
    let notes;
    try {
      notes = db.prepare(`
        SELECT vn.id, vn.title, vn.word_count, vn.content_type
        FROM vault_fts
        JOIN vault_notes vn ON vn.id = vault_fts.rowid
        WHERE vault_fts MATCH ?
          AND vn.content_type != 'attachment'
          AND vn.word_count > 100
        ORDER BY RANDOM()
        LIMIT ?
      `).all(word, CLUSTER_MAX);
    } catch (_) {
      continue; // FTS match can fail on some tokens
    }

    if (notes.length < CLUSTER_MIN) continue;

    const ids = notes.map(n => n.id);
    const key = JSON.stringify([...ids].sort((a, b) => a - b));
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scoreCluster(ids, notes, []);
    clusters.push(insertCluster(db, ids, `word:${word}`, score));
    log('info', 'Seed word cluster', {
      word,
      notes: notes.map(n => n.title)
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY 4: ORPHAN RESCUE
// Untagged notes with real content that have never been surfaced.
// ---------------------------------------------------------------------------
function strategyOrphanRescue(db, needed) {
  log('info', 'Strategy 4: Orphan Rescue');

  // Get orphans not already in any queue entry
  const queuedIds = new Set();
  const queuedRows = db.prepare(
    "SELECT note_ids FROM narrative_queue"
  ).all();
  for (const row of queuedRows) {
    try {
      JSON.parse(row.note_ids).forEach(id => queuedIds.add(id));
    } catch (_) {}
  }

  const orphans = db.prepare(`
    SELECT id, title, word_count, content_type, created
    FROM vault_notes
    WHERE has_tags = 0
      AND word_count > 300
      AND content_type IN ('article', 'note')
    ORDER BY RANDOM()
    LIMIT ?
  `).all(needed * CLUSTER_MAX);

  // Filter out already-queued
  const fresh = orphans.filter(n => !queuedIds.has(n.id));
  if (fresh.length < CLUSTER_MIN) {
    log('info', 'Orphan Rescue: insufficient fresh orphans', { found: fresh.length });
    return [];
  }

  const clusters = [];
  const seen     = new Set();

  // Group into clusters of CLUSTER_MIN-CLUSTER_MAX
  // Use random grouping — the narrator will find connections
  for (let i = 0; i < fresh.length && clusters.length < needed; i += CLUSTER_MIN) {
    const group = fresh.slice(i, i + CLUSTER_MAX);
    if (group.length < CLUSTER_MIN) break;

    const ids = group.map(n => n.id);
    const key = JSON.stringify([...ids].sort((a, b) => a - b));
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scoreCluster(ids, group, []) - 0.1; // slight penalty for no tags
    clusters.push(insertCluster(db, ids, 'orphan', score));
    log('info', 'Orphan cluster', { notes: group.map(n => n.title) });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY 5: TAG-ADJACENT
// Start from a tag_root, find notes under it, then find notes sharing
// words with those but having completely different tags.
// Crosses domain boundaries.
// ---------------------------------------------------------------------------
function strategyTagAdjacent(db, needed) {
  log('info', 'Strategy 5: Tag-Adjacent');

  // Pick a random tag_root that has enough notes
  const roots = db.prepare(`
    SELECT tag_root, COUNT(DISTINCT note_id) as n
    FROM note_tags
    GROUP BY tag_root
    HAVING n >= 3
    ORDER BY RANDOM()
    LIMIT 20
  `).all();

  const clusters = [];
  const seen     = new Set();

  for (const root of roots) {
    if (clusters.length >= needed) break;

    // Get notes from this root
    const seedNotes = db.prepare(`
      SELECT DISTINCT vn.id, vn.title, vn.word_count, vn.first_paragraph
      FROM vault_notes vn
      JOIN note_tags nt ON nt.note_id = vn.id
      WHERE nt.tag_root = ?
        AND vn.content_type != 'attachment'
        AND vn.word_count > 100
      ORDER BY RANDOM()
      LIMIT 2
    `).all(root.tag_root);

    if (seedNotes.length === 0) continue;

    // Extract distinctive words from seed notes
    const seedText = seedNotes
      .map(n => (n.title || '') + ' ' + (n.first_paragraph || ''))
      .join(' ')
      .toLowerCase();

    const words = (seedText.match(/[a-z]{7,}/g) || [])
      .filter(w => !['between', 'through', 'because', 'against', 'another',
                     'without', 'however', 'whether', 'nothing', 'history',
                     'different', 'important', 'including', 'following'].includes(w));

    if (words.length === 0) continue;

    // Pick a random word and find notes with DIFFERENT tag roots
    const pivot = words[Math.floor(Math.random() * Math.min(words.length, 10))];
    const seedIds = new Set(seedNotes.map(n => n.id));

    let adjacentNotes;
    try {
      adjacentNotes = db.prepare(`
        SELECT DISTINCT vn.id, vn.title, vn.word_count, vn.content_type
        FROM vault_fts
        JOIN vault_notes vn ON vn.id = vault_fts.rowid
        LEFT JOIN note_tags nt ON nt.note_id = vn.id AND nt.tag_root = ?
        WHERE vault_fts MATCH ?
          AND vn.content_type != 'attachment'
          AND vn.word_count > 100
          AND (nt.tag_root IS NULL OR nt.tag_root != ?)
        ORDER BY RANDOM()
        LIMIT 3
      `).all(root.tag_root, pivot, root.tag_root);
    } catch (_) {
      continue;
    }

    if (adjacentNotes.length === 0) continue;

    const allNotes = [...seedNotes, ...adjacentNotes].slice(0, CLUSTER_MAX);
    const ids      = allNotes.map(n => n.id);
    const key      = JSON.stringify([...ids].sort((a, b) => a - b));
    if (seen.has(key)) continue;
    seen.add(key);

    // Tag-adjacent gets a resonance bonus since it deliberately crosses domains
    const tagRoots = [root.tag_root, ...adjacentNotes.map(() => 'adjacent')];
    const score    = scoreCluster(ids, allNotes, tagRoots) + 0.1;

    clusters.push(insertCluster(db, ids, `adjacent:${root.tag_root}→${pivot}`, score));
    log('info', 'Tag-adjacent cluster', {
      root: root.tag_root,
      pivot,
      seeds:    seedNotes.map(n => n.title),
      adjacent: adjacentNotes.map(n => n.title)
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------
function printStatus(db) {
  const depth   = queueDepth(db);
  const inProg  = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'in_progress'").get().n;
  const done    = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'done'").get().n;
  const failed  = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'failed'").get().n;
  const narr    = db.prepare('SELECT COUNT(*) as n FROM narratives').get().n;

  const next3 = db.prepare(`
    SELECT seed_theme, priority_score, note_ids
    FROM narrative_queue
    WHERE status = 'queued'
    ORDER BY priority_score DESC
    LIMIT 3
  `).all();

  console.log('\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  QUARRY QUEUE STATUS');
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  console.log('  Queued:      ' + depth);
  console.log('  In progress: ' + inProg);
  console.log('  Done:        ' + done);
  console.log('  Failed:      ' + failed);
  console.log('  Narratives:  ' + narr);
  if (next3.length > 0) {
    console.log('\n  Next up (by score):');
    next3.forEach(function(r) {
      var ids = JSON.parse(r.note_ids);
      console.log('    [' + r.priority_score.toFixed(2) + '] ' + r.seed_theme + ' (' + ids.length + ' notes)');
    });
  }
  console.log('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  log('info', 'QUARRY curator starting', { args: args.join(' ') });

  var db = openDb();

  if (MODE_STATUS) {
    printStatus(db);
    db.close();
    return;
  }

  var depth = queueDepth(db);
  log('info', 'Queue depth check', { depth: depth, min: QUEUE_MIN });

  if (MODE_REFILL && depth >= QUEUE_MIN) {
    log('info', 'Queue above threshold — no refill needed', { depth: depth });
    printStatus(db);
    db.close();
    return;
  }

  var toGenerate = QUEUE_TARGET;
  if (MODE_REFILL) toGenerate = QUEUE_TARGET - depth;

  log('info', 'Generating candidates', { target: toGenerate });

  var existingKeys = alreadyQueued(db);
  var allClusters  = [];

  // Rotate through strategies
  var strategies = STRATEGY_ONLY
    ? [STRATEGY_ONLY]
    : [1, 2, 3, 4, 5];

  var perStrategy = Math.ceil(toGenerate / strategies.length);

  for (var i = 0; i < strategies.length; i++) {
    var s = strategies[i];
    var results = [];

    try {
      if (s === 1) results = strategyTagBridge(db, perStrategy);
      else if (s === 2) results = strategyTemporal(db, perStrategy);
      else if (s === 3) results = strategySeedWord(db, perStrategy);
      else if (s === 4) results = strategyOrphanRescue(db, perStrategy);
      else if (s === 5) results = strategyTagAdjacent(db, perStrategy);
    } catch (e) {
      log('error', 'Strategy failed', { strategy: s, err: e.message });
    }

    log('info', 'Strategy complete', { strategy: s, clusters: results.length });
    allClusters = allClusters.concat(results);
  }

  // Sort by score descending before inserting
  allClusters.sort(function(a, b) { return b.score - a.score; });

  var added = flushClusters(db, allClusters, existingKeys);
  log('info', 'Curator complete', { generated: allClusters.length, added: added });

  printStatus(db);
  db.close();
}

main();