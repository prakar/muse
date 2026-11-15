// Shared tag-insertion logic, used by tagger.js (switch-vocab direct writes). It was shared with the legacy server's
// tag-review pages (server.js, retired); tagger.js is now the only caller.
'use strict';

// Splits "a/b/c" into its parts, cleaned and lowercased. Returns null for
// an empty/invalid tag string.
function parseTag(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!clean) return null;
  const parts = clean.split('/').filter(Boolean);
  if (!parts.length) return null;
  return {
    tag_full: parts.join('/'),
    tag_root: parts[0],
    tag_leaf: parts[parts.length - 1],
    is_hierarchical: parts.length > 1 ? 1 : 0,
  };
}

// Inserts one tag onto one note. No parent-path auto-creation - tag_root
// already supports "everything under X" queries without a redundant
// standalone parent row (see QUARRY_V2_ARCHITECTURE.md decision log).
// markVocabApproved: also promotes/creates the tag in tag_vocabulary as
// 'approved' (used when a human just approved it via /review-tags).
function insertNoteTag(db, noteId, rawTag, opts) {
  opts = opts || {};
  const t = parseTag(rawTag);
  if (!t) return null;

  if (opts.markVocabApproved) {
    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO tag_vocabulary (tag_full,tag_root,tag_leaf,is_hierarchical,status,created_at) VALUES (?,?,?,?,?,?)'
    ).run(t.tag_full, t.tag_root, t.tag_leaf, t.is_hierarchical, 'approved', now);
    db.prepare("UPDATE tag_vocabulary SET status='approved' WHERE tag_full=? AND status='pending'").run(t.tag_full);
  }

  db.prepare(
    'INSERT OR IGNORE INTO note_tags (note_id,tag_full,tag_root,tag_leaf,is_hierarchical) VALUES (?,?,?,?,?)'
  ).run(noteId, t.tag_full, t.tag_root, t.tag_leaf, t.is_hierarchical);

  return t;
}

// Inserts many tags onto one note in one call, then sets has_tags/tag_source
// on vault_notes. Used by tagger.js's switch-vocab path.
function insertNoteTags(db, noteId, rawTags, tagSource, opts) {
  if (!rawTags || !rawTags.length) return [];
  const seen = new Set();
  const inserted = [];
  for (const raw of rawTags) {
    const t = insertNoteTag(db, noteId, raw, opts);
    if (t && !seen.has(t.tag_full)) { seen.add(t.tag_full); inserted.push(t); }
  }
  if (inserted.length) {
    db.prepare('UPDATE vault_notes SET has_tags=1, tag_source=? WHERE id=?').run(tagSource, noteId);
  }
  return inserted;
}

module.exports = { parseTag, insertNoteTag, insertNoteTags };