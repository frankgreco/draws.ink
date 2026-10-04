// Package kit is a thin layer over fogleman/ln used by both the JSON scene
// renderer and by model-written scene programs: shape constructors with
// plotter-friendly line textures, automatic framing, and SVG output.
package kit

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/fogleman/ln/ln"
)

const (
	size      = 1024.0
	maxExtent = 60.0
	margin    = 0.07
)

var zAxis = ln.Vector{X: 0, Y: 0, Z: 1}

// eye is the camera position in the local space of the shape whose Paths are
// being generated. Run sets it once the camera is framed; transformed shapes
// rebase it while their children generate paths.
var eye = ln.Vector{X: 6, Y: -8, Z: 5}

// Lines are produced in two passes so they can be drawn in different
// weights and in a human order: outlines first, then surface detail.
// Each kit shape returns only the lines belonging to the current pass.
type pass int

const (
	passOutline pass = iota
	passDetail
)

var current = passOutline

// light points from the scene toward the light source.
var light = ln.Vector{X: -0.55, Y: -0.45, Z: 0.7}.Normalize()

// Light sets the direction from the scene toward the light, used by Shade.
func Light(toward ln.Vector) {
	if toward.Length() > 1e-9 {
		light = toward.Normalize()
	}
}

type Camera struct {
	Eye    ln.Vector
	Center ln.Vector
	Fovy   float64
}

func V(x, y, z float64) ln.Vector { return ln.Vector{X: x, Y: y, Z: z} }

// ---- cubes

type cube struct {
	*ln.Cube
	style string
	n     int
}

func (c *cube) Paths() ln.Paths {
	if current == passOutline {
		return c.Cube.Paths()
	}
	var paths ln.Paths
	a, b := c.Min, c.Max
	for i := 1; i <= c.n; i++ {
		t := float64(i) / float64(c.n+1)
		switch c.style {
		case "columns":
			x := a.X + (b.X-a.X)*t
			y := a.Y + (b.Y-a.Y)*t
			paths = append(paths,
				ln.Path{{X: x, Y: a.Y, Z: a.Z}, {X: x, Y: a.Y, Z: b.Z}},
				ln.Path{{X: x, Y: b.Y, Z: a.Z}, {X: x, Y: b.Y, Z: b.Z}},
				ln.Path{{X: a.X, Y: y, Z: a.Z}, {X: a.X, Y: y, Z: b.Z}},
				ln.Path{{X: b.X, Y: y, Z: a.Z}, {X: b.X, Y: y, Z: b.Z}},
			)
		case "floors":
			z := a.Z + (b.Z-a.Z)*t
			paths = append(paths, ln.Path{
				{X: a.X, Y: a.Y, Z: z}, {X: b.X, Y: a.Y, Z: z}, {X: b.X, Y: b.Y, Z: z},
				{X: a.X, Y: b.Y, Z: z}, {X: a.X, Y: a.Y, Z: z},
			})
		}
	}
	return paths
}

func newCube(a, b ln.Vector, style string, n int) ln.Shape {
	lo, hi := a.Min(b), a.Max(b)
	return &cube{ln.NewCube(lo, hi), style, min(max(n, 0), 200)}
}

// Cube is an axis-aligned box drawn as its 12 edges.
func Cube(a, b ln.Vector) ln.Shape { return newCube(a, b, "outline", 0) }

// CubeColumns adds n vertical lines to each side face.
func CubeColumns(a, b ln.Vector, n int) ln.Shape { return newCube(a, b, "columns", n) }

// CubeFloors adds n horizontal bands around the side faces.
func CubeFloors(a, b ln.Vector, n int) ln.Shape { return newCube(a, b, "floors", n) }

// ---- spheres

type outlineSphere struct{ ln.Sphere }

func (s *outlineSphere) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	return ln.NewOutlineSphere(eye, zAxis, s.Center, s.Radius).Paths()
}

type gridSphere struct{ outlineSphere }

func (s *gridSphere) Paths() ln.Paths {
	if current == passOutline {
		return s.outlineSphere.Paths()
	}
	return s.Sphere.Paths()
}

// Sphere is drawn as its silhouette only.
func Sphere(center ln.Vector, radius float64) ln.Shape {
	return &outlineSphere{*ln.NewSphere(center, radius)}
}

// GridSphere is drawn with latitude and longitude lines.
func GridSphere(center ln.Vector, radius float64) ln.Shape {
	return &gridSphere{outlineSphere{*ln.NewSphere(center, radius)}}
}

