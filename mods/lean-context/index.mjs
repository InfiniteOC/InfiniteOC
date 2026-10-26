const core = "packages/core/src"

// Every request re-sends the system prompt, so these trims pay off on each step:
// - Skill catalog: one line per skill with the description's first sentence (≤160 chars) instead of five
//   XML lines with the full trigger text. Loading a skill still returns its full instructions, and the
//   change diff still compares full descriptions, so updates are announced exactly as before.
// - Code Mode: a smaller inline budget, so rarely used `opencode.*` signatures are found with the
//   upstream `search(...)` helper inside `execute` instead of being listed on every request.
export const SKILL_ENTRIES = [`const entries = (skills: ReadonlyArray<Summary>) =>
  skills.flatMap((skill) => [
    "  <skill>",
    \`    <id>\${skill.id}</id>\`,
    \`    <name>\${skill.name}</name>\`,
    \`    <description>\${skill.description}</description>\`,
    "  </skill>",
  ])`, `// InfiniteOC lean-context: first sentence, capped, is enough to choose a skill; loading returns the rest.
const brief = (text: string) => {
  const flat = text.replace(/\\s+/g, " ").trim()
  const sentence = /^.{20,}?[.!?](?=\\s|$)/.exec(flat)?.[0] ?? flat
  return sentence.length > 160 ? \`\${sentence.slice(0, 157).trimEnd()}...\` : sentence
}

const entries = (skills: ReadonlyArray<Summary>) =>
  skills.map((skill) => \`- \${skill.id}\${(skill.name as string) === skill.id ? "" : \` (\${skill.name})\`}: \${brief(skill.description)}\`)`]

// 0: namespace lines only (`rea (116 tools, none shown)`); search(...) inside execute finds a tool, which large MCP
// namespaces needed anyway. Pinned tools still show.
export const CODEMODE_BUDGET = ["const INLINE_BUDGET = 2_000", "const INLINE_BUDGET = 0"]

export const patches = [
  [`${core}/skill/instructions.ts`, ...SKILL_ENTRIES],
  [`${core}/codemode/catalog.ts`, ...CODEMODE_BUDGET],
]

export default {
  id: "lean-context",
  version: "1.0.0",
  async setup(api) {
    for (const [file, before, after] of patches) await api.patchExact(file, before, after)
  },
}
