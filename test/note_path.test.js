'use strict';
const test = require('node:test'), assert = require('node:assert'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const N = require('../code/lib/note_path');
const posix = path.posix, win = path.win32;

test('checkKey: accepts portable keys, refuses everything that could escape or differ by system', () => {
  for (const k of ['a.md', '2026/Some Note.md', "2013/'Death Ray II'_ London.md", '+Home.md', 'Caf\u00e9/x.md', '2026/a b/c d.md']) assert.strictEqual(N.checkKey(k), k, k);
  const bad = { '': /non-empty/, '/abs/x.md': /relative/, 'C:/x.md': /relative/, 'C:x.md': /relative/, '..': /"\.\."/, 'a/../b.md': /"\.\."/, './a.md': /"\."/, 'a//b.md': /empty segment/, 'a/b/': /empty segment/,
    'a\\b.md': /backslash/, 'a\u0000b.md': /control/, 'Cafe\u0301.md': /NFC/ };
  for (const [k, re] of Object.entries(bad)) assert.throws(() => N.checkKey(k), re, JSON.stringify(k));
  assert.throws(() => N.checkKey(null), /non-empty/); assert.throws(() => N.checkKey(7), /non-empty/);
  assert.ok(N.isKey('a.md') && !N.isKey('../a.md'));
});

test('toKey and toAbs on POSIX: round trip, trailing slashes, sibling folders and escapes are refused', () => {
  const root = '/home/me/dev/quarry-data/knowledge';
  assert.strictEqual(N.toKey(root + '/2026/Some Note.md', root, posix), '2026/Some Note.md');
  assert.strictEqual(N.toKey(root + '/+Home.md', root + '/', posix), '+Home.md');
  assert.strictEqual(N.toAbs('2026/Some Note.md', root + '/', posix), root + '/2026/Some Note.md');
  assert.strictEqual(N.toKey(N.toAbs('2013/it\'s a note.md', root, posix), root, posix), '2013/it\'s a note.md');
  for (const outside of [root, root + '-copy/x.md', '/home/me/other/x.md', root + '/../x.md']) assert.throws(() => N.toKey(outside, root, posix), /not inside/, outside);
  assert.throws(() => N.toKey('/abs/x.md'), /root is needed/);
  assert.throws(() => N.toAbs('../x.md', root, posix), /"\.\."/);
  assert.throws(() => N.toAbs('a.md'), /root is needed/);
  assert.strictEqual(N.toKey('2026/x.md'), '2026/x.md', 'a relative input is a key already');
  assert.throws(() => N.toKey('../x.md'), /"\.\."/);
});

test('toKey and toAbs follow Windows rules too: backslashes, drive letters, case-insensitive roots', () => {
  const root = 'C:\\Users\\me\\quarry-data\\knowledge';
  assert.strictEqual(N.toKey(root + '\\2026\\Some Note.md', root, win), '2026/Some Note.md');
  assert.strictEqual(N.toKey('c:\\users\\me\\quarry-data\\knowledge\\2026\\x.md', root, win), '2026/x.md');
  assert.strictEqual(N.toKey('2026\\x.md', root, win), '2026/x.md', 'a relative Windows path becomes a key');
  assert.strictEqual(N.toAbs('2026/Some Note.md', root, win), root + '\\2026\\Some Note.md');
  assert.throws(() => N.toKey('D:\\other\\x.md', root, win), /not inside/);
  assert.throws(() => N.toKey('C:\\Users\\me\\quarry-data\\knowledge-copy\\x.md', root, win), /not inside/);
});

test('keys are Unicode NFC whatever form the file system returned', () => {
  const root = '/v', nfd = '/v/2026/Cafe\u0301.md';
  assert.strictEqual(N.toKey(nfd, root, posix), '2026/Caf\u00e9.md');
  assert.strictEqual(N.toKey('2026/Cafe\u0301.md'), '2026/Caf\u00e9.md');
});

test('locate: finds the file whether the disk holds the composed or the decomposed name, and never leaves the root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-locate-'));
  fs.mkdirSync(path.join(dir, '2026')); fs.writeFileSync(path.join(dir, '2026', 'Cafe\u0301.md'), 'x'); fs.writeFileSync(path.join(dir, 'plain.md'), 'x');
  assert.ok(N.locate('plain.md', dir)); assert.ok(N.locate('2026/Caf\u00e9.md', dir), 'NFC key, NFD file');
  assert.strictEqual(N.locate('2026/missing.md', dir), null); assert.strictEqual(N.locate('2026', dir), null, 'a folder is not a note');
  assert.throws(() => N.locate('../x.md', dir), /"\.\."/);
});

