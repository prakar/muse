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

const Pack = require('./pack');
const ROLES = Pack.current().hookRoles;
const DEAD_END = new Set(ROLES.deadEnd);
const COMMON_TYPES = new Set(ROLES.common);
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
  wordplay: [['good lead-in', 'Usable as a lead-in', 'A quiz lead-in you would use.'], ['weak', 'Not worth a lead-in', 'Valid wordplay, but dull or accidental.']],
  slices: [['useful slice', 'Useful to browse', 'A year, quantity or word worth pulling every note for.'], ['noise', 'Not worth browsing', 'Too generic or accidental to be a slice.']],
  knots: [['homonym', 'Unrelated meanings', 'e.g. bank (river edge) and bank (money): nothing connects them.'], ['polyseme', 'Related meanings', 'e.g. mouth (body) and mouth (river): one grew out of the other.'], ['same sense', 'Same meaning', 'One meaning everywhere, so not a real knot.'], ['unsure', "Can't tell", '']]
};

// ---------- spark eligibility (from the first v5 spark judgements, 25 Oct 2026) ----------
// A spark is a handle worth following between notes. These keys are not: they go to `slices` (a way to browse a year,
// a quantity or a generic word), not to the spark list. Nothing is deleted; each exclusion has a reason.
const NUMBER_WORDS = new Set('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion first second third fourth fifth sixth seventh eighth ninth tenth'.split(' '));
const GENERIC_CATS = new Set(['substance', 'other', 'object']);
function sparkExclusion(key, e) {
  const types = Array.from(e.types), surf = String(e.surface || ''), srcs = e.srcs;
  if (types.every(function (t) { return t === 'time' || t === 'number'; })) return L.isYearKey(key) ? 'year-slice' : 'quantity-slice';
  if (srcs.size === 1 && srcs.has('title')) return 'title-only';                       // found by matching note titles in the text, not by an extracted hook
  if (key.split(' ').every(function (w) { return NUMBER_WORDS.has(w); })) return 'spelled-number';
  if (key.indexOf(' ') < 0 && surf && surf === surf.toLowerCase() && e.cats.size && Array.from(e.cats).every(function (c) { return GENERIC_CATS.has(c); })) return 'generic-word';   // chemicals, compounds: a kind of thing, not a thing
  return '';
}

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


// ---------- spark ranking (28 Oct 2026) ----------
// The old score, rarity x tag distance, was flat: every two-note spark has the same rarity, tag distance is 1.00 for any pair of notes
// that share no tag, and a missing distance (untagged notes) scored -1 and sank to the bottom although the author had judged many of those
// "worth a question". The ranking is now a sum of small, readable parts. The weights are hand-set priors, to be refitted
// (logistic regression on the author's judgements) once about 200 sparks are judged; `parts` is kept on each row so the viewer can say why.
function sparkParts(r, nBOf, NN) {
  const parts = {}, surface = String(r.surface || ''), words = surface.split(/\s+/).length, wp = r.wordplay;
  parts.rare = +Math.min(1, r.rarity / Math.log(NN / 2)).toFixed(2);                                                  // 1 = shared by two notes
  if (wp) parts.name = 0;
  else parts.name = /^[A-Z]/.test(surface) ? (words > 1 ? 1 : 0.6) : (words > 1 ? 0.2 : -0.5);                       // proper multi-word name best; lowercase single word is a sense question
  if (r.recs.indexOf('common-word') >= 0) parts.common = -1;
  if (r.recs.indexOf('needs-category') >= 0) parts.needsCategory = -0.3;
  parts.far = r.dist == null ? 0.5 : +r.dist.toFixed(2);                                                              // unknown distance is neutral, not bad
  const nb = (r.burrs || []).map(function (b) { return nBOf.get(b.id) || 0; }), lens = (r.burrs || []).map(function (b) { return (b.claim || '').length; });
  parts.rich = nb.length ? +Math.min(1, Math.min.apply(null, nb) / 5).toFixed(2) * 0.6 : 0;                           // both facts carry several hooks
  parts.full = lens.length ? +Math.min(1, Math.min.apply(null, lens) / 120).toFixed(2) * 0.5 : 0;                     // very short facts are weak
  if (r.clone) parts.restated = -0.5;
  if (wp) parts.wordplay = wp.grade === 'A' ? 0.8 : 0.2;
  const score = Object.keys(parts).reduce(function (s, k) { return s + (k === 'rare' ? 1.5 * parts[k] : parts[k]); }, 0);
  return { score: +score.toFixed(3), parts: parts };
}
function whyRanked(parts) {
  return Object.keys(parts).filter(function (k) { return k !== 'rare' && k !== 'far' && parts[k] !== 0; }).map(function (k) { return k + (parts[k] > 0 ? ' +' : ' ') + (+parts[k]).toFixed(1); }).concat(['distance ' + parts.far]).join(', ');
}

