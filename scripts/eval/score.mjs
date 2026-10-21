// Label-based browser QA for the expense-tracker task (task-expense-tracker.md): finds fields by their
// labels and buttons by their names, so any implementation of the task can be scored. Prints PASS/FAIL per
// check and "SCORE n/22". Needs Playwright with Chromium (PLAYWRIGHT_MODULE, a local or the global install).
// Usage: node scripts/eval/score.mjs URL [screenshot-dir]
import { createRequire } from "node:module"
import { execSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"]
  try { candidates.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright")) } catch {}
  for (const id of candidates.filter(Boolean)) { try { return require(id) } catch {} }
  throw new Error("Playwright not found: npm i -g playwright (or set PLAYWRIGHT_MODULE to its folder)")
}
// The same built-in audit ui_check runs (mods/qual-checks/lib/browser.ts), evaluated from its template literal.
function basicAudit() {
  const source = fs.readFileSync(new URL("../../mods/qual-checks/lib/browser.ts", import.meta.url), "utf8")
  const start = source.indexOf("export const BASIC_AUDIT = `") + "export const BASIC_AUDIT = `".length
  const end = source.indexOf("`\n\nconst DIFF_SCRIPT", start)
  if (start < 30 || end < 0) throw new Error("BASIC_AUDIT not found in mods/qual-checks/lib/browser.ts")
  return new Function(`return \`${source.slice(start, end)}\``)()
}
const { chromium } = loadPlaywright()
const AUDIT = basicAudit()
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` }
const U = process.argv[2], OUT = process.argv[3]
const results = []
const check = async (name, fn) => { try { const r = await fn(); results.push([name, r === true, r === true ? "" : String(r)]) } catch (e) { results.push([name, false, e.message.split("\n")[0].slice(0, 120)]) } }
const br = await chromium.launch()
const ctx = await br.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true })
const pg = await ctx.newPage(); const errs = []; let dialogs = 0
pg.on("console", m => m.type() === "error" && errs.push(m.text())); pg.on("pageerror", e => errs.push(String(e))); pg.on("dialog", d => { dialogs++; d.dismiss() })
await pg.goto(U); await pg.waitForTimeout(300)
const form = pg.locator("form").first()
const field = (re) => form.getByLabel(re).first()
const submit = form.locator("button[type=submit], button:not([type])").first()
const filterSelect = async (want) => { for (const s of await pg.locator("select").all()) { if (await s.evaluate((el, w) => [...el.options].some(o => o.value === w || o.textContent.trim() === w), want)) if (!(await form.locator("select").evaluateAll((els, x) => els.includes(x), await s.elementHandle()))) return s } }
const rowsText = () => pg.locator("body").innerText()
const add = async (a, d, c, dt) => {
  await field(/amount/i).fill(a); await field(/description/i).fill(d); await field(/category/i).selectOption(c); await field(/date/i).fill(dt); await submit.click(); await pg.waitForTimeout(80)
}
const totalText = async () => (await rowsText()).match(/total[^$\d]*\$?\s?([\d,]+\.\d{2})/i)?.[1]

await check("loads without console errors", async () => errs.length === 0 || errs.join(" | "))
await check("default date is today", async () => (await field(/date/i).inputValue()) === today() || await field(/date/i).inputValue())
await check("empty submit: inline errors, no alert()", async () => {
  await field(/amount/i).fill(""); await field(/description/i).fill(""); await submit.click(); await pg.waitForTimeout(100)
  const shown = await pg.locator("[role=alert], [aria-live], .error, [id*=error]").evaluateAll(els => els.filter(e => e.textContent.trim()).length)
  return (shown >= 2 && dialogs === 0) || `errors shown: ${shown}, alerts: ${dialogs}`
})
await check("invalid amounts rejected (12.345, -5, 0)", async () => {
  const before = await rowsText()
  for (const bad of ["12.345", "-5", "0"]) { await field(/amount/i).fill(bad).catch(() => {}); await field(/description/i).fill(`bad ${bad}`); await field(/category/i).selectOption("Food"); await submit.click(); await pg.waitForTimeout(60) }
  const after = await rowsText()
  return !/bad (12\.345|-5|0)\b/.test(after.replace(before, "")) || "an invalid amount was saved"
})
await check("focus moves to the first invalid field", async () => {
  await pg.reload(); await field(/amount/i).fill(""); await submit.click(); await pg.waitForTimeout(100)
  return (await field(/amount/i).evaluate(el => el === document.activeElement)) || `focus on ${await pg.evaluate(() => document.activeElement.id || document.activeElement.tagName)}`
})
await check("errors linked to fields (aria-describedby or aria-invalid)", async () => (await field(/amount/i).evaluate(el => el.hasAttribute("aria-describedby") || el.getAttribute("aria-invalid") === "true")) || "no aria link")
await add("12.50", 'Lunch, "big" one', "Food", "2026-10-03"); await add("0.1", "Gum", "Food", "2026-10-04"); await add("0.2", "Mint", "Food", "2026-10-05")
await add("1200", "Rent", "Housing", "2026-10-01"); await add("30", "Bus pass", "Transport", "2026-09-15"); await add("0.4", "Sticker", "Fun", "2026-09-20")
await check("six expenses listed", async () => { const t = await rowsText(); const missing = ['Lunch, "big" one', "Gum", "Mint", "Rent", "Bus pass", "Sticker"].filter(d => !t.includes(d)); return missing.length === 0 || `missing ${missing}` })
await check("total of all = 1243.20", async () => (await totalText())?.replace(",", "") === "1243.20" || `total ${await totalText()}`)
await check("month filter 2026-09 → total 30.40", async () => { const s = await filterSelect("2026-09"); if (!s) return "no month select with 2026-09"; await s.selectOption("2026-09"); await pg.waitForTimeout(80); const t = await totalText(); await s.selectOption({ index: 0 }); return t === "30.40" || `total ${t}` })
await check("edit Gum → 2.00", async () => {
  const row = pg.locator("li, tr, .expense, [class*=item], [class*=row]").filter({ hasText: "Gum" }).last()
  await row.getByRole("button", { name: /edit/i }).click(); await field(/amount/i).fill("2"); await submit.click(); await pg.waitForTimeout(80)
  return /Gum[\s\S]{0,80}2\.00|2\.00[\s\S]{0,80}Gum/.test(await rowsText()) || "edit not applied"
})
await check("edit, then delete the same row, then submit: no ghost save", async () => {
  const row = () => pg.locator("li, tr, .expense, [class*=item], [class*=row]").filter({ hasText: "Sticker" }).last()
  await row().getByRole("button", { name: /edit/i }).click(); await row().getByRole("button", { name: /delete|remove/i }).click(); await pg.waitForTimeout(80)
  await field(/amount/i).fill("9"); await field(/description/i).fill("Ghost"); await field(/category/i).selectOption("Fun"); await submit.click(); await pg.waitForTimeout(80)
  const t = await rowsText(); return !t.includes("Sticker") || "deleted row still shown"
})
await check("CSV export quotes commas and quotes", async () => {
  const [dl] = await Promise.all([pg.waitForEvent("download", { timeout: 3000 }), pg.getByRole("button", { name: /export|csv/i }).first().click()])
  const csv = fs.readFileSync(await dl.path(), "utf8"); return csv.includes('"Lunch, ""big"" one"') || csv.slice(0, 200)
})
const key = await pg.evaluate(() => Object.keys(localStorage)[0])
await check("survives reload", async () => { await pg.reload(); await pg.waitForTimeout(200); return (await rowsText()).includes("Rent") || "data lost" })
await check("corrupt storage: still renders", async () => { await pg.evaluate(k => localStorage.setItem(k, "{not json"), key); await pg.reload(); await pg.waitForTimeout(200); return (await form.count()) === 1 && errs.filter(e => !/JSON/.test(e)).length === 0 || `errors ${errs}` })
await check("invalid stored entries filtered out", async () => {
  await pg.evaluate(k => localStorage.removeItem(k), key); await pg.reload(); await add("5", "Valid one", "Food", "2026-10-01")
  const saved = await pg.evaluate(k => localStorage.getItem(k), key); const arr = JSON.parse(saved); const base = Array.isArray(arr) ? arr[0] : null
  if (!base) return "unknown storage shape"
  const bad = { ...base, amount: -7, date: "nope" }; if ("id" in bad) bad.id = String(bad.id) + "x"; if ("description" in bad) bad.description = "Bogus"
  await pg.evaluate(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify([base, bad])]); await pg.reload(); await pg.waitForTimeout(200)
  return !(await rowsText()).includes("Bogus") || "invalid entry shown"
})
await check("deleting one of two id-less stored entries keeps the other", async () => {
  const arr = JSON.parse(await pg.evaluate(k => localStorage.getItem(k), key)); const base = arr[0]
  const strip = (d) => { const o = { ...base, description: d }; delete o.id; return o }
  await pg.evaluate(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify([strip("Alpha one"), strip("Beta two")])]); await pg.reload(); await pg.waitForTimeout(200)
  const row = pg.locator("li, tr, .expense, [class*=item], [class*=row]").filter({ hasText: "Alpha one" }).last()
  if (!(await rowsText()).includes("Alpha one")) return "id-less entries not shown (acceptable migration?)"
  await row.getByRole("button", { name: /delete|remove/i }).click(); await pg.waitForTimeout(100)
  const t = await rowsText(); return (!t.includes("Alpha one") && t.includes("Beta two")) || `after delete: alpha ${t.includes("Alpha one")}, beta ${t.includes("Beta two")}`
})
await check("row buttons name their expense (accessible names differ)", async () => {
  const names = await pg.getByRole("button", { name: /edit/i }).evaluateAll(bs => bs.map(b => b.getAttribute("aria-label") || b.title || b.textContent.trim()))
  return (names.length > 0 && new Set(names).size === names.length) || `names: ${[...new Set(names)].slice(0, 3)}`
})
await check("chart canvas draws something", async () => {
  const blank = await pg.locator("canvas").first().evaluate(c => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false; return true })
  return !blank || "canvas is blank"
})
await check("375px: no horizontal overflow", async () => { await pg.setViewportSize({ width: 375, height: 800 }); await pg.waitForTimeout(150); return !(await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth)) || "overflows" })
for (const scheme of ["light", "dark"]) await check(`${scheme} mode: text contrast meets WCAG AA`, async () => {
  const c = await br.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: scheme }); const p = await c.newPage(); await p.goto(U)
  await p.evaluate(([k, v]) => localStorage.setItem(k, v), [key, await pg.evaluate(k => localStorage.getItem(k), key)]); await p.reload(); await p.waitForTimeout(300)
  const found = JSON.parse(await p.evaluate(AUDIT)).filter(v => v.id === "color-contrast"); await c.close()
  return found.length === 0 || found[0].help
})
await check("keyboard: first Tab lands on a form control", async () => { await pg.setViewportSize({ width: 1200, height: 900 }); await pg.reload(); await pg.keyboard.press("Tab"); return (await pg.evaluate(() => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(document.activeElement.tagName))) || "focus elsewhere" })
if (OUT) {
  for (const [name, opts] of [["mobile", { viewport: { width: 375, height: 1600 }, deviceScaleFactor: 2 }], ["dark", { viewport: { width: 1200, height: 1400 }, colorScheme: "dark" }]]) {
    const c = await br.newContext(opts); const p = await c.newPage(); await p.goto(U)
    await p.evaluate(([k, v]) => localStorage.setItem(k, v), [key, await pg.evaluate(k => localStorage.getItem(k), key)]); await p.reload(); await p.waitForTimeout(300)
    await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }); await c.close()
  }
}
await br.close()
const passed = results.filter(r => r[1]).length
for (const [n, ok, why] of results) console.log(ok ? "PASS" : "FAIL", n, why ? `— ${why}` : "")
console.log(`SCORE ${passed}/${results.length}`)
