// Project export: archives a project directory and serves it as a one-click
// download. This module is plain Node.js: it is copied into the built binary's
// plugin tree by src/export-tool.mjs and runs there, and its logic is unit
// tested directly. The download server listens on loopback only, hands out
// single-use random tokens, and shuts down when nothing is pending.
import http from "node:http"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdtemp, readdir, readFile, lstat, stat, unlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export const FORMATS = ["zip", "tar.gz"]
// Excluded from every export: version control and reinstallable dependencies.
export const EXCLUDED = new Set([".git", "node_modules"])
// Refuse absurd exports before archiving: 100k files or 512 MiB of inputs.
export const MAX_FILES = 100_000
export const MAX_BYTES = 512 * 1024 * 1024
// A download link works once and dies after 10 minutes.
export const LINK_TTL_MS = 10 * 60_000

const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    let stderr = ""
    child.stderr?.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)))
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Object.assign(new Error(`${command} failed`), { stderr })),
    )
  })

const commandAvailable = async (command) => {
  const bin = process.platform === "win32" && command === "tar" ? "tar.exe" : command
  // zip -v and tar --version both exit 0 and change nothing.
  const args = command === "zip" ? ["-v"] : ["--version"]
  try {
    await run(bin, args, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** Walk `directory` (never following symlinks) and total excluded-filtered inputs. */
export async function measure(directory, { maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
  const root = path.resolve(directory)
  let files = 0
  let bytes = 0
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(file)
      else {
        // lstat: a symlink counts its link, never its target (no outside content leaks in).
        const info = await lstat(file).catch(() => undefined)
        if (!info || (!info.isFile() && !info.isSymbolicLink())) continue
        files++
        bytes += info.size
        if (files > maxFiles) throw new Error(`Too many files to export (${files}); narrow the directory`)
        if (bytes > maxBytes) throw new Error(`Too large to export (${bytes} bytes); narrow the directory`)
      }
    }
  }
  await visit(root)
  return { files, bytes }
}

/**
 * Archive `directory` into a temp file. Returns { file, filename, bytes, sha256, format }.
 * `format` is honored when its archiver exists, else the other format is used and reported.
 */
export async function archive(directory, format = "zip", options = {}) {
  if (!FORMATS.includes(format)) throw new Error(`format must be ${FORMATS.join(" or ")}`)
  const root = path.resolve(directory)
  if ((await stat(root).catch(() => undefined))?.isDirectory() !== true)
    throw new Error(`${directory} is not a directory`)
  await measure(root, options)
  const zipOk = await commandAvailable("zip")
  const tarBin = process.platform === "win32" ? "tar.exe" : "tar"
  const tarOk = await commandAvailable("tar")
  if (format === "zip" && !zipOk) format = "tar.gz"
  if (format === "tar.gz" && !tarOk) throw new Error("tar not found; install tar to export projects")
  if (format === "zip" && !zipOk) throw new Error("zip not found; use format tar.gz")
  const outDir = await mkdtemp(path.join(tmpdir(), "infiniteoc-export-"))
  const base = path.basename(root) || "project"
  const filename = `${base}.${format === "zip" ? "zip" : "tar.gz"}`
  const file = path.join(outDir, filename)
  try {
    if (format === "zip") {
      await run("zip", ["-qr", "-X", file, ".", "-x", "*/.git/*", ".git/*", "*/node_modules/*", "node_modules/*"], { cwd: root })
    } else {
      await run(tarBin, ["-czf", file, "--exclude=.git", "--exclude=node_modules", "-C", root, "."], {})
    }
  } catch (error) {
    await rm(outDir, { recursive: true, force: true })
    throw new Error(`Could not archive ${root}: ${(error.stderr ?? error.message).trim().split("\n").at(-1)}`)
  }
  const bytes = (await stat(file)).size
  const sha256 = createHash("sha256").update(await readFile(file)).digest("hex")
  return { file, filename, bytes, sha256, format }
}

// --- one-click download server (loopback only, single-use tokens) ---

const pending = new Map()
let server

// Closing is left to the timers: a sweep inside a request would shut the
// server mid-flight and turn a used link's 404 into a refused connection.
const sweep = ({ close = true } = {}) => {
  const now = Date.now()
  for (const [token, entry] of pending) {
    if (entry.used || entry.expiresAt <= now) {
      pending.delete(token)
      unlink(entry.file).catch(() => {})
      rm(path.dirname(entry.file), { recursive: true, force: true }).catch(() => {})
    }
  }
  if (close && !pending.size && server) {
    server.close()
    server = undefined
  }
}

const later = (ms, task) => {
  const timer = setTimeout(task, ms)
  timer.unref?.()
  return timer
}

export function ensureServer() {
  sweep({ close: false })
  if (server) return server
  server = http.createServer(async (request, response) => {
    try {
      sweep({ close: false })
      const match = /^GET \/download\/([0-9a-f]{64})$/.exec(`${request.method} ${request.url ?? ""}`)
      const entry = match ? pending.get(match[1]) : undefined
      if (!entry || entry.used || entry.expiresAt <= Date.now()) {
        response.writeHead(404, { "Content-Type": "text/plain" })
        response.end("Not found")
        return
      }
      entry.used = true
      const info = await stat(entry.file).catch(() => undefined)
      if (!info) {
        response.writeHead(404, { "Content-Type": "text/plain" })
        response.end("Not found")
        return
      }
      response.writeHead(200, {
        "Content-Type": entry.format === "zip" ? "application/zip" : "application/gzip",
        "Content-Length": info.size,
        "Content-Disposition": `attachment; filename="${entry.filename.replace(/["\r\n]/g, "")}"`,
        "Cache-Control": "no-store",
      })
      createReadStream(entry.file).on("error", () => response.destroy()).pipe(response)
      response.on("close", () => later(1000, sweep))
    } catch {
      try {
        response.writeHead(500, { "Content-Type": "text/plain" })
        response.end("Export failed")
      } catch {}
    }
  })
  return server
}

/**
 * Archive `directory` and publish a one-click download link.
 * Returns { url, filename, bytes, sha256, format, expiresInMs }.
 * @param {{ directory: string, format?: string }} input
 * @param {{ maxFiles?: number, maxBytes?: number }} [options]
 */
export async function exportProject({ directory, format = "zip" }, options = {}) {
  const built = await archive(directory, format, options)
  const token = randomBytes(32).toString("hex")
  pending.set(token, { ...built, used: false, expiresAt: Date.now() + LINK_TTL_MS })
  const app = ensureServer()
  if (!app.listening) await new Promise((resolve, reject) => {
    app.once("error", reject)
    // Loopback only: the link never leaves this machine.
    app.listen(0, "127.0.0.1", resolve)
  })
  later(LINK_TTL_MS + 1000, sweep)
  const { port } = app.address()
  return {
    url: `http://127.0.0.1:${port}/download/${token}`,
    filename: built.filename,
    bytes: built.bytes,
    sha256: built.sha256,
    format: built.format,
    expiresInMs: LINK_TTL_MS,
  }
}

/** Test hook: drop every pending export and close the server. */
export async function resetExports() {
  for (const token of [...pending.keys()]) {
    pending.delete(token)
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve))
    server = undefined
  }
}

export const __test = { pending, sweep }