function build(db, version, opts) {
  opts = opts || {};
  // Burrs flagged as duplicates by code/dedupe.js are hidden unless opts.showDupes (nothing is ever deleted).
  let hasDupes = false; try { hasDupes = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='burr_dupes'").get(); } catch (e) {}
  const dupClause = hasDupes && !opts.showDupes ? " AND b.id NOT IN (SELECT burr_id FROM burr_dupes WHERE status='dup')" : '';
  const burrsRaw = db.prepare('SELECT b.id, b.note_id, b.claim, b.quote, b.kind, b.hooks_json, b.perishable, n.title FROM burrs b JOIN vault_notes n ON n.id=b.note_id WHERE b.prompt_version=? AND COALESCE(n.quarry_exclude,0)=0' + dupClause + ' ORDER BY b.id').all(version);
  const noteTitle = new Map(), noteTags = new Map();
  db.prepare('SELECT id,title FROM vault_notes').all().forEach(function (r) { noteTitle.set(r.id, r.title); });
  const noteDate = new Map();   // the note's file date (when it was last saved), for the Note date lens; a database without the column just has no dates
  try { db.prepare('SELECT id, file_mtime FROM vault_notes WHERE file_mtime IS NOT NULL').all().forEach(function (r) { const t = Date.parse(r.file_mtime); if (!isNaN(t)) noteDate.set(r.id, t); }); } catch (e) { /* no file_mtime column */ }
  db.prepare('SELECT note_id, tag_root FROM note_tags WHERE tag_root IS NOT NULL').all().forEach(function (r) {
    if (!noteTags.has(r.note_id)) noteTags.set(r.note_id, new Set()); noteTags.get(r.note_id).add(r.tag_root); });
  const NN = new Set(burrsRaw.map(function (b) { return b.note_id; })).size;
  const titleDict = new Map();
  noteTitle.forEach(function (t, id) { const k = L.titleKey(t); if (k && !titleDict.has(k)) titleDict.set(k, id); });

  const perNote = new Map(), rank = new Map(), toks = new Map(), bristles = new Map(), timeline = [], quantities = [], coarse = [];
  burrsRaw.forEach(function (b) { const c = (perNote.get(b.note_id) || 0) + 1; perNote.set(b.note_id, c); rank.set(b.id, c); toks.set(b.id, L.tokens(b.claim)); });
  burrsRaw.forEach(function (b) {
    const own = L.titleKey(b.title), seen = new Set(), out = [], seenQ = new Set();
    const note = function (key, kindHint) { if (seenQ.has(key)) return; seenQ.add(key); const y = L.yearOfKey(key); if (y != null) timeline.push({ y: y, b: b.id }); else { const q = L.quantityOfKey(key); if (q) quantities.push({ u: L.normUnit(q.u), v: q.v, b: b.id }); } };
    const add = function (type, surface, key, src, cat) { if (!L.usableKey(key) || seen.has(key)) return; seen.add(key); out.push({ type: type, surface: surface, key: key, src: src, cat: cat || '' }); };
    let hooks = []; try { hooks = JSON.parse(b.hooks_json || '[]'); } catch (e) {}
    hooks.forEach(function (h) {
      // Numbers and dates carry a unit or an era so that 1170 BC, 1170 AD, 1120 km and 1120 runs never join.
      if (h.type === 'time' && h.grain === 'century') return;   // coarse date: read from the claim text into `coarse`
      if (h.type === 'time' || h.type === 'number') {
        const q = L.qualifyNumber(h.value, b.claim, null, h.type, h.xc ? null : { era: h.era, unit: h.unit });   // where the model and the claim-text reading disagree (xc), fall back to the claim text until reviewed
        if (q.kind === 'text') return add(h.type, h.value, L.foldKey(h.value), 'hook');
        if (!q.key) return;                                   // a bare number with no unit or era is not a handle
        note(q.key); return add(q.kind === 'qty' && !q.duration ? 'number' : 'time', q.surface, q.key, 'hook');
      }
      add(h.type, h.value, L.foldKey(h.value), 'hook', h.cat);
    });
    L.findDates(b.claim).forEach(function (f) { if (f.grain === 'century') coarse.push({ from: f.from, to: f.to, g: 'century', stated: f.eraStated, b: b.id }); });   // centuries: coarse dates, kept apart from the year timeline
    L.datesIn(b.claim).forEach(function (q) { note(q.key); add('time', q.surface, q.key, 'year'); });
    L.daysIn(b.claim).forEach(function (d) { if (d.clip) return; add('day', d.surface, d.key, 'day', d.role || ''); if (d.full) add('day', d.surface + ' ' + d.year, d.full, 'day', d.role || ''); });   // G1: a day-level date ("march 14") joins across years; the role (born, died, founded...) rides in `cat`
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
    if (!e) { e = { burrs: [], notes: new Set(), types: new Set(), srcs: new Set(), cats: new Set(), surface: br.surface }; index.set(br.key, e); }
    e.burrs.push(b.id); e.notes.add(b.note_id); e.types.add(br.type); e.srcs.add(br.src); if (br.cat) e.cats.add(br.cat); }); });
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
    if (!brs.length) add('no-bristle');
    if (/https?:\/\//.test(b.quote || '')) add('url-in-quote');
    brs.forEach(function (x) { keyRecs.get(x.k).forEach(function (r) { if (r === 'dead-end-type' || r === 'split-time' || r === 'needs-category') add(r); }); });
    return { id: b.id, note: b.title, noteId: b.note_id, rank: rank.get(b.id), noteBurrs: perNote.get(b.note_id), kind: b.kind, claim: b.claim, quote: b.quote,
      perishable: b.perishable, nB: brs.length, bestDf: bestDf, band: jb, bristles: brs, recs: recs,
      _s: (b.claim + ' ' + b.title).toLowerCase() };
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
  const sparkRows = [], knotRows = [], sliceRows = [], excluded = {}, SURF = new Set(ROLES.surface);
  index.forEach(function (e, key) {
    const df = e.notes.size;
    const why = df >= 2 && df <= 8 ? sparkExclusion(key, e) : '';
    if (why) excluded[why] = (excluded[why] || 0) + 1;
    if (df >= 2 && df <= 8 && !why) {
      const bs = pickPerNote(e), st = pairStats(bs, key), clone = st.cos >= 0.5, recs = keyRecs.get(key).slice();
      if (clone) recs.push('clone-of');
      sparkRows.push({ _ns: Array.from(e.notes).sort(function (a, b) { return a - b; }).join(','), id: key, surface: e.surface, types: Array.from(e.types), df: df, rarity: Math.log(NN / df), dist: st.dist, cos: st.cos, clone: clone,
        score: st.dist == null ? -1 : Math.log(NN / df) * st.dist, recs: recs, burrs: bs.slice(0, 6).map(brief), _s: (key + ' ' + e.surface).toLowerCase() });
    }
    if (df >= 2 && df <= 40 && !L.isYearKey(key) && Array.from(e.types).some(function (t) { return SURF.has(t); }) && !(e.cats.size && Array.from(e.cats).every(function (c) { return c === 'other'; }))) {
      const bs = pickPerNote(e).slice(0, 12), st = pairStats(bs, key);
      const cls = st.cos >= 0.15 || (st.dist != null && st.dist <= 0.4) ? 'same-sense' : (st.cos < 0.06 && st.dist != null && st.dist >= 0.8) ? 'collision' : 'undecided';
      const recs = keyRecs.get(key).filter(function (r) { return r === 'common-word' || r === 'needs-category' || r === 'hub' || r === 'title-hub'; });
      if (cls === 'collision') recs.push('verify-collision');
      knotRows.push({ id: key, surface: e.surface, types: Array.from(e.types), df: df, cos: st.cos, dist: st.dist, cls: cls, recs: recs, burrs: bs.slice(0, 6).map(brief), _s: (key + ' ' + e.surface).toLowerCase() });
    }
  });

  // Slices: every key that is a way to browse, not a lead, at any frequency (a year, a quantity, a generic word). Pick one, see its notes.
  index.forEach(function (e, key) {
    if (e.notes.size < 2) return;
    const why = sparkExclusion(key, e);
    if (why) sliceRows.push({ id: key, surface: e.surface, types: Array.from(e.types), df: e.notes.size, why: why, recs: [], _s: (key + ' ' + e.surface).toLowerCase() });
  });
  sliceRows.sort(function (a, b) { return b.df - a.df; });

  // Sparks that join exactly the same notes are one lead, not several (Beckham, Posh and Baby). Keep the most specific, list the rest.
  const byNotes = new Map();
  sparkRows.forEach(function (r) { (byNotes.get(r._ns) || byNotes.set(r._ns, []).get(r._ns)).push(r); });
  const sparkOut = [];
  byNotes.forEach(function (rs) {
    rs.sort(function (a, b) { return (/^[A-Z]/.test(b.surface) - /^[A-Z]/.test(a.surface)) || (b.surface.length - a.surface.length); });
    const head = rs[0]; head.also = rs.slice(1).map(function (r) { return r.surface; });
    if (head.also.length) excluded['same-notes'] = (excluded['same-notes'] || 0) + head.also.length;
    sparkOut.push(head);
  });
  sparkOut.sort(function (a, b) { return b.score - a.score; });
  sparkRows.length = 0; sparkOut.forEach(function (r) { delete r._ns; sparkRows.push(r); });

  // ----- wordplay: pairs of names joined by a wordplay relation become sparks; every edge is listed in the wordplay view.
  // Read from wordplay_edges (built by npm run wordplay); absent table = no wordplay, nothing else changes. Grade C edges are listed, never sparks.
  const wordplayRows = []; let wpState = 'table missing (run npm run wordplay -- --apply)';
  let wpEdges = null; try { wpEdges = db.prepare('SELECT kind, a_name, b_name, a_notes, b_notes, grade, detail, fit FROM wordplay_edges').all(); } catch (e) { /* table not built */ }
  if (wpEdges) {
    wpState = 'ok';
    const noteBurrs = new Map(); burrsRaw.forEach(function (b) { (noteBurrs.get(b.note_id) || noteBurrs.set(b.note_id, []).get(b.note_id)).push(b); });
    const burrFor = function (nid, name) { const l = noteBurrs.get(nid) || [], n = String(name || '').toLowerCase(); return l.find(function (b) { return n && b.claim.toLowerCase().indexOf(n) >= 0; }) || l[0]; };
    const ids = function (s) { try { return JSON.parse(s || '[]').filter(function (n) { return noteBurrs.has(n); }); } catch (e) { return []; } };
    const seenPair = new Set();
    wpEdges.sort(function (x, y) { return x.grade < y.grade ? -1 : x.grade > y.grade ? 1 : 0; });
    wpEdges.forEach(function (e, i) {
      const an = ids(e.a_notes), bn = ids(e.b_notes), det = e.detail ? JSON.parse(e.detail) : null;
      const na = an[0], nb = bn.find(function (n) { return n !== na; });
      const pair = na != null && nb != null, surface = e.b_name ? e.a_name + ' ~ ' + e.b_name : e.a_name;
      const burrs = pair ? [burrFor(na, e.a_name), burrFor(nb, e.b_name)] : an.length ? [burrFor(na, e.a_name)] : [];
      const notes = Array.from(new Set(an.concat(bn)));
      let dist = null;
      if (pair) { let s = 0, c = 0; an.slice(0, 3).forEach(function (x) { bn.slice(0, 3).forEach(function (y) { if (x === y) return; const d = L.tagDistance(noteTags.get(x), noteTags.get(y)); if (d != null) { s += d; c++; } }); }); dist = c ? s / c : null; }
      const id = 'wp:' + e.kind + ':' + e.a_name + '|' + (e.b_name || '');
      wordplayRows.push({ id: id, kind: e.kind, grade: e.grade, a: e.a_name, b: e.b_name, surface: surface, pair: pair, nNotes: notes.length, fit: e.fit, detail: det && det.items ? det.items.slice(0, 8).map(function (x) { return x.name; }) : det && det.names ? det.names.slice(0, 8) : null,
        dist: dist, an: an.slice(0, 12), bn: bn.slice(0, 12), burrs: burrs.filter(Boolean).map(brief), recs: [], types: ['wordplay', e.kind], _s: (e.kind + ' ' + surface).toLowerCase() });
      const pk = [e.a_name, e.b_name].map(function (x) { return String(x).toLowerCase(); }).sort().join('|');   // one spark per pair of names, whichever detector found it first (best grade sorts first)
      if (pair && e.grade !== 'C' && !seenPair.has(pk) && burrs[0] && burrs[1]) {
        seenPair.add(pk);
        const df = new Set(an.concat(bn)).size;
        sparkRows.push({ id: id, surface: surface, types: ['wordplay', e.kind], df: df, rarity: Math.log(NN / df), dist: dist, cos: 0, clone: false, score: dist == null ? -1 : Math.log(NN / df) * dist,
          recs: [], burrs: burrs.map(brief), wordplay: { kind: e.kind, grade: e.grade, fit: e.fit }, also: [], _s: (e.kind + ' ' + surface).toLowerCase() });
      }
    });
    wordplayRows.sort(function (a, b) { return (a.grade < b.grade ? -1 : a.grade > b.grade ? 1 : 0) || b.nNotes - a.nNotes; });
  }

  const nBOf = new Map(burrRows.map(function (r) { return [r.id, r.nB]; }));
  sparkRows.forEach(function (r) { r.score0 = r.score; const s = sparkParts(r, nBOf, NN); r.score = s.score; r.parts = s.parts; r.why = whyRanked(s.parts); });
  sparkRows.sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); });
  // ----- Connect support: the facts that share one handle, each with a difficulty proxy (mean idf of its wording, handle words left out).
  const diffOf = function (b, ex) {
    const t = (toks.get(b.id) || []).filter(function (w) { return !L.STOP.has(w) && w.length >= 3 && !(ex && ex.has(w)); });
    return t.length ? t.reduce(function (s, w) { return s + (idf.get(w) || 1); }, 0) / t.length : 0;
  };
  const noteBurrsAll = new Map(); burrsRaw.forEach(function (b) { (noteBurrsAll.get(b.note_id) || noteBurrsAll.set(b.note_id, []).get(b.note_id)).push(b); });
  const burrWith = function (nid, name) { const l = noteBurrsAll.get(nid) || [], n = String(name || '').toLowerCase(); return l.find(function (b) { return n && b.claim.toLowerCase().indexOf(n) >= 0; }) || l[0]; };
  // Other hooks a fact carries that join at least one more note (not years), rarest first: the "also about" pivots in the app.
  const hooksOf = function (b) { return (bristles.get(b.id) || []).map(function (x) { return { id: x.key, label: x.surface, df: index.get(x.key).notes.size }; })
    .filter(function (x) { return x.df >= 2 && x.df <= 40 && !L.isYearKey(x.id); }).sort(function (a, c) { return a.df - c.df; }).slice(0, 6); };
  const itemOf = function (b, ex, extra) { return Object.assign({ id: b.id, noteId: b.note_id, note: noteTitle.get(b.note_id), claim: b.claim, quote: b.quote, diff: +diffOf(b, ex).toFixed(3), hooks: hooksOf(b) }, extra || {}); };
  const wpById = new Map(wordplayRows.map(function (r) { return [r.id, r]; }));
  // One fact on its own (for a star that belongs to no handle). Null for an unknown fact.
  const burrInfo = function (id) { const b = byId.get(id); return b ? itemOf(b, new Set()) : null; };
  // A pile of facts as the Angles detectors read them: the claim, its kind and its stored hooks. Unknown ids are skipped.
  const pile = function (ids) {
    return ids.map(function (id) { return byId.get(id); }).filter(Boolean).map(function (b) {
      let hooks = []; try { hooks = JSON.parse(b.hooks_json || '[]'); } catch (e) { /* no hooks */ }
      return { id: b.id, noteId: b.note_id, claim: b.claim, kind: b.kind, hooks: Array.isArray(hooks) ? hooks : [] };
    });
  };
  const allPile = function () { return pile(burrsRaw.map(function (b) { return b.id; })); };
  const handle = function (id) {
    if (wpById.has(id)) {
      const r = wpById.get(id), items = [];
      (r.an || []).slice(0, 4).forEach(function (n) { const b = burrWith(n, r.a); if (b) items.push(itemOf(b, new Set(L.tokens(r.a)), { side: 'a', name: r.a })); });
      (r.bn || []).filter(function (n) { return (r.an || []).indexOf(n) < 0; }).slice(0, 4).forEach(function (n) { const b = burrWith(n, r.b); if (b) items.push(itemOf(b, new Set(L.tokens(r.b)), { side: 'b', name: r.b })); });
      return { id: id, kind: 'wordplay', wordplay: r.kind, grade: r.grade, a: r.a, b: r.b, surface: r.surface, items: items };
    }
    const e = index.get(id); if (!e) return null;
    const ex = new Set(id.split(' '));
    return { id: id, kind: 'hook', surface: e.surface, types: Array.from(e.types), df: e.notes.size, items: pickPerNote(e).map(function (b) { return itemOf(b, ex); }) };
  };
  // Stick: hold one fact, see what clings. Every hook the fact carries that joins other notes (2 to 60 notes), grouped by type, rarest first,
  // each with up to 5 facts from OTHER notes. Hooks in more than 60 notes are named but not expanded (too common to be a link). Null for an unknown or hidden fact.
  const STICK_MAX_DF = 60, STICK_PER_HOOK = 5;
  const stick = function (burrId) {
    const b = byId.get(burrId); if (!b) return null;
    const held = itemOf(b, new Set()), groups = new Map(), common = [];
    (bristles.get(b.id) || []).forEach(function (x) {
      const e = index.get(x.key); if (!e) return; const df = e.notes.size;
      if (df < 2) return;
      if (df > STICK_MAX_DF) { common.push({ id: x.key, label: x.surface, df: df, type: x.type }); return; }
      const ex = new Set(x.key.split(' ')), held0 = noteTags.get(b.note_id);
      // Facts from notes far from the held fact's subject come first (tag distance 0 to 1; null when either note has no tags, which sorts last).
      const others = pickPerNote(e).filter(function (o) { return o.note_id !== b.note_id; }).map(function (o) { return { o: o, d: L.tagDistance(held0, noteTags.get(o.note_id)) }; })
        .sort(function (p, q) { return (q.d == null ? -1 : q.d) - (p.d == null ? -1 : p.d) || p.o.id - q.o.id; });
      if (!others.length) return;
      const g = groups.get(x.type) || groups.set(x.type, []).get(x.type);
      if (!g.some(function (h) { return h.id === x.key; })) g.push({ id: x.key, label: x.surface, df: df, items: others.slice(0, STICK_PER_HOOK).map(function (p) { return itemOf(p.o, ex, { dist: p.d == null ? null : +p.d.toFixed(2), far: p.d != null && p.d >= 0.9 }); }), more: Math.max(0, others.length - STICK_PER_HOOK) });
    });
    const out = Array.from(groups.entries()).map(function (kv) { return { type: kv[0], hooks: kv[1].sort(function (a, c) { return a.df - c.df; }) }; })
      .sort(function (a, c) { return c.hooks.length - a.hooks.length || (a.type < c.type ? -1 : 1); });
    return { burr: held, groups: out, clings: out.reduce(function (s, g) { return s + g.hooks.length; }, 0), common: common };
  };
  // Shelves for Stick: every fact sits on exactly one of veins (3+ hooks), grip (1 or 2), lone (none).
  // A hook is one the fact shares with 2 to 60 notes. Shuffled shelves (grip, lone) use a seed so paging is stable and a new seed gives a fresh handful;
  // they skip fragments (under 30 characters or under 5 words), which Reflection will deal with properly.
  let shelfCache = null;
  const shelfIndex = function () {
    if (shelfCache) return shelfCache;
    const c = { veins: [], grip: [], lone: [] };
    burrRows.forEach(function (r) {
      const hs = r.bristles.filter(function (x) { return x.df >= 2 && x.df <= 60; }), n = new Set(hs.map(function (x) { return x.k; })).size;
      const e = { r: r, n: n, rare: hs.length ? Math.min.apply(null, hs.map(function (x) { return x.df; })) : null, types: Array.from(new Set(hs.map(function (x) { return x.t; }))), hs: hs };
      e.sh = n >= 3 ? 'veins' : n >= 1 ? 'grip' : 'lone'; c[e.sh].push(e);
    });
    shelfCache = c; return c;
  };
  const rng = function (seed) { let t = (seed >>> 0) + 0x6D2B79F5; return function () { t = (t + 0x6D2B79F5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; };
  const isFragment = function (claim) { const c = String(claim || '').trim(); return c.length < 30 || c.split(/\s+/).length < 5; };
  const seenLive = new Set(), seedSnap = new Map();     // facts already shown on a shuffled shelf (this run); each seed freezes its own view so paging stays stable
  // shelf(name, o): name is veins, grip, lone, or all. Options: type (one kind, or several separated by commas), match ('any' of them, or 'every' one),
  // only (a Set of fact ids, for "Starred only"), page, size, seed, sort, dir. Lone facts have no kinds, so any kind filter leaves them out.
  // sort: 'shuffle' (the default: a seeded shuffle of the whole list, facts not yet shown first), 'surprise' (the seed picks one lens and a direction, and the answer says which),
  // or one lens: hooks, kinds, rarest (the fewest notes sharing a hook), length, note (A to Z), order (when extracted), rank (place within its note), notesize, date (the note's file date).
  // A lens sort is strict; facts that tie come in seeded random order. Facts a lens cannot measure (no hook, no date) come last in either direction.
  // The counts it returns are conditional on the other filters: typeCounts for the kind chips, shelves for the shelf tabs.
  const LENSES = {
    hooks: { dir: 'desc', val: function (e) { return e.n; } }, kinds: { dir: 'desc', val: function (e) { return e.types.length; } },
    rarest: { dir: 'asc', val: function (e) { return e.rare; } }, length: { dir: 'desc', val: function (e) { return e.r.claim.length; } },
    note: { dir: 'asc', val: function (e) { return String(e.r.note || '').toLowerCase(); } }, order: { dir: 'asc', val: function (e) { return e.r.id; } },
    rank: { dir: 'asc', val: function (e) { return e.r.rank; } }, notesize: { dir: 'desc', val: function (e) { return e.r.noteBurrs; } },
    date: { dir: 'desc', val: function (e) { const t = noteDate.get(e.r.noteId); return t == null ? null : t; } }
  };
  const flip = function (d) { return d === 'asc' ? 'desc' : 'asc'; };
  const rollLens = function (seed) { const keys = Object.keys(LENSES), r = rng((seed >>> 0) ^ 0x9E3779B9), key = keys[Math.floor(r() * keys.length)]; return { key: key, dir: r() < 0.5 ? LENSES[key].dir : flip(LENSES[key].dir) }; };
  const mix = function (arr, seed) { const rnd = rng(seed), a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
  // Sort by one lens: each fact's value is read once (not on every comparison), unmeasurable ones go last, and the sort is stable so ties keep their seeded random order.
  const orderBy = function (list, lens, dir) {
    const sign = dir === 'asc' ? 1 : -1, dec = list.map(function (e) { return { e: e, v: lens.val(e) }; });
    dec.sort(function (a, b) { const x = a.v, y = b.v; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x < y ? -sign : x > y ? sign : 0; });
    return dec.map(function (d) { return d.e; });
  };
  const shelf = function (name, o) {
    o = o || {}; const idx = shelfIndex(); if (name !== 'all' && !idx[name]) return null;
    const size = [12, 24, 48, 96].indexOf(o.size) >= 0 ? o.size : 12, types = String(o.type || '').split(',').filter(Boolean), every = o.match === 'every', only = o.only instanceof Set ? o.only : null;
    const overlay = function (e) { return !only || only.has(e.r.id); };
    const kindOk = function (e) { return !types.length || (every ? types.every(function (t) { return e.types.indexOf(t) >= 0; }) : types.some(function (t) { return e.types.indexOf(t) >= 0; })); };
    const typeCounts = {}; let list = [], hiddenFragments = 0; const counts = {};
    ['veins', 'grip', 'lone'].forEach(function (sn) { counts[sn] = idx[sn].filter(overlay).filter(kindOk).length; });
    counts.all = counts.veins + counts.grip + counts.lone;
    (name === 'all' ? ['veins', 'grip', 'lone'] : [name]).forEach(function (sn) {
      const base = idx[sn].filter(overlay);
      if (sn !== 'lone') base.forEach(function (e) { e.types.forEach(function (t) { typeCounts[t] = (typeCounts[t] || 0) + 1; }); });
      let part = base.filter(kindOk);
      if (sn === 'grip' || sn === 'lone') { const kept = only ? part : part.filter(function (e) { return !isFragment(e.r.claim); }); hiddenFragments += part.length - kept.length; part = kept; }
      list = list.concat(part);
    });
    const seed = o.seed == null ? 1 : o.seed;
    let sortKey = o.sort === 'surprise' || LENSES[o.sort] ? o.sort : 'shuffle', dir = o.dir === 'asc' || o.dir === 'desc' ? o.dir : null, rolled = false;
    if (sortKey === 'surprise') { const pick = rollLens(seed); sortKey = pick.key; dir = pick.dir; rolled = true; }
    if (LENSES[sortKey] && !dir) dir = LENSES[sortKey].dir;
    if (sortKey === 'shuffle') {       // each seed freezes the set of facts already shown when it was first used, so paging stays stable and a new seed puts the unseen first
      const sk = name + ':' + seed; if (!seedSnap.has(sk)) seedSnap.set(sk, new Set(seenLive)); const snap = seedSnap.get(sk);
      list = mix(list.filter(function (e) { return !snap.has(e.r.id); }), seed).concat(mix(list.filter(function (e) { return snap.has(e.r.id); }), seed));
    } else list = orderBy(mix(list, seed), LENSES[sortKey], dir);
    const pages = Math.max(1, Math.ceil(list.length / size)), page = Math.min(Math.max(o.page || 1, 1), pages);
    const pageRows = list.slice((page - 1) * size, page * size); if (sortKey === 'shuffle') pageRows.forEach(function (e) { seenLive.add(e.r.id); });
    const items = pageRows.map(function (e) {
      const r = e.r; return { id: r.id, noteId: r.noteId, note: r.note, claim: r.claim, quote: r.quote, nHooks: e.n, types: e.types, shelf: e.sh,
        hooks: e.hs.slice().sort(function (a, b) { return a.df - b.df; }).filter(function (x, i, arr) { return arr.findIndex(function (y) { return y.k === x.k; }) === i; }).slice(0, 4).map(function (x) { return { id: x.k, label: x.s, type: x.t, df: x.df }; }) };
    });
    return { name: name, total: list.length, page: page, pages: pages, size: size, items: items, hiddenFragments: hiddenFragments, typeCounts: typeCounts, shelves: counts, sort: { key: sortKey, dir: LENSES[sortKey] ? dir : null, rolled: rolled } };
  };
  // A random fact that has at least `min` hooks to cling to, for "Surprise me".
  const stickRandom = function (min, pick) {
    const pool = burrRows.filter(function (r) { return r.nB >= min && r.band !== 'none'; }); if (!pool.length) return null;
    for (let i = 0; i < 40; i++) { const r = pool[Math.floor((((pick ? pick() : Math.random()) + i * 0.6180339887) % 1) * pool.length)], s = stick(r.id); if (s && s.clings >= min) return s; }
    return null;
  };
  const suggest = function (q, limit) {
    const raw = String(q || '').toLowerCase().trim(); if (raw.length < 2) return [];
    // "Berlin ~ Merlin", "berlin - merlin", "berlin vs merlin" or just "berlin": every part must appear in a wordplay pair; a plain query also matches hooks.
    const parts = raw.split(/\s*(?:~|\u2013|\u2014|\s-\s|\/|\bvs\.?\b|\band\b)\s*/).filter(function (x) { return x.length >= 2; }), s = parts[0] || raw;
    const wp = wordplayRows.filter(function (r) { return r.pair && r.grade !== 'C' && parts.every(function (x) { return r._s.indexOf(x) >= 0; }); }).sort(function (a, b) { return (a.grade < b.grade ? -1 : a.grade > b.grade ? 1 : 0) || b.nNotes - a.nNotes; })
      .slice(0, 8).map(function (r) { return { id: r.id, label: r.surface, kind: 'wordplay', df: r.nNotes, sub: 'wordplay: ' + r.kind + ', grade ' + r.grade, a: r.a, b: r.b, wp: r.kind, grade: r.grade }; });
    const hooks = [];
    if (parts.length < 2) index.forEach(function (e, key) { const df = e.notes.size; if (df < 2 || df > 40 || L.isYearKey(key)) return; if (key.indexOf(s) < 0 && String(e.surface).toLowerCase().indexOf(s) < 0) return;
      hooks.push({ id: key, label: e.surface, kind: 'hook', df: df, starts: key.indexOf(s) === 0 ? 0 : 1 }); });
    hooks.sort(function (a, b) { return a.starts - b.starts || a.df - b.df || a.label.length - b.label.length; });
    return wp.concat(hooks.slice(0, (limit || 14) - wp.length));
  };
  // Browse wordplay pairs by kind (best grade, then most notes first).
  const wordplayPairs = function (kind, limit) {
    return wordplayRows.filter(function (r) { return r.pair && r.grade !== 'C' && (!kind || r.kind === kind); }).sort(function (a, b) { return (a.grade < b.grade ? -1 : a.grade > b.grade ? 1 : 0) || b.nNotes - a.nNotes; })
      .slice(0, limit || 60).map(function (r) { return { id: r.id, label: r.surface, kind: 'wordplay', df: r.nNotes, sub: r.kind + ', grade ' + r.grade, a: r.a, b: r.b, wp: r.kind, grade: r.grade }; });
  };
  const wordplayKinds = function () {
    const m = {}; wordplayRows.forEach(function (r) { if (r.pair && r.grade !== 'C') m[r.kind] = (m[r.kind] || 0) + 1; });
    return Object.keys(m).sort(function (a, b) { return m[b] - m[a]; }).map(function (k) { return { kind: k, n: m[k] }; });
  };

  const detail = function (view, id) {
    if (view !== 'bristles') return null;
    const e = index.get(id); if (!e) return null;
    return pickPerNote(e).slice(0, 25).map(brief);
  };
  const counts = {};
  [['burrs', burrRows], ['bristles', bristleRows], ['sparks', sparkRows], ['knots', knotRows]].forEach(function (p) {
    p[1].forEach(function (r) { r.recs.forEach(function (t) { (counts[t] = counts[t] || {})[p[0]] = ((counts[t] || {})[p[0]] || 0) + 1; }); }); });
  return { version: version, notes: NN, burrs: burrRows, bristles: bristleRows, sparks: sparkRows, knots: knotRows, slices: sliceRows, wordplay: wordplayRows, wordplayState: wpState, handle: handle, stick: stick, burrInfo: burrInfo, pile: pile, allPile: allPile, stickRandom: stickRandom, shelf: shelf, suggest: suggest, wordplayPairs: wordplayPairs, wordplayKinds: wordplayKinds, timeline: timeline, coarse: coarse, quantities: quantities, excluded: excluded, detail: detail, recCounts: counts,
    kinds: Array.from(new Set(burrRows.map(function (r) { return r.kind; }))).sort(),
    types: Array.from(new Set([].concat.apply([], bristleRows.map(function (r) { return r.types; })).concat(wordplayRows.length ? ['wordplay'] : []))).sort() };
}

module.exports = { sparkParts, sparkExclusion, build, REC, ITEM_LABELS, recsForKey, DURATION, REL, DEAD_END };
