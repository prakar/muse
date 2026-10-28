'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), os = require('os'), path = require('path');
const K = require('../code/lib/marks');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'marks-')), 'm.jsonl');

test('a mark on a handle and on a fact are kept apart; the latest mark wins; clear removes it', () => {
  const f = tmp(), m = K.open(f, 'nug-v6');
  m.set('wp:homophone:Wales|whales', null, 'use', { kind: 'wordplay' });
  m.set('wp:homophone:Wales|whales', 7, 'dull');
  m.set('wp:homophone:Wales|whales', 7, 'wrong-sense');
  assert.strictEqual(m.get('wp:homophone:Wales|whales'), 'use');
  assert.strictEqual(m.get('wp:homophone:Wales|whales', 7), 'wrong-sense');
  assert.strictEqual(m.get('wp:homophone:Wales|whales', 8), undefined);
  m.set('wp:homophone:Wales|whales', 7, 'clear');
  assert.strictEqual(m.get('wp:homophone:Wales|whales', 7), undefined);
  assert.deepStrictEqual(m.counts(), { use: 1, dull: 0, 'wrong-sense': 0 });
});
test('marks survive a restart and a torn line is skipped', () => {
  const f = tmp(); K.open(f).set('mercury', 3, 'dull');
  fs.appendFileSync(f, '{"handle":"x","mark"\n');
  const m = K.open(f); assert.strictEqual(m.get('mercury', 3), 'dull'); assert.strictEqual(m.all().length, 1);
});
test('an unknown mark is refused and nothing is written', () => {
  const f = tmp(), m = K.open(f); assert.throws(() => m.set('a', null, 'love'));
  assert.ok(!fs.existsSync(f));
});
