import { readFile } from "node:fs/promises"

// Agent display: the agent's own isolated screen (Xvfb, never the user's :0).
// Server: pure helpers plus the agent_display tool, registered next to upstream's
// subagent tool. TUI: /display reads the status file the server writes.
function replace(source, before, after, label = before) {
  if (typeof source !== "string" || source.split(before).length !== 2) throw new Error(`agent-display: expected one source anchor: ${label}`)
  if (source.includes(after)) throw new Error(`agent-display: already applied: ${label}`)
  return source.replace(before, () => after)
}

const file = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8")

// The plugin imports its sibling as "./display.ts" so node tests load it directly;
// the build gets the written name.
const LIB = "infiniteoc-agent-display-lib.js"
const relink = (source) => {
  const out = source.replace(/from "\.\/display\.ts"/g, `from "./${LIB}"`)
  if (/from "\.\/display\.ts"/.test(out)) throw new Error("agent-display: unmapped ./display.ts import")
  return out
}

const CORE = "packages/core/src/plugin"
const FEATURES = "packages/tui/src/infiniteoc-features"

export const guidance = `[Agent display]
You have your own isolated screen (Xvfb :99, 1280x800), separate from the user's display: programs you exec there get DISPLAY=:99 and no WAYLAND_DISPLAY. Use the agent_display tool.
- Fast loop: exec (waits for the program's window and returns its id and geometry), then steps with several ops and screenshot: true, read the frame, repeat. One steps call can click, type, press keys, wait for a window and sleep; prefer it to many single win calls.
- Click text by label instead of guessing pixels: { op: "click", label: "Consent" } finds that text on screen (OCR) and clicks its center; a button or link beats the same word inside a sentence, nth picks another match. find lists the visible text with x,y (cheaper than a screenshot); { op: "wait", label: "Done" } waits for text. Pixel guesses from screenshots are often 20-50px off; use x/y only for things without text (icons, canvas, games).
- Coordinates: without window, x/y are screen pixels, the same pixels as a full screenshot. With window (id or title/class fragment), x/y are window-relative, matching a screenshot of that window.
- Input is real (XTEST): a click hits whatever is on top at that point and moves keyboard focus there; type/key go to the focused window. keys are X keysyms, space separated: "Return", "ctrl+l", "ctrl+a BackSpace".
- Take a screenshot when a claim depends on what is on the screen, and read it before describing it. show shares a frame with the user; the live page (stream) is for the user to watch, not for you.
- It is a small desktop: openbox places windows and gives them title bars (close/maximize buttons work, alt+F4 too), a taskbar with a clock takes the bottom 36px, clicking a window focuses it. status says when the screen is bare X instead.
- The user can turn on realistic input in /display: then the pointer glides, typing is human speed and steps pause briefly, so calls take longer. It is instant by default; status shows which.
- Chromium: pass --ozone-platform=x11 and a fresh --user-data-dir per spawn, or it tries Wayland or opens its window in an instance that is already running.
- exec, kill, stream and input ops go through the normal shell permission, so /readonly, allow-lists and yolo apply.`
const marker = "// infiniteoc:guidance-extensions"

// safe-guard's /readonly refuses shells that may change state and editing subagents;
// spawning/killing programs, driving windows, managing the display and opening the
// live view are state changes too, while looking at it (status, screenshot, plain
// show) stays allowed like any other read.
const READONLY_ANCHOR = '        if (event.tool === "subagent" && !["explore", "reviewer", "researcher"].includes(agent)) return Effect.fail(new Tool.Error({ message: readonlyRefusal(`the ${agent || "general"} subagent (it can edit)`) }))\n'
const READONLY_DISPLAY = `        // mods/agent-display: spawning/killing, input, display management and the live view change state; looking (status, screenshot, plain show, list/find/wait/sleep) does not.
        if (event.tool === "agent_display") {
          const displayInput = event.input as { action?: unknown; op?: unknown; steps?: unknown; live?: unknown }
          const displayAction = String(displayInput?.action ?? "")
          const looks = (op: unknown) => ["list", "find", "wait", "sleep"].includes(String(op ?? ""))
          const acts =
            ["exec", "kill", "start", "stop", "stream"].includes(displayAction) ||
            (displayAction === "win" && !looks(displayInput?.op)) ||
            (displayAction === "steps" && !(Array.isArray(displayInput?.steps) && displayInput.steps.every((step: any) => looks(step?.op)))) ||
            displayInput?.live === true
          if (acts) return Effect.fail(new Tool.Error({ message: readonlyRefusal("the agent display (input and programs change state)") }))
        }
`

export default {
  id: "agent-display",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${CORE}/${LIB.replace(/\.js$/, ".ts")}`, await file("display.ts"))
    await api.write(`${CORE}/infiniteoc-agent-display-desktop.ts`, await file("desktop.ts"))
    await api.write(`${CORE}/infiniteoc-agent-display-viewer.ts`, `// The live page (mods/agent-display/viewer.html).\nexport const VIEWER = ${JSON.stringify(await file("viewer.html"))}\n`)
    await api.write(`${CORE}/infiniteoc-agent-display.ts`, relink(await file("plugin.ts")))
    await api.patch(`${CORE}/internal.ts`, (source) => {
      source = replace(source, 'import { SubagentTool } from "../tool/plugin/subagent.js"\n', 'import { SubagentTool } from "../tool/plugin/subagent.js"\nimport * as InfiniteocAgentDisplay from "./infiniteoc-agent-display.js"\n')
      return replace(source, "  SubagentTool.Plugin,\n", "  SubagentTool.Plugin,\n  InfiniteocAgentDisplay.Plugin,\n")
    })
    await api.patch("packages/core/src/infiniteoc/guidance.ts", (source) => {
      if (typeof source !== "string") throw new Error("agent-display: invalid source")
      if (source.includes("[Agent display]")) throw new Error("agent-display: already applied; refusing to duplicate")
      if (source.split(marker).length !== 2) throw new Error("agent-display: expected one source anchor: InfiniteOC guidance marker")
      return source.replace(marker, () => `infiniteocGuidance.build.push(${JSON.stringify(guidance)})\n${marker}`)
    })

    // safe-guard (when enabled before this mod): /readonly also covers display exec/kill/start/stop.
    const safety = `${CORE}/infiniteoc-safety.ts`
    const guarded = await api.read(safety).then((source) => source.includes(READONLY_ANCHOR), () => false)
    if (guarded) await api.patch(safety, (source) => replace(source, READONLY_ANCHOR, READONLY_ANCHOR + READONLY_DISPLAY, "safe-guard readonly subagent rule"))

    // TUI: the shared status reader plus /display (status, latest frame, stop).
    await api.write(`${FEATURES}/agent-display-store.ts`, await file("display.ts"))
    api.tui.command({
      id: "display",
      title: "Agent display: status, latest frame, stop",
      slash: "display",
      category: "Mods",
      source: await file("command.tsx"),
    })
  },
}
