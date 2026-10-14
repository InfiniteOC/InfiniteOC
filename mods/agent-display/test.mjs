import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod from "./index.mjs"
import * as D from "./display.ts"

// ---- pure helpers -----------------------------------------------------------------

test("resolveDisplay defaults, overrides, and never allows the user session", () => {
  assert.equal(D.resolveDisplay({}), ":99")
  assert.equal(D.resolveDisplay({ INFINITEOC_AGENT_DISPLAY: ":42" }), ":42")
  assert.throws(() => D.resolveDisplay({ INFINITEOC_AGENT_DISPLAY: ":0" }), /never the user's/)
  assert.throws(() => D.resolveDisplay({ INFINITEOC_AGENT_DISPLAY: "wayland-1" }), /like ":99"/)
})

test("status round-trips through an isolated data dir", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-display-"))
  const env = { XDG_DATA_HOME: home }
  assert.deepEqual(D.readStatus(env), { display: ":99", running: false, apps: [] })
  D.writeStatus({ display: ":99", running: true, pid: process.pid, apps: [] }, env)
  assert.equal(D.readStatus(env).pid, process.pid)
  await rm(home, { recursive: true, force: true })
})

test("stale running records sweep to stopped, live ones survive", () => {
  const stale = D.sweepStatus({ display: ":99", running: true, pid: 2 ** 30, apps: [{ pid: 1, command: "x", startedAt: 0, log: "" }] })
  assert.equal(stale.running, false)
  assert.deepEqual(stale.apps, [])
  const live = D.sweepStatus({ display: ":99", running: true, pid: process.pid, apps: [] })
  assert.equal(live.running, true)
})

