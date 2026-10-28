#!/usr/bin/env node
'use strict';
// Scan the vault's names and claims for wordplay leads (heuristics 47, 49, 50, 51, 58, 59, 60, 69). No model, read-only on eval.db.
//   node --no-warnings code/lab/wordplay_scan.js --db eval.db           writes code/lab/out/<version>/wordplay_scan.json and prints counts
const fs = require('node:fs'), path = require('node:path');
const D = require('./data'), W = require('../lib/wordplay'), PH = require('../lib/phonetics'), { isBoilerplate } = require('./boiler');
const NAME_TYPES = new Set(['entity', 'place', 'material']);

// Pure: distinct names with category and the notes that carry them, from burrs.
function namesFrom(burrs) {
  const m = new Map();
  burrs.forEach(b => (b.hooks || []).forEach(h => {
    if (!NAME_TYPES.has(h.type) || !h.value) return;
    const name = String(h.value).trim(); if (name.length < 3 || name.length > 40 || name.split(/\s+/).length > 5) return;
    const k = name.toLowerCase(); if (!m.has(k)) m.set(k, { name: name, category: h.cat || h.category || (h.type === 'place' ? 'place' : 'other'), notes: new Set() });
    m.get(k).notes.add(b.note_id);
  }));
  return Array.from(m.values()).map(n => ({ name: n.name, category: n.category, notes: Array.from(n.notes) }));
}
// Numbers and years that appear as hooks (1084, 1984): the other half of a look-alike pair such as 1Q84.
function numericStrings(burrs) {
  const m = new Map();
  burrs.forEach(b => (b.hooks || []).forEach(h => { if ((h.type === 'number' || h.type === 'time') && /^\d{3,6}$/.test(String(h.value))) { const k = String(h.value); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(b.note_id); } }));
  return Array.from(m.entries()).map(e => ({ name: e[0], category: 'number', notes: Array.from(e[1]) }));
}
// Digit-bearing words in note titles ("Mother of 1084" -> 1084): titles are the cleanest names in the vault.
function titleNumbers(titles) {
  const m = new Map();
  titles.forEach(t => (String(t.title || '').match(/[A-Za-z0-9]*\d[A-Za-z0-9]*/g) || []).forEach(w => { if (w.length >= 3 && w.length <= 12) { if (!m.has(w)) m.set(w, new Set()); m.get(w).add(t.id); } }));
  return Array.from(m.entries()).map(e => ({ name: e[0], category: 'title', notes: Array.from(e[1]) }));
}
function scan(burrs, extra) {
  extra = extra || {};
  const names = namesFrom(burrs), vocab = W.vocabOf(burrs), kinds = W.wordKinds(names), digits = W.digitNames(names), off = W.oneLetterOff(names), parts = W.sharedParts(names, { vocab: vocab }),
    ana = W.anagrams(names), acr = W.acronyms(burrs, vocab);
  const counts = { names: names.length, name_kind_groups: kinds.length, digit_names: digits.length, one_letter_off: off.length, one_letter_off_first_letter: off.filter(p => p.first_letter).length, shared_part_same_kind: parts.filter(p => p.route === 'same-kind').length,
    shared_part_across_kinds: parts.filter(p => p.route === 'across-kinds').length, anagrams: ana.length, acronyms: acr.length, acronyms_wordlike: acr.filter(a => a.wordlike).length };
  counts.round_capable = W.roundCapable({ anagrams: counts.anagrams, one_letter_off: counts.one_letter_off, acronyms: counts.acronyms_wordlike }, 8);
  const lex = W.lexiconOf(vocab, 5), more = {
    palindromes: W.palindromes(names), reversals: W.reversals(names, lex), anagram_words: W.anagramWords(names, lex), echo_names: W.echoNames(names), alliterative: W.alliterative(names),
    tautonyms: W.tautonyms(burrs), letter_oddities: W.letterOddities(names), palindrome_years: W.palindromeYears(burrs), hidden_words: W.hiddenWords(names), head_tail: W.headTail(names, lex), sounds_like: W.soundsLike(names, lex) };
  if (extra.dict) { more.homophones = PH.homophones(extra.dict, names, lex); more.rhyme_pairs = PH.rhymePairs(extra.dict, names).slice(0, 400); }
  more.digit_lookalikes = W.digitLookalikes(names.concat(numericStrings(burrs), extra.titleNumbers || []));
  Object.keys(more).forEach(function (k) { counts[k] = more[k].length; });
  return Object.assign({ counts: counts, kinds: kinds, digits: digits, one_letter_off: off, shared_parts: parts, anagrams: ana, acronyms: acr }, more);
}
// Readable leads: every kind found, each with a one-line note on how reliable it was in a hand check (28 Oct).
function toMarkdown(res) {
  const L = ['# Wordplay leads (from names in the knowledge vault, no model)', '', 'Leads, not verdicts. Re-make with `node --no-warnings code/lab/wordplay_scan.js --db eval.db`. Ranked by how many notes mention the name where that is known.', ''];
  const sec = function (title, note, items) { L.push('## ' + title + ' (' + items.length + ')', '', '_' + note + '_', ''); items.forEach(function (x) { L.push('- ' + x); }); L.push(''); };
  const top = function (a, n) { return a.slice().sort(function (x, y) { return (y.notes || 0) - (x.notes || 0); }).slice(0, n); };
  sec('Changed first letter', 'Strongest pun kind: nearly all good.', res.one_letter_off.filter(p => p.first_letter).map(p => p.a + ' / ' + p.b));
  sec('Anagram pairs, name with name', 'Nearly all genuine.', res.anagrams.map(p => p.names.join(' / ')));
  sec('Anagram of an everyday word', 'Genuine anagrams; a few use odd words from the vault.', (res.anagram_words || []).map(p => p.name + ' = ' + p.words.join(' / ')));
  sec('Reads backwards as another word or name', 'Genuine reversals; interest varies (Zeus / Suez, Camus / sumac, Devil / lived).', (res.reversals || []).map(p => p.name + ' <-> ' + p.reversed));
  sec('Palindromes', 'All genuine.', (res.palindromes || []).map(p => p.name));
  sec('Colour, number or material inside names', 'Sets of 3+ names: mostly good.', res.kinds.map(k => '**' + k.kind + ' in ' + k.category + ' names** (' + k.count + '): ' + k.items.map(i => i.name).join(', ')));
  sec('Name with a word hidden inside', 'Genuine hidden words (a number, colour, body part or animal); some are dull.', (res.hidden_words || []).map(p => p.name + ' hides ' + p.hidden));
  sec('Name that loses its first or last letter and becomes a word', 'Proper names only; about 60% good (Spain / pain, Cuba / cub, Oman / man).', top(res.head_tail || [], 120).map(p => p.name + ' -> ' + p.word + ' (' + p.form + ')'));
  sec('Repeated, rhyming or vowel-swap names', 'Genuine echoes (Bora Bora, Humpty Dumpty, Hong Kong, Fleet Street); the rhyming ones include accidents.', top(res.echo_names || [], 100).map(p => p.name + ' (' + p.form + ')'));
  sec('Alliterative names', 'Genuinely alliterative; top by notes shown.', top(res.alliterative || [], 120).map(p => p.name));
  sec('Same word twice in an animal name', 'Only 2 of 7 are true tautonyms (Gallus gallus, Vulpes vulpes); the rest are repeated words in titles.', (res.tautonyms || []).map(p => p.name));
  sec('Letter oddities', 'Genuine: alphabetical order (Abbott), two doubled pairs in a row (balloon), no vowel but y (rhythm).', (res.letter_oddities || []).map(p => p.name + ' (' + p.form + ')'));
  sec('Years that read the same backwards', 'With the number of notes that mention each.', (res.palindrome_years || []).map(p => p.year + ' (' + p.notes + ' notes)'));
  sec('Sounds like an everyday word (one letter different only)', 'Rough: about a third real (Knight / night, Iran / iron, Marx / marks). Looser matches are in the JSON.', (res.sounds_like || []).filter(p => p.lev === 1).slice(0, 120).map(p => p.name + ' ~ ' + p.words.join(' / ')));
  if (res.homophones) sec('Name sounds exactly like an everyday word', 'Pronunciation match from CMUdict, so exact. Pun candidates; whether the word also fits the topic is for you (or the embedding step) to judge.', top(res.homophones, 150).map(p => p.name + ' = ' + p.words.join(' / ')));
  if (res.rhyme_pairs) sec('Names that rhyme', 'Rhyme from CMUdict, different spelling at the end. Cross-kind pairs (person with organisation, say) first; same-kind pairs follow.', res.rhyme_pairs.filter(p => p.cross).slice(0, 80).concat(res.rhyme_pairs.filter(p => !p.cross).slice(0, 40)).map(p => p.a + ' / ' + p.b));
  sec('Looks like another title when a letter stands for a digit', 'Exactly one position differs (1Q84 / 1084 / 1984).', (res.digit_lookalikes || []).map(p => p.a + ' / ' + p.b));
  sec('Numbers in work titles', 'About half real (1Q84, Love of 3 Oranges, 12 Years a Slave).', res.digits.map(p => p.name));
  return L.join('\n') + '\n';
}
module.exports = { namesFrom, scan, toMarkdown, titleNumbers, numericStrings };

if (require.main === module) {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/wordplay_scan.js --db eval.db [--version nug-v6] [--cmudict cmudict.dict]'); process.exit(1); }
  const version = arg('version', D.DEFAULT_VERSION), db = D.openCopy(arg('db')), all = D.loadBurrs(db, version);
  const skip = new Set(D.loadDupes(db, all.map(b => b.id)).map(d => d.burr_id)), burrs = all.filter(b => !skip.has(b.id) && !isBoilerplate(b.claim));
  let titles = []; try { titles = db.prepare('SELECT id, title FROM vault_notes').all(); } catch (e) { /* no notes table */ }
  let dict = null; if (arg('cmudict')) dict = PH.parseDict(fs.readFileSync(arg('cmudict'), 'utf8'));
  const res = scan(burrs, { titleNumbers: titleNumbers(titles), dict: dict }), dest = path.join(__dirname, 'out', version, 'wordplay_scan.json'); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(res, null, 1));
  fs.writeFileSync(path.join(path.dirname(dest), 'wordplay_leads.md'), toMarkdown(res));
  console.log(burrs.length + ' burrs', JSON.stringify(res.counts, null, 1), '\nwritten to ' + dest);
}
