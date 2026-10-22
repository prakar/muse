#!/usr/bin/env node
// QUARRY writeback.js v1.1
// Normalising writeback: rewrites vault .md frontmatter tags using the
// canonical vocabulary from FORM/TAG archaeology. HIL-staged, reversible.
//
// Usage:
//   node writeback.js --stage noise      --dry-run
//   node writeback.js --stage normalise  --dry-run
//   node writeback.js --stage quarry         --dry-run
//   node writeback.js --stage sync-approved  --dry-run
//   node writeback.js --stage <name> --confirm [--limit N] [--commit]
//
// Stages (run in order):
//   noise      strip confirmed noise tags from frontmatter
//   normalise  replace remaining tags with canonical vocabulary
//   quarry     write quarry_exclude: true into frontmatter for DB-flagged notes
//   sync-approved  write HIL-approved tags (switch3-hil) back to vault frontmatter
//
// Flags:
//   --dry-run   show changes, write nothing (always run first)
//   --confirm   required to actually write files
//   --limit N   process at most N notes (for spot-checking)
//   --commit    after writing, git add + commit with a stage message
//   --diff      (sync-approved only) skip notes whose file tags already match DB
//
// Rollback (before push):
//   git -C $VAULT_PATH checkout -- .
//   node indexer.js --diff
//
// Rollback (after push):
//   git -C $VAULT_PATH revert HEAD && git -C $VAULT_PATH push
//   node indexer.js --full

'use strict';

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./lib/db');   // sets a busy timeout - see lib/db.js

const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const DB_PATH      = process.env.QUARRY_DB   || path.join(QUARRY_HOME, 'vault.db');
const VAULT_PATH   = process.env.VAULT_PATH  || path.join(process.env.HOME, 'dev', 'md-vaults', 'knowledge');
const ARCH_OUT     = path.join(process.env.HOME, 'dev', 'archaeology_output');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args      = process.argv.slice(2);
const STAGE     = (() => { const i = args.indexOf('--stage'); return i !== -1 ? args[i+1] : null; })();
const MODE_DRY  = args.includes('--dry-run');
const CONFIRMED = args.includes('--confirm');
const DO_COMMIT = args.includes('--commit');
const DO_DIFF   = args.includes('--diff');
const LIMIT     = (() => { const i = args.indexOf('--limit'); return i !== -1 ? parseInt(args[i+1],10) : Infinity; })();

const VALID_STAGES = ['noise', 'normalise', 'quarry', 'sync-approved'];

if (!STAGE || !VALID_STAGES.includes(STAGE)) {
  console.error('Usage: node writeback.js --stage <noise|normalise|quarry|sync-approved> [--dry-run|--confirm] [--limit N] [--commit] [--diff]');
  process.exit(1);
}
if (!MODE_DRY && !CONFIRMED) {
  console.error('Refusing to write without --dry-run or --confirm.');
  console.error('Run --dry-run first to preview changes.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const LOG_PATH = path.join(QUARRY_HOME, 'writeback.log');
function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg, stage: STAGE }, data);
  const line = JSON.stringify(entry);
  console.log(line);
  if (!process.env.QUARRY_LAUNCHED) { try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch(_) {} }
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) { console.error('vault.db not found at', DB_PATH); process.exit(1); }
  return openDatabase(DB_PATH);
}

