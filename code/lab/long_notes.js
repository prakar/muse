#!/usr/bin/env node
'use strict';
// Long-note lab: what does nug-v6 never see? The extractor reads only the first MAX_BODY_CHARS (6,000) of a note, so the
// tail of a long note yields no burrs. This lab runs the SAME prompt over successive windows of the largest notes and
// compares head against tail: burrs per 1,000 characters, rejection rate, and how many burrs join other notes by a handle.
// Writes lab output only (code/lab/out/<version>/long_notes*.json[l]); never vault.db, never the vault.
//   node code/lab/long_notes.js --db eval.db --dry-run --top 10                  list the notes and estimate the cost
//   node code/lab/long_notes.js --db eval.db --top 10 --max-usd 1                run it (resumable: responses are cached)
//   node code/lab/long_notes.js --db eval.db --notes 6145,4414 --limit-windows 6  a quick trial
//   --remap /Users/me/vault=/mnt/vault   rewrite the start of every note path (dry runs on another machine)
const fs = require('node:fs'), path = require('node:path');
const B = require('../lib/burrs'), Bud = require('../lib/budget'), BR = require('../lib/bristles'), D = require('./data');

const OUT = path.join(__dirname, 'out');
const EST_PROMPT_TOKENS = 700;     // fixed instructions and example (same figure as nuggetizer.js)
const EST_OUT_TOKENS = 1900;       // a full window of 14 burrs

// ---------- pure ----------

// Raw body -> windows of at most maxChars, cut at blank lines, then lines, then sentence ends, then hard.
function windowsOf(rawBody, maxChars) {
  const parts = [];
  String(rawBody || '').split(/\n{2,}/).forEach(function (para) {
    if (para.length <= maxChars) return parts.push(para);
    String(para).split(/\n/).forEach(function (line) {
      if (line.length <= maxChars) return parts.push(line);
      line.split(/(?<=[.!?])\s+/).forEach(function (s) {
        for (let i = 0; i < s.length; i += maxChars) parts.push(s.slice(i, i + maxChars));
      });
    });
  });
  const out = []; let cur = '';
  parts.forEach(function (p) {
    if (cur && cur.length + p.length + 2 > maxChars) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + p : p;
  });
  if (cur) out.push(cur);
  return out;
}

function pickTop(db, n, ids) {
  if (ids && ids.length) return ids.map(function (id) { return db.prepare('SELECT id, filepath, title, source_url, word_count FROM vault_notes WHERE id=? AND COALESCE(quarry_exclude,0)=0').get(id); }).filter(Boolean);
  return db.prepare('SELECT id, filepath, title, source_url, word_count FROM vault_notes WHERE COALESCE(quarry_exclude,0)=0 ORDER BY word_count DESC, id ASC LIMIT ?').all(n);
}

// folded handle key -> Set of note ids, from the stored burrs (years skipped: they are slices, not handles)
function handleIndex(burrs) {
  const idx = new Map();
  burrs.forEach(function (b) { (b.hooks || []).forEach(function (h) {
    const k = BR.foldKey(h.value); if (!BR.usableKey(k) || BR.isYearKey(k)) return;
    if (!idx.has(k)) idx.set(k, new Set()); idx.get(k).add(b.note_id); }); });
  return idx;
}

// A burr "joins" if one of its handles is carried by 1 to 40 OTHER notes.
function joins(hooks, noteId, idx) {
  return (hooks || []).some(function (h) {
    const k = BR.foldKey(h.value); if (!BR.usableKey(k) || BR.isYearKey(k)) return false;
    const s = idx.get(k); if (!s) return false;
    const others = s.size - (s.has(noteId) ? 1 : 0);
    return others >= 1 && others <= 40;
  });
}

function estimate(notes, provider) {
  // The provider's default model decides the real rate (gemini-2.5-flash: $0.30 in / $2.50 out per M); priceFor(provider, null) is a dearer fallback.
  const rate = Bud.priceFor(provider, provider === 'gemini' ? 'gemini-2.5-flash' : null, 0);
  let windows = 0, tin = 0;
  notes.forEach(function (n) { windows += n.windows.length; n.windows.forEach(function (w) { tin += EST_PROMPT_TOKENS + w.length / 4; }); });
  const tout = windows * EST_OUT_TOKENS;
  return { windows: windows, tokensIn: Math.round(tin), tokensOut: tout, usd: rate ? (tin * rate.in + tout * rate.out) / 1e6 : null };
}

