#!/usr/bin/env node
// QUARRY server.js v0.4
// Usage: node server.js [--port 3001]
// Views: / /approved /vault /tagger /curator /queue /narrator /reports /stats /notes /review

'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { insertNoteTag } = require('./lib/tags');
const cp    = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH   = process.env.QUARRY_DB    || path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'vault.db');
const VAULT_DIR = process.env.VAULT_PATH   || path.join(process.env.HOME, 'vault');
const CODE_DIR  = path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'code');
const LOG_DIR   = path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry');
const PORT      = (() => { const i = process.argv.indexOf('--port'); return i !== -1 ? parseInt(process.argv[i+1],10) : 3001; })();
const HERE      = path.dirname(process.argv[1] || __filename);
const API_TOKEN = process.env.QUARRY_API_TOKEN || ''; // if set, required on mutating API routes via X-Quarry-Token

// ---------------------------------------------------------------------------
// DB HELPERS
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) { console.error('vault.db not found'); process.exit(1); }
  return new DatabaseSync(DB_PATH);
}
function ensureSchema(db) {
  const nc = db.prepare('PRAGMA table_info(narratives)').all().map(c=>c.name);
  if (!nc.includes('approval_status'))  db.exec("ALTER TABLE narratives ADD COLUMN approval_status TEXT DEFAULT 'pending'");
  if (!nc.includes('approved_at'))      db.exec('ALTER TABLE narratives ADD COLUMN approved_at TEXT');
  if (!nc.includes('rejection_reason')) db.exec('ALTER TABLE narratives ADD COLUMN rejection_reason TEXT');
  const vn = db.prepare('PRAGMA table_info(vault_notes)').all().map(c=>c.name);
  if (!vn.includes('quarry_exclude'))   db.exec('ALTER TABLE vault_notes ADD COLUMN quarry_exclude INTEGER DEFAULT 0');
  if (!vn.includes('video_links'))      db.exec('ALTER TABLE vault_notes ADD COLUMN video_links TEXT');
  if (!vn.includes('video_transcripts'))db.exec('ALTER TABLE vault_notes ADD COLUMN video_transcripts TEXT');
}
function enrichNarrative(db, n) {
  try {
    const ids = JSON.parse(n.note_ids||'[]');
    if (!ids.length) return Object.assign({},n,{sources:[]});
    const sources = db.prepare('SELECT id,title,source_url FROM vault_notes WHERE id IN ('+inPlaceholders(ids)+')').all(...ids);
    return Object.assign({},n,{sources});
  } catch(_) { return Object.assign({},n,{sources:[]}); }
}

// ---------------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------------
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Plain-language labels for the tag_source column - the raw DB values
// (switchvocab, switch3, switch3-hil, original) are Quarry-internal
// history, not self-explanatory. Single lookup used everywhere a note's
// tag provenance is shown, so a renamed pass never drifts out of sync
// with what the UI displays. See the Help page's glossary for the
// full explanation of each.
const TAG_SOURCE_LABELS = {
  'original':    'Original',
  'switchvocab': 'Quick Match',
  'switch3':     'AI (pending)',
  'switch3-hil': 'AI (approved)',
};
function friendlyTagSource(src) {
  if (!src) return '';
  return TAG_SOURCE_LABELS[src] || src;
}
function renderDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}); } catch(_) { return iso.slice(0,10); }
}
function renderBadge(r) {
  const cls = r==='senior'?'badge-senior':r==='junior'?'badge-junior':'badge-unknown';
  return '<span class="badge '+cls+'">'+(r||'?')+'</span>';
}
function inPlaceholders(ids) {
  return ids.map(function () { return '?'; }).join(',');
}
function paginationHtml(total, page, totalPages, hrefForPage) {
  var pag = '<div class="pagination"><span>' + Number(total).toLocaleString() + ', p' + page + '/' + totalPages + '</span>';
  if (page > 1) {
    pag += '<a href="' + hrefForPage(1) + '">«</a><a href="' + hrefForPage(page - 1) + '">‹</a>';
  }
  for (var p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) {
    pag += '<a href="' + hrefForPage(p) + '"' + (p === page ? ' style="color:#c8b89a"' : '') + '>' + p + '</a>';
  }
  if (page < totalPages) {
    pag += '<a href="' + hrefForPage(page + 1) + '">›</a><a href="' + hrefForPage(totalPages) + '">»</a>';
  }
  return pag + '</div>';
}
function requireToken(req, res) {
  if (!API_TOKEN) return true;
  var got = req.headers['x-quarry-token'] || '';
  if (got === API_TOKEN) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

// ---------------------------------------------------------------------------
// CSS + HTML SHELL
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  ['/', 'Pending'],
  ['/approved', 'Approved'],
  ['/vault', 'Vault'],
  ['/tagger', 'Tagger'],
  ['/curator', 'Curator'],
  ['/queue', 'Queue'],
  ['/narrator', 'Narrator'],
  ['/reports', 'Reports'],
  ['/notes', 'Browse'],
  ['/review', 'Review'],
  ['/review-tags', 'Tag Review'],
  ['/help', 'Help'],
];

