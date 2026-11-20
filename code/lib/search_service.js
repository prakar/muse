'use strict';
// The search service: one question in, a banded, grouped, evidence-first answer out. It composes the pieces and owns the degradation ladder:
//   hybrid (question + rewrite by meaning, plus words)  ->  meaning of the question alone + words  ->  words only.
// Every rung that is skipped says why in `notices`, in plain language; nothing degrades silently. The confidence band comes from the REWRITE leg's best
// similarity only (that is what it was calibrated on); without a rewrite the band is 'unrated'.
const Core = require('./search_core');
const Cache = require('./search_cache');
const E = require('./search_embed');

const MAX_Q = 300;
const bad = msg => Object.assign(new Error(msg), { code: 'bad_request' });

// burrs: [{ id, noteId, claim, quote, note }]. words: buildWordIndex(burrs). vectors: search_vectors.load(...) or null.
// embedder: { model, embed(texts) } or null. rewriter: createRewriter(...) or null. cache: search_cache handle or null.
function createSearchService({ burrs, words, vectors = null, embedder = null, rewriter = null, cache = null, config = {} }) {
  const bands = config.bands || Core.BANDS, perNote = config.perNote || 2, topK = config.topK || 10, pool = config.pool || 80, pageSize = config.pageSize || 12, wordMax = config.wordMax || Math.max(burrs.length, pool);
  const byId = new Map(burrs.map(b => [b.id, b]));
  const prompts = E.promptsFor(embedder ? embedder.model : '');

  async function vec(text, kind) {                         // cached embedding of a query-side text; kind 'query' | 'doc'
    const key = Cache.vecKey(text, kind, embedder.model), hit = cache && cache.getVec(key);
    if (hit) return hit;
    const v = (await embedder.embed([kind === 'query' ? prompts.query(text) : prompts.doc(text, null)]))[0];
    if (cache) cache.putVec(key, embedder.model, v);
    return v;
  }

  async function search({ q, meaning = true, page = 1, size = 0 }) {
    q = String(q || '').trim();
    if (!q) throw bad('type a question first');
    if (q.length > MAX_Q) throw bad('questions are limited to ' + MAX_Q + ' characters');
    const notices = [], lists = [], wordAll = words.search(q, wordMax).map(h => h.id), wordHits = wordAll.slice(0, pool), wordSet = new Set(wordAll);   // wordHits (the best 80) feed the fusion; wordAll is every word match, for paging
    let rwTop = null, mode = 'words', band = null, understoodAs = null, rewriteSims = new Map(), meaningSet = new Set(), cost = 0, cachedRewrite = null;

    if (!meaning) notices.push({ kind: 'info', text: 'Search by meaning is off: matching the words you typed.' });
    else if (!embedder || !vectors) notices.push({ kind: 'warn', text: !embedder ? 'No embedding server is configured, so this search used words only.' : 'The meaning index has not been built yet (run: node code/search_build.js), so this search used words only.' });
    else {
      let plain = null, rw = null;
      try { plain = vectors.nearest(await vec(q, 'query'), pool); mode = 'question'; }
      catch (e) { notices.push({ kind: 'warn', text: 'Search by meaning is unavailable (' + e.message + '). Showing word matches only.' }); }
      if (plain) {
        if (rewriter && rewriter.available()) {
          try {
            const r = await rewriter.rewrite(q); understoodAs = r.text; cost = r.cost; cachedRewrite = r.cached;
            rw = vectors.nearest(await vec(r.text, 'doc'), pool); mode = 'hybrid';
          } catch (e) { notices.push({ kind: 'warn', text: 'The question could not be rewritten (' + e.message + '). Matching by the question alone, so there is no confidence rating.' }); }
        } else notices.push({ kind: 'warn', text: 'The AI rewrite step is not available, so matching uses the question alone and there is no confidence rating.' });
        if (rw && rw.length) rwTop = rw[0];
        if (rw) rw.forEach(h => rewriteSims.set(h.id, h.sim));
        [plain, rw].forEach(l => { if (l) { lists.push(l.map(h => h.id)); l.forEach(h => meaningSet.add(h.id)); } });
        band = rw && rw.length ? Core.bandOf(rw[0].sim, bands) : 'unrated';
      }
    }
    lists.push(wordHits);
    let ids, paged = false, total = 0, pages = 1, pg = 1, sz = Math.min(100, Math.max(1, parseInt(size, 10) || pageSize));
    if (mode === 'words') {
      // Words only: every match, best first, at most perNote from each note, in pages. (Meaning search keeps its short ranked list: similarity tails off, so a page 9 would mean little.)
      const all = Core.groupByNote(wordAll, id => byId.get(id).noteId, perNote, Infinity);
      total = all.length; pages = Math.max(1, Math.ceil(total / sz)); pg = Math.min(Math.max(1, parseInt(page, 10) || 1), pages); ids = all.slice((pg - 1) * sz, pg * sz); paged = true;
    } else {
      const fused = Core.rrf(lists.filter(l => l.length), pool);
      ids = Core.groupByNote(fused, id => byId.get(id).noteId, perNote, topK);
      // The confidence band is about ONE fact, the closest to the rewritten question. Put it first so the banner and the first result always agree.
      if (rwTop) ids = [rwTop.id].concat(ids.filter(x => x !== rwTop.id)).slice(0, topK);
    }
    const results = ids.map(function (id) {
      const b = byId.get(id);
      return { burrId: id, noteId: b.noteId, claim: b.claim, quote: b.quote || null, note: b.note || null, basis: !!rwTop && rwTop.id === id, via: { words: wordSet.has(id), meaning: meaningSet.has(id) }, sim: rewriteSims.has(id) ? Math.round(rewriteSims.get(id) * 1000) / 1000 : null };
    });
    if (!results.length) notices.push({ kind: 'info', text: 'No notes matched.' });
    else if (!paged && results.length >= topK) notices.push({ kind: 'info', text: 'Showing the closest ' + topK + ' by meaning. Turn search by meaning off to page through every word match.' });
    return { q, mode, band, bandText: band && Core.BAND_TEXT[band] || null, folded: band === 'nothing', understoodAs, bestSim: rwTop ? Math.round(rwTop.sim * 1000) / 1000 : null, cachedRewrite, cost, notices, results, paged, page: pg, pages, size: sz, total: paged ? total : results.length, counts: { burrs: burrs.length, vectors: vectors ? vectors.count : 0 } };
  }

  function status() {
    const c = cache ? cache.counts() : null;
    return { burrs: burrs.length, meaning: { ready: !!(embedder && vectors), vectors: vectors ? vectors.count : 0, stale: vectors ? vectors.stale : 0, gone: vectors ? vectors.gone : 0, built: vectors ? vectors.built : null,
      model: embedder ? embedder.model : null, serverPaused: embedder && embedder.breaker ? embedder.breaker.state().open : false },
      rewrite: { available: !!(rewriter && rewriter.available()), provider: rewriter ? rewriter.provider : null, promptVersion: rewriter ? rewriter.PROMPT_VERSION : null }, cache: c, bands };
  }
  return { search, status, MAX_Q };
}

module.exports = { MAX_Q, createSearchService };
