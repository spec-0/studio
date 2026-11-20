# Guide for coding assistants

Checks. All four must pass:

```bash
npm run type-check && npm test && npm run build && npx tauri build
```

Hard rules:

- Everything works with no account and no network call to spec0.
- Outbound HTTP goes through `src-tauri/src/http.rs`, never `tauri-plugin-http`.
- No secrets stored per API. Auth values live in environments, as secret variables.
- Don't commit tokens, private URLs or signing files. This repository is public.
- No AI attribution in commit messages or pull requests. CI rejects it.

Read next:

- [CONTRIBUTING.md](CONTRIBUTING.md): setup and how to send a change.
- [ARCHITECTURE.md](ARCHITECTURE.md): where code goes. A new file in `src/lib` or `src-tauri/src`
  needs a line there.
- [docs/design-rules.md](docs/design-rules.md): the rules and why, including some that look like
  they could be relaxed but can't.
