import SwiftUI

struct ServersView: View {
    @Environment(ServerStore.self) private var store
    @Environment(Connections.self) private var connections
    @State private var editing: Server?
    @State private var adding = false
    @State private var path = NavigationPath()
    @State private var autoOpened = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if store.servers.isEmpty {
                    EmptyServers { adding = true }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else {
                    Section {
                        ForEach(store.servers) { server in
                            NavigationLink(value: server) {
                                ServerRow(server: server)
                            }
                            .swipeActions {
                                Button(role: .destructive) {
                                    connections.drop(server)
                                    store.remove(server)
                                } label: { Label("Remove", systemImage: "trash") }
                                Button { editing = server } label: { Label("Edit", systemImage: "pencil") }
                                    .tint(Theme.deepPurple)
                            }
                            .contextMenu {
                                Button { editing = server } label: { Label("Edit", systemImage: "pencil") }
                                Button(role: .destructive) {
                                    connections.drop(server)
                                    store.remove(server)
                                } label: { Label("Remove", systemImage: "trash") }
                            }
                        }
                        .onMove { store.move(from: $0, to: $1) }
                        .listRowBackground(Theme.surface)
                    } footer: {
                        Text("Each computer runs `infiniteoc serve --hostname 0.0.0.0`. Use a network you trust or your tailnet: the connection is plain HTTP.")
                            .font(.footnote)
                            .foregroundStyle(Theme.faint)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle("InfiniteOC")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { adding = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add computer")
                }
            }
            .navigationDestination(for: Server.self) { server in
                if let connection = connections.connection(for: server, store: store) {
                    SessionsView(connection: connection)
                } else {
                    ContentUnavailableView("Invalid address", systemImage: "exclamationmark.triangle", description: Text(server.url))
                }
            }
            .sheet(isPresented: $adding) { ServerEditor(server: nil) }
            .sheet(item: $editing) { ServerEditor(server: $0) }
        }
        .onAppear {
            // One computer: open it straight away.
            if !autoOpened, store.servers.count == 1 { path.append(store.servers[0]) }
            autoOpened = true
        }
    }
}

private struct ServerRow: View {
    var server: Server
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.title3)
                .foregroundStyle(Theme.gradient)
                .frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.name).font(.body.weight(.medium)).foregroundStyle(Theme.text)
                Text(server.baseURL?.absoluteString ?? server.url).font(Theme.monoSmall).foregroundStyle(Theme.dim)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct EmptyServers: View {
    var add: () -> Void
    var body: some View {
        VStack(spacing: 18) {
            Theme.mark
                .resizable()
                .interpolation(.none)
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 22))
            Text("Your agent, in your pocket")
                .font(.title2.weight(.semibold))
                .foregroundStyle(Theme.text)
            Text("Connect to a computer running InfiniteOC to follow sessions live, send prompts and answer permission prompts.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.dim)
            VStack(alignment: .leading, spacing: 6) {
                Text("On the computer:").font(.footnote).foregroundStyle(Theme.faint)
                Text("OPENCODE_PASSWORD=… infiniteoc serve --hostname 0.0.0.0")
                    .font(Theme.monoSmall)
                    .foregroundStyle(Theme.purple)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            }
            Button(action: add) {
                Text("Add a computer")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.gradient, in: RoundedRectangle(cornerRadius: 14))
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 40)
        .padding(.horizontal, 8)
    }
}

struct ServerEditor: View {
    @Environment(ServerStore.self) private var store
    @Environment(Connections.self) private var connections
    @Environment(\.dismiss) private var dismiss

    let server: Server?
    @State private var name = ""
    @State private var url = ""
    @State private var username = "opencode"
    @State private var password = ""
    @State private var testing = false
    @State private var result: (ok: Bool, text: String)?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name, prompt: Text("MacBook"))
                    TextField("Address", text: $url, prompt: Text("100.66.26.54:4096"))
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(Theme.mono)
                    SecureField("Password", text: $password, prompt: Text("OPENCODE_PASSWORD"))
                        .textInputAutocapitalization(.never)
                } footer: {
                    Text("The address and password `infiniteoc serve` printed. A pasted link works too.")
                }
                .listRowBackground(Theme.surface)

                Section("Advanced") {
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .listRowBackground(Theme.surface)

                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("Test connection")
                            Spacer()
                            if testing { ProgressView() }
                        }
                    }
                    .disabled(Server.normalize(url) == nil || testing)
                    if let result {
                        Label(result.text, systemImage: result.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(result.ok ? Theme.green : Theme.red)
                            .font(.footnote)
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.ground)
            .navigationTitle(server == nil ? "Add computer" : "Edit computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }.disabled(Server.normalize(url) == nil)
                }
            }
            .onAppear {
                guard let server else { return }
                name = server.name
                url = server.url
                username = server.username
                password = store.password(for: server)
            }
        }
        .presentationBackground(Theme.ground)
    }

    private var draft: Server {
        var s = server ?? Server(name: "", url: "")
        let address = Server.normalize(url)
        s.name = name.trimmingCharacters(in: .whitespaces).isEmpty ? (address?.host ?? "Computer") : name
        s.url = address?.absoluteString ?? url
        s.username = username.isEmpty ? "opencode" : username
        return s
    }

    private func test() async {
        guard let base = Server.normalize(url) else { return }
        testing = true
        defer { testing = false }
        let api = API(baseURL: base, username: username.isEmpty ? "opencode" : username, password: password)
        do {
            let info = try await api.info()
            let count = try await api.sessions(limit: 200).count
            result = (true, "OpenCode \(info.version) · \(count) session\(count == 1 ? "" : "s")")
        } catch {
            result = (false, error.localizedDescription)
        }
    }

    private func save() {
        let s = draft
        connections.drop(s)
        store.save(s, password: password)
        dismiss()
    }
}
