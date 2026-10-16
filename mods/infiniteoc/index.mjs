import { readFile } from "node:fs/promises"
import path from "node:path"
import { installSettings } from "./settings/index.mjs"
import { guidance, extensionMarker } from "./workflow.mjs"

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
    // Agent colors and /stats use categorical[0]; dark mode otherwise inherits blue-first from base.
    theme.dark.categorical = ["purple", "blue", "green", "orange", "red"]
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
    // Guidance is not set as agent.system: that would replace upstream's base and model-tuned prompts.
    await api.patch("packages/core/src/config/plugin/agent.ts", (source) =>
      replace(source, '      }\n    })\n  }),\n})', `      }
      // InfiniteOC finalizes presentation after config; never change permission rules.
      const build = editor.get(Agent.defaultID)
      if (build) editor.update(Agent.defaultID, (agent) => {
        agent.name = Agent.Name.make("InfiniteOC")
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
})`))
    await api.patch("packages/core/src/plugin/agent.ts", (source) => {
      source = replace(source,
        '"General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."',
        '"Implementation worker for a bounded, well-specified change or multi-step task in files you assign. Give it the goal, owned files, constraints and the checks that define done; it reports changed files and check results. Run several in parallel only on non-overlapping files."')
      return replace(source, '      editor.update(Agent.ID.make("compaction"), (item) => {', `${subagents}
      editor.update(Agent.ID.make("compaction"), (item) => {`)
    })
    // Awareness: project instructions also come from CLAUDE.md in directories without an AGENTS.md
    // (many repos only have CLAUDE.md), and the environment block names the OS release and shell.
    await api.patch("packages/core/src/config/plugin/instruction.ts", (source) => {
      source = replace(source, '              .map((directory) => join(directory, "AGENTS.md"))', '              .flatMap((directory) => [join(directory, "AGENTS.md"), join(directory, "CLAUDE.md")])')
      return replace(source, '        const walked = yield* Effect.forEach(yield* fs.up({ targets: ["AGENTS.md"], start, stop }), fs.resolve)\n', `        const found = yield* Effect.forEach(yield* fs.up({ targets: ["AGENTS.md", "CLAUDE.md"], start, stop }), fs.resolve)
        // InfiniteOC: CLAUDE.md only where the same directory has no AGENTS.md.
        const walked = found.filter((file) => !file.endsWith("/CLAUDE.md") || !found.includes(join(dirname(file), "AGENTS.md")))
`)
    })
    await api.patch("packages/core/src/instructions/builtins.ts", (source) => {
      source = replace(source, 'import { Global } from "@opencode/util/global"', 'import { Global } from "@opencode/util/global"\nimport { release, type as osType } from "os"')
      return replace(source, "                  `  Platform: ${process.platform}`,\n", "                  `  Platform: ${process.platform}`,\n                  `  OS: ${osType()} ${release()} (${process.arch})${process.env.SHELL ? `, shell ${process.env.SHELL}` : \"\"}`,\n")
    })
    // Explore runs on the provider's small model (Haiku, Flash, Luna) at minimal reasoning unless the
    // caller or config picks a model; it only searches, so speed matters more than depth there.
    await api.patch("packages/core/src/tool/plugin/subagent.ts", (source) =>
      replace(source, "              const model = override ?? agent.model ?? parent.model\n", `              const fast =
                !override && !agent.model && parent.model && agent.id === "explore" && process.env.INFINITEOC_FAST_EXPLORE !== "0"
                  ? yield* models.small(parent.model.providerID).pipe(
                      Effect.map((info) => {
                        if (!info) return undefined
                        const variant = ["none", "minimal", "low"].find((id) => info.variants.some((item) => item.id === id))
                        return Model.Ref.make({ providerID: info.providerID, id: info.id, ...(variant ? { variant: Model.VariantID.make(variant) } : {}) })
                      }),
                      Effect.orElseSucceed(() => undefined),
                    )
                  : undefined
              const model = override ?? agent.model ?? fast ?? parent.model
`))
    // Per-agent guidance becomes an instruction block in every session's context, after upstream's
    // base/model prompt. Other mods append through the extension marker.
    await api.write("packages/core/src/infiniteoc/guidance.ts", guidanceSource())
    await api.patch("packages/core/src/session/context.ts", (source) => {
      source = replace(source, 'import { Context, Effect, Layer } from "effect"', 'import { Context, Effect, Layer, Schema } from "effect"\nimport { infiniteocGuidance } from "../infiniteoc/guidance.js"')
      return replace(source, '        instructions: Instructions.combine([\n          CodeModeInstructions.make(loaded.tools.codeModeCatalog),', `        instructions: Instructions.combine([
          Instructions.make({
            key: Instructions.Key.make("infiniteoc/guidance"),
            codec: Schema.toCodecJson(Schema.String),
            read: Effect.succeed(infiniteocGuidance[agent.id]?.join("\\n\\n") || Instructions.removed),
            render: {
              initial: (text) => text,
              changed: (_previous, text) => text,
              removed: () => "Earlier InfiniteOC guidance no longer applies to this agent.",
            },
          }),
          CodeModeInstructions.make(loaded.tools.codeModeCatalog),`)
    })
    // The launcher points INFINITEOC_SKILLS at the bundled skills/ library (mostly unlisted, loadable by ID).
    await api.patch("packages/core/src/config/plugin/skill.ts", (source) =>
      replace(source, '        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))\n      }\n', `        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))
      }
      if (process.env.INFINITEOC_SKILLS) add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(process.env.INFINITEOC_SKILLS) }))
`))
    // /goal: a server command plus a turn-end loop that keeps prompting until the goal is verified.
    await api.write("packages/core/src/plugin/infiniteoc-goal.ts", await readFile(new URL("./goal.ts", import.meta.url), "utf8"))
    // The goal record that survives compaction (goal, counters, the plan goal_progress keeps).
    await api.write("packages/core/src/plugin/infiniteoc-goal-store.ts", await readFile(new URL("./goal-store.ts", import.meta.url), "utf8"))
    // Background work (mods/workflows) registers here so a held goal waits for it instead of re-prompting.
    await api.write("packages/core/src/infiniteoc/background.ts", await readFile(new URL("./background.ts", import.meta.url), "utf8"))
    // Frontend gate: UI-file edits are refused until the session has loaded the frontend-design skill.
    await api.write("packages/core/src/plugin/infiniteoc-frontend.ts", await readFile(new URL("./frontend.ts", import.meta.url), "utf8"))
    // Ponytail: the bundled lazy-senior-dev ruleset, inlined and applied to turns that write code.
    const ponytail = await readFile(new URL("../../skills/ponytail/SKILL.md", import.meta.url), "utf8")
    await api.write("packages/core/src/plugin/infiniteoc-ponytail.ts",
      (await readFile(new URL("./ponytail.ts", import.meta.url), "utf8")).replace('"__PONYTAIL_SKILL__"', () => JSON.stringify(ponytail)))
    await api.patch("packages/core/src/plugin/internal.ts", (source) => {
      source = replace(source, 'import { PlanPlugin } from "./plan.js"', 'import { PlanPlugin } from "./plan.js"\nimport * as InfiniteocGoal from "./infiniteoc-goal.js"\nimport * as InfiniteocFrontend from "./infiniteoc-frontend.js"\nimport * as InfiniteocPonytail from "./infiniteoc-ponytail.js"')
      return replace(source, "  PlanPlugin.Plugin,\n", "  PlanPlugin.Plugin,\n  InfiniteocGoal.Plugin,\n  InfiniteocFrontend.Plugin,\n  InfiniteocPonytail.Plugin,\n")
    })
    // /goal in the TUI: the word glows while typed, an indicator shows the active goal under the
    // prompt, and the start message is shown as "/goal <text>" instead of the full protocol.
    const tui = (name) => readFile(new URL(`./tui/${name}`, import.meta.url), "utf8")
    await api.write("packages/tui/src/component/prompt/goal-word.ts", await tui("goal-word.ts"))
    await api.write("packages/tui/src/feature-plugins/prompt/goal.tsx", await tui("goal-status.tsx"))
    await api.patch("packages/tui/src/component/prompt/index.tsx", (source) => {
      source = replace(source, 'import { useTheme, useThemes } from "../../context/theme"', 'import { useTheme, useThemes } from "../../context/theme"\nimport { createGoalWord } from "./goal-word"')
      // After the store is declared: the memos inside run immediately.
      return replace(source, "  function syncExtmarksWithPromptParts() {\n", "  createGoalWord(() => input, () => store.prompt.text, syntax, theme, animationsEnabled)\n\n  function syncExtmarksWithPromptParts() {\n")
    })
    await api.patch("packages/tui/src/plugin/builtins.ts", (source) => {
      source = replace(source, 'import PromptBtw from "../feature-plugins/prompt/btw"', 'import PromptBtw from "../feature-plugins/prompt/btw"\nimport PromptGoal from "../feature-plugins/prompt/goal"')
      return replace(source, "  PromptBtw,\n", "  PromptBtw,\n  PromptGoal,\n")
    })
    await api.patch("packages/tui/src/routes/session/index.tsx", (source) =>
      replace(source, "<text fg={theme.text.base}>{props.message.text}</text>",
        '<text fg={theme.text.base}>{props.message.text.startsWith("[InfiniteOC goal]\\nGoal: ") ? `/goal ${props.message.text.split("\\n")[1].slice(6)}` : props.message.text}</text>'))
    await api.patch("packages/tui/src/component/prompt/index.tsx", (source) =>
      replace(source, 'agentLabel: agent ? Locale.titlecase(agent.id) : undefined,', 'agentLabel: agent ? agent.name : undefined,'))
    await api.patch("packages/tui/src/component/dialog-agent.tsx", (source) =>
      replace(source, 'title: item.id,', 'title: item.name,'))
    await api.patch("packages/tui/src/mini/footer.command.tsx", (source) =>
      replace(source, 'display: agent.id,', 'display: agent.name,'))
    await api.write("packages/tui/src/component/logo.tsx", await readFile(new URL("./logo.tsx", import.meta.url), "utf8"))
    // options.reducedMotion is the default of the one runtime Animations switch (logo, toasts,
    // spinners, tab pulses); the TUI config, /settings and "Disable animations" still override it.
    // Resolving it here also makes /settings show the effective value instead of "off".
    await api.patch("packages/tui/src/config/index.tsx", (source) =>
      replace(source, "    mouse: input.mouse ?? true,\n", `    mouse: input.mouse ?? true,\n    animations: input.animations ?? ${!api.options?.reducedMotion},\n`))
    // Shared wordmark data: the home logo, and the exit epilogue printed to the shell.
    await api.patch("packages/tui/src/logo.ts", (source) => replace(source, upstreamWordmark, wordmark))
    // Resume hints must reopen InfiniteOC, not the stock OpenCode install.
    await api.patch("packages/tui/src/util/presentation.ts", (source) =>
      replace(source, "${bold}opencode -s ${input.sessionID}", "${bold}infiniteoc -s ${input.sessionID}"))
    await api.patch("packages/tui/src/mini/splash.ts", (source) =>
      replace(source, "const command = `opencode mini -s ${meta.session_id}`", "const command = `infiniteoc mini -s ${meta.session_id}`"))
    await api.patch("packages/tui/src/feature-plugins/system/stats.tsx", (source) =>
      replace(source, "          opencode / stats\n", "          infiniteoc / stats\n"))
    // A pinned source build: never phone home for updates, never upgrade or uninstall OpenCode.
    // Upstream's uninstaller deletes the data/config/sessions shared with the stock install.
    await api.patch("packages/cli/src/services/updater.ts", (source) => {
      source = replace(source, 'import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"',
        `import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"\nconst INFINITEOC_PINNED = ${JSON.stringify(pinned)}`)
      source = replace(source, '  const inspect = Effect.fnUntraced(function* () {\n',
        '  const inspect = Effect.fnUntraced(function* () {\n    if (OPENCODE_CHANNEL === "infiniteoc") return undefined\n')
      source = replace(source, '  const check = Effect.fn("cli.updater.check")(function* () {\n',
        '  const check = Effect.fn("cli.updater.check")(function* () {\n    if (OPENCODE_CHANNEL === "infiniteoc") return { type: "unavailable" as const, message: INFINITEOC_PINNED }\n')
      return replace(source, '  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {\n',
        '  const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {\n    if (OPENCODE_CHANNEL === "infiniteoc") return yield* Effect.fail(new Error(INFINITEOC_PINNED))\n')
    })
    await api.patch("packages/cli/src/commands/handlers/uninstall.ts", (source) => {
      source = replace(source, 'import { errorMessage } from "../../util/error"', 'import { errorMessage } from "../../util/error"\nimport { OPENCODE_CHANNEL } from "../../version"')
      return replace(source, '  Effect.fn("cli.uninstall")(function* (input) {\n',
        `  Effect.fn("cli.uninstall")(function* (input) {\n    if (OPENCODE_CHANNEL === "infiniteoc") return yield* Effect.fail(new Error(${JSON.stringify(noUninstall)}))\n`)
    })
    // Brand the always-visible surfaces: reply footers said "Build", the terminal title "OpenCode".
    await api.patch("packages/tui/src/routes/session/index.tsx", (source) =>
      replace(source, "            {Locale.titlecase(props.message.agent)}\n",
        "            {local.agent.list().find((agent) => agent.id === props.message.agent)?.name ?? Locale.titlecase(props.message.agent)}\n"))
    await api.patch("packages/tui/src/app.tsx", (source) => {
      source = replace(source, '    if (route.data.type === "home") {\n      renderer.setTerminalTitle("OpenCode")', '    if (route.data.type === "home") {\n      renderer.setTerminalTitle("InfiniteOC")')
      return replace(source, '      if (!title || isFallbackTitle(title)) {\n        renderer.setTerminalTitle("OpenCode")', '      if (!title || isFallbackTitle(title)) {\n        renderer.setTerminalTitle("InfiniteOC")')
    })
    // Dialogs dim the page in over 120ms instead of a hard cut; content and focus are instant, and
    // wizard steps (dialog.replace) keep the mounted backdrop, so the fade plays once per open.
    await api.patch("packages/tui/src/ui/dialog.tsx", (source) => {
      source = replace(source, 'import { copy, copyOnSelectRelease } from "../util/selection"', 'import { copy, copyOnSelectRelease } from "../util/selection"\nimport { createAnimatable, tween } from "./animation"')
      source = replace(source, '  const renderer = useRenderer()\n\n  let dismiss = false\n',
        '  const renderer = useRenderer()\n  const config = useConfig()\n  const dim = createAnimatable({ alpha: 0 }, { enabled: () => config.data.animations ?? true, transition: tween({ duration: 0.12 }) })\n  dim.animate({ alpha: 150 })\n\n  let dismiss = false\n')
      return replace(source, '      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}', '      backgroundColor={RGBA.fromInts(0, 0, 0, Math.round(dim.value().alpha))}')
    })
    // Each toast's text sweeps in with upstream FadeInText (200ms, off when animations are off).
    // Keyed so every new toast remounts and animates, not only the first after an idle gap.
    // A store set merges into the visible toast object, so a replacement used to inherit the
    // old title and click action (e.g. "Probe free models"); clear first to really replace it.
    await api.patch("packages/tui/src/ui/toast.tsx", (source) => {
      source = replace(source, '      setStore("currentToast", toastOptions)\n      start(toastOptions.duration)',
        '      setStore("currentToast", null)\n      setStore("currentToast", toastOptions)\n      start(toastOptions.duration)')
      source = replace(source, '    setStore("currentToast", next ?? null)\n',
        '    setStore("currentToast", null)\n    if (next) setStore("currentToast", next)\n')
      source = replace(source, 'import { errorMessage } from "../util/error"', 'import { errorMessage } from "../util/error"\nimport { FadeInText } from "../component/fade-in-text"')
      source = replace(source, '              <text fg={theme.text.base} wrapMode="word" flexGrow={1}>\n                {props.toast.message}\n              </text>',
        '              <FadeInText fg={theme.text.base} backdrop={theme.background.raised.high} wrapMode="word" flexGrow={1}>\n                {props.toast.message}\n              </FadeInText>')
      source = replace(source, '            <text attributes={TextAttributes.BOLD} fg={theme.text.base}>\n              {props.toast.title}\n            </text>',
        '            <FadeInText attributes={TextAttributes.BOLD} fg={theme.text.base} backdrop={theme.background.raised.high}>\n              {props.toast.title}\n            </FadeInText>')
      source = replace(source, '          <text fg={theme.text.base} wrapMode="word" width="100%">\n            {props.toast.message}\n          </text>',
        '          <FadeInText fg={theme.text.base} backdrop={theme.background.raised.high} wrapMode="word" width="100%">\n            {props.toast.message}\n          </FadeInText>')
      return replace(source, '    <Show when={toast.currentToast}>\n      {(current) => (\n        <ToastSurface\n          toast={current()}',
        '    <Show when={toast.currentToast} keyed>\n      {(current) => (\n        <ToastSurface\n          toast={current}')
    })
    await installSettings(api)
  },
}

