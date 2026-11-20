#!/usr/bin/env node
'use strict';
/**
 * QUARRY nuggetizer — Muse step 1. One LLM pass per note → verified burrs in SQLite.
 *
 *   node code/nuggetizer.js --dry-run                 count candidates, estimate cost, no LLM, no writes
 *   node code/nuggetizer.js --limit 20                try 20 notes (short notes first)
 *   node code/nuggetizer.js                           all pending short notes (< --max-words, default 200)
 *   node code/nuggetizer.js --all                     every pending note, any length
 *   node code/nuggetizer.js --all --min-words 100 --shuffle --limit 50   spread-out trial on fuller notes
 *   node code/nuggetizer.js --redo ...            ignore finished status and re-verify (cached responses cost nothing)
 *   node code/nuggetizer.js --note 123                one note (re-runs it even if done)
 *   node code/nuggetizer.js --review-list out.csv     write the deletion-review candidates, then exit
 *
 * Flags: --provider gemini|claude|grok|openrouter (default gemini)  --ceiling USD  --max-words N
 *
 * Contract (Muse Constitution, Art. 3, 4, 6, 8): the model proposes, lib/burrs.js verifies against the
 * note's own text; responses are cached by input+prompt+schema+provider and reused only for the same model (except --redo); spend goes through api_budget;
 * 5 errors in a row or the budget ceiling stop the run. READ-ONLY on the vault: never edits a note.
 */
const fs   = require('fs');
const path = require('path');
const B    = require('./lib/burrs');
const Bud  = require('./lib/budget');
const Paths = require('./lib/note_path');   // notes are stored by key (rel_path); the file is the key joined to the vault root

const MAX_CONSEC_ERRORS = 5;
const EST_PROMPT_TOKENS = 700;   // fixed instructions + example
const EST_OUT_TOKENS    = 250;

function parseArgs(argv) {
  const a = { dryRun: false, edited: false, limit: 0, provider: 'gemini', all: false, maxWords: 200, minWords: 0, redo: false, shuffle: false, note: 0, ceiling: null, reviewList: '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--all') a.all = true;
    else if (k === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (k === '--provider') a.provider = argv[++i];
    else if (k === '--max-words') a.maxWords = parseInt(argv[++i], 10) || 200;
    else if (k === '--min-words') a.minWords = parseInt(argv[++i], 10) || 0;
    else if (k === '--shuffle') a.shuffle = true;
    else if (k === '--redo') a.redo = true;
    else if (k === '--edited') a.edited = true;
    else if (k === '--note') a.note = parseInt(argv[++i], 10) || 0;
    else if (k === '--ceiling') a.ceiling = parseFloat(argv[++i]);
    else if (k === '--review-list') a.reviewList = argv[++i] || '';
    else throw new Error('Unknown argument: ' + k);
  }
  return a;
}

function now() { return new Date().toISOString(); }

function pickCandidates(db, a, root) {
  if (a.edited) return pickEdited(db, a, root);
  if (a.note) return db.prepare('SELECT id,rel_path,title,source_url,word_count FROM vault_notes WHERE id=?').all(a.note);
  const where = ['COALESCE(n.quarry_exclude,0)=0',
    a.redo ? '1=1' : 'NOT EXISTS (SELECT 1 FROM nuggetize_status s WHERE s.note_id=n.id AND s.prompt_version=? AND s.status IN (\'ok\',\'empty\',\'skipped_empty\'))'];
  const params = a.redo ? [] : [B.PROMPT_VERSION];
  if (!a.all) { where.push('n.word_count < ?'); params.push(a.maxWords); }
  if (a.minWords) { where.push('n.word_count >= ?'); params.push(a.minWords); }
  const sql = 'SELECT n.id,n.rel_path,n.title,n.source_url,n.word_count FROM vault_notes n WHERE ' + where.join(' AND ') +
              (a.shuffle ? ' ORDER BY (n.id * 2654435761) % 1000003' : ' ORDER BY n.word_count ASC, n.id ASC') + (a.limit ? ' LIMIT ' + a.limit : '');
  return db.prepare(sql).all(...params);
}

