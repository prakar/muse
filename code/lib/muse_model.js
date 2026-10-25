'use strict';
/**
 * QUARRY lib/muse_model.js — SCRATCH. Builds the in-memory model the scratch viewer shows:
 * burrs, bristles (grouped by key), spark candidates and knot candidates, each with a list of
 * "recommendation" tags (REC). Deterministic, read-only, no LLM. Same maths as muse_scratch.js.
 *
 * Maths in one place:
 *   rarity(key)      = ln(N_notes / df)        df = number of distinct notes that contain the key
 *   domain distance  = 1 - |A ∩ B| / |A ∪ B|   over the two notes' tag-root sets (null if either has no tags)
 *   spark score      = rarity x distance       (inspection only; real selection samples, never argmax)
 *   sense distance   = cosine of TF-IDF claim vectors with the shared surface removed
 */
const L = require('./bristles');

const DEAD_END = new Set(['set', 'mechanism', 'uniqueness', 'former-role', 'homonym', 'etymon']);
const COMMON_TYPES = new Set(['entity', 'material', 'etymon', 'homonym', 'place']);
const DURATION = /\b\d[\d,.]*\s*[-+]?\s*(?:year|month|week|day|decade|century|centuries|hour|minute)s?\b/i;
const REL = /\b(this|last|next) (week|weekend|month|year|season|summer|winter|spring|autumn|fall)\b|\btoday\b|\bcurrently\b|\brecently\b|\bnow\b|\bnewly\b|\bupcoming\b/i;

// What each tag means, the evidence behind it (from the nug-v4 sniff test, 23 Oct 2026), and where the fix lands.
const REC = {
  'dead-end-type': { label: 'fix dead-end hook type', fix: 'nug-v5 prompt', finding: 'set/mechanism/uniqueness/former-role/homonym/etymon hooks are shared by no other note (79-97% single-note). The model words them freely, so exact matching never joins. Ask for canonical short forms, seeded with values that already join.' },
  'split-time': { label: 'split time: duration', fix: 'nug-v5 prompt', finding: '"150 years" joins six unrelated notes. A duration is not a date; keep dates and years as time bristles, drop or retype durations.' },
  'title-hub': { label: 'title match is a hub', fix: 'deterministic', finding: 'Note-title matches inside claims are 72% hubs (shared by >40 notes). Exclude from sparks.' },
  'common-word': { label: 'common word: knot, not spark', fix: 'deterministic', finding: 'A lower-case single word (light, honey) is a sense question, not a rare handle. Route to knots; require a capitalised or multi-word surface for sparks.' },
  'needs-category': { label: 'add category to hook', fix: 'nug-v5 prompt', finding: 'A single capitalised word can mean different things (Panini the grammarian, Panini the sandwich). A coarse category (person/place/work/food...) on entity hooks separates senses; context similarity cannot.' },
  'hub': { label: 'hub: not a spark', fix: 'deterministic', finding: 'Shared by more than 40 notes; too common to be a rare handle.' },
  'year-slice': { label: 'year: Slice mode, not a spark', fix: 'deterministic', finding: 'A year shared by more than 8 notes is a calendar slice, not a rare link.' },
  'raise-cap': { label: 'cap: raise', fix: 'nug-v5 prompt', finding: 'Last-ranked burrs (9+) in capped notes join as often as the first ones (60% vs 53%), so the cap is cutting good material.' },
  'dating-regex': { label: 'dating: regex-flag perishable', fix: 'deterministic', finding: 'Only 1.4% of claims have relative-time wording; flag perishable by regex instead of a prompt change.' },
  'loop-restates': { label: 'tighten loop rule', fix: 'nug-v5 prompt', finding: 'The loop mostly repeats the claim as a question. A loop should be what the note leaves unexplained.' },
  'url-in-quote': { label: 'URLs inside evidence quote', fix: 'nug-v5 preprocessing', finding: 'Evidence units can be markdown link blobs (a 300-character quote of search-engine URL). Turn [text](url) into text and drop bare URLs before numbering lines; also cuts input tokens.' },
  'no-bristle': { label: 'burr has no bristle', fix: 'review', finding: 'Nothing to join on: hooks absent or unusable.' },
  'clone-of': { label: 'near-duplicate fact', fix: 'deterministic', finding: 'Two notes state nearly the same fact (context cosine >= 0.5). A clone-of relation, not a spark.' },
  'verify-collision': { label: 'verify: is it really a collision?', fix: 'human + nug-v5 (category)', finding: 'Low context similarity is the default for short claims, so it over-reports collisions (about 1 in 10 in the sample was real). Needs a human label or a category field.' }
};

