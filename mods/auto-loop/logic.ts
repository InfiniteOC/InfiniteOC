// InfiniteOC autonomy: pure logic for the agent-loop features. No imports, so tests load it directly.
// Written to packages/core/src/plugin/infiniteoc-auto-logic.ts by mods/auto-loop.
// Session state lives in the transcript as control messages (like /goal), so a restarted server
// resumes it. Only timers (loop, timebox), the queue and macro recording are in memory.

// Structural subset of SessionMessage.Info; the generated type is too wide to restate here.
type Msg = any

// ---- markers -------------------------------------------------------------------------------------

export const MARK = {
  verify: "[InfiniteOC verify]",
  critique: "[InfiniteOC critique]",
  review: "[InfiniteOC review]",
  escalated: "[InfiniteOC escalated]",
  restored: "[InfiniteOC escalated: restored]",
  plan: "[InfiniteOC plan]",
  askOn: "[InfiniteOC askfirst: on]",
  askOff: "[InfiniteOC askfirst: off]",
  timebox: "[InfiniteOC timebox]",
}
const GOAL_ACTIVE = ["[InfiniteOC goal]", "[InfiniteOC goal: continue]", "[InfiniteOC goal: verify]"]
const GOAL_STOPPED = "[InfiniteOC goal: stopped]"

const isText = (message: Msg) => message.type === "user" || message.type === "synthetic"
const starts = (message: Msg, mark: string) => isText(message) && message.text.startsWith(mark)
const lastIndex = (messages: ReadonlyArray<Msg>, mark: string) => messages.findLastIndex((message) => starts(message, mark))
export const textOf = (message: Msg): string =>
  isText(message)
    ? message.text
    : message.type === "assistant"
      ? message.content.flatMap((part: any) => (part.type === "text" ? [part.text] : [])).join("\n")
      : ""

/** Index of the message that began the current piece of work: the last real user prompt. */
export const turnStart = (messages: ReadonlyArray<Msg>) => messages.findLastIndex((message) => message.type === "user")

/** True while a /goal is running (its last control message is not stopped or finished). */
export function goalActive(messages: ReadonlyArray<Msg>) {
  const last = messages.findLast(
    (message) => isText(message) && (GOAL_ACTIVE.some((mark) => message.text.startsWith(mark)) || message.text.startsWith(GOAL_STOPPED) || message.text.startsWith("[InfiniteOC goal: finished]")),
  )
  return !!last && GOAL_ACTIVE.some((mark) => last.text.startsWith(mark))
}

// ---- edits ---------------------------------------------------------------------------------------

const EDIT_TOOLS = new Set(["edit", "write", "patch"])

/** Files an edit, write or patch call would create or change. */
export function targets(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const value = input as { path?: unknown; patchText?: unknown }
  if ((tool === "edit" || tool === "write") && typeof value.path === "string") return [value.path]
  if (tool === "patch" && typeof value.patchText === "string")
    return [...value.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim())
  return []
}

/** Distinct files successfully edited after message index `from`. */
export function editedFiles(messages: ReadonlyArray<Msg>, from: number): string[] {
  const files = new Set<string>()
  for (const message of messages.slice(from + 1))
    if (message.type === "assistant")
      for (const part of message.content)
        if (part.type === "tool" && EDIT_TOOLS.has(part.name) && part.state.status === "completed") targets(part.name, part.state.input).forEach((file) => files.add(file))
  return [...files]
}

// ---- 1. auto-verify ------------------------------------------------------------------------------

export type Project = { files: string[]; read: (name: string) => string | undefined }
export type CheckKind = "check" | "tests" | "types" | "lint"

const STUB = /no test specified/

