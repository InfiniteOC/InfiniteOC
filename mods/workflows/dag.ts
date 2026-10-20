// InfiniteOC workflows: plan validation, the DAG scheduler state machine and the text the
// model and subagents see. Pure (no imports), so node tests drive it without OpenCode.
// Written to packages/core/src/plugin/infiniteoc-wf-dag.ts and
// packages/tui/src/infiniteoc-features/workflows-dag.ts by mods/workflows.

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "cancelled"
export type WorkflowStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"

export type StepSpec = {
  id: string
  title: string
  agent: string
  prompt: string
  needs: string[]
  /** "provider/model[#variant]", a tier (fast, strong, default) or undefined for automatic choice. */
  model?: string
  kind?: string
  /** A failed optional step does not fail the workflow or block its dependents. */
  optional: boolean
  /** Fan-out: the id of the `each` step this one was expanded from, and the item it got for {{item}}. */
  group?: string
  item?: string
}

export type StepState = {
  id: string
  status: StepStatus
  sessionID?: string
  /** "provider/model[#variant]" the step runs on, or "session default". */
  model?: string
  /** Models the step may run on (a tier or request naming several); the scheduler picks one when it starts. */
  pool?: string[]
  tier?: string
  kind?: string
  modelReason?: string
  output?: string
  error?: string
  startedAt?: number
  endedAt?: number
  /** Runs of a fan-out item that failed and were queued again (pooled items get two more runs). */
  attempts?: number
  /** The error of the last failed run, while it is queued again. */
  lastError?: string
  /** Claude Code steps: what the worker is doing (its tool calls, last text). */
  activity?: { tool?: string; detail?: string; tools: number; text?: string }
}

export type WorkflowMessage = { id: number; from: string; to: string; text: string; at: number; readBy: string[] }

/** The persisted, serializable record of one workflow (store files, TUI, tool output). */
export type Workflow = {
  id: string
  name: string
  parentSessionID: string
  status: WorkflowStatus
  createdAt: number
  endedAt?: number
  pid?: number
  steps: StepSpec[]
  state: Record<string, StepState>
  messages: WorkflowMessage[]
  error?: string
}

export const RESERVED = new Set(["main", "all", "everyone", "*"])
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i
const ITEM = /\{\{\s*item\s*\}\}/g
const FILE = /\{\{\s*file\s*\}\}/g
const TEMPLATE = /\{\{\s*steps\.([a-z0-9][a-z0-9_-]{0,31})(?:\.output)?\s*\}\}/gi

