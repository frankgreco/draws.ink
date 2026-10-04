package kit

import (
	"math"

	"github.com/fogleman/ln/ln"
)

// Solids that ln does not provide: ellipsoids, lathed profiles, tubes along
// a curve, and extruded outlines. Each implements ln.Shape with its own ray
// intersection so it hides what is behind it.

const hitEps = 1e-4

func circle(r, z float64) ln.Path {
	var p ln.Path
	for a := 0; a <= 360; a += 3 {
		t := ln.Radians(float64(a))
		p = append(p, ln.Vector{X: r * math.Cos(t), Y: r * math.Sin(t), Z: z})
	}
	return p
}

// ---- ellipsoid

type ellipsoid struct {
	center, radii ln.Vector
}

func (e *ellipsoid) Compile() {}
func (e *ellipsoid) BoundingBox() ln.Box {
	return ln.Box{Min: e.center.Sub(e.radii), Max: e.center.Add(e.radii)}
}
func (e *ellipsoid) local(v ln.Vector) ln.Vector { return v.Sub(e.center).Div(e.radii) }
func (e *ellipsoid) Contains(v ln.Vector, f float64) bool {
	return e.local(v).Length() <= 1+f/e.radii.MinComponent()
}

func (e *ellipsoid) Intersect(r ln.Ray) ln.Hit {
	o, d := e.local(r.Origin), r.Direction.Div(e.radii)
	a, b, c := d.Dot(d), o.Dot(d), o.Dot(o)-1
	q := b*b - a*c
	if q <= 0 {
		return ln.NoHit
	}
	s := math.Sqrt(q)
	for _, t := range [2]float64{(-b - s) / a, (-b + s) / a} {
		if t > 1e-2 {
			return ln.Hit{Shape: e, T: t}
		}
	}
	return ln.NoHit
}

// The silhouette of a unit sphere seen from the eye, mapped back out: an
// affine map keeps tangent rays tangent, so this is exact.
func (e *ellipsoid) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	le := e.local(eye)
	hyp := le.Length()
	if hyp <= 1.0001 {
		return nil
	}
	d := 1 / hyp // distance from centre to the silhouette plane
	r := math.Sqrt(1 - d*d)
	w := le.MulScalar(1 / hyp)
	up := zAxis
	if math.Abs(w.Z) > 0.999 {
		up = ln.Vector{X: 1}
	}
	u := w.Cross(up).Normalize()
	v := w.Cross(u).Normalize()
	c := w.MulScalar(d)
	var path ln.Path
	for i := 0; i <= 360; i += 2 {
		a := ln.Radians(float64(i))
		p := c.Add(u.MulScalar(math.Cos(a) * r)).Add(v.MulScalar(math.Sin(a) * r))
		// Slightly proud of the surface, so the chords between samples do
		// not dip inside the solid and hide themselves.
		path = append(path, p.MulScalar(1.003).Mul(e.radii).Add(e.center))
	}
	return ln.Paths{path}
}

// Ellipsoid is a stretched sphere with separate radii along x, y and z,
// drawn as its silhouette. Rotate it to tilt it.
func Ellipsoid(center, radii ln.Vector) ln.Shape {
	radii = ln.Vector{X: math.Max(math.Abs(radii.X), 1e-4), Y: math.Max(math.Abs(radii.Y), 1e-4), Z: math.Max(math.Abs(radii.Z), 1e-4)}
	return &ellipsoid{center, radii}
}

// ---- lathe

// lathe is a profile of (radius, z) points spun around the local Z axis.
type lathe struct {
	rs, zs     []float64
	rings      bool // draw a circle wherever the profile has a corner
	capA, capB bool // draw the end circles
	box        ln.Box
}

func (l *lathe) Compile()            {}
func (l *lathe) BoundingBox() ln.Box { return l.box }

func (l *lathe) radiusAt(z float64) (float64, bool) {
	n := len(l.zs)
	if z < l.zs[0] || z > l.zs[n-1] {
		return 0, false
	}
	best := 0.0
	for i := 0; i < n-1; i++ {
		z0, z1 := l.zs[i], l.zs[i+1]
		if z < z0 || z > z1 {
			continue
		}
		r := math.Max(l.rs[i], l.rs[i+1])
		if z1-z0 > 1e-9 {
			r = l.rs[i] + (l.rs[i+1]-l.rs[i])*(z-z0)/(z1-z0)
		}
		best = math.Max(best, r)
	}
	return best, true
}

