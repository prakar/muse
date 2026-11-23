'use strict';
// Drift audit for Muse: compares the map (code/muse_ui/js/muse_map.mjs) with what the code really has, and with Help.
// Run: node code/muse_map_check.js   (exit code 1 when anything has drifted). The tests run the same check.
const fs = require('fs'), path = require('path'), { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..'), UI_DEFAULT = path.join(ROOT, 'code', 'muse_ui', 'js');
const read = p => fs.readFileSync(p, 'utf8'), uniq = a => [...new Set(a)];
const walk = dir => fs.readdirSync(dir, { recursive: true }).filter(f => /\.mjs$/.test(f)).map(f => path.join(dir, f));

// check()                 audits the screens as they are on disk (the default profile's words)
// check({ pack: 'name' })  audits them with that profile's words: a copy of the UI is made in a temp folder with that profile's vocabulary module
async function check(opts) {
  let UI = UI_DEFAULT, tmp = null, hidden = new Set();
  if (opts && opts.pack) {
    const Pack = require('./lib/pack'), V = require('./lib/pack_vocab'), os = require('os');
    const loaded = Pack.loadPack(opts.pack, opts.root), vocab = loaded.vocabulary;
    // Buttons a capability owns exist in the screen code but are hidden for a pack that lacks it: not drift.
    if (!loaded.capabilities.includes('wordplay')) JSON.parse(fs.readFileSync(path.join(ROOT, 'code', 'data', 'capability_wordplay.json'), 'utf8')).features.forEach(x => (x['buttons+'] || []).forEach(b => hidden.add(b)));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-map-')); fs.cpSync(UI_DEFAULT, path.join(tmp, 'js'), { recursive: true }); UI = path.join(tmp, 'js');
    fs.writeFileSync(path.join(UI, 'pack_vocab.mjs'), V.moduleText(vocab));
  }
  try { return await checkIn(UI, hidden); } finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function checkIn(UI, hidden) {
  hidden = hidden || new Set();
  const problems = [], bad = (kind, msg) => problems.push({ kind, msg });
  const M = await import(pathToFileURL(path.join(UI, 'muse_map.mjs')).href), H = await import(pathToFileURL(path.join(UI, 'help_content.mjs')).href);
  const { FEATURES, DATA, BUDGET } = M, recipeKeys = H.RECIPES.map(r => r.key);

  // What the code has
  const shape = /const SHAPE = \{([^}]*)\}/.exec(read(path.join(UI, 'router.mjs')));
  const routes = shape ? [...shape[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]) : [];
  const apis = uniq([...read(path.join(ROOT, 'code', 'lib', 'muse_server.js')).matchAll(/pathname === '(\/api\/[a-z/]+)'/g)].map(m => m[1]));
  const uiFiles = walk(UI).filter(f => !/muse_map\.mjs$|help_content\.mjs$|views[\\/]help\.mjs$/.test(f)), ui = uiFiles.map(read).join('\n'), uiButtons = uiFiles.filter(f => !/crumbs\.mjs$/.test(f)).map(read).join('\n');   // breadcrumb labels are not buttons
  // Button labels in the UI source: plain 'text', or built from the vocabulary (W.focus, W.star + ' this pair', cond ? W.collected : W.collect).
  const Wd = (await import(pathToFileURL(path.join(UI, 'words.mjs')).href)).W, piece = /^('[^']*'|W\.\w+)(\s*\+\s*('[^']*'|W\.\w+))*$/;
  const evalPiece = p => [...p.matchAll(/'([^']*)'|W\.(\w+)/g)].map(m => m[1] !== undefined ? m[1] : Wd[m[2]]).join('');
  const labels = uniq([...uiButtons.matchAll(/\blabel: ((?:[^,}()]|\([^)]*\))+)/g)].flatMap(m => m[1].split(/\s+\?\s+|\s+:\s+/).map(x => x.trim()).filter(x => piece.test(x)).map(evalPiece)).filter(Boolean));
  const srcFiles = [path.join(ROOT, 'code', 'muse_app.js'), path.join(ROOT, 'code', 'search_build.js')].concat(fs.readdirSync(path.join(ROOT, 'code', 'lib')).filter(f => /\.js$/.test(f)).map(f => path.join(ROOT, 'code', 'lib', f)));
  const src = srcFiles.filter(fs.existsSync).map(read).join('\n');
  const files = uniq([...src.matchAll(/\b(muse-[a-z]+\.(?:jsonl|json|db)|search-vectors-)/g)].map(m => m[1]));

  // Map integrity
  const keys = FEATURES.map(f => f.key), dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  dup.forEach(k => bad('map', `feature key used twice: ${k}`));
  FEATURES.forEach(f => { if (f.parent && !keys.includes(f.parent)) bad('map', `${f.key}: parent “${f.parent}” is not a feature`); });
  const claim = (list, what) => { const seen = {}; FEATURES.forEach(f => (f[list] || []).forEach(v => { (seen[v] = seen[v] || []).push(f.key); })); return seen; };
  const byRoute = FEATURES.filter(f => f.route).map(f => f.route), byApi = claim('api'), byBtn = claim('buttons'), byData = claim('data'), byRec = claim('recipes');

  // Code → map: everything real must be in the map
  routes.filter(r => !byRoute.includes(r)).forEach(r => bad('unmapped route', `#/${r} exists in router.mjs but no feature claims it`));
  apis.filter(a => !byApi[a]).forEach(a => bad('unmapped api', `${a} is served but no feature claims it`));
  labels.filter(l => !byBtn[l] && !hidden.has(l)).forEach(l => bad('unmapped button', `a button labelled “${l}” exists in the UI but no feature lists it`));
  files.filter(f => !DATA.some(d => d.file && f.startsWith(d.file.replace(/\*.*/, '')) || d.file === f)).forEach(f => bad('unmapped file', `${f} is written or read in code but not in DATA`));

  // Map → code: everything in the map must be real
  FEATURES.filter(f => f.route && !routes.includes(f.route)).forEach(f => bad('stale route', `${f.key}: route “${f.route}” is not in router.mjs`));
  Object.keys(byApi).filter(a => !apis.includes(a)).forEach(a => bad('stale api', `${byApi[a].join(', ')}: ${a} is not served any more`));
  Object.keys(byApi).filter(a => byApi[a].length > 1).forEach(a => bad('map', `${a} is claimed by ${byApi[a].join(' and ')}`));
  Object.keys(byBtn).filter(b => !labels.includes(b) && !ui.replace(/export const W = \{[^}]*\};/, '').includes(`'${b}'`) && !ui.includes(JSON.stringify(b))).forEach(b => bad('stale button', `${byBtn[b].join(', ')}: no button “${b}” found in the UI source`));
  Object.keys(byBtn).filter(b => byBtn[b].length > 1).forEach(b => bad('map', `button “${b}” is listed by ${byBtn[b].join(' and ')}`));
  DATA.filter(d => d.file && !files.some(f => f === d.file || f.startsWith(d.file))).forEach(d => bad('stale file', `${d.id}: ${d.file} is not mentioned in the code any more`));
  Object.keys(byData).filter(d => !DATA.some(x => x.id === d)).forEach(d => bad('map', `${byData[d].join(', ')}: data “${d}” is not in DATA`));
  DATA.filter(d => !byData[d.id]).forEach(d => bad('map', `DATA “${d.id}” is not used by any feature`));

  // Help: every feature taught, every recipe reachable
  FEATURES.forEach(f => { if (!f.noHelp && !(f.recipes || []).length) bad('no help', `${f.key} (“${f.title}”) has no recipe and no noHelp reason`); });
  Object.keys(byRec).filter(r => !recipeKeys.includes(r)).forEach(r => bad('help', `${byRec[r].join(', ')}: recipe “${r}” does not exist`));
  recipeKeys.filter(r => !byRec[r]).forEach(r => bad('orphan recipe', `recipe “${r}” is not linked from any feature, so the contents list never shows it`));

  // Bloat: warn at 80% of each limit, fail above it, and name the smallest features as the first candidates to merge or drop.
  const warnings = [], use = {
    features: [FEATURES.filter(f => !f.legacy).length, 'features'], dataFiles: [DATA.length, 'data entries'], recipes: [recipeKeys.length, 'recipes'], noHelp: [FEATURES.filter(f => f.noHelp).length, 'features marked noHelp'],
    buttonsPerFeature: [Math.max(0, ...FEATURES.map(f => (f.buttons || []).length)), 'buttons in the busiest feature (' + (FEATURES.slice().sort((a, b) => (b.buttons || []).length - (a.buttons || []).length)[0] || {}).key + ')']
  };
  const weight = f => (f.buttons || []).length + (f.api || []).length + (f.data || []).length, leaves = FEATURES.filter(f => !f.legacy && !f.route && !FEATURES.some(g => g.parent === f.key)).sort((a, b) => weight(a) - weight(b)).slice(0, 3);
  Object.entries(BUDGET).forEach(([k, max]) => { const [n, what] = use[k] || [0, k]; if (n > max) bad('bloat', `${n} ${what}, budget is ${max}. Trim first (merge or drop; smallest features: ${leaves.map(f => f.key).join(', ') || 'none'}), or raise BUDGET.${k} in muse_map.mjs and add the reason to \`reasons\`.`); else if (n > max * 0.8) warnings.push({ kind: 'bloat warning', msg: `${n} ${what}, budget is ${max} (over 80%). Think about trimming before adding more.` }); });

  return { problems, warnings, stats: { features: FEATURES.length, routes: routes.length, apis: apis.length, buttons: labels.length, files: files.length, recipes: recipeKeys.length } };
}
module.exports = { check };
if (require.main === module) {
  // node code/muse_map_check.js [--pack NAME | --all]   (no flag: the default profile; --all: every profile installed under packs/)
  const a = process.argv.slice(2), all = a.includes('--all'), one = a.includes('--pack') ? a[a.indexOf('--pack') + 1] : null;
  const names = all ? fs.readdirSync(path.join(ROOT, 'packs')).filter(n => fs.existsSync(path.join(ROOT, 'packs', n, 'pack.json'))).sort() : [one];
  (async () => {
    let bad = 0;
    for (const n of names) {
      const { problems, warnings, stats } = await check(n ? { pack: n } : undefined);
      console.log((n ? '[' + n + '] ' : '') + `Muse map: ${stats.features} features, ${stats.routes} routes, ${stats.apis} server calls, ${stats.buttons} labelled buttons, ${stats.files} data files, ${stats.recipes} recipes.`);
      warnings.forEach(w => console.log(`  ${w.kind.padEnd(16)} ${w.msg}`));
      if (!problems.length) { console.log('No drift.'); continue; }
      problems.forEach(p => console.log(`  ${p.kind.padEnd(16)} ${p.msg}`)); console.log(`${problems.length} problem(s).`); bad += problems.length;
    }
    if (bad) process.exit(1);
  })().catch(e => { console.error(e); process.exit(2); });
}
