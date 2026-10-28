'use strict';
/**
 * QUARRY lib/heuristics.js: the heuristic registry (checklist H1).
 *
 * One source of truth per field, so nothing can drift:
 *  - name, detection tag and group  <- vault note "QUARRY - Heuristics Commons" (parsed, never copied)
 *  - fragment count and confidence  <- vault note "QUARRY - Heuristics Illustrations" (counts only; no quiz text is read out)
 *  - route, v6 coverage, gaps, joins, relations, detector, note <- code/data/heuristic_overlay.json (authored, canonical)
 * code/data/heuristics.json is GENERATED from those three by code/heuristics_build.js and checked for drift by the tests.
 *
 * Pure functions, no I/O.
 */
const B = require('./burrs');

const GROUPS = [[1, 44, 'A', 'link structures'], [45, 57, 'B', 'names and words'], [58, 60, 'C', 'surface-form'], [61, 71, 'D', 'set and round shapes']];
const ROUTES = ['join', 'string', 'relation', 'judge', 'card', 'author'];
const V6 = ['covered', 'partial', 'missing', 'na'];
const DETECTORS = ['sql', 'str', 'judge', 'author', 'none'];
const JOIN_ON = B.HOOK_TYPES.concat(B.CATEGORIES, ['date']);
const N = 71;

function groupOf(id) { const g = GROUPS.find(function (x) { return id >= x[0] && id <= x[1]; }); return g ? g[2] : null; }

// "12. **Name:** description [TAG]"  ->  { id, name, tag }
function parseCommons(md) {
  const rows = [];
  String(md).split(/\r?\n/).forEach(function (line) {
    const m = /^(\d+)\. \*\*(.+?)\*\*(.*)$/.exec(line);
    if (!m) return;
    const t = /\[([A-Za-z\/ ]+?)\]\s*$/.exec(m[3]);
    rows.push({ id: parseInt(m[1], 10), name: m[2].replace(/[:.]\s*$/, '').trim(), tag: t ? t[1].trim() : null });
  });
  return rows;
}

// Table rows "| 12 | name | SRC | fragment | how | CONF |": only the id and the grade are read. The fragment text is ignored.
function parseIllustrations(md) {
  const per = {};
  String(md).split(/\r?\n/).forEach(function (line) {
    const m = /^\|\s*(\d+)\s*\|/.exec(line);
    if (!m) return;
    const cols = line.split('|').map(function (c) { return c.trim(); });
    const conf = cols[cols.length - 2] || '';
    const id = parseInt(m[1], 10);
    const o = per[id] || (per[id] = { fragments: 0, conf: [] });
    o.fragments++;
    const g = /^[HMLR]/.exec(conf);
    if (g) o.conf.push(g[0]);
  });
  return per;
}

function build(commonsMd, illustrationsMd, overlay) {
  const commons = parseCommons(commonsMd), ill = parseIllustrations(illustrationsMd), rows = [];
  commons.forEach(function (c) {
    const o = (overlay.rows || {})[String(c.id)] || {}, f = ill[c.id] || { fragments: 0, conf: [] };
    rows.push({
      id: c.id, group: groupOf(c.id), name: c.name, tag: c.tag,
      route: o.route, v6: o.v6, gaps: o.gaps || [], join_on: o.join_on || [], rel: o.rel || [], detector: o.detector, note: o.note,
      fragments: f.fragments, conf: f.conf
    });
  });
  return { generated_from: ['QUARRY - Heuristics Commons', 'QUARRY - Heuristics Illustrations', 'code/data/heuristic_overlay.json'], assessed: overlay.assessed, relations: overlay.relations, gaps: overlay.gaps, rows: rows };
}

// Returns a list of problems; empty means valid.
function validate(reg, overlay) {
  const bad = [];
  const rows = reg.rows || [];
  if (rows.length !== N) bad.push('expected ' + N + ' heuristics, found ' + rows.length);
  rows.forEach(function (r, i) {
    const w = 'heuristic ' + r.id + ': ';
    if (r.id !== i + 1) bad.push(w + 'ids must run 1..' + N + ' in order');
    if (!r.name) bad.push(w + 'no name in the Commons');
    if (!r.tag) bad.push(w + 'no detection tag in the Commons');
    if (ROUTES.indexOf(r.route) < 0) bad.push(w + 'route missing or unknown');
    if (V6.indexOf(r.v6) < 0) bad.push(w + 'v6 missing or unknown');
    if (DETECTORS.indexOf(r.detector) < 0) bad.push(w + 'detector missing or unknown');
    if (!r.note || r.note.length > 160) bad.push(w + 'note missing or over 160 characters');
    (r.gaps || []).forEach(function (g) { if (!(reg.gaps || {})[g]) bad.push(w + 'unknown gap ' + g); });
    (r.rel || []).forEach(function (x) { if ((reg.relations || []).indexOf(x) < 0) bad.push(w + 'unknown relation ' + x); });
    (r.join_on || []).forEach(function (x) { if (JOIN_ON.indexOf(x) < 0) bad.push(w + 'unknown join_on ' + x); });
    if (r.route === 'relation' && !(r.rel || []).length) bad.push(w + 'relation route needs at least one relation');
    if (r.route === 'relation' && (r.gaps || []).indexOf('G2') < 0) bad.push(w + 'relation route must list gap G2');
    if (r.route === 'join' && !(r.join_on || []).length) bad.push(w + 'join route needs join_on');
    if (r.route === 'string' && (r.gaps || []).indexOf('G4') < 0) bad.push(w + 'string route must list gap G4');
    if (r.v6 === 'covered' && r.route !== 'string' && (r.gaps || []).length) bad.push(w + 'covered rows should not list gaps (string rows list G4 only)');
    if ((r.v6 === 'missing' || r.v6 === 'partial') && !(r.gaps || []).length && r.route !== 'judge') bad.push(w + v6msg(r));
    if (r.fragments === 0) bad.push(w + 'no example in the Illustrations note');
  });
  if (overlay) Object.keys(overlay.rows || {}).forEach(function (k) { if (+k < 1 || +k > N) bad.push('overlay has a row for ' + k); });
  return bad;
}
function v6msg(r) { return 'v6 is ' + r.v6 + ' but no gap explains it'; }

function summarise(reg) {
  const by = function (k) { const o = {}; reg.rows.forEach(function (r) { o[r[k]] = (o[r[k]] || 0) + 1; }); return o; };
  const gaps = {}; reg.rows.forEach(function (r) { r.gaps.forEach(function (g) { (gaps[g] = gaps[g] || []).push(r.id); }); });
  return { routes: by('route'), v6: by('v6'), detectors: by('detector'), gaps: gaps };
}

function toTable(reg) {
  const out = ['| # | Heuristic | Tag | Route | v6 | Gaps | Joins on | Relations | Fragments |', '|---|---|---|---|---|---|---|---|---|'];
  reg.rows.forEach(function (r) { out.push('| ' + [r.id, r.name, r.tag, r.route, r.v6, r.gaps.join(' '), r.join_on.join(', '), r.rel.join(', '), r.fragments + ' (' + r.conf.join('') + ')'].join(' | ') + ' |'); });
  return out.join('\n');
}

module.exports = { GROUPS, ROUTES, V6, DETECTORS, JOIN_ON, N, groupOf, parseCommons, parseIllustrations, build, validate, summarise, toTable };
