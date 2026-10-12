# Security policy

## Supported

Latest `main` only. Pinned upstream tag is recorded in `infiniteoc.json`.

## Report a vulnerability

Open a GitHub Security Advisory for this repository
(`Security` tab → `Report a vulnerability`), or open a public issue if the
problem is not sensitive. Include steps to reproduce, the pinned upstream
tag, and the output of `infiniteoc doctor`.

Do not include secrets, tokens, or session data in reports.

## Scope notes

- Mods in `mods/` are trusted local JavaScript and are not sandboxed.
  Review a mod before enabling it, and never use untrusted mods with
  secrets available.
- InfiniteOC never weakens OpenCode permission rules or approval
  requirements, and never prints or commits secrets.
- `.upstream/`, `.runtime/`, `.tools/`, and `.opendaemon/` are generated
  and git-ignored; do not commit their contents.
