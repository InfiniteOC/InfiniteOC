import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { homedir } from "node:os"
import {
  binaryCandidates,
  binaryName,
  browserArgs,
  browserCommand,
  buildTarget,
  bunCandidates,
  checkSocket,
  daemonPipeName,
  daemonPaths,
  defaultBinDir,
  defaultInstallDir,
  isAbsolutePath,
  isSupportedTarget,
  npmCommand,
  opencodeConfigDir,
  opencodeDataDir,
  prependPath,
  socketLimit,
  splitToolsPath,
  upstreamDistName,
} from "../src/platform.mjs"

test("supported targets include Windows x64/arm64, nothing else new", () => {
  for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"])
    assert.equal(isSupportedTarget(target), true, target)
  for (const target of ["win32-ia32", "linux-ia32", "freebsd-x64", "darwin-arm32"])
    assert.equal(isSupportedTarget(target), false, target)
  assert.equal(isSupportedTarget(buildTarget()), ["linux", "darwin", "win32"].includes(process.platform))
})

test("upstream dist names spell win32 as windows and binaries end in .exe there", () => {
  assert.equal(upstreamDistName("win32-x64"), "cli-windows-x64")
  assert.equal(upstreamDistName("win32-arm64"), "cli-windows-arm64")
  assert.equal(upstreamDistName("linux-x64"), "cli-linux-x64")
  assert.equal(upstreamDistName("darwin-arm64"), "cli-darwin-arm64")
  assert.equal(binaryName("win32"), "opencode.exe")
  assert.equal(binaryName("linux"), "opencode")
  const win = binaryCandidates("/home", "win32-x64")
  assert.ok(win[0].endsWith("opencode.exe") && win.join("/").includes("cli-windows-x64"))
  const lin = binaryCandidates("/home", "linux-x64")
  assert.ok(lin[0].endsWith("/opencode") && lin.join("/").includes("cli-linux-x64"))
})

test("bun resolves to a spawnable executable, never a sh or .cmd shim on Windows", () => {
  assert.deepEqual(bunCandidates("/home", "linux").map((file) => path.basename(file)), ["bun", "bun.exe"])
  const win = bunCandidates("/home", "win32")
  assert.equal(win.length, 1)
  assert.ok(win[0].replaceAll("\\", "/").endsWith(".tools/node_modules/bun/bin/bun.exe"), win[0])
})

test("npm runs through npm-cli.js on Windows, where npm.cmd needs a shell", () => {
  assert.deepEqual(npmCommand(["install"], "linux"), ["npm", ["install"]])
  const [command, args] = npmCommand(["install", "C:/with space"], "win32", "C:/node/node.exe")
  assert.equal(command, "C:/node/node.exe")
  assert.ok(args[0].replaceAll("\\", "/").endsWith("node/node_modules/npm/bin/npm-cli.js"), args[0])
  assert.deepEqual(args.slice(1), ["install", "C:/with space"])
})

test("PATH is joined with the OS delimiter", () => {
  assert.equal(prependPath("/a", "/b"), `/a${path.delimiter}/b`)
  assert.equal(prependPath("/a", ""), "/a")
})

test("install and bin defaults are user-local and overridable", () => {
  const windows = process.platform === "win32"
  const install = windows ? path.join("C:/L", "InfiniteOC") : path.join(homedir(), ".infiniteoc")
  assert.equal(defaultInstallDir({ LOCALAPPDATA: "C:/L" }), install)
  assert.equal(defaultInstallDir({ INFINITEOC_DIR: "/x" }), "/x")
  assert.equal(defaultBinDir({ LOCALAPPDATA: "C:/L" }), windows ? path.join(install, "bin") : path.join(homedir(), ".local", "bin"))
  assert.equal(defaultBinDir({ INFINITEOC_BIN: "/y" }), "/y")
})

test("opencode config/data dirs respect XDG and Windows conventions", () => {
  assert.equal(opencodeConfigDir({ XDG_CONFIG_HOME: "/cfg" }), path.join("/cfg", "opencode"))
  assert.equal(opencodeDataDir({ XDG_DATA_HOME: "/data" }), path.join("/data", "opencode"))
  // OpenCode ignores APPDATA/LOCALAPPDATA on Windows too (upstream global-roots.ts).
  assert.equal(opencodeConfigDir({ APPDATA: "/A" }), path.join(homedir(), ".config", "opencode"))
  assert.equal(opencodeDataDir({ LOCALAPPDATA: "/L" }), path.join(homedir(), ".local", "share", "opencode"))
})

test("daemon transport is a named pipe on Windows", { skip: process.platform !== "win32" }, () => {
  const paths = daemonPaths("C:/base")
  assert.equal(paths.pipe, true)
  assert.equal(paths.socket, daemonPipeName("C:/base"))
  assert.equal(socketLimit, null)
  checkSocket("x".repeat(500))
})

test("daemon transport is a socket file on posix", { skip: process.platform === "win32" }, () => {
  const paths = daemonPaths("/base")
  assert.equal(paths.pipe, false)
  assert.equal(paths.socket, path.join("/base", ".opendaemon/control.sock"))
  assert.ok(socketLimit === 104 || socketLimit === 107)
  checkSocket(paths.socket)
  assert.throws(() => checkSocket("x".repeat((socketLimit ?? 0) + 1)), /socket path/)
})

test("daemon pipe names are stable per install dir and unique across dirs", () => {
  const a = daemonPipeName("/base/one")
  assert.equal(a, daemonPipeName("/base/one"))
  assert.notEqual(a, daemonPipeName("/base/two"))
  assert.match(a, /^\\\\\?\\pipe\\infiniteoc-[0-9a-f]{16}$/)
})

test("absolute path detection covers posix, drive letters and UNC", () => {
  assert.equal(isAbsolutePath("/a/b"), true)
  assert.equal(isAbsolutePath("C:\\Users\\x"), true)
  assert.equal(isAbsolutePath("C:/Users/x"), true)
  assert.equal(isAbsolutePath("\\\\server\\share"), true)
  assert.equal(isAbsolutePath("relative/path"), false)
  assert.equal(isAbsolutePath("{env:INFINITEOC_HOME}/.tools/x"), false)
  assert.equal(isAbsolutePath(""), false)
})

test("tool path splitting works with either separator", () => {
  assert.equal(splitToolsPath("/old/.tools/gimp-mcp")[1], "gimp-mcp")
  assert.equal(splitToolsPath("C:\\old\\.tools\\gimp-mcp")[1], "gimp-mcp")
})

test("browser command covers macOS, Windows and Linux displays", () => {
  assert.equal(browserCommand("darwin", {}), "open")
  assert.equal(browserCommand("win32", {}), "cmd")
  assert.equal(browserCommand("linux", { DISPLAY: ":0" }), "xdg-open")
  assert.equal(browserCommand("linux", {}), undefined)
  assert.deepEqual(browserArgs("cmd", "http://x"), ["/c", "start", "", "http://x"])
  assert.deepEqual(browserArgs("open", "http://x"), ["http://x"])
})
