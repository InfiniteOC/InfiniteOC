package ui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"infiniteoc/infinitui/internal/api"
)

// modelPrefs is <state>/model.json, shared with the classic TUI (tui/src/model-preference.ts).
// Unknown keys are preserved on write.
type modelPrefs struct {
	raw      map[string]json.RawMessage
	Recent   []prefModel
	Favorite []prefModel
	Variant  map[string]string
}

type prefModel struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

func modelPrefsFile() string { return filepath.Join(stateDir(), "model.json") }

func loadModelPrefs() *modelPrefs {
	p := &modelPrefs{raw: map[string]json.RawMessage{}, Variant: map[string]string{}}
	b, err := os.ReadFile(modelPrefsFile())
	if err != nil {
		return p
	}
	_ = json.Unmarshal(b, &p.raw)
	_ = json.Unmarshal(p.raw["recent"], &p.Recent)
	_ = json.Unmarshal(p.raw["favorite"], &p.Favorite)
	_ = json.Unmarshal(p.raw["variant"], &p.Variant)
	if p.Variant == nil {
		p.Variant = map[string]string{}
	}
	return p
}

func (p *modelPrefs) save() {
	set := func(k string, v any) {
		b, _ := json.Marshal(v)
		p.raw[k] = b
	}
	set("recent", p.Recent)
	set("favorite", p.Favorite)
	set("variant", p.Variant)
	b, err := json.MarshalIndent(p.raw, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(stateDir(), 0o755)
	tmp := modelPrefsFile() + "." + strconv.FormatInt(time.Now().UnixNano(), 36) + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, modelPrefsFile())
	}
}

// touch moves a model to the front of the recent list (max 10).
func (p *modelPrefs) touch(ref api.ModelRef) {
	e := prefModel{ProviderID: ref.ProviderID, ModelID: ref.ID}
	out := []prefModel{e}
	for _, r := range p.Recent {
		if r != e {
			out = append(out, r)
		}
	}
	if len(out) > 10 {
		out = out[:10]
	}
	p.Recent = out
}

func (p *modelPrefs) isFavorite(ref api.ModelRef) bool {
	for _, f := range p.Favorite {
		if f.ProviderID == ref.ProviderID && f.ModelID == ref.ID {
			return true
		}
	}
	return false
}

func (p *modelPrefs) toggleFavorite(ref api.ModelRef) {
	e := prefModel{ProviderID: ref.ProviderID, ModelID: ref.ID}
	for i, f := range p.Favorite {
		if f == e {
			p.Favorite = append(p.Favorite[:i], p.Favorite[i+1:]...)
			return
		}
	}
	p.Favorite = append(p.Favorite, e)
}

// variantFor returns the remembered variant ("" = none).
func (p *modelPrefs) variantFor(ref api.ModelRef) string {
	v := p.Variant[ref.Key()]
	if v == "default" {
		return ""
	}
	return v
}

func (p *modelPrefs) setVariant(ref api.ModelRef, v string) {
	if v == "" {
		v = "default"
	}
	p.Variant[ref.Key()] = v
}

// uiPrefs is InfiniTUI's own small settings file.
type uiPrefs struct {
	Theme       string `json:"theme,omitempty"`
	ShowThought bool   `json:"showThinking,omitempty"`
	Sidebar     *bool  `json:"sidebar,omitempty"`
	Notify      *bool  `json:"notify,omitempty"`
	Animations  *bool  `json:"animations,omitempty"`
}

func uiPrefsFile() string { return filepath.Join(stateDir(), "infiniteoc", "tui", "infinitui.json") }

func loadUIPrefs() uiPrefs {
	var p uiPrefs
	if b, err := os.ReadFile(uiPrefsFile()); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	return p
}

func (p uiPrefs) save() {
	b, _ := json.MarshalIndent(p, "", "  ")
	_ = os.MkdirAll(filepath.Dir(uiPrefsFile()), 0o755)
	_ = os.WriteFile(uiPrefsFile(), b, 0o644)
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}
