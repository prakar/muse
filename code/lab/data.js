'use strict';
// Single adapter between the burrs table and the lab. Version-parametrised.
const DEFAULT_VERSION = 'nug-v6';

function openCopy(path) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path, { readOnly: true });
}

function parseHooks(s) { try { const h = JSON.parse(s || '[]'); return Array.isArray(h) ? h : []; } catch (e) { return []; } }

// text used for similarity: the claim only (quote is source prose, claim is the normalised fact)
function burrText(b) { return String(b.claim || '').trim(); }

function loadBurrs(db, version) {
  const rows = db.prepare('SELECT id, note_id, claim, quote, kind, hooks_json, prompt_version FROM burrs WHERE prompt_version = ?').all(version || DEFAULT_VERSION);
  return rows.map(r => ({ id: r.id, note_id: r.note_id, claim: r.claim, quote: r.quote, kind: r.kind, hooks: parseHooks(r.hooks_json), version: r.prompt_version }));
}

function loadDupes(db, ids) {
  let rows;
  try { rows = db.prepare('SELECT burr_id, dup_of, kind, score FROM burr_dupes').all(); } catch (e) { return []; }
  const keep = ids ? new Set(ids) : null;
  return rows.filter(r => !keep || (keep.has(r.burr_id) && keep.has(r.dup_of)));
}

module.exports = { DEFAULT_VERSION, openCopy, parseHooks, burrText, loadBurrs, loadDupes };
