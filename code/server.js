#!/usr/bin/env node
/**
 * QUARRY server.js v0.2
 * Local web UI for narrative approval queue, archive, stats, and note browser.
 *
 * Views:
 *   /           → Pending approval queue
 *   /approved   → Approved narrative archive
 *   /stats      → Vault statistics dashboard
 *   /notes      → Browse all notes (paginated, filterable)
 *   /review     → Mark notes quarry_exclude
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.QUARRY_DB || path.join(process.env.HOME, 'quarry', 'vault.db');
const PORT = (() => { const i = process.argv.indexOf('--port'); return i !== -1 ? parseInt(process.argv[i+1],10) : 3001; })();

function openDb() {
  if (!fs.existsSync(DB_PATH)) { console.error('vault.db not found'); process.exit(1); }
  return new DatabaseSync(DB_PATH);
}

function ensureSchema(db) {
  const cols = db.prepare('PRAGMA table_info(narratives)').all().map(c => c.name);
  if (!cols.includes('approval_status')) db.exec("ALTER TABLE narratives ADD COLUMN approval_status TEXT DEFAULT 'pending'");
  if (!cols.includes('approved_at'))     db.exec('ALTER TABLE narratives ADD COLUMN approved_at TEXT');
  if (!cols.includes('rejection_reason'))db.exec('ALTER TABLE narratives ADD COLUMN rejection_reason TEXT');
  const nc = db.prepare('PRAGMA table_info(vault_notes)').all().map(c => c.name);
  if (!nc.includes('quarry_exclude'))    db.exec('ALTER TABLE vault_notes ADD COLUMN quarry_exclude INTEGER DEFAULT 0');
}

function getNotesByIds(db, json) {
  try { const ids = JSON.parse(json); if (!ids.length) return []; return db.prepare('SELECT id, title, source_url FROM vault_notes WHERE id IN (' + ids.join(',') + ')').all(); } catch(_) { return []; }
}
function enrichNarrative(db, n) { return Object.assign({}, n, { sources: getNotesByIds(db, n.note_ids||'[]') }); }

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'}); } catch(_) { return iso.slice(0,10); }
}
function renderBadge(r) {
  const cls = r==='senior'?'badge-senior':r==='junior'?'badge-junior':'badge-unknown';
  return '<span class="badge '+cls+'">'+(r||'unknown')+'</span>';
}

// ---------------------------------------------------------------------------
// HTML SHELL
// ---------------------------------------------------------------------------
const CSS = `
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Georgia,serif; background:#0f0f0f; color:#e8e4dc; min-height:100vh; }
  header { background:#1a1a1a; border-bottom:1px solid #333; padding:16px 24px; display:flex; align-items:center; gap:16px; }
  header h1 { font-size:1.4rem; letter-spacing:.05em; color:#c8b89a; }
  nav { display:flex; gap:8px; }
  nav a { color:#888; text-decoration:none; font-size:.9rem; padding:6px 14px; border-radius:4px; border:1px solid #333; }
  nav a:hover, nav a.active { color:#c8b89a; border-color:#555; }
  .container { max-width:960px; margin:0 auto; padding:32px 24px; }
  .empty { text-align:center; color:#555; padding:64px; font-size:1.1rem; }
  .section-title { font-size:.85rem; color:#666; letter-spacing:.1em; text-transform:uppercase; margin-bottom:20px; }
  .stats-bar { background:#141414; border:1px solid #2a2a2a; border-radius:6px; padding:12px 20px; margin-bottom:24px; display:flex; gap:24px; font-size:.85rem; color:#888; flex-wrap:wrap; }
  .stats-bar strong { color:#c8b89a; }
  /* Cards */
  .card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:8px; margin-bottom:24px; overflow:hidden; }
  .card-header { padding:14px 20px; background:#141414; border-bottom:1px solid #2a2a2a; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
  .card-meta { font-size:.78rem; color:#666; }
  .card-meta span { margin-right:12px; }
  .badge { display:inline-block; font-size:.7rem; padding:2px 8px; border-radius:10px; font-family:monospace; }
  .badge-senior { background:#2a1f0e; color:#c8a96e; border:1px solid #5a3e1a; }
  .badge-junior { background:#0e1f2a; color:#6eacc8; border:1px solid #1a5a7a; }
  .badge-unknown { background:#1f1f1f; color:#888; border:1px solid #333; }
  .card-body { padding:20px; }
  .narrative-text { line-height:1.75; font-size:1.05rem; color:#d8d0c4; white-space:pre-wrap; }
  .sources { margin-top:16px; padding-top:14px; border-top:1px solid #2a2a2a; font-size:.82rem; color:#666; }
  .sources strong { color:#888; }
  .actions { padding:14px 20px; background:#141414; border-top:1px solid #2a2a2a; display:flex; gap:10px; align-items:center; }
  .btn { padding:8px 20px; border-radius:5px; border:none; font-size:.9rem; cursor:pointer; font-family:Georgia,serif; transition:opacity .15s; }
  .btn:hover { opacity:.85; }
  .btn-approve { background:#1a3a1a; color:#6ec86e; border:1px solid #2a5a2a; }
  .btn-reject  { background:#3a1a1a; color:#c86e6e; border:1px solid #5a2a2a; }
  .btn-copy    { background:#1f1f2a; color:#8888cc; border:1px solid #33335a; }
  .btn-source  { background:none; border:none; color:#6ea8c8; font-size:.82rem; cursor:pointer; padding:0; text-decoration:underline; font-family:Georgia,serif; }
  .reject-reason { flex:1; background:#0f0f0f; border:1px solid #333; color:#aaa; padding:7px 12px; border-radius:4px; font-size:.85rem; font-family:Georgia,serif; }
  .theme-tag { font-size:.75rem; color:#8a7a6a; font-family:monospace; background:#1f1a12; padding:2px 8px; border-radius:3px; border:1px solid #3a3020; }
  .approved-date { font-size:.78rem; color:#4a6a4a; }
  /* Stats page */
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:16px; margin-bottom:28px; }
  .stat-card { background:#141414; border:1px solid #2a2a2a; border-radius:8px; padding:20px; }
  .stat-card .num { font-size:2rem; color:#c8b89a; font-weight:bold; line-height:1; margin-bottom:6px; }
  .stat-card .lbl { font-size:.78rem; color:#666; text-transform:uppercase; letter-spacing:.08em; }
  .stat-card .sub { font-size:.82rem; color:#555; margin-top:4px; }
  .progress-bar { background:#1a1a1a; border-radius:4px; height:8px; overflow:hidden; margin:6px 0; }
  .progress-fill { height:100%; background:#5a3e1a; border-radius:4px; transition:width .3s; }
  .breakdown { background:#141414; border:1px solid #2a2a2a; border-radius:8px; padding:20px; margin-bottom:20px; }
  .breakdown h3 { font-size:.82rem; color:#888; text-transform:uppercase; letter-spacing:.08em; margin-bottom:14px; }
  .breakdown-row { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid #1a1a1a; font-size:.88rem; }
  .breakdown-row:last-child { border-bottom:none; }
  .breakdown-row .key { color:#aaa; }
  .breakdown-row .val { color:#c8b89a; font-family:monospace; }
  /* Notes browser */
  .note-table { width:100%; border-collapse:collapse; font-size:.85rem; }
  .note-table th { text-align:left; padding:8px 10px; color:#555; font-weight:normal; border-bottom:1px solid #2a2a2a; font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; }
  .note-table td { padding:8px 10px; border-bottom:1px solid #141414; vertical-align:top; }
  .note-table tr:hover td { background:#141414; cursor:pointer; }
  .nt { color:#c8b89a; font-size:.88rem; line-height:1.3; }
  .nx { color:#555; font-size:.78rem; margin-top:2px; max-width:440px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .nm { color:#444; font-size:.75rem; white-space:nowrap; }
  .ntag { font-size:.7rem; color:#5a4a3a; font-family:monospace; }
  .s4-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#5a3e1a; margin-right:4px; }
  /* Review */
  .review-toolbar { background:#141414; border:1px solid #2a2a2a; border-radius:6px; padding:12px 20px; margin-bottom:16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .review-toolbar select, .review-toolbar input { background:#0f0f0f; border:1px solid #333; color:#aaa; padding:6px 10px; border-radius:4px; font-size:.85rem; font-family:Georgia,serif; }
  .review-toolbar label { font-size:.85rem; color:#888; }
  .cb-exclude { width:16px; height:16px; accent-color:#c86e6e; cursor:pointer; }
  .btn-save-review { background:#1a3a1a; color:#6ec86e; border:1px solid #2a5a2a; padding:8px 24px; border-radius:5px; font-size:.9rem; cursor:pointer; font-family:Georgia,serif; }
  .save-status { font-size:.82rem; color:#666; }
  .tr-excluded td { opacity:.4; }
  /* Pagination */
  .pagination { display:flex; gap:8px; align-items:center; margin-top:20px; flex-wrap:wrap; }
  .pagination a { color:#888; text-decoration:none; padding:5px 12px; border:1px solid #333; border-radius:4px; font-size:.85rem; }
  .pagination a:hover { color:#c8b89a; border-color:#555; }
  .pagination span { color:#555; font-size:.85rem; }
  /* Drawer */
  .drawer-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,.7); z-index:100; }
  .drawer-overlay.open { display:block; }
  .drawer { position:fixed; top:0; right:0; width:min(700px,95vw); height:100vh; background:#141414; border-left:1px solid #333; z-index:101; display:flex; flex-direction:column; transform:translateX(100%); transition:transform .25s ease; }
  .drawer-overlay.open .drawer { transform:translateX(0); }
  .drawer-head { padding:16px 20px; border-bottom:1px solid #2a2a2a; display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
  .drawer-title { font-size:.95rem; color:#c8b89a; line-height:1.4; flex:1; }
  .drawer-close { background:none; border:1px solid #444; color:#888; width:28px; height:28px; border-radius:4px; cursor:pointer; font-size:1rem; flex-shrink:0; }
  .drawer-tabs { display:flex; border-bottom:1px solid #2a2a2a; }
  .drawer-tab { padding:9px 18px; font-size:.82rem; color:#666; cursor:pointer; border-bottom:2px solid transparent; background:none; border-top:none; border-left:none; border-right:none; font-family:Georgia,serif; }
  .drawer-tab.active { color:#c8b89a; border-bottom-color:#c8b89a; }
  .drawer-body { flex:1; overflow-y:auto; padding:20px; }
  .drawer-content { line-height:1.75; font-size:.92rem; color:#ccc; white-space:pre-wrap; }
  .drawer-meta { font-size:.78rem; color:#555; margin-bottom:14px; }
  .drawer-meta a { color:#6ea8c8; }
`;

function htmlShell(title, bodyContent, activeNav) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪨 QUARRY — ${escHtml(title)}</title>
<style>${CSS}</style></head><body>
<header>
  <span style="font-size:1.6rem">🪨</span>
  <h1>QUARRY</h1>
  <nav>
    <a href="/" id="nav-pending" class="${activeNav==='pending'?'active':''}">Pending</a>
    <a href="/approved" id="nav-approved" class="${activeNav==='approved'?'active':''}">Approved</a>
    <a href="/stats" id="nav-stats" class="${activeNav==='stats'?'active':''}">Stats</a>
    <a href="/notes" id="nav-notes" class="${activeNav==='notes'?'active':''}">Notes</a>
    <a href="/review" id="nav-review" class="${activeNav==='review'?'active':''}">Review</a>
  </nav>
</header>
<div class="container">
${bodyContent}
</div>
${DRAWER_HTML}
${COMMON_JS}
</body></html>`;
}

const DRAWER_HTML = `
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
</div>`;

const COMMON_JS = `<script>
var _drawerData = {};
var _currentNote = null;
function openNote(noteId) {
  _currentNote = noteId;
  var o=document.getElementById('drawer-overlay'),c=document.getElementById('drawer-content'),
      t=document.getElementById('drawer-title'),m=document.getElementById('drawer-meta'),
      tb=document.getElementById('drawer-tabs');
  c.textContent='Loading...'; tb.innerHTML=''; m.innerHTML=''; o.classList.add('open');
  fetch('/api/notes/'+noteId).then(function(r){return r.json();}).then(function(d){
    _drawerData[noteId]=d; t.textContent=d.title||'Note';
    var mp=[]; if(d.word_count) mp.push(d.word_count+' words'); if(d.content_type) mp.push(d.content_type);
    if(d.source_url) mp.push('<a href="'+d.source_url+'" target="_blank">source ↗</a>');
    m.innerHTML=mp.join(' · ')+'&nbsp;&nbsp;<button onclick="startEdit('+noteId+')" style="background:none;border:1px solid #444;color:#888;padding:2px 10px;border-radius:3px;cursor:pointer;font-size:.78rem;">✎ Edit</button>';
    var th='',ft='raw';
    if(d.essay){th+='<button class="drawer-tab active" onclick="showTab('+noteId+',\\'essay\\',this)">Essay</button>';ft='essay';}
    th+='<button class="drawer-tab'+(ft==='raw'?' active':'')+'" onclick="showTab('+noteId+',\\'raw\\',this)">Raw Note</button>';
    if(d.verified&&d.verified.length) th+='<button class="drawer-tab" onclick="showTab('+noteId+',\\'facts\\',this)">Verified ('+d.verified.length+')</button>';
    tb.innerHTML=th; showTabContent(noteId,ft);
  }).catch(function(e){c.textContent='Failed: '+e.message;});
}
function startEdit(noteId) {
  var d=_drawerData[noteId]; if(!d) return;
  var c=document.getElementById('drawer-content');
  c.innerHTML='<textarea id="note-editor" style="width:100%;height:calc(100vh - 260px);background:#0f0f0f;color:#e8e4dc;border:1px solid #555;padding:14px;font-family:monospace;font-size:.9rem;line-height:1.65;resize:none;">'+escHtml(d.body||'')+'</textarea>'+
    '<div style="margin-top:10px;display:flex;gap:8px">'+
    '<button onclick="saveNote('+noteId+')" style="background:#1a3a1a;color:#6ec86e;border:1px solid #2a5a2a;padding:7px 18px;border-radius:4px;cursor:pointer;">💾 Save</button>'+
    '<button onclick="openNote('+noteId+')" style="background:#3a1a1a;color:#c86e6e;border:1px solid #5a2a2a;padding:7px 18px;border-radius:4px;cursor:pointer;">Cancel</button>'+
    '</div>';
}
function saveNote(noteId) {
  var ta=document.getElementById('note-editor'); if(!ta) return;
  fetch('/api/notes/'+noteId+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:ta.value})})
  .then(function(r){return r.json();})
  .then(function(res){
    if(res.ok){alert('Saved (backup created at .bak)');openNote(noteId);}
    else alert('Save failed: '+(res.error||'unknown'));
  }).catch(function(e){alert('Error: '+e.message);});
}
function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function showTab(id,tab,btn){
  document.querySelectorAll('.drawer-tab').forEach(function(b){b.classList.remove('active');});
  if(btn) btn.classList.add('active'); showTabContent(id,tab);
}
function showTabContent(id,tab){
  var d=_drawerData[id]; if(!d) return;
  var c=document.getElementById('drawer-content');
  if(tab==='essay') c.textContent=d.essay||'(no essay)';
  else if(tab==='facts') c.textContent=(d.verified||[]).map(function(f){return '• '+f;}).join('\\n');
  else c.textContent=d.body||'(no content)';
}
function closeDrawer(e){
  if(e&&e.target!==document.getElementById('drawer-overlay')) return;
  document.getElementById('drawer-overlay').classList.remove('open');
}
function approve(id){fetch('/api/narratives/'+id+'/approve',{method:'POST'}).then(function(r){if(r.ok){document.getElementById('card-'+id).remove();updateCount();}});}
function reject(id){
  var reason=document.getElementById('reason-'+id).value.trim();
  fetch('/api/narratives/'+id+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:reason})})
  .then(function(r){if(r.ok){document.getElementById('card-'+id).remove();updateCount();}});
}
function copyText(id){
  var text=document.getElementById('narrative-text-'+id).innerText;
  navigator.clipboard.writeText(text).then(function(){
    var b=document.getElementById('copy-btn-'+id); b.textContent='Copied!';
    setTimeout(function(){b.textContent='Copy';},1500);
  });
}
function updateCount(){var r=document.querySelectorAll('.card').length,e=document.getElementById('pending-count');if(e)e.textContent=r;}
</script>`;

// ---------------------------------------------------------------------------
// PAGE RENDERERS
// ---------------------------------------------------------------------------
function renderPendingCard(n) {
  const src = (n.sources||[]).map(s=>'<button class="btn-source" onclick="openNote('+s.id+')">'+escHtml(s.title)+'</button>').join(' &middot; ');
  return `<div class="card" id="card-${n.id}">
  <div class="card-header"><div class="card-meta">${renderBadge(n.register)}<span class="theme-tag">${escHtml(n.queue_theme||n.seed_theme||'')}</span><span>${renderDate(n.produced_at)}</span><span style="color:#444">${escHtml(n.model_used||'')}</span></div></div>
  <div class="card-body"><div class="narrative-text" id="narrative-text-${n.id}">${escHtml(n.body)}</div><div class="sources"><strong>Sources:</strong> ${src||'<em>none</em>'}</div></div>
  <div class="actions"><button class="btn btn-approve" onclick="approve(${n.id})">✓ Approve</button><input class="reject-reason" id="reason-${n.id}" placeholder="Rejection reason (optional)"/><button class="btn btn-reject" onclick="reject(${n.id})">✗ Reject</button><button class="btn btn-copy" id="copy-btn-${n.id}" onclick="copyText(${n.id})">Copy</button></div>
</div>`;
}

function renderApprovedCard(n) {
  const src = (n.sources||[]).map(s=>'<button class="btn-source" onclick="openNote('+s.id+')">'+escHtml(s.title)+'</button>').join(' &middot; ');
  return `<div class="card" id="card-${n.id}">
  <div class="card-header"><div class="card-meta">${renderBadge(n.register)}<span class="theme-tag">${escHtml(n.queue_theme||n.seed_theme||'')}</span><span>${renderDate(n.produced_at)}</span><span class="approved-date">approved ${renderDate(n.approved_at)}</span></div></div>
  <div class="card-body"><div class="narrative-text" id="narrative-text-${n.id}">${escHtml(n.body)}</div><div class="sources"><strong>Sources:</strong> ${src||'<em>none</em>'}</div></div>
  <div class="actions"><button class="btn btn-copy" id="copy-btn-${n.id}" onclick="copyText(${n.id})">Copy</button></div>
</div>`;
}

function renderStatsPage(db) {
  const total      = db.prepare('SELECT COUNT(*) as n FROM vault_notes').get().n;
  const tagged     = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE has_tags=1').get().n;
  const classified = db.prepare('SELECT COUNT(DISTINCT note_id) as n FROM note_classifications').get().n;
  const s4         = db.prepare("SELECT COUNT(DISTINCT note_id) as n FROM note_classifications WHERE switch_level=4").get().n;
  const excluded   = db.prepare('SELECT COUNT(*) as n FROM vault_notes WHERE quarry_exclude=1').get().n;
  const narratives = db.prepare('SELECT COUNT(*) as n FROM narratives').get().n;
  const approved   = db.prepare("SELECT COUNT(*) as n FROM narratives WHERE approval_status='approved'").get().n;
  const budget     = db.prepare('SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget').get().t;
  const s4cost     = db.prepare("SELECT COALESCE(SUM(cost_usd),0) as t FROM api_budget WHERE component='classifier-s4'").get().t;

  const byType   = db.prepare("SELECT content_type, COUNT(*) as n FROM vault_notes GROUP BY content_type ORDER BY n DESC").all();
  const byOrigin = db.prepare("SELECT origin, COUNT(*) as n FROM vault_notes GROUP BY origin ORDER BY n DESC").all();
  const bySrc    = db.prepare("SELECT COALESCE(tag_source,'original') as src, COUNT(*) as n FROM vault_notes WHERE has_tags=1 GROUP BY tag_source ORDER BY n DESC").all();
  const bySize   = db.prepare("SELECT CASE WHEN word_count<200 THEN 'stub (<200w)' WHEN word_count<1000 THEN 'short (200-1k)' WHEN word_count<5000 THEN 'medium (1k-5k)' ELSE 'long (5k+)' END as bucket, COUNT(*) as n FROM vault_notes GROUP BY bucket ORDER BY n DESC").all();
  const topTags  = db.prepare("SELECT tag_root, COUNT(*) as n FROM note_tags GROUP BY tag_root ORDER BY n DESC LIMIT 15").all();
  const unclassifiedBySize = db.prepare("SELECT CASE WHEN word_count<200 THEN 'stub' WHEN word_count<1000 THEN 'short' WHEN word_count<5000 THEN 'medium' ELSE 'long' END as bucket, COUNT(*) as n FROM vault_notes WHERE classification_at IS NULL AND content_type IN ('article','note','video') GROUP BY bucket ORDER BY n DESC").all();

  function breakdownHtml(title, rows, keyField, valField) {
    return '<div class="breakdown"><h3>'+escHtml(title)+'</h3>' +
      rows.map(r=>'<div class="breakdown-row"><span class="key">'+escHtml(String(r[keyField]))+'</span><span class="val">'+r[valField]+'</span></div>').join('') +
      '</div>';
  }

  const tagPct = Math.round(tagged/total*100);
  const clsPct = Math.round(classified/total*100);

  return `
<p class="section-title">Vault Statistics</p>
<div class="stat-grid">
  <div class="stat-card"><div class="num">${total.toLocaleString()}</div><div class="lbl">Total Notes</div></div>
  <div class="stat-card"><div class="num">${tagged.toLocaleString()}</div><div class="lbl">Tagged</div><div class="progress-bar"><div class="progress-fill" style="width:${tagPct}%"></div></div><div class="sub">${tagPct}% of vault</div></div>
  <div class="stat-card"><div class="num">${classified.toLocaleString()}</div><div class="lbl">Classified (S3/S4)</div><div class="progress-bar"><div class="progress-fill" style="width:${clsPct}%;background:#1a4a2a"></div></div><div class="sub">${clsPct}% · ${s4} with Switch-4</div></div>
  <div class="stat-card"><div class="num">${narratives}</div><div class="lbl">Narratives</div><div class="sub">${approved} approved</div></div>
  <div class="stat-card"><div class="num">$${budget.toFixed(3)}</div><div class="lbl">API Spend</div><div class="sub">S4: $${s4cost.toFixed(3)} · ceiling $10.00</div></div>
  <div class="stat-card"><div class="num">${excluded}</div><div class="lbl">Excluded (quarry_exclude)</div></div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
  ${breakdownHtml('By Content Type', byType, 'content_type', 'n')}
  ${breakdownHtml('By Origin', byOrigin, 'origin', 'n')}
  ${breakdownHtml('By Word Count', bySize, 'bucket', 'n')}
  ${breakdownHtml('By Tag Source', bySrc, 'src', 'n')}
  ${breakdownHtml('Unclassified by Size', unclassifiedBySize, 'bucket', 'n')}
  ${breakdownHtml('Top Tag Roots', topTags, 'tag_root', 'n')}
</div>`;
}

function renderNotesPage(db, params) {
  const page     = Math.max(1, parseInt(params.get('page')||'1',10));
  const filter   = params.get('filter')||'all';
  const search   = (params.get('q')||'').trim();
  const sort     = params.get('sort')||'words';
  const PAGE_SIZE = 100;
  const offset   = (page-1)*PAGE_SIZE;

  let where = "WHERE content_type != 'attachment'";
  if (filter==='classified')   where += ' AND classification_at IS NOT NULL';
  if (filter==='unclassified') where += ' AND classification_at IS NULL';
  if (filter==='tagged')       where += ' AND has_tags=1';
  if (filter==='untagged')     where += ' AND has_tags=0';
  if (filter==='s4')           where += ' AND id IN (SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4)';
  if (filter==='excluded')     where += ' AND quarry_exclude=1';
  if (filter==='article')      where += " AND content_type='article'";
  if (filter==='note')         where += " AND content_type='note'";
  if (filter==='stub')         where += " AND content_type='stub'";
  if (search) where += " AND (title LIKE '%"+search.replace(/'/g,"''") +"%' OR first_paragraph LIKE '%"+search.replace(/'/g,"''")+"%')";

  const orderBy = sort==='title' ? 'title ASC' : sort==='date' ? 'file_mtime DESC' : 'word_count DESC';

  const total = db.prepare('SELECT COUNT(*) as n FROM vault_notes '+where).get().n;
  const notes = db.prepare('SELECT id,title,word_count,content_type,origin,first_paragraph,tag_source,classification_at,quarry_exclude FROM vault_notes '+where+' ORDER BY '+orderBy+' LIMIT ? OFFSET ?').all(PAGE_SIZE, offset);
  const s4ids = new Set(db.prepare('SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4').all().map(r=>r.note_id));

  const totalPages = Math.ceil(total/PAGE_SIZE);

  function pageLink(p) { return '/notes?page='+p+'&filter='+encodeURIComponent(filter)+'&sort='+sort+'&q='+encodeURIComponent(search); }

  const rows = notes.map(n => {
    const excerpt = (n.first_paragraph||'').slice(0,140).replace(/\n/g,' ');
    const s4 = s4ids.has(n.id) ? '<span class="s4-dot" title="Switch-4 classified"></span>' : '';
    const excl = n.quarry_exclude ? ' style="opacity:.4"' : '';
    return '<tr onclick="openNote('+n.id+')"'+excl+'><td><div class="nt">'+s4+escHtml(n.title)+'</div><div class="nx">'+escHtml(excerpt)+'</div></td>'+
      '<td class="nm">'+n.word_count+'w</td>'+
      '<td class="nm">'+escHtml(n.content_type)+'</td>'+
      '<td class="nm">'+escHtml(n.origin)+'</td>'+
      '<td class="ntag">'+escHtml(n.tag_source||'')+(n.classification_at?'<br><span style="color:#2a5a2a">✓cls</span>':'')+'</td></tr>';
  }).join('');

  const filterOpts = [['all','All'],['article','Articles'],['note','Notes'],['stub','Stubs'],['classified','Classified'],['unclassified','Unclassified'],['s4','Switch-4'],['tagged','Tagged'],['untagged','Untagged'],['excluded','Excluded']];
  const sortOpts   = [['words','By words'],['title','By title'],['date','By date']];

  const toolbar = '<div class="review-toolbar">'+
    '<label>Filter: <select onchange="applyNotesFilter()" id="f-sel">'+filterOpts.map(([v,l])=>'<option value="'+v+'"'+(filter===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label>'+
    '<label>Sort: <select onchange="applyNotesFilter()" id="s-sel">'+sortOpts.map(([v,l])=>'<option value="'+v+'"'+(sort===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label>'+
    '<input type="text" id="q-box" placeholder="Search..." value="'+escHtml(search)+'" onkeydown="if(event.key===\'Enter\')applyNotesFilter()" style="width:180px">'+
    '</div>';

  let pag = '<div class="pagination"><span>'+total.toLocaleString()+' notes, page '+page+' of '+totalPages+'</span>';
  if (page>1) pag += '<a href="'+pageLink(1)+'">«</a><a href="'+pageLink(page-1)+'">‹ Prev</a>';
  // show up to 5 page links around current
  for (let p=Math.max(1,page-2);p<=Math.min(totalPages,page+2);p++) {
    pag += '<a href="'+pageLink(p)+'"'+(p===page?' style="color:#c8b89a;border-color:#555"':'')+'>'+p+'</a>';
  }
  if (page<totalPages) pag += '<a href="'+pageLink(page+1)+'">Next ›</a><a href="'+pageLink(totalPages)+'">»</a>';
  pag += '</div>';

  const script = '<script>function applyNotesFilter(){var f=document.getElementById("f-sel").value,s=document.getElementById("s-sel").value,q=document.getElementById("q-box").value;window.location="/notes?filter="+f+"&sort="+s+"&q="+encodeURIComponent(q);}</script>';

  return '<p class="section-title">Notes Browser — click any row to read</p>'+
    toolbar+
    '<table class="note-table"><thead><tr><th>Note</th><th>Words</th><th>Type</th><th>Origin</th><th>Tags</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    pag+script;
}

function renderReviewPage(db, params) {
  const page     = Math.max(1, parseInt(params.get('page')||'1',10));
  const filter   = params.get('filter')||'all';
  const search   = (params.get('q')||'').trim();
  const PAGE_SIZE = 100;
  const offset   = (page-1)*PAGE_SIZE;

  let where = "WHERE content_type != 'attachment'";
  if (filter==='obsidian') where += " AND origin='obsidian'";
  if (filter==='untagged') where += ' AND has_tags=0';
  if (filter==='excluded') where += ' AND quarry_exclude=1';
  if (filter==='short')    where += ' AND word_count<300';
  if (search) where += " AND (title LIKE '%"+search.replace(/'/g,"''")+"%' OR first_paragraph LIKE '%"+search.replace(/'/g,"''")+"%')";

  const total = db.prepare('SELECT COUNT(*) as n FROM vault_notes '+where).get().n;
  const notes = db.prepare('SELECT id,title,word_count,content_type,origin,first_paragraph,quarry_exclude,tag_source FROM vault_notes '+where+' ORDER BY origin,word_count DESC LIMIT ? OFFSET ?').all(PAGE_SIZE,offset);
  const totalPages = Math.ceil(total/PAGE_SIZE);

  function pageLink(p) { return '/review?page='+p+'&filter='+encodeURIComponent(filter)+'&q='+encodeURIComponent(search); }

  const rows = notes.map(n=>{
    const ex = (n.first_paragraph||'').slice(0,160).replace(/\n/g,' ');
    const ch = n.quarry_exclude?'checked':'';
    const cl = n.quarry_exclude?'tr-excluded':'';
    return '<tr class="'+cl+'" id="row-'+n.id+'">'+
      '<td><input type="checkbox" class="cb-exclude" id="cb-'+n.id+'" '+ch+' onchange="markChanged('+n.id+')" data-id="'+n.id+'"></td>'+
      '<td><div class="nt">'+escHtml(n.title)+'</div><div class="nx">'+escHtml(ex)+'</div></td>'+
      '<td class="nm">'+n.word_count+'w</td>'+
      '<td class="nm">'+escHtml(n.origin)+'</td>'+
      '<td class="nm">'+escHtml(n.content_type)+'</td>'+
      '<td class="ntag">'+escHtml(n.tag_source||'')+'</td></tr>';
  }).join('');

  const filterOpts = [['all','All'],['obsidian','Obsidian'],['untagged','Untagged'],['short','Short (<300w)'],['excluded','Already excluded']];
  const toolbar = '<div class="review-toolbar">'+
    '<label>Filter: <select onchange="applyRFilter(this.value)" id="rf-sel">'+filterOpts.map(([v,l])=>'<option value="'+v+'"'+(filter===v?' selected':'')+'>'+l+'</option>').join('')+'</select></label>'+
    '<input type="text" id="rq-box" placeholder="Search..." value="'+escHtml(search)+'" onkeydown="if(event.key===\'Enter\')applyRFilter()" style="width:180px">'+
    '<button class="btn-save-review" onclick="saveExclusions()">Save</button>'+
    '<span class="save-status" id="save-status"></span>'+
    '<label style="margin-left:auto"><input type="checkbox" onchange="selectAll(this)"> Select all</label>'+
    '</div>';

  let pag = '<div class="pagination"><span>'+total.toLocaleString()+' notes, page '+page+' of '+totalPages+'</span>';
  if (page>1) pag += '<a href="#" onclick="saveAndGo(\''+pageLink(page-1)+'\');return false">‹ Prev</a>';
  if (page<totalPages) pag += '<a href="#" onclick="saveAndGo(\''+pageLink(page+1)+'\');return false">Next ›</a>';
  pag += '</div>';

  const script = `<script>
var _ch={},_pn=null;
window.addEventListener('beforeunload',function(e){if(Object.keys(_ch).length){e.preventDefault();e.returnValue='';}});
function markChanged(id){_ch[id]=document.getElementById('cb-'+id).checked;document.getElementById('row-'+id).className=_ch[id]?'tr-excluded':'';document.getElementById('save-status').textContent=Object.keys(_ch).length+' unsaved';}
function selectAll(cb){document.querySelectorAll('.cb-exclude').forEach(function(c){c.checked=cb.checked;markChanged(c.dataset.id);});}
function applyRFilter(val){var f=val||document.getElementById('rf-sel').value,q=document.getElementById('rq-box').value;saveAndGo('/review?filter='+f+'&q='+encodeURIComponent(q));}
function saveAndGo(url){
  if(!Object.keys(_ch).length){window.location=url;return;}
  document.getElementById('save-status').textContent='Saving...';
  fetch('/api/notes/exclude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(_ch)})
  .then(function(r){return r.json();}).then(function(){_ch={};window.location=url;})
  .catch(function(){document.getElementById('save-status').textContent='Save failed';});}
function saveExclusions(){
  var ids=Object.keys(_ch);if(!ids.length){document.getElementById('save-status').textContent='Nothing changed.';return;}
  document.getElementById('save-status').textContent='Saving...';
  fetch('/api/notes/exclude',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(_ch)})
  .then(function(r){return r.json();}).then(function(d){document.getElementById('save-status').textContent='Saved '+d.updated+' ✓';_ch={};})
  .catch(function(){document.getElementById('save-status').textContent='Save failed';});}
</script>`;

  return '<p class="section-title">Review Notes — mark to exclude from QUARRY</p>'+toolbar+
    '<table class="note-table"><thead><tr><th style="width:32px"></th><th>Note</th><th>Words</th><th>Origin</th><th>Type</th><th>Tags</th></tr></thead><tbody>'+rows+'</tbody></table>'+
    pag+script;
}

// ---------------------------------------------------------------------------
// ROUTER
// ---------------------------------------------------------------------------
function router(req, res) {
  const url    = req.url.split('?')[0];
  const method = req.method;
  const params = new URLSearchParams(req.url.split('?')[1]||'');

  const send = (content, nav) => {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end(htmlShell(nav, content, nav));
  };

  // Pending queue
  if (method==='GET' && url==='/') {
    const db = openDb(); ensureSchema(db);
    const pending = db.prepare("SELECT n.*,nq.seed_theme as queue_theme FROM narratives n LEFT JOIN narrative_queue nq ON nq.id=n.queue_id WHERE n.approval_status='pending' OR n.approval_status IS NULL ORDER BY n.produced_at DESC").all().map(n=>enrichNarrative(db,n));
    db.close();
    const cards = pending.length ? pending.map(renderPendingCard).join('') : '<div class="empty">No narratives pending approval.</div>';
    send('<p class="section-title">Pending Approval</p><div class="stats-bar"><span>Pending: <strong id="pending-count">'+pending.length+'</strong></span></div>'+cards, 'pending');
    return;
  }

  // Approved archive
  if (method==='GET' && url==='/approved') {
    const db = openDb(); ensureSchema(db);
    const approved = db.prepare("SELECT n.*,nq.seed_theme as queue_theme FROM narratives n LEFT JOIN narrative_queue nq ON nq.id=n.queue_id WHERE n.approval_status='approved' ORDER BY n.approved_at DESC").all().map(n=>enrichNarrative(db,n));
    db.close();
    const cards = approved.length ? approved.map(renderApprovedCard).join('') : '<div class="empty">No narratives approved yet.</div>';
    send('<p class="section-title">Approved Archive</p><div class="stats-bar"><span>Approved: <strong>'+approved.length+'</strong></span></div>'+cards, 'approved');
    return;
  }

  // Stats
  if (method==='GET' && url==='/stats') {
    const db = openDb(); ensureSchema(db);
    const content = renderStatsPage(db);
    db.close();
    send(content, 'stats');
    return;
  }

  // Notes browser
  if (method==='GET' && url==='/notes') {
    const db = openDb(); ensureSchema(db);
    const content = renderNotesPage(db, params);
    db.close();
    send(content, 'notes');
    return;
  }

  // Review
  if (method==='GET' && /^\/review/.test(url)) {
    const db = openDb(); ensureSchema(db);
    const content = renderReviewPage(db, params);
    db.close();
    send(content, 'review');
    return;
  }

  // API: single note
  const noteMatch = url.match(/^\/api\/notes\/(\d+)$/);
  if (method==='GET' && noteMatch) {
    const id = parseInt(noteMatch[1],10);
    const db = openDb(); ensureSchema(db);
    const note = db.prepare('SELECT id,title,filepath,source_url,word_count,content_type FROM vault_notes WHERE id=?').get(id);
    if (!note) { db.close(); res.writeHead(404); res.end('{}'); return; }
    const essayRow = db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='essay' ORDER BY switch_level DESC LIMIT 1").get(id);
    const verified = db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='verified' ORDER BY switch_level DESC LIMIT 12").all(id).map(r=>r.claim);
    db.close();
    var body='';
    try { body=fs.readFileSync(note.filepath,'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/,'').replace(/_Created at[^_]*\._/g,'').replace(/_Source URL:[^_]*\._/g,'').trim(); } catch(_){}
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(Object.assign({},note,{body,essay:essayRow?essayRow.claim:null,verified})));
    return;
  }

  // API: approve
  const approveMatch = url.match(/^\/api\/narratives\/(\d+)\/approve$/);
  if (method==='POST' && approveMatch) {
    const db=openDb(); ensureSchema(db);
    db.prepare("UPDATE narratives SET approval_status='approved',approved_at=? WHERE id=?").run(new Date().toISOString(),parseInt(approveMatch[1],10));
    db.close(); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); return;
  }

  // API: reject
  const rejectMatch = url.match(/^\/api\/narratives\/(\d+)\/reject$/);
  if (method==='POST' && rejectMatch) {
    readBody(req, function(b) {
      var reason=''; try{reason=JSON.parse(b).reason||'';}catch(_){}
      const db=openDb(); ensureSchema(db);
      db.prepare("UPDATE narratives SET approval_status='rejected',rejection_reason=? WHERE id=?").run(reason,parseInt(rejectMatch[1],10));
      db.close(); res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}');
    }); return;
  }

  // API: save exclusions
  if (method==='POST' && url==='/api/notes/exclude') {
    readBody(req, function(b) {
      var ch={}; try{ch=JSON.parse(b);}catch(_){}
      const db=openDb(); ensureSchema(db);
      var n=0;
      Object.keys(ch).forEach(function(id){db.prepare('UPDATE vault_notes SET quarry_exclude=? WHERE id=?').run(ch[id]?1:0,parseInt(id,10));n++;});
      db.close(); res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,updated:n}));
    }); return;
  }

  // API: save edited note body back to .md file (distinct URL — no collision with GET /api/notes/:id)
  const saveMatch = url.match(/^\/api\/notes\/(\d+)\/save$/);
  if (method==='POST' && saveMatch) {
    const id = parseInt(saveMatch[1],10);
    readBody(req, function(b) {
      var data; try { data=JSON.parse(b); } catch(_) { res.writeHead(400,{'Content-Type':'application/json'}); res.end('{"error":"Invalid JSON"}'); return; }
      const db   = openDb(); ensureSchema(db);
      const note = db.prepare('SELECT filepath FROM vault_notes WHERE id=?').get(id);
      db.close();
      if (!note) { res.writeHead(404,{'Content-Type':'application/json'}); res.end('{"error":"Note not found"}'); return; }
      try {
        const original = fs.readFileSync(note.filepath,'utf8');
        const fm       = (original.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/)||[''])[0];
        const newBody  = (data.content||'').trim();
        fs.writeFileSync(note.filepath+'.bak', original);
        fs.writeFileSync(note.filepath, fm ? fm+'\n'+newBody : newBody, 'utf8');
        // sync word count
        const newWc = (newBody.match(/\S+/g)||[]).length;
        const db2 = openDb();
        db2.prepare('UPDATE vault_notes SET word_count=? WHERE id=?').run(newWc, id);
        db2.close();
        res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}');
      } catch(e) { res.writeHead(500,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.message})); }
    }); return;
  }

  res.writeHead(404); res.end('Not found');
}

function readBody(req,cb){var b='';req.on('data',c=>{b+=c;});req.on('end',()=>cb(b));}

const server = http.createServer(router);
server.listen(PORT,'0.0.0.0',function(){
  console.log('🪨 QUARRY server running at http://localhost:'+PORT);
  console.log('   / Pending  /approved Archive  /stats  /notes  /review');
  console.log('   DB: '+DB_PATH);
});