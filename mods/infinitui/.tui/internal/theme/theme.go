// Package theme holds the semantic palette and the lipgloss styles built from it.
package theme

import (
	"image/color"

	"charm.land/lipgloss/v2"
)

// Palette is the semantic color set every view draws from.
type Palette struct {
	Name string
	Dark bool

	Bg        color.Color // app background (nil = terminal default)
	Panel     color.Color // raised surfaces: prompt, dialogs
	PanelAlt  color.Color // selection rows, code blocks
	Border    color.Color
	BorderHot color.Color

	Text    color.Color
	Muted   color.Color
	Subtle  color.Color
	Primary color.Color // brand purple
	Accent  color.Color // brand pink
	Info    color.Color
	Success color.Color
	Warning color.Color
	Error   color.Color

	DiffAdd       color.Color
	DiffDel       color.Color
	DiffAddBg     color.Color
	DiffDelBg     color.Color
	DiffAddWordBg color.Color
	DiffDelWordBg color.Color
	DiffContext   color.Color
	DiffLineNo    color.Color

	// Gradient stops for the wordmark and spinners.
	Gradient []color.Color
}

func hex(s string) color.Color { return lipgloss.Color(s) }

// InfiniteOC is the house theme (mods/infiniteoc): gray/purple/pink ramps, 100→900.
var InfiniteOC = Palette{
	Name:      "infiniteoc",
	Dark:      true,
	Bg:        hex("#160f1d"), // gray.800
	Panel:     hex("#211629"), // gray.700
	PanelAlt:  hex("#302039"), // gray.600
	Border:    hex("#654777"), // gray.500
	BorderHot: hex("#a864db"), // purple.300

	Text:    hex("#f3e8ff"), // gray.200
	Muted:   hex("#a78bbd"), // gray.400
	Subtle:  hex("#654777"),
	Primary: hex("#c084fc"), // purple.200
	Accent:  hex("#f472b6"), // pink.200
	Info:    hex("#56b6c2"),
	Success: hex("#7fd88f"),
	Warning: hex("#f5a742"),
	Error:   hex("#e06c75"),

	DiffAdd:       hex("#4fd6be"),
	DiffDel:       hex("#e26a75"),
	DiffAddBg:     hex("#20303b"),
	DiffDelBg:     hex("#37222c"),
	DiffAddWordBg: hex("#2c5a55"),
	DiffDelWordBg: hex("#6a2a3c"),
	DiffContext:   hex("#cfb8df"),
	DiffLineNo:    hex("#8f8f8f"),

	Gradient: []color.Color{hex("#c084fc"), hex("#f472b6")},
}

// Light is the light variant of the house theme.
var Light = Palette{
	Name:      "infiniteoc-light",
	Dark:      false,
	Bg:        hex("#fffaff"),
	Panel:     hex("#f7eefb"),
	PanelAlt:  hex("#eee3f4"),
	Border:    hex("#b59fc1"),
	BorderHot: hex("#a855f7"),

	Text:    hex("#321842"),
	Muted:   hex("#876996"),
	Subtle:  hex("#b59fc1"),
	Primary: hex("#7e22ce"),
	Accent:  hex("#be185d"),
	Info:    hex("#0369a1"),
	Success: hex("#16a34a"),
	Warning: hex("#a16207"),
	Error:   hex("#dc2626"),

	DiffAdd:       hex("#166534"),
	DiffDel:       hex("#9f1239"),
	DiffAddBg:     hex("#e3f7e9"),
	DiffDelBg:     hex("#fde7ec"),
	DiffAddWordBg: hex("#b9ebc8"),
	DiffDelWordBg: hex("#f8c3cf"),
	DiffContext:   hex("#60416f"),
	DiffLineNo:    hex("#b59fc1"),

	Gradient: []color.Color{hex("#7e22ce"), hex("#be185d")},
}

