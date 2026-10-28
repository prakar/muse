'use strict';
// Author marks for the Muse app: "use" (keep), "dull" (not interesting) or "wrong-sense" (same word, different meaning), on a whole handle
// (a name or a wordplay pair) or on one fact under it. Append-only JSON lines in a local file, the latest line for a target wins,
// "clear" removes a mark. The vault database is never written. Pure apart from the one file given.
const fs = require('fs');
const MARKS = ['use', 'dull', 'wrong-sense'];
const keyOf = (handle, item) => item == null ? String(handle) : handle + '#' + item;

function open(file, version) {
  const state = new Map();
  const apply = ev => { if (!ev || !ev.handle) return; const k = keyOf(ev.handle, ev.item); if (MARKS.includes(ev.mark)) state.set(k, ev); else if (ev.mark === 'clear') state.delete(k); };
  if (file && fs.existsSync(file)) fs.readFileSync(file, 'utf8').split('\n').forEach(l => { if (!l.trim()) return; try { apply(JSON.parse(l)); } catch (e) { /* a torn line is skipped */ } });
  return {
    get: (handle, item) => { const e = state.get(keyOf(handle, item)); return e ? e.mark : undefined; },
    // mark: one of MARKS or 'clear'. ctx: small facts about the target kept for later ranking work (kind, wordplay kind, grade, band, note).
    set(handle, item, mark, ctx) {
      if (!handle || ![].concat(MARKS, 'clear').includes(mark)) throw new Error('bad mark');
      const ev = { ts: new Date().toISOString(), version: version || null, handle: String(handle), item: item == null ? null : item, mark: mark, ctx: ctx || null };
      if (file) fs.appendFileSync(file, JSON.stringify(ev) + '\n');
      apply(ev); return ev;
    },
    all: () => Array.from(state.values()),
    counts: () => { const c = { use: 0, dull: 0, 'wrong-sense': 0 }; state.forEach(e => { c[e.mark]++; }); return c; }
  };
}
module.exports = { open, MARKS, keyOf };
