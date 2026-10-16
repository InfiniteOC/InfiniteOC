// Platform helpers shared by the launcher, daemon, installer and release scripts.
// Windows works without administrator: every path is user-local, no service is
// registered, no machine-wide PATH or firewall rule is touched.
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

export const isWindows = process.platform === "win32"

/** process.platform-process.arch, e.g. linux-x64 or win32-arm64. */
export const buildTarget = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

/** Platforms InfiniteOC builds and runs on. No administrator is needed on any of them. */
export const SUPPORTED_TARGETS = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "win32-x64",
  "win32-arm64",
]

export const isSupportedTarget = (target = buildTarget()) => SUPPORTED_TARGETS.includes(target)

/**
 * Upstream `script/build.ts --single` names its output directory cli-<os>-<arch>
 * with win32 spelled `windows` (opencode-windows-x64, not opencode-win32-x64).
 */
export function upstreamDistName(target = buildTarget()) {
  const [os, ...rest] = target.split("-")
  return `cli-${os === "win32" ? "windows" : os}-${rest.join("-")}`
}

/** Binary file name inside the dist directory (opencode.exe on Windows). */
export const binaryName = (platform = process.platform) => (platform === "win32" ? "opencode.exe" : "opencode")

/**
 * Absolute path of the built InfiniteOC binary for `home`. On Windows both
 * `opencode.exe` and a bare `opencode` are accepted (Bun's outfile handling
 * differs by version), exe first.
 */
export function binaryPath(home, target = buildTarget()) {
  return path.join(home, ".runtime/opencode/packages/cli/dist", upstreamDistName(target), "bin", binaryName())
}

/** All candidate binary paths (exe first on Windows, bare first elsewhere). */
export function binaryCandidates(home, target = buildTarget()) {
  const dir = path.join(home, ".runtime/opencode/packages/cli/dist", upstreamDistName(target), "bin")
  return isWindows || target.startsWith("win32-")
    ? [path.join(dir, "opencode.exe"), path.join(dir, "opencode")]
    : [path.join(dir, "opencode"), path.join(dir, "opencode.exe")]
}

/** Last-good fallback binary candidates (mirrors binaryCandidates). */
export function lastGoodCandidates(home) {
  const dir = path.join(home, ".runtime/last-good")
  return isWindows
    ? [path.join(dir, "opencode.exe"), path.join(dir, "opencode")]
    : [path.join(dir, "opencode"), path.join(dir, "opencode.exe")]
}

/**
 * Bun installed by bootstrap() under .tools. On Windows npm's .bin/bun is a sh
 * script and bun.cmd needs a shell (Node refuses to spawn .cmd without one), so
 * the real executable the bun package ships, bin/bun.exe, comes first there.
 */
export function bunCandidates(home, platform = process.platform) {
  const exe = path.join(home, ".tools/node_modules/bun/bin/bun.exe")
  const bin = path.join(home, ".tools/node_modules/.bin/bun")
  return platform === "win32" ? [exe] : [bin, exe]
}

/**
 * argv for running npm. Windows has only npm.cmd, which Node will not spawn
 * without a shell (that would mangle paths with spaces), so run npm's own
 * npm-cli.js with this node instead.
 */
export function npmCommand(args, platform = process.platform, execPath = process.execPath) {
  if (platform !== "win32") return ["npm", args]
  return [execPath, [path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"), ...args]]
}

/** Prepend `dir` to a PATH value using the OS delimiter (; on Windows). */
export const prependPath = (dir, envPath = "") => (envPath ? `${dir}${path.delimiter}${envPath}` : dir)

/** User-local install directory. Never a system path, never needs elevation. */
export function defaultInstallDir(env = process.env) {
  if (env.INFINITEOC_DIR) return env.INFINITEOC_DIR
  if (isWindows) return path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "InfiniteOC")
  return path.join(homedir(), ".infiniteoc")
}

/**
 * Where command shims go. Posix: ~/.local/bin. Windows: a user-local bin
 * directory (no admin); the installer adds it to the *user* PATH, never the
 * machine PATH. No symlinks are used on Windows (they need elevation or
 * Developer Mode): .cmd shims instead.
 */
export function defaultBinDir(env = process.env) {
  if (env.INFINITEOC_BIN) return env.INFINITEOC_BIN
  if (isWindows) return path.join(defaultInstallDir(env), "bin")
  return path.join(homedir(), ".local", "bin")
}

// --- OpenCode config/data directories (wizard, bench, crash log tail) ---
// OpenCode uses the XDG layout under the home directory on every OS, Windows
// included (upstream packages/util/src/global-roots.ts), never APPDATA.

export const opencodeConfigDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode")
export const opencodeDataDir = (env = process.env) => path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode")

// --- opendaemon transport ---
// Posix: a same-user Unix socket under .opendaemon (mode 600/700).
// Windows: Unix sockets are not reliable there, so a same-user named pipe
// `\\?\pipe\infiniteoc-<16 hex of sha256(base)>` is used instead. Pipes live
// in their own namespace (no file to clean up) and need no elevation.

export function daemonPipeName(base) {
  const hash = createHash("sha256").update(path.resolve(base)).digest("hex").slice(0, 16)
  return `\\\\?\\pipe\\infiniteoc-${hash}`
}

export function daemonPaths(base) {
  const directory = path.join(base, ".opendaemon")
  if (isWindows) return { directory, socket: daemonPipeName(base), manifest: path.join(directory, "live.json"), pipe: true }
  return { directory, socket: path.join(directory, "control.sock"), manifest: path.join(directory, "live.json"), pipe: false }
}

/**
 * Unix socket length limit (sun_path). Measured: macOS 104 bytes, Linux 107.
 * Windows named pipes have no such tight limit; null there.
 */
export const socketLimit = isWindows ? null : process.platform === "darwin" ? 104 : 107

export function checkSocket(socket) {
  if (socketLimit === null) return
  const length = Buffer.byteLength(socket)
  if (length > socketLimit)
    throw new Error(
      `opendaemon socket path is ${length} bytes; this OS allows ${socketLimit}. Move InfiniteOC to a shorter directory`,
    )
}

/** True for an absolute path on this OS (C:\, \\share, /). */
export const isAbsolutePath = (value) => {
  if (typeof value !== "string" || !value) return false
  if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return true
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")
}

/** Split a path that may use either separator (repos cloned on another OS). */
export const splitToolsPath = (value) => value.split(/[\\/]\.tools[\\/]/)

// --- browser ---

/**
 * Command that opens a URL on this OS. Windows uses `cmd /c start` (see
 * openBrowserArgs); callers that just need "can open" treat any string as yes.
 */
export function browserCommand(platform = process.platform, env = process.env) {
  if (platform === "darwin") return "open"
  if (platform === "win32") return "cmd"
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) return "xdg-open"
  return undefined
}

/** argv for browserCommand: `cmd /c start "" <url>` on Windows. */
export function browserArgs(command, url) {
  if (command === "cmd") return ["/c", "start", "", url]
  return [url]
}

/**
 * True when running elevated (root on posix). InfiniteOC never needs it:
 * callers warn and continue with user-local paths instead of failing.
 */
export function isElevated(env = process.env) {
  if (typeof process.getuid === "function") {
    try {
      if (process.getuid() === 0 && !env.INFINITEOC_ALLOW_ROOT) return true
    } catch {}
  }
  return false
}
