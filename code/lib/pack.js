'use strict';
// The assembler. muse.yaml names the pack; the pack folder (packs/<name>/pack.json) carries everything that gives Muse its character: how facts are
// extracted, which hook types join them, which shapes are looked for, the words on screen. Core code never names a profession; it asks the pack.
//
// Contract version 1 has three implemented seams: `extraction`, `lenses` (optional: a pack with none finds no shapes) and `vocabulary` (optional: the words on screen; core has neutral defaults). Tagging is listed under `files` and will be wired in later.
// Everything here is pure except reading the two config files, and every problem is a PackError that says what is wrong and where.
const fs = require('fs');
const path = require('path');
const Lenses = require('./lenses');
const Vocab = require('./pack_vocab');

const ROOT = path.resolve(__dirname, '..', '..');
const CONTRACT = 1;
const DEFAULT_PACK = 'quiz';
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

class PackError extends Error { constructor(msg) { super(msg); this.name = 'PackError'; } }

const isStrList = (a) => Array.isArray(a) && a.length > 0 && a.every((s) => typeof s === 'string' && s.trim() && s === s.trim());
const isStr = (s) => typeof s === 'string' && s.length > 0;
const isNum = (n) => Number.isInteger(n) && n > 0;

// muse.yaml is optional: with none, Muse behaves as it always has (the quiz pack). With one, it must parse and name a pack that exists.
function readConfig(root) {
  root = root || ROOT;
  const file = process.env.MUSE_CONFIG || path.join(root, 'muse.yaml');
  if (!fs.existsSync(file)) return { pack: process.env.MUSE_PACK || DEFAULT_PACK, file: null };
  let YAML;
  try { YAML = require('yaml'); } catch (e) { throw new PackError(file + ' exists but the "yaml" package is not installed. Run: npm install yaml'); }
  let doc;
  try { doc = YAML.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { throw new PackError(file + ' is not valid YAML: ' + e.message); }
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new PackError(file + ' must be a mapping (pack: quiz)');
  const name = process.env.MUSE_PACK || doc.pack || DEFAULT_PACK;
  return Object.assign({}, doc, { pack: name, file });
}

function validateExtraction(ex, where) {
  const bad = (m) => { throw new PackError(where + ': extraction ' + m); };
  if (!ex || typeof ex !== 'object') bad('is missing');
  for (const k of ['promptVersion', 'schemaVersion', 'audience', 'claimReader', 'kindNotes', 'categoryExample']) if (!isStr(ex[k])) bad(k + ' must be a non-empty string');
  if (typeof ex.skipRule !== 'string') bad('skipRule must be a string (use "" for none)');
  if (!isStrList(ex.kinds) || !ex.kinds.includes('fact')) bad('kinds must be a list that includes "fact" (the default kind)');
  const h = ex.hooks;
  if (!h || !isStrList(h.strict) || !Array.isArray(h.loose) || !h.loose.every(isStr) || !Array.isArray(h.categorised) || !h.categorised.every(isStr)) bad('hooks needs strict (list), loose (list) and categorised (list)');
  const all = h.strict.concat(h.loose);
  if (new Set(all).size !== all.length) bad('a hook type is listed twice across strict and loose');
  if (h.categorised.some((t) => !all.includes(t))) bad('hooks.categorised names a type that is not declared');
  if (!isStrList(ex.categories) || !ex.categories.includes('other')) bad('categories must be a list that includes "other"');
  const c = ex.caps;
  if (!c || !isNum(c.base) || !isNum(c.long) || !isNum(c.xl) || !isNum(c.longChars) || !isNum(c.xlChars)) bad('caps needs whole numbers base, long, xl, longChars, xlChars');
  if (!(c.base <= c.long && c.long <= c.xl && c.longChars < c.xlChars)) bad('caps must satisfy base <= long <= xl and longChars < xlChars');
  if (!ex.example || !isStr(ex.example.note) || !isStr(ex.example.reply)) bad('example needs note and reply');
  try { JSON.parse(ex.example.reply); } catch (e) { bad('example.reply must be valid JSON'); }
}

// Which hook types play which part in the model's checks. Optional in pack.json as "hookRoles":
//   deadEnd - types that link nothing when seen in only one note (default: the loose hooks)
//   common  - types that are often an ordinary word (default: none)
//   surface - types whose shared wording can hide different meanings (default: the categorised hooks)
function readHookRoles(p, file) {
  const x = p.hookRoles == null ? {} : p.hookRoles, h = p.extraction.hooks, out = {};
  if (typeof x !== 'object' || Array.isArray(x)) throw new PackError(file + ': hookRoles must be an object');
  const all = new Set(h.strict.concat(h.loose, ['title']));
  const def = { deadEnd: h.loose, common: [], surface: h.categorised };
  for (const k of Object.keys(x)) if (!(k in def)) throw new PackError(file + ': hookRoles.' + k + ' is not a role (deadEnd, common, surface)');
  for (const k of Object.keys(def)) {
    const v = x[k] == null ? def[k] : x[k];
    if (!isStrList(v) && v.length) throw new PackError(file + ': hookRoles.' + k + ' must be a list of hook types');
    for (const t of v) if (!all.has(t)) throw new PackError(file + ': hookRoles.' + k + ' names "' + t + '", which is not one of this pack\'s hook types');
    out[k] = Object.freeze(v.slice());
  }
  return Object.freeze(out);
}
function loadPack(name, root) {
  root = root || ROOT;
  if (!SLUG.test(String(name))) throw new PackError('pack name "' + name + '" is not a plain folder name (letters, digits, hyphens)');
  const dir = path.join(root, 'packs', name), file = path.join(dir, 'pack.json');
  if (!fs.existsSync(file)) throw new PackError('pack "' + name + '" not found: expected ' + file);
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new PackError(file + ' is not valid JSON: ' + e.message); }
  if (p.name !== name) throw new PackError(file + ': "name" is "' + p.name + '" but the folder is "' + name + '"');
  if (p.contract !== CONTRACT) throw new PackError(file + ': contract is ' + p.contract + ', this Muse speaks contract ' + CONTRACT);
  if (!isStr(p.description)) throw new PackError(file + ': description is required (one sentence a stranger can read)');
  if (p.capabilities != null && !(Array.isArray(p.capabilities) && p.capabilities.every(isStr))) throw new PackError(file + ': capabilities must be a list of names');
  validateExtraction(p.extraction, file);
  const files = {};
  for (const [k, rel] of Object.entries(p.files || {})) {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new PackError(file + ': files.' + k + ' points outside the project');
    if (!fs.existsSync(abs)) throw new PackError(file + ': files.' + k + ' names ' + rel + ', which does not exist');
    files[k] = abs;
  }
  const hookRoles = readHookRoles(p, file);
  let lens = null;
  if (p.lenses != null) {
    if (!p.lenses || !isStr(p.lenses.config) || !isStr(p.lenses.registry)) throw new PackError(file + ': lenses needs config and registry (project-relative file paths)');
    const rd = (rel, what) => {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) throw new PackError(file + ': lenses.' + what + ' points outside the project');
      try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new PackError(file + ': lenses.' + what + ' (' + rel + ') cannot be read as JSON: ' + e.message); }
    };
    const reg = rd(p.lenses.registry, 'registry'), cfg = rd(p.lenses.config, 'config');
    try { lens = Lenses.compile(cfg, Array.isArray(reg.rows) ? reg.rows : []); } catch (e) { throw new PackError(file + ': ' + e.message); }
  }
  let vocabulary = {};
  if (p.vocabulary != null) {
    if (!isStr(p.vocabulary)) throw new PackError(file + ': vocabulary must be a project-relative file path');
    const abs = path.resolve(root, p.vocabulary);
    if (!abs.startsWith(root + path.sep)) throw new PackError(file + ': vocabulary points outside the project');
    try { vocabulary = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new PackError(file + ': vocabulary (' + p.vocabulary + ') cannot be read as JSON: ' + e.message); }
    Vocab.validate(vocabulary, file);
  }
  if ((p.capabilities || []).includes('wordplay')) vocabulary = Vocab.withCapability('wordplay', vocabulary);
  if (p.lenses != null) vocabulary = Vocab.withCapability('lenses', vocabulary);   // any pack with shapes gets the neutral Angles screens; its own words win
  let dipaka = null;
  if (p.dipaka != null) {
    if (!isStr(p.dipaka)) throw new PackError(file + ': dipaka must be a project-relative file path');
    const abs = path.resolve(root, p.dipaka);
    if (!abs.startsWith(root + path.sep)) throw new PackError(file + ': dipaka points outside the project');
    try { dipaka = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new PackError(file + ': dipaka (' + p.dipaka + ') cannot be read as JSON: ' + e.message); }
    if (!dipaka || !['promptVersion', 'intro', 'question'].every((k) => isStr(dipaka[k]))) throw new PackError(file + ': dipaka needs promptVersion, intro and question (non-empty strings)');
  }
  return Object.freeze({ dipaka, lens, vocabulary: Object.freeze(vocabulary), name: p.name, version: p.version || '0.0.0', description: p.description, capabilities: Object.freeze((p.capabilities || []).slice()), extraction: p.extraction, hookRoles, files: Object.freeze(files), dir });
}

