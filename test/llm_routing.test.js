'use strict';
// A standing decision (see CLAUDE.md, "LLM calls"): every LLM call goes through code/lib/llm.js, and llm.js chooses the model with llm-model-resolver, the utility built
// for exactly this. These tests fail if a new path around it appears: a direct call to a provider, an adapter that skips the resolver, a hard-coded model name, or a
// dependency that has gone missing. A lab bake-off may pin an exact model only because comparing named models is its whole purpose, and only from a command-line flag.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const CODE = path.join(__dirname, '..', 'code');
const walk = (d, o = []) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'data'].includes(f.name)) continue; const p = path.join(d, f.name); f.isDirectory() ? walk(p, o) : /\.(js|mjs)$/.test(f.name) && o.push(p); } return o; };
const rel = f => path.relative(CODE, f).split(path.sep).join('/');
const FILES = walk(CODE).map(f => ({ rel: rel(f), src: fs.readFileSync(f, 'utf8') }));
// The text of a call's argument list: from just after its opening parenthesis to the matching close (so reading r.model from the answer is not mistaken for passing one).
const args = (s, i) => { let d = 1, j = i; for (; j < s.length && d > 0; j++) { if (s[j] === '(') d++; else if (s[j] === ')') d--; } return s.slice(i, j); };
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

test('only lib/llm.js talks to a model provider', () => {
  const hosts = /api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.x\.ai|openrouter\.ai|api\.openai\.com|@anthropic-ai\/sdk|@google\/generative-ai|openai['"]\)/;
  const bad = FILES.filter(f => f.rel !== 'lib/llm.js' && hosts.test(code(f.src))).map(f => f.rel);
  assert.deepEqual(bad, [], 'these files reach a provider directly; use callLLM from lib/llm.js');
});

test('every adapter in lib/llm.js chooses its model through llm-model-resolver', () => {
  const src = FILES.find(f => f.rel === 'lib/llm.js').src, adapters = [...src.matchAll(/async function (call(?:Claude|Gemini|Grok|OpenRouter))\b[\s\S]*?\n}\n/g)];
  assert.ok(adapters.length >= 4, 'found the provider adapters');
  adapters.forEach(m => assert.match(m[0], /withResolvedModel\(|getNextFreeModel\(|resolver\.resolveModel\(/, m[1] + ' must resolve its model through llm-model-resolver'));
  assert.match(src, /resolver\.resolveModel\(/); assert.match(src, /require\('llm-model-resolver'\)/);
});

test('no model is named in code outside the resolver’s pinned fallbacks, the price table and the lab', () => {
  const NAME = /['"`](?:claude-(?:opus|sonnet|haiku)[\w.-]*|gemini-\d[\w.-]*|grok-\d[\w.-]*)['"`]/;
  const allowed = new Set(['lib/llm.js', 'lib/budget.js']);
  const bad = FILES.filter(f => !allowed.has(f.rel) && !f.rel.startsWith('lab/') && NAME.test(code(f.src))).map(f => f.rel);
  assert.deepEqual(bad, [], 'a model name is hard-coded here; let llm-model-resolver choose it');
});

test('only the lab bake-offs may pin a model, and only from a command-line flag', () => {
  const ALLOWED = new Set(['lab/nug_bakeoff.js', 'lab/quiz_backtest.js']), pinned = [];
  FILES.forEach(f => { if (f.rel === 'lib/llm.js') return; const s = code(f.src);
    for (const m of s.matchAll(/callLLM\(/g)) { if (/\bmodel\s*:/.test(args(s, m.index + m[0].length))) { pinned.push(f.rel); break; } } });
  assert.deepEqual(pinned.filter(r => !ALLOWED.has(r)), [], 'passing model: to callLLM bypasses the resolver');
  pinned.forEach(r => assert.match(FILES.find(f => f.rel === r).src, /arg\('model'/, r + ' must take its pinned model from --model'));
});

test('llm-model-resolver is a declared dependency and is installed', () => {
  const pkg = require('../package.json'); assert.ok(pkg.dependencies && pkg.dependencies['llm-model-resolver'], 'llm-model-resolver must be in dependencies');
  assert.doesNotThrow(() => require.resolve('llm-model-resolver'));
});
