"use strict"
const $ = (id) => document.getElementById(id)
let token = ""
try { token = (location.hash.slice(1) || localStorage.getItem("infiniteoc-remote") || "") } catch { token = location.hash.slice(1) }
if (location.hash) history.replaceState(null, "", location.pathname)
let timer

const api = async (path, init = {}) => {
  const response = await fetch(path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, cache: "no-store" })
  if (response.status === 401) throw Object.assign(new Error("Wrong token"), { auth: true })
  if (response.status === 429) throw new Error("Too many wrong tries; wait a minute")
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`)
  return response.status === 204 ? undefined : response.json()
}
const ago = (time) => { const s = Math.max(0, Math.round((Date.now() - time) / 1000)); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago` }
const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node }

function render(state) {
  $("link").textContent = "connected"; $("link").className = "link on"
  const pending = $("pending"); pending.replaceChildren()
  $("pending-count").textContent = state.permissions.length
  $("pending-empty").hidden = state.permissions.length > 0
  for (const ask of state.permissions) {
    const decide = (decision) => async (event) => {
      for (const button of event.target.closest(".ask").querySelectorAll("button")) button.disabled = true
      try { await api("/api/reply", { method: "POST", body: JSON.stringify({ sessionID: ask.sessionID, requestID: ask.id, decision }) }) } catch (error) { $("link").textContent = error.message; $("link").className = "link off" }
      refresh()
    }
    pending.append(el("li", { className: "ask" },
      el("b", {}, ask.action),
      el("p", { className: "where" }, `${ask.sessionTitle || "Session"}${ask.agent ? ` · ${ask.agent}` : ""}`),
      el("ul", {}, ...ask.resources.map((resource) => el("li", {}, el("code", {}, resource)))),
      el("div", { className: "buttons" }, el("button", { className: "deny", onclick: decide("deny") }, "Deny"), el("button", { className: "approve", onclick: decide("approve") }, "Approve once"))))
  }
  const sessions = $("sessions"); sessions.replaceChildren()
  $("sessions-empty").hidden = state.sessions.length > 0
  for (const session of state.sessions)
    sessions.append(el("li", { className: "session" }, el("b", {}, session.title || session.id), el("span", {}, session.directory || ""),
      el("span", { className: `state-${session.outcome}` }, `${session.outcome || "idle"} · ${ago(session.updated)}`)))
}

async function refresh() {
  clearTimeout(timer)
  try {
    render(await api("/api/state"))
    $("login").hidden = true; $("app").hidden = false
  } catch (error) {
    if (error.auth) { token = ""; try { localStorage.removeItem("infiniteoc-remote") } catch {} $("app").hidden = true; $("login").hidden = false; $("login-error").textContent = $("token").value ? error.message : ""; $("link").textContent = "locked"; $("link").className = "link off" }
    else { $("link").textContent = "reconnecting"; $("link").className = "link off" }
  }
  if (token) timer = setTimeout(refresh, document.hidden ? 8000 : 2000)
}

$("login").addEventListener("submit", (event) => {
  event.preventDefault()
  token = $("token").value.trim()
  try { localStorage.setItem("infiniteoc-remote", token) } catch {}
  refresh()
})
document.addEventListener("visibilitychange", () => { if (!document.hidden && token) refresh() })
if (token) refresh(); else { $("login").hidden = false; $("link").textContent = "locked"; $("link").className = "link off" }
