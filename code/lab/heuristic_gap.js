'use strict';
// H2 evidence: what the nug-v6 burrs carry, how joinable the hooks are, and how many claims state each relation
// the heuristics need. Read-only on an eval.db snapshot; writes code/lab/out/<version>/heuristic_gap.json.
// Usage: node --no-warnings code/lab/heuristic_gap.js --db eval.db [--version nug-v6]
const fs = require('fs'), path = require('path');
const D = require('./data'), BR = require('../lib/bristles');
const { isBoilerplate } = require('./boiler');

// Relation cues: deliberately plain regexes over the claim. They estimate DEMAND (how many claims state the relation),
// not quality; a model would find more, a regex finds the obvious ones. Keys are the draft relation vocabulary.
const CUES = {
  'named-after': /\b(named|christened|called|dubbed) (after|for|in honou?r of)\b|\bnamesake\b|\beponym/i,
  'renamed-from': /\brenamed\b|\bformerly (known|called|named)\b|\b(originally|earlier|previously) (called|named|known)\b|\bre-?brand/i,
  'derived-from': /\b(derived|descended|adapted|translated|copied|modell?ed|based) (from|on|upon)\b|\brebadged\b|\bclone of\b|\bversion of\b|\bvariant of\b/i,
  'inspired-by': /\binspired by\b|\bhomage\b|\bin imitation of\b|\bemulat|\bparod(y|ies|ied)\b/i,
  'caused-by': /\b(because|due to|as a result of|owing to|led to|resulted in|caused|triggered|sparked|prompted)\b/i,
  'chosen-because': /\b(chosen|selected|picked|decided)\b[^.]{0,80}\b(because|since|so that|in order to|to avoid|to make)\b/i,
  'explained-by': /\bexplains?\b|\b(reason|explanation|origin) (for|of|why)\b|\baccounts? for\b|\bthat is why\b|\baccording to (legend|myth|tradition|folklore)\b|\blegend (has it|says|holds)\b/i,
  'commemorates': /\bcommemorat|\bin memory of\b|\bin honou?r of\b|\bmemorial\b|\bhonou?rs? the\b/i,
  'persists-as': /\bsurviv(es|ed|ing)\b|\bpersist(s|ed)?\b|\bstill (used|exists|stands|survives|follows|called|known)\b|\blegacy\b|\bremains (in|as)\b/i,
  'applied-from': /\b(borrowed|adopted|imported|introduced) (from|by)\b|\bstudied (the|how)\b|\bmodell?ed (on|after)\b/i,
  'contested-explanation': /\b(contested|disputed|folk etymology|popular myth|apocryphal|allegedly|some say|others say|according to one|debated|uncertain whether)\b/i
};
const ROLE = /\b(born|died|founded|established|opened|launched|released|published|married|killed|assassinated|signed|inaugurated|premiered|crowned|abdicated|ratified|began|ended|formed|built|completed)\b/i;
const MON = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DAY_LEVEL = new RegExp('\\b\\d{1,2}(?:st|nd|rd|th)? ' + MON + ',? (?:1|2)\\d{3}\\b|\\b' + MON + ' \\d{1,2}(?:st|nd|rd|th)?,? (?:1|2)\\d{3}\\b', 'i');
const MONTH_LEVEL = new RegExp('\\b' + MON + ',? (?:1|2)\\d{3}\\b', 'i');
const LOOSE = ['set', 'uniqueness', 'mechanism', 'former-role'];

function pct(n, d) { return d ? Math.round(1000 * n / d) / 10 : 0; }

