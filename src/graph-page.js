// The graph page: a small force-directed layout on a canvas (no dependencies, so it works offline and under a
// strict CSP), a side panel for reading and editing, and a list view for keyboard and screen-reader use.
const $ = (id) => document.getElementById(id)
const canvas = $("graph")
const ctx = canvas.getContext("2d")
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches

// The token arrives in the #fragment once; keep it for this tab only and take it out of the address bar.
let token = location.hash.slice(1)
if (token) { sessionStorage.setItem("ioc-graph", token); history.replaceState(null, "", location.pathname) } else token = sessionStorage.getItem("ioc-graph") ?? ""

const TYPES = {
  project: { label: "Projects", radius: 10 },
  session: { label: "Sessions", radius: 4.5 },
  note: { label: "Notes", radius: 7 },
  memory: { label: "Memory", radius: 4.5 },
  glossary: { label: "Glossary", radius: 4.5 },
  doc: { label: "AGENTS.md", radius: 5.5 },
  tag: { label: "Tags", radius: 4.5 },
  ghost: { label: "Unwritten links", radius: 4.5 },
}
const FILTERS = ["session", "note", "memory", "glossary", "doc", "tag", "ghost", "temp"]
const shown = { session: true, note: true, memory: true, glossary: true, doc: true, tag: true, ghost: true, temp: false }
const colors = {}
const readColors = () => {
  const style = getComputedStyle(document.documentElement)
  for (const type of Object.keys(TYPES)) colors[type] = style.getPropertyValue(`--${type}`).trim()
  for (const name of ["edge", "text", "muted", "bg", "accent", "accent-2", "focus"]) colors[name] = style.getPropertyValue(`--${name}`).trim()
}
readColors()
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { readColors(); draw() })

let nodes = []
let links = []
let byId = new Map()
let neighbors = new Map()
let visible = []
let visibleLinks = []
let stats = {}
let selected
let hovered
let query = ""
const camera = { x: 0, y: 0, k: 1 }
let alpha = 1
let frame = 0

// ---- data -------------------------------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.body ? { "content-type": "application/json" } : {}) } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

function status(text, error = false) {
  const box = $("status")
  box.textContent = text
  box.classList.toggle("error", error)
  box.hidden = !text
  clearTimeout(status.timer)
  if (text && !error) status.timer = setTimeout(() => (box.hidden = true), 2500)
}

async function load(fresh = false) {
  if (!token) return status("Open the link printed by infiniteoc graph (it carries the access token).", true)
  try {
    const data = await api(`/api/graph${fresh ? "?fresh=1" : ""}`)
    const previous = byId
    const same = previous.size === data.nodes.length && data.nodes.every((node) => previous.has(node.id)) && links.length === data.links.length
    nodes = data.nodes.map((node) => ({ ...node, ...(previous.get(node.id) && { x: previous.get(node.id).x, y: previous.get(node.id).y }), vx: 0, vy: 0 }))
    links = data.links
    stats = data.stats
    byId = new Map(nodes.map((node) => [node.id, node]))
    neighbors = new Map(nodes.map((node) => [node.id, new Set()]))
    for (const link of links) { neighbors.get(link.source)?.add(link.target); neighbors.get(link.target)?.add(link.source) }
    place()
    applyFilters(previous.size === 0, !same)
    if (selected) select(byId.get(selected.id), false)
  } catch (error) {
    status(error.message, true)
  }
}

/** New nodes start near what they link to, so the layout settles quickly and stays stable on refresh. */
function place() {
  const projects = nodes.filter((node) => node.type === "project")
  const ring = 120 + 30 * Math.sqrt(projects.length)
  projects.forEach((node, index) => {
    if (node.x !== undefined) return
    const angle = (index / Math.max(1, projects.length)) * Math.PI * 2
    node.x = Math.cos(angle) * ring * (0.6 + Math.random() * 0.4)
    node.y = Math.sin(angle) * ring * (0.6 + Math.random() * 0.4)
  })
  for (const node of nodes) {
    if (node.x !== undefined) continue
    const anchor = [...(neighbors.get(node.id) ?? [])].map((id) => byId.get(id)).find((other) => other?.x !== undefined)
    node.x = (anchor?.x ?? 0) + (Math.random() - 0.5) * 60
    node.y = (anchor?.y ?? 0) + (Math.random() - 0.5) * 60
  }
}

