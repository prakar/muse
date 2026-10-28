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
const get = (path, params = {}, key) => request(path + qs(params), {}, key);
const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  meta: () => get('/api/meta'),
  suggest: q => get('/api/suggest', { q }, 'suggest'),
  pairs: ({ kind, page, size, hidden }) => get('/api/wordplay', { kind: kind === 'all' ? '' : kind, page, size, hidden }, 'pairs'),
  set: (id, { n, o, r, h }) => get('/api/connect', { id, n, order: o, reveal: r, hidden: h }, 'set'),
  note: (id, at) => get('/api/note', { id, at }, 'note'),
  noteByTitle: title => get('/api/note', { title }, 'note'),
  kept: () => get('/api/kept', {}, 'kept'),
  mark: body => post('/api/mark', body)
};
