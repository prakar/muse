#!/usr/bin/env node
'use strict';
/**
 * QUARRY muse_scratch.js — SCRATCH sniff test of the bristle + knot stage. Deterministic, no LLM, READ-ONLY.
 * Writes nothing to the DB or the vault; prints a report. Use it to see what the burrs can and cannot join on,
 * which tells us what nug-v5 must change.
 *
 *   node code/muse_scratch.js [--version nug-v4] [--seed 1] [--show 12] [--json out.json]
 *
 * Bristle sources: hooks the nuggetizer proposed ("hook"), years found in claim text ("year"),
 * and note titles found in claim text ("title", the vault-built entity dictionary).
 * Spark candidate: a key shared by 2-8 different notes. Knot candidate: a surface shared by 2-40 notes,
 * classed by context distance (TF-IDF cosine) and tag distance. All thresholds are guesses until the backtest.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const L = require('./lib/bristles');

const args = process.argv.slice(2);
const opt = function (k, d) { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const VERSION = opt('--version', 'nug-v4'), SEED = parseInt(opt('--seed', '1'), 10), SHOW = parseInt(opt('--show', '12'), 10);
const DB = process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db');

function rng(seed) { let a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(SEED);
function sample(arr, n) { const a = arr.slice(); const out = []; while (a.length && out.length < n) out.push(a.splice(Math.floor(rand() * a.length), 1)[0]); return out; }
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : 'n/a'; }
function short(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function hr(t) { console.log('\n=== ' + t + ' ==='); }

const db = new DatabaseSync(DB, { readOnly: true });
const burrs = db.prepare('SELECT b.id, b.note_id, b.claim, b.kind, b.hooks_json, b.loop_text, n.title FROM burrs b JOIN vault_notes n ON n.id=b.note_id WHERE b.prompt_version=? ORDER BY b.id').all(VERSION);
if (!burrs.length) { console.error('No burrs for ' + VERSION); process.exit(1); }
const noteTitle = new Map(), noteTags = new Map();
db.prepare('SELECT id,title FROM vault_notes').all().forEach(function (r) { noteTitle.set(r.id, r.title); });
db.prepare('SELECT note_id, tag_root FROM note_tags WHERE tag_root IS NOT NULL').all().forEach(function (r) {
  if (!noteTags.has(r.note_id)) noteTags.set(r.note_id, new Set()); noteTags.get(r.note_id).add(r.tag_root); });
const notesWithBurrs = new Set(burrs.map(function (b) { return b.note_id; }));
const NN = notesWithBurrs.size;

// entity dictionary from titles
const titleDict = new Map();
noteTitle.forEach(function (t, id) { const k = L.titleKey(t); if (k && !titleDict.has(k)) titleDict.set(k, id); });

// bristles
const tokensOf = new Map(), rankInNote = new Map(), perNoteCount = new Map();
burrs.forEach(function (b) { const c = (perNoteCount.get(b.note_id) || 0) + 1; perNoteCount.set(b.note_id, c); rankInNote.set(b.id, c); tokensOf.set(b.id, L.tokens(b.claim)); });
const bristles = new Map();   // burr id -> [{type,surface,key,src}]
burrs.forEach(function (b) {
  const own = L.titleKey(b.title), seen = new Set(), out = [];
  const add = function (type, surface, key, src) { if (!L.usableKey(key) || seen.has(key)) return; seen.add(key); out.push({ type: type, surface: surface, key: key, src: src }); };
  let hooks = []; try { hooks = JSON.parse(b.hooks_json || '[]'); } catch (e) {}
  hooks.forEach(function (h) { add(h.type, h.value, L.foldKey(h.value), 'hook'); });
  L.yearsIn(b.claim).forEach(function (y) { add('time', y, y, 'year'); });
  const t = tokensOf.get(b.id); let nTitle = 0;
  for (let n = 6; n >= 1 && nTitle < 4; n--) for (let i = 0; i + n <= t.length && nTitle < 4; i++) {
    const k = t.slice(i, i + n).join(' ');
    if (k !== own && titleDict.has(k) && !seen.has(k)) { add('title', k, k, 'title'); nTitle++; }
  }
  bristles.set(b.id, out);
});

// index
const index = new Map();   // key -> {burrs:[], notes:Set, types:Set}
burrs.forEach(function (b) { bristles.get(b.id).forEach(function (br) {
  let e = index.get(br.key); if (!e) { e = { burrs: [], notes: new Set(), types: new Set(), surface: br.surface }; index.set(br.key, e); }
  e.burrs.push(b.id); e.notes.add(b.note_id); e.types.add(br.type); }); });
const band = function (df) { return df === 1 ? 'single' : df <= 8 ? 'spark(2-8)' : df <= 40 ? 'mid(9-40)' : 'hub(>40)'; };
const burrById = new Map(burrs.map(function (b) { return [b.id, b]; }));

// ---------- 1. what bristles exist ----------
hr('1. Bristles: ' + burrs.length + ' burrs from ' + NN + ' notes (' + VERSION + ')');
const all = [].concat.apply([], burrs.map(function (b) { return bristles.get(b.id); }));
const bySrc = {}; all.forEach(function (x) { bySrc[x.src] = (bySrc[x.src] || 0) + 1; });
console.log('bristles per burr: ' + (all.length / burrs.length).toFixed(2) + ' | by source: ' + JSON.stringify(bySrc));
console.log('burrs with zero bristles: ' + pct(burrs.filter(function (b) { return !bristles.get(b.id).length; }).length, burrs.length));
console.log('\ntype            n    single  spark   mid    hub     (share of bristles whose key is shared by N notes)');
const byType = {};
all.forEach(function (x) { const e = index.get(x.key); const k = x.src === 'hook' ? 'hook:' + x.type : x.src; (byType[k] = byType[k] || { n: 0, single: 0, spark: 0, mid: 0, hub: 0 }); const o = byType[k]; o.n++; const b = band(e.notes.size); o[b === 'single' ? 'single' : b.startsWith('spark') ? 'spark' : b.startsWith('mid') ? 'mid' : 'hub']++; });
Object.keys(byType).sort(function (a, b) { return byType[b].n - byType[a].n; }).forEach(function (k) { const o = byType[k];
  console.log((k + '               ').slice(0, 16) + String(o.n).padStart(6) + '  ' + pct(o.single, o.n).padStart(6) + '  ' + pct(o.spark, o.n).padStart(6) + '  ' + pct(o.mid, o.n).padStart(6) + '  ' + pct(o.hub, o.n).padStart(6)); });

// ---------- 2. coverage ----------
hr('2. Coverage: how many burrs can join anything');
const joinable = function (b, lo, hi, srcSet) { return bristles.get(b.id).some(function (x) { if (srcSet && !srcSet.has(x.src)) return false; const df = index.get(x.key).notes.size; return df >= lo && df <= hi; }); };
[['hooks only', new Set(['hook'])], ['hooks + years', new Set(['hook', 'year'])], ['hooks + years + titles', new Set(['hook', 'year', 'title'])]].forEach(function (p) {
  console.log((p[0] + '                         ').slice(0, 26) + ' spark-range(2-8): ' + pct(burrs.filter(function (b) { return joinable(b, 2, 8, p[1]); }).length, burrs.length) +
    ' | any join(2-40): ' + pct(burrs.filter(function (b) { return joinable(b, 2, 40, p[1]); }).length, burrs.length)); });
console.log('\nBy position inside its note (does a bigger cap pay?)  share of burrs with an any-join(2-40):');
[[1, 2], [3, 5], [6, 8], [9, 12]].forEach(function (r) { const g = burrs.filter(function (b) { const k = rankInNote.get(b.id); return k >= r[0] && k <= r[1]; });
  console.log('  rank ' + r[0] + '-' + r[1] + ': ' + pct(g.filter(function (b) { return joinable(b, 2, 40); }).length, g.length) + '  (n=' + g.length + ')'); });
const capped = burrs.filter(function (b) { return perNoteCount.get(b.note_id) >= 10; }), uncapped = burrs.filter(function (b) { return perNoteCount.get(b.note_id) < 10; });
console.log('  notes at the cap (10 burrs): ' + pct(capped.filter(function (b) { return joinable(b, 2, 40); }).length, capped.length) + ' | notes under cap: ' + pct(uncapped.filter(function (b) { return joinable(b, 2, 40); }).length, uncapped.length));

// ---------- 3. sparks ----------
hr('3. Spark candidates (key shared by 2-8 notes)');
const sparks = [];
index.forEach(function (e, key) {
  const df = e.notes.size; if (df < 2 || df > 8) return;
  const perNote = new Map(); e.burrs.forEach(function (id) { const b = burrById.get(id); if (!perNote.has(b.note_id)) perNote.set(b.note_id, b); });
  const bs = Array.from(perNote.values()), ids = bs.map(function (b) { return b.note_id; });
  let dsum = 0, dn = 0; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const d = L.tagDistance(noteTags.get(ids[i]), noteTags.get(ids[j])); if (d != null) { dsum += d; dn++; } }
  sparks.push({ key: key, surface: e.surface, types: Array.from(e.types), df: df, rarity: Math.log(NN / df), dist: dn ? dsum / dn : null, burrs: bs });
});
const idf = L.buildIdf(burrs.map(function (b) { return tokensOf.get(b.id); }));
const vec = new Map(); const vecOf = function (b, ex) { return L.vectorOf(tokensOf.get(b.id), idf, ex); };
sparks.forEach(function (s) { const ex = new Set(s.key.split(' ')); const v = s.burrs.map(function (b) { return vecOf(b, ex); }); let m = 0, n = 0;
  for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) { m += L.cosine(v[i], v[j]); n++; } s.cos = n ? m / n : 0; s.clone = s.cos >= 0.5; });
const live = sparks.filter(function (s) { return !s.clone; }), tagged = live.filter(function (s) { return s.dist != null; });
console.log('candidates: ' + sparks.length + ' | near-duplicate facts (clone-of, cosine>=0.5): ' + (sparks.length - live.length) + ' | with known tag distance: ' + tagged.length +
  ' | cross-domain (dist>=0.8): ' + tagged.filter(function (s) { return s.dist >= 0.8; }).length + ' | one-note-untagged: ' + (live.length - tagged.length));
const typeMix = {}; live.forEach(function (s) { s.types.forEach(function (t) { typeMix[t] = (typeMix[t] || 0) + 1; }); });
console.log('which bristle types make live sparks: ' + JSON.stringify(typeMix));
const show = function (s) { console.log('\n• "' + s.surface + '" [' + s.types.join('/') + '] notes=' + s.df + ' rarity=' + s.rarity.toFixed(1) + ' dist=' + (s.dist == null ? '?' : s.dist.toFixed(2)) + ' ctx-cos=' + s.cos.toFixed(2));
  s.burrs.slice(0, 4).forEach(function (b) { console.log('   - ' + short(b.claim, 150) + '   [' + short(noteTitle.get(b.note_id), 38) + ']'); }); };
const ranked = tagged.filter(function (s) { return s.dist >= 0.8; }).sort(function (a, b) { return b.rarity * b.dist - a.rarity * a.dist; });
console.log('\n-- top by rarity x distance (an argmax view, for inspection only) --'); ranked.slice(0, Math.ceil(SHOW / 2)).forEach(show);
console.log('\n-- seeded SAMPLE of cross-domain sparks (what a card stream would feel like; seed ' + SEED + ') --'); sample(ranked, SHOW).forEach(show);

// ---------- 4. knots ----------
hr('4. Knots (one surface, 2-40 notes, different contexts)');
const SURF = new Set(require('./lib/pack').current().hookRoles.surface);
const knots = [];
index.forEach(function (e, key) {
  const df = e.notes.size; if (df < 2 || df > 40 || L.isYearKey(key)) return;
  if (!Array.from(e.types).some(function (t) { return SURF.has(t); })) return;
  const perNote = new Map(); e.burrs.forEach(function (id) { const b = burrById.get(id); if (!perNote.has(b.note_id)) perNote.set(b.note_id, b); });
  const bs = Array.from(perNote.values()).slice(0, 12), ex = new Set(key.split(' ')), v = bs.map(function (b) { return vecOf(b, ex); });
  let cs = 0, cn = 0, ds = 0, dn = 0;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { cs += L.cosine(v[i], v[j]); cn++; const d = L.tagDistance(noteTags.get(bs[i].note_id), noteTags.get(bs[j].note_id)); if (d != null) { ds += d; dn++; } }
  const cos = cn ? cs / cn : 0, dist = dn ? ds / dn : null;
  const cls = cos >= 0.15 || (dist != null && dist <= 0.4) ? 'same-sense' : (cos < 0.06 && dist != null && dist >= 0.8) ? 'collision' : 'undecided';
  knots.push({ key: key, surface: e.surface, df: df, cos: cos, dist: dist, cls: cls, burrs: bs });
});
const kc = {}; knots.forEach(function (k) { kc[k.cls] = (kc[k.cls] || 0) + 1; });
console.log('knot candidates: ' + knots.length + ' | ' + JSON.stringify(kc) + ' | variant-key preview below');
const showK = function (k) { console.log('\n• "' + k.surface + '" notes=' + k.df + ' ctx-cos=' + k.cos.toFixed(2) + ' dist=' + (k.dist == null ? '?' : k.dist.toFixed(2)));
  k.burrs.slice(0, 3).forEach(function (b) { console.log('   - ' + short(b.claim, 140) + '   [' + short(noteTitle.get(b.note_id), 34) + ']'); }); };
const coll = knots.filter(function (k) { return k.cls === 'collision'; });
console.log('\n-- SAMPLE of collision knots (seed ' + SEED + ') --'); sample(coll, SHOW).forEach(showK);
console.log('\n-- SAMPLE of undecided knots --'); sample(knots.filter(function (k) { return k.cls === 'undecided'; }), Math.ceil(SHOW / 2)).forEach(showK);

// variant-key preview (E1 preview, NOT the experiment): what would the experimental fold merge?
const vk = new Map(); index.forEach(function (e, key) { if (e.notes.size > 40 || L.isYearKey(key)) return; const v = L.variantKey(key); if (!vk.has(v)) vk.set(v, []); vk.get(v).push(key); });
const merges = Array.from(vk.values()).filter(function (a) { return a.length > 1; });
console.log('\nvariant-key preview: ' + merges.length + ' groups where the experimental fold merges different exact keys; samples:');
sample(merges, 8).forEach(function (a) { console.log('   ' + a.slice(0, 4).join('  ~  ')); });

// ---------- 5. loops ----------
hr('5. Loops: unanswered questions and whether the vault could answer them');
const loops = burrs.filter(function (b) { return b.loop_text; });
let withPartner = 0; const ex = [];
loops.forEach(function (b) { const t = L.tokens(b.loop_text); let hit = null;
  for (let n = 4; n >= 1 && !hit; n--) for (let i = 0; i + n <= t.length && !hit; i++) { const k = t.slice(i, i + n).join(' '); const e = index.get(k); if (L.usableKey(k) && e && Array.from(e.notes).some(function (id) { return id !== b.note_id; })) hit = k; }
  if (hit) { withPartner++; if (ex.length < 400) ex.push({ b: b, k: hit }); } });
console.log('burrs with a loop: ' + loops.length + ' (' + pct(loops.length, burrs.length) + ' of burrs) | loops whose text names something found in another note: ' + withPartner + ' (' + pct(withPartner, loops.length) + ')');
sample(ex, Math.ceil(SHOW / 2)).forEach(function (x) { console.log('\n• ' + short(x.b.loop_text, 130) + '\n   (matches "' + x.k + '")   from: ' + short(x.b.claim, 100)); });

// ---------- 6. dating residue ----------
hr('6. Relative-time wording left in claims (what the dating tweak in v5 would fix)');
const REL = /\b(this|last|next) (week|weekend|month|year|season|summer|winter|spring|autumn|fall)\b|\btoday\b|\bcurrently\b|\brecently\b|\bnow\b|\bnewly\b|\bupcoming\b/i;
const rel = burrs.filter(function (b) { return REL.test(b.claim); });
console.log('claims with relative-time wording: ' + rel.length + ' (' + pct(rel.length, burrs.length) + ')');
sample(rel, 5).forEach(function (b) { console.log('   - ' + short(b.claim, 140)); });

hr('7. Summary numbers');
console.log(JSON.stringify({ burrs: burrs.length, notes: NN, taggedNotesShare: pct(Array.from(notesWithBurrs).filter(function (i) { return noteTags.has(i); }).length, NN), titleDictionary: titleDict.size, keys: index.size,
  sparkCandidates: sparks.length, liveSparks: live.length, crossDomainSparks: tagged.filter(function (s) { return s.dist >= 0.8; }).length, knots: knots.length, knotClasses: kc }));
if (opt('--json')) require('fs').writeFileSync(opt('--json'), JSON.stringify({ sparks: ranked.slice(0, 200), knots: coll.slice(0, 200) }, null, 1));
