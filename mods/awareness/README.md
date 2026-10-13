# awareness — explicit tool-call recipes + two read-only tools

New isolated mod (runs after `mods/infiniteoc`; no edits to existing mods).
It adds exact how-to-call guidance for every custom tool plus two read-only
tools in the spirit of `free_port`:

| Tool | Call | Use |
| --- | --- | --- |
| `project_checks` | `{}` (no input) | Detected `check`/`tests`/`types`/`lint` commands from `package.json` scripts, `Makefile`, `Cargo.toml`, `go.mod` or pytest config. Call before claiming how to build/test/lint; run what it returns instead of guessing. Reads manifest names + scripts only, never `.env` or secrets, never executes. |
| `tool_guide` | `{tool?: name}` or `{}` | Exact input shapes + when-to-use for all 20 custom tools. Call when unsure of a shape; omit `tool` for the full cheat-sheet. Static text, no fs. |

Guidance push (`[Tool awareness]`, ~950 chars) gives the recipes every turn:
`free_port {}` before any listener, `project_checks {}` before build claims,
`env_diff {}` instead of reading `.env`, `repo_map`/`trace_lookup`/`type_lookup`
for orientation, `ui_check`/`design_tokens`/`component_catalog` for UI,
`mutation_check`/`coverage_delta`/`bench_guard`/`/testfirst`/`prune_scan`/`license_check`
for verification. Full shapes live in `tool_guide`, so the prompt stays small.
Both tools are `codemode:false`; they add no permissions and change no behavior.

## Enable (after `/yolo` merges)

This commit adds only `mods/awareness/*` so it merges cleanly with
`feat/yolo` (which touches `infiniteoc.json`, `README.md` and
`mods/safe-guard/*`). It does **not** edit `infiniteoc.json` yet:

```sh
node --test mods/awareness/test.mjs
node bin/infiniteoc.mjs feature check awareness
# after feat/yolo is in main:
node bin/infiniteoc.mjs feature enable awareness
```

`enable` checks first, appends `./mods/awareness/index.mjs` after
`./mods/infiniteoc/index.mjs`, keeps `infiniteoc.json.bak`.
Rollback: `node bin/infiniteoc.mjs feature disable awareness`, then restart.

## Tests

```sh
node --test mods/awareness/test.mjs
```

Pure `detectChecks`/`formatChecks`/`toolGuide` checks, disposable-tree
`applyMods` (writes + both anchors, fail-closed on missing/duplicate marker
and repeat), guidance bounds/permission invariance, and plugin-source safety
(read-only: no exec, writes, or permission grants; never touches `safety.ts`
messages that `/yolo`'s `SAFETY_GATE` regex depends on).
