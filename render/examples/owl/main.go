// Request: an owl on a branch
package main

import (
	"math"
	"math/rand"

	"github.com/fogleman/ln/ln"

	"sketch/render/kit"
)

func main() {
	rng := rand.New(rand.NewSource(3))
	kit.Light(kit.V(-1, -0.5, 1))
	var shapes []ln.Shape
	add := func(s ...ln.Shape) { shapes = append(shapes, s...) }

	// Branch: a tapered, slightly wavy tube, with two twigs.
	var branch []ln.Vector
	for i := 0; i <= 40; i++ {
		t := float64(i) / 40
		branch = append(branch, kit.V(-3.2+6.4*t, 0.15*math.Sin(t*5), 0.12*math.Sin(t*7)))
	}
	add(kit.Shade(kit.TaperedTube(branch, 0.3, 0.16)))
	add(kit.TaperedTube([]ln.Vector{kit.V(2.0, 0, 0.1), kit.V(2.5, 0.1, 0.7), kit.V(2.6, 0.1, 1.2)}, 0.09, 0.03))
	add(kit.TaperedTube([]ln.Vector{kit.V(-2.2, 0, 0), kit.V(-2.7, -0.2, -0.6)}, 0.08, 0.03))

	// Body and head: overlapping ellipsoids give one soft silhouette.
	add(kit.Shade(kit.Ellipsoid(kit.V(0, 0, 1.25), kit.V(0.85, 0.75, 1.1))))
	add(kit.Shade(kit.Ellipsoid(kit.V(0, 0, 2.45), kit.V(0.8, 0.7, 0.62))))
	// Wings hug the sides.
	for _, side := range []float64{-1, 1} {
		add(kit.Shade(kit.Rotate(kit.Ellipsoid(kit.V(side*0.78, 0.05, 1.3), kit.V(0.22, 0.55, 0.85)), kit.V(0, 1, 0), side*8)))
		// Ear tufts.
		add(kit.Cone(kit.V(side*0.45, 0, 2.9), kit.V(side*0.7, 0, 3.35), 0.2))
		// Eyes face the camera side (-Y): a disc, a ring and a pupil.
		c := kit.V(side*0.33, -0.6, 2.52)
		add(kit.Cylinder(c, c.Add(kit.V(0, -0.06, 0)), 0.27))
		add(kit.Sphere(c.Add(kit.V(0, -0.06, 0)), 0.11))
		// Feet grip the branch.
		for k := -1.0; k <= 1; k++ {
			add(kit.Tube([]ln.Vector{kit.V(side*0.35+k*0.1, -0.1, 0.35), kit.V(side*0.35+k*0.13, -0.33, 0.2), kit.V(side*0.35+k*0.13, -0.3, -0.05)}, 0.04))
		}
	}
	add(kit.Cone(kit.V(0, -0.62, 2.4), kit.V(0, -0.85, 2.2), 0.1)) // beak

	// Chest feathers: rows of small V strokes just in front of the body.
	var feathers []ln.Path
	for row := 0; row < 6; row++ {
		z := 0.75 + float64(row)*0.22
		for x := -0.45; x <= 0.45; x += 0.18 {
			xx := x + (rng.Float64()-0.5)*0.05 + float64(row%2)*0.09
			y := -0.76 * math.Sqrt(math.Max(0, 1-(xx/0.85)*(xx/0.85)-((z-1.25)/1.1)*((z-1.25)/1.1)))
			feathers = append(feathers, ln.Path{kit.V(xx-0.06, y-0.01, z+0.07), kit.V(xx, y-0.01, z), kit.V(xx+0.06, y-0.01, z+0.07)})
		}
	}
	add(kit.Lines(feathers...))

	kit.Run(kit.Camera{Eye: kit.V(4, -9, 4), Center: kit.V(0, 0, 1.5), Fovy: 40}, shapes)
}
