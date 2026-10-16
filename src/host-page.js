// The host page: projects stored in this browser (IndexedDB), opened on the host for a session, synced back
// every few seconds while open, downloadable as a zip that is built right here.
const $ = (id) => document.getElementById(id)
const SYNC_MS = 3000
// Raw bytes per upload request (base64 adds a third; the host accepts 12 MB bodies).
const UPLOAD_BATCH = 6 * 1024 * 1024

// ---- storage ----------------------------------------------------------------------------------------

const db = await new Promise((resolve, reject) => {
  const open = indexedDB.open("infiniteoc-host", 1)
  open.onupgradeneeded = () => {
    const files = open.result.createObjectStore("files", { keyPath: ["project", "path"] })
    files.createIndex("project", "project")
    open.result.createObjectStore("projects", { keyPath: "name" })
  }
  open.onsuccess = () => resolve(open.result)
  open.onerror = () => reject(open.error)
})
const tx = (stores, mode, run) =>
  new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode)
    let result
    transaction.oncomplete = () => resolve(result)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
    result = run(transaction)
  })
const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
const projects = () => tx(["projects"], "readonly", (t) => request(t.objectStore("projects").getAll()))
const project = (name) => tx(["projects"], "readonly", (t) => request(t.objectStore("projects").get(name)))
const files = (name) => tx(["files"], "readonly", (t) => request(t.objectStore("files").index("project").getAll(name)))
const saveMeta = (meta) => tx(["projects"], "readwrite", (t) => void t.objectStore("projects").put(meta))
async function store(name, incoming, keep) {
  // One transaction per batch: a crash mid-sync leaves the previous files, never a half-written one.
  await tx(["files", "projects"], "readwrite", (t) => {
    const fileStore = t.objectStore("files")
    for (const file of incoming) fileStore.put({ project: name, path: file.path, data: file.data, mtime: file.mtime })
    if (keep) {
      const index = fileStore.index("project").openCursor(IDBKeyRange.only(name))
      index.onsuccess = () => {
        const cursor = index.result
        if (!cursor) return
        if (!keep.has(cursor.value.path)) cursor.delete()
        cursor.continue()
      }
    }
  })
}
async function totals(name) {
  const all = await files(name)
  return { count: all.length, size: all.reduce((sum, file) => sum + file.data.byteLength, 0) }
}
async function removeProject(name) {
  await tx(["files", "projects"], "readwrite", (t) => {
    t.objectStore("projects").delete(name)
    const index = t.objectStore("files").index("project").openKeyCursor(IDBKeyRange.only(name))
    index.onsuccess = () => { const cursor = index.result; if (cursor) { t.objectStore("files").delete(cursor.primaryKey); cursor.continue() } }
  })
}

// ---- host API ---------------------------------------------------------------------------------------

async function api(path, options = {}) {
  const response = await fetch(`/_ioc/api${path}`, { ...options, headers: { "x-ioc": "1", ...(options.body ? { "content-type": "application/json" } : {}) } })
  if (response.status === 401) { location.href = "/_ioc/"; throw new Error("Signed out") }
  const type = response.headers.get("content-type") ?? ""
  const body = type.includes("json") ? await response.json() : await response.blob()
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}
const toBase64 = (bytes) => { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out) }
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const encodeName = (name) => encodeURIComponent(name)

/** Pulls everything the host changed since the project's cursor into this browser. */
async function pull(name) {
  const meta = (await project(name)) ?? { name, created: Date.now() }
  let since = meta.cursor ?? 0
  let after = ""
  for (;;) {
    const page = await api(`/projects/${encodeName(name)}/changes?since=${since}&after=${encodeURIComponent(after)}`)
    const incoming = page.files.map((file) => ({ path: file.path, mtime: file.mtime, data: fromBase64(file.data) }))
    await store(name, incoming, page.more ? undefined : new Set(page.paths))
    if (!page.more) { since = page.cursor; break }
    after = page.files.at(-1)?.path ?? after
  }
  const sum = await totals(name)
  await saveMeta({ ...meta, cursor: since, updated: Date.now(), ...sum })
  return sum
}