export type PlanInput = {
  name?: unknown
  steps?: unknown
}
export type Limits = { maxSteps: number; maxPromptChars?: number }
const MAX_ITEM_CHARS = 500

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/** Validates and normalizes a plan; throws an Error whose message tells the model what to fix. */
export function validatePlan(input: PlanInput, limits: Limits): { name: string; steps: StepSpec[] } {
  const maxPrompt = limits.maxPromptChars ?? 20000
  if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error("A workflow needs at least one step.")
  if (input.steps.length > limits.maxSteps)
    throw new Error(`Too many steps (${input.steps.length}); the limit is ${limits.maxSteps}. Merge small steps.`)
  const steps: StepSpec[] = []
  const items = new Map<string, string[]>()
  const seen = new Set<string>()
  for (const [index, raw] of input.steps.entries()) {
    const step = (raw ?? {}) as Record<string, unknown>
    const id = text(step.id)
    if (!ID.test(id)) throw new Error(`Step ${index + 1}: id must be 1-32 letters, digits, "-" or "_" (got ${JSON.stringify(step.id)}).`)
    if (RESERVED.has(id.toLowerCase())) throw new Error(`Step id "${id}" is reserved; choose another.`)
    if (seen.has(id)) throw new Error(`Duplicate step id "${id}".`)
    seen.add(id)
    const prompt = text(step.prompt)
    if (!prompt) throw new Error(`Step "${id}" has no prompt.`)
    if (prompt.length > maxPrompt) throw new Error(`Step "${id}": prompt is longer than ${maxPrompt} characters.`)
    const needs = step.needs === undefined ? [] : step.needs
    if (!Array.isArray(needs) || needs.some((need) => typeof need !== "string"))
      throw new Error(`Step "${id}": needs must be a list of step ids.`)
    if (step.each !== undefined) {
      const list = step.each
      if (!Array.isArray(list) || list.length === 0 || list.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_ITEM_CHARS))
        throw new Error(`Step "${id}": each must be a non-empty list of strings (at most ${MAX_ITEM_CHARS} characters each).`)
      if (!new RegExp(ITEM.source).test(prompt) && !new RegExp(FILE.source).test(prompt))
        throw new Error(`Step "${id}": put {{item}} (or {{file}}) in the prompt where each item of each goes.`)
      items.set(id, list.map((item) => item.trim()))
    }
    if (step.each === undefined && new RegExp(FILE.source).test(prompt))
      throw new Error(`Step "${id}": {{file}} needs each (or glob): it is replaced by the content of each item's file.`)
    const model = text(step.model)
    const kind = text(step.kind).toLowerCase()
    steps.push({
      id,
      title: (text(step.title) || id).slice(0, 80),
      agent: text(step.agent) || "general",
      prompt,
      needs: [...new Set(needs.map((need) => need.trim()))],
      ...(model ? { model } : {}),
      ...(kind ? { kind } : {}),
      // A fan-out is best effort: a failed item shows in the digest instead of failing the workflow and
      // skipping what depends on the group. optional: false makes every item required again.
      optional: step.optional === true || (step.each !== undefined && step.optional !== false),
    })
  }
  const ids = new Set(steps.map((step) => step.id))
  for (const step of steps) {
    for (const need of step.needs) {
      if (need === step.id) throw new Error(`Step "${step.id}" cannot depend on itself.`)
      if (!ids.has(need)) throw new Error(`Step "${step.id}" needs unknown step "${need}".`)
    }
    for (const ref of templateRefs(step.prompt))
      if (!step.needs.includes(ref))
        throw new Error(`Step "${step.id}" uses {{steps.${ref}}} but does not list "${ref}" in needs.`)
  }
  const cycle = findCycle(steps)
  if (cycle) throw new Error(`Dependency cycle: ${cycle.join(" -> ")}.`)
  const expanded = expand(steps, items)
  if (expanded.length > limits.maxSteps)
    throw new Error(`Too many steps after expanding each (${expanded.length}); the limit is ${limits.maxSteps}. Use fewer items.`)
  return { name: (text(input.name) || "workflow").slice(0, 60), steps: expanded }
}

/**
 * Replaces every `each` step with one step per item (ids "<id>-1", "<id>-2", …, same prompt
 * template, `group` and `item` set) and a need on the group with needs on all of its steps.
 */
function expand(steps: StepSpec[], items: Map<string, string[]>): StepSpec[] {
  if (items.size === 0) return steps
  const members = new Map([...items].map(([id, list]) => [id, list.map((_, index) => `${id}-${index + 1}`)]))
  const out: StepSpec[] = []
  for (const step of steps) {
    const needs = [...new Set(step.needs.flatMap((need) => members.get(need) ?? [need]))]
    const list = items.get(step.id)
    if (!list) out.push({ ...step, needs })
    else list.forEach((item, index) => out.push({ ...step, id: `${step.id}-${index + 1}`, needs, group: step.id, item }))
  }
  return out
}

/** The steps of each group in plan order. */
export function groups(steps: ReadonlyArray<StepSpec>) {
  const out = new Map<string, StepSpec[]>()
  for (const step of steps) if (step.group) (out.get(step.group) ?? out.set(step.group, []).get(step.group)!).push(step)
  return out
}

const counts = (workflow: Workflow, members: ReadonlyArray<StepSpec>) => {
  const tally: Record<string, number> = {}
  for (const step of members) tally[workflow.state[step.id].status] = (tally[workflow.state[step.id].status] ?? 0) + 1
  return Object.entries(tally)
    .map(([status, n]) => `${n} ${status}`)
    .join(", ")
}

export function templateRefs(prompt: string) {
  return [...new Set([...prompt.matchAll(TEMPLATE)].map((match) => match[1]))]
}