// What the author is asked, in plain words. `ask` is the question shown on the row ({x} = the row's handle with its note count),
// `yes` / `no` are the button texts (each names the effect), `pick` is the bristle types the question is about for burr rows.
// Stored verdicts are 'apply' (yes) and 'leave' (no), so a stored vote never depends on the wording.
const ASK = {
  'dead-end-type': { ask: 'Should {x} be rewritten as a short standard form so it can match other notes?', yes: 'Standardise it', no: 'Leave as is', pick: ['set', 'mechanism', 'uniqueness', 'former-role', 'homonym', 'etymon'] },
  'split-time': { ask: 'Is {x} a date or a length of time?', yes: "It's a duration, drop it", no: "It's a date", pick: ['time'] },
  'title-hub': { ask: 'Should {x} be used to link notes?', yes: "Don't use for links", no: 'Use for links', pick: ['title'] },
  'common-word': { ask: 'Should {x} be a spark, or a word to check for different meanings?', yes: 'Keep out of sparks', no: 'Allow in sparks', pick: ['entity', 'material', 'etymon', 'homonym', 'place'] },
  'needs-category': { ask: 'Should {x} get a category (person, place, food…)?', yes: 'Add category', no: 'Leave as is', pick: ['entity', 'place', 'material'] },
  'hub': { ask: 'Should {x} be a spark?', yes: 'Keep out of sparks', no: 'Allow in sparks', pick: [] },
  'year-slice': { ask: 'Should {x} be a spark?', yes: 'Keep out of sparks', no: 'Allow in sparks', pick: ['time'] },
  'raise-cap': { ask: 'This is a late fact from a long note. Is it worth keeping?', yes: 'Keep, raise the limit', no: 'Fine to cut', pick: [] },
  'dating-regex': { ask: 'The claim has time-relative wording. Mark it as may-go-stale?', yes: 'Mark may-go-stale', no: 'Not time-sensitive', pick: [] },
  'loop-restates': { ask: 'The open question just repeats the claim. Should it ask what the note leaves unexplained instead?', yes: 'Rewrite it', no: 'Leave it', pick: [] },
  'url-in-quote': { ask: 'The evidence contains a web link. Strip links before it is used?', yes: 'Strip links', no: 'Leave as is', pick: [] },
  'no-bristle': { ask: 'This fact has nothing to link on.', yes: 'Flag for review', no: 'Keep anyway', pick: [] },
  'clone-of': { ask: 'Two notes state the same fact: {x}.', yes: 'Treat as duplicate', no: 'Treat as a spark', pick: [] },
  'verify-collision': { ask: 'Does {x} have two meanings in your notes?', yes: 'Yes, two meanings', no: 'No, one meaning', pick: [] }
};
Object.keys(ASK).forEach(function (k) { Object.assign(REC[k], ASK[k]); });