// ---------------------------------------------------------------------------
// LOAD ARCHAEOLOGY OUTPUT
// ---------------------------------------------------------------------------
function loadJson(name) {
  const fp = path.join(ARCH_OUT, name);
  if (!fs.existsSync(fp)) {
    console.error('Missing archaeology output file:', fp);
    console.error('Run archaeology_encoder.py first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function loadNoisePatterns() {
  const data = loadJson('noise_patterns.json');
  return data.patterns.map(p => new RegExp(p, 'i'));
}

function loadNormalisationMap() {
  return loadJson('normalisation_map.json');
}

// ---------------------------------------------------------------------------
// YAML FRONTMATTER PARSING (minimal, tags-focused)
// ---------------------------------------------------------------------------
function readFrontmatter(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/);
  if (!m) return { raw, frontmatter: null, fmText: '', body: raw };
  return { raw, frontmatter: m[1], fmText: m[1], body: raw.slice(m[1].length) };
}

// Extracts tags from a frontmatter block. Handles two common forms:
//   tags: #foo #bar/baz #qux         (space-separated, hash-prefixed)
//   tags: [foo, bar/baz, qux]        (YAML list)
//   tags:\n  - foo\n  - bar/baz      (YAML block list)
function extractTagsFromFrontmatter(fmText) {
  if (!fmText) return { tags: [], tagLineInfo: null };

  // Try inline hash-space form: tags: #a #b/c
  let m = fmText.match(/^tags:\s*((?:#\S+\s*)+)$/m);
  if (m) {
    const tags = m[0].match(/#(\S+)/g).map(t => t.slice(1));
    return { tags, tagLineInfo: { type: 'hash-inline', match: m[0] } };
  }

  // Try YAML flow list: tags: [a, b/c, d]
  m = fmText.match(/^tags:\s*\[([^\]]*)\]\s*$/m);
  if (m) {
    const tags = m[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    return { tags, tagLineInfo: { type: 'yaml-flow', match: m[0] } };
  }

  // Try YAML block list: tags:\n  - a\n  - b/c
  m = fmText.match(/^tags:\s*\n((?:^\s*-\s+(?!--\s*$).+\n?)+)/m);
  if (m) {
    const tags = m[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    return { tags, tagLineInfo: { type: 'yaml-block', match: m[0] } };
  }

  return { tags: [], tagLineInfo: null };
}

function replaceTagsInFrontmatter(fmText, newTags) {
  const { tagLineInfo } = extractTagsFromFrontmatter(fmText);
  const newTagLine = 'tags: [' + newTags.map(t => `"${t}"`).join(', ') + ']\n';

  if (!tagLineInfo) {
    // No existing tags line - insert one after the opening ---
    return fmText.replace(/^---\r?\n/, m => m + newTagLine);
  }

  if (tagLineInfo.type === 'hash-inline' || tagLineInfo.type === 'yaml-flow') {
    return fmText.replace(tagLineInfo.match, newTagLine.trim());
  }
  // yaml-block
  return fmText.replace(tagLineInfo.match, newTagLine);
}

// ---------------------------------------------------------------------------
// STAGE: NOISE — strip confirmed noise tags
// ---------------------------------------------------------------------------
function runNoiseStage(db, noisePatterns) {
  const notes = db.prepare(
    "SELECT id, filepath, title FROM vault_notes WHERE content_type != 'attachment' ORDER BY id LIMIT ?"
  ).all(LIMIT === Infinity ? 999999 : LIMIT);

  log('info', 'Noise stage starting', { totalNotes: notes.length });

  let changed = 0, unchanged = 0, errors = 0;

  for (const note of notes) {
    try {
      if (!fs.existsSync(note.filepath)) { errors++; continue; }
      const { frontmatter, body } = readFrontmatter(note.filepath);
      if (!frontmatter) { unchanged++; continue; }

      const { tags } = extractTagsFromFrontmatter(frontmatter);
      if (!tags.length) { unchanged++; continue; }

      const kept = tags.filter(t => !noisePatterns.some(p => p.test(t)));

      if (kept.length === tags.length) { unchanged++; continue; }

      changed++;
      if (MODE_DRY) {
        log('info', 'Would strip noise', { title: note.title.slice(0,60), before: tags.length, after: kept.length, removed: tags.filter(t => !kept.includes(t)) });
        continue;
      }

      const newFm = replaceTagsInFrontmatter(frontmatter, kept);
      fs.writeFileSync(note.filepath + '.bak', fs.readFileSync(note.filepath));
      fs.writeFileSync(note.filepath, newFm + body, 'utf8');

      db.prepare(
        'INSERT INTO writeback_log (note_id, stage, tags_before, tags_after, written_at) VALUES (?,?,?,?,?)'
      ).run(note.id, 'noise', JSON.stringify(tags), JSON.stringify(kept), new Date().toISOString());

      log('info', 'Noise stripped', { title: note.title.slice(0,60), before: tags.length, after: kept.length });
    } catch(e) {
      errors++;
      log('error', 'Noise stage failed', { title: note.title.slice(0,60), err: e.message });
    }
  }

  log('info', 'Noise stage complete', { changed, unchanged, errors, dryRun: MODE_DRY });
}

// ---------------------------------------------------------------------------
// STAGE: NORMALISE — replace tags with canonical vocabulary
// ---------------------------------------------------------------------------
function runNormaliseStage(db, normMap, noisePatterns) {
  const notes = db.prepare(
    "SELECT id, filepath, title FROM vault_notes WHERE content_type != 'attachment' ORDER BY id LIMIT ?"
  ).all(LIMIT === Infinity ? 999999 : LIMIT);

  log('info', 'Normalise stage starting', { totalNotes: notes.length, mapSize: Object.keys(normMap).length });

  let changed = 0, unchanged = 0, errors = 0;

  for (const note of notes) {
    try {
      if (!fs.existsSync(note.filepath)) { errors++; continue; }
      const { frontmatter, body } = readFrontmatter(note.filepath);
      if (!frontmatter) { unchanged++; continue; }

      const { tags } = extractTagsFromFrontmatter(frontmatter);
      if (!tags.length) { unchanged++; continue; }

      // Strip any remaining noise first
      let working = tags.filter(t => !noisePatterns.some(p => p.test(t)));

      // Apply normalisation map, dedupe
      const seen = new Set();
      const result = [];
      let hadMOC = false;

      for (const t of working) {
        if (normMap[t]) {
          for (const nt of normMap[t]) {
            if (nt === 'QUARRY_EXCLUDE') { hadMOC = true; continue; }
            if (!seen.has(nt)) { seen.add(nt); result.push(nt); }
          }
        } else {
          if (!seen.has(t)) { seen.add(t); result.push(t); }
        }
      }

      const setsEqual = result.length === tags.length && result.every(t => tags.includes(t));
      if (setsEqual && !hadMOC) { unchanged++; continue; }

      changed++;
      if (MODE_DRY) {
        log('info', 'Would normalise', { title: note.title.slice(0,60), before: tags, after: result, wouldExcludeMOC: hadMOC });
        continue;
      }

      const newFm = replaceTagsInFrontmatter(frontmatter, result);
      fs.writeFileSync(note.filepath + '.bak', fs.readFileSync(note.filepath));
      fs.writeFileSync(note.filepath, newFm + body, 'utf8');

      db.prepare(
        'INSERT INTO writeback_log (note_id, stage, tags_before, tags_after, written_at) VALUES (?,?,?,?,?)'
      ).run(note.id, 'normalise', JSON.stringify(tags), JSON.stringify(result), new Date().toISOString());

      if (hadMOC) {
        db.prepare('UPDATE vault_notes SET quarry_exclude = 1 WHERE id = ?').run(note.id);
        log('info', 'MOC detected — quarry_exclude set', { title: note.title.slice(0,60) });
      }

      log('info', 'Normalised', { title: note.title.slice(0,60), before: tags.length, after: result.length });
    } catch(e) {
      errors++;
      log('error', 'Normalise stage failed', { title: note.title.slice(0,60), err: e.message });
    }
  }

  log('info', 'Normalise stage complete', { changed, unchanged, errors, dryRun: MODE_DRY });
}

// ---------------------------------------------------------------------------
// STAGE: QUARRY — write quarry_exclude flags into frontmatter
// ---------------------------------------------------------------------------
function runQuarryStage(db) {
  const notes = db.prepare(
    "SELECT id, filepath, title FROM vault_notes WHERE quarry_exclude = 1 ORDER BY id LIMIT ?"
  ).all(LIMIT === Infinity ? 999999 : LIMIT);

  log('info', 'Quarry stage starting', { flaggedNotes: notes.length });

  let changed = 0, unchanged = 0, errors = 0;

  for (const note of notes) {
    try {
      if (!fs.existsSync(note.filepath)) { errors++; continue; }
      const raw = fs.readFileSync(note.filepath, 'utf8');

      if (/^quarry_exclude:\s*true/m.test(raw)) { unchanged++; continue; }

      changed++;
      if (MODE_DRY) {
        log('info', 'Would flag quarry_exclude', { title: note.title.slice(0,60) });
        continue;
      }

      const { frontmatter, body } = readFrontmatter(note.filepath);
      let newFm;
      if (frontmatter) {
        newFm = frontmatter.replace(/^---\r?\n/, m => m + 'quarry_exclude: true\n');
      } else {
        newFm = '---\nquarry_exclude: true\n---\n';
      }

      fs.writeFileSync(note.filepath + '.bak', raw);
      fs.writeFileSync(note.filepath, newFm + (frontmatter ? body : raw), 'utf8');

      db.prepare(
        'INSERT INTO writeback_log (note_id, stage, tags_before, tags_after, written_at) VALUES (?,?,?,?,?)'
      ).run(note.id, 'quarry', null, 'quarry_exclude:true', new Date().toISOString());

      log('info', 'quarry_exclude written', { title: note.title.slice(0,60) });
    } catch(e) {
      errors++;
      log('error', 'Quarry stage failed', { title: note.title.slice(0,60), err: e.message });
    }
  }

  log('info', 'Quarry stage complete', { changed, unchanged, errors, dryRun: MODE_DRY });
}


// ---------------------------------------------------------------------------
// STAGE: SYNC-APPROVED — write HIL-approved tags back to vault frontmatter
//
// Source of truth: note_tag_proposals WHERE status='approved', joined to
// vault_notes WHERE tag_source='switch3-hil'.
//
// Strategy: union of existing frontmatter tags + approved DB tags, sorted.
// This preserves any pre-existing tags the file already has while adding the
// approved set. No tags are ever removed by this stage.
//
// --diff mode: skip a note if every approved DB tag is already present in the
// file's current frontmatter. Speeds up re-runs after partial completion.
// ---------------------------------------------------------------------------
function runSyncApprovedStage(db) {
  // Load all notes that completed HIL review, ordered by id for determinism
  const notes = db.prepare(
    `SELECT id, filepath, title
     FROM vault_notes
     WHERE tag_source = 'switch3-hil'
     ORDER BY id
     LIMIT ?`
  ).all(LIMIT === Infinity ? 999999 : LIMIT);

  log('info', 'sync-approved stage starting', {
    totalNotes: notes.length,
    diffMode: DO_DIFF,
    dryRun: MODE_DRY
  });

  // Prepared statements reused across the loop
  const getApproved = db.prepare(
    `SELECT DISTINCT tag_full
     FROM note_tag_proposals
     WHERE note_id = ? AND status = 'approved'
     ORDER BY tag_full`
  );
  const insertLog = db.prepare(
    'INSERT INTO writeback_log (note_id, stage, tags_before, tags_after, written_at) VALUES (?,?,?,?,?)'
  );

  let changed = 0, skipped = 0, unchanged = 0, errors = 0;

  for (const note of notes) {
    try {
      // Get the set of approved tags from the DB for this note
      const approvedRows = getApproved.all(note.id);
      if (!approvedRows.length) {
        // Unusual: tag_source=switch3-hil but no approved proposals (might be
        // a custom-tag note where the reviewer typed tags directly). Skip.
        skipped++;
        log('info', 'No approved proposals — skipping', { title: note.title.slice(0,60) });
        continue;
      }
      const approvedTags = approvedRows.map(r => r.tag_full);

      // Read the file
      if (!fs.existsSync(note.filepath)) {
        errors++;
        log('warn', 'File not found', { title: note.title.slice(0,60), filepath: note.filepath });
        continue;
      }

      const { frontmatter, body } = readFrontmatter(note.filepath);

      // Extract what's currently in the file
      const { tags: existingFileTags } = extractTagsFromFrontmatter(frontmatter || '');

      // Build the union: existing file tags + approved DB tags, deduplicated and sorted
      const existingLower = new Set(existingFileTags.map(t => t.toLowerCase()));
      const merged = [...existingFileTags];
      for (const t of approvedTags) {
        if (!existingLower.has(t.toLowerCase())) {
          merged.push(t);
        }
      }
      merged.sort();

      // --diff: skip if all approved tags are already in the file
      if (DO_DIFF) {
        const allPresent = approvedTags.every(t =>
          existingLower.has(t.toLowerCase())
        );
        if (allPresent) { unchanged++; continue; }
      }

      // Check if any change is actually needed
      const existingSorted = [...existingFileTags].sort();
      const noChange = merged.length === existingSorted.length &&
        merged.every((t, i) => t === existingSorted[i]);
      if (noChange) { unchanged++; continue; }

      // Count how many new tags are being added
      const added = merged.filter(t => !existingLower.has(t.toLowerCase()));

      changed++;
      if (MODE_DRY) {
        log('info', 'Would write approved tags', {
          title: note.title.slice(0,60),
          fileTags: existingFileTags.length,
          approvedTags: approvedTags.length,
          merged: merged.length,
          added: added
        });
        continue;
      }

      // Write the updated frontmatter
      let newFm;
      if (frontmatter) {
        newFm = replaceTagsInFrontmatter(frontmatter, merged);
      } else {
        // Note has no standard frontmatter yet — create one with just the tags
        newFm = '---\ntags: [' + merged.map(t => `"${t}"`).join(', ') + ']\n---\n';
      }

      // Backup then write
      fs.writeFileSync(note.filepath + '.bak', fs.readFileSync(note.filepath));
      fs.writeFileSync(note.filepath, newFm + body, 'utf8');

      insertLog.run(
        note.id,
        'sync-approved',
        JSON.stringify(existingFileTags),
        JSON.stringify(merged),
        new Date().toISOString()
      );

      log('info', 'Tags written', {
        title: note.title.slice(0,60),
        before: existingFileTags.length,
        after: merged.length,
        added: added.length
      });
    } catch(e) {
      errors++;
      log('error', 'sync-approved failed for note', { title: note.title.slice(0,60), err: e.message });
    }
  }

  log('info', 'sync-approved stage complete', {
    changed, skipped, unchanged, errors,
    dryRun: MODE_DRY,
    diffMode: DO_DIFF
  });
}

// ---------------------------------------------------------------------------
// GIT COMMIT
// ---------------------------------------------------------------------------
function gitCommit(stage) {
  try {
    cp.execFileSync('git', ['-C', VAULT_PATH, 'add', '-u'], { stdio: 'inherit' });
    cp.execFileSync('git', ['-C', VAULT_PATH, 'commit', '-m', `QUARRY writeback: ${stage} stage`], { stdio: 'inherit' });
    const sha = cp.execFileSync('git', ['-C', VAULT_PATH, 'rev-parse', 'HEAD']).toString().trim();
    log('info', 'Git commit created', { stage, sha });
    return sha;
  } catch(e) {
    log('error', 'Git commit failed', { stage, err: e.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  log('info', 'writeback.js starting', { stage: STAGE, dryRun: MODE_DRY, limit: LIMIT === Infinity ? 'none' : LIMIT });

  const db = openDb();

  if (STAGE === 'noise') {
    const noisePatterns = loadNoisePatterns();
    runNoiseStage(db, noisePatterns);
  } else if (STAGE === 'normalise') {
    const noisePatterns = loadNoisePatterns();
    const normMap = loadNormalisationMap();
    runNormaliseStage(db, normMap, noisePatterns);
  } else if (STAGE === 'quarry') {
    runQuarryStage(db);
  } else if (STAGE === 'sync-approved') {
    runSyncApprovedStage(db);
  }

  if (!MODE_DRY && DO_COMMIT) {
    gitCommit(STAGE);
  } else if (!MODE_DRY) {
    log('info', 'Files written but NOT committed. Review changes, then:', {
      hint: `git -C ${VAULT_PATH} add -u && git -C ${VAULT_PATH} commit -m "QUARRY writeback: ${STAGE} stage"`
    });
  }

  db.close();
  log('info', 'writeback.js complete', { stage: STAGE });
}

main();
