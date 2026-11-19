'use strict';
// loop_trial.js: a small lab experiment, not part of Muse. Does putting a fact's own open question (its loop) into the author's line of a Dipaka packet
// make the illumination sharper? For each of N randomly chosen facts that carry a loop it builds two packets with Dipaka's own buildPacket:
//   A) the fact with its loop as the author's line:   1. Note title: claim (the open question)
//   B) the fact alone (baseline):                    1. Note title: claim
// and sends both through lib/llm.js on the economy profile (the model is chosen by llm-model-resolver, never pinned here).
// Nothing is written to vault.db, the vault or muse-dipaka.jsonl: the database is opened read-only; the only file written is the report under code/lab/out/loop_trial/ (gitignored).
//
//   node --no-warnings code/lab/loop_trial.js --dry-run        show the packets and the call count; no money spent
//   node --no-warnings code/lab/loop_trial.js --n 4            run it (2 calls per fact, economy profile)
//   options: --seed 7  --provider claude|gemini|grok  --db path  --version nug-v6  --min-claim 60
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { buildPacket } = require('../lib/dipaka');

function parseArgs(argv) {
  const a = { n: 4, seed: 7, provider: '', db: path.join(__dirname, '..', '..', 'vault.db'), version: '', minClaim: 60, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dry = true;
    else if (k === '--n') a.n = Math.max(1, Math.min(10, parseInt(argv[++i], 10) || 4));
    else if (k === '--seed') a.seed = parseInt(argv[++i], 10) || 7;
    else if (k === '--provider') a.provider = argv[++i];
    else if (k === '--db') a.db = argv[++i];
    else if (k === '--version') a.version = argv[++i];
    else if (k === '--min-claim') a.minClaim = parseInt(argv[++i], 10) || 60;
    else throw new Error('unknown option ' + k);
  }
  return a;
}
const rng = seed => { let t = (seed >>> 0) + 0x6D2B79F5; return () => { t = (t + 0x6D2B79F5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; };

function pick(db, a) {
  const version = a.version || (db.prepare('SELECT prompt_version AS v FROM burrs GROUP BY prompt_version ORDER BY MAX(created_at) DESC LIMIT 1').get() || {}).v;
  const rows = db.prepare("SELECT b.id, b.claim, b.loop_text AS loop, n.title AS note FROM burrs b JOIN vault_notes n ON n.id = b.note_id WHERE b.prompt_version = ? AND b.loop_text IS NOT NULL AND length(b.loop_text) >= 20 AND length(b.claim) >= ?").all(version, a.minClaim);
  const r = rng(a.seed), pool = rows.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)), t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return { version, total: rows.length, chosen: pool.slice(0, a.n) };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const db = new DatabaseSync(a.db, { readOnly: true });
  const { version, total, chosen } = pick(db, a);
  db.close();
  console.log('prompt version ' + version + ': ' + total + ' facts with a loop; trying ' + chosen.length + ' (seed ' + a.seed + '); calls: ' + chosen.length * 2 + ', economy profile');
  const cases = chosen.map(f => ({ f, withLoop: buildPacket([f], [f.loop]), alone: buildPacket([f], []) }));
  if (a.dry) { cases.forEach((c, i) => console.log('\n--- ' + (i + 1) + ' (A: loop in the author line) ---\n' + c.withLoop + '\n--- ' + (i + 1) + ' (B: fact alone) ---\n' + c.alone)); console.log('\nDRY RUN: nothing sent.'); return; }
  const llm = require('../lib/llm');
  const provider = a.provider || ['claude', 'gemini', 'grok'].find(p => llm.hasKey(p));
  if (!provider || !llm.hasKey(provider)) throw new Error('No API key for provider ' + (provider || '(any)') + '. Set one, or pass --provider.');
  const out = ['# Loop trial (' + new Date().toISOString() + ')', 'provider ' + provider + ', economy profile, prompt version ' + version + ', seed ' + a.seed, ''];
  let tin = 0, tout = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    out.push('## ' + (i + 1) + '. ' + c.f.note, '', 'Fact: ' + c.f.claim, 'Loop: ' + c.f.loop, '');
    for (const [label, packet] of [['A: loop in the author line', c.withLoop], ['B: fact alone', c.alone]]) {
      const r = await llm.callLLM(provider, packet, { system: null, maxTokens: 4000, profile: 'economy', label: 'loop-trial' });
      tin += r.tokensIn || 0; tout += r.tokensOut || 0;
      out.push('### ' + label + ' (' + (r.model || '?') + ', ' + (r.tokensIn || 0) + ' in, ' + (r.tokensOut || 0) + ' out)', '', String(r.text || '').trim(), '');
      console.log('done ' + (i + 1) + ' ' + label);
    }
  }
  out.push('Totals: ' + tin + ' tokens in, ' + tout + ' out.');
  const dir = path.join(__dirname, 'out', 'loop_trial'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'loop_trial-' + new Date().toISOString().replace(/[:.]/g, '-') + '.md'); fs.writeFileSync(file, out.join('\n'));
  console.log('\nTokens: ' + tin + ' in, ' + tout + ' out.\nReport: ' + file);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { parseArgs, pick };
