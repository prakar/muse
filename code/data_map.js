#!/usr/bin/env node
'use strict';
// The data map: for every table in vault.db, which code files read it (R), insert into it (C), update it (U) and delete from it (D).
// Tables come from a fresh database built by the migrations (the same source the integrity check trusts), so the list cannot drift from the schema. The code is
// scanned for SQL statements, so the map cannot drift from the code either: a test compares the committed map (code/data/data_map.json) with a fresh scan, and fails
// if the code names a table that does not exist (a stale reference), or if a table is never written or never read without a stated reason.
//
//   node code/data_map.js            print the matrix
//   node code/data_map.js --write    rewrite code/data/data_map.json (after a deliberate change)
//   node code/data_map.js --check    exit 1 if the committed map is out of date
//
// Limits, on purpose: only literal SQL is seen. A table name built at run time ('DELETE FROM ' + t) is invisible, so keep table names literal in the code.
// Files that work on other databases or on a temporary table are skipped (SKIP below), and so are the migrations and the base definition, which are where tables are
// made and changed (test/no_ddl_outside_migrations.test.js guards that).
const fs = require('fs'), path = require('path');

const CODE = __dirname;
const SKIP = new Set([
  'migrate.js', 'lib/base_schema.js', 'lib/rel_path_migration.js', 'lib/schema_structure.js', 'lib/integrity.js',   // where tables are made, changed and compared
  'lib/search_cache.js',   // its own file, muse-cache.db
  'lib/search_core.js'     // an in-memory search index, rebuilt each time
]);
// Names that appear after FROM/JOIN/INTO/UPDATE but are not vault.db tables.
const NOT_TABLES = new Set(['sqlite_master', 'sqlite_schema', 'vault_fts', 'f']);

// A table that is legitimately only read, or only written, by the code (everything else must have both).
const WHY_ONE_SIDED = {
  schema_migrations: 'written only by migrate.js, which this scan skips; read by the integrity check and Admin',
  vault_meta: 'written and read by the one-time path-key migration, which this scan skips',
  api_budget: 'written by every paid step, read by the spend report'
};

const walk = (d, o = []) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'lab', 'muse_ui', 'data'].includes(f.name)) continue;
    const p = path.join(d, f.name);
    f.isDirectory() ? walk(p, o) : /\.(js|mjs)$/.test(f.name) && o.push(p);
  }
  return o;
};
const rel = f => path.relative(CODE, f).split(path.sep).join('/');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

function tableNames() {
  const { DatabaseSync } = require('node:sqlite');
  const db = require('./migrate').buildFresh(new DatabaseSync(':memory:'));
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'vault_fts%' ORDER BY name").all().map(r => r.name);
  } finally { db.close(); }
}

function scan(tables) {
  const map = Object.fromEntries(tables.map(t => [t, { C: [], R: [], U: [], D: [] }]));
  const unknown = {};
  for (const f of walk(CODE)) {
    const r = rel(f); if (SKIP.has(r)) continue;
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const t of tables) {
      const ins = new RegExp('\\b(INSERT(?:\\s+OR\\s+\\w+)?|REPLACE)\\s+INTO\\s+' + t + '\\b', 'i'), upd = new RegExp('\\bUPDATE\\s+' + t + '\\b'), del = new RegExp('\\bDELETE\\s+FROM\\s+' + t + '\\b', 'i');
      const read = new RegExp('\\b(FROM|JOIN)\\s+' + t + '\\b', 'i');
      if (ins.test(s)) map[t].C.push(r);
      if (upd.test(s)) map[t].U.push(r);
      if (del.test(s)) map[t].D.push(r);
      if (read.test(s.replace(new RegExp('DELETE\\s+FROM\\s+' + t + '\\b', 'gi'), ''))) map[t].R.push(r);
    }
    // Stale references: an upper-case SQL keyword followed by a name that is not a table (upper case only, so ordinary prose is not mistaken for SQL).
    for (const m of s.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)\b/g)) {
      const n = m[1]; if (tables.includes(n) || NOT_TABLES.has(n)) continue;
      (unknown[n] = unknown[n] || new Set()).add(r);
    }
  }
  for (const t of tables) for (const k of 'CRUD') map[t][k].sort();
  return { tables: map, unknown: Object.fromEntries(Object.entries(unknown).map(([k, v]) => [k, [...v].sort()])) };
}

function generate() { const tables = tableNames(), { tables: map, unknown } = scan(tables); return { map: { tables: map }, unknown, tables }; }

const COMMITTED = path.join(CODE, 'data', 'data_map.json');

function matrix(map) {
  const names = Object.keys(map.tables), files = [...new Set(names.flatMap(t => 'CRUD'.split('').flatMap(k => map.tables[t][k])))].sort();
  const cell = (t, f) => 'CRUD'.split('').map(k => map.tables[t][k].includes(f) ? k : '·').join('');
  const lines = ['file'.padEnd(26) + names.map(n => n.slice(0, 11).padEnd(12)).join('')];
  for (const f of files) lines.push(f.padEnd(26) + names.map(n => cell(n, f).padEnd(12)).join(''));
  return lines.join('\n') + '\n\nC insert   R read   U update   D delete   (· none)';
}

if (require.main === module) {
  const arg = process.argv[2], { map, unknown } = generate(), text = JSON.stringify(map, null, 1) + '\n';
  if (arg === '--write') { fs.mkdirSync(path.dirname(COMMITTED), { recursive: true }); fs.writeFileSync(COMMITTED, text); console.log('Wrote ' + path.relative(process.cwd(), COMMITTED)); }
  else if (arg === '--check') {
    const have = fs.existsSync(COMMITTED) ? fs.readFileSync(COMMITTED, 'utf8') : '';
    if (have !== text) { console.error('The data map is out of date. Review the change, then run: node code/data_map.js --write'); process.exit(1); }
    console.log('Data map is current.');
  } else console.log(matrix(map));
  if (Object.keys(unknown).length) console.error('\nNames used in SQL that are not tables: ' + JSON.stringify(unknown));
}

module.exports = { generate, matrix, tableNames, scan, WHY_ONE_SIDED, COMMITTED };
