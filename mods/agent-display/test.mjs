import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import mod, { guidance } from "./index.mjs"
import * as D from "./display.ts"
import * as K from "./desktop.ts"

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

test("sweepStatus prunes dead apps but keeps live ones", () => {
  const swept = D.sweepStatus({
    display: ":99",
    running: true,
    pid: process.pid,
    apps: [
      { pid: 2 ** 30, command: "dead", startedAt: 0, log: "" },
      { pid: process.pid, command: "live", startedAt: 0, log: "" },
    ],
  })
  assert.equal(swept.running, true)
  assert.deepEqual(swept.apps.map((app) => app.command), ["live"])
})

test("screenshot and stream commands stay on the virtual display", () => {
  assert.deepEqual(D.xvfbArgs(":99"), [":99", "-screen", "0", "1280x800x24", "-nolisten", "tcp"])
  assert.match(D.importArgs(":99", "/tmp/f.png").args.join(" "), /-window root/)
  assert.match(D.ffmpegArgs(":99", "/tmp/f.png").args.join(" "), /x11grab/)
  const live = D.ffmpegStreamArgs(":99").join(" ")
  assert.match(live, /-draw_mouse 1 -framerate 30 -video_size 1280x800 -i :99 -f mpjpeg/)
})

test("spawned apps get DISPLAY=:99 and lose the user's Wayland socket", () => {
  const env = D.appEnv(":99", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1", HOME: "/home/u" })
  assert.equal(env.DISPLAY, ":99")
  assert.ok(!("WAYLAND_DISPLAY" in env))
  assert.equal(env.HOME, "/home/u")
})

test("validateExec accepts argv and env, refuses empties, NUL and managed vars", () => {
  assert.deepEqual(D.validateExec({ command: "chromium", args: ["--no-sandbox"] }), { command: "chromium", args: ["--no-sandbox"], env: {} })
  assert.deepEqual(D.validateExec({ command: "x", env: { FOO: "bar" } }), { command: "x", args: [], env: { FOO: "bar" } })
  assert.ok("error" in D.validateExec({ command: "  " }))
  assert.ok("error" in D.validateExec({ command: "x", args: "nope" }))
  assert.ok("error" in D.validateExec({ command: "x\0y" }))
  assert.ok("error" in D.validateExec({ command: "x", env: "nope" }))
  assert.ok("error" in D.validateExec({ command: "x", env: { DISPLAY: ":1" } }))
  assert.ok("error" in D.validateExec({ command: "x", env: { WAYLAND_DISPLAY: "w" } }))
  assert.ok("error" in D.validateExec({ command: "x", env: { "A=B": "c" } }))
  assert.ok("error" in D.validateExec({ command: "x", env: { A: 1 } }))
})

const plan = (input) => {
  const result = D.validateWin(input)
  assert.ok(!("error" in result), JSON.stringify(result))
  return result
}
const args = (input, id) => D.winArgs(plan(input), id).join(" ")

test("validateWin refuses unknown ops, missing fields and off-screen pixels", () => {
  assert.match(D.validateWin({}).error, /op must be one of/)
  assert.match(D.validateWin({ op: "move", x: 1, y: 1 }).error, /needs a window/)
  assert.match(D.validateWin({ op: "click", x: 1 }).error, /both x and y/)
  assert.match(D.validateWin({ op: "click", x: 1280, y: 0 }).error, /x must be an integer 0-1279/)
  assert.ok(!("error" in D.validateWin({ op: "click", window: "1", x: 1280, y: 0 })), "window-relative pixels are not bound to the screen")
  assert.match(D.validateWin({ op: "click", x: 1.5, y: 0 }).error, /integer/)
  assert.match(D.validateWin({ op: "scroll", button: 1 }).error, /scroll button/)
  assert.match(D.validateWin({ op: "drag", x: 1, y: 1 }).error, /x2 and y2/)
  assert.match(D.validateWin({ op: "type", text: "" }).error, /type needs text/)
  assert.match(D.validateWin({ op: "type", text: "a\0b" }).error, /NUL/)
  assert.match(D.validateWin({ op: "key", keys: "--sync" }).error, /must not start/)
  assert.match(D.validateWin({ op: "key", keys: "   " }).error, /needs keys/)
  assert.match(D.validateWin({ op: "wait" }).error, /needs a window/)
  assert.match(D.validateWin({ op: "wait", window: "x", timeout: 99 }).error, /timeout/)
  assert.match(D.validateWin({ op: "sleep", ms: 60_000 }).error, /ms/)
  assert.match(D.validateWin({ op: "click", window: "x".repeat(201) }).error, /200 chars/)
  assert.match(D.validateWin({ op: "click", window: 5 }).error, /must be a string/)
})

test("input uses real XTEST events: no --window on clicks or keys, never mousemove --sync", () => {
  // Screen pixels: plain absolute moves.
  assert.equal(args({ op: "click", x: 640, y: 400 }), "mousemove 640 400 click --repeat 1 1")
  assert.equal(args({ op: "click", x: 10, y: 20, count: 2, button: 3 }), "mousemove 10 20 click --repeat 2 3")
  assert.equal(args({ op: "click" }), "click --repeat 1 1")
  // Window-relative pixels: only the move names the window; the press is XTEST.
  assert.equal(args({ op: "click", window: "7", x: 5, y: 6 }, "7"), "mousemove --window 7 5 6 click --repeat 1 1")
  assert.equal(args({ op: "scroll", x: 5, y: 6, count: 4 }), "mousemove 5 6 click --repeat 4 5")
  assert.equal(args({ op: "mousedown", button: 1 }), "mousedown 1")
  assert.equal(args({ op: "mouseup", x: 1, y: 2 }), "mousemove 1 2 mouseup 1")
  // Keyboard: focus the window first when one is given, then XTEST (Chromium drops --window events).
  assert.equal(args({ op: "type", text: "-hi" }), "type -- -hi")
  assert.equal(args({ op: "type", window: "Chromium", text: "hi" }, "9"), "windowfocus 9 type -- hi")
  assert.equal(args({ op: "key", keys: "ctrl+a  BackSpace" }), "key --repeat 1 ctrl+a BackSpace")
  assert.equal(args({ op: "key", keys: "Tab", count: 3 }, "9"), "windowfocus 9 key --repeat 3 Tab")
  assert.equal(args({ op: "keydown", keys: "w" }, "9"), "windowfocus 9 keydown w")
  for (const input of [{ op: "click", x: 1, y: 1 }, { op: "mousemove", x: 1, y: 1 }, { op: "drag", x: 1, y: 1, x2: 9, y2: 9 }])
    for (const id of [undefined, "4"]) assert.ok(!D.winArgs(plan(input), id).includes("--sync"), JSON.stringify(input))
})

test("drag presses at the start, moves through midpoints, releases at the end", () => {
  assert.equal(
    args({ op: "drag", x: 0, y: 0, x2: 90, y2: 30 }),
    "mousemove 0 0 mousedown 1 mousemove 30 10 sleep 0.03 mousemove 60 20 sleep 0.03 mousemove 90 30 sleep 0.05 mouseup 1",
  )
  assert.match(args({ op: "drag", window: "4", x: 0, y: 0, x2: 3, y2: 3 }, "4"), /^mousemove --window 4 0 0 mousedown 1 mousemove --window 4 1 1/)
})

test("window ops need the resolved id; look ops run in the plugin", () => {
  assert.equal(args({ op: "focus", window: "Sober" }, "12"), "windowraise 12 windowfocus 12")
  assert.equal(args({ op: "close", window: "12" }, "12"), "windowclose 12")
  assert.equal(args({ op: "move", window: "12", x: 3, y: 4 }, "12"), "windowmove 12 3 4")
  assert.equal(args({ op: "resize", window: "12", w: 300, h: 200 }, "12"), "windowsize 12 300 200")
  for (const input of [{ op: "list" }, { op: "wait", window: "x" }, { op: "sleep" }]) assert.deepEqual(D.winArgs(plan(input)), [])
  assert.equal(plan({ op: "sleep" }).ms, 500)
  assert.equal(plan({ op: "wait", window: "x" }).timeout, 10)
})

test("clicks move keyboard focus to what was clicked, as a separate best-effort call", () => {
  assert.deepEqual(D.focusAfterArgs(plan({ op: "click", x: 1, y: 1 })), ["getmouselocation", "windowfocus"])
  assert.deepEqual(D.focusAfterArgs(plan({ op: "click", window: "5", x: 1, y: 1 }), "5"), ["windowfocus", "5"])
  assert.equal(D.focusAfterArgs(plan({ op: "type", text: "x" })), undefined)
  assert.equal(D.focusAfterArgs(plan({ op: "scroll" })), undefined)
})

test("validateSteps checks every step before any runs and names the bad one", () => {
  const steps = D.validateSteps([{ op: "click", x: 1, y: 2 }, { op: "type", text: "hi" }, { op: "key", keys: "Return" }])
  assert.ok(Array.isArray(steps) && steps.length === 3)
  assert.match(D.validateSteps([{ op: "click", x: 1, y: 2 }, { op: "nope" }]).error, /^step 2 \(nope\): op must be one of/)
  assert.match(D.validateSteps([]).error, /non-empty/)
  assert.match(D.validateSteps("click").error, /non-empty/)
  assert.match(D.validateSteps([null]).error, /step 1/)
  assert.match(D.validateSteps(Array.from({ length: 51 }, () => ({ op: "sleep" }))).error, /at most 50/)
})

test("describePlan summarizes ops for results and permission prompts", () => {
  assert.equal(D.describePlan(plan({ op: "click", x: 640, y: 400 })), "click 640,400")
  assert.equal(D.describePlan(plan({ op: "click", window: "Chromium", x: 1, y: 2, count: 2 })), 'click 1,2 in "Chromium" x2')
  assert.equal(D.describePlan(plan({ op: "scroll", count: 4 })), "scroll down x4")
  assert.equal(D.describePlan(plan({ op: "drag", x: 1, y: 2, x2: 3, y2: 4 })), "drag 1,2→3,4")
  assert.equal(D.describePlan(plan({ op: "type", text: "x".repeat(50) })), `type "${"x".repeat(39)}…"`)
  assert.equal(D.describePlan(plan({ op: "key", keys: "ctrl+a BackSpace", window: "12" })), "key ctrl+a BackSpace in 12")
  assert.equal(D.describePlan(plan({ op: "wait", window: "Save", timeout: 5 })), 'wait for "Save" (5s)')
})

test("parseWindowInfo reads one chained xdotool call, with or without WM_CLASS", () => {
  const shell = "WINDOW=6291459\nX=10\nY=10\nWIDTH=1050\nHEIGHT=780\nSCREEN=0\n"
  assert.deepEqual(D.parseWindowInfo("6291459", `${shell}page.html\nChromium\n`, true), {
    id: "6291459",
    title: "page.html",
    clazz: "Chromium",
    geometry: { w: 1050, h: 780, x: 10, y: 10 },
  })
  // getwindowclassname failed: the chain stopped, everything after the geometry is the title.
  assert.deepEqual(D.parseWindowInfo("935", `${shell.replace("1050", "1280")}\n`, false), { id: "935", title: "", clazz: "", geometry: { w: 1280, h: 780, x: 10, y: 10 } })
  assert.equal(D.parseWindowInfo("1", "", false).geometry, undefined)
  // The root window: xdotool prints "(null)" for the missing class, so it is filtered as junk.
  const root = D.parseWindowInfo("935", "WINDOW=935\nX=0\nY=0\nWIDTH=1280\nHEIGHT=800\nSCREEN=0\n\n(null)\n", true)
  assert.equal(root.clazz, "")
  assert.equal(D.isRealWindow(root), false)
})

test("the root window and 1x1 helpers are filtered; fragments pick the largest match", () => {
  const root = { id: "935", title: "", clazz: "", geometry: { w: 1280, h: 800, x: 0, y: 0 } }
  const helper = { id: "2", title: "", clazz: "", geometry: { w: 1, h: 1, x: -1, y: -1 } }
  const popup = { id: "3", title: "menu", clazz: "Chromium", geometry: { w: 200, h: 300, x: 0, y: 0 } }
  const main = { id: "4", title: "page", clazz: "Chromium", geometry: { w: 1000, h: 700, x: 0, y: 0 } }
  assert.deepEqual([root, helper, popup, main].filter(D.isRealWindow), [popup, main])
  assert.equal(D.pickWindow([popup, main])?.id, "4")
  assert.equal(D.pickWindow([]), undefined)
})

test("formatWindowList prints id: title | class | geometry and keeps untitled ids", () => {
  assert.equal(
    D.formatWindowList([
      { id: "1", title: "Sober", clazz: "org.vinegarhq.Sober", geometry: { w: 800, h: 600, x: 240, y: 100 } },
      { id: "2", title: "", clazz: "" },
    ]),
    "1: Sober | org.vinegarhq.Sober | 800x600+240+100\n2: (no title)",
  )
  assert.equal(D.formatWindowList([{ id: "1", title: "a\n2: forged", clazz: "" }]), "1: a 2: forged")
})

test("parsePointer and logTail", () => {
  assert.deepEqual(D.parsePointer("X=230\nY=250\nSCREEN=0\nWINDOW=6291459\n"), { x: 230, y: 250 })
  assert.equal(D.parsePointer("nope"), undefined)
  assert.equal(D.logTail("\x1b[31mred\x1b[0m\n\n" + Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), 2), "line 18\nline 19")
})

