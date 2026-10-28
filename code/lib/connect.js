'use strict';
// Muse mode "Connect": given a handle (a shared hook, or a wordplay pair), return the facts that share it, ordered hard to easy,
// optionally with the shared handle withheld ("reveal last") so the author can test whether the set points to it unaided.
// Pure functions over the handle object that muse_model.handle() returns. No model, no database.

const LEAD_IN = {
  'homophone': (a, b) => a + ' sounds exactly like "' + b + '"',
  'one-letter-off': (a, b) => a + ' and ' + b + ' differ by one letter',
  'anagram-pair': (a, b) => a + ' and ' + b + ' are anagrams',
  'anagram-of-word': (a, b) => a + ' is an anagram of "' + b + '"',
  'reversal': (a, b) => a + ' spelled backwards is ' + b,
  'hidden-word': (a, b) => a + ' hides the word "' + b + '"',
  'head-tail': (a, b) => a + ' becomes "' + b + '" when a letter is dropped',
  'digit-lookalike': (a, b) => a + ' looks like ' + b + ', with a letter standing in for a digit',
  'acronym-word': (a, b) => a + ' spells a word and stands for ' + b,
  'rhyme': (a, b) => a + ' rhymes with ' + b,
  'sounds-like': (a, b) => a + ' sounds almost like "' + b + '"'
};
function leadIn(kind, a, b) { const f = LEAD_IN[kind]; return f && b != null ? f(a, b) : null; }

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Blank every mention of the handle's words (whole names for wordplay) so a fact cannot give the answer away.
function mask(text, names) {
  let t = String(text);
  names.filter(Boolean).sort((x, y) => String(y).length - String(x).length).forEach(function (n) { t = t.replace(new RegExp('\\b' + esc(n) + '\\b', 'gi'), '_____'); });
  return t;
}
// Keep at most n facts, spread across the difficulty range so a short set still runs hard to easy; then order hard first.
function pick(items, n) {
  const s = items.slice().sort((a, b) => b.diff - a.diff || a.id - b.id);
  if (s.length <= n) return s;
  const out = []; for (let i = 0; i < n; i++) out.push(s[Math.round(i * (s.length - 1) / (n - 1))]);
  return out.filter((x, i) => out.indexOf(x) === i);
}
function band(i, total) { const r = total <= 1 ? 0 : i / (total - 1); return r < 0.34 ? 'hard' : r < 0.67 ? 'medium' : 'easy'; }

// h: handle from muse_model.handle(); opts: {n (default 6), reveal (withhold the handle), order: 'hard' (default) | 'easy' | 'found',
//   markOf(itemId) -> 'use' | 'dull' | 'wrong-sense' | undefined, showHidden}. Kept ("use") facts are always in the set; dull and wrong-sense facts are
//   left out and the next candidate takes the place, unless showHidden.
function connect(h, opts) {
  opts = opts || {}; const n = Math.max(2, Math.min(12, opts.n || 6));
  if (!h) return { error: 'unknown handle' };
  const names = h.kind === 'wordplay' ? [h.a, h.b] : String(h.surface).split(/\s+/).length > 1 ? [h.surface] : [h.surface];
  const markOf = opts.markOf || (() => undefined);
  const hidden = h.items.filter(it => { const m = markOf(it.id); return m === 'dull' || m === 'wrong-sense'; });
  const pool = opts.showHidden ? h.items : h.items.filter(it => hidden.indexOf(it) < 0);
  const kept = pool.filter(it => markOf(it.id) === 'use').sort((a, b) => b.diff - a.diff || a.id - b.id).slice(0, n);
  const chosen = kept.concat(pick(pool.filter(it => kept.indexOf(it) < 0), n - kept.length)).sort((a, b) => b.diff - a.diff || a.id - b.id);
  let items = chosen.map((it, i) => Object.assign({}, it, { band: band(i, chosen.length), mark: markOf(it.id) || null }));
  // The difficulty guess is rough (no better than chance against the author's own reading on a first check), so the author can flip or drop it.
  if (opts.order === 'easy') items.reverse(); else if (opts.order === 'found') items.sort((a, b) => a.id - b.id);
  items = items.map((it, i) => Object.assign(it, { rank: i + 1 }));
  const out = { id: h.id, kind: h.kind, total: h.items.length, shown: items.length, reveal: !!opts.reveal, hidden: opts.showHidden ? 0 : hidden.length };
  const lead = h.kind === 'wordplay' ? leadIn(h.wordplay, h.a, h.b) : null;
  if (opts.reveal) {
    out.handle = null; out.leadIn = null; out.answer = { surface: h.surface, leadIn: lead };
    out.items = items.map(it => Object.assign({}, it, { claim: mask(it.claim, names), quote: mask(it.quote || '', names), note: mask(it.note || '', names), name: undefined, hooks: [] }));   // the shared hook is among a fact's hooks, so none are shown
  } else {
    out.handle = { surface: h.surface, types: h.types || null, df: h.df || null, wordplay: h.wordplay || null, grade: h.grade || null }; out.leadIn = lead;
    out.items = items.map(it => it.hooks ? Object.assign({}, it, { hooks: it.hooks.filter(k => k.id !== h.id) }) : it);   // pivot chips never repeat the handle itself
  }
  if (items.length < 2) out.warning = 'fewer than two facts share this handle';
  return out;
}
module.exports = { connect, leadIn, mask, pick, band };
