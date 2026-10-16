# crash-guard

Keeps one dangling `{file:...}` reference in `opencode.json` from crash-looping the backend.

## Why

Upstream `ConfigVariable.substitute` fails `Config.load` with `ConfigInvalidError`
when any `{file:...}` token points at a missing file, and `Config.load` wraps
file loads in `Effect.orDie`. Every API endpoint then answers 500 and
`serve --stdio` exits with `UnexpectedStatus: 500`. This hits any device whose
config references key files that are not there: a second device, synced dotfiles,
a deleted `~/.config/infiniteoc/keys` dir, or a shared config. `{env:...}` never
crashes (missing vars become `""`), so only `{file:}` is handled.

## What it does

On every launch (`beforeLaunch`, fail-open so config trouble never blocks you):

1. Reads `OPENCODE_CONFIG` (or `~/.config/opencode/opencode.json` plus its
   `.jsonc` sibling, the files upstream loads).
2. If a strict-JSON file has `{file:...}` refs to missing files inside
   `providers.*` or `mcp` servers, it writes a `0600` backup
   (`opencode.json.<timestamp>-crash-guard.bak`), drops exactly those entries,
   and posts a startup notice naming them and the backup.
3. Anything it cannot safely rewrite (JSONC, unparseable files, refs outside
   provider/server subtrees) is warn-only: notice, no write.

Healthy configs are untouched and silent. Notices never include secrets, only paths.

## Rollback

Re-add the removed provider/MCP server (its secret goes back to a `0600` key
file), or restore the backup over `opencode.json`. Disable with
`infiniteoc feature disable crash-guard`.
