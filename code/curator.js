#!/usr/bin/env node
/**
 * QUARRY curator.js v0.3 — Tag-Based Clustering Strategies
 *
 * Philosophy: the curator's job is NOT to find connections.
 * That is the narrator's job. The curator's job is to assemble
 * diverse, high-quality raw material and let the narrator surprise you.
 *
 * Strategies (--strategy flag):
 *   shared_root  — same tag root, diverse leaf tags (thematic unity + disciplinary diversity)
 *   weak_tie     — anchor + most topically distant note sharing ≥1 tag (min Jaccard)
 *   cross_leaf   — same leaf from different roots (e.g. india/history + japan/history)
 *
 * Legacy modes (no --strategy): retains serendipity + orphan rescue from v0.2
 *
 * Usage:
 *   node curator.js --refill [--strategy shared_root|weak_tie|cross_leaf]
 *   node curator.js --force  [--strategy shared_root|weak_tie|cross_leaf]
 *   node curator.js --status
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./lib/db');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH     = process.env.QUARRY_DB || path.join(QUARRY_HOME, 'vault.db');
const QUEUE_MIN   = 15;
const QUEUE_TARGET= 20;
const CLUSTER_SIZE= 3;
const SERENDIPITY_PCT = 0.80;
const RECENT_DAYS = 30;

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args         = process.argv.slice(2);
const MODE_REFILL  = args.includes('--refill');
const MODE_FORCE   = args.includes('--force');
const MODE_STATUS  = args.includes('--status');

const stratIdx     = args.indexOf('--strategy');
const STRATEGY     = stratIdx !== -1 ? args[stratIdx + 1] : null;

const VALID_STRATEGIES = ['shared_root', 'weak_tie', 'cross_leaf'];

if (!MODE_REFILL && !MODE_FORCE && !MODE_STATUS) {
  console.error('Usage: node curator.js [--refill|--force|--status] [--strategy shared_root|weak_tie|cross_leaf]');
  process.exit(1);
}

if (STRATEGY && !VALID_STRATEGIES.includes(STRATEGY)) {
  console.error('Unknown strategy: ' + STRATEGY + '. Valid: ' + VALID_STRATEGIES.join(', '));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(QUARRY_HOME, 'curator.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
  console.log(line);
  if (!process.env.QUARRY_LAUNCHED) { try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('vault.db not found — run indexer first');
    process.exit(1);
  }
  return openDatabase(DB_PATH);
}

// ---------------------------------------------------------------------------
// QUEUE HELPERS
// ---------------------------------------------------------------------------
function queueDepth(db) {
  return db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status = 'queued'").get().n;
}

function recentlyUsedIds(db) {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows   = db.prepare(
    "SELECT note_ids FROM narrative_queue WHERE created_at > ?"
  ).all(cutoff);
  const used = new Set();
  for (var i = 0; i < rows.length; i++) {
    try { JSON.parse(rows[i].note_ids).forEach(function(id) { used.add(id); }); } catch (_) {}
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

function makeKey(ids) {
  return JSON.stringify(ids.slice().sort(function(a, b) { return a - b; }));
}

// ---------------------------------------------------------------------------
// TAG HELPERS
// ---------------------------------------------------------------------------
function getTagRoots(db, noteId) {
  return db.prepare(
    'SELECT DISTINCT tag_root FROM note_tags WHERE note_id = ? AND tag_root IS NOT NULL'
  ).all(noteId).map(function(r) { return r.tag_root; });
}

function getTagLeafs(db, noteId) {
  // Try tag_leaf column first; fall back to parsing full tag
  try {
    const rows = db.prepare(
      'SELECT DISTINCT tag_leaf FROM note_tags WHERE note_id = ? AND tag_leaf IS NOT NULL AND tag_leaf != ""'
    ).all(noteId);
    if (rows.length > 0) return rows.map(function(r) { return r.tag_leaf; });
  } catch (_) {}
  // Fallback: derive leaf from full tag (last segment after '/')
  try {
    const rows = db.prepare(
      'SELECT DISTINCT tag FROM note_tags WHERE note_id = ? AND tag IS NOT NULL'
    ).all(noteId);
    return rows.map(function(r) {
      const parts = r.tag.split('/');
      return parts[parts.length - 1];
    }).filter(function(l) { return l; });
  } catch (_) {}
  return [];
}

function getFullTags(db, noteId) {
  try {
    return db.prepare(
      'SELECT DISTINCT tag FROM note_tags WHERE note_id = ? AND tag IS NOT NULL'
    ).all(noteId).map(function(r) { return r.tag; });
  } catch (_) {
    // Reconstruct from root+leaf if tag column absent
    try {
      return db.prepare(
        'SELECT tag_root, tag_leaf FROM note_tags WHERE note_id = ? AND tag_root IS NOT NULL'
      ).all(noteId).map(function(r) {
        return r.tag_leaf ? r.tag_root + '/' + r.tag_leaf : r.tag_root;
      });
    } catch (_) { return []; }
  }
}

// Jaccard similarity between two sets of tags
function jaccard(setA, setB) {
  if (setA.length === 0 || setB.length === 0) return 0;
  const a = new Set(setA);
  const b = new Set(setB);
  let inter = 0;
  a.forEach(function(t) { if (b.has(t)) inter++; });
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// QUALITY FILTER POOL
// ---------------------------------------------------------------------------
function buildEligiblePool(db, recentIds) {
  const hasClassifications = new Set(
    db.prepare('SELECT DISTINCT note_id FROM note_classifications').all()
      .map(function(r) { return r.note_id; })
  );

  const rows = db.prepare(
    "SELECT id, title, word_count, content_type, source_url, folder_hint FROM vault_notes " +
    "WHERE content_type NOT IN ('attachment','processed') " +
    "AND title NOT LIKE '% MOC%' AND title NOT LIKE 'MOC %' " +
    "AND (quarry_exclude IS NULL OR quarry_exclude = 0) " +
    "ORDER BY RANDOM() LIMIT 2000"
  ).all();

  return rows.filter(function(n) {
    if (recentIds.has(n.id)) return false;
    if (n.word_count < 200 && !hasClassifications.has(n.id)) return false;
    return true;
  });
}

// Pool narrowed to notes that actually have tags (needed for all three strategies)
function buildTaggedPool(db, recentIds) {
  const pool = buildEligiblePool(db, recentIds);
  const tagged = db.prepare(
    'SELECT DISTINCT note_id FROM note_tags WHERE tag_root IS NOT NULL'
  ).all().reduce(function(s, r) { s.add(r.note_id); return s; }, new Set());
  return pool.filter(function(n) { return tagged.has(n.id); });
}

// ---------------------------------------------------------------------------
// DIVERSITY CHECK (legacy — used by serendipity)
// ---------------------------------------------------------------------------
function getDomain(sourceUrl) {
  if (!sourceUrl) return null;
  try {
    const m = sourceUrl.match(/https?:\/\/([^/]+)/);
    return m ? m[1].replace(/^www\./, '') : null;
  } catch (_) { return null; }
}

function isDiverse(db, selected, candidate) {
  if (selected.length === 0) return true;
  const candRoots  = getTagRoots(db, candidate.id);
  const candDomain = getDomain(candidate.source_url);
  for (var i = 0; i < selected.length; i++) {
    const selDomain = getDomain(selected[i].source_url);
    if (candDomain && selDomain && candDomain === selDomain) return false;
  }
  if (selected.length >= 1) {
    const existingRoots = new Set();
    for (var j = 0; j < selected.length; j++) {
      getTagRoots(db, selected[j].id).forEach(function(r) { existingRoots.add(r); });
    }
    const hasSharedRoot = candRoots.some(function(r) { return existingRoots.has(r); });
    if (candRoots.length > 0 && !hasSharedRoot && selected.length >= 2) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// STRATEGY: SHARED ROOT
// Clusters notes sharing the same tag_root but with diverse leaf tags.
// Thematic unity (same root) + disciplinary diversity (different leaves).
// ---------------------------------------------------------------------------
function strategySharedRoot(db, needed, pool, existingKeys) {
  const clusters = [];

  // Build a map: tag_root -> [note_ids in pool]
  const poolIds = new Set(pool.map(function(n) { return n.id; }));
  const rootMap = {};  // root -> [{id, title, leaves:[]}]

  pool.forEach(function(n) {
    const roots  = getTagRoots(db, n.id);
    const leaves = getTagLeafs(db, n.id);
    roots.forEach(function(root) {
      if (!rootMap[root]) rootMap[root] = [];
      rootMap[root].push({ id: n.id, title: n.title, leaves: leaves });
    });
  });

  // Only consider roots with enough notes
  const eligibleRoots = Object.keys(rootMap).filter(function(r) {
    return rootMap[r].length >= CLUSTER_SIZE;
  });

  if (eligibleRoots.length === 0) {
    log('warn', 'shared_root: no roots with enough eligible notes');
    return clusters;
  }

  // Shuffle roots
  const shuffledRoots = eligibleRoots.slice().sort(function() { return Math.random() - 0.5; });
  const maxAttempts   = needed * 10;
  let attempts = 0;

  for (var ri = 0; ri < shuffledRoots.length && clusters.length < needed && attempts < maxAttempts; ri++) {
    const root  = shuffledRoots[ri];
    const notes = rootMap[root].slice().sort(function() { return Math.random() - 0.5; });

    // Pick CLUSTER_SIZE notes with maximally diverse leaf tags
    const selected = [];
    const usedLeaves = new Set();

    for (var i = 0; i < notes.length && selected.length < CLUSTER_SIZE; i++) {
      const n = notes[i];
      // Prefer notes that add new leaf tags; allow any if we're running out
      const newLeaves = n.leaves.filter(function(l) { return !usedLeaves.has(l); });
      if (selected.length < CLUSTER_SIZE - 1 && newLeaves.length === 0 && notes.length > CLUSTER_SIZE * 2) continue;
      selected.push(n);
      n.leaves.forEach(function(l) { usedLeaves.add(l); });
    }

    attempts++;

    if (selected.length < CLUSTER_SIZE) continue;

    const ids = selected.map(function(n) { return n.id; });
    const key = makeKey(ids);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    // Score: ratio of unique leaves to total leaves possible
    const uniqueLeaves = usedLeaves.size;
    const score = Math.min(1.0, 0.5 + uniqueLeaves / (CLUSTER_SIZE * 3));

    clusters.push({ ids: ids, theme: 'shared_root:' + root, score: score, key: key });
    log('info', 'shared_root cluster', {
      root:   root,
      leaves: Array.from(usedLeaves).slice(0, 6).join(', '),
      notes:  selected.map(function(n) { return n.title.slice(0, 50); })
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY: WEAK TIE
// Anchor note + most topically distant note sharing ≥1 tag (min Jaccard).
// Third note bridges the two (highest combined overlap with both).
// ---------------------------------------------------------------------------
function strategyWeakTie(db, needed, pool, existingKeys) {
  const clusters = [];

  // Cache tags for pool to avoid repeated DB calls
  const tagCache = {};
  function tagsOf(id) {
    if (!tagCache[id]) tagCache[id] = getFullTags(db, id);
    return tagCache[id];
  }

  const shuffled  = pool.slice().sort(function() { return Math.random() - 0.5; });
  const maxAnchors = Math.min(shuffled.length, needed * 15);

  for (var ai = 0; ai < maxAnchors && clusters.length < needed; ai++) {
    const anchor     = shuffled[ai];
    const anchorTags = tagsOf(anchor.id);
    if (anchorTags.length === 0) continue;
    const anchorSet  = new Set(anchorTags);

    // Find the most distant note that still shares ≥1 tag (minimum Jaccard > 0)
    let weakPartner = null;
    let minJac = Infinity;

    for (var bi = 0; bi < shuffled.length; bi++) {
      const candidate = shuffled[bi];
      if (candidate.id === anchor.id) continue;
      const candTags = tagsOf(candidate.id);
      if (candTags.length === 0) continue;

      // Must share at least one tag
      const hasShared = candTags.some(function(t) { return anchorSet.has(t); });
      if (!hasShared) continue;

      const jac = jaccard(anchorTags, candTags);
      if (jac > 0 && jac < minJac) {
        minJac = jac;
        weakPartner = candidate;
      }
    }

    if (!weakPartner) continue;
    const partnerTags = tagsOf(weakPartner.id);

    // Third note: best bridge — highest combined Jaccard with both anchor and partner
    // (but must be different from both, and not zero overlap with either)
    let bridge = null;
    let maxBridgeScore = -1;

    for (var ci = 0; ci < shuffled.length; ci++) {
      const candidate = shuffled[ci];
      if (candidate.id === anchor.id || candidate.id === weakPartner.id) continue;
      const candTags = tagsOf(candidate.id);
      if (candTags.length === 0) continue;

      const jacA = jaccard(anchorTags, candTags);
      const jacP = jaccard(partnerTags, candTags);
      if (jacA === 0 && jacP === 0) continue;  // no connection at all

      // Bridge score: reward connection to both, penalise if it's just a clone of anchor
      const bridgeScore = (jacA + jacP) - Math.abs(jacA - jacP) * 0.3;
      if (bridgeScore > maxBridgeScore) {
        maxBridgeScore = bridgeScore;
        bridge = candidate;
      }
    }

    if (!bridge) continue;

    const ids = [anchor.id, weakPartner.id, bridge.id];
    const key = makeKey(ids);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    // Score: low Jaccard between anchor+partner = more surprising connection
    const score = Math.min(1.0, 0.4 + (1 - minJac) * 0.6);

    clusters.push({ ids: ids, theme: 'weak_tie', score: score, key: key });
    log('info', 'weak_tie cluster', {
      anchor:  anchor.title.slice(0, 50),
      partner: weakPartner.title.slice(0, 50),
      bridge:  bridge.title.slice(0, 50),
      jaccard: minJac.toFixed(3)
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY: CROSS LEAF
// Notes sharing the same leaf tag from different tag roots.
// e.g. india/history + japan/history + rome/history → leaf=history, 3 roots
// ---------------------------------------------------------------------------
function strategyCrossLeaf(db, needed, pool, existingKeys) {
  const clusters = [];

  // Build leaf -> [{root, noteId, title}] map from pool
  const poolIdSet = new Set(pool.map(function(n) { return n.id; }));
  const poolById  = {};
  pool.forEach(function(n) { poolById[n.id] = n; });

  // Query: for each note in pool, get root+leaf pairs
  // We build: leaf -> [{root, id}]
  const leafMap = {};   // leaf -> [{root, id}]

  pool.forEach(function(n) {
    const roots  = getTagRoots(db, n.id);
    const leaves = getTagLeafs(db, n.id);
    if (roots.length === 0 || leaves.length === 0) return;

    leaves.forEach(function(leaf) {
      if (!leaf || leaf.length < 2) return;  // skip trivially short leaves
      roots.forEach(function(root) {
        if (!leafMap[leaf]) leafMap[leaf] = [];
        leafMap[leaf].push({ root: root, id: n.id });
      });
    });
  });

  // Filter to leaves that appear in at least CLUSTER_SIZE different roots
  const eligibleLeafs = Object.keys(leafMap).filter(function(leaf) {
    const rootSet = new Set(leafMap[leaf].map(function(e) { return e.root; }));
    return rootSet.size >= CLUSTER_SIZE;
  });

  if (eligibleLeafs.length === 0) {
    log('warn', 'cross_leaf: no leaf tags spanning >= ' + CLUSTER_SIZE + ' roots in eligible pool');
    return clusters;
  }

  // Shuffle leaves for variety
  const shuffledLeafs = eligibleLeafs.slice().sort(function() { return Math.random() - 0.5; });

  for (var li = 0; li < shuffledLeafs.length && clusters.length < needed; li++) {
    const leaf    = shuffledLeafs[li];
    const entries = leafMap[leaf];

    // Group by root, pick one random note per root
    const byRoot = {};
    entries.forEach(function(e) {
      if (!byRoot[e.root]) byRoot[e.root] = [];
      byRoot[e.root].push(e.id);
    });

    const roots = Object.keys(byRoot).filter(function(r) { return byRoot[r].length > 0; });
    if (roots.length < CLUSTER_SIZE) continue;

    // Pick CLUSTER_SIZE most-diverse roots (maximise root-name dissimilarity — just shuffle)
    const shuffledRoots = roots.slice().sort(function() { return Math.random() - 0.5; });
    const pickedRoots   = shuffledRoots.slice(0, CLUSTER_SIZE);

    const ids = pickedRoots.map(function(root) {
      const candidates = byRoot[root].slice().sort(function() { return Math.random() - 0.5; });
      return candidates[0];
    });

    // Deduplicate (a note could appear under multiple roots)
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length < CLUSTER_SIZE) continue;

    const key = makeKey(uniqueIds);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    // Score: more roots = more diverse cross-cultural sweep
    const score = Math.min(1.0, 0.5 + pickedRoots.length / (CLUSTER_SIZE * 2));

    clusters.push({ ids: uniqueIds, theme: 'cross_leaf:' + leaf, score: score, key: key });
    log('info', 'cross_leaf cluster', {
      leaf:   leaf,
      roots:  pickedRoots.join(', '),
      notes:  uniqueIds.map(function(id) {
        return poolById[id] ? poolById[id].title.slice(0, 50) : String(id);
      })
    });
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// STRATEGY: INFORMED SERENDIPITY (legacy v0.2)
// ---------------------------------------------------------------------------
function strategySerendipity(db, needed, pool, existingKeys) {
  const clusters = [];
  const attempts = needed * 20;

  for (var attempt = 0; attempt < attempts && clusters.length < needed; attempt++) {
    const shuffled = pool.slice().sort(function() { return Math.random() - 0.5; });
    const selected = [];

    for (var i = 0; i < shuffled.length && selected.length < CLUSTER_SIZE; i++) {
      const candidate = shuffled[i];
      if (selected.some(function(s) { return s.id === candidate.id; })) continue;
      if (isDiverse(db, selected, candidate)) selected.push(candidate);
    }

    if (selected.length < CLUSTER_SIZE) continue;

    const ids = selected.map(function(n) { return n.id; });
    const key = makeKey(ids);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    const allRoots = [];
    ids.forEach(function(id) {
      getTagRoots(db, id).forEach(function(r) { allRoots.push(r); });
    });
    const rootCounts = {};
    allRoots.forEach(function(r) { rootCounts[r] = (rootCounts[r] || 0) + 1; });
    const sharedRoots = Object.keys(rootCounts).filter(function(r) { return rootCounts[r] > 1; });
    const theme = sharedRoots.length > 0 ? 'serendipity:' + sharedRoots[0] : 'serendipity';
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
// STRATEGY: ORPHAN RESCUE (legacy v0.2)
// ---------------------------------------------------------------------------
function strategyOrphanRescue(db, needed, recentIds, existingKeys) {
  const clusters = [];

  const orphans = db.prepare(
    "SELECT id, title, word_count, content_type, source_url FROM vault_notes " +
    "WHERE classification_at IS NULL AND word_count >= 300 AND content_type IN ('article', 'note') " +
    "ORDER BY RANDOM() LIMIT ?"
  ).all(needed * CLUSTER_SIZE * 3);

  const fresh = orphans.filter(function(n) { return !recentIds.has(n.id); });

  for (var i = 0; i + CLUSTER_SIZE <= fresh.length && clusters.length < needed; i += CLUSTER_SIZE) {
    const group = fresh.slice(i, i + CLUSTER_SIZE);
    const ids   = group.map(function(n) { return n.id; });
    const key   = makeKey(ids);
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

  const next3  = db.prepare(
    "SELECT id, seed_theme, priority_score, note_ids FROM narrative_queue WHERE status = 'queued' ORDER BY priority_score DESC LIMIT 3"
  ).all();

  console.log('\n' + '═'.repeat(39));
  console.log('  QUARRY QUEUE STATUS');
  console.log('═'.repeat(39));
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
  console.log('\n' + '═'.repeat(39) + '\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  log('info', 'QUARRY curator v0.3 starting', {
    args:     args.join(' '),
    strategy: STRATEGY || 'legacy'
  });

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

  const toGenerate   = MODE_FORCE ? QUEUE_TARGET : Math.max(0, QUEUE_TARGET - depth);
  const recentIds    = recentlyUsedIds(db);
  const existingKeys = alreadyQueuedKeys(db);

  log('info', 'Generating candidates', { total: toGenerate, strategy: STRATEGY || 'legacy' });

  let allClusters = [];

  if (STRATEGY) {
    // Tag-based strategy: use tagged-pool (notes with at least one tag)
    const pool = buildTaggedPool(db, recentIds);
    log('info', 'Tagged-eligible pool built', { size: pool.length });

    if (pool.length < CLUSTER_SIZE) {
      log('warn', 'Pool too small to form clusters', { size: pool.length });
      db.close();
      return;
    }

    if (STRATEGY === 'shared_root') {
      allClusters = strategySharedRoot(db, toGenerate, pool, existingKeys);
    } else if (STRATEGY === 'weak_tie') {
      allClusters = strategyWeakTie(db, toGenerate, pool, existingKeys);
    } else if (STRATEGY === 'cross_leaf') {
      allClusters = strategyCrossLeaf(db, toGenerate, pool, existingKeys);
    }

    if (allClusters.length < toGenerate) {
      log('warn', 'Strategy yielded fewer clusters than requested', {
        strategy: STRATEGY,
        got:      allClusters.length,
        wanted:   toGenerate
      });
    }

  } else {
    // Legacy: serendipity + orphan rescue
    const pool = buildEligiblePool(db, recentIds);
    log('info', 'Eligible pool built', { size: pool.length });

    if (pool.length < CLUSTER_SIZE) {
      log('warn', 'Pool too small to form clusters', { size: pool.length });
      db.close();
      return;
    }

    const serendipityN = Math.ceil(toGenerate * SERENDIPITY_PCT);
    const orphanN      = toGenerate - serendipityN;
    log('info', 'Legacy split', { serendipity: serendipityN, orphan: orphanN });

    const sc = strategySerendipity(db, serendipityN, pool, existingKeys);
    const oc = strategyOrphanRescue(db, orphanN, recentIds, existingKeys);
    allClusters = sc.concat(oc);
  }

  allClusters.sort(function(a, b) { return b.score - a.score; });

  db.exec('BEGIN');
  for (var i = 0; i < allClusters.length; i++) {
    var c = allClusters[i];
    insertCluster(db, c.ids, c.theme, c.score);
  }
  db.exec('COMMIT');

  log('info', 'Curator complete', {
    strategy: STRATEGY || 'legacy',
    inserted: allClusters.length
  });

  printStatus(db);
  db.close();
}

main();
