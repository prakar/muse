const test = require('node:test');
const assert = require('node:assert');
const R = require('../code/lab/query_rewrite');

test('buildPrompt carries the question and asks for concrete terms, idiom meanings and search terms', () => {
  const p = R.buildPrompt('  Is Elon Musk on the spectrum  ');
  assert.ok(p.includes('"Is Elon Musk on the spectrum"'));
  assert.ok(/idiom/.test(p) && /Terms:/.test(p) && /premise/.test(p));
});

test('cleanRewrite strips fences and labels, collapses whitespace, caps length', () => {
  assert.strictEqual(R.cleanRewrite('```text\nWindcatchers cool\nhouses.\n```'), 'Windcatchers cool houses.');
  assert.strictEqual(R.cleanRewrite('Here is the passage:\nA badgir is a wind tower.'), 'A badgir is a wind tower.');
  assert.strictEqual(R.cleanRewrite(null), '');
  assert.strictEqual(R.cleanRewrite('x'.repeat(2000)).length, 900);
});
