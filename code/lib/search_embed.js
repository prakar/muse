'use strict';
// Embeddings for search: the model-card prompt formats, an Ollama client, and a circuit breaker so a dead server costs one timeout, not one per keystroke.
// The client takes a fetch function, so tests never touch the network.

// Prompt formats from the model cards. A query and a document are embedded differently; unknown models get raw text.
const PROMPTS = {
  embeddinggemma: { query: q => 'task: search result | query: ' + q, doc: (c, t) => 'title: ' + (t || 'none') + ' | text: ' + c },
  'qwen3-embedding': { query: q => 'Instruct: Given a question, retrieve facts from a personal knowledge base that answer it\nQuery:' + q, doc: c => c }
};
function promptsFor(model) { const k = Object.keys(PROMPTS).find(m => String(model).startsWith(m)); return k ? PROMPTS[k] : { query: q => q, doc: c => c }; }

// The exact text a burr is embedded as. The build script and the running app must agree on it, or every vector would read as out of date.
const docText = (model, b) => promptsFor(model).doc(b.claim, b.note);

// A breaker opens after `threshold` failures in a row and stays open for `coolMs`; the next call after that is a trial. `now` is injectable for tests.
function createBreaker({ threshold = 3, coolMs = 60000, now = Date.now } = {}) {
  let fails = 0, openedAt = 0;
  return {
    isOpen: () => fails >= threshold && now() - openedAt < coolMs,
    async run(fn) {
      if (fails >= threshold && now() - openedAt < coolMs) throw new Error('paused after repeated failures; retrying shortly');
      try { const r = await fn(); fails = 0; return r; }
      catch (e) { fails++; if (fails >= threshold) openedAt = now(); throw e; }
    },
    state: () => ({ fails, open: fails >= threshold && now() - openedAt < coolMs })
  };
}

// Ollama /api/embed. embed(texts) -> array of number arrays, one per text. Throws a plain-language Error when the server is unreachable.
function ollamaEmbedder({ url = 'http://127.0.0.1:11434', model = 'embeddinggemma', timeoutMs = 20000, fetchFn = globalThis.fetch, breaker = createBreaker() } = {}) {
  const base = String(url).replace(/\/$/, '');
  return {
    model, url: base, breaker,
    async embed(texts) {
      return breaker.run(async function () {
        const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
        let res;
        try { res = await fetchFn(base + '/api/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: texts }), signal: ctl.signal }); }
        catch (e) { throw new Error('embedding server unreachable at ' + base + ' (' + (e.name === 'AbortError' ? 'timeout' : e.message) + ')'); }
        finally { clearTimeout(t); }
        if (!res.ok) throw new Error('embedding server answered ' + res.status);
        const j = await res.json();
        if (!j.embeddings || j.embeddings.length !== texts.length) throw new Error('embedding server returned ' + (j.embeddings ? j.embeddings.length : 0) + ' vectors for ' + texts.length + ' texts');
        return j.embeddings;
      });
    }
  };
}

module.exports = { PROMPTS, promptsFor, docText, createBreaker, ollamaEmbedder };
