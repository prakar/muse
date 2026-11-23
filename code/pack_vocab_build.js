'use strict';
// Rewrites code/muse_ui/js/pack_vocab.mjs from the default pack's vocabulary. Run after changing a pack's vocabulary.json; a test fails if it is stale.
const fs = require('fs'), path = require('path');
const Pack = require('./lib/pack'), V = require('./lib/pack_vocab');
const file = path.join(__dirname, 'muse_ui', 'js', 'pack_vocab.mjs');
fs.writeFileSync(file, V.moduleText(Pack.loadPack(Pack.DEFAULT_PACK).vocabulary));
console.log('wrote ' + path.relative(process.cwd(), file));
