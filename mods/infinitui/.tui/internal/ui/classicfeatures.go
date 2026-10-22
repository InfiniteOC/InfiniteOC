package ui

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// classicFeature is a TUI command a mod registered (api.tui.command, `infiniteoc feature new`). Its code runs in the
// classic UI, so InfiniTUI lists it and hands it to a classic client of the same server, as it does /connect.
type classicFeature struct {
	Title    string   `json:"title"`
	Category string   `json:"category"`
	Slash    string   `json:"slash"`
	Aliases  []string `json:"aliases"`
}

// classicFeatures reads the generation the opendaemon published live (INFINITEOC_LIVE_MANIFEST), which replaces the
// build's list in the classic UI too, or else the build's (INFINITEOC_HOME/.runtime/opencode/infiniteoc-features.json).
func classicFeatures() []classicFeature {
	if file := os.Getenv("INFINITEOC_LIVE_MANIFEST"); file != "" {
		var live struct {
			Commands []classicFeature `json:"commands"`
		}
		if data, err := os.ReadFile(file); err == nil && json.Unmarshal(data, &live) == nil && live.Commands != nil {
			return live.Commands
		}
	}
	home := os.Getenv("INFINITEOC_HOME")
	if home == "" {
		return nil
	}
	var built []classicFeature
	data, err := os.ReadFile(filepath.Join(home, ".runtime", "opencode", "infiniteoc-features.json"))
	if err != nil || json.Unmarshal(data, &built) != nil {
		return nil
	}
	return built
}

// visibleClassicFeatures leaves out the ones InfiniTUI already has (its own commands, server-built views like /context).
func (a *App) visibleClassicFeatures() []classicFeature {
	var out []classicFeature
	for _, f := range classicFeatures() {
		if f.Slash != "" && findLocal(f.Slash) == nil && a.findFeature(f.Slash) == nil {
			out = append(out, f)
		}
	}
	return out
}

func (a *App) findClassicFeature(name string) *classicFeature {
	for _, f := range a.visibleClassicFeatures() {
		if f.Slash == name {
			return &f
		}
		for _, alias := range f.Aliases {
			if alias == name {
				return &f
			}
		}
	}
	return nil
}
