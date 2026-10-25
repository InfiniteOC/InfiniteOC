import Foundation

// Shapes of the OpenCode v2 serve API (`infiniteoc serve`), decoded leniently: unknown message
// types and fields are kept as generic values so a newer server never breaks the transcript.

struct ModelRef: Codable, Hashable, Sendable {
    var id: String
    var providerID: String
    var variant: String?
}

struct ErrorInfo: Decodable, Hashable, Sendable {
    var message: String
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        message = c.lenient(String.self, AnyKey("message"))
            ?? c.lenient(String.self, AnyKey("type"))
            ?? "Error"
    }
}

struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

struct SessionInfo: Decodable, Identifiable, Hashable, Sendable {
    struct Times: Decodable, Hashable, Sendable {
        var created: Double
        var updated: Double
        var idle: Double?
        var archived: Double?
    }
    struct Location: Decodable, Hashable, Sendable { var directory: String }

    var id: String
    var parentID: String?
    var title: String?
    var outcome: String?
    var agent: String?
    var model: ModelRef?
    var cost: Double?
    var time: Times
    var location: Location?

    var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "Untitled session" }
    var directory: String? { location?.directory }
    var updated: Date { .init(timeIntervalSince1970: time.updated / 1000) }
}

struct PermissionRequest: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var sessionID: String
    var action: String
    var resources: [String]
    var message: String?
    var metadata: JSONValue?
}

struct ToolContent: Decodable, Hashable, Sendable {
    var type: String
    var text: String?
    var name: String?
    var uri: String?
}

struct ToolState: Decodable, Hashable, Sendable {
    var status: String
    var input: JSONValue?
    var content: [ToolContent]?
    var error: ErrorInfo?
    var metadata: JSONValue?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        status = c.lenient(String.self, AnyKey("status")) ?? "unknown"
        input = c.lenient(JSONValue.self, AnyKey("input"))
        content = c.lenient([ToolContent].self, AnyKey("content"))
        error = c.lenient(ErrorInfo.self, AnyKey("error"))
        metadata = c.lenient(JSONValue.self, AnyKey("metadata"))
    }

    var outputText: String {
        (content ?? []).compactMap { $0.text ?? $0.name ?? $0.uri }.joined(separator: "\n")
    }
}

/// One item of an assistant message: text, reasoning or a tool call.
struct ContentItem: Decodable, Hashable, Sendable {
    var type: String
    var text: String?
    var id: String?
    var name: String?
    var state: ToolState?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        type = c.lenient(String.self, AnyKey("type")) ?? "unknown"
        text = c.lenient(String.self, AnyKey("text"))
        id = c.lenient(String.self, AnyKey("id"))
        name = c.lenient(String.self, AnyKey("name"))
        state = c.lenient(ToolState.self, AnyKey("state"))
    }

    init(type: String, text: String) {
        self.type = type
        self.text = text
    }
}

/// A transcript entry. `type` is user, assistant, idle, synthetic, system, skill, shell, compaction,
/// agent-switched, model-switched, location-switched, or something newer.
struct Message: Decodable, Identifiable, Hashable, Sendable {
    var id: String
    var type: String
    var created: Double
    var completed: Double?
    var text: String?
    var description: String?
    var agent: String?
    var model: ModelRef?
    var content: [ContentItem]
    var finish: String?
    var error: ErrorInfo?
    var outcome: String?
    var status: String?
    var command: String?
    var shellOutput: String?
    var name: String?
    var files: [String]
    var cost: Double?

    private struct Times: Decodable { var created: Double?; var completed: Double? }
    private struct ShellOutput: Decodable { var output: String? }
    private struct Attachment: Decodable { var name: String?; var uri: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = try c.decode(String.self, forKey: AnyKey("id"))
        type = c.lenient(String.self, AnyKey("type")) ?? "unknown"
        let time = c.lenient(Times.self, AnyKey("time"))
        created = time?.created ?? 0
        completed = time?.completed
        text = c.lenient(String.self, AnyKey("text"))
        description = c.lenient(String.self, AnyKey("description"))
        agent = c.lenient(String.self, AnyKey("agent"))
        model = c.lenient(ModelRef.self, AnyKey("model"))
        content = c.lenient([ContentItem].self, AnyKey("content")) ?? []
        finish = c.lenient(String.self, AnyKey("finish"))
        error = c.lenient(ErrorInfo.self, AnyKey("error"))
        outcome = c.lenient(String.self, AnyKey("outcome"))
        status = c.lenient(String.self, AnyKey("status"))
        command = c.lenient(String.self, AnyKey("command"))
        shellOutput = c.lenient(ShellOutput.self, AnyKey("output"))?.output
        name = c.lenient(String.self, AnyKey("name"))
        files = (c.lenient([Attachment].self, AnyKey("files")) ?? []).compactMap { $0.name ?? $0.uri }
        cost = c.lenient(Double.self, AnyKey("cost"))
    }

    var date: Date { .init(timeIntervalSince1970: created / 1000) }
}

struct CommandInfo: Decodable, Hashable, Sendable {
    var name: String
    var description: String?
}

struct AgentInfo: Decodable, Hashable, Sendable {
    var id: String
    var name: String?
    var description: String?
    var mode: String?
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        id = c.lenient(String.self, AnyKey("id")) ?? c.lenient(String.self, AnyKey("name")) ?? "?"
        name = c.lenient(String.self, AnyKey("name"))
        description = c.lenient(String.self, AnyKey("description"))
        mode = c.lenient(String.self, AnyKey("mode"))
    }
}

struct ServerInfo: Decodable, Sendable {
    var version: String
}

/// One frame of `GET /api/event`: `{id, type, data, location}`.
struct ServerEvent: Decodable, Sendable {
    var type: String
    var data: JSONValue

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        type = try c.decode(String.self, forKey: AnyKey("type"))
        data = c.lenient(JSONValue.self, AnyKey("data")) ?? .null
    }

    var sessionID: String? { data["sessionID"]?.string }
}

struct DataEnvelope<T: Decodable>: Decodable { var data: T }

struct Page<T: Decodable>: Decodable {
    struct Cursor: Decodable { var previous: String?; var next: String? }
    var data: [T]
    var cursor: Cursor?

    private enum Keys: String, CodingKey { case data, cursor }

    /// Items that fail to decode are skipped, so one odd entry never hides the rest.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        var list = try c.nestedUnkeyedContainer(forKey: .data)
        var items: [T] = []
        while !list.isAtEnd {
            if let item = try? list.decode(T.self) { items.append(item) } else { _ = try? list.decode(JSONValue.self) }
        }
        data = items
        cursor = c.lenient(Cursor.self, .cursor)
    }
}

/// `/api/session/active`: `{data: {ses_...: {type: "running"}}}`.
struct ActiveSessions: Decodable {
    var data: [String: JSONValue]
}
