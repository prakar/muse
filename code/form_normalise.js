#!/usr/bin/env node
// QUARRY form_normalise.js v1.0
// FORM structural normalisation — converts all 5 known frontmatter
// variants to standard YAML (---\n...\n---\n) BEFORE writeback.js runs.
// Syntactic only: no tags are invented, merged, or interpreted here.
// Existing tag content is preserved verbatim (moved, not rewritten).
//
// Variants handled (see QUARRY_V2_ARCHITECTURE.md Phase 2.5):
//   A_standard            — already correct, left untouched
//   B_pseudo              — H1, lone ---, tags: line, no closing --- 
//                           => wrap into standard YAML, preserve tags
//   B_lone_dash_no_tags   — H1, lone --- as visual separator, NO tags
//                           => wrap into standard YAML with empty tags
//   C_bare_inline         — #tags floating in body, no frontmatter
//                           => extract inline tags into new YAML block
//   D_no_tags_found       — no markers at all
//                           => add empty standard YAML shell
//
// Also captures the Evernote export fingerprint footer
// ("_Created at Fr0-34-yyyy._ / _Last updated at Mo0-33-yyyy._")
// into a source_date_raw field. The dates are known-garbled from the
// original export tool; captured verbatim for provenance, not parsed.
//
// Usage:
//   node form_normalise.js --scan                 report counts only, no writes
//   node form_normalise.js --dry-run [--limit N]   show planned changes
//   node form_normalise.js --confirm [--limit N] [--commit]

'use strict';

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./lib/db');   // sets a busy timeout - see lib/db.js

const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const DB_PATH      = process.env.QUARRY_DB   || path.join(QUARRY_HOME, 'vault.db');
const VAULT_PATH   = process.env.VAULT_PATH  || path.join(process.env.HOME, 'dev', 'md-vaults', 'knowledge');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args      = process.argv.slice(2);
const MODE_SCAN = args.includes('--scan');
const MODE_DRY  = args.includes('--dry-run');
const CONFIRMED = args.includes('--confirm');
const DO_COMMIT = args.includes('--commit');
const LIMIT     = (() => { const i = args.indexOf('--limit'); return i !== -1 ? parseInt(args[i+1],10) : Infinity; })();

if (!MODE_SCAN && !MODE_DRY && !CONFIRMED) {
  console.error('Usage: node form_normalise.js --scan | --dry-run [--limit N] | --confirm [--limit N] [--commit]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const LOG_PATH = path.join(QUARRY_HOME, 'form_normalise.log');
function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line = JSON.stringify(entry);
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch(_) {}
}

// ---------------------------------------------------------------------------
// VARIANT CLASSIFIER (mirrors form_scan.py logic, in JS for direct use)
// ---------------------------------------------------------------------------
function classifyVariant(raw) {
  if (/^---\r?\n/.test(raw)) {
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    return m ? 'A_standard' : 'A_unclosed';
  }
  const lines = raw.split('\n');
  let dashIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].trim() === '---') { dashIdx = i; break; }
  }
  if (dashIdx !== -1) {
    const hasTagsNearby = lines.slice(dashIdx, Math.min(dashIdx+8, lines.length))
      .some(l => /^tags:/i.test(l));
    return hasTagsNearby ? 'B_pseudo' : 'B_lone_dash_no_tags';
  }
  if (/(?<![\w&])#[A-Za-z]/.test(raw.slice(0, 500))) return 'C_bare_inline';
  return 'D_no_tags_found';
}

// ---------------------------------------------------------------------------
// EVERNOTE FOOTER EXTRACTION
// Captures "_Created at Fr0-34-yyyy._ / _Last updated at Mo0-33-yyyy._"
// verbatim. Dates are a known-garbled artifact of the original export
// tool - not parsed, just preserved for provenance.
// ---------------------------------------------------------------------------
function extractEvernoteFooter(text) {
  const created = text.match(/_Created at ([^_]*)\._/);
  const updated = text.match(/_Last updated at ([^_]*)\._/);
  if (!created && !updated) return null;
  return {
    created: created ? created[1].trim() : null,
    updated: updated ? updated[1].trim() : null,
    fullMatch: [created ? created[0] : '', updated ? updated[0] : ''].filter(Boolean)
  };
}

