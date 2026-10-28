'use strict';
const test = require('node:test'), assert = require('node:assert');
const C = require('../code/lib/connect');
const hook = { id: 'nimrud', kind: 'hook', surface: 'Nimrud', types: ['place'], df: 5, items: [1, 2, 3, 4, 5].map(i => ({ id: i, noteId: i, note: 'Notes on Nimrud ' + i, claim: 'Nimrud fact ' + i + ' about Nimrud', quote: 'q Nimrud', diff: i })) };
const wp = { id: 'wp:homophone:Wales|whales', kind: 'wordplay', wordplay: 'homophone', grade: 'A', a: 'Wales', b: 'whales', surface: 'Wales ~ whales', items: [{ id: 1, noteId: 1, note: 'A', claim: 'Wales is a country.', quote: '', diff: 2, side: 'a' }, { id: 2, noteId: 2, note: 'B', claim: 'Blue whales are big.', quote: '', diff: 1, side: 'b' }] };

test('orders hard to easy and labels bands', () => {
  const r = C.connect(hook, { n: 5 });
  assert.deepStrictEqual(r.items.map(i => i.id), [5, 4, 3, 2, 1]);
  assert.strictEqual(r.items[0].band, 'hard'); assert.strictEqual(r.items[4].band, 'easy');
  assert.strictEqual(r.handle.surface, 'Nimrud');
});
test('order option flips the list or restores the order found', () => {
  assert.deepStrictEqual(C.connect(hook, { n: 5, order: 'easy' }).items.map(i => i.id), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(C.connect(hook, { n: 5, order: 'found' }).items.map(i => i.rank), [1, 2, 3, 4, 5]);
  assert.strictEqual(C.connect(hook, { n: 5, order: 'easy' }).items[0].band, 'easy');
});
test('a short set keeps the spread: n=3 of 5 takes hardest, middle, easiest', () => {
  assert.deepStrictEqual(C.connect(hook, { n: 3 }).items.map(i => i.id), [5, 3, 1]);
});
test('reveal-last withholds the handle and blanks it in every fact', () => {
  const r = C.connect(hook, { n: 3, reveal: true });
  assert.strictEqual(r.handle, null);
  assert.ok(r.items.every(i => !/Nimrud/i.test(i.claim + i.quote + i.note)), 'claim, quote and note title are all masked');
  assert.strictEqual(r.answer.surface, 'Nimrud');
});
test('wordplay handle gets a lead-in line, masked in reveal mode', () => {
  const r = C.connect(wp, {});
  assert.strictEqual(r.leadIn, 'Wales sounds exactly like "whales"');
  const m = C.connect(wp, { reveal: true });
  assert.strictEqual(m.leadIn, null); assert.strictEqual(m.answer.leadIn, 'Wales sounds exactly like "whales"');
  assert.ok(m.items.every(i => !/Wales|whales/i.test(i.claim)));
});
test('unknown handle and thin sets are reported, not guessed', () => {
  assert.ok(C.connect(null).error);
  assert.ok(C.connect({ id: 'x', kind: 'hook', surface: 'X', items: [hook.items[0]] }).warning);
});
test('kept facts are always included; dull and wrong-sense facts are replaced by the next candidate', () => {
  const marks = { 1: 'use', 5: 'dull', 4: 'wrong-sense' };
  const r = C.connect(hook, { n: 3, markOf: id => marks[id] });
  assert.ok(r.items.some(i => i.id === 1 && i.mark === 'use'), 'the kept easy fact is in even though it would not be picked');
  assert.ok(r.items.every(i => i.id !== 5 && i.id !== 4), 'dull and wrong-sense facts are left out');
  assert.strictEqual(r.items.length, 3); assert.strictEqual(r.hidden, 2);
  const s = C.connect(hook, { n: 5, markOf: id => marks[id], showHidden: true });
  assert.strictEqual(s.items.length, 5); assert.strictEqual(s.hidden, 0); assert.strictEqual(s.items[0].mark, 'dull');
});
test('reveal mode shows no pivot hooks; otherwise the handle itself is dropped from them', () => {
  const withHooks = { id: 'nimrud', kind: 'hook', surface: 'Nimrud', items: [{ id: 1, noteId: 1, note: 'N', claim: 'Nimrud fact', quote: '', diff: 1, hooks: [{ id: 'nimrud', label: 'Nimrud', df: 5 }, { id: 'assyria', label: 'Assyria', df: 9 }] }, { id: 2, noteId: 2, note: 'N2', claim: 'Another Nimrud fact', quote: '', diff: 2, hooks: [] }] };
  assert.deepStrictEqual(C.connect(withHooks, {}).items.find(i => i.id === 1).hooks.map(k => k.id), ['assyria']);
  assert.ok(C.connect(withHooks, { reveal: true }).items.every(i => i.hooks.length === 0));
});
