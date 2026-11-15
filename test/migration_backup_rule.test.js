'use strict';
// "Create or update the database" no longer backs up on every run. Instead, a migration that can destroy data must say so (backupFirst: true) and then takes its own
// copy before it runs. This test makes that a rule: any migration after M018 whose code drops, deletes, renames or rewrites in place has to declare backupFirst.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'code', 'migrate.js'), 'utf8');
const parts = src.split(/\n\s*id:\s+'(M\d+)'/), migrations = [];
for (let i = 1; i < parts.length; i += 2) migrations.push({ id: parts[i], body: parts[i + 1].split(/\n\s*\/\/ M\d+:/)[0] });
const DESTRUCTIVE = /\b(DROP\s+(TABLE|INDEX|COLUMN)|DELETE\s+FROM|RENAME\s+TO|UPDATE\s+[a-z_]+\s+SET)\b/i;

test('the migrations are found, and M015 (the table rebuild) backs up first', () => {
  assert.ok(migrations.length >= 18, 'parsed ' + migrations.length);
  assert.match(migrations.find(m => m.id === 'M015').body, /backupFirst:\s*true/);
});

test('every migration after M018 that drops, deletes, renames or rewrites in place declares backupFirst', () => {
  const missing = migrations.filter(m => parseInt(m.id.slice(1), 10) > 18 && DESTRUCTIVE.test(m.body) && !/backupFirst:\s*true/.test(m.body)).map(m => m.id);
  assert.deepStrictEqual(missing, [], 'add backupFirst: true to: ' + missing.join(', '));
});
