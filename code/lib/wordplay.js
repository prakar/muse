'use strict';
/**
 * QUARRY lib/wordplay.js: wordplay in names and titles, found from their text alone (heuristics 47, 49, 50, 51, 58, 59, 60, 69).
 * No model, no database. Pure functions over names [{name, category, notes:[note_id]}] and claims [{id, note_id, claim}].
 * Each detector returns candidates only; a candidate is a lead for the author, never a verdict.
 */
const COLOURS = new Set('red blue green yellow black white purple orange grey gray pink brown crimson scarlet violet indigo azure vermilion saffron'.split(' '));
const MATERIALS = new Set('gold golden silver copper bronze iron steel tin lead zinc nickel platinum diamond glass stone wood wooden paper silk cotton wool leather clay marble granite ivory amber jade brick salt coal'.split(' '));
const NUMBERS = new Set('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen twenty thirty forty fifty hundred thousand million billion dozen'.split(' '));
const GENERIC = new Set('river lake mount mountain university national state united north south east west central city saint church temple fort the and of for new old great little upper lower royal international institute society association company'.split(' '));
const KIND_CATEGORIES = new Set(['place', 'organisation', 'work', 'event', 'animal', 'plant', 'food', 'object']);
const SMALL = new Set('of the and for in on to de la le du von van'.split(' '));

function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function wordsOf(s) { return fold(s).split(/[^a-z0-9]+/).filter(Boolean); }
function letters(s) { return fold(s).replace(/[^a-z]/g, ''); }
function sortedLetters(s) { return letters(s).split('').sort().join(''); }
function uniq(a) { return Array.from(new Set(a)); }
function distinctNames(names) { const m = new Map(); names.forEach(function (n) { const k = fold(n.name).trim(); if (k && !m.has(k)) m.set(k, n); }); return Array.from(m.values()); }

// 47 and 60. A number, colour or material word inside a name, grouped by what it is and what kind of thing is named
// (the Black Sea, the Red Sea, the Yellow Sea). A group needs 3+ names from 2+ notes to be worth showing.
function kindOf(w) { if (NUMBERS.has(w)) return 'number'; if (COLOURS.has(w)) return 'colour'; if (MATERIALS.has(w)) return 'material'; return null; }
function wordKinds(names, minNames) {
  const groups = new Map();
  distinctNames(names).forEach(function (n) {
    if (!KIND_CATEGORIES.has(n.category)) return;
    const seen = new Set();
    wordsOf(n.name).forEach(function (w) { const k = kindOf(w); if (!k || seen.has(k)) return; seen.add(k);
      const key = k + '|' + (n.category || 'other'); if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ name: n.name, token: w, notes: n.notes || [] }); });
  });
  const out = [];
  groups.forEach(function (items, key) {
    const notes = new Set(); items.forEach(function (i) { (i.notes || []).forEach(function (x) { notes.add(x); }); });
    if (items.length >= (minNames || 3) && notes.size >= 2) out.push({ kind: key.split('|')[0], category: key.split('|')[1], count: items.length, notes: notes.size, items: items });
  });
  return out.sort(function (a, b) { return b.count - a.count; });
}

// 60. Digits fused into a word (IQ84, Se7en, B2B) or a bare numeral in a work's title (Fahrenheit 451, Catch-22).
function digitNames(names) {
  const out = [];
  distinctNames(names).forEach(function (n) {
    if (n.category !== 'work') return;
    const raw = String(n.name);
    if (/\d+\.\d+|\bv\d|\b(?:mm|cm|kg|km|gb|mb)\b|[:()]/i.test(raw)) return;   // versions, measurements, verse references, qualifiers
    const fused = /[A-Za-z]\d|\d[A-Za-z]/.test(raw), bare = /\b\d{1,4}\b/.test(raw) && !/\s\d{1,2}$/.test(raw);   // a short number after a space is a sequel (Honey 2); Catch-22 and Fahrenheit 451 stay
    if (fused || bare) out.push({ name: n.name, category: n.category, form: fused ? 'fused' : 'numeral-in-title', notes: n.notes || [] });
  });
  return out;
}