// Notes edited since their facts were extracted: the file is newer than the last extraction AND the note's current text has no saved model answer (the cache is keyed on
// the text itself, so a note that was only touched or re-synced finds its answer and is NOT edited). Unchanged notes are never selected, so their facts and ids stay put.
// A note that was empty and still is, is not edited either. Unreadable files are left out (the index step reports them). Uses the same provider as the extraction.
function pickEdited(db, a, root) {
  if (!root) throw new Error('--edited needs the vault copy folder (VAULT_PATH).');
  const rows = db.prepare("SELECT n.id,n.rel_path,n.title,n.source_url,n.word_count,s.status AS prev FROM vault_notes n JOIN nuggetize_status s ON s.note_id=n.id AND s.prompt_version=? " +
    "WHERE COALESCE(n.quarry_exclude,0)=0 AND s.status IN ('ok','empty','skipped_empty') AND n.file_mtime > s.at ORDER BY n.word_count ASC, n.id ASC").all(B.PROMPT_VERSION);
  const out = []; Object.defineProperty(out, 'skipped', { value: [], enumerable: false });   // out.skipped: notes whose file changed but are not re-processed, each with the reason
  if (!rows.length) return out;
  const cached = db.prepare('SELECT 1 FROM nuggetize_cache WHERE cache_key=?');
  for (const r of rows) {
    let note; try { note = loadNote(r, root); } catch (e) { out.skipped.push({ rel_path: r.rel_path, reason: 'file could not be read from the vault copy' }); continue; }
    const empty = note.real_words < 3;
    if (empty) { if (r.prev !== 'skipped_empty') out.push(r); else out.skipped.push({ rel_path: r.rel_path, reason: 'still empty (under 3 words of body text)' }); continue; }
    if (r.prev === 'skipped_empty' || !cached.get(B.cacheKey(a.provider, B.buildInput(note, note.cleaned)))) out.push(r);
    else out.skipped.push({ rel_path: r.rel_path, reason: 'file changed, but the body text is unchanged since the last extraction (tags, properties or a re-save only)' });
  }
  return out;
}

function loadNote(row, root) {
  const raw = fs.readFileSync(Paths.toAbs(row.rel_path, root), 'utf8');
  const { body } = B.splitFrontmatter(raw);
  const cleaned = B.cleanBody(body);
  return { id: row.id, title: row.title || path.basename(row.rel_path, '.md'), source_url: row.source_url, cleaned: cleaned,
           real_words: B.realWordCount(cleaned) };
}

