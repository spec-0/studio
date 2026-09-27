# Security

Thank you for helping keep Studio and its users safe.

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use GitHub's private reporting: go to the
[Security tab](https://github.com/spec-0/studio/security) and choose
**Report a vulnerability**, or open
[the form directly](https://github.com/spec-0/studio/security/advisories/new).
Only the maintainers can see the report.

Helpful things to include:

- what the problem is and what someone could do with it
- steps to reproduce, or a small proof of concept
- the Studio version and your operating system

We'll reply as soon as we can, keep you updated while we work on a fix, and
credit you in the advisory if you'd like. Studio is maintained by a small team,
so please give us reasonable time to release a fix before sharing details
publicly.

## What's in scope

Anything in this repository, and especially:

- **Secret handling**: secret environment values reaching disk, history, error
  messages, exported reports or logs, other than through the documented plain-file
  fallback when the OS credential store can't be reached.
- **Update signing**: any way to get Studio to install an update that wasn't
  signed with the project's update key, or to point the updater somewhere else.
- **The web view's security policy**: any way for a spec, a response or a
  bundled library to run script, load remote content, or make network requests
  from the app's window.
- **Requests Studio makes on its own**: any network request you didn't ask for.
- **Certificate checks**: a request that skips certificate verification without
  you having turned that off for that host.
- **Local files**: reading or writing files outside what you picked or Studio's
  own data folder.

Out of scope: the unsigned Windows installer (a known limitation, described in
the [README](README.md#download)), and problems in the APIs you call with Studio.
Problems in the spec0 service itself should go to spec0, not this repository.

## Supported versions

Security fixes go into the latest release. Please update to it (Help or app
menu → *Check for Updates…*) before reporting, if you can.
