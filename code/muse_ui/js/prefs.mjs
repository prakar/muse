// Per-browser conveniences only. Storage can be blocked or empty (private windows), so every read and write is guarded and the page works without it.
export function getPref(key, fallback) {
  try { const v = localStorage.getItem('muse.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem('muse.' + key, JSON.stringify(value)); } catch (e) { /* not saved; the switch still works for this visit */ }
}
