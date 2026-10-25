import SwiftUI

struct MessageView: View {
    var message: Message
    var content: [ContentItem]

    var body: some View {
        switch message.type {
        case "user":
            UserBubble(text: message.text ?? "", files: message.files)
        case "assistant":
            AssistantView(items: content, error: message.error?.message)
        case "idle":
            IdleRow(outcome: message.outcome, error: message.error?.message)
        case "shell":
            ShellView(message: message)
        case "agent-switched":
            Note(icon: "person.crop.circle", text: "Agent: \(message.agent ?? "?")")
        case "model-switched":
            Note(icon: "cpu", text: "Model: \(message.model?.id ?? "?")")
        case "location-switched":
            Note(icon: "folder", text: "Moved to another folder")
        case "skill":
            Note(icon: "sparkles", text: "Skill: \(message.name ?? "skill")")
        case "compaction":
            Note(icon: "rectangle.compress.vertical", text: message.status == "running" ? "Compacting context…" : message.status == "failed" ? "Compaction failed" : "Context compacted")
        case "synthetic", "system":
            ExpandableNote(title: message.description ?? (message.type == "system" ? "System" : "Added context"), text: message.text ?? "")
        default:
            EmptyView()
        }
    }
}

private struct UserBubble: View {
    var text: String
    var files: [String]
    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 6) {
                Text(text)
                    .font(.body)
                    .foregroundStyle(Theme.text)
                    .textSelection(.enabled)
                ForEach(files, id: \.self) { file in
                    Label(file, systemImage: "paperclip").font(.caption).foregroundStyle(Theme.dim)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.purple.opacity(0.25)))
        }
    }
}

struct AssistantView: View {
    var items: [ContentItem]
    var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                switch item.type {
                case "text":
                    if let text = item.text, !text.isEmpty { RichText(text: text) }
                case "reasoning":
                    if let text = item.text, !text.isEmpty { ReasoningView(text: text) }
                case "tool":
                    ToolView(item: item)
                default:
                    EmptyView()
                }
            }
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Theme.red)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ReasoningView: View {
    var text: String
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "brain").font(.caption)
                    Text("Thinking").font(.caption.weight(.medium))
                    Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(Theme.faint)
            }
            .buttonStyle(.plain)
            if open {
                Text(text)
                    .font(.footnote)
                    .italic()
                    .foregroundStyle(Theme.dim)
                    .textSelection(.enabled)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 2) }
            }
        }
    }
}

struct ToolView: View {
    var item: ContentItem
    @State private var open = false

    private var state: ToolState? { item.state }
    private var status: String { state?.status ?? "streaming" }
    private var name: String { item.name ?? "tool" }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.caption)
                        .foregroundStyle(Theme.purple)
                        .frame(width: 18)
                    Text(name).font(Theme.monoSmall.weight(.semibold)).foregroundStyle(Theme.text)
                    Text(summary).font(Theme.monoSmall).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    statusIcon
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if let input = state?.input, !input.display.isEmpty {
                        CodeBlock(label: "Input", text: input.display.clipped(4000))
                    }
                    if let error = state?.error?.message {
                        CodeBlock(label: "Error", text: error.clipped(4000), color: Theme.red)
                    }
                    if let output = state?.outputText, !output.isEmpty {
                        CodeBlock(label: "Output", text: output.clipped(6000))
                    }
                }
                .padding(.horizontal, 10)
                .padding(.bottom, 10)
            }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(status == "error" ? Theme.red.opacity(0.4) : Theme.line))
    }

    @ViewBuilder private var statusIcon: some View {
        switch status {
        case "completed": Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(Theme.green.opacity(0.8))
        case "error": Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(Theme.red)
        default: ProgressView().controlSize(.mini)
        }
    }

    /// The most telling input field: the command, the path, the pattern...
    private var summary: String {
        guard let input = state?.input else { return "" }
        if case .string(let partial) = input { return partial.replacingOccurrences(of: "\n", with: " ") }
        for key in ["command", "filePath", "file_path", "path", "pattern", "url", "query", "description", "prompt", "name"] {
            if let value = input[key]?.string, !value.isEmpty {
                return key.lowercased().contains("path") ? value.shortPath : value.replacingOccurrences(of: "\n", with: " ")
            }
        }
        return ""
    }

    private var icon: String {
        let n = name.lowercased()
        if n.contains("bash") || n.contains("shell") || n.contains("exec") { return "terminal" }
        if n.contains("read") || n.contains("view") { return "doc.text" }
        if n.contains("edit") || n.contains("write") || n.contains("patch") { return "pencil" }
        if n.contains("grep") || n.contains("glob") || n.contains("find") || n.contains("search") || n.contains("list") { return "magnifyingglass" }
        if n.contains("web") || n.contains("fetch") || n.contains("http") { return "globe" }
        if n.contains("task") || n.contains("agent") || n.contains("workflow") { return "person.2" }
        if n.contains("todo") { return "checklist" }
        if n.contains("check") || n.contains("test") { return "checkmark.seal" }
        return "wrench.and.screwdriver"
    }
}

