'use strict';
// tagging.js: the slim tagger. It tags notes that have no tags, using the approved vocabulary and the ontology rules the author settled on; nothing else.
//   - proposals wait in tag_proposals (M020). A tag already in the vocabulary is approved at once; a new tag waits for the author's review.
//   - writeback merges APPROVED proposals into a note's frontmatter `tags:` line, dry run first, and only adds: it never removes or rewrites a tag the note has.
// Everything outside (database, model call, files) is passed in so tests use fakes. Nothing here commits to git, and no backup or scratch file is made in the vault.
const fs = require('fs'), path = require('path');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tag_proposals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id       INTEGER NOT NULL REFERENCES vault_notes(id) ON DELETE CASCADE,
  tag_full      TEXT NOT NULL,
  in_vocabulary INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by    TEXT,
  model         TEXT,
  prompt_version TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  written_at    TEXT,
  UNIQUE (note_id, tag_full)
);
CREATE INDEX IF NOT EXISTS idx_tag_proposals_status ON tag_proposals(status, in_vocabulary);
`;
const PROMPT_VERSION = 'tag-s2';   // s1 sent the whole vocabulary with every note; s2 sends none and maps the answer to the vocabulary in code
const STOP = new Set(['and', 'of', 'in', 'on', 'for', 'with', 'the', 'by', 'at']);
const MAX_TAGS = 6, MAX_BODY = 4000;

const clean = s => String(s || '').trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
// A tag is 1 to 3 hyphenated words per segment, at most 3 segments, no stopword joiners, no number first, no commas or sentence fragments.
function saneTag(t) {
  if (!t || t.length > 60 || /[^a-z0-9\-\/]/.test(t)) return false;
  const segs = t.split('/');
  if (segs.length > 3 || segs.some(s => !s)) return false;
  return segs.every(s => { const w = s.split('-'); return w.length <= 3 && w.every(x => x) && !STOP.has(w[0]) && !w.some(x => STOP.has(x)) && !/^\d/.test(s); });
}

// The approved tags come from the active pack (files.tagVocabulary). A pack with none starts empty: every tag the model names waits for the author's review.
function loadVocabulary(file) {
  file = file || require('./pack').current().files.tagVocabulary;
  if (!file) return new Set();
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set(j.tags.map(clean));
}
// The vocabulary the author has now: the exported file plus out-of-vocabulary tags the author approved since.
function vocabularyWithApproved(db, base) {
  const s = new Set(base);
  db.prepare("SELECT DISTINCT tag_full FROM tag_proposals WHERE status='approved'").all().forEach(r => s.add(r.tag_full));
  return s;
}

// No vocabulary here: the model names the tags, and mapToVocabulary (below) decides in code which of them are already in the vocabulary.
function buildPrompt(note) {
  const body = String(note.body || '').slice(0, MAX_BODY);
  const system = 'You tag personal knowledge notes against a strict ontology. Output only the one section requested.';
  const prompt = `Propose tags for this note. It has none yet.

Title: ${note.title}${note.source_url ? '\nSource URL: ' + note.source_url : ''}

Content:
${body}

Use the plain, broad, well-established name for a subject (British spelling: "maths", "colour"), the way a library would classify it.

ONTOLOGICAL PRINCIPLES (apply strictly):
1. Geography is a co-tag, never a parent: "india" + "culture/food", never "india/food", unless the concept has no existence outside that geography and is unambiguous without it.
2. Hierarchy resolves ambiguity only: use parent/leaf (e.g. "science/psychology") only when the bare leaf is genuinely ambiguous. A self-identifying term stays flat.
3. No attribution tags: an author's or publisher's name is not a subject.
4. Tag the general category, not a specific instance (not "rule-30" for a note on elementary cellular automata).
5. Never tag the same discipline twice under two roots.
6. A proper noun or place name is not on its own a tag; tag the concept it exemplifies.
7. 1-3 words per tag, hyphenated. No stopword joiners (and, of, in, on, for, with, the, by, at). No commas, no sentence fragments, no number as the leading token.

Give 1 to ${MAX_TAGS} tags, the fewest that cover the note.

Output EXACTLY this, nothing else:

