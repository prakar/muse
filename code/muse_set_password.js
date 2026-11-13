#!/usr/bin/env node
'use strict';
// Set the Muse login password.   node code/muse_set_password.js [--user name] [--file path/to/.env]
// Asks for the password (typed hidden, twice) and saves it as plain text on one line of the server's .env:  MUSE_ADMIN_PASSWORD=...
// The .env sits beside vault.db (QUARRY_HOME), is git-ignored (.env*), and is made readable by its owner only (chmod 600). Other lines are kept as they are.
// Why plain text, and why a file and not vault.db: see the note at the top of lib/muse_access.js. In short, this guards the author's marks and a few
// maintenance jobs, not personal data; and vault.db is opened read-only by Muse and replaced whenever a fresh copy is made on the Mac, so a password kept
// there would be lost at the next copy and would travel into every backup. For the hashed version, use  node code/muse_hash_password.js  instead.
// Then restart Muse (on the homelab: systemctl --user restart muse).
const fs = require('fs'), path = require('path'), readline = require('readline');

// Systemd's EnvironmentFile treats quotes and backslashes specially, so the password may not contain them.
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters.';
  if (/["'\\\r\n]/.test(pw)) return 'Leave out quotes, backslashes and line breaks (the service file reader treats them specially).';
  if (pw !== pw.trim()) return 'No spaces at the start or end.';
  return null;
}
// Replace the KEY= line if there is one, else append it. Everything else in the file is left untouched.
function upsertEnv(text, key, value) {
  const line = key + '=' + value, lines = String(text || '').split('\n'), re = new RegExp('^\\s*' + key + '\\s*=');
  let done = false;
  const out = lines.map(l => { if (re.test(l)) { if (done) return null; done = true; return line; } return l; }).filter(l => l !== null);
  if (!done) { while (out.length && out[out.length - 1] === '') out.pop(); out.push(line); }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
function ask(prompt) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) { let b = ''; process.stdin.on('data', d => b += d); process.stdin.on('end', () => resolve(b.replace(/\r?\n$/, ''))); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = s => { if (s.includes(prompt) || /[\r\n]/.test(s)) rl.output.write(s); };      // hide what is typed
    rl.question(prompt, a => { rl.close(); resolve(a); });
  });
}
async function main() {
  const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const file = path.resolve(opt('--file') || path.join(process.env.QUARRY_HOME || path.join(__dirname, '..'), '.env')), user = opt('--user');
  if (user && !/^[A-Za-z0-9._-]+$/.test(user)) { console.error('Login name: letters, digits . _ - only.'); process.exit(2); }
  const a = await ask('New Muse password (hidden): ');
  if (process.stdin.isTTY) { const b = await ask('Type it again: '); if (a !== b) { console.error('\nThey differ. Nothing saved.'); process.exit(1); } }
  const bad = checkPassword(a); if (bad) { console.error('\n' + bad + ' Nothing saved.'); process.exit(1); }
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch (e) { /* a new file */ }
  text = upsertEnv(text, 'MUSE_ADMIN_PASSWORD', a); if (user) text = upsertEnv(text, 'MUSE_ADMIN_USER', user);
  fs.writeFileSync(file, text, { mode: 0o600 }); fs.chmodSync(file, 0o600);
  console.log('\nSaved to ' + file + ' (owner-only). Login name: ' + (user || 'admin (the default, or MUSE_ADMIN_USER if already set)') + '.');
  console.log('Restart Muse to use it. If MUSE_ADMIN_PASSWORD_HASH is also set, the hash wins: remove it.');
}
if (require.main === module) main();
module.exports = { checkPassword, upsertEnv };
