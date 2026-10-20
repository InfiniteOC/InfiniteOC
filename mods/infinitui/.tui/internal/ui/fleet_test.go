package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
)

func TestFleetCards(t *testing.T) {
	theme.Apply(theme.InfiniteOC)
	a := &App{opt: Options{Animations: true}, width: 120, cwd: "/repo"}
	now := time.Now().UnixMilli()
	a.fleet.wfs = []api.Workflow{{ID: "wf1", Name: "auth audit", Status: "running", CreatedAt: now - 42000, Steps: []api.WorkflowStep{
		{ID: "find", Title: "Find middleware", Status: "running", Model: "opencode/deepseek-v4.1-flash-free", StartedAt: now - 12000, SessionID: "ses_a",
			Activity: &api.StepActivity{Tool: "grep", Detail: "/repo/src/auth middleware", Tools: 14}},
		{ID: "spec", Title: "OAuth spec", Status: "completed", Model: "claude-code/sonnet", StartedAt: now - 9000, EndedAt: now - 1000,
			Activity: &api.StepActivity{Text: "thinking out loud", Tools: 4}, Result: "OAuth 2.1 drops implicit flow"},
		{ID: "review", Title: "Review", Status: "pending", Model: "claude-code/opus", Needs: []string{"find", "spec"}},
	}}}
	lines := a.renderFleet(120, 30, 2)
	out := ansi.Strip(strings.Join(lines, "\n"))
	for _, want := range []string{"AUTH AUDIT", "1/3 done", "Find middlewa", "deepseek-v4.1", "cc/sonnet", "grep  src/auth middleware", "14 tools", "✓ done", "waiting on find, spec", "OAuth 2.1 drops"} {
		if !strings.Contains(out, want) {
			t.Fatalf("fleet missing %q:\n%s", want, out)
		}
	}
	for _, l := range lines {
		if w := ansi.StringWidth(l); w > 120 {
			t.Fatalf("line wider than the panel (%d): %q", w, ansi.Strip(l))
		}
	}
	// Three cards fit side by side at 120 columns; clicking the running OpenCode step opens its session.
	if len(a.fleet.hits) != 3 || a.fleet.hits[0].sessionID != "ses_a" || a.fleet.hits[1].x0 <= a.fleet.hits[0].x0 {
		t.Fatalf("unexpected hit boxes: %+v", a.fleet.hits)
	}
	a.fleet.open = true
	if _, in := a.fleetClick(a.fleet.hits[1].x0+1, a.fleet.hits[1].y0+1); !in {
		t.Fatal("a click on a Claude Code card stays in the panel")
	}
}

func TestFleetGroupGrid(t *testing.T) {
	theme.Apply(theme.InfiniteOC)
	a := &App{opt: Options{Animations: true}, width: 120, cwd: "/repo"}
	now := time.Now().UnixMilli()
	cells := strings.Repeat("c", 300) + "f" + strings.Repeat("r", 8) + strings.Repeat("p", 191)
	a.fleet.wfs = []api.Workflow{{ID: "wf", Name: "big", Status: "running", CreatedAt: now - 60000, Steps: []api.WorkflowStep{
		{ID: "scan", Title: "Summarize", Status: "running", Model: "opencode/deepseek-v4.1-flash-free", Group: true, Cells: cells, StartedAt: now - 60000,
			Members: []api.WorkflowStep{{ID: "scan-302", Item: "src/file301.ts", Status: "running", Activity: &api.StepActivity{Tool: "read", Detail: "/repo/src/file301.ts"}}}},
		{ID: "sum", Title: "Rank", Status: "pending", Needs: []string{"scan-1"}},
	}}}
	lines := a.renderFleet(120, 40, 2)
	out := ansi.Strip(strings.Join(lines, "\n"))
	for _, want := range []string{"Summarize ×500", "300/501 done", "300/500 done", "8 running", "1 failed", "5.0/s", "left", "src/file301.ts  read  src/file301.ts", "Rank"} {
		if !strings.Contains(out, want) {
			t.Fatalf("group card missing %q:\n%s", want, out)
		}
	}
	if got := strings.Count(out, "●"); got != 300 {
		t.Fatalf("want one dot per finished item, got %d:\n%s", got, out)
	}
	for _, l := range lines {
		if w := ansi.StringWidth(l); w > 120 {
			t.Fatalf("line wider than the panel (%d): %q", w, ansi.Strip(l))
		}
	}
	// In a small panel the grid buckets items instead of overflowing.
	small := a.renderFleet(60, 12, 2)
	if len(small) > 12 {
		t.Fatalf("panel overflowed: %d lines", len(small))
	}
}