/** Uploads this browser's copy to the host (replacing the host's), in batches. */
async function push(name) {
  const all = await files(name)
  const batches = [[]]
  let bytes = 0
  for (const file of all) {
    if (bytes + file.data.byteLength > UPLOAD_BATCH && batches.at(-1).length) { batches.push([]); bytes = 0 }
    batches.at(-1).push(file)
    bytes += file.data.byteLength
  }
  const git = !all.some((file) => file.path.startsWith(".git/"))
  for (const [index, batch] of batches.entries())
    await api(`/projects/${encodeName(name)}/files`, { method: "PUT", body: JSON.stringify({ replace: index === 0, git: git && index === 0, files: batch.map((file) => ({ path: file.path, data: toBase64(file.data) })) }) })
  const meta = (await project(name)) ?? { name, created: Date.now() }
  // The host now matches this copy; only later changes need to come back.
  await saveMeta({ ...meta, cursor: Date.now(), updated: Date.now() })
}

// ---- zip (stored, no compression): built from this browser's copy ----------------------------------

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function zip(entries) {
  const encoder = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  const now = new Date()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const crc = crc32(entry.data)
    const local = new DataView(new ArrayBuffer(30))
    ;[[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, entry.data.length, 4], [22, entry.data.length, 4], [26, name.length, 2], [28, 0, 2]].forEach(([at, value, size]) => (size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true)))
    parts.push(new Uint8Array(local.buffer), name, entry.data)
    const head = new DataView(new ArrayBuffer(46))
    ;[[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, entry.data.length, 4], [24, entry.data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]].forEach(([at, value, size]) => (size === 4 ? head.setUint32(at, value, true) : head.setUint16(at, value, true)))
    central.push(new Uint8Array(head.buffer), name)
    offset += 30 + name.length + entry.data.length
  }
  const size = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  ;[[0, 0x06054b50, 4], [8, entries.length, 2], [10, entries.length, 2], [12, size, 4], [16, offset, 4]].forEach(([at, value, sizeOf]) => (sizeOf === 4 ? end.setUint32(at, value, true) : end.setUint16(at, value, true)))
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" })
}
async function download(name) {
  if (opened === name) await pull(name).catch(() => {})
  const all = (await files(name)).sort((a, b) => (a.path < b.path ? -1 : 1))
  const link = document.createElement("a")
  link.href = URL.createObjectURL(zip(all.map((file) => ({ path: `${name}/${file.path}`, data: file.data }))))
  link.download = `${name}.zip`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

// ---- views ------------------------------------------------------------------------------------------

const slug = (text) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|-+$/g, "").slice(0, 60)
const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes > 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`)
const when = (ms) => (ms ? new Date(ms).toLocaleString() : "")
function message(text, error = false) {
  const box = $("message")
  box.textContent = text
  box.className = `message${error ? " error" : ""}`
  box.hidden = !text
}
const button = (text, kind, onClick) => { const b = document.createElement("button"); b.type = "button"; b.className = kind; b.textContent = text; b.addEventListener("click", onClick); return b }

async function renderList() {
  const local = (await projects()).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  const list = $("projects")
  list.replaceChildren()
  for (const meta of local) {
    const item = document.createElement("li")
    item.className = "project"
    const info = document.createElement("div")
    info.className = "info"
    const name = document.createElement("div")
    name.className = "name"
    name.textContent = meta.name
    if (meta.fromAgent) { const badge = document.createElement("span"); badge.className = "badge"; badge.textContent = "made by the agent"; name.append(badge) }
    const details = document.createElement("div")
    details.className = "meta"
    details.textContent = `${meta.count ?? 0} files · ${size(meta.size ?? 0)} · saved ${when(meta.updated)}`
    info.append(name, details)
    const row = document.createElement("div")
    row.className = "row"
    row.append(
      button("Open", "primary", () => openProject(meta.name)),
      button("Download", "ghost", () => download(meta.name).catch((error) => message(error.message, true))),
      button("Delete", "danger", async () => {
        if (!confirm(`Delete "${meta.name}" from this browser${hostNames.has(meta.name) ? " and the host" : ""}? Download it first if you want to keep it.`)) return
        await removeProject(meta.name)
        if (hostNames.has(meta.name)) await api(`/projects/${encodeName(meta.name)}`, { method: "DELETE" }).catch(() => {})
        hostNames.delete(meta.name)
        renderList()
      }),
    )
    item.append(info, row)
    list.append(item)
  }
  $("empty").hidden = local.length > 0
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined)
  $("storage").textContent = estimate ? `This browser holds ${size(estimate.usage ?? 0)} of about ${size(estimate.quota ?? 0)} available.` : ""
}

let hostNames = new Set()
/** Projects that exist only on the host (the agent created them) are saved into this browser too. */
async function adoptHostProjects() {
  const host = await api("/projects")
  hostNames = new Set(host.projects.map((item) => item.name))
  for (const item of host.projects) {
    if (await project(item.name)) continue
    await saveMeta({ name: item.name, created: Date.now(), fromAgent: true, cursor: 0 })
    await pull(item.name)
  }
}

// ---- working on a project ---------------------------------------------------------------------------

let opened
let timer
let lastSync = 0
let adoptTimer
function status(text, kind = "") { const el = $("sync"); el.textContent = text; el.className = `sync ${kind}` }

async function openProject(name) {
  message("")
  try {
    status("Uploading to the host…")
    showWork(name)
    // The host may already hold a newer copy (the agent kept working while this tab was closed): take it first.
    if (hostNames.has(name)) await pull(name)
    else await push(name)
    hostNames.add(name)
    const { sessionID } = await api(`/projects/${encodeName(name)}/session`, { method: "POST" })
    const server = btoa(location.origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    $("work").src = `/server/${server}/session/${sessionID}`
    history.pushState({ project: name }, "", `/_ioc/#${encodeURIComponent(name)}`)
    syncLoop()
  } catch (error) {
    showList()
    message(`Could not open ${name}: ${error.message}`, true)
  }
}

