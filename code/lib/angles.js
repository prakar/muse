'use strict';
/**
 * QUARRY lib/angles.js: which shapes a PILE of facts already hints at (Angles, detectors only). A pile is any list of burr-like objects:
 * { id, claim, kind, hooks: [{type, value, cat?}] }. Pure and deterministic: no model, no database, no network.
 *   angles(pile) -> [{ h, name, why, ids }]   (widest first; one row per finding)
 * The engine is general (lib/lenses.js); WHICH shapes are looked for, and the words they use, come from the active pack's lenses (packs/<name>/lenses.json).
 * A pack with no lenses finds nothing. A detector only points at a shape; whether it is worth using stays the author's call, so nothing here writes a question.
 */
const Lenses = require('./lenses');
const Pack = require('./pack');

const lens = () => Pack.current().lens || Lenses.EMPTY;

module.exports = {
  angles: (pile, l) => Lenses.run(pile, l || lens()),
  shapeHowTo: (rel, shape, l) => (l || lens()).shapeHowTo(rel, shape),
  browse: (pile, ctx, l) => (l || lens()).browse(pile, ctx),
  lens,
};
