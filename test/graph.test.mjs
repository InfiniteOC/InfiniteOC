import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { collectGraph, createNote, formatNote, noteLinks, parseNote, slugify, startGraph, trashNote, updateNote } from "../src/graph.mjs"

const sqlite = await import("node:sqlite").catch(() => undefined)

/** A data home with an OpenCode database, ctx-context memory and a project folder with AGENTS.md. */
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "ioc-graph-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const data = path.join(home, "data")
  // A real project directory outside the temp root is not needed: temp-ness is reported, not filtered.
  const project = path.join(home, "work", "alpha")
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, "AGENTS.md"), "# Alpha rules\nRun npm test.\n")
  if (sqlite) {
    await mkdir(path.join(data, "opencode"), { recursive: true })
    const db = new sqlite.DatabaseSync(path.join(data, "opencode", "opencode-infiniteoc.db"))
    db.exec(`create table project (id text primary key, worktree text not null, name text, time_active integer default 0 not null);
      create table session_v2 (id text primary key, project_id text not null, parent_id text, title text, directory text not null, time_updated integer not null, time_archived integer, cost real default 0 not null);
      insert into project values ('p1', '${project}', null, 5), ('p2', '/', null, 1);
      insert into session_v2 values ('ses_a', 'p1', null, 'Fix the build', '${project}', 20, null, 0.5),
        ('ses_child', 'p1', 'ses_a', 'Subagent', '${project}', 21, null, 0),
        ('ses_old', 'p1', null, 'Archived', '${project}', 3, 9, 0);`)
    db.close()
  }
  const ctx = path.join(data, "infiniteoc", "ctx", "projects", `alpha-${createHash("sha1").update(project).digest("hex").slice(0, 8)}`)
  await mkdir(ctx, { recursive: true })
  await writeFile(path.join(ctx, "memory.md"), "- build with npm run build\n- tests live in test/\n")
  await writeFile(path.join(ctx, "glossary.md"), "- DAG: the workflow step graph\n")
  const notes = path.join(home, "notes")
  await mkdir(notes)
  await writeFile(path.join(notes, "plan.md"), formatNote({ title: "Plan", project, body: "See [[Ideas]], [[alpha]] and [[Nowhere]]. #roadmap\n```\n#code [[NotALink]]\n```" }))
  await writeFile(path.join(notes, "ideas.md"), "No frontmatter, back to [[plan]]. #roadmap #Later")
  await writeFile(path.join(notes, "Bad Name.md"), "ignored: not a slug")
  return { env: { XDG_DATA_HOME: data }, notes, project }
}

test("notes: frontmatter, slugs, wikilinks and tags outside code", () => {
  assert.deepEqual(parseNote("---\ntitle: A\nproject: /x\n---\nbody"), { meta: { title: "A", project: "/x" }, body: "body" })
  assert.deepEqual(parseNote("just text"), { meta: {}, body: "just text" })
  assert.equal(slugify("Héllo, World! 2"), "hello-world-2")
  assert.equal(slugify("!!!"), "note")
  assert.equal(formatNote({ title: "T\nx", body: "b" }), "---\ntitle: T x\n---\nb\n")
  assert.deepEqual(noteLinks("[[A]] [[B|label]] [[C#head]] `[[D]]` #tag #Tag2 x#no\n```\n#e [[F]]\n```\n# Heading"), { links: ["A", "B", "C"], tags: ["tag", "tag2"] })
})

test("the graph joins projects, sessions, memory, glossary, docs and notes", { skip: !sqlite && "node:sqlite unavailable" }, async (t) => {
  const { env, notes, project } = await fixture(t)
  const graph = await collectGraph({ env, notes })
  const ids = new Set(graph.nodes.map((node) => node.id))
  for (const id of [`p:${project}`, "p:/", "s:ses_a", `m:${project}:0`, `m:${project}:1`, `g:${project}:0`, `d:${project}:AGENTS.md`, "n:plan", "n:ideas", "t:roadmap", "t:later", "x:nowhere"]) assert.ok(ids.has(id), id)
  // Subagent children and archived sessions are not shown; files that are not slugs are ignored.
  for (const id of ["s:ses_child", "s:ses_old", "x:notalink", "t:code"]) assert.ok(!ids.has(id), id)
  assert.equal(graph.nodes.filter((node) => node.type === "note").length, 2)
  assert.equal(graph.nodes.find((node) => node.id === "p:/").label, "global")
  assert.equal(graph.nodes.find((node) => node.id === `g:${project}:0`).label, "DAG")
  const has = (a, b) => graph.links.some((link) => (link.source === a && link.target === b) || (link.source === b && link.target === a))
  assert.ok(has("s:ses_a", `p:${project}`))
  assert.ok(has("n:plan", "n:ideas"))
  assert.ok(has("n:plan", `p:${project}`))
  assert.ok(has("n:plan", "x:nowhere"))
  // [[alpha]] and the frontmatter project are one edge, not two.
  assert.equal(graph.links.filter((link) => [link.source, link.target].includes("n:plan") && [link.source, link.target].includes(`p:${project}`)).length, 1)
  assert.equal(graph.stats.sessions, 1)
})