struct CodeBlock: View {
    var label: String?
    var text: String
    var color: Color = Theme.text

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let label {
                Text(label.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(Theme.faint)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(Theme.monoSmall)
                    .foregroundStyle(color)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.ground, in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

private struct ShellView: View {
    var message: Message
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("$").foregroundStyle(Theme.pink)
                Text(message.command ?? "").foregroundStyle(Theme.text)
                Spacer()
                if message.status == "running" { ProgressView().controlSize(.mini) }
            }
            .font(Theme.monoSmall)
            if let output = message.shellOutput, !output.isEmpty {
                CodeBlock(label: nil, text: output.clipped(6000))
            }
        }
        .padding(10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct IdleRow: View {
    var outcome: String?
    var error: String?
    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 8) {
                Rectangle().fill(Theme.line).frame(height: 1)
                Text(label).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(color)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            if let error { Text(error).font(.caption).foregroundStyle(Theme.red).multilineTextAlignment(.center) }
        }
        .padding(.vertical, 2)
    }
    private var label: String {
        switch outcome { case "failed": "FAILED"; case "interrupted": "STOPPED"; default: "DONE" }
    }
    private var color: Color {
        switch outcome { case "failed": Theme.red; case "interrupted": Theme.amber; default: Theme.faint }
    }
}

private struct Note: View {
    var icon: String
    var text: String
    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption)
            .foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity, alignment: .center)
    }
}

private struct ExpandableNote: View {
    var title: String
    var text: String
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "text.badge.plus").font(.caption)
                    Text(title).font(.caption).lineLimit(1)
                    if !text.isEmpty {
                        Image(systemName: "chevron.right").font(.caption2).rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
                .foregroundStyle(Theme.faint)
            }
            .buttonStyle(.plain)
            .disabled(text.isEmpty)
            if open { CodeBlock(label: nil, text: text.clipped(4000), color: Theme.dim) }
        }
    }
}

/// Markdown for agent replies: fenced code as blocks, headings bold, bullets as dots, inline styles via Foundation.
struct RichText: View {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.segments(text).enumerated()), id: \.offset) { _, segment in
                if segment.code {
                    CodeBlock(label: segment.language, text: segment.text)
                } else {
                    Text(Self.inline(segment.text))
                        .font(.body)
                        .foregroundStyle(Theme.text)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    struct Segment { var text: String; var code: Bool; var language: String? }

    static func segments(_ text: String) -> [Segment] {
        var out: [Segment] = []
        var prose: [Substring] = []
        var code: [Substring] = []
        var language: String?
        var inCode = false
        func flushProse() {
            let joined = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { out.append(Segment(text: joined, code: false)) }
            prose = []
        }
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    out.append(Segment(text: code.joined(separator: "\n"), code: true, language: language))
                    code = []
                    inCode = false
                } else {
                    flushProse()
                    let lang = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    language = lang.isEmpty ? nil : lang
                    inCode = true
                }
            } else if inCode {
                code.append(line)
            } else {
                prose.append(line)
            }
        }
        // A fence still open while streaming shows as code so far.
        if inCode { out.append(Segment(text: code.joined(separator: "\n"), code: true, language: language)) }
        flushProse()
        return out
    }

    static func inline(_ text: String) -> AttributedString {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let s = String(line)
            let stripped = s.trimmingCharacters(in: .whitespaces)
            if stripped.hasPrefix("#") {
                let title = stripped.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                return title.isEmpty ? s : "**\(title)**"
            }
            for bullet in ["- ", "* ", "+ "] where stripped.hasPrefix(bullet) {
                let indent = String(s.prefix { $0 == " " })
                return indent + "• " + stripped.dropFirst(2)
            }
            return s
        }
        let source = lines.joined(separator: "\n")
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        var result = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
        for run in result.runs where run.inlinePresentationIntent?.contains(.code) == true {
            result[run.range].font = .system(.callout, design: .monospaced)
            result[run.range].foregroundColor = Theme.pink
        }
        return result
    }
}
