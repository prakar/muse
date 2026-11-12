const test = require('node:test');
const assert = require('node:assert');
const DD = require('../code/lib/daydates');
const L = require('../code/lib/bristles');

// sig = key | role | year
const sig = (f) => [f.key, f.role || '-', f.year == null ? '-' : f.year].join('|');
const found = (s) => DD.findDays(s).map(sig);

const GOLDEN = [
  ['Albert Einstein was born on 14 March 1879 in Ulm.', ['march 14|born|1879']],
  ['Einstein was born March 14, 1879.', ['march 14|born|1879']],
  ['The company was founded on the 14th of March.', ['march 14|founded|-']],
  ['Pi Day falls on March 14th.', ['march 14|-|-']],
  ['The treaty was signed on 4 Jul. 1776.', ['july 4|signed|1776']],
  ['He died on 29 February 1972.', ['february 29|died|1972']],
  ['The bridge opened on Sept 3, 1931 to traffic.', ['september 3|opened|1931']],
  ['Born 1 January 1900, died 31 December 1980.', ['january 1|born|1900', 'december 31|died|1980']],
  // the nearest cue in the same clause wins; a cue from the previous sentence does not carry over
  ['She was born in Paris and married on 5 June 1920.', ['june 5|married|1920']],
  ['He died young. The school opened on 9 October 1950.', ['october 9|opened|1950']],
  ['It was released on 10 May 2001, a year after it was announced.', ['may 10|released|2001']],
  // not days
  ['She may 5 times visit the shop.', []],
  ['The May 1998 issue was late.', []],
  ['In March 1998 the fund grew.', []],
  ['The 31 June deadline was a typo.', []],
  ['He ran 12 March 2 miles.', ['march 12|-|-']],                    // "2" is not a year (needs 3-4 digits)
  ['Route 14 Mar Vista Drive.', ['march 14|-|-']],                  // known limit: a bare "14 Mar" is taken as a date
  ['The 1,200 Dec items were counted.', []],
  ['Costs 5.14 March sums.', []],
];

for (const [text, want] of GOLDEN) {
  test('findDays: ' + text, () => assert.deepStrictEqual(found(text), want));
}

test('two spellings of one day make one join key', () => {
  const a = DD.findDays('Born 14 March 1879.')[0], b = DD.findDays('Opened March 14th, 1903.')[0];
  assert.strictEqual(a.key, b.key);
  assert.notStrictEqual(a.role, b.role);
});

test('surface is human readable, key is lower case', () => {
  const f = DD.findDays('Founded on 3 sept 1900.')[0];
  assert.strictEqual(f, undefined);                                  // month names must be capitalised
  const g = DD.findDays('Founded on 3 Sept 1900.')[0];
  assert.strictEqual(g.surface, '3 September');
  assert.strictEqual(g.key, 'september 3');
});

test('a key never looks like a year or a quantity to the rest of the model', () => {
  const k = DD.findDays('Born 14 March 1879.')[0].key;
  assert.strictEqual(L.yearOfKey(k), null);
  assert.strictEqual(L.quantityOfKey(k), null);
  assert.strictEqual(L.usableKey(k), true);
});

test('exposed through lib/bristles as daysIn', () => {
  assert.strictEqual(typeof L.daysIn, 'function');
  assert.strictEqual(L.daysIn('Died 1 April 1999.')[0].role, 'died');
});

test('empty and odd input', () => {
  assert.deepStrictEqual(DD.findDays(''), []);
  assert.deepStrictEqual(DD.findDays(null), []);
  assert.deepStrictEqual(DD.findDays(undefined), []);
});

test('full date key is zero padded and only present when a year is', () => {
  assert.strictEqual(DD.findDays('Born 4 May 1799.')[0].full, '1799-05-04');
  assert.strictEqual(DD.findDays('Born 4 May.')[0].full, null);
});

test('clip dates (a post or article dated 2000 or later) are flagged; life events never are', () => {
  assert.strictEqual(DD.findDays('Ed Yong wrote the piece on June 6, 2016.')[0].clip, true);
  assert.strictEqual(DD.findDays('The paper was published on 8 July 2016.')[0].clip, true);
  assert.strictEqual(DD.findDays('Anna Politkovskaya died on 7 October 2006.')[0].clip, false);
  assert.strictEqual(DD.findDays('Google was founded on 4 September 1998.')[0].clip, false);
  assert.strictEqual(DD.findDays('Pi Day falls on March 14.')[0].clip, false);   // no year: nothing to tell
});
