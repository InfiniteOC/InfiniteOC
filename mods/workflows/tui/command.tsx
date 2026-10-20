import type { FeatureContext } from "./api"
import type { Workflow } from "./workflows-dag"
import { changeSetting, listWorkflows, readSettings, requestCancel } from "./workflows-store"
import { summary } from "./workflows-settings"

// /workflows: this session's workflows with each step's status and model, cancel, and the settings.
// Reads the files the server writes; a cancel is a marker file the server picks up within a second.
// Never deletes sessions or interrupts anything except the workflow the user confirms.
const ICON: Record<string, string> = { pending: "·", running: "◐", completed: "✓", failed: "✗", skipped: "↷", cancelled: "⊘", interrupted: "⊘" }
const ago = (from: number, to = Date.now()) => {
  const s = Math.max(0, Math.round((to - from) / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}
const done = (workflow: Workflow) => workflow.steps.filter((step) => !["pending", "running"].includes(workflow.state[step.id].status)).length

export async function run(ctx: FeatureContext) {
  for (;;) {
    const route = ctx.route.data
    const here = route.type === "session" ? route.sessionID : undefined
    const all = listWorkflows(undefined, 50)
    const mine = here ? all.filter((w) => w.parentSessionID === here || Object.values(w.state).some((s) => s.sessionID === here)) : []
    const shown = mine.length ? mine : all.slice(0, 20)
    const settings = readSettings()
    const choice = await ctx.ui.select({
      title: mine.length ? `Workflows of this session · ${mine.length}` : here ? "Workflows · none in this session, recent ones shown" : "Workflows · recent",
      options: [
        ...shown.map((w) => ({
          title: `${ICON[w.status] ?? "?"} ${w.name}`,
          value: w.id,
          description: `${w.status} · ${done(w)}/${w.steps.length} steps · ${ago(w.createdAt)} ago`,
        })),
        { title: "Settings", value: "settings", description: summary(settings) },
      ],
    })
    if (!choice) return
    if (choice === "settings") await settingsMenu(ctx)
    else {
      const workflow = shown.find((w) => w.id === choice)
      if (workflow) await details(ctx, workflow.parentSessionID, workflow.id)
    }
  }
}

async function details(ctx: FeatureContext, parent: string, id: string) {
  for (;;) {
    const workflow = listWorkflows(parent, 200).find((w) => w.id === id)
    if (!workflow) return ctx.ui.alert({ title: "Workflow", message: "It no longer exists (finished workflows are kept for 7 days)." })
    const choice = await ctx.ui.select({
      title: `${workflow.name} · ${workflow.status} · ${done(workflow)}/${workflow.steps.length}`,
      options: [
        ...workflow.steps.map((step) => {
          const state = workflow.state[step.id]
          return {
            title: `${ICON[state.status] ?? "?"} ${step.id} · ${step.agent}`,
            value: `step:${step.id}`,
            description: `${state.status} · ${state.model ?? "default model"}${state.tier ? ` (${state.tier})` : ""}${step.needs.length ? ` · after ${step.needs.join(", ")}` : ""}`,
          }
        }),
        ...(workflow.messages.length ? [{ title: "Messages", value: "messages", description: `${workflow.messages.length} between steps` }] : []),
        ...(workflow.status === "running" ? [{ title: "Cancel workflow", value: "cancel", description: "Stops running steps; finished results stay" }] : []),
      ],
    })
    if (!choice) return
    if (choice === "cancel") {
      const ok = await ctx.ui.confirm({ title: "Cancel workflow", message: `Stop "${workflow.name}"? Running steps are interrupted; their sessions and finished results stay.`, label: { confirm: "Cancel it", cancel: "Keep running" } })
      if (ok) {
        requestCancel(workflow.parentSessionID, workflow.id)
        await ctx.ui.alert({ title: "Workflow", message: "Cancel requested; the server stops the steps within about a second." })
      }
      continue
    }
    if (choice === "messages") {
      await ctx.ui.alert({ title: `Messages · ${workflow.name}`, message: workflow.messages.slice(-30).map((m) => `${m.from} → ${m.to}: ${m.text.slice(0, 300)}`).join("\n\n") })
      continue
    }
    const step = workflow.steps.find((item) => `step:${item.id}` === choice)
    if (!step) continue
    const state = workflow.state[step.id]
    await ctx.ui.alert({
      title: `${step.id} · ${step.title}`,
      message: [
        `Status: ${state.status}${state.startedAt ? ` · ${ago(state.startedAt, state.endedAt)}` : ""}`,
        `Agent: ${step.agent}`,
        `Model: ${state.model ?? "session default"}${state.tier ? ` · tier ${state.tier}` : ""}${state.kind ? ` · kind ${state.kind}` : ""}`,
        state.modelReason ? `Why: ${state.modelReason}` : "",
        state.error && state.status !== "completed" ? `Error: ${state.error}` : "",
        state.output ? `\n${state.output.slice(0, 1500)}${state.output.length > 1500 ? "\n…" : ""}` : "",
      ].filter(Boolean).join("\n"),
    })
  }
}

async function settingsMenu(ctx: FeatureContext) {
  for (;;) {
    const s = readSettings()
    const key = await ctx.ui.select({
      title: `Workflows settings · ${s.enabled ? (s.fleet ? "fleet" : "on") : "off"}`,
      options: [
        { title: s.enabled ? "Turn off" : "Turn on", value: "enabled", description: "The workflow tool and its guidance; read on every request, no restart" },
        { title: s.fleet ? "Turn fleet mode off" : "Turn fleet mode on", value: "fleet", description: "The agent hands nearly all its work to workflows instead of doing it itself" },
        { title: "Fast model", value: "models.fast", description: `search, grep, summaries · ${s.models.fast}` },
        { title: "Strong model", value: "models.strong", description: `planning, review, hard reasoning · ${s.models.strong}` },
        { title: "Default model", value: "models.default", description: `implementation, other steps · ${s.models.default}` },
        { title: "Parallel steps", value: "maxParallel", description: String(s.maxParallel) },
        { title: "Notify", value: "notify", description: `${s.notify} (end: once per workflow · each: also per step)` },
      ],
    })
    if (!key) return
    let value: string | undefined
    if (key === "enabled") value = s.enabled ? "off" : "on"
    else if (key === "fleet") value = s.fleet ? "off" : "on"
    else if (key === "notify") value = s.notify === "end" ? "each" : "end"
    else {
      const tier = key.startsWith("models.") ? (key.slice(7) as "fast" | "strong" | "default") : undefined
      value = await ctx.ui.prompt({
        title: `Workflows · ${key}`,
        value: tier ? s.models[tier] : String(s.maxParallel),
        placeholder: tier ? (tier === "default" ? "inherit or provider/model" : "auto, inherit or provider/model") : "1-8",
      })
    }
    if (value === undefined) continue
    const result = changeSetting(key, value)
    if ("error" in result) await ctx.ui.alert({ title: "Workflows settings", message: result.error })
  }
}