let cached = null;
// The active pack, loaded once. Tests pass {root, name, fresh:true} to look at another.
function current(opts) {
  opts = opts || {};
  if (cached && !opts.fresh && !opts.root && !opts.name) return cached;
  const root = opts.root || ROOT;
  const pack = loadPack(opts.name || readConfig(root).pack, root);
  if (!opts.root && !opts.name) cached = pack;
  return pack;
}
const extraction = (opts) => current(opts).extraction;
function reset() { cached = null; }

// The occupations Muse suggests (code/data/occupations.json) plus any other profile folder on disk, each marked installed or not, and which one is active.
// Nothing here switches a profile: the active one comes from muse.yaml at start-up.
function catalogue(opts) {
  const o = opts || {}, root = o.root || ROOT, rows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'occupations.json'), 'utf8')).rows;
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(root, 'packs'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, 'packs', e.name, 'pack.json'))).map((e) => e.name).sort(); } catch (e) { /* no packs folder */ }
  let active = o.active; if (active === undefined) { try { active = current().name; } catch (e) { active = null; } }
  const out = rows.map((r) => ({ id: r.id, label: r.label, installed: dirs.includes(r.id), active: r.id === active }));
  dirs.filter((d) => !rows.some((r) => r.id === d)).forEach((d) => out.push({ id: d, label: d, installed: true, active: d === active }));
  return out;
}