/** A cycle as a list of ids (first repeated at the end), or undefined. */
export function findCycle(steps: StepSpec[]): string[] | undefined {
  const byID = new Map(steps.map((step) => [step.id, step]))
  const mark = new Map<string, "visiting" | "done">()
  const path: string[] = []
  const visit = (id: string): string[] | undefined => {
    if (mark.get(id) === "done") return
    if (mark.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id]
    mark.set(id, "visiting")
    path.push(id)
    for (const need of byID.get(id)?.needs ?? []) {
      const found = visit(need)
      if (found) return found
    }
    path.pop()
    mark.set(id, "done")
  }
  for (const step of steps) {
    const found = visit(step.id)
    if (found) return found
  }
}

/** Steps grouped by depth: every step's needs are in earlier levels. */
export function levels(steps: StepSpec[]): string[][] {
  const depth = new Map<string, number>()
  const byID = new Map(steps.map((step) => [step.id, step]))
  const of = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const value = Math.max(-1, ...(byID.get(id)?.needs ?? []).map(of)) + 1
    depth.set(id, value)
    return value
  }
  const result: string[][] = []
  for (const step of steps) (result[of(step.id)] ??= []).push(step.id)
  return result
}

export const initialState = (steps: StepSpec[]): Record<string, StepState> =>
  Object.fromEntries(steps.map((step) => [step.id, { id: step.id, status: "pending" as StepStatus }]))

const FINISHED: ReadonlySet<StepStatus> = new Set(["completed", "failed", "skipped", "cancelled"])
export const isFinished = (status: StepStatus) => FINISHED.has(status)

/** A dependency lets its dependents run when it completed, or when it is optional and ended any other way. */
const satisfied = (step: StepSpec | undefined, state: StepState | undefined) =>
  state?.status === "completed" || (step?.optional === true && state !== undefined && isFinished(state.status))

/**
 * Marks pending steps whose required dependency failed, was skipped or cancelled as skipped,
 * transitively. Mutates and returns the ids it skipped.
 */
export function propagate(workflow: Pick<Workflow, "steps" | "state">, now = Date.now()): string[] {
  const byID = new Map(workflow.steps.map((step) => [step.id, step]))
  const skipped: string[] = []
  for (let changed = true; changed; ) {
    changed = false
    for (const step of workflow.steps) {
      const state = workflow.state[step.id]
      if (state.status !== "pending") continue
      const blocker = step.needs.find((need) => {
        const dep = workflow.state[need]
        return isFinished(dep.status) && !satisfied(byID.get(need), dep)
      })
      if (!blocker) continue
      state.status = "skipped"
      state.error = `skipped: required step "${blocker}" ${workflow.state[blocker].status}`
      state.endedAt = now
      skipped.push(step.id)
      changed = true
    }
  }
  return skipped
}

/** Pending steps whose dependencies are satisfied, in plan order, limited by free parallel slots. */
export function ready(
  workflow: Pick<Workflow, "steps" | "state">,
  maxParallel: number,
  /**
   * Asked for each step that could start, in plan order: false keeps it pending for now (its model has
   * no room, Claude Code slots are full). It may reserve what the step takes, so later answers see it.
   */
  admit?: (id: string) => boolean,
): string[] {
  const byID = new Map(workflow.steps.map((step) => [step.id, step]))
  const running = workflow.steps.filter((step) => workflow.state[step.id].status === "running").length
  let free = Math.max(0, maxParallel - running)
  const out: string[] = []
  for (const step of workflow.steps) {
    if (free === 0) break
    if (workflow.state[step.id].status !== "pending" || !step.needs.every((need) => satisfied(byID.get(need), workflow.state[need]))) continue
    if (admit && !admit(step.id)) continue
    out.push(step.id)
    free--
  }
  return out
}

/** The overall status once nothing is running or ready; "running" before that. */
export function overall(workflow: Pick<Workflow, "steps" | "state" | "status">): WorkflowStatus {
  if (workflow.status === "cancelled" || workflow.status === "interrupted") return workflow.status
  const states = workflow.steps.map((step) => workflow.state[step.id])
  if (states.some((state) => !isFinished(state.status))) return "running"
  const required = workflow.steps.filter((step) => !step.optional).map((step) => workflow.state[step.id])
  if (required.some((state) => state.status === "cancelled")) return "cancelled"
  if (required.some((state) => state.status !== "completed")) return "failed"
  return "completed"
}

