'use strict';
// Reads one note for the Muse app: the metadata from vault.db, the text from the markdown file on disk.
// Only notes the model itself uses are served (quarry_exclude = private notes are never shown), and paths come from the database, never from the request.
// A note is stored by its KEY (rel_path, the path inside the vault); the file is found by joining the key to a configured vault root (lib/note_path.js),
// so the same database works whichever machine, folder or copy of the vault it is used with.
const fs = require('fs');
const Paths = require('./note_path');

function createNoteStore(db, opts) {
  opts = opts || {};
  const vaultName = opts.vaultName || 'knowledge', maxBytes = opts.maxBytes || 512 * 1024, roots = [].concat(opts.vaultRoot || []).filter(Boolean);
  const cols = 'SELECT id, rel_path, title, word_count, first_paragraph FROM vault_notes WHERE COALESCE(quarry_exclude,0)=0';
  const byId = db.prepare(cols + ' AND id=?'), byTitle = db.prepare(cols + ' AND lower(title)=lower(?) ORDER BY word_count DESC LIMIT 1');
  const burr = db.prepare('SELECT quote FROM burrs WHERE id=? AND note_id=?');

  // The path inside the vault ("2026/Some Note.md") is the key itself.
  const relPath = key => key;
  const locate = key => { for (const r of roots) { let f = null; try { f = Paths.locate(key, r, fs); } catch (e) { /* a malformed key finds nothing */ } if (f) return f; } return null; };

  return {
    relPath,
    // {id} or {title}, optional {at: burr id whose quote to locate}. Returns null for an unknown or private note.
    get({ id, title, at }) {
      const n = id != null ? byId.get(Number(id)) : title ? byTitle.get(String(title)) : null;
      if (!n) return null;
      const file = locate(n.rel_path); let body = n.first_paragraph || '', truncated = false;
      if (file) { const buf = fs.readFileSync(file); truncated = buf.length > maxBytes; body = buf.subarray(0, maxBytes).toString('utf8'); }
      const b = at != null ? burr.get(Number(at), n.id) : null, rel = relPath(n.rel_path).replace(/\.md$/i, '');
      return { id: n.id, title: n.title, words: n.word_count, body, exists: !!file, truncated, quote: b ? b.quote : null,
        obsidian: 'obsidian://open?vault=' + encodeURIComponent(vaultName) + '&file=' + encodeURIComponent(rel) };
    }
  };
}
module.exports = { createNoteStore };
