import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { freeModelIDs, classifyProbe, isolatedEnvironment, probeModel, probeModels, meter } from "./health-store.mjs"

test("health selects only bounded free-labelled models and never treats catalog listing as inference", () => {
  assert.deepEqual(freeModelIDs({ data: [{ id: "exo-free" }, { id: "paid-model" }, { id: "exo-free" }, { id: "--bad-free" }] }), ["exo-free"])
  assert.equal(classifyProbe(''), "inconclusive")
  assert.equal(classifyProbe('{"type":"text","part":{"text":"OK"}}'), "responding")
  assert.equal(classifyProbe('{"type":"error","error":{"message":"secret"}}'), "provider/client error")
  assert.equal(classifyProbe('{"type":"text","part":{"text":"OK"}}', { timedOut: true }), "timeout")
  assert.equal(classifyProbe('{"type":"step_finish"}'), "empty response")
})

test("health isolates config/history/secrets and denies all tools", () => {
  const env = isolatedEnvironment('/tmp/health', 'exo-free', { PATH: '/usr/bin', OPENCODE_CONFIG: '/secret', OPENAI_API_KEY: 'secret', HOME: '/real-home', INFINITEOC_DAEMON_SOCKET: '/real-socket' })
  assert.equal(env.HOME, '/tmp/health/home')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.OPENCODE_CONFIG, undefined)
  assert.equal(env.INFINITEOC_DAEMON_SOCKET, undefined)
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
  assert.equal(config.providers.opencode.settings.apiKey, 'public')
  assert.deepEqual(config.agents.health.permissions, [{ action: '*', resource: '*', effect: 'deny' }])
})

test("health progress is sequential, deduplicated and excludes paid models", async () => {
  const progress = []
  const results = await probeModels(['exo-free', 'other-free', 'exo-free'], { probe: async id => ({ id, status: 'responding' }), onResult: (result, done, total) => progress.push([result.id, done, total]) })
  assert.equal(results.length, 2)
  assert.deepEqual(progress, [['exo-free', 1, 2], ['other-free', 2, 2]])
  await assert.rejects(probeModels(['paid-model']), /Invalid/)
  assert.equal(meter(2, 5), '■■⬝⬝⬝')
  assert.equal(meter(5, 5), '■■■■■')
})

test("health executes a child and cleans up timeout without leaking provider errors", async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'health-test-'))
  const binary = path.join(base, 'fake-opencode')
  try {
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"text",part:{text:"OK"}}))\n')
    await chmod(binary, 0o700)
    const result = await probeModel('exo-free', { binary })
    assert.deepEqual([result.id, result.status, typeof result.durationMs], ['exo-free', 'responding', 'number'])
    await writeFile(binary, '#!/usr/bin/env node\nsetInterval(()=>{},1000)\n')
    assert.equal((await probeModel('exo-free', { binary, timeout: 150 })).status, 'timeout')
  } finally { await rm(base, { recursive: true, force: true }) }
})

test("/health probes only after explicit menu consent, bridges progress and shares one run and report across live reloads", { skip: !process.features.typescript && "needs Node type stripping" }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'health-command-'))
  const { fetch } = globalThis, { execPath } = process, socket = process.env.INFINITEOC_DAEMON_SOCKET
  t.after(async () => {
    globalThis.fetch = fetch; process.execPath = execPath
    if (socket !== undefined) process.env.INFINITEOC_DAEMON_SOCKET = socket
    await rm(base, { recursive: true, force: true })
  })
  const source = await readFile(new URL('./command.tsx', import.meta.url), 'utf8')
  const generation = async name => { // like an opendaemon live bundle: its own command and health-store module instances
    await writeFile(path.join(base, `${name}.mts`), source.replace('"./health-store.mjs"', JSON.stringify(new URL(`./health-store.mjs?${name}`, import.meta.url).href)))
    return (await import(pathToFileURL(path.join(base, `${name}.mts`)).href)).run
  }
  const run = await generation('command'), reloaded = await generation('reloaded')
  process.execPath = path.join(base, 'fake-opencode')
  await writeFile(process.execPath, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"text",part:{text:"OK"}}))\n')
  await chmod(process.execPath, 0o700)
  const catalog = async () => new Response(JSON.stringify({ data: [{ id: 'exo-free' }, { id: 'other-free' }, { id: 'paid-model' }] }))
  globalThis.fetch = catalog
  delete process.env.INFINITEOC_DAEMON_SOCKET
  const toasts = [], menus = [], answers = [undefined, 'probe', 'report']
  const ctx = { toast: { pending: 0, show: toast => toasts.push(toast) }, ui: { set() {}, select: async menu => (menus.push(menu), answers.shift()) } }

  await run({ toast: ctx.toast }) // a TUI built before ctx.ui gets a notice, not a TypeError
  assert.match(toasts.pop().message, /Rebuild and restart/)

  await run(ctx) // Esc sends nothing
  assert.equal(menus[0].title, 'Free-model health · daemon not connected')
  assert.deepEqual(menus[0].options.map(option => option.value), ['probe', 'close'])
  assert.match(menus[0].options[0].description, /^uses free-tier quota/) // survives row clipping
  assert.equal(toasts.length, 0)

  let settled = false
  const probing = run(ctx).finally(() => { settled = true }) // explicit keyboard consent
  while (!toasts.length && !settled) await new Promise(resolve => setImmediate(resolve))
  await reloaded(ctx) // /health after a live reload shows progress instead of another menu or run
  await probing
  assert.equal(menus.length, 2)
  const start = '⬝⬝ 0/2\nnow: exo-free · up to 20s'
  assert.deepEqual(toasts.map(toast => toast.message), [start, start, '■⬝ 1/2\nexo-free: responding\nnow: other-free · up to 20s', '2/2 responding · run /health to view'])
  assert.ok(toasts.slice(0, 3).every(toast => toast.variant === 'info' && toast.duration >= 21000)) // steady border: no success/warning flips
  assert.ok(toasts.every(toast => !toast.action))

  await reloaded(ctx) // Show last report, kept across the reload
  assert.deepEqual(menus[2].options.map(option => option.value), ['probe', 'report', 'close'])
  assert.deepEqual(menus[3].options.map(option => option.title), ['exo-free', 'other-free'])
  assert.match(menus[3].options[0].footer, /^responding · \d+\.\ds$/)
  assert.match(menus[3].options[0].category, /does not verify tool use/)

  globalThis.fetch = async () => { throw new Error('offline') } // the report stays reachable without the catalog
  answers.push('report')
  await run(ctx)
  assert.equal(menus[4].title, 'Free-model health · catalog unavailable')
  assert.deepEqual(menus[4].options.map(option => option.value), ['report', 'close'])
  assert.equal(menus[5].title, 'Free-model health · 2/2 responding')

  globalThis.fetch = catalog
  ctx.toast.pending = 1 // toasts already queue: progress is skipped, the summary still queues
  answers.push('probe')
  toasts.length = 0
  await run(ctx)
  assert.deepEqual(toasts.map(toast => toast.message), ['2/2 responding · run /health to view'])
})
