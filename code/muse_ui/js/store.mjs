// Minimal observable store. Views read from it and subscribe; nothing else holds shared state.
export function createStore(initial) {
  let state = initial; const subs = new Set();
  return {
    get: () => state,
    set(patch) { const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch }; if (Object.is(next, state)) return; state = next; subs.forEach(f => f(state)); },
    subscribe(f) { subs.add(f); return () => subs.delete(f); }
  };
}
