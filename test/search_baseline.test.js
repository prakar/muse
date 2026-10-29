const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const SB = require('../code/lab/search_baseline');

test('terms drops question words and stopwords, keeps content words once, in order', () => {
  assert.deepStrictEqual(SB.terms('How much protein does Quinoa have per 100 grams?'), ['protein', 'quinoa', 'per', '100', 'grams']);
  assert.deepStrictEqual(SB.terms('Is james bond always a british actor'), ['james', 'bond', 'british', 'actor']);
  assert.deepStrictEqual(SB.terms('Why are texas and taxes anagrams'), ['texas', 'taxes', 'anagrams']);
  assert.deepStrictEqual(SB.terms('What is the?'), []);
  assert.deepStrictEqual(SB.terms('hair hair Hair'), ['hair']);
});

test('matchExpr quotes every term, so query syntax cannot leak in', () => {
  assert.strictEqual(SB.matchExpr(['quinoa', 'protein']), '"quinoa" OR "protein"');
  assert.strictEqual(SB.matchExpr(['a"b']), '"ab"');
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE vault_notes (id INTEGER PRIMARY KEY, title TEXT, quarry_exclude INT DEFAULT 0);
    CREATE TABLE burrs (id INTEGER PRIMARY KEY, note_id INT, claim TEXT, quote TEXT, kind TEXT, hooks_json TEXT, prompt_version TEXT);`);
  db.prepare('INSERT INTO vault_notes (id,title,quarry_exclude) VALUES (1,?,0)').run('Grains');
  db.prepare('INSERT INTO vault_notes (id,title,quarry_exclude) VALUES (2,?,0)').run('Private diary');
  db.prepare('INSERT INTO vault_notes (id,title,quarry_exclude) VALUES (3,?,1)').run('Excluded');
  const ins = db.prepare('INSERT INTO burrs (note_id,claim,quote,kind,hooks_json,prompt_version) VALUES (?,?,?,?,?,?)');
  ins.run(1, 'Quinoa contains about 14 grams of protein per 100 grams.', 'x', 'fact', '[]', 'nug-v6');
  ins.run(1, 'Rice is a staple grain in Asia.', 'x', 'fact', '[]', 'nug-v6');
  ins.run(3, 'Quinoa secret protein plan.', 'x', 'fact', '[]', 'nug-v6');
  return db;
}

test('search ranks the best overlap first and never returns excluded notes', () => {
  const idx = SB.buildIndex(fixture(), 'nug-v6');
  assert.strictEqual(idx.n, 2);                                   // the excluded note's burr is not indexed
  const r = SB.search(idx, 'How much protein does quinoa have per 100 grams?', 5);
  assert.strictEqual(r.hits[0].claim.startsWith('Quinoa contains'), true);
  assert.ok(r.hits[0].matched.includes('quinoa'));
  assert.ok(r.hits.every(h => !/secret/.test(h.claim)));
});

test('stemming matches word forms; a query with no content words returns no hits', () => {
  const idx = SB.buildIndex(fixture(), 'nug-v6');
  assert.strictEqual(SB.search(idx, 'which grains are staples', 5).hits[0].claim.startsWith('Rice'), true);
  assert.deepStrictEqual(SB.search(idx, 'What is the?', 5).hits, []);
});
