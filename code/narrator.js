#!/usr/bin/env node
/**
 * QUARRY narrator.js v0.4
 * Changes from v0.2:
 *   - Serendipity (--live / liveSelectNotes) removed. Tag-based clustering is the
 *     sole queue-building strategy going forward (see quarry-tag-experiment.py).
 *   - NUM_SOURCES / --numSources removed (was only used by liveSelectNotes).
 *
 * Changes from v0.1→v0.2:
 *   - SYSTEM_PROMPT: OUTPUT FORMAT header (BRIDGE: line mandatory), ATTRIBUTION RULE,
 *     hard METAPHORICAL opt-out (REGISTER: unnarratable)
 *   - buildUserMessage: BRIDGE: required as first line of every response
 *   - parseBridge() extracts and logs the BRIDGE line; stripped from stored body
 *   - resolveModel integration for Claude and Gemini (live model resolution)
 *
 * Changes from v0.3→v0.4:
 *   - All LLM calls go through lib/llm.js (shared with tagger.js): gains request timeout,
 *     markModelBad + re-resolve on model-level 404/403, and a pinned fallback if the
 *     resolver package is absent. Local httpPost/callClaude/callGemini removed.
 *
 * Usage:
 *   node --no-warnings narrator.js --dry-run
 *   node --no-warnings narrator.js --next
 *   node --no-warnings narrator.js --id <queue_id>
 *   node --no-warnings narrator.js --reset
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const QUARRY_HOME = process.env.QUARRY_HOME || path.join(process.env.HOME, 'dev', 'quarry');
const { DatabaseSync } = require('node:sqlite');

const llm = require('./lib/llm');   // all LLM calls: see lib/llm.js

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH = process.env.QUARRY_DB
  || path.join(QUARRY_HOME, 'vault.db');

const VAULT_PATH = process.env.VAULT_PATH
  || path.join(process.env.HOME, 'vault');


const MAX_TOKENS      = parseInt(process.env.QUARRY_MAX_TOKENS || '4096', 10);
const FULL_BODY_CHARS = 3000;
const MIN_SOURCES     = 3;   // a cluster with fewer readable notes than this is marked failed

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const MODE_NEXT   = args.includes('--next');
const MODE_DRY    = args.includes('--dry-run');
const MODE_RESET  = args.includes('--reset');

const SPECIFIC_ID = (() => {
  const i = args.indexOf('--id');
  return i !== -1 ? parseInt(args[i + 1], 10) : null;
})();

if (!MODE_NEXT && !MODE_DRY && !MODE_RESET && SPECIFIC_ID === null) {
  console.error('Usage: node narrator.js [--next|--dry-run|--reset|--id <queue_id>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(QUARRY_HOME, 'narrator.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
  console.log(line);
  if (!process.env.QUARRY_LAUNCHED) { try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {} }
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('vault.db not found — run indexer first');
    process.exit(1);
  }
  return new DatabaseSync(DB_PATH);
}

// ---------------------------------------------------------------------------
// RESET
// ---------------------------------------------------------------------------
async function handleReset(db) {
  log('info', 'Reset requested — clearing narratives and queue');

  const approved = db.prepare(`
    SELECT id, seed_theme, produced_at, register
    FROM narratives
    WHERE approval_status = 'approved'
    ORDER BY produced_at DESC
  `).all();

  if (approved.length > 0) {
    console.log(`\n⚠️  Found ${approved.length} APPROVED narrative(s):`);
    approved.forEach(n => {
      console.log(`   • ${n.seed_theme || '(no theme)'}  [${n.register || 'unknown'}]  ${n.produced_at?.slice(0,10) || ''}`);
    });
    console.log('\nThis will permanently delete ALL narratives and the entire queue.');
    const answer = await new Promise(function(resolve) {
      const rl = require('readline').createInterface({input: process.stdin, output: process.stdout});
      rl.question('Type YES to confirm deletion: ', function(a) { rl.close(); resolve(a); });
    });
    if (answer.trim().toUpperCase() !== 'YES') {
      console.log('Reset cancelled.');
      return false;
    }
  }

  db.exec('BEGIN');
  try {
    const narrDeleted  = db.prepare('DELETE FROM narratives').run().changes;
    const queueDeleted = db.prepare('DELETE FROM narrative_queue').run().changes;
    db.exec('COMMIT');
    console.log(`\n✅ Reset complete: ${narrDeleted} narratives, ${queueDeleted} queue items deleted`);
    log('info', 'Reset completed', { narratives: narrDeleted, queue: queueDeleted });
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Reset failed:', err.message);
    log('error', 'Reset failed', { err: err.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// NOTE CONTENT READER
// ---------------------------------------------------------------------------
function readNoteBody(filepath) {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const clean = body
      .replace(/_Created at[^_]*\._/g, '')
      .replace(/_Source URL:[^_]*\._/g, '')
      .replace(/_Last updated:[^_]*\._/g, '')
      .trim();
    return clean.slice(0, FULL_BODY_CHARS);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are QUARRY, a narrative engine that surfaces moving, surprising stories
from a curated personal knowledge vault built over 10 years by a single
curious mind spanning history, music, science, language, economics, and culture
— with a particular depth in Indian and South Asian knowledge.

You will receive 2-5 note excerpts. Your task is to compose a single
self-contained narrative of 200-400 words that connects them into a moment
of astonishment.

---

OUTPUT FORMAT — NON-NEGOTIABLE

Every response must begin with exactly this line:
BRIDGE: [one sentence stating the factual or structural mechanism connecting at least two notes]

Then the narrative body (200-400 words).
Then: REGISTER: senior or REGISTER: junior

If no factual or structural bridge is available (only thematic category-overlap
or surface word-resemblance), output only:
BRIDGE: none — [one phrase describing what the notes superficially share]
REGISTER: unnarratable

Do not write a narrative body in the unnarratable case.
The curator will re-queue with different notes.

A response without a BRIDGE: first line will be treated as a failed generation.

---

WHAT YOU ARE PRODUCING

A short narrative of one or two paragraphs. Not a question. Not a quiz. Not a summary.

The narrative is upstream of any question. A human quizmaster will decide
later whether the narrative crystallises into a question. Your job ends
at the narrative. Never write a question. Never write "quiz" or "trivia."

The narrative succeeds when the reader thinks:
"I didn't know these things were connected — and now I can't unknow it!
Wow, that was hidden in plain sight and I could have worked it out from the clues!
Man, that was against all odds — that took some heart!"

---

MANDATORY: FIND A UNIFYING PRINCIPLE BEFORE WRITING

Before writing a single word, identify one concept, fact, person, place,
or mechanism that genuinely connects at least two of the notes.

This is not a metaphor hunt. This is not a word hunt.
A unifying principle must hold at the level of MEANING, not vocabulary.

TEST YOUR CONNECTION BEFORE COMMITTING TO IT:
1. Do the two things share the same MECHANISM, not just the same word?
2. Would a domain expert in both fields recognise this as a real connection?
3. If you remove the connecting word/phrase, does the connection still hold?

If any answer is no — ABANDON that connection. Find a different one.
If no connection survives this test — use the BRIDGE: none format and stop.

CONNECTION HIERARCHY — strongest to weakest:
1. FACTUAL: documented causal link, shared historical moment, same person,
   verified etymological descent, same geographic origin
2. STRUCTURAL: same underlying mechanism operating in different domains
   (e.g. both involve exponential growth, both involve translation loss)
3. IRONIC: the two things contradict each other in a revealing way
4. ANALOGICAL: similar shape or pattern — ONLY use if mechanism is shared
5. METAPHORICAL: surface resemblance in language — FORBIDDEN.
   Thematic category-overlap ("both involve Indian cultural influence",
   "both are about resilience", "both show patronage") is also FORBIDDEN
   as a primary bridge — it is a category, not a mechanism.
   If only a metaphorical or thematic bridge is available, use BRIDGE: none.

---

ATTRIBUTION RULE

When your narrative names a specific person and attributes a method, theory,
concept, or historical act to them, that attribution must come directly from
what the source note says about that specific person.

When a note lists two or more thinkers, scholars, or figures together, do NOT
transfer one person's method or contribution to another. Each person's
attribution must be separately traceable to what the note says about them.

Before attributing anything to a named person:
- Verify that the note explicitly connects that attribution to that person
  (not merely to someone else mentioned nearby).
- If you cannot trace the attribution this way, omit it entirely.

Example of the failure to avoid:
A note correctly listed "Deconstruction (Derrida)" and "Discourse Analysis (Foucault)"
as separate items. A narrative that wrote "Foucault's deconstructive lens, shared with
Derrida" blended the two — a factual error a first-year student would catch.
That narrative should never have been written.

---

USE ALL NOTES

Every note provided must appear in the narrative.
If a note cannot be connected to the others through a factual or structural
bridge, say so in the REGISTER line: "REGISTER: junior — note [N] not integrated"
and write the strongest narrative you can from the notes that do connect.

A narrative that uses three notes well is better than one that forces all five
through a broken metaphor.

---

TWO REGISTERS — choose based on the material

SENIOR REGISTER (default when material supports it):
The double reveal. Two facts that are each interesting alone, but
devastating at their junction. The reader must hold two threads
simultaneously and feel them snap together.

Examples of junction types that work:
- A 1996 novel that fictionalises a man whose daughter becomes infamous
  twenty years later — the author didn't know, but the shape was already there
- A Roman emperor's trade restriction that inadvertently names a modern airport
- A 19th-century folk rebellion whose slogan prefigures a national movement
  by seventeen years
- A modern divisive political chant that turns out to have grammar three
  thousand years old

JUNIOR REGISTER (use when material is a single strong pivot):
One fact. One moment of astonishment. Emotionally direct.
The surprise is immediate, not built.
Example: Beatrix Potter filed the most rigorous mycological field observations
of her era — and was dismissed by every scientific institution she approached
because she was a woman and an amateur. Her findings were confirmed decades
after her death.
That's complete. One pivot. No second thread needed.

---

THE BRAID PRINCIPLE

Single-domain narratives are weak.
The strongest narratives braid two or more of:
etymology · history · geography · economics · literature ·
current affairs · science · music · religion · biography

The braid is where the surprise lives. A fact about rivers becomes
moving when it braids with music. A monetary policy becomes astonishing
when it braids with toponymy. Always look for the braid.

---

THE TIME COLLAPSE — the signature move

Find the moment where something ancient is secretly operating inside
something contemporary. Or where a contemporary event reveals it was
prefigured long before anyone noticed.

This is the highest-value narrative move. Use it whenever the material
allows. The reader should feel time compress.

---

ENTRY POINTS — pick the most unexpected one

- ETYMOLOGICAL: The word itself carries the story. Start there.
  "The word comes from the Sanskrit for 'land of gold'..."
- TIME COLLAPSE: Ancient thing surfaces in modern world, or vice versa.
  "In 69 AD, a Roman emperor made a decision that named a modern airport."
- HIDDEN IDENTITY: Something or someone is not what they appear.
  "The mild-mannered publisher was born Ján Ludvík Hoch."
- PRIORITY CLAIM: Someone got there first, and nobody remembers.
  "This was 1899. The word Swaraj wouldn't be coined for another seventeen years."
- SCALE SHOCK: The number, the distance, the duration lands like a punch.
  "Fifty-five million coins. Every year. For centuries."
- REVERSAL: Start with what everyone assumes, then dismantle it.
  "We think of white marble as the aesthetic of classical antiquity.
   Every single statue was painted. The white is the damage."

---

CLOSING MOVES — the narrative must earn its ending

Before choosing a closing move, ask one question:
Is any element of this narrative still operating in the world right now,
unnoticed by most people? If yes — use THE STILL-HERE CLOSE.
It is the highest-value closing move when the material supports it.
The reader should feel the past collapse into the present tense.

Choose one move. Execute it cleanly. Do not trail off. Do not moralise.

- THE STILL-HERE CLOSE: The ancient or historical thing is still present,
  unnoticed, in everyday life. End in the present tense.
  "The Congreve rocket, reverse-engineered from Tipu's iron tubes,
   is the direct ancestor of every military rocket in use today."
- THE NAMING REVEAL: "...and amazingly, we still use that word today."
- THE TIME COLLAPSE CLOSE: "...that slogan is still chanted at protests
  in 2024, by people who have no idea it is quoting the Old Testament."
- THE HIDDEN IDENTITY CLOSE: "...the man behind all of this was Robert Maxwell.
  His daughter's name you may recognise from more recent headlines."
- THE PRIORITY CLOSE: "...Tilak's movement came seventeen years later.
  History remembered Tilak. It forgot Birsa Munda."
- THE SCALE CLOSE: Leave the reader with the number, the span, the weight.
  Let it sit without commentary.

---

TONE

- Curious, warm, never condescending
- Write for someone intelligent who doesn't know this yet
- The prose should move — not academic, not breezy, not breathless
- Never explain a concept by naming it and describing it.
  Instead, find the specific event, person, date, or mechanism
  that demonstrates it without announcing it.
  The reader should feel the idea land before they can name it.
  Wrong: "Philosopher X argued that Y, which shows..."
  Right: Find the fact that proves Y and let it speak.
- Never write "interestingly" or "fascinatingly" or "remarkably"
  — if it's any of those things, the writing will show it
- Never open with "This narrative explores..." or any preamble
  The first sentence is the hook. It must earn the second.
- Indic cultural references, when they arise naturally from the notes,
  are a strength — do not flatten them into Western analogies or
  feel any need to explain them. The audience knows.
- Hindi, Marathi, Sanskrit, Telugu phrases that appear in the notes
  may be used directly if they carry meaning. Translate inline,
  lightly, without footnote energy.

---

AFTER THE NARRATIVE — register check

Append exactly one line after the narrative body:

REGISTER: senior
or
REGISTER: junior

Nothing else. No question. No summary. No "I hope this helps."
If a note could not be integrated, append: "NOTE [N] NOT INTEGRATED: [one sentence why]"
This is valuable feedback for the curator.`;

// ---------------------------------------------------------------------------
// FETCH CLUSTER NOTES
// ---------------------------------------------------------------------------
function fetchClusterNotes(db, noteIds) {
  return noteIds.map(function(id) {
    const note = db.prepare(
      'SELECT id, filepath, title, first_paragraph, source_url, word_count, content_type FROM vault_notes WHERE id = ?'
    ).get(id);
    if (!note) return null;

    const tags = db.prepare(
      'SELECT tag_full FROM note_tags WHERE note_id = ? ORDER BY is_hierarchical DESC'
    ).all(id).map(function(r) { return r.tag_full; });

    const body = readNoteBody(note.filepath);

    const classifications = db.prepare(
      "SELECT bucket, claim FROM note_classifications WHERE note_id = ? AND bucket IN ('verified', 'evergreen', 'trivia') ORDER BY switch_level DESC, bucket"
    ).all(id);

    const verified  = classifications.filter(function(c) { return c.bucket === 'verified';  }).map(function(c) { return c.claim; });
    const evergreen = classifications.filter(function(c) { return c.bucket === 'evergreen'; }).map(function(c) { return c.claim; });
    const trivia    = classifications.filter(function(c) { return c.bucket === 'trivia';    }).map(function(c) { return c.claim; });

    return {
      id:                 note.id,
      title:              note.title,
      body:               body || note.first_paragraph || '',
      tags:               tags,
      source_url:         note.source_url,
      word_count:         note.word_count,
      content_type:       note.content_type,
      verified:           verified,
      evergreen:          evergreen,
      trivia:             trivia,
      hasClassifications: classifications.length > 0
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// BUILD USER MESSAGE
// ---------------------------------------------------------------------------
function buildUserMessage(notes, seedTheme) {
  var parts = [];
  parts.push('SEED THEME: ' + (seedTheme || 'none'));
  parts.push('');
  parts.push('NOTES (' + notes.length + '):');
  parts.push('');

  notes.forEach(function(note, i) {
    parts.push('--- NOTE ' + (i + 1) + ': ' + note.title + ' ---');
    if (note.tags && note.tags.length > 0) {
      parts.push('Tags: ' + note.tags.slice(0, 8).join(', '));
    }
    if (note.source_url) {
      parts.push('Source: ' + note.source_url);
    }
    parts.push('');

    if (note.hasClassifications) {
      if (note.verified && note.verified.length > 0) {
        parts.push('VERIFIED FACTS:');
        note.verified.slice(0, 8).forEach(function(f) { parts.push('  • ' + f); });
        parts.push('');
      }
      if (note.evergreen && note.evergreen.length > 0) {
        parts.push('CORE CONCEPTS:');
        note.evergreen.slice(0, 4).forEach(function(e) {
          const name = e.match(/\*([^*]+)\*/) || e.match(/^[-•*\d.]+\s*([^:\n]{3,40})/);
          if (name) parts.push('  • ' + name[1].trim());
          else parts.push('  • ' + e.slice(0, 80));
        });
        parts.push('');
      }
      if (note.trivia && note.trivia.length > 0) {
        parts.push('TRIVIA / SURPRISING CONNECTIONS:');
        note.trivia.slice(0, 3).forEach(function(t) { parts.push('  • ' + t); });
        parts.push('');
      }
      parts.push('RAW NOTE (for additional context):');
    }

    parts.push(note.body || '(no content)');
    parts.push('');
  });

  parts.push('---');
  parts.push('Your response MUST begin with exactly this line:');
  parts.push('BRIDGE: [one sentence — the factual or structural mechanism connecting at least two notes]');
  parts.push('');
  parts.push('Then write the narrative (200-400 words).');
  parts.push('Then append: REGISTER: senior or REGISTER: junior');
  parts.push('');
  parts.push('If the only available bridge is thematic category-overlap or surface word-resemblance:');
  parts.push('BRIDGE: none — [one phrase describing the surface resemblance]');
  parts.push('REGISTER: unnarratable');
  parts.push('(No narrative body in this case.)');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// CALL NARRATOR