// InfiniCode is the red palette mods/infinicode fades to while that effort level is selected.
var InfiniCode = Palette{
	Name:      "infinicode",
	Dark:      true,
	Bg:        hex("#1c0e10"),
	Panel:     hex("#2a1617"),
	PanelAlt:  hex("#381f21"),
	Border:    hex("#6b4646"),
	BorderHot: hex("#e8455f"),

	Text:    hex("#fbe9e9"),
	Muted:   hex("#b58e8e"),
	Subtle:  hex("#6b4646"),
	Primary: hex("#ff6b81"),
	Accent:  hex("#ff7a5c"),
	Info:    hex("#56b6c2"),
	Success: hex("#7fd88f"),
	Warning: hex("#f5a742"),
	Error:   hex("#ff6b81"),

	DiffAdd:       hex("#4fd6be"),
	DiffDel:       hex("#e26a75"),
	DiffAddBg:     hex("#1f2a2c"),
	DiffDelBg:     hex("#3e1a20"),
	DiffAddWordBg: hex("#2c5a55"),
	DiffDelWordBg: hex("#6a2a3c"),
	DiffContext:   hex("#dcbcbc"),
	DiffLineNo:    hex("#8f8f8f"),

	Gradient: []color.Color{hex("#ff6b81"), hex("#ff7a5c")},
}

// Current is the active palette; Styles is rebuilt by Set.
var (
	Current = InfiniteOC
	S       = Build(Current)
)

// Set switches the active palette.
func Set(p Palette) {
	Current = p
	S = Build(p)
}

// ByName returns a known palette.
func ByName(name string) (Palette, bool) {
	switch name {
	case "", "infiniteoc", "dark":
		return InfiniteOC, true
	case "infiniteoc-light", "light":
		return Light, true
	case "infinicode":
		return InfiniCode, true
	}
	return Palette{}, false
}

// Styles are the shared lipgloss styles. Views copy and extend them.
type Styles struct {
	Text, Muted, Subtle, Bold     lipgloss.Style
	Primary, Accent, Info         lipgloss.Style
	Success, Warning, Error       lipgloss.Style
	UserBar, UserText             lipgloss.Style
	ToolName, ToolArg, ToolResult lipgloss.Style
	Code                          lipgloss.Style
	Key, KeyDesc                  lipgloss.Style
	Dialog, DialogTitle           lipgloss.Style
	Selected, SelectedMuted       lipgloss.Style
	Prompt, PromptFocused         lipgloss.Style
	Badge                         lipgloss.Style
}

// Build derives Styles from a palette.
func Build(p Palette) Styles {
	base := lipgloss.NewStyle()
	return Styles{
		Text:    base.Foreground(p.Text),
		Muted:   base.Foreground(p.Muted),
		Subtle:  base.Foreground(p.Subtle),
		Bold:    base.Foreground(p.Text).Bold(true),
		Primary: base.Foreground(p.Primary),
		Accent:  base.Foreground(p.Accent),
		Info:    base.Foreground(p.Info),
		Success: base.Foreground(p.Success),
		Warning: base.Foreground(p.Warning),
		Error:   base.Foreground(p.Error),

		UserBar:  base.Foreground(p.Accent),
		UserText: base.Foreground(p.Text),

		ToolName:   base.Foreground(p.Text).Bold(true),
		ToolArg:    base.Foreground(p.Muted),
		ToolResult: base.Foreground(p.Muted),
		Code:       base.Foreground(p.Accent),

		Key:     base.Foreground(p.Primary).Bold(true),
		KeyDesc: base.Foreground(p.Subtle),

		Dialog: base.Border(lipgloss.RoundedBorder()).
			BorderForeground(p.BorderHot).
			Padding(1, 2),
		DialogTitle: base.Foreground(p.Primary).Bold(true),

		Selected:      base.Background(p.PanelAlt).Foreground(p.Text).Bold(true),
		SelectedMuted: base.Background(p.PanelAlt).Foreground(p.Muted),

		Prompt: base.Border(lipgloss.RoundedBorder()).
			BorderForeground(p.Border).
			Padding(0, 1),
		PromptFocused: base.Border(lipgloss.RoundedBorder()).
			BorderForeground(p.Primary).
			Padding(0, 1),

		Badge: base.Foreground(p.Bg).Background(p.Primary).Padding(0, 1).Bold(true),
	}
}

// Blend linearly mixes the gradient at position t in [0,1].
func Blend(stops []color.Color, t float64) color.Color {
	if len(stops) == 0 {
		return nil
	}
	if len(stops) == 1 || t <= 0 {
		return stops[0]
	}
	if t >= 1 {
		return stops[len(stops)-1]
	}
	seg := t * float64(len(stops)-1)
	i := int(seg)
	f := seg - float64(i)
	a, b := rgba(stops[i]), rgba(stops[i+1])
	mix := func(x, y uint8) uint8 { return uint8(float64(x) + (float64(y)-float64(x))*f) }
	return color.RGBA{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B), 255}
}