/** The project's check command for a kind, from package.json scripts, a Makefile, cargo, go or pytest. */
export function detectCheck(project: Project, kind: CheckKind = "check"): string | undefined {
  const has = (name: string) => project.files.includes(name)
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(project.read("package.json") ?? "{}").scripts ?? {}
  } catch {}
  const names: Record<CheckKind, string[]> = {
    check: ["check", "verify", "test"],
    tests: ["test"],
    types: ["typecheck", "type-check", "check:types", "tsc"],
    lint: ["lint"],
  }
  const script = names[kind].find((name) => typeof scripts[name] === "string" && !STUB.test(scripts[name]))
  if (script) {
    const runner = has("bun.lock") || has("bun.lockb") ? "bun run" : has("pnpm-lock.yaml") ? "pnpm run" : has("yarn.lock") ? "yarn" : "npm run"
    return `${runner} ${script}`
  }
  if (kind === "types" && has("tsconfig.json") && has("package.json")) return "npx tsc --noEmit"
  const make = project.read("Makefile") ?? project.read("makefile")
  const target = make ? names[kind].find((name) => new RegExp(`^${name}\\s*:`, "m").test(make)) : undefined
  if (target) return `make ${target}`
  if (has("Cargo.toml")) return { check: "cargo check --all-targets", tests: "cargo test", types: "cargo check --all-targets", lint: "cargo clippy --all-targets" }[kind]
  if (has("go.mod")) return { check: "go vet ./... && go test ./...", tests: "go test ./...", types: "go build ./...", lint: "go vet ./..." }[kind]
  if (kind !== "types" && kind !== "lint" && (has("pytest.ini") || /pytest/.test(project.read("pyproject.toml") ?? "") || /pytest/.test(project.read("setup.cfg") ?? ""))) return "python -m pytest -q"
  return undefined
}

/** Whether to run the check now. Attempts are counted from this prompt's failure notes. */
export function verifyPlan(messages: ReadonlyArray<Msg>, max: number, passedAt = -1) {
  const start = turnStart(messages)
  const marks = messages.flatMap((message, index) => (index > start && starts(message, MARK.verify) ? [index] : []))
  const since = Math.max(start, marks.at(-1) ?? -1, passedAt)
  return { run: marks.length < max && editedFiles(messages, since).length > 0, attempt: marks.length }
}

export const verifyFailText = (command: string, output: string, attempt: number, max: number) =>
  `${MARK.verify}\nThe project check \`${command}\` failed after your edits (fix attempt ${attempt} of ${max}). Output (tail):\n\n${output}\n\nFix the failures it reports, then re-run the check yourself. If a failure is unrelated to your change or you cannot fix it, say so plainly instead of guessing.`

export const tail = (text: string, max = 6000) => (text.length > max ? `...(truncated)\n${text.slice(-max)}` : text)

// ---- 2. stuck detection --------------------------------------------------------------------------

export const STUCK_AT = 3

const stable = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as any)[key])}`).join(",")}}`
      : JSON.stringify(value) ?? "null"

export const callKey = (tool: string, input: unknown) => `${tool} ${stable(input)}`

/** Records one call outcome and returns how many times this exact call has failed with this exact output. */
export function bump(counts: Map<string, number>, key: string, failed: boolean) {
  if (!failed) {
    counts.delete(key)
    return 0
  }
  const next = (counts.get(key) ?? 0) + 1
  counts.set(key, next)
  return next
}

export const stuckNote = (tool: string) =>
  `[InfiniteOC stuck] The same ${tool} call has now failed ${STUCK_AT} times with the same result. Stop repeating it. Change approach: re-read the error, check an assumption with a different command or smaller experiment, or ask the user which way to go with the question tool.`

export const stuckRefusal = (tool: string) =>
  `Refused: this exact ${tool} call already failed ${STUCK_AT} times with the same result. Do not retry it. Change approach (different inputs, a diagnostic step, another route) or ask the user with the question tool.`

// ---- 7. /plan ------------------------------------------------------------------------------------

export const APPROVE = "Approve and execute"
export const CANCEL = "Cancel plan"

export const planText = (task: string) =>
  `${MARK.plan}\nTask: ${task}\n\nPlan mode. Investigate read-only (read, search, run non-modifying commands) and do not edit or write files yet; edit tools are refused until the plan is approved.\n1. Write the plan as a markdown checklist: \`- [ ] step\`, each step small and checkable, ending with the verification commands that prove it works.\n2. Then call the question tool once: header "Plan", question "Approve this plan?", options "${APPROVE}", "Revise the plan" and "${CANCEL}". The user can also type their own edits instead.\n3. If they approve, execute the checklist in order. After each step, restate the checklist with finished steps ticked (\`- [x]\`). If they give edits, update the checklist and ask again. If they cancel, stop.`

