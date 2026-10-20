package ui

import (
	"image/color"
	"os"
	"path/filepath"
	"strings"
)

type colorT = color.Color

// stateDir is OpenCode's TUI state directory ($XDG_STATE_HOME/opencode).
func stateDir() string {
	if d := os.Getenv("XDG_STATE_HOME"); d != "" {
		return filepath.Join(d, "opencode")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "opencode")
}

// tildify shortens a path under $HOME.
func tildify(p string) string {
	home, _ := os.UserHomeDir()
	if home != "" && (p == home || strings.HasPrefix(p, home+string(filepath.Separator))) {
		return "~" + p[len(home):]
	}
	return p
}
