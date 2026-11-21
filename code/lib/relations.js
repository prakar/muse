'use strict';
/**
 * QUARRY lib/relations.js — the relation a fact STATES, read from cue words only (no model).
 * About 30 of the 71 quiz heuristics join facts on a relation that lives in the prose (cause, named-for, inspired-by...). A model reading burrs
 * guessed right about one time in three (pilot, Nov 2026), so a relation is recorded only when the sentence carries the connecting words itself.
 * Low recall by design: a missed relation costs an idea, a wrong one costs trust.
 *   relationsIn(text) -> [{ r: 'cause', cue: 'because' }]
 */
const CUES = {
  cause: /\b(because(?: of)?|due to|owing to|as a result|resulted in|led to|leading to|caused|triggered|in response to|so that|to avoid|circumvent(?:ed|ing)?)\b/i,
  'named-for': /\b(named (?:after|for|from)|takes? its name|derives? (?:its|his|her) name|coined from|named in honou?r of)\b/i,
  'inspired-by': /\b(inspired by|inspiration (?:for|from)|based on|modell?ed (?:on|after)|homage to|adapted from)\b/i,
  'explains-practice': /\b(according to (?:legend|myth|tradition)|legend has it|to commemorate|in memory of|commemorates?)\b/i,
  'copy-of': /\b(clone of|rebadged|rebranded version|copy of)\b/i,
  'applied-elsewhere': /\b(adopted from|borrowed from|imported from|studied (?:the|in)\b.{0,40}\b(?:to|for))\b/i,
  'reason-chosen': /\b(chosen because|selected because|picked because|for convenience|because of its location)\b/i,
  'ignored-because': /\b(ignored because|overlooked because|unrecognised because|unrecognized because|neglected because|went unnoticed because)\b/i,
};
// the heuristic each relation points at first, and the close neighbours the author may mean instead
const POINTS_AT = { cause: { h: 1, also: [14, 18, 19] }, 'named-for': { h: 8, also: [54, 52] }, 'inspired-by': { h: 6, also: [] }, 'explains-practice': { h: 11, also: [] },
  'copy-of': { h: 5, also: [] }, 'applied-elsewhere': { h: 13, also: [] }, 'reason-chosen': { h: 9, also: [] }, 'ignored-because': { h: 15, also: [] } };

function relationsIn(text) {
  const out = [], s = String(text || '');
  Object.keys(CUES).forEach(function (r) { const m = CUES[r].exec(s); if (m) out.push({ r: r, cue: m[0] }); });
  return out;
}
module.exports = { relationsIn, CUES, POINTS_AT };
