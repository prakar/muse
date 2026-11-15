'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const D = require('../code/lib/dedupe');
const run = require('../code/dedupe').run;
const B = require('../code/lib/burrs');

const b = (id, note, claim) => ({ id: id, note_id: note, claim: claim });

test('facts that differ in one name or number are not duplicates', () => {
  const r = D.findDupes([
    b(1, 1, 'The East Africa cricket squad for CWC 1975 included players from Kenya.'),
    b(2, 1, 'The East Africa cricket squad for CWC 1975 included players from Uganda.'),
    b(3, 2, 'Monsanto was a candidate for Worst Company in America in 2014.'),
    b(4, 2, 'SeaWorld was a candidate for Worst Company in America in 2014.'),
    b(5, 3, 'The tower is 101 floors tall and opened in 2004.'),
    b(6, 4, 'The tower is 110 floors tall and opened in 2004.')
  ]);
  assert.deepStrictEqual(r, []);
});

test('a shorter claim contained in a longer one in the same note is an echo of the longer', () => {
  const r = D.findDupes([
    b(10, 5, 'Chaudhry Rahmat Ali started PAKISTAN as an acronym.'),
    b(11, 5, 'Chaudhry Rahmat Ali started PAKISTAN as an acronym in the 1930s.')
  ]);
  assert.deepStrictEqual(r.map(x => [x.id, x.dup_of, x.kind]), [[10, 11, 'echo']]);
});

test('the same fact in two notes is a clone, and the longer claim is kept', () => {
  const r = D.findDupes([
    b(20, 7, 'Francis Crick and James Watson discovered the structure of DNA in 1953.'),
    b(21, 8, 'Francis Crick and James Watson discovered the structure of DNA in 1953 at Cambridge.'),
    b(22, 9, 'Pharaoh Hounds weigh 45 to 55 pounds.'),
    b(23, 10, 'Pharaoh Hounds weigh 45 to 55 pounds.')
  ]);
  const m = Object.fromEntries(r.map(x => [x.id, x]));
  assert.strictEqual(m[20].dup_of, 21); assert.strictEqual(m[20].kind, 'clone');
  assert.strictEqual(m[23].dup_of, 22); assert.strictEqual(m[23].kind, 'clone');
});

test('a negation in one claim only blocks a match', () => {
  assert.deepStrictEqual(D.findDupes([b(1, 1, 'The 1960s work of Joe Weber on gravitational waves was replicated.'), b(2, 2, 'The 1960s work of Joe Weber on gravitational waves was not replicated.')]), []);
});

test('report only writes nothing; --apply writes flags and replaces them on re-run; --undo clears; no burr is deleted', () => {
  const db = new DatabaseSync(':memory:'); db.exec(B.SCHEMA_SQL);
  const ins = db.prepare("INSERT INTO burrs (id, note_id, claim, quote, kind, hooks_json, loop_text, provenance, method, prompt_version, model, run_id, created_at) VALUES (?, ?, ?, 'q', 'fact', '[]', '', '{}', 'llm', ?, 'm', 'r', '2026-10-24')");
  ins.run(1, 1, 'Pharaoh Hounds weigh 45 to 55 pounds.', B.PROMPT_VERSION);
  ins.run(2, 2, 'Pharaoh Hounds weigh 45 to 55 pounds.', B.PROMPT_VERSION);
  ins.run(3, 3, 'Something else entirely about tea.', B.PROMPT_VERSION);
  const rep = run(db);
  assert.strictEqual(rep.dupes, 1);
  assert.throws(() => db.prepare('SELECT * FROM burr_dupes').all());          // report wrote nothing
  assert.throws(() => run(db, { apply: true }), /Missing table: burr_dupes.*Create or update the database/);   // a step never builds a table itself
  db.exec(D.SCHEMA_SQL);   // what migration M014 does
  run(db, { apply: true }); const r2 = run(db, { apply: true });
  assert.strictEqual(r2.dupes, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM burr_dupes').get().c, 1);
  assert.strictEqual(db.prepare("SELECT status FROM burr_dupes").get().status, 'dup');
  run(db, { undo: true });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM burr_dupes').get().c, 0);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM burrs').get().c, 3);
});

test('a number followed by a full stop is the same number', () => {
  assert.strictEqual(D.sameFact(D.prep(b(1, 1, 'It was founded in 1953.')), D.prep(b(2, 2, 'It was founded in 1953'))) > 0, true);
  assert.strictEqual(D.sameFact(D.prep(b(1, 1, 'It cost 1,500 pounds in 1953.')), D.prep(b(2, 2, 'It cost 1,500 pounds in 1954.'))), 0);
});

test('claims that differ only in a symbol are different facts, not echoes', () => {
  const D = require('../code/lib/dedupe');
  const r = D.findDupes([{ id: 1, note_id: 1, claim: "The ']' key goes to the next page in a multi-page document in Lynx." }, { id: 2, note_id: 2, claim: "The '+' key goes to the next page in a multi-page document in Lynx." }]);
  assert.strictEqual(r.length, 0);
});
