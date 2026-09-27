# Guide for coding assistants

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything. It has the
checks a change must pass, the two main rules, and the reasons behind the
design rules, including some that look like they could be relaxed but can't.

In short:

- `npm run type-check && npm test && npm run build && npx tauri build` must all pass.
- Everything must work with **no account and no network call to spec0**.
- Outbound HTTP goes through `src-tauri/src/http.rs`, never `tauri-plugin-http`.
- No secrets stored per API. Auth values live in environments, as secret variables.
- Don't commit tokens, private URLs or signing files. This repository is public.
