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
The agent has its own isolated screen (Xvfb, default :99), separate from the user's session. It never touches the user's :0/Wayland display: spawned programs get DISPLAY=:99 with WAYLAND_DISPLAY unset.
- Use the agent_display tool: status (is it running, what apps, is the live view on), exec (spawn a program there; runs in the project directory), win (list, focus, move, resize, click, type, key, close windows via title or id), screenshot (see the screen; costs image tokens, use sparingly), show (screenshot plus a user-visible note so the user can view the frame with <leader>i), stream (live watch page on this machine only), start/stop.
- exec, win, stream and show with live go through the normal shell permission, so /readonly, allow-lists and yolo apply. Screenshots are PNG frames: take one when a claim depends on what is actually on the screen, then read it before describing it. The live page is for the user to watch, not for the agent to see.
- Chromium on a Wayland box still tries Wayland: pass --ozone-platform=x11. There is no window manager, so focusing warns but move/resize/click/type work.`
const marker = "// infiniteoc:guidance-extensions"

// safe-guard's /readonly refuses shells that may change state and editing subagents;
// spawning programs, driving windows, managing the display and opening the live view
// are state changes too, while looking at it (status, screenshot, plain show) stays
// allowed like any other read.
const READONLY_ANCHOR = '        if (event.tool === "subagent" && !["explore", "reviewer", "researcher"].includes(agent)) return Effect.fail(new Tool.Error({ message: readonlyRefusal(`the ${agent || "general"} subagent (it can edit)`) }))\n'
const READONLY_DISPLAY = `        // mods/agent-display: spawning, window control, display management and the live view change state; looking does not.
        if (event.tool === "agent_display") {
          const displayInput = event.input as { action?: unknown; live?: unknown }
          if (["exec", "win", "start", "stop", "stream"].includes(String(displayInput?.action ?? "")) || displayInput?.live === true)
            return Effect.fail(new Tool.Error({ message: readonlyRefusal("the agent display (driving windows changes state)") }))
        }
`

export default {
  id: "agent-display",
  version: "1.0.0",
  async setup(api) {
    await api.write(`${CORE}/${LIB.replace(/\.js$/, ".ts")}`, await file("display.ts"))
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

    // safe-guard (when enabled before this mod): /readonly also covers display exec/start/stop.
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
