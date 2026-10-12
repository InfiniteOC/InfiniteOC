import type { Plugin } from "@opencode/plugin/tui"
import type { FileDiff } from "./logic"

const unwrap = (value: any) => (Array.isArray(value) ? value : (value?.data ?? []))
const firstUser = new Map<string, string>()

/**
 * Net file changes of the whole session: the diff from its first prompt's turn through its last prompt's turn.
 * `session.diff` alone covers only the latest turn, so it is the fallback when the range cannot be diffed
 * (for example after a location switch).
 */
export async function sessionChanges(client: Plugin.Context["client"], sessionID: string, context = 8): Promise<FileDiff[]> {
  const user = async (order: "asc" | "desc") => unwrap(await client.message.list({ sessionID, limit: 1, order, type: "user" }))[0]?.id as string | undefined
  try {
    let from = firstUser.get(sessionID)
    if (!from) {
      from = await user("asc")
      if (from) firstUser.set(sessionID, from)
    }
    const to = await user("desc")
    if (!from || !to) return []
    return unwrap(await client.session.diff({ sessionID, from, to, context }))
  } catch {
    return unwrap(await client.session.diff({ sessionID, context }))
  }
}
