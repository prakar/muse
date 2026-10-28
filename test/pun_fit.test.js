'use strict';
const test = require('node:test'), assert = require('node:assert');
const P = require('../code/lab/pun_fit');

// Fake embedding: a vector of how many of three topic words a text contains.
const TOPICS = ['whale', 'sea', 'king'];
const embed = async texts => ({ vecs: texts.map(t => TOPICS.map(w => (t.toLowerCase().includes(w) ? 1 : 0) + 0.01)) });
const claims = { 1: ['Sea creatures such as the whale swim in the sea.'], 2: ['The king ruled for forty years.'], 3: ['The king signed the charter.'] };

test('fitScores: word close to the name\'s notes ranks above a word that is not', async () => {
  const edges = [{ kind: 'homophone', a_name: 'Wales', b_name: 'whale', a_notes: [1], grade: 'A' }, { kind: 'homophone', a_name: 'Kings', b_name: 'whale', a_notes: [2], grade: 'A' },
    { kind: 'homophone', a_name: 'Nothing', b_name: 'x', a_notes: [], grade: 'A' }, { kind: 'rhyme', a_name: 'A', b_name: null, a_notes: [1], grade: 'B' }];
  const r = await P.fitScores(edges, n => claims[n] || [], embed, { baseline: 2 });
  assert.strictEqual(r.length, 2, 'edges with no notes or no word are skipped');
  assert.strictEqual(r[0].a, 'Wales');
  assert.ok(r[0].fit > r[1].fit);
});