const projectOf = (node) => (node.type === "project" ? node : [...(neighbors.get(node.id) ?? [])].map((id) => byId.get(id)).find((other) => other?.type === "project"))

function isVisible(node) {
  if (node.type === "project") return shown.temp || !node.temp
  if (!shown[node.type]) return false
  const project = projectOf(node)
  return !project || shown.temp || !project.temp
}

function applyFilters(fit = false, moved = true) {
  visible = nodes.filter(isVisible)
  const ids = new Set(visible.map((node) => node.id))
  visibleLinks = links.filter((link) => ids.has(link.source) && ids.has(link.target)).map((link) => ({ ...link, a: byId.get(link.source), b: byId.get(link.target) }))
  for (const node of visible) node.degree = neighbors.get(node.id)?.size ?? 0
  renderChips()
  renderLegend()
  renderStats()
  if (!$("list").hidden) renderList()
  if (moved) reheat(fit ? 1 : 0.5)
  else draw()
  if (fit) settleThenFit()
}

// ---- layout -----------------------------------------------------------------------------------------

function tick() {
  const count = visible.length
  for (let i = 0; i < count; i++) {
    const a = visible[i]
    for (let j = i + 1; j < count; j++) {
      const b = visible[j]
      let dx = a.x - b.x
      let dy = a.y - b.y
      let d2 = dx * dx + dy * dy
      if (d2 > 250000) continue
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
      const force = (a.type === "project" && b.type === "project" ? 1800 : 420) * alpha / d2
      a.vx += dx * force; a.vy += dy * force
      b.vx -= dx * force; b.vy -= dy * force
    }
  }
  for (const link of visibleLinks) {
    const { a, b } = link
    const dx = b.x - a.x
    const dy = b.y - a.y
    const distance = Math.sqrt(dx * dx + dy * dy) || 1
    const rest = link.kind === "session" ? 46 : link.kind === "wikilink" ? 90 : 60
    const force = ((distance - rest) / distance) * 0.06 * alpha
    const share = (b.degree || 1) / ((a.degree || 1) + (b.degree || 1))
    a.vx += dx * force * share; a.vy += dy * force * share
    b.vx -= dx * force * (1 - share); b.vy -= dy * force * (1 - share)
  }
  for (const node of visible) {
    node.vx -= node.x * 0.02 * alpha
    node.vy -= node.y * 0.02 * alpha
    if (node.fx !== undefined) { node.x = node.fx; node.y = node.fy; node.vx = node.vy = 0; continue }
    node.vx *= 0.62; node.vy *= 0.62
    node.x += node.vx; node.y += node.vy
  }
  alpha *= 0.982
}

function reheat(value) {
  alpha = Math.max(alpha, value)
  if (!frame) frame = requestAnimationFrame(loop)
}

function loop() {
  frame = 0
  if (alpha > 0.004) { tick(); frame = requestAnimationFrame(loop) }
  draw()
}

function settleThenFit() {
  // Most of the layout happens in the first few hundred ticks; run them off-screen, then frame the result.
  for (let i = 0; i < 260 && alpha > 0.02; i++) tick()
  fit(false)
}

// ---- drawing ----------------------------------------------------------------------------------------

const radius = (node) => TYPES[node.type].radius + (node.type === "project" ? Math.min(10, Math.sqrt(node.degree || 0) * 1.6) : 0)

// The toolbar wraps differently per width and filter set: keep the panels just below it.
new ResizeObserver(() => document.documentElement.style.setProperty("--bar", `${Math.round(document.querySelector(".bar").getBoundingClientRect().bottom)}px`)).observe(document.querySelector(".bar"))

