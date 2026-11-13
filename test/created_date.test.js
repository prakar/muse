'use strict';
const test = require('node:test'), assert = require('node:assert');
const { normalizeCreated: n } = require('../code/lib/created_date');
test('created: ISO dates and bare years pass through; spelled-out dates become ISO; template leftovers become null', () => {
  for (const ok of ['2016-07-17', '2024-11-04T10:30:00Z', '2018', '2025-05-09T09:17:36 (UTC +05:30)']) assert.strictEqual(n(ok), ok);
  assert.strictEqual(n('"2018"'), '2018'); assert.strictEqual(n("'2016-07-17'"), '2016-07-17');
  assert.strictEqual(n('17 July 2016'), '2016-07-17'); assert.strictEqual(n('4 November 2024'), '2024-11-04');
  assert.strictEqual(n('4 Nov 2024'), '2024-11-04'); assert.strictEqual(n('July 17, 2016'), '2016-07-17'); assert.strictEqual(n('1st Sept 2019'), '2019-09-01');
  for (const bad of ['We0-47-yyyy', 'Mo0-33-yyyy', 'Su0-00-yyyy', '', '   ', null, undefined, '31 February 2020', '2016-13-45', '12', 'yesterday']) assert.strictEqual(n(bad), null, String(bad));
});
