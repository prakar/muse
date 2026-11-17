'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const T = require('../code/lib/tagging'), Tagger = require('../code/tagger'), Paths = require('../code/lib/note_path');
const ROOT = path.join(__dirname, '..');

// A real, freshly migrated database in a temp folder, with a vault of three notes: untagged, tagged, and untagged-but-excluded.
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tagging-')), dbFile = path.join(dir, 'vault.db'), vault = path.join(dir, 'vault'); fs.mkdirSync(path.join(vault, '2026'), { recursive: true });
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(ROOT, 'code', 'migrate.js'), '--run'], { env: { ...process.env, QUARRY_DB: dbFile, QUARRY_HOME: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout.slice(-300));
  const db = new DatabaseSync(dbFile), put = (rel, text, hasTags, excl) => {
    fs.writeFileSync(path.join(vault, rel), text);
    return Number(db.prepare('INSERT INTO vault_notes (rel_path,title,word_count,has_tags,quarry_exclude,indexed_at) VALUES (?,?,?,?,?,?)').run(rel, path.basename(rel, '.md'), 60, hasTags, excl, 'x').lastInsertRowid);
  };
  const body = 'Thebaine is an opiate that is named after the Egyptian city of Thebes. '.repeat(4);
  const a = put('2026/Thebaine.md', '---\ntitle: Thebaine\n---\n' + body, 0, 0), b = put('2026/Tagged.md', '---\ntags: [maths]\n---\n' + body, 1, 0), c = put('2026/Excluded.md', body, 0, 1);
  return { dir, dbFile, vault, db, a, b, c };
}
const vocab = new Set(['chemistry', 'history', 'maths', 'science/psychology']);

test('the exported vocabulary is a real list of clean tags', () => {
  const v = T.loadVocabulary(); assert.ok(v.size > 400); for (const t of v) assert.ok(T.saneTag(t) || t.split('/').length > 3 || /\d/.test(t), 'odd vocabulary tag: ' + t);
  assert.ok(v.has('architecture/brutalism'));
});

test('a tag is sane only if it follows the ontology rules of shape', () => {
  ['maths', 'science/psychology', 'cellular-automata', 'arts/movements/dadaism'].forEach(t => assert.ok(T.saneTag(t), t));
  ['history-of-art', 'rule 30', '3d-printing', 'a/b/c/d', 'x,y', '', 'one-two-three-four', 'the-thing'].forEach(t => assert.ok(!T.saneTag(t), t));
});

const V = new Set(['chemistry', 'maths', 'science/psychology', 'arts/history', 'sports/history', 'architecture/brutalism']);

test('mapping to the vocabulary is by rule: exact, plural, a unique last part, ambiguous, or none', () => {
  const idx = T.vocabIndex(V), m = t => T.mapToVocabulary(t, idx);
  assert.deepEqual(m('maths'), { tag: 'maths', via: 'exact', inVocab: true });
  assert.deepEqual(m('chemistries'), { tag: 'chemistries', via: 'none', inVocab: false }, 'only a plain trailing s counts as plural');
  assert.equal(m('maths').tag, 'maths'); assert.deepEqual(m('mathss'), { tag: 'maths', via: 'plural', inVocab: true });
  assert.deepEqual(m('psychology'), { tag: 'science/psychology', via: 'leaf', inVocab: true });
  assert.deepEqual(m('brutalism'), { tag: 'architecture/brutalism', via: 'leaf', inVocab: true });
  assert.deepEqual(m('history'), { tag: 'history', via: 'ambiguous', inVocab: false, candidates: ['arts/history', 'sports/history'] });
  assert.deepEqual(m('etymology'), { tag: 'etymology', via: 'none', inVocab: false });
});

test('suggestions are look-alikes for the review screen only', () => {
  assert.ok(T.suggest('brutalist', V).includes('architecture/brutalism')); assert.ok(T.suggest('psycology', V).includes('science/psychology'));
  assert.deepEqual(T.suggest('etymology', V), []);
});

