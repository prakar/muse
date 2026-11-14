'use strict';
// muse integrity: read-only check that the database matches the code. Exit 0 ok/warn, 2 fatal, 3 no database yet.
const path = require('path'), os = require('os');
const I = require('./lib/integrity');
const HOME = process.env.QUARRY_HOME || path.join(__dirname, '..'), DB = process.env.QUARRY_DB || path.join(HOME, 'vault.db');
const roots = [process.env.MUSE_VAULT_ROOT || path.join(os.homedir(), 'md-vaults', 'knowledge'), process.env.VAULT_PATH];
const r = I.check({ dbPath: DB, vaultRoots: roots, deep: true });
if (process.argv.includes('--json')) console.log(JSON.stringify(r)); else {
  console.log('Integrity check of ' + DB + ' (' + r.ms + ' ms): ' + (r.state === 'setup' ? 'NO DATABASE YET' : r.level.toUpperCase()));
  for (const l of I.lines(r)) console.log(l);
}
process.exit(r.state === 'setup' ? 3 : r.level === 'fatal' ? 2 : 0);