// All LLM traffic goes through lib/llm.js (model resolution, markModelBad
// retry, timeouts). Claude first; Gemini if Claude is unavailable or fails.
// ---------------------------------------------------------------------------
llm.setLogger(log);

async function callNarrator(userMessage) {
  if (llm.hasKey('claude')) {
    try {
      log('info', 'Calling Claude');
      return await llm.callLLM('claude', userMessage, { system: SYSTEM_PROMPT, maxTokens: MAX_TOKENS, label: 'narrator' });
    } catch (e) {
      log('warn', 'Claude failed, falling back to Gemini', { err: e.message });
    }
  }

  log('info', 'Calling Gemini');
  return await llm.callLLM('gemini', userMessage, { system: SYSTEM_PROMPT, maxTokens: MAX_TOKENS, temperature: 0.7, label: 'narrator' });
}

// ---------------------------------------------------------------------------
// PARSE BRIDGE LINE
// Extracts "BRIDGE: <text>" from the start of the LLM response.
// Returns { bridge, isUnnarratable, rest } where rest is the text without the BRIDGE line.
// ---------------------------------------------------------------------------
function parseBridge(text) {
  const lines = text.split('\n');
  const firstLine = lines[0].trim();
  const match = firstLine.match(/^BRIDGE:\s*(.+)$/i);

  if (!match) {
    // No BRIDGE line — model didn't comply with format
    return { bridge: null, isUnnarratable: false, rest: text };
  }

  const bridgeText = match[1].trim();
  const isNone = /^none\s*[—–-]/i.test(bridgeText) || /^none$/i.test(bridgeText);
  const rest = lines.slice(1).join('\n').trim();

  return {
    bridge:          bridgeText,
    isUnnarratable:  isNone,
    rest:            rest
  };
}

