const test = require('node:test');
const assert = require('node:assert');
const D = require('../code/lib/dates');
const L = require('../code/lib/bristles');

// Golden cases: the sentences of the library bake-off (bakeoff/cases.json) and the failure catalogue C1-C7.
// sig = text | from..to | grain | era(stated?) | flags
const sig = (f) => [f.text, f.from + '..' + f.to, f.grain, f.era + (f.eraStated ? '!' : '?'), (f.approx ? 'c' : '') + (f.mod || '') + (f.range ? 'r' : '')].join('|');
const found = (s) => D.findDates(s).map(sig);

const GOLDEN = [
  ['The Roman Empire fell in AD 476.', ['AD 476|476..477|year|ad!|']],
  ['Vesuvius erupted in 79 AD.', ['79 AD|79..80|year|ad!|']],
  ['The eruption of Thera was c. 1600 BC.', ['1600 BC|-1600..-1599|year|bc!|c']],
  ['The eruption of Thera was c. 1600 BC and Rome fell in AD 476.', ['1600 BC|-1600..-1599|year|bc!|c', 'AD 476|476..477|year|ad!|']],
  ['The imperial Chinese exam occurred in the 7th century.', ['7th century|601..701|century|ad?|']],
  ['Built in the early seventh century.', ['early seventh century|601..701|century|ad?|early']],
  ['Founded in the 5th century BC.', ['5th century BC|-500..-400|century|bc!|']],
  ['The 1st century BC saw civil war.', ['1st century BC|-100..0|century|bc!|']],
  ['The product was developed in the 1980s.', ['1980s|1980..1990|decade|ad?|']],
  ['A hit of the late 1990s.', ['late 1990s|1990..2000|decade|ad?|late']],
  ['Emmy Noether 1882-1935 was a mathematician.', ['1882|1882..1883|year|ad?|r', '1935|1935..1936|year|ad?|r']],
  ['He lived 1908-2000.', ['1908|1908..1909|year|ad?|r', '2000|2000..2001|year|ad?|r']],
  ['The 1963-64 season.', ['1963|1963..1964|year|ad?|r', '64|1964..1965|year|ad?|r']],
  ['Reigned 500-400 BC.', ['500|-500..-499|year|bc!|r', '400|-400..-399|year|bc!|r']],
  ['The Dattilam was composed between the 1st and 4th century AD.', ['1st and 4th century AD|1..101|century|ad!|r', '1st and 4th century AD|301..401|century|ad!|r']],
  ['Mid-20th century physics.', ['Mid-20th century|1901..2001|century|ad?|mid']],
  // not dates
  ['He scored 1,234 runs in 1998.', []],
  ['Windows 95 shipped in 1995.', []],
  ['The tower is 1250 feet tall and opened in 1931.', []],
  ['Texas could have between 2,000 and 5,000 tigers.', []],
  ['7-Eleven christened store #2,000 in 1968.', []],
  ['A 1500-metre race in 1972', []],
  ['between 1000-1500 people came', []],
  ['a road 1000-1500 km long', []],
  ['the 747-400 jet', []],
  ['Priced at $1,999-$2,500', []],
  ['ad 476 is lowercase and ignored', []],
];
for (const [s, want] of GOLDEN) test('dates golden: ' + s, () => assert.deepStrictEqual(found(s), want));

test('datesIn: eras, ranges, decades and "in the YEAR" come out as keys; quantities do not', () => {
  const k = (s) => L.datesIn(s).map((x) => x.key);
  assert.deepStrictEqual(k('Rome fell in AD 476.'), ['476 ad']);
  assert.deepStrictEqual(k('Vesuvius erupted in 79 AD.'), ['79 ad']);
  assert.deepStrictEqual(k('Thera c. 1600 BC.'), ['1600 bc']);
  assert.deepStrictEqual(k('Emmy Noether 1882-1935 was a mathematician.'), ['1882', '1935']);
  assert.deepStrictEqual(k('The product was developed in the 1980s.'), ['1980']);
  assert.deepStrictEqual(k('England scored 552 runs in the 1947 series against South Africa.'), ['1947']);
  assert.deepStrictEqual(k('He scored 1743 runs in 1950; the road is 1120 km.'), ['1950']);
  assert.deepStrictEqual(k('Rome fell in AD 476, in 1085 Toledo fell, and 79 AD.'), ['476 ad', '1085', '79 ad']);
});

test('a year followed by a comma or full stop is still a year ("In 1066, the Normans...")', () => {
  const k = (s) => L.datesIn(s).map((x) => x.key);
  assert.deepStrictEqual(k('In 1066, the Normans won.'), ['1066']);
  assert.deepStrictEqual(k('He left in 1998, and returned in 2004.'), ['1998', '2004']);
  assert.deepStrictEqual(k('about 1,000 people came in 1998'), ['1998']);
  assert.deepStrictEqual(L.yearsIn('In 1066, the Normans won; 1,066 men'), ['1066']);
});
