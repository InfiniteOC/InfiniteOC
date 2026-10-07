# Testing a source mod

## Disposable application checker

```sh
node /home/rize/.config/opencode/skill-library/infiniteoc-mod-development/scripts/check-mod.mjs /home/rize/InfiniteOC/mods/example/index.mjs /home/rize/InfiniteOC
```

This syntax-checks the mod, copies pinned source without `.git`/`node_modules` to a temporary directory, and applies currently enabled mods followed by the candidate if not already enabled. It does not register the candidate, rebuild the application, launch it, or invoke hooks. It deletes the temporary copy in `finally`.

**Only run trusted mods:** importing and setup execute arbitrary Node code; a disposable source tree is not a security sandbox. This checker copies pristine upstream and applies configured source mods, not the launcher-managed server/isolation patches. If targeting a launcher-managed patch, use a test fixture containing that known patch or validate via the actual rebuild.

## Minimal regression test using the actual loader

```js
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import mod from "./index.mjs"

test("patches expected source and fails closed on repeated application", async () => {
  const root = await mkdtemp(join(tmpdir(), "infiniteoc-mod-test-"))
  try {
    await writeFile(join(root, "fixture.txt"), "old\n")
    const result = await applyMods([mod], root)
    assert.equal(await readFile(join(root, "fixture.txt"), "utf8"), "new\n")
    assert.equal(result.changes.length, 1)
    await assert.rejects(applyMods([mod], root), /source anchor/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
```

This fixture assumes a mod patching `fixture.txt` from `old\n` to `new\n`; replace fixture and expectations with the real feature before shipping. The bundled `examples/patch-fixture.mjs` implements this behavior and is only for checker smoke tests, never for installation.

Add missing-anchor and duplicate-anchor cases. Hook mods should test event order, mutable context, register-only registration, and failures without leaking resources. UI mods should check preservation of permission rules and existing prompts/config. Keep tests deterministic and paid requests out of the suite.

## Project checks

```sh
node --check /home/rize/InfiniteOC/mods/example/index.mjs
node --test /home/rize/InfiniteOC/test/*.test.mjs /home/rize/InfiniteOC/mods/infiniteoc/test.mjs
node --test /home/rize/InfiniteOC/mods/example/test.mjs
node /home/rize/InfiniteOC/bin/infiniteoc.mjs rebuild
node /home/rize/InfiniteOC/bin/infiniteoc.mjs -- --version
```

Use real mod paths, not the example name. Independent syntax checks/tests may run together. Rebuild must not race another rebuild or tests reading the generated tree. Run feature smoke checks after rebuild, inspect logs, and wait for background builds before declaring completion. Native terminal validation differs from browser validation; use a PTY or real terminal for Solid/OpenTUI.