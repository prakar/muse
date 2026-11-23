'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const H = require('../packs/quiz/tools/heuristics');
const BUILD = require('../packs/quiz/tools/heuristics_build');

const COMMONS = [
  '# Commons', '## A', '1. **Chain with pivot:** a scenario, then its consequence. [LLM]', '29. **Anomaly in a corpus:** the outlier. [SQL if counts are stored]',
  '38. **Material x occasion.** [SQL]', '51. **Backronym, initials-as-name, pun-title.** [STR/LLM]', '- not a heuristic', 'prose line'
].join('\n');
const ILL = ['| # | Heuristic | Src | Fragment | How | Conf |', '|---|---|---|---|---|---|', '| 1 | Chain | P | text | how | H |', '| 1 | | P | text | how | M, R on a detail |', '| 29 | Anomaly | KK | text | how | L |'].join('\n');

test('parseCommons reads id, name and tag, and ignores everything else', () => {
  const r = H.parseCommons(COMMONS);
  assert.deepStrictEqual(r.map(x => x.id), [1, 29, 38, 51]);
  assert.strictEqual(r[0].name, 'Chain with pivot');
  assert.strictEqual(r[1].tag, 'SQL if counts are stored');
  assert.strictEqual(r[2].name, 'Material x occasion');
  assert.strictEqual(r[3].tag, 'STR/LLM');
});

test('parseIllustrations counts fragments and keeps only the grade letter', () => {
  const r = H.parseIllustrations(ILL);
  assert.strictEqual(r[1].fragments, 2);
  assert.deepStrictEqual(r[1].conf, ['H', 'M']);
  assert.deepStrictEqual(r[29].conf, ['L']);
  assert.ok(!JSON.stringify(r).includes('text'), 'fragment text must never be read out');
});

test('groupOf matches the four groups', () => {
  assert.strictEqual(H.groupOf(1), 'A'); assert.strictEqual(H.groupOf(44), 'A'); assert.strictEqual(H.groupOf(45), 'B');
  assert.strictEqual(H.groupOf(60), 'C'); assert.strictEqual(H.groupOf(61), 'D'); assert.strictEqual(H.groupOf(71), 'D');
});

function tiny(over) {
  const overlay = { assessed: 'x', relations: ['caused-by'], gaps: { G2: { title: 't', fix: 'f' }, G4: { title: 't', fix: 'f' } }, rows: { '1': Object.assign({ route: 'relation', v6: 'missing', gaps: ['G2'], join_on: ['entity'], rel: ['caused-by'], detector: 'judge', note: 'ok' }, over || {}) } };
  return { overlay: overlay, reg: H.build('1. **A:** x. [LLM]', '| 1 | A | P | t | h | H |', overlay) };
}
test('validate accepts a consistent row (only the count check fails on a one-row registry)', () => {
  const t = tiny(); const bad = H.validate(t.reg, t.overlay);
  assert.deepStrictEqual(bad, ['expected 71 heuristics, found 1']);
});
test('validate rejects bad enums, unknown names and rule breaks', () => {
  const rules = [
    [{ route: 'nope' }, 'route missing or unknown'], [{ v6: 'maybe' }, 'v6 missing or unknown'], [{ detector: 'x' }, 'detector missing or unknown'],
    [{ gaps: ['G9'] }, 'unknown gap G9'], [{ rel: ['made-up'] }, 'unknown relation made-up'], [{ join_on: ['galaxy'] }, 'unknown join_on galaxy'],
    [{ rel: [] }, 'relation route needs at least one relation'], [{ gaps: [] }, 'relation route must list gap G2'],
    [{ note: '' }, 'note missing'], [{ route: 'string', gaps: ['G2'], rel: [] }, 'string route must list gap G4'],
    [{ route: 'join', join_on: [], rel: [] }, 'join route needs join_on'], [{ v6: 'covered' }, 'covered rows should not list gaps']
  ];
  rules.forEach(function (c) {
    const t = tiny(c[0]); const bad = H.validate(t.reg, t.overlay).join(' | ');
    assert.ok(bad.indexOf(c[1]) >= 0, 'expected "' + c[1] + '" in: ' + bad);
  });
});
test('a row with no example in the Illustrations note is rejected', () => {
  const overlay = tiny().overlay; const reg = H.build('1. **A:** x. [LLM]', '', overlay);
  assert.ok(H.validate(reg, overlay).join(' ').indexOf('no example in the Illustrations note') >= 0);
});

// Real sources: skipped where the vault notes are not on this machine.
const haveNotes = fs.existsSync(path.join(BUILD.NOTES, 'QUARRY - Heuristics Commons.md')) && fs.existsSync(path.join(BUILD.NOTES, 'QUARRY - Heuristics Illustrations.md'));
test('the real registry is valid and in sync with its sources', { skip: !haveNotes && 'vault notes not on this machine' }, () => {
  const s = BUILD.sources(), reg = H.build(s.commons, s.illustrations, s.overlay);
  assert.deepStrictEqual(H.validate(reg, s.overlay), []);
  const file = path.join(__dirname, '..', 'packs', 'quiz', 'data', 'heuristics.json');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(reg, null, 2) + '\n', 'run: node --no-warnings packs/quiz/tools/heuristics_build.js');
});
test('the committed registry holds no quiz text: only names, tags, counts and grades', () => {
  const file = path.join(__dirname, '..', 'packs', 'quiz', 'data', 'heuristics.json');
  if (!fs.existsSync(file)) return;
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.rows.forEach(r => assert.deepStrictEqual(Object.keys(r).sort(), ['conf', 'detector', 'fragments', 'gaps', 'group', 'id', 'join_on', 'name', 'note', 'rel', 'route', 'tag', 'v6']));
  assert.strictEqual(reg.rows.length, 71);
});
test('relation names in the vault gap note match the registry vocabulary', { skip: !fs.existsSync(path.join(BUILD.NOTES, 'QUARRY - Heuristics Gap Analysis.md')) && 'gap note not written yet' }, () => {
  const md = fs.readFileSync(path.join(BUILD.NOTES, 'QUARRY - Heuristics Gap Analysis.md'), 'utf8');
  const sec = md.slice(md.indexOf('## Draft relation vocabulary'));
  const names = (sec.slice(0, sec.indexOf('\n## ', 5) > 0 ? sec.indexOf('\n## ', 5) : undefined).match(/^\| `([a-z-]+)` \|/gm) || []).map(x => /`([a-z-]+)`/.exec(x)[1]);
  const overlay = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'packs', 'quiz', 'data', 'heuristic_overlay.json'), 'utf8'));
  assert.deepStrictEqual(names.slice().sort(), overlay.relations.slice().sort());
});
