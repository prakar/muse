# Security

Muse is a local tool for your own notes. It is not hardened for the open internet.

- Default: listens on 127.0.0.1 only. Opening it (`host: 0.0.0.0` in `muse.yaml`, or `MUSE_HOST`) makes reading open to the network; Admin and writes need the login from `node code/muse_set_password.js`. Put it behind https or a private network.
- Your API keys live in environment variables or a git-ignored `.env` beside the database. Never commit them.
- Notes flagged `quarry_exclude` are kept out of the model and the search index.
- Extraction sends note text to the LLM provider you choose. Pick the provider with that in mind.

Found a vulnerability? Please open a private security advisory on the GitHub repository rather than a public issue.
