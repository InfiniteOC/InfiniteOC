#!/usr/bin/env node
// session-import CLI: list, preview and import foreign harness sessions
// (Claude Code, Antigravity CLI) into a running InfiniteOC backend, where
// they continue as ordinary sessions. Read-only against foreign data.
//
//   node import.mjs --list [--from claude|antigravity] [--json] [--home DIR]
//   node import.mjs --read <id> [--from ...] [--home DIR]
//   node import.mjs --import <id> --upstream http://127.0.0.1:4096 [--dir DIR] [--title T] [--home DIR]
//
// Backend password from IOC_IMPORT_PASSWORD, IOC_PROXY_PASSWORD or
// OPENCODE_PASSWORD (env only, never argv, never logged).
import { existsSync, statSync } from "node:fs"
import {
  antigravityDir,
  claudeDir,
  listAntigravitySessions,
  listClaudeSessions,
  readAntigravitySession,
  readClaudeSession,
  toImportPayload,
} from "./lib.mjs"
import { readSummaries } from "./summaries.mjs"

const usage = `Usage:
  node import.mjs --list [--from claude|antigravity] [--json] [--home DIR]
  node import.mjs --read <id> [--from claude|antigravity] [--home DIR]
  node import.mjs --import <id> --upstream URL [--dir DIR] [--title T] [--from ...] [--home DIR]`

function parseArgs(argv) {
  const out = { from: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf("=")
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    const value = () => {
      const given = eq === -1 ? argv[++i] : arg.slice(eq + 1)
      if (given === undefined || given === "") throw new Error(`${flag} needs a value`)
      return given
    }
    if (flag === "--list") out.list = true
    else if (flag === "--json") out.json = true
    else if (flag === "--read") out.read = value()
    else if (flag === "--import") out.import = value()
    else if (flag === "--from") out.from = value()
    else if (flag === "--home") out.home = value()
    else if (flag === "--upstream") out.upstream = value()
    else if (flag === "--dir") out.dir = value()
    else if (flag === "--title") out.title = value()
    else throw new Error(`Unknown option ${arg}\n${usage}`)
  }
  if (out.from !== undefined && !["claude", "antigravity"].includes(out.from)) throw new Error(`--from must be claude or antigravity\n${usage}`)
  return out
}

const want = (options, harness) => !options.from || options.from === harness

async function listAll(home, options) {
  const out = []
  if (want(options, "claude")) out.push(...listClaudeSessions(home))
  if (want(options, "antigravity")) {
    const scanned = listAntigravitySessions(home)
    if (scanned.length) {
      const summaries = new Map((await readSummaries(home)).map((row) => [row.conversation_id, row]))
      for (const item of scanned) {
        const meta = summaries.get(item.id)
        out.push({ ...item, title: meta?.title || item.id, preview: meta?.preview ?? "", steps: meta?.step_count ?? 0 })
      }
    }
  }
  return out
}

function findSession(sessions, id, from) {
  const exact = sessions.filter((s) => s.id === id && (!from || s.harness === from))
  if (exact.length === 1) return exact[0]
  if (!exact.length) {
    const prefix = sessions.filter((s) => s.id.startsWith(id) && (!from || s.harness === from))
    if (prefix.length === 1) return prefix[0]
    if (!prefix.length) throw new Error(`No ${from ?? ""} session ${JSON.stringify(id)} found; run --list first.`.trim())
    throw new Error(`Prefix ${JSON.stringify(id)} matches ${prefix.length} sessions; use the full id.`)
  }
  throw new Error(`Session id ${JSON.stringify(id)} exists in both harnesses; pass --from.`)
}

function readTurns(session, home) {
  void home
  if (session.harness === "claude") return { ...readClaudeSession(session.file), harness: "claude", sourceId: session.id }
  return { ...readAntigravitySession(session.file), harness: "antigravity", sourceId: session.id }
}

const fmtDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?")

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) {
    const sessions = await listAll(options.home, options)
    if (options.json) return void console.log(JSON.stringify(sessions, null, 2))
    if (!sessions.length) {
      const hint = [
        !want(options, "antigravity") || options.from ? "" : ` (looked in ${antigravityDir(options.home)})`,
        !want(options, "claude") || options.from ? "" : ` (looked in ${claudeDir(options.home)})`,
      ].join("")
      return void console.log(`No foreign sessions found${hint}.`)
    }
    for (const s of sessions)
      console.log(`${s.harness.padEnd(11)} ${s.id}  ${s.userTurns}u/${s.assistantTurns}a  ${fmtDate(s.lastTime ?? s.mtimeMs)}  ${(s.title ?? "").slice(0, 60)}`)
    return
  }
  if (options.read) {
    const session = findSession(await listAll(options.home, options), options.read, options.from)
    const { turns } = readTurns(session, options.home)
    console.log(`${session.harness} ${session.id} (${turns.length} turns)`)
    for (const turn of turns.slice(0, 40)) console.log(`\n[${turn.role}]${turn.model ? ` (${turn.model})` : ""}\n${turn.text.slice(0, 1200)}`)
    if (turns.length > 40) console.log(`\n… (${turns.length - 40} more turns)`)
    return
  }
  if (options.import) {
    if (!options.upstream) throw new Error(`--import needs --upstream URL of infiniteoc serve\n${usage}`)
    const upstream = options.upstream.replace(/\/+$/, "")
    const password = process.env.IOC_IMPORT_PASSWORD ?? process.env.IOC_PROXY_PASSWORD ?? process.env.OPENCODE_PASSWORD ?? ""
    if (!password) throw new Error("Backend password missing (IOC_IMPORT_PASSWORD or OPENCODE_PASSWORD from infiniteoc serve)")
    const session = findSession(await listAll(options.home, options), options.import, options.from)
    const { turns, cwd } = readTurns(session, options.home)
    let directory = options.dir ?? (cwd && existsSync(cwd) && statSync(cwd).isDirectory() ? cwd : process.cwd())
    const payload = toImportPayload(turns, { harness: session.harness, sourceId: session.id, title: options.title, directory })
    payload.location = { directory }
    let response
    try {
      response = await fetch(`${upstream}/api/experimental/session/import`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
        body: JSON.stringify({ info: payload.info, messages: payload.messages, location: payload.location }),
      })
    } catch (error) {
      throw new Error(`Backend did not answer at ${upstream} (${error.cause?.message ?? error.message})`)
    }
    if (response.status === 401) throw new Error("Backend refused the password (401); use the password infiniteoc serve prints")
    if (response.status === 409) throw new Error("Backend already imported this session id (409); import once only")
    if (!response.ok) throw new Error(`Backend answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`)
    const created = (await response.json()).data
    console.log(`Imported ${session.harness} ${session.id} as session ${created.id} (${payload.messages.length} messages).`)
    console.log(`Continue it: open the TUI on ${upstream} and pick "${created.title ?? created.id}" in /sessions.`)
    return
  }
  throw new Error(usage)
}

main().catch((error) => {
  console.error(`[session-import] ${error.message}`)
  process.exit(1)
})