// 49. Names one letter apart (Drainspotting / Trainspotting). Candidates via deletion keys. Suffix-only differences (plurals, -s, -ed) are skipped.
const VOWELS = new Set('aeiou'.split(''));
const TRANSLIT = ['vw', 'ck', 'sz', 'jz', 'iy'].map(function (p) { return new Set(p.split('')); });
function translit(x, y) { return TRANSLIT.some(function (t) { return t.has(x) && t.has(y); }); }
function oneLetterOff(names) {
  // single-word names only: puns and parodies are single words (Drainspotting / Trainspotting); multi-word pairs are almost always spelling variants
  const items = distinctNames(names).filter(function (n) { return n.category !== 'person' && /^[A-Za-z]{6,}$/.test(String(n.name).trim()); }).map(function (n) { return { n: n, l: letters(n.name) }; });
  const byKey = new Map(), add = function (key, it) { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(it); };
  items.forEach(function (it) { add('=' + it.l, it); add('-' + it.l, it); for (let i = 0; i < it.l.length; i++) add('-' + it.l.slice(0, i) + it.l.slice(i + 1), it); });
  const seen = new Set(), out = [];
  byKey.forEach(function (list) {
    if (list.length < 2 || list.length > 12) return;
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const x = list[a], y = list[b]; if (x.l === y.l) continue;
      const id = x.l < y.l ? x.l + '|' + y.l : y.l + '|' + x.l; if (seen.has(id)) continue;
      const d = diffOne(x.l, y.l); if (!d) continue;
      const longer = x.l.length > y.l.length ? x.l : y.l;
      if (d.kind === 'insert') { if (d.pos >= longer.length - 2) continue; if (VOWELS.has(d.letter) || d.letter === 'h') continue; if (longer[d.pos] === longer[d.pos - 1] || longer[d.pos] === longer[d.pos + 1]) continue; }   // suffixes, a vowel or h slipped in, doubled letters: spelling variants
      else { const p = x.l[d.pos], q = y.l[d.pos]; if (VOWELS.has(p) && VOWELS.has(q)) continue; if (translit(p, q)) continue; }
      seen.add(id); out.push({ a: x.n.name, b: y.n.name, kind: d.kind, pos: d.pos, first_letter: d.pos === 0 });
    }
  });
  return out.sort(function (p, q) { return (q.first_letter ? 1 : 0) - (p.first_letter ? 1 : 0); });   // a changed first letter is the strongest pun
}
function diffOne(s, t) {
  if (s.length === t.length) { let at = -1; for (let i = 0; i < s.length; i++) if (s[i] !== t[i]) { if (at >= 0) return null; at = i; } return at >= 0 ? { kind: 'substitute', pos: at, letter: t[at] } : null; }
  if (Math.abs(s.length - t.length) !== 1) return null;
  const a = s.length < t.length ? s : t, b = s.length < t.length ? t : s;
  for (let i = 0; i < b.length; i++) if (a.slice(0, i) === b.slice(0, i) && a.slice(i) === b.slice(i + 1)) return { kind: 'insert', pos: i, letter: b[i] };
  return null;
}

