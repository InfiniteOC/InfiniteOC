# AI-friendly feature development

**Live updates:** `opendaemon` now watches trusted local mod files and reloads
declared ctx-only TUI commands without restarting the UI/backend. It also exposes
notifications, tab control and actual reload/client-acknowledgement progress.
See `/home/rize/InfiniteOC/OPENDAEMON.md`. Compiled source/backend changes still
need rebuild/restart; auto reload does not download remote updates.

New local TUI slash commands no longer need hand-written upstream registry
patches: use `api.tui.command` with a typed Solid/OpenTUI handler.

```sh
node /home/rize/InfiniteOC/bin/infiniteoc.mjs feature new my-feature
node /home/rize/InfiniteOC/bin/infiniteoc.mjs feature check my-feature
```

Scaffolding does not enable mods. See `/home/rize/InfiniteOC/FEATURES.md` for the
API contract, examples, checks and build/restart instructions; `AGENTS.md` gives
AI coding agents the entry point. The repaired `/clearall` uses this API to close
all open tabs in the current scope **without deleting conversations or stopping
running tasks**. Reopen saved sessions with `/sessions`.

# InfiniteOC

## Efficient workflow

Three locally authored skills are available in `/home/rize/.config/opencode/skill-library` and registered with the auto-router:

- `infiniteoc-mod-development`: the actual mod API, safe source patches/hooks, disposable checker, regression tests, rebuilds, and rollback.
- `plain-human-writing`: direct, short replies based on the user's preference and a reviewed Wikipedia writing-pattern guide; no detector-evasion claims.
- `efficient-tool-use`: targeted reads/searches, safe parallel work, bounded delegation, process tracking, and proportionate verification.

Concise replies and command efficiency are also always-on in the unified agent workflow and local `AGENTS.md`. Longer requested explanations and complete artifacts take priority. These are model instructions, not enforced word limits or new permissions. Restart into a fresh session to pick up rebuilt agent instructions.

The unified agent preserves your configured system prompt and appends bounded delegation and parallel-execution guidance. It batches independent reads/searches, uses configured subagents for substantial separable work (normally two workers), and permits concurrent edits only with non-overlapping ownership. Dependent actions and shared-state operations stay sequential; the primary agent integrates and verifies the result. This is model guidance, not a scheduler or new tool permission: actual concurrency depends on the model and available task/tool APIs.

The local OpenCode skill library includes Impeccable and the six Anti Slop skills, registered in your existing auto-route catalog. Existing provider, model, permission, command, and plugin settings were not changed. Skills are selected by task, not all injected on every turn.

## InfiniteOC Settings

Open `/settings` → **InfiniteOC Settings**:

- **Traffic**: inherit your proxy environment (default), direct, HTTP/HTTPS/SOCKS5 proxy, or Tor. Tor uses an already-running SOCKS listener, default `127.0.0.1:9050`; this does not install or start Tor. SOCKS routing uses a local HTTP bridge with destination DNS passed to the SOCKS server. Local OpenCode control traffic always bypasses the proxy. Additional bypass hosts can be configured. Restart InfiniteOC after saving.
- **Providers**: guided Anthropic Messages, OpenAI Chat Completions, or OpenAI Responses setup. Enter a unique provider ID, API base URL (including `/v1` where required), exact model IDs, and either a masked API key, an environment-variable name, or no key for local unauthenticated endpoints. Restart, then select the new model.

Provider setup preserves existing OpenCode configuration and writes a restricted-permission backup before editing. Raw API keys are stored separately in mode-600 files and referenced from config; they are not encrypted. Environment-variable references are recommended. Strict JSON is required; JSONC/commented configurations are deliberately not rewritten. Existing provider IDs are never overwritten.

Traffic preferences live at `/home/rize/.config/infiniteoc/settings.json` (override with `INFINITEOC_SETTINGS_FILE`). Provider configuration uses `OPENCODE_CONFIG`, or your XDG OpenCode `opencode.json`. The InfiniteOC agent accent is lavender-purple (`#c084fc`).

**Routing is not an anonymity sandbox:** plugins, tools, child processes, custom transports, and explicit proxy overrides may ignore environment proxy settings. Tor mode does not guarantee all-process anonymity. The bridge returns an error if SOCKS is unavailable; it does not fall back to a direct connection.

A local, source-backed OpenCode launcher and mod framework, pinned to **OpenCode
v2.0.21**. It copies upstream into a disposable worktree, applies trusted JavaScript
source mods, builds a separate CLI/TUI binary, and launches it without replacing
your installed stock OpenCode.

The bundled mod adds a purple/pink theme, an animated InfiniteOC terminal logo,
and an InfiniteOC primary-agent name and unified reasoning/planning/implementation
instruction appended to the existing prompt. The upstream `build` agent ID and
subagents remain intact; the legacy Plan primary is hidden from selection while
its restrictions are preserved. InfiniteOC is the only visible primary and the
default; other primary agents such as Quick remain stored but hidden. This is
branding and conversational guidance, not a new model or a guarantee of improved
intelligence. Model quality still depends on your chosen provider/model and task.
No permission rules or approval requirements are weakened.

