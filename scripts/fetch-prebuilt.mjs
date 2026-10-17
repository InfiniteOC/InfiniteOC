#!/usr/bin/env node
// Downloads a prebuilt InfiniteOC binary for this checkout's release tag.
// Usage: node scripts/fetch-prebuilt.mjs <target> [--tag vX.Y.Z]
// Exits 0 after installing .runtime/build.json and the dist binary, non-zero
// when no prebuilt binary is available (the installer then builds from source).
// Never needs administrator: everything lands inside the checkout.
import { spawnSync } from "node:child_process"
import { mkdir, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const home = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const repoUrl = process.env.INFINITEOC_REPO ?? "https://github.com/InfiniteOC/InfiniteOC.git"
const slug = repoUrl
  .replace(/\.git$/, "")
  .replace(/^git@github\.com:/, "https://github.com/")
  .replace(/^https?:\/\/github\.com\//, "")
const args = process.argv.slice(2)
const target = args.find((arg) => !arg.startsWith("--"))
const tagFlag = args.indexOf("--tag")
const tag = tagFlag >= 0 ? args[tagFlag + 1] : process.env.INFINITEOC_VERSION
if (!target) {
  console.error("[InfiniteOC] fetch-prebuilt: usage: fetch-prebuilt.mjs <target> [--tag TAG]")
  process.exit(2)
}
const url =
  process.env.INFINITEOC_PREBUILT_URL ??
  (tag
    ? `https://github.com/${slug}/releases/download/${tag}/infiniteoc-${target}.zip`
    : `https://github.com/${slug}/releases/latest/download/infiniteoc-${target}.zip`)

// The repository is private, so a release asset needs credentials. The GitHub
// CLI carries them (gh auth login); GH_TOKEN/GITHUB_TOKEN work through gh and
// as a bearer header for the raw fetch/curl fallbacks.
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const run = (command, argv) => {
  const result = spawnSync(command, argv, { encoding: "utf8" })
  return result.status === 0
}
const tmp = await import("node:fs/promises").then((fs) => fs.mkdtemp(path.join(tmpdir(), "infiniteoc-prebuilt-")))
try {
  let zip = path.join(tmp, "prebuilt.zip")
  let downloaded = false
  if (!process.env.INFINITEOC_PREBUILT_URL && /^https:\/\/github\.com\//.test(url) && run("gh", ["--version"])) {
    const ghArgs = ["release", "download"]
    if (tag) ghArgs.push(tag)
    ghArgs.push("--repo", slug, "--pattern", `infiniteoc-${target}.zip`, "--dir", tmp, "--clobber")
    if (run("gh", ghArgs)) {
      zip = path.join(tmp, `infiniteoc-${target}.zip`)
      downloaded = true
    } else {
      console.error("[InfiniteOC] fetch-prebuilt: gh release download found no asset")
    }
  }
  if (!downloaded && typeof fetch === "function") {
    try {
      const response = await fetch(url, { redirect: "follow", headers: token ? { Authorization: `Bearer ${token}` } : undefined })
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer())
        await import("node:fs/promises").then((fs) => fs.writeFile(zip, buffer))
        downloaded = true
      } else {
        console.error(`[InfiniteOC] fetch-prebuilt: ${url} answered ${response.status}`)
      }
    } catch (error) {
      console.error(`[InfiniteOC] fetch-prebuilt: download failed: ${error.message}`)
    }
  }
  if (!downloaded) {
    // curl is present with Git for Windows and on most posix systems.
    const curlArgs = ["-fsSL", "-o", zip]
    if (token) curlArgs.push("-H", `Authorization: Bearer ${token}`)
    curlArgs.push(url)
    if (run("curl", curlArgs)) downloaded = true
    else console.error("[InfiniteOC] fetch-prebuilt: download failed (no network or no release asset yet)")
  }
  if (!downloaded) process.exit(1)
  const out = path.join(tmp, "out")
  await mkdir(out, { recursive: true })
  const extracted =
    run("unzip", ["-q", "-o", zip, "-d", out]) ||
    // Windows 10+ ships bsdtar, which reads zip archives.
    (process.platform === "win32" && run("tar.exe", ["-xf", zip, "-C", out])) ||
    (process.platform === "win32" && run("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force '${zip}' '${out}'`]))
  if (!extracted) {
    console.error("[InfiniteOC] fetch-prebuilt: could not extract the archive (unzip missing?)")
    process.exit(1)
  }
  const manifest = JSON.parse(await readFile(path.join(out, "build.json"), "utf8"))
  const distName = `cli-${target.startsWith("win32-") ? target.replace("win32", "windows") : target}`
  const exe = target.startsWith("win32-") ? "opencode.exe" : "opencode"
  const destDir = path.join(home, ".runtime/opencode/packages/cli/dist", distName, "bin")
  await mkdir(destDir, { recursive: true })
  const { copyFile, rm: remove } = await import("node:fs/promises")
  const binarySource = path.join(out, target.startsWith("win32-") ? "opencode.exe" : "opencode")
  const binaryDest = path.join(destDir, exe)
  // Remove first: overwriting a running executable fails with ETXTBSY on Linux.
  await remove(binaryDest, { force: true })
  await copyFile(binarySource, binaryDest)
  if (process.platform !== "win32") await import("node:fs/promises").then((fs) => fs.chmod(path.join(destDir, exe), 0o755))
  await copyFile(path.join(out, "build.json"), path.join(home, ".runtime/build.json"))
  console.error(`[InfiniteOC] fetch-prebuilt: installed ${target} build from ${manifest.builtAt ?? "release"}`)
} finally {
  await rm(tmp, { recursive: true, force: true })
}
