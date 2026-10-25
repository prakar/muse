'use strict';
/**
 * QUARRY lib/units.js — unit vocabulary and unit-name normalisation.
 *
 * Why this exists: a hand-rolled plural stripper turned "inches" into "inche" and "series" into "serie". Plural
 * handling is now (1) a closed table of units with every spelling listed, then (2) the `pluralize` library for any
 * other counted noun ("runs", "wickets", "tigers"), with a short list of words that are not plurals although they end in s
 * (the library, like the others in the bake-off, singularises "physics" and "lens").
 * Evidence: claude/bakeoff-results-2026-10-25.md in the project (pluralize 26/28 alone; the exception list covers the rest).
 */
const pluralize = require('pluralize');

// canonical -> every spelling that means it (lower case).
const TABLE = {
  km: 'km kms kilometre kilometres kilometer kilometers',
  m: 'm metre metres meter meters',
  cm: 'cm cms centimetre centimetres centimeter centimeters',
  mm: 'mm millimetre millimetres millimeter millimeters',
  mile: 'mi mile miles',
  ft: 'ft feet foot',
  yd: 'yd yds yard yards',
  inch: 'inch inches',
  'km²': 'km² km2 sqkm',
  'km³': 'km³ km3',
  'm²': 'm² m2',
  'm³': 'm³ m3',
  acre: 'acre acres',
  hectare: 'ha hectare hectares',
  kg: 'kg kgs kilogram kilograms kilogramme kilogrammes',
  g: 'g gram grams gramme grammes',
  mg: 'mg milligram milligrams',
  tonne: 'tonne tonnes ton tons',
  lb: 'lb lbs pound-weight',
  oz: 'oz ounce ounces',
  litre: 'l litre litres liter liters',
  ml: 'ml millilitre millilitres milliliter milliliters',
  'km/h': 'kmh kph km/h kmph',
  mph: 'mph',
  hz: 'hz hertz', khz: 'khz', mhz: 'mhz', ghz: 'ghz',
  kb: 'kb', mb: 'mb', gb: 'gb', tb: 'tb',
  watt: 'watt watts w', kw: 'kw', mw: 'mw',
  volt: 'volt volts v',
  '%': 'percent % pct',
  usd: 'dollar dollars usd',
  person: 'person persons people',
  man: 'man men', woman: 'woman women', child: 'child children',
};
// Words that end in s (or look plural) but are singular, or are the same in both numbers.
const NOT_PLURAL = new Set('physics mathematics economics politics linguistics ethics genetics athletics statistics lens news series species bus gas atlas chaos cosmos pancreas iris axis basis crisis thesis analysis'.split(' '));

const FORM = new Map();
Object.keys(TABLE).forEach(function (canon) { TABLE[canon].split(' ').forEach(function (f) { if (f) FORM.set(f, canon); }); });
FORM.delete('pound-weight');

function singular(w) {
  if (!w || NOT_PLURAL.has(w) || /ics$/.test(w)) return w;
  const s = pluralize.singular(w);
  return s || w;
}

// One unit or counted noun -> its canonical singular. A multi-word unit ("million people") is normalised on its last word.
function normUnit(u) {
  const w = String(u == null ? '' : u).toLowerCase().trim();
  if (!w) return w;
  if (FORM.has(w)) return FORM.get(w);
  const parts = w.split(/\s+/);
  const last = parts[parts.length - 1];
  parts[parts.length - 1] = FORM.has(last) ? FORM.get(last) : singular(last);
  return parts.join(' ');
}

// Every spelling in the table: a year-like number followed by one of these is a quantity ("1250 feet"), not a date.
const KNOWN_FORMS = new Set(FORM.keys());
// Unit with an ASCII exponent glued on: "0.4 km3", "120 m2" -> canonical.
function withExponent(word, digit) {
  return FORM.get((word + digit).toLowerCase()) || null;
}

module.exports = { normUnit, KNOWN_FORMS, withExponent, TABLE, singular };