// 50 and 59. A word shared by different names (Amu Darya / Syr Darya). Across different kinds of thing it is 59 (the Red Dot of a payments
// provider, a pavilion and a logo). People are left out (a shared given name or surname is a family tie, not wordplay).
const SHARED_CATEGORIES = new Set(['place', 'organisation', 'work', 'event', 'object', 'animal', 'plant', 'food', 'substance']);
function sharedParts(names, opts) {
  opts = opts || {}; const vocab = opts.vocab || null; const maxNames = opts.maxNames || 8, byFeat = new Map(), all = distinctNames(names), asNames = new Set(all.map(function (n) { return fold(n.name).trim(); }));
  all.forEach(function (n) {
    if (!SHARED_CATEGORIES.has(n.category)) return;
    const w = wordsOf(n.name); if (w.length < 2) return;
    const feats = uniq(w.filter(function (t) { return /^[a-z]{4,}$/.test(t) && !GENERIC.has(t) && !SMALL.has(t); }).map(function (t) { return 't:' + t; })
      .concat(w.slice(0, -1).map(function (t, i) { return [t, w[i + 1]]; }).filter(function (p) { return /^[a-z]+$/.test(p[0] + p[1]) && !SMALL.has(p[0]) && !SMALL.has(p[1]) && !GENERIC.has(p[0]) && !GENERIC.has(p[1]) && (p[0] + p[1]).length >= 6; }).map(function (p) { return 'p:' + p[0] + ' ' + p[1]; })));
    feats.forEach(function (f) { if (!byFeat.has(f)) byFeat.set(f, []); byFeat.get(f).push(n); });
  });
  const groups = [];
  byFeat.forEach(function (list, f) {
    if (list.length < 2 || list.length > maxNames) return;
    if (f[0] === 't') { if (vocab && (vocab.get(f.slice(2)) || 0) >= 5) return;   // an everyday English word (flag, beach, girl): not a morpheme
      const last = list.filter(function (n) { const w = wordsOf(n.name); return w[w.length - 1] === f.slice(2); }).length; if (last < Math.ceil(list.length * 2 / 3)) return; }   // a morpheme closes the name (Amu Darya, Arya Samaj)
    if (asNames.has(f.slice(2))) return;   // the shared word is itself a name (Kerala, Oregon): a namesake, not a shared morpheme
    const low = list.map(function (n) { return fold(n.name); });
    if (low.some(function (x, i) { return low.some(function (y, j) { return i !== j && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0); }); })) return;   // one name inside another: the same thing, not a pair
    const cats = uniq(list.map(function (n) { return n.category || 'other'; })), notes = new Set(); list.forEach(function (n) { (n.notes || []).forEach(function (x) { notes.add(x); }); });
    if (notes.size < 2) return;
    groups.push({ token: f.slice(2), phrase: f[0] === 'p', route: cats.length > 1 ? 'across-kinds' : 'same-kind', categories: cats, count: list.length, names: list.map(function (n) { return n.name; }) });
  });
  // a single word whose names are all inside a shared phrase group is the same finding: keep the phrase
  const phraseSets = groups.filter(function (g) { return g.phrase; }).map(function (g) { return new Set(g.names); });
  return groups.filter(function (g) { return g.phrase || !phraseSets.some(function (ps) { return g.names.every(function (x) { return ps.has(x); }); }); })
    .sort(function (a, b) { return b.count - a.count; });
}

// 58. Anagrams between names (same letters, different arrangement). Names built by joining two other names were tried and dropped: ordinary compounds swamp the real ones.
function lev(a, b) { const m = a.length, n = b.length; let prev = []; for (let j = 0; j <= n; j++) prev[j] = j; for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; }
function anagrams(names) {
  const by = new Map();
  distinctNames(names).forEach(function (n) { const l = letters(n.name); if (l.length < 5 || /\d/.test(n.name)) return; const k = sortedLetters(n.name); if (!by.has(k)) by.set(k, []); by.get(k).push(n); });
  const out = [];
  by.forEach(function (list) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], la = letters(a.name), lb = letters(b.name);
      if (la === lb) continue;                                     // same letters in the same order: spacing, case or punctuation
      if (lev(la, lb) < 3) continue;                               // a swap of two letters (fiber / fibre) is a spelling variant
      const wa = wordsOf(a.name), wb = wordsOf(b.name); if (wa.some(function (w) { return wb.indexOf(w) >= 0; })) continue;   // they share a whole word
      out.push({ names: [a.name, b.name] });
    }
  });
  return out;
}