function resize() {
  const dpr = devicePixelRatio || 1
  canvas.width = Math.round(innerWidth * dpr)
  canvas.height = Math.round(innerHeight * dpr)
  draw()
}

const toScreen = (x, y) => [(x - camera.x) * camera.k + innerWidth / 2, (y - camera.y) * camera.k + innerHeight / 2]
const toWorld = (sx, sy) => [(sx - innerWidth / 2) / camera.k + camera.x, (sy - innerHeight / 2) / camera.k + camera.y]

function matches(node) {
  return query && (node.label.toLowerCase().includes(query) || (node.path ?? "").toLowerCase().includes(query) || (node.body ?? "").toLowerCase().includes(query))
}

function draw() {
  const dpr = devicePixelRatio || 1
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.setTransform(camera.k * dpr, 0, 0, camera.k * dpr, (innerWidth / 2 - camera.x * camera.k) * dpr, (innerHeight / 2 - camera.y * camera.k) * dpr)
  const focus = hovered ?? selected
  const near = focus ? neighbors.get(focus.id) ?? new Set() : undefined
  // A selection (or hover) shows its neighbourhood; otherwise a search shows its matches.
  const lit = (node) => (focus ? node === focus || near.has(node.id) : !query || matches(node))

  ctx.lineWidth = 1 / camera.k
  for (const link of visibleLinks) {
    const on = focus && (link.a === focus || link.b === focus)
    ctx.globalAlpha = focus ? (on ? 0.9 : 0.06) : query ? 0.08 : 1
    ctx.strokeStyle = on ? colors.accent : colors.edge
    ctx.beginPath(); ctx.moveTo(link.a.x, link.a.y); ctx.lineTo(link.b.x, link.b.y); ctx.stroke()
  }
  for (const node of visible) {
    const r = radius(node)
    ctx.globalAlpha = lit(node) ? (node.temp || node.type === "ghost" ? 0.55 : 1) : 0.12
    ctx.fillStyle = colors[node.type]
    ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, Math.PI * 2); ctx.fill()
    if (node === selected || (query && matches(node))) {
      ctx.globalAlpha = 1
      ctx.lineWidth = 2 / camera.k
      ctx.strokeStyle = node === selected ? colors.focus : colors["accent-2"]
      ctx.beginPath(); ctx.arc(node.x, node.y, r + 3 / camera.k, 0, Math.PI * 2); ctx.stroke()
      ctx.lineWidth = 1 / camera.k
    }
  }

  // Labels in screen space so they stay readable at any zoom; minor nodes only when zoomed in or in focus.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  for (const node of visible) {
    const inFocus = focus && (node === focus || near.has(node.id))
    const major = node.type === "project" || node.type === "note"
    if (!(inFocus || (query && matches(node)) || (major && camera.k > 0.2) || camera.k > 1.5)) continue
    if (focus && !inFocus && !(query && matches(node))) continue
    const [sx, sy] = toScreen(node.x, node.y)
    if (sx < -100 || sy < -40 || sx > innerWidth + 100 || sy > innerHeight + 40) continue
    ctx.globalAlpha = lit(node) ? 1 : 0.25
    ctx.font = `${node.type === "project" ? 600 : 400} ${node.type === "project" ? 12.5 : 11.5}px ui-sans-serif, system-ui, sans-serif`
    const text = node.label.length > 34 ? `${node.label.slice(0, 33)}…` : node.label
    ctx.lineWidth = 3
    ctx.strokeStyle = colors.bg
    ctx.strokeText(text, sx, sy + radius(node) * camera.k + 4)
    ctx.fillStyle = node === focus ? colors.text : node.type === "project" ? colors.text : colors.muted
    ctx.fillText(text, sx, sy + radius(node) * camera.k + 4)
  }
  ctx.globalAlpha = 1
}

