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

// The resolver's profile is process-wide, so llm.js serialises resolves and sets the profile explicitly before each one.
test('resolver profiles: a call can ask for flagship; the next call goes back to the default; overlapping calls never see each other’s profile', async () => {
  const L = require('../code/lib/llm'), seen = []; let current = 'economy';
  L.setResolver({ useProfile: n => { current = n; }, resolveModel: async () => { await new Promise(r => setTimeout(r, 5)); seen.push(current); return { id: current + '-model', source: 'live' }; }, markModelBad() {} });
  const saved = { a: process.env.ANTHROPIC_API_KEY, x: process.env.XAI_API_KEY, p: process.env.LLM_MODEL_RESOLVER_PROFILE };
  process.env.ANTHROPIC_API_KEY = 'k'; delete process.env.XAI_API_KEY; process.env.LLM_MODEL_RESOLVER_PROFILE = 'economy';
  try {
    const out = await Promise.all([L.modelFor('claude'), L.modelFor('claude', { profile: 'flagship' }), L.modelFor('claude'), L.modelFor('claude', { profile: 'flagship' })]);
    assert.deepEqual(out.map(x => x.id), ['economy-model', 'flagship-model', 'economy-model', 'flagship-model']);
    assert.deepEqual(seen, ['economy', 'flagship', 'economy', 'flagship']);
    assert.equal(await L.modelFor('grok'), null, 'no key for that provider: nothing resolved');
  } finally {
    L.setResolver(require('llm-model-resolver'));
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['XAI_API_KEY', saved.x], ['LLM_MODEL_RESOLVER_PROFILE', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
