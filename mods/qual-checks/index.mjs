import { readFile } from "node:fs/promises"

const LIB = ["scan", "tokens", "catalog", "prune", "deps", "license", "coverage", "tests", "exec", "store", "browser"]
const marker = "// infiniteoc:guidance-extensions"

export const guidance = `[Quality tools]
Prove it; don't claim. Prefer these over manual checks.
- UI: ui_check {target} before+after (dev URL or HTML file). Screenshots phone/tablet/desktop + dark, overflow, console errors, axe audit when installed, pixel diff vs baseline. Fix, re-check. design_tokens + component_catalog before new UI; mockup path for pixel compare.
- Tests must fail first: mutation_check {file,test_command,line?} flips one condition, expects failure, restores. coverage_delta after tests; bench_guard after perf-sensitive changes. Fail-then-pass-twice is flaky, never fixed.
- /testfirst <bug> gates edits till failing test seen. package.json/requirements edits report dep size+license; vendored code needs license_check. /prune lists unused files/exports (prune_scan); never deletes.`

export default {
  id: "qual-checks",
  version: "1.0.0",
  async setup(api) {
    const here = (file) => new URL(file, import.meta.url)
    // The lib files import each other as ./x.ts so Node can run them in tests; upstream imports use .js.
    for (const name of LIB)
      await api.write(`packages/core/src/infiniteoc/quality/${name}.ts`, (await readFile(here(`./lib/${name}.ts`), "utf8")).replace(/(from\s+"\.\/[\w-]+)\.ts"/g, '$1.js"'))
    await api.write("packages/core/src/plugin/infiniteoc-quality.ts", await readFile(here("./quality.ts"), "utf8"))
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      const imp = 'import { PlanPlugin } from "./plan.js"'
      const list = "  PlanPlugin.Plugin,\n"
      if (source.split(imp).length !== 2 || source.split(list).length !== 2) throw new Error("qual-checks: expected one internal.ts plugin anchor")
      return source.replace(imp, () => `${imp}\nimport * as InfiniteocQuality from "./infiniteoc-quality.js"`).replace(list, () => `  InfiniteocQuality.Plugin,\n${list}`)
    })
    // Agent guidance through the extension marker that mods/infiniteoc writes (see mods/deep-deliberation).
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) => {
      if (source.includes("[Quality tools]")) throw new Error("qual-checks: guidance already applied")
      if (source.split(marker).length !== 2) throw new Error("qual-checks: expected one guidance extension marker")
      return source.replace(marker, () => `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${marker}`)
    })
  },
}
