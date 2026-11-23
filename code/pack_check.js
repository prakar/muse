#!/usr/bin/env node
'use strict';
// Check a profile (pack) folder: loads it the way Muse does at start-up and prints what it finds. Exit 1 when it would not load.
//   npm run pack:check -- lawyer
const Pack = require('./lib/pack');
const name = process.argv[2];
if (!name) { console.error('Usage: npm run pack:check -- <name>'); process.exit(2); }
let p;
try { p = Pack.loadPack(name); } catch (e) { console.error('✗ ' + (e.message || e)); process.exit(1); }
const x = p.extraction, warn = [];
if (/^TODO/.test(p.description)) warn.push('description is still the TODO text');
if (p.name !== 'general' && /^gen-v/.test(x.promptVersion)) warn.push('promptVersion ' + x.promptVersion + ' is the neutral profile\'s: facts extracted under it would be mixed with its own; give yours its own, e.g. ' + name + '-v1');
if (!p.lens) warn.push('no lenses: the Angles screen will be hidden');
if (!p.vocabulary || !p.vocabulary.purpose) warn.push('no purpose line in vocabulary.json: Help uses the neutral wording');
console.log('✓ ' + p.name + ' (contract ' + Pack.CONTRACT + ', version ' + p.version + ') loads.');
console.log('  kinds: ' + x.kinds.join(', ') + '\n  hook types: ' + x.hooks.strict.concat(x.hooks.loose).join(', ') + '\n  capabilities: ' + (p.capabilities.join(', ') || 'none') + '\n  lenses: ' + (p.lens ? 'yes' : 'none'));
warn.forEach((w) => console.log('  ! ' + w));
