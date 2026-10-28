'use strict';
// Reads one note for the Muse app: the metadata from vault.db, the text from the markdown file on disk.
// Only notes the model itself uses are served (quarry_exclude = private notes are never shown), and paths come from the database, never from the request.
const fs = require('fs'), path = require('path');

function createNoteStore(db, opts) {
  opts = opts || {};
  const vaultName = opts.vaultName || 'knowledge', maxBytes = opts.maxBytes || 512 * 1024;
  const cols = 'SELECT id, filepath, title, word_count, first_paragraph FROM vault_notes WHERE COALESCE(quarry_exclude,0)=0';
  const byId = db.prepare(cols + ' AND id=?'), byTitle = db.prepare(cols + ' AND lower(title)=lower(?) ORDER BY word_count DESC LIMIT 1');
  const burr = db.prepare('SELECT quote FROM burrs WHERE id=? AND note_id=?');
  const marker = '/' + vaultName + '/';

  // The path inside the vault ("2026/Some Note.md"), whichever copy of the vault the database was indexed from.
  const relPath = fp => { const i = fp.lastIndexOf(marker); return i >= 0 ? fp.slice(i + marker.length) : path.basename(fp); };
  const locate = fp => [fp].concat(opts.vaultRoot ? [path.join(opts.vaultRoot, relPath(fp))] : []).find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });

  return {
    relPath,
    // {id} or {title}, optional {at: burr id whose quote to locate}. Returns null for an unknown or private note.
    get({ id, title, at }) {
      const n = id != null ? byId.get(Number(id)) : title ? byTitle.get(String(title)) : null;
      if (!n) return null;
      const file = locate(n.filepath); let body = n.first_paragraph || '', truncated = false;
      if (file) { const buf = fs.readFileSync(file); truncated = buf.length > maxBytes; body = buf.subarray(0, maxBytes).toString('utf8'); }
      const b = at != null ? burr.get(Number(at), n.id) : null, rel = relPath(n.filepath).replace(/\.md$/i, '');
      return { id: n.id, title: n.title, words: n.word_count, body, exists: !!file, truncated, quote: b ? b.quote : null,
        obsidian: 'obsidian://open?vault=' + encodeURIComponent(vaultName) + '&file=' + encodeURIComponent(rel) };
    }
  };
}
module.exports = { createNoteStore };