function stripEvernoteFooter(text, footer) {
  if (!footer) return text;
  let out = text;
  for (const m of footer.fullMatch) {
    out = out.replace(m, '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// NORMALISERS — one per variant, all produce standard YAML frontmatter
// ---------------------------------------------------------------------------
function yamlEscape(s) {
  return String(s).replace(/"/g, '\\"');
}

function buildStandardFrontmatter(tags, sourceDateRaw) {
  const lines = ['---'];
  if (tags && tags.length) {
    lines.push('tags: [' + tags.map(t => `"${yamlEscape(t)}"`).join(', ') + ']');
  } else {
    lines.push('tags: []');
  }
  if (sourceDateRaw && (sourceDateRaw.created || sourceDateRaw.updated)) {
    if (sourceDateRaw.created) lines.push(`source_date_raw_created: "${yamlEscape(sourceDateRaw.created)}"`);
    if (sourceDateRaw.updated) lines.push(`source_date_raw_updated: "${yamlEscape(sourceDateRaw.updated)}"`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// B_pseudo: H1, lone ---, tags: line, no closing ---.
// Extract tags, extract H1 as title (keep H1 in body - it's the note's
// own heading, not purely metadata), wrap everything properly.
function normaliseBPseudo(raw) {
  const lines = raw.split('\n');
  let dashIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].trim() === '---') { dashIdx = i; break; }
  }
  let tagsLineIdx = -1;
  for (let j = dashIdx + 1; j < Math.min(dashIdx + 8, lines.length); j++) {
    if (/^tags:/i.test(lines[j])) { tagsLineIdx = j; break; }
  }

  const tagsLine = lines[tagsLineIdx];
  const tags = (tagsLine.match(/#(\S+)/g) || []).map(t => t.slice(1));

  // Some notes have a closing --- right after the tags line (blank line,
  // then ---, then real body). Strip it if present so it doesn't leak
  // into the body as a stray line.
  let bodyStartIdx = tagsLineIdx + 1;
  for (let k = bodyStartIdx; k < Math.min(bodyStartIdx + 3, lines.length); k++) {
    if (lines[k].trim() === '') continue;
    if (lines[k].trim() === '---') { bodyStartIdx = k + 1; }
    break;
  }

  // Body = everything before the lone --- (the H1/title area) plus
  // everything after the tags line / optional closing --- (actual content)
  const preamble = lines.slice(0, dashIdx).join('\n');
  const rest = lines.slice(bodyStartIdx).join('\n');
  let body = (preamble + '\n' + rest).replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const footer = extractEvernoteFooter(body);
  if (footer) body = stripEvernoteFooter(body, footer).replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const fm = buildStandardFrontmatter(tags, footer);
  return fm + '\n' + body;
}

// B_lone_dash_no_tags: H1, lone --- as pure visual separator, no tags.
// Wrap with empty tags, preserve H1 + body exactly, capture footer.
function normaliseBLoneDash(raw) {
  const lines = raw.split('\n');
  let dashIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].trim() === '---') { dashIdx = i; break; }
  }
  const preamble = lines.slice(0, dashIdx).join('\n');
  const rest = lines.slice(dashIdx + 1).join('\n');
  let body = (preamble + '\n' + rest).replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const footer = extractEvernoteFooter(body);
  if (footer) body = stripEvernoteFooter(body, footer).replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const fm = buildStandardFrontmatter([], footer);
  return fm + '\n' + body;
}

// C_bare_inline: #tags floating in body, no frontmatter structure.
// Extract tags from first 15 lines, promote to real frontmatter,
// remove the bare tag line(s) from the body.
function normaliseCBareInline(raw) {
  const lines = raw.split('\n');
  const scanRange = Math.min(15, lines.length);
  const tags = [];
  const tagLineIndices = [];

  for (let i = 0; i < scanRange; i++) {
    const matches = lines[i].match(/(?<![\w&])#([A-Za-z][A-Za-z0-9_/-]*)/g);
    if (matches) {
      matches.forEach(m => tags.push(m.slice(1)));
      // Only remove the line if it's PURELY tags (nothing else meaningful)
      const withoutTags = lines[i].replace(/(?<![\w&])#[A-Za-z][A-Za-z0-9_/-]*/g, '').trim();
      if (withoutTags === '') tagLineIndices.push(i);
    }
  }

  const bodyLines = lines.filter((_, i) => !tagLineIndices.includes(i));
  let body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const footer = extractEvernoteFooter(body);
  if (footer) body = stripEvernoteFooter(body, footer).replace(/\n{3,}/g, '\n\n').trim() + '\n';

  const fm = buildStandardFrontmatter([...new Set(tags)], footer);
  return fm + '\n' + body;
}

// D_no_tags_found: no markers, pure prose. Add an empty shell.
function normaliseDNoTags(raw) {
  let body = raw.trim() + '\n';
  const footer = extractEvernoteFooter(body);
  if (footer) body = stripEvernoteFooter(body, footer).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const fm = buildStandardFrontmatter([], footer);
  return fm + '\n' + body;
}

function normalise(raw, variant) {
  switch (variant) {
    case 'B_pseudo':             return normaliseBPseudo(raw);
    case 'B_lone_dash_no_tags':  return normaliseBLoneDash(raw);
    case 'C_bare_inline':        return normaliseCBareInline(raw);
    case 'D_no_tags_found':      return normaliseDNoTags(raw);
    default:                     return null; // A_standard, A_unclosed - not handled here
  }
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) { console.error('vault.db not found'); process.exit(1); }
  return openDatabase(DB_PATH);
}

// ---------------------------------------------------------------------------
// SCAN MODE — pure census, no writes, no DB needed
// ---------------------------------------------------------------------------
function runScan() {
  const notes = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) notes.push(full);
    }
  }
  walk(VAULT_PATH);

  const counts = {};
  for (const fp of notes) {
    const raw = fs.readFileSync(fp, 'utf8');
    const v = classifyVariant(raw);
    counts[v] = (counts[v] || 0) + 1;
  }

  console.log(`Total notes scanned: ${notes.length}\n`);
  Object.entries(counts).sort((a,b) => b[1]-a[1]).forEach(([v,c]) => {
    console.log(`  ${v.padEnd(25)} ${String(c).padStart(5)}  (${(100*c/notes.length).toFixed(1)}%)`);
  });
}

// ---------------------------------------------------------------------------
// MAIN (dry-run / confirm)
// ---------------------------------------------------------------------------
function main() {
  if (MODE_SCAN) { runScan(); return; }

  log('info', 'form_normalise starting', { dryRun: MODE_DRY, limit: LIMIT === Infinity ? 'none' : LIMIT });

  const db = openDb();
  const notes = db.prepare(
    "SELECT id, filepath, title FROM vault_notes WHERE content_type != 'attachment' ORDER BY id LIMIT ?"
  ).all(LIMIT === Infinity ? 999999 : LIMIT);

  let stats = { A_standard:0, A_unclosed:0, B_pseudo:0, B_lone_dash_no_tags:0, C_bare_inline:0, D_no_tags_found:0, errors:0 };

  for (const note of notes) {
    try {
      if (!fs.existsSync(note.filepath)) { stats.errors++; continue; }
      const raw = fs.readFileSync(note.filepath, 'utf8');
      const variant = classifyVariant(raw);
      stats[variant] = (stats[variant] || 0) + 1;

      if (variant === 'A_standard' || variant === 'A_unclosed') continue; // no action needed

      const normalised = normalise(raw, variant);
      if (!normalised) continue;

      if (MODE_DRY) {
        log('info', 'Would normalise', {
          title: note.title.slice(0,60),
          variant,
          preview: normalised.slice(0, 150).replace(/\n/g, '\\n')
        });
        continue;
      }

      fs.writeFileSync(note.filepath + '.bak', raw);
      fs.writeFileSync(note.filepath, normalised, 'utf8');
      log('info', 'Normalised', { title: note.title.slice(0,60), variant });
    } catch(e) {
      stats.errors++;
      log('error', 'Normalise failed', { title: note.title.slice(0,60), err: e.message });
    }
  }

  log('info', 'form_normalise complete', stats);

  if (!MODE_DRY && DO_COMMIT) {
    try {
      cp.execFileSync('git', ['-C', VAULT_PATH, 'add', '-u'], { stdio: 'inherit' });
      cp.execFileSync('git', ['-C', VAULT_PATH, 'commit', '-m', 'FORM: normalise frontmatter structure (5 variants -> standard YAML)'], { stdio: 'inherit' });
      log('info', 'Git commit created');
    } catch(e) {
      log('error', 'Git commit failed', { err: e.message });
    }
  } else if (!MODE_DRY) {
    log('info', 'Files written but NOT committed.', {
      hint: `git -C ${VAULT_PATH} add -u && git -C ${VAULT_PATH} commit -m "FORM: normalise frontmatter structure"`
    });
  }

  db.close();
}

main();
