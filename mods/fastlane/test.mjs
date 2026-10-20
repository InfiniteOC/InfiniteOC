import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import module from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import mod, { internalSource, platformPatch } from "./index.mjs"

const upstream = path.resolve(import.meta.dirname, "../../.upstream")

async function load(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "fastlane-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, "fastlane.mjs")
  await writeFile(file, module.stripTypeScriptTypes(await readFile(new URL("./fastlane.ts", import.meta.url), "utf8")))
  return import(pathToFileURL(file).href)
}

// A fake network: each call is recorded; `hang` calls never answer until aborted.
function fakeNet() {
  const calls = []
  const net = {
    calls,
    mode: "ok", // ok | hang | stream
    fetch(input, init = {}) {
      const call = { url: String(input), init, aborted: false }
      calls.push(call)
      return new Promise((resolve, reject) => {
        const fail = () => {
          call.aborted = true
          reject(init.signal.reason ?? new Error("aborted"))
        }
        if (init.signal?.aborted) return fail()
        init.signal?.addEventListener("abort", fail, { once: true })
        if (net.mode === "ok" || init.method === "HEAD") return resolve(new Response("ok"))
        if (net.mode === "stream") {
          call.stream = new TransformStream()
          return resolve(new Response(call.stream.readable, { headers: { "content-type": "text/event-stream" } }))
        }
        // hang: answer only when the test says so
        call.resolve = (body = "late") => resolve(new Response(body))
      })
    },
  }
  return net
}

function lane(t, F, net, extra = {}) {
  let clock = 1_000_000
  let sig = "wlan0=10.0.0.2"
  const traces = []
  const l = F.createFastlane({ fetch: net.fetch, now: () => clock, signature: () => sig, timers: false, trace: (e) => traces.push(e), ...extra })
  t.after(() => l.stop())
  return {
    l,
    traces,
    tick: (ms) => (clock += ms),
    change: (s) => (sig = s),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 5))

test("loopback and non-HTTP requests pass straight through", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  const { l } = lane(t, F, net)
  await l.fetch("http://127.0.0.1:4096/api/info")
  assert.equal(net.calls[0].init.signal, undefined, "untouched init")
})

test("a request waiting for headers is resent on a fresh connection when the network changes", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  net.mode = "hang"
  const { l, change, traces } = lane(t, F, net)
  const pending = l.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: '{"x":1}' })
  await flush()
  net.mode = "ok"
  change("wlan0=10.0.0.2,tun0=10.8.0.5") // VPN came up
  l.poll()
  const res = await pending
  assert.equal(await res.text(), "ok")
  const posts = net.calls.filter((c) => c.init.method === "POST")
  assert.equal(posts.length, 2)
  assert.equal(posts[0].aborted, true, "the stuck attempt is dropped")
  assert.equal(posts[1].init.keepalive, false, "the resend skips the pool")
  assert.ok(traces.some((e) => e.kind === "resend"))
  // The pool of the origin gets purged with parallel probes.
  assert.ok(net.calls.filter((c) => c.init.method === "HEAD").length >= 4)
})

test("POSTs to unknown hosts fail fast instead of being resent", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  net.mode = "hang"
  const { l, change } = lane(t, F, net)
  const pending = l.fetch("https://mcp.example.com/rpc", { method: "POST", body: "{}" })
  await flush()
  change("eth0=192.168.1.4")
  l.poll()
  await assert.rejects(pending, /network changed/)
  assert.equal(net.calls.filter((c) => c.init.method === "POST").length, 1)
})

test("a stream that goes silent after a change is failed; a live one is left alone", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  net.mode = "stream"
  const { l, change, tick } = lane(t, F, net)
  const dead = await l.fetch("https://opencode.ai/zen/v1/chat/completions", { method: "POST", body: "{}" })
  const live = await l.fetch("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
  const deadReader = dead.body.getReader()
  const liveReader = live.body.getReader()
  const deadRead = deadReader.read()
  change("wlan1=172.16.0.9")
  l.poll()
  // The live stream keeps producing.
  const liveCall = net.calls.find((c) => c.url.includes("openai"))
  const w = liveCall.stream.writable.getWriter()
  tick(1000)
  const first = liveReader.read()
  await w.write(new TextEncoder().encode("data: hi\n\n"))
  assert.equal(new TextDecoder().decode((await first).value), "data: hi\n\n")
  tick(5_000)
  l.poll()
  await assert.rejects(deadRead, /network changed/)
  const second = liveReader.read()
  await w.write(new TextEncoder().encode("data: more\n\n"))
  assert.equal(new TextDecoder().decode((await second).value), "data: more\n\n", "the live stream survives")
  await w.close()
})

