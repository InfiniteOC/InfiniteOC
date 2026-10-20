// Written to packages/core/src/infiniteoc/fastlane.ts by mods/fastlane.
//
// One wrapper around the server's fetch (every provider route ends there: Effect's FetchHttpClient and
// the AI SDK both call globalThis.fetch). It does two things:
//
// 1. Network changes. Bun pools keep-alive sockets per origin. After a Wi-Fi switch or a VPN coming up,
//    pooled sockets are bound to a route that no longer exists: a request written to one waits for the
//    kernel to give up (minutes; the provider header timeout is 300s). Fastlane watches the interfaces,
//    and on a change it resends requests still waiting for headers on a fresh connection, fails streams
//    that went silent (OpenCode's own retry takes over), and purges each origin's pool with short
//    parallel probes (every dead socket a probe takes is destroyed when the probe times out).
// 2. Cold connections. A TLS handshake costs up to ~250ms (OpenCode Zen). Fastlane keeps recently used
//    origins warm: at start, while a session is active, and when the user starts typing (RPC "warm").

export interface FastlaneOptions {
  fetch: typeof fetch
  now?: () => number
  /** Network identity: changes when interfaces or addresses change. */
  signature?: () => string
  /** Persisted recent origins. */
  load?: () => Record<string, number>
  save?: (origins: Record<string, number>) => void
  trace?: (entry: Record<string, unknown>) => void
  timers?: boolean
}

// Requests in this window after a change open their own connection instead of drawing from the pool.
const FRESH_WINDOW = 5_000
// After a change, a stream that has produced nothing for this long is presumed dead.
const STALL_AFTER_CHANGE = 5_000
const PROBE_TIMEOUT = 2_500
// Keep origins used this recently warm; an idle socket is refreshed before servers drop it.
const ACTIVE_FOR = 10 * 60_000
const KEEPALIVE_EVERY = 45_000
const WARM_THROTTLE = 15_000

// Hosts whose POSTs are model calls: resending one after a network change costs at most a duplicate
// generation, which beats a multi-minute hang. Other POSTs fail fast instead of being resent.
const LLM_HOST =
  /(^|\.)(anthropic\.com|openai\.com|opencode\.ai|deepseek\.com|googleapis\.com|mistral\.ai|groq\.com|x\.ai|openrouter\.ai|together\.xyz|fireworks\.ai|cerebras\.ai|moonshot\.(ai|cn)|bigmodel\.cn|z\.ai|minimax(i)?\.(io|chat)|azure\.com|amazonaws\.com|githubcopilot\.com|cohere\.(ai|com)|perplexity\.ai|huggingface\.co)$/

export class NetworkChanged extends TypeError {
  constructor(detail: string) {
    super(`network changed: ${detail}`)
    this.name = "TypeError" // reads like a connection failure, which the session retries
  }
}

interface Flight {
  origin: string
  started: number
  headers: boolean
  lastChunk: number
  deadline: number
  kill: (detail: string) => void
}

function urlOf(input: unknown): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input)
    if (input instanceof URL) return input
    if (input && typeof input === "object" && "url" in input) return new URL(String((input as Request).url))
  } catch {}
  return undefined
}

function loopback(host: string) {
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.") || host.endsWith(".localhost")
}

function replayable(input: unknown, body: unknown) {
  if (!(typeof input === "string" || input instanceof URL)) return false
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof URLSearchParams
  )
}

// When a consumer stops at the last event, the end of the body is usually milliseconds away (or already
// buffered). Cancelling first makes Bun destroy the socket; reading the tail keeps it pooled, so the next
// agent step skips DNS, TCP and the TLS handshake. A real interrupt is cancelled after the window.
const DRAIN_MS = 250
const DRAIN_BYTES = 64 * 1024

