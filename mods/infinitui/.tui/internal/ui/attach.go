package ui

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"github.com/atotto/clipboard"
)

// Images and PDFs go along with a prompt inline, as data: URIs, as in the classic UI
// (component/prompt/local-attachment.ts): paste or drag in a path to one, or press ctrl+v with an image on the
// clipboard, and the composer shows an [Image 1] chip in its place.

const maxAttachBytes = 20 << 20 // the server's limit for one attachment, and the classic UI's for one paste

var attachMimes = map[string]string{
	".avif": "image/avif", ".gif": "image/gif", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
	".pdf": "application/pdf", ".png": "image/png", ".webp": "image/webp",
}

type attachment struct {
	name, mime string
	data       []byte
}

// pastedAttachments reads a paste that is nothing but paths or file:// URLs of images and PDFs: a file dragged
// onto the terminal, or several. Anything else, or a file it cannot read, leaves the paste as text (nil).
func pastedAttachments(text string) []attachment {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > 16<<10 {
		return nil
	}
	if p := pastedPath(text); attachMimes[strings.ToLower(filepath.Ext(p))] != "" && isFile(p) {
		return readAttachments([]string{p})
	}
	return readAttachments(splitPastedPaths(text))
}

func readAttachments(paths []string) []attachment {
	if len(paths) == 0 || len(paths) > 32 {
		return nil
	}
	var out []attachment
	left := maxAttachBytes
	for _, p := range paths {
		mime := attachMimes[strings.ToLower(filepath.Ext(p))]
		if mime == "" || !isFile(p) {
			return nil
		}
		data, err := readBounded(p, left)
		if err != nil {
			return nil
		}
		left -= len(data)
		out = append(out, attachment{name: filepath.Base(p), mime: mime, data: data})
	}
	return out
}

func isFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular()
}

func readBounded(p string, limit int) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err == nil && len(data) > limit {
		err = fmt.Errorf("%s: over the %d MB attachment limit", filepath.Base(p), maxAttachBytes>>20)
	}
	return data, err
}

var shellEscape = regexp.MustCompile(`\\(.)`)

// pastedPath is one pasted path without its quotes. A file:// URL becomes a local path; outside Windows a
// shell-escaped path (my\ shot.png, as macOS and Linux terminals paste a dragged file) is unescaped.
func pastedPath(s string) string {
	s = strings.Trim(s, `'"`)
	if p, ok := fileURLPath(s); ok {
		return p
	}
	if runtime.GOOS == "windows" {
		return s
	}
	return shellEscape.ReplaceAllString(s, "$1")
}

func fileURLPath(s string) (string, bool) {
	if !strings.HasPrefix(s, "file://") {
		return "", false
	}
	u, err := url.Parse(s)
	if err != nil || (u.Host != "" && u.Host != "localhost") {
		return "", false
	}
	if runtime.GOOS == "windows" {
		return filepath.FromSlash(strings.TrimPrefix(u.Path, "/")), true // file:///C:/x.png
	}
	return u.Path, true
}

// splitPastedPaths splits several pasted paths on whitespace, honouring quotes and, outside Windows, backslash
// escapes; a text/uri-list paste drops its # comment lines. An unclosed quote is not a list of paths.
func splitPastedPaths(s string) []string {
	if strings.Contains(s, "file://") {
		var keep []string
		for _, l := range strings.Split(s, "\n") {
			if !strings.HasPrefix(strings.TrimSpace(l), "#") {
				keep = append(keep, l)
			}
		}
		s = strings.Join(keep, "\n")
	}
	var out []string
	var cur strings.Builder
	push := func() {
		if cur.Len() == 0 {
			return
		}
		p := cur.String()
		if fp, ok := fileURLPath(p); ok {
			p = fp
		}
		out = append(out, p)
		cur.Reset()
	}
	escapes := runtime.GOOS != "windows"
	quote := rune(0)
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case quote != 0 && c == quote:
			quote = 0
		case quote == 0 && (c == '\'' || c == '"'):
			quote = c
		case escapes && c == '\\' && quote != '\'' && i+1 < len(rs):
			i++
			cur.WriteRune(rs[i])
		case quote == 0 && unicode.IsSpace(c):
			push()
		default:
			cur.WriteRune(c)
		}
	}
	if quote != 0 {
		return nil
	}
	push()
	return out
}

