package ui

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"infiniteoc/infinitui/internal/api"
)

func TestClassicFeatures(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".runtime", "opencode")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	built := `[{"slash":"clearall","title":"Close all session tabs","category":"Session","aliases":[]},{"slash":"yolo","title":"YOLO"},{"slash":"context","title":"Context"},{"slash":"hello","title":"Hello","aliases":["hi"]}]`
	if err := os.WriteFile(filepath.Join(dir, "infiniteoc-features.json"), []byte(built), 0o644); err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(home, "live.json")
	t.Setenv("INFINITEOC_HOME", home)
	t.Setenv("INFINITEOC_LIVE_MANIFEST", live)
	a := &App{store: NewStore(), tr: NewTranscript(), prompt: NewPrompt(), opt: Options{Handoff: filepath.Join(home, "handoff")}, sessionID: "ses_1"}
	a.store.features = []api.RPCFeature{{ID: "context", Slash: "context"}}
	slashes := func() (out []string) {
		for _, f := range a.visibleClassicFeatures() {
			out = append(out, f.Slash)
		}
		return out
	}

	// InfiniTUI's own commands (/yolo) and server-built views (/context) win; the rest are listed.
	if got := slashes(); !reflect.DeepEqual(got, []string{"clearall", "hello"}) {
		t.Fatalf("listed %v", got)
	}
	// By alias too, and submitting one hands it, with the session, to a classic client.
	a.submit("/hi")
	handoff, err := os.ReadFile(a.opt.Handoff)
	if err != nil || string(handoff) != "ses_1\nhello" || a.ExitCode() != ExitClassic {
		t.Fatalf("handoff %q (%v), exit %d", handoff, err, a.ExitCode())
	}
	// A generation the opendaemon published live replaces the build's list, as in the classic UI.
	if err := os.WriteFile(live, []byte(`{"revision":"r1","commands":[{"slash":"fresh","title":"Fresh","module":"file:///x.mjs"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := slashes(); !reflect.DeepEqual(got, []string{"fresh"}) {
		t.Fatalf("listed %v with a live generation", got)
	}
	// No InfiniteOC home (InfiniTUI run on its own): nothing to list.
	t.Setenv("INFINITEOC_HOME", "")
	t.Setenv("INFINITEOC_LIVE_MANIFEST", "")
	if got := slashes(); got != nil {
		t.Fatalf("listed %v without a home", got)
	}
}
