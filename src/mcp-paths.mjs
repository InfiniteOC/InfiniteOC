// MCP server commands in opencode.json that point at files. The repo config uses {env:INFINITEOC_HOME}, which the
// launcher exports; older copies hardcoded $HOME/InfiniteOC/.tools, which only exists for one checkout location.
import { readFile, writeFile, access } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const exists = (path) => access(path).then(() => true, () => false)
export const expand = (value, home) => value.replaceAll("{env:INFINITEOC_HOME}", home).replace(/^\$HOME(?=\/)|^~(?=\/)/, homedir()).replaceAll("${HOME}", homedir())

/** [{ server, raw, path }] for every absolute path argument that does not exist. */
export async function missingPaths(config, home) {
  const servers = { ...config?.mcp?.servers, ...Object.fromEntries(Object.entries(config?.mcp ?? {}).filter(([name, value]) => name !== "servers" && Array.isArray(value?.command))) }
  const found = []
  for (const [server, value] of Object.entries(servers))
    for (const raw of Array.isArray(value?.command) ? value.command : []) {
      const path = typeof raw === "string" ? expand(raw, home) : ""
      if (path.startsWith("/") && !await exists(path)) found.push({ server, raw, path })
    }
  return found
}

/** Rewrites paths that live under a .tools directory somewhere else to this install's, when the file exists there. Returns the count. */
export async function repairPaths(file, home) {
  let text, config
  try { text = await readFile(file, "utf8"); config = JSON.parse(text) } catch { return 0 }
  let fixed = 0
  for (const { raw, path } of await missingPaths(config, home)) {
    const rest = path.split("/.tools/")[1]
    if (!rest || !await exists(join(home, ".tools", rest))) continue
    text = text.replaceAll(JSON.stringify(raw), JSON.stringify(`{env:INFINITEOC_HOME}/.tools/${rest}`))
    fixed++
  }
  if (fixed) {
    await writeFile(`${file}.${Date.now()}.bak`, await readFile(file, "utf8"), { mode: 0o600 })
    await writeFile(file, text)
  }
  return fixed
}
