// session-import regression tests: discovery, both parsers, the import
// payload and the CLI against fixtures plus a stub backend. No user data, no
// paid requests, no real backend touched.
import test from "node:test"
import assert from "node:assert/strict"
import module from "node:module"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import mod from "./index.mjs"
import {
  claudeText,
  claudeUserEntry,
  listAntigravitySessions,
  listClaudeSessions,
  readAntigravitySession,
  readClaudeSession,
  toImportPayload,
  newSessionId,
  importedAs,
  MAX_IMPORT_CHARS,
} from "./lib.mjs"

const hasStrip = Boolean(module.stripTypeScriptTypes)
// Import records go to $XDG_DATA_HOME/infiniteoc; keep them out of the real one (children inherit it).
process.env.XDG_DATA_HOME = await mkdtemp(path.join(tmpdir(), "session-import-data-"))
const here = new URL(".", import.meta.url).pathname

const CLAUDE_FIXTURE = [
  { type: "mode", mode: "normal", sessionId: "s1" },
  { type: "user", message: { role: "user", content: "fix the login bug" }, uuid: "u1", timestamp: "2026-10-01T10:00:00Z", cwd: "/repo", sessionId: "s1" },
  { type: "assistant", message: { role: "assistant", model: "claude-x", content: [{ type: "thinking", thinking: "check auth", signature: "s" }, { type: "text", text: "On it." }, { type: "tool_use", id: "t1", name: "Read", input: { file: "a.ts" } }] }, uuid: "a1", timestamp: "2026-10-01T10:00:05Z", sessionId: "s1" },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file bytes here" }] }, uuid: "u2", timestamp: "2026-10-01T10:00:06Z", sessionId: "s1" },
  { type: "user", isSidechain: true, message: { role: "user", content: "subagent noise" }, uuid: "u3", sessionId: "s1" },
  { type: "cost-state", sessionId: "s1" },
].map((o) => JSON.stringify(o)).join("\n")