func (l *lathe) Contains(v ln.Vector, f float64) bool {
	r, ok := l.radiusAt(math.Min(math.Max(v.Z, l.zs[0]), l.zs[len(l.zs)-1]))
	if !ok || v.Z < l.zs[0]-f || v.Z > l.zs[len(l.zs)-1]+f {
		return false
	}
	return math.Hypot(v.X, v.Y) <= r+f
}

func (l *lathe) Intersect(ray ln.Ray) ln.Hit {
	o, d := ray.Origin, ray.Direction
	best := math.Inf(1)
	try := func(t float64) {
		if t > hitEps && t < best {
			best = t
		}
	}
	// a flat ring at height z between two radii (caps and steps)
	disc := func(z, r0, r1 float64) {
		if math.Abs(d.Z) < 1e-12 {
			return
		}
		t := (z - o.Z) / d.Z
		if t <= hitEps || t >= best {
			return
		}
		h := math.Hypot(o.X+t*d.X, o.Y+t*d.Y)
		if h >= math.Min(r0, r1) && h <= math.Max(r0, r1) {
			best = t
		}
	}
	n := len(l.zs)
	disc(l.zs[0], 0, l.rs[0])
	disc(l.zs[n-1], 0, l.rs[n-1])
	for i := 0; i < n-1; i++ {
		z0, z1, r0, r1 := l.zs[i], l.zs[i+1], l.rs[i], l.rs[i+1]
		if z1-z0 < 1e-9 {
			disc(z0, r0, r1)
			continue
		}
		k := (r1 - r0) / (z1 - z0)
		m := r0 + k*(o.Z-z0)
		nn := k * d.Z
		a := d.X*d.X + d.Y*d.Y - nn*nn
		b := 2 * (o.X*d.X + o.Y*d.Y - m*nn)
		c := o.X*o.X + o.Y*o.Y - m*m
		var roots [2]float64
		count := 0
		if math.Abs(a) < 1e-12 {
			if math.Abs(b) > 1e-12 {
				roots[0], count = -c/b, 1
			}
		} else if q := b*b - 4*a*c; q >= 0 {
			s := math.Sqrt(q)
			roots[0], roots[1], count = (-b-s)/(2*a), (-b+s)/(2*a), 2
		}
		for _, t := range roots[:count] {
			z := o.Z + t*d.Z
			if z >= z0 && z <= z1 && r0+k*(z-z0) >= 0 {
				try(t)
			}
		}
	}
	if math.IsInf(best, 1) {
		return ln.NoHit
	}
	return ln.Hit{Shape: l, T: best}
}

// silhouette returns the outline of the spun profile as seen from the eye:
// on each conical band it is a pair of straight generators.
func (l *lathe) silhouette() ln.Paths {
	var paths ln.Paths
	n := len(l.zs)
	var left, right ln.Path
	flush := func() {
		if len(left) > 1 {
			paths = append(paths, left, right)
		}
		left, right = nil, nil
	}
	R := math.Hypot(eye.X, eye.Y)
	base := math.Atan2(eye.Y, eye.X)
	for i := 0; i < n-1; i++ {
		z0, z1, r0, r1 := l.zs[i], l.zs[i+1], l.rs[i], l.rs[i+1]
		if z1-z0 < 1e-9 || R < 1e-9 {
			flush()
			continue
		}
		k := (r1 - r0) / (z1 - z0)
		cosv := (r0 - k*z0 + k*eye.Z) / R
		if math.Abs(cosv) >= 1 {
			flush()
			continue
		}
		delta := math.Acos(cosv)
		const out = 1.004
		pt := func(theta, r, z float64) ln.Vector {
			return ln.Vector{X: r * out * math.Cos(theta), Y: r * out * math.Sin(theta), Z: z}
		}
		left = append(left, pt(base+delta, r0, z0), pt(base+delta, r1, z1))
		right = append(right, pt(base-delta, r0, z0), pt(base-delta, r1, z1))
	}
	flush()
	return paths
}

func (l *lathe) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	paths := l.silhouette()
	n := len(l.zs)
	ring := func(i int) {
		if l.rs[i] > 1e-6 {
			paths = append(paths, circle(l.rs[i]*1.002, l.zs[i]))
		}
	}
	if l.capA {
		ring(0)
	}
	if l.capB {
		ring(n - 1)
	}
	if l.rings {
		for i := 1; i < n-1; i++ {
			a0 := math.Atan2(l.rs[i]-l.rs[i-1], l.zs[i]-l.zs[i-1])
			a1 := math.Atan2(l.rs[i+1]-l.rs[i], l.zs[i+1]-l.zs[i])
			if math.Abs(a1-a0) > ln.Radians(22) {
				ring(i)
			}
		}
	}
	return paths
}