// clipboardMsg is what a clipboard read found: an image, files copied in a file manager, or text.
type clipboardMsg struct {
	image    []byte // PNG
	files    []string
	text     string
	explicit bool // ctrl+v, rather than an empty paste
}

// readClipboard looks for an image first, then (for ctrl+v) text. Windows Terminal before 1.25 pastes nothing at
// all when the clipboard holds only an image, so an empty paste lands here too.
func readClipboard(explicit bool) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		msg := clipboardMsg{explicit: explicit}
		msg.image, msg.files = clipboardImage(ctx)
		if msg.image == nil && msg.files == nil && explicit {
			msg.text, _ = clipboard.ReadAll()
		}
		return msg
	}
}

// Windows: System.Windows.Forms reads the bitmap (Snipping Tool, browsers) or Explorer's copied files; paths go out
// base64-encoded so no console code page mangles them.
const winClipboard = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$c = [System.Windows.Forms.Clipboard]
if ($c::ContainsImage()) {
  $m = New-Object System.IO.MemoryStream
  $c::GetImage().Save($m, [System.Drawing.Imaging.ImageFormat]::Png)
  'png:' + [Convert]::ToBase64String($m.ToArray())
} elseif ($c::ContainsFileDropList()) {
  foreach ($f in $c::GetFileDropList()) { 'file:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f)) }
}`

func clipboardImage(ctx context.Context) (png []byte, files []string) {
	run := func(name string, args ...string) []byte {
		if _, err := exec.LookPath(name); err != nil {
			return nil
		}
		cmd := exec.CommandContext(ctx, name, args...)
		hideConsole(cmd)
		out, _ := cmd.Output()
		return out
	}
	isPNG := func(b []byte) []byte {
		if len(b) > 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n" {
			return b
		}
		return nil
	}
	switch runtime.GOOS {
	case "windows":
		for _, line := range strings.Split(string(run("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", winClipboard)), "\n") {
			kind, data, _ := strings.Cut(strings.TrimSpace(line), ":")
			b, err := base64.StdEncoding.DecodeString(data)
			if err != nil {
				continue
			}
			if kind == "png" {
				return isPNG(b), nil
			}
			if kind == "file" {
				files = append(files, string(b))
			}
		}
		return nil, files
	case "darwin":
		out := strings.TrimSpace(string(run("osascript", "-e", "the clipboard as «class PNGf»")))
		if b, err := hex.DecodeString(strings.TrimSuffix(strings.TrimPrefix(out, "«data PNGf"), "»")); err == nil && isPNG(b) != nil {
			return b, nil
		}
		// A file copied in Finder.
		if p := strings.TrimSpace(string(run("osascript", "-e", "POSIX path of (the clipboard as «class furl»)"))); p != "" {
			return nil, []string{p}
		}
		return nil, nil
	default:
		if os.Getenv("WAYLAND_DISPLAY") != "" {
			if b := isPNG(run("wl-paste", "--no-newline", "--type", "image/png")); b != nil {
				return b, nil
			}
		}
		return isPNG(run("xclip", "-selection", "clipboard", "-t", "image/png", "-o")), nil
	}
}

// pasteText is a paste into the composer: attachments when it is only paths of images or PDFs, else text.
func (a *App) pasteText(text string) {
	if atts := pastedAttachments(text); atts != nil {
		for _, att := range atts {
			a.prompt.Attach(att)
		}
		return
	}
	a.prompt.Paste(text)
}

func (a *App) clipboardResult(m clipboardMsg) tea.Cmd {
	if a.dialog != nil || a.perm != nil {
		return nil
	}
	switch {
	case m.image != nil:
		a.prompt.Attach(attachment{name: "clipboard", mime: "image/png", data: m.image})
	case m.files != nil:
		if atts := readAttachments(m.files); atts != nil {
			for _, att := range atts {
				a.prompt.Attach(att)
			}
		} else {
			a.prompt.Paste(strings.Join(m.files, " "))
		}
	case m.text != "":
		a.pasteText(strings.ReplaceAll(m.text, "\r\n", "\n"))
	case m.explicit:
		return a.showToast("info", "", "Nothing on the clipboard to paste", 2*time.Second)
	}
	return a.refreshCompletion()
}
