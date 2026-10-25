import SwiftUI

@main
struct InfiniteOCApp: App {
    @State private var store = ServerStore()
    @State private var connections = Connections()

    var body: some Scene {
        WindowGroup {
            ServersView()
                .environment(store)
                .environment(connections)
                .tint(Theme.purple)
                .preferredColorScheme(.dark)
        }
    }
}
