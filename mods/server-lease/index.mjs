// The private server (`serve --stdio`) lives while its launcher holds stdin open. The launcher stops it with
// SIGTERM, then exits before its own 3 s SIGKILL fallback runs; stdin closes when it is gone. A shutdown step that
// never finished left the server running with nobody to use it (~300 MB each, found after quitting InfiniTUI).
// Once the lease ends either way, an unref'd timer exits the server: it cannot delay a clean exit, it only ends a
// process that something else keeps alive.
export const EXIT_AFTER_MS = 5000

export const LEASE_EXIT = ["packages/cli/src/server-process.ts", `function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)`, `function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    // InfiniteOC server-lease: once nobody holds the lease, exit even if a shutdown step hangs.
    const exitSoon = () => setTimeout(() => process.exit(0), ${EXIT_AFTER_MS}).unref()
    const close = () => {
      exitSoon()
      resume(Effect.void)
    }
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    // Interrupted: the launcher stopped this server (SIGTERM), and stdin is no longer watched.
    return Effect.sync(() => {
      exitSoon()
      process.stdin.off("end", close)`]

export default {
  id: "server-lease",
  version: "1.0.0",
  async setup(api) {
    await api.patchExact(...LEASE_EXIT)
  },
}
