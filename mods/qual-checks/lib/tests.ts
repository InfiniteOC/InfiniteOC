// Test-run knowledge shared by /testfirst, the flaky detector and mutation checks.
const RUNNER = /(^|[\s;&|(])(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t|test:\w+|check)\b|(^|[\s;&|(])(vitest|jest|mocha|ava|tap|pytest|py\.test|phpunit|rspec|minitest)\b|\bnode\s+(--[\w=-]+\s+)*--test\b|\bgo\s+test\b|\bcargo\s+(nextest\s+)?test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|(^|[\s;&|(])(mvn|gradle|\.\/gradlew)\s+(\S+\s+)*test\b|\bdotnet\s+test\b|\bdeno\s+test\b|\bbun\s+test\b/
export const isTestCommand = (command: string) => RUNNER.test(command)

const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$|(^|\/)test\.m?[jt]s$/i
export const isTestFile = (file: string) => TEST_FILE.test(file)

export interface Run {
  command: string
  exit: number | undefined
}
export interface TestFirstState {
  active: boolean
  /** need-test: no test edited yet. need-red: test edited but no failing run seen after it. red: failing run seen, fix allowed. green: passing run after the fix. */
  phase: "off" | "need-test" | "need-red" | "red" | "green"
}

export type Entry =
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "edit"; files: string[] }
  | { kind: "run"; run: Run }

/** Pure: the test-first phase from a flat, ordered list of transcript events. */
export function testFirstPhase(events: Entry[]): TestFirstState["phase"] {
  let phase: TestFirstState["phase"] = "off"
  for (const event of events) {
    if (event.kind === "start") phase = "need-test"
    else if (event.kind === "stop") phase = "off"
    else if (phase === "off") continue
    else if (event.kind === "edit") {
      // Green is sticky: later edits never relock, or a refactor after the fix could not proceed.
      if (event.files.some(isTestFile) && phase !== "green" && phase !== "red") phase = "need-red"
    } else if (isTestCommand(event.run.command) && event.run.exit !== undefined) {
      if (event.run.exit !== 0 && (phase === "need-red")) phase = "red"
      else if (event.run.exit === 0 && phase === "red") phase = "green"
    }
  }
  return phase
}

const SOURCE = /\.(m?[jt]sx?|py|go|rs|rb|java|kt|php|cs|c|cc|cpp|h|swift|vue|svelte)$/i
/** Code the test-first gate protects: source files that are not tests. */
export const isSourceFile = (file: string) => SOURCE.test(file) && !isTestFile(file)

export const testFirstRefusal = (phase: TestFirstState["phase"], files: string[]) =>
  phase === "need-test"
    ? `Refused by /testfirst: write the failing test first. Add or edit a test file, run the tests, and show that the new test fails for the right reason before touching ${files.join(", ")}.`
    : `Refused by /testfirst: the new test has not been seen failing. Run the test command now and confirm the new test fails (and why) before touching ${files.join(", ")}.`

export const MARK = {
  start: "[InfiniteOC testfirst]",
  stopped: "[InfiniteOC testfirst: stopped]",
  done: "[InfiniteOC testfirst: done]",
  reminder: "[InfiniteOC testfirst: reminder]",
} as const

/** Files an edit, write or patch call would create or change. */
export function targets(tool: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return []
  const value = input as { path?: unknown; patchText?: unknown }
  if ((tool === "edit" || tool === "write") && typeof value.path === "string") return [value.path]
  if (tool === "patch" && typeof value.patchText === "string")
    return [...value.patchText.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim())
  return []
}

/** The ordered edit/run/marker events of a session transcript (structurally typed: SessionMessage.Info[]). */
export function eventsFromMessages(messages: ReadonlyArray<any>): Entry[] {
  const out: Entry[] = []
  for (const message of messages) {
    if (message.type === "user" || message.type === "synthetic") {
      const text: string = message.text ?? ""
      if (text.startsWith(MARK.stopped) || text.startsWith(MARK.done)) out.push({ kind: "stop" })
      else if (text.startsWith(MARK.start)) out.push({ kind: "start" })
    } else if (message.type === "assistant") {
      for (const part of message.content ?? []) {
        if (part.type !== "tool" || part.state?.status !== "completed") continue
        if (part.name === "shell") out.push({ kind: "run", run: { command: String(part.state.input?.command ?? ""), exit: part.state.metadata?.exit } })
        else {
          const files = targets(part.name, part.state.input)
          if (files.length) out.push({ kind: "edit", files })
        }
      }
    } else if (message.type === "shell") out.push({ kind: "run", run: { command: String(message.command ?? ""), exit: message.exit } })
  }
  return out
}

export const reminderCount = (messages: ReadonlyArray<any>) =>
  messages.filter((message) => (message.type === "user" || message.type === "synthetic") && String(message.text ?? "").startsWith(MARK.reminder)).length

/** What to do when a run ends: nothing, remind the agent, close out a confirmed red-green cycle, or give up reminding. */
export const testFirstEnd = (phase: TestFirstState["phase"], reminders: number) =>
  phase === "off" ? ("none" as const) : phase === "green" ? ("done" as const) : reminders >= 2 ? ("gave-up" as const) : ("remind" as const)

export const flakyVerdict = (results: ReadonlyArray<number | undefined>) => {
  const failed = results.filter((exit) => exit !== 0).length
  if (failed === results.length) return "consistent" as const
  return "flaky" as const
}

// Flipping one condition: the first operator on the line (or in the file) that has an inverse.
const FLIPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/===/, "!=="], [/!==/, "==="], [/(?<![=!<>])==(?!=)/, "!="], [/!=(?!=)/, "=="],
  [/<=/, ">"], [/>=/, "<"], [/(?<![<=-])<(?![<=])/, ">="], [/(?<![>=-])>(?![>=])/, "<="],
  [/&&/, "||"], [/\|\|/, "&&"], [/\btrue\b/, "false"], [/\bfalse\b/, "true"], [/\band\b/, "or"], [/\bor\b/, "and"],
]
export interface Mutation {
  line: number
  before: string
  after: string
  text: string
}

