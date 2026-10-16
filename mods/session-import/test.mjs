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
  listAntigravitySessions,
  listClaudeSessions,
  readAntigravitySession,
  readClaudeSession,
  toImportPayload,
} from "./lib.mjs"

const hasStrip = Boolean(module.stripTypeScriptTypes)
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
    assert.equal(sessions[0].userTurns, 2)
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
    assert.equal(turns.length, 3)
    assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"])
    assert.match(turns[1].text, /On it\./)
    assert.match(turns[1].text, /\[reasoning: check auth\]/)
    assert.match(turns[2].text, /\[tool result: file bytes here\]/)
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
  assert.match(payload.info.id, /^ses_[0-9a-f]{32}$/)
  assert.equal(payload.info.projectID, "global")
  assert.deepEqual(payload.info.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
  assert.equal(payload.messages.length, 2)
  assert.equal(payload.messages[0].type, "user")
  assert.match(payload.messages[1].text, /^Originally from claude \(claude-x\):/)
  assert.match(payload.messages[1].id, /^msg_[0-9a-f]{32}$/)
  assert.throws(() => toImportPayload([{ role: "system", text: "x" }], { harness: "c", sourceId: "s", directory: "/t" }), /Nothing importable/)
  const big = toImportPayload([{ role: "user", text: "a".repeat(70000) }], { harness: "c", sourceId: "s", directory: "/t" })
  assert.ok(big.messages.at(-1).text.includes("not imported"))
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

test("mod registers /import and ships the lib; command lists read-only", { skip: !hasStrip && "needs Node type stripping" }, async () => {
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
  const alerts = []
  await run({ ui: { select: async () => "close", alert: async (a) => alerts.push(a), set: () => {} }, toast: { show: () => {} } })
  assert.equal(alerts.length, 0)
})
