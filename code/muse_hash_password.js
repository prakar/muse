#!/usr/bin/env node
'use strict';
// OPTIONAL hardened login. Not used by default: the active login is a plain password set with  node code/muse_set_password.js
// Make the login hash for Muse's Admin page and writes.   node code/muse_hash_password.js
// Prints one line to put in the server's .env (chmod 600):   MUSE_ADMIN_PASSWORD_HASH=scrypt:...
// To switch the hashed login on: add that line AND remove MUSE_ADMIN_PASSWORD from the .env, then restart Muse (the hash wins if both are set).
// The password is typed (hidden) or piped in; it is never printed or stored, only its scrypt hash. See lib/muse_access.js for the reasoning.
const readline = require('readline'), { hashPassword } = require('./lib/muse_access');
function ask(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { let b = ''; process.stdin.on('data', d => b += d); process.stdin.on('end', () => resolve(b.replace(/\r?\n$/, ''))); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt) || /[\r\n]/.test(s)) rl.output.write(s); };      // hide what is typed
    rl.question(prompt, a => { rl.close(); resolve(a); });
  });
}
(async () => {
  const a = await ask('Choose a password for Muse (hidden): ');
  if (process.stdin.isTTY) { const b = await ask('Type it again: '); if (a !== b) { console.error('\nThey differ. Nothing made.'); process.exit(1); } }
  if (a.length < 12) { console.error('\nUse at least 12 characters (a few random words is fine).'); process.exit(1); }
  console.log('\nAdd this line to the server .env, remove the MUSE_ADMIN_PASSWORD line if there is one, then restart Muse. Login name: MUSE_ADMIN_USER (default "admin").\n');
  console.log('MUSE_ADMIN_PASSWORD_HASH=' + hashPassword(a));
})();
