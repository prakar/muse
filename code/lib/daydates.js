'use strict';
/**
 * QUARRY lib/daydates.js — day-level dates in prose, with the role the date plays (heuristic gap G1).
 *
 * "14 March 1879", "March 14, 1879", "14th of March", "Mar. 14" -> a day hook. Years and decades are lib/dates.js and
 * lib/bristles.js (datesIn); this module reads only the day and month. The join handle is the month and day alone
 * ("march 14"), so a birth on 14 March 1879 and a founding on 14 March 1903 meet: that is heuristic 3, same-moment coincidence.
 * The role (born, died, founded, ...) is read from the cue words just before the date, in the same clause. It is metadata for
 * the judge and the spark card, never part of the key.
 *
 *   findDays(text) -> [{ key: 'march 14', month: 3, day: 14, year: 1879|null, full: '1879-03-14'|null, role: 'born'|...|null, clip: bool, surface: '14 March', text, index, end }]
 *   `full` is the exact-date key (same year too: the strongest coincidence). `clip` marks a web-clipping date (year 2000 or later, no life-event role).
 *
 * No I/O, no LLM. Month names must be capitalised, so the verb "may" never matches. Tested in daydates.test.js.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];   // February allows the 29th: a leap day is a real date
const ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON_SRC = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)';
const ORD = '(?:st|nd|rd|th)';
const YEAR = '(?:,?\\s+(\\d{3,4})(?![\\d,]\\d|\\.\\d))';   // an optional year after the date; "1,000" and "12.5" are not years

// Day first: "14 March", "14th of March", "14 Mar. 1879". Month first: "March 14", "March 14th, 1879".
const DAY_FIRST = new RegExp('(?<![\\d,.#$/\\-])(\\d{1,2})' + ORD + '?(?:\\s+of)?\\s+(' + MON_SRC + ')\\b\\.?' + YEAR + '?', 'g');
const MON_FIRST = new RegExp('\\b(' + MON_SRC + ')\\b\\.?\\s+(\\d{1,2})' + ORD + '?(?![\\d:]|\\.\\d|,\\d)' + YEAR + '?', 'g');

// Role cues, nearest one before the date wins. Order inside a role does not matter; matching is on word stems.
const ROLES = [
  ['born', /\b(?:born|birth|birthday)\b/i],
  ['died', /\b(?:died|dies|death|killed|executed|assassinated|buried|murdered|perished|passed away)\b/i],
  ['founded', /\b(?:founded|established|incorporated|formed|created|chartered|instituted)\b/i],
  ['opened', /\b(?:opened|inaugurated|launched|unveiled|debuted|premiered|premiere|dedicated)\b/i],
  ['released', /\b(?:released|published|issued|aired|broadcast|first broadcast)\b/i],
  ['signed', /\b(?:signed|ratified|enacted|passed|adopted|declared|proclaimed|promulgated)\b/i],
  ['began', /\b(?:began|begins|started|commenced|outbreak|invaded|landed|arrived)\b/i],
  ['ended', /\b(?:ended|ends|ceased|closed|abolished|surrendered|abdicated|resigned|dissolved|collapsed|fell)\b/i],
  ['married', /\b(?:married|wed|wedding|engaged)\b/i],
  ['crowned', /\b(?:crowned|coronation|elected|appointed|sworn in|inaugurated as|took office)\b/i],
  ['discovered', /\b(?:discovered|invented|patented|first observed|first sighted|first flew|first flight)\b/i],
];

function roleBefore(text, index) {
  // Only the clause the date sits in: stop at a sentence end or semicolon, look back at most 70 characters.
  let w = text.slice(Math.max(0, index - 70), index);
  const cut = Math.max(w.lastIndexOf('. '), w.lastIndexOf('; '), w.lastIndexOf('\n'));
  if (cut >= 0) w = w.slice(cut + 2);
  let best = null, bestAt = -1;
  ROLES.forEach(function (r) {
    const re = new RegExp(r[1].source, 'gi');
    let m;
    while ((m = re.exec(w)) !== null) if (m.index > bestAt) { bestAt = m.index; best = r[0]; }
  });
  return best;
}

function monthNumber(name) {
  const k = name.toLowerCase();
  const full = MONTHS.indexOf(k);
  return full >= 0 ? full + 1 : (ABBR[k] || 0);
}

function findDays(input) {
  const t = String(input == null ? '' : input);
  const out = [], used = [];
  const free = function (a, b) { return !used.some(function (u) { return a < u[1] && b > u[0]; }); };
  const take = function (m, dayStr, monStr, yearStr) {
    const month = monthNumber(monStr), day = parseInt(dayStr, 10);
    if (!month || day < 1 || day > DAYS_IN[month - 1]) return;
    const a = m.index, b = m.index + m[0].length;
    if (!free(a, b)) return;
    used.push([a, b]);
    const year = yearStr ? parseInt(yearStr, 10) : null;
    const name = MONTHS[month - 1];
    const role = roleBefore(t, a);
    // A web-clipping date: an article or post "published on 8 July 2016". It dates the clipping, not a fact about the world,
    // and these swamp the real coincidences, so callers that join on days skip `clip` dates. Born, died, founded... always count.
    const clip = year != null && year >= 2000 && (role === null || role === 'released');
    out.push({ key: name + ' ' + day, month: month, day: day, year: year, role: role, clip: clip,
      full: year != null ? year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0') : null,
      surface: day + ' ' + name[0].toUpperCase() + name.slice(1), text: m[0], index: a, end: b });
  };
  let m;
  DAY_FIRST.lastIndex = 0;
  while ((m = DAY_FIRST.exec(t)) !== null) take(m, m[1], m[2], m[3]);
  MON_FIRST.lastIndex = 0;
  while ((m = MON_FIRST.exec(t)) !== null) take(m, m[2], m[1], m[3]);
  return out.sort(function (x, y) { return x.index - y.index; });
}

module.exports = { findDays, roleBefore, MONTHS };
