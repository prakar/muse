/* QUARRY client — shared across all pages.
 * Event delegation: elements use data-action / data-id / data-cmd instead of
 * inline onclick with string-built JS. */
'use strict';

var _dd = {};
var _logInterval = null;

// ---------------------------------------------------------------------------
// Safe HTML helpers (used when building drawer content client-side)
// ---------------------------------------------------------------------------
function escH(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(u) {
  u = String(u || '');
  if (/^https?:\/\//i.test(u)) return u;
  return '#';
}

// ---------------------------------------------------------------------------
// Drawer / notes
// ---------------------------------------------------------------------------
function openNote(id) {
  var o = document.getElementById('drawer-overlay');
  var c = document.getElementById('drawer-content');
  var t = document.getElementById('drawer-title');
  var m = document.getElementById('drawer-meta');
  var tb = document.getElementById('drawer-tabs');
  if (!o || !c) return;
  c.textContent = 'Loading...';
  if (tb) tb.innerHTML = '';
  if (m) m.innerHTML = '';
  o.classList.add('open');
  fetch('/api/notes/' + id)
    .then(function (r) { return r.json(); })
    .then(function (d) {
      _dd[id] = d;
      t.textContent = d.title || 'Note';
      var mp = [];
      if (d.word_count) mp.push(d.word_count + ' words');
      if (d.content_type) mp.push(d.content_type);
      if (d.source_url) {
        mp.push('<a href="' + escH(safeUrl(d.source_url)) + '" target="_blank" rel="noopener">source ↗</a>');
      }
      m.innerHTML =
        mp.join(' · ') +
        '&nbsp;<button type="button" data-action="start-edit" data-id="' + id +
        '" style="background:none;border:1px solid #444;color:#888;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:.72rem;">✎</button>';
      var th = '';
      var ft = 'raw';
      if (d.tags && d.tags.length) {
        th +=
          '<button type="button" class="drawer-tab active" data-action="show-tab" data-id="' +
          id + '" data-tab="tags">Tags (' + d.tags.length + ')</button>';
        ft = 'tags';
      }
      if (d.essay) {
        th +=
          '<button type="button" class="drawer-tab' + (ft === 'raw' ? ' active' : '') +
          '" data-action="show-tab" data-id="' + id + '" data-tab="essay">Essay</button>';
        if (ft === 'raw') ft = 'essay';
      }
      th +=
        '<button type="button" class="drawer-tab' + (ft === 'raw' ? ' active' : '') +
        '" data-action="show-tab" data-id="' + id + '" data-tab="raw">Raw</button>';
      if (d.verified && d.verified.length) {
        th +=
          '<button type="button" class="drawer-tab" data-action="show-tab" data-id="' +
          id + '" data-tab="facts">Facts (' + d.verified.length + ')</button>';
      }
      if (d.trivia && d.trivia.length) {
        th +=
          '<button type="button" class="drawer-tab" data-action="show-tab" data-id="' +
          id + '" data-tab="trivia">Trivia (' + d.trivia.length + ')</button>';
      }
      tb.innerHTML = th;
      showTabContent(id, ft);
    })
    .catch(function (e) {
      c.textContent = 'Error: ' + e.message;
    });
}

function startEdit(id) {
  var d = _dd[id];
  if (!d) return;
  document.getElementById('drawer-content').innerHTML =
    '<textarea id="note-ed" style="width:100%;height:calc(100vh - 270px);background:#0f0f0f;color:#e8e4dc;border:1px solid #555;padding:12px;font-family:monospace;font-size:.88rem;line-height:1.6;resize:none;">' +
    escH(d.body || '') +
    '</textarea>' +
    '<div style="margin-top:8px;display:flex;gap:8px">' +
    '<button type="button" data-action="save-note" data-id="' + id +
    '" class="btn btn-green" style="font-size:.8rem;padding:5px 14px;">💾 Save</button>' +
    '<button type="button" data-action="open-note" data-id="' + id +
    '" class="btn btn-red" style="font-size:.8rem;padding:5px 14px;">Cancel</button></div>';
}

function saveNote(id) {
  var ta = document.getElementById('note-ed');
  if (!ta) return;
  fetch('/api/notes/' + id + '/save', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ content: ta.value }),
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res.ok) {
        alert('Saved');
        openNote(id);
      } else alert('Save failed');
    })
    .catch(function (e) {
      alert('Error: ' + e.message);
    });
}

