package ui

import (
	"encoding/json"
	"fmt"
	"testing"

	"infiniteoc/infinitui/internal/api"
)

// bigSession builds n turns: prompt, a reply with markdown and a code block, two reads, an idle row.
func bigSession(n int) *sessionData {
	d := &sessionData{index: map[string]*api.Message{}, versions: map[string]int{}, loaded: true}
	id := 0
	next := func() string { id++; return fmt.Sprintf("msg_%08d", id) }
	done := true
	for i := 0; i < n; i++ {
		u := &api.Message{ID: next(), Type: "user", Text: fmt.Sprintf("question number %d about the code", i)}
		u.Time.Created = int64(i * 1000)
		d.upsert(u)
		a := &api.Message{ID: next(), Type: "assistant", Agent: "build", Model: &api.ModelRef{ID: "m", ProviderID: "p"}}
		a.Time.Created, a.Time.Completed = int64(i*1000+1), int64(i*1000+900)
		in, _ := json.Marshal(map[string]any{"path": "main.go"})
		for j := 0; j < 2; j++ {
			a.Content = append(a.Content, &api.Block{Type: "tool", ID: fmt.Sprintf("t%d%d", i, j), Name: "read", Executed: &done,
				State: &api.ToolState{Status: "completed", Input: in, Content: []api.ToolContent{{Type: "text", Text: "Read file main.go, lines 1-2\n1: a\n2: b"}}}})
		}
		a.Content = append(a.Content, &api.Block{Type: "text", Text: "Here is **the** answer.\n\n```go\nfunc x() {}\n```\n\n- one\n- two"})
		a.Tokens = &api.TokenUsage{Output: 100}
		d.upsert(a)
		idle := &api.Message{ID: next(), Type: "idle", Outcome: "succeeded"}
		idle.Time.Created = int64(i*1000 + 950)
		d.upsert(idle)
	}
	return d
}

func BenchmarkBuildCached(b *testing.B) {
	d := bigSession(400)
	tr := NewTranscript()
	o := renderOpts{width: 120, expanded: map[string]bool{}, store: NewStore(), reveal: map[*api.Block]int{}}
	tr.Build(d, o) // warm the caches, as after the first frame
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		tr.Build(d, o)
	}
	b.ReportMetric(float64(len(tr.lines)), "lines")
}
