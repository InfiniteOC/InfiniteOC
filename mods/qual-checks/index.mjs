import { readFile } from "node:fs/promises"

const LIB = ["scan", "tokens", "catalog", "prune", "deps", "license", "coverage", "tests", "exec", "store", "browser"]
const marker = "// infiniteoc:guidance-extensions"

export const guidance = `[Quality tools]
Verification tools built into InfiniteOC; use them instead of claiming something works.
- UI work: call ui_check (a dev server URL or an HTML file) once before editing and again after. It returns screenshots at phone, tablet and desktop widths plus dark mode, flags horizontal overflow and console errors, runs an axe-core accessibility audit when axe-core is installed, and attaches a pixel diff against the earlier capture. Fix what it reports, then check again. design_tokens lists the project's CSS variables and Tailwind theme and component_catalog lists existing components: read them before writing new UI so it matches and reuses what is there. Pass a mockup image to ui_check to see how far the render is from it.
- Tests: new tests should be able to fail. Run mutation_check on the source file you changed (it flips one condition and expects a test to fail, then restores the file). coverage_delta reports whether coverage went down; bench_guard compares a configured benchmark with its baseline when the change touches performance-sensitive code. A failing test command is rerun twice automatically and labelled flaky when it passes again: report a flaky test as flaky, never as fixed.
- /testfirst <bug or behavior> gates source edits until a new test has been seen failing; follow its steps. Edits to package.json or requirements files report each new dependency's size and license, and vendored code gets a license check (license_check does it on demand): justify new dependencies or drop them.
- /prune lists unused files and exports (prune_scan); it never deletes.`

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
