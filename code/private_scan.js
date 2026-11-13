#!/usr/bin/env node
'use strict';
/**
 * QUARRY code/private_scan.js — find notes in a vault that look private, so the owner can review and move them.
 * Deterministic and read-only: regexes and first-person patterns, no LLM. It never moves, edits or deletes a note,
 * never writes inside a vault, and never prints a matched secret (evidence is masked).
 *
 *   node code/private_scan.js [--vault ~/md-vaults/knowledge] [--out private-candidates.csv] [--min 2]
 *
 * Signal classes and weights: secret 5, id 4, contact 2, first-person finance/health/family 2 each, address 2.
 * A single weak signal (one email, one phone) scores low on purpose; a note needs --min points to be listed.
 */
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const VAULT = (opt('--vault', path.join(process.env.HOME || '', 'md-vaults', 'knowledge'))).replace(/^~/, process.env.HOME || '');
const DB = opt('--db', 'vault.db');
const OUT = opt('--out', 'private-candidates.csv'), MIN = parseInt(opt('--min', '2'), 10);

function luhn(d) { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; }
const mask = (s) => String(s).replace(/[A-Za-z0-9]/g, (c, i, a) => (i < 2 || i >= a.length - 2 ? c : '*')).slice(0, 24);

// [class, name, weight, regex, optional validator]. Global regexes; each distinct match counts once per note.
const RULES = [
  ['secret', 'private-key-block', 5, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['secret', 'api-key', 5, /\b(?:AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|xai-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g],
  ['secret', 'password-assignment', 5, /\b(?:password|passwd|pwd|secret|api[_ -]?key|token)\s*[:=]\s*["']?[^\s"',;]{6,}/gi],
  ['id', 'pan', 4, /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g],
  ['id', 'aadhaar', 4, /\b[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b/g],
  ['id', 'ifsc', 4, /\b[A-Z]{4}0[A-Z0-9]{6}\b/g],
  ['id', 'card-number', 4, /\b(?:\d[ -]?){13,19}\b/g, (m, ctx) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) && /card|visa|mastercard|amex|cvv|cvc|expiry|debit|credit/i.test(ctx); }],
  ['contact', 'email', 2, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ['contact', 'phone', 2, /(?<![\d.])(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])/g],
  ['address', 'address-line', 2, /\b(?:flat|door|plot|house)\s*(?:no\.?|number|#)\s*[\w-]+[^.\n]{0,60}\b[1-9]\d{5}\b/gi],
  ['finance', 'my-money', 2, /\bmy\s+(?:salary|income|portfolio|loan|emi|savings|bank account|account balance|tax return|demat|investments?|net worth|mortgage|rent)\b/gi],
  ['health', 'my-health', 2, /\b(?:my\s+(?:doctor|diagnosis|surgery|prescription|blood (?:pressure|sugar|test)|medication|treatment|lab report|symptoms?)|i\s+(?:was diagnosed|have been prescribed|underwent))\b/gi],
  ['family', 'my-family', 1, /\bmy\s+(?:wife|husband|mother|father|mom|dad|son|daughter|brother|sister|grandmother|grandfather|mother-in-law|father-in-law)\b/gi],
];

// Notes the DB knows to be clippings (they have a source URL): other people's public text. Personal-signal rules (contact,
// first-person) do not apply to them, because "my doctor" there is the article author's voice, not the owner's.
const Paths = require('./lib/note_path');
const keyOf = (f) => { try { return Paths.toKey(f, VAULT); } catch (e) { return path.relative(VAULT, f).split(path.sep).join('/'); } };
const CLIPPED = new Set();
try {
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync(DB, { readOnly: true }).prepare("SELECT rel_path FROM vault_notes WHERE source_url IS NOT NULL AND source_url != ''").all()
    .forEach((r) => CLIPPED.add(r.rel_path));   // keys: the path inside the vault, forward slashes, NFC (lib/note_path.js)
} catch (e) { console.error('no DB clipped-map (' + e.message + '): treating every note as unknown'); }
const PERSONAL = new Set(['contact', 'address', 'finance', 'health', 'family']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

const files = walk(VAULT, []);
const rows = [], byClass = {};
for (const f of files) {
  let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  const hits = {}; let score = 0; const ev = [];
  const clipped = CLIPPED.has(keyOf(f));
  for (const [cls, name, w, re, ok] of RULES) {
    if (clipped && PERSONAL.has(cls)) continue;
    const seen = new Set(); let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) { if (ok && !ok(m[0], text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 30))) continue; seen.add(m[0].toLowerCase()); if (seen.size >= 5) break; }
    if (seen.size) {
      // family mentions alone are weak: only count them with 2+ distinct mentions
      if (cls === 'family' && seen.size < 2) continue;
      hits[cls] = (hits[cls] || 0) + seen.size; score += w * Math.min(seen.size, 3);
      ev.push(name + ':' + Array.from(seen).slice(0, 2).map(mask).join('|'));
    }
  }
  if (score >= MIN) {
    const rel = keyOf(f), year = (rel.match(/(?:^|\/)((?:19|20)\d\d)\//) || [])[1] || '';
    rows.push({ rel, year, score, kind: clipped ? 'clipped' : (CLIPPED.size ? 'own-or-unmatched' : 'unknown'), classes: Object.keys(hits).sort().join('+'), ev: ev.join('; ') });
    Object.keys(hits).forEach((c) => { byClass[c] = (byClass[c] || 0) + 1; });
  }
}
rows.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
const csv = (s) => '"' + String(s).replace(/"/g, '""') + '"';
fs.writeFileSync(OUT, ['score,classes,kind,year,path,evidence_masked'].concat(rows.map((r) => [r.score, csv(r.classes), r.kind, r.year, csv(r.rel), csv(r.ev)].join(','))).join('\n') + '\n');
console.log('scanned ' + files.length + ' notes in ' + VAULT + '; listed ' + rows.length + ' with score >= ' + MIN + ' -> ' + OUT);
console.log('notes per signal class: ' + JSON.stringify(byClass));
console.log('score >= 8: ' + rows.filter((r) => r.score >= 8).length + ' · 4-7: ' + rows.filter((r) => r.score >= 4 && r.score < 8).length + ' · 2-3: ' + rows.filter((r) => r.score < 4).length);