// ---- cylinders and cones

// solidCylinder adds the end caps ln's cylinder lacks, so nothing shows
// through its open ends.
type solidCylinder struct{ ln.Cylinder }

func (c *solidCylinder) Intersect(r ln.Ray) ln.Hit {
	hit := c.Cylinder.Intersect(r)
	if math.Abs(r.Direction.Z) > 1e-12 {
		for _, z := range [2]float64{c.Z0, c.Z1} {
			t := (z - r.Origin.Z) / r.Direction.Z
			if t > 1e-6 && t < hit.T {
				p := r.Position(t)
				if p.X*p.X+p.Y*p.Y < c.Radius*c.Radius {
					hit = ln.Hit{Shape: c, T: t}
				}
			}
		}
	}
	return hit
}

// solidCone adds the base cap and an interior, so cones hide what is behind
// their base and can be used in Difference and Intersection.
type solidCone struct{ ln.Cone }

func (c *solidCone) Contains(v ln.Vector, f float64) bool {
	if v.Z < -f || v.Z > c.Height+f {
		return false
	}
	return math.Hypot(v.X, v.Y) <= c.Radius*(1-v.Z/c.Height)+f
}

func (c *solidCone) Intersect(r ln.Ray) ln.Hit {
	hit := c.Cone.Intersect(r)
	if math.Abs(r.Direction.Z) > 1e-12 {
		t := -r.Origin.Z / r.Direction.Z
		if t > 1e-6 && t < hit.T {
			p := r.Position(t)
			if p.X*p.X+p.Y*p.Y < c.Radius*c.Radius {
				hit = ln.Hit{Shape: c, T: t}
			}
		}
	}
	return hit
}

type outlineCylinder struct{ solidCylinder }

func (c *outlineCylinder) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	return ln.NewOutlineCylinder(eye, zAxis, c.Radius, c.Z0, c.Z1).Paths()
}

type linedCylinder struct {
	solidCylinder
	n int
}

func (c *linedCylinder) Paths() ln.Paths {
	if current == passOutline {
		return ln.NewOutlineCylinder(eye, zAxis, c.Radius, c.Z0, c.Z1).Paths()
	}
	var paths ln.Paths
	for i := 0; i < c.n; i++ {
		a := 2 * math.Pi * float64(i) / float64(c.n)
		x := c.Radius * math.Cos(a)
		y := c.Radius * math.Sin(a)
		paths = append(paths, ln.Path{{X: x, Y: y, Z: c.Z0}, {X: x, Y: y, Z: c.Z1}})
	}
	return paths
}

type outlineCone struct{ solidCone }

func (c *outlineCone) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	return ln.NewOutlineCone(eye, zAxis, c.Radius, c.Height).Paths()
}

// align returns the matrix taking the local +Z axis at the origin onto the
// segment v0 -> v1.
func align(v0, v1 ln.Vector) ln.Matrix {
	d := v1.Sub(v0)
	if d.Length() < 1e-9 {
		return ln.Translate(v0)
	}
	d = d.Normalize()
	c := d.Cross(zAxis)
	if c.Length() < 1e-9 {
		if d.Z > 0 {
			return ln.Translate(v0)
		}
		return ln.Rotate(ln.Vector{X: 1}, math.Pi).Translate(v0)
	}
	return ln.Rotate(c.Normalize(), math.Acos(d.Dot(zAxis))).Translate(v0)
}

// Cylinder is a capped cylinder from one point to another, drawn as its
// silhouette and end circles.
func Cylinder(from, to ln.Vector, radius float64) ln.Shape {
	h := to.Sub(from).Length()
	return Transform(&outlineCylinder{solidCylinder{*ln.NewCylinder(radius, 0, h)}}, align(from, to))
}

// LinedCylinder is a cylinder drawn with n lines along its length.
func LinedCylinder(from, to ln.Vector, radius float64, n int) ln.Shape {
	h := to.Sub(from).Length()
	return Transform(&linedCylinder{solidCylinder{*ln.NewCylinder(radius, 0, h)}, min(max(n, 0), 360)}, align(from, to))
}

// Cone has its base circle centred on base and its point at tip.
func Cone(base, tip ln.Vector, radius float64) ln.Shape {
	h := tip.Sub(base).Length()
	return Transform(&outlineCone{solidCone{*ln.NewCone(radius, h)}}, align(base, tip))
}