/** "none" without a plan or after a cancel, "planning" until the user chooses approval, then "approved". */
export function planState(messages: ReadonlyArray<Msg>): "none" | "planning" | "approved" {
  const at = lastIndex(messages, MARK.plan)
  if (at < 0) return "none"
  let state: "planning" | "approved" | "none" = "planning"
  for (const message of messages.slice(at + 1))
    if (message.type === "assistant")
      for (const part of message.content) {
        if (part.type !== "tool" || part.name !== "question" || part.state.status !== "completed") continue
        const answers = JSON.stringify(part.state.metadata?.answers ?? "")
        if (answers.includes(CANCEL)) state = "none"
        else if (answers.includes(APPROVE)) state = "approved"
      }
  return state
}

export const planRefusal = `Refused: plan mode is waiting for approval. Finish the checklist and ask with the question tool (option "${APPROVE}") before editing files.`

// ---- 13. /askfirst -------------------------------------------------------------------------------

export function askFirstOn(messages: ReadonlyArray<Msg>) {
  return lastIndex(messages, MARK.askOn) > lastIndex(messages, MARK.askOff)
}

/** Ask-first blocks the second distinct file of a turn until the agent has asked a question. */
export function askFirstGate(messages: ReadonlyArray<Msg>, files: ReadonlyArray<string>) {
  const start = turnStart(messages)
  const asked = messages.slice(start + 1).some((message) => message.type === "assistant" && message.content.some((part: any) => part.type === "tool" && part.name === "question"))
  if (asked) return false
  return new Set([...editedFiles(messages, start), ...files]).size > 1
}

export const askFirstRefusal = "Refused: ask-first mode is on. This change touches more than one file. Call the question tool now with one focused clarifying question (offer concrete options), then continue with the answer."

export const askFirstBlock = `[Ask-first mode is ON]
Before any change that will touch more than one file, ask exactly one focused clarifying question with the question tool (give 2-4 concrete options, recommended first) and wait for the answer. Single-file edits and read-only work need no question. Edits to a second file are refused until you have asked.`

// ---- 15. personas --------------------------------------------------------------------------------

export const personas: Record<string, string> = {
  terse: "[Persona: terse] Answer in as few words as possible: fragments are fine, no preamble, no recap of what you just did, no pleasantries. Code and commands exactly as needed. This changes style only, never the checks you run.",
  teacher: "[Persona: teacher] Explain as you go for a learner: say why each step is taken, name the concept behind it, and point to one thing worth reading. Keep explanations short and concrete. This changes style only, never the checks you run.",
  pair: "[Persona: pair programmer] Work like a pair partner: think aloud briefly, state what you are about to do before you do it, flag trade-offs and ask for the user's view at real decision points. Keep the user in the loop. This changes style only, never the checks you run.",
}

// ---- settings ------------------------------------------------------------------------------------

export type Settings = {
  verify: boolean
  verifyCommand: string
  verifyRetries: number
  verifyTimeout: number
  stuck: boolean
  critique: boolean
  reviewerModel: string
  escalateModel: string
  persona: string
}

export const defaults: Settings = {
  verify: true,
  verifyCommand: "",
  verifyRetries: 2,
  verifyTimeout: 300,
  stuck: true,
  critique: false,
  reviewerModel: "",
  escalateModel: "",
  persona: "",
}

