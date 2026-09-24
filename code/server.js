#!/usr/bin/env node
// QUARRY server.js v0.3
// Usage: node server.js [--port 3001]
// Views: / /approved /vault /tagger /curator /queue /narrator /reports /stats /notes /review

'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const cp    = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH   = process.env.QUARRY_DB    || path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'vault.db');
const VAULT_DIR = process.env.VAULT_PATH   || path.join(process.env.HOME, 'vault');
const CODE_DIR  = path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry', 'code');
const LOG_DIR   = path.join(process.env.QUARRY_HOME || process.env.HOME, 'dev', 'quarry');
const PORT      = (() => { const i = process.argv.indexOf('--port'); return i !== -1 ? parseInt(process.argv[i+1],10) : 3001; })();

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
    const sources = db.prepare('SELECT id,title,source_url FROM vault_notes WHERE id IN ('+ids.join(',')+')').all();
    return Object.assign({},n,{sources});
  } catch(_) { return Object.assign({},n,{sources:[]}); }
}

// ---------------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------------
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function renderDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}); } catch(_) { return iso.slice(0,10); }
}
function renderBadge(r) {
  const cls = r==='senior'?'badge-senior':r==='junior'?'badge-junior':'badge-unknown';
  return '<span class="badge '+cls+'">'+(r||'?')+'</span>';
}

