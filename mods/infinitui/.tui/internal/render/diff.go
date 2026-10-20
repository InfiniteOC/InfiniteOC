package render

import (
	"fmt"
	"image/color"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/aymanbagabas/go-udiff"
	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/theme"
)

// DiffKind is the role of one diff line.
type DiffKind int

const (
	DiffContext DiffKind = iota
	DiffAdd
	DiffDel
	DiffGap // between hunks
)

// DiffLine is one rendered row of a unified diff.
type DiffLine struct {
	Kind     DiffKind
	Old, New int // 1-based line numbers; 0 when absent
	Text     string
}

// DiffStat counts changed lines.
type DiffStat struct{ Add, Del int }

// ParseUnified reads a unified diff (headers optional) into rows.
func ParseUnified(text string) ([]DiffLine, DiffStat) {
	var rows []DiffLine
	var stat DiffStat
	oldNo, newNo := 0, 0
	seenHunk := false
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		switch {
		case strings.HasPrefix(l, "@@"):
			o, n := parseHunkHeader(l)
			if seenHunk {
				rows = append(rows, DiffLine{Kind: DiffGap})
			}
			seenHunk = true
			oldNo, newNo = o, n
		case !seenHunk:
			continue // ---/+++/Index headers
		case strings.HasPrefix(l, "+"):
			rows = append(rows, DiffLine{Kind: DiffAdd, New: newNo, Text: l[1:]})
			newNo++
			stat.Add++
		case strings.HasPrefix(l, "-"):
			rows = append(rows, DiffLine{Kind: DiffDel, Old: oldNo, Text: l[1:]})
			oldNo++
			stat.Del++
		case strings.HasPrefix(l, `\`):
			continue // "\ No newline at end of file"
		default:
			t := l
			if strings.HasPrefix(t, " ") {
				t = t[1:]
			}
			rows = append(rows, DiffLine{Kind: DiffContext, Old: oldNo, New: newNo, Text: t})
			oldNo++
			newNo++
		}
	}
	return rows, stat
}

func parseHunkHeader(l string) (int, int) {
	// @@ -a,b +c,d @@
	f := strings.Fields(l)
	num := func(s string) int {
		s = strings.TrimLeft(s, "+-")
		if i := strings.IndexByte(s, ','); i >= 0 {
			s = s[:i]
		}
		v, _ := strconv.Atoi(s)
		return v
	}
	if len(f) < 3 {
		return 1, 1
	}
	return num(f[1]), num(f[2])
}

// DiffStrings computes rows from two file versions.
func DiffStrings(before, after string, context int) ([]DiffLine, DiffStat) {
	// Snippets often lack a final newline; without one the last line always looks changed.
	if !strings.HasSuffix(before, "\n") {
		before += "\n"
	}
	if !strings.HasSuffix(after, "\n") {
		after += "\n"
	}
	edits := udiff.Lines(before, after)
	u, err := udiff.ToUnified("a", "b", before, edits, context)
	if err != nil {
		return nil, DiffStat{}
	}
	return ParseUnified(u)
}

// DiffOptions control RenderDiff.
type DiffOptions struct {
	Filename string
	Width    int
	MaxRows  int // 0 = unlimited
}

// RenderDiff draws rows with a line-number gutter, tinted backgrounds, syntax colour and
// intra-line emphasis for paired -/+ lines. Returns the lines and how many rows were hidden.
func RenderDiff(rows []DiffLine, o DiffOptions) ([]string, int) {
	p := theme.Current
	if o.Width < 20 {
		o.Width = 20
	}
	maxNo := 0
	for _, r := range rows {
		maxNo = max(maxNo, r.Old, r.New)
	}
	numW := max(len(strconv.Itoa(maxNo)), 2)

	shown := rows
	hidden := 0
	if o.MaxRows > 0 && len(rows) > o.MaxRows {
		shown = rows[:o.MaxRows]
		hidden = len(rows) - o.MaxRows
	}

	// Highlight old-side and new-side text as two documents so multi-line tokens stay coherent.
	lexer := LexerFor(o.Filename)
	var oldSrc, newSrc []string
	oldIdx := make([]int, len(shown))
	newIdx := make([]int, len(shown))
	for i, r := range shown {
		oldIdx[i], newIdx[i] = -1, -1
		switch r.Kind {
		case DiffDel:
			oldIdx[i] = len(oldSrc)
			oldSrc = append(oldSrc, r.Text)
		case DiffAdd:
			newIdx[i] = len(newSrc)
			newSrc = append(newSrc, r.Text)
		case DiffContext:
			newIdx[i] = len(newSrc)
			newSrc = append(newSrc, r.Text)
			oldSrc = append(oldSrc, r.Text)
		}
	}
	emph := pairEmphasis(shown)
	oldHL := highlightRows(oldSrc, lexer, shown, oldIdx, DiffDel, emph)
	newHL := highlightRows(newSrc, lexer, shown, newIdx, DiffAdd, emph)

	gutter := lipgloss.NewStyle().Foreground(p.DiffLineNo)
	out := make([]string, 0, len(shown)+1)
	for i, r := range shown {
		var no, sign, body string
		var bg lipgloss.Style
		switch r.Kind {
		case DiffGap:
			out = append(out, gutter.Render(strings.Repeat(" ", numW)+"  ⋮"))
			continue
		case DiffAdd:
			no = fmt.Sprintf("%*d", numW, r.New)
			sign = "+"
			bg = lipgloss.NewStyle().Background(p.DiffAddBg)
			body = newHL[i]
		case DiffDel:
			no = fmt.Sprintf("%*d", numW, r.Old)
			sign = "-"
			bg = lipgloss.NewStyle().Background(p.DiffDelBg)
			body = oldHL[i]
		default:
			no = fmt.Sprintf("%*d", numW, r.New)
			sign = " "
			body = newHL[i]
		}
		prefixW := numW + 3
		avail := o.Width - prefixW
		if ansi.StringWidth(body) > avail {
			body = ansi.Truncate(body, avail-1, "") + bg.Foreground(p.Subtle).Render("…")
		}
		var line string
		switch r.Kind {
		case DiffAdd:
			line = gutter.Background(p.DiffAddBg).Render(no+" ") + bg.Foreground(p.DiffAdd).Bold(true).Render(sign+" ") + body
		case DiffDel:
			line = gutter.Background(p.DiffDelBg).Render(no+" ") + bg.Foreground(p.DiffDel).Bold(true).Render(sign+" ") + body
		default:
			line = gutter.Render(no+" ") + "  " + body
		}
		if r.Kind != DiffContext {
			if pad := o.Width - ansi.StringWidth(line); pad > 0 {
				line += bg.Render(strings.Repeat(" ", pad))
			}
		}
		out = append(out, line)
	}
	return out, hidden
}

type span struct{ start, end int } // byte range in Text to emphasise

// pairEmphasis finds, for each run of deletions followed by the same number of additions, the
// differing middle of each pair (common prefix/suffix trimmed). Cheap and readable.
func pairEmphasis(rows []DiffLine) map[int]span {
	res := map[int]span{}
	for i := 0; i < len(rows); {
		if rows[i].Kind != DiffDel {
			i++
			continue
		}
		j := i
		for j < len(rows) && rows[j].Kind == DiffDel {
			j++
		}
		k := j
		for k < len(rows) && rows[k].Kind == DiffAdd {
			k++
		}
		if j-i == k-j {
			for n := 0; n < j-i; n++ {
				a, b := rows[i+n].Text, rows[j+n].Text
				pre := 0
				for pre < len(a) && pre < len(b) && a[pre] == b[pre] {
					pre++
				}
				suf := 0
				for suf < len(a)-pre && suf < len(b)-pre && a[len(a)-1-suf] == b[len(b)-1-suf] {
					suf++
				}
				// Only emphasise when the change is a minority of the line.
				if len(a)-pre-suf < len(a)*2/3 || len(b)-pre-suf < len(b)*2/3 {
					res[i+n] = span{pre, len(a) - suf}
					res[j+n] = span{pre, len(b) - suf}
				}
			}
		}
		i = k
	}
	return res
}

func highlightRows(src []string, lexer chroma.Lexer, rows []DiffLine, idx []int, kind DiffKind, emph map[int]span) []string {
	out := make([]string, len(rows))
	if len(src) == 0 {
		return out
	}
	doc := strings.Join(src, "\n")
	plain := HighlightLines(doc, lexer, nil)
	tinted := HighlightLines(doc, lexer, bgColor(kind))
	for i, r := range rows {
		j := idx[i]
		if j < 0 || j >= len(plain) {
			continue
		}
		switch r.Kind {
		case kind:
			if sp, ok := emph[i]; ok && sp.end > sp.start {
				out[i] = emphasise(r.Text, sp, kind)
			} else {
				out[i] = tinted[j]
			}
		case DiffContext:
			out[i] = plain[j]
		}
	}
	return out
}

func bgColor(kind DiffKind) color.Color {
	if kind == DiffAdd {
		return theme.Current.DiffAddBg
	}
	return theme.Current.DiffDelBg
}

func emphasise(text string, sp span, kind DiffKind) string {
	p := theme.Current
	fg, bg, wbg := p.DiffAdd, p.DiffAddBg, p.DiffAddWordBg
	if kind == DiffDel {
		fg, bg, wbg = p.DiffDel, p.DiffDelBg, p.DiffDelWordBg
	}
	base := lipgloss.NewStyle().Foreground(p.Text).Background(bg)
	hot := lipgloss.NewStyle().Foreground(fg).Background(wbg).Bold(true)
	return base.Render(expandTabs(text[:sp.start])) + hot.Render(expandTabs(text[sp.start:sp.end])) + base.Render(expandTabs(text[sp.end:]))
}