// rows: [{ note_id, title, k, chars, accepted, rejected, joined }] -> per note and overall, head (k = 1) against tail (k > 1)
function summarise(rows) {
  const by = new Map();
  rows.forEach(function (r) { if (!by.has(r.note_id)) by.set(r.note_id, { note_id: r.note_id, title: r.title, head: null, tail: { chars: 0, accepted: 0, rejected: 0, joined: 0, windows: 0 } }); });
  rows.forEach(function (r) {
    const e = by.get(r.note_id);
    if (r.k === 1) e.head = { chars: r.chars, accepted: r.accepted, rejected: r.rejected, joined: r.joined, windows: 1 };
    else { e.tail.chars += r.chars; e.tail.accepted += r.accepted; e.tail.rejected += r.rejected; e.tail.joined += r.joined; e.tail.windows++; }
  });
  const rate = function (n, d) { return d ? +(n / d).toFixed(3) : null; };
  const side = function (s) { return s ? { windows: s.windows, chars: s.chars, burrs: s.accepted, rejected: s.rejected, burrsPer1kChars: rate(s.accepted * 1000, s.chars), joinShare: rate(s.joined, s.accepted), rejectShare: rate(s.rejected, s.accepted + s.rejected) } : null; };
  const notes = Array.from(by.values()).map(function (e) { return { note_id: e.note_id, title: e.title, head: side(e.head), tail: side(e.tail.windows ? e.tail : null) }; });
  const sum = function (pick) { const t = { windows: 0, chars: 0, accepted: 0, rejected: 0, joined: 0 }; by.forEach(function (e) { const s = pick(e); if (s) Object.keys(t).forEach(function (k) { t[k] += s[k]; }); }); return t; };
  return { notes: notes, head: side(sum(function (e) { return e.head; })), tail: side(sum(function (e) { return e.tail.windows ? e.tail : null; })) };
}

// ---------- IO ----------

function loadCache(file) {
  const m = new Map();
  try { fs.readFileSync(file, 'utf8').split('\n').forEach(function (l) { if (!l) return; try { const r = JSON.parse(l); m.set(r.key, r); } catch (e) {} }); } catch (e) {}
  return m;
}

