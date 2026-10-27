# lab — judge & embeddings groundwork

Stage contract (nothing here writes to vault.db or the vault):

    nuggetize (any prompt_version) -> burrs table -> lab/data.js -> sim.js / metrics.js -> experiments

Every lab script takes `--version nug-v6` (default) and `--db <path>` (a COPY made with
`sqlite3 vault.db ".backup eval.db"`; never point at the live DB while nuggetize runs).
Only `data.js` knows the burrs schema. Swapping nug-v5 -> v6 -> v7 changes one flag.

- data.js    loadBurrs(db, version), loadDupes(db, ids), burr text for embedding
- metrics.js AUC, precision@k, recall@k, bootstrap CI
- sim.js     TF-IDF baseline + embedding backend interface + sha(text)+model disk cache
             (unchanged claims are never re-embedded across versions)
Outputs go to lab/out/<version>/ (gitignored).
