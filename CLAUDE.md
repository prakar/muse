# Quarry: guide for Claude Code

Quarry turns the author's Obsidian vault into a SQLite store of burrs (atomic claims), hooks/bristles (shared handles) and sparks (surprising connections), to help him write quizzes. It surfaces connections; it never writes questions.

Stance: deterministic first, local ML second, LLM last. The LLM proposes, deterministic code disposes.

## Read first
- `code/lab/STATUS.md` (repo): current state and the execution checklist.
- Design docs have ONE canonical home: the vault, at `/Users/prakar/md-vaults/tech-journalling/worklog/2026/` (index: `QUARRY MOC.md`). Edit them there only. Code state and the execution checklist have one home too: `code/lab/STATUS.md`. The claude.ai Project QUARRY holds pointer stubs under the old `claude/` names; never copy design text into the Project or the repo.

| Project stub | Canonical note | Role |
|---|---|---|
| `muse-constitution.md` | vault `QUARRY - Muse Constitution.md` | Binding rules and decisions (Decision 7: quiz material) |
| `muse-design.md` | vault `QUARRY - Muse Design.md` | Design; "The heuristics are the spec"; checklist H1-H7 |
| `quiz-corpus-lessons.md` | vault `QUARRY - Heuristics Commons.md` | The 71 link heuristics |
| `heuristics-illustrations.md` | vault `QUARRY - Heuristics Illustrations.md` (tech-journalling only) | Source fragment per heuristic (other setters' quizzes) |
| `quiz-backtest.md` | vault `QUARRY - Quiz Backtest.md` | Backtest findings and what is not yet done |
| `yaksha-design.md` | vault `QUARRY - Yaksha Design.md` | The asker |
| `dipaka-design.md` | vault `QUARRY - Dipaka Design.md` | The lamp (user-triggered LLM surface) |
| `muse-feedback-round-1.md` | vault `QUARRY - Muse Feedback Round 1.md` | First author verdicts |
| `tagger-v2-roadmap.md` | vault `tagger-v2-roadmap.md` | Tagger roadmap |
| `lab-status.md` | `code/lab/STATUS.md` (this repo) | Code state, numbers, execution checklist |

Project-only working papers (single copy, not duplicated): `nug-v6-backlog.md`, `deterministic-first-deliverable.md`, `bakeoff-results-2026-10-25.md`, `rust-candidates.md`, `text-extraction-failures-and-libraries.md`.

## Standing rules
- One canonical home per fact. Link to it, never copy it. Anything derived (the heuristic registry, tables) is generated from its sources and carries a test that fails on drift. Say so whenever you add a new document or data file.
- Quizzes (own or others') are for patterns and backtests only, read-only, outside the burr store and the vault. Only the author's own quiz data may be imported into the `knowledge` vault (the only one Quarry reads). Notes quoting other setters' fragments stay in `tech-journalling`, never `knowledge`. Quiz files and extracts stay in gitignored `backtest/`, never in the repo.
- Never run `git commit` or `git push` unless asked. Never automate `writeback.js`.
- Lab work lives in `code/lab/`; lab outputs in `code/lab/out/`. Lab spend log: `code/lab/out/spend.jsonl`. Ask before raising spend caps beyond what was agreed.
- Eval snapshots: use sqlite `.backup`, not `VACUUM INTO`.
- Run tests with the repo's test command before saying work is done.

## Heuristic registry
`code/data/heuristics.json` is GENERATED (`npm run heuristics`; `npm run heuristics:check`). Authored fields are in `code/data/heuristic_overlay.json`; names and tags come from the vault note `QUARRY - Heuristics Commons`, fragment counts from `QUARRY - Heuristics Illustrations`. It must hold no quiz text. Findings and plan: vault note `QUARRY - Heuristics Gap Analysis`. Set `QUARRY_VAULT_NOTES` if the vault notes are not at the default path.

## In progress
Reverse-engineering the 71 heuristics into burrs, bristles, sparks and the judge. H1 (registry) and H2 (gap analysis) are done; the order of work is in the vault note `QUARRY - Heuristics Gap Analysis`.
