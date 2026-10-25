'use strict';
/**
 * QUARRY lib/commands.js — the one catalogue of commands for the dev box and the Muse pipeline.
 * The Help page renders from this list, and test/commands.test.js checks it against package.json,
 * so a command cannot be added in one place and forgotten in the other.
 *
 * Fields: cmd (what you type), alt (an equivalent spelling, so nothing is listed twice), does, effect.
 * effect is one of: free, read-only, writes DB, spends money, Mac only (with a short note).
 */

const DEV_BOX = {
  title: 'Dev box commands (Mac)',
  intro: 'The <code>quarry</code> shell command comes from <code>~/dotfiles/zsh/quarry.zshrc.local</code>, loaded when you cd into the quarry folder. It exists on the Mac only, not on the homelab. <code>dev.sh</code> is the helper behind it; use the <code>quarry</code> command, not <code>dev.sh</code> directly.',
  items: [
    { cmd: 'quarry setup', does: 'First-time setup: install deps, copy the vault (no .git) to ../quarry-data, snapshot vault.db from the homelab, fix note paths.', effect: 'writes DB (backs up the dev DB first)' },
    { cmd: 'quarry start', does: 'Start the dev server in a detached tmux session "quarry-dev" on http://localhost:3001. LLM keys are scrubbed, so UI runs cannot spend money.', effect: 'free' },
    { cmd: 'quarry start --llm', does: 'Same, but keeps the LLM keys.', effect: 'spends money (UI runs call the APIs)' },
    { cmd: 'quarry start --fg', does: 'Run the server in the foreground instead (Ctrl-C stops it).', effect: 'free' },
    { cmd: 'quarry status | logs | attach | stop', does: 'Is the session up and answering | last 200 lines | watch live (detach with Ctrl-b d) | stop it.', effect: 'free' },
    { cmd: 'quarry refresh-db', does: 'Re-snapshot vault.db from the homelab and fix paths. Burrs exist only in the dev DB, so the current one is copied to vault.db.bak-… first.', effect: 'writes DB (backs up first)' },
    { cmd: 'quarry index', alt: 'npm run index', does: 'Incremental index of the dev vault copy into the dev DB.', effect: 'writes DB' },
    { cmd: 'quarry open', does: 'Open the dev UI in the browser.', effect: 'free' },
    { cmd: 'quarry muse', alt: 'npm run muse (foreground)', does: 'Start the Muse scratch viewer (burrs, bristles, sparks, knots) in a detached tmux session "quarry-muse" on http://localhost:3002. Your labels go to muse-judgements.jsonl, which is local and gitignored.', effect: 'read-only (writes only your labels)' },
    { cmd: 'quarry muse --fg | status | logs | attach | stop | open', does: 'The same controls as above, for the viewer.', effect: 'free' }
  ]
};

const MUSE = {
  title: 'Muse pipeline: burrs, bristles, sparks, knots',
  intro: 'Run these in the quarry folder (Node 24 comes from mise). Order: back up vault.db, migrate, nuggetize, then look at the results in the viewer. Nothing here writes to the vault; <code>writeback.js</code> is still never automated.',
  items: [
    { cmd: 'npm run migrate -- --status | --run', does: 'Show or apply pending migrations (M012 adds the burr tables, M013 the perishable flag, M014 the duplicate flags). Back up vault.db first: <code>cp vault.db vault.db.bak-$(date +%Y%m%d-%H%M)</code>.', effect: 'writes DB' },
    { cmd: 'npm run nuggetize -- --dry-run', does: 'Count the pending notes and estimate the cost. No LLM call, nothing written.', effect: 'free' },
    { cmd: 'npm run nuggetize -- --limit N', does: 'Extract burrs from N pending notes, shortest first. Empty and title-only notes are skipped with no LLM call and flagged for review.', effect: 'spends money (Gemini, about $0.0005 per note)' },
    { cmd: 'npm run nuggetize -- --all', does: 'Every pending note, any length. Resumable: finished notes are skipped. Run it in tmux. Stops at the budget ceiling or after 5 errors in a row.', effect: 'spends money (whole vault about $2 to $3)' },
    { cmd: 'npm run nuggetize -- --all --min-words N --shuffle --limit N', does: 'A spread-out trial on fuller notes instead of the shortest ones.', effect: 'spends money (cents)' },
    { cmd: 'npm run nuggetize -- --redo', does: 'Re-verify finished notes from the cache after a verifier change. Responses are cached, so there are no LLM calls except for notes that previously errored.', effect: 'writes DB (cents at most)' },
    { cmd: 'npm run nuggetize -- --note ID', does: 'One note, re-run even if finished.', effect: 'spends money (a fraction of a cent)' },
    { cmd: 'npm run nuggetize -- --review-list FILE.csv', does: 'Write the deletion-review candidates (empty or title-only notes and duplicate titles) to a CSV. Deletes nothing.', effect: 'read-only' },
    { cmd: 'nuggetize options', does: '<code>--provider gemini|claude|grok|openrouter</code> (default gemini), <code>--ceiling USD</code>, <code>--max-words N</code> (short-note cut, default 200).', effect: 'free' },
    { cmd: 'npm run dedupe', does: 'Find burrs that state the same fact (near-identical wording and identical numbers; 0.9 word overlap across notes, 0.95 inside a note; a negation in one claim blocks a match). Prints counts and sample pairs. Nothing written. Add <code>--csv FILE.csv</code> to write every duplicate burr pair, or <code>--notes FILE.csv</code> to list duplicate notes (same title or same opening) for your review.', effect: 'read-only' },
    { cmd: 'npm run dedupe -- --apply | --undo', does: 'Record the flags in <code>burr_dupes</code>, or clear them. Flagged burrs are hidden in the viewer (set <code>MUSE_SHOW_DUPES=1</code> to see them); no burr is ever deleted. Back up vault.db before --apply.', effect: 'writes DB' },
    { cmd: 'npm run muse:report', does: 'Print the text report: bristle types and join rates, spark and knot samples, loops, and the findings that feed the next prompt version.', effect: 'read-only' },
    { cmd: 'npm test', does: 'Run all unit tests (burr verifier, bristle maths, viewer rules, this catalogue).', effect: 'free' }
  ]
};

