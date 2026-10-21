import { readFile } from "node:fs/promises"

const core = "packages/core/src"
export const GUARD = `${core}/tool/path-guard.ts`

const check = (...values) => `const pathFailure = pathProblem(${values.join(", ")})
                if (pathFailure) return yield* new ToolFailure({ message: pathFailure })
                `
const guardImport = [`import { ToolFailure } from "@opencode/ai"`, `import { ToolFailure } from "@opencode/ai"
import { pathProblem } from "../path-guard.js"`]

// Leaked file text in a path argument: repaired before permission checks when the leak echoes
// another argument, otherwise refused with a clear message instead of creating junk directories.
// Several calls packed into one (raw chat-stream markers in any argument) are refused, never written.
export const patches = [
  [`${core}/plugin/tool-input-repair.ts`, `import { definition } from "../tool/runtime.js"`, `import { definition } from "../tool/runtime.js"
import { repairLeakedPath, stripHeredocTail } from "../tool/path-guard.js"`],
  [`${core}/plugin/tool-input-repair.ts`, `event.input = repair(event.input, schema, schema, 0)`, `event.input = stripHeredocTail(repairLeakedPath(repair(event.input, schema, schema, 0)))`],
  [`${core}/tool/plugin/write.ts`, ...guardImport],
  [`${core}/tool/plugin/write.ts`, `const target = yield* access.resolve({ path: input.path, kind: "file" })`, `${check("input.path", "input.content")}const target = yield* access.resolve({ path: input.path, kind: "file" })`],
  [`${core}/tool/plugin/edit.ts`, ...guardImport],
  [`${core}/tool/plugin/edit.ts`, `const target = yield* access.resolve({ path: input.path, kind: "file" })`, `${check("input.path", "input.oldString", "input.newString")}const target = yield* access.resolve({ path: input.path, kind: "file" })`],
  [`${core}/tool/plugin/patch.ts`, ...guardImport],
  [`${core}/tool/plugin/patch.ts`, `const target = yield* access.resolve({ path: value, kind: "file" })`, `${check("value", "input.patchText")}const target = yield* access.resolve({ path: value, kind: "file" })`],
]

export default {
  id: "path-repair",
  version: "1.0.0",
  async setup(api) {
    await api.write(GUARD, await readFile(new URL("./path-guard.ts", import.meta.url), "utf8"))
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
