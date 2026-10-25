import Foundation
import Observation

struct Toast: Identifiable, Equatable {
    let id = UUID()
    var title: String?
    var message: String
    var variant: String
}

/// Live state of one server: sessions, which are running, pending permission prompts, and the event stream
/// that keeps them current and feeds the open transcript.
@MainActor @Observable
final class Connection {
    let server: Server
    let api: API

    var sessions: [SessionInfo] = []
    var running: Set<String> = []
    var retrying: [String: String] = [:]
    var permissions: [PermissionRequest] = []
    var version: String?
    var streamUp = false
    var error: String?
    var toast: Toast?
    var loaded = false

    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var permissionTask: Task<Void, Never>?
    @ObservationIgnored private var chats: [String: WeakChat] = [:]

    init(server: Server, api: API) {
        self.server = server
        self.api = api
    }

    func start() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in await self?.runStream() }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        streamUp = false
    }

    func register(_ chat: ChatModel) { chats[chat.sessionID] = WeakChat(chat) }

    func pending(for sessionID: String) -> [PermissionRequest] { permissions.filter { $0.sessionID == sessionID } }

    func refresh() async {
        do {
            async let list = api.sessions()
            async let active = api.active()
            async let asks = api.permissions()
            let (s, a, p) = try await (list, active, asks)
            sessions = s
            running = a
            permissions = p
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
        if version == nil { version = try? await api.info().version }
    }

    private func runStream() async {
        var delay: UInt64 = 1
        while !Task.isCancelled {
            await refresh()
            do {
                for try await event in api.events() {
                    if !streamUp {
                        streamUp = true
                        delay = 1
                        // Anything that happened while disconnected was missed: catch up once connected.
                        await refresh()
                        for chat in chats.values.compactMap(\.chat) { chat.scheduleReload() }
                    }
                    handle(event)
                }
            } catch {
                if Task.isCancelled { break }
                if let api = error as? APIError, api.status == 401 { self.error = api.localizedDescription }
            }
            streamUp = false
            try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
            delay = min(delay * 2, 20)
        }
    }

    private func handle(_ event: ServerEvent) {
        let type = event.type
        let sessionID = event.sessionID

        switch type {
        case "session.status":
            guard let sessionID else { break }
            switch event.data["status"]?["type"]?.string {
            case "busy": running.insert(sessionID); retrying[sessionID] = nil
            case "retry": running.insert(sessionID); retrying[sessionID] = event.data["status"]?["message"]?.string ?? "Retrying"
            default: running.remove(sessionID); retrying[sessionID] = nil
            }
        case "session.idle":
            if let sessionID { running.remove(sessionID); retrying[sessionID] = nil }
        case "session.execution.started":
            if let sessionID { running.insert(sessionID) }
        case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
            if let sessionID { running.remove(sessionID) }
            scheduleRefresh()
        case "permission.asked", "permission.replied":
            schedulePermissions()
        case "tui.toast.show":
            if let message = event.data["message"]?.string {
                showToast(Toast(title: event.data["title"]?.string, message: message, variant: event.data["variant"]?.string ?? "info"))
            }
        case "session.created", "session.deleted", "session.archived", "session.unarchived", "session.renamed",
             "session.moved", "session.forked", "session.usage.updated":
            scheduleRefresh()
        default:
            break
        }

        if let sessionID, type.hasPrefix("session."), let chat = chats[sessionID]?.chat {
            chat.handle(event)
        }
        chats = chats.filter { $0.value.chat != nil }
    }

    private func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled, let self else { return }
            if let list = try? await api.sessions() { sessions = list }
        }
    }

    private func schedulePermissions() {
        permissionTask?.cancel()
        permissionTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled, let self else { return }
            if let list = try? await api.permissions() { permissions = list }
        }
    }

    func showToast(_ toast: Toast) {
        self.toast = toast
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if self?.toast == toast { self?.toast = nil }
        }
    }

    // MARK: Actions

    func reply(_ request: PermissionRequest, decision: String) async {
        permissions.removeAll { $0.id == request.id }
        do { try await api.reply(request, decision: decision) }
        catch {
            showToast(Toast(message: error.localizedDescription, variant: "error"))
            if let list = try? await api.permissions() { permissions = list }
        }
    }

    func createSession(directory: String) async throws -> SessionInfo {
        let session = try await api.createSession(directory: directory)
        sessions.insert(session, at: 0)
        return session
    }

    func archive(_ session: SessionInfo) async {
        sessions.removeAll { $0.id == session.id }
        do { try await api.archive(session.id) } catch { showToast(Toast(message: error.localizedDescription, variant: "error")) }
    }

    func delete(_ session: SessionInfo) async {
        sessions.removeAll { $0.id == session.id }
        do { try await api.delete(session.id) } catch { showToast(Toast(message: error.localizedDescription, variant: "error")) }
    }

    /// Directories of recent sessions, newest first, for starting a new one.
    var recentDirectories: [String] {
        var seen = Set<String>()
        return sessions.compactMap(\.directory).filter { seen.insert($0).inserted }
    }
}

private struct WeakChat {
    weak var chat: ChatModel?
    init(_ chat: ChatModel) { self.chat = chat }
}

/// Keeps one Connection per server alive while the app runs.
@MainActor @Observable
final class Connections {
    @ObservationIgnored private var byID: [UUID: Connection] = [:]

    func connection(for server: Server, store: ServerStore) -> Connection? {
        if let existing = byID[server.id], existing.server == server, existing.api.password == store.password(for: server) {
            return existing
        }
        byID[server.id]?.stop()
        guard let api = store.api(for: server) else { return nil }
        let connection = Connection(server: server, api: api)
        byID[server.id] = connection
        return connection
    }

    func drop(_ server: Server) {
        byID[server.id]?.stop()
        byID[server.id] = nil
    }

    func pauseAll() { byID.values.forEach { $0.stop() } }
}