test('vaultRoot: VAULT_PATH wins, the dev convention counts only if it exists, otherwise an error', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-root-')), home = path.join(base, 'quarry'); fs.mkdirSync(home);
  assert.strictEqual(N.vaultRoot({ VAULT_PATH: '/x/y/' }), '/x/y');
  assert.throws(() => N.vaultRoot({}, home), /VAULT_PATH is not set/);
  fs.mkdirSync(path.join(base, 'quarry-data', 'knowledge'), { recursive: true });
  assert.strictEqual(N.vaultRoot({}, home), path.join(base, 'quarry-data', 'knowledge'));
  assert.strictEqual(N.vaultRoot({ QUARRY_HOME: home }), path.join(base, 'quarry-data', 'knowledge'));
  assert.throws(() => N.vaultRoot({}), /VAULT_PATH is not set/);
});

test('portabilityIssues and findCollisions: reported, not refused', () => {
  assert.deepStrictEqual(N.portabilityIssues('2026/Fine name.md'), []);
  assert.match(N.portabilityIssues('2026/What? Why.md')[0], /character Windows does not allow/);
  assert.match(N.portabilityIssues('2026/trailing.')[0], /space or a dot/);
  assert.match(N.portabilityIssues('con.md')[0], /reserved/); assert.match(N.portabilityIssues('a/LPT1.txt')[0], /reserved/);
  assert.match(N.portabilityIssues('x'.repeat(230) + '.md')[0], /longer than 212/); assert.deepStrictEqual(N.portabilityIssues('x'.repeat(230) + '.md', 0), []);
  assert.deepStrictEqual(N.findCollisions(['a/Note.md', 'a/note.md', 'b/x.md', 'b/x.md']), [['a/Note.md', 'a/note.md']]);
  assert.deepStrictEqual(N.findCollisions(['Caf\u00e9.md', 'Cafe\u0301.md']), [['Caf\u00e9.md', 'Cafe\u0301.md']]);
});

test('older databases: the shared prefix is found for POSIX and Windows stored paths, and a path outside it is reported', () => {
  const mac = ['/Users/me/Developer/prototypes/quarry-data/knowledge/+Home.md', '/Users/me/Developer/prototypes/quarry-data/knowledge/2013/a.md'];
  assert.strictEqual(N.chooseLegacyPrefix(mac), '/Users/me/Developer/prototypes/quarry-data/knowledge');
  assert.strictEqual(N.chooseLegacyPrefix(mac, '/Users/me/Developer/prototypes/quarry-data/knowledge/'), '/Users/me/Developer/prototypes/quarry-data/knowledge');
  assert.strictEqual(N.chooseLegacyPrefix(mac, '/home/me/dev/quarry-data/knowledge'), '/Users/me/Developer/prototypes/quarry-data/knowledge', 'a configured root the paths are not under is ignored');
  assert.strictEqual(N.chooseLegacyPrefix(mac, null, '/Users/me/Developer/prototypes/quarry-data'), '/Users/me/Developer/prototypes/quarry-data', 'an explicit override wins');
  assert.strictEqual(N.keyFromLegacy(mac[1], N.chooseLegacyPrefix(mac)), '2013/a.md');
  assert.strictEqual(N.keyFromLegacy('/elsewhere/x.md', '/Users/me'), null);
  assert.strictEqual(N.keyFromLegacy('/Users/me-two/x.md', '/Users/me'), null, 'a longer sibling name is not "under" the prefix');
  const w = ['C:\\Users\\me\\kn\\2026\\a.md', 'c:\\users\\me\\kn\\b.md'];
  assert.strictEqual(N.chooseLegacyPrefix(w, 'C:\\Users\\me\\kn'), 'C:/Users/me/kn');
  assert.strictEqual(N.keyFromLegacy(w[0], 'C:/Users/me/kn'), '2026/a.md'); assert.strictEqual(N.keyFromLegacy(w[1], 'C:/Users/me/kn'), 'b.md', 'Windows paths ignore case');
  assert.strictEqual(N.keyFromLegacy('/Users/me/kn/Cafe\u0301.md', '/Users/me/kn'), 'Caf\u00e9.md');
  assert.strictEqual(N.commonDirPrefix([]), ''); assert.strictEqual(N.commonDirPrefix(['/a/b/x.md', '/a/c/y.md']), '/a');
});
