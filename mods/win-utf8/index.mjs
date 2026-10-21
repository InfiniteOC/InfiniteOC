const core = "packages/core/src"

// Windows shells print in the console's legacy code page (cp852, cp1252, …) unless told otherwise,
// while the shell tool decodes their output as UTF-8: every non-ASCII character came back as "?".
// PowerShell gets UTF-8 output encodings before the command (the try: setting the console encoding
// throws in a process without a console); cmd switches its code page first. The exit code stays the
// command's (the last statement), and permission checks still see the original command.
export const patches = [
  [`${core}/shell/select.ts`, `  if (n === "cmd") return ["/c", command]
  if (ps(file)) return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]`, `  if (n === "cmd") return ["/c", \`chcp 65001>nul 2>&1 & \${command}\`]
  if (ps(file))
    return [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      \`try{[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)}catch{};$OutputEncoding=[Text.UTF8Encoding]::new($false);\${command}\`,
    ]`],
]

export default {
  id: "win-utf8",
  version: "1.0.0",
  async setup(api) {
    for (const [path, before, after] of patches) await api.patchExact(path, before, after)
  },
}