// 51. Acronym with its expansion in the claim, e.g. "NASA (National Aeronautics and Space Administration)" or "Foo Bar Baz (FBB)".
// pronounceable acronyms are the likelier backronyms and pun-titles.
function initialsOf(words) { return words.filter(function (w) { return !SMALL.has(w.toLowerCase()); }).map(function (w) { return w[0].toUpperCase(); }).join(''); }
function acronyms(claims, vocab) {
  const out = [];
  claims.forEach(function (c) {
    const text = String(c.claim || ''); let m;
    const fwd = /\b([A-Z]{3,8})\b\s*\(([^()]{6,140})\)/g;
    while ((m = fwd.exec(text))) { const ws = m[2].split(/[\s-]+/).filter(Boolean); if (initialsOf(ws) === m[1]) out.push(rec(c, m[1], m[2])); }
    const back = /([A-Z][\w'’-]*(?:[\s-]+(?:of|the|and|for|in|on|to|de|la|[A-Z][\w'’-]*)){1,9})\s*\(([A-Z]{3,8})\)/g;
    while ((m = back.exec(text))) { const ws = m[1].split(/[\s-]+/), n = m[2].length; for (let k = Math.max(1, ws.length - n - 3); k < ws.length; k++) { const tail = ws.slice(k); if (initialsOf(tail) === m[2]) { out.push(rec(c, m[2], tail.join(' '))); break; } } }
  });
  function rec(c, ac, ex) { return { burr: c.id, note: c.note_id, acronym: ac, expansion: ex, pronounceable: /[AEIOU]/.test(ac) && !/[^AEIOU]{3}/.test(ac), wordlike: !!(vocab && ac.length >= 4 && (vocab.get(ac.toLowerCase()) || 0) >= 2) }; }
  const seen = new Set(); return out.filter(function (r) { const k = r.acronym + '|' + r.expansion.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function vocabOf(claims) { const m = new Map(); claims.forEach(function (c) { (String(c.claim || '').match(/\b[a-z]{3,20}\b/g) || []).forEach(function (w) { m.set(w, (m.get(w) || 0) + 1); }); }); return m; }

// 69. A cryptic round needs enough items of one kind. Returns which kinds could fill a round of `size` items.
function roundCapable(counts, size) { size = size || 8; return Object.keys(counts).filter(function (k) { return counts[k] >= size; }); }

// ---------------------------------------------------------------------------------------------------------------------------------
// More quiz wordplay, all from the vault's own text. `lexicon` is a Set of everyday words (the vault's lowercase vocabulary), standing in for a dictionary.
function lexiconOf(vocab, min) { const s = new Set(); (vocab || new Map()).forEach(function (n, w) { if (n >= (min || 5) && /^[a-z]{3,}$/.test(w)) s.add(w); }); return s; }
function reverseStr(s) { return s.split('').reverse().join(''); }

// A name that reads the same backwards (Malayalam, Hannah).
function palindromes(names) {
  const out = [];
  distinctNames(names).forEach(function (n) { const l = letters(n.name); if (l.length >= 5 && l === reverseStr(l) && /^[a-z]+$/.test(l) && l.split('').some(function (c, i) { return c !== l[0]; })) out.push({ name: n.name, category: n.category }); });
  return out;
}
// A name that spells another word or name backwards (Damon / nomad, Stressed / Desserts).
function reversals(names, lexicon) {
  const all = distinctNames(names), byLetters = new Map(); all.forEach(function (n) { const l = letters(n.name); if (l.length >= 4) byLetters.set(l, n.name); });
  const out = [], seen = new Set();
  all.forEach(function (n) { const l = letters(n.name); if (l.length < 4 || l === reverseStr(l)) return; const r = reverseStr(l);
    const asName = byLetters.get(r), asWord = lexicon && lexicon.has(r); if (!asName && !asWord) return;
    const id = l < r ? l + '|' + r : r + '|' + l; if (seen.has(id)) return; seen.add(id);
    out.push({ name: n.name, reversed: asName || r, with: asName ? 'name' : 'word' }); });
  return out;
}
// A single-word name that is an anagram of an everyday word (Silent / listen, Elvis / lives).
function anagramWords(names, lexicon) {
  const by = new Map(); (lexicon || new Set()).forEach(function (w) { if (w.length >= 5) { const k = w.split('').sort().join(''); if (!by.has(k)) by.set(k, []); by.get(k).push(w); } });
  const out = [];
  distinctNames(names).forEach(function (n) { const raw = String(n.name).trim(); if (!/^[A-Za-z]{5,}$/.test(raw)) return; const l = fold(raw), k = l.split('').sort().join(''), ws = (by.get(k) || []).filter(function (w) { return w !== l && lev(w, l) >= 3; });
    if (ws.length) out.push({ name: n.name, words: ws.slice(0, 3) }); });
  return out;
}
// Two-word names that echo themselves: the same word twice (Bora Bora), rhyming (Hocus Pocus), a vowel swap (Ping Pong).
function echoNames(names) {
  const out = [];
  distinctNames(names).forEach(function (n) {
    const w = wordsOf(n.name).filter(function (x) { return /^[a-z]+$/.test(x); }); if (w.length !== 2 || String(n.name).trim().split(/\s+/).length !== 2) return;
    const a = w[0], b = w[1]; if (a.length < 3 || b.length < 3) return;
    if (a === b) { out.push({ name: n.name, form: 'repeated', notes: (n.notes || []).length }); return; }
    const frame = function (x) { return x.replace(/[aeiou]+/g, '_'); };
    if (frame(a) === frame(b) && /^[^aeiou]*[aeiou]+[^aeiou]*$/.test(a) && /^[^aeiou]*[aeiou]+[^aeiou]*$/.test(b) && a.length === b.length && a !== b) { out.push({ name: n.name, form: 'vowel swap', notes: (n.notes || []).length }); return; }
    let k = 0; while (k < Math.min(a.length, b.length) && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
    if (k >= 3 && a[0] !== b[0] && /[aeiouy]/.test(a.slice(a.length - k)) && a.length > k && b.length > k) out.push({ name: n.name, form: 'rhyming', notes: (n.notes || []).length });
  });
  return out;
}
// Names whose words all start with the same letter (Peter Parker, Coca-Cola, Bed Bath).
function alliterative(names) {
  const out = [];
  distinctNames(names).forEach(function (n) {
    const w = wordsOf(n.name).filter(function (x) { return !SMALL.has(x); }); if (w.length < 2 || w.length > 4) return;
    if (w.some(function (x) { return x.length < 3 || !/^[a-z]/.test(x); })) return;
    if (w.every(function (x) { return x[0] === w[0][0]; })) out.push({ name: n.name, category: n.category, notes: (n.notes || []).length });
  });
  return out;
}
// Animal binomials with the same word twice (Gorilla gorilla, Bison bison).
function tautonyms(claims) {
  const out = [], seen = new Set();
  claims.forEach(function (c) { const re = /\b([A-Z][a-z]{3,}) ([a-z]{3,})\b/g; let m; while ((m = re.exec(String(c.claim || '')))) { if (m[1].toLowerCase() === m[2] && !seen.has(m[2])) { seen.add(m[2]); out.push({ name: m[1] + ' ' + m[2], burr: c.id, note: c.note_id }); } } });
  return out;
}
// Letter oddities in single-word names: letters in alphabetical order, two doubled letters in a row (balloon), no vowel but y (rhythm).
function letterOddities(names) {
  const out = [];
  distinctNames(names).forEach(function (n) {
    const raw = String(n.name).trim(); if (!/^[A-Za-z]{5,}$/.test(raw)) return; const l = fold(raw);
    if (l.length >= 6 && l.split('').every(function (c, i) { return i === 0 || c >= l[i - 1]; })) out.push({ name: n.name, form: 'alphabetical order' });
    else if (/(.)\1(.)\2/.test(l) && !/(.)\1\1/.test(l)) out.push({ name: n.name, form: 'two doubles in a row' });
    else if (l.length >= 5 && !/[aeiou]/.test(l) && /y/.test(l)) out.push({ name: n.name, form: 'no vowel but y' });
  });
  return out;
}
// Years that read the same backwards (1991, 2002), from time hooks.
function palindromeYears(burrs) {
  const m = new Map();
  burrs.forEach(function (b) { (b.hooks || []).forEach(function (h) { if (h.type === 'time' && /^\d{4}$/.test(String(h.value)) && !h.era || h.type === 'time' && /^\d{4}$/.test(String(h.value)) && h.era !== 'bc') { const y = String(h.value); if (y === reverseStr(y) && y[0] !== y[1]) { if (!m.has(y)) m.set(y, new Set()); m.get(y).add(b.note_id); } } }); });
  return Array.from(m.entries()).map(function (e) { return { year: e[0], notes: e[1].size }; }).sort(function (a, b) { return a.year < b.year ? -1 : 1; });
}
// A short everyday word hidden inside a name (a number, colour, body part or animal), straddling a word boundary or buried inside a longer word.
const HIDDEN = { number: 'three four five seven eight nine zero', colour: 'blue pink gray grey gold teal lime navy cyan rose plum ruby', body: 'head hand foot knee shin chin nose face back neck hair lung heart liver ankle elbow thumb wrist tongue', animal: 'bear wolf lion deer goat duck frog toad hawk crow swan lamb mole mouse camel horse sheep snake whale shark eagle otter hare ibis bison zebra panda tiger' };
function hiddenWords(names) {
  const lists = []; Object.keys(HIDDEN).forEach(function (k) { HIDDEN[k].split(' ').forEach(function (w) { lists.push([k, w]); }); });
  const out = [];
  distinctNames(names).forEach(function (n) {
    const ws = String(n.name).trim().split(/\s+/).map(function (x) { return letters(x); }).filter(Boolean); if (!ws.length || ws.length > 4) return;
    const s = ws.join(''), cuts = new Set(); let p = 0; ws.forEach(function (w) { p += w.length; cuts.add(p); });
    if (s.length > 22) return;
    lists.forEach(function (kw) { let i = s.indexOf(kw[1]); while (i >= 0) { const j = i + kw[1].length;
      const straddles = Array.from(cuts).some(function (c) { return c > i && c < j; }), wholeWords = (i === 0 || cuts.has(i)) && (j === s.length || cuts.has(j)), inner = ws.length === 1 && i > 0 && j < s.length && kw[1].length >= 5;
      if (!wholeWords && (straddles || inner)) { out.push({ name: n.name, hidden: kw[1], kind: kw[0] }); break; }
      i = s.indexOf(kw[1], i + 1); } });
  });
  return out;
}
// A name that becomes an everyday word with its first letter removed (Spain -> pain) or its last (Cuba -> cub, Sweden -> swede).
function headTail(names, lexicon) {
  const out = [];
  distinctNames(names).forEach(function (n) { const raw = String(n.name).trim(); if (!/^[A-Z][a-z]{3,}$/.test(raw)) return; const l = fold(raw);   // a proper name, not a common noun or an acronym
    const head = l.slice(1), tail = l.slice(0, -1), hits = [];
    if (head.length >= 3 && lexicon.has(head) && head !== l) hits.push({ form: 'first letter off', word: head });
    if (tail.length >= 3 && lexicon.has(tail) && tail !== l && !(l.endsWith('s') && lexicon.has(tail))) hits.push({ form: 'last letter off', word: tail });
    hits.forEach(function (h) { out.push({ name: n.name, category: n.category, form: h.form, word: h.word, notes: (n.notes || []).length }); }); });
  return out;
}
// Simplified Metaphone: a spelling-to-sound key, to pair a name with an everyday word that sounds the same (Wales / whales, Seoul / soul).
function metaphone(word) {
  let w = fold(word).replace(/[^a-z]/g, ''); if (!w) return '';
  if (/^(ae|gn|kn|pn|wr)/.test(w)) w = w.slice(1); else if (w[0] === 'x') w = 's' + w.slice(1); else if (w.startsWith('wh')) w = 'w' + w.slice(2);
  const V = 'aeiou', out = [];
  for (let i = 0; i < w.length; i++) { const c = w[i], p = w[i - 1], nx = w[i + 1], n2 = w[i + 2];
    if (c === p && c !== 'c') continue;
    if (V.indexOf(c) >= 0) { if (i === 0) out.push(c.toUpperCase()); continue; }
    switch (c) {
      case 'b': if (!(p === 'm' && i === w.length - 1)) out.push('B'); break;
      case 'c': if (nx === 'i' && n2 === 'a' || nx === 'h') out.push('X'); else if ('iey'.indexOf(nx) >= 0) { if (p !== 's') out.push('S'); } else out.push('K'); if (nx === 'h') i++; break;
      case 'd': out.push(nx === 'g' && 'iey'.indexOf(n2) >= 0 ? 'J' : 'T'); break;
      case 'g': if (nx === 'h' && !(i + 2 < w.length && V.indexOf(n2) >= 0)) break; if (nx === 'n') break; out.push('iey'.indexOf(nx) >= 0 && p !== 'g' ? 'J' : 'K'); break;
      case 'h': if (V.indexOf(nx) >= 0 && 'csptg'.indexOf(p) < 0) out.push('H'); break;
      case 'k': if (p !== 'c') out.push('K'); break;
      case 'p': out.push(nx === 'h' ? 'F' : 'P'); if (nx === 'h') i++; break;
      case 'q': out.push('K'); break;
      case 's': if (nx === 'h') { out.push('X'); i++; } else if (nx === 'i' && (n2 === 'o' || n2 === 'a')) out.push('X'); else out.push('S'); break;
      case 't': if (nx === 'i' && (n2 === 'o' || n2 === 'a')) out.push('X'); else if (nx === 'h') { out.push('0'); i++; } else if (!(nx === 'c' && n2 === 'h')) out.push('T'); break;
      case 'v': out.push('F'); break;
      case 'w': case 'y': if (V.indexOf(nx) >= 0) out.push(c.toUpperCase()); break;
      case 'x': out.push('KS'); break;
      case 'z': out.push('S'); break;
      default: out.push(c.toUpperCase());
    }
  }
  return out.join('');
}
// A name that sounds like a different everyday word.
function soundsLike(names, lexicon) {
  const by = new Map(); lexicon.forEach(function (w) { if (w.length >= 4) { const k = metaphone(w); if (k.length >= 2) { if (!by.has(k)) by.set(k, []); by.get(k).push(w); } } });
  const out = [];
  distinctNames(names).forEach(function (n) { const raw = String(n.name).trim(); if (!/^[A-Z][a-z]{3,}$/.test(raw)) return; const l = fold(raw), k = metaphone(l); if (k.length < 2) return;   // a proper name
    const ws = (by.get(k) || []).filter(function (w) { return w !== l && w !== l + 's' && l !== w + 's' && !w.startsWith(l) && !l.startsWith(w) && lev(w, l) >= 1 && lev(w, l) <= 2 && Math.abs(w.length - l.length) <= 2; });
    if (ws.length) out.push({ name: n.name, category: n.category, words: ws.slice(0, 3), lev: Math.min.apply(null, ws.map(function (w) { return lev(w, l); })), notes: (n.notes || []).length }); });
  return out.sort(function (a, b) { return a.lev - b.lev || b.notes - a.notes; });
}

// Titles that look alike when a letter stands in for a digit: 1Q84 / 1084 / 1984 (Q reads as 0 or 9). Exactly one position differs, one side a digit and the other a letter that resembles it.
const LOOK = { '0': 'oq', '1': 'il', '2': 'z', '3': 'e', '4': 'a', '5': 's', '6': 'gb', '7': 't', '8': 'b', '9': 'qg' };
function digitLookalikes(items) {
  const list = distinctNames(items).map(function (n) { return { n: n, s: String(n.name).trim().toLowerCase() }; }).filter(function (x) { return x.s.length >= 3 && x.s.length <= 12 && !/\s/.test(x.s) && /\d{2}/.test(x.s.replace(/[a-z]/g, '')) || x.s.length >= 3 && x.s.length <= 12 && !/\s/.test(x.s) && (x.s.match(/\d/g) || []).length >= 2; });
  const buckets = new Map();
  list.forEach(function (x) { for (let i = 0; i < x.s.length; i++) { const k = x.s.length + ':' + x.s.slice(0, i) + '*' + x.s.slice(i + 1); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push([x, i]); } });
  const out = [], seen = new Set();
  buckets.forEach(function (b) {
    for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
      const x = b[i][0], y = b[j][0], pos = b[i][1]; if (x.s === y.s) continue;
      const cx = x.s[pos], cy = y.s[pos], dx = /\d/.test(cx), dy = /\d/.test(cy); if (dx === dy) continue;
      const digit = dx ? cx : cy, letter = dx ? cy : cx; if (LOOK[digit].indexOf(letter) < 0) continue;
      const rest = x.s.slice(0, pos) + x.s.slice(pos + 1); if ((rest.match(/\d/g) || []).length < 2) continue;
      const id = x.s < y.s ? x.s + '|' + y.s : y.s + '|' + x.s; if (seen.has(id)) continue; seen.add(id);
      out.push({ a: x.n.name, b: y.n.name, notes: (x.n.notes || []).length + (y.n.notes || []).length });
    }
  });
  return out;
}

module.exports = { digitLookalikes, lexiconOf, palindromes, reversals, anagramWords, echoNames, alliterative, tautonyms, letterOddities, palindromeYears, hiddenWords, headTail, metaphone, soundsLike, fold, wordsOf, letters, kindOf, wordKinds, digitNames, oneLetterOff, diffOne, sharedParts, anagrams, acronyms, vocabOf, roundCapable };