// ---- height-field surfaces

type surface struct {
	fn  func(x, y float64) float64
	box ln.Box
	n   int
}

func (s *surface) Compile()            {}
func (s *surface) BoundingBox() ln.Box { return s.box }
func (s *surface) Contains(v ln.Vector, f float64) bool {
	return s.box.Contains(v) && v.Z < s.fn(v.X, v.Y)
}

func (s *surface) Intersect(r ln.Ray) ln.Hit {
	t0, t1 := s.box.Intersect(r)
	if t1 < t0 || t1 <= 0 {
		return ln.NoHit
	}
	step := s.box.Size().Length() / 400
	t := math.Max(t0, step)
	below := func(t float64) bool {
		v := r.Position(t)
		return v.Z < s.fn(v.X, v.Y)
	}
	sign := below(t)
	for ; t <= t1; t += step {
		if below(t) != sign {
			return ln.Hit{Shape: s, T: t}
		}
	}
	return ln.NoHit
}

func (s *surface) Paths() ln.Paths {
	if current != passDetail {
		return nil
	}
	var paths ln.Paths
	a, b := s.box.Min, s.box.Max
	const samples = 200
	for i := 0; i <= s.n; i++ {
		t := float64(i) / float64(s.n)
		x := a.X + (b.X-a.X)*t
		y := a.Y + (b.Y-a.Y)*t
		var px, py ln.Path
		for j := 0; j <= samples; j++ {
			u := float64(j) / samples
			yy := a.Y + (b.Y-a.Y)*u
			xx := a.X + (b.X-a.X)*u
			px = append(px, ln.Vector{X: x, Y: yy, Z: s.fn(x, yy)})
			py = append(py, ln.Vector{X: xx, Y: y, Z: s.fn(xx, y)})
		}
		paths = append(paths, px, py)
	}
	return paths
}

// Surface is the height field z = fn(x, y) over the rectangle a..b (only x
// and y of a and b are used), solid underneath, drawn as an n-by-n grid.
// It cannot be used inside Difference or Intersection.
func Surface(a, b ln.Vector, n int, fn func(x, y float64) float64) ln.Shape {
	lo, hi := a.Min(b), a.Max(b)
	safe := func(x, y float64) float64 {
		z := fn(x, y)
		if math.IsNaN(z) || math.IsInf(z, 0) {
			return 0
		}
		return z
	}
	z0, z1 := math.Inf(1), math.Inf(-1)
	for i := 0; i <= 80; i++ {
		for j := 0; j <= 80; j++ {
			z := safe(lo.X+(hi.X-lo.X)*float64(i)/80, lo.Y+(hi.Y-lo.Y)*float64(j)/80)
			z0, z1 = math.Min(z0, z), math.Max(z1, z)
		}
	}
	pad := 0.05 + (z1-z0)*0.05
	if n <= 0 {
		n = 24
	}
	box := ln.Box{Min: ln.Vector{X: lo.X, Y: lo.Y, Z: z0 - pad}, Max: ln.Vector{X: hi.X, Y: hi.Y, Z: z1 + pad}}
	return &surface{safe, box, min(n, 200)}
}

// ---- combinators

// boxed corrects ln's boolean bounding box, which is the union of every
// operand (so a large cutter inflates the frame).
type boxed struct {
	ln.Shape
	box ln.Box
}

func (b *boxed) BoundingBox() ln.Box { return b.box }

// Difference carves every later shape out of the first.
func Difference(shapes ...ln.Shape) ln.Shape {
	if len(shapes) == 0 {
		return &ln.EmptyShape{}
	}
	return &boxed{ln.NewDifference(shapes...), shapes[0].BoundingBox()}
}

// Intersection keeps only what all the shapes share.
func Intersection(shapes ...ln.Shape) ln.Shape {
	if len(shapes) == 0 {
		return &ln.EmptyShape{}
	}
	box := shapes[0].BoundingBox()
	for _, s := range shapes[1:] {
		b := s.BoundingBox()
		box = ln.Box{Min: box.Min.Max(b.Min), Max: box.Max.Min(b.Max)}
	}
	return &boxed{ln.NewIntersection(shapes...), box}
}

type transformed struct {
	ln.Shape // an *ln.TransformedShape
	inverse  ln.Matrix
}

func (t *transformed) Paths() ln.Paths {
	saved := eye
	eye = t.inverse.MulPosition(eye)
	defer func() { eye = saved }()
	return t.Shape.Paths()
}

