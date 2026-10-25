import Foundation
import Observation

/// Text or reasoning that is still streaming in, before the server stores the finished value.
struct LiveText: Hashable {
    var kind: String // "text" or "reasoning"
    var text: String
}

/// The transcript of one session: stored messages plus live deltas from the event stream.
@MainActor @Observable
final class ChatModel {
    let sessionID: String
    let api: API

    var messages: [Message] = []
    var live: [String: [Int: LiveText]] = [:]
    var olderCursor: String?
    var loading = false
    var loadingOlder = false
    var error: String?
    var commands: [CommandInfo] = []

    @ObservationIgnored private var reloadTask: Task<Void, Never>?

    init(sessionID: String, api: API) {
        self.sessionID = sessionID
        self.api = api
    }

    func load() async {
        loading = messages.isEmpty
        await reload()
        loading = false
    }

    func loadCommands(directory: String?) async {
        if let list = try? await api.commands(directory: directory) {
            commands = list.sorted { $0.name < $1.name }
        }
    }

    /// Fetches the newest page and merges it over what is loaded, keeping older pages.
    func reload() async {
        do {
            let page = try await api.messages(sessionID)
            let fresh = Array(page.data.reversed())
            if messages.isEmpty { olderCursor = page.cursor?.next }
            let freshIDs = Set(fresh.map(\.id))
            let oldest = fresh.first?.created ?? .infinity
            let kept = messages.filter { !freshIDs.contains($0.id) && $0.created < oldest }
            messages = kept + fresh
            pruneLive()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func loadOlder() async {
        guard let cursor = olderCursor, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await api.messages(sessionID, cursor: cursor)
            let ids = Set(messages.map(\.id))
            messages = page.data.reversed().filter { !ids.contains($0.id) } + messages
            olderCursor = page.data.isEmpty ? nil : page.cursor?.next
        } catch {
            self.error = error.localizedDescription
        }
    }

    func scheduleReload(after nanoseconds: UInt64 = 250_000_000) {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            await self?.reload()
        }
    }

    func handle(_ event: ServerEvent) {
        switch event.type {
        case "session.text.delta", "session.reasoning.delta":
            guard let messageID = event.data["assistantMessageID"]?.string,
                  let ordinal = event.data["ordinal"]?.string.flatMap(Int.init),
                  let delta = event.data["delta"]?.string else { return }
            let kind = event.type == "session.text.delta" ? "text" : "reasoning"
            var parts = live[messageID] ?? [:]
            if let existing = parts[ordinal], existing.kind == kind {
                parts[ordinal]?.text += delta
            } else {
                // A fresh stream starts from what the stored message already holds at that position.
                let stored = messages.first { $0.id == messageID }.flatMap { $0.content.indices.contains(ordinal) ? $0.content[ordinal] : nil }
                let base = stored?.type == kind ? (stored?.text ?? "") : ""
                parts[ordinal] = LiveText(kind: kind, text: base + delta)
            }
            live[messageID] = parts
            if !messages.contains(where: { $0.id == messageID }) { scheduleReload(after: 600_000_000) }
        case "session.tool.input.delta", "session.compaction.delta", "session.step.streamed":
            break // fine-grained; the durable events around them trigger a reload
        default:
            scheduleReload()
        }
    }

    /// Drops live text the stored messages have caught up with.
    private func pruneLive() {
        for (messageID, parts) in live {
            guard let message = messages.first(where: { $0.id == messageID }) else { continue }
            let remaining = parts.filter { ordinal, part in
                guard message.content.indices.contains(ordinal) else { return message.completed == nil }
                let stored = message.content[ordinal]
                return stored.type == part.kind && (stored.text ?? "").count < part.text.count && message.completed == nil
            }
            live[messageID] = remaining.isEmpty ? nil : remaining
        }
    }

    /// Content of an assistant message with live text laid over it.
    func content(of message: Message) -> [ContentItem] {
        var items = message.content
        guard let parts = live[message.id] else { return items }
        for (ordinal, part) in parts.sorted(by: { $0.key < $1.key }) {
            if items.indices.contains(ordinal) {
                if items[ordinal].type == part.kind, (items[ordinal].text ?? "").count < part.text.count { items[ordinal].text = part.text }
            } else {
                items.append(ContentItem(type: part.kind, text: part.text))
            }
        }
        return items
    }

    /// Streams for messages not loaded yet, shown at the end until the reload brings them in.
    var orphanLive: [(id: String, items: [ContentItem])] {
        let ids = Set(messages.map(\.id))
        return live.filter { !ids.contains($0.key) }.sorted { $0.key < $1.key }.map { id, parts in
            (id, parts.sorted { $0.key < $1.key }.map { ContentItem(type: $0.value.kind, text: $0.value.text) })
        }
    }

    // MARK: Sending

    /// `/name args` runs a known command; anything else is a prompt. `delivery` is steer or queue while running.
    func send(_ raw: String, delivery: String?) async throws {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if text.hasPrefix("/") {
            let body = text.dropFirst()
            let name = String(body.prefix { !$0.isWhitespace })
            if commands.contains(where: { $0.name == name }) {
                let args = body.dropFirst(name.count).trimmingCharacters(in: .whitespaces)
                try await api.command(sessionID, name: name, text: args, delivery: delivery)
                scheduleReload()
                return
            }
        }
        try await api.prompt(sessionID, text: text, delivery: delivery)
        scheduleReload()
    }

    func interrupt() async throws {
        try await api.interrupt(sessionID)
    }
}
