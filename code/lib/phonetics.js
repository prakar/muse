'use strict';
// Pronunciation-based wordplay (rhymes, exact sound-alikes) from the CMU Pronouncing Dictionary. No model, pure functions.
// Dictionary file: cmudict.dict (lines like "knight N AY1 T", variants "read(2) R EH1 D"). Names missing from it are skipped.
const fold = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
const isVowel = p => /\d$/.test(p);
const strip = p => p.replace(/\d/g, '');

function parseDict(text) {
  const d = new Map();
  String(text).split(/\r?\n/).forEach(function (line) {
    if (!line || line[0] === ';') return;
    const parts = line.trim().split(/\s+/), w = parts[0].replace(/\(\d+\)$/, '').toLowerCase();
    if (!/^[a-z]+$/.test(w) || parts.length < 2) return;
    if (!d.has(w)) d.set(w, []);
    d.get(w).push(parts.slice(1));
  });
  return d;
}
// First pronunciation as phones with stress digits, or null.
function phones(dict, word) { const v = dict.get(fold(word)); return v ? v[0] : null; }
// Everything from the last stressed vowel to the end, stress dropped ("night" -> AY T). Falls back to the last vowel.
function rhymeKey(ph) {
  if (!ph) return null;
  let i = -1;
  for (let k = ph.length - 1; k >= 0; k--) if (/[12]$/.test(ph[k])) { i = k; break; }
  if (i < 0) for (let k = ph.length - 1; k >= 0; k--) if (isVowel(ph[k])) { i = k; break; }
  return i < 0 ? null : ph.slice(i).map(strip).join(' ');
}
const soundKey = ph => (ph ? ph.map(strip).join(' ') : null);
const lastWord = n => { const w = String(n).trim().split(/\s+/); return w[w.length - 1]; };

// Names whose sound equals an everyday word spelt differently (Knight / night, Paine / pain). lexicon = Set of lowercase everyday words.
function homophones(dict, names, lexicon) {
  const bySound = new Map();
  lexicon.forEach(function (w) { const ph = phones(dict, w); if (!ph) return; const k = soundKey(ph); if (!bySound.has(k)) bySound.set(k, []); bySound.get(k).push(w); });
  const out = [];
  names.forEach(function (n) {
    const word = String(n.name).trim(); if (/\s/.test(word) || word.length < 3) return; // single-word names only
    const ph = phones(dict, word); if (!ph) return;
    const f = fold(word), hits = (bySound.get(soundKey(ph)) || []).filter(w => w !== f && w.length >= 3);
    if (hits.length) out.push({ name: word, category: n.category, words: hits.slice(0, 4), notes: n.notes.length });
  });
  return out;
}
// Pairs of different names whose last word rhymes, spelt differently at the end (Keats / Beats). Key must hold a vowel plus a consonant, or a long vowel set.
function rhymePairs(dict, names, opts) {
  opts = opts || {};
  const groups = new Map();
  names.forEach(function (n) {
    const w = lastWord(n.name); if (fold(w).length < 4 || /\d/.test(w)) return;
    const ph = phones(dict, w); if (!ph) return;
    const k = rhymeKey(ph); if (!k) return;
    const parts = k.split(' '); if (parts.length < 2) return; // bare vowel ending is too common
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ n: n, w: fold(w), ph: ph });
  });
  const out = [];
  groups.forEach(function (g, k) {
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      if (a.w === b.w) continue;
      if (k.split(' ').length >= 4 && a.w.slice(-4) === b.w.slice(-4)) continue; // long shared suffix: Hampton/Compton, not a surprise
      if (soundKey(a.ph) === soundKey(b.ph)) continue; // exact homophones are the other list
      if (opts.sameKindOnly && a.n.category !== b.n.category) continue;
      out.push({ a: a.n.name, b: b.n.name, key: k, kinds: [a.n.category, b.n.category], notes: Math.min(a.n.notes.length, b.n.notes.length), cross: a.n.category !== b.n.category });
    }
  });
  return out.sort((x, y) => y.notes - x.notes);
}
module.exports = { parseDict, phones, rhymeKey, soundKey, homophones, rhymePairs, fold };
