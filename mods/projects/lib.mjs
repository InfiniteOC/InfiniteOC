// InfiniteOC projects: one folder that InfiniteOC manages, where the agent (tool `project`) and the user
// (`infiniteoc new NAME`) create projects and switch between them. Plain JS with node built-ins only, so the
// launcher can import it on any Node 22: written to packages/core/src/plugin/infiniteoc-projects-lib.mjs by
// mods/projects, and used as is by `infiniteoc new` and the node tests.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const TEMPLATES = ["empty", "node", "python", "web"]

const settingsPath = (env) => env.INFINITEOC_SETTINGS_FILE || path.join(homedir(), ".config/infiniteoc/settings.json")
const expand = (value) => (value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value)

/** INFINITEOC_PROJECTS_DIR, else settings.json projects.root, else ~/infiniteoc-projects. */
export function projectsRoot(env = process.env) {
  if (env.INFINITEOC_PROJECTS_DIR) return path.resolve(expand(env.INFINITEOC_PROJECTS_DIR))
  try {
    const root = JSON.parse(readFileSync(settingsPath(env), "utf8"))?.projects?.root
    if (typeof root === "string" && root.trim()) return path.resolve(expand(root.trim()))
  } catch {}
  return path.join(homedir(), "infiniteoc-projects")
}

/** A folder name from what the user called it: lowercase, digits and hyphens. */
export const slug = (name) =>
  name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)

const GITIGNORE = {
  empty: ".DS_Store\n",
  node: "node_modules/\ndist/\n.env\n.DS_Store\n",
  python: "__pycache__/\n*.pyc\n.venv/\n.env\n.DS_Store\n",
  web: "node_modules/\ndist/\n.DS_Store\n",
}

function files(template, name, title, description) {
  const readme = `# ${title}\n\n${description || "Created with InfiniteOC."}\n`
  const base = { "README.md": readme, ".gitignore": GITIGNORE[template] }
  if (template === "node")
    return { ...base, "package.json": JSON.stringify({ name, version: "0.1.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n" }
  if (template === "python")
    return { ...base, "pyproject.toml": `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.10"\n` }
  if (template === "web")
    return {
      ...base,
      "index.html": `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${title.replace(/[<&]/g, "")}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main></main>\n  <script src="main.js" type="module"></script>\n</body>\n</html>\n`,
      "style.css": ":root { color-scheme: light dark; font-family: system-ui, sans-serif; }\n",
      "main.js": "",
    }
  return base
}

const describe = (dir) => {
  try {
    return readFileSync(path.join(dir, "README.md"), "utf8").split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"))?.slice(0, 160) ?? ""
  } catch {
    return ""
  }
}

/** Projects in the root, most recently changed first. */
export function listProjects(root = projectsRoot()) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const dir = path.join(root, entry.name)
      return { name: entry.name, dir, description: describe(dir), updated: statSync(dir).mtimeMs }
    })
    .sort((a, b) => b.updated - a.updated)
}

/** The project folder for a name (exact folder, then its slug, then a unique prefix); throws with the choices. */
export function findProject(name, root = projectsRoot()) {
  const all = listProjects(root)
  const want = slug(name)
  const found = all.find((item) => item.name === name) ?? all.find((item) => item.name === want) ?? (() => {
    const prefix = all.filter((item) => want && item.name.startsWith(want))
    return prefix.length === 1 ? prefix[0] : undefined
  })()
  if (found) return found
  throw new Error(all.length ? `No project "${name}" in ${root}. Projects: ${all.slice(0, 20).map((item) => item.name).join(", ")}` : `No projects yet in ${root}; create one with action "create".`)
}

/** Creates <root>/<slug(name)> with starter files for the template; never touches an existing folder. */
export function createProject(input, root = projectsRoot()) {
  const name = slug(input.name)
  if (!name) throw new Error("Give the project a name with letters or digits.")
  const template = input.template ?? "empty"
  if (!TEMPLATES.includes(template)) throw new Error(`template must be one of ${TEMPLATES.join(", ")}`)
  const dir = path.join(root, name)
  if (existsSync(dir)) throw new Error(`${dir} already exists; open it with action "open" or pick another name.`)
  mkdirSync(dir, { recursive: true })
  const written = Object.entries(files(template, name, input.name.trim(), (input.description ?? "").trim()))
  for (const [file, text] of written) writeFileSync(path.join(dir, file), text, { flag: "wx" })
  return { name, dir, template, files: written.map(([file]) => file) }
}
