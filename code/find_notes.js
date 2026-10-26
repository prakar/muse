#!/usr/bin/env node
'use strict';
/**
 * List notes whose body matches a regular expression (read-only). For picking trial notes.
 *   node code/find_notes.js " (BC|BCE)[ .,;)]" [--limit 15] [--min-words 60]
 * Prints: id <TAB> words <TAB> title. Feed an id to:  npm run nuggetize -- --note <id>
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const opt = function (k, d) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const pattern = args[0] && args[0][0] !== '-' ? args[0] : '';
if (!pattern) { console.error('usage: node code/find_notes.js "<regex>" [--limit 15] [--min-words 60]'); process.exit(1); }
const limit = parseInt(opt('--limit', '15'), 10), minWords = parseInt(opt('--min-words', '60'), 10);
const re = new RegExp(pattern);
const db = new DatabaseSync(process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db'), { readOnly: true });
const rows = db.prepare('SELECT id, filepath, title, word_count FROM vault_notes WHERE COALESCE(quarry_exclude,0)=0 AND word_count >= ? ORDER BY (id * 2654435761) % 1000003').all(minWords);
let n = 0;
for (const r of rows) {
  let t = ''; try { t = fs.readFileSync(r.filepath, 'utf8'); } catch (e) { continue; }
  if (re.test(t)) { console.log([r.id, r.word_count, r.title || path.basename(r.filepath, '.md')].join('\t')); if (++n >= limit) break; }
}
if (!n) console.log('no match');
