# lab status (update on every change; this file is the merge ledger)

Last updated: 2026-10-27

## Waiting on
- nuggetize v6 full run (tmux; resume with `--ceiling 9`). ~850 notes were left at the $7.50 stop. Do not read live vault.db while it runs.

## Built (needs only an eval.db snapshot of v6)
| piece | file | state |
|---|---|---|
| data adapter (version-parametrised) | lab/data.js | done, tested |
| metrics (AUC, p@k, CI) | lab/metrics.js | done, tested |
| similarity + embed cache | lab/sim.js | done, tested |
| Ollama backend | lab/embed_ollama.js | done, tested vs fake server; not yet run on real Ollama |
| E2 bake-off | lab/e2_bakeoff.js | done, tested on synthetic pairs; not yet run on real burrs |
| E1 review list | lab/e1_fold.js | done, tested; not yet run on real burrs |

## Not built yet (order)
1. string-level layer (deterministic spark-candidate rules)
2. link judge harness (run only after nuggetize finishes - rate limits)
3. backtest tool (needs the user's own quiz questions)

## Merge point: after v6 finishes
```
cd ~/Developer/prototypes/quarry
sqlite3 vault.db ".backup eval.db"
node code/dedupe.js ...            # on nug-v6 first (E2 positives = burr_dupes clones)
sqlite3 vault.db ".backup eval.db" # re-snapshot after dedupe
ollama pull embeddinggemma && ollama pull qwen3-embedding:0.6b && ollama pull bge-m3
node code/lab/e1_fold.js --db eval.db --version nug-v6
node code/lab/e2_bakeoff.js --db eval.db --version nug-v6
```
Outputs: code/lab/out/nug-v6/{e1_review.md,e2_results.json}. Embedding cache: code/lab/out/cache (reused across versions).
Decision rules: embeddings only adopted if AUC vs same-hook (hard) beats TF-IDF with non-overlapping 95% CI.
