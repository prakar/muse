'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { grokBilledOutput } = require('../code/lib/llm');

// Real usage block from a grok-build-0.1 extraction call (24 Oct 2026): completion_tokens excludes reasoning.
test('grok: reasoning tokens are billed as output (total_tokens - prompt_tokens)', () => {
  const u = { prompt_tokens: 2607, completion_tokens: 1884, total_tokens: 2607 + 1884 + 10540, completion_tokens_details: { reasoning_tokens: 10540 } };
  assert.strictEqual(grokBilledOutput(u), 12424);
});

test('grok: if completion_tokens already includes reasoning, nothing is double-counted', () => {
  const u = { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600, completion_tokens_details: { reasoning_tokens: 400 } };
  assert.strictEqual(grokBilledOutput(u), 500);
});

test('grok: without total_tokens, completion + reasoning is used; plain models are unchanged', () => {
  assert.strictEqual(grokBilledOutput({ prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } }), 80);
  assert.strictEqual(grokBilledOutput({ prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 }), 50);
  assert.strictEqual(grokBilledOutput({}), 0);
  assert.strictEqual(grokBilledOutput(undefined), 0);
});
