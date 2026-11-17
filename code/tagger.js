#!/usr/bin/env node
'use strict';
/**
 * QUARRY slim tagger: tags notes that have no tags, from the approved vocabulary (code/data/tag_vocabulary.json) and the ontology rules in lib/tagging.js.
 *
 *   node code/tagger.js --dry-run [--limit N]          count the untagged notes and estimate the cost. No LLM call, nothing written.
 *   node code/tagger.js --limit N [--provider P]       tag N untagged notes (shortest first). In-vocabulary tags are approved at once; new tags wait for review.
 *   node code/tagger.js --note ID                      one note
 *   node code/tagger.js --decide TAG --action accept|reject|map [--to VOCAB_TAG]   one decision (what the Admin page runs)
 *   node code/tagger.js --decide-batch "tag|action|to;tag|action|to"   many decisions at once (what the Admin page applies)
 *   node code/tagger.js --review                       decide the new (out-of-vocabulary) tags, one tag at a time: [a]ccept [r]eject [s]kip [q]uit
 *   node code/tagger.js --writeback                    DRY RUN: show the tags that would be added to note frontmatter
 *   node code/tagger.js --writeback --confirm [--limit N]   write them. Only adds tags; never commits; the vault's own git plugin picks the change up.
 *   node code/tagger.js --status
 *
 * Writes to the database (tag_proposals, api_budget) and, only with --writeback --confirm, to the `tags:` line of note frontmatter. The model is chosen by llm-model-resolver
 * (economy profile). Writeback is logged to muse-tag-writeback.jsonl beside the database, never inside the vault. The tags are written into the REAL vault (MUSE_VAULT_SRC, default ~/md-vaults/knowledge), never Muse's copy, which the next vault sync would overwrite. After a writeback, bring the vault in (vault-sync, then index) so vault.db sees the tags.
 */
const fs = require('fs'), path = require('path'), readline = require('readline');
const T = require('./lib/tagging'), Bud = require('./lib/budget'), Paths = require('./lib/note_path');
const MAX_CONSEC_ERRORS = 5, EST_PROMPT_TOKENS = 900, EST_OUT_TOKENS = 40;   // rules plus the note's first 4,000 characters; no vocabulary list

function parseArgs(argv) {
  const a = { dryRun: false, limit: 0, note: 0, provider: 'gemini', ceiling: null, review: false, decide: '', decideBatch: '', action: '', to: '', writeback: false, confirm: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true; else if (k === '--limit') a.limit = parseInt(argv[++i], 10) || 0; else if (k === '--note') a.note = parseInt(argv[++i], 10) || 0;
    else if (k === '--provider') a.provider = argv[++i]; else if (k === '--ceiling') a.ceiling = parseFloat(argv[++i]); else if (k === '--review') a.review = true; else if (k === '--decide') a.decide = argv[++i]; else if (k === '--decide-batch') a.decideBatch = argv[++i]; else if (k === '--action') a.action = argv[++i]; else if (k === '--to') a.to = argv[++i];
    else if (k === '--writeback') a.writeback = true; else if (k === '--confirm') a.confirm = true; else if (k === '--status') a.status = true;
    else throw new Error('Unknown argument: ' + k);
  }
  if (a.confirm && !a.writeback) throw new Error('--confirm belongs with --writeback.');
  return a;
}
const now = () => new Date().toISOString();

