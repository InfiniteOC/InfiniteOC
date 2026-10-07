import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import http from "node:http"

export async function daemonHealth(socket = process.env.INFINITEOC_DAEMON_SOCKET) {
  if (!socket) return "not connected"
  return new Promise(resolve => {
    const request = http.get({ socketPath: socket, path: "/status" }, response => {
      response.resume()
      response.on("end", () => resolve(response.statusCode === 200 ? "reachable" : "unavailable"))
    })
    request.setTimeout(2000, () => request.destroy())
    request.on("error", () => resolve("unavailable"))
  })
}

export function freeModelIDs(data) {
  if (!Array.isArray(data?.data)) throw new Error("Invalid catalog")
  return [...new Set(data.data.map(item => item.id).filter(id => typeof id === "string" && /^[a-z0-9][a-z0-9._-]*-free$/.test(id)))].sort()
}

export async function discoverFreeModels(request = fetch) {
  const response = await request("https://opencode.ai/zen/v1/models", {
    headers: { "User-Agent": "opencode/infiniteoc/health/opencode", Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error("Catalog unavailable")
  const ids = freeModelIDs(await response.json())
  if (!ids.length || ids.length > 20) throw new Error("Unexpected free-model catalog size")
  return ids
}

export function classifyProbe(output, { timedOut = false, exitCode = 0 } = {}) {
  if (timedOut) return "timeout"
  let text = "", failure = false, completed = false, errorStatus
  for (const line of output.split("\n")) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === "error") {
      failure = true
      const status = event.error?.status ?? event.error?.data?.statusCode
      if (Number.isInteger(status) && status >= 400 && status <= 599) errorStatus = status
    }
    if (event.type === "text") text += event.part?.text || ""
    if (event.type === "step_finish" || event.type === "step-finish") completed = true
  }
  if (failure) return errorStatus ? `provider error (HTTP ${errorStatus})` : "provider/client error"
  if (exitCode !== 0) return "client error"
  if (text.trim()) return "responding"
  return completed ? "empty response" : "inconclusive"
}

export function isolatedEnvironment(base, model, environment = process.env) {
  const env = { ...environment }
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCODE_") || key.startsWith("INFINITEOC") || /(?:_API_KEY|_TOKEN)$/.test(key)) delete env[key]
  }
  for (const [key, suffix] of Object.entries({ XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", HOME: "home" })) env[key] = path.join(base, suffix)
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    providers: { opencode: { package: "@ai-sdk/openai-compatible", settings: { baseURL: "https://opencode.ai/zen/v1", apiKey: "public" }, models: { [model]: { name: model, modelID: model } } } },
    agents: { health: { mode: "primary", steps: 1, system: "Reply only OK. Never call tools.", permissions: [{ action: "*", resource: "*", effect: "deny" }] } },
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  })
  return env
}

export async function probeModel(id, { binary, timeout = 20000 } = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*-free$/.test(id) || !path.isAbsolute(binary || "")) throw new Error("Invalid probe")
  const base = await mkdtemp(path.join(tmpdir(), "infiniteoc-health-"))
  const start = Date.now()
  try {
    return await new Promise(resolve => {
      let output = "", timedOut = false, overflow = false, settled = false, killTimer
      const child = spawn(binary, ["run", "--standalone", "--agent", "health", "--model", `opencode/${id}`, "--format", "json", "Reply only OK. Do not use tools."], { cwd: base, env: isolatedEnvironment(base, id), detached: true, stdio: ["ignore", "pipe", "pipe"] })
      const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal) } catch {} } }
      const stop = () => { kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 1500) }
      const timer = setTimeout(() => { timedOut = true; stop() }, timeout)
      const finish = (code, error = false) => {
        if (settled) return
        settled = true; clearTimeout(timer); clearTimeout(killTimer)
        kill("SIGKILL") // Only this probe's private process group, including server children.
        resolve({ id, status: error || overflow ? "client error" : classifyProbe(output, { timedOut, exitCode: code }), durationMs: Date.now() - start })
      }
      child.stdout.on("data", chunk => {
        if (output.length + chunk.length > 262144) { if (!overflow) { overflow = true; stop() }; return }
        output += chunk
      })
      child.stderr.resume() // Never display provider payloads, prompts, or secrets.
      child.on("error", () => finish(1, true))
      child.on("close", code => finish(code ?? 1))
    })
  } finally { await rm(base, { recursive: true, force: true }) }
}

export async function probeModels(ids, { onResult = () => {}, probe = probeModel, ...options } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*-free$/.test(id))) throw new Error("Invalid free model list")
  const results = []
  for (const id of [...new Set(ids)]) {
    const result = await probe(id, options)
    results.push(result)
    onResult(result, results.length, new Set(ids).size)
  }
  return results
}