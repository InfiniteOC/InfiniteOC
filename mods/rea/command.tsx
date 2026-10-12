import type { FeatureContext } from "./api"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const REA_PACKAGE = "rea-agents@4.0.1"
const SKILL_ID = "reverse-engineer-anything"

function configPath() {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config")
  return path.join(base, "opencode", "opencode.json")
}

function skillPath() {
  return path.join(homedir(), ".agents", "skills", SKILL_ID, "SKILL.md")
}

function registrationStatus() {
  const file = configPath()
  try {
    const raw = readFileSync(file, "utf8")
    const value = JSON.parse(raw) as Record<string, unknown>
    const mcp = (value?.mcp ?? {}) as Record<string, unknown>
    const servers = {
      ...((mcp.servers ?? {}) as Record<string, unknown>),
      ...Object.fromEntries(
        Object.entries(mcp).filter(
          ([name, entry]) =>
            name !== "servers" &&
            !!entry &&
            typeof entry === "object" &&
            Array.isArray((entry as Record<string, unknown>).command),
        ),
      ),
    }
    const entry = servers.rea as { command?: unknown } | undefined
    if (!entry) return { file, state: "missing" as const, detail: "no rea entry under mcp.servers" }
    const command = Array.isArray(entry.command) ? entry.command.join(" ") : String(entry.command ?? "")
    const pinned = command.includes("rea-agents@") && command.includes("mcp")
    return { file, state: (pinned ? "pinned" : "present") as const, detail: command || "rea entry without command" }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return { file, state: "missing" as const, detail: "config file does not exist yet" }
    return { file, state: "unreadable" as const, detail: error instanceof Error ? error.message : String(error) }
  }
}

const SETUP_PLAN = [
  `# Read-only diagnosis (no writes):`,
  `npx -y ${REA_PACKAGE} doctor --client opencode --json`,
  ``,
  `# Read-only plan (shows paths, backups, changes; exit 0, nothing applied):`,
  `npx -y ${REA_PACKAGE} setup --client opencode --dry-run --json`,
  ``,
  `# After you approve the exact plan, apply that scope and restart:`,
  `npx -y ${REA_PACKAGE} setup --client opencode --yes`,
  ``,
  `Setup pins MCP to the exact version, installs the matching skill, keeps backups,`,
  `and preserves unrelated config. Never add --install-hopper unless Hopper was`,
  `needed and explicitly approved. REA never installs Node/npm/Java/Ghidra.`,
].join("\n")

const CLI_FALLBACK = [
  `# No MCP registration or engine needed for static JS/ASAR:`,
  `npx -y ${REA_PACKAGE} analyze-javascript-application /absolute/path/to/app --json`,
  ``,
  `# Native targets still need their selected engine (Hopper or bring-your-own Ghidra).`,
  `# Check engines without changing anything:`,
  `npx -y ${REA_PACKAGE} doctor --json`,
  `npx -y ${REA_PACKAGE} providers --json`,
].join("\n")

export async function run(ctx: FeatureContext) {
  if (!ctx.ui) {
    ctx.toast.show({ variant: "warning", title: "/rea", message: "Rebuild and restart InfiniteOC to use /rea" })
    return
  }
  for (;;) {
    const choice = await ctx.ui.select({
      title: "REA · reverse-engineer shipped apps (npm package, repo untouched)",
      options: [
        { title: "Show status", value: "status", description: "config registration + skill file, read-only" },
        { title: "Show setup plan", value: "setup", description: "dry-run first, approval required" },
        { title: "Show CLI fallback", value: "cli", description: "JS/ASAR without MCP or engine" },
        { title: "Close", value: "close" },
      ],
    })
    if (!choice || choice === "close") return
    ctx.ui.set({ size: "large" })
    if (choice === "status") {
      const reg = registrationStatus()
      const skill = skillPath()
      const skillState = existsSync(skill) ? `present: ${skill}` : `missing: ${skill} (setup installs it)`
      await ctx.ui.alert({
        title: "REA status (read-only)",
        message: [
          `Package: npx -y ${REA_PACKAGE} mcp (the REA source checkout is never used)`,
          `Config: ${reg.file}`,
          `Registration: ${reg.state} · ${reg.detail}`,
          `Skill: ${skillState}`,
          ``,
          `Static JS inspection needs no engine. Native analysis needs Hopper`,
          `or bring-your-own Ghidra 12.1.4 + JDK 21. doctor may report an`,
          `unsupported host on Arch derivatives; JS/CLI work still applies.`,
          `If tools are absent, use Show setup plan, approve, then restart.`,
        ].join("\n"),
      })
    } else if (choice === "setup") {
      await ctx.ui.alert({ title: "REA setup · approval required, nothing applied here", message: SETUP_PLAN })
    } else if (choice === "cli") {
      await ctx.ui.alert({ title: "REA CLI fallback (no MCP, no engine for JS)", message: CLI_FALLBACK })
    }
  }
}