async function tagNotes(db, a, deps) {
  const vocab = T.vocabularyWithApproved(db, deps.vocab || T.loadVocabulary());
  const cands = T.candidates(db, a), rate = Bud.priceFor(a.provider, null, 0);
  const est = rate ? cands.length * (EST_PROMPT_TOKENS * rate.in + EST_OUT_TOKENS * rate.out) / 1e6 : 0;
  console.log('Untagged notes to tag: ' + cands.length + ' | vocabulary ' + vocab.size + ' tags | provider ' + a.provider + ' | est. cost $' + est.toFixed(3));
  if (a.dryRun || !cands.length) return { candidates: cands.length, est };
  const callLLM = deps.callLLM || require('./lib/llm').callLLM;
  if (!deps.callLLM && !require('./lib/llm').hasKey(a.provider)) throw new Error('No API key for provider ' + a.provider);
  const root = deps.root || Paths.vaultRoot(process.env, process.env.QUARRY_HOME || path.join(__dirname, '..'));
  const tally = { tagged: 0, auto: 0, waiting: 0, none: 0, error: 0, cost: 0 }; let consec = 0, stopped = '';
  for (const row of cands) {
    try {
      Bud.checkBudget(db, a.provider, a.ceiling);
      const body = T.readBody(Paths.toAbs(row.rel_path, root));
      const p = T.buildPrompt({ title: row.title || path.basename(row.rel_path, '.md'), source_url: row.source_url, body });
      const r = await callLLM(a.provider, p.prompt, { system: p.system, maxTokens: 300, temperature: 0, thinkingBudget: 0, profile: 'economy', label: 'tagger' });
      tally.cost += Bud.recordSpend(db, a.provider, 'tagger', row.id, r.tokensIn, r.tokensOut, r.model, (m, d) => console.warn(m, d || '')) || 0;
      const parsed = T.parseTags(r.text, vocab);
      if (!parsed.tags.length) { tally.none++; console.log('  note ' + row.id + ': no usable tags' + (parsed.rejected.length ? ' (rejected: ' + parsed.rejected.join(' | ') + ')' : '')); }
      else { const s = T.saveProposals(db, row.id, parsed.tags, { model: r.model }); tally.tagged++; tally.auto += s.auto; tally.waiting += s.waiting; console.log('  note ' + row.id + ' ' + (row.title || '').slice(0, 50) + ': ' + parsed.tags.map(t => t.raw + (t.inVocab ? (t.via === 'exact' ? '' : ' (→ ' + t.tag + ', ' + t.via + ')') : ' (new' + (t.candidates ? ', ambiguous: ' + t.candidates.join(' | ') : '') + ')')).join(', ')); }
      consec = 0;
    } catch (e) {
      if (e instanceof Bud.BudgetError) { stopped = e.message; break; }
      tally.error++; consec++; console.error('note ' + row.id + ': ' + e.message);
      if (consec >= MAX_CONSEC_ERRORS) { stopped = MAX_CONSEC_ERRORS + ' errors in a row; stopping'; break; }
    }
  }
  console.log('Done: ' + JSON.stringify(tally) + (stopped ? '\nSTOPPED: ' + stopped : '')); if (stopped) process.exitCode = 1;
  return tally;
}

async function review(db, ask, vocabBase) {
  const vocab = T.vocabularyWithApproved(db, vocabBase || T.loadVocabulary()), pend = T.pending(db, vocab, { limit: 500 });
  if (!pend.waiting.length) { console.log('No new tags are waiting for review.'); return { decided: 0 }; }
  console.log(pend.total + ' new tags waiting. Tags already in the vocabulary were approved automatically.\n');
  let decided = 0;
  for (let i = 0; i < pend.waiting.length; i++) {
    const g = pend.waiting[i], opts = g.candidates.length ? g.candidates : g.suggestions;
    console.log('[' + (i + 1) + '/' + pend.waiting.length + '] ' + g.tag + '  (' + g.notes + ' note' + (g.notes === 1 ? '' : 's') + ': ' + g.titles.map(t => '"' + t.slice(0, 40) + '"').join(', ') + ')');
    if (opts.length) console.log('  ' + (g.candidates.length ? 'ambiguous, could be: ' : 'looks like: ') + opts.map((o, k) => (k + 1) + ') ' + o).join('  '));
    const ans = String(await ask('  [a]ccept as new  [r]eject  ' + (opts.length ? '[1-' + opts.length + '] use that one  ' : '') + '[s]kip  [q]uit > ')).trim().toLowerCase();
    if (ans[0] === 'q') break;
    try {
      if (ans[0] === 'a') { T.decide(db, vocab, g.tag, 'accept'); decided++; } else if (ans[0] === 'r') { T.decide(db, vocab, g.tag, 'reject'); decided++; }
      else if (/^\d+$/.test(ans) && opts[Number(ans) - 1]) { T.decide(db, vocab, g.tag, 'map', opts[Number(ans) - 1]); decided++; }
    } catch (e) { console.error('  ' + e.message); }
  }
  console.log('Decided ' + decided + '.'); return { decided };
}