func newLathe(rs, zs []float64, rings, capA, capB bool) *lathe {
	maxR := 0.0
	for i := range rs {
		rs[i] = math.Max(rs[i], 0)
		maxR = math.Max(maxR, rs[i])
		if i > 0 && zs[i] < zs[i-1] {
			zs[i] = zs[i-1]
		}
	}
	box := ln.Box{Min: ln.Vector{X: -maxR, Y: -maxR, Z: zs[0]}, Max: ln.Vector{X: maxR, Y: maxR, Z: zs[len(zs)-1]}}
	return &lathe{rs, zs, rings, capA, capB, box}
}

// Lathe spins a profile around a vertical axis standing on base. The
// profile is a list of {radius, height} points from bottom to top; heights
// must not decrease. Corners in the profile are drawn as rings. Use many
// points for a smooth curve: vases, towers, bottles, domes, chess pieces,
// wheels, mushrooms.
func Lathe(base ln.Vector, profile [][2]float64) ln.Shape {
	if len(profile) < 2 {
		return &ln.EmptyShape{}
	}
	rs := make([]float64, len(profile))
	zs := make([]float64, len(profile))
	for i, p := range profile {
		rs[i], zs[i] = p[0], p[1]
	}
	return Transform(newLathe(rs, zs, true, true, true), ln.Translate(base))
}

// ---- groups and tubes

type silent struct{ ln.Shape }

func (s *silent) Paths() ln.Paths { return nil }

// group is several solids acting as one.
type group struct {
	shapes []ln.Shape
	tree   *ln.Tree
	box    ln.Box
}

func newGroup(shapes []ln.Shape) *group {
	for _, s := range shapes {
		s.Compile()
	}
	return &group{shapes, ln.NewTree(shapes), ln.BoxForShapes(shapes)}
}

func (g *group) Compile()                  {}
func (g *group) BoundingBox() ln.Box       { return g.box }
func (g *group) Intersect(r ln.Ray) ln.Hit { return g.tree.Intersect(r) }
func (g *group) Contains(v ln.Vector, f float64) bool {
	for _, s := range g.shapes {
		if s.Contains(v, f) {
			return true
		}
	}
	return false
}
func (g *group) Paths() ln.Paths {
	var paths ln.Paths
	for _, s := range g.shapes {
		paths = append(paths, s.Paths()...)
	}
	return paths
}

// Group makes several shapes behave as one, so they can be rotated, moved,
// shaded or carved together.
func Group(shapes ...ln.Shape) ln.Shape {
	if len(shapes) == 0 {
		return &ln.EmptyShape{}
	}
	return newGroup(shapes)
}

// tube is a chain of conical segments with a ball at each bend. Its outline
// is drawn as two continuous lines, bridging the small gaps between the
// segments' own silhouettes.
type tube struct {
	*group
	segs     []*lathe
	matrices []ln.Matrix
	sharp    []bool     // sharp[i]: the tube turns a real corner where segment i starts
	balls    []ln.Shape // outlined balls at the sharp corners
	r0, r1   float64
}

func (t *tube) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	var paths ln.Paths
	var left, right ln.Path
	flush := func() {
		if len(left) > 1 {
			paths = append(paths, left, right)
		}
		left, right = nil, nil
	}
	camera := eye
	for i, seg := range t.segs {
		if t.sharp[i] {
			flush()
		}
		m := t.matrices[i]
		eye = m.Inverse().MulPosition(camera)
		sides := seg.silhouette()
		if len(sides) != 2 {
			flush()
			continue
		}
		left = append(left, sides[0].Transform(m)...)
		right = append(right, sides[1].Transform(m)...)
	}
	eye = camera
	flush()
	for _, ball := range t.balls {
		paths = append(paths, ball.Paths()...)
	}
	last := len(t.segs) - 1
	paths = append(paths, circle(t.r0*1.002, 0).Transform(t.matrices[0]))
	paths = append(paths, circle(t.r1*1.002, t.segs[last].zs[1]).Transform(t.matrices[last]))
	return paths
}

