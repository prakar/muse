// "Seen" memory, kept in this browser only (a convenience, never relied on): which sets you opened, and the last few, for quick return.
const KEY = 'muse.visited.v1', MAX = 200;
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; } };
const write = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch (e) { /* private mode or blocked: fine */ } };
let cache = read();
export const visited = {
  has: id => cache.some(v => v.id === id),
  add(id, label, kind) { cache = [{ id, label, kind, at: Date.now() }].concat(cache.filter(v => v.id !== id)); write(cache); },
  recent: (n = 8) => cache.slice(0, n)
};
