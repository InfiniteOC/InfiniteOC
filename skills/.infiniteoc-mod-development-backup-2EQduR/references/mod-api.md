# Actual local mod API

Authority: `/home/rize/InfiniteOC/src/mod-loader.mjs` and `/home/rize/InfiniteOC/src/launcher.mjs`. Re-read when implementation changes.

## Loading and order

`loadMods(paths, base)` resolves each module against the launcher root, imports its default export, checks ID/setup, rejects duplicate IDs, and preserves configured order. Module top-level code executes on import. Keep it side-effect free.

`applyMods(mods, root, options, registerOnly)` calls setup sequentially. It returns `{ changes, emit(event, context) }`. A recorded change is `{ mod, path, action: "write" | "patch" }`. It has no transactional rollback: an error may leave a partial disposable worktree. The launcher will recreate that tree on preparation.

## setup(api)

| Member | Actual behavior |
|---|---|
| `root` | Absolute source-root path supplied by the loader |
| `options` | Shared `infiniteoc.json.options`; namespace per-mod values to avoid collisions |
| `await api.read(relativePath)` | UTF-8 read; still executes during register-only setup |
| `await api.write(relativePath, string)` | Creates parent directories, writes source; skipped in register-only mode |
| `await api.patch(relativePath, transform)` | Reads current UTF-8 source, awaits sync/async transform, requires a changed string, writes it; skipped in register-only mode |
| `api.on("beforeLaunch", handler)` | Registers awaited launch callback |
| `api.on("afterExit", handler)` | Registers awaited post-exit callback |

Paths cannot be absolute, escape the root, or use symlinks into external trees. There is no delete API, package installer, runtime JSX injection hook, or automatic dependency resolution for arbitrary mod imports. `api.write` can overwrite existing source: inspect before using it.

## Hooks

Before launch, context is `{ args: string[], env: object, cwd: string }`. Mutate this supplied object to affect the spawned binary. Do not assume it is frozen or mutate global environment instead. After exit, context also has `code`.

Ordering: module-level `beforeLaunch` functions in mod order, then registered `beforeLaunch` hooks in registration order, then the binary. After a normal child exit: module-level `afterExit`, then registered `afterExit`. Hook failures propagate. Post-exit hooks are not guaranteed after spawn/prelaunch failure, and are not `finally` cleanup hooks. Resources acquired in hooks need failure-aware design.

Cached launches still invoke setup in register-only mode to restore hooks. Source callbacks do not run in that mode. `api.read` and reads of bundled mod resources do run, so resources must exist independently of a just-executed transform.

## Build lifecycle

The launcher fingerprints configuration, framework source, and files beneath configured mod directories. Preparation copies pinned `.upstream` into `.runtime/opencode`, applies framework isolation/activation patches, applies mods, installs locked workspace dependencies, and builds the isolated CLI using bundled Bun. Do not change `.upstream`, `.tools`, or workspace lockfiles casually. Hooks are Node code; patched upstream is compiled with Bun/Solid/OpenTUI.

Launcher commands: `setup` prepares if needed; `rebuild` forces pristine reapplication; `mods` lists entries; `doctor` checks prerequisites; `-- --version` passes through. Read current CLI before relying on flags. The loader's change list records mod file actions, not every launcher-managed patch.

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