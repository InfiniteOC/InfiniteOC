// Crash reporter: when the TUI dies abnormally the launcher saves what it knows to one file and prints its path.
// Nothing is sent anywhere. Known secret shapes are redacted from the log tail.
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { homedir, platform, arch, release } from "node:os"
import { daemonRequest } from "./daemon-client.mjs"
import { opencodeDataDir } from "./platform.mjs"

// Clean exit, hangup, Ctrl+C and SIGTERM are not crashes. A TUI that exits non-zero by itself is; a one-shot command that does is a user error.
export const isCrash = (code, { tui = false } = {}) => ![0, 129, 130, 143].includes(code) && (code > 128 || tui)

const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:api[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?[^\s"',}]{8,})/gi
export const redact = (text) => text.replace(SECRET, "[redacted]")

/** The newest log files under opencode's log directory, as the last `lines` lines of the newest one. */
export async function logTail(env = process.env, lines = 200) {
  const dir = join(opencodeDataDir(env), "log")
  try {
    const files = await Promise.all((await readdir(dir)).filter((name) => name.endsWith(".log")).map(async (name) => ({ name, mtime: (await stat(join(dir, name))).mtimeMs })))
    const newest = files.sort((a, b) => b.mtime - a.mtime)[0]
    if (!newest) return { file: dir, text: "(no log files)" }
    return { file: join(dir, newest.name), text: redact((await readFile(join(dir, newest.name), "utf8")).split("\n").slice(-lines).join("\n")) }
  } catch { return { file: dir, text: "(log directory unreadable)" } }
}

/** Daemon events of the last minutes, when the daemon answers. */
export async function lastEvents(socket, count = 50) {
  if (!socket) return []
  try { return (await daemonRequest(socket, "GET", "/status", undefined, 1500)).events?.slice(-count) ?? [] } catch { return [] }
}

/** Writes <home>/.runtime/crashes/crash-<time>.log and returns its path. */
export async function writeCrashReport({ home, code, args = [], env = process.env, socket, manifest, startedAt, now = new Date() }) {
  const [log, events] = await Promise.all([logTail(env), lastEvents(socket)])
  const directory = join(home, ".runtime", "crashes")
  await mkdir(directory, { recursive: true })
  const file = join(directory, `crash-${now.toISOString().replace(/[:.]/g, "-")}.log`)
  const report = [
    `InfiniteOC crash report ${now.toISOString()}`,
    `exit code ${code}${code > 128 ? ` (signal ${code - 128})` : ""}, ran ${startedAt ? Math.round((now - startedAt) / 1000) : "?"}s`,
    `platform ${platform()} ${release()} ${arch()}, node ${process.version}`,
    `build ${manifest ? `${manifest.builtAt} upstream ${manifest.upstream} mods ${manifest.mods?.join(",")}` : "unknown"}`,
    `args ${JSON.stringify(args)}`,
    "",
    `--- last daemon events (${events.length}) ---`,
    ...events.map((event) => redact(JSON.stringify(event))),
    "",
    `--- tail of ${log.file} ---`,
    log.text,
    "",
  ].join("\n")
  await writeFile(file, report, { mode: 0o600 })
  return file
}