const pinned = "InfiniteOC is a pinned OpenCode source build and never updates OpenCode installs. Update it with git pull, then infiniteoc rebuild."
const noUninstall = "InfiniteOC never runs OpenCode's uninstaller: it deletes the data, config and sessions shared with your stock OpenCode install. To remove InfiniteOC, delete its checkout. To uninstall stock OpenCode, use its own opencode uninstall."

// Upstream logo.ts glyph encoding: _ shadow cell, ^ ▀ over shadow, ~ shadow ▀.
const upstreamWordmark = `export const logo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}`
const wordmark = `export const logo = {
  left: ["▀       █▀ ▀      ▀  ▄      ", "█ █▀▀▄ ▀█▀ █ █▀▀▄ █ ▀█▀ █▀▀█", "█ █__█  █  █ █__█ █  █  █^^^", "▀ ▀~~▀  ▀  ▀ ▀~~▀ ▀  ▀▀ ▀▀▀▀"],
  right: ["         ", "█▀▀█ █▀▀▀", "█__█ █___", "▀▀▀▀ ▀▀▀▀"],
}`
// Generated module: guidance per agent ID, joined into one instruction block per session.
function guidanceSource() {
  const entries = Object.fromEntries(Object.entries(guidance).map(([agent, text]) => [agent, [text]]))
  return `// Written by mods/infiniteoc from mods/infiniteoc/workflow.mjs; edit it there.
export const infiniteocGuidance: Record<string, string[]> = ${JSON.stringify(entries, null, 2)}
${extensionMarker}
`
}

