package render

import (
	"fmt"
	"strings"
	"sync"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/theme"
)

// segment is a run of prose or one fenced code block.
type segment struct {
	code   bool
	lang   string
	text   string
	closed bool // the closing fence arrived (always true for prose)
}

// splitFences cuts markdown into prose and fenced code. An unclosed fence at the end (still
// streaming) becomes an open code segment.
func splitFences(text string) []segment {
	var out []segment
	var cur strings.Builder
	inCode := false
	fence := ""
	lang := ""
	flush := func(code, closed bool) {
		s := cur.String()
		cur.Reset()
		if !code && strings.TrimSpace(s) == "" {
			return
		}
		out = append(out, segment{code: code, lang: lang, text: strings.TrimSuffix(s, "\n"), closed: closed})
	}
	for _, line := range strings.SplitAfter(text, "\n") {
		trimmed := strings.TrimSpace(line)
		indent := len(line) - len(strings.TrimLeft(line, " "))
		if !inCode && indent <= 3 && (strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")) {
			flush(false, true)
			inCode = true
			fence = trimmed[:3]
			lang = strings.TrimSpace(strings.TrimLeft(trimmed, "`~"))
			if i := strings.IndexAny(lang, " {"); i >= 0 {
				lang = lang[:i]
			}
			continue
		}
		if inCode && strings.HasPrefix(trimmed, fence) && strings.Trim(trimmed, fence[:1]) == "" {
			flush(true, true)
			inCode = false
			lang = ""
			continue
		}
		cur.WriteString(line)
	}
	if inCode {
		flush(true, false)
	} else {
		flush(false, true)
	}
	return out
}

var (
	codeMu    sync.Mutex
	codeCache = map[string][]string{}
)

// CodeBlock frames highlighted code: the language sits in the top border, line numbers in a gutter.
func CodeBlock(lang, code string, width int, open bool) []string {
	key := fmt.Sprintf("%s|%d|%v|%s|%s", lang, width, open, theme.Current.Name, code)
	codeMu.Lock()
	if v, ok := codeCache[key]; ok {
		codeMu.Unlock()
		return v
	}
	codeMu.Unlock()

	p := theme.Current
	border := lipgloss.NewStyle().Foreground(p.Border)
	label := lipgloss.NewStyle().Foreground(p.Accent).Bold(true)
	num := lipgloss.NewStyle().Foreground(p.Subtle)

	src := strings.ReplaceAll(code, "\t", "    ")
	lines := HighlightLines(src, LexerFor(lang), nil)
	numW := len(fmt.Sprint(len(lines)))
	inner := width - 2
	body := inner - numW - 3 // " N │ code" minus borders

	title := lang
	if title == "" {
		title = "text"
	}
	head := border.Render("╭─ ") + label.Render(title) + " "
	right := ""
	if open {
		right = lipgloss.NewStyle().Foreground(p.Subtle).Render(" writing… ")
	} else {
		label := "click to copy"
		if len(lines) > 1 {
			label = fmt.Sprintf("%d lines · click to copy", len(lines))
		}
		right = lipgloss.NewStyle().Foreground(p.Subtle).Render(" " + label + " ")
	}
	fill := width - ansi.StringWidth(head) - ansi.StringWidth(right) - 2
	out := []string{head + border.Render(strings.Repeat("─", max(1, fill))) + right + border.Render("─╮")}
	for i, l := range lines {
		if ansi.StringWidth(l) > body {
			l = ansi.Truncate(l, body-1, "") + num.Render("…")
		}
		pad := max(0, body-ansi.StringWidth(l))
		out = append(out, border.Render("│")+num.Render(fmt.Sprintf(" %*d ", numW, i+1))+l+strings.Repeat(" ", pad)+border.Render(" │"))
	}
	out = append(out, border.Render("╰"+strings.Repeat("─", max(0, width-2))+"╯"))

	if !open {
		codeMu.Lock()
		if len(codeCache) > 2000 {
			codeCache = map[string][]string{}
		}
		codeCache[key] = out
		codeMu.Unlock()
	}
	return out
}

// Rich renders markdown with InfiniTUI code blocks. streaming marks text that is still arriving.
func Rich(text string, width int, streaming bool) []string {
	lines, _, _ := RichMap(text, width, streaming)
	return lines
}

// RichMap is Rich plus, per output line, the index of the code block it belongs to (-1 for prose)
// and the source of each code block, so a click can copy the block under the pointer.
func RichMap(text string, width int, streaming bool) ([]string, []int, []string) {
	segs := splitFences(text)
	var out []string
	var owner []int
	var codes []string
	for i, sg := range segs {
		last := i == len(segs)-1
		var lines []string
		if sg.code {
			cw := min(width, max(30, longestLine(sg.text)+numWidth(sg.text)+8))
			lines = CodeBlock(sg.lang, sg.text, cw, !sg.closed)
		} else if streaming && last {
			lines = MarkdownStreaming(sg.text, width)
		} else {
			lines = Markdown(sg.text, width)
		}
		if len(lines) == 0 {
			continue
		}
		if len(out) > 0 {
			out = append(out, "")
			owner = append(owner, -1)
		}
		idx := -1
		if sg.code {
			idx = len(codes)
			codes = append(codes, sg.text)
		}
		out = append(out, lines...)
		for range lines {
			owner = append(owner, idx)
		}
	}
	return out, owner, codes
}

func longestLine(s string) int {
	n := 0
	for _, l := range strings.Split(strings.ReplaceAll(s, "\t", "    "), "\n") {
		n = max(n, ansi.StringWidth(l))
	}
	return n
}

func numWidth(s string) int { return len(fmt.Sprint(strings.Count(s, "\n") + 1)) }