/** Cancels every unfinished step; returns the ids that were running (their sessions must be interrupted). */
export function cancelAll(workflow: Workflow, now = Date.now(), reason = "cancelled"): string[] {
  const running: string[] = []
  for (const step of workflow.steps) {
    const state = workflow.state[step.id]
    if (isFinished(state.status)) continue
    if (state.status === "running") running.push(step.id)
    state.status = "cancelled"
    state.error = reason
    state.endedAt = now
  }
  workflow.status = "cancelled"
  workflow.endedAt = now
  return running
}

export function truncate(value: string, max: number, hint = "") {
  if (value.length <= max) return value
  const head = Math.max(0, Math.floor(max * 0.8))
  const tail = Math.max(0, max - head)
  return `${value.slice(0, head)}\n…[${value.length - max} characters omitted${hint ? `; ${hint}` : ""}]…\n${tail ? value.slice(-tail) : ""}`
}

const xml = (value: string) => value.replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char]!)

/** Result text of a finished step for dependents and notifications. */
export function stepResult(workflow: Workflow, id: string, max: number) {
  const state = workflow.state[id]
  if (!state) {
    const members = groups(workflow.steps).get(id)
    if (!members) return "(unknown step)"
    return groupResult(workflow, members, max)
  }
  if (state.status === "completed")
    return truncate(state.output ?? "", max, `full text: workflow action "result" with workflowID ${workflow.id}, stepID ${id}`)
  return `(step ${state.status}${state.error ? `: ${state.error}` : ""})`
}