// Inserted into upstream's built-in agent plugin, next to general and explore.
const subagents = `      // InfiniteOC subagents; their role guidance comes from infiniteoc/guidance.ts.
      editor.update(Agent.ID.make("reviewer"), (item) => {
        item.name = Agent.Name.make("Reviewer")
        item.steps = 60
        item.description =
          "Independent read-only code reviewer. Give it the change (a diff range or files) and its intent; it reads callers and tests, runs checks, and reports ranked defects with file:line, or says it found none. Use it before reporting nontrivial or risky changes as done."
        item.mode = "subagent"
        item.permissions.push(
          { action: "edit", resource: "*", effect: "deny" },
          { action: "question", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        )
      })

      editor.update(Agent.ID.make("researcher"), (item) => {
        const externalDirectories = item.permissions.filter(
          (rule) => rule.action === "external_directory" && rule.effect === "allow",
        )
        item.name = Agent.Name.make("Researcher")
        item.steps = 30
        item.description =
          "Read-only researcher for information outside the codebase: library and API docs, changelogs, error messages, specs. It checks the project's installed versions and returns a concise answer with source URLs."
        item.mode = "subagent"
        item.permissions.push(
          ...Permission.merge(
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "grep", resource: "*", effect: "allow" },
              { action: "glob", resource: "*", effect: "allow" },
              { action: "read", resource: "*", effect: "allow" },
              { action: "read", resource: "*.env", effect: "ask" },
              { action: "read", resource: "*.env.*", effect: "ask" },
              { action: "read", resource: "*.env.example", effect: "allow" },
              { action: "webfetch", resource: "*", effect: "allow" },
              { action: "websearch", resource: "*", effect: "allow" },
              { action: "skill", resource: "*", effect: "allow" },
              { action: "subagent", resource: "*", effect: "deny" },
            ],
            [{ action: "external_directory", resource: "*", effect: "ask" }, ...externalDirectories],
          ),
        )
      })
      // Step caps keep search subagents fast: at the cap they must answer with what they found.
      editor.update(Agent.ID.make("explore"), (item) => {
        item.steps = 30
      })
`
