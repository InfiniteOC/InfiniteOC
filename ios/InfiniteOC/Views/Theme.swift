import SwiftUI

/// InfiniteOC's palette: the TUI and web theme's purple and pink on a near-black violet ground.
enum Theme {
    static let ground = Color(red: 22 / 255, green: 16 / 255, blue: 28 / 255)       // #16101C
    static let surface = Color(red: 33 / 255, green: 26 / 255, blue: 41 / 255)      // #211A29
    static let raised = Color(red: 45 / 255, green: 36 / 255, blue: 56 / 255)       // #2D2438
    static let line = Color.white.opacity(0.08)
    static let purple = Color(red: 192 / 255, green: 132 / 255, blue: 252 / 255)    // #C084FC
    static let pink = Color(red: 244 / 255, green: 114 / 255, blue: 182 / 255)      // #F472B6
    static let deepPurple = Color(red: 147 / 255, green: 51 / 255, blue: 234 / 255) // #9333EA
    static let text = Color.white.opacity(0.92)
    static let dim = Color.white.opacity(0.55)
    static let faint = Color.white.opacity(0.35)
    static let green = Color(red: 134 / 255, green: 239 / 255, blue: 172 / 255)
    static let red = Color(red: 252 / 255, green: 129 / 255, blue: 129 / 255)
    static let amber = Color(red: 252 / 255, green: 211 / 255, blue: 77 / 255)

    static let gradient = LinearGradient(colors: [purple, pink], startPoint: .leading, endPoint: .trailing)

    static let mono = Font.system(.footnote, design: .monospaced)
    static let monoSmall = Font.system(.caption, design: .monospaced)
}

extension String {
    /// `/Users/me/code/app` → `code/app`.
    var shortPath: String {
        let parts = split(separator: "/")
        return parts.suffix(2).joined(separator: "/").isEmpty ? self : parts.suffix(2).joined(separator: "/")
    }

    func clipped(_ max: Int) -> String {
        count > max ? String(prefix(max)) + "\n… (\(count - max) more characters)" : self
    }
}

/// A small pulsing dot for "running".
struct PulseDot: View {
    var color: Color = Theme.pink
    @State private var on = false
    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .opacity(on ? 1 : 0.35)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: on)
            .onAppear { on = true }
    }
}

struct ToastView: View {
    var toast: Toast
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(color)
            VStack(alignment: .leading, spacing: 2) {
                if let title = toast.title { Text(title).font(.subheadline.weight(.semibold)) }
                Text(toast.message).font(.subheadline).foregroundStyle(Theme.text)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(color.opacity(0.4)))
        .padding(.horizontal, 16)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var color: Color {
        switch toast.variant { case "error": Theme.red; case "warning": Theme.amber; case "success": Theme.green; default: Theme.purple }
    }
    private var icon: String {
        switch toast.variant { case "error": "xmark.octagon"; case "warning": "exclamationmark.triangle"; case "success": "checkmark.circle"; default: "info.circle" }
    }
}
