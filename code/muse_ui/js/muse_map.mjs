// The Muse map: one row per feature, saying where it lives (screen), what you press, which server calls it makes, which files it writes, and which Help recipes teach it.
// Help's contents list and its "Where things are saved" table are generated from this file, and `node code/muse_map_check.js` (also run by the tests) compares it
// with the real code and reports drift: a screen, button, server call or file the map does not know, or a map entry the code no longer has.
// To add a feature: add a row here, add its recipe in help_content.mjs, run the check.
//   route: a name from SHAPE in router.mjs   buttons: labels as shown   api: /api paths   data: ids from DATA below   recipes: keys from RECIPES
//   legacy: true keeps a row out of the contents list (code that still exists but is not the Muse app)
//   parent: the feature this sits under (the contents list is built from it)   noHelp: a reason, only for things Help should not teach

// The budget keeps the map (and so Help) from growing without limit. The checker WARNS above 80% of a limit and FAILS above the limit, in every
// `muse check`, `muse drift` and pre-commit run. When it fails, trim first: merge a small feature into its parent, retire a recipe, drop a data file.
// Raising a number is allowed, but it is a visible one-line change in this file: put the reason in `reasons` so the next admin sees why.
import { W, SHELF_NAME } from './words.mjs';
import PACK from './pack_vocab.mjs';
import { overlay } from './overlay.mjs';

export const BUDGET = { features: 16, dataFiles: 10, buttonsPerFeature: 22, recipes: 18, noHelp: 3 };
export const reasons = [{ date: '2026-10-30', limit: 'recipes', to: 18, why: 'Added the Focus recipe; Help is the cookbook, so it is the one list allowed to grow' }];

export const DATA = [
  { id: 'marks', file: 'muse-marks.jsonl', what: `${W.starred} (${W.star})`, where: 'muse-marks.jsonl, beside vault.db', notes: 'Permanent. Your judgements: starred, dull, wrong sense.' },
  { id: 'tray', file: 'muse-tray.json', what: `${W.collection} and link lines`, where: 'muse-tray.json', notes: 'Autosaved. Survives refresh, restart, another browser or port.' },
  { id: 'recent', file: null, what: W.recentFocus, where: 'This browser only', notes: 'A convenience. Lost if you clear the browser’s site data or change the address.' },
  { id: 'events', file: 'muse-events.jsonl', what: `Where you ${W.focus.toLowerCase()}ed or ${W.collect.toLowerCase()}ed from`, where: 'muse-events.jsonl', notes: 'A plain log: when, which fact, which route. No search text.' },
  { id: 'cache', file: 'muse-cache.db', what: 'Search rewrites and question vectors', where: 'muse-cache.db', notes: 'So a repeated question costs nothing. Stores the questions you typed. Safe to delete.' },
  { id: 'vectors', file: 'search-vectors-', what: 'Meaning index', where: 'search-vectors-*.f32 and .json', notes: 'Rebuilt with: node --no-warnings code/search_build.js. Safe to delete.' },
  { id: 'labels', file: 'muse-judgements.jsonl', what: 'Your earlier labels (old scratch viewer)', where: 'muse-judgements.jsonl, in QUARRY_HOME', notes: 'Written by the old viewer (code/muse_view.js), not by Muse. The lab scripts use it as ground truth. Keep it.' },
  { id: 'dipaka', file: 'muse-dipaka.jsonl', what: `${W.dipaka} answers and your labels`, where: 'muse-dipaka.jsonl, beside vault.db', notes: 'Permanent. The answers are the model\u2019s, unverified learning material: they never enter your notes or the fact store.' },
  { id: 'notes', file: null, what: 'Your notes', where: 'Never changed', notes: 'Muse reads them and never writes to them. Private notes are never shown.' }
];