function fit(animate = true) {
  if (!visible.length) return draw()
  const xs = visible.map((node) => node.x)
  const ys = visible.map((node) => node.y)
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const bar = document.querySelector(".bar").getBoundingClientRect().bottom
  const k = Math.max(0.15, Math.min(2.2, Math.min((innerWidth - 80) / (maxX - minX + 1), (innerHeight - bar - 80) / (maxY - minY + 1))))
  moveCamera((minX + maxX) / 2, (minY + maxY) / 2 - (bar - 30) / 2 / k, k, animate)
}

function moveCamera(x, y, k = camera.k, animate = true) {
  if (!animate || reduced) { Object.assign(camera, { x, y, k }); return draw() }
  const from = { ...camera }
  const start = performance.now()
  const step = (now) => {
    const t = Math.min(1, (now - start) / 320)
    const e = 1 - Math.pow(1 - t, 3)
    camera.x = from.x + (x - from.x) * e
    camera.y = from.y + (y - from.y) * e
    camera.k = from.k + (k - from.k) * e
    draw()
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

// ---- pointer ----------------------------------------------------------------------------------------

function nodeAt(sx, sy) {
  const [x, y] = toWorld(sx, sy)
  let best
  let bestDistance = Infinity
  for (const node of visible) {
    const d = Math.hypot(node.x - x, node.y - y)
    if (d < radius(node) + 5 / camera.k && d < bestDistance) { best = node; bestDistance = d }
  }
  return best
}

let drag
canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId)
  const node = nodeAt(event.offsetX, event.offsetY)
  drag = { node, x: event.offsetX, y: event.offsetY, cx: camera.x, cy: camera.y, moved: false }
  canvas.classList.add("dragging")
})
canvas.addEventListener("pointermove", (event) => {
  if (!drag) {
    const node = nodeAt(event.offsetX, event.offsetY)
    if (node !== hovered) { hovered = node; canvas.classList.toggle("pointing", Boolean(node)); draw() }
    return
  }
  const dx = event.offsetX - drag.x
  const dy = event.offsetY - drag.y
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
  if (!drag.moved) return
  if (drag.node) {
    const [x, y] = toWorld(event.offsetX, event.offsetY)
    drag.node.fx = x; drag.node.fy = y
    reheat(0.3)
  } else {
    camera.x = drag.cx - dx / camera.k
    camera.y = drag.cy - dy / camera.k
    draw()
  }
})
const endDrag = () => {
  if (!drag) return
  if (drag.node) { delete drag.node.fx; delete drag.node.fy }
  if (!drag.moved) select(drag.node)
  drag = undefined
  canvas.classList.remove("dragging")
}
canvas.addEventListener("pointerup", endDrag)
canvas.addEventListener("pointercancel", endDrag)
canvas.addEventListener("pointerleave", () => { if (!drag && hovered) { hovered = undefined; draw() } })
canvas.addEventListener("dblclick", (event) => { if (!nodeAt(event.offsetX, event.offsetY)) fit() })
canvas.addEventListener("wheel", (event) => {
  event.preventDefault()
  const [x, y] = toWorld(event.offsetX, event.offsetY)
  const k = Math.max(0.1, Math.min(6, camera.k * Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))))
  camera.x = x - (event.offsetX - innerWidth / 2) / k
  camera.y = y - (event.offsetY - innerHeight / 2) / k
  camera.k = k
  draw()
}, { passive: false })

// ---- panel ------------------------------------------------------------------------------------------

const escape = (text) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

/** Resolves a [[link]] the way the server does: note title/slug, then project name or folder. */
function resolveLink(target) {
  const want = target.trim().toLowerCase()
  const slug = want.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return nodes.find((node) => node.type === "note" && (node.label.toLowerCase() === want || node.slug === want || node.slug === slug))
    ?? nodes.find((node) => node.type === "project" && (node.label.toLowerCase() === want || node.path.split(/[\\/]/).pop().toLowerCase() === want))
    ?? byId.get(`x:${want}`)
}

