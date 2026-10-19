// InfiniteOC features for the web UI, as server-driven views. The browser sends {feature, action, value}
// and renders the View it gets back with one generic dialog (packages/app/src/infiniteoc/dialog.tsx);
// every rule lives here, next to the stores the TUI commands use. Pure: the stores are passed in, so it is
// tested with node and generated into packages/core/src/plugin/infiniteoc-web-views.ts by mods/webui.
import path from "node:path"

export type Item = { readonly id: string; readonly title: string; readonly description?: string }
export type View = {
  readonly title: string
  /** Preformatted text above the list. */
  readonly text?: string
  /** Selecting one sends its id as the next action. */
  readonly items?: readonly Item[]
  /** Buttons; their id is the next action. */
  readonly actions?: readonly Item[]
  /** A text field; submitting sends `action` with the text as value. */
  readonly input?: { readonly placeholder: string; readonly action: string; readonly value?: string }
  /** Shown as a toast after the view renders. */
  readonly toast?: { readonly message: string; readonly variant: "success" | "error" }
}
export type Request = {
  readonly feature: string
  readonly action?: string
  readonly value?: string
  readonly sessionID?: string
  readonly directory?: string
}

type Snapshot = unknown
export type Deps = {
  readonly ctx?: {
    readSnapshot(sessionID: string): Snapshot | undefined
    formatSnapshot(snapshot: never): string
    projectRoot(start: string): string
    memoryFile(root: string): string
    glossaryFile(root: string): string
    listItems(file: string): string[]
    addItem(file: string, text: string, key?: (item: string) => string): unknown
    removeItem(file: string, which: string | number): unknown
    termKey(item: string): string
    listPins(sessionID: string): string[]
    addPin(sessionID: string, file: string): unknown
    removePin(sessionID: string, which: string): unknown
  }
  readonly octx?: {
    readState(sessionID: string): { readonly paged: readonly string[]; readonly off?: boolean; readonly chars?: number }
    writeState(sessionID: string, state: { readonly paged: readonly string[]; readonly off?: boolean; readonly chars?: number }): void
    describe(state: { readonly paged: readonly string[]; readonly off?: boolean; readonly chars?: number }): string
  }
  /** Spend from the stored sessions, formatted. */
  readonly usage?: () => string
  readonly workflows?: {
    listWorkflows(parentSessionID?: string, limit?: number): readonly WorkflowLike[]
    requestCancel(parentSessionID: string, id: string): void
  }
}
type StepState = { readonly status: string; readonly sessionID?: string; readonly model?: string; readonly error?: string; readonly output?: string }
export type WorkflowLike = {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly parentSessionID: string
  readonly createdAt: number
  readonly steps: ReadonlyArray<{ readonly id: string; readonly title: string; readonly agent: string }>
  readonly state: Readonly<Record<string, StepState>>
}

export type Feature = { readonly id: string; readonly slash: string; readonly title: string; readonly description: string; readonly session: boolean }

// What the web UI offers, in palette order; each appears only when its mod is in the build.
const ALL: ReadonlyArray<Feature & { readonly needs: keyof Deps }> = [
  { id: "context", slash: "context", title: "Show what fills the context window", description: "Estimated size of each part of the last request", session: true, needs: "ctx" },
  { id: "octx", slash: "octx", title: "Context paging (InfiniteOCTX)", description: "Old tool outputs paged out of this session's requests", session: true, needs: "octx" },
  { id: "memory", slash: "memory", title: "Project memory and glossary", description: "Notes and terms loaded into every session of this project", session: false, needs: "ctx" },
  { id: "pins", slash: "pins", title: "Pinned files", description: "Files kept in every turn of this session", session: true, needs: "ctx" },
  { id: "workflows", slash: "workflows", title: "Workflows", description: "This session's workflows: steps, status, cancel", session: false, needs: "workflows" },
  { id: "usage", slash: "usage", title: "Spend by day, project and provider", description: "From the stored sessions", session: false, needs: "usage" },
]

/** The features this build can serve. */
export const features = (deps: Deps): Feature[] => ALL.filter((feature) => deps[feature.needs] !== undefined).map(({ needs, ...feature }) => feature)

