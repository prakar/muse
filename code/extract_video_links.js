#!/usr/bin/env node
// QUARRY extract_video_links.js v0.1
// Scans all vault .md files, extracts video URLs, updates vault_notes.video_links
//
// Usage:
//   node extract_video_links.js              # process all notes
//   node extract_video_links.js --limit 100  # process first N notes
//   node extract_video_links.js --dry-run    # print matches, no DB writes
//   node extract_video_links.js --id 5089    # single note by DB id

'use strict';

const fs   = require('fs');
const path = require('path');
// QUARRY_HOME is the quarry directory itself (default ~/dev/quarry): the DB, logs and chunk caches live
// directly under it. (These scripts once treated it as a PARENT and appended dev/quarry, which doubles
// the path when QUARRY_HOME=$HOME/dev/quarry - the convention writeback.js and the docs use.)
const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.QUARRY_DB || path.join(QUARRY_HOME, 'vault.db');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT   = (() => { const i = args.indexOf('--limit'); return i !== -1 ? parseInt(args[i+1],10) : Infinity; })();
const ONLY_ID = (() => { const i = args.indexOf('--id');    return i !== -1 ? parseInt(args[i+1],10) : null; })();

// ---------------------------------------------------------------------------
// VIDEO URL PATTERNS
// Matches YouTube, Vimeo, Dailymotion, Rumble, Twitch, and bare video file URLs.
// Captures the full URL including query strings (e.g. ?v=xxxxx, ?t=123).
// ---------------------------------------------------------------------------
const VIDEO_PATTERNS = [
  // YouTube: watch, embed, short youtu.be, shorts, live
  /https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s"')>\]]+/g,
  /https?:\/\/(?:www\.)?youtube\.com\/embed\/[^\s"')>\]]+/g,
  /https?:\/\/(?:www\.)?youtube\.com\/shorts\/[^\s"')>\]]+/g,
  /https?:\/\/(?:www\.)?youtube\.com\/live\/[^\s"')>\]]+/g,
  /https?:\/\/youtu\.be\/[^\s"')>\]]+/g,
  // Vimeo
  /https?:\/\/(?:www\.)?vimeo\.com\/[0-9][^\s"')>\]]*/g,
  // Dailymotion
  /https?:\/\/(?:www\.)?dailymotion\.com\/video\/[^\s"')>\]]+/g,
  // Rumble
  /https?:\/\/rumble\.com\/[^\s"')>\]]+/g,
  // Twitch clips and streams
  /https?:\/\/(?:www\.)?twitch\.tv\/[^\s"')>\]]+/g,
  // Bare video file links (.mp4 .webm .mov .avi)
  /https?:\/\/[^\s"')>\]]+\.(?:mp4|webm|mov|avi)(?:\?[^\s"')>\]]*)?/gi,
];

function extractVideoLinks(text) {
  const found = new Set();

  // 1. Broad URL capture (robust)
  const urlRegex = /https?:\/\/[^\s"'<>()\]]+/g;

  let m;
  while ((m = urlRegex.exec(text)) !== null) {
    let url = m[0];

    // Clean trailing junk
    url = url.replace(/[.,;:!?)\]]+$/, '');

    // 2. Filter: video platforms OR real video files
    if (
      url.includes('youtube.com') ||
      url.includes('youtu.be') ||
      url.includes('vimeo.com') ||
      url.includes('dailymotion.com') ||
      url.includes('rumble.com') ||
      url.includes('twitch.tv') ||
      /\.(mp4|webm|avi)$/i.test(url)
    ) {
      found.add(url);
    }
  }

  return Array.from(found);
}

// ---------------------------------------------------------------------------
// SCHEMA: add columns if missing
// ---------------------------------------------------------------------------
function ensureColumns(db) {
  const cols = db.prepare('PRAGMA table_info(vault_notes)').all().map(c => c.name);
  if (!cols.includes('video_links'))      db.exec('ALTER TABLE vault_notes ADD COLUMN video_links TEXT');
  if (!cols.includes('video_transcripts'))db.exec('ALTER TABLE vault_notes ADD COLUMN video_transcripts TEXT');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('vault.db not found'); process.exit(1); }
  const db = new DatabaseSync(DB_PATH);
  ensureColumns(db);

  let query, params;
  if (ONLY_ID !== null) {
    query  = 'SELECT id, title, filepath FROM vault_notes WHERE id = ?';
    params = [ONLY_ID];
  } else {
    const lim = LIMIT === Infinity ? 999999 : LIMIT;
    query  = "SELECT id, title, filepath FROM vault_notes WHERE content_type != 'attachment' ORDER BY id LIMIT ?";
    params = [lim];
  }

  const notes = db.prepare(query).all(...params);
  console.log('Notes to scan:', notes.length, DRY_RUN ? '(dry-run)' : '');

  let updated = 0, withLinks = 0, noFile = 0;

  const stmt = db.prepare('UPDATE vault_notes SET video_links = ? WHERE id = ?');

  for (const note of notes) {
    if (!fs.existsSync(note.filepath)) { noFile++; continue; }

    const text  = fs.readFileSync(note.filepath, 'utf8');
    const links = extractVideoLinks(text);

    if (links.length === 0) continue;

    withLinks++;
    const csv = JSON.stringify(links);

    if (DRY_RUN) {
      console.log('\n[' + note.id + '] ' + note.title.slice(0, 70));
      links.forEach(l => console.log('  ' + l));
    } else {
      stmt.run(csv, note.id);
      updated++;
      if (updated <= 5 || links.length > 3) {
        // Log notable finds
        console.log('[' + note.id + '] ' + links.length + ' links — ' + note.title.slice(0, 60));
      }
    }
  }

  db.close();

  console.log('\n=== DONE ===');
  console.log('Scanned:    ', notes.length);
  console.log('With links: ', withLinks);
  if (!DRY_RUN) console.log('Updated:    ', updated);
  console.log('Missing file:', noFile);
}

main();