function showTab(id, tab, btn) {
  document.querySelectorAll('.drawer-tab').forEach(function (b) {
    b.classList.remove('active');
  });
  if (btn) btn.classList.add('active');
  showTabContent(id, tab);
}

function showTabContent(id, tab) {
  var d = _dd[id];
  if (!d) return;
  var c = document.getElementById('drawer-content');
  if (tab === 'tags') {
    if (!d.tags || !d.tags.length) {
      c.innerHTML = '(no tags)';
      return;
    }
    c.innerHTML = d.tags
      .map(function (t) {
        return (
          '<span class="tag-chip">#' +
          escH(t) +
          '<button type="button" class="tag-chip-x" data-action="delete-tag" data-id="' +
          id +
          '" data-tag="' +
          escH(t) +
          '">✕</button></span>'
        );
      })
      .join(' ');
    return;
  }
  if (tab === 'essay') c.textContent = d.essay || '(no essay)';
  else if (tab === 'facts')
    c.textContent = (d.verified || []).map(function (f) { return '• ' + f; }).join('\n');
  else if (tab === 'trivia')
    c.textContent = (d.trivia || []).map(function (f) { return '• ' + f; }).join('\n');
  else c.textContent = d.body || '(no content)';
}

function deleteTag(id, tag) {
  if (!confirm('Remove tag "' + tag + '"?')) return;
  fetch('/api/notes/' + id + '/tags/delete', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ tag: tag }),
  })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      if (res.ok) openNote(id);
      else alert('Delete failed');
    })
    .catch(function (e) {
      alert('Error: ' + e.message);
    });
}

function closeDrawer(e) {
  if (e && e.target !== document.getElementById('drawer-overlay')) return;
  var o = document.getElementById('drawer-overlay');
  if (o) o.classList.remove('open');
}

// ---------------------------------------------------------------------------
// Narratives
// ---------------------------------------------------------------------------
function approve(id) {
  fetch('/api/narratives/' + id + '/approve', { method: 'POST', headers: apiHeaders(), body: '{}' }).then(function (r) {
    if (r.ok) {
      var el = document.getElementById('card-' + id);
      if (el) el.remove();
      updateCount();
    }
  });
}

function reject(id) {
  var input = document.getElementById('reason-' + id);
  var reason = input ? input.value.trim() : '';
  fetch('/api/narratives/' + id + '/reject', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ reason: reason }),
  }).then(function (r) {
    if (r.ok) {
      var el = document.getElementById('card-' + id);
      if (el) el.remove();
      updateCount();
    }
  });
}

function copyText(id) {
  var node = document.getElementById('nt-' + id);
  if (!node) return;
  navigator.clipboard.writeText(node.innerText).then(function () {
    var b = document.getElementById('cp-' + id);
    if (!b) return;
    b.textContent = 'Copied!';
    setTimeout(function () { b.textContent = 'Copy'; }, 1500);
  });
}

function updateCount() {
  var r = document.querySelectorAll('.card').length;
  var e = document.getElementById('pending-count');
  if (e) e.textContent = r;
}

// ---------------------------------------------------------------------------
// Command runner (vault / tagger / curator / narrator)
// ---------------------------------------------------------------------------
function apiHeaders() {
  var h = { 'Content-Type': 'application/json' };
  var meta = document.querySelector('meta[name="quarry-token"]');
  if (meta && meta.content) h['X-Quarry-Token'] = meta.content;
  return h;
}

function runCmd(cmd, label, extra) {
  var el = document.getElementById('cmd-output');
  if (el) el.innerHTML = '<div class="log-box" id="log-box">Starting ' + escH(label) + '...</div>';
  var body = withSingleNote(Object.assign({ cmd: cmd }, extra || {}));
  fetch('/api/run', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!el) return;
      if (d.ok) {
        el.innerHTML +=
          '<div style="color:#6ec86e;font-size:.78rem;margin-top:6px">✓ ' + escH(d.msg) + jobLinks(d.log, d.session) + '</div>';
        startLogPoll(d.log || 'tagger.log');
      } else {
        el.innerHTML +=
          '<div style="color:#c86e6e;font-size:.78rem;margin-top:6px">✗ ' +
          escH(d.error || 'unknown error') + (d.busySession ? jobLinks(null, d.busySession) : '') +
          '</div>';
      }
    });
}

