package render

import (
	"fmt"
	"image/color"
	"strings"
	"sync"

	"charm.land/glamour/v2"
	gansi "charm.land/glamour/v2/ansi"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/theme"
)

func hexOf(c color.Color) *string {
	if c == nil {
		return nil
	}
	r, g, b, _ := c.RGBA()
	s := fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
	return &s
}

func bp(b bool) *bool     { return &b }
func sp(s string) *string { return &s }
func up(u uint) *uint     { return &u }

// markdownStyle maps the palette onto glamour. Margins are zero: the transcript owns indentation.
func markdownStyle(p theme.Palette) gansi.StyleConfig {
	codeTheme := "rose-pine-moon"
	if !p.Dark {
		codeTheme = "rose-pine-dawn"
	}
	return gansi.StyleConfig{
		Document:       gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Color: hexOf(p.Text)}},
		BlockQuote:     gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Color: hexOf(p.Muted), Italic: bp(true)}, Indent: up(1), IndentToken: sp("▎ ")},
		Paragraph:      gansi.StyleBlock{},
		List:           gansi.StyleList{LevelIndent: 2},
		Heading:        gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{BlockSuffix: "\n", Color: hexOf(p.Primary), Bold: bp(true)}},
		H1:             gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Prefix: "▍", Color: hexOf(p.Accent), Bold: bp(true)}},
		H2:             gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Prefix: "▍", Color: hexOf(p.Primary)}},
		H3:             gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Prefix: "◆ ", Color: hexOf(p.Primary)}},
		H4:             gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Prefix: "◇ ", Color: hexOf(p.Muted)}},
		H5:             gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Prefix: "· ", Color: hexOf(p.Muted)}},
		H6:             gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Prefix: "· ", Color: hexOf(p.Subtle)}},
		Strikethrough:  gansi.StylePrimitive{CrossedOut: bp(true)},
		Emph:           gansi.StylePrimitive{Italic: bp(true)},
		Strong:         gansi.StylePrimitive{Bold: bp(true), Color: hexOf(p.Text)},
		HorizontalRule: gansi.StylePrimitive{Color: hexOf(p.Subtle), Format: "\n────────\n"},
		Item:           gansi.StylePrimitive{BlockPrefix: "• "},
		Enumeration:    gansi.StylePrimitive{BlockPrefix: ". "},
		Task:           gansi.StyleTask{Ticked: "✓ ", Unticked: "○ "},
		Link:           gansi.StylePrimitive{Color: hexOf(p.Info), Underline: bp(true)},
		LinkText:       gansi.StylePrimitive{Color: hexOf(p.Info), Bold: bp(true)},
		Image:          gansi.StylePrimitive{Color: hexOf(p.Info), Underline: bp(true)},
		ImageText:      gansi.StylePrimitive{Color: hexOf(p.Muted), Format: "Image: {{.text}} →"},
		Code: gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{
			Prefix: " ", Suffix: " ",
			Color: hexOf(p.Accent), BackgroundColor: hexOf(p.PanelAlt),
		}},
		CodeBlock: gansi.StyleCodeBlock{
			StyleBlock: gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Color: hexOf(p.Text)}, Margin: up(1)},
			Theme:      codeTheme,
		},
		Table:                 gansi.StyleTable{StyleBlock: gansi.StyleBlock{StylePrimitive: gansi.StylePrimitive{Color: hexOf(p.Text)}}},
		DefinitionDescription: gansi.StylePrimitive{BlockPrefix: "\n→ "},
	}
}

type mdKey struct {
	width int
	theme string
}

var (
	mdMu        sync.Mutex
	mdRenderers = map[mdKey]*glamour.TermRenderer{}
	mdCache     = map[string][]string{}
)

func renderer(width int) *glamour.TermRenderer {
	k := mdKey{width, theme.Current.Name}
	if r, ok := mdRenderers[k]; ok {
		return r
	}
	r, err := glamour.NewTermRenderer(
		glamour.WithStyles(markdownStyle(theme.Current)),
		glamour.WithWordWrap(width),
		glamour.WithTableWrap(true),
	)
	if err != nil {
		return nil
	}
	mdRenderers[k] = r
	return r
}

// Markdown renders text to lines at width. Results are cached by content and width.
func Markdown(text string, width int) []string {
	if width < 10 {
		width = 10
	}
	key := fmt.Sprintf("%d|%s|%s", width, theme.Current.Name, text)
	mdMu.Lock()
	defer mdMu.Unlock()
	if v, ok := mdCache[key]; ok {
		return v
	}
	var lines []string
	if r := renderer(width); r != nil {
		if out, err := r.Render(text); err == nil {
			lines = trimBlank(strings.Split(strings.TrimRight(out, "\n"), "\n"))
		}
	}
	if lines == nil {
		lines = strings.Split(ansi.Wordwrap(text, width, ""), "\n")
	}
	if len(mdCache) > 4000 {
		mdCache = map[string][]string{}
	}
	mdCache[key] = lines
	return lines
}

// MarkdownStreaming renders text that is still growing. Everything up to the last paragraph boundary
// outside a code fence is stable and served from cache, so each delta only re-renders the tail.
func MarkdownStreaming(text string, width int) []string {
	cut := stableBoundary(text)
	if cut <= 0 || cut >= len(text) {
		return Markdown(text, width)
	}
	head := Markdown(text[:cut], width)
	tail := Markdown(text[cut:], width)
	out := make([]string, 0, len(head)+len(tail)+1)
	out = append(out, head...)
	out = append(out, "")
	return append(out, tail...)
}

func stableBoundary(text string) int {
	inFence := false
	last := -1
	pos := 0
	for _, line := range strings.SplitAfter(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
		}
		pos += len(line)
		if !inFence && trimmed == "" && pos < len(text) {
			last = pos
		}
	}
	return last
}

func trimBlank(lines []string) []string {
	isBlank := func(s string) bool { return strings.TrimSpace(ansi.Strip(s)) == "" }
	for len(lines) > 0 && isBlank(lines[0]) {
		lines = lines[1:]
	}
	for len(lines) > 0 && isBlank(lines[len(lines)-1]) {
		lines = lines[:len(lines)-1]
	}
	// glamour pads every line to the wrap width; trailing spaces break our own right alignment.
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " ")
	}
	return lines
}
