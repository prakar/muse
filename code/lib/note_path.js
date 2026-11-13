'use strict';
// note_path.js: the ONE place that turns a note's location into a portable KEY and back. Nothing else may join or split a vault root and a note path.
//
// Why: the database used to store each note's ABSOLUTE path (/Users/me/.../quarry-data/knowledge/2026/x.md). A database that moved to another machine
// (Mac to Linux, or one day Windows) then saw every note as new and every stored note as missing. The fix every system that outlives one computer uses
// (Git: repo-relative paths; Obsidian: vault-relative; Zotero: a base directory plus relative paths) is: store a location-free KEY, keep the ROOT in
// configuration, and join them only when a file is actually opened.
//
// A KEY is the note's path inside the vault: "2026/Some Note.md".
//   - forward slashes on every operating system, never a backslash;
//   - Unicode NFC (macOS can hand back decomposed names; the same filename must give the same key everywhere);
//   - relative: no leading "/", no drive letter, no "." or ".." segment, no empty segment, no control characters;
//   - case is kept exactly as the file has it (never lowercased); clashes that differ only by case are DETECTED (findCollisions), not hidden.
// A key that breaks the first rules is refused (NotePathError). Names that merely would not work on Windows (see portabilityIssues) are allowed but reported.
//
// The optional last argument of toKey and toAbs is a path module (path.win32, path.posix) so each operating system's rules can be tested on any machine.
// toKey(path, root)   absolute path under root (any OS) -> key.  A relative input is treated as a key already (checked and normalised).
// toAbs(key, root)    key + root -> absolute path for THIS machine; refuses anything that would leave the root.
// locate(key, root)   the file on disk (tries the composed and the decomposed Unicode form), or null.
// vaultRoot(env)      the configured root: VAULT_PATH, else ../quarry-data/knowledge beside the quarry folder when it exists, else an error. Never guessed silently.
const fs = require('fs'), path = require('path');

class NotePathError extends Error { constructor(message, code) { super(message); this.name = 'NotePathError'; this.code = code || 'bad-path'; } }

const WIN_DRIVE = /^[A-Za-z]:[\\/]/, WIN_UNC = /^\\\\/, CONTROL = /[\u0000-\u001f\u007f]/;
const isWindowsStyle = s => WIN_DRIVE.test(s) || WIN_UNC.test(s);
const nfc = s => s.normalize('NFC');

// Throws NotePathError unless `key` is a well-formed key. Returns it unchanged otherwise.
function checkKey(key) {
  if (typeof key !== 'string' || !key) throw new NotePathError('A note key must be a non-empty string.');
  if (key !== nfc(key)) throw new NotePathError('Note key is not Unicode NFC: ' + JSON.stringify(key), 'not-nfc');
  if (CONTROL.test(key)) throw new NotePathError('Note key has a control character: ' + JSON.stringify(key));
  if (key.includes('\\')) throw new NotePathError('Note key has a backslash (keys use "/" on every system): ' + JSON.stringify(key));
  if (key[0] === '/' || isWindowsStyle(key) || /^[A-Za-z]:/.test(key)) throw new NotePathError('Note key must be relative to the vault: ' + JSON.stringify(key), 'absolute');
  const parts = key.split('/');
  if (parts.some(p => p === '')) throw new NotePathError('Note key has an empty segment: ' + JSON.stringify(key));
  if (parts.some(p => p === '.' || p === '..')) throw new NotePathError('Note key must not contain "." or "..": ' + JSON.stringify(key), 'traversal');
  return key;
}
const isKey = key => { try { checkKey(key); return true; } catch (e) { return false; } };

// Absolute path on THIS machine -> key. A relative input is taken to be a key already (on Windows a backslash form is accepted and converted).
function toKey(input, root, P) {
  P = P || path;
  if (typeof input !== 'string' || !input) throw new NotePathError('A note path must be a non-empty string.');
  if (!P.isAbsolute(input) && !isWindowsStyle(input)) return checkKey(nfc(P.sep === '\\' ? input.split('\\').join('/') : input));
  if (!root) throw new NotePathError('A vault root is needed to turn an absolute path into a key: ' + input, 'no-root');
  const r = P.resolve(root), rel = P.relative(r, P.resolve(input));
  if (!rel || rel === '..' || rel.startsWith('..' + P.sep) || P.isAbsolute(rel)) throw new NotePathError('Path is not inside the vault root (' + r + '): ' + input, 'outside-root');
  return checkKey(nfc(rel.split(P.sep).join('/')));
}