// TaperedTube is a round tube following a path of points, its radius going
// from r0 at the first point to r1 at the last. Only its silhouette and end
// circles are drawn: tails, limbs, branches, horns, necks, hoses, handles.
func TaperedTube(points []ln.Vector, r0, r1 float64) ln.Shape {
	var pts []ln.Vector
	for _, p := range points {
		if len(pts) == 0 || p.Sub(pts[len(pts)-1]).Length() > 1e-6 {
			pts = append(pts, p)
		}
	}
	if len(pts) < 2 {
		return &ln.EmptyShape{}
	}
	lengths := make([]float64, len(pts))
	for i := 1; i < len(pts); i++ {
		lengths[i] = lengths[i-1] + pts[i].Sub(pts[i-1]).Length()
	}
	total := lengths[len(pts)-1]
	radius := func(i int) float64 { return math.Max(r0+(r1-r0)*lengths[i]/total, 1e-4) }
	t := &tube{r0: radius(0), r1: radius(len(pts) - 1)}
	var shapes []ln.Shape
	for i := 0; i < len(pts)-1; i++ {
		h := pts[i+1].Sub(pts[i]).Length()
		seg := newLathe([]float64{radius(i), radius(i + 1)}, []float64{0, h}, false, false, false)
		m := align(pts[i], pts[i+1])
		t.segs = append(t.segs, seg)
		t.matrices = append(t.matrices, m)
		shapes = append(shapes, ln.NewTransformedShape(seg, m))
		sharp := false
		if i > 0 {
			// A ball at each bend closes the gap on the outside of the turn.
			// Gentle bends are bridged by the outline itself; at a real corner
			// the ball's own outline rounds it off.
			ball := Sphere(pts[i], radius(i)*0.995)
			shapes = append(shapes, ball)
			a, b := pts[i].Sub(pts[i-1]).Normalize(), pts[i+1].Sub(pts[i]).Normalize()
			if sharp = a.Dot(b) < math.Cos(ln.Radians(14)); sharp {
				t.balls = append(t.balls, ball)
			}
		}
		t.sharp = append(t.sharp, sharp)
	}
	t.group = newGroup(shapes)
	return t
}

// Tube is a round tube of constant radius following a path of points.
func Tube(points []ln.Vector, radius float64) ln.Shape { return TaperedTube(points, radius, radius) }

// ---- extrusion

// prism is a closed 2D outline in the XY plane pushed along Z.
type prism struct {
	pts    [][2]float64 // counter-clockwise
	z0, z1 float64
	box    ln.Box
}

func (p *prism) Compile()            {}
func (p *prism) BoundingBox() ln.Box { return p.box }

func (p *prism) inside(x, y float64) bool {
	in := false
	n := len(p.pts)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		a, b := p.pts[i], p.pts[j]
		if (a[1] > y) != (b[1] > y) && x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0] {
			in = !in
		}
	}
	return in
}

func (p *prism) Contains(v ln.Vector, f float64) bool {
	return v.Z >= p.z0-f && v.Z <= p.z1+f && p.inside(v.X, v.Y)
}

func (p *prism) Intersect(r ln.Ray) ln.Hit {
	o, d := r.Origin, r.Direction
	best := math.Inf(1)
	if math.Abs(d.Z) > 1e-12 {
		for _, z := range [2]float64{p.z0, p.z1} {
			t := (z - o.Z) / d.Z
			if t > hitEps && t < best && p.inside(o.X+t*d.X, o.Y+t*d.Y) {
				best = t
			}
		}
	}
	n := len(p.pts)
	for i := 0; i < n; i++ {
		a, b := p.pts[i], p.pts[(i+1)%n]
		ex, ey := b[0]-a[0], b[1]-a[1]
		den := d.X*ey - d.Y*ex
		if math.Abs(den) < 1e-12 {
			continue
		}
		t := ((a[0]-o.X)*ey - (a[1]-o.Y)*ex) / den
		if t <= hitEps || t >= best {
			continue
		}
		s := ((a[0]-o.X)*d.Y - (a[1]-o.Y)*d.X) / den
		if z := o.Z + t*d.Z; s >= 0 && s <= 1 && z >= p.z0 && z <= p.z1 {
			best = t
		}
	}
	if math.IsInf(best, 1) {
		return ln.NoHit
	}
	return ln.Hit{Shape: p, T: best}
}

