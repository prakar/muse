# Muse (Quarry)

Muse sits on top of a folder of markdown notes (an Obsidian vault, a research folder, case files). It never edits your notes. It reads them once, breaks each into small, cited statements, tags each statement with the names, dates, places and numbers it mentions, and keeps all of that in a local SQLite file. Then you can search the statements, pull ones from different notes into a working pile, see where they meet, and write down in your own words how they connect. Muse never writes the conclusion for you.

What it extracts and how it speaks come from a **profile** (a folder under `packs/`). The profile that ships as the default, `quiz`, is for people who write quizzes. A neutral `general` profile is included as a starting point. Muse ships no other professions: if you are a lawyer, teacher, linguist or accountant, you build your own profile for your field; [PACKS.md](PACKS.md) is the guide.

## What you need

- Node.js 22.13 or newer (developed on Node 24; `mise.toml` pins it if you use [mise](https://mise.jdx.dev)).
- A folder of markdown notes.
- For extraction (turning notes into statements): an API key for one provider: `GEMINI_API_KEY` (default), `ANTHROPIC_API_KEY`, `XAI_API_KEY` or `OPENROUTER_API_KEY`. Extraction costs money; every command that spends says so and has a `--dry-run`. A hard ceiling applies (`BUDGET_CEILING_USD`, default 10).
- Optional: a local embedding server (Ollama with `embeddinggemma`) for meaning-based search. Muse works without it.

## Quick start

```sh
git clone https://github.com/prakar/quarry.git
cd quarry
npm install

export QUARRY_HOME="$PWD"                 # where vault.db and logs live
export VAULT_PATH="$HOME/path/to/notes"   # your notes folder (read only)
export GEMINI_API_KEY=...                 # or another provider's key

npm run migrate -- --run                  # create the database
npm run index                             # read your notes into it
npm run nuggetize -- --dry-run            # how many notes, estimated cost, nothing spent
npm run nuggetize -- --limit 20           # extract 20 notes (cents)
npm run muse:app                          # then open http://localhost:3005
```

Run `npm run nuggetize -- --all` when you are happy with the trial. It is resumable. Everything else (the Admin page, tagging, wordplay, search index) is reachable from the app's Admin page or listed with `npm run ops -- list`.

## Configuration

On first start Muse writes `muse.yaml` in the repo folder (git-ignored). `muse.example.yaml` documents every key:

| Key | Meaning |
|---|---|
| `pack` | the profile to run (a folder under `packs/`). Switch it from Admin > Profile, then restart. |
| `host` | where Muse listens. Default `127.0.0.1` (this machine only). |
| `notes_dir` | folder holding the quiz profile's source notes for its registry builder (only needed for `npm run heuristics`). |

Environment variables win over `muse.yaml`: `MUSE_PACK`, `MUSE_HOST`, `QUARRY_VAULT_NOTES`. Other knobs are named in `code/lib/commands.js` (the same catalogue the Admin page shows).

## Profiles

`packs/quiz` is the author's own: facts worth building a question around, hooks for wordplay and etymology, and a set of 71 quiz-setting shapes. `packs/general` is neutral. To build one for your field:

```sh
npm run pack:new -- lawyer      # copies the neutral profile to packs/lawyer
npm run pack:check -- lawyer    # loads it the way Muse does and names anything wrong
```

Then set `pack: lawyer` in `muse.yaml` (or use Admin > Profile) and restart. Read [PACKS.md](PACKS.md) first: a profile decides what counts as a fact, which hooks link notes, and what the screens say. Re-extract on a copy of your database when you change profile.

## Network and privacy

Muse listens on this machine only by default. To reach it from other machines set `host: 0.0.0.0`; reading is then open to anyone who can reach the port, and Admin and anything that writes need a login (`node code/muse_set_password.js`). Use https (`MUSE_TLS_KEY`, `MUSE_TLS_CERT`) or a private network before exposing it. Notes marked private (`quarry_exclude`) never reach the model or the search index. The database, marks and caches stay on your machine; `.env*` and `muse.yaml` are git-ignored. See [SECURITY.md](SECURITY.md).

## Tests

```sh
npm test
```

Two tests need the author's design notes and skip without them. The Muse map check (`node code/muse_map_check.js --all`) audits every profile's screens against the code.

## Licence

MIT. See [LICENSE](LICENSE). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