function showCmdResult(r) {
  return r.json().then(function (d) {
    var el = document.getElementById('cmd-output');
    if (!el) return;
    if (d.ok) {
      el.innerHTML +=
        '<div style="color:#6ec86e;font-size:.78rem;margin-top:6px">✓ ' + escH(d.msg) + jobLinks(d.log, d.session) + '</div>';
      startLogPoll(d.log || 'tagger.log');
    } else {
      el.innerHTML +=
        '<div style="color:#c86e6e;font-size:.78rem;margin-top:6px">✗ ' +
        escH(d.error || 'unknown error') + (d.busySession ? jobLinks(null, d.busySession) : '') +
        '</div>';
    }
  });
}

// Links shown next to a started (or blocked) job: the whole log in its own tab - a plain browser
// page you can scroll, search and copy, which never refreshes under you - and a Stop button.
function jobLinks(logFile, session) {
  var out = '';
  if (logFile) out += ' &nbsp;<a class="job-link" target="_blank" rel="noopener" href="/api/log?full=1&file=' +
    encodeURIComponent(logFile) + '">open full log ↗</a>';
  if (session) out += ' &nbsp;<a class="job-link" href="#" data-action="stop-job" data-session="' + escH(session) + '">■ Stop</a>';
  return out;
}

function startLogPoll(logFile) {
  if (_logInterval) clearInterval(_logInterval);
  var lf = logFile || 'tagger.log';
  var started = Date.now();
  _logInterval = setInterval(function () {
    // Keeps following long runs (the old 10-minute cut-off froze the panel mid-run); pauses while
    // the tab is hidden and gives up after 12 hours.
    if (Date.now() - started > 12 * 3600 * 1000) { clearInterval(_logInterval); return; }
    if (document.hidden) return;
    fetch('/api/log?file=' + encodeURIComponent(lf))
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var b = document.getElementById('log-box');
        if (!b || b.textContent === t) return;
        // Only follow the bottom if you were already there: scrolled up to read or select
        // something, the view stays put while new lines arrive.
        var atBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 30;
        var keep = b.scrollTop;
        b.textContent = t;
        b.scrollTop = atBottom ? b.scrollHeight : keep;
      });
  }, 3000);
}

function stopJob(session) {
  if (!confirm('Stop the job running in ' + session + '? An AI call in progress may still be billed.')) return;
  fetch('/api/stop', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ session: session }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var el = document.getElementById('cmd-output');
      if (el) el.innerHTML += '<div style="color:' + (d.ok ? '#c8b89a' : '#c86e6e') + ';font-size:.78rem;margin-top:6px">' +
        escH(d.ok ? d.msg : (d.error || 'stop failed')) + '</div>';
    });
}

function runVocab(dry) {
  var limit = document.getElementById('vocab-limit');
  runCmd('sw-vocab', dry ? 'Quick Tag Match (dry run)' : 'Quick Tag Match',
    { limit: limit && limit.value ? limit.value : undefined, dryRun: !!dry });
}

function narratorReset() {
  fetch('/api/narrator/reset-preview').then(function (r) { return r.json(); }).then(function (p) {
    var msg = 'Delete ' + p.narratives + ' narrative(s) and ' + p.queue + ' queue item(s)?';
    if (p.approved) msg += '\n\n' + p.approved + ' of them are APPROVED.';
    msg += '\n\nA JSON backup is saved to backups/ first.';
    if (!confirm(msg)) return;
    runCmd('narrator-reset', 'Narrator reset', { expectApproved: p.approved });
  });
}

function runS3(dry) {
  var limit = document.getElementById('s3-limit');
  var prov = document.getElementById('s3-prov');
  fetch('/api/run', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(withSingleNote({
      cmd: 'sw3',
      dryRun: !!dry,
      limit: limit ? limit.value : 500,
      provider: prov ? prov.value : 'openrouter',
    })),
  }).then(showCmdResult);
}

function runRetag(dry) {
  var limit = document.getElementById('retag-limit');
  var prov = document.getElementById('retag-prov');
  fetch('/api/run', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(withSingleNote({
      cmd: 'sw3-retag',
      dryRun: !!dry,
      limit: limit ? limit.value : 500,
      provider: prov ? prov.value : 'grok',
    })),
  }).then(showCmdResult);
}

