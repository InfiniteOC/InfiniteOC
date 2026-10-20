package render

import (
	"image/color"
	"strings"
	"sync"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"

	"infiniteoc/infinitui/internal/theme"
)

var (
	styleMu    sync.Mutex
	styleCache = map[string]*chroma.Style{}
)

func chromaStyle() *chroma.Style {
	name := "rose-pine-moon"
	if !theme.Current.Dark {
		name = "rose-pine-dawn"
	}
	styleMu.Lock()
	defer styleMu.Unlock()
	if s, ok := styleCache[name]; ok {
		return s
	}
	s := styles.Get(name)
	if s == nil {
		s = styles.Fallback
	}
	styleCache[name] = s
	return s
}

// LexerFor picks a lexer from a filename or a fenced-code language.
func LexerFor(nameOrLang string) chroma.Lexer {
	if nameOrLang == "" {
		return nil
	}
	if l := lexers.Match(nameOrLang); l != nil {
		return chroma.Coalesce(l)
	}
	if l := lexers.Get(nameOrLang); l != nil {
		return chroma.Coalesce(l)
	}
	return nil
}

// HighlightLines tokenises the whole text once (so multi-line constructs colour correctly) and
// returns one styled string per source line. bg, when set, is painted under every token.
func HighlightLines(text string, lexer chroma.Lexer, bg color.Color) []string {
	lines := strings.Split(text, "\n")
	if lexer == nil {
		out := make([]string, len(lines))
		st := lipgloss.NewStyle().Foreground(theme.Current.Text)
		if bg != nil {
			st = st.Background(bg)
		}
		for i, l := range lines {
			out[i] = st.Render(l)
		}
		return out
	}
	it, err := lexer.Tokenise(nil, text)
	if err != nil {
		return HighlightLines(text, nil, bg)
	}
	style := chromaStyle()
	out := make([]string, 0, len(lines))
	var cur strings.Builder
	for _, tok := range it.Tokens() {
		entry := style.Get(tok.Type)
		st := lipgloss.NewStyle()
		if entry.Colour.IsSet() {
			st = st.Foreground(lipgloss.Color(entry.Colour.String()))
		} else {
			st = st.Foreground(theme.Current.Text)
		}
		if entry.Bold == chroma.Yes {
			st = st.Bold(true)
		}
		if entry.Italic == chroma.Yes {
			st = st.Italic(true)
		}
		if bg != nil {
			st = st.Background(bg)
		}
		parts := strings.Split(tok.Value, "\n")
		for i, p := range parts {
			if i > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
			if p != "" {
				cur.WriteString(st.Render(expandTabs(p)))
			}
		}
	}
	out = append(out, cur.String())
	// Tokenisers append a trailing newline; keep the line count equal to the input.
	for len(out) > len(lines) {
		out = out[:len(out)-1]
	}
	for len(out) < len(lines) {
		out = append(out, "")
	}
	return out
}

func expandTabs(s string) string {
	if !strings.Contains(s, "\t") {
		return s
	}
	return strings.ReplaceAll(s, "\t", "    ")
}