## Requirements and setup

The initial launcher supports **Linux x64**. Use Node.js **22 or newer**, npm,
Git, an Internet connection for the first setup, and sufficient disk space for
the upstream source, dependencies, and build. Provider credentials are still
required to use models. Other operating systems/architectures are not supported
by this launcher's hard-coded artifact path.

From this checkout, use its absolute root so commands work from any directory:

```sh
ROOT=/home/rize/InfiniteOC  # change to the absolute path of your checkout
node "$ROOT/bin/infiniteoc.mjs" mods
node "$ROOT/bin/infiniteoc.mjs" setup
node "$ROOT/bin/infiniteoc.mjs" --version

# Open a project with the modded TUI
node "$ROOT/bin/infiniteoc.mjs" /absolute/path/to/project
# Or open the current working directory
node "$ROOT/bin/infiniteoc.mjs"
```

Setup installs pinned Bun **1.4.2** locally under `.tools/`, clones the configured
upstream tag into `.upstream/`, and copies source into `.runtime/opencode/`.
It runs `bun install --frozen-lockfile` in that copy, then builds from
`packages/cli/` with:

```sh
# These are the equivalent manual build commands AFTER mods have been applied.
# Normally use `setup` instead, so patches, cache, and manifest are managed.
ROOT=/home/rize/InfiniteOC
export PATH="$ROOT/.tools/node_modules/.bin:$PATH"
export HUSKY=0 OPENCODE_CHANNEL=infiniteoc OPENCODE_VERSION=2.0.21-infiniteoc
cd "$ROOT/.runtime/opencode"
bun install --frozen-lockfile
cd packages/cli
bun run script/build.ts --single --skip-install --skip-web-ui
```

The expected artifact is
`.runtime/opencode/packages/cli/dist/cli-linux-x64/bin/opencode`.
**No web UI bundle is built**; this project targets the CLI and terminal UI.
Building requires upstream dependencies and may take a while. The source tests
below do not establish that a compiled binary or interactive TUI works.

## Commands and local state

| Command | Purpose |
| --- | --- |
| `node "$ROOT/bin/infiniteoc.mjs" help` | Show launcher help. |
| `node "$ROOT/bin/infiniteoc.mjs" setup` | Prepare/build, reusing a matching cached binary. |
| `node "$ROOT/bin/infiniteoc.mjs" rebuild` | Recreate the worktree from pristine upstream, reapply mods, and rebuild. |
| `node "$ROOT/bin/infiniteoc.mjs" mods` | Import and list configured mods. |
| `node "$ROOT/bin/infiniteoc.mjs" doctor` | Bootstrap/check pinned source and tools; may download them. |
| `node "$ROOT/bin/infiniteoc.mjs" -- [args]` | Forward arguments to OpenCode (escape launcher command names). |

`npm run setup`, `npm start -- [args]`, and `npm test` also work from the
repository root. A launch prepares the build automatically when needed.
Settings, framework source, and mod-directory contents contribute to the build
cache key. `.runtime/build.json` records the upstream tag, enabled mod IDs,
and source changes. Do not edit `.runtime/opencode` as persistent source:
rebuild deletes that tree. Edit mods instead. If setup crashed and left
`.runtime/prepare.lock`, confirm no setup is running before removing the lock.

The launcher leaves `.upstream` and the stock installed executable unpatched.
It refuses a checkout whose package version differs from the exact configured
tag; it does not destructively update an existing checkout. Upgrading requires
reviewing patch anchors against the new version and arranging a matching source
checkout, not merely assuming old mods remain compatible.

### Stock configuration/auth and the private server

The launcher retains the normal home/environment and does not rewrite or replace
your stock OpenCode configuration or authentication files. Your existing provider
settings, credentials, user agents, permissions, and explicit theme selection
continue to be used, subject to the bundled primary-agent branding/default changes
described above. The stock `opencode` theme selection maps to `infiniteoc` inside
this launcher; other explicitly selected themes and light/dark mode remain intact.
The build uses the `infiniteoc` channel and a separate `opencode-infiniteoc.db`, so
stock sessions are not automatically imported. Credentials and configuration are
still shared: this is not a fully isolated user-data profile.

The launcher sets `INFINITEOC=1` and patches the copied CLI's server connection
selection to use a private server instead of the user's stock background service.
For normal TUI launches (no positional command, flags first, or an existing
project path), it also adds `--standalone` unless `--standalone` or `--server` was
explicitly supplied. Explicit remote/server attachment remains your responsibility.
Private-server mode isolates the running server, not credentials or permissions.

The copied agent-list handler waits for plugin activation before responding,
avoiding an empty agent list when a private server has just started.