// Key + root -> absolute path on THIS machine. The result is guaranteed to lie inside root.
function joinUnder(key, root, P) {
  P = P || path;
  if (!root) throw new NotePathError('A vault root is needed to open a note.', 'no-root');
  const r = P.resolve(root), abs = P.join(r, ...key.split('/')), rel = P.relative(r, abs);
  if (!rel || rel.startsWith('..') || P.isAbsolute(rel)) throw new NotePathError('Key resolves outside the vault root: ' + key, 'outside-root');
  return abs;
}
const toAbs = (key, root, P) => joinUnder(checkKey(key), root, P);

// The file for a key as it exists on disk, or null. Some filesystems keep a decomposed (NFD) name where the key is composed (NFC), so both are tried.
function locate(key, root, fsApi) {
  const f = fsApi || fs; checkKey(key);
  for (const form of [key, key.normalize('NFD')]) {
    const abs = joinUnder(form, root);
    try { if (f.statSync(abs).isFile()) return abs; } catch (e) { /* try the next form */ }
  }
  return null;
}

// The configured vault root. VAULT_PATH wins; the dev convention (a copy beside the quarry folder) is used only when it exists; otherwise an error,
// because indexing, reading or writing against a guessed folder is how a vault gets emptied or a real vault gets touched.
function vaultRoot(env, home) {
  env = env || process.env;
  if (env.VAULT_PATH) return path.resolve(env.VAULT_PATH);
  const base = home || env.QUARRY_HOME || '';
  if (base) { const copy = path.resolve(base, '..', 'quarry-data', 'knowledge'); try { if (fs.statSync(copy).isDirectory()) return copy; } catch (e) { /* fall through */ } }
  throw new NotePathError('VAULT_PATH is not set: it must point at the copy of the vault that Muse indexes.', 'no-root');
}

// Names that are valid keys but would not survive on Windows (or in a tool that follows its rules). Reported, never refused.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function portabilityIssues(key, rootBudget) {
  const out = [], parts = key.split('/');
  if (/[<>:"|?*]/.test(key)) out.push('has a character Windows does not allow (< > : " | ? *)');
  if (parts.some(p => /[ .]$/.test(p))) out.push('a name ends with a space or a dot');
  if (parts.some(p => RESERVED.test(p))) out.push('a name is a reserved Windows device name');
  const budget = 260 - (rootBudget == null ? 48 : rootBudget);
  if (key.length > budget) out.push('longer than ' + budget + ' characters (Windows without long-path support stops at 260 including the folder)');
  return out;
}

// Keys that differ only by letter case or Unicode form: fine on Linux, a clash on macOS and Windows. Returns [[keyA, keyB, ...], ...].
const foldKey = key => nfc(key).toLowerCase();
function findCollisions(keys) {
  const by = new Map();
  for (const k of keys) { const f = foldKey(k), a = by.get(f); if (a) a.push(k); else by.set(f, [k]); }
  return [...by.values()].filter(a => new Set(a).size > 1);
}

// ---- Reading older databases (the stored value was an absolute path, possibly from another operating system) -------------------------------------------
// Only the migration and its tests use these. A stored path is "Windows style" when it starts with a drive letter or \\ ; those use "\" and ignore case.
const sepNorm = s => isWindowsStyle(s) ? s.replace(/\\/g, '/') : s;
function commonDirPrefix(paths) {
  const lists = paths.map(p => sepNorm(p).split('/').slice(0, -1));
  if (!lists.length) return '';
  let n = lists[0].length; const first = lists[0];
  for (const l of lists) { let i = 0; while (i < n && i < l.length && l[i] === first[i]) i++; n = i; }
  return first.slice(0, n).join('/');
}
// Which prefix the stored paths share. Prefers the configured VAULT_PATH when every stored path sits under it; else the longest folder they all share.
function chooseLegacyPrefix(stored, configured, override) {
  const strip = s => s.replace(/\/+$/, ''), starts = (p, pre) => (isWindowsStyle(p) ? sepNorm(p).toLowerCase().startsWith(pre.toLowerCase() + '/') : sepNorm(p).startsWith(pre + '/'));
  if (override) return strip(sepNorm(override));
  if (configured) { const c = strip(sepNorm(isWindowsStyle(configured) ? configured : path.resolve(configured))); if (stored.every(p => starts(p, c))) return c; }
  return commonDirPrefix(stored);
}
// Stored absolute path -> key, given the prefix. Returns null when the path is not under the prefix.
function keyFromLegacy(stored, prefix) {
  const s = sepNorm(stored), pre = prefix.replace(/\/+$/, '');
  const under = isWindowsStyle(stored) ? s.toLowerCase().startsWith(pre.toLowerCase() + '/') : s.startsWith(pre + '/');
  if (!under) return null;
  return nfc(s.slice(pre.length + 1));
}

module.exports = { NotePathError, checkKey, isKey, toKey, toAbs, locate, vaultRoot, portabilityIssues, foldKey, findCollisions, commonDirPrefix, chooseLegacyPrefix, keyFromLegacy, isWindowsStyle };
