import { readFile } from "node:fs/promises"
import path from "node:path"
import { installSettings } from "./settings/index.mjs"
import { workflowInstruction } from "./workflow.mjs"

// Anchor checks intentionally fail closed on incompatible upstream revisions.
function replace(source, before, after) {
  if (source.includes(after)) return source
  if (source.split(before).length !== 2) throw new Error(`InfiniteOC: expected one source anchor: ${before}`)
  return source.replace(before, after)
}

export default {
  id: "infiniteoc",
  version: "1.0.0",
  async setup(api) {
    const theme = JSON.parse(await readFile(path.join(api.root, "packages/tui/src/theme/assets/v2/opencode.json"), "utf8"))
    // Reuse the exact v2 token tree; keep semantic error/success/diff colors intact.
    const colors = {
      dark: {
        gray: ["#fff5ff", "#f3e8ff", "#cfb8df", "#a78bbd", "#654777", "#302039", "#211629", "#160f1d", "#0e0913"],
        purple: ["#e9c5ff", "#c084fc", "#a864db", "#904dbd", "#763aa0", "#5e2880", "#461961", "#300e43", "#1c0529"],
        pink: ["#ffd0ed", "#f472b6", "#d45a9b", "#b44480", "#943165", "#74214d", "#561437", "#3a0924", "#210314"],
      },
      light: {
        gray: ["#21102b", "#321842", "#60416f", "#876996", "#b59fc1", "#eee3f4", "#f7eefb", "#fffaff", "#ffffff"],
        purple: ["#6b21a8", "#7e22ce", "#9333ea", "#a855f7", "#c084fc", "#d8b4fe", "#e9d5ff", "#f3e8ff", "#faf5ff"],
        pink: ["#9d174d", "#be185d", "#db2777", "#ec4899", "#f472b6", "#f9a8d4", "#fbcfe8", "#fce7f3", "#fdf2f8"],
      },
    }
    for (const mode of ["dark", "light"]) {
      for (const [hue, values] of Object.entries(colors[mode])) {
        theme[mode].hue[hue] = Object.fromEntries(values.map((color, i) => [String((i + 1) * 100), color]))
      }
      theme[mode].hue.interactive = "$hue.purple"
      theme[mode].hue.accent = "$hue.pink"
      theme[mode].border = { ...theme[mode].border, base: mode === "dark" ? "#654777" : "#b59fc1" }
      theme[mode].scrollbar = { ...theme[mode].scrollbar, base: mode === "dark" ? "#a864db" : "#a855f7" }
    }
    // Warning yellow is a safety/status signal, not a branding accent.
    theme.light.text.feedback.warning.base = "#a16207"
    await api.write("packages/tui/src/theme/assets/v2/infiniteoc.json", JSON.stringify(theme, null, 2) + "\n")
    await api.patch("packages/tui/src/theme/index.ts", (source) => {
      source = replace(source, 'import opencode from "./assets/v2/opencode.json" with { type: "json" }', 'import opencode from "./assets/v2/opencode.json" with { type: "json" }\nimport infiniteoc from "./assets/v2/infiniteoc.json" with { type: "json" }')
      return replace(source, "    opencode: getOpenCodeTheme(),", "    opencode: getOpenCodeTheme(),\n    infiniteoc,")
    })
    await api.patch("packages/tui/src/context/theme.tsx", (source) => {
      source = replace(source, '  active: "opencode",', '  active: "infiniteoc",')
      source = replace(source, 'draft.active = config.theme?.name ?? "opencode"', 'draft.active = !config.theme?.name || config.theme.name === "opencode" ? "infiniteoc" : config.theme.name')
      return replace(source, 'const theme = config.theme?.name', 'const theme = config.theme?.name === "opencode" ? "infiniteoc" : config.theme?.name')
    })
    await api.patch("packages/core/src/plugin/agent.ts", (source) => {
      source = replace(source, 'item.name = Agent.Name.make("Build")', 'item.name = Agent.Name.make("InfiniteOC")')
      return replace(source,
        'item.description = "The default agent. Executes tools based on configured permissions."',
        'item.description = "Unified primary agent for reasoning, planning, and implementation. Executes tools based on configured permissions."')
    })
    await api.patch("packages/core/src/plugin/plan.ts", (source) =>
      replace(source, '        item.mode = "primary"', '        item.mode = "primary"\n        item.hidden = true // InfiniteOC: retain legacy Plan restrictions, omit selector'))
    await api.patch("packages/core/src/config/plugin/agent.ts", (source) => {
      const instruction = workflowInstruction
      return replace(source, '      }\n    })\n  }),\n})', `      }
      // InfiniteOC finalizes presentation after config; never change permission rules.
      const build = editor.get(Agent.defaultID)
      if (build) editor.update(Agent.defaultID, (agent) => {
        agent.name = Agent.Name.make("InfiniteOC")
        agent.color = Agent.Color.make("#c084fc")
        const instruction = ${JSON.stringify(instruction)}
        if (!agent.system?.includes("[InfiniteOC unified workflow]")) {
          agent.system = [agent.system, instruction].filter(Boolean).join("\\n\\n")
        }
      })
      const legacyPlan = Agent.ID.make("plan")
      if (editor.get(legacyPlan)) editor.update(legacyPlan, (agent) => { agent.hidden = true })
      if (build) {
        editor.default(Agent.defaultID)
        for (const current of editor.list()) {
          if (current.id !== Agent.defaultID && current.mode !== "subagent") {
            editor.update(current.id, (agent) => { agent.hidden = true })
          }
        }
      }
    })
  }),
})`)
    })
    await api.patch("packages/tui/src/component/prompt/index.tsx", (source) =>
      replace(source, 'agentLabel: agent ? Locale.titlecase(agent.id) : undefined,', 'agentLabel: agent ? agent.name : undefined,'))
    await api.patch("packages/tui/src/component/dialog-agent.tsx", (source) =>
      replace(source, 'title: item.id,', 'title: item.name,'))
    await api.patch("packages/tui/src/mini/footer.command.tsx", (source) =>
      replace(source, 'display: agent.id,', 'display: agent.name,'))
    await api.write("packages/tui/src/component/logo.tsx", logoSource(Boolean(api.options?.reducedMotion)))
    await installSettings(api)
  },
}