async function syncLoop() {
  clearTimeout(timer)
  if (!opened) return
  try {
    const sum = await pull(opened)
    lastSync = Date.now()
    status(`Saved in this browser · ${sum.count} files`, "ok")
  } catch (error) {
    status(`Not saved: ${error.message}`, "warn")
  }
  timer = setTimeout(syncLoop, SYNC_MS)
}

function showWork(name) {
  opened = name
  $("list-view").hidden = true
  $("work").hidden = false
  $("workbar").hidden = false
  $("current").textContent = name
  $("back").hidden = false
  $("download-current").hidden = false
}
async function showList() {
  if (opened) await pull(opened).catch(() => {})
  opened = undefined
  clearTimeout(timer)
  $("work").src = "about:blank"
  $("work").hidden = true
  $("list-view").hidden = false
  $("workbar").hidden = true
  $("back").hidden = true
  $("download-current").hidden = true
  await adoptHostProjects().catch((error) => message(`Host unreachable: ${error.message}`, true))
  await renderList()
}

$("back").addEventListener("click", () => { history.pushState({}, "", "/_ioc/"); showList() })
$("download-current").addEventListener("click", () => opened && download(opened).catch((error) => status(error.message, "warn")))
addEventListener("popstate", () => { const name = decodeURIComponent(location.hash.slice(1)); if (name && name !== opened) openProject(name); else if (!name && opened) showList() })
addEventListener("beforeunload", (event) => { if (opened && Date.now() - lastSync > SYNC_MS * 2) event.preventDefault() })

$("new-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const name = slug($("new-name").value)
  if (!name) return message("Give the project a name with letters or digits.", true)
  if (await project(name)) return message(`"${name}" already exists in this browser.`, true)
  const readme = new TextEncoder().encode(`# ${$("new-name").value.trim()}\n\nCreated with InfiniteOC.\n`)
  await store(name, [{ path: "README.md", data: readme, mtime: Date.now() }])
  await saveMeta({ name, created: Date.now(), updated: Date.now(), count: 1, size: readme.length })
  $("new-name").value = ""
  openProject(name)
})

$("import").addEventListener("change", async (event) => {
  const picked = [...event.target.files]
  if (!picked.length) return
  const name = slug(picked[0].webkitRelativePath.split("/")[0] || "imported")
  if (await project(name) && !confirm(`Replace "${name}" in this browser with the imported folder?`)) return
  message(`Importing ${picked.length} files…`)
  const skip = /(^|\/)(node_modules|\.venv|venv|__pycache__|\.next|\.cache|target)(\/|$)/
  const incoming = []
  for (const file of picked) {
    const rel = file.webkitRelativePath.split("/").slice(1).join("/")
    if (!rel || skip.test(rel) || file.size > 8 * 1024 * 1024) continue
    incoming.push({ path: rel, data: new Uint8Array(await file.arrayBuffer()), mtime: file.lastModified })
  }
  await removeProject(name)
  await store(name, incoming)
  await saveMeta({ name, created: Date.now(), updated: Date.now(), ...(await totals(name)) })
  message(`Imported ${incoming.length} files into "${name}".`)
  event.target.value = ""
  renderList()
})

// Keep agent-made projects arriving while the list is open.
adoptTimer = setInterval(() => { if (!opened) adoptHostProjects().then(renderList).catch(() => {}) }, 15_000)
navigator.storage?.persist?.().catch(() => {})
const start = decodeURIComponent(location.hash.slice(1))
await showList()
if (start && (await project(start))) openProject(start)