/** Pure: flip one condition. With `line`, mutate that line only; otherwise the first mutable line. */
export function mutate(source: string, line?: number): Mutation | undefined {
  const lines = source.split("\n")
  const candidates = line ? [line - 1] : lines.map((_, i) => i)
  for (const i of candidates) {
    const text = lines[i]
    if (text === undefined || /^\s*(\/\/|#|\*|\/\*)/.test(text)) continue
    // Prefer conditions: lines with if/while/ternary/return/assignment of a comparison.
    for (const [pattern, to] of FLIPS) {
      const match = pattern.exec(text)
      if (!match || (!line && !/\b(if|while|return|elif|unless)\b|\?|=>|&&|\|\|/.test(text))) continue
      lines[i] = text.slice(0, match.index) + to + text.slice(match.index + match[0].length)
      return { line: i + 1, before: text.trim(), after: lines[i].trim(), text: lines.join("\n") }
    }
  }
  return undefined
}

export const compareBench = (baseMs: number | undefined, nowMs: number, tolerancePct: number) => {
  if (baseMs === undefined) return { regressed: false, message: `Benchmark: ${nowMs.toFixed(0)} ms (best of runs). No baseline yet; this is now the baseline.` }
  const pct = ((nowMs - baseMs) / baseMs) * 100
  const regressed = pct > tolerancePct
  return {
    regressed,
    message: `Benchmark: ${nowMs.toFixed(0)} ms versus baseline ${baseMs.toFixed(0)} ms (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%, tolerance ${tolerancePct}%).${regressed ? " REGRESSION: investigate before reporting done, or tell the user the cost is intended." : ""}`,
  }
}