// Item labels: [stored value, button text, hint]. Same stored values as before for knots; burrs, bristles and sparks are re-worded.
const ITEM_LABELS = {
  burrs: [['good', 'Interesting fact', 'Faithful to its evidence and a fact you would gladly hold as a card.'], ['weak', 'Dull fact', 'True, but too trivial or vague to build on.'], ['junk', 'Wrong or not a fact', 'Not supported by the evidence, or not a fact at all.']],
  bristles: [['good handle', 'Use as a link', 'Specific and meaning the same wherever it appears.'], ['bad handle', 'Too generic to link', 'Correct, but too common or too vague to connect notes.'], ['noise', 'Not a real hook (a mistake)', 'An extraction artefact: a fragment, URL or stray number.']],
  sparks: [['spark', 'Worth a question', 'This pairing makes you want to write a question.'], ['held (keep juxtaposition)', 'Keep this pairing for later', 'Not a question yet, but keep the two together.'], ['dull', 'Dull', 'Valid, but uninteresting.'], ['trivial', 'Too obvious', 'Obvious or a coincidence.']],
  knots: [['homonym', 'Unrelated meanings', 'e.g. bank (river edge) and bank (money): nothing connects them.'], ['polyseme', 'Related meanings', 'e.g. mouth (body) and mouth (river): one grew out of the other.'], ['same sense', 'Same meaning', 'One meaning everywhere, so not a real knot.'], ['unsure', "Can't tell", '']]
};

function recsForKey(key, e) {
  const df = e.notes.size, surf = String(e.surface || ''), out = [];
  const types = Array.from(e.types), single = key.indexOf(' ') < 0;
  const isYear = L.isYearKey(key);
  if (df === 1 && types.some(function (t) { return DEAD_END.has(t); })) out.push('dead-end-type');
  if (types.indexOf('time') >= 0 && DURATION.test(surf)) out.push('split-time');
  if (e.srcs && e.srcs.has('title') && df > 40) out.push('title-hub');
  if (single && surf && surf === surf.toLowerCase() && !isYear && df >= 2 && types.some(function (t) { return COMMON_TYPES.has(t); })) out.push('common-word');
  if (single && /^[A-Z]/.test(surf) && types.indexOf('entity') >= 0 && df >= 2 && df <= 40) out.push('needs-category');
  if (isYear && df > 8) out.push('year-slice');
  else if (df > 40 && out.indexOf('title-hub') < 0) out.push('hub');
  return out;
}

function jaccard(a, b) { let i = 0; a.forEach(function (x) { if (b.has(x)) i++; }); const u = a.size + b.size - i; return u ? i / u : 0; }
function band(df) { return df === 1 ? 'single' : df <= 8 ? 'spark' : df <= 40 ? 'mid' : 'hub'; }