function analyse(burrs, skip) {
  const live = burrs.filter(b => !skip.has(b.id) && !isBoilerplate(b.claim));
  // key -> set of notes, over every hook of every live burr (the judge's handle definition)
  const keyNotes = new Map();
  live.forEach(b => b.hooks.forEach(h => { const k = BR.foldKey(h.value); if (!BR.usableKey(k)) return;
    if (!keyNotes.has(k)) keyNotes.set(k, new Set()); keyNotes.get(k).add(b.note_id); }));
  const joinable = k => { const s = keyNotes.get(k); return !!s && s.size >= 2 && s.size <= 20; };
  const burrJoinable = b => b.hooks.some(h => { const k = BR.foldKey(h.value); return BR.usableKey(k) && joinable(k); });

  const out = { burrs_live: live.length, burrs_total: burrs.length };
  out.kinds = {}; live.forEach(b => { out.kinds[b.kind] = (out.kinds[b.kind] || 0) + 1; });
  out.burrs_with_hook = live.filter(b => b.hooks.length).length;
  out.burrs_with_joinable_hook = live.filter(burrJoinable).length;
  out.burrs_isolated_pct = pct(live.length - out.burrs_with_joinable_hook, live.length);

  // hook types: instances, joinable instances, distinct keys, singleton share of keys
  out.hook_types = {};
  live.forEach(b => b.hooks.forEach(h => {
    const t = h.type, k = BR.foldKey(h.value), o = out.hook_types[t] || (out.hook_types[t] = { instances: 0, joinable: 0, keys: new Set(), singletons: new Set() });
    o.instances++; if (BR.usableKey(k)) { o.keys.add(k); if (joinable(k)) o.joinable++; if ((keyNotes.get(k) || new Set()).size === 1) o.singletons.add(k); }
  }));
  Object.keys(out.hook_types).forEach(t => { const o = out.hook_types[t];
    out.hook_types[t] = { instances: o.instances, joinable_pct: pct(o.joinable, o.instances), distinct_keys: o.keys.size, singleton_key_pct: pct(o.singletons.size, o.keys.size) }; });

  // loose hooks: free phrases. Show how many distinct phrases, and the head of the distribution.
  out.loose = {};
  LOOSE.forEach(t => { const c = new Map();
    live.forEach(b => b.hooks.forEach(h => { if (h.type === t) c.set(BR.foldKey(h.value), (c.get(BR.foldKey(h.value)) || 0) + 1); }));
    const top = Array.from(c.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
    out.loose[t] = { distinct: c.size, instances: Array.from(c.values()).reduce((s, x) => s + x, 0), top: top };
  });

  // dates
  out.dates = { burrs_with_time_hook: live.filter(b => b.hooks.some(h => h.type === 'time')).length,
    day_level_in_claim: 0, month_level_in_claim: 0, day_level_with_role_cue: 0 };
  live.forEach(b => { if (DAY_LEVEL.test(b.claim)) { out.dates.day_level_in_claim++; if (ROLE.test(b.claim)) out.dates.day_level_with_role_cue++; } else if (MONTH_LEVEL.test(b.claim)) out.dates.month_level_in_claim++; });

  // loops
  out.loops = { with_loop: 0, why_how: 0 };

  // relation demand and supply
  out.relations = {};
  Object.keys(CUES).forEach(r => {
    const hit = live.filter(b => CUES[r].test(b.claim));
    out.relations[r] = { claims: hit.length, pct_of_burrs: pct(hit.length, live.length), already_joinable_pct: pct(hit.filter(burrJoinable).length, hit.length), isolated: hit.length - hit.filter(burrJoinable).length };
  });
  const anyRel = live.filter(b => Object.keys(CUES).some(r => CUES[r].test(b.claim)));
  out.relations_any = { claims: anyRel.length, pct_of_burrs: pct(anyRel.length, live.length), isolated: anyRel.filter(b => !burrJoinable(b)).length };
  return out;
}

function main() {
  const a = process.argv.slice(2), arg = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!arg('db')) { console.error('Usage: node --no-warnings code/lab/heuristic_gap.js --db eval.db [--version nug-v6]'); process.exit(1); }
  const version = arg('version', D.DEFAULT_VERSION), db = D.openCopy(arg('db')), burrs = D.loadBurrs(db, version);
  const skip = new Set(D.loadDupes(db, burrs.map(b => b.id)).map(d => d.burr_id));
  const res = analyse(burrs, skip);
  const rows = db.prepare('SELECT loop_text FROM burrs WHERE prompt_version = ?').all(version);
  res.loops.with_loop = rows.filter(r => r.loop_text && r.loop_text.trim()).length;
  res.loops.why_how = rows.filter(r => /^\s*(why|how come|what made|what led|what explains)\b/i.test(r.loop_text || '')).length;
  const dir = path.join(__dirname, 'out', version); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'heuristic_gap.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 1));
}
module.exports = { CUES, analyse, DAY_LEVEL, ROLE };
if (require.main === module) main();
