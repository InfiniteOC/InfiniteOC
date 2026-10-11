# Actual local mod API

Authority (relative to the checkout): `src/mod-loader.mjs`, `src/tui-features.mjs` and `src/launcher.mjs`. Re-read when implementation changes.

## Loading and order

`loadMods(paths, base)` resolves each module against the launcher root, imports its default export, checks ID/setup, rejects duplicate IDs, and preserves configured order. Module top-level code executes on import. Keep it side-effect free.

`applyMods(mods, root, options, registerOnly)` calls setup sequentially. It returns `{ changes, featureSources, features, emit(event, context) }`; `features` excludes handler source, while `featureSources` contains it. A recorded change is `{ mod, path, action: "write" | "patch" }`. It has no transactional rollback: an error may leave a partial disposable worktree. The launcher will recreate that tree on preparation.

## setup(api)

| Member | Actual behavior |
|---|---|
| `root` | Absolute source-root path supplied by the loader |
| `options` | Shared `infiniteoc.json.options`; namespace per-mod values to avoid collisions |
| `await api.read(relativePath)` | UTF-8 read; still executes during register-only setup |
| `await api.write(relativePath, string)` | Creates parent directories, writes source; skipped in register-only mode |
| `await api.patch(relativePath, transform)` | Reads current UTF-8 source, awaits sync/async transform, requires a changed string, writes it; skipped in register-only mode |
| `await api.patchExact(relativePath, before, after)` | Requires one exact nonempty anchor and changed output; skipped in register-only mode |
| `api.tui.command(descriptor)` | Declares a local UI command; collected even in register-only mode; source integration occurs after mod setup |
| `api.on("beforeLaunch", handler)` | Registers awaited launch callback |
| `api.on("afterExit", handler)` | Registers awaited post-exit callback |

Paths cannot be absolute, escape the root, or use symlinks into external trees. There is no delete API, package installer, runtime JSX injection hook, or automatic dependency resolution for arbitrary mod imports. `api.write` can overwrite existing source: inspect before using it.

## Declarative TUI features

Scaffold with `node bin/infiniteoc.mjs feature new hello-ai`.
It creates an unenabled mod; `feature check hello-ai` validates declarations,
slash collisions and pinned anchors, not compilation or runtime behavior.

```js
import { readFile } from "node:fs/promises"
export default {
  id: "hello-ai",
  async setup(api) {
    api.tui.command({
      id: "main", title: "Say hello", slash: "hello-ai",
      aliases: ["greet"], category: "Mods",
      source: await readFile(new URL("./command.tsx", import.meta.url), "utf8"),
    })
  },
}
```

```ts
import type { FeatureContext } from "./api"
export function run(ctx: FeatureContext) {
  ctx.toast.show({ variant: "info", message: "Hello!" })
}
```

`id`, `title`, `slash`, and `source` are required; aliases/category optional.
Slash names/aliases are lowercase without `/`; source must export `function run`
or `async function run`. Command IDs become `infiniteoc.<mod>.<id>` (also the
keybind name). Duplicate IDs and slash collisions fail closed: the build,
`feature check` and live reload check every `slash:` declared under
`packages/tui/src` (app, routes, plugins; the build also sees other mods'
patches), the reserved built-in `/live`, and other features. The compiled API type
lives under `packages/tui/src/infiniteoc-features/api.ts` in the generated workspace.

Context exposes `tabs`, `route`, `dialog`, `toast`, `ui`, not a general server SDK.
`ctx.tabs.tabs()` reads current-scope tabs; `await ctx.tabs.closeAll()` closes
that scope, navigates home and returns the count without deleting conversations
or stopping tasks; `await ctx.tabs.restoreAll(ids, active?)` undoes it in one
locked write. `ctx.ui` is the upstream plugin dialog API: `alert`, `confirm`,
`prompt` and `select` resolve with the answer (`undefined` on Esc), and `set({ size })`
resizes the open dialog. Toast actions are mouse-only; give side effects a
keyboard path. Each run first clears the open dialog; failures show an error toast
titled `/<slash> failed`. Inspect pinned types for open/select/reopen/navigation
methods. For compiled features, `api.write` can add Solid/OpenTUI components;
live ctx-only handlers must not import another framework instance.

## Hook execution

Before launch, context is `{ args: string[], env: object, cwd: string }`. Mutate this supplied object to affect the spawned binary. Do not assume it is frozen or mutate global environment instead. After exit, context also has `code`.

Ordering: module-level `beforeLaunch` functions in mod order, then registered `beforeLaunch` hooks in registration order, then the binary. After a normal child exit: module-level `afterExit`, then registered `afterExit`. Hook failures propagate. Post-exit hooks are not guaranteed after spawn/prelaunch failure, and are not `finally` cleanup hooks. A launch that falls back to `.runtime/last-good` runs no hooks at all. Resources acquired in hooks need failure-aware design.

Cached launches still invoke setup in register-only mode to restore hooks. Source callbacks do not run in that mode. `api.read` and reads of bundled mod resources do run, so resources must exist independently of a just-executed transform.

## Build lifecycle

The launcher fingerprints configuration, framework source, and files beneath configured mod directories. Preparation copies pinned `.upstream` into `.runtime/opencode`, applies framework isolation/activation patches, applies mods, installs locked workspace dependencies, and builds the isolated CLI using bundled Bun. Do not change `.upstream`, `.tools`, or workspace lockfiles casually. Hooks are Node code; patched upstream is compiled with Bun/Solid/OpenTUI.

Supported targets are Linux (glibc) and macOS on x64/arm64. A build prints its reason and timed `[1/4]`…`[4/4]` steps. The build lock `.runtime/prepare.lock` records its pid and heals itself; a successful build is also kept in `.runtime/last-good`, which a launch runs (without mod hooks) when a later build or mod fails.

Launcher commands: `setup` prepares if needed; `rebuild` forces pristine reapplication; `mods` lists entries; `doctor [--json]` runs read-only checks; `feature new|check|enable|disable ID` scaffolds, checks, or adds/removes `mods/ID` in `infiniteoc.json` (keeping `infiniteoc.json.bak`); `upgrade`/`update`/`uninstall` are refused; `-- --version` passes through. Read current CLI before relying on flags. The loader's change list records mod file actions, not every launcher-managed patch.

## Strict patch pattern

```js
export function replaceOnce(source, before, after) {
  if (typeof source !== "string" || !before || before === after)
    throw new Error("Invalid source patch")
  if (source.split(before).length !== 2)
    throw new Error("Expected one source anchor; inspect upstream/mod order")
  return source.replace(before, () => after)
}
```

The callback replacement avoids JavaScript `$&`/`$1` replacement expansion. Fail on already-patched source when using this helper: the real loader rejects no-op patches. If a mod intentionally supports partial earlier-mod changes, detect each supported variant explicitly and test it.