test('parseTags reads the TAGS section, cleans, maps to the vocabulary, de-duplicates and rejects bad shapes', () => {
  const r = T.parseTags('chatter\n## TAGS\n- Chemistry\n#psychology\n1. etymology\npsychology\nhistory of art\nhistory\n', V);
  assert.deepEqual(r.tags.map(t => [t.raw, t.tag, t.via, t.inVocab]), [['chemistry', 'chemistry', 'exact', true], ['psychology', 'science/psychology', 'leaf', true], ['etymology', 'etymology', 'none', false], ['history', 'history', 'ambiguous', false]]);
  assert.deepEqual(r.rejected, ['history of art']); assert.equal(T.parseTags('', V).tags.length, 0);
});

test('the prompt carries the rules and the note, and NO vocabulary list', () => {
  const p = T.buildPrompt({ title: 'Thebaine', body: 'It is named after Thebes.', source_url: null });
  assert.match(p.prompt, /Geography is a co-tag/); assert.match(p.prompt, /It is named after Thebes/); assert.match(p.prompt, /## TAGS/); assert.ok(!/VOCABULARY/i.test(p.prompt)); assert.ok(p.prompt.length < 3000, 'a short prompt');
});

test('merging adds tags in every frontmatter form, keeps the note’s own tags and order, and returns null when nothing is new', () => {
  assert.equal(T.mergeTagsInto('---\ntags: [b, a]\n---\nx', ['c']), '---\ntags: ["b", "a", "c"]\n---\nx');
  assert.equal(T.mergeTagsInto('---\ntags: #b #a\n---\nx', ['c']), '---\ntags: ["b", "a", "c"]\n---\nx');
  assert.equal(T.mergeTagsInto('---\ntitle: t\ntags:\n  - b\n  - a\n---\nx', ['c']), '---\ntitle: t\ntags: ["b", "a", "c"]\n---\nx');
  assert.equal(T.mergeTagsInto('---\ntitle: t\n---\nx', ['c']), '---\ntags: ["c"]\ntitle: t\n---\nx');
  assert.equal(T.mergeTagsInto('plain body', ['c']), '---\ntags: ["c"]\n---\nplain body');
  assert.equal(T.mergeTagsInto('---\ntags: [A]\n---\nx', ['a']), null, 'case-insensitive: already there');
});

test('tagging: candidates exclude tagged and excluded notes; in-vocabulary tags are approved, new ones wait; the model is asked for the economy profile', async () => {
  const s = setup(), calls = [];
  assert.deepEqual(T.candidates(s.db).map(r => r.id), [s.a]);
  const out = await Tagger.tagNotes(s.db, { dryRun: false, limit: 0, note: 0, provider: 'claude', ceiling: 5 }, { vocab, root: s.vault,
    callLLM: async (p, prompt, o) => { calls.push({ p, o, prompt }); return { text: '## TAGS\nhistory\netymology\npsychology', model: 'm', tokensIn: 1000, tokensOut: 20 }; } });
  assert.equal(calls.length, 1); assert.ok(!/chemistry, history/.test(calls[0].prompt), 'the vocabulary is not sent'); assert.equal(calls[0].o.profile, 'economy'); assert.equal(calls[0].o.label, 'tagger');
  assert.deepEqual({ tagged: out.tagged, auto: out.auto, waiting: out.waiting }, { tagged: 1, auto: 2, waiting: 1 });
  const rows = s.db.prepare('SELECT tag_full, status, in_vocabulary, decided_by FROM tag_proposals ORDER BY tag_full').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [{ tag_full: 'etymology', status: 'pending', in_vocabulary: 0, decided_by: null }, { tag_full: 'history', status: 'approved', in_vocabulary: 1, decided_by: 'vocabulary' }, { tag_full: 'science/psychology', status: 'approved', in_vocabulary: 1, decided_by: 'vocabulary-leaf' }]);
  
  assert.deepEqual(T.candidates(s.db), [], 'a note with proposals is not tagged twice');
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM api_budget WHERE component='tagger'").get().n, 1, 'spend recorded');
});

test('a dry run calls nothing and writes nothing', async () => {
  const s = setup(); let n = 0;
  await Tagger.tagNotes(s.db, { dryRun: true, limit: 0, note: 0, provider: 'claude' }, { vocab, root: s.vault, callLLM: async () => { n++; return {}; } });
  assert.equal(n, 0); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM tag_proposals').get().n, 0);
});

