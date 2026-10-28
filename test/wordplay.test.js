'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('../code/lib/wordplay');
const n = (name, category, notes) => ({ name: name, category: category || 'other', notes: notes || ['a', 'b'] });

test('wordKinds groups colour/number/material names by kind of thing, needs 3+ names and 2+ notes', () => {
  const g = W.wordKinds([n('Black Sea', 'place', ['a']), n('Red Sea', 'place', ['b']), n('Yellow Sea', 'place', ['c']), n('Red Dot', 'organisation', ['a']), n('Peter Black', 'person'), n('Black Panther', 'other', ['d'])]);
  assert.strictEqual(g.length, 1);
  assert.deepStrictEqual([g[0].kind, g[0].category, g[0].count], ['colour', 'place', 3]);
  assert.strictEqual(W.wordKinds([n('Black Sea', 'place', ['a']), n('Red Sea', 'place', ['a']), n('Blue Nile', 'place', ['a'])]).length, 0, 'one note only');
});
test('digitNames finds fused digits and numerals in work titles, never persons', () => {
  const d = W.digitNames([n('IQ84', 'work'), n('Fahrenheit 451', 'work'), n('Apollo 11', 'event'), n('Se7en', 'work'), n('Louis 14', 'person'), n('Ubuntu 10.04', 'work'), n('Honey 2', 'work'), n('Matthew 25:29', 'work')]);
  assert.deepStrictEqual(d.map(x => x.name).sort(), ['Fahrenheit 451', 'IQ84', 'Se7en']);
});
test('oneLetterOff finds a changed letter and skips plurals, suffixes and identical letters', () => {
  const p = W.oneLetterOff([n('Drainspotting', 'work'), n('Trainspotting', 'work'), n('Himalaya', 'place'), n('Himalayas', 'place'), n('Jahangir', 'person'), n('Jehangir', 'place'), n('Mathnawi', 'work'), n('Mathnavi', 'work'), n('garlic', 'plant'), n('Gaelic', 'language')]);
  assert.deepStrictEqual(p.map(x => [x.a, x.b].sort().join('/')).sort(), ['Drainspotting/Trainspotting', 'Gaelic/garlic']);
  assert.strictEqual(p.find(x => /Drain|Train/.test(x.a)).first_letter, true);
});
test('sharedParts: same-kind (Amu/Syr Darya), across kinds (Red Dot), generic words and people ignored', () => {
  const s = W.sharedParts([n('Amu Darya', 'place'), n('Syr Darya', 'place'), n('Red Dot Payments', 'organisation'), n('Red Dot Pavilion', 'work'), n('Blue River', 'place'), n('Green River', 'place'), n('John Darya', 'person'), n('Kerala', 'place'), n('Kerala Murals', 'work'), n('Kerala Waterfalls', 'place')]);
  const by = Object.fromEntries(s.map(x => [x.token, x]));
  assert.strictEqual(by.darya.route, 'same-kind'); assert.strictEqual(by.darya.count, 2);
  assert.strictEqual(by['red dot'].route, 'across-kinds'); assert.ok(!by.payments);
  assert.ok(!by.river, 'generic word'); const e = W.sharedParts([n('Premier League', 'organisation', ['a']), n('Muslim League', 'organisation', ['b'])], { vocab: new Map([['league', 19]]) }); assert.strictEqual(e.length, 0, 'everyday English word'); assert.ok(!by.kerala, 'the shared word is itself a name');
});
test('anagrams: different arrangements only, not the same words reordered', () => {
  const a = W.anagrams([n('Elvis', 'person'), n('Lives', 'work'), n('Silent', 'work'), n('Listen', 'work'), n('Smith John', 'person'), n('John Smith', 'person'), n('da Vinci', 'person'), n('DaVinci', 'person'), n('fiber', 'object'), n('fibre', 'object'), n('Eastern Airlines', 'organisation'), n('Eastern Air Lines', 'organisation')]);
  assert.deepStrictEqual(a.map(x => x.names.slice().sort().join('/')).sort(), ['Elvis/Lives', 'Listen/Silent']);
});
test('acronyms: expansion after or before, initials must match, small words skipped', () => {
  const r = W.acronyms([{ id: 1, note_id: 'x', claim: 'NASA (National Aeronautics and Space Administration) was founded in 1958.' },
    { id: 2, note_id: 'y', claim: 'The Strategic Arms Limitation Talks (SALT) began in 1969.' },
    { id: 3, note_id: 'z', claim: 'The Fruit Bat Society (XYZ) met.' }]);
  assert.deepStrictEqual(r.map(x => x.acronym).sort(), ['NASA', 'SALT']);
  assert.strictEqual(r.find(x => x.acronym === 'SALT').pronounceable, true);
  const w = W.acronyms([{ id: 2, note_id: 'y', claim: 'The Strategic Arms Limitation Talks (SALT) began.' }], new Map([['salt', 9]]));
  assert.strictEqual(w[0].wordlike, true);
});
test('roundCapable lists the kinds with enough items', () => {
  assert.deepStrictEqual(W.roundCapable({ anagrams: 12, joined: 3 }, 8), ['anagrams']);
});

