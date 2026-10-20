// InfiniTUI is InfiniteOC's terminal interface: a Bubble Tea client for the OpenCode v2 server.
//
// Under the launcher (mods/infinitui) OpenCode's default command resolves the server and runs this
// binary with INFINITUI_SERVER_URL / INFINITUI_SERVER_PASSWORD. Run directly, it starts its own
// private `opencode serve --stdio` (like `opencode --standalone`) or connects to --server.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/colorprofile"

	"infiniteoc/infinitui/internal/api"
	"infiniteoc/infinitui/internal/theme"
	"infiniteoc/infinitui/internal/ui"
)

func main() {
	os.Exit(run())
}

func run() (code int) {
	var (
		cont    = flag.Bool("continue", false, "continue the last session")
		session = flag.String("session", "", "session ID to open")
		newID   = flag.String("new-session", "", "ID for the session the first prompt creates")
		prompt  = flag.String("prompt", "", "prompt to send on start")
		auto    = flag.Bool("auto", false, "auto-approve permissions (YOLO)")
		server  = flag.String("server", "", "server URL (password from OPENCODE_PASSWORD)")
		dir     = flag.String("dir", "", "working directory")
	)
	flag.BoolVar(cont, "c", false, "continue the last session")
	flag.StringVar(session, "s", "", "session ID to open")
	flag.Parse()

	if *dir != "" {
		if err := os.Chdir(*dir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	cwd, _ := os.Getwd()

	url := os.Getenv("INFINITUI_SERVER_URL")
	password := os.Getenv("INFINITUI_SERVER_PASSWORD")
	// The agent's tools must not inherit the server password through this process.
	os.Unsetenv("INFINITUI_SERVER_URL")
	os.Unsetenv("INFINITUI_SERVER_PASSWORD")
	if *server != "" {
		url = *server
		password = firstEnv("OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD")
	}
	os.Unsetenv("OPENCODE_PASSWORD")
	os.Unsetenv("OPENCODE_SERVER_PASSWORD")

	if url == "" {
		srv, err := startServer(cwd)
		if err != nil {
			fmt.Fprintln(os.Stderr, "infinitui:", err)
			return 1
		}
		defer srv.stop()
		url, password = srv.url, srv.password
	}

	client := api.New(url, password, cwd)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	info, err := client.Info(ctx)
	cancel()
	if err != nil {
		var ae *api.APIError
		if errors.As(err, &ae) && ae.Status == 401 {
			fmt.Fprintf(os.Stderr, "infinitui: server at %s rejected the password (set OPENCODE_PASSWORD)\n", url)
		} else {
			fmt.Fprintf(os.Stderr, "infinitui: could not reach %s: %v\n", url, err)
		}
		return 1
	}
	version := os.Getenv("INFINITUI_OPENCODE_VERSION")
	if version == "" {
		version = info.Version
	}

	theme.Limited256 = colorprofile.Detect(os.Stdout, os.Environ()) < colorprofile.TrueColor
	app := ui.New(ui.Options{
		Client:     client,
		Version:    version,
		SessionID:  *session,
		NewID:      *newID,
		Continue:   *cont,
		Prompt:     *prompt,
		Auto:       *auto,
		Notice:     os.Getenv("INFINITEOC_NOTICE"),
		Handoff:    os.Getenv("INFINITUI_HANDOFF"),
		DaemonSock: os.Getenv("INFINITEOC_DAEMON_SOCKET"),
		DaemonID:   os.Getenv("INFINITEOC_UI_CLIENT"),
		Animations: os.Getenv("INFINITEOC_BATTERY") != "1" && os.Getenv("INFINITUI_NO_ANIMATIONS") == "",
	})

	p := tea.NewProgram(app)
	events := make(chan api.Event, 4096)
	go client.Stream(app.Context(), events)
	go pump(app.Context(), events, p)

	defer func() {
		if r := recover(); r != nil {
			code = crashed(fmt.Sprint(r), debug.Stack())
		}
	}()
	if _, err := p.Run(); err != nil {
		if errors.Is(err, tea.ErrProgramPanic) {
			return crashed(err.Error(), nil)
		}
		fmt.Fprintln(os.Stderr, "infinitui:", err)
		return 1
	}
	if app.ExitCode() == 0 && app.SessionID() != "" {
		name := "opencode"
		if os.Getenv("INFINITEOC") == "1" {
			name = "infiniteoc"
		}
		mark := "\x1b[1;38;2;244;114;182m∞\x1b[0m"
		dim := func(s string) string { return "\x1b[38;2;167;139;189m" + s + "\x1b[0m" }
		cmd := "\x1b[1;38;2;192;132;252m" + name + " -s " + app.SessionID() + "\x1b[0m"
		fmt.Printf("\n  %s  %s %s\n\n", mark, dim("until next time · continue with"), cmd)
	}
	return app.ExitCode()
}

// pump forwards events in batches so a burst of stream deltas costs one render.
func pump(ctx context.Context, in <-chan api.Event, p *tea.Program) {
	for {
		var batch ui.EventsMsg
		select {
		case <-ctx.Done():
			return
		case ev := <-in:
			batch = append(batch, ev)
		}
		timer := time.NewTimer(8 * time.Millisecond)
	drain:
		for len(batch) < 512 {
			select {
			case ev := <-in:
				batch = append(batch, ev)
			case <-timer.C:
				break drain
			}
		}
		timer.Stop()
		p.Send(batch)
	}
}

// crashed records a panic and asks the launcher for the classic UI so the user is never stuck.
func crashed(reason string, stack []byte) int {
	dir := filepath.Join(stateHome(), "opencode", "infiniteoc")
	_ = os.MkdirAll(dir, 0o700)
	file := filepath.Join(dir, "infinitui-crash.log")
	body := fmt.Sprintf("%s\n%s\n\n%s\n", time.Now().Format(time.RFC3339), reason, stack)
	_ = os.WriteFile(file, []byte(body), 0o600)
	fmt.Fprintf(os.Stderr, "InfiniTUI crashed (%s); report: %s\nFalling back to the classic interface…\n", reason, file)
	return ui.ExitClassic
}

func stateHome() string {
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state")
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

type server struct {
	url, password string
	cmd           *exec.Cmd
	stdin         io.WriteCloser
}

// startServer runs `opencode serve --stdio --port 0`, which lives while our stdin pipe stays open.
func startServer(cwd string) (*server, error) {
	bin := firstEnv("OPENCODE_BIN")
	if bin == "" {
		bin = "opencode"
	}
	pw := make([]byte, 24)
	_, _ = rand.Read(pw)
	password := base64.RawURLEncoding.EncodeToString(pw)
	cmd := exec.Command(bin, "serve", "--stdio", "--port", "0")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), "OPENCODE_PASSWORD="+password)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w (set OPENCODE_BIN or pass --server)", bin, err)
	}
	lines := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		if sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case line, ok := <-lines:
		if !ok {
			return nil, fmt.Errorf("%s serve exited before it was ready", bin)
		}
		var ready struct {
			URL string `json:"url"`
		}
		if json.Unmarshal([]byte(line), &ready) != nil || ready.URL == "" {
			return nil, fmt.Errorf("unexpected server output: %s", line)
		}
		return &server{url: ready.URL, password: password, cmd: cmd, stdin: stdin}, nil
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("%s serve did not start within 60s", bin)
	}
}

func (s *server) stop() {
	_ = s.stdin.Close()
	done := make(chan struct{})
	go func() { _ = s.cmd.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		_ = s.cmd.Process.Kill()
	}
}