test('decide: map rewrites a waiting tag to a vocabulary tag, accept and reject change only waiting out-of-vocabulary tags, and a wrong target is refused', () => {
  const s = setup(); T.saveProposals(s.db, s.a, [{ tag: 'psycology', inVocab: false }, { tag: 'etymology', inVocab: false }]);
  assert.throws(() => T.decide(s.db, vocab, 'psycology', 'map', 'not-in-vocab'), /in the vocabulary/); assert.throws(() => T.decide(s.db, vocab, 'nothing', 'accept'), /No pending/); assert.throws(() => T.decide(s.db, vocab, 'etymology', 'burn'), /Unknown action/);
  assert.deepEqual(T.decide(s.db, vocab, 'psycology', 'map', 'science/psychology'), { notes: 1 });
  const r = s.db.prepare("SELECT tag_full,status,decided_by FROM tag_proposals ORDER BY tag_full").all().map(x => ({ ...x }));
  assert.deepEqual(r, [{ tag_full: 'etymology', status: 'pending', decided_by: null }, { tag_full: 'science/psychology', status: 'approved', decided_by: 'author-map' }]);
  assert.throws(() => T.decide(s.db, vocab, 'psycology', 'accept'), /No pending/, 'already decided');
  const w = T.pending(s.db, vocab); assert.equal(w.total, 1); assert.equal(w.waiting[0].tag, 'etymology');
});

test('pending is paged and filtered by the server; decisions can be applied in one batch', async () => {
  const s = setup(), many = Array.from({ length: 30 }, (_, i) => ({ tag: 'topic' + String.fromCharCode(97 + (i % 26)) + (i > 25 ? 'x' : ''), inVocab: false }));
  T.saveProposals(s.db, s.a, many.slice(0, 20)); T.saveProposals(s.db, s.b, [{ tag: 'topica', inVocab: false }]); T.saveProposals(s.db, s.c, [{ tag: 'history', inVocab: false }]);
  const p1 = T.pending(s.db, vocab, { limit: 8, offset: 0 }), p3 = T.pending(s.db, vocab, { limit: 8, offset: 16 });
  assert.equal(p1.total, 21); assert.equal(p1.matching, 21); assert.equal(p1.waiting.length, 8); assert.equal(p3.waiting.length, 5); assert.equal(p1.waiting[0].tag, 'topica', 'most-used first (two notes)');
  assert.equal(T.pending(s.db, vocab, { filter: 'once' }).matching, 20); assert.equal(T.pending(s.db, vocab, { q: 'topicb' }).matching, 1);
  assert.deepEqual(T.pending(s.db, vocab, { filter: 'ambiguous' }).waiting.map(g => g.tag), [], 'history is exact in this small vocabulary, so it is not ambiguous');
  assert.equal(T.pending(s.db, vocab, { filter: 'none' }).matching, 21 - T.pending(s.db, vocab, { filter: 'suggestion' }).matching);
  const code = process.exitCode, quiet = console.error; console.error = () => {};   // one decision fails on purpose, which sets the exit code and prints
  let out; try { out = await Tagger.run(Tagger.parseArgs(['--decide-batch', 'topica|accept|;topicb|reject|;nothing|accept|']), { db: s.db, vocab }); } finally { console.error = quiet; assert.equal(process.exitCode, 1, 'a failed decision makes the job fail'); process.exitCode = code; }
  assert.deepEqual(out, { ok: 2, failed: 1 }); assert.equal(T.pending(s.db, vocab).total, 19);
});