function status(db) {
  const q = s => db.prepare(s).all();
  console.log('Notes without tags: ' + db.prepare("SELECT COUNT(*) n FROM vault_notes WHERE has_tags=0 AND COALESCE(quarry_exclude,0)=0").get().n);
  console.log('Proposals by state: ' + JSON.stringify(q("SELECT status, in_vocabulary AS in_vocab, COUNT(*) n FROM tag_proposals GROUP BY 1,2")));
  console.log('Approved, not yet written to notes: ' + db.prepare("SELECT COUNT(DISTINCT note_id) n FROM tag_proposals WHERE status='approved' AND written_at IS NULL").get().n + ' notes');
}

async function run(a, deps = {}) {
  const dbPath = process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db');
  const db = deps.db || require('./lib/db').openDatabase(dbPath);
  if (a.status) return status(db);
  if (a.decideBatch) {   // many decisions in one job: "tag|action|to;tag|action|to" (what the Admin page applies)
    const vocab = T.vocabularyWithApproved(db, deps.vocab || T.loadVocabulary()); let ok = 0, failed = 0;
    a.decideBatch.split(';').filter(Boolean).forEach(x => { const [tag, action, to] = x.split('|'); try { T.decide(db, vocab, tag, action, to || undefined); ok++; vocab; } catch (e) { failed++; console.error('  ' + tag + ': ' + e.message); } });
    console.log('Decisions applied: ' + ok + (failed ? ', failed: ' + failed : '')); if (failed) process.exitCode = 1; return { ok, failed };
  }
  if (a.decide) {   // one decision, for the Admin page (the Muse server does not write the database, so Admin runs this as a job)
    if (!a.action) throw new Error('--decide needs --action accept|reject|map');
    const vocab = T.vocabularyWithApproved(db, deps.vocab || T.loadVocabulary()), r = T.decide(db, vocab, a.decide, a.action, a.to);
    console.log(a.action + ' ' + a.decide + (a.to ? ' -> ' + a.to : '') + ': ' + r.notes + ' note' + (r.notes === 1 ? '' : 's')); return r;
  }
  if (a.review) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return await review(db, deps.ask || (q => new Promise(res => rl.question(q, res)))); } finally { rl.close(); }
  }
  if (a.writeback) {
    const root = deps.root || T.writebackRoot(process.env);   // the real vault, not Muse's copy
    const logFile = path.join(path.dirname(dbPath), 'muse-tag-writeback.jsonl');
    const out = T.writeback(db, root, Paths.toAbs, { confirm: a.confirm, limit: a.limit, log: ev => fs.appendFileSync(logFile, JSON.stringify(ev) + '\n') });
    out.plan.slice(0, 40).forEach(p => console.log('  note ' + p.id + ' ' + p.rel_path + '  +' + p.added.join(', ') + (p.before.length ? '   (keeps: ' + p.before.join(', ') + ')' : '')));
    if (out.plan.length > 40) console.log('  … and ' + (out.plan.length - 40) + ' more');
    console.log((a.confirm ? 'WRITTEN: ' + out.written : 'DRY RUN, nothing written. Would change: ' + out.would) + ' notes | already had the tags: ' + out.unchanged + ' | file missing: ' + out.missing + (a.confirm ? '\nLog: ' + logFile + '\nNow run Bring the vault in (vault-sync, then index) so Muse sees the tags.' : '\nRun again with --confirm to write.'));
    return out;
  }
  return tagNotes(db, a, deps);
}

module.exports = { run, parseArgs, tagNotes, review };
if (require.main === module) run(parseArgs(process.argv.slice(2))).catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