// ---------------------------------------------------------------------------
// PARSE REGISTER
// ---------------------------------------------------------------------------
function parseRegister(text) {
  const match = text.match(/REGISTER:\s*(senior|junior|unnarratable)/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function stripRegisterLine(text) {
  return text.replace(/\n?REGISTER:\s*(senior|junior|unnarratable)\s*$/i, '').trim();
}

// ---------------------------------------------------------------------------
// STORE NARRATIVE
// ---------------------------------------------------------------------------
function storeNarrative(db, queueId, noteIds, seedTheme, text, model) {
  const { bridge, isUnnarratable, rest } = parseBridge(text);
  const register = parseRegister(rest || text);
  const body     = stripRegisterLine(rest || text);

  // Log the bridge for visibility; bridge column storage requires migration:
  //   ALTER TABLE narratives ADD COLUMN bridge TEXT;
  // Until then, bridge is logged but not stored in the row.
  if (bridge) {
    log('info', 'Narrative bridge', { bridge, isUnnarratable });
  } else {
    log('warn', 'No BRIDGE line in response — model did not comply with format');
  }

  if (isUnnarratable) {
    log('warn', 'Model returned REGISTER: unnarratable — no narrative produced', { bridge });
    return { body: '', register: 'unnarratable', bridge };
  }

  db.prepare(`
    INSERT INTO narratives
      (queue_id, note_ids, seed_theme, body, register, model_used, produced_at, used_for_kcircle)
    VALUES
      (@queue_id, @note_ids, @seed_theme, @body, @register, @model_used, @produced_at, 0)
  `).run({
    queue_id:    queueId,
    note_ids:    JSON.stringify(noteIds),
    seed_theme:  seedTheme,
    body:        body,
    register:    register,
    model_used:  model,
    produced_at: new Date().toISOString()
  });

  return { body, register, bridge };
}

// ---------------------------------------------------------------------------
// FORMAT TELEGRAM MESSAGE
// ---------------------------------------------------------------------------
function formatTelegram(narrative, notes, seedTheme, register, bridge) {
  const titles  = notes.map(function(n) { return n.title; }).join(', ');
  const divider = '──────────';

  const parts = [
    '🪨 QUARRY',
    '',
    narrative,
    '',
    divider,
    '📎 Sources: ' + titles,
    '🏷 Theme: ' + seedTheme,
    'REGISTER: ' + register
  ];

  if (bridge) parts.push('BRIDGE: ' + bridge);

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
// Set once an item is marked in_progress, so a crash can mark it failed instead of
// leaving it stuck in_progress (invisible in both Queued and Pending).
let ACTIVE_QUEUE_ID = null;

async function main() {
  log('info', 'QUARRY narrator v0.4 starting', {
    mode: MODE_RESET ? 'reset' : MODE_DRY ? 'dry-run' : 'queue'
  });

  const db = openDb();

  if (MODE_RESET) {
    await handleReset(db);
    db.close();
    return;
  }

  // QUEUE MODE
  var queueItem;
  if (SPECIFIC_ID !== null) {
    queueItem = db.prepare('SELECT * FROM narrative_queue WHERE id = ?').get(SPECIFIC_ID);
    if (!queueItem) {
      log('error', 'Queue item not found', { id: SPECIFIC_ID });
      db.close(); process.exit(1);
    }
  } else {
    queueItem = db.prepare(
      "SELECT * FROM narrative_queue WHERE status = 'queued' ORDER BY priority_score DESC LIMIT 1"
    ).get();
    if (!queueItem) {
      log('info', 'No queued items — queue is empty');
      db.close(); return;
    }
  }

  log('info', 'Processing queue item', { id: queueItem.id, theme: queueItem.seed_theme });

  if (!MODE_DRY) {
    db.prepare("UPDATE narrative_queue SET status = 'in_progress' WHERE id = ?")
      .run(queueItem.id);
    ACTIVE_QUEUE_ID = queueItem.id;
  }

  const noteIds = JSON.parse(queueItem.note_ids);
  const notes   = fetchClusterNotes(db, noteIds);

  if (notes.length < MIN_SOURCES) {
    log('warn', 'Cluster has too few readable notes', { id: queueItem.id, found: notes.length });
    if (!MODE_DRY) {
      db.prepare("UPDATE narrative_queue SET status = 'failed' WHERE id = ?")
        .run(queueItem.id);
    }
    db.close(); return;
  }

  log('info', 'Notes loaded', {
    count: notes.length,
    titles: notes.map(function(n) { return n.title; })
  });

  const userMessage = buildUserMessage(notes, queueItem.seed_theme);

  if (MODE_DRY) {
    console.log('\n=== DRY RUN — API PAYLOAD ===\n');
    console.log('SYSTEM PROMPT: [' + SYSTEM_PROMPT.length + ' chars — omitted for brevity]');
    console.log('\nUSER MESSAGE:\n');
    console.log(userMessage);
    console.log('\n=== END DRY RUN ===\n');
    db.close(); return;
  }

  var result;
  try {
    result = await callNarrator(userMessage);
  } catch (e) {
    log('error', 'Narrator API call failed', { err: e.message, id: queueItem.id });
    db.prepare("UPDATE narrative_queue SET status = 'failed' WHERE id = ?")
      .run(queueItem.id);
    db.close(); return;
  }

  log('info', 'Narrative produced', {
    model:    result.model,
    length:   result.text.length,
    register: parseRegister(result.text)
  });

  const stored = storeNarrative(
    db, queueItem.id, noteIds, queueItem.seed_theme, result.text, result.model
  );

  if (stored.register !== 'unnarratable') {
    db.prepare("UPDATE narrative_queue SET status = 'done' WHERE id = ?")
      .run(queueItem.id);

    const telegramMsg = formatTelegram(stored.body, notes, queueItem.seed_theme, stored.register, stored.bridge);
    console.log('\n' + telegramMsg + '\n');
    log('info', 'Narrator complete', { queue_id: queueItem.id, register: stored.register });
  } else {
    db.prepare("UPDATE narrative_queue SET status = 'failed' WHERE id = ?")
      .run(queueItem.id);
    log('warn', 'Queue item unnarratable — marked failed', { queue_id: queueItem.id, bridge: stored.bridge });
    console.log('\n[UNNARRATABLE] ' + stored.bridge + '\n');
  }

  db.close();
}

main().catch(function(e) {
  log('error', 'Narrator crashed', { err: e.message, stack: e.stack });
  if (ACTIVE_QUEUE_ID !== null) {
    try {
      const d = new DatabaseSync(DB_PATH);
      d.prepare("UPDATE narrative_queue SET status = 'failed' WHERE id = ? AND status = 'in_progress'").run(ACTIVE_QUEUE_ID);
      d.close();
      log('warn', 'Marked crashed queue item failed', { id: ACTIVE_QUEUE_ID });
    } catch (_) {}
  }
  process.exit(1);
});