func rgba(c color.Color) color.RGBA {
	r, g, b, _ := c.RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), 255}
}

// Gradient paints s with the palette gradient, one color per rune.
func Gradient(s string, stops []color.Color, phase float64) string {
	runes := []rune(s)
	if len(runes) == 0 {
		return ""
	}
	out := make([]byte, 0, len(s)*20)
	n := float64(len(runes))
	for i, r := range runes {
		if r == ' ' {
			out = append(out, ' ')
			continue
		}
		t := float64(i)/n + phase
		t -= float64(int(t))
		// Ping-pong so the ramp loops without a seam.
		if t > 0.5 {
			t = 1 - t
		}
		out = append(out, lipgloss.NewStyle().Foreground(Blend(stops, t*2)).Render(string(r))...)
	}
	return string(out)
}

// For256 swaps the background tones that the automatic 256-colour conversion maps badly (dark muted
// purples land on saturated magenta) for hand-picked xterm-256 colours. Foregrounds convert fine.
func For256(p Palette) Palette {
	c := func(n string) color.Color { return lipgloss.Color(n) }
	if p.Dark {
		p.Panel, p.PanelAlt = c("234"), c("236")
		p.DiffAddBg, p.DiffDelBg = c("22"), c("52")
		p.DiffAddWordBg, p.DiffDelWordBg = c("28"), c("88")
	} else {
		p.Panel, p.PanelAlt = c("255"), c("254")
		p.DiffAddBg, p.DiffDelBg = c("194"), c("224")
		p.DiffAddWordBg, p.DiffDelWordBg = c("157"), c("217")
	}
	return p
}

// Limited256 is set when the terminal cannot show true colour.
var Limited256 bool

// Apply sets a palette, adapted to the terminal's colour depth.
func Apply(p Palette) {
	if Limited256 {
		p = For256(p)
	}
	Set(p)
}

// Mix blends two palettes field by field (t=0 is a, t=1 is b). The name changes per step so
// renderers keyed on it do not reuse colours from another step.
func Mix(a, b Palette, t float64) Palette {
	m := func(x, y color.Color) color.Color {
		if x == nil || y == nil {
			if t < 0.5 {
				return x
			}
			return y
		}
		return Blend([]color.Color{x, y}, t)
	}
	out := b
	out.Name = b.Name
	if t < 1 {
		out.Name = a.Name + ">" + b.Name + "@" + string(rune('a'+int(t*20)))
	}
	out.Bg, out.Panel, out.PanelAlt, out.Border, out.BorderHot = m(a.Bg, b.Bg), m(a.Panel, b.Panel), m(a.PanelAlt, b.PanelAlt), m(a.Border, b.Border), m(a.BorderHot, b.BorderHot)
	out.Text, out.Muted, out.Subtle, out.Primary, out.Accent = m(a.Text, b.Text), m(a.Muted, b.Muted), m(a.Subtle, b.Subtle), m(a.Primary, b.Primary), m(a.Accent, b.Accent)
	out.Info, out.Success, out.Warning, out.Error = m(a.Info, b.Info), m(a.Success, b.Success), m(a.Warning, b.Warning), m(a.Error, b.Error)
	out.DiffAdd, out.DiffDel, out.DiffAddBg, out.DiffDelBg = m(a.DiffAdd, b.DiffAdd), m(a.DiffDel, b.DiffDel), m(a.DiffAddBg, b.DiffAddBg), m(a.DiffDelBg, b.DiffDelBg)
	out.DiffAddWordBg, out.DiffDelWordBg, out.DiffContext, out.DiffLineNo = m(a.DiffAddWordBg, b.DiffAddWordBg), m(a.DiffDelWordBg, b.DiffDelWordBg), m(a.DiffContext, b.DiffContext), m(a.DiffLineNo, b.DiffLineNo)
	if len(a.Gradient) == len(b.Gradient) {
		out.Gradient = make([]color.Color, len(b.Gradient))
		for i := range b.Gradient {
			out.Gradient[i] = m(a.Gradient[i], b.Gradient[i])
		}
	}
	return out
}
