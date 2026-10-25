import Foundation
import Observation
import Security

/// A computer running `infiniteoc serve`. The password lives in the Keychain, the rest in UserDefaults.
struct Server: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var url: String
    var username = "opencode"

    var baseURL: URL? { Server.normalize(url) }

    /// Accepts `100.66.26.54:4096`, `http://host:4096/`, or a pasted sign-in link, and keeps scheme, host and port.
    static func normalize(_ text: String) -> URL? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        if !raw.contains("://") { raw = "http://" + raw }
        guard let parsed = URLComponents(string: raw), let host = parsed.host, !host.isEmpty,
              parsed.scheme == "http" || parsed.scheme == "https" else { return nil }
        var clean = URLComponents()
        clean.scheme = parsed.scheme
        clean.host = host
        clean.port = parsed.port
        return clean.url
    }
}

@Observable
final class ServerStore {
    private(set) var servers: [Server] = []
    private let key = "servers.v1"

    init() {
        if let data = UserDefaults.standard.data(forKey: key),
           let list = try? JSONDecoder().decode([Server].self, from: data) {
            servers = list
        }
    }

    func password(for server: Server) -> String { Keychain.read(server.id.uuidString) ?? "" }

    func api(for server: Server) -> API? {
        guard let url = server.baseURL else { return nil }
        return API(baseURL: url, username: server.username, password: password(for: server))
    }

    func save(_ server: Server, password: String) {
        if let index = servers.firstIndex(where: { $0.id == server.id }) { servers[index] = server }
        else { servers.append(server) }
        Keychain.write(server.id.uuidString, password)
        persist()
    }

    func remove(_ server: Server) {
        servers.removeAll { $0.id == server.id }
        Keychain.delete(server.id.uuidString)
        persist()
    }

    func move(from source: IndexSet, to destination: Int) {
        servers.move(fromOffsets: source, toOffset: destination)
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(servers) { UserDefaults.standard.set(data, forKey: key) }
    }
}

enum Keychain {
    private static let service = "dev.infiniteoc.app.server"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func read(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ account: String, _ value: String) {
        delete(account)
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