test("Xvfb readiness is its local socket", () => {
  assert.equal(D.displaySocket(":99"), "/tmp/.X11-unix/X99")
})

test("validateKill takes tracked pids, refuses blanks and non-integers", () => {
  assert.deepEqual(D.validateKill({ pid: 4242 }), { pid: 4242 })
  assert.ok("error" in D.validateKill({}))
  assert.ok("error" in D.validateKill({ pid: 0 }))
  assert.ok("error" in D.validateKill({ pid: -3 }))
  assert.ok("error" in D.validateKill({ pid: 1.5 }))
  assert.ok("error" in D.validateKill({ pid: "4242" }))
})

test("window capture targets one window id through import", () => {
  assert.deepEqual(D.importWindowArgs("12345", "/tmp/w.png"), { command: "import", args: ["-window", "12345", "/tmp/w.png"] })
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
  assert.match(files.get("packages/core/src/plugin/infiniteoc-agent-display-desktop.ts"), /export function openboxConfig/)
  assert.match(files.get("packages/core/src/plugin/infiniteoc-agent-display-viewer.ts"), /^\/\/ The live page[^\n]*\nexport const VIEWER = "<!doctype html>/)
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
  assert.match(safety, /\["list", "wait", "sleep"\]/)
  assert.equal(safety.split(anchor).length, 2)
})

test("command dialog follows the select-alert-confirm pattern", async () => {
  const source = await readFile(new URL("./command.tsx", import.meta.url), "utf8")
  assert.match(source, /ctx\.ui\.select/)
  assert.match(source, /ctx\.ui\.alert/)
  assert.match(source, /ctx\.ui\.confirm/)
  assert.match(source, /agent-display-store/)
  assert.match(source, /Kill app/)
  assert.match(source, /pidAlive/)
})

test("agent guidance teaches the fast loop, coordinates and the chromium tips", () => {
  assert.match(guidance, /steps/)
  assert.match(guidance, /screenshot: true/)
  assert.match(guidance, /screen pixels/)
  assert.match(guidance, /window-relative/)
  assert.match(guidance, /--user-data-dir/)
  assert.match(guidance, /--ozone-platform=x11/)
  assert.match(guidance, /shell permission/)
})

test("plugin source keeps user :0 out and shell permission in", async () => {
  const source = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  assert.match(source, /USER_DISPLAY/)
  assert.match(source, /action: "shell"/)
  assert.match(source, /streamHost/)
  assert.match(source, /from "\.\.\/bus\.js"/)
  assert.match(source, /from "\.\.\/permission\.js"/)
  // One approval covers later input on the agent's own screen.
  assert.match(source, /"agent display input \*"/)
  assert.match(source, /validateSteps/)
  assert.match(source, /displaySocket/)
  assert.ok(!/Effect\.(either|orElse)\(/.test(source), "effect v4 removed either/orElse; use catch")
  assert.ok(!/"timeout", \[/.test(source), "win wait polls; it no longer needs coreutils timeout")
})

// ---- realism: desktop, human input, live view -------------------------------------------------

test("with a window manager, focus activates, close is graceful and clicks leave focus to it", () => {
  const managed = { managed: true }
  assert.equal(D.winArgs(plan({ op: "focus", window: "9" }), "9", managed).join(" "), "windowactivate --sync 9")
  assert.equal(D.winArgs(plan({ op: "close", window: "9" }), "9", managed).join(" "), "windowquit 9")
  assert.equal(D.winArgs(plan({ op: "type", window: "9", text: "hi" }), "9", managed).join(" "), "windowactivate --sync 9 type -- hi")
  // openbox focuses what is clicked; focusing by hand would hit its frame window instead of the app.
  assert.equal(D.focusAfterArgs(plan({ op: "click", x: 1, y: 1 }), undefined, managed), undefined)
})

test("the taskbar is desktop scenery, not a window to work in", () => {
  const geometry = { w: 1280, h: 36, x: 0, y: 764 }
  assert.equal(D.isRealWindow({ id: "1", title: "tint2", clazz: "Tint2", geometry }), false)
})

const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

test("glidePath eases along a gentle curve and lands exactly on the target", () => {
  const from = { x: 100, y: 700 }, to = { x: 900, y: 120 }
  const path = D.glidePath(from, to, seeded())
  assert.deepEqual(path.at(-1), to)
  // ~12ms a move over 170ms + 0.42ms/px (capped at 720ms).
  assert.ok(path.length >= 40 && path.length <= 61, String(path.length))
  // Eased: the middle moves cover more ground than the first and last ones.
  const step = (index) => Math.hypot(path[index + 1].x - path[index].x, path[index + 1].y - path[index].y)
  assert.ok(step(Math.floor(path.length / 2)) > step(0) * 3)
  assert.ok(step(Math.floor(path.length / 2)) > step(path.length - 2) * 3)
  // Curved, but never far off the straight line.
  const off = Math.max(...path.map((p) => Math.abs((to.x - from.x) * (from.y - p.y) - (from.x - p.x) * (to.y - from.y)) / Math.hypot(to.x - from.x, to.y - from.y)))
  assert.ok(off > 0 && off <= 50, String(off))
  assert.deepEqual(D.glidePath(to, { x: 901, y: 120 }), [{ x: 901, y: 120 }])
})

test("realistic input glides from the real pointer, then presses and types like a person", () => {
  const human = { from: { x: 640, y: 400 }, origin: { x: 10, y: 20 }, random: seeded() }
  const click = D.winArgs(plan({ op: "click", window: "5", x: 100, y: 50, count: 2 }), "5", { human })
  const moves = click.filter((arg) => arg === "mousemove").length
  assert.ok(moves > 20, String(moves))
  assert.ok(!click.includes("--window"), "glides in screen pixels")
  // Window-relative 100,50 in a window at 10,20 lands on screen 110,70, then two press/release pairs.
  assert.match(click.join(" "), /mousemove 110 70 sleep 0\.07 mousedown 1 sleep 0\.05 mouseup 1 sleep 0\.09 mousedown 1 sleep 0\.05 mouseup 1$/)
  assert.equal(D.winArgs(plan({ op: "type", text: "hello" }), undefined, { human }).join(" "), "type --delay 38 -- hello")
  assert.equal(D.winArgs(plan({ op: "type", text: "x".repeat(401) }), undefined, { human }).join(" "), `type -- ${"x".repeat(401)}`)
  assert.equal(D.winArgs(plan({ op: "key", keys: "ctrl+l" }), undefined, { human }).join(" "), "key --delay 110 --repeat 1 ctrl+l")
  const drag = D.winArgs(plan({ op: "drag", x: 10, y: 10, x2: 300, y2: 300 }), undefined, { human: { ...human, origin: { x: 0, y: 0 } } }).join(" ")
  assert.match(drag, /mousemove 10 10 sleep 0\.08 mousedown 1 sleep 0\.1 .*mousemove 300 300 sleep 0\.08 mouseup 1$/)
  // Without realistic input it stays instant.
  assert.equal(D.winArgs(plan({ op: "click", x: 5, y: 6 })).join(" "), "mousemove 5 6 click --repeat 1 1")
})

test("captions and screen points describe each op for the live page", () => {
  assert.equal(D.caption(plan({ op: "click", x: 1, y: 1 }), "Example - Chromium"), "Clicking in Example - Chromium")
  assert.equal(D.caption(plan({ op: "click", count: 2 })), "Double-clicking")
  assert.equal(D.caption(plan({ op: "type", text: "hello\nworld" })), "Typing “hello world”")
  assert.equal(D.caption(plan({ op: "key", keys: "ctrl+l" })), "Pressing ctrl+l")
  assert.equal(D.caption(plan({ op: "scroll", button: 4 })), "Scrolling up")
  assert.deepEqual(D.screenPoint(plan({ op: "drag", window: "3", x: 1, y: 2, x2: 3, y2: 4 }), { x: 10, y: 20 }), { at: { x: 11, y: 22 }, to: { x: 13, y: 24 } })
})

test("mpjpegFrames rebuilds whole frames from arbitrary pipe chunks", () => {
  const jpeg = (size, fill) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(size, fill), Buffer.from([0xff, 0xd9])])
  const frames = [jpeg(10, 1), jpeg(70_000, 2), jpeg(3, 3)]
  const stream = Buffer.concat(frames.map((frame) => Buffer.concat([Buffer.from(`--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: ${frame.length}\r\n\r\n`), frame, Buffer.from("\r\n")])))
  for (const size of [1, 7, 4096, 65536, stream.length]) {
    const got = []
    const push = D.mpjpegFrames((frame) => got.push(frame))
    for (let offset = 0; offset < stream.length; offset += size) push(stream.subarray(offset, offset + size))
    assert.deepEqual(got, frames, `chunk ${size}`)
  }
})

test("the live page gets the display's name and size", async () => {
  const html = D.viewerHtml(await readFile(new URL("./viewer.html", import.meta.url), "utf8"), ":99")
  assert.ok(!html.includes("__"), "every placeholder filled")
  assert.match(html, /const W = 1280, H = 800/)
  assert.match(html, /\/stream\.mjpg/)
  assert.match(html, /new EventSource\("\/events"\)/)
  assert.ok(!/(src|href)="https?:/.test(html), "no external resources: the page works offline and leaks nothing")
})

test("describeStatus names the desktop or how to get one", () => {
  assert.match(D.describeStatus({ display: ":99", running: true, pid: process.pid, apps: [], desktop: { wm: process.pid, panel: process.pid } }), /Desktop: openbox window manager \+ taskbar/)
  assert.match(D.describeStatus({ display: ":99", running: true, pid: process.pid, apps: [] }), /bare X \(install openbox and tint2/)
})

test("desktop configs: themed openbox with working buttons, tint2 taskbar, wallpaper", () => {
  const rc = K.openboxConfig()
  assert.match(rc, /<name>InfiniteOC<\/name>/)
  for (const context of ["Titlebar", "Close", "Maximize", "Iconify", "Client"]) assert.match(rc, new RegExp(`<context name="${context}">`))
  assert.match(rc, /<keybind key="A-F4"><action name="Close"\/>/)
  assert.ok(!/root-menu|ShowMenu/.test(rc), "no desktop menu that launches untracked programs")
  assert.match(K.openboxTheme(), /^window\.active\.title\.bg\.color: #1d1a2b$/m)
  assert.match(K.tint2Config(), /^panel_items = PTC$/m)
  assert.match(K.tint2Config(), /^panel_size = 100% 36$/m)
  const wall = K.wallpaperArgs("/tmp/w.png", 1280, 800)
  assert.equal(wall.at(-1), "/tmp/w.png")
  assert.equal(wall.filter((arg) => arg === "(").length, wall.filter((arg) => arg === ")").length)
  const files = K.desktopFiles("/data")
  assert.equal(files.theme, "/data/desktop/themes/InfiniteOC/openbox-3/themerc")
  assert.equal(K.desktopEnv({ DISPLAY: ":99" }, "/data").XDG_DATA_HOME, "/data/desktop")
})

test("realistic input is a saved toggle, off by default", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "agent-display-settings-"))
  const env = { XDG_DATA_HOME: home }
  try {
    assert.deepEqual(D.readSettings(env), { realistic: false })
    D.writeSettings({ realistic: true }, env)
    assert.deepEqual(D.readSettings(env), { realistic: true })
    await writeFile(D.settingsFile(env), "{ broken")
    assert.deepEqual(D.readSettings(env), { realistic: false }, "a broken file falls back to off")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("/display toggles realistic input from the keyboard menu", async () => {
  const source = await readFile(new URL("./command.tsx", import.meta.url), "utf8")
  assert.match(source, /Realistic input: \$\{settings\.realistic \? "on" : "off"\}/)
  assert.match(source, /writeSettings\(\{ \.\.\.settings, realistic: !settings\.realistic \}\)/)
  const plugin = await readFile(new URL("./plugin.ts", import.meta.url), "utf8")
  assert.match(plugin, /const human = realistic\(\)/)
})