function runMwc() {
  var limit = document.getElementById('mwc-limit');
  fetch('/api/run', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ cmd: 'mwc', limit: limit ? limit.value : 5 }),
  }).then(showCmdResult);
}

function runLive() {
  var sel = document.getElementById('ns-count');
  fetch('/api/run', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      cmd: 'narrator-live',
      numSources: sel ? sel.value : 3,
    }),
  }).then(showCmdResult);
}

function narrateId(id) {
  fetch('/api/run', {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ cmd: 'narrator-id', id: id }),
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      alert(d.ok ? 'Narration started — check Pending queue' : 'Failed: ' + d.error);
    });
}

function discardId(id) {
  if (!confirm('Discard queue item ' + id + '?')) return;
  fetch('/api/queue/' + id + '/discard', { method: 'POST', headers: apiHeaders() }).then(
    function (r) {
      if (r.ok) location.reload();
    }
  );
}

function runReport(id) {
  var el = document.getElementById('rr-' + id);
  if (!el) return;
  el.innerHTML = '<span style="color:#555;font-size:.75rem">Running...</span>';
  fetch('/api/reports/' + id)
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      if (!rows || !rows.length) {
        el.innerHTML = '<span style="color:#555;font-size:.75rem">No results</span>';
        return;
      }
      var cols = Object.keys(rows[0]);
      var th = cols.map(function (c) { return '<th>' + escH(c) + '</th>'; }).join('');
      var tb = rows
        .map(function (r) {
          return (
            '<tr>' +
            cols
              .map(function (c) {
                return '<td>' + (r[c] === null ? '' : escH(String(r[c]).slice(0, 120))) + '</td>';
              })
              .join('') +
            '</tr>'
          );
        })
        .join('');
      el.innerHTML = '<table><thead><tr>' + th + '</tr></thead><tbody>' + tb + '</tbody></table>';
    })
    .catch(function (e) {
      el.innerHTML =
        '<span style="color:#c86e6e;font-size:.75rem">Error: ' + escH(e.message) + '</span>';
    });
}

// Notes / review filter navigation (page-local controls still use ids)
function applyNF() {
  var f = document.getElementById('nf-sel');
  var s = document.getElementById('ns-sel');
  var q = document.getElementById('nq-box');
  if (!f) return;
  window.location =
    '/notes?filter=' +
    encodeURIComponent(f.value) +
    '&sort=' +
    encodeURIComponent(s ? s.value : 'words') +
    '&q=' +
    encodeURIComponent(q ? q.value : '');
}

// ---------------------------------------------------------------------------
// Global click delegation
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Single-note targeting (Tagger page)
//
// Lets a run target ONE note instead of the whole vault. The picked note is held in
// _singleNote and injected into the request by withSingleNote(), in one place, rather
// than editing every Run button. Only commands that actually understand --file get it;
// Compress and video extraction ignore the selection, and the panel says so.
//
// File paths are kept in _findResults (keyed by note id) and never written into HTML
// attributes - paths contain commas, parentheses and quotes, and this codebase already
// paid for putting arbitrary text into attributes once. Rows carry only the numeric id.
// ---------------------------------------------------------------------------
var _singleNote = null;       // { id, title, filepath, rel } once a note is picked
var _findResults = {};        // id -> row from /api/notes/find
var _findTimer = null;
var FILE_CMDS = ['sw-vocab', 'sw3', 'sw3-retag'];

function withSingleNote(body) {
  if (_singleNote && FILE_CMDS.indexOf(body.cmd) !== -1) body.file = _singleNote.filepath;
  return body;
}

function renderSingleNote() {
  var box = document.getElementById('single-note-active');
  if (!box) return;
  if (!_singleNote) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML =
    '<strong>Single-note mode is ON.</strong> Quick Tag Match, AI Tag Suggestions and AI Tag Correction ' +
    'will run on <em>' + escH(_singleNote.title) + '</em> only.' +
    '<span class="single-note-path">' + escH(_singleNote.rel) + '</span>' +
    '<button type="button" class="btn btn-grey" data-action="clear-single-note">Clear</button>';
}

