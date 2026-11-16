'use strict';
// Dipaka, the lamp (design: QUARRY - Dipaka Design in the vault). The author gathers facts in the Collection, presses Illuminate, and ONE paid model call tells them
// related, important things they did not ask because they did not know enough to ask. The answer is learning material for the author: it is kept beside the vault
// database in muse-dipaka.jsonl (append-only, like the marks file), never enters the burr store, and is never written into the vault. v1 stops there: no approval
// stages. The author labels each answer so a month on there is evidence of what it was worth.
//
// Everything outside is passed in (the model, the LLM call, the price table), so tests use fakes. The database is never touched; only the one file given.
const fs = require('fs');

const PROMPT_VERSION = 'dip-v2';   // v1 reused the research-session wording ("you have answered my questions"), which means nothing in a cold call
const LABELS = ['yielded', 'generic', 'already-knew', 'wrong'];
const INTRO = 'I write quiz questions and keep a large personal vault of notes. Below are facts taken from my notes, each with the passage it came from and the note it is in. Where I wrote a line between two facts, it is my own thought or question about how they connect; I have not found the answers.';
const QUESTION = 'Please do two things.\n\nFirst, answer the questions and curiosities I wrote between the facts, as far as you reliably can, and say plainly where you are unsure.\n\nSecond, there are questions I have not asked because I don’t know enough to ask them. Tell me things that are related and important but that I didn’t ask because I don’t know enough to ask them. Name the specific people, places, substances, dates or terms I could look up to follow each one, and do not just repeat what the facts already say.\n\nDo not write quiz questions; I will write those myself.';
const SYSTEM = 'You are a careful, widely read guide for one reader: an author who writes quiz questions and keeps notes. The facts below come from the reader’s own notes. Be concrete. Say plainly when you are unsure or when something is contested, and never invent a quotation, a source or a date.';
const MAX_FACTS = 20, MAX_PACKET = 30000, EXPECTED_OUT_TOKENS = 2500, MAX_OUT_TOKENS = 4000;

