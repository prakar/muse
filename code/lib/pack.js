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
  let dipaka = null;
  if (p.dipaka != null) {
    if (!isStr(p.dipaka)) throw new PackError(file + ': dipaka must be a project-relative file path');
    const abs = path.resolve(root, p.dipaka);
    if (!abs.startsWith(root + path.sep)) throw new PackError(file + ': dipaka points outside the project');
    try { dipaka = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new PackError(file + ': dipaka (' + p.dipaka + ') cannot be read as JSON: ' + e.message); }
    if (!dipaka || !['promptVersion', 'intro', 'question'].every((k) => isStr(dipaka[k]))) throw new PackError(file + ': dipaka needs promptVersion, intro and question (non-empty strings)');
  }
  return Object.freeze({ dipaka, lens, vocabulary: Object.freeze(vocabulary), name: p.name, version: p.version || '0.0.0', description: p.description, capabilities: Object.freeze((p.capabilities || []).slice()), extraction: p.extraction, files: Object.freeze(files), dir });
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

module.exports = { PackError, CONTRACT, DEFAULT_PACK, ROOT, readConfig, loadPack, validateExtraction, current, extraction, reset };