const AGY_FIXTURE = [
  { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-11T20:14:42Z", content: "<USER_REQUEST>\nFind FLYWHEEL.\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnoon\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to `Gemini 3.1 Pro (High)`.\n</USER_SETTINGS_CHANGE>" },
  { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-06-11T20:14:42Z" },
  { step_index: 2, source: "SYSTEM", type: "EPHEMERAL_MESSAGE", status: "DONE", created_at: "2026-06-11T20:14:42Z", content: "transient" },
  { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-06-11T20:14:43Z", content: "Searching now.", thinking: "grep first" },
  { step_index: 4, source: "MODEL", type: "RUN_COMMAND", status: "DONE", created_at: "2026-06-11T20:14:44Z", content: "found it", thinking: null, tool_calls: [{ name: "grep_search", id: "c1", arguments: { query: "FLYWHEEL" } }] },
  { step_index: 5, source: "FUTURE", type: "SOMETHING_NEW", status: "DONE", created_at: "2026-06-11T20:14:45Z", content: "must not crash" },
].map((o) => JSON.stringify(o)).join("\n")

async function fixtureHome() {
  const home = await mkdtemp(path.join(tmpdir(), "harness-"))
  await mkdir(path.join(home, ".claude", "projects", "-repo"), { recursive: true })
  await writeFile(path.join(home, ".claude", "projects", "-repo", "s1.jsonl"), CLAUDE_FIXTURE)
  await writeFile(path.join(home, ".claude", "projects", "-repo", "agent-sub.jsonl"), '{"type":"user","message":{"role":"user","content":"x"}}\n')
  const logs = path.join(home, ".gemini", "antigravity-cli", "brain", "agy1", ".system_generated", "logs")
  await mkdir(logs, { recursive: true })
  await writeFile(path.join(logs, "transcript.jsonl"), AGY_FIXTURE)
  return home
}

test("claude discovery lists mains, skips subagent forks", async () => {
  const home = await fixtureHome()
  try {
    const sessions = listClaudeSessions(home)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, "s1")
    assert.equal(sessions[0].harness, "claude")
    assert.equal(sessions[0].userTurns, 1) // typed messages; the tool result is not one
    assert.equal(sessions[0].assistantTurns, 1)
    assert.equal(sessions[0].title, "fix the login bug")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("claude blocks render text, thinking, tools and images as markers", () => {
  assert.equal(claudeText("raw"), "raw")
  const text = claudeText([{ type: "text", text: "hi" }, { type: "thinking", thinking: "hmm", signature: "s" }, { type: "tool_use", name: "Bash", input: { c: "ls" } }, { type: "image" }, { type: "unknown_future" }])
  assert.match(text, /hi/)
  assert.match(text, /\[reasoning: hmm\]/)
  assert.match(text, /\[used Bash/)
  assert.match(text, /\[image omitted\]/)
  assert.ok(!text.includes("unknown_future"))
})

test("claude session parses to turns with model and cwd", async () => {
  const home = await fixtureHome()
  try {
    const { turns, cwd, requestedModel } = readClaudeSession(path.join(home, ".claude", "projects", "-repo", "s1.jsonl"))
    // The tool result joins the reply that ran the tool; only typed text is the user's.
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant"])
    assert.match(turns[1].text, /On it\./)
    assert.match(turns[1].text, /\[reasoning: check auth\]/)
    assert.match(turns[1].text, /\[used Read[\s\S]*\[tool result: file bytes here\]/)
    assert.equal(cwd, "/repo")
    assert.equal(requestedModel, "claude-x")
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("antigravity discovery and transcript parse (drops ephemeral/history, survives future types)", async () => {
  const home = await fixtureHome()
  try {
    const sessions = listAntigravitySessions(home)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].id, "agy1")
    const { turns, model } = readAntigravitySession(sessions[0].file)
    assert.equal(model, "Gemini 3.1 Pro (High)")
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "assistant"])
    assert.equal(turns[0].text, "Find FLYWHEEL.")
    assert.ok(!turns[0].text.includes("ADDITIONAL_METADATA"))
    assert.match(turns[1].text, /Searching now\./)
    assert.match(turns[1].text, /\[reasoning: grep first\]/)
    assert.match(turns[2].text, /\[used grep_search/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("import payload uses ses_/msg_ ids, marks assistant origin, caps and discloses", () => {
  const turns = [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi there", model: "claude-x" },
    { role: "system", text: "noise" },
  ]
  const payload = toImportPayload(turns, { harness: "claude", sourceId: "s1", directory: "/tmp" })
  assert.equal(payload.info.projectID, "global")
  assert.deepEqual(payload.info.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  // An origin note, then the turns: replies are assistant messages attributed to their real source.
  assert.deepEqual(payload.messages.map((m) => m.type), ["synthetic", "user", "assistant"])
  assert.match(payload.messages[0].text, /imported from Claude Code \(session s1\)/)
  assert.equal(payload.messages[1].text, "hello")
  assert.deepEqual(payload.messages[2].model, { providerID: "claude-code", id: "claude-x" })
  assert.deepEqual(payload.messages[2].content, [{ type: "text", text: "hi there" }])
  assert.match(payload.messages[2].id, /^msg_[0-9a-f]{32}$/)
  assert.throws(() => toImportPayload([{ role: "system", text: "x" }], { harness: "c", sourceId: "s", directory: "/t" }), /Nothing importable/)
  // Ids are made the way OpenCode makes them (time-ordered, newest first), never random hex: the
  // provider gateway refuses a session whose id OpenCode could not have created.
  assert.match(payload.info.id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  const now = Date.now()
  assert.ok(newSessionId(now + 1000).slice(0, 16) < newSessionId(now).slice(0, 16), "descending: newer ids sort first, like upstream")
  // Long sessions keep the original request and the newest turns, with a note for the gap.
  const long = [{ role: "user", text: "GOAL: build it" }]
  for (let i = 0; i < 40; i++) long.push({ role: "assistant", text: `step ${i} ` + "x".repeat(10_000) }, { role: "user", text: `next ${i}` })
  const cut = toImportPayload(long, { harness: "claude", sourceId: "long", directory: "/t" })
  const textOf = (m) => m.text ?? m.content.map((part) => part.text).join("")
  assert.equal(cut.messages[1].text, "GOAL: build it")
  assert.match(cut.messages[2].text, /^\[import note: \d+ earlier turns of the claude session were left out/)
  assert.equal(cut.messages.at(-1).text, "next 39")
  assert.match(textOf(cut.messages.at(-2)), /step 39 /)
  assert.ok(cut.messages.slice(1).reduce((sum, m) => sum + textOf(m).length, 0) <= MAX_IMPORT_CHARS + 500)
  // A single newest turn bigger than everything still comes along, cut to fit.
  const huge = toImportPayload([{ role: "user", text: "hi" }, { role: "assistant", text: "z".repeat(MAX_IMPORT_CHARS * 2) }], { harness: "c", sourceId: "s", directory: "/t" })
  assert.equal(huge.messages.length, 3)
  assert.ok(huge.messages[2].content[0].text.length < MAX_IMPORT_CHARS)
})

test("CLI lists and reads from a fixture home", async () => {
  const home = await fixtureHome()
  try {
    const run = (args) => spawnSync(process.execPath, [path.join(here, "import.mjs"), ...args, "--home", home], { encoding: "utf8" })
    const list = run(["--list"])
    assert.equal(list.status, 0, list.stderr)
    assert.match(list.stdout, /claude\s+s1/)
    assert.match(list.stdout, /antigravity\s+agy1/)
    const read = run(["--read", "s1", "--from", "claude"])
    assert.equal(read.status, 0, read.stderr)
    assert.match(read.stdout, /fix the login bug/)
    assert.equal(run([]).status, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test("CLI imports through a stub backend", async () => {
  const home = await fixtureHome()
  const seen = []
  const stub = createServer((request, response) => {
    const send = (status, body) => {
      const text = JSON.stringify(body)
      response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
      response.end(text)
    }
    if (request.headers.authorization !== "Basic b3BlbmNvZGU6cHc=") return send(401, {})
    if (request.method === "POST" && request.url === "/api/experimental/session/import") {
      let raw = ""
      request.on("data", (c) => (raw += c))
      request.on("end", () => {
        const body = JSON.parse(raw)
        seen.push(body)
        send(200, { data: { id: body.info.id, title: body.info.title } })
      })
      return
    }
    send(404, {})
  })
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve))
  try {
    const port = stub.address().port
    const child = spawn(process.execPath, [path.join(here, "import.mjs"), "--import", "agy1", "--from", "antigravity", "--upstream", `http://127.0.0.1:${port}`, "--dir", tmpdir(), "--home", home], {
      env: { ...process.env, IOC_IMPORT_PASSWORD: "pw" },
      encoding: "utf8",
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (c) => (out += c))
    child.stderr.on("data", (c) => (err += c))
    const code = await new Promise((resolve) => child.on("close", resolve))
    assert.equal(code, 0, err)
    assert.equal(seen.length, 1)
    assert.match(seen[0].info.id, /^ses_/)
    assert.ok(seen[0].messages.length >= 3)
    assert.equal(seen[0].location.directory, tmpdir())
    assert.match(out, /Imported antigravity agy1 as session ses_/)
  } finally {
    stub.close()
    await rm(home, { recursive: true, force: true })
  }
})

test("/import imports the picked session through the UI's backend client and opens it", { skip: !hasStrip && "needs Node type stripping" }, async () => {
  assert.equal(mod.id, "session-import")
  const written = {}
  const commands = []
  await mod.setup({
    read: async () => "",
    write: async (file, content) => {
      written[file] = content
    },
    patch: async () => {
      throw new Error("must not patch")
    },
    patchExact: async () => {
      throw new Error("must not patch")
    },
    tui: { command: (input) => commands.push(input) },
    on: () => {},
  })
  assert.ok(written["packages/tui/src/infiniteoc-features/session-import-lib.mjs"].includes("toImportPayload"))
  assert.equal(commands.length, 1)
  assert.equal(commands[0].slash, "import")
  const stripped = module.stripTypeScriptTypes(commands[0].source).replace("./session-import-lib.mjs", new URL("./lib.mjs", import.meta.url).href)
  const { run } = await import(`data:text/javascript,${encodeURIComponent(stripped)}`)
  const home = await fixtureHome()
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    const imported = new Map()
    const calls = { opened: [], selected: [], alerts: [], toasts: [] }
    const ctx = (pick) => ({
      ui: { select: async ({ options }) => options.findIndex((o) => o.title.startsWith(pick)).toString(), alert: async (a) => calls.alerts.push(a) },
      toast: { show: (t) => calls.toasts.push(t) },
      tabs: { enabled: () => true, open: (id) => calls.opened.push(id), select: (id) => calls.selected.push(id) },
      route: { navigate: () => assert.fail("tabs are enabled") },
      client: {
        api: {
          session: {
            get: async ({ sessionID }) => imported.get(sessionID) ?? Promise.reject(new Error("404")),
            import: async (input) => void imported.set(input.info.id, input),
          },
        },
      },
    })
    await run(ctx("Claude"))
    const id = importedAs("claude", "s1")
    assert.deepEqual(calls.alerts, [])
    assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    assert.ok(imported.has(id), "imported into the backend")
    assert.equal(imported.get(id).info.title, "Claude: fix the login bug")
    assert.deepEqual(imported.get(id).location, { directory: imported.get(id).info.location.directory })
    assert.deepEqual([calls.opened, calls.selected], [[id], [id]])
    // Picking it again opens the first copy instead of importing a second one.
    await run(ctx("Claude"))
    assert.equal(imported.size, 1)
    assert.deepEqual(calls.selected, [id, id])
    assert.match(calls.toasts.at(-1).title, /Already imported/)
    // Antigravity sessions are titled by their first request.
    await run(ctx("Antigravity"))
    assert.match(imported.get(importedAs("antigravity", "agy1")).info.title, /^Antigravity: (?!agy1$)/)
  } finally {
    process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test("Claude Code bookkeeping is not conversation: caveats, local commands, their output, notices", () => {
  const user = (content, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra })
  assert.equal(claudeUserEntry(user("<local-command-caveat>The command below was run directly</local-command-caveat>", { isMeta: true })), undefined)
  assert.equal(claudeUserEntry(user("<command-name>/login</command-name>\n<command-message>login</command-message>\n<command-args></command-args>")), undefined)
  assert.equal(claudeUserEntry(user("<local-command-stdout>Login successful</local-command-stdout>")), undefined)
  assert.equal(claudeUserEntry(user("<task-notification>\n<task-id>b1</task-id></task-notification>")), undefined)
  assert.equal(claudeUserEntry(user("<system-reminder>interrupted</system-reminder>", { isMeta: true })), undefined)
  assert.deepEqual(claudeUserEntry(user("<command-message>ponytail</command-message>\n<command-name>/ponytail</command-name>\n<command-args>ultra</command-args>")), { text: "[ran /ponytail ultra]", typed: true })
  assert.deepEqual(claudeUserEntry(user("fix the login bug")), { text: "fix the login bug", typed: true })
  assert.deepEqual(claudeUserEntry(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])), { text: "[tool result: ok]", typed: false })
  assert.equal(claudeUserEntry(user("subagent", { isSidechain: true })), undefined)
})