/** True when an (HTML-escaped) [[link]] target names an existing note or project, not a placeholder. */
const written = (escaped) => {
  const node = resolveLink(escaped.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
  return Boolean(node) && node.type !== "ghost"
}

/** A small, escape-first markdown subset: headings, lists, code, emphasis, links, [[wikilinks]], #tags. */
function markdown(text) {
  const out = []
  let list = false
  const inline = (line) => escape(line)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => `<button type="button" class="wikilink${written(target) ? "" : " missing"}" data-link="${target}">${label ?? target}</button>`)
    .replace(/(^|\s)#([A-Za-z][\w/-]*)/g, '$1<span class="tag">#$2</span>')
  const parts = text.split(/```/)
  parts.forEach((part, index) => {
    if (index % 2 === 1) { out.push(`<pre><code>${escape(part.replace(/^[^\n]*\n/, ""))}</code></pre>`); return }
    for (const raw of part.split("\n")) {
      const line = raw.trimEnd()
      const item = /^\s*[-*]\s+(.*)$/.exec(line)
      if (item) { if (!list) { out.push("<ul>"); list = true } out.push(`<li>${inline(item[1])}</li>`); continue }
      if (list) { out.push("</ul>"); list = false }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line)
      if (heading) out.push(`<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`)
      else if (line) out.push(`<p>${inline(line)}</p>`)
    }
    if (list) { out.push("</ul>"); list = false }
  })
  return out.join("")
}

const typeLabel = { project: "Project", session: "Session", note: "Note", memory: "Memory", glossary: "Glossary", doc: "Project instructions", tag: "Tag", ghost: "Unwritten link" }

function button(text, onClick, kind = "ghost") {
  const element = document.createElement("button")
  element.type = "button"
  element.className = kind
  element.textContent = text
  element.addEventListener("click", onClick)
  return element
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); status(`Copied ${what}`) } catch { status(text) }
}

async function select(node, center = true) {
  selected = node
  draw()
  const panel = $("panel")
  if (!node) { panel.hidden = true; return }
  panel.hidden = false
  $("panel-type").textContent = typeLabel[node.type]
  $("panel-type").dataset.type = node.type
  $("panel-title").textContent = node.label
  $("panel-path").textContent = node.type === "note" ? node.project ?? "" : node.type === "session" ? node.session : node.path ?? ""
  const actions = $("panel-actions")
  actions.replaceChildren()
  const body = $("panel-body")
  body.replaceChildren()
  if (node.type === "project") {
    actions.append(button("New note here", () => openEditor(undefined, node.path), "primary"), button("Copy launch command", () => copy(`infiniteoc ${JSON.stringify(node.path)}`, "the launch command")))
    body.innerHTML = markdown(`${node.sessions} session${node.sessions === 1 ? "" : "s"}${node.temp ? " · temporary or deleted directory" : ""}${node.active ? ` · last active ${new Date(node.active).toLocaleString()}` : ""}`)
  } else if (node.type === "session") {
    actions.append(button("Copy resume command", () => copy(`infiniteoc -s ${node.session}`, "the resume command")))
    body.innerHTML = markdown(`Updated ${new Date(node.updated).toLocaleString()}${node.cost ? ` · $${node.cost.toFixed(2)}` : ""}\n\nIn \`${node.path ?? ""}\``)
  } else if (node.type === "note") {
    actions.append(button("Edit", () => openEditor(node), "primary"))
    body.innerHTML = markdown(node.body || "*Empty note*")
  } else if (node.type === "memory" || node.type === "glossary") {
    body.innerHTML = markdown(node.body)
  } else if (node.type === "doc") {
    body.textContent = "Loading…"
    api(`/api/doc?id=${encodeURIComponent(node.id)}`).then((doc) => { if (selected === node) body.innerHTML = markdown(doc.body) }, (error) => { if (selected === node) body.textContent = error.message })
  } else if (node.type === "ghost") {
    actions.append(button(`Write “${node.label}”`, () => openEditor(undefined, undefined, node.label), "primary"))
  }
  const list = $("panel-links")
  list.replaceChildren()
  const linked = [...(neighbors.get(node.id) ?? [])].map((id) => byId.get(id)).filter(Boolean).sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
  $("panel-links-title").hidden = !linked.length
  for (const other of linked.slice(0, 200)) {
    const item = document.createElement("li")
    const go = button("", () => select(other))
    go.className = ""
    go.innerHTML = `<span class="dot" data-type="${other.type}"></span><span class="label"></span>`
    go.querySelector(".label").textContent = `${other.label}`
    go.title = `${typeLabel[other.type]}: ${other.label}`
    item.append(go)
    list.append(item)
  }
  if (center && node.x !== undefined && isVisible(node)) moveCamera(node.x + (innerWidth > 760 ? 160 / camera.k : 0), node.y, Math.max(camera.k, 0.9))
}

