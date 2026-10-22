package ui

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

const pngHead = "\x89PNG\r\n\x1a\n...."

func TestPastedAttachments(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	shot, spaced, doc := write("shot.png", pngHead), write("my shot.jpg", "jpeg"), write("spec.pdf", "%PDF")
	notes := write("notes.txt", "hi")
	names := func(atts []attachment) (out []string) {
		for _, a := range atts {
			out = append(out, a.name+" "+a.mime)
		}
		return out
	}
	cases := map[string][]string{
		shot:                               {"shot.png image/png"},
		`"` + spaced + `"`:                 {"my shot.jpg image/jpeg"},
		"file://" + filepath.ToSlash(shot): {"shot.png image/png"},
		shot + " '" + spaced + "'\n" + doc: {"shot.png image/png", "my shot.jpg image/jpeg", "spec.pdf application/pdf"},
		// Text, other files and missing files stay text.
		"look at " + shot:              nil,
		notes:                          nil,
		filepath.Join(dir, "gone.png"): nil,
		"":                             nil,
	}
	if runtime.GOOS != "windows" {
		// macOS and Linux terminals paste a dragged file shell-escaped.
		cases[strings.ReplaceAll(spaced, " ", `\ `)] = []string{"my shot.jpg image/jpeg"}
		cases["# from a file manager\nfile://"+shot+"\nfile://"+filepath.ToSlash(doc)] = []string{"shot.png image/png", "spec.pdf application/pdf"}
	}
	for in, want := range cases {
		if got := names(pastedAttachments(in)); !reflect.DeepEqual(got, want) {
			t.Errorf("%q: got %v, want %v", in, got, want)
		}
	}
	if atts := pastedAttachments(shot); len(atts) != 1 || string(atts[0].data) != pngHead {
		t.Fatalf("read %+v", atts)
	}
	// One paste is limited like one attachment.
	big := filepath.Join(dir, "big.png")
	if err := os.WriteFile(big, nil, 0o644); err != nil || os.Truncate(big, maxAttachBytes+1) != nil {
		t.Fatal("cannot make a big file")
	}
	if atts := pastedAttachments(big); atts != nil {
		t.Fatal("a file over the limit was attached")
	}
}

func TestAttachChipsBuildInlineFiles(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	p := NewPrompt()
	p.Insert("what is ")
	p.Attach(attachment{name: "a.png", mime: "image/png", data: []byte(pngHead)})
	p.Insert("vs ")
	p.Attach(attachment{name: "clipboard", mime: "image/png", data: []byte("x")})
	p.Attach(attachment{name: "spec.pdf", mime: "application/pdf", data: []byte("%PDF")})
	text := strings.TrimSpace(p.Value())
	if text != "what is [Image 1] vs [Image 2] [PDF 1]" {
		t.Fatalf("composer: %q", text)
	}
	body := p.Build(text)
	if len(body.Files) != 3 {
		t.Fatalf("files: %+v", body.Files)
	}
	f := body.Files[0]
	if f.URI != "data:image/png;base64,"+base64.StdEncoding.EncodeToString([]byte(pngHead)) || f.Name != "a.png" || f.Mention.Text != "[Image 1]" || f.Mention.Start != 8 {
		t.Fatalf("first file: %+v %+v", f, f.Mention)
	}
	if body.Files[2].URI != "data:application/pdf;base64,JVBERg==" || body.Files[2].Mention.Text != "[PDF 1]" {
		t.Fatalf("pdf: %+v", body.Files[2])
	}
	// A chip deleted from the text is not sent.
	if got := len(p.Build("vs [Image 2]").Files); got != 1 {
		t.Fatalf("sent %d files for one chip", got)
	}
}

func TestPasteAndClipboardAttach(t *testing.T) {
	a := homeApp(t)
	shot := filepath.Join(t.TempDir(), "shot.png")
	if err := os.WriteFile(shot, []byte(pngHead), 0o644); err != nil {
		t.Fatal(err)
	}
	// A dragged file arrives as a paste of its path.
	a.Update(tea.PasteMsg{Content: `"` + shot + `"`})
	// An empty paste (Windows Terminal before 1.25, image on the clipboard) asks the clipboard.
	if _, cmd := a.Update(tea.PasteMsg{}); cmd == nil {
		t.Fatal("an empty paste read nothing")
	}
	a.Update(clipboardMsg{image: []byte(pngHead)})
	a.Update(clipboardMsg{text: "and this", explicit: true})
	if v := a.prompt.Value(); v != "[Image 1] [Image 2] and this" {
		t.Fatalf("composer: %q", v)
	}
	if n := len(a.prompt.Build(a.prompt.Value()).Files); n != 2 {
		t.Fatalf("%d files", n)
	}
	// ctrl+v reads the clipboard instead of the textarea's text-only paste.
	if cmd := a.handleKey(tea.KeyPressMsg{Code: 'v', Mod: tea.ModCtrl}); cmd == nil {
		t.Fatal("ctrl+v did nothing")
	}
}