export const modelRef = (value: unknown): value is string => typeof value === "string" && /^[^/\s#]+\/[^\s#]+(#\S+)?$/.test(value)

export function normalizeSettings(raw: any): Settings {
  const input = raw && typeof raw === "object" ? raw : {}
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
  const int = (value: unknown, fallback: number, low: number, high: number) => (Number.isInteger(value) && (value as number) >= low && (value as number) <= high ? (value as number) : fallback)
  return {
    verify: bool(input.verify, defaults.verify),
    verifyCommand: typeof input.verifyCommand === "string" ? input.verifyCommand.trim() : "",
    verifyRetries: int(input.verifyRetries, defaults.verifyRetries, 1, 5),
    verifyTimeout: int(input.verifyTimeout, defaults.verifyTimeout, 5, 3600),
    stuck: bool(input.stuck, defaults.stuck),
    critique: bool(input.critique, defaults.critique),
    reviewerModel: modelRef(input.reviewerModel) ? input.reviewerModel : "",
    escalateModel: modelRef(input.escalateModel) ? input.escalateModel : "",
    persona: typeof input.persona === "string" && input.persona in personas ? input.persona : "",
  }
}

const ON = /^(on|true|yes|1)$/i
const OFF = /^(off|false|no|0|none|-)$/i

/** One `/auto <key> <value>` change. Returns the next autonomy object or an error message. */
export function applySetting(current: Record<string, unknown>, key: string, value: string): { next: Record<string, unknown> } | { error: string } {
  const name = ({ verify: "verify", verifycmd: "verifyCommand", verifycommand: "verifyCommand", retries: "verifyRetries", verifyretries: "verifyRetries", timeout: "verifyTimeout", verifytimeout: "verifyTimeout", stuck: "stuck", critique: "critique", reviewer: "reviewerModel", reviewermodel: "reviewerModel", escalate: "escalateModel", escalatemodel: "escalateModel", persona: "persona" } as Record<string, string>)[key.toLowerCase()]
  if (!name) return { error: `Unknown setting "${key}". Keys: verify, verifycmd, retries, timeout, stuck, critique, reviewer, escalate, persona.` }
  const next = { ...current }
  if (name === "verify" || name === "stuck" || name === "critique") {
    if (!ON.test(value) && !OFF.test(value)) return { error: `${name} takes on or off.` }
    next[name] = ON.test(value)
  } else if (name === "verifyRetries" || name === "verifyTimeout") {
    const number = Number(value)
    const [low, high] = name === "verifyRetries" ? [1, 5] : [5, 3600]
    if (!Number.isInteger(number) || number < low || number > high) return { error: `${name} takes a whole number from ${low} to ${high}.` }
    next[name] = number
  } else if (name === "reviewerModel" || name === "escalateModel") {
    if (OFF.test(value)) delete next[name]
    else if (modelRef(value)) next[name] = value
    else return { error: `${name} takes provider/model (optionally #variant) or off.` }
  } else if (name === "persona") {
    if (OFF.test(value)) delete next[name]
    else if (value.toLowerCase() in personas) next[name] = value.toLowerCase()
    else return { error: `persona takes ${Object.keys(personas).join(", ")} or off.` }
  } else {
    if (OFF.test(value) || !value.trim()) delete next[name]
    else next[name] = value.trim()
  }
  return { next }
}

export function describeSettings(settings: Settings) {
  const state = (value: boolean) => (value ? "on" : "off")
  return [
    `verify ${state(settings.verify)}${settings.verifyCommand ? ` (${settings.verifyCommand})` : ""}, ${settings.verifyRetries} fix-ups, ${settings.verifyTimeout}s`,
    `stuck ${state(settings.stuck)}`,
    `critique ${state(settings.critique)}`,
    `reviewer ${settings.reviewerModel || "off"}`,
    `escalate ${settings.escalateModel || "off"}`,
    `persona ${settings.persona || "off"}`,
  ].join(" | ")
}

// ---- 4-6. loop, queue, timebox, macros -----------------------------------------------------------

export const MIN_LOOP_MS = 10_000

/** "90s", "5m", "2h", "1h30m" to milliseconds; undefined when it is not a duration. */
export function parseDuration(text: string): number | undefined {
  const value = text.trim().toLowerCase()
  if (!/^(\d+(\.\d+)?[smh])+$/.test(value)) return undefined
  const ms = [...value.matchAll(/(\d+(?:\.\d+)?)([smh])/g)].reduce((sum, [, amount, unit]) => sum + Number(amount) * { s: 1000, m: 60_000, h: 3_600_000 }[unit as "s"], 0)
  return ms > 0 ? Math.round(ms) : undefined
}

export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
  return [h && `${h}h`, m && `${m}m`, (s || (!h && !m)) && `${s}s`].filter(Boolean).join(" ")
}

export type LoopCommand = { action: "stop" } | { action: "status" } | { action: "start"; ms: number; prompt: string } | { action: "error"; message: string }

