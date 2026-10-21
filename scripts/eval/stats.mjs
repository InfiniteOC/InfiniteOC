// Stats of an `opencode run --format json` log: steps, tokens, tool calls and errors, failed file writes,
// files written through shell heredocs (which skip the edit gates), skills loaded and wall time.
// Usage: node scripts/eval/stats.mjs run.jsonl...
import fs from "node:fs"
import path from "node:path"

export function summarize(file) {
  const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const s = { steps: 0, input: 0, output: 0, reasoning: 0, cache: 0, tools: 0, toolErrors: 0, writeErrors: 0, shellWrites: 0, skills: [], uiChecks: 0, seconds: 0 }
  for (const e of events) {
    if (e.type === "step_finish") { const t = e.part?.tokens ?? {}; s.steps++; s.input += t.input ?? 0; s.output += t.output ?? 0; s.reasoning += t.reasoning ?? 0; s.cache += t.cache?.read ?? 0 }
    if (e.type !== "tool_use") continue
    const state = e.part?.state ?? {}, tool = e.part?.tool
    s.tools++
    if (state.status === "error") s.toolErrors++
    if (["write", "edit"].includes(tool) && state.status === "error") s.writeErrors++
    if (tool === "shell" && /cat\s*>\s*\S+\s*<</.test(state.input?.command ?? "")) s.shellWrites++
    if (tool === "skill") s.skills.push(state.input?.name ?? state.input?.id)
    if (tool === "ui_check") s.uiChecks++
  }
  const stamps = events.map((e) => e.timestamp).filter(Number.isFinite)
  s.seconds = stamps.length ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 1000) : 0
  return s
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  for (const file of process.argv.slice(2)) console.log(path.basename(path.dirname(path.resolve(file))).padEnd(16), JSON.stringify(summarize(file)))
