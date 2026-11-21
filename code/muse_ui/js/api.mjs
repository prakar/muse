// All server calls live here. A call made with a `key` cancels the previous in-flight call with the same key (latest wins),
// so a slow answer can never overwrite a newer screen.
const inflight = new Map();
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

async function request(url, init, key) {
  let signal;
  if (key) { inflight.get(key)?.abort(); const c = new AbortController(); inflight.set(key, c); signal = c.signal; }
  try {
    const res = await fetch(url, { ...init, signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, body.error || res.statusText);
    return body;
  } finally { if (key && inflight.get(key)?.signal === signal) inflight.delete(key); }
}
const qs = o => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : v])).toString(); return p ? '?' + p : ''; };
const get = (path, params = {}, key, headers) => request(path + qs(params), headers ? { headers } : {}, key);
const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  meta: () => get('/api/meta'),
  suggest: q => get('/api/suggest', { q }, 'suggest'),
  pairs: ({ kind, page, size, hidden }) => get('/api/wordplay', { kind: kind === 'all' ? '' : kind, page, size, hidden }, 'pairs'),
  set: (id, { n, o, r, h }) => get('/api/connect', { id, n, order: o, reveal: r, hidden: h }, 'set'),
  note: (id, at) => get('/api/note', { id, at }, 'note'),
  noteByTitle: title => get('/api/note', { title }, 'note'),
  search: (q, meaning, page, size) => get('/api/search', Object.assign({ q, meaning: meaning ? '1' : '0' }, page > 1 ? { page } : {}, size ? { size } : {}), 'search', { 'X-Muse': '1' }),
  searchStatus: () => get('/api/search/status'),
  stick: id => get('/api/stick', { id }, 'stick'),
  event: body => fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(() => {}),
  tray: () => get('/api/tray'),
  anglesBrowse: ({ h, page, size }) => get('/api/angles/browse', { h, page: page > 1 ? page : undefined, size }, 'angles-browse'),
  angles: ids => get('/api/angles', { ids: ids.join(',') }, 'angles'),
  saveTray: body => request('/api/tray', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }),
  shelf: o => get('/api/shelf', o, 'shelf'),
  stickRandom: () => get('/api/stick', { random: true }),
  kept: () => get('/api/kept', {}, 'kept'),
  mark: body => post('/api/mark', body),
  dipaka: () => get('/api/dipaka'),
  dipakaPreview: body => request('/api/dipaka/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muse': '1' }, body: JSON.stringify(body) }),
  dipakaRun: body => request('/api/dipaka/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muse': '1' }, body: JSON.stringify(body) }),
  dipakaLabel: body => request('/api/dipaka/label', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muse': '1' }, body: JSON.stringify(body) }),
  dipakaDelete: body => request('/api/dipaka/delete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muse': '1' }, body: JSON.stringify(body) }),
  adminStatus: () => get('/api/admin/status', {}, 'admin', { 'X-Muse': '1' }),
  adminDrift: () => request('/api/admin/drift', { method: 'POST', headers: { 'X-Muse': '1' } }),
  adminOps: () => get('/api/admin/ops', {}, 'ops', { 'X-Muse': '1' }),
  adminTags: p => get('/api/admin/tags', p || {}, null, { 'X-Muse': '1' }),
  adminJobs: () => get('/api/admin/jobs', {}, 'jobs', { 'X-Muse': '1' }),
  adminJob: (id, tail) => get('/api/admin/jobs/' + encodeURIComponent(id), { tail }, null, { 'X-Muse': '1' }),
  adminStart: body => request('/api/admin/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muse': '1' }, body: JSON.stringify(body) }).then(r => r),
  adminCancel: id => request('/api/admin/jobs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Muse': '1' }, body: '{}' })
};
