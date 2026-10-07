---
name: infiniteoc-mod-development
description: Create, modify, test, debug, install, or remove InfiniteOC mods. Use for InfiniteOC launcher extensions, OpenCode source patches, TUI components, themes, agent presentation and workflow, settings dialogs, and launch/exit hooks. This is the local source-mod framework, not the normal OpenCode plugin API.
metadata:
  opencode:
    autoinvoke: false
---

# InfiniteOC mod development

Build the requested mod, not just a proposal. Respect explicit plan-only requests. Inspect the installed framework and pinned source before editing; this document describes the current local implementation, not a universal OpenCode API.

## Locate and inspect

The current installation is `/home/rize/InfiniteOC`. If moved, locate its `infiniteoc.json`, `src/mod-loader.mjs`, and `bin/infiniteoc.mjs`; do not assume the current working directory is the launcher root.

Read these together, using targeted ranges where possible:

- `infiniteoc.json`: exact upstream pin, ordered mods, shared options.
- `src/mod-loader.mjs`: authoritative file API and hooks.
- `src/launcher.mjs`: source preparation, fingerprint/cache, build, launch, isolation.
- `mods/infiniteoc/index.mjs` and the smallest relevant supporting file: existing patches and collision risks.
- `package.json`, relevant tests, and the target upstream file.

`.upstream` is the pristine pinned source. `.runtime/opencode` is generated, patched build output. Never implement persistent changes by editing either tree directly. Write a source mod in `mods/<unique-id>/index.mjs` and, when installation is requested, append its path to `infiniteoc.json.mods` without replacing existing entries or options.

## Choose the smallest mechanism

1. Use an existing OpenCode configuration option when it fully solves the request; distinguish configuration from a source mod.
2. Use a launch hook for launcher args/environment changes.
3. Use `api.patch` for targeted internal changes or `api.write` for new source/assets.
4. Use SolidJS/OpenTUI for this terminal UI, not React/DOM assumptions. Match existing imports, renderables, event APIs, and provider context. Use only dependencies confirmed in the pinned workspace.

Read [references/mod-api.md](references/mod-api.md) before implementing. Read [references/testing.md](references/testing.md) for the regression-test pattern and build validation. Use `scripts/check-mod.mjs` for safe disposable application checks. Do not invent APIs, supported platforms, or hooks.

## Implement safely

- Default export `{ id, async setup(api) }`; optional `version`, `beforeLaunch`, and `afterExit`. Use a unique ID matching `/^[a-z0-9][a-z0-9._-]*$/i`.
- Every file API path is relative to the supplied source root, with no absolute paths or traversal. In filesystem/shell tools outside that API, use absolute paths.
- Patch the incoming source, not a fresh upstream copy: earlier mods have already changed it. Require an exact, unique anchor and throw on mismatch. Never silently skip incompatible upstream or ambiguous matches.
- `api.patch` rejects unchanged output. An idempotent replacement helper alone does not make repeated application through the loader valid. Rebuild starts from pristine upstream; test the actual behavior rather than claiming arbitrary repeatability.
- Source transforms should have no external effects. `setup` runs again on cached launches to register hooks: in register-only mode `write` and `patch` are skipped, but ordinary setup code still executes. Do not require transforms to run to initialize hook state.
- Preserve configured provider/auth data, routing, permission/approval rules, custom agent prompts, and ordinary OpenCode installations. Source mods are trusted code, not a sandbox. Do not download/execute remote code, expose secrets, or add dependencies without a concrete need and authorization.
- Append workflow instructions only once with a marker; do not replace the user's prompt. Preserve hidden/subagent semantics and actual permission restrictions when changing agent presentation.
- Clean up timers, servers, sockets, listeners, and temporary resources, including error paths. Never mutate launcher-global `process.env` when a hook can update `context.env`.

## Work efficiently

Batch independent reads/searches; delegate bounded implementation or tests with clear non-overlapping file ownership. Keep mod application and conflicting shared-file edits sequential. Do not concurrently run rebuild/setup, or tests that depend on a changing generated tree. Continue the critical path while independent workers run and verify their results yourself.

## Validate and deliver

1. Add Node `node:test` regression tests using disposable source copies. Cover successful change, missing/duplicate anchors, preservation of unrelated configuration, and hooks on cached launches where relevant.
2. Run syntax checks and disposable application, then the existing test suite. Never test patches against the live pristine checkout.
3. If authorized, enable the mod by appending its relative path after backing up `infiniteoc.json`. Never enable the example smoke fixture.
4. Run `node /home/rize/InfiniteOC/bin/infiniteoc.mjs rebuild`, wait for exit, and inspect the build log and `.runtime/build.json`. Do not delete an active `prepare.lock`; first determine whether its process is alive.
5. Smoke-test the actual changed behavior: render/interact with TUI changes in a terminal; check server APIs for registry/config changes; check args/environment via an isolated child for hooks. A clean build alone is not functional proof. Do not send paid model requests or change credentials just to test UI.
6. Explain what changed, installed mod path/order, verified checks, limitations, and restart requirements. Rollback: restore the backed-up mods list or remove only the added entry, then rebuild. Generated runtime files are disposable; user configuration is not.

An added source mod requires rebuilding and restarting; it does not hot-patch the already-running binary. Linux x64 is the current launcher-supported target. Confirm version and capability from local files on each task.