test("an origin that streamed before is treated as a model API and resent", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  net.mode = "stream"
  const { l, change } = lane(t, F, net)
  const first = await l.fetch("https://llm.internal.example/v1/chat", { method: "POST", body: "{}" })
  await first.body.cancel()
  net.mode = "hang"
  const pending = l.fetch("https://llm.internal.example/v1/chat", { method: "POST", body: "{}" })
  await flush()
  net.mode = "ok"
  change("tun0=10.9.0.2")
  l.poll()
  assert.equal(await (await pending).text(), "ok")
})

test("requests right after a change use fresh connections; later ones pool again", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  const { l, change, tick } = lane(t, F, net)
  change("eth0=10.1.1.1")
  l.poll()
  await l.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" })
  assert.equal(net.calls.at(-1).init.keepalive, false)
  tick(10_000)
  await l.fetch("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" })
  assert.equal(net.calls.at(-1).init.keepalive, undefined)
})

test("a caller's abort is honoured, not resent", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  net.mode = "hang"
  const { l } = lane(t, F, net)
  const ctrl = new AbortController()
  const pending = l.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}", signal: ctrl.signal })
  await flush()
  ctrl.abort(new Error("user interrupt"))
  await assert.rejects(pending, /user interrupt/)
  assert.equal(net.calls.length, 1)
})

test("a long timer gap (suspend/resume) counts as a network change", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  net.mode = "hang"
  const { l, tick, traces } = lane(t, F, net)
  const pending = l.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" })
  await flush()
  net.mode = "ok"
  tick(60_000)
  l.poll()
  assert.equal(await (await pending).text(), "ok")
  assert.ok(traces.some((e) => e.kind === "network-change" && /resumed/.test(e.detail)))
})

test("warm opens connections to recently used origins, throttled", async (t) => {
  const F = await load(t)
  const net = fakeNet()
  const { l, tick } = lane(t, F, net, { load: () => ({ "https://opencode.ai": 999_000, "https://old.example": 1 }) })
  assert.deepEqual(l.warm("typing"), ["https://opencode.ai"], "only origins used in the last ten minutes")
  assert.deepEqual(l.warm("typing"), [], "throttled")
  tick(20_000)
  assert.deepEqual(l.warm("typing"), ["https://opencode.ai"])
  await flush()
  assert.ok(net.calls.every((c) => c.init.method === "HEAD" && !("authorization" in (c.init.headers ?? {}))), "probes carry no credentials")
})

test("plugin registration keeps the WarmingPlugin anchor intact", { skip: !existsSync(upstream) && "no .upstream checkout" }, async () => {
  const source = await readFile(path.join(upstream, "packages/core/src/plugin/internal.ts"), "utf8")
  const out = internalSource(source)
  assert.match(out, /InfiniteocFastlane\.Plugin,\n {2}WarmingPlugin\.Plugin,/)
  assert.throws(() => internalSource(out), /already applied/)
})

test("provider requests resolve fetch per call (anchor unique upstream)", { skip: !existsSync(upstream) && "no .upstream checkout" }, async () => {
  const [file, before, after] = platformPatch
  const source = await readFile(path.join(upstream, file), "utf8")
  assert.equal(source.split(before).length, 2)
  assert.match(after, /globalThis\.fetch\(input, init\)/)
})

test("setup writes the core files", async () => {
  const writes = []
  await mod.setup({ async write(file) { writes.push(file) }, async patch() {}, async patchExact() {} })
  assert.deepEqual(writes, ["packages/core/src/infiniteoc/fastlane.ts", "packages/core/src/plugin/infiniteoc-fastlane.ts"])
})
