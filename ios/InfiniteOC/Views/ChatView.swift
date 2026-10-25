import SwiftUI

struct ChatView: View {
    var connection: Connection
    let sessionID: String
    @State private var chat: ChatModel
    @State private var draft = ""
    @State private var delivery = "steer"
    @State private var sending = false
    @FocusState private var focused: Bool

    init(connection: Connection, sessionID: String) {
        self.connection = connection
        self.sessionID = sessionID
        _chat = State(initialValue: ChatModel(sessionID: sessionID, api: connection.api))
    }

    private var session: SessionInfo? { connection.sessions.first { $0.id == sessionID } }
    private var running: Bool { connection.running.contains(sessionID) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if chat.olderCursor != nil {
                        Button {
                            Task { await chat.loadOlder() }
                        } label: {
                            HStack {
                                if chat.loadingOlder { ProgressView().controlSize(.small) }
                                Text("Load earlier messages")
                            }
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                        }
                        .padding(.vertical, 6)
                    }

                    ForEach(chat.messages) { message in
                        MessageView(message: message, content: chat.content(of: message))
                            .id(message.id)
                    }
                    ForEach(chat.orphanLive, id: \.id) { item in
                        AssistantView(items: item.items, error: nil)
                    }
                    if running {
                        WorkingRow(retry: connection.retrying[sessionID])
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 14)
                .padding(.top, 10)
                .padding(.bottom, 8)
            }
            .pinnedToBottom()
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.ground)
            .overlay {
                if chat.loading { ProgressView() }
                else if chat.messages.isEmpty && chat.orphanLive.isEmpty {
                    VStack(spacing: 8) {
                        Theme.mark.resizable().interpolation(.none).frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 13)).opacity(0.85)
                        Text("What should it build?").font(.headline).foregroundStyle(Theme.text)
                        Text("Type a prompt, or / for commands like /goal.").font(.footnote).foregroundStyle(Theme.dim)
                    }
                }
            }
            .onChange(of: chat.messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: focused) { _, isFocused in
                if isFocused { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                bottomBar(proxy: proxy)
            }
        }
        .navigationTitle(session?.displayTitle ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(session?.displayTitle ?? "Session").font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let directory = session?.directory {
                        Text(directory.shortPath).font(Theme.monoSmall).foregroundStyle(Theme.dim).lineLimit(1)
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    if running {
                        Button(role: .destructive) { Task { await stop() } } label: { Label("Stop", systemImage: "stop.fill") }
                    }
                    Button { Task { await chat.reload() } } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    if let directory = session?.directory {
                        Button { UIPasteboard.general.string = directory } label: { Label("Copy folder path", systemImage: "folder") }
                    }
                    if let model = session?.model {
                        Section("Model") { Text("\(model.providerID)/\(model.id)") }
                    }
                    if let cost = session?.cost, cost > 0 {
                        Section("Cost") { Text(cost, format: .currency(code: "USD")) }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .overlay(alignment: .top) {
            if let toast = connection.toast { ToastView(toast: toast).padding(.top, 4) }
        }
        .animation(.spring(duration: 0.3), value: connection.toast)
        .task {
            connection.register(chat)
            connection.start()
            await chat.load()
            await chat.loadCommands(directory: session?.directory)
        }
    }

    @ViewBuilder
    private func bottomBar(proxy: ScrollViewProxy) -> some View {
        VStack(spacing: 8) {
            ForEach(connection.pending(for: sessionID)) { request in
                PermissionCard(request: request, sessionTitle: nil) { decision in
                    Task { await connection.reply(request, decision: decision) }
                }
            }
            if !suggestions.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(suggestions, id: \.name) { command in
                        Button {
                            draft = "/\(command.name) "
                        } label: {
                            HStack(spacing: 10) {
                                Text("/\(command.name)").font(Theme.mono).foregroundStyle(Theme.purple)
                                if let description = command.description {
                                    Text(description).font(.caption).foregroundStyle(Theme.dim).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            }
            composer(proxy: proxy)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(.bar)
    }

    private func composer(proxy: ScrollViewProxy) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            if running && !trimmed.isEmpty {
                Menu {
                    Picker("Delivery", selection: $delivery) {
                        Label("Steer: use it now", systemImage: "arrow.turn.down.right").tag("steer")
                        Label("Queue: after this run", systemImage: "text.append").tag("queue")
                    }
                } label: {
                    Text(delivery == "steer" ? "Steer" : "Queue")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 10)
                        .frame(height: 36)
                        .background(Theme.raised, in: Capsule())
                }
            }
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(focused ? Theme.purple.opacity(0.5) : Theme.line))
                .textInputAutocapitalization(.sentences)

            if running && trimmed.isEmpty {
                Button { Task { await stop() } } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Theme.red.opacity(0.85), in: Circle())
                }
                .accessibilityLabel("Stop")
            } else {
                Button { Task { await send(proxy: proxy) } } label: {
                    Group {
                        if sending { ProgressView().tint(.white) }
                        else { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)) }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(trimmed.isEmpty ? AnyShapeStyle(Theme.raised) : AnyShapeStyle(Theme.gradient), in: Circle())
                }
                .disabled(trimmed.isEmpty || sending)
                .accessibilityLabel("Send")
            }
        }
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var suggestions: [CommandInfo] {
        guard draft.hasPrefix("/"), !draft.contains(" "), focused else { return [] }
        let q = draft.dropFirst().lowercased()
        return Array(chat.commands.filter { q.isEmpty || $0.name.lowercased().hasPrefix(q) }.prefix(6))
    }

    private func send(proxy: ScrollViewProxy) async {
        let text = trimmed
        guard !text.isEmpty else { return }
        sending = true
        defer { sending = false }
        do {
            try await chat.send(text, delivery: running ? delivery : nil)
            draft = ""
            connection.running.insert(sessionID)
            withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
        } catch {
            connection.showToast(Toast(message: error.localizedDescription, variant: "error"))
        }
    }

    private func stop() async {
        do { try await chat.interrupt() }
        catch { connection.showToast(Toast(message: error.localizedDescription, variant: "error")) }
    }
}

private struct WorkingRow: View {
    var retry: String?
    var body: some View {
        HStack(spacing: 8) {
            PulseDot()
            Text(retry ?? "Working…")
                .font(.footnote)
                .foregroundStyle(retry == nil ? Theme.dim : Theme.amber)
                .lineLimit(2)
        }
        .padding(.vertical, 4)
    }
}

private extension View {
    /// Keeps the transcript pinned to the newest line as streamed text grows (iOS 18+), and opens at the bottom.
    @ViewBuilder func pinnedToBottom() -> some View {
        if #available(iOS 18.0, *) {
            self.defaultScrollAnchor(.bottom).defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            self.defaultScrollAnchor(.bottom)
        }
    }
}
