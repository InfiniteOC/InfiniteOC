// Mod packs: third-party mods installed from a git URL into packs/<id>, pinned by commit and by a sha256 of the
// files. The pin is checked when installing and again at every launch, so a pack that changed on disk does not load.
// State lives in infiniteoc.packs.json (local, git-ignored) so installing never dirties the tracked infiniteoc.json.
import { spawn } from "node:child_process"
import { readFile, writeFile, readdir, rm, rename, mkdir, access } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join, resolve, sep } from "node:path"
import { loadMods } from "./mod-loader.mjs"

export const PACKS_FILE = "infiniteoc.packs.json"
const URL_OK = /^(https:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/|\/)/
const ID_OK = /^[a-z0-9][a-z0-9._-]*$/i

const git = (args, cwd) => new Promise((done, fail) => {
  const child = spawn("git", ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=always", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  let out = "", err = ""
  child.stdout.on("data", (chunk) => (out += chunk))
  child.stderr.on("data", (chunk) => (err += chunk))
  child.on("error", (error) => fail(error.code === "ENOENT" ? new Error("git not found on PATH") : error))
  child.on("close", (code) => (code === 0 ? done(out.trim()) : fail(new Error(`git ${args[0]} failed: ${err.trim().split("\n").at(-1) || `exit ${code}`}`))))
})

export const readPacks = (home) => readFile(join(home, PACKS_FILE), "utf8").then(JSON.parse, (error) => (error.code === "ENOENT" ? {} : Promise.reject(new Error(`${PACKS_FILE}: ${error.message}`))))
const writePacks = (home, packs) => writeFile(join(home, PACKS_FILE), JSON.stringify(packs, null, 2) + "\n")
const entry = (id) => `./packs/${id}/index.mjs`

/** sha256 over every file's relative path and bytes, sorted; .git is not part of a pack. */
export async function treeDigest(directory, hash = createHash("sha256"), prefix = "") {
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (item.name === ".git") continue
    const path = join(directory, item.name)
    if (item.isDirectory()) await treeDigest(path, hash, `${prefix}${item.name}/`)
    else if (item.isFile()) hash.update(`${prefix}${item.name}\0`).update(await readFile(path)).update("\0")
  }
  return hash.digest("hex")
}

/** Config entries for the installed packs whose files still match their pin; the rest are named in `skipped`. */
export async function packEntries(home) {
  const entries = [], skipped = []
  for (const [id, pin] of Object.entries(await readPacks(home))) {
    const directory = join(home, "packs", id)
    try {
      if (await treeDigest(directory) !== pin.sha256) throw new Error("files changed since install")
      entries.push(entry(id))
    } catch (error) { skipped.push(`${id}: ${error.code === "ENOENT" ? "directory missing" : error.message}`) }
  }
  return { entries, skipped }
}

/**
 * Installs a pack. `confirm(summary)` is asked when the pin is not fully given on the command line; without it
 * (no terminal) both --commit and --sha256 are required. Returns { id, commit, sha256 }.
 */
export async function addPack({ home, url, commit, sha256, confirm, existing = [] }) {
  if (!URL_OK.test(url ?? "") || url.startsWith("-")) throw new Error("Pack URL must be https://, ssh://, git@host:path, file:// or an absolute path")
  if (commit && !/^[0-9a-f]{40}$/i.test(commit)) throw new Error("--commit must be the full 40 character commit hash")
  if (sha256 && !/^[0-9a-f]{64}$/i.test(sha256)) throw new Error("--sha256 must be a 64 character hex digest")
  const pinned = commit && sha256
  if (!pinned && !confirm) throw new Error("Pass --commit and --sha256 (run once on a terminal to see them) to install without a prompt")
  await mkdir(join(home, "packs"), { recursive: true })
  const staging = join(home, "packs", `.staging-${randomUUID()}`)
  try {
    await git(["clone", "--quiet", "--no-checkout", "--", url, staging])
    await git(["checkout", "--quiet", "--detach", commit ?? "HEAD"], staging)
    const resolved = await git(["rev-parse", "HEAD"], staging)
    if (commit && resolved.toLowerCase() !== commit.toLowerCase()) throw new Error(`Pinned commit ${commit} is not what ${url} resolves to`)
    await rm(join(staging, ".git"), { recursive: true, force: true })
    const digest = await treeDigest(staging)
    if (sha256 && digest !== sha256.toLowerCase()) throw new Error(`sha256 mismatch: the files at ${resolved} hash to ${digest}, not ${sha256}`)
    if (!pinned && !await confirm({ url, commit: resolved, sha256: digest })) throw new Error("Not installed")
    await access(join(staging, "index.mjs")).catch(() => { throw new Error("A pack needs an index.mjs at its root exporting a mod") })
    // Only now is the pack's code loaded: it has matched its pin or been approved by name.
    const [mod] = await loadMods([join(staging, "index.mjs")], home)
    if (!ID_OK.test(mod.id)) throw new Error(`Invalid mod id ${mod.id}`)
    const packs = await readPacks(home)
    if (packs[mod.id] || existing.includes(mod.id)) throw new Error(`A mod named ${mod.id} is already installed`)
    await rename(staging, join(home, "packs", mod.id))
    await writePacks(home, { ...packs, [mod.id]: { url, commit: resolved, sha256: digest } })
    return { id: mod.id, commit: resolved, sha256: digest }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

export async function removePack(home, id) {
  const packs = await readPacks(home)
  if (!packs[id] || !ID_OK.test(id)) throw new Error(`No installed pack named ${id}`)
  const directory = resolve(home, "packs", id)
  if (!directory.startsWith(resolve(home, "packs") + sep)) throw new Error("Refusing to remove outside packs/")
  const { [id]: _, ...rest } = packs
  await writePacks(home, rest)
  await rm(directory, { recursive: true, force: true })
}
