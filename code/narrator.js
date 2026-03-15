#!/usr/bin/env node
/**
 * QUARRY narrator.js v0.1
 * Takes the next queued cluster, reads full note content,
 * calls Claude (or Gemini fallback), stores result, returns narrative.
 *
 * Usage:
 *   node narrator.js --next          Process next queued item
 *   node narrator.js --id <queue_id> Process a specific queue item
 *   node narrator.js --dry-run       Show what would be sent to API, no call
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH = process.env.QUARRY_DB
  || path.join(process.env.HOME, 'quarry', 'vault.db');

const VAULT_PATH = process.env.VAULT_PATH
  || path.join(process.env.HOME, 'vault');

const CLAUDE_API_KEY  = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY    || '';

const CLAUDE_MODEL    = 'claude-sonnet-4-20250514';
const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_TOKENS = 4096;
const FULL_BODY_CHARS = 3000; // max chars of note body to send to narrator

// ---------------------------------------------------------------------------
// CLI ARGS
// ---------------------------------------------------------------------------
const args        = process.argv.slice(2);
const MODE_NEXT   = args.includes('--next');
const MODE_DRY    = args.includes('--dry-run');
const SPECIFIC_ID = (() => {
  const i = args.indexOf('--id');
  return i !== -1 ? parseInt(args[i + 1], 10) : null;
})();

if (!MODE_NEXT && !MODE_DRY && SPECIFIC_ID === null) {
  console.error('Usage: node narrator.js [--next|--dry-run|--id <queue_id>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------
const TRACE_PATH = path.join(process.env.HOME, 'quarry', 'narrator.log');

function log(level, msg, data) {
  data = data || {};
  const entry = Object.assign({ ts: new Date().toISOString(), level, msg }, data);
  const line  = JSON.stringify(entry);
  console.log(line);
  try { fs.appendFileSync(TRACE_PATH, line + '\n'); } catch (_) {}
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
// NOTE CONTENT READER
// Reads the actual markdown file for full body content.
// ---------------------------------------------------------------------------
function readNoteBody(filepath) {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    // Strip frontmatter
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    // Strip trailing Evernote footer
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

    return {
      id:              note.id,
      title:           note.title,
      body:            body || note.first_paragraph || '',
      tags:            tags,
      source_url:      note.source_url,
      word_count:      note.word_count,
      content_type:    note.content_type
    };
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are QUARRY, a narrative engine that surfaces moving, surprising stories
from a curated personal knowledge vault built over 10 years by a single
curious mind spanning history, music, science, language, economics, and culture
— with a particular depth in Indian and South Asian knowledge.

You will receive 2-5 note excerpts. Your task is to compose a single
self-contained narrative of 150-400 words that connects them into a moment
of astonishment.

---

WHAT YOU ARE PRODUCING

A short narrative of one or two paragraphs. Not a question. Not a quiz. Not a summary.

The narrative is upstream of any question. A human quizmaster will decide
later whether the narrative crystallises into a question. Your job ends
at the narrative. Never write a question. Never write "quiz" or "trivia."

The narrative succeeds when the reader thinks:
"I didn't know these things were connected — and now I can't unknow it!;
Wow, that was hidden in plain sight and I could have worked it out from the clues!;
Man, that was against all odds — that took some heart!"

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

Choose one. Execute it cleanly. Do not trail off. Do not moralise.

- THE NAMING REVEAL: "...and amazingly, we still use that word today."
- THE TIME COLLAPSE CLOSE: "...that slogan is still chanted at protests
  in 2024, by people who have no idea it is quoting the Old Testament."
- THE HIDDEN IDENTITY CLOSE: "...the man behind all of this was Robert Maxwell.
  His daughter's name you may recognise from more recent headlines."
- THE PRIORITY CLOSE: "...Tilak's movement came seventeen years later.
  History remembered Tilak. It forgot Birsa Munda."
- THE SCALE CLOSE: Leave the reader with the number, the span, the weight.
  Let it sit without commentary.
- THE STILL-HERE CLOSE: The ancient thing is still present, unnoticed,
  in everyday life.

---

TONE

- Curious, warm, never condescending
- Write for someone intelligent who doesn't know this yet
- The prose should move — not academic, not breezy, not breathless
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

This helps the system learn which clusters produce which register.
Nothing else. No question. No summary. No "I hope this helps."`;

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
    parts.push(note.body || '(no content)');
    parts.push('');
  });

  parts.push('---');
  parts.push('Compose the narrative now. Remember: no questions, no "quiz" or "trivia", end with REGISTER: senior or REGISTER: junior.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// HTTP POST helper (no external deps)
// ---------------------------------------------------------------------------
function httpPost(hostname, pathStr, headers, body) {
  return new Promise(function(resolve, reject) {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: hostname,
      path:     pathStr,
      method:   'POST',
      headers:  Object.assign({
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }, headers)
    };

    const req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// CLAUDE API CALL
// ---------------------------------------------------------------------------
async function callClaude(userMessage) {
  if (!CLAUDE_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await httpPost(
    'api.anthropic.com',
    '/v1/messages',
    {
      'x-api-key':         CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    {
      model:      CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }]
    }
  );

  if (res.status !== 200) {
    throw new Error('Claude API error ' + res.status + ': ' + JSON.stringify(res.body));
  }

  const text = (res.body.content || [])
    .filter(function(b) { return b.type === 'text'; })
    .map(function(b) { return b.text; })
    .join('');

  return { text: text, model: CLAUDE_MODEL };
}

// ---------------------------------------------------------------------------
// GEMINI API CALL (fallback)
// ---------------------------------------------------------------------------
async function callGemini(userMessage) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  const res = await httpPost(
    'generativelanguage.googleapis.com',
    '/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY,
    {},
    {
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [{ text: userMessage }]
      }],
      generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 }
    }
  );

  if (res.status !== 200) {
    throw new Error('Gemini API error ' + res.status + ': ' + JSON.stringify(res.body));
  }

  const text = ((((res.body.candidates || [])[0] || {}).content || {}).parts || [])
    .map(function(p) { return p.text || ''; })
    .join('');

  return { text: text, model: GEMINI_MODEL };
}

// ---------------------------------------------------------------------------
// CALL NARRATOR (Claude first, Gemini fallback)
// ---------------------------------------------------------------------------
async function callNarrator(userMessage) {
  if (CLAUDE_API_KEY) {
    try {
      log('info', 'Calling Claude', { model: CLAUDE_MODEL });
      return await callClaude(userMessage);
    } catch (e) {
      log('warn', 'Claude failed, falling back to Gemini', { err: e.message });
    }
  }

  log('info', 'Calling Gemini', { model: GEMINI_MODEL });
  return await callGemini(userMessage);
}

// ---------------------------------------------------------------------------
// PARSE REGISTER from narrative text
// ---------------------------------------------------------------------------
function parseRegister(text) {
  const match = text.match(/REGISTER:\s*(senior|junior)/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

function stripRegisterLine(text) {
  return text.replace(/\n?REGISTER:\s*(senior|junior)\s*$/i, '').trim();
}

// ---------------------------------------------------------------------------
// STORE NARRATIVE
// ---------------------------------------------------------------------------
function storeNarrative(db, queueId, noteIds, seedTheme, text, model) {
  const register = parseRegister(text);
  const body     = stripRegisterLine(text);

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

  return { body, register };
}

// ---------------------------------------------------------------------------
// FORMAT TELEGRAM MESSAGE
// ---------------------------------------------------------------------------
function formatTelegram(narrative, notes, seedTheme, register) {
  const titles  = notes.map(function(n) { return n.title; }).join(', ');
  const divider = '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500';

  return [
    '\uD83E\uDEA8 QUARRY',
    '',
    narrative,
    '',
    divider,
    '\uD83D\uDCCE Sources: ' + titles,
    '\uD83C\uDFF7 Theme: ' + seedTheme,
    'REGISTER: ' + register
  ].join('\n');
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  log('info', 'QUARRY narrator starting', { mode: MODE_DRY ? 'dry-run' : 'live' });

  const db = openDb();

  // Get queue item
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

  // Mark in_progress
  if (!MODE_DRY) {
    db.prepare("UPDATE narrative_queue SET status = 'in_progress' WHERE id = ?")
      .run(queueItem.id);
  }

  // Fetch notes
  const noteIds = JSON.parse(queueItem.note_ids);
  const notes   = fetchClusterNotes(db, noteIds);

  if (notes.length < 2) {
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

  // Build message
  const userMessage = buildUserMessage(notes, queueItem.seed_theme);

  if (MODE_DRY) {
    console.log('\n=== DRY RUN — API PAYLOAD ===\n');
    console.log('SYSTEM PROMPT: [' + SYSTEM_PROMPT.length + ' chars — omitted for brevity]');
    console.log('\nUSER MESSAGE:\n');
    console.log(userMessage);
    console.log('\n=== END DRY RUN ===\n');
    db.close(); return;
  }

  // Call narrator
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

  // Store
  const stored = storeNarrative(
    db, queueItem.id, noteIds, queueItem.seed_theme, result.text, result.model
  );

  // Mark done
  db.prepare("UPDATE narrative_queue SET status = 'done' WHERE id = ?")
    .run(queueItem.id);

  // Print Telegram-formatted output
  const telegramMsg = formatTelegram(stored.body, notes, queueItem.seed_theme, stored.register);
  console.log('\n' + telegramMsg + '\n');

  log('info', 'Narrator complete', { queue_id: queueItem.id, register: stored.register });

  db.close();
}

main().catch(function(e) {
  log('error', 'Narrator crashed', { err: e.message, stack: e.stack });
  process.exit(1);
});