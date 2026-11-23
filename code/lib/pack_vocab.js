'use strict';
// A pack's words for the screens. The UI imports them from one module (js/pack_vocab.mjs): on disk it holds the default pack's words so tests and a
// fresh clone work with no server; the server replaces it on the fly with the active pack's words, so a pack's wording reaches every screen.
//   vocabulary keys:
//     purpose         the clause that finishes the first Help sentence ("so you can write ... of your own. It never writes ... for you.")
//     glossaryOthers  the note on a shape example that came from someone else
//     features        Muse-map rows the pack adds or patches (same key patches; a field "buttons+" appends to the core's list; a new key goes after `after`)
//     recipes         Help recipes the pack adds or patches, the same way
//     wordplayKinds   { kind: { label, blurb } } for the kinds of wordplay pair the pack finds
//     typeLabels      { hook type: label } for the hook types the pack adds to the common ones
const KEYS = { purpose: 'string', glossaryOthers: 'string', features: 'array', recipes: 'array', wordplayKinds: 'map', typeLabels: 'map' };

function validate(v, where) {
  const bad = (m) => { const Pack = require('./pack'); throw new Pack.PackError(where + ': vocabulary ' + m); };
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('must be an object');
  Object.keys(v).forEach((k) => {
    if (!KEYS[k]) bad('has an unknown key "' + k + '" (known: ' + Object.keys(KEYS).join(', ') + ')');
    if (KEYS[k] === 'array') { if (!Array.isArray(v[k])) bad(k + ' must be a list'); v[k].forEach((r, i) => { if (!r || typeof r.key !== 'string' || !/^[a-z][a-z-]*$/.test(r.key)) bad(k + '[' + i + '] needs a key (lowercase letters and hyphens)'); }); }
    else if (KEYS[k] === 'map') { if (!v[k] || typeof v[k] !== 'object' || Array.isArray(v[k])) bad(k + ' must be an object'); }
    else if (typeof v[k] !== KEYS[k]) bad(k + ' must be a ' + KEYS[k]);
  });
}
// What a capability adds to the screens (code/data/capability_<name>.json), merged under the pack's own words: a pack entry with the same key
// patches the capability's row (its fields win; "buttons+" lists join, the capability's first).
function withCapability(name, vocab) {
  const file = require('path').join(__dirname, '..', 'data', 'capability_' + name + '.json');
  const cap = JSON.parse(require('fs').readFileSync(file, 'utf8')); delete cap._comment; validate(cap, file);
  const out = Object.assign({}, vocab);
  Object.keys(cap).forEach((k) => {
    if (KEYS[k] === 'map') out[k] = Object.assign({}, cap[k], vocab[k]);
    else if (KEYS[k] === 'array') {
      const mine = (vocab[k] || []).slice(), rows = cap[k].map((r) => { const i = mine.findIndex((m) => m.key === r.key); if (i < 0) return r; const m = mine.splice(i, 1)[0], j = Object.assign({}, r, m); Object.keys(r).filter((x) => /\+$/.test(x) && Array.isArray(m[x])).forEach((x) => { j[x] = r[x].concat(m[x]); }); return j; });
      out[k] = rows.concat(mine);
    } else if (out[k] == null) out[k] = cap[k];
  });
  return out;
}
const moduleText = (vocab) => '// Generated from the active pack by code/lib/pack_vocab.js (node code/pack_vocab_build.js). Do not edit by hand.\nexport default ' + JSON.stringify(vocab || {}, null, 2) + ';\n';
module.exports = { KEYS, validate, moduleText, withCapability };
