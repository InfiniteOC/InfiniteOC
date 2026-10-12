// License check for vendored code: find the license text or SPDX tags and classify the risk.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const KNOWN: ReadonlyArray<readonly [string, RegExp]> = [
  ["AGPL-3.0", /GNU AFFERO GENERAL PUBLIC LICENSE/i],
  ["LGPL", /GNU LESSER GENERAL PUBLIC LICENSE|GNU LIBRARY GENERAL PUBLIC LICENSE/i],
  ["GPL", /GNU GENERAL PUBLIC LICENSE/i],
  ["MPL-2.0", /Mozilla Public License/i],
  ["Apache-2.0", /Apache License[\s\S]{0,40}Version 2\.0/i],
  ["MIT", /Permission is hereby granted, free of charge/i],
  ["ISC", /Permission to use, copy, modify, and\/or distribute this software for any purpose/i],
  ["BSD", /Redistribution and use in source and binary forms/i],
  ["Unlicense", /This is free and unencumbered software released into the public domain/i],
  ["CC0-1.0", /CC0 1\.0 Universal|Creative Commons Zero/i],
]
export const classifyText = (text: string) => KNOWN.find(([, pattern]) => pattern.test(text))?.[0]

export type Risk = "permissive" | "weak-copyleft" | "copyleft" | "unknown"
export function risk(id: string): Risk {
  if (/AGPL|SSPL|^GPL|GPL-[23]|^GPL$/i.test(id) && !/LGPL/i.test(id)) return "copyleft"
  if (/LGPL|MPL|EPL|CDDL|CC-BY-SA/i.test(id)) return "weak-copyleft"
  if (/^(MIT|ISC|BSD|Apache|Unlicense|CC0|0BSD|Zlib|BlueOak)/i.test(id)) return "permissive"
  return "unknown"
}

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense|notice)(\.[a-z]+)?$/i

/** License evidence for a path: nearest license files going up to `stop`, package.json license, SPDX header tags. */
export function scanLicense(target: string, stop: string) {
  const ids = new Set<string>()
  const evidence: string[] = []
  const add = (id: string | undefined, source: string) => {
    if (!id) return
    ids.add(id)
    evidence.push(`${id} (${source})`)
  }
  let dir = existsSync(target) && statSync(target).isFile() ? path.dirname(target) : target
  const root = path.resolve(stop)
  for (;;) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {}
    for (const name of entries.filter((entry) => LICENSE_FILE.test(entry))) {
      const text = readFileSync(path.join(dir, name), "utf8").slice(0, 20000)
      add(classifyText(text) ?? "unrecognised license text", path.relative(root, path.join(dir, name)))
    }
    const manifest = path.join(dir, "package.json")
    if (existsSync(manifest))
      try {
        const license = JSON.parse(readFileSync(manifest, "utf8")).license
        if (typeof license === "string") add(license, path.relative(root, manifest))
      } catch {}
    if (ids.size > 0 || dir === root || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
  const files = existsSync(target) && statSync(target).isFile() ? [target] : listFiles(target).slice(0, 20)
  for (const file of files) {
    let head = ""
    try {
      head = readFileSync(file, "utf8").split("\n").slice(0, 12).join("\n")
    } catch {}
    const tag = /SPDX-License-Identifier:\s*([A-Za-z0-9.+\- ()]+)/.exec(head)?.[1]?.trim()
    if (tag) add(tag, `SPDX header in ${path.relative(root, file)}`)
    else if (/Copyright|All rights reserved/i.test(head) && ids.size === 0) evidence.push(`copyright notice without license in ${path.relative(root, file)}`)
  }
  return { ids: [...ids], evidence }
}

function listFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return []
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (entry.name === "node_modules" || entry.name === ".git" ? [] : listFiles(path.join(dir, entry.name), depth + 1)) : /\.(m?[jt]sx?|css|py|go|rs|c|h|cpp|java|rb|php)$/.test(entry.name) ? [path.join(dir, entry.name)] : [],
    )
  } catch {
    return []
  }
}

export function formatLicense(target: string, result: ReturnType<typeof scanLicense>, projectLicense?: string) {
  if (result.ids.length === 0)
    return `License check for ${target}: NO LICENSE FOUND${result.evidence.length ? ` (${result.evidence.join("; ")})` : ""}. Code without a license is all rights reserved: do not vendor it without the owner's permission. Find the upstream license or write the code yourself.`
  const worst = result.ids.map(risk).sort((a, b) => ["permissive", "unknown", "weak-copyleft", "copyleft"].indexOf(b) - ["permissive", "unknown", "weak-copyleft", "copyleft"].indexOf(a))[0]
  const advice = {
    permissive: "Permissive: keep the license text and copyright notice with the vendored code.",
    "weak-copyleft": "Weak copyleft: changes to the vendored files must stay under that license; check with the user before modifying them.",
    copyleft: `Copyleft: this can force your project to adopt the same license${projectLicense ? ` (project is ${projectLicense})` : ""}. Ask the user before vendoring it.`,
    unknown: "Unrecognised license: read the text and confirm it permits this use before vendoring.",
  }[worst]
  return `License check for ${target}: ${result.evidence.join("; ")}. ${advice}`
}