// Ids reach file names in the stores: anything else is refused before a store sees it.
const SESSION = /^[A-Za-z0-9_-]{1,120}$/
const error = (title: string, message: string): View => ({ title, text: message, toast: { message, variant: "error" } })

/** The next view for a request. Throws nothing: a failure is a view that says what went wrong. */
export function view(request: Request, deps: Deps): View {
  const feature = ALL.find((item) => item.id === request.feature)
  if (!feature || !deps[feature.needs]) return error("InfiniteOC", `Unknown feature: ${request.feature}`)
  if (feature.session && !(request.sessionID && SESSION.test(request.sessionID))) return { title: feature.title, text: "Open a session first." }
  try {
    switch (feature.id) {
      case "context":
        return context(request.sessionID!, deps.ctx!)
      case "octx":
        return octx(request, deps.octx!)
      case "memory":
        return memory(request, deps.ctx!)
      case "pins":
        return pins(request, deps.ctx!)
      case "workflows":
        return workflows(request, deps.workflows!)
      case "usage":
        return { title: "Spend from stored sessions", text: deps.usage!() }
    }
  } catch (cause) {
    return error(feature.title, cause instanceof Error ? cause.message : String(cause))
  }
  return error("InfiniteOC", `Unknown feature: ${request.feature}`)
}

function context(sessionID: string, ctx: NonNullable<Deps["ctx"]>): View {
  const snapshot = ctx.readSnapshot(sessionID)
  if (!snapshot) return { title: "Context", text: "No model request has been made in this session yet. Send a message, then open this again." }
  return { title: "Context", text: ctx.formatSnapshot(snapshot as never) }
}

function octx(request: Request, store: NonNullable<Deps["octx"]>): View {
  const sessionID = request.sessionID!
  let state = store.readState(sessionID)
  let toast: View["toast"]
  if (request.action === "off" || request.action === "on") {
    state = { ...state, off: request.action === "off" }
    store.writeState(sessionID, state)
    toast = { message: state.off ? "Paging is off for this session." : "Paging is on for this session.", variant: "success" }
  }
  return {
    title: "Context paging (InfiniteOCTX)",
    text: store.describe(state),
    actions: [state.off ? { id: "on", title: "Turn paging back on", description: "old outputs page out again in batches" } : { id: "off", title: "Turn paging off for this session", description: "resends all outputs in full, once uncached" }],
    toast,
  }
}

const KINDS = {
  memory: { title: "Project memory", hint: "A fact, e.g. run tests with npm test", glossary: false },
  glossary: { title: "Glossary", hint: "term: meaning", glossary: true },
} as const
type Kind = keyof typeof KINDS

function memory(request: Request, ctx: NonNullable<Deps["ctx"]>): View {
  const root = ctx.projectRoot(request.directory || ".")
  const file = (kind: Kind) => (KINDS[kind].glossary ? ctx.glossaryFile(root) : ctx.memoryFile(root))
  const [verb, kindName, position] = (request.action ?? "").split(":")
  const kind = kindName === "memory" || kindName === "glossary" ? (kindName as Kind) : undefined
  let toast: View["toast"]
  if (kind && verb === "add" && request.value?.trim()) {
    ctx.addItem(file(kind), request.value, KINDS[kind].glossary ? ctx.termKey : undefined)
    toast = { message: `Saved to ${KINDS[kind].title.toLowerCase()}.`, variant: "success" }
  }
  if (kind && verb === "remove" && position) {
    ctx.removeItem(file(kind), Number(position))
    toast = { message: "Removed.", variant: "success" }
  }
  if (kind && verb === "entry" && position) {
    const entry = ctx.listItems(file(kind))[Number(position) - 1]
    if (entry !== undefined)
      return { title: KINDS[kind].title, text: entry, actions: [{ id: `remove:${kind}:${position}`, title: "Remove" }, { id: `open:${kind}`, title: "Back" }] }
  }
  if (!kind)
    return {
      title: "Project knowledge (loaded into every session)",
      text: `Project: ${root}`,
      items: (Object.keys(KINDS) as Kind[]).map((name) => ({ id: `open:${name}`, title: KINDS[name].title, description: `${ctx.listItems(file(name)).length} entries` })),
    }
  const items = ctx.listItems(file(kind))
  return {
    title: `${KINDS[kind].title} · ${items.length} entries`,
    items: items.map((item, index) => ({ id: `entry:${kind}:${index + 1}`, title: item })),
    input: { placeholder: KINDS[kind].hint, action: `add:${kind}` },
    actions: [{ id: "", title: "Back" }],
    toast,
  }
}