// Transform applies a matrix to a shape.
func Transform(s ln.Shape, m ln.Matrix) ln.Shape {
	return &transformed{ln.NewTransformedShape(s, m), m.Inverse()}
}

// Rotate turns a shape about its own centre.
func Rotate(s ln.Shape, axis ln.Vector, degrees float64) ln.Shape {
	if axis.Length() < 1e-9 || degrees == 0 {
		return s
	}
	c := s.BoundingBox().Center()
	return Transform(s, Rotation(axis, degrees).Mul(ln.Translate(c.MulScalar(-1))).Translate(c))
}

// Rotation is a right-handed rotation matrix: a positive angle turns
// counter-clockwise when looking down the axis toward the origin. (ln's own
// Rotate turns the other way.) Chain with .Translate(v).
func Rotation(axis ln.Vector, degrees float64) ln.Matrix {
	return ln.Rotate(axis.Normalize(), -ln.Radians(degrees))
}

// Translate moves a shape.
func Translate(s ln.Shape, v ln.Vector) ln.Shape { return Transform(s, ln.Translate(v)) }

type textured struct {
	ln.Shape
	paths ln.Paths
}

func (t *textured) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	return t.paths
}

// Textured keeps a shape's solid geometry (it still hides what is behind it)
// but draws the given lines instead of its default ones.
func Textured(s ln.Shape, paths ln.Paths) ln.Shape { return &textured{s, paths} }

type hatched struct {
	ln.Shape
	extra ln.Paths
}

func (h *hatched) Paths() ln.Paths {
	paths := h.Shape.Paths()
	if current == passDetail {
		paths = append(paths, h.extra...)
	}
	return paths
}

// Hatched draws a shape's default lines plus extra lines lying on its
// surface (shading strokes, windows, panel seams).
func Hatched(s ln.Shape, extra ln.Paths) ln.Shape { return &hatched{s, extra} }

type lines struct {
	ln.EmptyShape
	paths ln.Paths
}

func (l *lines) Paths() ln.Paths {
	if current != passDetail {
		return nil
	}
	return l.paths
}
func (l *lines) BoundingBox() ln.Box {
	if len(l.paths) == 0 {
		return ln.Box{}
	}
	return l.paths.BoundingBox()
}

// Lines draws free 3D polylines with no solid body: they can be hidden by
// other shapes but hide nothing themselves.
func Lines(paths ...ln.Path) ln.Shape {
	var kept ln.Paths
	for _, p := range paths {
		if len(p) >= 2 {
			kept = append(kept, p)
		}
	}
	return &lines{paths: kept}
}

type shaded struct{ ln.Shape }

func (s *shaded) Intersect(r ln.Ray) ln.Hit {
	hit := s.Shape.Intersect(r)
	if hit.Ok() {
		hit.Shape = s
	}
	return hit
}

var shadedCount int

// Shade adds pen hatching to a shape: strokes appear where its surface
// turns away from the light or lies in another shape's shadow, denser where
// darker. Set the light with Light.
func Shade(s ln.Shape) ln.Shape {
	shadedCount++
	return &shaded{s}
}

type background struct{ ln.Shape }

// Background leaves a shape out of the automatic framing (use it for a
// large ground or backdrop).
func Background(s ln.Shape) ln.Shape { return &background{s} }

// ---- rendering

