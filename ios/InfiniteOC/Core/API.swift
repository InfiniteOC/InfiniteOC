import Foundation

struct APIError: LocalizedError {
    var status: Int
    var detail: String
    var errorDescription: String? {
        switch status {
        case 401: return "The server refused the password (401)."
        case 0: return detail
        default: return "The server answered \(status)\(detail.isEmpty ? "." : ": \(detail)")"
        }
    }
}

/// One `infiniteoc serve` (OpenCode v2 API, HTTP Basic auth).
struct API: Sendable {
    var baseURL: URL
    var username: String
    var password: String

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    /// A session for the event stream: no request timeout between frames (the server sends a heartbeat every 15 s).
    static let streamSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 60 * 60 * 24
        return URLSession(configuration: config)
    }()

    var authorization: String {
        "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
    }

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Encodable? = nil) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIError(status: 0, detail: "Invalid address")
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError(status: 0, detail: "Invalid address") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        return request
    }

    @discardableResult
    func send(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Encodable? = nil) async throws -> Data {
        let request = try self.request(method, path, query: query, body: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await API.session.data(for: request)
        } catch let error as URLError {
            throw APIError(status: 0, detail: error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let detail = String(data: data.prefix(300), encoding: .utf8) ?? ""
            throw APIError(status: status, detail: Self.errorMessage(detail))
        }
        return data
    }

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [URLQueryItem] = []) async throws -> T {
        let data = try await send("GET", path, query: query)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError(status: 0, detail: "Unexpected answer from \(path): \(error.localizedDescription)") }
    }

    /// Pulls `message` out of a JSON error body when there is one.
    static func errorMessage(_ body: String) -> String {
        guard let data = body.data(using: .utf8), let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { return body }
        return json["message"]?.string ?? json["error"]?["message"]?.string ?? json["error"]?.string ?? body
    }

    // MARK: Endpoints

    func info() async throws -> ServerInfo { try await get(ServerInfo.self, "api/info") }

    func sessions(limit: Int = 100) async throws -> [SessionInfo] {
        try await get(Page<SessionInfo>.self, "api/session", query: [
            .init(name: "limit", value: String(limit)), .init(name: "order", value: "desc"),
            .init(name: "parentID", value: "null"), .init(name: "archived", value: "false"),
        ]).data
    }

    func session(_ id: String) async throws -> SessionInfo {
        try await get(DataEnvelope<SessionInfo>.self, "api/session/\(id)").data
    }

    func active() async throws -> Set<String> {
        Set(try await get(ActiveSessions.self, "api/session/active").data.keys)
    }

    func createSession(directory: String) async throws -> SessionInfo {
        struct Body: Encodable { struct Location: Encodable { var directory: String }; var location: Location }
        let data = try await send("POST", "api/session", body: Body(location: .init(directory: directory)))
        return try JSONDecoder().decode(DataEnvelope<SessionInfo>.self, from: data).data
    }

    func archive(_ id: String) async throws {
        struct Body: Encodable { var archived = true }
        try await send("PATCH", "api/session/\(id)", body: Body())
    }

    func delete(_ id: String) async throws { try await send("DELETE", "api/session/\(id)") }

    /// Newest first; `cursor` continues toward older messages.
    func messages(_ sessionID: String, limit: Int = 100, cursor: String? = nil) async throws -> Page<Message> {
        var query: [URLQueryItem] = [.init(name: "limit", value: String(limit)), .init(name: "order", value: "desc")]
        if let cursor { query.append(.init(name: "cursor", value: cursor)) }
        return try await get(Page<Message>.self, "api/session/\(sessionID)/message", query: query)
    }

    func prompt(_ sessionID: String, text: String, delivery: String?) async throws {
        struct Body: Encodable { var text: String; var delivery: String? }
        try await send("POST", "api/session/\(sessionID)/prompt", body: Body(text: text, delivery: delivery))
    }

    func command(_ sessionID: String, name: String, text: String, delivery: String?) async throws {
        struct Body: Encodable { var name: String; var text: String; var delivery: String? }
        try await send("POST", "api/session/\(sessionID)/command", body: Body(name: name, text: text, delivery: delivery))
    }

    func interrupt(_ sessionID: String) async throws {
        try await send("POST", "api/session/\(sessionID)/interrupt")
    }

    func commands(directory: String?) async throws -> [CommandInfo] {
        let query = directory.map { [URLQueryItem(name: "location[directory]", value: $0)] } ?? []
        return try await get(Page<CommandInfo>.self, "api/command", query: query).data
    }

    func permissions() async throws -> [PermissionRequest] {
        try await get(Page<PermissionRequest>.self, "api/permission/request").data
    }

    func reply(_ request: PermissionRequest, decision: String) async throws {
        struct Body: Encodable { var decision: String }
        try await send("POST", "api/session/\(request.sessionID)/permission/\(request.id)/reply", body: Body(decision: decision))
    }

    /// Server-sent events from `GET /api/event`, one decoded frame at a time.
    func events() -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = try self.request("GET", "api/event")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await API.streamSession.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else { throw APIError(status: status, detail: "") }
                    let decoder = JSONDecoder()
                    // Each frame is a single `data: {...}` line; heartbeats are `: heartbeat` comments.
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let json = line.dropFirst(5).drop(while: { $0 == " " })
                        if let event = try? decoder.decode(ServerEvent.self, from: Data(json.utf8)) {
                            continuation.yield(event)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ value: Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