function shell(title, body, active) {
  const nav = NAV_LINKS.map(([href,label])=>
    '<a href="'+href+'"'+(active===href?' class="active"':'')+'>'+label+'</a>'
  ).join('');
  const tokenMeta = API_TOKEN
    ? '<meta name="quarry-token" content="'+escHtml(API_TOKEN)+'">'
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${tokenMeta}
<title>🪨 QUARRY — ${escHtml(title)}</title>
<link rel="stylesheet" href="/quarry.css">
</head><body>
<header>
  <span style="font-size:1.5rem">🪨</span>
  <h1>QUARRY</h1>
  <nav>${nav}</nav>
</header>
<div class="container">
${body}
</div>
${DRAWER_HTML}
<script src="/quarry.js"></script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// DRAWER
// ---------------------------------------------------------------------------
const DRAWER_HTML = `
<div class="drawer-overlay" id="drawer-overlay" data-action="close-drawer">
  <div class="drawer" id="drawer">
    <div class="drawer-head">
      <div class="drawer-title" id="drawer-title"></div>
      <button type="button" class="drawer-close" data-action="close-drawer">✕</button>
    </div>
    <div class="drawer-tabs" id="drawer-tabs"></div>
    <div class="drawer-body">
      <div class="drawer-meta" id="drawer-meta"></div>
      <div class="drawer-content" id="drawer-content">Loading...</div>
    </div>
  </div>
</div>`;


// ---------------------------------------------------------------------------
// NARRATIVE CARDS
// ---------------------------------------------------------------------------
function pendingCard(n) {
  const src=(n.sources||[]).map(s=>'<button type="button" class="btn-source" style="background:none;border:none;color:#6ea8c8;font-size:.78rem;cursor:pointer;text-decoration:underline;padding:0" data-action="open-note" data-id="'+s.id+'">'+escHtml(s.title)+'</button>').join(' · ');
  return `<div class="card" id="card-${n.id}">
  <div class="card-header"><div class="card-meta">${renderBadge(n.register)}<span class="theme-tag">${escHtml(n.queue_theme||n.seed_theme||'')}</span><span>${renderDate(n.produced_at)}</span><span style="color:#444">${escHtml(n.model_used||'')}</span></div></div>
  <div class="card-body"><div class="narrative-text" id="nt-${n.id}">${escHtml(n.body)}</div><div class="sources-line"><strong>Sources:</strong> ${src||'<em>none</em>'}</div></div>
  <div class="card-actions"><button type="button" class="btn btn-green" data-action="approve" data-id="${n.id}">✓ Approve</button><input class="reject-input" id="reason-${n.id}" placeholder="Rejection reason"/><button type="button" class="btn btn-red" data-action="reject" data-id="${n.id}">✗ Reject</button><button type="button" class="btn btn-blue" id="cp-${n.id}" data-action="copy" data-id="${n.id}">Copy</button></div>
</div>`;
}
function approvedCard(n) {
  const src=(n.sources||[]).map(s=>'<button type="button" class="btn-source" style="background:none;border:none;color:#6ea8c8;font-size:.78rem;cursor:pointer;text-decoration:underline;padding:0" data-action="open-note" data-id="'+s.id+'">'+escHtml(s.title)+'</button>').join(' · ');
  return `<div class="card" id="card-${n.id}">
  <div class="card-header"><div class="card-meta">${renderBadge(n.register)}<span class="theme-tag">${escHtml(n.queue_theme||n.seed_theme||'')}</span><span>${renderDate(n.produced_at)}</span><span class="approved-date">approved ${renderDate(n.approved_at)}</span></div></div>
  <div class="card-body"><div class="narrative-text" id="nt-${n.id}">${escHtml(n.body)}</div><div class="sources-line"><strong>Sources:</strong> ${src||'<em>none</em>'}</div></div>
  <div class="card-actions"><button type="button" class="btn btn-blue" id="cp-${n.id}" data-action="copy" data-id="${n.id}">Copy</button></div>
</div>`;
}

// ---------------------------------------------------------------------------
// CONTROL PANEL PAGES
// ---------------------------------------------------------------------------
function vaultPage() {
  return `<p class="page-title">Vault — git sync and indexing</p>
<div class="ctrl-panel">
  <h3>Sync (recommended - ZeroClaw candidate)</h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">git pull, then index only new/moved/deleted files. Read-mostly, orphan-pruning tested, zero API cost - the pair to cron nightly.</p>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="git-pull-diff" data-label="Sync: pull + diff">&#8595; Sync (pull + index --diff)</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Git Sync (manual, single steps)</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="git-pull" data-label="Git pull vault">⬇ git pull (origin/master)</button>
    <span style="font-size:.78rem;color:#555">git -C ${VAULT_DIR} pull origin master</span>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Indexer</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="index-diff" data-label="Indexer --diff">Index changed files</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="index-full" data-label="Indexer full">Full re-index</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Recount Word Counts <span style="color:#666;font-weight:normal;font-family:monospace;font-size:.75rem">(sync-wc)</span></h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">Recounts every note's word count directly from the files on disk. Run this if word counts look stale after a manual edit outside the normal git-pull flow.</p>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="sync-wc" data-label="Recount word counts">Recount from filesystem</button>
  </div>
</div>
<div id="cmd-output"></div>
`;
}

function taggerPage() {
  return `<p class="page-title">Tagger — classify and tag vault notes</p>

<div class="ctrl-panel">
  <h3>1. Quick Tag Match <span style="color:#666;font-weight:normal;font-family:monospace;font-size:.75rem">(switch-vocab)</span></h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">Free, no AI call. Matches each untagged note's filename/title/first paragraph against tags you already have in the canonical vocabulary. Fast, zero cost, but only ever reuses existing tags - never invents anything new. Good first pass before spending on the AI passes below.</p>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="sw-vocab" data-label="Quick Tag Match">Run Quick Tag Match</button>
  </div>
</div>

<div class="ctrl-panel">
  <h3>2. AI Tag Suggestions + Facts &amp; Trivia <span style="color:#666;font-weight:normal;font-family:monospace;font-size:.75rem">(switch-3)</span></h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">The main AI pass. Reads each untagged/unclassified note, proposes tags (landing in the Tag Review queue - nothing is applied automatically), and extracts verified facts + trivia for narrative generation. This is what most of your API spend goes to.</p>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="s3-limit" type="number" value="500" min="1" max="5000"></div>
    <div class="field"><label>Provider:</label><select id="s3-prov"><option value="grok">grok</option><option value="openrouter">openrouter</option><option value="gemini">gemini</option><option value="claude">claude</option></select></div>
    <button class="btn btn-primary" type="button" data-action="run-s3">Run AI Tag Suggestions</button>
  </div>
</div>

<div class="ctrl-panel">
  <h3>3. AI Tag Correction <span style="color:#666;font-weight:normal;font-family:monospace;font-size:.75rem">(switch-3-retag)</span></h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">Re-reviews notes that ALREADY have tags (real or still-pending in the Tag Review queue) and corrects them against the current ontology rules - drops attribution tags, collapses redundant categories, fixes bad hierarchy, replaces overly-specific instance tags with the right general category. Old pending suggestions for a note are marked superseded and replaced by the corrected set, so the review queue never shows both versions at once. Does not touch facts/trivia. Use this after tightening the ontology rules, or whenever a batch of AI tag suggestions looks systematically off.</p>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="retag-limit" type="number" value="500" min="1" max="5000"></div>
    <div class="field"><label>Provider:</label><select id="retag-prov"><option value="grok">grok</option><option value="openrouter">openrouter</option><option value="gemini">gemini</option><option value="claude">claude</option></select></div>
    <button class="btn btn-primary" type="button" data-action="run-retag">Run AI Tag Correction</button>
  </div>
</div>

<div class="ctrl-panel">
  <h3>4. Full-Document Deep Read <span style="color:#666;font-weight:normal;font-family:monospace;font-size:.75rem">(switch-4)</span></h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">Sends the ENTIRE note body, no truncation - for your longest/richest notes where a partial read would miss the point. Restricted to large-context-window providers only; a free OpenRouter model can silently truncate a long document and give a shallow read without telling you.</p>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="s4-limit" type="number" value="20" min="1" max="500"></div>
    <div class="field"><label>Provider:</label><select id="s4-prov"><option value="gemini">gemini</option><option value="grok">grok</option></select></div>
    <button class="btn btn-primary" type="button" data-action="run-s4">Run Full-Document Deep Read</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="sw4-dry" data-label="Full-Document dry run">Dry run</button>
  </div>
</div>

<div class="ctrl-panel">
  <h3>5. Compress Overlong Notes <span style="color:#666;font-weight:normal;font-family:monospace;font-size:.75rem">(mindful-wc)</span></h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">For notes over 15,000 words - summarizes them down to a manageable size so later AI passes can afford to read the whole thing.</p>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="mwc-limit" type="number" value="5" min="1" max="50"></div>
    <button class="btn btn-primary" type="button" data-action="run-mwc">Run Compression</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="mwc-dry" data-label="Compression dry run">Dry run (candidates list)</button>
  </div>
</div>

<div class="ctrl-panel">
  <h3>6. Extract Video Links</h3>
  <p style="color:#666;font-size:.78rem;margin-bottom:10px">Scans every note for embedded video URLs (YouTube, Vimeo, etc) and stores them for the Video Links report. No AI, just pattern matching.</p>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="extract-video" data-label="Extract video links">Extract video links from all notes</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="extract-video-dry" data-label="Extract video links dry run">Dry run</button>
  </div>
</div>

<div id="cmd-output"></div>
`;
}

function curatorPage() {
  return `<p class="page-title">Curator — build narrative queue</p>
<div class="ctrl-panel">
  <h3>Strategy: Informed Serendipity</h3>
  <p style="font-size:.8rem;color:#666;margin-bottom:14px;line-height:1.6">80% random selection within quality+diversity constraints · 20% orphan rescue · 3-note clusters · No two notes from same domain · Different tag roots required</p>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="curator-force" data-label="Curator --force">Force generate 20 clusters</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="curator-refill" data-label="Curator --refill">Refill if below threshold</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="curator-status" data-label="Curator status">Status</button>
  </div>
</div>
<div id="cmd-output"></div>
`;
}

function narratorPage() {
  return `<p class="page-title">Narrator — generate narratives</p>
<div class="ctrl-panel">
  <h3>Live Mode — fresh selection at runtime</h3>
  <div class="ctrl-row">
    <div class="field"><label>Sources:</label>
      <select id="ns-count">
        <option value="1">1 — single note (junior)</option>
        <option value="2">2 — tight braid</option>
        <option value="3" selected>3 — default</option>
        <option value="5">5 — ambitious</option>
      </select>
    </div>
    <button class="btn btn-primary" type="button" data-action="run-live">▶ Run --live</button>
    <span style="font-size:.75rem;color:#555">Result appears in Pending queue</span>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Queue Mode</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" type="button" data-action="run-cmd" data-cmd="narrator-next" data-label="Narrator --next">▶ Process next queued item</button>
    <button class="btn btn-grey" type="button" data-action="run-cmd" data-cmd="narrator-dry" data-label="Narrator --dry-run">Dry run (show payload)</button>
  </div>
</div>
<div id="cmd-output"></div>
`;
}

// ---------------------------------------------------------------------------
// QUEUE VIEW — 3 notes per row
// ---------------------------------------------------------------------------
function queuePage(db, params) {
  const page     = Math.max(1, parseInt(params.get('page')||'1',10));
  const PAGE_SIZE = 10; // 10 clusters per page
  const offset   = (page-1)*PAGE_SIZE;
  const total    = db.prepare("SELECT COUNT(*) as n FROM narrative_queue WHERE status='queued'").get().n;
  const items    = db.prepare("SELECT id,note_ids,seed_theme,priority_score,created_at FROM narrative_queue WHERE status='queued' ORDER BY priority_score DESC,id LIMIT ? OFFSET ?").all(PAGE_SIZE,offset);
  const s4ids    = new Set(db.prepare('SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4').all().map(r=>r.note_id));

  const rows = items.map(item => {
    let noteIds=[];try{noteIds=JSON.parse(item.note_ids);}catch(_){}
    const notes = noteIds.length ? db.prepare('SELECT id,title,word_count,tag_source FROM vault_notes WHERE id IN ('+inPlaceholders(noteIds)+')').all(...noteIds) : [];

    const noteCells = notes.map(n=>`
      <div class="q-note" data-action="open-note" data-id="${n.id}">
        <div class="qt">${n.s4?'<span class="s4-dot"></span>':''}`+escHtml(n.title.slice(0,60))+`</div>
        <div class="qm">${n.word_count}w · ${escHtml(friendlyTagSource(n.tag_source))}</div>
      </div>`).join('');

    // pad to 3 cells if fewer notes
    const padded = noteCells + '<div></div>'.repeat(Math.max(0,3-notes.length));

    return `<div style="margin-bottom:16px">
      <div class="q-theme">[${item.id}] ${escHtml(item.seed_theme)} · score ${item.priority_score.toFixed(2)} · ${renderDate(item.created_at)}</div>
      <div class="queue-row">
        ${padded}
        <div class="q-actions">
          <button type="button" class="btn btn-primary" data-action="narrate" data-id="${item.id}">▶ Narrate</button>
          <button type="button" class="btn btn-grey" data-action="discard" data-id="${item.id}">✕ Discard</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const totalPages = Math.ceil(total/PAGE_SIZE);
  let pag = '<div class="pagination"><span>'+total+' queued, page '+page+' of '+totalPages+'</span>';
  if (page>1) pag+='<a href="/queue?page='+(page-1)+'">‹ Prev</a>';
  if (page<totalPages) pag+='<a href="/queue?page='+(page+1)+'">Next ›</a>';
  pag+='</div>';

  return `<p class="page-title">Narrative Queue — ${total} clusters awaiting narration</p>
${rows||'<div class="empty">Queue is empty. Run the Curator to fill it.</div>'}
${pag}`;
}

// ---------------------------------------------------------------------------
// REPORTS PAGE
// ---------------------------------------------------------------------------
const REPORTS = [
  {
    id: 'vault-coverage',
    title: 'Vault Coverage',
    desc: 'Total notes, tagged %, classified counts, unclassified by size bucket',
    sql: `SELECT 'Total notes' as metric, COUNT(*) as value FROM vault_notes
          UNION ALL SELECT 'Tagged', COUNT(*) FROM vault_notes WHERE has_tags=1
          UNION ALL SELECT 'Classified S3/S4', COUNT(DISTINCT note_id) FROM note_classifications
          UNION ALL SELECT 'Switch-4 specifically', COUNT(DISTINCT note_id) FROM note_classifications WHERE switch_level=4
          UNION ALL SELECT 'quarry_exclude', COUNT(*) FROM vault_notes WHERE quarry_exclude=1
          UNION ALL SELECT 'Stubs unclassified', COUNT(*) FROM vault_notes WHERE word_count<200 AND classification_at IS NULL
          UNION ALL SELECT 'Short unclassified (200-1k)', COUNT(*) FROM vault_notes WHERE word_count BETWEEN 200 AND 999 AND classification_at IS NULL AND content_type IN ('article','note','video')
          UNION ALL SELECT 'Medium unclassified (1k-5k)', COUNT(*) FROM vault_notes WHERE word_count BETWEEN 1000 AND 4999 AND classification_at IS NULL AND content_type IN ('article','note','video')
          UNION ALL SELECT 'Long unclassified (5k+)', COUNT(*) FROM vault_notes WHERE word_count>=5000 AND classification_at IS NULL AND content_type IN ('article','note','video')`
  },
  {
    id: 'richest-notes',
    title: 'Top 15 Richest Classifications',
    desc: 'Notes with most verified facts, evergreen concepts, and trivia nuggets',
    sql: `SELECT vn.title, COUNT(*) as total_claims,
          SUM(CASE WHEN nc.bucket='verified' THEN 1 ELSE 0 END) as verified,
          SUM(CASE WHEN nc.bucket='evergreen' THEN 1 ELSE 0 END) as evergreen,
          SUM(CASE WHEN nc.bucket='trivia' THEN 1 ELSE 0 END) as trivia
          FROM note_classifications nc JOIN vault_notes vn ON vn.id=nc.note_id
          GROUP BY nc.note_id ORDER BY evergreen DESC, trivia DESC LIMIT 15`
  },
  {
    id: 'budget',
    title: 'API Budget & Spend',
    desc: 'Spend by provider and component, ceiling remaining',
    sql: `SELECT provider, component, COUNT(*) as calls,
          ROUND(SUM(tokens_in),0) as tokens_in,
          ROUND(SUM(tokens_out),0) as tokens_out,
          ROUND(SUM(cost_usd),4) as cost_usd
          FROM api_budget GROUP BY provider,component ORDER BY cost_usd DESC`
  },
  {
    id: 'narrative-pipeline',
    title: 'Narrative Pipeline',
    desc: 'Queue depth, narrative approval status counts',
    sql: `SELECT 'Queued' as stage, COUNT(*) as n FROM narrative_queue WHERE status='queued'
          UNION ALL SELECT 'In progress', COUNT(*) FROM narrative_queue WHERE status='in_progress'
          UNION ALL SELECT 'Done', COUNT(*) FROM narrative_queue WHERE status='done'
          UNION ALL SELECT 'Failed', COUNT(*) FROM narrative_queue WHERE status='failed'
          UNION ALL SELECT 'Narratives total', COUNT(*) FROM narratives
          UNION ALL SELECT 'Approved', COUNT(*) FROM narratives WHERE approval_status='approved'
          UNION ALL SELECT 'Pending approval', COUNT(*) FROM narratives WHERE approval_status='pending' OR approval_status IS NULL
          UNION ALL SELECT 'Rejected', COUNT(*) FROM narratives WHERE approval_status='rejected'`
  },
  {
    id: 'mindful-candidates',
    title: 'Mindful-WC Candidates',
    desc: 'Notes above 15K words (compression candidates)',
    sql: `SELECT id, title, word_count, content_type,
          CASE WHEN quarry_exclude=1 THEN 'excluded' ELSE '' END as excluded
          FROM vault_notes WHERE word_count>15000
          ORDER BY word_count DESC LIMIT 30`
  },
  {
    id: 'sw4-candidates',
    title: 'Switch-4 Candidates',
    desc: 'Unclassified notes >1500 words ordered by richness potential',
    sql: `SELECT id, title, word_count, content_type
          FROM vault_notes
          WHERE word_count>=1500
          AND classification_at IS NULL
          AND content_type IN ('article','note','video')
          AND (quarry_exclude IS NULL OR quarry_exclude=0)
          ORDER BY word_count DESC LIMIT 30`
  },
  {
    id: 'orphan-pool',
    title: 'Orphan Pool',
    desc: 'Unclassified, untagged notes >300 words — orphan rescue candidates',
    sql: `SELECT id, title, word_count, content_type
          FROM vault_notes
          WHERE has_tags=0 AND classification_at IS NULL AND word_count>=300
          AND content_type IN ('article','note','video')
          AND (quarry_exclude IS NULL OR quarry_exclude=0)
          ORDER BY word_count DESC LIMIT 30`
  },
  {
    id: 'video-links',
    title: 'Video Links',
    desc: 'Notes with extracted video URLs',
    sql: `SELECT id, title, word_count,
          LENGTH(video_links) - LENGTH(REPLACE(video_links,',','')) + 1 as link_count,
          SUBSTR(video_links,1,80) as sample_url
          FROM vault_notes WHERE video_links IS NOT NULL AND video_links != ''
          ORDER BY link_count DESC LIMIT 30`
  },
  {
    id: 'excluded-notes',
    title: 'Excluded Notes',
    desc: 'Notes marked quarry_exclude — review what is hidden from the narrator',
    sql: `SELECT id, title, word_count, content_type, origin
          FROM vault_notes WHERE quarry_exclude=1
          ORDER BY title LIMIT 100`
  },
  {
    id: 'top-tags',
    title: 'Top Tag Roots',
    desc: 'Most common tag roots across the vault',
    sql: `SELECT tag_root, COUNT(*) as notes
          FROM note_tags GROUP BY tag_root ORDER BY notes DESC LIMIT 30`
  },
];

function reportsPage() {
  const cards = REPORTS.map(r=>`
    <div class="report-card" id="rc-${r.id}">
      <h4>${escHtml(r.title)}</h4>
      <p>${escHtml(r.desc)}</p>
      <button type="button" class="btn btn-primary" data-action="run-report" data-report="${r.id}" style="font-size:.78rem;padding:5px 12px;">▶ Run</button>
      <div class="report-result" id="rr-${r.id}"></div>
    </div>`).join('');

  return `<p class="page-title">Reports — live database queries</p>
<div class="report-grid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// NOTES BROWSER
// ---------------------------------------------------------------------------
function notesPage(db, params) {
  const page=Math.max(1,parseInt(params.get('page')||'1',10));
  const filter=params.get('filter')||'all';
  const search=(params.get('q')||'').trim();
  const sort=params.get('sort')||'words';
  const PS=100, offset=(page-1)*PS;

  let where="WHERE content_type!='attachment'";
  if(filter==='classified')   where+=' AND classification_at IS NOT NULL';
  if(filter==='unclassified') where+=' AND classification_at IS NULL';
  if(filter==='s4')           where+=' AND id IN (SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4)';
  if(filter==='tagged')       where+=' AND has_tags=1';
  if(filter==='untagged')     where+=' AND has_tags=0';
  if(filter==='excluded')     where+=' AND quarry_exclude=1';
  if(filter==='video')        where+=" AND video_links IS NOT NULL AND video_links!=''";
  if(filter==='article')      where+=" AND content_type='article'";
  if(filter==='note')         where+=" AND content_type='note'";
  if(filter==='stub')         where+=" AND content_type='stub'";
  const bind = [];
  if (search) {
    where += ' AND (title LIKE ? OR first_paragraph LIKE ?)';
    const q = '%' + search + '%';
    bind.push(q, q);
  }
  const orderBy=sort==='title'?'title ASC':sort==='date'?'file_mtime DESC':'word_count DESC';
  const total=db.prepare('SELECT COUNT(*) as n FROM vault_notes '+where).get(...bind).n;
  const notes=db.prepare('SELECT id,title,word_count,content_type,origin,first_paragraph,tag_source,classification_at,quarry_exclude FROM vault_notes '+where+' ORDER BY '+orderBy+' LIMIT ? OFFSET ?').all(...bind, PS, offset);
  const s4ids=new Set(db.prepare('SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4').all().map(r=>r.note_id));
  const totalPages=Math.ceil(total/PS);

  function pl(p){return '/notes?page='+p+'&filter='+encodeURIComponent(filter)+'&sort='+sort+'&q='+encodeURIComponent(search);}

  const rows=notes.map(n=>{
    const ex=(n.first_paragraph||'').slice(0,130).replace(/\n/g,' ');
    const s4=s4ids.has(n.id)?'<span class="s4-dot" title="Switch-4"></span>':'';
    const dim=n.quarry_exclude?' style="opacity:.4"':'';
    return '<tr data-action="open-note" data-id="'+n.id+'"'+dim+'><td><div class="nt">'+s4+escHtml(n.title)+'</div><div class="nx">'+escHtml(ex)+'</div></td><td class="nm">'+n.word_count+'w</td><td class="nm">'+escHtml(n.content_type)+'</td><td class="nm">'+escHtml(n.origin)+'</td><td class="ntag">'+escHtml(friendlyTagSource(n.tag_source))+(n.classification_at?'<br><span style="color:#2a5a2a">✓</span>':'')+'</td></tr>';
  }).join('');

  const fOpts=[['all','All'],['article','Articles'],['note','Notes'],['stub','Stubs'],['video','Video'],['classified','Classified'],['unclassified','Unclassified'],['s4','Switch-4'],['tagged','Tagged'],['untagged','Untagged'],['excluded','Excluded']];
  const sOpts=[['words','Words'],['title','Title'],['date','Date']];
  const toolbar='<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:12px 16px">'+
    '<label style="font-size:.8rem;color:#888">Filter: <select onchange="applyNF()" id="nf-sel" style="background:#0f0f0f;border:1px solid #333;color:#aaa;padding:4px 8px;border-radius:4px;font-size:.8rem">'+fOpts.map(([v,l])=>'<option value="'+v+'"'+(filter===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label>'+
    '<label style="font-size:.8rem;color:#888">Sort: <select onchange="applyNF()" id="ns-sel" style="background:#0f0f0f;border:1px solid #333;color:#aaa;padding:4px 8px;border-radius:4px;font-size:.8rem">'+sOpts.map(([v,l])=>'<option value="'+v+'"'+(sort===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label>'+
    '<input id="nq-box" placeholder="Search..." value="'+escHtml(search)+'" onkeydown="if(event.key===\'Enter\')applyNF()" style="background:#0f0f0f;border:1px solid #333;color:#aaa;padding:4px 8px;border-radius:4px;font-size:.8rem;width:160px">'+
    '</div>';

  let pag='<div class="pagination"><span>'+total.toLocaleString()+' notes, p'+page+'/'+totalPages+'</span>';
  if(page>1) pag+='<a href="'+pl(1)+'">«</a><a href="'+pl(page-1)+'">‹</a>';
  for(let p=Math.max(1,page-2);p<=Math.min(totalPages,page+2);p++) pag+='<a href="'+pl(p)+'"'+(p===page?' style="color:#c8b89a"':'')+'>'+p+'</a>';
  if(page<totalPages) pag+='<a href="'+pl(page+1)+'">›</a><a href="'+pl(totalPages)+'">»</a>';
  pag+='</div>';

  return '<p class="page-title">Notes Browser — click row to read</p>'+toolbar+
    '<table class="note-table"><thead><tr><th>Note</th><th>Words</th><th>Type</th><th>Origin</th><th>Tags</th></tr></thead><tbody>'+rows+'</tbody></table>'+pag+
    '<script>function applyNF(){window.location="/notes?filter="+document.getElementById("nf-sel").value+"&sort="+document.getElementById("ns-sel").value+"&q="+encodeURIComponent(document.getElementById("nq-box").value);}</script>';
}

// ---------------------------------------------------------------------------
// REVIEW PAGE
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// TAG REVIEW PAGE — HIL approval queue for Switch-3 tag suggestions.
// Grouped by note so the reviewer sees full context: title, excerpt, every
// proposed tag for that note with a checkbox. Approve writes into note_tags
// (and tag_vocabulary if the tag is genuinely new); reject just marks the
// proposal row so it never resurfaces. Bulk save, same pattern as reviewPage.
// ---------------------------------------------------------------------------
function reviewTagsPage(db, params) {
  const page = Math.max(1, parseInt(params.get('page')||'1',10));
  const PS = 40; // notes per page (each note can have several tag rows)
  const offset = (page-1)*PS;

  const totalNotes = db.prepare(
    "SELECT COUNT(DISTINCT note_id) as n FROM note_tag_proposals WHERE status='pending'"
  ).get().n;

  const noteIds = db.prepare(
    "SELECT DISTINCT note_id FROM note_tag_proposals WHERE status='pending' ORDER BY note_id DESC LIMIT ? OFFSET ?"
  ).all(PS, offset).map(r => r.note_id);

  const totalPages = Math.max(1, Math.ceil(totalNotes/PS));

  const rows = noteIds.map(noteId => {
    const note = db.prepare('SELECT title, first_paragraph, word_count FROM vault_notes WHERE id=?').get(noteId);
    if (!note) return '';
    const proposals = db.prepare(
      "SELECT id, tag_full, in_vocabulary FROM note_tag_proposals WHERE note_id=? AND status='pending' ORDER BY tag_full"
    ).all(noteId);
    const excerpt = (note.first_paragraph||'').slice(0,160).replace(/\n/g,' ');

    const tagChips = proposals.map(p => {
      const vocabBadge = p.in_vocabulary ? '<span style="color:#3a5a3a;font-size:.68rem"> \u2713existing</span>' : '<span style="color:#8a6a2a;font-size:.68rem"> new</span>';
      return '<label style="display:inline-flex;align-items:center;gap:4px;background:#141414;border:1px solid #333;border-radius:4px;padding:4px 8px;margin:2px;font-size:.82rem;cursor:pointer">'+
        '<input type="checkbox" class="cb-tag" data-pid="'+p.id+'" checked>'+
        escHtml(p.tag_full)+vocabBadge+'</label>';
    }).join('');

    return '<div class="card" style="margin-bottom:14px" id="note-'+noteId+'">'+
      '<div class="card-header"><div class="nt" style="cursor:pointer" data-action="open-note" data-id="'+noteId+'">'+escHtml(note.title)+'</div><div class="nm">'+note.word_count+'w</div></div>'+
      '<div class="card-body">'+
      '<div class="nx" style="margin-bottom:10px">'+escHtml(excerpt)+'</div>'+
      '<div>'+tagChips+'</div>'+
      '<div style="margin-top:10px">'+
      '<input type="text" class="custom-tags-input" data-note="'+noteId+'" placeholder="Custom tag(s), comma-separated e.g. humour/nsfw, miscellany" '+
      'style="width:100%;background:#0f0f0f;border:1px solid #333;color:#aaa;padding:6px 10px;border-radius:4px;font-size:.8rem;font-family:Georgia,serif">'+
      '</div>'+
      '</div></div>';
  }).join('');

  const toolbar = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:12px 16px">'+
    '<span style="font-size:.8rem;color:#888">Checked = approve. Uncheck to reject.</span>'+
    '<button class="btn-save" onclick="submitTagReview()">Submit Page</button>'+
    '<span class="save-status" id="save-status"></span>'+
    '</div>';

  let pag = '<div class="pagination"><span>'+totalNotes+' notes pending, p'+page+'/'+totalPages+'</span>';
  if (page>1) pag += '<a href="/review-tags?page='+(page-1)+'">\u2039</a>';
  if (page<totalPages) pag += '<a href="/review-tags?page='+(page+1)+'">\u203a</a>';
  pag += '</div>';

  const script = `<script>
function submitTagReview(){
  var approve=[], reject=[], custom={};
  document.querySelectorAll('.cb-tag').forEach(function(cb){
    var pid=parseInt(cb.dataset.pid,10);
    if(cb.checked) approve.push(pid); else reject.push(pid);
  });
  document.querySelectorAll('.custom-tags-input').forEach(function(inp){
    var raw=inp.value.trim();
    if(!raw) return;
    var noteId=inp.dataset.note;
    var tags=raw.split(',').map(function(t){return t.trim();}).filter(function(t){return t.length>0;});
    if(tags.length) custom[noteId]=tags;
  });
  document.getElementById('save-status').textContent='Saving...';
  fetch('/api/tags/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approve:approve,reject:reject,custom:custom})})
  .then(r=>r.json()).then(d=>{
    document.getElementById('save-status').textContent='Approved '+d.approved+', rejected '+d.rejected+', custom '+d.custom+' \u2713';
    setTimeout(function(){ window.location.reload(); }, 700);
  })
  .catch(()=>{document.getElementById('save-status').textContent='Save failed';});
}
</script>`;

  return '<p class="page-title">Tag Review \u2014 approve or reject Switch-3 tag suggestions</p>'+
    toolbar + (rows || '<div class="empty">No pending tag proposals.</div>') + pag + script;
}

function reviewPage(db, params) {
  const page=Math.max(1,parseInt(params.get('page')||'1',10));
  const filter=params.get('filter')||'all';
  const search=(params.get('q')||'').trim();
  const PS=100, offset=(page-1)*PS;

  let where="WHERE content_type!='attachment'";
  if(filter==='obsidian') where+=" AND origin='obsidian'";
  if(filter==='untagged') where+=' AND has_tags=0';
  if(filter==='excluded') where+=' AND quarry_exclude=1';
  if(filter==='short')    where+=' AND word_count<300';
  const bind = [];
  if (search) {
    where += ' AND (title LIKE ? OR first_paragraph LIKE ?)';
    const q = '%' + search + '%';
    bind.push(q, q);
  }
  const total=db.prepare('SELECT COUNT(*) as n FROM vault_notes '+where).get(...bind).n;
  const notes=db.prepare('SELECT id,title,word_count,content_type,origin,first_paragraph,quarry_exclude,tag_source FROM vault_notes '+where+' ORDER BY origin,word_count DESC LIMIT ? OFFSET ?').all(...bind, PS, offset);
  const totalPages=Math.ceil(total/PS);

  function pl(p){return '/review?page='+p+'&filter='+encodeURIComponent(filter)+'&q='+encodeURIComponent(search);}

  const rows=notes.map(n=>{
    const ex=(n.first_paragraph||'').slice(0,150).replace(/\n/g,' ');
    const ch=n.quarry_exclude?'checked':'';
    const cl=n.quarry_exclude?'tr-excluded':'';
    return '<tr class="'+cl+'" id="row-'+n.id+'"><td><input type="checkbox" class="cb-exclude" id="cb-'+n.id+'" '+ch+' onchange="markChanged('+n.id+')" data-id="'+n.id+'"></td><td><div class="nt" style="cursor:pointer" data-action="open-note" data-id="'+n.id+'">'+escHtml(n.title)+'</div><div class="nx">'+escHtml(ex)+'</div></td><td class="nm">'+n.word_count+'w</td><td class="nm">'+escHtml(n.origin)+'</td><td class="nm">'+escHtml(n.content_type)+'</td><td class="ntag">'+escHtml(friendlyTagSource(n.tag_source))+'</td></tr>';
  }).join('');

  const fOpts=[['all','All'],['obsidian','Obsidian'],['untagged','Untagged'],['short','Short <300w'],['excluded','Excluded']];
  const toolbar='<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px;background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:12px 16px">'+
    '<label style="font-size:.8rem;color:#888">Filter: <select onchange="applyRF(this.value)" id="rf-sel" style="background:#0f0f0f;border:1px solid #333;color:#aaa;padding:4px 8px;border-radius:4px;font-size:.8rem">'+fOpts.map(([v,l])=>'<option value="'+v+'"'+(filter===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label>'+
    '<input id="rq-box" placeholder="Search..." value="'+escHtml(search)+'" onkeydown="if(event.key===\'Enter\')applyRF()" style="background:#0f0f0f;border:1px solid #333;color:#aaa;padding:4px 8px;border-radius:4px;font-size:.8rem;width:160px">'+
    '<button class="btn-save" onclick="saveExclusions()">Save</button><span class="save-status" id="save-status"></span>'+
    '<label style="margin-left:auto;font-size:.8rem;color:#888"><input type="checkbox" onchange="selectAll(this)"> All</label></div>';

  let pag='<div class="pagination"><span>'+total.toLocaleString()+' notes, p'+page+'/'+totalPages+'</span>';
  if(page>1) pag+='<a href="#" onclick="saveAndGo(\''+pl(page-1)+'\');return false">‹</a>';
  if(page<totalPages) pag+='<a href="#" onclick="saveAndGo(\''+pl(page+1)+'\');return false">›</a>';
  pag+='</div>';

  return '<p class="page-title">Review — mark notes to exclude from QUARRY</p>'+toolbar+
    '<table class="note-table"><thead><tr><th style="width:30px"></th><th>Note</th><th>Words</th><th>Origin</th><th>Type</th><th>Tags</th></tr></thead><tbody>'+rows+'</tbody></table>'+pag+
    `<script>
var _ch={};
window.addEventListener('beforeunload',function(e){if(Object.keys(_ch).length){e.preventDefault();e.returnValue='';}});
function markChanged(id){_ch[id]=document.getElementById('cb-'+id).checked;document.getElementById('row-'+id).className=_ch[id]?'tr-excluded':'';document.getElementById('save-status').textContent=Object.keys(_ch).length+' unsaved';}
function selectAll(cb){document.querySelectorAll('.cb-exclude').forEach(c=>{c.checked=cb.checked;markChanged(c.dataset.id);});}
function applyRF(val){var f=val||document.getElementById('rf-sel').value,q=document.getElementById('rq-box').value;saveAndGo('/review?filter='+f+'&q='+encodeURIComponent(q));}
function saveAndGo(url){
  if(!Object.keys(_ch).length){window.location=url;return;}
  document.getElementById('save-status').textContent='Saving...';
  fetch('/api/notes/exclude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(_ch)})
  .then(r=>r.json()).then(()=>{_ch={};window.location=url;})
  .catch(()=>{document.getElementById('save-status').textContent='Save failed';});}
function saveExclusions(){
  var ids=Object.keys(_ch);if(!ids.length){document.getElementById('save-status').textContent='Nothing changed.';return;}
  document.getElementById('save-status').textContent='Saving...';
  fetch('/api/notes/exclude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(_ch)})
  .then(r=>r.json()).then(d=>{document.getElementById('save-status').textContent='Saved '+d.updated+' ✓';_ch={};})
  .catch(()=>{document.getElementById('save-status').textContent='Save failed';});}
</script>`;
}

// ---------------------------------------------------------------------------
// STATS PAGE
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// HELP PAGE — static reference. CLI usage, pipeline order, narrative modes,
// cron candidates, architecture notes. Edit this function directly to keep
// it current; it's plain HTML, no DB queries.
// ---------------------------------------------------------------------------
function helpPage() {
  return `
<div style="max-width:820px">

<h2 style="color:#c8b89a;font-size:1.1rem;margin-bottom:6px">Pipeline order</h2>
<p style="color:#999;font-size:.85rem;margin-bottom:14px">Run in this sequence after a vault change (new/moved/deleted notes). Plain-language names on the left, the underlying CLI flag on the right:</p>
<pre class="log-box" style="color:#ccc">cd ~/dev/md-vaults/knowledge &amp;&amp; git pull                                       (or the Vault page's "Sync" button)
node --no-warnings ~/dev/quarry/code/indexer.js --diff                           Update the index
node --no-warnings ~/dev/quarry/code/tagger.js --switch3 --provider grok         AI Tag Suggestions + Facts &amp; Trivia (recommended default)
node --no-warnings ~/dev/quarry/code/tagger.js --switch3-retag --provider grok   AI Tag Correction (run after any ontology rule change)
</pre>
<p style="color:#999;font-size:.8rem;margin-bottom:14px"><strong>Quick Tag Match</strong> (<code>--switch-vocab</code>) is no longer part of the default sequence above. It still exists and still works, but it tags from a note's filename/title alone, with no AI reading the actual content - the AI passes produce meaningfully better tags for roughly $2 total across the whole vault. Reach for Quick Tag Match only when no LLM API key is configured or the budget ceiling has been hit and you still want some coverage rather than none.</p>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Plain-language glossary</h2>
<p style="color:#999;font-size:.85rem;margin-bottom:10px">The "Switch-N" names are Quarry-internal history, not self-explanatory - use this table to translate.</p>
<table class="report-result" style="margin-top:0"><tbody>
<tr><td style="color:#c8b89a;white-space:nowrap">Quick Tag Match<br><span style="color:#666;font-family:monospace;font-size:.72rem">switch-vocab</span></td><td>Fallback only - see note above. Free, no AI reading. Matches a note's filename/title/first paragraph against tags already in your vocabulary. Never invents a new tag.</td></tr>
<tr><td style="color:#c8b89a;white-space:nowrap">AI Tag Suggestions<br>+ Facts &amp; Trivia<br><span style="color:#666;font-family:monospace;font-size:.72rem">switch-3</span></td><td>The recommended default pass. AI reads the whole note, proposes tags (to the Tag Review queue, never auto-applied), extracts verified facts + trivia.</td></tr>
<tr><td style="color:#c8b89a;white-space:nowrap">AI Tag Correction<br><span style="color:#666;font-family:monospace;font-size:.72rem">switch-3-retag</span></td><td>Re-reviews an already-tagged note (real tags or still-pending proposals) and corrects it against the current ontology rules - drops attribution tags, collapses redundant categories, fixes bad hierarchy, swaps an overly-specific instance tag for the right general category. Old pending proposals for that note are marked <em>superseded</em> and replaced, so the queue never shows both versions at once. Doesn't touch facts/trivia.</td></tr>
<tr><td style="color:#c8b89a;white-space:nowrap">Full-Document Deep Read<br><span style="color:#666;font-family:monospace;font-size:.72rem">switch-4</span></td><td>Sends the whole note, no truncation. For your longest/richest notes. Restricted to large-context providers (Gemini, Grok) - a free OpenRouter model can silently truncate a long document.</td></tr>
<tr><td style="color:#c8b89a;white-space:nowrap">Compress Overlong Notes<br><span style="color:#666;font-family:monospace;font-size:.72rem">mindful-wc</span></td><td>For notes over 15,000 words - summarizes them so later passes can afford a full read.</td></tr>
</tbody></table>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Tagging tiers (tag_source column on a note)</h2>
<table class="report-result" style="margin-top:0"><tbody>
<tr><td style="color:#c8b89a">original</td><td>Pre-existing frontmatter tags, kept as-is by FORM/TAG archaeology.</td></tr>
<tr><td style="color:#c8b89a">switchvocab</td><td>"Quick Tag Match" - zero-cost keyword match. No API calls. Fallback tier, not the recommended default (see Pipeline order above).</td></tr>
<tr><td style="color:#c8b89a">switch3</td><td>"AI Tag Suggestions" - still sitting in the note_tag_proposals queue awaiting your review at /review-tags. Not yet a real tag on the note.</td></tr>
<tr><td style="color:#c8b89a">switch3-hil</td><td>AI-suggested AND human-approved (via Tag Review's checkboxes, the Custom Tag(s) field, or an approved AI Tag Correction). Highest-trust tier - "hil" = human in the loop.</td></tr>
</tbody></table>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Proposal statuses (note_tag_proposals table)</h2>
<table class="report-result" style="margin-top:0"><tbody>
<tr><td style="color:#c8b89a">pending</td><td>Sitting in the Tag Review queue, waiting for your approve/reject decision.</td></tr>
<tr><td style="color:#6ec86e">approved</td><td>You approved it - now also a real note_tags row and (if new) a canonical tag_vocabulary entry.</td></tr>
<tr><td style="color:#c86e6e">rejected</td><td>You rejected it. Never resurfaces.</td></tr>
<tr><td style="color:#888">superseded</td><td>An AI Tag Correction pass replaced this suggestion with a better one before you got to review it. Kept in the database for audit, hidden from the queue.</td></tr>
</tbody></table>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">tagger.js flags</h2>
<pre class="log-box" style="color:#ccc">--switch-vocab            Quick Tag Match - fallback only, zero-cost, matches canonical tag_vocabulary
--switch3                 AI Tag Suggestions + Facts &amp; Trivia -&gt; note_tag_proposals (HIL queue)
--switch3-retag           AI Tag Correction - re-reviews already-tagged notes, supersedes old proposals
--switch4                 Full-Document Deep Read (word_count&gt;=threshold, no truncation)
--limit N                 cap notes processed this run
--provider grok|gemini|openrouter|claude
--file &lt;path&gt;             target one specific note (any pass) - use exact path, no extra quoting
--dry-run                 show what would happen, write nothing
--status                  print current tagging/budget status and exit
</pre>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Tag Review workflow (/review-tags)</h2>
<ul style="color:#ccc;font-size:.85rem;line-height:1.8;padding-left:20px">
<li>Each card = one note with pending AI tag suggestions. Checked = approve, unchecked = reject.</li>
<li>Click a note's title to open the read/edit drawer (Tags, Trivia, Facts, Raw, Essay tabs).</li>
<li>In the drawer's Tags tab, click the &#10005; on any chip to delete that tag from the note immediately (no page reload needed on Submit).</li>
<li><strong>Custom Tag(s)</strong> field: comma-separated tags you add by hand, independent of what the AI suggested. Runs through the same sane-shape filter (max 4 hyphen-segments, no stopword joiners, no commas/periods inside a tag).</li>
<li><strong>Submit Page</strong> applies all decisions on the current page only (40 notes/page) — approved and custom tags become real, queryable note_tags rows plus canonical tag_vocabulary entries; rejected ones are marked and never resurface.</li>
<li>If the queue looks systematically wrong (e.g. after tightening an ontology rule), don't hand-correct hundreds of cards - run <strong>AI Tag Correction</strong> from the Tagger page instead. It re-reads each note, supersedes the old suggestion, and replaces it with a corrected one, so the queue you actually review is already clean.</li>
</ul>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Narrative generation — two independent modes</h2>
<table class="report-result" style="margin-top:0"><tbody>
<tr><td style="color:#c8b89a;white-space:nowrap">Planned<br><span style="color:#666;font-size:.75rem">curator --refill/--force<br>then narrator --next</span></td>
<td>Curator pre-fills narrative_queue: 3-note clusters, 80% serendipity / 20% orphan rescue, avoids notes surfaced in the last 30 days. Narrator then pops the next queued cluster. Batchable, deliberate, good for cron.</td></tr>
<tr><td style="color:#c8b89a;white-space:nowrap">Serendipitous<br><span style="color:#666;font-size:.75rem">narrator --live</span></td>
<td>Bypasses the queue entirely — picks fresh notes at runtime and weaves a narrative on the spot. The "hit or miss" mode. No pre-planning, good for manual exploration.</td></tr>
</tbody></table>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">narrator.js flags</h2>
<pre class="log-box" style="color:#ccc">--next                    pop next from narrative_queue (planned mode)
--live                    pick fresh notes now, bypass queue (serendipity mode)
--dry-run                 build the prompt, show it, no API call, no write
--reset                   delete a narrative (asks for typed YES confirmation)
--id &lt;id&gt;                 regenerate a specific existing narrative
--numSources 1-5          cluster size override (v1 testing found 2-note clusters
                           tighter than 3-note - worth re-testing at v2 scale)
</pre>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">curator.js flags</h2>
<pre class="log-box" style="color:#ccc">--refill                  top up narrative_queue only if below 15 entries (target 20)
--force                   regenerate 20 new candidates regardless of current depth
--status                  print queue depth and exit, no writes
</pre>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">ZeroClaw cron candidates</h2>
<table class="report-result" style="margin-top:0"><tbody>
<tr><td style="color:#6ec86e">git pull + indexer.js --diff</td><td><strong>Primary ZeroClaw candidate.</strong> Run as a pair: git pull picks up vault changes from GitHub, --diff picks up only new/moved/deleted files (not a full re-index), including tested orphan-pruning for removed notes. Read-mostly, zero API cost, safe nightly.</td></tr>
<tr><td style="color:#6ec86e">curator.js --refill</td><td>Safe to automate. Self-limiting, zero API cost.</td></tr>
<tr><td style="color:#888">tagger.js --switch-vocab</td><td>Fallback only now (see Pipeline order above) - not recommended as a routine cron job when an LLM key is available. Zero API cost if you do still want it.</td></tr>
<tr><td style="color:#c8b89a">narrator.js --next</td><td>Automate with a cap (e.g. 3-5/run) so the Pending approval queue stays reviewable, not overwhelming.</td></tr>
<tr><td style="color:#e0a840">tagger.js --switch3 / --switch3-retag</td><td>Real API cost per run - cron with --limit and a budget check in the wrapper, not just QUARRY's internal $10 ceiling.</td></tr>
<tr><td style="color:#c86e6e">writeback.js (any stage)</td><td>Never automate. Writes directly to vault files + git; keep this a deliberate, reviewed action.</td></tr>
</tbody></table>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Ontological principles (tag_vocabulary governance)</h2>
<ol style="color:#ccc;font-size:.85rem;line-height:1.8;padding-left:20px">
<li><strong>Geography is a co-tag, never a parent</strong> — write "india" + "culture/food", never "india/food" - unless the concept has no meaningful existence outside that geography and the term itself is unambiguous without it (e.g. "carnatic", "bharatanatyam" need no geography prefix).</li>
<li><strong>Hierarchy resolves ambiguity only</strong> — use parent/leaf (e.g. "science/psychology") only when the bare leaf term is genuinely ambiguous on its own. If a term is self-identifying, keep it flat.</li>
<li><strong>No parent-path auto-creation</strong> — tagging "humour/nsfw" does not also create a standalone "humour" row. tag_root already supports "everything under X" queries (WHERE tag_root='humour') without a redundant parent tag.</li>
<li><strong>Drop attribution tags</strong> — a source's author or publisher name (e.g. "wolfram") is not a subject tag; it duplicates the note's own source/author field.</li>
<li><strong>Drop specific-instance tags in favour of the general category</strong> — a numbered example or named instance of a broader concept (e.g. "rule-30" on a note about elementary cellular automata generally) belongs in trivia, not as a tag.</li>
<li><strong>Never tag the same discipline twice under two different roots</strong> — don't keep both "computer-science" and "technology/computing" on one note; pick the one that fits the note's actual angle.</li>
</ol>

<h2 style="color:#c8b89a;font-size:1.1rem;margin:22px 0 6px">Architecture notes</h2>
<ul style="color:#ccc;font-size:.85rem;line-height:1.8;padding-left:20px">
<li>Ground truth split: note content + frontmatter tags live in the vault/GitHub. QUARRY metadata (classifications, narratives, budget, proposals) lives in SQLite only.</li>
<li>note_classifications now carries only two buckets: <strong>verified</strong> and <strong>trivia</strong>. evergreen/asserted/dubious/essay were tried and deliberately cut - they added token cost without adding narrative value; epistemic status (opinion/conspiracy) is captured as a tag instead, not a classification bucket.</li>
<li>Client-side code lives in quarry.js, styling in quarry.css, both served as static files next to server.js. All dynamic content uses data-* attributes + fetch()/JSON, never inline onclick with interpolated strings - this was a real bug class (nested escaping across template layers) and is now structurally avoided.</li>
<li>lib/tags.js is the single shared tag-insertion path for both server.js (HIL approve/custom) and tagger.js (switch-vocab). Edit tag-insertion policy there once, both processes pick it up.</li>
<li>Anywhere a note's tag_source is displayed (Browse, Queue, Review, Stats), it goes through a single friendlyTagSource() lookup rather than showing the raw DB value - keeps the UI consistent with this glossary even if a pass gets renamed later.</li>
</ul>

</div>
`;
}

function statsPage(db) {
  const total      = db.prepare('SELECT COUNT(*) as n FROM vault_notes').get().n;
  const tagged     = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE has_tags=1').get().n;
  const classified = db.prepare('SELECT COUNT(DISTINCT note_id) as n FROM note_classifications').get().n;
  const s4         = db.prepare('SELECT COUNT(DISTINCT note_id) as n FROM note_classifications WHERE switch_level=4').get().n;
  const excluded   = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE quarry_exclude=1').get().n;
  const narratives = db.prepare('SELECT COUNT(*) as n FROM narratives').get().n;
  const approved   = db.prepare("SELECT COUNT(*) as n FROM narratives WHERE approval_status='approved'").get().n;
  const budget     = db.prepare('SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget').get().t;
  const s4cost     = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget WHERE component='classifier-s4'").get().t;
  const tagPct=Math.round(tagged/total*100), clsPct=Math.round(classified/total*100);
  const byType=db.prepare("SELECT content_type,COUNT(*) as n FROM vault_notes GROUP BY content_type ORDER BY n DESC").all();
  const byOrigin=db.prepare("SELECT origin,COUNT(*) as n FROM vault_notes GROUP BY origin ORDER BY n DESC").all();
  const bySrc=db.prepare("SELECT COALESCE(tag_source,'original') as src,COUNT(*) as n FROM vault_notes WHERE has_tags=1 GROUP BY tag_source ORDER BY n DESC").all();
  bySrc.forEach(r => { r.src = friendlyTagSource(r.src); });
  const bySize=db.prepare("SELECT CASE WHEN word_count<200 THEN 'stub' WHEN word_count<1000 THEN 'short' WHEN word_count<5000 THEN 'medium' ELSE 'long' END as bucket,COUNT(*) as n FROM vault_notes GROUP BY bucket ORDER BY n DESC").all();
  const topTags=db.prepare("SELECT tag_root,COUNT(*) as n FROM note_tags GROUP BY tag_root ORDER BY n DESC LIMIT 15").all();

  function bd(title,rows,k,v){
    return '<div class="breakdown"><h3>'+escHtml(title)+'</h3>'+rows.map(r=>'<div class="br-row"><span class="k">'+escHtml(String(r[k]))+'</span><span class="v">'+r[v]+'</span></div>').join('')+'</div>';
  }

  return `<p class="page-title">Statistics</p>
<div class="stat-grid">
  <div class="stat-card"><div class="num">${total.toLocaleString()}</div><div class="lbl">Total Notes</div></div>
  <div class="stat-card"><div class="num">${tagged.toLocaleString()}</div><div class="lbl">Tagged</div><div class="progress-bar"><div class="progress-fill" style="width:${tagPct}%"></div></div><div class="sub">${tagPct}%</div></div>
  <div class="stat-card"><div class="num">${classified.toLocaleString()}</div><div class="lbl">Classified</div><div class="progress-bar"><div class="progress-fill" style="width:${clsPct}%;background:#1a4a2a"></div></div><div class="sub">${clsPct}% · ${s4} S4</div></div>
  <div class="stat-card"><div class="num">${narratives}</div><div class="lbl">Narratives</div><div class="sub">${approved} approved</div></div>
  <div class="stat-card"><div class="num">$${budget.toFixed(3)}</div><div class="lbl">API Spend</div><div class="sub">S4: $${s4cost.toFixed(3)}</div></div>
  <div class="stat-card"><div class="num">${excluded}</div><div class="lbl">Excluded</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
  ${bd('By Type',byType,'content_type','n')}${bd('By Origin',byOrigin,'origin','n')}
  ${bd('By Size',bySize,'bucket','n')}${bd('Tag Source',bySrc,'src','n')}
  ${bd('Top Tags',topTags,'tag_root','n')}
</div>`;
}

const NODE  = process.execPath; // full path to the node binary running this server
const FLAGS = ['--no-warnings'];

// ---------------------------------------------------------------------------
// COMMAND RUNNER — tmux sessions survive server restarts and Android process death
// Each command gets a named tmux session and writes to its own log file.
// Killing an existing session before starting ensures clean restarts.
// ---------------------------------------------------------------------------

// Map from cmd → {session, logFile, args(body)=>string[]}
// logFile is relative to LOG_DIR. git-pull and index use their own logs.
const CMD_MAP = {
  'git-pull':          { session:'quarry-git',      log:'git.log',      build: ()=>['git',['-C',VAULT_DIR,'pull','origin','master']] },
  'git-pull-diff':     { session:'quarry-git',      log:'git.log',      build: (b,C)=>['bash',['-c', 'git -C '+VAULT_DIR+' pull origin master && '+NODE+' '+FLAGS.join(' ')+' '+path.join(C,'indexer.js')+' --diff']] },
  'index-diff':        { session:'quarry-index',    log:'indexer.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'indexer.js'),'--diff']] },
  'index-full':        { session:'quarry-index',    log:'indexer.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'indexer.js')]] },
  'sync-wc':           { session:'quarry-syncwc',   log:'sync-wc.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--sync-wc']] },
  'sw-vocab':          { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch-vocab']] },
  'sw3':               { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>{ const a=[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch3']]; if(b.limit)a[1].push('--limit',String(b.limit)); if(b.provider)a[1].push('--provider',b.provider); return a; } },
  'sw4':               { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>{ const a=[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch4']]; if(b.limit)a[1].push('--limit',String(b.limit)); a[1].push('--provider',b.provider||'gemini'); return a; } },
  'sw3-retag':         { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>{ const a=[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch3-retag']]; if(b.limit)a[1].push('--limit',String(b.limit)); if(b.provider)a[1].push('--provider',b.provider); return a; } },
  'sw4-dry':           { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch4','--dry-run','--limit','10']] },
  'mwc':               { session:'quarry-mwc',      log:'tagger.log',   build: (b,C)=>{ const a=[NODE,[...FLAGS,path.join(C,'tagger.js'),'--mindful-wc']]; if(b.limit)a[1].push('--limit',String(b.limit)); return a; } },
  'mwc-dry':           { session:'quarry-mwc',      log:'tagger.log',   build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--mindful-wc','--dry-run']] },
  'extract-video':     { session:'quarry-video',    log:'video.log',    build: (b,C)=>[NODE,[...FLAGS,path.join(C,'extract_video_links.js')]] },
  'extract-video-dry': { session:'quarry-video',    log:'video.log',    build: (b,C)=>[NODE,[...FLAGS,path.join(C,'extract_video_links.js'),'--dry-run']] },
  'curator-force':     { session:'quarry-curator',  log:'curator.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'curator.js'),'--force']] },
  'curator-refill':    { session:'quarry-curator',  log:'curator.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'curator.js'),'--refill']] },
  'curator-status':    { session:'quarry-curator',  log:'curator.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'curator.js'),'--status']] },
  'narrator-next':     { session:'quarry-narrator', log:'narrator.log', build: (b,C)=>[NODE,[...FLAGS,path.join(C,'narrator.js'),'--next']] },
  'narrator-dry':      { session:'quarry-narrator', log:'narrator.log', build: (b,C)=>[NODE,[...FLAGS,path.join(C,'narrator.js'),'--dry-run']] },
  'narrator-live':     { session:'quarry-narrator', log:'narrator.log', build: (b,C)=>[NODE,[...FLAGS,path.join(C,'narrator.js'),'--live','--numSources',String(b.numSources||3)]] },
  'narrator-id':       { session:'quarry-narrator', log:'narrator.log', build: (b,C)=>{ if(!b.id)throw new Error('id required'); return [NODE,[...FLAGS,path.join(C,'narrator.js'),'--id',String(b.id)]]; } },
};

function launchInTmux(session, logFile, executable, args) {
  const logPath = path.join(LOG_DIR, logFile);
  // Build the shell command that runs inside tmux
  // Redirect both stdout and stderr to the log file (append), then also to console
  const quotedArgs = [executable].concat(args).map(a=>"'"+String(a).replace(/'/g,"'\\''")+"'").join(' ');
  const shellCmd = quotedArgs + ' >> '+logPath+' 2>&1';

  // Kill existing session — ignore error if session doesn't exist yet
  try { cp.execFileSync('tmux',['kill-session','-t',session],{stdio:'ignore'}); } catch(_){}

  // Start new tmux session running the command
  cp.execFileSync('tmux',['new-session','-d','-s',session,shellCmd],{env:process.env});
  return logPath;
}

function resolveCmd(body) {
  const cmd = body.cmd;
  const def = CMD_MAP[cmd];
  if (!def) throw new Error('Unknown command: '+cmd);

  const [executable, args] = def.build(body, CODE_DIR);
  const logPath = launchInTmux(def.session, def.log, executable, args);
  return { msg: cmd+' started in tmux session '+def.session, log: def.log };
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------
function router(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;
  const params = new URLSearchParams(req.url.split('?')[1]||'');

  // Static assets (next to server.js)
  if (method === 'GET' && (url === '/quarry.css' || url === '/quarry.js')) {
    const fp = path.join(HERE, path.basename(url));
    try {
      const body = fs.readFileSync(fp);
      res.writeHead(200, {
        'Content-Type': url.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(404);
      res.end('not found: place quarry.css / quarry.js next to server.js');
    }
    return;
  }

  function send(content, active) {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(shell(active, content, '/'+active.toLowerCase().replace(/ /g,'-')));
  }
  function sendHtml(title, content, activeHref) {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(shell(title, content, activeHref));
  }
  function json(obj, status) {
    res.writeHead(status||200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(obj));
  }

  // --- Static pages ---
  if (method==='GET' && url==='/') {
    const db=openDb();ensureSchema(db);
    const pending=db.prepare("SELECT n.*,nq.seed_theme as queue_theme FROM narratives n LEFT JOIN narrative_queue nq ON nq.id=n.queue_id WHERE n.approval_status='pending' OR n.approval_status IS NULL ORDER BY n.produced_at DESC").all().map(n=>enrichNarrative(db,n));
    db.close();
    const cards=pending.length?pending.map(pendingCard).join(''):'<div class="empty">No narratives pending approval.</div>';
    sendHtml('Pending','<p class="page-title">Pending Approval</p><div style="background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:10px 18px;margin-bottom:20px;font-size:.85rem;color:#888">Pending: <strong id="pending-count" style="color:#c8b89a">'+pending.length+'</strong></div>'+cards,'/');
    return;
  }
  if (method==='GET' && url==='/approved') {
    const db=openDb();ensureSchema(db);
    const approved=db.prepare("SELECT n.*,nq.seed_theme as queue_theme FROM narratives n LEFT JOIN narrative_queue nq ON nq.id=n.queue_id WHERE n.approval_status='approved' ORDER BY n.approved_at DESC").all().map(n=>enrichNarrative(db,n));
    db.close();
    const cards=approved.length?approved.map(approvedCard).join(''):'<div class="empty">No narratives approved yet.</div>';
    sendHtml('Approved','<p class="page-title">Approved Archive</p><div style="background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:10px 18px;margin-bottom:20px;font-size:.85rem;color:#888">Approved: <strong style="color:#c8b89a">'+approved.length+'</strong></div>'+cards,'/approved');
    return;
  }
  if (method==='GET' && url==='/vault')    { sendHtml('Vault',   vaultPage(),   '/vault');    return; }
  if (method==='GET' && url==='/tagger')   { sendHtml('Tagger',  taggerPage(),  '/tagger');   return; }
  if (method==='GET' && url==='/curator')  { sendHtml('Curator', curatorPage(), '/curator');  return; }
  if (method==='GET' && url==='/narrator') { sendHtml('Narrator',narratorPage(),'/narrator'); return; }
  if (method==='GET' && url==='/reports')  { sendHtml('Reports', reportsPage(), '/reports');  return; }
  if (method==='GET' && url==='/stats')    { const db=openDb();ensureSchema(db);const c=statsPage(db);db.close(); sendHtml('Stats',c,'/stats'); return; }
  if (method==='GET' && url==='/help')     { sendHtml('Help',helpPage(),'/help'); return; }
  if (method==='GET' && /^\/queue/.test(url)) { const db=openDb();ensureSchema(db);const c=queuePage(db,params);db.close(); sendHtml('Queue',c,'/queue'); return; }
  if (method==='GET' && /^\/notes/.test(url)) { const db=openDb();ensureSchema(db);const c=notesPage(db,params);db.close(); sendHtml('Browse',c,'/notes'); return; }
  if (method==='GET' && /^\/review-tags/.test(url)){ const db=openDb();ensureSchema(db);const c=reviewTagsPage(db,params);db.close(); sendHtml('Tag Review',c,'/review-tags'); return; }
  if (method==='GET' && /^\/review/.test(url)){ const db=openDb();ensureSchema(db);const c=reviewPage(db,params);db.close(); sendHtml('Review',c,'/review'); return; }

  // --- API: approve/reject tag proposals ---
  if (method==='POST' && url==='/api/tags/review') {
    if (!requireToken(req, res)) return;
    readBody(req, function(b) {
      var data={}; try{ data=JSON.parse(b); }catch(_){}
      const approve = data.approve || [];
      const reject  = data.reject  || [];
      const custom  = data.custom  || {};
      const db = openDb(); ensureSchema(db);
      const now = new Date().toISOString();
      let approvedCount = 0, rejectedCount = 0, customCount = 0;

      // Same shape-sanity rules as tagger.js's isSaneTagShape - kept minimal
      // and duplicated here since server.js and tagger.js don't share code.
      const TAG_STOPWORDS = new Set(['and','in','for','with','the','by','at','to','from','as','is','was','a','an']);
      function isSaneTag(t) {
        if (!t || t.length < 2 || t.length > 35) return false;
        if (/[,.]/.test(t)) return false;
        if (/^[\d\u2013-]/.test(t)) return false;
        const parts = t.split('/').join('-').split('-');
        if (parts.length > 4) return false;
        if (parts.some(p => TAG_STOPWORDS.has(p))) return false;
        return true;
      }

      db.exec('BEGIN');
      try {
        for (const noteId of Object.keys(custom)) {
          const tags = custom[noteId] || [];
          for (const raw of tags) {
            const clean = raw.trim().toLowerCase().replace(/\s+/g,'-');
            if (!isSaneTag(clean)) continue;
            const t = insertNoteTag(db, noteId, clean, { markVocabApproved: true });
            if (!t) continue;
            db.prepare("UPDATE vault_notes SET has_tags=1, tag_source='switch3-hil' WHERE id=?").run(noteId);
            customCount++;
          }
        }
        for (const pid of approve) {
          const p = db.prepare('SELECT * FROM note_tag_proposals WHERE id=?').get(pid);
          if (!p || p.status !== 'pending') continue;

          // insertNoteTag handles both tag_vocabulary promotion and the
          // note_tags row - single shared code path with the custom-tag
          // branch above and with tagger.js's switch-vocab writer.
          insertNoteTag(db, p.note_id, p.tag_full, { markVocabApproved: true });
          db.prepare("UPDATE vault_notes SET has_tags=1, tag_source='switch3-hil' WHERE id=?").run(p.note_id);

          db.prepare("UPDATE note_tag_proposals SET status='approved', reviewed_at=? WHERE id=?").run(now, pid);
          approvedCount++;
        }
        for (const pid of reject) {
          const p = db.prepare('SELECT status FROM note_tag_proposals WHERE id=?').get(pid);
          if (!p || p.status !== 'pending') continue;
          db.prepare("UPDATE note_tag_proposals SET status='rejected', reviewed_at=? WHERE id=?").run(now, pid);
          rejectedCount++;
        }
        db.exec('COMMIT');
      } catch(e) {
        db.exec('ROLLBACK');
        db.close();
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:e.message}));
        return;
      }

      db.close();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true, approved:approvedCount, rejected:rejectedCount, custom:customCount}));
    });
    return;
  }

  // --- API: run command ---
  if (method==='POST' && url==='/api/run') {
    if (!requireToken(req, res)) return;
    readBody(req, function(b) {
      var body={};try{body=JSON.parse(b);}catch(_){}
      try {
        const result = resolveCmd(body);
        json({ok:true, msg:result.msg, log:result.log});
      } catch(e) {
        json({ok:false, error:e.message}, 400);
      }
    }); return;
  }

  // --- API: tail log — serves correct log based on ?file= param ---
  if (method==='GET' && url.startsWith('/api/log')) {
    const logFile = params.get('file') || 'tagger.log';
    // Sanitise: only allow simple filenames, no path traversal
    const safe = path.basename(logFile).replace(/[^a-z0-9._-]/gi,'');
    const fp = path.join(LOG_DIR, safe.endsWith('.log') ? safe : safe+'.log');
    try {
      const lines = fs.readFileSync(fp,'utf8').split('\n').filter(Boolean);
      res.writeHead(200,{'Content-Type':'text/plain'});
      res.end(lines.slice(-60).join('\n'));
    } catch(_) {
      res.writeHead(200,{'Content-Type':'text/plain'});
      res.end('(log not yet created — command may still be starting)');
    }
    return;
  }

  // --- API: reports ---
  const reportMatch = url.match(/^\/api\/reports\/([a-z0-9-]+)$/);
  if (method==='GET' && reportMatch) {
    const r = REPORTS.find(x=>x.id===reportMatch[1]);
    if (!r) { json({error:'Unknown report'},404); return; }
    const db=openDb();ensureSchema(db);
    try {
      const rows=db.prepare(r.sql).all();
      db.close(); json(rows);
    } catch(e) { db.close(); json({error:e.message},500); }
    return;
  }

  // --- API: discard queue item ---
  const discardMatch = url.match(/^\/api\/queue\/(\d+)\/discard$/);
  if (method==='POST' && discardMatch) {
    if (!requireToken(req, res)) return;
    const db=openDb();
    db.prepare("UPDATE narrative_queue SET status='failed' WHERE id=?").run(parseInt(discardMatch[1],10));
    db.close(); json({ok:true}); return;
  }

  // --- API: get note ---
  const noteMatch = url.match(/^\/api\/notes\/(\d+)$/);
  if (method==='GET' && noteMatch) {
    const id=parseInt(noteMatch[1],10);
    const db=openDb();ensureSchema(db);
    const note=db.prepare('SELECT id,title,filepath,source_url,word_count,content_type FROM vault_notes WHERE id=?').get(id);
    if (!note){db.close();res.writeHead(404);res.end(JSON.stringify({}));return;}
    const essay=db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='essay' ORDER BY switch_level DESC LIMIT 1").get(id);
    const verified=db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='verified' ORDER BY switch_level DESC LIMIT 12").all(id).map(r=>r.claim);
    const trivia=db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='trivia' ORDER BY switch_level DESC LIMIT 20").all(id).map(r=>r.claim);
    const tags=db.prepare('SELECT tag_full FROM note_tags WHERE note_id=? ORDER BY tag_full').all(id).map(r=>r.tag_full);
    db.close();
    var body='';
    try{body=fs.readFileSync(note.filepath,'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/,'').replace(/_Created at[^_]*\._/g,'').replace(/_Source URL:[^_]*\._/g,'').trim();}catch(_){}
    json(Object.assign({},note,{body,essay:essay?essay.claim:null,verified,trivia,tags}));
    return;
  }

  // --- API: remove a single tag from a note ---
  const delTagMatch = url.match(/^\/api\/notes\/(\d+)\/tags\/delete$/);
  if (method==='POST' && delTagMatch) {
    if (!requireToken(req, res)) return;
    const id = parseInt(delTagMatch[1],10);
    readBody(req, function(b) {
      var data={}; try{ data=JSON.parse(b); }catch(_){}
      const tag = (data.tag||'').trim();
      if (!tag) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'missing tag'})); return; }
      const db = openDb(); ensureSchema(db);
      db.prepare('DELETE FROM note_tags WHERE note_id=? AND tag_full=?').run(id, tag);
      const remaining = db.prepare('SELECT COUNT(*) as n FROM note_tags WHERE note_id=?').get(id).n;
      if (remaining===0) db.prepare('UPDATE vault_notes SET has_tags=0 WHERE id=?').run(id);
      db.close();
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  // --- API: save note ---
  const saveMatch = url.match(/^\/api\/notes\/(\d+)\/save$/);
  if (method==='POST' && saveMatch) {
    if (!requireToken(req, res)) return;
    const id=parseInt(saveMatch[1],10);
    readBody(req,function(b){
      var data={};try{data=JSON.parse(b);}catch(_){}
      const db=openDb();
      const note=db.prepare('SELECT filepath FROM vault_notes WHERE id=?').get(id);
      db.close();
      if(!note){res.writeHead(404);res.end(JSON.stringify({error:'not found'}));return;}
      try{
        const orig=fs.readFileSync(note.filepath,'utf8');
        const fm=(orig.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/)||[''])[0];
        const nb=(data.content||'').trim();
        fs.writeFileSync(note.filepath+'.bak',orig);
        fs.writeFileSync(note.filepath,fm?fm+'\n'+nb:nb,'utf8');
        const wc=(nb.match(/\S+/g)||[]).length;
        const db2=openDb();db2.prepare('UPDATE vault_notes SET word_count=? WHERE id=?').run(wc,id);db2.close();
        json({ok:true});
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    }); return;
  }

  // --- API: approve/reject narrative ---
  const approveMatch = url.match(/^\/api\/narratives\/(\d+)\/approve$/);
  if (method==='POST' && approveMatch) {
    if (!requireToken(req, res)) return;
    const db=openDb();ensureSchema(db);
    db.prepare("UPDATE narratives SET approval_status='approved',approved_at=? WHERE id=?").run(new Date().toISOString(),parseInt(approveMatch[1],10));
    db.close();json({ok:true});return;
  }
  const rejectMatch = url.match(/^\/api\/narratives\/(\d+)\/reject$/);
  if (method==='POST' && rejectMatch) {
    if (!requireToken(req, res)) return;
    readBody(req,function(b){
      var reason='';try{reason=JSON.parse(b).reason||'';}catch(_){}
      const db=openDb();ensureSchema(db);
      db.prepare("UPDATE narratives SET approval_status='rejected',rejection_reason=? WHERE id=?").run(reason,parseInt(rejectMatch[1],10));
      db.close();json({ok:true});
    });return;
  }

  // --- API: save exclusions ---
  if (method==='POST' && url==='/api/notes/exclude') {
    if (!requireToken(req, res)) return;
    readBody(req,function(b){
      var ch={};try{ch=JSON.parse(b);}catch(_){}
      const db=openDb();ensureSchema(db);
      var n=0;Object.keys(ch).forEach(id=>{db.prepare('UPDATE vault_notes SET quarry_exclude=? WHERE id=?').run(ch[id]?1:0,parseInt(id,10));n++;});
      db.close();json({ok:true,updated:n});
    });return;
  }

  res.writeHead(404);res.end('Not found');
}

function readBody(req,cb){var b='';req.on('data',c=>{b+=c;});req.on('end',()=>cb(b));}

const server=http.createServer(router);
server.listen(PORT,'0.0.0.0',function(){
  console.log('🪨 QUARRY server running at http://localhost:'+PORT);
  console.log('   Nav: / /approved /vault /tagger /curator /queue /narrator /reports /notes /review /stats');
  if (API_TOKEN) console.log('   API token required (QUARRY_API_TOKEN) on mutating routes');
  else console.log('   No API token set — mutating routes open (set QUARRY_API_TOKEN to lock)');
});