test('toMarkdown lists the three chosen kinds', () => {
  const { toMarkdown } = require('../code/lab/wordplay_scan');
  const md = toMarkdown({ one_letter_off: [{ a: 'Siberia', b: 'Iberia', first_letter: true }, { a: 'x', b: 'y', first_letter: false }], anagrams: [{ names: ['Koran', 'Akron'] }], kinds: [{ kind: 'colour', category: 'place', count: 2, items: [{ name: 'Black Sea' }, { name: 'Red Sea' }] }], digits: [] });
  assert.match(md, /## Changed first letter \(1\)\n\n_[^\n]*_\n\n- Siberia \/ Iberia/);
  assert.ok(!md.includes('x / y'));
  assert.match(md, /Koran \/ Akron/); assert.match(md, /colour in place names\*\* \(2\): Black Sea, Red Sea/);
});

const lex = new Set(['mined', 'listen', 'pain', 'cub', 'whales', 'soul', 'lived', 'use']);
test('palindromes, reversals and anagrams of everyday words', () => {
  assert.deepStrictEqual(W.palindromes([n('Malayalam'), n('Tenet'), n('Hello'), n('Aaaaa')]).map(x => x.name), ['Malayalam', 'Tenet']);
  const r = W.reversals([n('Zeus'), n('Suez'), n('Devil'), n('Tenet')], lex);
  assert.deepStrictEqual(r.map(x => x.name + '>' + x.with).sort(), ['Devil>word', 'Zeus>name']);
  assert.deepStrictEqual(W.anagramWords([n('Denim'), n('Silent'), n('Mined')], lex).map(x => x.name + '=' + x.words[0]), ['Denim=mined', 'Silent=listen']);
});
test('echo names: repeated, rhyming, vowel swap; alliterative names; tautonyms', () => {
  const e = Object.fromEntries(W.echoNames([n('Bora Bora'), n('Humpty Dumpty'), n('Hip Hop'), n('Marie Curie'), n('Peter Parker'), n('Fleet Street')]).map(x => [x.name, x.form]));
  assert.deepStrictEqual(e, { 'Bora Bora': 'repeated', 'Humpty Dumpty': 'rhyming', 'Hip Hop': 'vowel swap', 'Marie Curie': 'rhyming', 'Fleet Street': 'rhyming' });
  assert.deepStrictEqual(W.alliterative([n('Peter Parker'), n('Coca-Cola'), n('Marie Curie'), n('Bed and Breakfast')]).map(x => x.name), ['Peter Parker', 'Coca-Cola', 'Bed and Breakfast']);
  assert.deepStrictEqual(W.tautonyms([{ id: 1, note_id: 'a', claim: 'The gorilla is Gorilla gorilla in Latin.' }]).map(x => x.name), ['Gorilla gorilla']);
});
test('letter oddities, palindrome years, hidden words', () => {
  const o = Object.fromEntries(W.letterOddities([n('Abbott'), n('balloon'), n('Rhythm'), n('Hello')]).map(x => [x.name, x.form]));
  assert.deepStrictEqual(o, { Abbott: 'alphabetical order', balloon: 'two doubles in a row', Rhythm: 'no vowel but y' });
  assert.deepStrictEqual(W.palindromeYears([{ note_id: 'a', hooks: [{ type: 'time', value: '1991' }, { type: 'time', value: '1992' }, { type: 'time', value: '1111' }] }]).map(x => x.year), ['1991']);
  const h = Object.fromEntries(W.hiddenWords([n('Northumbria'), n('French Indochina'), n('British Airways'), n('Black Sea')]).map(x => [x.name, x.hidden]));
  assert.deepStrictEqual(h, { Northumbria: 'thumb', 'French Indochina': 'chin', 'British Airways': 'hair' });
});
test('head/tail: proper names only; sounds-like: close spellings only', () => {
  const h = W.headTail([n('Spain', 'place'), n('Cuba', 'place'), n('face'), n('OMAN')], lex);
  assert.deepStrictEqual(h.map(x => x.name + '>' + x.word).sort(), ['Cuba>cub', 'Spain>pain']);
  assert.strictEqual(W.metaphone('Wales'), W.metaphone('whales'));
  const s = W.soundsLike([n('Wales', 'place'), n('Seoul', 'place'), n('Mayday')], lex);
  assert.deepStrictEqual(s.map(x => x.name).sort(), ['Seoul', 'Wales']);
  assert.strictEqual(s.find(x => x.name === 'Wales').lev, 1);
});

test('digitLookalikes pairs strings that differ by one letter standing in for a digit (1Q84 / 1084 / 1984)', () => {
  const p = W.digitLookalikes([n('1Q84'), n('1084'), n('1984'), n('Se7en'), n('Seven'), n('a1'), n('al'), n('2001'), n('2O01')]);
  assert.deepStrictEqual(p.map(x => [x.a, x.b].sort().join('~')).sort(), ['1084~1Q84', '1984~1Q84', '2001~2O01'].sort());
});