func finite(vs ...float64) bool {
	for _, v := range vs {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return true
}

// Render frames the shapes and returns the drawing as SVG.
func Render(cam Camera, shapes []ln.Shape) (string, error) {
	if len(shapes) == 0 {
		return "", errors.New("scene has no shapes")
	}
	fovy := cam.Fovy
	if fovy < 10 || fovy > 100 {
		fovy = 45
	}
	if cam.Eye == (ln.Vector{}) && cam.Center == (ln.Vector{}) {
		cam.Eye = ln.Vector{X: 6, Y: -8, Z: 5}
	}
	dir := cam.Eye.Sub(cam.Center)
	if dir.Length() < 1e-6 || dir.Normalize().Cross(zAxis).Length() < 1e-3 {
		return "", errors.New("camera: eye must differ from center and must not look straight up or down")
	}
	dir = dir.Normalize()

	// Keep the requested view direction, but aim at the middle of the framed
	// shapes and back off until they all fit.
	var framed []ln.Shape
	for _, s := range shapes {
		_, bg := s.(*background)
		_, free := s.(*lines)
		if !bg && !free {
			framed = append(framed, s)
		}
	}
	if len(framed) == 0 {
		framed = shapes
	}
	box := ln.BoxForShapes(framed)
	all := ln.BoxForShapes(shapes)
	if !finite(box.Min.X, box.Min.Y, box.Min.Z, box.Max.X, box.Max.Y, box.Max.Z,
		all.Min.X, all.Min.Y, all.Min.Z, all.Max.X, all.Max.Y, all.Max.Z) {
		return "", errors.New("scene contains non-finite coordinates")
	}
	radius := box.Size().Length() / 2
	if radius < 1e-6 {
		return "", errors.New("scene is empty")
	}
	if extent := all.Size().Length(); extent > maxExtent {
		return "", fmt.Errorf("scene is too large (extent %.1f, max %.0f): keep coordinates within about -10..10", extent, maxExtent)
	}
	center := box.Center()
	dist := radius / math.Sin(ln.Radians(fovy)/2) * 1.05
	eye = center.Add(dir.MulScalar(dist))

	scene := ln.Scene{}
	for _, s := range shapes {
		scene.Add(s)
	}
	near, far := 0.1, dist+maxExtent
	matrix := ln.LookAt(eye, center, zAxis).Perspective(fovy, 1, near, far)
	scene.Compile()
	screen := ln.Translate(ln.Vector{X: 1, Y: 1}).Scale(ln.Vector{X: size / 2, Y: size / 2})
	camera := eye
	visible := func(p pass) ln.Paths {
		current = p
		eye = camera
		paths := scene.Paths().Chop(0.01)
		paths = paths.Filter(&ln.ClipFilter{Matrix: matrix, Eye: camera, Scene: &scene})
		return paths.Simplify(1e-6).Transform(screen)
	}
	outline := visible(passOutline)
	detail := visible(passDetail)
	current = passOutline

	// The camera distance above is conservative. Project the framed shapes'
	// bounding boxes and zoom the drawing so they fill the page.
	lo, hi := ln.Vector{X: math.Inf(1), Y: math.Inf(1)}, ln.Vector{X: math.Inf(-1), Y: math.Inf(-1)}
	for _, s := range framed {
		b := s.BoundingBox()
		for i := 0; i < 8; i++ {
			c := b.Min
			if i&1 != 0 {
				c.X = b.Max.X
			}
			if i&2 != 0 {
				c.Y = b.Max.Y
			}
			if i&4 != 0 {
				c.Z = b.Max.Z
			}
			p := screen.MulPosition(matrix.MulPositionW(c))
			p.Z = 0
			lo, hi = lo.Min(p), hi.Max(p)
		}
	}
	fit := ln.Identity()
	zoom := 1.0
	if span := math.Max(hi.X-lo.X, hi.Y-lo.Y); finite(lo.X, lo.Y, hi.X, hi.Y) && span > 1 {
		zoom = math.Min(size*(1-2*margin)/span, 4)
		mid := lo.Add(hi).MulScalar(0.5)
		fit = ln.Translate(mid.MulScalar(-1)).Scale(ln.Vector{X: zoom, Y: zoom, Z: 1}).Translate(ln.Vector{X: size / 2, Y: size / 2})
	}
	layers := []ln.Paths{clean(outline.Transform(fit), nil), nil, nil}
	layers[1] = clean(detail.Transform(fit), layers[0])
	if shadedCount > 0 {
		layers[2] = hatch(&scene, camera, center, fovy, fit.Inverse())
	}
	if len(layers[0])+len(layers[1]) == 0 {
		return "", errors.New("nothing visible from this camera")
	}
	return toSVG(layers), nil
}

// clean drops broken paths and any path already present in seen (a shape
// that ignores passes would otherwise be drawn twice).
func clean(paths, seen ln.Paths) ln.Paths {
	key := func(p ln.Path) string {
		return fmt.Sprintf("%d:%.2f,%.2f:%.2f,%.2f", len(p), p[0].X, p[0].Y, p[len(p)-1].X, p[len(p)-1].Y)
	}
	have := map[string]bool{}
	for _, p := range seen {
		have[key(p)] = true
	}
	var out ln.Paths
	for _, p := range paths {
		ok := len(p) >= 2
		for _, v := range p {
			ok = ok && finite(v.X, v.Y)
		}
		if ok && !have[key(p)] {
			out = append(out, p)
		}
	}
	return out
}

// hatch shades the Shade-wrapped shapes with diagonal pen strokes laid out
// on the page: rays through each stroke find the surface, and a stroke is
// kept where that surface faces away from the light or is in shadow.
func hatch(scene *ln.Scene, camera, center ln.Vector, fovy float64, toScreen ln.Matrix) ln.Paths {
	const spacing, step = 4.5, 3.0
	forward := center.Sub(camera).Normalize()
	right := forward.Cross(zAxis).Normalize()
	up := right.Cross(forward)
	tan := math.Tan(ln.Radians(fovy) / 2)
	cast := func(x, y float64) (ln.Vector, float64, bool) {
		s := toScreen.MulPosition(ln.Vector{X: x, Y: y})
		u, v := s.X/(size/2)-1, s.Y/(size/2)-1
		dir := forward.Add(right.MulScalar(u * tan)).Add(up.MulScalar(v * tan)).Normalize()
		hit := scene.Intersect(ln.Ray{Origin: camera, Direction: dir})
		if !hit.Ok() {
			return ln.Vector{}, 0, false
		}
		if _, ok := hit.Shape.(*shaded); !ok {
			return ln.Vector{}, 0, false
		}
		return camera.Add(dir.MulScalar(hit.T)), hit.T, true
	}
	darkness := func(x, y float64) float64 {
		p, t, ok := cast(x, y)
		if !ok {
			return 0
		}
		px, tx, okx := cast(x+1.5, y)
		py, ty, oky := cast(x, y+1.5)
		if !okx || !oky || math.Abs(tx-t) > 0.03*t || math.Abs(ty-t) > 0.03*t {
			return 0
		}
		n := px.Sub(p).Cross(py.Sub(p))
		if n.Length() < 1e-12 {
			return 0
		}
		n = n.Normalize()
		if n.Dot(camera.Sub(p)) < 0 {
			n = n.MulScalar(-1)
		}
		d := (1 - n.Dot(light)) / 2
		if d < 0.8 && n.Dot(light) > 0 {
			if scene.Intersect(ln.Ray{Origin: p.Add(n.MulScalar(0.02)), Direction: light}).Ok() {
				d = math.Max(d, 0.72)
			}
		}
		return d
	}
	var paths ln.Paths
	index := 0
	for c := -size; c <= size; c += spacing {
		index++
		var start, end ln.Vector
		open := false
		flush := func() {
			if open && end.Sub(start).Length() >= step*1.5 {
				// Alternate direction, the way a hand hatches back and forth.
				if index%2 == 0 {
					start, end = end, start
				}
				paths = append(paths, ln.Path{start, end})
			}
			open = false
		}
		// The stroke runs along y = x + c across the page.
		for x := math.Max(0, -c); x <= math.Min(size, size-c); x += step {
			y := x + c
			d := darkness(x, y)
			draw := d > 0.86 || (d > 0.68 && index%2 == 0) || (d > 0.5 && index%4 == 0)
			if !draw {
				flush()
				continue
			}
			p := ln.Vector{X: x, Y: y}
			if !open {
				start, open = p, true
			}
			end = p
		}
		flush()
	}
	return paths
}

// toSVG writes one group per layer (outline, detail, shade), with y flipped
// so the page origin is at the top left.
func toSVG(layers []ln.Paths) string {
	var b strings.Builder
	fmt.Fprintf(&b, "<svg width=\"%g\" height=\"%g\" viewBox=\"0 0 %g %g\" version=\"1.1\" xmlns=\"http://www.w3.org/2000/svg\">\n", size, size, size, size)
	for i, paths := range layers {
		if len(paths) == 0 {
			continue
		}
		fmt.Fprintf(&b, "<g id=\"layer%d\" fill=\"none\" stroke=\"black\">\n", i+1)
		for _, p := range paths {
			b.WriteString("<polyline points=\"")
			for j, v := range p {
				if j > 0 {
					b.WriteByte(' ')
				}
				fmt.Fprintf(&b, "%.2f,%.2f", v.X, size-v.Y)
			}
			b.WriteString("\" />\n")
		}
		b.WriteString("</g>\n")
	}
	b.WriteString("</svg>")
	return b.String()
}

// Run renders the shapes and writes the SVG to stdout, exiting non-zero with
// a message on stderr if the scene cannot be drawn.
func Run(cam Camera, shapes []ln.Shape) {
	svg, err := Render(cam, shapes)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(svg)
}
