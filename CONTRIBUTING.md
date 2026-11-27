# Contributing

Studio is a Tauri v2 app (a Rust shell around a web view) with React 19, TypeScript and Vite. It
ships for macOS, Windows and Linux; the Mac build has had the most use.

## Sending a change

Send changes as a pull request from your fork.

1. Find or open an issue. [Good first issues](https://github.com/spec-0/studio/labels/good%20first%20issue)
   are a good start. For anything bigger than a small fix, say on the issue what you plan before you
   start, so we can agree on the approach.
2. Fork the repository, clone your fork, and make a branch:

   ```bash
   git clone https://github.com/<your-username>/studio.git
   cd studio
   git remote add upstream https://github.com/spec-0/studio.git
   git checkout -b fix-null-drift
   ```

3. Make the change. New logic needs tests. If users will see the change, update the page in
   [docs/user](docs/user/) that describes it.
4. Run [the checks](#the-checks), push the branch to your fork, and open the pull request. Write
   `Closes #123` in it so the issue closes on merge.

To bring your branch up to date with `main`:

```bash
git fetch upstream
git rebase upstream/main
git push --force-with-lease
```

### After you open it

- A maintainer approves CI for your first pull request; later ones run by themselves.
- CI runs the checks below, plus the Rust tests on macOS, Linux and Windows.
- A maintainer reviews it, and may push a small fix if **Allow edits by maintainers** is ticked.
- It's squash-merged, so the title and description become the commit message, and it ships in the
  next release. If there's been no reply for a week, comment on it.

## Setting up

You need:

- **Node.js 24**, the version in [`.nvmrc`](.nvmrc) and the one CI uses. 22.12 is the oldest that
  works.
- **Rust 1.90 or later**, installed with [rustup](https://rustup.rs).
- **The system libraries Tauri needs**, listed on Tauri's
  [prerequisites page](https://v2.tauri.app/start/prerequisites/): the Xcode Command Line Tools on
  macOS, the Microsoft C++ Build Tools and WebView2 on Windows, WebKitGTK 4.1 and a few build
  packages on Linux.

Then:

```bash
npm ci        # install dependencies
npm run app   # build and open Studio, reloading as you edit
```

The first `npm run app` compiles the Rust side and takes a few minutes.

`npm run dev` opens the interface in a browser, which is useful for styling. Requests to other
sites fail there on CORS; test requests in `npm run app`.

A development build uses the same settings and library as an installed Studio. If you also use
Studio day to day, give the development build its own name and link scheme:

```bash
npm run app -- --config '{"identifier":"io.spec0.studio.dev","productName":"Studio Dev","plugins":{"deep-link":{"desktop":{"schemes":["spec0-dev"]}}}}'
```

## The checks

All four must pass:

```bash
npm run type-check          # TypeScript
npm test                    # unit tests (vitest)
npm run build               # production build of the interface
npx tauri build             # the Rust shell and the app
```

CI also runs:

```bash
npm run test:csp            # the built app in Chrome under its real content security policy
cd src-tauri && cargo test  # the Rust tests
```

`test:csp` exists because unit tests run in Node, which has no content security policy. Code the
app's policy blocks (a library that uses `eval`, for example) can pass every unit test and still
fail in the app.

For interface changes, also try the feature in `npm run app`. For changes to the user guide, run
`npm run check:docs`.

## The two main rules

1. **Everything works without an account.** Opening specs, sending and checking requests,
   environments, history, collections, local mocks and the MCP server need no sign-in and no
   network call to Spec0. ([Design rule 2](docs/design-rules.md#2-everything-works-without-an-account))
2. **Requests go out through Rust, with no `Origin` header.** Outbound HTTP goes through
   `src-tauri/src/http.rs`, never `tauri-plugin-http`.
   ([Design rule 3](docs/design-rules.md#3-requests-go-out-through-rust-with-no-origin-header))

## Where to read next

- [ARCHITECTURE.md](ARCHITECTURE.md): where the code is, and how a request, an MCP call and a
  local mock pass through it.
- [docs/design-rules.md](docs/design-rules.md): the rules the code follows, and why. Read the ones
  near your change before you start.
- [docs/user/README.md](docs/user/README.md): how to write and preview the user guide, published
  at [studio-docs.spec0.io](https://studio-docs.spec0.io/).

## Bugs, ideas and security

- Questions and ideas go in [Discussions](https://github.com/spec-0/studio/discussions).
- For a bug, [open an issue](https://github.com/spec-0/studio/issues/new/choose) with your
  operating system, the Studio version, what you did, what you expected and what happened. A small
  spec that shows the problem helps. Remove tokens and private URLs first.
- Report security problems privately, as [SECURITY.md](SECURITY.md) describes.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing, you agree that your contribution is licensed under the [MIT licence](LICENSE).
