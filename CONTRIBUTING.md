# Contributing

Muse is a core engine plus swappable profiles (`packs/<name>`). Improvements to the core are welcome; a profile for your own field belongs in your own fork or repo (Muse ships only `quiz` and the neutral `general`).

- Run `npm test` and `node code/muse_map_check.js --all` before sending a change. Both must pass.
- The quiz profile's behaviour is frozen by snapshot tests (`test/behaviour_snapshot.test.js`). A change that alters it on purpose must say so and update the snapshot.
- Core code must not name a profession. `test/pack_leak.test.js` counts quiz words in core and the count may only go down.
- Anything that spends money on an LLM needs a `--dry-run` and goes through `code/lib/llm.js`.
- Derived data (the heuristic registry, the Muse map) is generated or checked by a test; do not hand-edit generated files.
