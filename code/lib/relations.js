'use strict';
/**
 * QUARRY lib/relations.js: the relation a fact STATES, read from cue words only (no model). The cue words and the shapes they point at belong to the
 * active pack (packs/<name>/lenses.json, "relations"); the reading is done by lib/lenses.js. A model reading facts for relations guessed right about one
 * time in three (pilot, Nov 2026), so a relation is recorded only when the sentence carries the connecting words itself. Low recall by design.
 *   relationsIn(text) -> [{ r: 'cause', cue: 'because' }]
 */
const Pack = require('./pack');
const L = () => Pack.current().lens;
module.exports = {
  relationsIn: (text) => (L() ? L().relationsIn(text) : []),
  get CUES() { return L() ? L().CUES : {}; },
  get POINTS_AT() { return L() ? L().POINTS_AT : {}; },
};
