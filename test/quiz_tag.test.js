'use strict';
const test = require('node:test'), assert = require('node:assert');
const Q = require('../code/lab/quiz_tag');
const COMMONS = ['# x', '1. **Chain with pivot:** a vivid scenario, then the consequence it produced. [LLM]', '7. **Namesake split:** one person’s name appearing in two unlike entities. [SQL]', '39. **Lesser-known achievement** of a well-known person. [LLM]', '49. **Near-homophone or one-letter-off pair.** [STR]', '61. **Connect:** many clues, one hidden link. [SQL]', '66. **Split answers:** two or three sub-answers. [LLM]', 'not a heuristic line'].join('\n');
const defs = Q.parseDefs(COMMONS), known = new Set(defs.map(d => d.id));
const item = { id: 'q#1', source: 'q', n: 1, question: 'Which Roman emperor taxed trade with India, and what flowed out as a result?', answer: 'Vespasian; gold' };

test('parseDefs reads id, name and meaning from the Commons list and drops the detection tag', () => {
  assert.deepStrictEqual(defs.map(d => d.id), [1, 7, 39, 49, 61, 66]); assert.strictEqual(defs[0].name, 'Chain with pivot'); assert.strictEqual(defs[0].what, 'a vivid scenario, then the consequence it produced.');
  assert.ok(!/LLM|SQL/.test(Q.SYSTEM(defs)), 'tags are not in the prompt'); assert.ok(Q.SYSTEM(defs).includes('7. Namesake split:')); assert.ok(!/confidence/i.test(Q.SYSTEM(defs)), 'no self-rated confidence is asked for');
});

test('parseTags keeps real ids, drops unknown ids and repeats, and marks evidence that is not in the item (elisions are checked stretch by stretch)', () => {
  const r = Q.parseTags('```json\n{"tags":[{"id":1,"evidence":"Which Roman emperor taxed trade"},{"id":1,"evidence":"x"},{"id":999,"evidence":"x"},{"id":49,"evidence":"never said this"}]}\n```', item, known);
  assert.ok(r.ok); assert.deepStrictEqual(r.tags.map(t => [t.id, t.weak]), [[1, false], [49, true]]); assert.strictEqual(r.dropped, 2);
  const gap = Q.parseTags('{"tags":[{"id":1,"evidence":"Which Roman emperor taxed [...] what flowed out as a result?"},{"id":7,"evidence":"Which Roman emperor ... never said this here"},{"id":49,"evidence":"a b"}]}', item, known);
  assert.deepStrictEqual(gap.tags.map(t => [t.id, t.weak]), [[1, false], [7, true], [49, true]]);
  assert.strictEqual(Q.parseTags('nope', item, known).ok, false); assert.deepStrictEqual(Q.parseTags('{"tags":[]}', item, known).tags, []);
});

test('tagItems: set-level heuristics are not offered; a dry run calls nothing; a real run caches, stops at the budget and reports bad replies', async () => {
  const calls = [], systems = []; const cache = new Map(), deps = { callLLM: async (p, u, o) => { calls.push(u); systems.push(o.system); return { text: '{"tags":[{"id":1,"evidence":"Roman emperor taxed trade"}]}', model: 'm', tokensIn: 1000, tokensOut: 50 }; }, cache: { get: k => cache.get(k), put: (k, r) => cache.set(k, r) }, ledger: null };
  const items = [item, Object.assign({}, item, { id: 'q#2', n: 2 }), Object.assign({}, item, { id: 'q#3', n: 3 })], rate = (i, o) => (i + o) / 1000;
  let r = await Q.tagItems(items, deps, { provider: 'x', defs, maxUsd: 100, dryRun: true, rate }); assert.strictEqual(calls.length, 0); assert.ok(r.planned > 0); assert.strictEqual(r.records.length, 0);
  r = await Q.tagItems(items, deps, { provider: 'x', defs, maxUsd: 100, dryRun: false, rate }); assert.strictEqual(calls.length, 3); assert.strictEqual(r.records.length, 3); assert.strictEqual(r.records[0].tags[0].weak, false); assert.strictEqual(r.records[0].provider, 'x');
  assert.ok(!systems[0].includes('61. Connect'), 'whole-set shapes are left for a later pass'); assert.ok(!systems[0].includes('66. Split answers'), 'split answers fires on any multi-part item, so it is not offered'); assert.ok(systems[0].includes('49. Near-homophone'));
  r = await Q.tagItems(items, deps, { provider: 'x', defs, maxUsd: 100, dryRun: false, rate }); assert.strictEqual(calls.length, 3, 'a second run is served from the cache'); assert.strictEqual(r.spent, 0);
  cache.clear(); calls.length = 0; r = await Q.tagItems(items, deps, { provider: 'x', defs, maxUsd: 1.0, dryRun: false, rate }); assert.strictEqual(calls.length, 1, 'one call costs 1.05, then the budget stops it'); assert.ok(r.problems.some(p => p.stopped === 'budget'));
  const bad = await Q.tagItems([item], { callLLM: async () => ({ text: 'garbage', model: 'm', tokensIn: 1, tokensOut: 1 }), cache: { get: () => null, put() { } } }, { provider: 'x', defs, maxUsd: 9, dryRun: false, rate }); assert.strictEqual(bad.problems[0].error, 'not json');
});