test("screenshot and stream commands stay on the virtual display", () => {
  assert.deepEqual(D.xvfbArgs(":99"), [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"])
  assert.match(D.importArgs(":99", "/tmp/f.png").args.join(" "), /-window root/)
  assert.match(D.ffmpegArgs(":99", "/tmp/f.png").args.join(" "), /x11grab/)
  assert.match(D.ffmpegStreamArgs(":99").join(" "), /mjpeg/)
  assert.match(D.viewerPage(":99"), /stream\.mjpg/)
})

test("spawned apps get DISPLAY=:99 and lose the user's Wayland socket", () => {
  const env = D.appEnv(":99", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1", HOME: "/home/u" })
  assert.equal(env.DISPLAY, ":99")
  assert.ok(!("WAYLAND_DISPLAY" in env))
  assert.equal(env.HOME, "/home/u")
})

test("validateExec accepts argv, refuses empties and NUL", () => {
  assert.deepEqual(D.validateExec({ command: "chromium", args: ["--no-sandbox"] }), { command: "chromium", args: ["--no-sandbox"] })
  assert.ok("error" in D.validateExec({ command: "  " }))
  assert.ok("error" in D.validateExec({ command: "x", args: "nope" }))
  assert.ok("error" in D.validateExec({ command: "x\0y" }))
})

test("validateWin builds xdotool argv per op and refuses bad input", () => {
  assert.ok("error" in D.validateWin({}))
  assert.ok("error" in D.validateWin({ op: "move" }))
  const move = D.validateWin({ op: "move", window: "Chromium", x: 10, y: 20 })
  assert.ok(!("error" in move) && move.args.join(" ").includes("windowmove 10 20"))
  const byId = D.validateWin({ op: "focus", window: "12345" })
  assert.ok(!("error" in byId) && byId.args.join(" ").includes("windowactivate"))
  assert.ok("error" in D.validateWin({ op: "move", window: "x", x: 1.5, y: 0 }))
  assert.ok(!("error" in D.validateWin({ op: "list" })))
  assert.ok(!("error" in D.validateWin({ op: "type", window: "x", text: "hello" })))
  assert.ok("error" in D.validateWin({ op: "type", window: "x", text: "" }))
  assert.ok(!("error" in D.validateWin({ op: "key", window: "x", keys: "ctrl+q" })))
  assert.ok("error" in D.validateWin({ op: "key", window: "x", keys: "a\nb" }))
})

test("describeStatus names the display, apps, frame and live view", () => {
  const text = D.describeStatus({ display: ":99", running: true, pid: 7, apps: [], streamPort: 4567 })
  assert.match(text, /:99/)
  assert.match(text, /Apps: none/)
  assert.match(text, /127\.0\.0\.1:4567/)
})

// ---- mod application ---------------------------------------------------------------

test("registers the tool after the subagent anchor and appends guidance once", async () => {
  const internal = [
    'import { SubagentTool } from "../tool/plugin/subagent.js"',
    "const pre = [",
    "  SubagentTool.Plugin,",
    "] as const",
    "",
  ].join("\n")
  const guidance = `export const x = 1\n${"// infiniteoc:guidance-extensions"}\n`
  const files = new Map([
    ["packages/core/src/plugin/internal.ts", internal],
    ["packages/core/src/infiniteoc/guidance.ts", guidance],
  ])
  const commands = []
  const api = {
    options: {},
    read: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return files.get(file)
    },
    write: async (file, content) => void files.set(file, content),
    patch: async (file, transform) => void files.set(file, await transform(files.get(file))),
    patchExact: async () => {},
    tui: { command: (command) => void commands.push(command) },
    on() {},
  }
  await mod.setup(api)
  assert.match(files.get("packages/core/src/plugin/internal.ts"), /InfiniteocAgentDisplay\.Plugin,\n/)
  assert.equal(files.get("packages/core/src/infiniteoc/guidance.ts").split("[Agent display]").length, 2)
  assert.equal(commands.length, 1)
  assert.equal(commands[0].slash, "display")
  await assert.rejects(mod.setup(api), /already applied/)
})

test("extends safe-guard readonly without touching its gate messages", async () => {
  const anchor = '        if (event.tool === "subagent" && !["explore", "reviewer", "researcher"].includes(agent)) return Effect.fail(new Tool.Error({ message: readonlyRefusal(`the ${agent || "general"} subagent (it can edit)`) }))\n'
  const files = new Map([
    ["packages/core/src/plugin/internal.ts", 'import { SubagentTool } from "../tool/plugin/subagent.js"\n  SubagentTool.Plugin,\n'],
    ["packages/core/src/infiniteoc/guidance.ts", "x\n// infiniteoc:guidance-extensions\n"],
    ["packages/core/src/plugin/infiniteoc-safety.ts", `a\n${anchor}b\n`],
  ])
  const api = {
    options: {},
    read: async (file) => {
      if (!files.has(file)) throw Object.assign(new Error("missing"), { code: "ENOENT" })
      return files.get(file)
    },
    write: async (file, content) => void files.set(file, content),
    patch: async (file, transform) => void files.set(file, await transform(files.get(file))),
    patchExact: async () => {},
    tui: { command: () => {} },
    on() {},
  }
  await mod.setup(api)
  const safety = files.get("packages/core/src/plugin/infiniteoc-safety.ts")
  assert.match(safety, /agent_display/)
  assert.equal(safety.split(anchor).length, 2)
})

test("command dialog follows the select-alert-confirm pattern", async () => {
  const source = await readFile(new URL("./command.tsx", import.meta.url), "utf8")
  assert.match(source, /ctx\.ui\.select/)
  assert.match(source, /ctx\.ui\.alert/)
  assert.match(source, /ctx\.ui\.confirm/)
  assert.match(source, /agent-display-store/)
})

test("plugin source keeps user :0 out and shell permission in", async () => {
  const source = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  assert.match(source, /USER_DISPLAY/)
  assert.match(source, /action: "shell"/)
  assert.match(source, /127\.0\.0\.1|streamHost/)
  const dir = await mkdtemp(path.join(tmpdir(), "agent-display-check-"))
  try {
    await writeFile(path.join(dir, "x.mjs"), await readFile(new URL("./display.ts", import.meta.url), "utf8"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
