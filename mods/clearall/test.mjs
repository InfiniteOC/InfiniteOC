import test from "node:test"
import assert from "node:assert/strict"
import module from "node:module"
import mod from "./index.mjs"

test("clearall registers without deletes", async () => {
  const commands = []
  await mod.setup({
    tui: { command: input => commands.push(input) },
  })
  assert.equal(commands.length, 1)
  assert.equal(commands[0].slash, "clearall")
  assert.match(commands[0].source, /ctx\.tabs\.closeAll\(\)/)
  assert.doesNotMatch(commands[0].source, /\.destroy|\.remove\(|\.delete\(|\.interrupt\(|\.prompt\(/i)
})

test("clearall Undo restores the tabs open before closing and reports failures; an empty scope gets no action", { skip: !module.stripTypeScriptTypes && "needs Node type stripping" }, async () => {
  const commands = []
  await mod.setup({ tui: { command: input => commands.push(input) } })
  const { run } = await import(`data:text/javascript,${encodeURIComponent(module.stripTypeScriptTypes(commands[0].source))}`)
  let open = [{ sessionID: "a" }, { sessionID: "b" }], current = "b"
  const toasts = [], restores = [], errors = []
  const ctx = {
    tabs: {
      tabs: () => open,
      current: () => current,
      // Like upstream, closing navigates home, so current() is undefined afterwards.
      async closeAll() { const count = open.length; open = []; current = undefined; return count },
      async restoreAll(...args) { restores.push(args); return 2 },
    },
    toast: { show: toast => toasts.push(toast), error: error => errors.push(error) },
  }
  await run(ctx)
  assert.equal(toasts[0].variant, "success")
  assert.match(toasts[0].message, /"Reopen closed tab" \(ctrl\+shift\+t\)/)
  toasts[0].action.run()
  await new Promise(setImmediate)
  assert.deepEqual(restores, [[["a", "b"], "b"]])
  await run(ctx)
  assert.deepEqual(toasts[1], { variant: "info", message: "No open tabs in this scope." })
  // A TUI built before restoreAll can run this handler via opendaemon; Undo must not throw into the mouse handler.
  delete ctx.tabs.restoreAll
  toasts[0].action.run()
  await new Promise(setImmediate)
  assert.deepEqual(errors.map(error => error instanceof TypeError), [true])
})