func (p *prism) Paths() ln.Paths {
	if current != passOutline {
		return nil
	}
	var top, bottom ln.Path
	n := len(p.pts)
	for i := 0; i <= n; i++ {
		q := p.pts[i%n]
		top = append(top, ln.Vector{X: q[0], Y: q[1], Z: p.z1})
		bottom = append(bottom, ln.Vector{X: q[0], Y: q[1], Z: p.z0})
	}
	paths := ln.Paths{top, bottom}
	// An upright edge is drawn at sharp corners, and wherever the wall turns
	// away from the viewer (the silhouette of a curved wall).
	for i := 0; i < n; i++ {
		a, v, b := p.pts[(i+n-1)%n], p.pts[i], p.pts[(i+1)%n]
		e1x, e1y := v[0]-a[0], v[1]-a[1]
		e2x, e2y := b[0]-v[0], b[1]-v[1]
		dx, dy := eye.X-v[0], eye.Y-v[1]
		front1 := e1y*dx-e1x*dy > 0
		front2 := e2y*dx-e2x*dy > 0
		turn := math.Abs(math.Atan2(e1x*e2y-e1y*e2x, e1x*e2x+e1y*e2y))
		if front1 != front2 || turn > ln.Radians(25) {
			paths = append(paths, ln.Path{{X: v[0], Y: v[1], Z: p.z0}, {X: v[0], Y: v[1], Z: p.z1}})
		}
	}
	return paths
}

func newPrism(outline [][2]float64, z0, z1 float64) ln.Shape {
	var pts [][2]float64
	for _, q := range outline {
		if len(pts) == 0 || math.Hypot(q[0]-pts[len(pts)-1][0], q[1]-pts[len(pts)-1][1]) > 1e-7 {
			pts = append(pts, q)
		}
	}
	if len(pts) > 1 && math.Hypot(pts[0][0]-pts[len(pts)-1][0], pts[0][1]-pts[len(pts)-1][1]) < 1e-7 {
		pts = pts[:len(pts)-1]
	}
	if len(pts) < 3 || z0 == z1 {
		return &ln.EmptyShape{}
	}
	area := 0.0
	lo := ln.Vector{X: math.Inf(1), Y: math.Inf(1), Z: math.Min(z0, z1)}
	hi := ln.Vector{X: math.Inf(-1), Y: math.Inf(-1), Z: math.Max(z0, z1)}
	for i, q := range pts {
		r := pts[(i+1)%len(pts)]
		area += q[0]*r[1] - r[0]*q[1]
		lo.X, lo.Y = math.Min(lo.X, q[0]), math.Min(lo.Y, q[1])
		hi.X, hi.Y = math.Max(hi.X, q[0]), math.Max(hi.Y, q[1])
	}
	if area < 0 {
		for i, j := 0, len(pts)-1; i < j; i, j = i+1, j-1 {
			pts[i], pts[j] = pts[j], pts[i]
		}
	}
	return &prism{pts, lo.Z, hi.Z, ln.Box{Min: lo, Max: hi}}
}

// Extrude pushes a closed outline of {x, y} points (a floor plan) up from
// height z0 to z1: slabs, star or L-shaped buildings, gears lying flat.
func Extrude(outline [][2]float64, z0, z1 float64) ln.Shape { return newPrism(outline, z0, z1) }

// ExtrudeY pushes a closed outline of {x, z} points (a front elevation, as
// seen from the default camera side) through depth y0 to y1: arches, gable
// walls, letters, gears and wheels standing upright, side profiles of cars,
// boats and animals.
func ExtrudeY(outline [][2]float64, y0, y1 float64) ln.Shape {
	flat := make([][2]float64, len(outline))
	for i, q := range outline {
		flat[i] = [2]float64{q[0], q[1]}
	}
	// local (x, y, z) -> world (x, -z, y): a quarter turn about the X axis.
	return Transform(newPrism(flat, -y1, -y0), Rotation(ln.Vector{X: 1}, 90))
}

// RoundedBox is a box between two corners whose upright edges are rounded.
func RoundedBox(a, b ln.Vector, radius float64) ln.Shape {
	lo, hi := a.Min(b), a.Max(b)
	r := math.Min(radius, math.Min(hi.X-lo.X, hi.Y-lo.Y)/2*0.999)
	if r <= 1e-6 {
		return Cube(lo, hi)
	}
	var pts [][2]float64
	corners := [4][3]float64{{hi.X - r, hi.Y - r, 0}, {lo.X + r, hi.Y - r, 90}, {lo.X + r, lo.Y + r, 180}, {hi.X - r, lo.Y + r, 270}}
	for _, c := range corners {
		for s := 0; s <= 8; s++ {
			t := ln.Radians(c[2] + float64(s)*90/8)
			pts = append(pts, [2]float64{c[0] + r*math.Cos(t), c[1] + r*math.Sin(t)})
		}
	}
	return newPrism(pts, lo.Z, hi.Z)
}
