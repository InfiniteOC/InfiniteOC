import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { dataDir, dbFiles, formatHits, formatMessages, formatSessions, listSessions, messageText, readMessages, resolveSession, searchMessages } from "./lib.mjs"

const sqlite = await import("node:sqlite").catch(() => undefined)

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "ioc-sessions-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { XDG_DATA_HOME: path.join(home, "data") }
  if (sqlite) {
    const { mkdirSync } = await import("node:fs")
    mkdirSync(path.join(env.XDG_DATA_HOME, "opencode"), { recursive: true })
    const db = new sqlite.DatabaseSync(path.join(env.XDG_DATA_HOME, "opencode", "opencode.db"))
    db.exec(`create table project (id text primary key, worktree text not null, name text, time_active integer default 0);
      create table session_v2 (id text primary key, project_id text not null, parent_id text, title text, directory text not null, time_updated integer not null, time_archived integer, cost real default 0);
      create table session_message (id text primary key, session_id text not null, type text not null, seq integer not null, time_created integer not null, data text not null);
      insert into project values ('p1', '/work/alpha', 'alpha', 5);
      insert into session_v2 values ('ses_alpha1', 'p1', null, 'Build the widget', '/work/alpha', 30, null, 1.25), ('ses_beta2', 'p1', null, 'Fix tests', '/work/alpha', 20, null, 0);
      insert into session_message values
        ('m1', 'ses_alpha1', 'user', 1, 10, '{"text":"make a blue widget"}'),
        ('m2', 'ses_alpha1', 'assistant', 2, 11, '{"content":[{"type":"text","text":"done, it is blue"}]}'),
        ('m3', 'ses_beta2', 'user', 1, 12, '{"text":"widget tests fail on linux"}');`)
    db.close()
  }
  return { env, home }
}

test("messageText pulls printable text out of any blob shape", () => {
  assert.equal(messageText({ text: "hi" }), "hi")
  assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "toolcall", name: "x" }] }), "a")
  assert.equal(messageText("raw"), "raw")
})

test("list, resolve, read and search", { skip: !sqlite && "node:sqlite unavailable" }, async (t) => {
  const { env } = await fixture(t)
  const all = await listSessions({ env })
  assert.deepEqual(all.map((item) => item.id), ["ses_alpha1", "ses_beta2"])
  assert.equal(all[0].title, "Build the widget")
  assert.deepEqual((await listSessions({ env, search: "tests" })).map((item) => item.id), ["ses_beta2"])
  assert.deepEqual(await listSessions({ env, project: "/nowhere" }), [])
  assert.equal((await resolveSession("ses_alpha1", env)).title, "Build the widget")
  assert.equal((await resolveSession("ses_alpha", env)).id, "ses_alpha1")
  await assert.rejects(resolveSession("ses_", env), /Did you mean/)
  await assert.rejects(resolveSession("ses_", env), /ses_alpha1/)
  await assert.rejects(resolveSession("nope", env), /No session/)
  const read = await readMessages("ses_alpha1", { env })
  assert.deepEqual(read.messages.map((item) => [item.seq, item.type]), [[1, "user"], [2, "assistant"]])
  assert.match(read.messages[1].text, /done, it is blue/)
  const users = await readMessages("ses_alpha1", { env, types: ["user"] })
  assert.deepEqual(users.messages.map((item) => item.type), ["user"])
  const hits = await searchMessages("linux", { env })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].session.id, "ses_beta2")
  assert.match(formatSessions(all), /ses_alpha1/)
  assert.match(formatMessages(read), /Build the widget/)
  assert.match(formatHits(hits), /ses_beta2/)
  await assert.rejects(searchMessages("  ", { env }), /query/)
})

test("empty or missing databases read as empty, never throw", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "ioc-sessions-empty-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { XDG_DATA_HOME: path.join(home, "data") }
  assert.deepEqual(dbFiles(env), [])
  assert.deepEqual(await listSessions({ env }), [])
  assert.equal(formatSessions([]), "No sessions on this machine yet.")
  assert.equal(dataDir({ XDG_DATA_HOME: "/x" }), "/x/opencode")
})