$("panel-body").addEventListener("click", (event) => {
  const target = event.target.closest(".wikilink")
  if (!target) return
  const node = resolveLink(target.dataset.link)
  if (node) select(node)
  else openEditor(undefined, undefined, target.dataset.link)
})
$("panel-close").addEventListener("click", () => select(undefined))

// ---- editing notes ----------------------------------------------------------------------------------

let editing
function openEditor(note, project, title = "") {
  editing = note
  $("editor-title").textContent = note ? "Edit note" : "New note"
  $("note-title").value = note?.label ?? title
  $("note-body").value = note?.body ?? ""
  const select = $("note-project")
  select.replaceChildren(new Option("No project", ""))
  const projects = nodes.filter((node) => node.type === "project" && node.path !== "/" && (!node.temp || node.path === (note?.project ?? project))).sort((a, b) => a.label.localeCompare(b.label))
  for (const node of projects) select.append(new Option(`${node.label} — ${node.path}`, node.path))
  select.value = note?.project ?? project ?? ""
  $("note-delete").hidden = !note
  $("editor-error").hidden = true
  $("editor").showModal()
  ;(note ? $("note-body") : $("note-title")).focus()
}

$("editor-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const save = $("note-save")
  save.disabled = true
  try {
    const input = { title: $("note-title").value, body: $("note-body").value, project: $("note-project").value || undefined }
    const result = editing
      ? await api(`/api/notes/${editing.slug}`, { method: "PUT", body: JSON.stringify(input) })
      : await api("/api/notes", { method: "POST", body: JSON.stringify(input) })
    $("editor").close()
    await load(true)
    const node = byId.get(`n:${result.slug}`)
    if (node) select(node)
    status("Saved")
  } catch (error) {
    $("editor-error").textContent = error.message
    $("editor-error").hidden = false
  } finally {
    save.disabled = false
  }
})
$("note-cancel").addEventListener("click", () => $("editor").close())
$("note-delete").addEventListener("click", async () => {
  if (!editing || !confirm(`Move “${editing.label}” to the trash? It stays in the notes folder's .trash.`)) return
  try {
    await api(`/api/notes/${editing.slug}`, { method: "DELETE" })
    $("editor").close()
    select(undefined)
    await load(true)
    status("Moved to trash")
  } catch (error) {
    $("editor-error").textContent = error.message
    $("editor-error").hidden = false
  }
})

// ---- controls ---------------------------------------------------------------------------------------

function renderChips() {
  const counts = {}
  for (const node of nodes) counts[node.type] = (counts[node.type] ?? 0) + 1
  counts.temp = nodes.filter((node) => node.temp).length
  const box = $("filters")
  box.replaceChildren()
  for (const type of FILTERS) {
    if (!counts[type]) continue
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = "chip"
    chip.setAttribute("aria-pressed", String(shown[type]))
    chip.innerHTML = `<span class="dot" data-type="${type}"></span><span></span><span class="count">${counts[type]}</span>`
    chip.children[1].textContent = type === "temp" ? "Temporary" : TYPES[type].label
    chip.title = type === "temp" ? "Projects in a temp folder or deleted from disk" : `Show ${TYPES[type].label.toLowerCase()}`
    chip.addEventListener("click", () => { shown[type] = !shown[type]; applyFilters() })
    box.append(chip)
  }
}

