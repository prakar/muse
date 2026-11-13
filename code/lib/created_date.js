'use strict';
// One place that decides what a note's `created` value may be in vault.db. Standard library only.
// Accepted as they are: a value that starts with a valid ISO date (2016-07-17, 2016-07-17T10:00, "2025-05-09T09:17:36 (UTC +05:30)"), or a bare year (2018).
// Converted: "17 July 2016", "4 Nov 2024", "July 17, 2016" become 2016-07-17; quoted values lose their quotes.
// Everything else (for example the template leftovers like "We0-47-yyyy") becomes null: no date is better than a wrong one.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
function validDay(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
function ymd(y, m, d) { return m && d && validDay(y, m, d) ? y + '-' + pad(m) + '-' + pad(d) : null; }
function normalizeCreated(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^["']+|["']+$/g, '').trim();
  if (!s) return null;
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(s))) return validDay(+m[1], +m[2], +m[3]) ? s : null;   // anything after a valid date (a time, "(UTC +05:30)") is kept as written
  if ((m = /^(\d{4})$/.exec(s))) return +m[1] >= 1000 ? m[1] : null;
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s))) return ymd(+m[3], MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]);
  if ((m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) return ymd(+m[3], MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return null;
}
module.exports = { normalizeCreated };
