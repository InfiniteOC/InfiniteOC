#!/usr/bin/env node
// Packages the finished InfiniteOC build for the current machine into a
// release asset: infiniteoc-<target>.zip containing the built binary and
// .runtime/build.json. The installer (install.sh/install.ps1) downloads this
// asset via scripts/fetch-prebuilt.mjs; when its fingerprint matches the
// checkout, the first launch reuses the binary instead of rebuilding.
// Usage: node scripts/package-release.mjs [--out DIR]
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { binaryCandidates, buildTarget } from "../src/platform.mjs"

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outFlag = process.argv.indexOf("--out")
const outDir = outFlag >= 0 ? path.resolve(process.argv[outFlag + 1] ?? ".") : process.cwd()
const target = buildTarget()
const exe = target.startsWith("win32-")

const firstExisting = async (paths) => {
  for (const file of paths) {
    try {
      await stat(file)
      return file
    } catch {}
  }
  return undefined
}
const binary = await firstExisting(binaryCandidates(home))
if (!binary) {
  console.error(`[InfiniteOC] package-release: no finished build for ${target}; run 'infiniteoc setup' first`)
  process.exit(1)
}
const manifest = JSON.parse(await readFile(path.join(home, ".runtime/build.json"), "utf8"))

const stage = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(tmpdir(), "infiniteoc-release-")))
try {
  await copyFile(binary, path.join(stage, exe ? "opencode.exe" : "opencode"))
  await copyFile(path.join(home, ".runtime/build.json"), path.join(stage, "build.json"))
  // mods/infinitui: ship the Go TUI with the stamp of the sources it was built from.
  const tui = exe ? "infinitui.exe" : "infinitui"
  const files = [exe ? "opencode.exe" : "opencode", "build.json"]
  if (await firstExisting([path.join(home, ".runtime/infinitui", tui)])) {
    await copyFile(path.join(home, ".runtime/infinitui", tui), path.join(stage, tui))
    await copyFile(path.join(home, ".runtime/infinitui/stamp"), path.join(stage, "infinitui.stamp"))
    files.push(tui, "infinitui.stamp")
  }
  await mkdir(outDir, { recursive: true })
  const asset = path.join(outDir, `infiniteoc-${target}.zip`)
  const run = (command, argv) => spawnSync(command, argv, { stdio: "inherit", encoding: "utf8" }).status === 0
  let ok = false
  if (process.platform === "win32") {
    ok = run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Force -Path '${path.join(stage, "*")}' -DestinationPath '${asset}'`,
    ])
  } else {
    ok = run("zip", ["-j", "-q", asset, ...files.map((file) => path.join(stage, file))])
    if (!ok) {
      // zip is not preinstalled everywhere; python3 (with zipfile) usually is.
      ok = run("python3", [
        "-c",
        `import zipfile; z = zipfile.ZipFile(${JSON.stringify(asset)}, "w", zipfile.ZIP_DEFLATED); ${files.map((file) => `z.write(${JSON.stringify(path.join(stage, file))}, ${JSON.stringify(file)}); `).join("")}z.close()`,
      ])
    }
  }
  if (!ok) {
    console.error("[InfiniteOC] package-release: could not create the zip (zip missing on PATH?)")
    process.exit(1)
  }
  console.error(`[InfiniteOC] package-release: ${asset} (${manifest.upstream}, built ${manifest.builtAt})`)
} finally {
  await import("node:fs/promises").then((fs) => fs.rm(stage, { recursive: true, force: true }))
}
