// InfiniteOC tstat: status and feedback surfaces (desktop notifications, sound cues, subagent
// progress, usage meter, /zen, /expand, /tstat settings, session-wide permission allow).
// Copied to packages/tui/src/feature-plugins/system/tstat.tsx and registered as a builtin by
// mods/tstat-status.
import { Plugin } from "@opencode/plugin/tui"
import { spawn } from "node:child_process"
import { createEffect, createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import {
  budgetState,
  fanout,
  formatTokens,
  notifyCommand,
  progressBar,
  shouldNotify,
  soundCommand,
  sumTokens,
  type Cue,
  type Focus,
  type Settings,
  defaults,
} from "./tstat-logic"
import { applySaved, expandAll, icons, isSessionAllowed, setExpandAll, setZen, settings, zen } from "./tstat-state"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
// A run that ends and is immediately followed by another (queued prompt, /goal continuation) is not "done".
const SETTLE_MS = 2500

function run(command: { cmd: string; args: string[] } | undefined) {
  if (!command) return
  try {
    const child = spawn(command.cmd, command.args, { stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {}
}

export default Plugin.define({
  id: "infiniteoc.tstat",
  setup(context) {
    const [saved, update] = context.storage.store<Settings>("infiniteoc.tstat", { initial: defaults })
    const save = async (change: (draft: Settings) => void) => {
      await update(change)
      applySaved(saved)
    }

    // --- Desktop notifications and sound cues -------------------------------------------------
    let focus: Focus = "unknown"
    const onFocus = () => (focus = "focused")
    const onBlur = () => (focus = "blurred")
    context.renderer.on("focus", onFocus)
    context.renderer.on("blur", onBlur)

    const title = (sessionID?: string) => (sessionID && context.data.session.get(sessionID)?.title) || "InfiniteOC"
    const alert = (cue: Cue, heading: string, message: string) => {
      const current = settings()
      if (current.sound) run(soundCommand(process.platform, cue))
      if (current.notify && shouldNotify(focus)) run(notifyCommand(process.platform, heading, message))
    }
    // A session not loaded yet is not assumed to be a root: subagent events can arrive before their info.
    const isRoot = (sessionID: string) => {
      const session = context.data.session.get(sessionID)
      return session !== undefined && session.parentID === undefined
    }

    const settling = new Map<string, ReturnType<typeof setTimeout>>()
    const unsettle = (sessionID: string) => {
      clearTimeout(settling.get(sessionID))
      settling.delete(sessionID)
    }
    const started = new Map<string, number>()
    const warned = new Set<string>()
    const checkBudget = (sessionID: string) => {
      const budget = budgetState(context.data.session.cost(sessionID), settings().budget)
      if (budget?.level !== "over" || warned.has(sessionID)) return
      warned.add(sessionID)
      const message = `Session cost ${money.format(context.data.session.cost(sessionID))} passed the ${money.format(settings().budget)} budget`
      context.ui.toast.show({ variant: "warning", title: "Budget", message, duration: 8000 })
      alert("waiting", title(sessionID), message)
    }

    const dispose = [
      () => context.renderer.off("focus", onFocus),
      () => context.renderer.off("blur", onBlur),
      context.data.on("session.execution.started", (event) => {
        unsettle(event.data.sessionID)
        started.set(event.data.sessionID, Date.now())
      }),
      context.data.on("session.execution.succeeded", (event) => {
        const sessionID = event.data.sessionID
        if (!isRoot(sessionID)) return
        checkBudget(sessionID)
        unsettle(sessionID)
        settling.set(
          sessionID,
          setTimeout(() => {
            settling.delete(sessionID)
            alert("done", title(sessionID), "Run finished")
          }, SETTLE_MS),
        )
      }),
      context.data.on("session.execution.failed", (event) => {
        const sessionID = event.data.sessionID
        if (!isRoot(sessionID)) return
        unsettle(sessionID)
        alert("error", title(sessionID), `Run failed: ${event.data.error.message}`)
      }),
      context.data.on("permission.asked", (event) => {
        const request = event.data
        const root = context.data.session.root(request.sessionID)
        if (isSessionAllowed(root, request)) {
          void context.client.permission
            .reply({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
            .catch(() => alert("waiting", title(root), "Permission needs input"))
          return
        }
        alert("waiting", title(root), isRoot(request.sessionID) ? "Permission needs input" : "A subagent needs permission")
      }),
      context.data.on("form.created", (event) => alert("waiting", title(context.data.session.root(event.data.form.sessionID)), "Input needs response")),
      // /goal announces its end with a toast; it replaces the plain "Run finished" of its last turn.
      context.data.listen(({ details }) => {
        if (details.type !== "tui.toast.show" || details.data.title !== "Goal") return
        for (const sessionID of [...settling.keys()]) unsettle(sessionID)
        alert(details.data.message.startsWith("Goal finished") ? "done" : "waiting", "InfiniteOC goal", details.data.message)
      }),
      () => settling.forEach((timer) => clearTimeout(timer)),
    ]

    // --- Subagent fan-out and usage meter in the prompt footer ---------------------------------
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => {
        const theme = useTheme()
        const agents = createMemo(() => {
          const root = props.sessionID
          if (!root || zen()) return
          const since = started.get(root) ?? 0
          const children = context.data.session
            .family(root)
            .filter((id) => id !== root && (context.data.session.get(id)?.time.created ?? 0) >= since - 1000)
          const stats = fanout(children.map((id) => context.data.session.status(id)))
          return stats.running > 0 ? stats : undefined
        })
        const meter = createMemo(() => {
          const root = props.sessionID
          if (!root || zen() || !settings().meter || !props.showDetails) return
          const tokens = sumTokens(context.data.session.family(root).map((id) => context.data.session.get(id)))
          if (tokens.input + tokens.output === 0) return
          const budget = budgetState(context.data.session.cost(root), settings().budget)
          return { text: `in ${formatTokens(tokens.input)} out ${formatTokens(tokens.output)}`, budget }
        })
        return (
          <>
            <Show when={agents()}>
              {(stats) => (
                <box flexShrink={0} paddingLeft={1}>
                  <text fg={theme.hue.interactive[400]} wrapMode="none">
                    {icons().agent} {progressBar(stats().done, stats().total)} {stats().done}/{stats().total} done, {stats().running} running
                  </text>
                </box>
              )}
            </Show>
            <Show when={meter()}>
              {(value) => (
                <box flexShrink={0} paddingLeft={1}>
                  <text fg={theme.text.muted} wrapMode="none">
                    {value().text}
                    <Show when={value().budget}>
                      {(budget) => (
                        <span
                          style={{
                            fg:
                              budget().level === "over"
                                ? theme.text.feedback.error.base
                                : budget().level === "warn"
                                  ? theme.text.feedback.warning.base
                                  : theme.text.muted,
                          }}
                        >
                          {" "}
                          budget {budget().percent}%
                        </span>
                      )}
                    </Show>
                  </text>
                </box>
              )}
            </Show>
          </>
        )
      },
    })

    // --- Commands: /tstat, /zen, /expand ------------------------------------------------------
    context.ui.slot({
      append: "app",
      render() {
        createEffect(() => applySaved({ ...saved }))
        const onOff = (value: boolean) => (value ? "on" : "off")
        async function menu() {
          for (;;) {
            const current = settings()
            const choice = await context.ui.dialog.select<string>({
              title: "Status and feedback",
              options: [
                { title: `Desktop notifications: ${onOff(current.notify)}`, description: "When a run, a /goal or a prompt needs you and the terminal is not focused", value: "notify" },
                { title: `Sound cues: ${onOff(current.sound)}`, description: "Different system sounds for done, error and waiting", value: "sound" },
                { title: `Compact tool output: ${onOff(current.compact)}`, description: "Cap long tool bodies; click or /expand opens them", value: "compact" },
                { title: `Usage meter: ${onOff(current.meter)}`, description: "Tokens and budget in the prompt footer", value: "meter" },
                { title: `Budget: ${current.budget > 0 ? money.format(current.budget) : "none"}`, description: "Warn when a session's cost passes this many USD", value: "budget" },
                { title: `Nerd Font icons: ${current.nerd}`, description: "auto detects Kitty, WezTerm, Ghostty or NERD_FONT=1", value: "nerd" },
              ],
            })
            if (!choice) return
            if (choice === "budget") {
              const answer = await context.ui.dialog.prompt({ title: "Session budget in USD", description: "0 turns the budget off", value: String(current.budget) })
              const amount = Number(answer)
              if (answer !== undefined && Number.isFinite(amount) && amount >= 0) await save((draft) => void (draft.budget = amount))
              continue
            }
            await save((draft) => {
              if (choice === "nerd") draft.nerd = draft.nerd === "auto" ? "on" : draft.nerd === "on" ? "off" : "auto"
              else draft[choice as "notify" | "sound" | "compact" | "meter"] = !draft[choice as "notify" | "sound" | "compact" | "meter"]
            })
          }
        }
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "tstat.settings",
              title: "Status and feedback settings",
              description: "Notifications, sounds, compact tool output, usage meter, budget, Nerd Font icons",
              group: "Mods",
              palette: true,
              slash: { name: "tstat" },
              run: () => void menu(),
            },
            {
              id: "tstat.zen",
              title: "Toggle zen mode",
              description: "Hide tabs, sidebar and footer details; keep the transcript and the prompt",
              group: "Mods",
              palette: true,
              slash: { name: "zen" },
              run: () => {
                setZen(!zen())
                context.ui.toast.show({ variant: "info", message: zen() ? "Zen mode on. /zen leaves it." : "Zen mode off" })
              },
            },
            {
              id: "tstat.expand",
              title: "Expand or collapse all tool output",
              group: "Mods",
              palette: true,
              slash: { name: "expand" },
              run: () => {
                setExpandAll(!expandAll())
                context.ui.toast.show({ variant: "info", message: expandAll() ? "Tool output expanded" : "Tool output collapsed" })
              },
            },
          ],
        }))
        return null
      },
    })

    return () => dispose.reverse().forEach((cleanup) => cleanup())
  },
})