// Features a pack adds (Angles) or rewords (the Collection's blurb) come from the pack: same key patches, a new key is inserted after its `after`.
const CORE_FEATURES = [
  { key: 'home', title: W.home, route: 'home', blurb: 'Two blocks that stay put: Facts (narrow by how well connected and what connects; All shelves and All kinds zoom back out) and Results (shuffled by default, or ordered by a lens, with Starred only). The results below follow the one you touched last.', api: ['/api/meta', '/api/suggest', '/api/connect', '/api/shelf', '/api/wordplay'], buttons: ['Go', SHELF_NAME.veins, SHELF_NAME.grip, SHELF_NAME.lone, SHELF_NAME.all, 'All kinds', 'Any chosen', 'Every chosen', 'Starred only', 'Shuffle', 'Re-roll', 'Start over'], data: ['notes'], recipes: ['know', 'vein', 'lone', 'handle'] },
  { key: 'sets', title: 'A set of facts', parent: 'home', route: 'set', blurb: 'The facts that share one handle, on one page, in the order you choose.', buttons: ['Open set', 'Show the handle', 'Reveal last', 'How many facts', 'Order', 'Hard to easy', 'Easy to hard', 'As found'], recipes: ['handle', 'test'] },
  { key: 'note', title: 'Reading the full note', parent: 'home', blurb: 'The title of the note above any fact opens the whole note in a side panel.', api: ['/api/note'], buttons: [], recipes: ['know'] },

  { key: 'stick', title: W.stick, route: 'stick', blurb: 'Put one fact in focus and see what clings to it.', api: ['/api/stick'], buttons: [W.focus, 'Surprise me', 'Another fact', 'Try again', W.home], recipes: ['focus', 'resume'] },
  { key: 'admin', title: W.admin, route: 'admin', blurb: 'The maintenance tasks, in two modes: Initial setup (a vault and no database yet: do these once, in order) and Ongoing maintenance (bring new notes in, process them, restart Muse, then the less frequent tasks). Each task is checked first and runs as a job you can watch, above the reports on the state of the vault, the facts, the money and the saved files. It also says when Muse is behind the database.', api: ['/api/health', '/api/admin/status', '/api/admin/drift', '/api/admin/ops', '/api/admin/jobs', '/api/admin/tags'], buttons: [W.admin, 'Run drift check', 'Admin mode', 'Ongoing maintenance', 'Initial setup', 'Check first', 'Run', 'Do it for real', 'Cancel job', 'View log', 'Tags', 'Accept tag', 'Reject tag', 'Apply decisions', 'Clear decisions'], noHelp: 'admin work is documented in Help, Sys Admin' },
  { key: 'collection', title: W.collection, blurb: 'The working pile of facts, with a line between neighbours for how they link. The button at the top opens it over any page; Collect is on every fact.', api: ['/api/tray', '/api/event'], buttons: [W.collection, W.collect, W.collected, 'Remove', 'Clear', 'Copy cluster', W.illuminate], data: ['tray', 'events', 'recent'], recipes: ['link'] },
  { key: 'dipaka', title: W.dipaka, route: 'dipaka', parent: 'collection', blurb: 'The lamp. Your Collection becomes a packet you can read and edit; one press sends it to the cheapest (economy) model, which tells you related things you did not ask because you did not know enough to ask. Cost shown first, capped per day. The answer is unverified learning material, kept in its own file and labelled by you.', api: ['/api/dipaka', '/api/dipaka/preview', '/api/dipaka/run', '/api/dipaka/label', '/api/dipaka/delete'], buttons: ['Reset packet', 'Copy answer', 'Delete', 'Yielded', 'Generic', 'Already knew', 'Wrong or loaded'], data: ['dipaka'], recipes: ['dipaka'] },

  { key: 'search', title: 'Search', route: 'search', blurb: 'Ask a question or type words. Says how close the best match is, and says plainly when nothing is.', api: ['/api/search', '/api/search/status'], buttons: ['Search'], data: ['cache', 'vectors'], recipes: ['ask', 'words'] },

  { key: 'basket', title: W.starred, route: 'basket', blurb: 'Everything you starred, with the set it was found in.', api: ['/api/kept'], buttons: [W.starred, 'Undo', 'Show dull', 'Copy as text', 'Copy all as text'], data: ['marks'], recipes: ['junk'] },
  { key: 'marks', title: `${W.star}, Dull, Wrong sense`, parent: 'basket', blurb: 'Judge a fact or a pair: star it for good, or push it out of the way.', api: ['/api/mark'], buttons: [W.star, W.star + ' this pair', W.star + ' this handle', 'Dull', 'Wrong sense'], recipes: ['junk'] },

  { key: 'scratch', title: 'Old scratch viewer', legacy: true, blurb: 'The first viewer (npm run muse). Still the only thing that writes your earlier labels.', data: ['labels'], noHelp: 'legacy tool, not part of the Muse app' },
  { key: 'help', title: 'Help', route: 'help', blurb: 'This page: the three similar buttons, recipes, keys, where things are saved, and what is coming.', buttons: ['Help'], noHelp: 'this is the help page' }
];
export const FEATURES = overlay(CORE_FEATURES, PACK.features);
