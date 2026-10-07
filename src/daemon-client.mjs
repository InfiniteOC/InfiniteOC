import http from "node:http"

export function daemonRequest(socketPath, method, path, body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!socketPath) { reject(new Error("opendaemon is not connected; restart InfiniteOC through its launcher")); return }
    const data = body === undefined ? undefined : JSON.stringify(body)
    const request = http.request({ socketPath, method, path, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, response => {
      let text = ""
      response.setEncoding("utf8")
      response.on("data", chunk => {
        text += chunk
        if (text.length > 1024 * 1024) request.destroy(new Error("opendaemon response too large"))
      })
      response.on("end", () => {
        try {
          const result = JSON.parse(text)
          if (response.statusCode >= 400) reject(new Error(result.error || "opendaemon request failed"))
          else resolve(result)
        } catch (error) { reject(error) }
      })
      response.on("error", reject)
    })
    request.setTimeout(timeout, () => request.destroy(new Error("opendaemon request timed out")))
    request.on("error", reject)
    request.end(data)
  })
}