function logoSource(reducedMotion) {
  const art = [
    " ___        __ _       _ _        ___   ____ ",
    "|_ _|_ __  / _(_)_ __ (_) |_ ___ / _ \\ / ___|",
    " | || '_ \\| |_| | '_ \\| | __/ _ \\ | | | |    ",
    " | || | | |  _| | | | | | ||  __/ |_| | |___ ",
    "|___|_| |_|_| |_|_| |_|_|\\__\\___|\\___/ \\____|",
  ]
  return `// InfiniteOC: source-only branding; no network or permission hooks.
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, createSignal, onCleanup, onMount } from "solid-js"

const art = ${JSON.stringify(art, null, 2)}

export function Logo() {
  const dimensions = useTerminalDimensions()
  const [phase, setPhase] = createSignal(0)
  onMount(() => {
    if (${reducedMotion}) return
    const timer = setInterval(() => setPhase((value) => (value + 0.12) % (Math.PI * 2)), 100)
    onCleanup(() => clearInterval(timer))
  })
  const color = (column: number, row: number) => {
    const mix = (Math.sin(column * 0.15 + row * 0.3 + phase()) + 1) / 2
    return RGBA.fromInts(Math.round(192 + 52 * mix), Math.round(132 - 18 * mix), Math.round(252 - 70 * mix), 255)
  }
  const lines = () => dimensions().width < 48 ? ["InfiniteOC"] : art
  return (
    <box>
      <For each={dimensions().height < 12 ? [] : lines()}>
        {(line, row) => (
          <box flexDirection="row">
            <For each={Array.from(line)}>
              {(char, column) => <text fg={color(column(), row())} attributes={TextAttributes.BOLD} selectable={false}>{char}</text>}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
`
}