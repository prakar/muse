# Profiles (packs): using Muse for your own field

Muse is built to surface connections between facts in your own notes. What counts as a fact, what joins two facts, and which patterns are worth looking for differ by field. All of that lives in a **profile** (internally a *pack*): a folder under `packs/`. Everything else (storing notes, search, the Collection, marks, budgets, the faithfulness checks on every extracted fact) is the same for everyone.

A copy of Muse runs **one** profile, named in `muse.yaml` (`pack: quiz`). Muse does not switch profession on the fly: the Profile tab in Admin is where you see which profiles are installed, choose one (it writes `pack:` into `muse.yaml`; you then restart), and read what it takes to add another. Facts already extracted keep the kinds and hooks they were extracted with, so choosing a profile is a decision made when you set a copy up.

Profiles that ship: `quiz` (the default, for writers of quizzes and puzzles) and `general` (a neutral starting point). Anything else is built by someone who knows the field. That is you.

## What you bring
1. **Benchmark material.** Examples of good work in your field that show how facts are linked: for quizzes it was completed quizzes; for a lawyer it might be well-built case summaries or briefs; for a teacher, lessons that connect ideas well. From them you draw a list of **patterns** (heuristics), each with a short name and a sentence on what it is.
2. **A sense of what a "fact" is** in your notes, and what joins two facts (a statute, a party, a date, a term, a misconception).

Muse will not invent these for you. They are the field's own knowledge.

## Steps
1. Create the folder from the neutral profile:  
   `muse pack new lawyer` (or `npm run pack:new -- lawyer`)  
   (any lowercase name; it should match the occupation it serves).
2. Edit `packs/<name>/pack.json`:
   - `description`: one sentence on who it is for.
   - `extraction`: the kinds of fact (`kinds`), the hook types that join facts (`hooks.strict`: checked word for word against the note; `hooks.loose`: topics), the categories for names, how many facts per note (`caps`), and `promptVersion` (give it its own, e.g. `lawyer-v1`). Core owns the faithfulness rules: a fact must be stated in the note, with its quote, and strict hooks must appear in it. You only supply the vocabulary.
   - `capabilities`: add `"wordplay"` if word and name play is useful in your field (it is general to English).
3. Edit `packs/<name>/vocabulary.json`: the `purpose` line that finishes Help's first sentence, and optionally recipes and features specific to your field.
4. Write your shapes: `lenses.json` says how each pattern is detected (same date, same name for different things, a stated cause, a cue phrase, and so on; the detector types are in `code/lib/lenses.js`), and `shapes.json` lists their ids and names. `glossary.json` gives each a plain definition. Start with the two shapes that come with the neutral profile.
5. Check it:  
   `muse pack check <name>` (or `npm run pack:check -- <name>`)  
   It loads the folder the way Muse does at start-up and names anything wrong, with the file and key.
6. Try it:  set `pack: <name>` in `muse.yaml` (copy `muse.example.yaml` if you have none) and restart Muse. Run extraction on a **copy** of your vault first: extraction costs model calls, and a new profile changes what gets extracted.

## Importing heuristics you already have
A registry is a JSON file `{ "rows": [ { "id": 1, "name": "…" }, … ] }`. Point `lenses.registry` in `pack.json` at it. How you produce it is up to you: by hand, from a spreadsheet, or by asking a model to draft it from your benchmark documents and then reviewing every row yourself. The quiz profile builds its registry from two notes in the author's vault with `packs/quiz/tools/heuristics_build.js`; that tool is specific to quiz and is an example, not a requirement.

## Tests worth running
`npm test` runs the whole suite. `test/pack_profiles.test.js` runs sample teacher, accountant, linguist and lawyer vocabularies through the same checks, so it shows what a profile must satisfy.
