# Rules for Claude

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing anything. It carries the
definition of done, the two rules that define this app, and the design rationale
behind the constraints — including several that look like they could be relaxed and
can't.

The short version:

- `npm run type-check && npm test && npm run build && npx tauri build` must all pass.
- Everything except opening a spec must work with **no account and no network**.
- Outbound HTTP goes through `src-tauri/src/http.rs`, never `tauri-plugin-http`.
- No secrets stored per API — auth values live in environments as secret variables.
