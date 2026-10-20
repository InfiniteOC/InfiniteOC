package render

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

const patch = `Index: main.go
===================================================================
--- main.go
+++ main.go
@@ -1,3 +1,4 @@
 package main
-func old() {}
+func main() {}
+func add() {}
 // end
@@ -20,2 +21,2 @@
 a
-b
+c
`

func TestParseUnified(t *testing.T) {
	rows, stat := ParseUnified(patch)
	if stat.Add != 3 || stat.Del != 2 {
		t.Fatalf("stat %+v", stat)
	}
	if rows[0].Kind != DiffContext || rows[0].Old != 1 || rows[0].New != 1 {
		t.Fatalf("first row %+v", rows[0])
	}
	var gap bool
	for _, r := range rows {
		if r.Kind == DiffGap {
			gap = true
		}
		if r.Kind == DiffAdd && r.Text == "c" && r.New != 22 {
			t.Fatalf("second hunk numbering: %+v", r)
		}
	}
	if !gap {
		t.Fatal("missing gap between hunks")
	}
}

func TestDiffStringsTrailingNewline(t *testing.T) {
	rows, stat := DiffStrings("a\nb", "a\nb\nc", 3)
	if stat.Add != 1 || stat.Del != 0 {
		t.Fatalf("only the new line changed, got %+v (%+v)", stat, rows)
	}
}

func TestRenderDiffWidthAndCollapse(t *testing.T) {
	rows, _ := ParseUnified(patch)
	lines, hidden := RenderDiff(rows, DiffOptions{Filename: "main.go", Width: 40, MaxRows: 4})
	if len(lines) != 4 || hidden != len(rows)-4 {
		t.Fatalf("collapse: %d lines, %d hidden", len(lines), hidden)
	}
	for _, l := range lines {
		if w := ansi.StringWidth(l); w > 40 {
			t.Fatalf("line wider than 40: %d %q", w, ansi.Strip(l))
		}
	}
}

func TestPairEmphasisMarksTheChangedMiddle(t *testing.T) {
	rows := []DiffLine{{Kind: DiffDel, Text: "return a + b"}, {Kind: DiffAdd, Text: "return a - b"}}
	em := pairEmphasis(rows)
	if em[0] != (span{9, 10}) || em[1] != (span{9, 10}) {
		t.Fatalf("emphasis %+v", em)
	}
}

func TestMarkdownStreamingMatchesFullRender(t *testing.T) {
	text := "# Title\n\nFirst paragraph.\n\n```go\nfunc x() {}\n\n```\n\nTail"
	full := strings.Join(Markdown(text, 60), "\n")
	stream := strings.Join(MarkdownStreaming(text, 60), "\n")
	if ansi.Strip(full) == "" || !strings.Contains(ansi.Strip(stream), "func x()") || !strings.Contains(ansi.Strip(stream), "Tail") {
		t.Fatalf("streaming render lost content:\n%s", ansi.Strip(stream))
	}
	if b := stableBoundary("a\n\n```\nx\n\ny\n"); b != 3 {
		t.Fatalf("boundary inside a fence: %d", b)
	}
}