class DipakaError extends Error { constructor(msg, status) { super(msg); this.name = 'DipakaError'; this.userError = true; this.status = status || 400; } }
// A quote is a slice of a note, so it can carry Markdown litter (list dashes, bold, headings, wikilink brackets). The model should read plain words.
const plain = s => String(s == null ? '' : s).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || a).replace(/\*\*|__|==|`/g, '').replace(/^\s*(?:[-*+]|#{1,6}|\d+\.)\s+/gm, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// Pure. facts: [{ claim, quote, note }] in the order gathered; lines: link text between neighbour i and i+1 (or '').
function buildPacket(facts, lines) {
  const out = [INTRO, '', 'The facts:', ''];
  facts.forEach((f, i) => {
    out.push((i + 1) + '. ' + clip(plain(f.claim), 400));
    out.push('   From my note “' + clip(plain(f.note), 120) + '”' + (f.quote ? ': “' + clip(plain(f.quote), 500) + '”' : '.'));
    if (lines && lines[i]) out.push('   My own thought about how this links to the next fact: ' + clip(lines[i], 200));
  });
  out.push('', QUESTION);
  return out.join('\n');
}

const startOfDay = now => { const d = new Date(now()); d.setHours(0, 0, 0, 0); return d.getTime(); };

function createDipaka({ file, model, callLLM, hasKey, priceFor, resolveModel = null, now = Date.now, config = {} }) {
  const profile = config.profile || 'economy', choices = config.providers || ['claude', 'gemini', 'grok'], provider = choices.includes(config.provider) ? config.provider : choices[0], cap = config.maxUsdPerDay == null ? 3 : config.maxUsdPerDay, threads = new Map();
  const apply = ev => {
    if (!ev || !ev.id) return;
    if (ev.kind === 'thread') threads.set(ev.id, Object.assign({ label: null }, ev));
    else if (ev.kind === 'label' && threads.has(ev.id)) threads.get(ev.id).label = LABELS.includes(ev.label) ? ev.label : null;
  };
  if (file && fs.existsSync(file)) fs.readFileSync(file, 'utf8').split('\n').forEach(l => { if (!l.trim()) return; try { apply(JSON.parse(l)); } catch (e) { /* a torn line is skipped */ } });
  const append = ev => { if (file) fs.appendFileSync(file, JSON.stringify(ev) + '\n'); apply(ev); return ev; };
  const spentToday = () => { const t0 = startOfDay(now); let s = 0; threads.forEach(t => { if (Date.parse(t.ts) >= t0) s += t.cost || 0; }); return s; };
  const pick = p => { if (p == null || p === '') return provider; if (!choices.includes(p)) throw new DipakaError('Unknown provider. Choose one of: ' + choices.join(', ') + '.'); return p; };
  const rate = (pv, m, tokIn) => (priceFor && priceFor(pv, m || null, tokIn)) || { in: 0, out: 0 };
  const estimate = (packet, pv, modelId) => { const tokensIn = Math.ceil(String(packet).length / 4), r = rate(pv, modelId || null, tokensIn); return { tokensIn, usd: (tokensIn * r.in + EXPECTED_OUT_TOKENS * r.out) / 1e6 }; };

  return {
    PROMPT_VERSION, LABELS, provider, providers: () => choices.map(id => ({ id, key: !!hasKey(id) })),
    // The packet for the facts in the Collection, built from the database (not from what the browser says the facts are), plus what it would cost.
    preview({ ids, links, provider: want }) {
      const pv = pick(want);
      if (!Array.isArray(ids) || !ids.length) throw new DipakaError('Collect some facts first. Dipaka works on the facts in your Collection.');
      if (ids.length > MAX_FACTS || !ids.every(Number.isInteger) || new Set(ids).size !== ids.length) throw new DipakaError('A thread can hold up to ' + MAX_FACTS + ' different facts.');
      const facts = [], missing = [], lines = [];
      ids.forEach((id, i) => { const f = model.burrInfo(id); if (!f) { missing.push(id); return; } facts.push(f); const nxt = ids[i + 1]; lines.push(links && nxt != null ? String(links[id + '>' + nxt] || '') : ''); });
      if (!facts.length) throw new DipakaError('None of those facts are in this database.');
      const packet = buildPacket(facts, lines), est = estimate(packet, pv);
      return { packet, facts: facts.length, missing, estimate: est, provider: pv, providers: this.providers(), promptVersion: PROMPT_VERSION, key: !!hasKey(pv), spentToday: spentToday(), cap };
    },
    // The same as preview, plus the model this provider would use right now (from llm-model-resolver, as a real call resolves it) and the estimate priced for that model.
    async previewResolved(args) {
      const r = this.preview(args); r.model = null;
      r.profile = profile;
      if (resolveModel && r.key) { try { r.model = await resolveModel(r.provider, { profile }); } catch (e) { r.model = null; } }
      if (r.model && r.model.id) r.estimate = estimate(r.packet, r.provider, r.model.id);
      return r;
    },
    // One paid call. `packet` is the text the author saw and possibly edited; `seeds` are the fact ids it was built from (kept so the thread can be traced back).
    async run({ packet, seeds, provider: want }) {
      const pv = pick(want);
      if (typeof packet !== 'string' || packet.trim().length < 20) throw new DipakaError('There is nothing to send.');
      if (packet.length > MAX_PACKET) throw new DipakaError('The packet is too long (' + packet.length + ' characters; the limit is ' + MAX_PACKET + ').');
      if (!hasKey(pv)) throw new DipakaError('No ' + pv + ' key is set on this machine, so Dipaka cannot run with it. Choose another provider.', 503);
      const est = estimate(packet, pv), spent = spentToday();
      if (spent + est.usd > cap) throw new DipakaError('Today’s Dipaka budget ($' + cap.toFixed(2) + ') would be exceeded: $' + spent.toFixed(2) + ' spent, this run about $' + est.usd.toFixed(2) + '.', 429);
      const r = await callLLM(pv, packet, { system: SYSTEM, maxTokens: MAX_OUT_TOKENS, profile, label: 'dipaka' });
      const text = String((r && r.text) || '').trim();
      if (!text) throw new DipakaError('The model sent back nothing. Nothing was kept; you can try again.', 502);
      const rt = rate(pv, r.model, r.tokensIn || 0), cost = ((r.tokensIn || 0) * rt.in + (r.tokensOut || 0) * rt.out) / 1e6;
      const id = 'd' + now().toString(36) + Math.random().toString(36).slice(2, 6);
      append({ kind: 'thread', id, ts: new Date(now()).toISOString(), promptVersion: PROMPT_VERSION, provider: pv, profile, model: r.model || null, seeds: Array.isArray(seeds) ? seeds.filter(Number.isInteger).slice(0, MAX_FACTS) : [],
        packet, response: text, tokensIn: r.tokensIn || 0, tokensOut: r.tokensOut || 0, cost });
      return threads.get(id);
    },
    label(id, label) {
      if (!threads.has(id)) throw new DipakaError('No such thread.', 404);
      if (!LABELS.includes(label) && label !== 'clear') throw new DipakaError('Unknown label.');
      append({ kind: 'label', id, label: label === 'clear' ? null : label, ts: new Date(now()).toISOString() });
      return threads.get(id);
    },
    list: (limit = 20) => Array.from(threads.values()).sort((a, b) => b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0).slice(0, limit),
    spentToday, counts: () => ({ threads: threads.size, spent: Array.from(threads.values()).reduce((s, t) => s + (t.cost || 0), 0) })
  };
}
module.exports = { createDipaka, buildPacket, DipakaError, PROMPT_VERSION, LABELS, INTRO, QUESTION, MAX_FACTS, MAX_PACKET };
