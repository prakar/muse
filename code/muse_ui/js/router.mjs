// The address bar is the application state: every screen, page, selection and open note is a shareable, bookmarkable, back-button-friendly URL.
// Pure parse/build here; the browser glue lives in main.mjs.
const SHAPE = { home: [], set: ['id'], basket: [], search: [], stick: [], admin: [], help: [], dipaka: [] };
export const DRAWER_KEYS = ['note', 'at', 'pile'];

export function parse(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/', cut = raw.indexOf('?');
  const path = cut < 0 ? raw : raw.slice(0, cut), qs = cut < 0 ? '' : raw.slice(cut + 1);
  const segs = path.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
  const query0 = Object.fromEntries(new URLSearchParams(qs));
  // Older addresses still work: #/browse?... is Home with filters, #/wordplay/<kind> is Home with that wordplay trick chosen.
  if (segs[0] === 'browse') return { name: 'home', params: {}, query: query0 };
  if (segs[0] === 'wordplay') return { name: 'home', params: {}, query: { ...query0, wp: segs[1] || 'all' } };
  if (segs[0] === 'stick' && query0.id) { const { id, ...rest } = query0; return { name: 'home', params: {}, query: { ...rest, focus: id } }; }   // an older In focus address: the fact now opens inside Home
  const name = segs.length && SHAPE[segs[0]] ? segs[0] : 'home';
  const params = {}; (SHAPE[name] || []).forEach((k, i) => { params[k] = segs[i + 1] || ''; });
  if ((SHAPE[name] || []).some(k => !params[k])) return { name: 'home', params: {}, query: {} };
  return { name, params, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function build(name, params = {}, query = {}) {
  const path = name === 'home' ? '' : [name].concat((SHAPE[name] || []).map(k => encodeURIComponent(params[k]))).join('/');
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false).map(([k, v]) => [k, v === true ? '1' : String(v)])).toString();
  return '#/' + path + (qs ? '?' + qs : '');
}

// Two routes are the same screen if only the open note differs; the drawer then opens or closes without redrawing the page underneath.
export function sameScreen(a, b) {
  const strip = r => JSON.stringify([r.name, r.params, Object.entries(r.query).filter(([k]) => !DRAWER_KEYS.includes(k)).sort()]);
  return !!a && !!b && strip(a) === strip(b);
}
export const withQuery = (route, patch) => build(route.name, route.params, { ...route.query, ...patch });