function findNotes(q) {
  var out = document.getElementById('single-note-results');
  if (!out) return;
  if (q.trim().length < 2) { out.innerHTML = ''; return; }
  fetch('/api/notes/find?q=' + encodeURIComponent(q.trim()))
    .then(function (r) { return r.json(); })
    .then(function (rows) {
      _findResults = {};
      if (!rows.length) { out.innerHTML = '<div class="single-note-empty">No matching notes.</div>'; return; }
      out.innerHTML = rows.map(function (n) {
        _findResults[n.id] = n;
        return '<div class="single-note-row" data-action="pick-single-note" data-id="' + n.id + '">' +
          '<span class="nt">' + escH(n.title) + '</span> ' +
          '<span class="nm">' + n.word_count + 'w &middot; ' + escH(n.rel) + '</span></div>';
      }).join('');
    })
    .catch(function () { out.innerHTML = '<div class="single-note-empty">Search failed.</div>'; });
}

document.addEventListener('input', function (e) {
  if (!e.target || e.target.id !== 'single-note-q') return;
  var q = e.target.value;
  clearTimeout(_findTimer);
  _findTimer = setTimeout(function () { findNotes(q); }, 250);
});

document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.getAttribute('data-action');
  var id = el.getAttribute('data-id');
  var idNum = id != null ? parseInt(id, 10) : NaN;

  switch (action) {
    case 'open-note':
      e.preventDefault();
      if (!isNaN(idNum)) openNote(idNum);
      break;
    case 'pick-single-note':
      e.preventDefault();
      if (!isNaN(idNum) && _findResults[idNum]) {
        _singleNote = _findResults[idNum];
        var pickOut = document.getElementById('single-note-results');
        if (pickOut) pickOut.innerHTML = '';
        var pickQ = document.getElementById('single-note-q');
        if (pickQ) pickQ.value = '';
        renderSingleNote();
      }
      break;
    case 'clear-single-note':
      e.preventDefault();
      _singleNote = null;
      renderSingleNote();
      break;
    case 'start-edit':
      e.preventDefault();
      if (!isNaN(idNum)) startEdit(idNum);
      break;
    case 'save-note':
      e.preventDefault();
      if (!isNaN(idNum)) saveNote(idNum);
      break;
    case 'show-tab':
      e.preventDefault();
      if (!isNaN(idNum)) showTab(idNum, el.getAttribute('data-tab'), el);
      break;
    case 'delete-tag':
      e.preventDefault();
      if (!isNaN(idNum)) deleteTag(idNum, el.getAttribute('data-tag') || '');
      break;
    case 'close-drawer':
      e.preventDefault();
      closeDrawer(e);
      break;
    case 'approve':
      e.preventDefault();
      if (!isNaN(idNum)) approve(idNum);
      break;
    case 'reject':
      e.preventDefault();
      if (!isNaN(idNum)) reject(idNum);
      break;
    case 'copy':
      e.preventDefault();
      if (!isNaN(idNum)) copyText(idNum);
      break;
    case 'run-cmd':
      e.preventDefault();
      (function() {
        var extra = {};
        if (el.getAttribute('data-dry') === '1') extra.dryRun = true;
        var limId = el.getAttribute('data-limit-input');
        if (limId) { var limEl = document.getElementById(limId); if (limEl && limEl.value) extra.limit = limEl.value; }
        runCmd(el.getAttribute('data-cmd'), el.getAttribute('data-label') || el.getAttribute('data-cmd'),
          Object.keys(extra).length ? extra : undefined);
      })();
      break;
    case 'run-vocab':
      e.preventDefault();
      runVocab(el.getAttribute('data-dry') === '1');
      break;
    case 'run-s3':
      e.preventDefault();
      runS3(el.getAttribute('data-dry') === '1');
      break;
    case 'run-retag':
      e.preventDefault();
      runRetag(el.getAttribute('data-dry') === '1');
      break;
    case 'stop-job':
      e.preventDefault();
      stopJob(el.getAttribute('data-session'));
      break;
    case 'narrator-reset':
      e.preventDefault();
      narratorReset();
      break;
    case 'run-mwc':
      e.preventDefault();
      runMwc();
      break;
    case 'run-live':
      e.preventDefault();
      runLive();
      break;
    case 'narrate':
      e.preventDefault();
      if (!isNaN(idNum)) narrateId(idNum);
      break;
    case 'discard':
      e.preventDefault();
      if (!isNaN(idNum)) discardId(idNum);
      break;
    case 'run-report':
      e.preventDefault();
      runReport(el.getAttribute('data-report'));
      break;
    default:
      break;
  }
});

// Overlay mousedown outside drawer still closes (data-action on overlay)
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeDrawer();
});