const NOTES = [
  'Ports: 3001 is the Quarry server, 3002 is the Muse viewer. tmux sessions: quarry-dev and quarry-muse.',
  'Prompt versions: burrs are stored per prompt version (nug-v1 to nug-v5). The viewer shows nug-v5 by default; start it with <code>--version nug-v4</code> to see the old burrs; older burrs are kept, never deleted.',
  'Burrs exist only in the dev DB. Back up vault.db before any snapshot or migration; <code>.gitignore</code> already covers <code>vault.db.bak-*</code>.',
  'The environment (QUARRY_DB, VAULT_PATH, Node version) comes from <code>mise.toml</code> in the quarry folder; run <code>mise trust</code> once.'
];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const H2 = 'color:#c8b89a;font-size:1.1rem;margin:22px 0 6px';

/** HTML for the Help page. `cmd`/`alt`/`effect` are escaped; `does` and `intro` are trusted markup from this file. */
function renderHtml() {
  const groups = [DEV_BOX, MUSE].map(g => {
    const rows = g.items.map(i =>
      '<tr><td style="color:#c8b89a;white-space:nowrap"><code>' + esc(i.cmd) + '</code>' +
      (i.alt ? '<div style="color:#777;font-size:.75rem">same as <code>' + esc(i.alt) + '</code></div>' : '') +
      '</td><td>' + i.does + '</td><td style="color:#999;font-size:.8rem">' + esc(i.effect) + '</td></tr>').join('\n');
    return '<h2 style="' + H2 + '">' + esc(g.title) + '</h2>\n<p style="color:#999;font-size:.85rem;margin-bottom:8px">' + g.intro + '</p>\n' +
      '<table class="report-result"><thead><tr><th>Command</th><th>What it does</th><th>Cost / effect</th></tr></thead><tbody>\n' + rows + '\n</tbody></table>';
  }).join('\n');
  const M = require('./muse_model');
  const lab = Object.keys(M.ITEM_LABELS).map(v => '<tr><td style="color:#c8b89a">' + esc(v) + '</td><td>' +
    M.ITEM_LABELS[v].map(l => '<b>' + esc(l[1]) + '</b>' + (l[2] ? ' (' + esc(l[2]) + ')' : '')).join('<br>') + '</td></tr>').join('\n');
  const chg = Object.keys(M.REC).map(k => '<tr><td style="color:#c8b89a">' + esc(M.REC[k].label) + '</td><td>' + esc(M.REC[k].ask.replace('{x}', '“…”')) +
    '</td><td><b>' + esc(M.REC[k].yes) + '</b> / <b>' + esc(M.REC[k].no) + '</b></td></tr>').join('\n');
  const viewer = '<h2 style="' + H2 + '">Muse viewer: what the buttons do</h2>\n' +
    '<p style="color:#999;font-size:.85rem;margin-bottom:8px">Every row carries up to two kinds of question. Your clicks are saved at once to <code>muse-judgements.jsonl</code> (local, gitignored); a note is saved with the next click.</p>\n' +
    '<p style="color:#999;font-size:.85rem;margin:8px 0 4px"><b>About the item</b> (is this fact, hook, pairing or word any good?):</p>\n<table class="report-result"><tbody>' + lab + '</tbody></table>\n' +
    '<p style="color:#999;font-size:.85rem;margin:12px 0 4px"><b>About a proposed change</b> (the Proposed changes tab; each button names what will happen if the change is applied):</p>\n' +
    '<table class="report-result"><thead><tr><th>Proposed change</th><th>The question on the row</th><th>Buttons</th></tr></thead><tbody>' + chg + '</tbody></table>';
  return groups + '\n' + viewer + '\n<ul style="color:#999;font-size:.8rem;margin:10px 0 14px 18px">' + NOTES.map(n => '<li>' + n + '</li>').join('') + '</ul>';
}

module.exports = { groups: [DEV_BOX, MUSE], notes: NOTES, renderHtml };
