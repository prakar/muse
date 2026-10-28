'use strict';
/**
 * Builds or checks the heuristic registry (checklist H1).
 *   node --no-warnings code/heuristics_build.js            write code/data/heuristics.json and the readable table
 *   node --no-warnings code/heuristics_build.js --check    exit 1 if the committed registry differs from its sources
 * Sources (read-only): the vault notes QUARRY - Heuristics Commons and QUARRY - Heuristics Illustrations.
 * Directory: $QUARRY_VAULT_NOTES or the default below.
 */
const fs = require('fs'), path = require('path');
const H = require('./lib/heuristics');

const NOTES = process.env.QUARRY_VAULT_NOTES || '/Users/prakar/md-vaults/tech-journalling/worklog/2026';
const DATA = path.join(__dirname, 'data');

function sources() {
  const rd = f => fs.readFileSync(path.join(NOTES, f), 'utf8');
  return { commons: rd('QUARRY - Heuristics Commons.md'), illustrations: rd('QUARRY - Heuristics Illustrations.md'),
    overlay: JSON.parse(fs.readFileSync(path.join(DATA, 'heuristic_overlay.json'), 'utf8')) };
}

function main() {
  const check = process.argv.includes('--check');
  let s;
  try { s = sources(); } catch (e) { console.error('Cannot read the sources (' + e.message + '). Set QUARRY_VAULT_NOTES to the folder holding the QUARRY notes.'); process.exit(2); }
  const reg = H.build(s.commons, s.illustrations, s.overlay), bad = H.validate(reg, s.overlay);
  if (bad.length) { console.error('Registry invalid:\n- ' + bad.join('\n- ')); process.exit(1); }
  const text = JSON.stringify(reg, null, 2) + '\n', file = path.join(DATA, 'heuristics.json');
  if (check) {
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (have !== text) { console.error('code/data/heuristics.json is out of date with its sources. Run: node --no-warnings code/heuristics_build.js'); process.exit(1); }
    console.log('registry in sync: ' + reg.rows.length + ' heuristics'); return;
  }
  fs.writeFileSync(file, text);
  const out = path.join(__dirname, 'lab', 'out'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'heuristics_table.md'), H.toTable(reg) + '\n');
  console.log('wrote ' + file + ' (' + reg.rows.length + ' heuristics)');
  console.log(JSON.stringify(H.summarise(reg)));
}
if (require.main === module) main();
module.exports = { sources, NOTES };
