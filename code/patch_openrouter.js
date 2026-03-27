#!/usr/bin/env node
/**
 * Patches callOpenRouter in tagger.js to use live free models only.
 * Run once: node patch_openrouter.js
 */
const fs   = require('fs');
const home = process.env.HOME || '/data/data/com.termux/files/home';
const file = home + '/quarry/code/tagger.js';

let code = fs.readFileSync(file, 'utf8');

// New simplified callOpenRouter using live free models 
const newFn = `async function callOpenRouter(prompt) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not set');

  let lastErr = null;
  _orModelIdx = 0; // reset index for this call

  for (var attempt = 0; attempt < 12; attempt++) {   // reasonable max attempts
    const model = await getNextOrModel();

    try {
      log('info', 'OpenRouter trying model', { model });

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
        log('warn', 'OpenRouter rate-limited, trying next', { model });
        lastErr = new Error('rate-limited: ' + model);
        continue;
      }
      if (res.status !== 200) {
        log('warn', 'OpenRouter error, trying next', { model, status: res.status });
        lastErr = new Error('OpenRouter error ' + res.status);
        continue;
      }

      const choice = (res.body.choices || [])[0];
      if (!choice || !choice.message || !choice.message.content) {
        log('warn', 'OpenRouter empty response, trying next', { model });
        lastErr = new Error('empty response from ' + model);
        continue;
      }

      const text  = choice.message.content;
      const usage = res.body.usage || {};
      log('info', 'OpenRouter success', { model });
      return { 
        text: text, 
        tokensIn: usage.prompt_tokens || 0, 
        tokensOut: usage.completion_tokens || 0, 
        provider: 'openrouter' 
      };

    } catch (e) {
      log('warn', 'OpenRouter attempt failed', { model, err: e.message });
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


console.log('   → Uses live free models from fetchOrFreeModels()');
console.log('   → Simple round-robin');