function setStatus(db, id, status, nB, nR, reasons, model, runId) {
  db.prepare('INSERT OR REPLACE INTO nuggetize_status (note_id,prompt_version,status,n_burrs,n_rejected,reasons_json,model,run_id,at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, B.PROMPT_VERSION, status, nB, nR, JSON.stringify(reasons || []), model || null, runId, now());
}

function markNugget(db, row, reason) {
  db.prepare('INSERT OR IGNORE INTO note_disposition (note_id,bucket,disposition,reason,decided_by,decided_at) VALUES (?,?,?,?,?,?)')
    .run(row.id, 'short', 'nugget', reason, 'rule', now());
}

async function processNote(db, row, a, runId, deps) {
  const note = loadNote(row, deps.root);
  if (note.real_words < 3) {
    db.prepare('DELETE FROM burrs WHERE note_id=? AND prompt_version=?').run(row.id, B.PROMPT_VERSION);   // a note edited down to nothing keeps no facts from its old text
    setStatus(db, row.id, 'skipped_empty', 0, 0, ['body under 3 real words (title only or media only)'], null, runId);
    db.prepare('INSERT OR REPLACE INTO note_disposition (note_id,bucket,disposition,reason,decided_by,decided_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, 'empty', 'review', 'no body text (title-only or media-only); human review: delete, expand or keep as hub', 'rule', now());
    return { status: 'skipped_empty', cost: 0, n: 0 };
  }
  const input = B.buildInput(note, note.cleaned);
  const key = B.cacheKey(a.provider, input);
  let hit = db.prepare('SELECT response_text, model FROM nuggetize_cache WHERE cache_key=?').get(key);
  // Constitution Decision 4: a different model is a different answer. The key holds the provider; the model is checked here. --redo is the free replay of cached
  // answers (re-verify after a verifier change), so it keeps them whatever model made them; a normal run asks the current model again.
  if (hit && deps.model && hit.model && hit.model !== deps.model && !a.redo) { console.warn('note ' + row.id + ': cached answer is from ' + hit.model + ', current model is ' + deps.model + '; asking again'); hit = undefined; }
  let text, model, cost = 0, fresh = false;
  if (hit) { text = hit.response_text; model = hit.model; }
  else {
    Bud.checkBudget(db, a.provider, a.ceiling);
    const p = B.buildPrompt(note, note.cleaned);
    const r = await deps.callLLM(a.provider, p.prompt, { system: p.system, maxTokens: 8000, temperature: 0, thinkingBudget: 0, label: 'nuggetize' });
    text = r.text; model = r.model; fresh = true;
    cost = Bud.recordSpend(db, a.provider, 'nuggetize', row.id, r.tokensIn, r.tokensOut, model, function (m, d) { console.warn(m, d || ''); });
    var tokIn = r.tokensIn || 0, tokOut = r.tokensOut || 0;
  }
  const parsed = B.parseModelJson(text);
  if (fresh && parsed.ok) {
    db.prepare('INSERT OR REPLACE INTO nuggetize_cache (cache_key,response_text,model,tokens_in,tokens_out,created_at) VALUES (?,?,?,?,?,?)')
      .run(key, text, model, tokIn, tokOut, now());
  }
  if (!parsed.ok) { setStatus(db, row.id, 'error', 0, 0, [parsed.error].concat(parsed.detail ? ['detail: ' + parsed.detail] : [], ['tail: ' + String(text).slice(-100).replace(/\s+/g, ' ')]), model, runId); return { status: 'error', cost: cost, n: 0 }; }
  const v = B.verifyBurrs(parsed.burrs, note);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM burrs WHERE note_id=? AND prompt_version=?').run(row.id, B.PROMPT_VERSION);
    const ins = db.prepare('INSERT INTO burrs (note_id,claim,quote,kind,hooks_json,loop_text,perishable,provenance,method,prompt_version,model,run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    v.accepted.forEach(function (b) {
      ins.run(row.id, b.claim, b.quote, b.kind, JSON.stringify(b.hooks), b.loop_text || null, b.perishable, 'vault', 'llm', B.PROMPT_VERSION, model, runId, now());
    });
    const status = v.accepted.length ? 'ok' : 'empty';
    setStatus(db, row.id, status, v.accepted.length, v.rejected.length,
      v.rejected.map(function (r) { return r.reason; }).concat(parsed.reason ? ['model: ' + parsed.reason] : []), model, runId);
    if (row.word_count < a.maxWords) markNugget(db, row, 'short note kept as nugget');
    db.exec('COMMIT');
    return { status: status, cost: cost, n: v.accepted.length, rejected: v.rejected.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function writeReviewList(db, outPath) {
  const rows = [];
  db.prepare("SELECT n.id,n.title,n.rel_path,n.word_count,d.reason FROM note_disposition d JOIN vault_notes n ON n.id=d.note_id WHERE d.disposition='review'")
    .all().forEach(function (r) { rows.push(['empty', r]); });
  db.prepare(`SELECT n.id,n.title,n.rel_path,n.word_count,'duplicate title' AS reason FROM vault_notes n
              WHERE n.word_count<200 AND lower(trim(n.title)) IN
                (SELECT lower(trim(title)) FROM vault_notes WHERE word_count<200 GROUP BY 1 HAVING COUNT(*)>1)
              ORDER BY lower(trim(n.title)), n.id`).all().forEach(function (r) { rows.push(['duplicate', r]); });
  const q = function (s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; };
  const lines = ['kind,id,title,words,path,reason'].concat(rows.map(function (x) {
    return [x[0], x[1].id, q(x[1].title), x[1].word_count, q(x[1].rel_path), q(x[1].reason)].join(',');
  }));
  fs.writeFileSync(outPath, lines.join('\n') + '\n');
  return rows.length;
}

async function run(a, deps) {
  deps = deps || {};
  const db = deps.db || require('./lib/db').openDatabase(process.env.QUARRY_DB || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), 'vault.db'));
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='nuggetize_status'").get()) throw new Error('Tables missing. Run: node code/migrate.js --run');
  if (a.reviewList) { const n = writeReviewList(db, a.reviewList); console.log('Wrote ' + n + ' review rows to ' + a.reviewList); return { reviewRows: n }; }

  const rootOf = () => deps.root || Paths.vaultRoot(process.env, process.env.QUARRY_HOME || path.join(__dirname, '..'));   // never guessed: see lib/note_path.js
  const cands = pickCandidates(db, a, a.edited ? rootOf() : null);
  const estIn = cands.reduce(function (s, r) { return s + EST_PROMPT_TOKENS + Math.min(B.MAX_BODY_CHARS, (r.word_count || 0) * 7) / 4; }, 0);
  const rate = Bud.priceFor(a.provider, null, 0);
  const estCost = rate ? (estIn * rate.in + cands.length * EST_OUT_TOKENS * rate.out) / 1e6 : 0;
  console.log('Candidates: ' + cands.length + ' | provider ' + a.provider + ' | est. cost $' + estCost.toFixed(3) + ' | spent so far $' + Bud.spentToDate(db).toFixed(4));
  if (a.dryRun || !cands.length) return { candidates: cands.length, estCost: estCost };

  const root = rootOf();
  const callLLM = deps.callLLM || require('./lib/llm').callLLM;
  // The model a paid call would use now. Tests that inject callLLM get no model check unless they inject modelFor too.
  const modelFor = deps.modelFor || (deps.callLLM ? null : require('./lib/llm').modelFor);
  let curModel = null;
  if (modelFor) { try { const m = await modelFor(a.provider, {}); curModel = (m && m.id) || null; } catch (e) { curModel = null; } }
  if (curModel) console.log('Model: ' + curModel);
  if (!deps.callLLM && !require('./lib/llm').hasKey(a.provider)) throw new Error('No API key for provider ' + a.provider);
  const runId = 'nug-' + now().replace(/[-:.TZ]/g, '').slice(0, 17) + '-' + Math.random().toString(16).slice(2, 6);
  db.prepare('INSERT INTO muse_runs (run_id,kind,started_at,seed,params_json,versions_json) VALUES (?,?,?,?,?,?)')
    .run(runId, 'nuggetize', now(), null, JSON.stringify(a), JSON.stringify({ prompt: B.PROMPT_VERSION, schema: B.SCHEMA_VERSION }));

  const tally = { ok: 0, empty: 0, skipped_empty: 0, error: 0, burrs: 0, rejected: 0, cost: 0 };
  let consec = 0, stopped = '';
  for (let i = 0; i < cands.length; i++) {
    try {
      const r = await processNote(db, cands[i], a, runId, { callLLM: callLLM, root: root, model: curModel });
      tally[r.status] = (tally[r.status] || 0) + 1; tally.burrs += r.n; tally.rejected += (r.rejected || 0); tally.cost += r.cost;
      consec = r.status === 'error' ? consec + 1 : 0;
    } catch (e) {
      if (e instanceof Bud.BudgetError) { stopped = e.message; break; }
      tally.error++; consec++;
      setStatus(db, cands[i].id, 'error', 0, 0, [String(e.message).slice(0, 200)], null, runId);
      console.error('note ' + cands[i].id + ': ' + e.message);
    }
    if (consec >= MAX_CONSEC_ERRORS) { stopped = MAX_CONSEC_ERRORS + ' errors in a row; stopping'; break; }
    if ((i + 1) % 25 === 0) console.log('  ' + (i + 1) + '/' + cands.length + '  burrs ' + tally.burrs + '  $' + tally.cost.toFixed(4));
  }
  db.prepare('UPDATE muse_runs SET finished_at=? WHERE run_id=?').run(now(), runId);
  console.log('Run ' + runId + ': ' + JSON.stringify(tally) + (stopped ? '\nSTOPPED: ' + stopped : ''));
  if (stopped) process.exitCode = 1;
  return tally;
}

module.exports = { run, parseArgs, processNote, pickCandidates, pickEdited };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).catch(function (e) { console.error('FATAL: ' + e.message); process.exit(1); });
}
