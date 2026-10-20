// Builds the Go TUI from .tui/ into <home>/.runtime/infinitui/ when its sources changed.
// The sources live in a dot-directory so the launcher fingerprint (which skips dotfiles) does not
// rebuild OpenCode for a TUI-only change.
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { loadSettings, settingsFile } from "../infiniteoc/settings/settings-store.mjs"

const run = promisify(execFile)

// Subcommands that never open the interactive UI (upstream `opencode --help`).
const subcommands = new Set(["upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats", "mini", "run", "session", "service", "reload", "pair", "serve", "web", "completion"])

export async function wantsInfinitui(context) {
  const mode = context.env.INFINITEOC_TUI
  if (mode === "classic") return false
  const first = context.args.find((arg) => !arg.startsWith("-"))
  if (first && subcommands.has(first)) return false
  if (context.args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) return false
  if (mode === "infinitui") return true
  try {
    const settings = await loadSettings(settingsFile(context.env))
    return settings.tui !== "classic"
  } catch {
    return true
  }
}

async function digest(dir, hash, base = dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "testdata") await digest(file, hash, base)
    } else if (/\.go$|^go\.(mod|sum)$/.test(entry.name) && !entry.name.endsWith("_test.go")) {
      hash.update(path.relative(base, file)).update(await readFile(file))
    }
  }
}

export function binaryName(platform = process.platform) {
  return platform === "win32" ? "infinitui.exe" : "infinitui"
}

export async function ensureBuilt({ modDir, home, env = process.env, go = env.INFINITUI_GO || "go" }) {
  // go build runs inside the source tree, so every path must be absolute.
  modDir = path.resolve(modDir)
  home = path.resolve(home)
  const source = path.join(modDir, ".tui")
  const outDir = path.join(home, ".runtime", "infinitui")
  const binary = path.join(outDir, binaryName())
  const stampFile = path.join(outDir, "stamp")
  const hash = createHash("sha256")
  await digest(source, hash)
  const key = hash.digest("hex")
  const fresh = await Promise.all([readFile(stampFile, "utf8").catch(() => ""), stat(binary).then(() => true, () => false)])
  if (fresh[0].trim() === key && fresh[1]) return binary

  await mkdir(outDir, { recursive: true })
  const tmp = `${binary}.${process.pid}.tmp`
  process.stderr.write("Building InfiniTUI...\n")
  try {
    await run(go, ["build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w", "-o", tmp, "./cmd/infinitui"], {
      cwd: source,
      env: { ...env, CGO_ENABLED: "0" },
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Go is not installed (https://go.dev/dl)")
    const detail = String(error.stderr || error.message).trim().split("\n").slice(-3).join(" ")
    throw new Error(`go build failed: ${detail}`)
  }
  await rename(tmp, binary)
  await writeFile(stampFile, key + "\n")
  return binary
}
