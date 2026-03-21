#!/usr/bin/env node
/**
 * QUARRY server.js v0.1
 * Local web UI for narrative approval queue and archive.
 *
 * Usage:
 *   node server.js [--port 3001]
 *
 * Views:
 *   /          → Pending approval queue
 *   /approved  → Approved narrative archive
 *   /api/narratives/pending   → JSON
 *   /api/narratives/approved  → JSON
 *   /api/narratives/:id/approve
 *   /api/narratives/:id/reject
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const DB_PATH = process.env.QUARRY_DB
  || path.join(process.env.HOME, 'quarry', 'vault.db');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 3001;
})();

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('vault.db not found at', DB_PATH);
    process.exit(1);
  }
  return new DatabaseSync(DB_PATH);
}

// Ensure approval columns exist
function ensureSchema(db) {
  const cols = db.prepare('PRAGMA table_info(narratives)').all().map(function(c) { return c.name; });
  if (!cols.includes('approval_status')) {
    db.exec("ALTER TABLE narratives ADD COLUMN approval_status TEXT DEFAULT 'pending'");
  }
  if (!cols.includes('approved_at')) {
    db.exec('ALTER TABLE narratives ADD COLUMN approved_at TEXT');
  }
  if (!cols.includes('rejection_reason')) {
    db.exec('ALTER TABLE narratives ADD COLUMN rejection_reason TEXT');
  }
  // quarry_exclude flag on vault_notes
  const noteCols = db.prepare('PRAGMA table_info(vault_notes)').all().map(function(c) { return c.name; });
  if (!noteCols.includes('quarry_exclude')) {
    db.exec('ALTER TABLE vault_notes ADD COLUMN quarry_exclude INTEGER DEFAULT 0');
  }
}

// ---------------------------------------------------------------------------
// DATA HELPERS
// ---------------------------------------------------------------------------
function getPendingNarratives(db) {
  return db.prepare(`
    SELECT n.id, n.body, n.register, n.mode, n.produced_at, n.model_used,
           n.note_ids, n.seed_theme, n.approval_status,
           nq.seed_theme as queue_theme
    FROM narratives n
    LEFT JOIN narrative_queue nq ON nq.id = n.queue_id
    WHERE n.approval_status = 'pending' OR n.approval_status IS NULL
    ORDER BY n.produced_at DESC
  `).all();
}

function getApprovedNarratives(db) {
  return db.prepare(`
    SELECT n.id, n.body, n.register, n.mode, n.produced_at, n.approved_at,
           n.note_ids, n.seed_theme,
           nq.seed_theme as queue_theme
    FROM narratives n
    LEFT JOIN narrative_queue nq ON nq.id = n.queue_id
    WHERE n.approval_status = 'approved'
    ORDER BY n.approved_at DESC
  `).all();
}

function getNotesByIds(db, noteIdsJson) {
  try {
    const ids = JSON.parse(noteIdsJson);
    if (!ids.length) return [];
    return db.prepare(
      'SELECT id, title, source_url FROM vault_notes WHERE id IN (' + ids.join(',') + ')'
    ).all();
  } catch (_) { return []; }
}

function enrichNarrative(db, n) {
  const sources = getNotesByIds(db, n.note_ids || '[]');
  return Object.assign({}, n, { sources: sources });
}

// ---------------------------------------------------------------------------
// HTML TEMPLATES
// ---------------------------------------------------------------------------
const HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🪨 QUARRY</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, serif; background: #0f0f0f; color: #e8e4dc; min-height: 100vh; }
  header { background: #1a1a1a; border-bottom: 1px solid #333; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 1.4rem; letter-spacing: 0.05em; color: #c8b89a; }
  nav a { color: #888; text-decoration: none; font-size: 0.9rem; padding: 6px 14px; border-radius: 4px; border: 1px solid #333; }
  nav a:hover, nav a.active { color: #c8b89a; border-color: #555; }
  nav { display: flex; gap: 8px; }
  .container { max-width: 860px; margin: 0 auto; padding: 32px 24px; }
  .empty { text-align: center; color: #555; padding: 64px; font-size: 1.1rem; }
  .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; margin-bottom: 24px; overflow: hidden; }
  .card-header { padding: 14px 20px; background: #141414; border-bottom: 1px solid #2a2a2a; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .card-meta { font-size: 0.78rem; color: #666; }
  .card-meta span { margin-right: 12px; }
  .badge { display: inline-block; font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-family: monospace; }
  .badge-senior { background: #2a1f0e; color: #c8a96e; border: 1px solid #5a3e1a; }
  .badge-junior { background: #0e1f2a; color: #6eacc8; border: 1px solid #1a5a7a; }
  .badge-unknown { background: #1f1f1f; color: #888; border: 1px solid #333; }
  .card-body { padding: 20px; }
  .narrative-text { line-height: 1.75; font-size: 1.05rem; color: #d8d0c4; white-space: pre-wrap; }
  .sources { margin-top: 16px; padding-top: 14px; border-top: 1px solid #2a2a2a; font-size: 0.82rem; color: #666; }
  .sources strong { color: #888; }
  .sources a { color: #6ea8c8; text-decoration: none; }
  .sources a:hover { text-decoration: underline; }
  .actions { padding: 14px 20px; background: #141414; border-top: 1px solid #2a2a2a; display: flex; gap: 10px; align-items: center; }
  .btn { padding: 8px 20px; border-radius: 5px; border: none; font-size: 0.9rem; cursor: pointer; font-family: Georgia, serif; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-approve { background: #1a3a1a; color: #6ec86e; border: 1px solid #2a5a2a; }
  .btn-reject { background: #3a1a1a; color: #c86e6e; border: 1px solid #5a2a2a; }
  .btn-copy { background: #1f1f2a; color: #8888cc; border: 1px solid #33335a; }
  .reject-reason { flex: 1; background: #0f0f0f; border: 1px solid #333; color: #aaa; padding: 7px 12px; border-radius: 4px; font-size: 0.85rem; font-family: Georgia, serif; }
  .theme-tag { font-size: 0.75rem; color: #8a7a6a; font-family: monospace; background: #1f1a12; padding: 2px 8px; border-radius: 3px; border: 1px solid #3a3020; }
  .stats-bar { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px 20px; margin-bottom: 24px; display: flex; gap: 24px; font-size: 0.85rem; color: #888; }
  .stats-bar strong { color: #c8b89a; }
  .approved-date { font-size: 0.78rem; color: #4a6a4a; }
  .section-title { font-size: 0.85rem; color: #666; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 20px; }
  /* Review page */
  .review-toolbar { background:#141414; border:1px solid #2a2a2a; border-radius:6px; padding:12px 20px; margin-bottom:16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .review-toolbar select, .review-toolbar input { background:#0f0f0f; border:1px solid #333; color:#aaa; padding:6px 10px; border-radius:4px; font-size:0.85rem; font-family:Georgia,serif; }
  .review-toolbar label { font-size:0.85rem; color:#888; }
  .review-table { width:100%; border-collapse:collapse; font-size:0.88rem; }
  .review-table th { text-align:left; padding:8px 12px; color:#666; font-weight:normal; border-bottom:1px solid #2a2a2a; font-size:0.78rem; letter-spacing:0.06em; text-transform:uppercase; }
  .review-table td { padding:8px 12px; border-bottom:1px solid #1a1a1a; vertical-align:top; }
  .review-table tr:hover td { background:#141414; }
  .review-table tr.excluded td { opacity:0.45; }
  .note-title { color:#c8b89a; font-size:0.9rem; line-height:1.3; }
  .note-excerpt { color:#666; font-size:0.82rem; line-height:1.4; margin-top:3px; max-width:480px; }
  .note-meta { color:#444; font-size:0.75rem; white-space:nowrap; }
  .note-tags { color:#5a4a3a; font-size:0.75rem; font-family:monospace; }
  .cb-exclude { width:16px; height:16px; accent-color:#c86e6e; cursor:pointer; }
  .btn-save-review { background:#1a3a1a; color:#6ec86e; border:1px solid #2a5a2a; padding:8px 24px; border-radius:5px; font-size:0.9rem; cursor:pointer; font-family:Georgia,serif; }
  .btn-save-review:hover { opacity:0.85; }
  .save-status { font-size:0.82rem; color:#666; }
  .pagination { display:flex; gap:8px; align-items:center; margin-top:20px; }
  .pagination a { color:#888; text-decoration:none; padding:5px 12px; border:1px solid #333; border-radius:4px; font-size:0.85rem; }
  .pagination a:hover, .pagination a.active { color:#c8b89a; border-color:#555; }
  .pagination span { color:#555; font-size:0.85rem; }
  /* Source note drawer */
  .drawer-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:100; }
  .drawer-overlay.open { display:block; }
  .drawer { position:fixed; top:0; right:0; width:min(680px,95vw); height:100vh; background:#141414; border-left:1px solid #333; z-index:101; display:flex; flex-direction:column; transform:translateX(100%); transition:transform 0.25s ease; }
  .drawer-overlay.open .drawer { transform:translateX(0); }
  .drawer-head { padding:16px 20px; border-bottom:1px solid #2a2a2a; display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .drawer-title { font-size:0.95rem; color:#c8b89a; line-height:1.4; flex:1; }
  .drawer-close { background:none; border:1px solid #444; color:#888; width:28px; height:28px; border-radius:4px; cursor:pointer; font-size:1rem; flex-shrink:0; }
  .drawer-close:hover { color:#ccc; border-color:#666; }
  .drawer-tabs { display:flex; gap:0; border-bottom:1px solid #2a2a2a; }
  .drawer-tab { padding:9px 18px; font-size:0.82rem; color:#666; cursor:pointer; border-bottom:2px solid transparent; background:none; border-top:none; border-left:none; border-right:none; font-family:Georgia,serif; }
  .drawer-tab.active { color:#c8b89a; border-bottom-color:#c8b89a; }
  .drawer-body { flex:1; overflow-y:auto; padding:20px; }
  .drawer-content { line-height:1.75; font-size:0.95rem; color:#ccc; white-space:pre-wrap; }
  .drawer-meta { font-size:0.78rem; color:#555; margin-bottom:14px; }
  .drawer-meta a { color:#6ea8c8; }
  .btn-source { background:none; border:none; color:#6ea8c8; font-size:0.82rem; cursor:pointer; padding:0; text-decoration:underline; font-family:Georgia,serif; }
  .btn-source:hover { color:#9ecce8; }
</style>
</head>
<body>
<header>
  <span style="font-size:1.6rem">🪨</span>
  <h1>QUARRY</h1>
  <nav>
    <a href="/" id="nav-pending">Pending</a>
    <a href="/approved" id="nav-approved">Approved</a>
    <a href="/review" id="nav-review">Review Notes</a>
  </nav>
</header>
<div class="container">`;

const HTML_FOOT = `</div>

<!-- Source note drawer -->
<div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer(event)">
  <div class="drawer" id="drawer">
    <div class="drawer-head">
      <div class="drawer-title" id="drawer-title"></div>
      <button class="drawer-close" onclick="closeDrawer()">✕</button>
    </div>
    <div class="drawer-tabs" id="drawer-tabs"></div>
    <div class="drawer-body">
      <div class="drawer-meta" id="drawer-meta"></div>
      <div class="drawer-content" id="drawer-content">Loading...</div>
    </div>
  </div>
</div>

<script>
function approve(id) {
  fetch('/api/narratives/' + id + '/approve', { method: 'POST' })
    .then(function(r) { if (r.ok) { document.getElementById('card-' + id).remove(); updateCount(); } });
}
function reject(id) {
  var reason = document.getElementById('reason-' + id).value.trim();
  fetch('/api/narratives/' + id + '/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason })
  }).then(function(r) { if (r.ok) { document.getElementById('card-' + id).remove(); updateCount(); } });
}
function copyText(id) {
  var text = document.getElementById('narrative-text-' + id).innerText;
  navigator.clipboard.writeText(text).then(function() {
    var btn = document.getElementById('copy-btn-' + id);
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });
}
function updateCount() {
  var remaining = document.querySelectorAll('.card').length;
  var el = document.getElementById('pending-count');
  if (el) el.textContent = remaining;
}

// Source note drawer
var _drawerData = {};
function openNote(noteId) {
  var overlay = document.getElementById('drawer-overlay');
  var content = document.getElementById('drawer-content');
  var title   = document.getElementById('drawer-title');
  var meta    = document.getElementById('drawer-meta');
  var tabs    = document.getElementById('drawer-tabs');

  content.textContent = 'Loading...';
  tabs.innerHTML = '';
  meta.innerHTML = '';
  overlay.classList.add('open');

  fetch('/api/notes/' + noteId)
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _drawerData[noteId] = d;
      title.textContent = d.title || 'Note';

      var metaParts = [];
      if (d.word_count) metaParts.push(d.word_count + ' words');
      if (d.content_type) metaParts.push(d.content_type);
      if (d.source_url) metaParts.push('<a href="' + d.source_url + '" target="_blank">original source ↗</a>');
      meta.innerHTML = metaParts.join(' · ');

      // Build tabs: Essay (if available), Raw Note
      var tabsHtml = '';
      var firstTab = 'raw';
      if (d.essay) {
        tabsHtml += '<button class="drawer-tab active" onclick="showTab(' + noteId + ', \\'essay\\', this)">Expository Essay</button>';
        firstTab = 'essay';
      }
      tabsHtml += '<button class="drawer-tab' + (firstTab === 'raw' ? ' active' : '') + '" onclick="showTab(' + noteId + ', \\'raw\\', this)">Raw Note</button>';
      if (d.verified && d.verified.length) {
        tabsHtml += '<button class="drawer-tab" onclick="showTab(' + noteId + ', \\'facts\\', this)">Verified Facts</button>';
      }
      tabs.innerHTML = tabsHtml;

      showTabContent(noteId, firstTab);
    })
    .catch(function(e) { content.textContent = 'Failed to load note: ' + e.message; });
}

function showTab(noteId, tab, btn) {
  document.querySelectorAll('.drawer-tab').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  showTabContent(noteId, tab);
}

function showTabContent(noteId, tab) {
  var d = _drawerData[noteId];
  if (!d) return;
  var content = document.getElementById('drawer-content');
  if (tab === 'essay') {
    content.textContent = d.essay || '(no essay)';
  } else if (tab === 'facts') {
    content.textContent = (d.verified || []).map(function(f) { return '• ' + f; }).join('\\n');
  } else {
    content.textContent = d.body || '(no content)';
  }
}

function closeDrawer(e) {
  if (e && e.target !== document.getElementById('drawer-overlay')) return;
  document.getElementById('drawer-overlay').classList.remove('open');
}

// Highlight active nav link
var path = window.location.pathname;
document.getElementById('nav-pending').className = path === '/' ? 'active' : '';
document.getElementById('nav-approved').className = path === '/approved' ? 'active' : '';
document.getElementById('nav-review').className = path.startsWith('/review') ? 'active' : '';
</script>
</body></html>`;

function renderBadge(register) {
  const cls = register === 'senior' ? 'badge-senior' : register === 'junior' ? 'badge-junior' : 'badge-unknown';
  return '<span class="badge ' + cls + '">' + (register || 'unknown') + '</span>';
}

function renderDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (_) { return iso.slice(0, 10); }
}

function renderPendingCard(n) {
  const sourceTitles = (n.sources || []).map(function(s) {
    return '<button class="btn-source" onclick="openNote(' + s.id + ')">' + escHtml(s.title) + '</button>';
  }).join(' &middot; ');

  return `
<div class="card" id="card-${n.id}">
  <div class="card-header">
    <div class="card-meta">
      ${renderBadge(n.register)}
      <span class="theme-tag">${escHtml(n.queue_theme || n.seed_theme || '')}</span>
      <span>${renderDate(n.produced_at)}</span>
      <span style="color:#444">${escHtml(n.model_used || '')}</span>
    </div>
  </div>
  <div class="card-body">
    <div class="narrative-text" id="narrative-text-${n.id}">${escHtml(n.body)}</div>
    <div class="sources">
      <strong>Sources:</strong> ${sourceTitles || '<em>none</em>'}
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-approve" onclick="approve(${n.id})">✓ Approve</button>
    <input class="reject-reason" id="reason-${n.id}" placeholder="Rejection reason (optional)" />
    <button class="btn btn-reject" onclick="reject(${n.id})">✗ Reject</button>
    <button class="btn btn-copy" id="copy-btn-${n.id}" onclick="copyText(${n.id})">Copy</button>
  </div>
</div>`;
}

function renderApprovedCard(n) {
  const sourceTitles = (n.sources || []).map(function(s) {
    return '<button class="btn-source" onclick="openNote(' + s.id + ')">' + escHtml(s.title) + '</button>';
  }).join(' &middot; ');

  return `
<div class="card" id="card-${n.id}">
  <div class="card-header">
    <div class="card-meta">
      ${renderBadge(n.register)}
      <span class="theme-tag">${escHtml(n.queue_theme || n.seed_theme || '')}</span>
      <span>${renderDate(n.produced_at)}</span>
      <span class="approved-date">approved ${renderDate(n.approved_at)}</span>
    </div>
  </div>
  <div class="card-body">
    <div class="narrative-text" id="narrative-text-${n.id}">${escHtml(n.body)}</div>
    <div class="sources">
      <strong>Sources:</strong> ${sourceTitles || '<em>none</em>'}
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-copy" id="copy-btn-${n.id}" onclick="copyText(${n.id})">Copy</button>
  </div>
</div>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------
function router(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;

  // Static: pending queue page
  if (method === 'GET' && url === '/') {
    const db       = openDb();
    ensureSchema(db);
    const pending  = getPendingNarratives(db).map(function(n) { return enrichNarrative(db, n); });
    db.close();

    const cards = pending.length
      ? pending.map(renderPendingCard).join('')
      : '<div class="empty">No narratives pending approval.</div>';

    const statsBar = `<div class="stats-bar"><span>Pending: <strong id="pending-count">${pending.length}</strong></span></div>`;
    const body = HTML_HEAD + '<p class="section-title">Pending Approval</p>' + statsBar + cards + HTML_FOOT;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  // Static: approved archive page
  if (method === 'GET' && url === '/approved') {
    const db       = openDb();
    ensureSchema(db);
    const approved = getApprovedNarratives(db).map(function(n) { return enrichNarrative(db, n); });
    db.close();

    const cards = approved.length
      ? approved.map(renderApprovedCard).join('')
      : '<div class="empty">No narratives approved yet.</div>';

    const statsBar = `<div class="stats-bar"><span>Approved: <strong>${approved.length}</strong></span></div>`;
    const body = HTML_HEAD + '<p class="section-title">Approved Archive</p>' + statsBar + cards + HTML_FOOT;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  // API: get pending
  if (method === 'GET' && url === '/api/narratives/pending') {
    const db      = openDb();
    ensureSchema(db);
    const pending = getPendingNarratives(db).map(function(n) { return enrichNarrative(db, n); });
    db.close();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pending));
    return;
  }

  // API: get approved
  if (method === 'GET' && url === '/api/narratives/approved') {
    const db       = openDb();
    ensureSchema(db);
    const approved = getApprovedNarratives(db).map(function(n) { return enrichNarrative(db, n); });
    db.close();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(approved));
    return;
  }

  // API: get single note with essay + verified facts
  const noteMatch = url.match(/^\/api\/notes\/(\d+)$/);
  if (method === 'GET' && noteMatch) {
    const id = parseInt(noteMatch[1], 10);
    const db = openDb();
    ensureSchema(db);

    const note = db.prepare(
      'SELECT id, title, filepath, source_url, word_count, content_type FROM vault_notes WHERE id = ?'
    ).get(id);

    if (!note) {
      db.close();
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Note not found' }));
      return;
    }

    // Get essay from classifications (Switch-3 or Switch-4)
    const essayRow = db.prepare(
      "SELECT claim FROM note_classifications WHERE note_id = ? AND bucket = 'essay' ORDER BY switch_level DESC LIMIT 1"
    ).get(id);

    // Get verified facts
    const verified = db.prepare(
      "SELECT claim FROM note_classifications WHERE note_id = ? AND bucket = 'verified' ORDER BY switch_level DESC LIMIT 12"
    ).all(id).map(function(r) { return r.claim; });

    db.close();

    // Read note body from file
    var body = '';
    try {
      const raw = fs.readFileSync(note.filepath, 'utf8');
      body = raw
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
        .replace(/_Created at[^_]*\._/g, '')
        .replace(/_Source URL:[^_]*\._/g, '')
        .trim();
    } catch (_) {}

    const result = Object.assign({}, note, {
      body:     body,
      essay:    essayRow ? essayRow.claim : null,
      verified: verified
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: approve
  const approveMatch = url.match(/^\/api\/narratives\/(\d+)\/approve$/);
  if (method === 'POST' && approveMatch) {
    const id = parseInt(approveMatch[1], 10);
    const db = openDb();
    ensureSchema(db);
    db.prepare(
      "UPDATE narratives SET approval_status = 'approved', approved_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), id);
    db.close();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: reject
  const rejectMatch = url.match(/^\/api\/narratives\/(\d+)\/reject$/);
  if (method === 'POST' && rejectMatch) {
    const id = parseInt(rejectMatch[1], 10);
    readBody(req, function(body) {
      var reason = '';
      try { reason = JSON.parse(body).reason || ''; } catch (_) {}
      const db = openDb();
      ensureSchema(db);
      db.prepare(
        "UPDATE narratives SET approval_status = 'rejected', rejection_reason = ? WHERE id = ?"
      ).run(reason, id);
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // Review notes page
  const reviewMatch = url.match(/^\/review(?:\?.*)?$/);
  if (method === 'GET' && reviewMatch) {
    const db = openDb();
    ensureSchema(db);

    const params    = new URLSearchParams(req.url.split('?')[1] || '');
    const page      = Math.max(1, parseInt(params.get('page') || '1', 10));
    const filter    = params.get('filter') || 'all';
    const search    = (params.get('q') || '').trim();
    const PAGE_SIZE = 100;
    const offset    = (page - 1) * PAGE_SIZE;

    var where = 'WHERE content_type != \'attachment\'';
    if (filter === 'obsidian') where += " AND origin = 'obsidian'";
    if (filter === 'untagged') where += ' AND has_tags = 0';
    if (filter === 'excluded') where += ' AND quarry_exclude = 1';
    if (filter === 'short')    where += ' AND word_count < 300';
    if (search) where += " AND (title LIKE '%" + search.replace(/'/g,"''") + "%' OR first_paragraph LIKE '%" + search.replace(/'/g,"''") + "%')";

    const total = db.prepare('SELECT COUNT(*) as n FROM vault_notes ' + where).get().n;
    const notes = db.prepare(
      'SELECT id, title, word_count, content_type, origin, first_paragraph, quarry_exclude, tag_source FROM vault_notes ' + where + ' ORDER BY origin, word_count DESC LIMIT ? OFFSET ?'
    ).all(PAGE_SIZE, offset);

    db.close();

    const totalPages = Math.ceil(total / PAGE_SIZE);

    const rows = notes.map(function(n) {
      const excerpt = (n.first_paragraph || '').slice(0, 160).replace(/\n/g, ' ');
      const checked = n.quarry_exclude ? 'checked' : '';
      const excClass = n.quarry_exclude ? 'excluded' : '';
      return '<tr class="' + excClass + '" id="row-' + n.id + '">' +
        '<td><input type="checkbox" class="cb-exclude" id="cb-' + n.id + '" ' + checked + ' onchange="markChanged(' + n.id + ')" data-id="' + n.id + '"></td>' +
        '<td><div class="note-title">' + escHtml(n.title) + '</div>' +
             '<div class="note-excerpt">' + escHtml(excerpt) + '</div></td>' +
        '<td class="note-meta">' + n.word_count + 'w</td>' +
        '<td class="note-meta">' + escHtml(n.origin) + '</td>' +
        '<td class="note-meta">' + escHtml(n.content_type) + '</td>' +
        '<td class="note-tags">' + escHtml(n.tag_source || '') + '</td>' +
        '</tr>';
    }).join('');

    var paginationHtml = '<div class="pagination">';
    paginationHtml += '<span>' + total + ' notes, page ' + page + ' of ' + totalPages + '</span>';
    if (page > 1) paginationHtml += '<a href="#" onclick="saveAndGo(\'/review?page=' + (page-1) + '&filter=' + filter + '&q=' + encodeURIComponent(search) + '\');return false;">← Prev</a>';
    if (page < totalPages) paginationHtml += '<a href="#" onclick="saveAndGo(\'/review?page=' + (page+1) + '&filter=' + filter + '&q=' + encodeURIComponent(search) + '\');return false;">Next →</a>';
    paginationHtml += '</div>';

    const toolbar = '<div class="review-toolbar">' +
      '<label>Filter: <select onchange="applyFilter(this.value)" id="filter-sel">' +
      '<option value="all"' + (filter==='all'?' selected':'') + '>All notes</option>' +
      '<option value="obsidian"' + (filter==='obsidian'?' selected':'') + '>Obsidian origin</option>' +
      '<option value="untagged"' + (filter==='untagged'?' selected':'') + '>Untagged</option>' +
      '<option value="short"' + (filter==='short'?' selected':'') + '>Short (&lt;300w)</option>' +
      '<option value="excluded"' + (filter==='excluded'?' selected':'') + '>Already excluded</option>' +
      '</select></label>' +
      '<input type="text" id="search-box" placeholder="Search titles..." value="' + escHtml(search) + '" onkeydown="if(event.key===\'Enter\')applyFilter()" style="width:200px">' +
      '<button class="btn-save-review" onclick="saveExclusions()">Save</button>' +
      '<span class="save-status" id="save-status"></span>' +
      '<label style="margin-left:auto"><input type="checkbox" onchange="selectAll(this)"> Select all visible</label>' +
      '</div>';

    const table = '<table class="review-table">' +
      '<thead><tr><th style="width:32px"></th><th>Note</th><th>Words</th><th>Origin</th><th>Type</th><th>Tag src</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>';

    const reviewScript = '<script>' +
      'var _changed = {};' +
      'var _pendingNav = null;' +
      'window.addEventListener("beforeunload", function(e) { if (Object.keys(_changed).length > 0) { e.preventDefault(); e.returnValue = ""; } });' +
      'function markChanged(id) { _changed[id] = document.getElementById("cb-"+id).checked; var row=document.getElementById("row-"+id); row.className=document.getElementById("cb-"+id).checked?"excluded":""; document.getElementById("save-status").textContent=Object.keys(_changed).length+" unsaved change(s)"; }' +
      'function selectAll(cb) { document.querySelectorAll(".cb-exclude").forEach(function(c){ c.checked=cb.checked; markChanged(c.dataset.id); }); }' +
      'function applyFilter(val) {' +
      '  var f=val||document.getElementById("filter-sel").value;' +
      '  var q=document.getElementById("search-box").value;' +
      '  saveAndGo("/review?filter="+f+"&q="+encodeURIComponent(q)); }' +
      'function saveAndGo(url) {' +
      '  if (!Object.keys(_changed).length) { window.location=url; return; }' +
      '  document.getElementById("save-status").textContent="Saving...";' +
      '  fetch("/api/notes/exclude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(_changed)})' +
      '  .then(function(r){return r.json();})' +
      '  .then(function(d){ _changed={}; window.location=url; })' +
      '  .catch(function(){ document.getElementById("save-status").textContent="Save failed — navigate anyway?"; _pendingNav=url; }); }' +
      'function saveExclusions() {' +
      '  var ids=Object.keys(_changed);' +
      '  if(!ids.length){document.getElementById("save-status").textContent="Nothing changed.";return;}' +
      '  document.getElementById("save-status").textContent="Saving...";' +
      '  fetch("/api/notes/exclude",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(_changed)})' +
      '  .then(function(r){return r.json();})' +
      '  .then(function(d){document.getElementById("save-status").textContent="Saved "+d.updated+" notes. ✓";_changed={};})' +
      '  .catch(function(){document.getElementById("save-status").textContent="Save failed.";});' +
      '}' +
      '</script>';

    const body = HTML_HEAD + '<p class="section-title">Note Review — mark notes to exclude from QUARRY narratives</p>' +
      toolbar + table + paginationHtml + reviewScript + HTML_FOOT;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  // API: save exclusions
  if (method === 'POST' && url === '/api/notes/exclude') {
    readBody(req, function(rawBody) {
      var changes = {};
      try { changes = JSON.parse(rawBody); } catch (_) {}
      const db = openDb();
      ensureSchema(db);
      var updated = 0;
      Object.keys(changes).forEach(function(id) {
        db.prepare('UPDATE vault_notes SET quarry_exclude = ? WHERE id = ?')
          .run(changes[id] ? 1 : 0, parseInt(id, 10));
        updated++;
      });
      db.close();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, updated: updated }));
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end('Not found');
}

function readBody(req, cb) {
  var body = '';
  req.on('data', function(chunk) { body += chunk; });
  req.on('end', function() { cb(body); });
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------
const server = http.createServer(router);
server.listen(PORT, '0.0.0.0', function() {
  console.log('🪨 QUARRY server running at http://localhost:' + PORT);
  console.log('   Pending queue:  http://localhost:' + PORT + '/');
  console.log('   Approved archive: http://localhost:' + PORT + '/approved');
  console.log('   DB: ' + DB_PATH);
  console.log('   Press Ctrl+C to stop.');
});