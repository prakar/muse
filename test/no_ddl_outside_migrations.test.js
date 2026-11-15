'use strict';
// The migrations (code/migrate.js) are the only thing that changes vault.db's schema. This test fails if a new file creates, alters or drops a table or index,
// or runs a schema definition, anywhere else. Each exception below says why it is safe.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path');
const CODE = path.join(__dirname, '..', 'code');

const DDL_OK = {
  'migrate.js': 'the migrations: the one authority',
  'lib/rel_path_migration.js': 'run only by migration M015',
  'lib/base_schema.js': 'definition text, executed only by migrate.js',
  'lib/burrs.js': 'definition text (SCHEMA_SQL), executed only by migrate.js',
  'lib/dedupe.js': 'definition text (SCHEMA_SQL), executed only by migrate.js',
  'lib/wordplay_edges.js': 'definition text (SCHEMA_SQL), executed only by migrate.js',
  'lib/search_cache.js': 'its own cache file (muse-cache.db), never vault.db',
  'lib/search_core.js': 'an in-memory search index, rebuilt each time',
  'lib/schema_structure.js': 'reads and compares schemas; creates nothing in vault.db'
};
const RUNS_SCHEMA_OK = new Set(['migrate.js', 'lib/schema_structure.js']);   // files that may execute a schema definition (the others only define it)

const walk = (d, o = []) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
  if (f.name === 'node_modules' || f.name === 'lab') continue; const p = path.join(d, f.name);
  f.isDirectory() ? walk(p, o) : /\.(js|mjs)$/.test(f.name) && o.push(p); } return o; };
const stripComments = s => s.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const rel = f => path.relative(CODE, f).split(path.sep).join('/');
const DDL = /\b(ALTER\s+TABLE|DROP\s+(TABLE|INDEX|VIEW|TRIGGER)|CREATE\s+(VIRTUAL\s+)?(TABLE|INDEX|VIEW|TRIGGER))\b/i;

test('no file outside the migrations (and the listed exceptions) creates, alters or drops tables or indexes', () => {
  const bad = walk(CODE).filter(f => !DDL_OK[rel(f)] && DDL.test(stripComments(fs.readFileSync(f, 'utf8')))).map(rel);
  assert.deepStrictEqual(bad, [], 'schema changes belong in a migration in code/migrate.js: ' + bad.join(', '));
});

test('a schema definition (SCHEMA_SQL / initSchema) is only run by migrate.js', () => {
  const bad = walk(CODE).filter(f => !RUNS_SCHEMA_OK.has(rel(f))).filter(f => {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    return /\bexec\(\s*[A-Za-z_.()' \/-]*SCHEMA_SQL/.test(s) || /\binitSchema\(/.test(s.replace(/function initSchema\(/, '')); }).map(rel);
  assert.deepStrictEqual(bad, [], 'only migrate.js may run a schema definition: ' + bad.join(', '));
});

test('every exception is a real file (the list cannot rot)', () => {
  Object.keys(DDL_OK).forEach(f => assert.ok(fs.existsSync(path.join(CODE, f)), 'listed but missing: ' + f));
});