test('the Admin tasks: tag is paid with a typed count, writeback has a dry run and a typed count, decide is one small job', () => {
  const Cat = require('../code/lib/ops_catalogue'), s = setup(), ctx = { home: s.dir, dbPath: s.dbFile, version: 'x', env: {} };
  const dry = Cat.plan('tag', { limit: 5 }, { ctx }); assert.deepEqual(dry.steps[0].args, ['--limit', '5', '--provider', 'gemini', '--dry-run']); assert.equal(dry.dry, true);
  assert.throws(() => Cat.plan('tag', { limit: 5 }, { go: true, ctx }), /Confirmation needed: this affects 1/); assert.ok(!Cat.plan('tag', { limit: 5 }, { go: true, expect: 1, ctx }).steps[0].args.includes('--dry-run'));
  T.saveProposals(s.db, s.a, [{ tag: 'history', inVocab: true }]);
  assert.throws(() => Cat.plan('tag-writeback', {}, { go: true, expect: 7, ctx }), /affects 1/); assert.deepEqual(Cat.plan('tag-writeback', {}, { go: true, expect: 1, ctx }).steps[0].args, ['--writeback', '--confirm']);
  assert.deepEqual(Cat.plan('tag-decide', { decisions: 'a/b|map|c;d|reject|' }, { ctx }).steps[0].args, ['--decide-batch', 'a/b|map|c;d|reject|']);
  assert.throws(() => Cat.plan('tag-decide', { decisions: 'A B; rm -rf' }, { ctx }), /not allowed/);
  const w = require('../code/lib/ops_internal').tagsWaiting({ dbPath: s.dbFile }); assert.equal(w.available, true); assert.equal(w.approvedUnwritten, 1);
});

test('review: accepting a new tag approves it everywhere and adds it to the vocabulary; rejecting leaves it out', async () => {
  const s = setup(); T.saveProposals(s.db, s.a, [{ tag: 'etymology', inVocab: false }, { tag: 'trivia', inVocab: false }]);
  const answers = ['a', 'r']; await Tagger.review(s.db, async () => answers.shift());
  const st = Object.fromEntries(s.db.prepare('SELECT tag_full, status FROM tag_proposals').all().map(r => [r.tag_full, r.status]));
  assert.deepEqual(st, { etymology: 'approved', trivia: 'rejected' });
  assert.ok(T.vocabularyWithApproved(s.db, vocab).has('etymology')); assert.ok(!T.vocabularyWithApproved(s.db, vocab).has('trivia'));
});

test('writeback: dry run changes no file; confirm adds only approved tags, keeps the note’s own, logs, and is not repeated', () => {
  const s = setup(); T.saveProposals(s.db, s.a, [{ tag: 'history', inVocab: true }, { tag: 'etymology', inVocab: false }]);   // history approved, etymology pending
  const file = path.join(s.vault, '2026/Thebaine.md'), before = fs.readFileSync(file, 'utf8'), logs = [];
  const dry = T.writeback(s.db, s.vault, Paths.toAbs, {}); assert.equal(dry.would, 1); assert.equal(fs.readFileSync(file, 'utf8'), before, 'dry run wrote nothing');
  assert.deepEqual(dry.plan[0].added, ['history']);
  const real = T.writeback(s.db, s.vault, Paths.toAbs, { confirm: true, log: e => logs.push(e) });
  assert.equal(real.written, 1); assert.match(fs.readFileSync(file, 'utf8'), /^---\ntags: \["history"\]\ntitle: Thebaine\n---\n/);
  assert.equal(logs.length, 1); assert.deepEqual(logs[0].after, ['history']);
  assert.deepEqual(fs.readdirSync(path.join(s.vault, '2026')).sort(), ['Excluded.md', 'Tagged.md', 'Thebaine.md'], 'no backup or scratch file in the vault');
  assert.equal(T.writeback(s.db, s.vault, Paths.toAbs, { confirm: true }).notes, 0, 'already written: nothing to do');
});

test('writeback never removes a tag the note already has', () => {
  const s = setup(); T.saveProposals(s.db, s.b, [{ tag: 'history', inVocab: true }]);
  T.writeback(s.db, s.vault, Paths.toAbs, { confirm: true });
  assert.match(fs.readFileSync(path.join(s.vault, '2026/Tagged.md'), 'utf8'), /^---\ntags: \["maths", "history"\]\n---\n/);
});

test('the command line refuses --confirm without --writeback and unknown flags', () => {
  assert.throws(() => Tagger.parseArgs(['--confirm']), /--writeback/); assert.throws(() => Tagger.parseArgs(['--nope']), /Unknown/);
  assert.equal(Tagger.parseArgs(['--writeback']).confirm, false, 'dry run is the default');
});