export function parseLoop(args: string): LoopCommand {
  const text = args.trim()
  if (!text) return { action: "status" }
  if (/^(stop|off|cancel|clear)$/i.test(text)) return { action: "stop" }
  const [interval, ...rest] = text.split(/\s+/)
  const ms = parseDuration(interval)
  if (!ms) return { action: "error", message: "Usage: /loop <interval> <prompt> (for example /loop 5m check the build), /loop stop." }
  if (ms < MIN_LOOP_MS) return { action: "error", message: `Interval must be at least ${formatDuration(MIN_LOOP_MS)}.` }
  const prompt = rest.join(" ").trim()
  return prompt ? { action: "start", ms, prompt } : { action: "error", message: "Say what to run each time: /loop <interval> <prompt>." }
}

export const timeboxText = (label: string) =>
  `${MARK.timebox}\nThe ${label} timebox is up. Stop starting new work now. Bring what you have to a safe, consistent state (finish or revert the edit in progress, no half-applied changes), run the quickest relevant check if cheap, then summarize: what is done, what is not done, what you would do next, and anything unverified.`

export const whyText = (extra: string) =>
  `Why did you do that? Explain your last action: what you did, why you chose it over alternatives, and the evidence (file:line, command output, tool results) that it was right. Mark anything you did not verify as unverified.${extra ? ` Focus: ${extra}` : ""} Do not make any changes or run state-changing commands while answering.`

// ---- 9, 10. critique and second opinion ----------------------------------------------------------

export const critiqueText = `${MARK.critique}
Before reporting this done, do a quick self-critique of your own change: read your diff (git diff), then check for a wrong assumption, an unhandled edge case, a missed caller, a missing or weak test, and anything you claimed but did not run. Fix what you find and re-run the relevant check. Then give the final summary; list anything still unverified.`

export const reviewPrompt = (request: string, diff: string) =>
  `You are an independent code reviewer giving a second opinion on a change an AI coding agent just made. Find real defects only: bugs, unhandled edge cases, regressions, security problems, tests that do not test the change. No style nits.\n\nThe user's request:\n${request}\n\nThe diff:\n${diff}\n\nReply with a ranked list, each item as "- severity (blocker|major|minor), file:line, the problem and its trigger". If you find no real defects, reply with exactly: NO DEFECTS`

export const reviewClean = (reply: string) => /^\s*NO DEFECTS\b/i.test(reply)

export const reviewText = (model: string, reply: string) =>
  `${MARK.review}\nA second-opinion reviewer (${model}) checked your diff and reported:\n\n${reply}\n\nVerify each point against the code. Fix the real defects and re-run the relevant check. For any point that is wrong, say briefly why. Then give the final summary.`

// ---- 11. escalation ------------------------------------------------------------------------------

/** The model the session was on before an unrestored escalation, or undefined. */
export function escalatedFrom(messages: ReadonlyArray<Msg>): string | undefined {
  const up = lastIndex(messages, MARK.escalated)
  if (up < 0 || up < lastIndex(messages, MARK.restored)) return undefined
  return /^From: (.+)$/m.exec(textOf(messages[up]))?.[1]?.trim()
}

export const escalatedText = (from: string, to: string, why: string) =>
  `${MARK.escalated}\nFrom: ${from}\nTo: ${to}\nReason: ${why}\nThe model was switched for the fix-up and is restored once the work passes.`

export const restoredText = (to: string) => `${MARK.restored}\nThe model is back on ${to}.`

/** "provider/model#variant" for an assistant message's model ref. */
export const refString = (ref: { providerID: string; id: string; variant?: string } | undefined) => (ref ? `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}` : undefined)

// ---- 8. goal templates ---------------------------------------------------------------------------

export const GOAL_TEMPLATES = { tests: "the project's tests pass", types: "the project type-checks cleanly", lint: "the project lints cleanly" } as const

/** `/goal tests|types|lint` as a full goal with its verification command, or undefined for any other text. */
export function goalTemplate(word: string, command: string | undefined): string | undefined {
  const key = word.trim().toLowerCase()
  if (!(key in GOAL_TEMPLATES)) return undefined
  const what = GOAL_TEMPLATES[key as keyof typeof GOAL_TEMPLATES]
  const how = command
    ? `\`${command}\` exits 0 when run after your last edit, with no failures reported`
    : `find the ${key === "tests" ? "test" : key === "types" ? "type-check" : "lint"} command (package.json scripts, Makefile, CI config), run it after your last edit, and it reports no failures`
  return `${what}: ${how}. Fix the code rather than weakening checks.`
}
