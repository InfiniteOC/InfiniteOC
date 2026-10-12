// Coverage parsing: totals from a test command's output or from a coverage report on disk.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export interface Totals {
  lines: number
  branches?: number
  functions?: number
}

/** Line coverage from the common text reporters: node --test, istanbul/nyc/c8/vitest/jest, coverage.py and pytest-cov. */
export function parseCoverage(text: string): Totals | undefined {
  const flat = text.replace(/\u001b\[[0-9;]*m/g, "")
  // istanbul text table: "All files | stmts | branch | funcs | lines |"
  const table = /^\s*All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/im.exec(flat)
  if (table) return { lines: +table[4], branches: +table[2], functions: +table[3] }
  // node:test: "# all files | 91.45 | 80.00 | 88.89 |" (line, branch, funcs)
  const node = /^[#\s]*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|[ \t]*$/im.exec(flat)
  if (node) return { lines: +node[1], branches: +node[2], functions: +node[3] }
  const summary = /Lines\s*:\s*([\d.]+)%/i.exec(flat)
  if (summary) return { lines: +summary[1], branches: +(/Branches\s*:\s*([\d.]+)%/i.exec(flat)?.[1] ?? NaN) || undefined, functions: +(/Functions\s*:\s*([\d.]+)%/i.exec(flat)?.[1] ?? NaN) || undefined }
  // coverage.py / pytest-cov: "TOTAL   1234    56    95%"
  const py = /^TOTAL\s+\d+\s+\d+(?:\s+\d+\s+\d+)?\s+([\d.]+)%/im.exec(flat)
  if (py) return { lines: +py[1] }
  return undefined
}

export function readReport(root: string): Totals | undefined {
  const json = path.join(root, "coverage", "coverage-summary.json")
  if (existsSync(json))
    try {
      const total = JSON.parse(readFileSync(json, "utf8")).total
      return { lines: total.lines.pct, branches: total.branches?.pct, functions: total.functions?.pct }
    } catch {}
  const lcov = path.join(root, "coverage", "lcov.info")
  if (existsSync(lcov)) {
    let found = 0
    let hit = 0
    for (const line of readFileSync(lcov, "utf8").split("\n")) {
      if (line.startsWith("LF:")) found += +line.slice(3)
      else if (line.startsWith("LH:")) hit += +line.slice(3)
    }
    if (found > 0) return { lines: Math.round((hit / found) * 10000) / 100 }
  }
  return undefined
}

/** A coverage command the project already defines (package.json script, or node's built-in coverage). */
export function detectCommand(packageJson: string | undefined): string | undefined {
  try {
    const scripts = JSON.parse(packageJson ?? "{}").scripts ?? {}
    for (const key of ["coverage", "test:coverage", "test:cov", "cov"]) if (scripts[key]) return `npm run ${key}`
    if (/--test\b/.test(scripts.test ?? "")) return `${scripts.test} --experimental-test-coverage`
    if (/\b(vitest|jest)\b/.test(scripts.test ?? "")) return `npm test -- --coverage`
  } catch {}
  return undefined
}

export const fmtDelta = (before: Totals | undefined, after: Totals) => {
  const now = `${after.lines.toFixed(2)}% lines${after.branches === undefined ? "" : `, ${after.branches.toFixed(2)}% branches`}`
  if (!before) return `Coverage: ${now} (no earlier snapshot to compare with; this one is now the baseline).`
  const delta = after.lines - before.lines
  return `Coverage: ${now}; lines ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} points versus ${before.lines.toFixed(2)}%.${delta < -0.05 ? " Coverage went down: add tests for the new or changed code." : ""}`
}
