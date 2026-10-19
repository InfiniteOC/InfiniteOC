import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readFile, writeFile, mkdtemp, mkdir, cp, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMods } from "../../src/mod-loader.mjs"
import mod, { icons, internalSource, logoSource, patches, serverSource, wordmarkSource } from "./index.mjs"
import { cells, markSvg, rows, wordmarkSvg } from "./wordmark.mjs"
import { features, view } from "./views.ts"
import { contract } from "./app/rpc.ts"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")
const INTERNAL = "packages/core/src/plugin/internal.ts"
const files = [...new Set([...patches.map(([file]) => file), INTERNAL])]

// A disposable tree with only the pinned files this mod touches (never the live .upstream checkout).
async function tree(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "webui-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await cp(path.join(upstream, file), path.join(root, file))
  }
  for (const [file, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), text)
  }
  return root
}

test("every anchor occurs exactly once in the pinned upstream source", async () => {
  for (const [file, before, after] of patches) {
    const source = await readFile(path.join(upstream, file), "utf8")
    assert.equal(source.split(before).length, 2, `${file}: ${before}`)
    assert.equal(source.includes(after), false, file)
  }
  assert.doesNotThrow(() => internalSource(readFileSync(path.join(upstream, INTERNAL), "utf8")))
  for (const [, target] of icons) await readFile(path.join(upstream, target))
})

test("applied through the real loader: branding, logo, icons, web features and the RPC plugin", async (t) => {
  const root = await tree(t, { "packages/core/src/plugin/infiniteoc-ctx-store.ts": "", "packages/core/src/plugin/infiniteoctx-store.ts": "" })
  const { changes } = await applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], root)
  const changed = new Set(changes.map((change) => change.path))
  for (const file of [...files, "packages/ui/src/components/logo.tsx", "packages/ui/src/typography/wordmark/wordmark.tsx", "packages/app/src/infiniteoc/web.tsx", "packages/core/src/plugin/infiniteoc-web.ts", ...icons.map(([, target]) => target)])
    assert.ok(changed.has(file), file)
  const read = (file) => readFile(path.join(root, file), "utf8")
  assert.match(await read("packages/app/src/app.tsx"), /<ThemeProvider\n {8}defaultTheme="infiniteoc"\n {8}onThemeApplied=\{/)
  assert.match(await read("packages/app/public/oc-theme-preload.js"), /localStorage\.getItem\(key\) \|\| "infiniteoc"/)
  assert.match(await read("packages/ui/src/theme/context.tsx"), /"oc-2": "OpenCode",\n {2}infiniteoc: "InfiniteOC",\n/)
  assert.match(await read("packages/app/index.html"), /<title>InfiniteOC<\/title>/)
  assert.match(await read("packages/app/manifest.json"), /"name": "InfiniteOC",\n {2}"short_name": "InfiniteOC",/)
  assert.match(await read("packages/app/src/servers/connect/screen.tsx"), /aria-label="InfiniteOC"/)
  const region = await read("packages/app/src/session/composer/region.tsx")
  assert.match(region, /import \{ useInfiniteocWeb \} from "@\/infiniteoc\/web"/)
  assert.match(region, / {2}useComposerCommands\(\)\n {2}useInfiniteocWeb\(\{ sessionID: \(\) => input\.session\.identity\.params\.id, directory: \(\) => location\(\)\.directory \}\)\n {2}useSessionCommands\(\{/)
  const server = await read("packages/core/src/plugin/infiniteoc-web.ts")
  assert.match(server, /import \* as Ctx from/)
  assert.match(server, /import \* as Octx from/)
  assert.doesNotMatch(server, /Workflows|bun:sqlite/, "absent stores are not imported")
  assert.match(await read(INTERNAL), /InfiniteocWeb\.Plugin,\n {2}WarmingPlugin\.Plugin,/)
  // Icons are written as bytes, not text.
  assert.deepEqual(await readFile(path.join(root, icons[0][1])), await readFile(new URL(`./icons/${icons[0][0]}`, import.meta.url)))
  const server_ = await read("packages/cli/src/server-process.ts")
  assert.match(server_, /if \(options\.mode === "stdio" \|\| OPENCODE_CHANNEL === "infiniteoc"\) \{\n {8}delete process\.env\.OPENCODE_PASSWORD/)
  const theme = JSON.parse(await read("packages/ui/src/theme/themes/infiniteoc.json"))
  assert.equal(theme.id, "infiniteoc")
})

test("fails closed when an anchor is gone (already applied, or upstream changed)", async (t) => {
  const root = await tree(t)
  await applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], root)
  await assert.rejects(applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], root), /expected one webui: packages\/cli\/src\/server-process\.ts anchor/)
  const fresh = await tree(t)
  await writeFile(path.join(fresh, "packages/app/index.html"), "<title>Something else</title>")
  await assert.rejects(applyMods([{ ...mod, filename: "mods/webui/index.mjs" }], fresh), /webui: packages\/app\/index\.html/)
  assert.throws(() => internalSource(internalSource(readFileSync(path.join(upstream, INTERNAL), "utf8"))), /already applied/)
})