test("notes are created, renamed safely, updated and moved to .trash, never unlinked", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ioc-notes-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.deepEqual(await createNote(dir, { title: "Same", body: "one" }), { slug: "same" })
  assert.deepEqual(await createNote(dir, { title: "Same", body: "two" }), { slug: "same-2" })
  await updateNote(dir, "same", { title: "Same", body: "edited", project: "/abs" })
  assert.equal(await readFile(path.join(dir, "same.md"), "utf8"), "---\ntitle: Same\nproject: /abs\n---\nedited\n")
  await trashNote(dir, "same-2")
  assert.deepEqual((await readdir(dir)).sort(), [".trash", "same.md"])
  assert.equal((await readdir(path.join(dir, ".trash"))).length, 1)
  await assert.rejects(createNote(dir, { title: "", body: "" }), /title/)
  await assert.rejects(createNote(dir, { title: "x", body: "x".repeat(300 * 1024) }), /200 KB/)
  await assert.rejects(createNote(dir, { title: "x", project: "relative/path" }), /absolute/)
  await assert.rejects(updateNote(dir, "../escape", { title: "x" }), /Invalid note id/)
  await assert.rejects(trashNote(dir, "missing"), /No such note/)
})

test("the server needs the token for /api, checks Host, and serves only its own assets", async (t) => {
  const notes = await mkdtemp(path.join(tmpdir(), "ioc-graph-srv-"))
  t.after(() => rm(notes, { recursive: true, force: true }))
  const graph = await startGraph({ notes, env: { XDG_DATA_HOME: path.join(notes, "empty") }, token: "tok" })
  t.after(() => graph.close())
  assert.match(graph.link, /^http:\/\/127\.0\.0\.1:\d+\/#tok$/)
  const auth = { authorization: "Bearer tok" }
  const page = await fetch(`${graph.url}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/)
  assert.equal((await fetch(`${graph.url}/graph.js`)).status, 200)
  assert.equal((await fetch(`${graph.url}/../src/graph.mjs`)).status, 404)
  assert.equal((await fetch(`${graph.url}/api/graph`)).status, 401)
  assert.equal((await fetch(`${graph.url}/api/graph`, { headers: { authorization: "Bearer nope" } })).status, 401)
  // A DNS-rebinding page reaches the port under its own host name.
  const { request } = await import("node:http")
  const rebound = await new Promise((resolve) => request(`${graph.url}/api/graph`, { headers: { ...auth, host: "evil.example" } }, (response) => resolve(response.statusCode)).end())
  assert.equal(rebound, 421)
  assert.equal((await fetch(`${graph.url}/api/notes`, { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" })).status, 415)
  const created = await fetch(`${graph.url}/api/notes`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ title: "Hello", body: "[[World]]" }) })
  assert.deepEqual(await created.json(), { slug: "hello" })
  const data = await (await fetch(`${graph.url}/api/graph`, { headers: auth })).json()
  assert.ok(data.nodes.some((node) => node.id === "n:hello"))
  assert.ok(data.nodes.some((node) => node.id === "x:world"))
  assert.equal((await fetch(`${graph.url}/api/notes/hello`, { method: "DELETE", headers: auth })).status, 200)
  assert.equal((await fetch(`${graph.url}/api/notes/hello`, { method: "DELETE", headers: auth })).status, 404)
  assert.equal((await fetch(`${graph.url}/api/doc?id=d:/etc:passwd`, { headers: auth })).status, 404)
})
