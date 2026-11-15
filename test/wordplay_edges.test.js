'use strict';
const test = require('node:test'), assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const E = require('../code/lib/wordplay_edges'), W = require('../code/wordplay');

const idx = new Map([['berlin', [1]], ['merlin', [2, 3]], ['wales', [4]]]);
const res = { one_letter_off: [{ a: 'Berlin', b: 'Merlin', kind: 'substitute', pos: 0, first_letter: true }], homophones: [{ name: 'Wales', words: ['whales', 'wails'] }], palindromes: [{ name: 'maqam' }],
  rhyme_pairs: [{ a: 'Keats', b: 'Beats', key: 'IY T S', kinds: ['person', 'organisation'], cross: true }], acronyms: [{ acronym: 'SURF', expansion: 'x', note: 9, wordlike: true }, { acronym: 'DMPA', expansion: 'y', note: 8, wordlike: false }] };

test('edgesFrom flattens kinds with grades and note ids', () => {
  const rows = E.edgesFrom(res, idx), by = k => rows.filter(r => r.kind === k);
  assert.strictEqual(by('one-letter-off')[0].grade, 'A');
  assert.deepStrictEqual(by('one-letter-off')[0].b_notes, [2, 3]);
  assert.strictEqual(by('homophone').length, 2);
  assert.strictEqual(by('palindrome')[0].b_name, null);
  assert.strictEqual(by('rhyme')[0].grade, 'C', 'rhymes are listed, not sparks');
  assert.strictEqual(E.edgesFrom({ one_letter_off: [{ a: 'Monarchy', b: 'Monarchs', kind: 'substitute', pos: 7, first_letter: false }] }, idx)[0].grade, 'C', 'last-letter change is an inflection');
  assert.strictEqual(by('acronym-word').length, 1, 'only word-like acronyms are kept');
});
test('apply replaces rows, summary counts grades', () => {
  const db = new DatabaseSync(':memory:'), rows = E.edgesFrom(res, idx);
  assert.throws(() => W.apply(db, rows), /Missing table: wordplay_edges/);   // a step never builds a table itself
  db.exec(E.SCHEMA_SQL);   // what the migration does
  W.apply(db, rows); W.apply(db, rows);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM wordplay_edges').get().c, rows.length, 'second apply replaces, not appends');
  assert.strictEqual(db.prepare('SELECT fit FROM wordplay_edges LIMIT 1').get().fit, null);
  assert.strictEqual(W.summary(rows)['one-letter-off'].A, 1);
});
