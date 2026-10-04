// Request: a desk lamp on a small table
package main

import (
	"math"

	"github.com/fogleman/ln/ln"

	"sketch/render/kit"
)

func main() {
	kit.Light(kit.V(-1, -0.6, 1))
	var shapes []ln.Shape
	add := func(s ...ln.Shape) { shapes = append(shapes, s...) }

	// Table: a rounded top on four turned legs.
	add(kit.Shade(kit.RoundedBox(kit.V(-2, -1.3, 2.0), kit.V(2, 1.3, 2.15), 0.25)))
	leg := [][2]float64{{0.07, 0}, {0.1, 0.3}, {0.07, 0.6}, {0.12, 1.7}, {0.12, 2.0}}
	for _, x := range []float64{-1.7, 1.7} {
		for _, y := range []float64{-1.0, 1.0} {
			add(kit.Shade(kit.Lathe(kit.V(x, y, 0), leg)))
		}
	}

	// Lamp base: a weighted disc with a short stem.
	add(kit.Shade(kit.Lathe(kit.V(-0.8, 0.2, 2.15), [][2]float64{{0.5, 0}, {0.5, 0.06}, {0.12, 0.14}, {0.08, 0.3}})))

	// Arm: one smooth curve up and over.
	var arm []ln.Vector
	for i := 0; i <= 30; i++ {
		t := float64(i) / 30
		arm = append(arm, kit.V(-0.8+1.5*t*t, 0.2, 2.45+1.9*math.Sin(t*math.Pi*0.62)))
	}
	add(kit.Shade(kit.Tube(arm, 0.045)))

	// Shade: a cone-shaped lathe hanging from the end of the arm, tilted.
	end := arm[len(arm)-1]
	hood := kit.Lathe(kit.V(end.X, end.Y, end.Z-0.75), [][2]float64{{0.62, 0}, {0.6, 0.04}, {0.2, 0.6}, {0.12, 0.75}})
	add(kit.Shade(kit.Rotate(hood, kit.V(0, 1, 0), 22)))

	// A book and a mug so the table reads as a table.
	add(kit.Shade(kit.Rotate(kit.Cube(kit.V(0.6, -0.7, 2.15), kit.V(1.5, -0.1, 2.3)), kit.V(0, 0, 1), 18)))
	add(kit.Shade(kit.Lathe(kit.V(1.2, 0.6, 2.15), [][2]float64{{0.17, 0}, {0.19, 0.38}})))
	var handle []ln.Vector
	for i := 0; i <= 12; i++ {
		a := -math.Pi/2 + math.Pi*float64(i)/12
		handle = append(handle, kit.V(1.39+0.13*math.Cos(a), 0.6, 2.34+0.12*math.Sin(a)))
	}
	add(kit.Tube(handle, 0.025))

	kit.Run(kit.Camera{Eye: kit.V(6, -9, 6), Center: kit.V(0, 0, 2), Fovy: 40}, shapes)
}
