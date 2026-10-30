# lab status (update on every change; this file is the merge ledger)

Last updated: 2026-10-29

This file is the canonical home of code state, numbers and the execution checklist. The design docs are canonical in the vault (see the repo CLAUDE.md); the Claude project QUARRY holds only pointer stubs.

## Roadmap, revised 29 Oct 2026 (the order of work; the checklist below keeps the older detail)
Reasoning for tracks B and C: vault note `QUARRY - Muse Search and Embeddings Design`.

**A. Extraction coverage** (found 29 Oct: the extractor reads only the first 6,000 characters of a note; 1,624 of 6,880 notes, about half of all characters, are beyond it; warning at the top of the vault note `QUARRY - Muse Design`)
- A1 DONE: finding documented. The old Quarry has nothing to import (its chunking compressed long notes and deleted its caches; the v2 classifier gave 13 to 22 claims for the largest notes).
- A2 Long-note lab, author runs it (`code/lab/long_notes.js`, built and tested 29 Oct, not yet run): the 10 largest notes, same prompt, successive windows; reports burrs per 1,000 characters head vs tail and how many join other notes. Dry run estimate $1.98 (371 windows, gemini-2.5-flash), which would take lifetime spend from $7.997 to about the $10 ceiling. Lab spend is logged in `code/lab/out/spend.jsonl`, not `api_budget`. Run on a copy: `rm -f eval.db` (the stale partial file), `sqlite3 vault.db ".backup eval.db"`, then `node --no-warnings code/lab/long_notes.js --db eval.db --top 10 --dry-run`, then the same with `--max-usd 3`.
- A3 Decide from the numbers: windowed re-extraction of all capped notes (rough scaling about $15 to $20, needs the author's go and a raised ceiling) or a chunk-level text index for the tails (about $0, goes with B2 and C3). Both can be done.
- A4 Author's call: move non-quiz notes such as `Indra in the Rig-Veda` out of `knowledge` into `vernacular-playground`. That vault is named in `md-vaults/CLAUDE.md` but does not exist on disk; creating it and moving the note need the author's go. After a move, re-index so Muse drops it.

**B. Search (no new technology)**
- B1 Routing: years, days and quantities go to their handles; Enter with no pick opens a results page (`#/search?q=`).
- B2 Full text: FTS5 over burr claims, quotes, hook surfaces and note titles; grouped results (Handles, Facts, Notes, Wordplay) with snippets; URL-as-state.
- B3 Facets (`born:`, `role:`, `kind:`): only if B2 shows the need.

**C. Embeddings** (the author wants them for search; the lab evidence limits what they are for)
- What the lab did and did not test (STATUS "E2", "Knot-sense", "Quiz backtest"): all claim-to-claim pairs, never query-to-claim retrieval, and the backend sent raw text with no query/document prompts. Duplicates: ceiling, uninformative. Sense: every method at chance (n=68). Link versus shared hook: a similarity score cannot judge a link, and hook-sharing pairs are alike by definition. Same-quiz-item versus random: embeddings 0.90 to 0.91, TF-IDF 0.80. So: no evidence against embeddings for search, and none for them yet. Sense checks stay with the LLM judge.
- C1 Central embeddings server on the Linux box (Ollama; stateless embed API with model and version stamp; LAN only; token). Muse never depends on it to start.
- C2 Retrieval pilot in the lab, no UI. Queries: about 100 synthetic paraphrases of sampled burrs with the key words removed (vocabulary mismatch, a known target, one cheap LLM call each), about 30 queries the author writes with judged results, plus exact-name and numeric queries as a guard. Compare BM25 (FTS5), each model with its proper query and document prompts, and hybrid (reciprocal rank fusion) on recall@10 and MRR with bootstrap CIs (`lab/metrics.js`). Adopt the semantic leg only if hybrid beats BM25 on the mismatch queries with a non-overlapping CI and does not lose on the exact ones. Also try G3 phrase clustering.
  - **C2 first pass DONE 29 Oct 2026** (embeddinggemma only; details in the vault note "Muse Search and Embeddings Design", section 10). Scripts: `search_baseline.js` (FTS5 BM25), `semantic_pilot.js` (meaning + hybrid), `score_pilot.js`, `quiz_seeds.js` (the author's quiz items as queries), `query_rewrite.js` (cached LLM rewrite + fusion), `verdict.js` (term-coverage check, did NOT work, not for use). Test sets: `lab/queries/author_queries_2026-10-29.json` (30 questions), vault labels and grades in `lab/queries/author_grades_keyword_2026-10-29.json`, quiz grades in `quiz_seeds_grades_2026-10-29.json` (8 of 27 graded).
  - Result: keyword answered 2 of 30; embeddings and the rewrite fixed several vocabulary-mismatch cases; fused search with a top-10 grouped by note is the recommended default. "Nothing here" is not solved (rewrite-leg similarity AUC 0.78 on 30 questions; cutoff 0.50 was set after the data). Open: validate on fresh questions; key-concept check from the same cached LLM call; reranker; qwen3-embedding and bge-m3 on the same sets; synthetic-paraphrase set (never built); C3 build. LLM spend for the rewrite test: $0.0099 (ledger `out/spend.jsonl`).
- C3 Semantic leg of search, "More like this", the Auto / Keywords / Meaning switch and the degradation ladder (hybrid, keywords only, in-memory floor).
  - **C3 first build DONE 29 Oct 2026** (uncommitted; tests 235/235 on device). Muse now has a results page (`#/search?q=`; Enter in the top box submits, last suggestion row is "Search the notes for ..."). Fused top 10 (question + AI-rewrite + words, RRF) grouped by note, max 2 per note. Banner from the rewrite-leg similarity: >=0.50 "Closest matches", 0.40-0.50 "Weak matches", <0.40 "Nothing close in the vault" (facts folded away); no rewrite -> "not rated". Cutoffs live in `lib/search_core.js` BANDS. Switch label: **"Search by meaning"** (on = embeddings + one cheap AI call per new question; off = words only); remembered per browser, `meaning=off` in the URL. Degradation ladder with plain-language notices and a circuit breaker; `/api/search` needs an `X-Muse: 1` header (a cross-site page cannot send it) and a daily rewrite cap ($0.25, `MUSE_REWRITE_MAX_USD_DAY`). `MUSE_MEANING=off` removes the meaning leg. Held-out validation: AUC 0.952 on 13 fresh questions, pooled 0.849 (n=43; CI 0.70-0.96); at 0.50 kept 12/18 answerable, passed 2/25 unanswerable.
  - New files: `lib/search_core.js`, `search_embed.js`, `search_vectors.js`, `search_cache.js`, `search_rewrite.js`, `search_service.js`; `code/search_build.js` (builds `search-vectors-<model>.{f32,json}` beside vault.db, reusing the lab embedding cache); `code/lab/search_check.js` (runs the 43 questions through the real service); UI `muse_ui/js/views/search.mjs`, `js/prefs.mjs`, `css/search.css`; `test/search_service.test.js`. Derived/gitignored: `search-vectors-*`, `muse-cache.db`. Edited: `muse_server.js`, `muse_app.js`, `api.mjs`, `router.mjs`, `crumbs.mjs`, `main.mjs`, `components/search.mjs`, `index.html`, `.gitignore`.
  - **Muse mode 2, Stick, built 30 Oct 2026** (uncommitted): `#/stick?id=<fact>`; `model.stick()` and `stickRandom()` in `lib/muse_model.js`, `/api/stick`, `views/stick.mjs`. Hold one fact, see its hooks that join other notes (2 to 60 notes), grouped by type and rarest first, up to 5 facts per hook from OTHER notes, "too common" hooks (60+ notes) named but not expanded; Keep/Dull work per hook; "Stick" button on every fact and search result; "Surprise me" picks a fact with 3+ hooks. Tests 236/238 (2 not run, none failing).
  - **Stick shelves, Grab and Picked up built 30 Oct 2026** (uncommitted): the Stick page now offers shelves (Veins 2,876; Some grip 25,729; Lone facts 26,432; Loops 1,594; Yours = kept + recently held), kind chips on the hook shelves, Shuffle with a seed on the two big shelves (short fragments left out), Grab on every fact, Pick up and a Picked up tray with a link line between neighbours, Copy cluster. Held back by the author: arrow-key navigation, kind chips on Lone, find-nearby-by-meaning. Not yet built from the agreed list: far-apart badge, per-shelf logging, tray persistence across refresh. Reflection (self-inspection queue) is specified in the Muse Design note; nothing built.
  - To do after trying it: run `search_check.js` on the Mac; Keep/Dull on search results (marks are handle-based, skipped in v1); key-concept check; reranker.

**D. Heuristic gaps** (registry: `code/data/heuristics.json`)
- D1 DONE: G1 day-level dates (heuristic 3).
- D2 G4 string layer (8 heuristics, deterministic). D3 G6 list and table look. D4 G3 loose-hook classes (after C2). D5 G2 relation pass (needs the author's go; est. cost to be set from a pilot on about 50 notes).

**E. UI release 2**: keyboard list navigation, command palette, select-to-search in notes, named boards, compare view, and the sense split for multi-sense handles (through the LLM judge).

## Next (execution checklist, in order)
1. **Heuristics into spark-making (H1-H7 in the vault note `QUARRY - Muse Design`, section "The heuristics are the spec"). H1 and H2 DONE 28 Oct** (registry `code/data/heuristics.json`; analysis in vault note `QUARRY - Heuristics Gap Analysis`); next per that note: string layer (G4/H3), day-level dates (G1: DONE 29 Oct, `code/lib/daydates.js`, `day` hooks in muse_model; 1,052 of 56,559 nug-v6 burrs carry one, 20 exact dates shared across notes), list/table look (G6), loose-hook classes (G3), then the relation pass (G2, needs the author's go). Registry of the 71 heuristics as data; gap analysis against nug-v6; detectors for the [SQL] and [STR] ones; spark cards and the judge carry the link class; quiz items tagged with heuristic ids for per-heuristic recall; author feedback adjusts weights per heuristic. Decision 28 Oct: do both relation routes, (a) relation hooks at extraction as the main investment, (b) the judge naming the link class on top.
2. DONE 28 Oct (provisional): vault judge review sample labelled in `code/lab/out/nug-v6/review_sample_labelled.csv` (60 rows). Claude labelled each from the claim text; the author supplied only entity-level worth (would a spark here be wanted). Result: of 40 yes, 14 spark / 17 weak / 5 duplicate / 4 dull (Aghion and Monty Norman were first called duplicates, then corrected to weak: complementary, not restated); of 20 none, 19 right / 1 missed. 9 of 26 yes-verdicts on important entities are sparks (35%), same rate as unimportant ones (5 of 14). Claude's labels share the judge's blind spots, so treat precision as provisional until the author spot-checks. Restatements also sit inside handles labelled by their best bridge (Mappa Mundi twice in 1300, Columbus twice in 1492, Rembrandt born/lived 1606). Next: `lab/restate_check.js` (below), and the 29 important handles with no spark as vault gaps.
   - Restatement check (built 28 Oct, not yet run): word overlap, shared hooks and TF-IDF cannot separate a restatement from a complementary pair (restatements score 0.54-0.65 TF-IDF; so does Wilde's loyal-to/portrait-of pair at 0.58, which is the Wilde spark), and embeddings are cached for only 26% of the judged claims, so a model reads each `yes` handle's claims and proposes groups of restated facts; code verifies. `node code/lab/restate_check.js --dry-run` (est. $0.25 for 1,235 handles, gemini-2.5-flash); real run `--max-usd 1`; output `out/nug-v6/restate_check.jsonl` with status restated / partly / distinct / error. 131 tests passing.
3. Duplicate removal across notes (embedding or string-based) ahead of the judge; stricter rule for 2-note handles, measured on the quiz pairs first.
4. Deterministic filter for header and boilerplate burrs in the production path (lab filter `boiler.js` exists).
5. llm-model-resolver fixes (public library): economy profile must not exclude cheap tiers (`lite`, `haiku`, `mini`); correct Gemini prices; price or exclude the unpriced previews; tests. Then pin `gemini-2.5-flash` explicitly in Quarry.
6. Restate api_budget rows (needs the author's go). Check the xAI console against the grok ledger rows.
7. DONE 28 Oct: `md-vaults/CLAUDE.md` rule narrowed to `knowledge`; repo `CLAUDE.md` created.
8. Open backlog: the 64 notes missing v6 burrs; the clock-time prompt rule.

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
- DONE 27 Oct: v2 adopted and ported as `variantKey` in lib/bristles.js with tests (old rule kept as `variantKeyV1`); 151 groups became 65 on v6, one known bad (Wapping/vaping). Review file: code/lab/out/nug-v6/e1_review_v2.md.

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

## Link judge harness (built and run; see Judge runs above and the Vault judge run below)
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

## Not built yet
See "Next" at the top. Built since: string-level layer is still open (part of H3); link judge harness, quiz backtest tool, boilerplate filter and the vault judge are built (below).

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
Decision 7 (Constitution): quizzes supplied by the author, own or others', are read-only material for patterns and backtests, held in backtest/ (gitignored), never in the burr store or the `knowledge` vault; only the author's own quiz data may be imported into `knowledge`. Design docs have one canonical home, the vault notes listed in the repo CLAUDE.md; the Claude project holds pointer stubs.
Tools: lab/quiz_items.js (pdftotext output -> items), lab/quiz_backtest.js build|score|judge, lab/nug_bakeoff.js (model bake-off), llm opts.model pin.
Data: 332 items from nine sources (3 PDFs, 6 pptx; text layer only); 1,384 burrs from 313 items; build cost about $0.41.
Results: AUC vs random: tfidf 0.80, embeddinggemma 0.91, qwen3 0.90, bge-m3 0.90; vs hook-sharing cross-item pairs all about 0.2 (embeddings do not separate coincident handles). Judge (v2, 120 pairs all sharing a hook): same-item yes 37/none 19/held 4; cross-item yes 3 (all header-boilerplate burrs)/none 57; P(link|yes) 0.93, recall 0.62, $0.043. Flash-Lite bake-off: hooks per burr 1.27 vs 1.86, 529 over_cap rejects; keep Flash for nuggetize.
Hook sharing: only 33.9% of same-item pairs (956 of 2,818) share a usable hook; 70.0% of items have at least one sharing pair; 22.6% are fully connected. This is the basis for route (a), relation hooks at extraction.
Caveats: n=120, one run, one seed; same-item truth is noisy; hook-sharing precondition built into the sample. Judge recall 0.62 is a floor: the misses are mostly defensible none under the contract (restatements, same-world facts, a bridge hidden in the masked answer). Flash-Lite bake-off cost shown ($0.081) is likely overstated (lab prices Lite at the Flash floor).
Open: api_budget restatement; xAI ledger check (the filter and the vault cost question are done, see below).

## Wordplay in names (heuristics 47, 49, 50, 51, 58, 59, 60, 69; built 28 Oct, no model)
- `lib/wordplay.js` (pure detectors, 7 tests) and `lab/wordplay_scan.js` (`node --no-warnings code/lab/wordplay_scan.js --db eval.db` -> `lab/out/nug-v6/wordplay_scan.json`). Reads entity/place/material hook values with their category (stored as `cat`, not `category`) and the claims.
- Found on 33,062 names / 55,550 burrs, with precision read off a 15-30 item sample per detector (the author's taste not yet applied):
  - number/colour/material in names (47): 21 sets of 3+ names, e.g. Black Sea / Red Sea / Yellow River; Boston Red Sox / White Sox / Pink Floyd; Four Seasons / Cambridge Five / BBC One. Mostly sensible.
  - numbers in work titles (60): 42, about half real (1Q84, Love of 3 Oranges, 12 Years a Slave, K297, 42-Line Bible); the rest are style guides, dates, section numbers.
  - one letter off (49): 142 single-word pairs, 55 with a changed first letter (Murano/Burano, monkey/donkey, Siberia/Iberia, Bangalore/Mangalore, Durban/turban); about 85% good in a sample of 7. The other 87 are mostly spelling variants (Naypyidaw/Naypyitaw).
  - anagrams (58): 183 pairs, nearly all real (Koran/Akron, Instagram/Gram stain, Andes/Sedan, parrot/raptor); how interesting varies.
  - shared word closing different names (50): 147 groups; about a third real, mostly non-English morphemes (Tepe, Yatra, Wada, Sutra, Mela, Samaj, Sabha, Samhita); the rest are English nouns (Airlines, Laboratories).
  - same phrase across different kinds of thing (59): 73 groups, no clean example yet (Pavilion, Creek, Bazaar); needs the judge.
  - acronym with its expansion in the claim (51): 114, every expansion correct, but only 2 are words (SURF, SNAP); pun-titles, rhyme titles and idiom puns need a model, not built.
  - cryptic round (69): enough items for a round of 8 in anagrams and one-letter-off pairs.
- More kinds added the same day (the first eight were only the string heuristics; quiz wordplay is wider), all text-only, hand-checked on samples: anagram of an everyday word 209; reads backwards as a word or name 29 (Zeus/Suez, Camus/sumac, Devil/lived); palindromes 8 (Malayalam, Tenet); name with a number/colour/body-part/animal hidden inside 56 (Northumbria > thumb, French Indochina > chin, British Airways > hair); name that loses its first or last letter and becomes a word 228 (Spain > pain, Cuba > cub; proper names only, about 60% good); repeated/rhyming/vowel-swap names 62 (Bora Bora, Humpty Dumpty, Hong Kong); alliterative names 994; tautonyms 7 (only 2 true); letter oddities 17; palindrome years 6; sounds like an everyday word 1037 (rough, about a third real; only the one-letter-off ones are listed); digit look-alike titles 8 (1Q84 / 1084 / 1984 / IQ84, from the author's own quiz; needed note titles as a source because the 1084 sits only in the title "Mother of 1084").
- Leads file: `lab/out/nug-v6/wordplay_leads.md` is a generated report (gitignored, rebuilt by the scan, never edited); the design for storing wordplay as a `wordplay_edges` table is in the vault note `QUARRY - Heuristics Gap Analysis` (section "Decision: how wordplay is stored"). Not yet wired into Muse's spark output. Full scan with the pronunciation dictionary takes about 3 s: 164 exact sound-alikes (Wales / whales, Chile / chili, Sun / son), 400 rhyme pairs (noisy: many -ese languages).
- Tried and dropped: names built by joining two other names (ordinary compounds swamp the real ones). Not built: hidden words (needs a dictionary), pun/rhyme/idiom titles (model).
- Gotcha found on the way: the stored hook field is `cat`; reading `category` gave every name the category "other" and made every category-gated detector look broken.

- Rhymes and exact sound-alikes (built 28 Oct, needs the CMU pronouncing dictionary; sandbox cannot download it): `lib/phonetics.js` (homophones: name = everyday word; rhymePairs). Run `curl -L -o code/lab/out/cmudict.dict https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict` then `node --no-warnings code/lab/wordplay_scan.js --db eval.db --cmudict code/lab/out/cmudict.dict`. Not yet run on real data. Pun *fit* (does the sound-alike word relate to the note's topic) is a later embedding step with embeddinggemma / qwen3-embedding:0.6b / bge-m3 via embed_ollama.js, only after the candidates are seen.
- Restate check, 40-handle run (28 Oct, $0.0073): 17 distinct / 8 restated / 15 partly. Hand check of 10 groups: 6 right (Aaron, Ali, Apuan Alps, arithmos, Alcor, 1492), 4 wrong (1730 trees vs painting, 1844 and Abdus Salam grouped complementary facts, 1422 borderline). Prompt needs tightening before the full run.

- Wordplay table built 28 Oct (not yet applied): `lib/wordplay_edges.js` (schema, grades A/B/C), `code/wordplay.js`; `npm run wordplay` reports (4,555 edges), `-- --apply` fills `wordplay_edges` in vault.db (back up first), `-- --undo` clears. `fit` column NULL until the embedding pun-fit step. Muse does not read it yet.
- Restate check v2 (28 Oct, 20 groups hand-checked: 14 right) plus a code filter (2+ shared content words and 15% overlap, applied after the cache so re-checks are free): 18 groups kept, 3 dropped (1501 true; Aaron/Clinton and Bactra false); about 14 of 18 right (remaining wrong: 1422, 1692, agamas, Alfred Vail). Treat output as a flag, not a merge.

- Pun fit (built 28 Oct, not yet run; needs Ollama on the Mac): `code/lab/pun_fit.js` scores 699 word edges (homophone, anagram-of-word, head-tail, hidden-word) as word-to-notes cosine minus the word's average cosine to random notes. `node --no-warnings code/lab/pun_fit.js --db eval.db [--model embeddinggemma|qwen3-embedding:0.6b|bge-m3]`; writes `out/nug-v6/pun_fit.jsonl` and `pun_fit_top.md`; `--apply` fills `wordplay_edges.fit`. First run (embeddinggemma, 699 edges): top was spelling variants (harbour/harbor, gray/grey) because the name's own text was in the context; fixed by masking the name and dropping spelling variants, rerun needed. Untested hypothesis: fit separates on-topic puns from accidents; judge by reading the top 150 and bottom 50.

- Wordplay in Muse (28 Oct): `lib/muse_model.js` reads `wordplay_edges` (A/B pair edges become sparks of type `wordplay`; every edge is in a new Wordplay tab with kind and grade filters; C never a spark). On a copy of vault.db: sparks 3,768 -> 4,198 (+430, one spark per name pair). Apply to the real db with `npm run wordplay -- --apply` (back up first), view with `node code/muse_view.js --version nug-v6`. Pun-fit scoring dropped as a pun finder (embeddings cannot see double meanings); names-that-sound-like-a-phrase parked by the author. Self-sustaining Muse design is in the vault note QUARRY - Muse Design.

- Spark ranking v2 (28 Oct): the old score (rarity x tag distance) was flat (every 2-note spark has equal rarity; distance 1.00 for pairs with no shared tag; untagged pairs scored -1 and sank). Now a sum of readable parts in `sparkParts` (lib/muse_model.js): rarity (x1.5), name shape (proper multi-word +1, lowercase single word -0.5), common-word -1, needs-category -0.3, distance (unknown = neutral 0.5), richness (hooks on both burrs), fact length, restated -0.5, wordplay A +0.8 / B +0.2. Weights are hand-set priors; the viewer shows a 'why ranked' column. NOT validated: on the 49 judged sparks that still exist (43 spark/held, 6 dull) AUC is 0.37 old and 0.37 new, and 6 negatives is too few to mean anything. Next evidence: label about 40 sparks sampled across rank deciles (inline form), then fit the weights.

- Muse app, mode 1 Connect (28 Oct): `npm run muse:app` (code/muse_app.js + muse_app.html, port 3005, read-only). `lib/muse_model.js` gained `handle(id)` and `suggest(q)`; `lib/connect.js` is pure (pick n facts spread over difficulty, order hard/easy/found, reveal-last masks handle in claim, quote and note title, wordplay lead-in line per kind). Other modes are listed as planned. Difficulty is NOT solved: two cheap proxies (mean idf of wording; obscurity of the fact's other hooks) score 0.50 and 0.49-0.54 pairwise agreement against Claude's own reading on 9 handles x 4 facts, and Claude agreed with the author on only 2 of 4 pairs (1 'about equal', 1 disagreement), so difficulty is audience taste; the UI labels the order as a rough guess and lets the author flip it. Multi-sense handles (Mercury) mix senses in one list; sense split is a later Connect feature. Legacy: Muse supersedes the Quarry v2 pipeline (curator, narrator, server, tagger pages); the old code stays frozen until the author is settled in Muse, then lab/, tests and v2 get a cleanup pass (cut experiments that did not make the cut).

## Vault judge run (28 Oct): 4,902 handles judged, lab output only
Handles = folded hook keys carried by 2 to 20 notes (hubs of 21+ skipped), up to 6 burrs one per note, 570 v6 duplicates and boilerplate burrs excluded. Verdicts: yes 1,235, held 1,811, none 1,852, error 4 (one 503, two cited an id not given, one yes citing a single note; all correctly rejected). Cost $1.58 total (first pass hit "prepayment credits depleted" at handle 1,010 and was resumed from cache). Written to `code/lab/out/nug-v6/vault_judge.jsonl`; nothing in vault.db. By handle size, yes: 827 of 1,235 are 2-note handles.
First read of a random 40 yes (Claude's reading, not yet the author's): about 15 clear bridges (Monty Norman and the Bond theme; Ganymede and Jupiter's moon; Big Dipper and Saptarishi; Toulouse-Lautrec and Wilde), about 10 near-duplicates (the Vishakha PIL stated twice; "Utsa" and "Wootz"; Goyal and Bryant), about 15 weak same-entity pairs. 20 random none looked right (namesakes such as Marie, Albert, Durga; hub handles with no bridge). A crude check flags about 150 of the yes as near-duplicates; the true share is probably higher. The quiz test's 0.93 precision does not cover this (see the vault note `QUARRY - Quiz Backtest`).

See also (vault notes in `/Users/prakar/md-vaults/tech-journalling/worklog/2026/`): `QUARRY - Quiz Backtest` (lineage of the quiz sources, findings with sampled data points, what has and has not been applied, and the tuning each undone item would produce); `QUARRY - Heuristics Commons` (the 71 link types and patterns); `QUARRY - Heuristics Illustrations` (per-example sources; tech-journalling only); `QUARRY - Muse Design`, section "The heuristics are the spec" (steps H1-H7). Vault judge review sample: code/lab/out/nug-v6/review_sample.md.

## Built (118 tests passing)
data.js, metrics.js, sim.js, embed_ollama.js, e2_bakeoff.js, e1_fold.js, fold2.js, knot_sense.js, judge_spec.js, judge.js, nug_bakeoff.js, quiz_items.js, quiz_backtest.js, boiler.js, vault_judge.js, test/budget.test.js, test/lab.test.js.

## Muse app: findable wordplay and marks (28 Oct 2026)
- Search dropdown and the browse-by-kind list are grouped ("Wordplay pairs" / "Names, places and things"); example chips on the empty page.
- Marks on a whole handle (pair or name) or one fact: Keep, Dull, Wrong sense (`code/lib/marks.js`). Saved append-only to `muse-marks.jsonl` beside vault.db (gitignored, override with `MUSE_MARKS`); the vault database is never written.
- Effect: dull / wrong-sense facts leave the set and the next candidate takes the place; kept facts are always in the set; dull handles drop out of search and browse; "show dull ones" reveals them; "★ Kept" lists everything kept.
- Each mark stores the handle kind, wordplay kind, grade, band and note so the marks can later be used to fit spark-ranking weights without further clicking.
- Tests: `test/marks.test.js`, plus a kept/dull case in `test/connect.test.js`. Nothing committed.

## Muse app release 1: interface rebuilt (28 Oct 2026)
- `code/muse_ui/` (static, no build): `css/` (tokens, base, components, layout, views) and `js/` ES modules (dom, icons, store, api, router, paging, crumbs, markdown, kinds, actions, visited, components/, views/, main). Spec: vault note "QUARRY - Muse UI Spec".
- Server split: `code/muse_app.js` (composition) + `code/lib/muse_server.js` (static files, JSON API, CSP, Host check) + `code/lib/note_store.js` (reads the note file from the database path; private notes never served). `MUSE_VAULT_ROOT` falls back to ~/md-vaults/knowledge when the indexed copy is not found.
- Added: kind lists with pager (landmark jumps, go-to, per page), tile and button states (selected, pressed, visited, focus), URL-driven breadcrumbs, Full note drawer (passage highlighted, wikilinks, Obsidian link), basket page, pivot hook chips on facts, undo toasts, reveal-last that withholds title, crumb, chips and Full note.
- `muse_model.js`: `itemOf` now carries `hooks`; wordplay pair rows carry a, b, wp, grade.
- Tests: `test/muse_ui.test.js` (paging, router, crumbs, markdown), `test/muse_server.test.js` (real HTTP with fakes), `test/helpers/muse_fake.js`, plus connect cases. Browser run: headless Chromium against the fake dataset, dark and light, clean.
- Old `code/muse_app.html` removed (superseded). Nothing committed.
