#!/usr/bin/env node
'use strict';
// Start a profile (pack) for a field: copies the neutral one (packs/general) to packs/<name> and renames it. Refuses to overwrite.
//   npm run pack:new -- lawyer
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]{1,29}$/.test(name)) { console.error('Usage: npm run pack:new -- <name>   (lowercase letters, digits and hyphens, 2 to 30 characters, e.g. lawyer)'); process.exit(2); }
const from = path.join(ROOT, 'packs', 'general'), to = path.join(ROOT, 'packs', name);
if (!fs.existsSync(path.join(from, 'pack.json'))) { console.error('The neutral profile packs/general is missing, so there is nothing to copy.'); process.exit(1); }
if (fs.existsSync(to)) { console.error('packs/' + name + ' already exists. Nothing was changed.'); process.exit(1); }
fs.mkdirSync(to, { recursive: true });
fs.readdirSync(from).forEach((f) => { const t = fs.readFileSync(path.join(from, f), 'utf8'); fs.writeFileSync(path.join(to, f), f === 'pack.json' ? JSON.stringify(Object.assign(JSON.parse(t.split('packs/general/').join('packs/' + name + '/')), {}), null, 2) + '\n' : t); });
const file = path.join(to, 'pack.json'), p = JSON.parse(fs.readFileSync(file, 'utf8'));
p.name = name; p.version = '0.1.0'; p.description = 'TODO: one sentence on who this is for and what it surfaces.'; p.extraction.promptVersion = name + '-v1';
fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n');
console.log('Created packs/' + name + ' from the neutral profile. Next:\n  1. Edit packs/' + name + '/pack.json: description, kinds, hook types, categories.\n  2. Edit lenses.json and shapes.json for the patterns of your field.\n  3. npm run pack:check -- ' + name + '\n  4. Set  pack: ' + name + '  in muse.yaml and restart.\nThe guide is PACKS.md.');