test('a reply with two JSON objects reads the first; a saved reply that cannot be read is asked for again, once', async () => {
  assert.deepStrictEqual(Q.parseTags('{"tags":[{"id":1,"evidence":"Roman emperor taxed trade"}]}  {"tags":[{"id":7,"evidence":"x"}]}', item, known).tags.map(t => t.id), [1]);
  assert.strictEqual(Q.parseTags('{"tags":[{"id":1,"evidence":"Roman emperor tax', item, known).ok, false, 'cut off');
  assert.strictEqual(Q.parseTags('{"tags":[{"id":1,"evidence":"has a } brace"}]}', item, known).ok, true, 'a brace inside a string does not end the object');
  let calls = 0; const cache = new Map([['k', null]]); const store = { get: k => cache.get(k), put: (k, r) => cache.set(k, r) };
  const deps = { callLLM: async () => { calls++; return { text: '{"tags":[]}', model: 'm', tokensIn: 1, tokensOut: 1 }; }, cache: store };
  const first = await Q.tagItems([item], { callLLM: deps.callLLM, cache: { get: () => ({ text: '{"tags":[{"id":1', model: 'm' }), put: store.put } }, { provider: 'x', defs, maxUsd: 9, dryRun: false, rate: () => 0 });
  assert.strictEqual(calls, 1); assert.strictEqual(first.records.length, 1, 'the unreadable saved answer was replaced');
});

test('merge marks which tags both providers gave; agreement counts them; only items both tagged are kept', () => {
  const A = [{ id: 'i1', source: 's', tags: [{ id: 1, evidence: 'e', weak: false }, { id: 7, evidence: 'e', weak: true }] }, { id: 'i2', source: 's', tags: [] }], B = [{ id: 'i1', source: 's', tags: [{ id: 7, evidence: 'f', weak: false }, { id: 39, evidence: 'f', weak: false }] }];
  const m = Q.merge(A, B, 'gemini', 'claude'); assert.strictEqual(m.length, 1);
  assert.deepStrictEqual(m[0].tags.map(t => [t.id, t.agreed, t.by.join('+'), t.weak]), [[1, false, 'gemini', false], [7, true, 'gemini+claude', false], [39, false, 'claude', false]]);
  const g = Q.agreement(m); assert.strictEqual(g.both, 1); assert.strictEqual(g.single, 2); assert.ok(Math.abs(g.share - 1 / 3) < 1e-9);
});

test('review sheet lists the tags with who gave them; parseReview reads Wrong and Missed; scoreReview gives precision (both vs one model) and recall', () => {
  const items = [Object.assign({}, item, { id: 'q#1', source: 'q' }), { id: 'z#1', source: 'z', question: 'other other other other other other other other', answer: '' }];
  const merged = [{ id: 'q#1', source: 'q', tags: [{ id: 1, by: ['a', 'b'], agreed: true, evidence: '', weak: false }, { id: 7, by: ['a'], agreed: false, evidence: '', weak: false }, { id: 49, by: ['b'], agreed: false, evidence: '', weak: false }] }, { id: 'z#1', source: 'z', tags: [] }];
  const md = Q.reviewSheet(items, merged, defs, 'q'); assert.ok(md.includes('### q#1') && !md.includes('z#1')); assert.ok(md.includes('1 Chain with pivot [both]') && md.includes('7 Namesake split [a only]'));
  const filled = md.replace('Wrong:\n', 'Wrong: 7, 49\n').replace('Missed:\n', 'Missed: 39 and 61\n'); const rv = Q.parseReview(filled);
  assert.deepStrictEqual(rv, [{ id: 'q#1', wrong: [7, 49], missed: [39, 61] }]);
  const s = Q.scoreReview(rv, merged); assert.strictEqual(s.items, 1); assert.strictEqual(s.precision.both, 1); assert.strictEqual(s.precision.single, 0); assert.ok(Math.abs(s.recall - 1 / 3) < 1e-9, 'one right tag, two missed');
  assert.deepStrictEqual(s.missedBy, { 39: 1, 61: 1 });
});

test('summary counts tags by heuristic and weak ones', () => {
  const s = Q.summary([{ tags: [{ id: 1, weak: false }, { id: 7, weak: true }] }, { tags: [{ id: 1, weak: false }] }, { tags: [] }], defs);
  assert.strictEqual(s.items, 3); assert.strictEqual(s.none, 1); assert.strictEqual(s.tags, 3); assert.strictEqual(s.weak, 1); assert.deepStrictEqual([s.rows[0].id, s.rows[0].n], [1, 2]);
});