// Where the active profile is decided: the MUSE_PACK environment variable (wins), muse.yaml, or the default. For Admin to say what a change will and will not do.
function source(root) {
  if (process.env.MUSE_PACK) return 'env';
  const file = process.env.MUSE_CONFIG || path.join(root || ROOT, 'muse.yaml');
  return fs.existsSync(file) ? 'file' : 'default';
}

// First start with no muse.yaml and no MUSE_PACK: write one naming the default profile, so the choice is on disk where the owner can see and change it.
// Never throws: if it cannot write (no yaml package, read-only folder) Muse still starts on the default and says why. Returns { written, file, pack, note }.
function ensureConfig(opts) {
  const o = opts || {};
  if (source(o.root) !== 'default') return { written: false, file: null, pack: null, note: '' };
  try { const r = setActive(DEFAULT_PACK, o); return { written: true, file: r.file, pack: r.pack, note: 'No muse.yaml was found, so Muse wrote ' + r.file + ' choosing the "' + r.pack + '" profile. Edit it to change profile.' }; }
  catch (e) { return { written: false, file: null, pack: DEFAULT_PACK, note: 'No muse.yaml and it could not be written (' + e.message + '). Muse is using the "' + DEFAULT_PACK + '" profile for now.' }; }
}

// Choose the profile for the NEXT start: writes `pack: <name>` into muse.yaml, keeping the rest of the file (comments too), after checking that the profile loads.
// Nothing running changes: Muse reads its profile once, at start-up. The old file is kept as muse.yaml.bak. Returns what was done.
function setActive(name, opts) {
  const o = opts || {}, root = o.root || ROOT;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{1,29}$/.test(name)) throw new PackError('profile name must be lowercase letters, digits and hyphens');
  if (!fs.existsSync(path.join(root, 'packs', name, 'pack.json'))) throw new PackError('no profile named ' + name + ' is installed (packs/' + name + '/pack.json is missing)');
  loadPack(name, root);   // refuses a profile that would not start
  let YAML; try { YAML = require('yaml'); } catch (e) { throw new PackError('the "yaml" package is not installed. Run: npm install yaml'); }
  const file = o.file || process.env.MUSE_CONFIG || path.join(root, 'muse.yaml'), had = fs.existsSync(file);
  let before = null, text;
  if (had) { before = fs.readFileSync(file, 'utf8'); let doc; try { doc = YAML.parseDocument(before); } catch (e) { throw new PackError(file + ' is not valid YAML, so it was left alone: ' + e.message); } if (doc.errors && doc.errors.length) throw new PackError(file + ' is not valid YAML, so it was left alone: ' + doc.errors[0].message); doc.set('pack', name); text = String(doc); }
  else text = '# Written by Muse (Admin, Profile). See muse.example.yaml.\npack: ' + name + '\n';
  if (had) fs.writeFileSync(file + '.bak', before);
  const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  return { pack: name, file, created: !had, backup: had ? file + '.bak' : null, envOverrides: !!process.env.MUSE_PACK, needsRestart: true };
}

module.exports = { ensureConfig, setActive, source, catalogue, PackError, CONTRACT, DEFAULT_PACK, ROOT, readConfig, loadPack, validateExtraction, current, extraction, reset };