// ---------------------------------------------------------------------------
// CSS + HTML SHELL
// ---------------------------------------------------------------------------
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Georgia,serif;background:#0f0f0f;color:#e8e4dc;min-height:100vh}
a{color:#6ea8c8;text-decoration:none}a:hover{text-decoration:underline}
header{background:#1a1a1a;border-bottom:1px solid #333;padding:14px 24px;display:flex;align-items:center;gap:16px}
header h1{font-size:1.3rem;letter-spacing:.05em;color:#c8b89a}
nav{display:flex;gap:6px;flex-wrap:wrap}
nav a{color:#888;font-size:.82rem;padding:5px 12px;border-radius:4px;border:1px solid #333}
nav a:hover,nav a.active{color:#c8b89a;border-color:#555;text-decoration:none}
.container{max-width:1100px;margin:0 auto;padding:28px 24px}
.page-title{font-size:.8rem;color:#666;letter-spacing:.1em;text-transform:uppercase;margin-bottom:20px}
/* Cards & panels */
.card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;margin-bottom:20px;overflow:hidden}
.card-header{padding:12px 18px;background:#141414;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.card-body{padding:18px}
.card-actions{padding:12px 18px;background:#141414;border-top:1px solid #2a2a2a;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.card-meta{font-size:.75rem;color:#666}
.card-meta span{margin-right:10px}
/* Badges */
.badge{display:inline-block;font-size:.68rem;padding:2px 7px;border-radius:9px;font-family:monospace}
.badge-senior{background:#2a1f0e;color:#c8a96e;border:1px solid #5a3e1a}
.badge-junior{background:#0e1f2a;color:#6eacc8;border:1px solid #1a5a7a}
.badge-unknown{background:#1f1f1f;color:#888;border:1px solid #333}
/* Buttons */
.btn{padding:7px 16px;border-radius:4px;border:none;font-size:.85rem;cursor:pointer;font-family:Georgia,serif;transition:opacity .15s;white-space:nowrap}
.btn:hover{opacity:.8}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:#2a1f0e;color:#c8a96e;border:1px solid #5a3e1a}
.btn-green{background:#1a3a1a;color:#6ec86e;border:1px solid #2a5a2a}
.btn-red{background:#3a1a1a;color:#c86e6e;border:1px solid #5a2a2a}
.btn-blue{background:#1f1f2a;color:#8888cc;border:1px solid #33335a}
.btn-grey{background:#1f1f1f;color:#888;border:1px solid #333}
/* Forms */
.field{display:flex;align-items:center;gap:8px;font-size:.82rem;color:#888}
.field label{white-space:nowrap}
.field input,.field select{background:#0f0f0f;border:1px solid #333;color:#aaa;padding:5px 9px;border-radius:4px;font-size:.82rem;font-family:Georgia,serif;width:80px}
.field input[type=text]{width:160px}
.reject-input{flex:1;background:#0f0f0f;border:1px solid #333;color:#aaa;padding:6px 10px;border-radius:4px;font-size:.82rem;font-family:Georgia,serif}
/* Narrative text */
.narrative-text{line-height:1.75;font-size:1rem;color:#d8d0c4;white-space:pre-wrap}
.sources-line{margin-top:14px;padding-top:12px;border-top:1px solid #2a2a2a;font-size:.8rem;color:#666}
.sources-line strong{color:#888}
.theme-tag{font-size:.72rem;color:#8a7a6a;font-family:monospace;background:#1f1a12;padding:2px 7px;border-radius:3px;border:1px solid #3a3020}
.approved-date{font-size:.75rem;color:#4a6a4a}
/* Stats */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:#141414;border:1px solid #2a2a2a;border-radius:7px;padding:16px}
.stat-card .num{font-size:1.8rem;color:#c8b89a;font-weight:bold;line-height:1;margin-bottom:4px}
.stat-card .lbl{font-size:.72rem;color:#666;text-transform:uppercase;letter-spacing:.07em}
.stat-card .sub{font-size:.78rem;color:#555;margin-top:3px}
.progress-bar{background:#1a1a1a;border-radius:3px;height:6px;overflow:hidden;margin:5px 0}
.progress-fill{height:100%;background:#5a3e1a;border-radius:3px}
.breakdown{background:#141414;border:1px solid #2a2a2a;border-radius:7px;padding:16px;margin-bottom:16px}
.breakdown h3{font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:.07em;margin-bottom:12px}
.br-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1a1a1a;font-size:.85rem}
.br-row:last-child{border-bottom:none}
.br-row .k{color:#aaa}.br-row .v{color:#c8b89a;font-family:monospace}
/* Notes browser */
.note-table{width:100%;border-collapse:collapse;font-size:.82rem}
.note-table th{text-align:left;padding:7px 9px;color:#555;font-weight:normal;border-bottom:1px solid #2a2a2a;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}
.note-table td{padding:7px 9px;border-bottom:1px solid #141414;vertical-align:top}
.note-table tr:hover td{background:#141414;cursor:pointer}
.nt{color:#c8b89a;font-size:.85rem;line-height:1.3}
.nx{color:#555;font-size:.75rem;margin-top:2px;max-width:440px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nm{color:#444;font-size:.72rem;white-space:nowrap}
.ntag{font-size:.68rem;color:#5a4a3a;font-family:monospace}
.s4-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#5a3e1a;margin-right:3px}
/* Review */
.cb-exclude{width:15px;height:15px;accent-color:#c86e6e;cursor:pointer}
.btn-save{background:#1a3a1a;color:#6ec86e;border:1px solid #2a5a2a;padding:7px 20px;border-radius:4px;font-size:.85rem;cursor:pointer;font-family:Georgia,serif}
.save-status{font-size:.78rem;color:#666}
.tr-excluded td{opacity:.4}
/* Queue view */
.queue-row{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;margin-bottom:14px;align-items:start}
.q-note{background:#141414;border:1px solid #2a2a2a;border-radius:6px;padding:12px;cursor:pointer}
.q-note:hover{border-color:#555}
.q-note .qt{color:#c8b89a;font-size:.85rem;line-height:1.3;margin-bottom:4px}
.q-note .qm{font-size:.72rem;color:#555}
.q-actions{display:flex;flex-direction:column;gap:6px;justify-content:center}
.q-theme{font-size:.72rem;color:#666;font-family:monospace;margin-bottom:6px}
/* Pagination */
.pagination{display:flex;gap:7px;align-items:center;margin-top:18px;flex-wrap:wrap}
.pagination a{color:#888;padding:4px 10px;border:1px solid #333;border-radius:4px;font-size:.82rem}
.pagination a:hover{color:#c8b89a;border-color:#555;text-decoration:none}
.pagination span{color:#555;font-size:.82rem}
/* Drawer */
.drawer-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100}
.drawer-overlay.open{display:block}
.drawer{position:fixed;top:0;right:0;width:min(700px,95vw);height:100vh;background:#141414;border-left:1px solid #333;z-index:101;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s ease}
.drawer-overlay.open .drawer{transform:translateX(0)}
.drawer-head{padding:14px 18px;border-bottom:1px solid #2a2a2a;display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.drawer-title{font-size:.92rem;color:#c8b89a;line-height:1.4;flex:1}
.drawer-close{background:none;border:1px solid #444;color:#888;width:26px;height:26px;border-radius:4px;cursor:pointer;font-size:.9rem;flex-shrink:0}
.drawer-tabs{display:flex;border-bottom:1px solid #2a2a2a}
.drawer-tab{padding:8px 16px;font-size:.8rem;color:#666;cursor:pointer;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;font-family:Georgia,serif}
.drawer-tab.active{color:#c8b89a;border-bottom-color:#c8b89a}
.drawer-body{flex:1;overflow-y:auto;padding:18px}
.drawer-content{line-height:1.75;font-size:.9rem;color:#ccc;white-space:pre-wrap}
.drawer-meta{font-size:.75rem;color:#555;margin-bottom:12px}
.drawer-meta a{color:#6ea8c8}
/* Log viewer */
.log-box{background:#0a0a0a;border:1px solid #2a2a2a;border-radius:6px;padding:14px;font-family:monospace;font-size:.75rem;color:#8a8;max-height:320px;overflow-y:auto;white-space:pre-wrap;margin-top:14px}
/* Control panel */
.ctrl-panel{background:#141414;border:1px solid #2a2a2a;border-radius:8px;padding:18px;margin-bottom:18px}
.ctrl-panel h3{font-size:.8rem;color:#888;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px}
.ctrl-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.ctrl-row:last-child{margin-bottom:0}
/* Report */
.report-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;margin-bottom:24px}
.report-card{background:#141414;border:1px solid #2a2a2a;border-radius:7px;padding:16px}
.report-card h4{font-size:.88rem;color:#c8b89a;margin-bottom:6px}
.report-card p{font-size:.78rem;color:#666;margin-bottom:12px;line-height:1.5}
.report-result{margin-top:12px;overflow-x:auto}
.report-result table{width:100%;border-collapse:collapse;font-size:.78rem}
.report-result th{text-align:left;padding:5px 8px;color:#666;border-bottom:1px solid #2a2a2a;font-weight:normal;font-size:.72rem;text-transform:uppercase}
.report-result td{padding:5px 8px;border-bottom:1px solid #141414;color:#aaa;font-family:monospace}
.empty{text-align:center;color:#555;padding:48px;font-size:1rem}
`;

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
];

function shell(title, body, active) {
  const nav = NAV_LINKS.map(([href,label])=>
    '<a href="'+href+'"'+(active===href?' class="active"':'')+'>'+label+'</a>'
  ).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>🪨 QUARRY — ${escHtml(title)}</title>
<style>${CSS}</style></head><body>
<header>
  <span style="font-size:1.5rem">🪨</span>
  <h1>QUARRY</h1>
  <nav>${nav}</nav>
</header>
<div class="container">
${body}
</div>
${DRAWER_HTML}
${COMMON_JS}
</body></html>`;
}

// ---------------------------------------------------------------------------
// DRAWER
// ---------------------------------------------------------------------------
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
var _dd={};
function openNote(id){
  var o=document.getElementById('drawer-overlay'),c=document.getElementById('drawer-content'),
      t=document.getElementById('drawer-title'),m=document.getElementById('drawer-meta'),
      tb=document.getElementById('drawer-tabs');
  c.textContent='Loading...';tb.innerHTML='';m.innerHTML='';o.classList.add('open');
  fetch('/api/notes/'+id).then(r=>r.json()).then(d=>{
    _dd[id]=d;t.textContent=d.title||'Note';
    var mp=[];if(d.word_count)mp.push(d.word_count+' words');if(d.content_type)mp.push(d.content_type);
    if(d.source_url)mp.push('<a href="'+d.source_url+'" target="_blank">source ↗</a>');
    m.innerHTML=mp.join(' · ')+'&nbsp;<button onclick="startEdit('+id+')" style="background:none;border:1px solid #444;color:#888;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:.72rem;">✎</button>';
    var th='',ft='raw';
    if(d.essay){th+='<button class="drawer-tab active" onclick="showTab('+id+',\\'essay\\',this)">Essay</button>';ft='essay';}
    th+='<button class="drawer-tab'+(ft==='raw'?' active':'')+'" onclick="showTab('+id+',\\'raw\\',this)">Raw</button>';
    if(d.verified&&d.verified.length)th+='<button class="drawer-tab" onclick="showTab('+id+',\\'facts\\',this)">Facts ('+d.verified.length+')</button>';
    tb.innerHTML=th;showTabContent(id,ft);
  }).catch(e=>{c.textContent='Error: '+e.message;});
}
function startEdit(id){
  var d=_dd[id];if(!d)return;
  document.getElementById('drawer-content').innerHTML=
    '<textarea id="note-ed" style="width:100%;height:calc(100vh - 270px);background:#0f0f0f;color:#e8e4dc;border:1px solid #555;padding:12px;font-family:monospace;font-size:.88rem;line-height:1.6;resize:none;">'+escH(d.body||'')+'</textarea>'+
    '<div style="margin-top:8px;display:flex;gap:8px">'+
    '<button onclick="saveNote('+id+')" class="btn btn-green" style="font-size:.8rem;padding:5px 14px;">💾 Save</button>'+
    '<button onclick="openNote('+id+')" class="btn btn-red" style="font-size:.8rem;padding:5px 14px;">Cancel</button></div>';
}
function saveNote(id){
  var ta=document.getElementById('note-ed');if(!ta)return;
  fetch('/api/notes/'+id+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:ta.value})})
  .then(r=>r.json()).then(res=>{if(res.ok){alert('Saved');openNote(id);}else alert('Save failed');})
  .catch(e=>alert('Error: '+e.message));
}
function showTab(id,tab,btn){
  document.querySelectorAll('.drawer-tab').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');showTabContent(id,tab);
}
function showTabContent(id,tab){
  var d=_dd[id];if(!d)return;
  var c=document.getElementById('drawer-content');
  if(tab==='essay')c.textContent=d.essay||'(no essay)';
  else if(tab==='facts')c.textContent=(d.verified||[]).map(f=>'• '+f).join('\\n');
  else c.textContent=d.body||'(no content)';
}
function closeDrawer(e){
  if(e&&e.target!==document.getElementById('drawer-overlay'))return;
  document.getElementById('drawer-overlay').classList.remove('open');
}
function escH(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function approve(id){fetch('/api/narratives/'+id+'/approve',{method:'POST'}).then(r=>{if(r.ok){document.getElementById('card-'+id).remove();updateCount();}});}
function reject(id){
  var reason=document.getElementById('reason-'+id).value.trim();
  fetch('/api/narratives/'+id+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason})})
  .then(r=>{if(r.ok){document.getElementById('card-'+id).remove();updateCount();}});
}
function copyText(id){
  navigator.clipboard.writeText(document.getElementById('nt-'+id).innerText).then(()=>{
    var b=document.getElementById('cp-'+id);b.textContent='Copied!';setTimeout(()=>b.textContent='Copy',1500);
  });
}
function updateCount(){var r=document.querySelectorAll('.card').length,e=document.getElementById('pending-count');if(e)e.textContent=r;}
</script>`;

// ---------------------------------------------------------------------------
// NARRATIVE CARDS
// ---------------------------------------------------------------------------
function pendingCard(n) {
  const src=(n.sources||[]).map(s=>'<button class="btn-source" style="background:none;border:none;color:#6ea8c8;font-size:.78rem;cursor:pointer;text-decoration:underline;padding:0" onclick="openNote('+s.id+')">'+escHtml(s.title)+'</button>').join(' · ');
  return `<div class="card" id="card-${n.id}">
  <div class="card-header"><div class="card-meta">${renderBadge(n.register)}<span class="theme-tag">${escHtml(n.queue_theme||n.seed_theme||'')}</span><span>${renderDate(n.produced_at)}</span><span style="color:#444">${escHtml(n.model_used||'')}</span></div></div>
  <div class="card-body"><div class="narrative-text" id="nt-${n.id}">${escHtml(n.body)}</div><div class="sources-line"><strong>Sources:</strong> ${src||'<em>none</em>'}</div></div>
  <div class="card-actions"><button class="btn btn-green" onclick="approve(${n.id})">✓ Approve</button><input class="reject-input" id="reason-${n.id}" placeholder="Rejection reason"/><button class="btn btn-red" onclick="reject(${n.id})">✗ Reject</button><button class="btn btn-blue" id="cp-${n.id}" onclick="copyText(${n.id})">Copy</button></div>
</div>`;
}
function approvedCard(n) {
  const src=(n.sources||[]).map(s=>'<button class="btn-source" style="background:none;border:none;color:#6ea8c8;font-size:.78rem;cursor:pointer;text-decoration:underline;padding:0" onclick="openNote('+s.id+')">'+escHtml(s.title)+'</button>').join(' · ');
  return `<div class="card" id="card-${n.id}">
  <div class="card-header"><div class="card-meta">${renderBadge(n.register)}<span class="theme-tag">${escHtml(n.queue_theme||n.seed_theme||'')}</span><span>${renderDate(n.produced_at)}</span><span class="approved-date">approved ${renderDate(n.approved_at)}</span></div></div>
  <div class="card-body"><div class="narrative-text" id="nt-${n.id}">${escHtml(n.body)}</div><div class="sources-line"><strong>Sources:</strong> ${src||'<em>none</em>'}</div></div>
  <div class="card-actions"><button class="btn btn-blue" id="cp-${n.id}" onclick="copyText(${n.id})">Copy</button></div>
</div>`;
}

// ---------------------------------------------------------------------------
// CONTROL PANEL PAGES
// ---------------------------------------------------------------------------
function vaultPage() {
  return `<p class="page-title">Vault — git sync and indexing</p>
<div class="ctrl-panel">
  <h3>Git Sync</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('git-pull','Git pull vault')">⬇ git pull (origin/master)</button>
    <span style="font-size:.78rem;color:#555">git -C ~/vault pull origin master</span>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Indexer</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('index-diff','Indexer --diff')">Index changed files</button>
    <button class="btn btn-grey" onclick="runCmd('index-full','Indexer full')">Full re-index</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Word Count Sync</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('sync-wc','Sync word counts')">sync-wc — recount from filesystem</button>
  </div>
</div>
<div id="cmd-output"></div>
${cmdJs()}`;
}

function taggerPage() {
  return `<p class="page-title">Tagger — classify and tag vault notes</p>
<div class="ctrl-panel">
  <h3>Switch-1 &amp; Switch-2 — zero API cost</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('sw1','Switch-1')">Switch-1 (filename heuristic)</button>
    <button class="btn btn-primary" onclick="runCmd('sw2','Switch-2')">Switch-2 (first-paragraph vocab)</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Switch-3 — OpenRouter free → Gemini fallback</h3>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="s3-limit" type="number" value="500" min="1" max="5000"></div>
    <div class="field"><label>Provider:</label><select id="s3-prov"><option value="openrouter">openrouter</option><option value="gemini">gemini</option></select></div>
    <button class="btn btn-primary" onclick="runS3()">Run Switch-3</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Switch-4 — full document, Gemini only</h3>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="s4-limit" type="number" value="20" min="1" max="500"></div>
    <button class="btn btn-primary" onclick="runS4()">Run Switch-4</button>
    <button class="btn btn-grey" onclick="runCmd('sw4-dry','Switch-4 dry run')">Dry run</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Mindful-WC — compress overlong notes (>15K words)</h3>
  <div class="ctrl-row">
    <div class="field"><label>Limit:</label><input id="mwc-limit" type="number" value="5" min="1" max="50"></div>
    <button class="btn btn-primary" onclick="runMwc()">Run mindful-wc</button>
    <button class="btn btn-grey" onclick="runCmd('mwc-dry','Mindful-WC dry run')">Dry run (candidates list)</button>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Video Link Extraction</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('extract-video','Extract video links')">Extract video links from all notes</button>
    <button class="btn btn-grey" onclick="runCmd('extract-video-dry','Extract video links dry run')">Dry run</button>
  </div>
</div>
<div id="cmd-output"></div>
<script>
function runS3(){fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'sw3',limit:document.getElementById('s3-limit').value,provider:document.getElementById('s3-prov').value})}).then(showCmdResult);}
function runS4(){fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'sw4',limit:document.getElementById('s4-limit').value})}).then(showCmdResult);}
function runMwc(){fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'mwc',limit:document.getElementById('mwc-limit').value})}).then(showCmdResult);}
</script>
${cmdJs()}`;
}

function curatorPage() {
  return `<p class="page-title">Curator — build narrative queue</p>
<div class="ctrl-panel">
  <h3>Strategy: Informed Serendipity</h3>
  <p style="font-size:.8rem;color:#666;margin-bottom:14px;line-height:1.6">80% random selection within quality+diversity constraints · 20% orphan rescue · 3-note clusters · No two notes from same domain · Different tag roots required</p>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('curator-force','Curator --force')">Force generate 20 clusters</button>
    <button class="btn btn-grey" onclick="runCmd('curator-refill','Curator --refill')">Refill if below threshold</button>
    <button class="btn btn-grey" onclick="runCmd('curator-status','Curator status')">Status</button>
  </div>
</div>
<div id="cmd-output"></div>
${cmdJs()}`;
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
    <button class="btn btn-primary" onclick="runLive()">▶ Run --live</button>
    <span style="font-size:.75rem;color:#555">Result appears in Pending queue</span>
  </div>
</div>
<div class="ctrl-panel">
  <h3>Queue Mode</h3>
  <div class="ctrl-row">
    <button class="btn btn-primary" onclick="runCmd('narrator-next','Narrator --next')">▶ Process next queued item</button>
    <button class="btn btn-grey" onclick="runCmd('narrator-dry','Narrator --dry-run')">Dry run (show payload)</button>
  </div>
</div>
<div id="cmd-output"></div>
<script>
function runLive(){fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'narrator-live',numSources:document.getElementById('ns-count').value})}).then(showCmdResult);}
</script>
${cmdJs()}`;
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
    const notes = noteIds.length ? db.prepare('SELECT id,title,word_count,tag_source FROM vault_notes WHERE id IN ('+noteIds.join(',')+')').all() : [];

    const noteCells = notes.map(n=>`
      <div class="q-note" onclick="openNote(${n.id})">
        <div class="qt">${n.s4?'<span class="s4-dot"></span>':''}`+escHtml(n.title.slice(0,60))+`</div>
        <div class="qm">${n.word_count}w · ${escHtml(n.tag_source||'')}</div>
      </div>`).join('');

    // pad to 3 cells if fewer notes
    const padded = noteCells + '<div></div>'.repeat(Math.max(0,3-notes.length));

    return `<div style="margin-bottom:16px">
      <div class="q-theme">[${item.id}] ${escHtml(item.seed_theme)} · score ${item.priority_score.toFixed(2)} · ${renderDate(item.created_at)}</div>
      <div class="queue-row">
        ${padded}
        <div class="q-actions">
          <button class="btn btn-primary" onclick="narrateId(${item.id})">▶ Narrate</button>
          <button class="btn btn-grey" onclick="discardId(${item.id})">✕ Discard</button>
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
${pag}
<script>
function narrateId(id){
  fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cmd:'narrator-id',id})})
  .then(r=>r.json()).then(d=>alert(d.ok?'Narration started — check Pending queue':'Failed: '+d.error));
}
function discardId(id){
  if(!confirm('Discard queue item '+id+'?'))return;
  fetch('/api/queue/'+id+'/discard',{method:'POST'}).then(r=>{if(r.ok)location.reload();});
}
</script>`;
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
      <button class="btn btn-primary" onclick="runReport('${r.id}')" style="font-size:.78rem;padding:5px 12px;">▶ Run</button>
      <div class="report-result" id="rr-${r.id}"></div>
    </div>`).join('');

  return `<p class="page-title">Reports — live database queries</p>
<div class="report-grid">${cards}</div>
<script>
function runReport(id){
  var el=document.getElementById('rr-'+id);
  el.innerHTML='<span style="color:#555;font-size:.75rem">Running...</span>';
  fetch('/api/reports/'+id).then(r=>r.json()).then(function(rows){
    if(!rows||!rows.length){el.innerHTML='<span style="color:#555;font-size:.75rem">No results</span>';return;}
    var cols=Object.keys(rows[0]);
    var th=cols.map(c=>'<th>'+c+'</th>').join('');
    var tb=rows.map(function(r){return '<tr>'+cols.map(c=>'<td>'+(r[c]===null?'':String(r[c]).slice(0,120))+'</td>').join('')+'</tr>';}).join('');
    el.innerHTML='<table><thead><tr>'+th+'</tr></thead><tbody>'+tb+'</tbody></table>';
  }).catch(function(e){el.innerHTML='<span style="color:#c86e6e;font-size:.75rem">Error: '+e.message+'</span>';});
}
</script>`;
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
  if(search) where+=" AND (title LIKE '%"+search.replace(/'/g,"''")+"%' OR first_paragraph LIKE '%"+search.replace(/'/g,"''")+"%')";

  const orderBy=sort==='title'?'title ASC':sort==='date'?'file_mtime DESC':'word_count DESC';
  const total=db.prepare('SELECT COUNT(*) as n FROM vault_notes '+where).get().n;
  const notes=db.prepare('SELECT id,title,word_count,content_type,origin,first_paragraph,tag_source,classification_at,quarry_exclude FROM vault_notes '+where+' ORDER BY '+orderBy+' LIMIT ? OFFSET ?').all(PS,offset);
  const s4ids=new Set(db.prepare('SELECT DISTINCT note_id FROM note_classifications WHERE switch_level=4').all().map(r=>r.note_id));
  const totalPages=Math.ceil(total/PS);

  function pl(p){return '/notes?page='+p+'&filter='+encodeURIComponent(filter)+'&sort='+sort+'&q='+encodeURIComponent(search);}

  const rows=notes.map(n=>{
    const ex=(n.first_paragraph||'').slice(0,130).replace(/\n/g,' ');
    const s4=s4ids.has(n.id)?'<span class="s4-dot" title="Switch-4"></span>':'';
    const dim=n.quarry_exclude?' style="opacity:.4"':'';
    return '<tr onclick="openNote('+n.id+')"'+dim+'><td><div class="nt">'+s4+escHtml(n.title)+'</div><div class="nx">'+escHtml(ex)+'</div></td><td class="nm">'+n.word_count+'w</td><td class="nm">'+escHtml(n.content_type)+'</td><td class="nm">'+escHtml(n.origin)+'</td><td class="ntag">'+escHtml(n.tag_source||'')+(n.classification_at?'<br><span style="color:#2a5a2a">✓</span>':'')+'</td></tr>';
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
  if(search) where+=" AND (title LIKE '%"+search.replace(/'/g,"''")+"%' OR first_paragraph LIKE '%"+search.replace(/'/g,"''")+"%')";

  const total=db.prepare('SELECT COUNT(*) as n FROM vault_notes '+where).get().n;
  const notes=db.prepare('SELECT id,title,word_count,content_type,origin,first_paragraph,quarry_exclude,tag_source FROM vault_notes '+where+' ORDER BY origin,word_count DESC LIMIT ? OFFSET ?').all(PS,offset);
  const totalPages=Math.ceil(total/PS);

  function pl(p){return '/review?page='+p+'&filter='+encodeURIComponent(filter)+'&q='+encodeURIComponent(search);}

  const rows=notes.map(n=>{
    const ex=(n.first_paragraph||'').slice(0,150).replace(/\n/g,' ');
    const ch=n.quarry_exclude?'checked':'';
    const cl=n.quarry_exclude?'tr-excluded':'';
    return '<tr class="'+cl+'" id="row-'+n.id+'"><td><input type="checkbox" class="cb-exclude" id="cb-'+n.id+'" '+ch+' onchange="markChanged('+n.id+')" data-id="'+n.id+'"></td><td><div class="nt">'+escHtml(n.title)+'</div><div class="nx">'+escHtml(ex)+'</div></td><td class="nm">'+n.word_count+'w</td><td class="nm">'+escHtml(n.origin)+'</td><td class="nm">'+escHtml(n.content_type)+'</td><td class="ntag">'+escHtml(n.tag_source||'')+'</td></tr>';
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

// ---------------------------------------------------------------------------
// CMD JS — shared "run command + show log" client script
// ---------------------------------------------------------------------------
function cmdJs() {
  return `<script>
var _logInterval=null;
function runCmd(cmd,label,extra){
  var el=document.getElementById('cmd-output');
  el.innerHTML='<div class="log-box" id="log-box">Starting '+label+'...</div>';
  fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({cmd},extra||{}))})
  .then(function(r){return r.json();})
  .then(function(d){
    var el=document.getElementById('cmd-output');
    if(d.ok){
      el.innerHTML+='<div style="color:#6ec86e;font-size:.78rem;margin-top:6px">✓ '+d.msg+'</div>';
      startLogPoll(d.log||'tagger.log');
    } else {
      el.innerHTML+='<div style="color:#c86e6e;font-size:.78rem;margin-top:6px">✗ '+(d.error||'unknown error')+'</div>';
    }
  });
}
function showCmdResult(r){return r.json().then(function(d){var el=document.getElementById('cmd-output');if(!el)return;if(d.ok){el.innerHTML+='<div style="color:#6ec86e;font-size:.78rem;margin-top:6px">✓ '+d.msg+'</div>';startLogPoll(d.log||'tagger.log');}else{el.innerHTML+='<div style="color:#c86e6e;font-size:.78rem;margin-top:6px">✗ '+(d.error||'unknown error')+'</div>';}});}
function startLogPoll(logFile){
  if(_logInterval)clearInterval(_logInterval);
  var lf=logFile||'tagger.log';
  _logInterval=setInterval(function(){
    fetch('/api/log?file='+encodeURIComponent(lf)).then(function(r){return r.text();}).then(function(t){
      var b=document.getElementById('log-box');if(b){b.textContent=t;b.scrollTop=b.scrollHeight;}
    });
  },3000);
  // Stop polling after 10 minutes
  setTimeout(function(){clearInterval(_logInterval);},10*60*1000);
}
</script>`;
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
  'index-diff':        { session:'quarry-index',    log:'indexer.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'indexer.js'),'--diff']] },
  'index-full':        { session:'quarry-index',    log:'indexer.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'indexer.js')]] },
  'sync-wc':           { session:'quarry-syncwc',   log:'sync-wc.log',  build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--sync-wc']] },
  'sw1':               { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch1']] },
  'sw2':               { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch2']] },
  'sw3':               { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>{ const a=[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch3']]; if(b.limit)a[1].push('--limit',String(b.limit)); if(b.provider)a[1].push('--provider',b.provider); return a; } },
  'sw4':               { session:'quarry-tagger',   log:'tagger.log',   build: (b,C)=>{ const a=[NODE,[...FLAGS,path.join(C,'tagger.js'),'--switch4']]; if(b.limit)a[1].push('--limit',String(b.limit)); return a; } },
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
  if (method==='GET' && /^\/queue/.test(url)) { const db=openDb();ensureSchema(db);const c=queuePage(db,params);db.close(); sendHtml('Queue',c,'/queue'); return; }
  if (method==='GET' && /^\/notes/.test(url)) { const db=openDb();ensureSchema(db);const c=notesPage(db,params);db.close(); sendHtml('Browse',c,'/notes'); return; }
  if (method==='GET' && /^\/review/.test(url)){ const db=openDb();ensureSchema(db);const c=reviewPage(db,params);db.close(); sendHtml('Review',c,'/review'); return; }

  // --- API: run command ---
  if (method==='POST' && url==='/api/run') {
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
  const reportMatch = url.match(/^\/api\/reports\/([a-z-]+)$/);
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
    if (!note){db.close();res.writeHead(404);res.end('{}');return;}
    const essay=db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='essay' ORDER BY switch_level DESC LIMIT 1").get(id);
    const verified=db.prepare("SELECT claim FROM note_classifications WHERE note_id=? AND bucket='verified' ORDER BY switch_level DESC LIMIT 12").all(id).map(r=>r.claim);
    db.close();
    var body='';
    try{body=fs.readFileSync(note.filepath,'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/,'').replace(/_Created at[^_]*\._/g,'').replace(/_Source URL:[^_]*\._/g,'').trim();}catch(_){}
    json(Object.assign({},note,{body,essay:essay?essay.claim:null,verified}));
    return;
  }

  // --- API: save note ---
  const saveMatch = url.match(/^\/api\/notes\/(\d+)\/save$/);
  if (method==='POST' && saveMatch) {
    const id=parseInt(saveMatch[1],10);
    readBody(req,function(b){
      var data={};try{data=JSON.parse(b);}catch(_){}
      const db=openDb();
      const note=db.prepare('SELECT filepath FROM vault_notes WHERE id=?').get(id);
      db.close();
      if(!note){res.writeHead(404);res.end('{"error":"not found"}');return;}
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
    const db=openDb();ensureSchema(db);
    db.prepare("UPDATE narratives SET approval_status='approved',approved_at=? WHERE id=?").run(new Date().toISOString(),parseInt(approveMatch[1],10));
    db.close();json({ok:true});return;
  }
  const rejectMatch = url.match(/^\/api\/narratives\/(\d+)\/reject$/);
  if (method==='POST' && rejectMatch) {
    readBody(req,function(b){
      var reason='';try{reason=JSON.parse(b).reason||'';}catch(_){}
      const db=openDb();ensureSchema(db);
      db.prepare("UPDATE narratives SET approval_status='rejected',rejection_reason=? WHERE id=?").run(reason,parseInt(rejectMatch[1],10));
      db.close();json({ok:true});
    });return;
  }

  // --- API: save exclusions ---
  if (method==='POST' && url==='/api/notes/exclude') {
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
});