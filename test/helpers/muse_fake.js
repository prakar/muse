'use strict';
// A small stand-in for the model and note store, so the HTTP layer and the interface can be tested without vault.db.
const KINDS = { 'anagram-pair': 181, 'one-letter-off': 108, 'head-tail': 65, homophone: 42 };
const REAL = { 'anagram-pair': [['Earth', 'Herat'], ['Arabs', 'Basra'], ['Arabia', 'airaab']], 'one-letter-off': [['Berlin', 'Merlin']], homophone: [['Wales', 'whales']] };

function fakeModel() {
  const pairs = [];
  Object.entries(KINDS).forEach(([kind, n]) => { for (let i = 0; i < n; i++) {
    const [a, b] = (REAL[kind] || [])[i] || ['Name' + kind.slice(0, 3) + i, 'Twin' + kind.slice(0, 3) + i];
    pairs.push({ id: `wp:${kind}:${a}|${b}`, label: `${a} ~ ${b}`, kind: 'wordplay', df: 40 - (i % 30), sub: `${kind}, grade ${i % 7 ? 'A' : 'B'}`, a, b, wp: kind, grade: i % 7 ? 'A' : 'B' }); } });
  const items = id => [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: i * 10, noteId: i, note: 'Note about ' + id.slice(-12) + ' ' + i, claim: `Fact ${i} about ${id.split(':').pop().split('|')[0]} and more words.`,
    quote: `Fact ${i} about this thing is written in the note.`, diff: i, side: i % 2 ? 'a' : 'b', hooks: [{ id: 'assyria', label: 'Assyria', df: 9 }, { id: id, label: 'self', df: 3 }, { id: 'tigris', label: 'Tigris', df: 4 }] }));
  const model = {
    burrInfo: id => id > 0 && id < 1000 ? { id, noteId: 1, note: 'Note ' + id, claim: 'Fact ' + id, quote: 'Quote ' + id } : null,
    notes: 6000, burrs: new Array(55000), sparks: [], wordplay: pairs, wordplayState: 'ok',
    wordplayKinds: () => Object.entries(KINDS).map(([kind, n]) => ({ kind, n })),
    wordplayPairs: (kind, limit) => pairs.filter(p => !kind || p.wp === kind).slice(0, limit),
    suggest: (q, limit) => { const s = String(q).toLowerCase(); return pairs.filter(p => p.label.toLowerCase().includes(s)).slice(0, 8).concat(s.includes('merc') ? [{ id: 'mercury', label: 'Mercury', kind: 'hook', df: 12 }] : []).slice(0, limit); },
    handle: id => {
      const p = pairs.find(x => x.id === id);
      if (p) return { id, kind: 'wordplay', wordplay: p.wp, grade: p.grade, a: p.a, b: p.b, surface: p.label, items: items(id) };
      return id === 'mercury' ? { id, kind: 'hook', surface: 'Mercury', types: ['thing'], df: 12, items: items(id) } : null;
    }
  };
  return model;
}
const NOTE = n => `---\ntags: [x]\n---\n# Note ${n}\n\nAn opening paragraph that goes first, with a [[Linked Note]] in it.\n\n- a list item\n- another with **bold**\n\nFact ${n} about this thing is written in the note. It sits here among other sentences.\n\n> A quoted line.\n\nClosing words.\n`;
const fakeNotes = () => ({ get: ({ id, title, at }) => (id || title === 'Linked Note') ? { id: Number(id) || 99, title: title || 'Note ' + id, words: 120, body: NOTE(Number(id) || 99), exists: true, truncated: false, quote: at ? `Fact ${Number(id)} about this thing is written in the note.` : null, obsidian: 'obsidian://open?vault=knowledge&file=x' } : null });
module.exports = { fakeModel, fakeNotes };