function renderLegend() {
  const present = new Set(visible.map((node) => node.type))
  $("legend").innerHTML = Object.keys(TYPES).filter((type) => present.has(type)).map((type) => `<span><i class="dot" data-type="${type}"></i>${escape(TYPES[type].label)}</span>`).join("")
}

function renderStats() {
  const hiddenSessions = stats.sessionsTotal - stats.sessions
  $("stats").textContent = `${visible.length} of ${nodes.length} nodes · ${stats.projects - (shown.temp ? 0 : stats.temporary)} projects${hiddenSessions > 0 ? ` · newest ${stats.sessions} of ${stats.sessionsTotal} sessions` : ""}${stats.notes ? "" : " · no notes yet: press N"}`
}

function renderList() {
  const box = $("list")
  box.replaceChildren()
  const groups = new Map()
  for (const node of visible) {
    if (node.type === "project") continue
    const project = projectOf(node)
    const key = project ? project.id : node.type === "tag" ? "Tags" : node.type === "ghost" ? "Unwritten links" : "Notes without a project"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }
  const projects = visible.filter((node) => node.type === "project").sort((a, b) => (b.active || 0) - (a.active || 0))
  for (const project of projects) {
    const heading = document.createElement("h2")
    const open = button(project.label, () => select(project))
    open.className = "linklike"
    heading.append(open)
    box.append(heading, linkList(groups.get(project.id) ?? []))
    groups.delete(project.id)
  }
  for (const [key, members] of groups) {
    const heading = document.createElement("h2")
    heading.textContent = key
    box.append(heading, linkList(members))
  }
}

function linkList(members) {
  const list = document.createElement("ul")
  list.className = "links"
  for (const node of members.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))) {
    const item = document.createElement("li")
    const go = button("", () => select(node))
    go.className = ""
    go.innerHTML = `<span class="dot" data-type="${node.type}"></span><span class="label"></span>`
    go.querySelector(".label").textContent = `${node.label}`
    go.title = typeLabel[node.type]
    item.append(go)
    list.append(item)
  }
  return list
}

$("view-toggle").addEventListener("click", (event) => {
  const list = $("list")
  list.hidden = !list.hidden
  event.currentTarget.setAttribute("aria-pressed", String(!list.hidden))
  event.currentTarget.textContent = list.hidden ? "List" : "Graph"
  if (!list.hidden) { renderList(); list.querySelector("button")?.focus() }
})
$("refresh").addEventListener("click", () => load(true).then(() => status("Reloaded")))
$("new-note").addEventListener("click", () => openEditor(undefined, selected?.type === "project" ? selected.path : selected?.project))
$("search").addEventListener("input", (event) => { query = event.target.value.trim().toLowerCase(); draw() })
$("search").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return
  // Best match first: the exact title, a title that starts with it, any title, then path or text.
  const rank = (node) => { const label = node.label.toLowerCase(); return label === query ? 0 : label.startsWith(query) ? 1 : label.includes(query) ? 2 : 3 }
  const hit = visible.filter(matches).sort((a, b) => rank(a) - rank(b) || (b.type === "project") - (a.type === "project"))[0]
  if (hit) select(hit)
})
addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "") || $("editor").open
  if (event.key === "Escape" && !$("editor").open) { if (query) { $("search").value = ""; query = ""; draw() } else select(undefined) }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === "/") { event.preventDefault(); $("search").focus() }
  else if (event.key === "n" || event.key === "N") { event.preventDefault(); $("new-note").click() }
  else if (event.key === "f") fit()
})
addEventListener("resize", resize)
addEventListener("focus", () => load(true))

resize()
load()