## TAGS
one tag per line`;
  return { system, prompt };
}

// ---- Vocabulary mapping (deterministic) ---------------------------------------------------------------------------------------------------------------------------------
// The answer is mapped to the vocabulary by rules, never by asking the model again:
//   exact       the tag is in the vocabulary                                             -> approved
//   plural      the tag differs only by a trailing "s"                                   -> approved, as the vocabulary spells it
//   leaf        the tag is the last part of exactly ONE vocabulary tag ("psychology" -> science/psychology) -> approved as that tag
//   ambiguous   the tag is the last part of SEVERAL vocabulary tags ("history")          -> waits for review, with the candidates
//   none        nothing matches                                                          -> waits for review, with look-alike suggestions
function vocabIndex(vocab) {
  const exact = new Set(vocab), leaf = new Map();
  exact.forEach(t => { const l = t.split('/').pop(); if (!leaf.has(l)) leaf.set(l, []); leaf.get(l).push(t); });
  return { exact, leaf };
}
function mapToVocabulary(tag, idx) {
  if (idx.exact.has(tag)) return { tag, via: 'exact', inVocab: true };
  const alt = tag.endsWith('s') ? tag.slice(0, -1) : tag + 's';
  if (idx.exact.has(alt)) return { tag: alt, via: 'plural', inVocab: true };
  const l = idx.leaf.get(tag) || idx.leaf.get(alt);
  if (l && l.length === 1) return { tag: l[0], via: 'leaf', inVocab: true };
  if (l && l.length > 1) return { tag, via: 'ambiguous', inVocab: false, candidates: l.slice().sort() };
  return { tag, via: 'none', inVocab: false };
}
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
// "Did you mean" for the review screen only. Suggestions are never applied by themselves: a wrong merge would quietly put a wrong tag in a note.
function suggest(tag, vocab, n = 3) {
  const words = new Set(tag.split(/[-\/]/)), out = [];
  vocab.forEach(v => {
    const vw = v.split(/[-\/]/), shared = vw.filter(w => words.has(w)).length, last = v.split('/').pop();
    const score = (shared ? 2 + shared : 0) + (lev(tag, last) <= 2 && last.length >= 4 ? 3 : 0) + (last.startsWith(tag) || tag.startsWith(last) ? (Math.min(last.length, tag.length) >= 4 ? 2 : 0) : 0);
    if (score > 0) out.push({ v, score });
  });
  return out.sort((x, y) => y.score - x.score || x.v.localeCompare(y.v)).slice(0, n).map(x => x.v);
}

// Lines under "## TAGS" (or the whole text if there is no header). Returns { tags: [{ tag, raw, via, inVocab, candidates? }], rejected: [text that did not pass the shape rules] }.
function parseTags(text, vocab) {
  const idx = vocab && vocab.exact ? vocab : vocabIndex(vocab);
  const m = String(text || '').split(/^##\s*TAGS\s*$/mi);
  const part = m.length > 1 ? m[1] : String(text || '');
  const tags = [], rejected = [], seen = new Set();
  part.split('\n').forEach(l => {
    const raw = l.replace(/^\s*[-*\d.)]+\s*/, '').trim(); if (!raw || /^##/.test(raw)) return;
    const t = clean(raw);
    if (!saneTag(t)) { rejected.push(raw.slice(0, 60)); return; }
    const m = mapToVocabulary(t, idx); if (seen.has(m.tag)) return; seen.add(m.tag); tags.push(Object.assign({ raw: t }, m));
  });
  return { tags: tags.slice(0, MAX_TAGS), rejected };
}

// Untagged notes with no proposals yet, shortest first (cheapest and quickest to review).
function candidates(db, { limit = 0, note = 0 } = {}) {
  if (note) return db.prepare('SELECT id,rel_path,title,source_url,word_count FROM vault_notes WHERE id=?').all(note);
  const sql = "SELECT id,rel_path,title,source_url,word_count FROM vault_notes n WHERE has_tags=0 AND COALESCE(quarry_exclude,0)=0 AND COALESCE(word_count,0)>=20 " +
    "AND NOT EXISTS (SELECT 1 FROM tag_proposals p WHERE p.note_id=n.id) ORDER BY word_count ASC, id ASC" + (limit ? ' LIMIT ' + (limit | 0) : '');
  return db.prepare(sql).all();
}

function readBody(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? raw.slice(m[0].length) : raw).trim();
}

function saveProposals(db, noteId, tags, { model, now = () => new Date().toISOString() } = {}) {
  const ins = db.prepare("INSERT OR IGNORE INTO tag_proposals (note_id,tag_full,in_vocabulary,status,decided_by,model,prompt_version,created_at,decided_at) VALUES (?,?,?,?,?,?,?,?,?)");
  let auto = 0, waiting = 0;
  tags.forEach(t => {
    if (t.inVocab) { ins.run(noteId, t.tag, 1, 'approved', t.via === 'exact' || !t.via ? 'vocabulary' : 'vocabulary-' + t.via, model || null, PROMPT_VERSION, now(), now()); auto++; }
    else { ins.run(noteId, t.tag, 0, 'pending', null, model || null, PROMPT_VERSION, now(), null); waiting++; }
  });
  return { auto, waiting };
}

// ---- Review (shared by the command line and the Admin page) ------------------------------------------------------------------------------------------------------------
// The new tags waiting for a decision, most-used first, one page at a time. Each carries what the author needs to decide: how many notes, a few titles, the candidates when a short
// name is ambiguous, and look-alike vocabulary tags. filter: all | suggestion | ambiguous | once | none. q: part of a tag name. Reads only. total = every waiting tag;
// matching = those that pass the filter and the search (what the pager pages through).
function pending(db, vocab, { limit = 30, offset = 0, filter = 'all', q = '' } = {}) {
  const idx = vocabIndex(vocab), total = db.prepare("SELECT COUNT(DISTINCT tag_full) n FROM tag_proposals WHERE status='pending' AND in_vocabulary=0").get().n;
  const like = '%' + String(q || '').replace(/[\\%_]/g, c => '\\' + c) + '%';
  let rows = db.prepare("SELECT tag_full, COUNT(*) n FROM tag_proposals WHERE status='pending' AND in_vocabulary=0 AND tag_full LIKE ? ESCAPE '\\' GROUP BY tag_full ORDER BY n DESC, tag_full").all(like);
  if (filter === 'once') rows = rows.filter(r => r.n === 1);
  const titles = db.prepare("SELECT n.title FROM tag_proposals p JOIN vault_notes n ON n.id=p.note_id WHERE p.tag_full=? AND p.status='pending' LIMIT 3");
  const describe = r => { const m = mapToVocabulary(r.tag_full, idx), candidates = m.candidates || [];
    return { tag: r.tag_full, notes: r.n, titles: titles.all(r.tag_full).map(x => String(x.title)), candidates, suggestions: candidates.length ? [] : suggest(r.tag_full, vocab) }; };
  const o = offset | 0, l = limit | 0 || 30;
  if (filter === 'ambiguous' || filter === 'suggestion' || filter === 'none') {   // these need the look-alike work for every row, so it is done only when asked for
    const all = rows.map(describe).filter(g => filter === 'ambiguous' ? g.candidates.length : filter === 'suggestion' ? g.suggestions.length : !g.candidates.length && !g.suggestions.length);
    return { total, matching: all.length, shown: Math.min(l, Math.max(0, all.length - o)), waiting: all.slice(o, o + l) };
  }
  const page = rows.slice(o, o + l).map(describe);
  return { total, matching: rows.length, shown: page.length, waiting: page };
}
// action: accept (the tag joins the vocabulary), reject, or map (use the vocabulary tag `to` instead). Only pending, out-of-vocabulary proposals change. Returns how many notes.
function decide(db, vocab, tag, action, to, now = () => new Date().toISOString()) {
  const e = m => { const x = new Error(m); x.userError = true; return x; };
  if (!['accept', 'reject', 'map'].includes(action)) throw e('Unknown action: ' + action);
  const rows = db.prepare("SELECT id, note_id FROM tag_proposals WHERE tag_full=? AND status='pending' AND in_vocabulary=0").all(tag);
  if (!rows.length) throw e('No pending proposals for ' + tag + '.');
  if (action === 'map') {
    if (!to || !vocab.has(to)) throw e('Map to a tag that is in the vocabulary. "' + to + '" is not.');
    const has = db.prepare('SELECT 1 FROM tag_proposals WHERE note_id=? AND tag_full=?'), mv = db.prepare("UPDATE tag_proposals SET tag_full=?, in_vocabulary=1, status='approved', decided_by='author-map', decided_at=? WHERE id=?"), del = db.prepare('DELETE FROM tag_proposals WHERE id=?');
    rows.forEach(r => has.get(r.note_id, to) ? del.run(r.id) : mv.run(to, now(), r.id));
    return { notes: rows.length };
  }
  db.prepare("UPDATE tag_proposals SET status=?, decided_by='author', decided_at=? WHERE tag_full=? AND status='pending' AND in_vocabulary=0").run(action === 'accept' ? 'approved' : 'rejected', now(), tag);
  return { notes: rows.length };
}

// ---- Frontmatter tags (the three forms Obsidian notes use) ---------------------------------------------------------------------------------------------------------------
function splitFrontmatter(raw) {
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/);
  return m ? { fm: m[1], body: raw.slice(m[1].length) } : { fm: '', body: raw };
}
function extractTags(fm) {
  if (!fm) return { tags: [], info: null };
  let m = fm.match(/^tags:[ \t]*((?:#\S+[ \t]*)+)$/m);
  if (m) return { tags: m[0].match(/#(\S+)/g).map(t => t.slice(1)), info: { type: 'hash', match: m[0] } };
  m = fm.match(/^tags:[ \t]*\[([^\]]*)\][ \t]*$/m);
  if (m) return { tags: m[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean), info: { type: 'flow', match: m[0] } };
  m = fm.match(/^tags:[ \t]*\r?\n((?:[ \t]*-[ \t]+(?!--[ \t]*$).+\r?\n?)+)/m);
  if (m) return { tags: m[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '')).filter(Boolean), info: { type: 'block', match: m[0] } };
  m = fm.match(/^tags:[ \t]*(\S.*)$/m);   // tags: a, b
  if (m && !/^[\[#]/.test(m[1])) return { tags: m[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean), info: { type: 'plain', match: m[0] } };
  return { tags: [], info: null };
}
// Only adds: the note's own tags stay exactly as written and in order; new ones follow. Returns the new full text, or null when nothing would change.
function mergeTagsInto(raw, add) {
  const { fm, body } = splitFrontmatter(raw), { tags, info } = extractTags(fm);
  const have = new Set(tags.map(t => t.toLowerCase())), fresh = add.filter(t => !have.has(t.toLowerCase()));
  if (!fresh.length) return null;
  const all = tags.concat(fresh), line = 'tags: [' + all.map(t => '"' + t + '"').join(', ') + ']';
  if (!fm) return '---\n' + line + '\n---\n' + raw;
  if (!info) return fm.replace(/^---\r?\n/, m => m + line + '\n') + body;
  return fm.replace(info.match, info.type === 'block' ? line + '\n' : line) + body;
}

// Where tags are written: the REAL vault (the one Obsidian and git use), never Muse's indexed copy, which the next vault sync would overwrite. The same variable the vault-sync task reads.
function writebackRoot(env) {
  const dir = env.MUSE_VAULT_SRC || path.join(env.HOME || '', 'md-vaults', 'knowledge');
  if (!fs.existsSync(dir)) { const e = new Error('The real vault is not at ' + dir + ' (set MUSE_VAULT_SRC). Tags are written there, not into Muse\u2019s copy.'); e.userError = true; throw e; }
  return dir;
}

// What would be written (or is written, when confirm): per note, the approved tags not yet in the file. `log` is called per written note with { id, rel_path, before, after }.
function writeback(db, root, toAbs, { confirm = false, limit = 0, log = () => {}, now = () => new Date().toISOString() } = {}) {
  const rows = db.prepare("SELECT n.id, n.rel_path FROM vault_notes n WHERE EXISTS (SELECT 1 FROM tag_proposals p WHERE p.note_id=n.id AND p.status='approved' AND p.written_at IS NULL) ORDER BY n.id" + (limit ? ' LIMIT ' + (limit | 0) : '')).all();
  const approved = db.prepare("SELECT tag_full FROM tag_proposals WHERE note_id=? AND status='approved' AND written_at IS NULL ORDER BY tag_full");
  const done = db.prepare("UPDATE tag_proposals SET written_at=? WHERE note_id=? AND status='approved' AND written_at IS NULL");
  const out = { notes: rows.length, would: 0, written: 0, unchanged: 0, missing: 0, plan: [] };
  rows.forEach(n => {
    const file = toAbs(n.rel_path, root);
    if (!fs.existsSync(file)) { out.missing++; return; }
    const raw = fs.readFileSync(file, 'utf8'), add = approved.all(n.id).map(r => r.tag_full), next = mergeTagsInto(raw, add);
    if (next === null) { out.unchanged++; if (confirm) done.run(now(), n.id); return; }
    const before = extractTags(splitFrontmatter(raw).fm).tags, after = extractTags(splitFrontmatter(next).fm).tags;
    out.would++; out.plan.push({ id: n.id, rel_path: n.rel_path, added: after.filter(t => !before.includes(t)), before });
    if (!confirm) return;
    fs.writeFileSync(file, next, 'utf8'); done.run(now(), n.id); out.written++;
    log({ ts: now(), id: n.id, rel_path: n.rel_path, before, after });
  });
  return out;
}

module.exports = { SCHEMA_SQL, PROMPT_VERSION, MAX_TAGS, clean, saneTag, loadVocabulary, vocabularyWithApproved, vocabIndex, mapToVocabulary, suggest, buildPrompt, parseTags, pending, decide, candidates, readBody, saveProposals,
  splitFrontmatter, extractTags, mergeTagsInto, writebackRoot, writeback };