/** One line per item of a group, the whole bounded by max characters. */
function groupResult(workflow: Workflow, members: ReadonlyArray<StepSpec>, max: number) {
  // Each line also carries "- [item] " and, when cut, a ~110-character note where the full text is, so
  // the item's share leaves room for both and every result fits.
  const per = Math.max(100, Math.floor(max / members.length) - Math.max(...members.map((step) => (step.item ?? "").length)) - 140)
  const lines: string[] = []
  let used = 0
  for (const [index, step] of members.entries()) {
    const line = `- [${step.item}] ${stepResult(workflow, step.id, per).replace(/\s*\n\s*/g, " ")}`
    if (used + line.length > max && lines.length) {
      lines.push(`…[${members.length - index} more results; workflow action "result" with workflowID ${workflow.id}, stepID ${step.id} and later]`)
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return lines.join("\n")
}

/** The other members for a step prompt, a group as one entry. */
function teamList(workflow: Workflow, self: StepSpec) {
  const seen = new Set<string>()
  const team: string[] = []
  for (const other of workflow.steps) {
    if (other.id === self.id) continue
    if (other.group) {
      if (seen.has(other.group)) continue
      seen.add(other.group)
      const size = workflow.steps.filter((step) => step.group === other.group).length
      team.push(`${other.group}-1…${other.group}-${size} (${other.agent}: ${other.title}, one per item)`)
    } else team.push(`${other.id} (${other.agent}: ${other.title})`)
  }
  return team
}

/** Fleet mode's speed rules for every step's worker. */
export const FAST_WORKER =
  "Speed matters most: you are one of many workers running in parallel. Use the fewest tool calls that do the task, make independent calls together in one message, read only what the task needs, stop as soon as you have the answer, do not re-check or explore beyond the task, and reply in a few lines."

/**
 * The first prompt of a step's child session: the role, the task with {{steps.X}} templates
 * filled in, results of dependencies not referenced by a template, messages that arrived
 * before it started and how to talk to the team.
 */
export function stepPrompt(input: {
  workflow: Workflow
  step: StepSpec
  inbox: WorkflowMessage[]
  messaging: boolean
  maxOutputChars: number
  /** The content of the step's item file, for {{file}}: the step answers without a tool round trip. */
  file?: string
  /** Fleet mode: tell the worker to finish as fast as it can. */
  fast?: boolean
}) {
  const { workflow, step } = input
  const used = new Set(templateRefs(step.prompt))
  // Results of many dependencies share a budget, so a step after a 500-item group gets a digest, not 500 full results.
  const total = input.maxOutputChars * 4
  const per = Math.min(input.maxOutputChars, Math.max(100, Math.floor(total / Math.max(1, step.needs.length))))
  const byID = new Map(workflow.steps.map((item) => [item.id, item]))
  const task = step.prompt
    .replace(TEMPLATE, (_match, id: string) => stepResult(workflow, id, byID.has(id) ? input.maxOutputChars : total))
    .replace(ITEM, () => step.item ?? "")
    .replace(FILE, () => (input.file === undefined ? `(the content of ${step.item} could not be inlined; read the file)` : `<file path="${xml(step.item ?? "")}">\n${input.file}\n</file>`))
  const pending = step.needs.filter((need) => !used.has(need) && !used.has(byID.get(need)?.group ?? ""))
  const deps: string[] = []
  const shown = new Set<string>()
  for (const need of pending) {
    const spec = byID.get(need)!
    if (spec.group && shown.has(spec.group)) continue
    const members = spec.group ? pending.filter((id) => byID.get(id)?.group === spec.group).map((id) => byID.get(id)!) : undefined
    if (spec.group && members && members.length > 1) {
      shown.add(spec.group)
      deps.push(`<group id="${xml(spec.group)}" title="${xml(spec.title)}" steps="${members.length}">\n${groupResult(workflow, members, per * members.length)}\n</group>`)
    } else
      deps.push(`<step id="${xml(need)}" title="${xml(spec.title)}${spec.item ? `: ${xml(spec.item)}` : ""}" status="${workflow.state[need].status}">\n${stepResult(workflow, need, per)}\n</step>`)
  }
  const team = teamList(workflow, step)
  return [
    `You are a subagent spawned by another session, working as step "${step.id}" (${step.title}${step.item ? `: ${step.item}` : ""}) of the workflow "${workflow.name}" (${workflow.id}).`,
    "Your final reply is your result: it is passed to the steps that depend on you and to the agent that started the workflow, so make it complete and self-contained.",
    ...(input.fast ? [FAST_WORKER] : []),
    "",
    task,
    ...(deps.length
      ? ["", "Results of the steps you depend on (your input: work from them, and open files only to check a specific doubt):", ...deps]
      : []),
    ...(input.inbox.length
      ? ["", "Messages sent to you before you started:", ...input.inbox.map((message) => `- from ${message.from}: ${message.text}`)]
      : []),
    ...(input.messaging && team.length
      ? [
          "",
          `Your team: main (the agent that started this workflow), ${team.join(", ")}.`,
          'Use send_message to tell a teammate something they need (to: a step id, "main" or "all"), and read_messages to see messages for you; messages sent to you while you work also arrive on their own. Keep messages short and only send what changes someone\'s work.',
        ]
      : []),
  ].join("\n")
}

const age = (from?: number, to?: number) => (from ? `${Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000))}s` : "")

/** One line per step for tool output, the TUI and notifications. */
export function stepLine(workflow: Workflow, step: StepSpec) {
  const state = workflow.state[step.id]
  const model = state.model ? ` · ${state.model}${state.tier ? ` (${state.tier})` : ""}` : ""
  const time = age(state.startedAt, state.endedAt)
  const needs = step.needs.length ? ` · after ${step.needs.join(", ")}` : ""
  return `${step.id}: ${state.status}${time ? ` ${time}` : ""} · ${step.agent}${model}${needs}${state.error && state.status !== "completed" ? ` · ${state.error}` : ""}`
}

export function statusText(workflow: Workflow) {
  const done = workflow.steps.filter((step) => isFinished(workflow.state[step.id].status)).length
  const all = groups(workflow.steps)
  const lines: string[] = []
  for (const step of workflow.steps) {
    if (!step.group) {
      lines.push(`- ${stepLine(workflow, step)}`)
      continue
    }
    const members = all.get(step.group)!
    if (members[0] !== step) continue
    const models = [...new Set(members.map((item) => workflow.state[item.id].model ?? "default"))].join(", ")
    const failed = members.filter((item) => ["failed", "cancelled"].includes(workflow.state[item.id].status)).slice(0, 3)
    lines.push(
      `- ${step.group} ×${members.length} (${step.agent} · ${models}): ${counts(workflow, members)}${step.needs.length ? ` · after ${step.needs.length} steps` : ""}` +
        failed.map((item) => `; ${item.id} [${item.item}]: ${workflow.state[item.id].error ?? workflow.state[item.id].status}`).join(""),
    )
  }
  return [
    `Workflow ${workflow.id} "${workflow.name}": ${workflow.status} (${done}/${workflow.steps.length} steps finished${workflow.error ? `; ${workflow.error}` : ""})`,
    ...lines,
  ].join("\n")
}

/**
 * Characters for the end-of-workflow notice: twice maxOutputChars, or 700 per step for a fan-out, at most
 * 80,000 (~20k tokens). Cutting a fan-out's digest costs more: the agent then fetches results one by one.
 */
export const finalBudget = (workflow: Workflow, maxOutputChars: number) =>
  Math.max(Math.max(maxOutputChars, 4000) * 2, Math.min(80_000, 700 * workflow.steps.length))

/** The notification the starting agent receives when a workflow ends. */
export function finalText(workflow: Workflow, maxTotal: number, unread: WorkflowMessage[]) {
  const all = groups(workflow.steps)
  // Plain steps and groups split the budget; a group shares its slice across its items.
  const units = workflow.steps.filter((step) => !step.group).length + all.size
  const per = Math.max(500, Math.floor(maxTotal / Math.max(1, units)))
  const body: string[] = []
  for (const step of workflow.steps) {
    if (!step.group) {
      body.push(
        `<step id="${xml(step.id)}" title="${xml(step.title)}" agent="${xml(step.agent)}" status="${workflow.state[step.id].status}" model="${xml(workflow.state[step.id].model ?? "")}">\n${stepResult(workflow, step.id, per)}\n</step>`,
      )
      continue
    }
    const members = all.get(step.group)!
    if (members[0] !== step) continue
    body.push(
      `<group id="${xml(step.group)}" title="${xml(step.title)}" agent="${xml(step.agent)}" steps="${members.length}" status="${xml(counts(workflow, members))}">\n${groupResult(workflow, members, per)}\n</group>`,
    )
  }
  return [
    `<workflow id="${workflow.id}" name="${xml(workflow.name)}" state="${workflow.status}">`,
    ...body,
    ...(unread.length ? ["Unread messages for you:", ...unread.map((message) => `- from ${message.from}: ${message.text}`)] : []),
    "</workflow>",
    `These are the steps' reports: answer from them. Do not re-read files or re-run checks to confirm them unless the user asked for verification or two reports contradict each other. Full step output: workflow action "result" with workflowID ${workflow.id}.`,
  ].join("\n")
}

export const STATUS_COOLDOWN_MS = 10_000
export const MAX_STATUS_WAIT_SECONDS = 300
export const DEFAULT_STATUS_WAIT_SECONDS = 120
export type Check = { readonly key: string; readonly at: number }

/**
 * How long a status call waits for a change before it answers, or undefined to answer now.
 * wait: true blocks until a change or the timeout; an identical repeat of the previous check waits out
 * the rest of a short cooldown, so a polling loop slows down. Finished workflows never wait.
 */
export function statusWait(input: { previous?: Check; key: string; live: boolean; wait?: boolean; timeout?: number; now: number }) {
  if (!input.live) return undefined
  if (input.wait) {
    const requested = Number.isFinite(input.timeout) ? Math.floor(input.timeout!) : DEFAULT_STATUS_WAIT_SECONDS
    const seconds = Math.max(1, Math.min(MAX_STATUS_WAIT_SECONDS, requested))
    return { deadline: input.now + seconds * 1000, since: input.now, waited: true }
  }
  if (input.previous?.key === input.key) return { deadline: input.previous.at + STATUS_COOLDOWN_MS, since: input.previous.at, waited: false }
  return undefined
}

/** What a progress check can see change: statuses and messages, not the clock, so re-asking compares equal. */
export const progressKey = (workflows: ReadonlyArray<Workflow>) =>
  JSON.stringify(workflows.map((workflow) => [workflow.id, workflow.status, workflow.steps.map((step) => workflow.state[step.id].status), workflow.messages.length]))

/** The short answer to a status check that saw nothing new, so a repeated check costs little and says why to stop. */
export function unchangedText(workflows: ReadonlyArray<Workflow>, sinceMs: number, waited = false) {
  const lines = workflows
    .filter((workflow) => workflow.status === "running")
    .map((workflow) => {
      const done = workflow.steps.filter((step) => isFinished(workflow.state[step.id].status)).length
      const running = workflow.steps.filter((step) => workflow.state[step.id].status === "running").map((step) => step.id)
      const list = running.length > 8 ? `${running.slice(0, 8).join(", ")} and ${running.length - 8} more` : running.join(", ")
      return `- ${workflow.id} "${workflow.name}": ${done}/${workflow.steps.length} steps finished${running.length ? `, running ${list}` : ""}`
    })
  return [
    `${waited ? "No change after waiting" : "No change since your last check"} ${Math.max(0, Math.round(sinceMs / 1000))}s${waited ? "" : " ago"}; still running:`,
    ...lines,
    "You are notified automatically when a workflow finishes (and when a step messages you), so do not poll. Work on something else or end your turn. If you cannot continue without its next step, call status once with wait: true.",
  ].join("\n")
}

// ---- steering toward workflows -------------------------------------------------------------------

/** Nudges per session at most, so a model that has a reason for separate subagents is not nagged. */
export const NUDGE_LIMIT = 2
export type NudgeState = { message: string; count: number; nudged: number }

/**
 * Counts subagent calls per assistant message. When one message starts a second subagent, returns a
 * note for that call's result pointing at the workflow tool (at most NUDGE_LIMIT times per session).
 */
export function subagentNudge(sessions: Map<string, NudgeState>, sessionID: string, messageID: string): string | undefined {
  const previous = sessions.get(sessionID)
  const state = previous?.message === messageID ? previous : { message: messageID, count: 0, nudged: previous?.nudged ?? 0 }
  state.count++
  // Insertion order doubles as recency: a bounded map of the sessions seen most recently.
  sessions.delete(sessionID)
  sessions.set(sessionID, state)
  if (sessions.size > 500) sessions.delete(sessions.keys().next().value!)
  if (state.count !== 2 || state.nudged >= NUDGE_LIMIT) return undefined
  state.nudged++
  return "[Workflows] This message started several subagents one by one. Next time delegate them with one workflow call: it runs independent steps in parallel and dependent ones in order (for example a reviewer step after the implementing steps), picks a fast or strong model per step, and notifies you once when everything is done."
}

/** Tools that are the work itself: in fleet mode the primary agent hands them to workflow steps. */
export const DIRECT_TOOLS = new Set(["read", "grep", "glob", "edit", "write", "patch", "shell"])
/** Direct calls allowed before the first fleet nudge (a look-up or two to plan steps), then one every FLEET_EVERY. */
export const FLEET_FREE = 2
export const FLEET_EVERY = 4

/**
 * Fleet mode: counts the primary agent's direct work calls since its last delegation. Returns a note for
 * the call's result once it does more than FLEET_FREE of them itself, and every FLEET_EVERY calls after.
 * A workflow or subagent call starts the count over.
 */
export function fleetNudge(counts: Map<string, number>, sessionID: string, tool: string): string | undefined {
  if (tool === "workflow" || tool === "subagent") {
    counts.delete(sessionID)
    return undefined
  }
  if (!DIRECT_TOOLS.has(tool)) return undefined
  const count = (counts.get(sessionID) ?? 0) + 1
  counts.delete(sessionID)
  counts.set(sessionID, count)
  if (counts.size > 500) counts.delete(counts.keys().next().value!)
  if (count <= FLEET_FREE || (count - FLEET_FREE - 1) % FLEET_EVERY !== 0) return undefined
  return `[Fleet] Fleet mode is on and you made ${count} direct tool calls yourself (${tool} last). You are the orchestrator: stop here and hand the remaining reading, editing and checking to a workflow (one step with wait: true is fine), then answer from its results.`
}