On this machine, `/home/rize/.local/bin/infiniteoc` links to the launcher.
Run `infiniteoc /path/to/project`, or use the absolute launcher path if that bin
directory is not on your shell's PATH.

## Configuration

`infiniteoc.json` lives beside this README, independent of your project directory:

```json
{
  "upstream": "v2.0.21",
  "mods": ["./mods/infiniteoc/index.mjs"],
  "options": { "reducedMotion": false }
}
```

Mod paths resolve relative to the launcher repository root. Order matters: each
mod's setup completes before the next starts. IDs must be unique. Set
`reducedMotion` to `true` for a static logo gradient and rebuild. Use `"mods": []`
to build without source mods. Configuration here is separate from upstream's
normal project/user configuration.

## Writing a source mod

This is a **source-patch framework**, not the upstream runtime plugin API. Create
`mods/my-mod/index.mjs`, add it to `mods` in `infiniteoc.json`, and run `rebuild`.
A module must default-export an object with a valid `id` and `setup(api)` function;
`version` is optional display metadata. IDs accept letters, digits, `.`, `_`, and
`-`, and must start with a letter or digit.

```js
export default {
  id: "my-mod",
  version: "1.0.0",
  async setup(api) {
    await api.patch("packages/tui/src/context/theme.tsx", (source) => {
      const anchor = '  active: "infiniteoc",'
      if (source.split(anchor).length !== 2) {
        throw new Error("Expected exactly one theme anchor")
      }
      return source.replace(anchor, '  active: "opencode",')
    })
    api.on("beforeLaunch", (context) => {
      context.env.MY_MOD_ACTIVE = "1"
    })
    api.on("afterExit", ({ code }) => {
      console.error(`OpenCode exited with ${code}`)
    })
  },
}
```

This example assumes the bundled mod runs first. With different mod ordering,
choose an anchor matching that point in the source transformations.

| API | Contract |
| --- | --- |
| `api.root` | Absolute path of the copied source worktree. |
| `api.options` | Shared options from `infiniteoc.json`. |
| `await api.read(relativePath)` | Read UTF-8 source text. |
| `await api.write(relativePath, content)` | Write a file, creating parent directories, and record a change. |
| `await api.patch(relativePath, transform)` | Pass source text to a sync/async transform; require a changed string result, write it, and record a change. |
| `api.on("beforeLaunch", callback)` | Register an awaited lifecycle callback receiving mutable `{ args, env, cwd }`. |
| `api.on("afterExit", callback)` | Register an awaited callback receiving launch context plus `code`. |

Hooks run sequentially in registration order. Invalid event names/callbacks and
setup/transform/hook exceptions fail the operation. The framework-level
`applyMods(mods, root, options)` returns `{ changes, emit(event, context) }`;
`loadMods(paths, base)` imports and validates modules in configured order.
On launch, including cached launches, setup is rerun in register-only mode:
API writes/patches are no-ops and hooks are registered again. Keep setup free of
direct external side effects, and do not depend on a transform executing to
register a hook. Reads still observe the cached worktree.

Always check unique source anchors and throw on unexpected upstream changes.
Returning unchanged text or a non-string from `patch` is an error, including
when attempting to reapply a patch already present. Setup should therefore target
the fresh worktree supplied by rebuild. Changes are not transactional: an error
can leave a partially patched disposable worktree, and rebuild starts fresh.

### Trust boundary

**Mods are trusted local JavaScript, not sandboxed.** Module import and setup can
execute arbitrary code with your user's privileges; even listing mods imports
them. Review mods and their imports before enabling them. API file operations
reject absolute paths, traversal outside the source root, and escaping symlinks,
but these guards prevent accidental API misuse, not malicious code: a mod can
import Node filesystem/process/network APIs directly or modify launch context.
The mod framework does not grant extra OS permissions, bypass provider policies,
or disable OpenCode approvals. Never use untrusted mods with secrets available.

See [the bundled mod documentation](mods/infiniteoc/README.md) for its exact
source targets and limitations.

## Tests

```sh
ROOT=/home/rize/InfiniteOC
cd "$ROOT"
npm test
node --test mods/infiniteoc/test.mjs
```

The framework tests use only built-in `node:test` and Node APIs: loading and
validation, duplicates, deterministic ordering, file operations, unchanged
transforms, traversal/symlink guards, lifecycle emission, and failures. An
integration test copies only files targeted by the bundled mod from local
`.upstream` into a temporary tree, applies the actual module through the actual
loader, and checks theme, logo, agent changes, permission-source invariance, and
that upstream was untouched. It skips if `.upstream` is absent; an incompatible
present checkout fails rather than silently skipping. No dependency installation
or binary build is needed to run these tests.

Interactive animation, live provider access, private-server behavior, and compiled
runtime correctness require separate build/manual validation. Keep upstream's
license and attribution with source and redistributed build artifacts.