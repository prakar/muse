'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const R = require('../code/lab/repair_after_redo');

const mk = (rows) => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE burrs (id INTEGER PRIMARY KEY, note_id INT, prompt_version TEXT, claim TEXT, loop_text TEXT)');
  const ins = db.prepare('INSERT INTO burrs VALUES (?,?,?,?,?)'); rows.forEach(r => ins.run(...r)); return db; };
const backup = () => mk([[10, 1, 'nug-v6', 'A fact.', 'why A?'], [11, 1, 'nug-v6', 'B fact.', null], [12, 2, 'nug-v6', 'C fact.', 'why C?'], [13, 3, 'nug-v6', 'Gone fact.', null]]);
const now = () => mk([[500, 1, 'nug-v6', 'A fact.', null], [501, 1, 'nug-v6', 'B fact.', null], [502, 2, 'nug-v6', 'C fact.', 'why C?'], [12, 9, 'nug-v6', 'Other.', null]]);

test('idMap pairs old ids with the same fact now; a fact that is gone, or an id still alive, is not paired', () => {
  const m = R.idMap(backup(), now());
  assert.deepStrictEqual([...m.entries()].sort(), [[10, 500], [11, 501]]);
});
test('marks: an active star on an old id is cleared there and re-issued on the new id; cleared or unrelated marks are left alone', () => {
  const m = R.idMap(backup(), now());
  const ev = [{ handle: '*', item: 10, mark: 'use', version: 'nug-v6' }, { handle: 'h', item: 11, mark: 'use' }, { handle: 'h', item: 11, mark: 'clear' }, { handle: 'wp:x', item: null, mark: 'dull' }];
  const out = R.marksAppend(ev, m, 'T');
  assert.deepStrictEqual(out.map(e => [e.mark, e.item]), [['clear', 10], ['use', 500]]);
  assert.strictEqual(out[1].remappedFrom, 10);
});
test('judgements: only fact judgements on a changed id are copied to the new id, with their own time', () => {
  const m = R.idMap(backup(), now());
  const ev = [{ ts: 'T0', view: 'burrs', id: '10', label: 'keep' }, { ts: 'T0', view: 'bristles', id: '10', label: 'x' }, { ts: 'T0', view: 'burrs', id: '12', label: 'y' }];
  const out = R.judgementsAppend(ev, m);
  assert.deepStrictEqual(out.map(e => [e.view, e.id, e.ts]), [['burrs', '500', 'T0']]);
});
test('loops: archived loop_text returns to the burr that lost it and never overwrites one that has its own', () => {
  const l = R.loopsToRestore(backup(), now());
  assert.deepStrictEqual(l, [{ id: 500, loop_text: 'why A?' }]);
});
