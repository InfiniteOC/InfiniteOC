// Build reuse for prepare(): the generated tree is synced instead of recopied (node_modules survive, so
// `bun install` is a no-op), and the web UI archive — a vite build plus brotli quality 11 over ~90 MB,
// about 85 s of a 115 s build — is reused whole when its inputs are unchanged, and per file otherwise.
// Every reuse is keyed on content: the source tree and the web archive are byte-for-byte what a clean build makes.
import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, utimes } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"

// Small worker pool: a first sync copies ~8,500 files, and unbounded parallel copies can run out of descriptors.
async function each(items, limit, task) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++])
  }))
}

// Copies keep the source's mtime (to about a millisecond: utimes goes through a float), so size + mtime + mode
// identify an unchanged file. A mod's write gets the current time, far outside that tolerance.
const sameFile = (a, b) => b.isFile() && a.size === b.size && a.mode === b.mode && Math.abs(a.mtimeMs - b.mtimeMs) < 2

/**
 * Makes `to` an exact mirror of `from` (minus .git and node_modules) without touching unchanged files:
 * files a mod patched or wrote are restored, files from earlier mods or builds are removed, and every
 * node_modules directory in `to` is kept. Copies are reflinks where the filesystem supports them.
 * Returns how many entries were copied and removed.
 */
export async function syncTree(from, to) {
  const counts = { copied: 0, removed: 0 }
  const files = []
  async function walk(rel) {
    const source = join(from, rel)
    const dest = join(to, rel)
    const [entries, existing] = await Promise.all([
      readdir(source, { withFileTypes: true }),
      readdir(dest, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error }),
    ])
    const wanted = new Map(entries.filter(entry => entry.name !== ".git" && entry.name !== "node_modules").map(entry => [entry.name, entry]))
    for (const entry of existing) {
      const kind = wanted.get(entry.name)
      if (entry.name === "node_modules") continue
      if (kind && kind.isDirectory() === entry.isDirectory() && kind.isSymbolicLink() === entry.isSymbolicLink()) continue
      await rm(join(dest, entry.name), { recursive: true, force: true })
      counts.removed++
    }
    await mkdir(dest, { recursive: true })
    for (const entry of wanted.values()) {
      if (entry.isDirectory()) await walk(join(rel, entry.name))
      else files.push(join(rel, entry.name))
    }
  }
  await walk("")
  await each(files, 64, async rel => {
    const source = join(from, rel)
    const dest = join(to, rel)
    const [a, b] = await Promise.all([lstat(source), lstat(dest).catch(() => undefined)])
    if (a.isSymbolicLink()) {
      const target = await readlink(source)
      if (b?.isSymbolicLink() && await readlink(dest) === target) return
      if (b) await rm(dest, { force: true })
      await symlink(target, dest)
    } else {
      if (b && sameFile(a, b)) return
      if (b) await rm(dest, { force: true })
      await copyFile(source, dest, constants.COPYFILE_FICLONE)
      await utimes(dest, a.atime, a.mtime)
    }
    counts.copied++
  })
  return counts
}

// Workspace packages the web UI (packages/app) imports, followed through package.json dependencies.
async function webPackages(root) {
  const packages = new Map()
  for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifest = await readFile(join(root, "packages", entry.name, "package.json"), "utf8").then(JSON.parse).catch(() => undefined)
    if (manifest?.name) packages.set(manifest.name, { dir: join("packages", entry.name), manifest })
  }
  const seen = new Set()
  const queue = ["@opencode/app"]
  while (queue.length) {
    const name = queue.pop()
    const pkg = packages.get(name)
    if (!pkg || seen.has(pkg.dir)) continue
    seen.add(pkg.dir)
    const { dependencies, devDependencies, peerDependencies } = pkg.manifest
    queue.push(...Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies }))
  }
  return [...seen]
}

const GENERATED = new Set(["node_modules", "dist", ".cache", ".turbo", ".git"])
async function listFiles(root, rel, out) {
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error })
  for (const entry of entries) {
    if (GENERATED.has(entry.name)) continue
    const path = join(rel, entry.name)
    if (entry.isDirectory()) await listFiles(root, path, out)
    else out.push(path)
  }
  return out
}

/**
 * Content key of everything the embedded web UI is built from: the workspace packages it imports,
 * desktop icons (vite.icons.ts reads them), the archive builder, the lockfile and root config, the
 * bun version and the environment vite and the archive read. Mods that patch only core/tui/server
 * leave it unchanged.
 */