async function run(o, deps) {
  deps = deps || {};
  const db = deps.db || D.openCopy(o.db);
  const readFile = deps.readFile || function (p) { return fs.readFileSync(p, 'utf8'); };
  const outRoot = deps.outDir || OUT;
  const remap = function (p) { if (!o.remap) return p; const i = o.remap.indexOf('='); const from = o.remap.slice(0, i), to = o.remap.slice(i + 1); return p.startsWith(from) ? to + p.slice(from.length) : p; };
  const notes = pickTop(db, o.top, o.notes).map(function (n) {
    const raw = readFile(remap(n.filepath)), body = B.splitFrontmatter(raw).body;
    let ws = windowsOf(body, o.window).map(function (w) { return { raw: w, cleaned: B.cleanBody(w) }; }).filter(function (w) { return B.realWordCount(w.cleaned) >= 3; });
    if (o.limitWindows) ws = ws.slice(0, o.limitWindows);
    return Object.assign({}, n, { windows: ws.map(function (w) { return w.raw; }), cleaned: ws.map(function (w) { return w.cleaned; }) });
  });
  const est = estimate(notes, o.provider);
  console.log('Notes: ' + notes.length + ' | windows: ' + est.windows + ' | est. tokens in/out: ' + est.tokensIn + '/' + est.tokensOut + ' | est. cost ' + (est.usd == null ? 'unknown provider' : '$' + est.usd.toFixed(3)) + ' | provider ' + o.provider);
  notes.forEach(function (n) { console.log('  ' + String(n.id).padStart(5) + '  ' + String(n.word_count).padStart(7) + ' words  ' + String(n.windows.length).padStart(4) + ' windows  ' + String(n.title).slice(0, 70)); });
  if (est.usd != null && est.usd > o.maxUsd) console.log('Note: the estimate is above --max-usd ' + o.maxUsd + '; the run will stop at the cap and can be resumed (responses are cached).');
  if (o.dryRun) return { estimate: est, notes: notes.map(function (n) { return { id: n.id, windows: n.windows.length }; }) };

  const idx = handleIndex(D.loadBurrs(db, o.version));
  const outDir = path.join(outRoot, o.version); fs.mkdirSync(path.join(outRoot, 'cache'), { recursive: true }); fs.mkdirSync(outDir, { recursive: true });
  const cacheFile = path.join(outRoot, 'cache', 'long_notes.jsonl'), cache = loadCache(cacheFile);
  const ledger = function (r) { fs.appendFileSync(path.join(outRoot, 'spend.jsonl'), JSON.stringify(r) + '\n'); };
  const callLLM = deps.callLLM || require('../lib/llm').callLLM;
  const jobs = []; notes.forEach(function (n) { n.cleaned.forEach(function (c, i) { jobs.push({ note: n, k: i + 1, n: n.cleaned.length, cleaned: c }); }); });
  const rows = new Array(jobs.length); let spent = 0, next = 0, stopped = '';

  async function one(j, slot) {
    const pseudo = { id: j.note.id, title: j.note.title, source_url: j.note.source_url, cleaned: j.cleaned, real_words: B.realWordCount(j.cleaned) };
    const key = B.cacheKey(o.provider, B.buildInput(pseudo, j.cleaned) + '|long-notes');
    let hit = cache.get(key), cost = 0;
    if (!hit) {
      if (spent >= o.maxUsd) { stopped = 'budget cap $' + o.maxUsd + ' reached'; return; }
      const p = B.buildPrompt(pseudo, j.cleaned);
      const r = await callLLM(o.provider, p.prompt, { system: p.system, maxTokens: 8000, temperature: 0, thinkingBudget: 0, label: 'long-notes' });
      const rate = Bud.priceFor(o.provider, r.model, r.tokensIn || 0);
      cost = rate ? ((r.tokensIn || 0) * rate.in + (r.tokensOut || 0) * rate.out) / 1e6 : 0; spent += cost;
      hit = { key: key, text: r.text, model: r.model };
      const parsedNow = B.parseModelJson(r.text);
      if (parsedNow.ok) { cache.set(key, hit); fs.appendFileSync(cacheFile, JSON.stringify(hit) + '\n'); }
      ledger({ ts: new Date().toISOString(), task: 'long-notes', provider: o.provider, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cost: cost, id: j.note.id + '#' + j.k });
    }
    const parsed = B.parseModelJson(hit.text);
    if (!parsed.ok) { rows[slot] = { note_id: j.note.id, title: j.note.title, k: j.k, of: j.n, chars: j.cleaned.length, error: parsed.error, accepted: 0, rejected: 0, joined: 0, burrs: [], cost: cost }; return; }
    const v = B.verifyBurrs(parsed.burrs, pseudo);
    const burrs = v.accepted.map(function (b) { return { claim: b.claim, quote: b.quote, kind: b.kind, hooks: b.hooks, joins: joins(b.hooks, j.note.id, idx) }; });
    rows[slot] = { note_id: j.note.id, title: j.note.title, k: j.k, of: j.n, chars: j.cleaned.length, accepted: burrs.length, rejected: v.rejected.length, joined: burrs.filter(function (b) { return b.joins; }).length, burrs: burrs, cost: cost };
  }
  async function worker() { while (!stopped) { const slot = next++; if (slot >= jobs.length) return; try { await one(jobs[slot], slot); } catch (e) { stopped = 'stopped: ' + e.message; } } }
  await Promise.all(Array.from({ length: Math.max(1, o.parallel) }, worker));

  const done = rows.filter(Boolean);
  fs.writeFileSync(path.join(outDir, 'long_notes.jsonl'), done.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
  const s = summarise(done.filter(function (r) { return !r.error; }));
  fs.writeFileSync(path.join(outDir, 'long_notes_summary.json'), JSON.stringify(s, null, 2));
  console.log('Windows done: ' + done.length + '/' + jobs.length + (stopped ? ' (' + stopped + ')' : '') + ' | spent $' + spent.toFixed(4));
  console.log('HEAD (first window of each note): ' + JSON.stringify(s.head));
  console.log('TAIL (every later window):        ' + JSON.stringify(s.tail));
  console.log('Written to ' + outDir + '/long_notes.jsonl and long_notes_summary.json');
  return { summary: s, spent: spent, stopped: stopped };
}

function parseArgs(argv) {
  const a = argv, arg = function (n, d) { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  return { db: arg('db'), version: arg('version', D.DEFAULT_VERSION), top: +arg('top', 10), notes: arg('notes') ? arg('notes').split(',').map(Number) : null,
    window: +arg('window', 5500), provider: arg('provider', 'gemini'), maxUsd: +arg('max-usd', 1), parallel: +arg('parallel', 4),
    limitWindows: +arg('limit-windows', 0), remap: arg('remap', ''), dryRun: a.includes('--dry-run') };
}

module.exports = { windowsOf, pickTop, handleIndex, joins, estimate, summarise, run, parseArgs };
if (require.main === module) {
  const o = parseArgs(process.argv.slice(2));
  if (!o.db) { console.error('Usage: node code/lab/long_notes.js --db eval.db [--dry-run] [--top 10] [--notes 1,2] [--max-usd 1] [--parallel 4] [--limit-windows N] [--remap FROM=TO]'); process.exit(1); }
  run(o).catch(function (e) { console.error(e); process.exit(1); });
}
