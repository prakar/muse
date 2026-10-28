import { toast } from './components/toast.mjs';

// Everything that changes a mark goes through here: one place that talks to the server, keeps the basket count in step, and offers Undo.
export function createActions({ api, store, refresh }) {
  const send = async (handle, item, mark, info) => { const r = await api.mark({ handle, item, mark, ctx: info }); store.set({ marks: r.marks }); return r.mark; };
  return {
    // Toggle one mark on a handle (item = null) or a fact. Returns the mark now in force, or null.
    async toggle(handle, item, current, mark, info) { return send(handle, item, current === mark ? 'clear' : mark, info); },
    // Dull / Wrong sense: the fact leaves the set and the next candidate takes its place, so the page is redrawn; Undo puts it back.
    async hide(handle, item, current, mark, info) {
      const now = await this.toggle(handle, item, current, mark, info); await refresh();
      if (now) toast({ text: mark === 'dull' ? 'Marked dull. The next fact took its place.' : 'Marked wrong sense. The next fact took its place.', action: { label: 'Undo', onClick: async () => { await send(handle, item, current || 'clear', info); await refresh(); } } });
    },
    send
  };
}
