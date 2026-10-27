# lab status (update on every change; this file is the merge ledger)

Last updated: 2026-10-27 (v6 complete)

## nuggetize v6: COMPLETE (checked read-only on live vault.db, 2026-10-27)
- nug-v6: 56,559 burrs over 6,359 notes (nug-v5: 56,999 / 6,382; nug-v4: 44,884 / 6,242). Final run 848 ok, 0 errors.
- Spend $7.997 lifetime (nuggetize $6.72, classifier $1.03, retag $0.24). Raise `--ceiling` before any further run.
- 346 v6 burrs carry a hook with `xc` (stored as the claim-scan reading string, e.g. "10 p.m", not `true`); 277 carry era BC. Eras are stored lower-case ("ad"/"bc").
- burr_dupes holds flags for nug-v4 (418 clone, 38 echo) and nug-v5 (531, 47) ONLY. None for v6 -> dedupe on v6 is the next step.
- 64 notes have v5 burrs but no v6 burrs (e.g. 6, 506, 629, 647, 966, 1030). Unresolved: model returned nothing vs never attempted. Check with `npm run nuggetize -- --all --dry-run`.
- Finding for backlog: clock times ("9 p.m") reach the model as time hooks with era "ad"; xc catches the mismatch, so keys fall back to claim text, but the prompt should say clock times are not hooks.
- eval.db: a partial 175 MB file was left by a failed in-sandbox VACUUM; it cannot be deleted from here. Delete it on the Mac before snapshotting.

## E1 result (nug-v6, eval.db, 2026-10-27)
- Rules v1 (production `variantKey`): 151 merge groups. Reviewed 97 by eye before the file was cut off: about 28 bad merges, two systematic classes:
  (a) roman numerals collapse by the doubled-letter rule (World War II = I, George I/II/III, Elizabeth, Charles, Richard, William, Ptolemy, Form I/II);
  (b) short ordinary words collide (copper/cooper, wolf/Woolf, thing/ting, rot/Roth, bat/Bath, Mass/Maas, Book/Bokh, tiger/Tigger).
- Rules v2 (`lab/fold2.js`, production untouched): roman numerals never folded; a token folds only if the folded form has >= 6 letters; word-level hook types (etymon, homonym, material) excluded. 65 groups, one known bad (Wapping/vaping). Lost true merges: short names (Hasan/Hassan, Masai/Maasai, Lenox/Lennox, Esther/Ester), accepted because a false join costs more than a missed one.
- Pending the user's call: adopt v2 as the fuzzy-bristle candidate rule (never creates a link alone) and port it into bristles.js with tests. Review file: code/lab/out/nug-v6/e1_review_v2.md.

## E2 result (nug-v6, 2026-10-27): INCONCLUSIVE BY DESIGN - TF-IDF stays the default
- All four methods (TF-IDF, embeddinggemma, qwen3-embedding:0.6b, bge-m3) score AUC 1.000 [1.000,1.000] vs random and vs same-hook negatives. Only 4 of 529 clone positives were paraphrase-like (TF-IDF cosine < 0.85): dedupe finds near-identical text by construction, so these positives cannot separate the methods.
- Same-quote v5/v6 pairs do not rescue it: 23,712 one-to-one pairs exist (~1,000 below cosine 0.7), but low-similarity ones are often different facts from the same quote (e.g. "Jennifer Robledo is a big fan of Cthulhu" vs "...bought crab legs..."), so the labels are noisy exactly where it matters.
- Conclusion: no evidence embeddings are needed for duplicate/same-fact matching. Their real jobs (knot sense clustering, pre-filter before the link judge) need judged data. Test them there:
  1. knots: `same sense` (57) vs `polyseme`/`homonym` (16) from muse-judgements.jsonl;
  2. link-judge harness output (yes/none/held) ranked by TF-IDF vs embeddings.
