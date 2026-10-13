import test from "node:test"
import assert from "node:assert/strict"
import { readFile, writeFile, mkdtemp, mkdir, cp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import mod, { patches } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const files = patches.map(([file]) => file)

// A disposable tree with only the pinned files this mod touches (never the live .upstream checkout).
async function tree(t) {
  const root = await mkdtemp(path.join(tmpdir(), "webui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await cp(path.join(upstream, file), path.join(root, file))
  }
  return root
}

test("every anchor occurs exactly once in the pinned upstream source", async () => {
  for (const [file, before, after] of patches) {
    const source = await readFile(path.join(upstream, file), "utf8")
    assert.equal(source.split(before).length, 2, `${file}: ${before}`)
    assert.equal(source.includes(after), false, file)
  }
})

test("applied through the real loader: password kept from tools, theme file, default theme, preload, picker name and title", async (t) => {
  const root = await tree(t)
  const { changes } = await applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], root)
  assert.deepEqual(changes.map((change) => change.path).sort(), ["packages/ui/src/theme/themes/infiniteoc.json", ...files].sort())
  const read = (file) => readFile(path.join(root, file), "utf8")
  assert.match(await read("packages/app/src/app.tsx"), /<ThemeProvider\n {8}defaultTheme="infiniteoc"\n {8}onThemeApplied=\{/)
  assert.match(await read("packages/app/public/oc-theme-preload.js"), /localStorage\.getItem\(key\) \|\| "infiniteoc"/)
  assert.match(await read("packages/ui/src/theme/context.tsx"), /"oc-2": "OpenCode",\n {2}infiniteoc: "InfiniteOC",\n/)
  assert.match(await read("packages/app/index.html"), /<title>InfiniteOC<\/title>/)
  // OPENCODE_CHANNEL is already imported there; the launcher builds with OPENCODE_CHANNEL=infiniteoc.
  const server = await read("packages/cli/src/server-process.ts")
  assert.match(server, /import \{ [^}]*OPENCODE_CHANNEL[^}]* \} from "\.\/version"/)
  assert.match(server, /const environmentPassword = yield\* Env\.password\n[\s\S]*if \(options\.mode === "stdio" \|\| OPENCODE_CHANNEL === "infiniteoc"\) \{\n {8}delete process\.env\.OPENCODE_PASSWORD\n {8}delete process\.env\.OPENCODE_SERVER_PASSWORD/)
  // Upstream finds themes with import.meta.glob("./themes/*.json"), and the id must match the file name.
  const theme = JSON.parse(await read("packages/ui/src/theme/themes/infiniteoc.json"))
  assert.equal(theme.id, "infiniteoc")
  assert.equal(theme.name, "InfiniteOC")
})

test("the theme has every palette color upstream requires, as hex, in both modes, and InfiniteOC's purple/pink", async () => {
  const theme = JSON.parse(await readFile(new URL("./theme.json", import.meta.url), "utf8"))
  const sample = JSON.parse(await readFile(path.join(upstream, "packages/ui/src/theme/themes/dracula.json"), "utf8"))
  for (const mode of ["light", "dark"]) {
    for (const key of ["neutral", "ink", "primary", "success", "warning", "error", "info"]) assert.match(theme[mode].palette[key], /^#[0-9a-f]{6}$/i, `${mode}.${key}`)
    for (const value of [...Object.values(theme[mode].palette), ...Object.values(theme[mode].overrides)]) assert.match(value, /^#[0-9a-f]{6}$/i)
    // Same shape as an upstream theme: no keys upstream does not know.
    for (const key of Object.keys(theme[mode].palette)) assert.ok(key in sample[mode].palette || key === "interactive", key)
  }
  assert.equal(theme.dark.palette.primary, "#c084fc") // the TUI theme's purple
  assert.equal(theme.dark.palette.accent, "#f472b6") // and pink
  assert.ok(!(await readdir(path.join(upstream, "packages/ui/src/theme/themes"))).includes("infiniteoc.json"))
})

test("fails closed when an anchor is gone (already applied, or upstream changed)", async (t) => {
  const root = await tree(t)
  await applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], root)
  await assert.rejects(applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], root), /expected one webui: packages\/cli\/src\/server-process\.ts anchor/)
  const fresh = await tree(t)
  await writeFile(path.join(fresh, "packages/app/index.html"), "<title>Something else</title>")
  await assert.rejects(applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], fresh), /webui: packages\/app\/index\.html/)
})
