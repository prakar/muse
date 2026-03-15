#!/usr/bin/env node
/**
 * Patches callOpenRouter in tagger.js with retry-on-rate-limit logic.
 * Run once: node patch_openrouter.js
 */
const fs   = require('fs');
const home = process.env.HOME || '/data/data/com.termux/files/home';
const file = home + '/quarry/code/tagger.js';

let code = fs.readFileSync(file, 'utf8');

const newFn = `async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  const triedModels = new Set();
  let lastErr = null;

  for (var attempt = 0; attempt < OR_PREFERRED.length; attempt++) {
    // Pick next untried model from preference list
    var model = null;
    for (var i = 0; i < OR_PREFERRED.length; i++) {
      if (!triedModels.has(OR_PREFERRED[i])) { model = OR_PREFERRED[i]; break; }
    }
    if (!model) break;
    triedModels.add(model);
    _orModelCache = model;

    try {
      const res = await httpPost(
        'openrouter.ai',
        '/api/v1/chat/completions',
        { 'Authorization': 'Bearer ' + OPENROUTER_API_KEY },
        {
          model:      model,
          messages:   [
            { role: 'system', content: S3_SYSTEM },
            { role: 'user',   content: prompt }
          ],
          max_tokens: 8192
        }
      );

      if (res.status === 429) {
        log('warn', 'OpenRouter rate-limited, trying next', { model: model });
        _orModelCache = null;
        lastErr = new Error('rate-limited: ' + model);
        continue;
      }
      if (res.status !== 200) {
        log('warn', 'OpenRouter error, trying next', { model: model, status: res.status });
        _orModelCache = null;
        lastErr = new Error('OpenRouter error ' + res.status);
        continue;
      }

      var choice = (res.body.choices || [])[0];
      if (!choice || !choice.message || !choice.message.content) {
        log('warn', 'OpenRouter empty response, trying next', { model: model });
        _orModelCache = null;
        lastErr = new Error('empty response from ' + model);
        continue;
      }

      const text  = choice.message.content;
      const usage = res.body.usage || {};
      log('info', 'OpenRouter success', { model: model });
      return { text: text, tokensIn: usage.prompt_tokens || 0, tokensOut: usage.completion_tokens || 0, provider: 'openrouter' };

    } catch (e) {
      log('warn', 'OpenRouter attempt failed', { model: model, err: e.message });
      _orModelCache = null;
      lastErr = e;
    }
  }

  throw lastErr || new Error('All OpenRouter models exhausted');
}`;

// Find and replace the callOpenRouter function
const startMarker = 'async function callOpenRouter(prompt)';
const endMarker   = '\nasync function callGemini(prompt)';

const start = code.indexOf(startMarker);
const end   = code.indexOf(endMarker, start);

if (start === -1) {
  console.error('callOpenRouter not found in file');
  process.exit(1);
}
if (end === -1) {
  console.error('callGemini boundary not found');
  process.exit(1);
}

code = code.slice(0, start) + newFn + '\n' + code.slice(end);
fs.writeFileSync(file, code);

// Verify
console.log('Patched OK');
console.log('triedModels present:', code.includes('triedModels'));
console.log('retry loop present:', code.includes('trying next'));
console.log('callGemini still present:', code.includes('async function callGemini'));