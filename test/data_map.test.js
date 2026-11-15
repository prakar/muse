'use strict';
// The data map (code/data_map.js) is scanned from the code. These tests keep the committed copy honest and catch table references that no longer match the schema.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('fs');
const DM = require('../code/data_map');

test('the committed data map matches a fresh scan of the code', () => {
  const { map } = DM.generate();
  assert.equal(fs.readFileSync(DM.COMMITTED, 'utf8'), JSON.stringify(map, null, 1) + '\n', 'data map is out of date: review, then run node code/data_map.js --write');
});

test('no SQL in the code names a table that does not exist', () => {
  const { unknown } = DM.generate();
  assert.deepEqual(unknown, {}, 'stale table reference(s): ' + JSON.stringify(unknown));
});

test('every table is both written and read by the code, or has a stated reason', () => {
  const { map } = DM.generate(), bad = [];
  for (const [t, m] of Object.entries(map.tables)) {
    const written = m.C.length + m.U.length + m.D.length > 0, read = m.R.length > 0;
    if ((!written || !read) && !DM.WHY_ONE_SIDED[t]) bad.push(t + (written ? ' is never read' : ' is never written'));
  }
  assert.deepEqual(bad, []);
});

test('every stated one-sided reason names a real table', () => {
  const names = DM.tableNames();
  for (const t of Object.keys(DM.WHY_ONE_SIDED)) assert.ok(names.includes(t), t + ' is not a table');
});
