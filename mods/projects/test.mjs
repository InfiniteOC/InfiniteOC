import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import * as Projects from "./lib.mjs"
import mod, { guidance } from "./index.mjs"

const repo = path.resolve(import.meta.dirname, "../..")

async function root(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "ioc-projects-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("the projects folder: env, then settings.json projects.root, then ~/infiniteoc-projects", async (t) => {
  const dir = await root(t)
  const settings = path.join(dir, "settings.json")
  assert.equal(Projects.projectsRoot({ INFINITEOC_PROJECTS_DIR: "/x/y", INFINITEOC_SETTINGS_FILE: settings }), path.resolve("/x/y"))
  await writeFile(settings, JSON.stringify({ projects: { root: path.join(dir, "mine") } }))
  assert.equal(Projects.projectsRoot({ INFINITEOC_SETTINGS_FILE: settings }), path.join(dir, "mine"))
  await writeFile(settings, "{ broken")
  assert.match(Projects.projectsRoot({ INFINITEOC_SETTINGS_FILE: settings }), /infiniteoc-projects$/)
})

test("create writes a template into a fresh folder and never touches an existing one", async (t) => {
  const dir = await root(t)
  const made = Projects.createProject({ name: "My Cool Game!", description: "A tiny platformer", template: "web" }, dir)
  assert.equal(made.name, "my-cool-game")
  assert.deepEqual(made.files.sort(), [".gitignore", "README.md", "index.html", "main.js", "style.css"])
  assert.match(await readFile(path.join(made.dir, "README.md"), "utf8"), /^# My Cool Game!\n\nA tiny platformer/)
  assert.match(await readFile(path.join(made.dir, "index.html"), "utf8"), /<title>My Cool Game!<\/title>/)
  const node = Projects.createProject({ name: "api", template: "node" }, dir)
  assert.equal(JSON.parse(await readFile(path.join(node.dir, "package.json"), "utf8")).scripts.test, "node --test")
  assert.ok(existsSync(path.join(Projects.createProject({ name: "py", template: "python" }, dir).dir, "pyproject.toml")))
  assert.throws(() => Projects.createProject({ name: "api" }, dir), /already exists/)
  assert.throws(() => Projects.createProject({ name: "!!!" }, dir), /letters or digits/)
  assert.throws(() => Projects.createProject({ name: "x", template: "rust" }, dir), /template must be/)
  // A name can never climb out of the folder.
  assert.equal(Projects.createProject({ name: "../../etc" }, dir).dir, path.join(dir, "etc"))
})

test("list is newest first with README descriptions; find matches folder, slug or a unique prefix", async (t) => {
  const dir = await root(t)
  const old = Projects.createProject({ name: "old thing", description: "first" }, dir)
  Projects.createProject({ name: "new thing", description: "second" }, dir)
  Projects.createProject({ name: "newer" }, dir)
  await utimes(old.dir, new Date(0), new Date(0))
  const all = Projects.listProjects(dir)
  assert.equal(all.at(-1).name, "old-thing")
  assert.equal(all.find((item) => item.name === "new-thing").description, "second")
  assert.equal(Projects.findProject("Old Thing", dir).name, "old-thing")
  assert.equal(Projects.findProject("old", dir).name, "old-thing")
  assert.throws(() => Projects.findProject("new", dir), /No project "new".*Projects: /)
  assert.throws(() => Projects.findProject("x", path.join(dir, "missing")), /No projects yet/)
  assert.deepEqual(Projects.listProjects(path.join(dir, "missing")), [])
})

test("applies to the pinned upstream: plugin registered, library written, guidance added", { skip: !existsSync(path.join(repo, ".upstream/packages/core/src/plugin/internal.ts")) && "no pinned upstream" }, async () => {
  const files = new Map([["packages/core/src/infiniteoc/guidance.ts", "export const infiniteocGuidance = { build: [] }\n// infiniteoc:guidance-extensions\n"]])
  const read = async (file) => files.get(file) ?? readFile(path.join(repo, ".upstream", file), "utf8")
  await mod.setup({
    write: async (file, text) => void files.set(file, text),
    patch: async (file, transform) => void files.set(file, transform(await read(file))),
  })
  const internal = files.get("packages/core/src/plugin/internal.ts")
  assert.match(internal, /import \* as InfiniteocProjects from "\.\/infiniteoc-projects\.js"/)
  assert.match(internal, /  PlanPlugin\.Plugin,\n  InfiniteocProjects\.Plugin,\n/)
  assert.equal(files.get("packages/core/src/plugin/infiniteoc-projects-lib.mjs"), await readFile(new URL("./lib.mjs", import.meta.url), "utf8"))
  assert.match(files.get("packages/core/src/plugin/infiniteoc-projects.ts"), /from "\.\/infiniteoc-projects-lib\.mjs"/)
  assert.ok(files.get("packages/core/src/infiniteoc/guidance.ts").includes(JSON.stringify(guidance)))
  // Every relative import of the plugin exists upstream or is written by this mod.
  for (const [, spec] of files.get("packages/core/src/plugin/infiniteoc-projects.ts").matchAll(/from "(\.\.?\/[^"]+)"/g)) {
    if (spec === "./infiniteoc-projects-lib.mjs") continue
    assert.ok(existsSync(path.join(repo, ".upstream/packages/core/src/plugin", spec.replace(/\.js$/, ".ts"))), spec)
  }
})