export async function webKey(root, { env = process.env, bun = "" } = {}) {
  const dirs = [...await webPackages(root), "packages/desktop/icons", "packages/cli/script"]
  const files = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "packages/cli/src/app-archive.ts"]
  for (const dir of dirs) await listFiles(root, dir, files)
  const hash = createHash("sha256").update(`infiniteoc-web-1\0${bun}\0`)
  for (const [name, value] of Object.entries(env).sort())
    if (/^(VITE_|SENTRY_|OPENCODE_)/.test(name)) hash.update(`${name}=${value}\0`)
  for (const file of [...new Set(files)].sort()) {
    const body = await readFile(join(root, file)).catch(error => { if (error.code === "ENOENT" || error.code === "EISDIR") return undefined; throw error })
    if (body === undefined) continue
    hash.update(`${file}\0${body.length}\0`).update(body)
  }
  return hash.digest("hex")
}

const ARCHIVE_ANCHOR = "  if (options?.skipBuild) return AppArchive.encode([])\n"
const COMPRESS_ANCHOR = "function compress(body: Buffer) {"
const IMPORT_ANCHOR = 'import { brotliCompress, constants } from "node:zlib"\n'

/**
 * Teaches packages/cli/script/app-assets.ts both reuses: INFINITEOC_APP_ARCHIVE names an earlier archive
 * with the same webKey, INFINITEOC_BROTLI_CACHE a directory of per-file brotli output keyed by content.
 * Returns false (and changes nothing) when upstream no longer has the anchors: builds stay correct, just slower.
 */
export function patchAppAssets(source) {
  if (source.includes("INFINITEOC_BROTLI_CACHE") || [ARCHIVE_ANCHOR, COMPRESS_ANCHOR, IMPORT_ANCHOR].some(anchor => source.split(anchor).length !== 2)) return undefined
  return source
    .replace(IMPORT_ANCHOR, () => `${IMPORT_ANCHOR}import { createHash } from "node:crypto"\nimport { mkdir, rename, utimes } from "node:fs/promises"\n`)
    .replace(ARCHIVE_ANCHOR, () => `${ARCHIVE_ANCHOR}  // InfiniteOC: unchanged web UI inputs reuse the archive an earlier build made (src/build-cache.mjs).
  const kept = process.env.INFINITEOC_APP_ARCHIVE
  if (kept && (await Bun.file(kept).exists())) return new Uint8Array(await Bun.file(kept).arrayBuffer())
`)
    .replace(COMPRESS_ANCHOR, () => `// InfiniteOC: brotli quality 11 is most of the build; a file compressed before reuses its bytes.
async function compress(body: Buffer) {
  const dir = process.env.INFINITEOC_BROTLI_CACHE
  if (!dir) return brotli(body)
  const file = path.join(dir, \`\${createHash("sha256").update(body).digest("hex")}.br\`)
  const hit = Bun.file(file)
  if (await hit.exists()) {
    const now = new Date()
    await utimes(file, now, now)
    return Buffer.from(await hit.arrayBuffer())
  }
  const out = await brotli(body)
  await mkdir(dir, { recursive: true })
  const temp = \`\${file}.\${process.pid}.\${Math.random().toString(36).slice(2)}\`
  await Bun.write(temp, out)
  await rename(temp, file)
  return out
}

function brotli(body: Buffer) {`)
}

export const archivePath = (cacheDir, key) => join(cacheDir, `web-${key}.bin`)

/** Keeps this build's archive for the next one; only the newest `keep` archives stay. */
export async function keepArchive(built, cacheDir, key, keep = 2) {
  await mkdir(cacheDir, { recursive: true })
  const file = archivePath(cacheDir, key)
  const temp = `${file}.${process.pid}`
  await copyFile(built, temp)
  await rename(temp, file)
  const archives = []
  for (const name of await readdir(cacheDir)) if (/^web-[0-9a-f]{64}\.bin$/.test(name)) archives.push({ name, mtime: (await stat(join(cacheDir, name))).mtimeMs })
  for (const { name } of archives.sort((a, b) => b.mtime - a.mtime).slice(keep)) await rm(join(cacheDir, name), { force: true })
}

/** Drops brotli entries this build did not use (hits are touched, misses are new) and other pins' caches. */
export async function pruneBrotli(dir, since) {
  for (const name of await readdir(dirname(dir)))
    if (name.startsWith("brotli-") && name !== basename(dir)) await rm(join(dirname(dir), name), { recursive: true, force: true })
  const names = await readdir(dir).catch(() => [])
  await each(names, 64, async name => {
    const file = join(dir, name)
    const info = await stat(file).catch(() => undefined)
    if (info && info.mtimeMs < since - 1000) await rm(file, { force: true })
  })
}
