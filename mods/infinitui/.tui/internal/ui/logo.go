package ui

import (
	"image/color"
	"math"
	"strings"
	"time"

	"charm.land/lipgloss/v2"

	"infiniteoc/infinitui/internal/theme"
)

// The InfiniTUI mark: a lemniscate drawn in braille dots, with a bright comet circling it.

const (
	introWipe  = 700 * time.Millisecond
	introHold  = 100 * time.Millisecond
	introGlint = 1200 * time.Millisecond
	// IntroLength is how long the mark animates in after start.
	IntroLength = introWipe + introHold + introGlint
)

// braille bit for dot (x 0..1, y 0..3) inside a cell.
var brailleBits = [2][4]rune{{0x01, 0x02, 0x04, 0x40}, {0x08, 0x10, 0x20, 0x80}}

type dot struct {
	t    float64 // position along the curve, 0..1
	hits int
}

// lemniscate rasterises the curve into a cols×rows braille canvas. Each cell keeps the curve
// position of its dots so colour can follow the path.
func lemniscate(cols, rows int) ([][]rune, [][]float64) {
	w, h := cols*2, rows*4
	cells := make([][]rune, rows)
	pos := make([][]float64, rows)
	for i := range cells {
		cells[i] = make([]rune, cols)
		pos[i] = make([]float64, cols)
		for j := range pos[i] {
			pos[i][j] = -1
		}
	}
	const steps = 2400
	for i := 0; i < steps; i++ {
		t := float64(i) / steps
		a := t * 2 * math.Pi
		d := 1 + math.Sin(a)*math.Sin(a)
		x := math.Cos(a) / d               // -1..1
		y := math.Sin(a) * math.Cos(a) / d // -0.35..0.35
		px := int(math.Round((x + 1) / 2 * float64(w-1)))
		py := int(math.Round((y/0.36 + 1) / 2 * float64(h-1)))
		if px < 0 || px >= w || py < 0 || py >= h {
			continue
		}
		cx, cy := px/2, py/4
		cells[cy][cx] |= brailleBits[px%2][py%4]
		if pos[cy][cx] < 0 {
			pos[cy][cx] = t
		}
	}
	return cells, pos
}

// Mark draws the lemniscate. phase moves the comet (0..1 per lap); reveal 0..1 draws it in.
func Mark(cols, rows int, phase, reveal float64) string {
	p := theme.Current
	cells, pos := lemniscate(cols, rows)
	grad := p.Gradient
	if len(grad) == 0 {
		grad = []color.Color{p.Primary, p.Accent}
	}
	bg := p.Bg
	if bg == nil {
		bg = lipgloss.Color("#000000")
	}
	glow := lipgloss.Color("#ffe6f6")
	var b strings.Builder
	for y := range cells {
		for x, r := range cells[y] {
			if r == 0 || pos[y][x] < 0 {
				b.WriteByte(' ')
				continue
			}
			t := pos[y][x]
			if t > reveal {
				b.WriteByte(' ')
				continue
			}
			// Colour runs along the path, mirrored so both loops share the ramp.
			c := theme.Blend(grad, 1-math.Abs(2*t-1))
			// Comet: bright head, fading tail behind it.
			d := math.Mod(phase-t+2, 1)
			if d < 0.18 {
				c = theme.Blend([]color.Color{glow, c}, d/0.18)
			} else {
				c = theme.Blend([]color.Color{c, bg}, 0.15)
			}
			b.WriteString(lipgloss.NewStyle().Foreground(c).Render(string(rune(0x2800) + r)))
		}
		if y < len(cells)-1 {
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// Wordmark is "infinite·oc" letter-spaced in the gradient.
func Wordmark(phase float64) string {
	text := "i n f i n i t e   o c"
	return lipgloss.NewStyle().Bold(true).Render(theme.Gradient(text, theme.Current.Gradient, phase))
}

// Logo is the home-screen mark plus wordmark, sized for width. elapsed drives the intro.
func Logo(width int, elapsed time.Duration, loop bool) string {
	cols, rows := 26, 6
	if width < 40 {
		cols, rows = 16, 4
	}
	reveal := 1.0
	if elapsed < introWipe {
		reveal = coast(float64(elapsed) / float64(introWipe))
	}
	phase := float64(elapsed) / float64(2600*time.Millisecond)
	if !loop && elapsed >= IntroLength {
		phase = 0.5 // comet parked on the crossing
	}
	mark := Mark(cols, rows, math.Mod(phase, 1), reveal)
	lines := strings.Split(mark, "\n")
	lines = append(lines, "", Wordmark(0))
	return strings.Join(lines, "\n")
}

// spinnerInf is a two-cell braille ∞ with a dot chasing around it.
func spinnerInf(frame int) string {
	cells, pos := lemniscate(5, 1)
	p := theme.Current
	head := math.Mod(float64(frame)/12, 1)
	var b strings.Builder
	for x, r := range cells[0] {
		if r == 0 {
			b.WriteByte(' ')
			continue
		}
		d := math.Mod(head-pos[0][x]+2, 1)
		c := theme.Blend([]color.Color{p.Accent, p.Primary, p.Subtle}, math.Min(1, d*2.2))
		b.WriteString(lipgloss.NewStyle().Foreground(c).Render(string(rune(0x2800) + r)))
	}
	return b.String()
}

func coast(t float64) float64 {
	t = clamp(t, 0, 1)
	return 1 - math.Pow(1-t, 3)
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}
