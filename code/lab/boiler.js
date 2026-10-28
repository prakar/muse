'use strict';
// Deterministic filter for burrs that say nothing about the world: header-slide / meta claims ("ASIASWEEP occurred in 2013.",
// "ASIASWEEP 2013 is a quiz item."). Used before the judge sees any burr. Conservative: a miss costs a judge call, a false hit hides a fact.
const META = /\b(is|was|are|were|includes?|included|contains?|contained|features?|featured)\s+(a|an|the)?\s*(quiz|trivia)\s+(item|question|round|slide|set)\b|\b(quiz item|quiz question|answer slide|question slide|this slide|the slide|slide \d+|this quiz|the quiz|prelims|finals)\b/i;
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);
function isBoilerplate(claim) {
  const c = String(claim || '').trim();
  if (!c) return true;
  if (words(c).length <= 4) return true;          // "X occurred in 2013." has nothing to link
  return META.test(c);
}
module.exports = { isBoilerplate };