function build(db, version, opts) {
  opts = opts || {};
  // Burrs flagged as duplicates by code/dedupe.js are hidden unless opts.showDupes (nothing is ever deleted).
  let hasDupes = false; try { hasDupes = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='burr_dupes'").get(); } catch (e) {}
  const dupClause = hasDupes && !opts.showDupes ? " AND b.id NOT IN (SELECT burr_id FROM burr_dupes WHERE status='dup')" : '';
  const burrsRaw = db.prepare('SELECT b.id, b.note_id, b.claim, b.quote, b.kind, b.hooks_json, b.loop_text, b.perishable, n.title FROM burrs b JOIN vault_notes n ON n.id=b.note_id WHERE b.prompt_version=?' + dupClause + ' ORDER BY b.id').all(version);
  const noteTitle = new Map(), noteTags = new Map();
  db.prepare('SELECT id,title FROM vault_notes').all().forEach(function (r) { noteTitle.set(r.id, r.title); });
  db.prepare('SELECT note_id, tag_root FROM note_tags WHERE tag_root IS NOT NULL').all().forEach(function (r) {
    if (!noteTags.has(r.note_id)) noteTags.set(r.note_id, new Set()); noteTags.get(r.note_id).add(r.tag_root); });
  const NN = new Set(burrsRaw.map(function (b) { return b.note_id; })).size;
  const titleDict = new Map();
  noteTitle.forEach(function (t, id) { const k = L.titleKey(t); if (k && !titleDict.has(k)) titleDict.set(k, id); });

  const perNote = new Map(), rank = new Map(), toks = new Map(), bristles = new Map();
  burrsRaw.forEach(function (b) { const c = (perNote.get(b.note_id) || 0) + 1; perNote.set(b.note_id, c); rank.set(b.id, c); toks.set(b.id, L.tokens(b.claim)); });
  burrsRaw.forEach(function (b) {
    const own = L.titleKey(b.title), seen = new Set(), out = [];
    const add = function (type, surface, key, src) { if (!L.usableKey(key) || seen.has(key)) return; seen.add(key); out.push({ type: type, surface: surface, key: key, src: src }); };
    let hooks = []; try { hooks = JSON.parse(b.hooks_json || '[]'); } catch (e) {}
    hooks.forEach(function (h) { add(h.type, h.value, L.foldKey(h.value), 'hook'); });
    L.yearsIn(b.claim).forEach(function (y) { add('time', y, y, 'year'); });
    const t = toks.get(b.id); let nT = 0;
    for (let n = 6; n >= 1 && nT < 4; n--) for (let i = 0; i + n <= t.length && nT < 4; i++) {
      const k = t.slice(i, i + n).join(' ');
      if (k !== own && titleDict.has(k) && !seen.has(k)) { add('title', k, k, 'title'); nT++; }
    }
    bristles.set(b.id, out);
  });

  const index = new Map();
  burrsRaw.forEach(function (b) { bristles.get(b.id).forEach(function (br) {
    let e = index.get(br.key);
    if (!e) { e = { burrs: [], notes: new Set(), types: new Set(), srcs: new Set(), surface: br.surface }; index.set(br.key, e); }
    e.burrs.push(b.id); e.notes.add(b.note_id); e.types.add(br.type); e.srcs.add(br.src); }); });
  const byId = new Map(burrsRaw.map(function (b) { return [b.id, b]; }));
  const keyRecs = new Map(); index.forEach(function (e, k) { keyRecs.set(k, recsForKey(k, e)); });
  const brief = function (b) { return { id: b.id, claim: b.claim, quote: b.quote, note: noteTitle.get(b.note_id) }; };

  // ----- burr rows
  const burrRows = burrsRaw.map(function (b) {
    const brs = bristles.get(b.id).map(function (x) { const e = index.get(x.key); return { t: x.type, s: x.surface, k: x.key, src: x.src, df: e.notes.size }; });
    const joinDfs = brs.map(function (x) { return x.df; }).filter(function (d) { return d >= 2; });
    const bestDf = joinDfs.length ? Math.min.apply(null, joinDfs) : null;
    const jb = brs.some(function (x) { return x.df >= 2 && x.df <= 8; }) ? 'spark' : brs.some(function (x) { return x.df >= 2 && x.df <= 40; }) ? 'any' : 'none';
    const recs = [];
    const add = function (r) { if (recs.indexOf(r) < 0) recs.push(r); };
    if (rank.get(b.id) >= 9) add('raise-cap');
    if (REL.test(b.claim)) add('dating-regex');
    if (b.loop_text) { const lt = new Set(L.tokens(b.loop_text).filter(function (w) { return !L.STOP.has(w) && w.length > 2; })), ct = new Set(toks.get(b.id)); if (lt.size && jaccard(lt, ct) >= 0.5) add('loop-restates'); }
    if (!brs.length) add('no-bristle');
    if (/https?:\/\//.test(b.quote || '')) add('url-in-quote');
    brs.forEach(function (x) { keyRecs.get(x.k).forEach(function (r) { if (r === 'dead-end-type' || r === 'split-time' || r === 'needs-category') add(r); }); });
    return { id: b.id, note: b.title, noteId: b.note_id, rank: rank.get(b.id), noteBurrs: perNote.get(b.note_id), kind: b.kind, claim: b.claim, quote: b.quote,
      loop: b.loop_text || '', perishable: b.perishable, nB: brs.length, bestDf: bestDf, band: jb, bristles: brs, recs: recs,
      _s: (b.claim + ' ' + b.title + ' ' + (b.loop_text || '')).toLowerCase() };
  });

  // ----- bristle rows (one per key)
  const bristleRows = [];
  index.forEach(function (e, key) {
    const df = e.notes.size;
    bristleRows.push({ id: key, surface: e.surface, types: Array.from(e.types), srcs: Array.from(e.srcs), df: df, nBurrs: e.burrs.length, band: band(df),
      rarity: Math.log(NN / df), recs: keyRecs.get(key), _s: (key + ' ' + e.surface).toLowerCase() });
  });

  // ----- sparks and knots
  const idf = L.buildIdf(burrsRaw.map(function (b) { return toks.get(b.id); }));
  const pickPerNote = function (e) { const m = new Map(); e.burrs.forEach(function (id) { const b = byId.get(id); if (!m.has(b.note_id)) m.set(b.note_id, b); }); return Array.from(m.values()); };
  const pairStats = function (bs, key) {
    const ex = new Set(key.split(' ')), v = bs.map(function (b) { return L.vectorOf(toks.get(b.id), idf, ex); });
    let cs = 0, cn = 0, ds = 0, dn = 0;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      cs += L.cosine(v[i], v[j]); cn++;
      const d = L.tagDistance(noteTags.get(bs[i].note_id), noteTags.get(bs[j].note_id)); if (d != null) { ds += d; dn++; } }
    return { cos: cn ? cs / cn : 0, dist: dn ? ds / dn : null };
  };
  const sparkRows = [], knotRows = [], SURF = new Set(['entity', 'homonym', 'material', 'place', 'etymon', 'title']);
  index.forEach(function (e, key) {
    const df = e.notes.size;
    if (df >= 2 && df <= 8) {
      const bs = pickPerNote(e), st = pairStats(bs, key), clone = st.cos >= 0.5, recs = keyRecs.get(key).slice();
      if (clone) recs.push('clone-of');
      sparkRows.push({ id: key, surface: e.surface, types: Array.from(e.types), df: df, rarity: Math.log(NN / df), dist: st.dist, cos: st.cos, clone: clone,
        score: st.dist == null ? -1 : Math.log(NN / df) * st.dist, recs: recs, burrs: bs.slice(0, 6).map(brief), _s: (key + ' ' + e.surface).toLowerCase() });
    }
    if (df >= 2 && df <= 40 && !L.isYearKey(key) && Array.from(e.types).some(function (t) { return SURF.has(t); })) {
      const bs = pickPerNote(e).slice(0, 12), st = pairStats(bs, key);
      const cls = st.cos >= 0.15 || (st.dist != null && st.dist <= 0.4) ? 'same-sense' : (st.cos < 0.06 && st.dist != null && st.dist >= 0.8) ? 'collision' : 'undecided';
      const recs = keyRecs.get(key).filter(function (r) { return r === 'common-word' || r === 'needs-category' || r === 'hub' || r === 'title-hub'; });
      if (cls === 'collision') recs.push('verify-collision');
      knotRows.push({ id: key, surface: e.surface, types: Array.from(e.types), df: df, cos: st.cos, dist: st.dist, cls: cls, recs: recs, burrs: bs.slice(0, 6).map(brief), _s: (key + ' ' + e.surface).toLowerCase() });
    }
  });

  const detail = function (view, id) {
    if (view !== 'bristles') return null;
    const e = index.get(id); if (!e) return null;
    return pickPerNote(e).slice(0, 25).map(brief);
  };
  const counts = {};
  [['burrs', burrRows], ['bristles', bristleRows], ['sparks', sparkRows], ['knots', knotRows]].forEach(function (p) {
    p[1].forEach(function (r) { r.recs.forEach(function (t) { (counts[t] = counts[t] || {})[p[0]] = ((counts[t] || {})[p[0]] || 0) + 1; }); }); });
  return { version: version, notes: NN, burrs: burrRows, bristles: bristleRows, sparks: sparkRows, knots: knotRows, detail: detail, recCounts: counts,
    kinds: Array.from(new Set(burrRows.map(function (r) { return r.kind; }))).sort(),
    types: Array.from(new Set([].concat.apply([], bristleRows.map(function (r) { return r.types; })))).sort() };
}

module.exports = { build, REC, ITEM_LABELS, recsForKey, DURATION, REL, DEAD_END };
