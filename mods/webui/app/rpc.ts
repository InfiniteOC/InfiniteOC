// InfiniteOC's RPC contract, shared with the server plugin mods/webui generates
// (packages/core/src/plugin/infiniteoc-web.ts). Strings in and out: the payloads are JSON the server's
// views module defines (mods/webui/views.ts), so neither side depends on a schema library.
// Written to packages/app/src/infiniteoc/rpc.ts by mods/webui.
export const contract = {
  id: "infiniteoc",
  methods: {
    features: { input: { type: "string" }, output: { type: "string" } },
    run: { input: { type: "string" }, output: { type: "string" } },
  },
  events: {},
} as const

export type Item = { id: string; title: string; description?: string }
export type View = {
  title: string
  text?: string
  items?: Item[]
  actions?: Item[]
  input?: { placeholder: string; action: string; value?: string }
  toast?: { message: string; variant: "success" | "error" }
}
export type Feature = { id: string; slash: string; title: string; description: string; session: boolean }
export type Request = { feature: string; action?: string; value?: string; sessionID?: string; directory?: string }