function pins(request: Request, ctx: NonNullable<Deps["ctx"]>): View {
  const sessionID = request.sessionID!
  const root = ctx.projectRoot(request.directory || ".")
  const relative = (file: string) => (path.relative(root, file).startsWith("..") ? file : path.relative(root, file) || file)
  let toast: View["toast"]
  if (request.action === "add" && request.value?.trim()) {
    const wanted = request.value.trim().replace(/^@/, "")
    ctx.addPin(sessionID, path.resolve(root, wanted))
    toast = { message: `Pinned ${wanted}.`, variant: "success" }
  }
  if (request.action?.startsWith("unpin:")) {
    ctx.removePin(sessionID, request.action.slice("unpin:".length))
    toast = { message: "Unpinned.", variant: "success" }
  }
  if (request.action?.startsWith("pin:")) {
    const file = request.action.slice("pin:".length)
    return { title: "Pinned file", text: relative(file), actions: [{ id: `unpin:${file}`, title: "Unpin" }, { id: "", title: "Back" }] }
  }
  const list = ctx.listPins(sessionID)
  return {
    title: `Pinned files · ${list.length} (kept in every turn of this session)`,
    items: list.map((file) => ({ id: `pin:${file}`, title: relative(file) })),
    input: { placeholder: "Pin a file: path relative to the project", action: "add" },
    toast,
  }
}

const ICON: Record<string, string> = { pending: "·", running: "◐", completed: "✓", failed: "✗", skipped: "↷", cancelled: "⊘", interrupted: "⊘" }
const finished = (workflow: WorkflowLike) => workflow.steps.filter((step) => !["pending", "running"].includes(workflow.state[step.id]?.status ?? "pending")).length

function workflows(request: Request, store: NonNullable<Deps["workflows"]>): View {
  const all = store.listWorkflows(undefined, 50)
  const here = request.sessionID
  const mine = here ? all.filter((workflow) => workflow.parentSessionID === here || Object.values(workflow.state).some((state) => state.sessionID === here)) : []
  const shown = mine.length ? mine : all.slice(0, 20)
  const [verb, id] = (request.action ?? "").split(":")
  const workflow = shown.find((item) => item.id === id)
  let toast: View["toast"]
  if (verb === "cancel" && workflow && workflow.status === "running") {
    store.requestCancel(workflow.parentSessionID, workflow.id)
    toast = { message: "Cancel requested; the server stops the steps within about a second.", variant: "success" }
  }
  if (workflow && (verb === "open" || verb === "cancel"))
    return {
      title: `${ICON[workflow.status] ?? "?"} ${workflow.name} · ${workflow.status}`,
      text: workflow.steps
        .map((step) => {
          const state = workflow.state[step.id]
          const detail = state?.error && state.status !== "completed" ? `\n    ${state.error}` : ""
          return `${ICON[state?.status ?? "pending"] ?? "?"} ${step.id} · ${step.title} (${step.agent}${state?.model ? `, ${state.model}` : ""})${detail}`
        })
        .join("\n"),
      actions: [...(workflow.status === "running" ? [{ id: `cancel:${workflow.id}`, title: "Cancel workflow", description: "Stops running steps; finished results stay" }] : []), { id: "", title: "Back" }],
      toast,
    }
  return {
    title: mine.length ? `Workflows of this session · ${mine.length}` : here ? "Workflows · none in this session, recent ones shown" : "Workflows · recent",
    items: shown.map((item) => ({ id: `open:${item.id}`, title: `${ICON[item.status] ?? "?"} ${item.name}`, description: `${item.status} · ${finished(item)}/${item.steps.length} steps` })),
    text: shown.length ? undefined : "No workflows yet.",
  }
}
