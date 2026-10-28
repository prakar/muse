'use strict';
// The wordplay_edges table: wordplay found by code/lib/wordplay.js and phonetics.js, stored so Muse never runs the detectors.
// Pure: edgesFrom flattens a scan result into rows. grade is the detector's hand-checked reliability (A nearly all genuine,
// B mostly genuine, C rough, use only with a second signal). C never becomes a Muse spark. A last-letter change (Monarchy / Monarchs) reads as an inflection, so it is C; rhymes are C (many -ese languages). fit is left NULL for the later embedding step (does the sound-alike relate to the topic).
const DETECTOR_VERSION = 'wordplay-v1';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wordplay_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  a_name TEXT NOT NULL,
  b_name TEXT,
  a_notes TEXT NOT NULL DEFAULT '[]',
  b_notes TEXT NOT NULL DEFAULT '[]',
  grade TEXT NOT NULL CHECK (grade IN ('A','B','C')),
  detail TEXT,
  fit REAL,
  detector_version TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wordplay_a ON wordplay_edges(a_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_wordplay_b ON wordplay_edges(b_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_wordplay_kind ON wordplay_edges(kind, grade);
`;

// noteIndex: Map of lowercase name -> array of note ids (names from hooks, digit strings, note titles).
function edgesFrom(res, noteIndex) {
  const rows = [], ni = noteIndex || new Map();
  const notes = n => (n == null ? [] : (ni.get(String(n).toLowerCase()) || []));
  const add = function (kind, grade, a, b, detail) {
    if (a == null || a === '') return;
    rows.push({ kind: kind, a_name: String(a), b_name: b == null ? null : String(b), a_notes: notes(a), b_notes: notes(b), grade: grade, detail: detail == null ? null : JSON.stringify(detail) });
  };
  (res.one_letter_off || []).forEach(p => add('one-letter-off', p.first_letter ? 'A' : (p.pos >= String(p.a).length - 1 ? 'C' : 'B'), p.a, p.b, { change: p.kind, pos: p.pos, first_letter: !!p.first_letter }));
  (res.anagrams || []).forEach(p => add('anagram-pair', 'A', p.names[0], p.names[1]));
  (res.anagram_words || []).forEach(p => p.words.forEach(w => add('anagram-of-word', 'A', p.name, w)));
  (res.reversals || []).forEach(p => add('reversal', 'A', p.name, p.reversed, { with: p.with }));
  (res.palindromes || []).forEach(p => add('palindrome', 'A', p.name, null));
  (res.digit_lookalikes || []).forEach(p => add('digit-lookalike', 'B', p.a, p.b));
  (res.hidden_words || []).forEach(p => add('hidden-word', 'B', p.name, p.hidden, { kind: p.kind }));
  (res.head_tail || []).forEach(p => add('head-tail', 'B', p.name, p.word, { form: p.form }));
  (res.echo_names || []).forEach(p => add('echo-name', p.form === 'repeated' ? 'A' : 'B', p.name, null, { form: p.form }));
  (res.alliterative || []).forEach(p => add('alliterative', 'A', p.name, null));
  (res.tautonyms || []).forEach(p => add('tautonym', 'C', p.name, null));
  (res.letter_oddities || []).forEach(p => add('letter-oddity', 'A', p.name, null, { form: p.form }));
  (res.palindrome_years || []).forEach(p => add('palindrome-year', 'A', p.year, null));
  (res.sounds_like || []).forEach(p => p.words.forEach(w => add('sounds-like', 'C', p.name, w, { lev: p.lev })));
  (res.homophones || []).forEach(p => p.words.forEach(w => add('homophone', 'A', p.name, w)));
  (res.rhyme_pairs || []).forEach(p => add('rhyme', 'C', p.a, p.b, { key: p.key, kinds: p.kinds }));
  (res.acronyms || []).filter(a => a.wordlike).forEach(a => { rows.push({ kind: 'acronym-word', a_name: a.acronym, b_name: a.expansion, a_notes: [a.note], b_notes: [a.note], grade: 'B', detail: null }); });
  (res.digits || []).forEach(p => add('number-in-title', 'C', p.name, null, { form: p.form }));
  (res.kinds || []).forEach(k => rows.push({ kind: 'name-kind-group', a_name: k.kind, b_name: null, a_notes: [], b_notes: [], grade: 'B', detail: JSON.stringify({ category: k.category, items: k.items.map(i => ({ name: i.name, notes: i.notes })) }) }));
  (res.shared_parts || []).forEach(s => rows.push({ kind: 'shared-part', a_name: s.token, b_name: null, a_notes: [], b_notes: [], grade: s.route === 'across-kinds' ? 'C' : 'B', detail: JSON.stringify({ route: s.route, names: s.names }) }));
  return rows;
}
module.exports = { DETECTOR_VERSION, SCHEMA_SQL, edgesFrom };
