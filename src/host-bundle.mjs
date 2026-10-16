// `infiniteoc host bundle DIR`: a clean copy of this checkout that only runs the web host. "Clean" means the
// files git tracks or would track (no ignored build trees, keys, packs or local config), so nothing private
// leaks into a deployment. The finished binary rides along, so the copy needs no build, Bun or upstream source.
import { spawnSync } from "node:child_process"
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const HOST = `#!/usr/bin/env node
// This copy of InfiniteOC only runs the web host (made by \`infiniteoc host bundle\`). Settings come from the
// environment: INFINITEOC_HOST_PASSWORD (required, 12+ characters), HOST (default 0.0.0.0), PORT (default
// 8080), INFINITEOC_HOST_CONFIG (an opencode.json with your providers and model), INFINITEOC_HOST_IDLE_MINUTES,
// INFINITEOC_HOST_SECURE_COOKIES=1 behind HTTPS. Nothing is stored outside a temporary directory.
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startHost } from "./src/host.mjs"

const home = path.dirname(fileURLToPath(import.meta.url))
const binary = ["opencode", "opencode.exe"].map((name) => path.join(home, "runtime", name)).find((file) => existsSync(file))
if (!binary) throw new Error("runtime/opencode is missing; make the bundle again with infiniteoc host bundle")
const password = process.env.INFINITEOC_HOST_PASSWORD
if (!password || password.length < 12) {
  console.error("Set INFINITEOC_HOST_PASSWORD to a password of 12 or more characters.")
  process.exit(1)
}
const running = await startHost({
  home,
  binary,
  password,
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  config: process.env.INFINITEOC_HOST_CONFIG,
  idleMinutes: Number(process.env.INFINITEOC_HOST_IDLE_MINUTES ?? 30),
  secureCookies: process.env.INFINITEOC_HOST_SECURE_COOKIES === "1",
  log: (line) => console.error(line),
})
console.log(\`InfiniteOC host on \${running.url}\`)
const stop = async () => { await running.close(); process.exit(0) }
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
await running.exited
await running.close()
process.exit(1)
`

const DOCKERFILE = `# The InfiniteOC web host. Projects live in each visitor's browser; the container keeps only temporary files.
#   docker build -t infiniteoc-host .
#   docker run -p 8080:8080 -e INFINITEOC_HOST_PASSWORD=change-me-please infiniteoc-host
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl zip unzip python3 \\
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node
CMD ["node", "host.mjs"]
`

const HOSTING = `# InfiniteOC web host

This folder only runs InfiniteOC as a web app: \`node host.mjs\` (or \`npm start\`, or the Dockerfile). The normal
terminal launcher refuses to run here (see HOST_ONLY).

- **Password**: set \`INFINITEOC_HOST_PASSWORD\` (12+ characters). Everyone with it shares this host.
- **Where projects live**: in each visitor's browser (IndexedDB). Opening a project uploads it to a temporary
  directory here for the agent to work in; changes stream back every few seconds; Download makes a zip in the
  browser. A project a browser has saved is removed from the host after 30 idle minutes
  (\`INFINITEOC_HOST_IDLE_MINUTES\`), and everything here is deleted when the host stops.
- **Models**: \`INFINITEOC_HOST_CONFIG=/path/opencode.json\` brings your providers and default model; without it the
  free OpenCode model is used, and visitors can sign in to a provider with /connect for the life of the host.
- **Confinement**: the backend gets your providers/model merged with a permission lockdown, so the agent can only
  read, edit and run inside this host's temporary directory (plus its bundled skills); anything outside is
  refused. Shell commands are gated by static analysis, which obfuscated commands can dodge, so the password
  still guards real shell access: share it only with people you trust with that.
- **On the internet**: put it behind HTTPS (Caddy, nginx, a tunnel) and set \`INFINITEOC_HOST_SECURE_COOKIES=1\`.
  The agent runs commands on this machine (or container) as its user: give it nothing you would not give the
  people who have the password.
- The included binary is for {TARGET}; make the bundle on the platform you deploy to (or use the Dockerfile on {TARGET}).
`

/** Files git tracks plus untracked ones it does not ignore, relative to `home`. */
function cleanFiles(home) {
  const result = spawnSync("git", ["-C", home, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error("infiniteoc host bundle needs a git checkout of InfiniteOC")
  return result.stdout.split("\0").filter(Boolean)
}

export async function bundleHost({ home, binary, target }) {
  const directory = path.resolve(target)
  const existing = await readdir(directory).catch(() => [])
  if (existing.length) throw new Error(`${directory} is not empty; choose a new folder`)
  if (directory === path.resolve(home) || directory.startsWith(path.resolve(home) + path.sep)) throw new Error("Choose a folder outside this checkout")
  const files = cleanFiles(home)
  for (const file of files) {
    const from = path.join(home, file)
    const to = path.join(directory, file)
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to).catch((error) => { if (error.code !== "ENOENT") throw error })
  }
  await mkdir(path.join(directory, "runtime"), { recursive: true })
  const exe = path.join(directory, "runtime", path.basename(binary).endsWith(".exe") ? "opencode.exe" : "opencode")
  await copyFile(binary, exe)
  await chmod(exe, 0o755).catch(() => {})
  await writeFile(path.join(directory, "host.mjs"), HOST, { mode: 0o755 })
  await writeFile(path.join(directory, "HOST_ONLY"), "This copy only runs the web host: node host.mjs\n")
  await writeFile(path.join(directory, "Dockerfile"), DOCKERFILE)
  await writeFile(path.join(directory, ".dockerignore"), ".git\nnode_modules\n")
  await writeFile(path.join(directory, "HOSTING.md"), HOSTING.replaceAll("{TARGET}", `${process.platform}-${process.arch}`))
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ ...pkg, scripts: { start: "node host.mjs" }, bin: undefined }, null, 2) + "\n")
  return { directory, files: files.length + 5 }
}
