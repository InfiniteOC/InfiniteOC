import SwiftUI

struct SessionsView: View {
    @Bindable var connection: Connection
    @Environment(\.scenePhase) private var scenePhase
    @State private var search = ""
    @State private var creating = false
    @State private var path: SessionInfo?
    @State private var confirmDelete: SessionInfo?

    var body: some View {
        List {
            if let error = connection.error {
                Label(error, systemImage: "wifi.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(Theme.red)
                    .listRowBackground(Theme.surface)
            }

            if !connection.permissions.isEmpty {
                Section {
                    ForEach(connection.permissions) { request in
                        PermissionCard(request: request, sessionTitle: title(of: request.sessionID)) { decision in
                            Task { await connection.reply(request, decision: decision) }
                        }
                        .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                } header: {
                    SectionLabel(text: "Waiting for you", color: Theme.amber)
                }
            }

            Section {
                ForEach(filtered) { session in
                    NavigationLink(value: session) {
                        SessionRow(session: session,
                                   running: connection.running.contains(session.id),
                                   asks: connection.pending(for: session.id).count)
                    }
                    .swipeActions {
                        Button(role: .destructive) { confirmDelete = session } label: { Label("Delete", systemImage: "trash") }
                        Button { Task { await connection.archive(session) } } label: { Label("Archive", systemImage: "archivebox") }
                            .tint(Theme.deepPurple)
                    }
                    .contextMenu {
                        if let directory = session.directory {
                            Button { UIPasteboard.general.string = directory } label: { Label("Copy folder path", systemImage: "doc.on.doc") }
                        }
                        Button { Task { await connection.archive(session) } } label: { Label("Archive", systemImage: "archivebox") }
                        Button(role: .destructive) { confirmDelete = session } label: { Label("Delete", systemImage: "trash") }
                    }
                }
                .listRowBackground(Theme.surface)
            } header: {
                if !connection.sessions.isEmpty { SectionLabel(text: "Sessions", color: Theme.dim) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .overlay {
            if !connection.loaded {
                ProgressView()
            } else if connection.sessions.isEmpty && connection.error == nil {
                ContentUnavailableView {
                    Label("No sessions yet", systemImage: "text.bubble")
                } description: {
                    Text("Start one in a folder on \(connection.server.name).")
                } actions: {
                    Button("New session") { creating = true }.buttonStyle(.borderedProminent)
                }
            }
        }
        .searchable(text: $search, prompt: "Search sessions")
        .refreshable { await connection.refresh() }
        .navigationTitle(connection.server.name)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    Circle().fill(connection.streamUp ? Theme.green : Theme.faint).frame(width: 7, height: 7)
                    Text(connection.streamUp ? "Live" : "Connecting…").font(.caption).foregroundStyle(Theme.dim)
                }
                .accessibilityElement(children: .combine)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { creating = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New session")
            }
        }
        .navigationDestination(for: SessionInfo.self) { session in
            ChatView(connection: connection, sessionID: session.id)
        }
        .navigationDestination(item: $path) { session in
            ChatView(connection: connection, sessionID: session.id)
        }
        .sheet(isPresented: $creating) {
            NewSessionSheet(connection: connection) { session in path = session }
        }
        .confirmationDialog("Delete this session?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible, presenting: confirmDelete) { session in
            Button("Delete", role: .destructive) { Task { await connection.delete(session) }; confirmDelete = nil }
            Button("Cancel", role: .cancel) { confirmDelete = nil }
        } message: { session in
            Text("“\(session.displayTitle)” and its history are removed from \(connection.server.name).")
        }
        .overlay(alignment: .top) {
            if let toast = connection.toast { ToastView(toast: toast) }
        }
        .animation(.spring(duration: 0.3), value: connection.toast)
        .onAppear { connection.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { connection.start() } else if phase == .background { connection.stop() }
        }
    }

    private var filtered: [SessionInfo] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return connection.sessions }
        return connection.sessions.filter {
            $0.displayTitle.lowercased().contains(q) || ($0.directory?.lowercased().contains(q) ?? false)
        }
    }

    private func title(of sessionID: String) -> String {
        connection.sessions.first { $0.id == sessionID }?.displayTitle ?? "Session"
    }
}

struct SectionLabel: View {
    var text: String
    var color: Color
    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.8)
            .foregroundStyle(color)
    }
}