- Embedding vectors for 6,797 burrs x 3 models are cached in code/lab/out/cache and reused by any later run.

## Knot-sense result (nug-v4 labels, 54 same-sense vs 14 multi-sense keys, 2026-10-27): embeddings do NOT help here
- Mean pairwise claim similarity (key words stripped) AUC: tfidf 0.525, embeddinggemma 0.454, qwen3-embedding 0.389, bge-m3 0.369; all CIs include 0.5 (embeddings are, if anything, inverted).
- Why: whether a NAME is ambiguous (mercury, mars, diamond, homer, diana, jones, indus) is not the same as whether its claims are topically similar; a one-referent entity like Algeria has claims spread across politics, sport and history.
- Simple deterministic features on the same labels: key length AUC 0.72 [0.60,0.84], multiword 0.64, non-wordy hook types 0.62, capitalised 0.58, entity type 0.56. Preliminary (5 features tried, 14 negatives); only length excludes 0.5.
- Direction: sense checks belong to the LLM judge (one call per ambiguous short key: "do these claims use X in one sense?"), gated by deterministic features (short, single-word, df >= 2). Embeddings are not needed for it.

## Gemini price table: FIXED in code 2026-10-27 (ledger rows not yet restated)
- Was $0.075 in / $0.30 out per 1M (recorded $6.68 for 37.0M in / 13.0M out gemini nuggetize tokens). Now gemini-2.5-flash $0.30 / $2.50 (+ flash-lite 0.10/0.40, pro 1.25/10; unknown gemini models charged at the pro rate, flagged) in lib/budget.js and tagger.js, with a test that keeps the two in sync and a calibration test.
- Evidence: Google bill INR 3.73K over Oct 22-27 (Tier 2); INR about 95/USD (94.5-95.4 on Oct 20-27) = about $39; list-price recompute of the recorded tokens = $43.7 (billing lags by hours; the cap counter showed INR 4,028.57 = about $42). Monthly spend cap INR 5,000, resets 1 Nov (PST).
- NOT done: api_budget still holds old-rate rows (Gemini rows understated about 6x; the table has no model column, so all gemini rows would be assumed flash). New spend records at the correct rate, so the lifetime ceiling now mixes the two until the rows are restated (one-off, reversible; needs the user's go).

## Judge runs (69 reproducible labelled sparks: 41 yes, 21 held, 7 none)
- Run 1, prompt v1: accuracy 0.64 vs always-yes 0.59. yes recall 1.00 / precision 0.63; none recall 2/7; held recall 1/21. Treated "same entity in several facts" as a link.
- Run 2, prompt v2, dev half only (35): accuracy 0.46 vs always-yes 0.69 (v1 on the same half: 0.74). Over-corrected: 13 of 24 sparks became held/none; none class 0/2 with 7 predicted. Held recall rose to 5/9.
- Why prompt tuning stops here: the labels are not separable by a rule. Dublin, Harappan civilization, Yamuna, Ganga, ginger = spark; Sydney, Manchester, Egyptian, Bolivia, White House = held; same structure (a hub entity, unrelated facts). And 5 of the 6 sparks the author labelled more than once changed verdict (ganga none>yes, civil war held>yes, eurovision none>yes, "shift from hard liquor to beer" flipped six times).
- Next evidence must come from the author's quiz backtest (needs ~30-50 of the author's own questions with answers) or a fresh, consistent binary labelling (keep/dull, no held) of random sparks. The test half (34) is untouched by tuning.
- Cost comparison (list prices, per nuggetize-sized call of 1.8k in / 0.63k out): gemini-2.5-flash $0.0021; flash-lite $0.0004; grok-4.3 $0.0038; grok-4.7 $0.0074. Full 6,800-note pass: about $14 / $3 / $26 / $50. Quality head-to-head not measured. Grok ledger rows (3,570 classifier calls, 8.3M in / 1.27M out recorded as $1.03) do not match any rate in the table (about $10 at the cheapest): check the xAI console.

