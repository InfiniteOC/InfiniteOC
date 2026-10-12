// Lets plugin code scroll a session view to a message. The session route registers itself here.
const jumps = new Map<string, (messageID: string) => void>()
const last = new Map<string, string>()

export function registerJump(sessionID: string, jump: (messageID: string) => void) {
  jumps.set(sessionID, jump)
  return () => {
    if (jumps.get(sessionID) === jump) jumps.delete(sessionID)
  }
}

export const lastJumped = (sessionID: string) => last.get(sessionID)

/** Waits (up to ~4s) for the session view to mount, then jumps; repeats once after layout settles. */
export function jumpTo(sessionID: string, messageID: string, tries = 40) {
  last.set(sessionID, messageID)
  const jump = jumps.get(sessionID)
  if (!jump) {
    if (tries > 0) setTimeout(() => jumpTo(sessionID, messageID, tries - 1), 100)
    return
  }
  jump(messageID)
  setTimeout(() => jumps.get(sessionID)?.(messageID), 350)
}
