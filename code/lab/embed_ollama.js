'use strict';
// Embedding backend for sim.js using a local Ollama server (POST /api/embed).
// Models under test (E2): embeddinggemma, qwen3-embedding:0.6b, bge-m3.  Pull first: `ollama pull <model>`.
const DEFAULT_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

function ollamaBackend(model, opts) {
  const url = ((opts && opts.url) || DEFAULT_URL).replace(/\/$/, '');
  const timeoutMs = (opts && opts.timeoutMs) || 120000;
  return {
    name: model,
    embed: async function (texts) {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(url + '/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model, input: texts }), signal: ctl.signal });
      } catch (e) { throw new Error('ollama unreachable at ' + url + ' (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')'); }
      finally { clearTimeout(t); }
      if (!res.ok) { const body = await res.text().catch(() => ''); throw new Error('ollama ' + res.status + ' for ' + model + ': ' + body.slice(0, 200)); }
      const j = await res.json();
      if (!j.embeddings || j.embeddings.length !== texts.length) throw new Error('ollama returned ' + (j.embeddings ? j.embeddings.length : 0) + ' vectors for ' + texts.length + ' inputs');
      return j.embeddings;
    }
  };
}
module.exports = { ollamaBackend, DEFAULT_URL };
