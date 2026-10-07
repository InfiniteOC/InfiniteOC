import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { freeModelIDs, classifyProbe, isolatedEnvironment, probeModel, probeModels } from "./health-store.mjs"

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
  const results = await probeModels(['exo-free', 'other-free', 'exo-free'], { probe: async id => ({ id, status: 'responding' }), onResult: (_result, done, total) => progress.push([done, total]) })
  assert.equal(results.length, 2)
  assert.deepEqual(progress, [[1, 2], [2, 2]])
  await assert.rejects(probeModels(['paid-model']), /Invalid/)
})

test("health executes a child and cleans up timeout without leaking provider errors", async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'health-test-'))
  const binary = path.join(base, 'fake-opencode')
  try {
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"text",part:{text:"OK"}}))\n')
    await chmod(binary, 0o700)
    assert.equal((await probeModel('exo-free', { binary })).status, 'responding')
    await writeFile(binary, '#!/usr/bin/env node\nsetInterval(()=>{},1000)\n')
    assert.equal((await probeModel('exo-free', { binary, timeout: 150 })).status, 'timeout')
  } finally { await rm(base, { recursive: true, force: true }) }
})