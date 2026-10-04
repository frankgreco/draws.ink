// Command render reads a JSON scene on stdin and writes an SVG line drawing
// (hidden lines removed, via fogleman/ln) to stdout.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"

	"github.com/fogleman/ln/ln"

	"sketch/render/kit"
)

const maxShapes = 400

type Scene struct {
	Camera struct {
		Eye    *[3]float64 `json:"eye"`
		Center *[3]float64 `json:"center"`
		Fovy   float64     `json:"fovy"`
	} `json:"camera"`
	Shapes []Spec `json:"shapes"`
}

type Spec struct {
	Type   string     `json:"type"`
	Style  string     `json:"style"`
	Lines  int        `json:"lines"`
	Min    [3]float64 `json:"min"`
	Max    [3]float64 `json:"max"`
	Center [3]float64 `json:"center"`
	From   [3]float64 `json:"from"`
	To     [3]float64 `json:"to"`
	Radius float64    `json:"radius"`
	Rotate *struct {
		Axis    [3]float64 `json:"axis"`
		Degrees float64    `json:"degrees"`
	} `json:"rotate"`
	Shapes    []Spec  `json:"shapes"`
	Preset    string  `json:"preset"`
	Amplitude float64 `json:"amplitude"`
	Frequency float64 `json:"frequency"`
	Seed      float64 `json:"seed"`
	Frame     *bool   `json:"frame"`
}

func vec(a [3]float64) ln.Vector { return ln.Vector{X: a[0], Y: a[1], Z: a[2]} }

func surface(s Spec) (ln.Shape, error) {
	a, b := vec(s.Min), vec(s.Max)
	if b.X <= a.X || b.Y <= a.Y {
		return nil, errors.New("surface: max must exceed min in x and y (z of min is the base height)")
	}
	amp, freq := s.Amplitude, s.Frequency
	if freq == 0 {
		freq = 1
	}
	cx, cy, base := (a.X+b.X)/2, (a.Y+b.Y)/2, a.Z
	var h func(x, y float64) float64
	switch s.Preset {
	case "flat", "":
		h = func(x, y float64) float64 { return 0 }
	case "ripple":
		h = func(x, y float64) float64 {
			r := math.Hypot(x, y)
			return amp * math.Cos(freq*r) * math.Exp(-0.15*r)
		}
	case "waves":
		h = func(x, y float64) float64 { return amp * math.Sin(freq*x) * math.Cos(freq*y) }
	case "hills":
		k := s.Seed
		h = func(x, y float64) float64 {
			return amp * (math.Sin(freq*x+k) + math.Sin(0.7*freq*y+1.3*k) + math.Sin(0.5*freq*(x+y)+2.1*k)) / 3
		}
	case "peak":
		h = func(x, y float64) float64 { return amp * math.Exp(-(x*x+y*y)*freq*freq) }
	case "saddle":
		h = func(x, y float64) float64 { return amp * (x*x - y*y) * freq * freq }
	default:
		return nil, fmt.Errorf("surface: unknown preset %q", s.Preset)
	}
	return kit.Surface(a, b, s.Lines, func(x, y float64) float64 { return base + h(x-cx, y-cy) }), nil
}

func build(s Spec, inCSG bool) (ln.Shape, error) {
	shape, err := buildPlain(s, inCSG)
	if err != nil {
		return nil, err
	}
	if s.Rotate != nil && s.Rotate.Degrees != 0 {
		axis := vec(s.Rotate.Axis)
		if axis.Length() < 1e-9 {
			return nil, fmt.Errorf("%s: rotate.axis must be non-zero", s.Type)
		}
		shape = kit.Rotate(shape, axis, s.Rotate.Degrees)
	}
	return shape, nil
}

func buildPlain(s Spec, inCSG bool) (ln.Shape, error) {
	style := s.Style
	if style == "" {
		style = "outline"
	}
	n := s.Lines
	switch s.Type {
	case "cube":
		a, b := vec(s.Min), vec(s.Max)
		if b.X <= a.X || b.Y <= a.Y || b.Z <= a.Z {
			return nil, errors.New("cube: max must exceed min on every axis")
		}
		if n <= 0 {
			n = 8
		}
		switch style {
		case "outline":
			return kit.Cube(a, b), nil
		case "columns":
			return kit.CubeColumns(a, b, n), nil
		case "floors":
			return kit.CubeFloors(a, b, n), nil
		}
		return nil, fmt.Errorf("cube: unknown style %q", style)
	case "sphere":
		if s.Radius <= 0 {
			return nil, errors.New("sphere: radius must be > 0")
		}
		switch style {
		case "outline":
			return kit.Sphere(vec(s.Center), s.Radius), nil
		case "grid":
			return kit.GridSphere(vec(s.Center), s.Radius), nil
		}
		return nil, fmt.Errorf("sphere: unknown style %q", style)
	case "cylinder", "cone":
		v0, v1 := vec(s.From), vec(s.To)
		if s.Radius <= 0 || v1.Sub(v0).Length() < 1e-6 {
			return nil, fmt.Errorf("%s: needs radius > 0 and distinct from/to", s.Type)
		}
		if s.Type == "cone" {
			return kit.Cone(v0, v1, s.Radius), nil
		}
		switch style {
		case "outline":
			return kit.Cylinder(v0, v1, s.Radius), nil
		case "lines":
			if n <= 0 {
				n = 24
			}
			return kit.LinedCylinder(v0, v1, s.Radius, n), nil
		}
		return nil, fmt.Errorf("cylinder: unknown style %q", style)
	case "surface":
		if inCSG {
			return nil, errors.New("surface cannot be used inside difference/intersection")
		}
		return surface(s)
	case "difference", "intersection":
		if len(s.Shapes) < 2 {
			return nil, fmt.Errorf("%s: needs at least 2 shapes", s.Type)
		}
		var parts []ln.Shape
		for _, c := range s.Shapes {
			p, err := build(c, true)
			if err != nil {
				return nil, err
			}
			parts = append(parts, p)
		}
		if s.Type == "difference" {
			return kit.Difference(parts...), nil
		}
		return kit.Intersection(parts...), nil
	}
	return nil, fmt.Errorf("unknown shape type %q", s.Type)
}

func count(specs []Spec) int {
	n := len(specs)
	for _, s := range specs {
		n += count(s.Shapes)
	}
	return n
}

func render(sc Scene) (string, error) {
	if n := count(sc.Shapes); n > maxShapes {
		return "", fmt.Errorf("too many shapes: %d (max %d)", n, maxShapes)
	}
	var shapes []ln.Shape
	for i, s := range sc.Shapes {
		shape, err := build(s, false)
		if err != nil {
			return "", fmt.Errorf("shapes[%d]: %w", i, err)
		}
		if s.Frame != nil && !*s.Frame {
			shape = kit.Background(shape)
		}
		shapes = append(shapes, shape)
	}
	cam := kit.Camera{Eye: ln.Vector{X: 6, Y: -8, Z: 5}, Fovy: sc.Camera.Fovy}
	if sc.Camera.Eye != nil {
		cam.Eye = vec(*sc.Camera.Eye)
	}
	if sc.Camera.Center != nil {
		cam.Center = vec(*sc.Camera.Center)
	}
	return kit.Render(cam, shapes)
}

func main() {
	var sc Scene
	if err := json.NewDecoder(os.Stdin).Decode(&sc); err != nil {
		fmt.Fprintln(os.Stderr, "invalid scene JSON:", err)
		os.Exit(1)
	}
	svg, err := render(sc)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(svg)
}