test("the theme has every palette color upstream requires, as hex, in both modes, and InfiniteOC's purple/pink", async () => {
  const theme = JSON.parse(await readFile(new URL("./theme.json", import.meta.url), "utf8"))
  const sample = JSON.parse(await readFile(path.join(upstream, "packages/ui/src/theme/themes/dracula.json"), "utf8"))
  for (const mode of ["light", "dark"]) {
    for (const key of ["neutral", "ink", "primary", "success", "warning", "error", "info"]) assert.match(theme[mode].palette[key], /^#[0-9a-f]{6}$/i, `${mode}.${key}`)
    for (const value of [...Object.values(theme[mode].palette), ...Object.values(theme[mode].overrides)]) assert.match(value, /^#[0-9a-f]{6}$/i)
    for (const key of Object.keys(theme[mode].palette)) assert.ok(key in sample[mode].palette || key === "interactive", key)
  }
  assert.equal(theme.dark.palette.primary, "#c084fc")
  assert.equal(theme.dark.palette.accent, "#f472b6")
  assert.ok(!(await readdir(path.join(upstream, "packages/ui/src/theme/themes"))).includes("infiniteoc.json"))
})

test("the wordmark converts the TUI's glyphs cell for cell", () => {
  // █ is a full cell, ▀ the top half, ▄ the bottom half; _ is a shadow cell, ^ ▀ over shadow, ~ a shadow ▀.
  assert.deepEqual(cells(["█▀▄"]), [{ x: 0, y: 0, w: 2, h: 1, shadow: false }, { x: 0, y: 1, w: 1, h: 1, shadow: false }, { x: 2, y: 1, w: 1, h: 1, shadow: false }])
  assert.deepEqual(cells(["_^~ "]), [{ x: 0, y: 0, w: 1, h: 1, shadow: true }, { x: 1, y: 0, w: 1, h: 1, shadow: false }, { x: 2, y: 0, w: 1, h: 1, shadow: true }, { x: 0, y: 1, w: 2, h: 1, shadow: true }])
  assert.equal(rows.length, 4)
  assert.equal(rows[1], "█ █▀▀▄ ▀█▀ █ █▀▀▄ █ ▀█▀ █▀▀█ █▀▀█ █▀▀▀")
  for (const svg of [wordmarkSvg(), markSvg()]) assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+"/)
  assert.match(wordmarkSvg(), /aria-label="InfiniteOC"/)
})

test("logo and wordmark components keep upstream's exports and props, with unique gradient ids", () => {
  const source = logoSource()
  for (const name of ["Mark", "Splash", "Logo"]) assert.match(source, new RegExp(`export const ${name} = \\(props: `))
  assert.match(source, /ref=\{props\.ref\}/)
  assert.equal(source.match(/createUniqueId\(\)/g).length, 3)
  assert.match(source, /viewBox="0 0 38 8"/)
  assert.match(wordmarkSource(), /export function Wordmark\(props: Pick<ComponentProps<"svg">, "class"> & \{ fade\?: boolean; muted\?: boolean; outline\?: boolean \}\)/)
})

test("the RPC plugin imports only the stores the build has; the contract matches the browser's", () => {
  const all = serverSource(["ctx", "octx", "workflows", "usage"])
  assert.match(all, /const deps: Deps = \{ ctx: Ctx, octx: Octx, workflows: Workflows, usage \}/)
  assert.match(all, /from "bun:sqlite"/)
  assert.match(serverSource([]), /const deps: Deps = \{  \}/)
  const embedded = all.match(/const contract = (\{[\s\S]*?\n\}) as const/)[1]
  assert.deepEqual(new Function(`return ${embedded}`)(), contract)
})

// In-memory stores standing in for the server modules.
function stores() {
  const files = new Map()
  const pins = new Map()
  let octx = { paged: ["a", "b"], chars: 8000 }
  const workflows = [
    { id: "w1", name: "review", status: "running", parentSessionID: "ses_1", createdAt: 0, steps: [{ id: "s1", title: "Read", agent: "explore" }, { id: "s2", title: "Fix", agent: "general" }], state: { s1: { status: "completed" }, s2: { status: "running", sessionID: "ses_2", model: "m" } } },
  ]
  const cancelled = []
  return {
    cancelled,
    deps: {
      ctx: {
        readSnapshot: (id) => (id === "ses_1" ? { total: 10 } : undefined),
        formatSnapshot: (snapshot) => `total ${snapshot.total}`,
        projectRoot: (start) => `/p${start === "." ? "" : start}`,
        memoryFile: (root) => `${root}/memory.md`,
        glossaryFile: (root) => `${root}/glossary.md`,
        listItems: (file) => files.get(file) ?? [],
        addItem: (file, text) => files.set(file, [...(files.get(file) ?? []), text.trim()]),
        removeItem: (file, which) => files.set(file, (files.get(file) ?? []).filter((_, index) => index !== Number(which) - 1)),
        termKey: (item) => item,
        listPins: (id) => pins.get(id) ?? [],
        addPin: (id, file) => pins.set(id, [...(pins.get(id) ?? []), file]),
        removePin: (id, file) => pins.set(id, (pins.get(id) ?? []).filter((item) => item !== file)),
      },
      octx: { readState: () => octx, writeState: (_, state) => (octx = state), describe: (state) => (state.off ? "off" : `${state.paged.length} paged`) },
      workflows: { listWorkflows: () => workflows, requestCancel: (parent, id) => cancelled.push([parent, id]) },
      usage: () => "spend table",
    },
  }
}

test("views: context, octx, usage, and the features a build offers", () => {
  const { deps } = stores()
  assert.deepEqual(features(deps).map((feature) => feature.slash), ["context", "octx", "memory", "pins", "workflows", "usage"])
  assert.deepEqual(features({ ctx: deps.ctx }).map((feature) => feature.slash), ["context", "memory", "pins"])
  assert.equal(view({ feature: "context", sessionID: "ses_1" }, deps).text, "total 10")
  assert.match(view({ feature: "context", sessionID: "ses_9" }, deps).text, /No model request/)
  assert.equal(view({ feature: "context" }, deps).text, "Open a session first.")
  assert.equal(view({ feature: "context", sessionID: "../../etc" }, deps).text, "Open a session first.", "ids that are not ids never reach a store")
  const octx = view({ feature: "octx", sessionID: "ses_1" }, deps)
  assert.equal(octx.text, "2 paged")
  assert.equal(octx.actions[0].id, "off")
  const off = view({ feature: "octx", sessionID: "ses_1", action: "off" }, deps)
  assert.equal(off.text, "off")
  assert.equal(off.actions[0].id, "on")
  assert.equal(off.toast.variant, "success")
  assert.equal(view({ feature: "usage" }, deps).text, "spend table")
  assert.equal(view({ feature: "nope" }, deps).toast.variant, "error")
  assert.equal(view({ feature: "usage" }, { ...deps, usage: () => { throw new Error("db locked") } }).toast.message, "db locked")
})

test("views: memory and glossary browse, add and remove per project", () => {
  const { deps } = stores()
  const top = view({ feature: "memory", directory: "/repo" }, deps)
  assert.deepEqual(top.items.map((item) => item.id), ["open:memory", "open:glossary"])
  assert.equal(view({ feature: "memory", directory: "/repo", action: "add:memory", value: "use bun test" }, deps).toast.variant, "success")
  view({ feature: "memory", directory: "/repo", action: "add:glossary", value: "OC: OpenCode" }, deps)
  const list = view({ feature: "memory", directory: "/repo", action: "open:memory" }, deps)
  assert.deepEqual(list.items, [{ id: "entry:memory:1", title: "use bun test" }])
  assert.equal(list.input.action, "add:memory")
  const entry = view({ feature: "memory", directory: "/repo", action: "entry:memory:1" }, deps)
  assert.deepEqual(entry.actions.map((action) => action.id), ["remove:memory:1", "open:memory"])
  assert.deepEqual(view({ feature: "memory", directory: "/repo", action: "remove:memory:1" }, deps).items, [])
  assert.equal(view({ feature: "memory", directory: "/repo", action: "open:glossary" }, deps).items[0].title, "OC: OpenCode")
  assert.deepEqual(view({ feature: "memory", directory: "/other", action: "open:glossary" }, deps).items, [], "per project")
  assert.equal(view({ feature: "memory", action: "add:memory", value: "   " }, deps).toast, undefined, "blank entries are not saved")
})

test("views: pins resolve against the project and unpin; workflows list, open and cancel", () => {
  const { deps, cancelled } = stores()
  const pinned = view({ feature: "pins", sessionID: "ses_1", directory: "/repo", action: "add", value: "@src/a.ts" }, deps)
  assert.deepEqual(pinned.items, [{ id: "pin:/p/repo/src/a.ts", title: "src/a.ts" }])
  const one = view({ feature: "pins", sessionID: "ses_1", directory: "/repo", action: "pin:/p/repo/src/a.ts" }, deps)
  assert.deepEqual(one.actions.map((action) => action.id), ["unpin:/p/repo/src/a.ts", ""])
  assert.deepEqual(view({ feature: "pins", sessionID: "ses_1", directory: "/repo", action: "unpin:/p/repo/src/a.ts" }, deps).items, [])
  const list = view({ feature: "workflows", sessionID: "ses_2" }, deps)
  assert.equal(list.title, "Workflows of this session · 1")
  assert.deepEqual(list.items, [{ id: "open:w1", title: "◐ review", description: "running · 1/2 steps" }])
  const detail = view({ feature: "workflows", sessionID: "ses_2", action: "open:w1" }, deps)
  assert.match(detail.text, /✓ s1 · Read \(explore\)\n◐ s2 · Fix \(general, m\)/)
  assert.equal(detail.actions[0].id, "cancel:w1")
  assert.equal(view({ feature: "workflows", sessionID: "ses_2", action: "cancel:w1" }, deps).toast.variant, "success")
  assert.deepEqual(cancelled, [["ses_1", "w1"]])
  assert.equal(view({ feature: "workflows", action: "cancel:missing" }, deps).toast, undefined)
})