export function createFastlane(opts: FastlaneOptions) {
  const base = opts.fetch
  const now = opts.now ?? Date.now
  const trace = opts.trace ?? (() => {})
  const flights = new Set<Flight>()
  const origins = new Map<string, number>(Object.entries(opts.load?.() ?? {}))
  const concurrency = new Map<string, number>() // most simultaneous requests seen per origin
  const warmedAt = new Map<string, number>()
  const streaming = new Set<string>()
  let changedAt = 0
  let generation = 0
  let lastSignature = opts.signature?.() ?? ""
  let lastPoll = now()
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  const persist = () => {
    if (!opts.save || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      const cutoff = now() - 7 * 24 * 3600_000
      const out: Record<string, number> = {}
      for (const [origin, at] of origins) if (at > cutoff) out[origin] = at
      opts.save?.(out)
    }, 2_000)
    ;(saveTimer as { unref?: () => void }).unref?.()
  }

  const touch = (origin: string) => {
    origins.set(origin, now())
    persist()
  }

  /** A HEAD with no credentials: opens (or refreshes) a pooled connection; dead sockets it takes die with it. */
  const probe = (origin: string, fresh = false) =>
    base(origin + "/", {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      ...(fresh ? { keepalive: false } : {}),
    } as RequestInit)
      .then((r) => {
        void r.body?.cancel()
        return true
      })
      .catch(() => false)

  /** Warm the pool of recently used origins. */
  const warm = (reason: string, force = false) => {
    const t = now()
    const out: string[] = []
    for (const [origin, at] of origins) {
      if (t - at > ACTIVE_FOR && reason !== "start") continue
      if (!force && t - (warmedAt.get(origin) ?? 0) < WARM_THROTTLE) continue
      warmedAt.set(origin, t)
      out.push(origin)
      void probe(origin).then((ok) => trace({ kind: "warm", reason, origin, ok }))
    }
    return out
  }

  /** Purge an origin's pool: one probe per socket it may hold. */
  const purge = (origin: string) => {
    const n = Math.max(4, (concurrency.get(origin) ?? 1) + 2)
    return Promise.all(Array.from({ length: n }, () => probe(origin))).then((r) => r.filter(Boolean).length)
  }

  const onChange = (detail: string) => {
    generation++
    changedAt = now()
    trace({ kind: "network-change", detail, generation, inflight: flights.size })
    for (const f of flights) {
      if (!f.headers) f.kill(detail)
      else f.deadline = changedAt + STALL_AFTER_CHANGE
    }
    const t = now()
    for (const [origin, at] of origins) {
      if (t - at > ACTIVE_FOR) continue
      void purge(origin).then((alive) => trace({ kind: "purge", origin, alive }))
    }
  }

  /** Poll once: interface changes, and suspend/resume gaps (sockets rarely survive a sleep). */
  const poll = () => {
    const t = now()
    const gap = t - lastPoll
    lastPoll = t
    const sig = opts.signature?.() ?? ""
    if (sig !== lastSignature) {
      lastSignature = sig
      onChange("interfaces")
    } else if (gap > 20_000) {
      onChange(`resumed after ${Math.round(gap / 1000)}s`)
    }
    for (const f of flights) {
      if (f.deadline && t > f.deadline && f.lastChunk <= changedAt) f.kill("stream stalled after the change")
    }
  }

  const keepWarm = () => {
    const t = now()
    for (const [origin, at] of origins) {
      if (t - at > ACTIVE_FOR || flights.size > 0) continue
      if (t - Math.max(at, warmedAt.get(origin) ?? 0) < KEEPALIVE_EVERY) continue
      warmedAt.set(origin, t)
      void probe(origin)
    }
  }

  // The body is pumped eagerly, as Bun does on its own: the socket goes back to the pool when the body
  // ends, whether the consumer reads to the end, stops reading, or cancels after the last event.
  const wrapBody = (res: Response, flight: Flight, done: () => void, killed: () => string | undefined) => {
    if (!res.body) {
      done()
      return res
    }
    const reader = res.body.getReader()
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
    let cancelled = false
    let finished = false
    let drained = 0
    const kill = flight.kill
    flight.kill = (detail) => {
      kill(detail)
      done()
      try {
        ctl?.error(new NetworkChanged(detail))
      } catch {}
      void reader.cancel().catch(() => {})
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctl = controller
        void (async () => {
          try {
            while (true) {
              const { done: end, value } = await reader.read()
              if (end) {
                finished = true
                done()
                if (!cancelled) controller.close()
                return
              }
              flight.lastChunk = now()
              flight.deadline = 0
              if (!cancelled) {
                controller.enqueue(value)
                continue
              }
              // Cancelled: keep the tail flowing briefly so the socket can be pooled.
              drained += value.byteLength
              if (drained > DRAIN_BYTES) {
                await reader.cancel().catch(() => {})
                return
              }
            }
          } catch (error) {
            finished = true
            done()
            if (cancelled) return
            const why = killed()
            try {
              controller.error(why ? new NetworkChanged(why) : error)
            } catch {}
          }
        })()
      },
      cancel() {
        cancelled = true
        done()
        // A real interrupt: stop after the drain window.
        const timer = setTimeout(() => {
          if (!finished) void reader.cancel().catch(() => {})
        }, DRAIN_MS)
        ;(timer as { unref?: () => void }).unref?.()
      },
    })
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  const fastFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = urlOf(input)
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || loopback(url.hostname)) return base(input, init)
    const origin = url.origin
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    const resendable =
      replayable(input, init.body) &&
      (method === "GET" || method === "HEAD" || LLM_HOST.test(url.hostname) || streaming.has(origin))
    touch(origin)
    const outer = init.signal ?? undefined
    for (let attempt = 0; ; attempt++) {
      if (outer?.aborted) throw outer.reason
      const ctrl = new AbortController()
      const onAbort = () => ctrl.abort(outer?.reason)
      outer?.addEventListener("abort", onAbort, { once: true })
      let killedFor: string | undefined
      const flight: Flight = {
        origin,
        started: now(),
        headers: false,
        lastChunk: now(),
        deadline: 0,
        kill: (detail) => {
          killedFor = detail
          ctrl.abort(new NetworkChanged(detail))
        },
      }
      flights.add(flight)
      const active = [...flights].filter((f) => f.origin === origin).length
      concurrency.set(origin, Math.max(concurrency.get(origin) ?? 0, active))
      const done = () => {
        flights.delete(flight)
        outer?.removeEventListener("abort", onAbort)
      }
      const fresh = attempt > 0 || now() - changedAt < FRESH_WINDOW
      try {
        const res = await base(input, { ...init, signal: ctrl.signal, ...(fresh ? { keepalive: false } : {}) } as RequestInit)
        flight.headers = true
        // An origin that streams events is a model API (custom and self-hosted providers included).
        if (res.headers.get("content-type")?.includes("event-stream")) streaming.add(origin)
        trace({ kind: "request", origin, method, path: url.pathname, attempt, fresh, headersMs: now() - flight.started })
        return wrapBody(res, flight, done, () => killedFor)
      } catch (error) {
        done()
        if (killedFor && !outer?.aborted) {
          if (attempt === 0 && resendable) {
            trace({ kind: "resend", origin, method, path: url.pathname, why: killedFor })
            continue
          }
          throw new NetworkChanged(killedFor)
        }
        throw error
      }
    }
  }

  let timers: ReturnType<typeof setInterval>[] = []
  if (opts.timers !== false) {
    timers = [setInterval(poll, 1_500), setInterval(keepWarm, 5_000)]
    for (const t of timers) (t as { unref?: () => void }).unref?.()
  }

  return {
    fetch: fastFetch as typeof fetch,
    warm,
    poll,
    keepWarm,
    onChange,
    purge,
    stop: () => timers.forEach(clearInterval),
    state: () => ({ generation, changedAt, inflight: flights.size, origins: Object.fromEntries(origins) }),
  }
}