## Link judge harness (built, tests pass, not yet run on real LLM calls)
- lab/judge_spec.js: contract (prompt judge-spark-v1, schema, cache key, verifier: verdict in yes/none/held; cited burrs must exist; yes needs >= 2 cited facts from different notes; failures flagged, never guessed). lab/judge.js: rebuilds every labelled spark from the version it was labelled on, asks the judge, prints confusion matrix vs the author's labels.
- Ground truth: 95 labelled sparks (nug-v4 + nug-v5); 69 still reproducible: 41 yes (spark), 21 held, only 7 none (dull/trivial). Weak on the "none" side; more dull labels from the author would sharpen it.
- Estimated cost for all 69: about $0.035 at list price. Spend is capped per run (--max-usd 0.30) and logged to lab/out/spend.jsonl (not api_budget).

## Built (needs only an eval.db snapshot of v6)
| piece | file | state |
|---|---|---|
| data adapter (version-parametrised) | lab/data.js | done, tested |
| metrics (AUC, p@k, CI) | lab/metrics.js | done, tested |
| similarity + embed cache | lab/sim.js | done, tested |
| Ollama backend | lab/embed_ollama.js | done, tested vs fake server; not yet run on real Ollama |
| E2 bake-off | lab/e2_bakeoff.js | run on v6: saturated, see E2 result |
| E1 review list | lab/e1_fold.js (+ fold2.js, `--rules v1|v2`) | run on v6; see E1 result |

## Not built yet (order)
1. string-level layer (deterministic spark-candidate rules)
2. link judge harness (run only after nuggetize finishes - rate limits)
3. backtest tool (needs the user's own quiz questions)

## Merge point: after v6 finishes
```
cd ~/Developer/prototypes/quarry
npm run dedupe                       # report on nug-v6 (default version), read-only
npm run dedupe -- --apply            # records v6 flags (E2 positives); back up vault.db first
rm -f eval.db && sqlite3 vault.db ".backup eval.db"   # snapshot AFTER dedupe
ollama pull embeddinggemma && ollama pull qwen3-embedding:0.6b && ollama pull bge-m3
node code/lab/e1_fold.js --db eval.db --version nug-v6
node code/lab/e2_bakeoff.js --db eval.db --version nug-v6
```
Outputs: code/lab/out/nug-v6/{e1_review.md,e2_results.json}. Embedding cache: code/lab/out/cache (reused across versions).
Decision rules: embeddings only adopted if AUC vs same-hook (hard) beats TF-IDF with non-overlapping 95% CI.

## Quiz backtest (2026-10-28)
Decision 7 (Constitution): quizzes supplied by the author, own or others', are read-only material for patterns and backtests, held in backtest/ (gitignored), never in the burr store or vault; only the author's own quiz data may be imported into the vault.
Tools: lab/quiz_items.js (pdftotext output -> items), lab/quiz_backtest.js build|score|judge, lab/nug_bakeoff.js (model bake-off), llm opts.model pin.
Data: 332 items from nine sources (3 PDFs, 6 pptx; text layer only); 1,384 burrs from 313 items; build cost about $0.41.
Results: AUC vs random: tfidf 0.80, embeddinggemma 0.91, qwen3 0.90, bge-m3 0.90; vs hook-sharing cross-item pairs all about 0.2 (embeddings do not separate coincident handles). Judge (v2, 120 pairs all sharing a hook): same-item yes 37/none 19/held 4; cross-item yes 3 (all header-boilerplate burrs)/none 57; P(link|yes) 0.93, recall 0.62, $0.043. Flash-Lite bake-off: hooks per burr 1.27 vs 1.86, 529 over_cap rejects; keep Flash for nuggetize.
Open: deterministic filter for header/boilerplate burrs; judge candidate-pair count and cost on the vault; api_budget restatement; xAI ledger check.