private struct SessionRow: View {
    var session: SessionInfo
    var running: Bool
    var asks: Int

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            status
                .frame(width: 14, height: 20)
            VStack(alignment: .leading, spacing: 4) {
                Text(session.displayTitle)
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let directory = session.directory {
                        Text(directory.shortPath).font(Theme.monoSmall).lineLimit(1)
                        Text("·")
                    }
                    Text(session.updated, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(Theme.dim)
            }
            Spacer(minLength: 0)
            if asks > 0 {
                Text("\(asks)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Theme.ground)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Theme.amber, in: Capsule())
                    .accessibilityLabel("\(asks) waiting for approval")
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var status: some View {
        if running {
            PulseDot()
        } else {
            switch session.outcome {
            case "failed": Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(Theme.red)
            case "interrupted": Image(systemName: "pause.circle.fill").font(.caption).foregroundStyle(Theme.amber)
            default: Circle().stroke(Theme.faint, lineWidth: 1.5).frame(width: 8, height: 8)
            }
        }
    }
}

struct PermissionCard: View {
    var request: PermissionRequest
    var sessionTitle: String?
    var reply: (String) -> Void
    @State private var confirmAlways = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill").foregroundStyle(Theme.amber)
                Text(request.action)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.text)
                Spacer()
                if let sessionTitle {
                    Text(sessionTitle).font(.caption).foregroundStyle(Theme.dim).lineLimit(1)
                }
            }
            if let message = request.message, !message.isEmpty {
                Text(message).font(.footnote).foregroundStyle(Theme.dim)
            }
            if !request.resources.isEmpty {
                Text(request.resources.prefix(6).joined(separator: "\n"))
                    .font(Theme.monoSmall)
                    .foregroundStyle(Theme.text)
                    .lineLimit(8)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.ground, in: RoundedRectangle(cornerRadius: 8))
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Button { reply("reject") } label: {
                    Text("Deny").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(Theme.red)
                Button { confirmAlways = true } label: {
                    Text("Always").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                Button { reply("once") } label: {
                    Text("Allow").fontWeight(.semibold).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.deepPurple)
            }
            .controlSize(.regular)
        }
        .padding(12)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.amber.opacity(0.35)))
        .confirmationDialog("Always allow \(request.action)?", isPresented: $confirmAlways, titleVisibility: .visible) {
            Button("Always allow") { reply("always") }
        } message: {
            Text("This saves a permanent rule on the computer, so it won't ask again for this.")
        }
    }
}

struct NewSessionSheet: View {
    var connection: Connection
    var opened: (SessionInfo) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var directory = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Folder", text: $directory, prompt: Text("/Users/me/code/app"))
                        .font(Theme.mono)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await create() } }
                } footer: {
                    Text("An absolute path on \(connection.server.name).")
                }
                .listRowBackground(Theme.surface)

                if !connection.recentDirectories.isEmpty {
                    Section("Recent folders") {
                        ForEach(connection.recentDirectories.prefix(12), id: \.self) { path in
                            Button {
                                directory = path
                                Task { await create() }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(path.shortPath).foregroundStyle(Theme.text)
                                    Text(path).font(Theme.monoSmall).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.head)
                                }
                            }
                        }
                    }
                    .listRowBackground(Theme.surface)
                }

                if let error {
                    Text(error).foregroundStyle(Theme.red).font(.footnote).listRowBackground(Theme.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .disabled(working)
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if working { ProgressView() } else {
                        Button("Start") { Task { await create() } }.disabled(!directory.hasPrefix("/"))
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.ground)
    }

    private func create() async {
        let path = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard path.hasPrefix("/") else { error = "Use an absolute path, starting with /."; return }
        working = true
        defer { working = false }
        do {
            let session = try await connection.createSession(directory: path)
            dismiss()
            opened(session)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
