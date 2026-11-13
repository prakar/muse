'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createNoteStore } = require('../code/lib/note_store');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-ns-')), vault = path.join(dir, 'vault'), other = path.join(dir, 'copy'); fs.mkdirSync(path.join(vault, '2026'), { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(path.join(vault, '2026', 'Alpha.md'), 'alpha body'); fs.writeFileSync(path.join(vault, '2026', 'Café.md'), 'cafe body'); fs.writeFileSync(path.join(other, 'OnlyInCopy.md'), 'copy body');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE vault_notes (id INTEGER PRIMARY KEY, rel_path TEXT UNIQUE NOT NULL, title TEXT, word_count INTEGER, first_paragraph TEXT, quarry_exclude INTEGER DEFAULT 0); CREATE TABLE burrs (id INTEGER, note_id INTEGER, quote TEXT)');
  const ins = db.prepare('INSERT INTO vault_notes (rel_path, title, word_count, first_paragraph, quarry_exclude) VALUES (?, ?, ?, ?, ?)');
  ins.run('2026/Alpha.md', 'Alpha', 2, 'alpha para', 0); ins.run('2026/Café.md', 'Cafe', 2, 'cafe para', 0); ins.run('OnlyInCopy.md', 'Copy', 2, 'copy para', 0);
  ins.run('2026/Private.md', 'Private', 2, 'secret', 1); ins.run('2026/Gone.md', 'Gone', 3, 'stored paragraph only', 0); ins.run('../../etc/passwd', 'Evil', 1, 'bad key', 0);
  return { db, vault, other };
}

test('note store: the body comes from the file found by joining the key to the vault root; the key alone says where it lives inside the vault', () => {
  const { db, vault } = setup(), s = createNoteStore(db, { vaultRoot: vault });
  const a = s.get({ id: 1 }); assert.strictEqual(a.body, 'alpha body'); assert.strictEqual(a.exists, true); assert.strictEqual(a.obsidian, 'obsidian://open?vault=knowledge&file=2026%2FAlpha');
  assert.strictEqual(s.get({ title: 'alpha' }).id, 1, 'title lookup ignores case');
  assert.strictEqual(s.get({ id: 2 }).body, 'cafe body', 'an NFC key finds a file stored with a decomposed name');
});

test('note store: private notes, unknown ids, missing files and malformed keys are handled without leaking or crashing', () => {
  const { db, vault } = setup(), s = createNoteStore(db, { vaultRoot: vault });
  assert.strictEqual(s.get({ id: 4 }), null, 'quarry_exclude notes are never served'); assert.strictEqual(s.get({ id: 999 }), null);
  const g = s.get({ id: 5 }); assert.strictEqual(g.exists, false); assert.strictEqual(g.body, 'stored paragraph only');
  const e = s.get({ id: 6 }); assert.strictEqual(e.exists, false); assert.ok(!/root:/.test(e.body), 'a key that climbs out of the vault reads nothing');
});

test('note store: several roots are tried in order, so the real vault and its copy can both serve', () => {
  const { db, vault, other } = setup(), s = createNoteStore(db, { vaultRoot: [vault, other] });
  assert.strictEqual(s.get({ id: 3 }).body, 'copy body'); assert.strictEqual(s.get({ id: 1 }).body, 'alpha body');
  assert.strictEqual(createNoteStore(db, {}).get({ id: 1 }).exists, false, 'no root, no file');
});
