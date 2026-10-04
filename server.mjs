// The draws.ink server: a prompt goes in, pen strokes come out.
//
// The public site has one page and one endpoint, POST /api/sketch
// {prompt, aspect}. An image model draws the picture, trace.py turns it into
// strokes and vpype tidies them. Visitors choose the prompt and the shape of
// the page (square, tall or wide), nothing else.
//
// Environment:
//   OPENROUTER_API_KEY   required in production (locally .dev.vars is read too)
//   PORT, HOST           default 5177 on 127.0.0.1; set HOST=0.0.0.0 to serve publicly
//   TRUST_PROXY=1        take the visitor's address from X-Forwarded-For
//   SKETCH_IP_LIMIT      drawings per visitor per 10 minutes (default 5)
//   SKETCH_IP_DAILY      drawings per visitor per day (default 25)
//   SKETCH_DAILY_CAP     drawings per day for everyone together (default 500)
//   SKETCH_CONCURRENCY   drawings in progress at once (default 4)
//   SKETCH_GATED=1       something in front counts each visitor's drawings and
//                        the day's total, so only the cap on drawings in
//                        progress applies here. The Cloudflare deployment sets
//                        it: src/worker.js keeps those counts in storage that
//                        outlives this process.
//   SKETCH_LAB=1         development only: adds /lab, where the model and the
//                        older 3D modes (a language model writes a scene, ln
//                        renders it) can be chosen, and switches the limits
//                        off. Never set it on a public server: the 3D code
//                        mode compiles and runs model-written Go.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, rm, realpath, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { createGzip, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS, MAX_PROMPT, WINDOW_MS, DAY_MS, MESSAGES, limitsFrom, refusal, decide } from "./shared.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5177);
const HOST = process.env.HOST ?? "127.0.0.1";
const LAB = process.env.SKETCH_LAB === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const GATED = process.env.SKETCH_GATED === "1";
const LIMITS = limitsFrom(process.env);
const MAX_STROKES = 7000;   // more than this and the picture was not line art
// Scene models, compared on six prompts: Sol drew the most detailed scenes, Opus was faster.
const MODELS = ["openai/gpt-6.1-sol", "anthropic/claude-opus-5.5"];
const DEFAULT_MODEL = process.env.SKETCH_MODEL ?? MODELS[0];
// Image models, compared on six prompts: MAI Flash drew as well as Gemini Flash
// for under a third of the price. The first is the one the site uses.
const IMAGE_MODELS = ["microsoft/mai-image-2.6-flash", "google/gemini-3.1-flash-image", "google/gemini-3-pro-image", "openai/gpt-5.4-image-2"];
// Gemini and GPT image models answer in words as well and must be asked for
// both; the image-only models refuse a request that mentions text.
const speaks = (model) => /^(google|openai)\//.test(model);
const DEFAULT_IMAGE_MODEL = process.env.SKETCH_IMAGE_MODEL ?? IMAGE_MODELS[0];
// Rewords a request the image model's provider refused (see reword below).
const REWORD_MODEL = process.env.SKETCH_REWORD_MODEL ?? "anthropic/claude-haiku-4.5";
// The page shapes on offer: the ratio the image model is asked for, how the
// prompt describes it, and the page the strokes are fitted to. The pages are
// about the size of the model's pictures, so the pen weights suit all three.
const ASPECTS = {
  square: { ratio: "1:1", words: "a square page", page: [1024, 1024] },
  tall: { ratio: "9:16", words: "a tall portrait page", page: [756, 1344] },
  wide: { ratio: "16:9", words: "a wide landscape page", page: [1344, 756] },
};
const RENDER_DIR = join(ROOT, "render");
const RENDER_BIN = join(ROOT, "bin", "render");
const VPYPE_BIN = join(ROOT, ".venv", "bin", "vpype");
const PYTHON_BIN = join(ROOT, ".venv", "bin", "python");
const TRACE_SCRIPT = join(ROOT, "trace.py");
const SANDBOX_PROFILE = join(ROOT, "sandbox.sb");
const MAX_ATTEMPTS = 3;

// Locally the OpenRouter key comes from .dev.vars, which is not committed.
function loadApiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const file = join(ROOT, ".dev.vars");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").match(/^\s*OPENROUTER_API_KEY\s*=\s*["']?(.*?)["']?\s*$/m)?.[1] || null;
}
const API_KEY = loadApiKey();

const INTRO = `You design scenes for a 3D line-art renderer. The scene is drawn as black pen lines on white paper with hidden lines removed, like a pen plotter drawing.

Coordinate system: right-handed, Z is up, the ground is z = 0. Keep everything within about -10..10 on each axis.

Camera: only the direction from center to eye matters. The renderer keeps that viewing direction and moves the camera so the shapes fill the frame. Never look straight down the Z axis. A three-quarter view from above (for example eye (7,-9,5)) reads best.`;

const ADVICE = `Composition advice:
- Build recognisable things from many small primitives.
- Shapes hide what is behind them, so overlap them freely; put objects on the ground (z = 0) or on each other.
- Mix plain outlines with a few textured shapes; too many textured shapes turns into a dark blob.
- Model the subject at a consistent scale and make sure parts touch: nothing floating, nothing detached.
- Do not add a ground plane, floor grid or surface under the subject. Draw the subject on blank paper. Only add a surface when the request itself names terrain or water (hills, sea, lake, dunes), and then keep it just large enough to sit the subject in.
- Organic subjects must be stylised from spheres, cylinders and cones. Commit to a clear, simple silhouette.`;

const JSON_PROMPT = `${INTRO}

Reply with one JSON object and nothing else:

{
  "camera": { "eye": [x,y,z], "center": [x,y,z], "fovy": 45 },
  "shapes": [ ... ]
}

Shapes (lengths in scene units, angles in degrees):
- {"type":"cube","min":[x,y,z],"max":[x,y,z],"style":"outline"|"columns"|"floors","lines":n}
  An axis-aligned box. "columns" adds n vertical lines per side, "floors" adds n horizontal bands (good for buildings).
- {"type":"sphere","center":[x,y,z],"radius":r,"style":"outline"|"grid"}
  "outline" is a clean silhouette, "grid" draws latitude/longitude lines.
- {"type":"cylinder","from":[x,y,z],"to":[x,y,z],"radius":r,"style":"outline"|"lines","lines":n}
  A capped cylinder between two points, any orientation.
- {"type":"cone","from":[x,y,z],"to":[x,y,z],"radius":r}
  "from" is the centre of the base, "to" is the tip.
- {"type":"surface","preset":"flat"|"ripple"|"waves"|"hills"|"peak"|"saddle","min":[x,y,z],"max":[x,y,z],"amplitude":a,"frequency":f,"seed":s,"lines":n}
  A height field over the rectangle min..max in x,y; min z is the base height; drawn as an n-by-n grid; solid underneath. "flat" is a ground grid.
- {"type":"difference","shapes":[A,B,...]} carves B and the rest out of A. {"type":"intersection","shapes":[A,B,...]} keeps the overlap.
  Only cube, sphere, cylinder and cone may appear inside. Inside these, use "grid", "lines", "columns" or "floors" styles so the carved faces show.

Any shape may also have:
- "rotate": {"axis":[x,y,z],"degrees":d}, which rotates it about its own centre.
- "frame": false, which leaves it out of the automatic framing (use this for a large ground or backdrop).

${ADVICE}
- 20 to 150 shapes is normal. At most 400.
- Output raw JSON only: no markdown fence, no comments, no trailing commas.`;

// Only the lab's 3D code mode shows these to a model; a public server runs
// without the render directory.
const EXAMPLES = !LAB ? "" : ["lamp", "owl"]
  .map((name) => readFileSync(join(RENDER_DIR, "examples", name, "main.go"), "utf8").trim())
  .join("\n\n----\n\n");

const ALLOWED_IMPORTS = ["math", "math/rand", "math/cmplx", "sort", "slices", "github.com/fogleman/ln/ln", "sketch/render/kit"];

const CODE_PROMPT = `${INTRO}

Reply with one complete Go program and nothing else. It builds a list of shapes and calls kit.Run exactly once, which writes the drawing. Skeleton:

package main

import (
	"math"
	"math/rand"

	"github.com/fogleman/ln/ln"

	"sketch/render/kit"
)

func main() {
	rng := rand.New(rand.NewSource(1))
	var shapes []ln.Shape
	// ... append shapes, using loops, helper functions and rng freely ...
	_, _ = rng, math.Pi
	kit.Run(kit.Camera{Eye: kit.V(7, -9, 5), Center: kit.V(0, 0, 1), Fovy: 45}, shapes)
}

Allowed imports, and no others: ${ALLOWED_IMPORTS.join(", ")}. Unused imports and unused variables are compile errors in Go.

package kit (all shapes are ln.Shape; vectors are ln.Vector, built with kit.V(x, y, z)):

Basic solids
- kit.Cube(a, b)                      axis-aligned box between two corners, drawn as its edges
- kit.CubeColumns(a, b, n)            box with n vertical lines per side
- kit.CubeFloors(a, b, n)             box with n horizontal bands (buildings)
- kit.RoundedBox(a, b, r)             box whose upright edges are rounded with radius r
- kit.Sphere(center, r)               clean silhouette
- kit.GridSphere(center, r)           silhouette plus latitude/longitude lines
- kit.Ellipsoid(center, kit.V(rx, ry, rz))   stretched sphere: bodies, heads, leaves, hulls, cushions
- kit.Cylinder(from, to, r)           capped cylinder between two points
- kit.LinedCylinder(from, to, r, n)   cylinder with n lines along its length
- kit.Cone(base, tip, r)              base circle centre and tip point

Shaped solids (prefer these to stacks of primitives)
- kit.Lathe(base, [][2]float64{{radius, height}, ...})
                                      a profile spun round a vertical axis standing on base, listed bottom to top (heights must not decrease; a repeated height makes a flat step). Corners in the profile are drawn as rings; use 20+ points for a smooth curve. Vases, towers, bottles, domes, bells, lamp shades, turned legs, chess pieces, mushrooms, wheels lying flat, tree trunks.
- kit.Tube(points, r)                 a round tube following a []ln.Vector path, drawn as one smooth outline
- kit.TaperedTube(points, r0, r1)     the same, radius going from r0 to r1: tails, limbs, necks, branches, horns, tentacles, cables, handles, rails. Use 15+ points on a curve.
- kit.Extrude([][2]float64{{x, y}, ...}, z0, z1)
                                      a closed floor-plan outline pushed up from z0 to z1: slabs, L-shaped or star-shaped buildings, leaves lying flat
- kit.ExtrudeY([][2]float64{{x, z}, ...}, y0, y1)
                                      a closed front-view outline (as seen from the -Y side, where the default camera stands) pushed through depth y0..y1: arches, gable walls, letters, gears, wheels standing upright, side profiles of cars, boats, guitars, animals
- kit.Surface(a, b, n, func(x, y float64) float64 { ... })
                                      height field z = f(x, y) over the x,y rectangle a..b, solid underneath, drawn as an n-by-n grid. Terrain, water, dunes. Cannot be carved.

Combining
- kit.Difference(a, b, ...)           carves b and the rest out of a
- kit.Intersection(a, b, ...)         keeps the overlap
- kit.Group(shapes...)                several shapes acting as one, to rotate, move or shade together
- kit.Rotate(shape, axis, degrees)    rotate about the shape's own centre (right-hand rule: positive is counter-clockwise looking down the axis)
- kit.Translate(shape, v)             move
- kit.Transform(shape, m)             a rotation about the origin and/or a move, e.g. kit.Rotation(axis, degrees).Translate(v) (applied left to right). Use this to spin a part around a hub or pivot: build it at the origin, then rotate and translate. Do not scale with a matrix; use Ellipsoid or build at the right size.
- kit.Rotation(axis, degrees)         right-handed rotation matrix. Never call ln.Rotate: it turns the opposite way.

Lines and shading
- kit.Shade(shape)                    adds pen hatching where the shape faces away from the light or lies in another shape's shadow. This is what makes a drawing look solid: wrap most of the main solids in it. A shape only receives shadows if it is shaded.
- kit.Light(kit.V(x, y, z))           direction from the scene toward the light (default: upper left, from the camera side). Call once, before kit.Run.
- kit.Hatched(shape, extra)           the shape's own lines plus extra ln.Paths lying on its surface: windows, doors, bricks, planks, seams, stripes
- kit.Textured(shape, paths)          the shape's solid body, drawn with only your ln.Paths
- kit.Lines(paths...)                 free 3D polylines (ln.Path) with no body: whiskers, rigging, rain, grass, feathers, fur, cracks. Hidden by solids, hide nothing. Place them 0.01 in front of a surface, not exactly on it.
- kit.Background(shape)               leave a shape out of the automatic framing (large ground, backdrop)

The drawing is made in three weights: solid outlines are heavy, surface detail (Hatched extras, Lines, grids, columns, floors) is medium, Shade hatching is light.

From package ln you may use: ln.Vector (fields X, Y, Z; methods Add, Sub, MulScalar, Normalize, Cross, Dot, Length), ln.Path (a []ln.Vector), ln.Paths (a []ln.Path), ln.Matrix with ln.Translate, ln.Radians, ln.LatLngToXYZ(lat, lng, radius). Build solids only with package kit: do not call ln shape constructors, define your own shape types, load or save files, or print anything.

Techniques:
- Model the real form. One Lathe, Tube or Extrude with a well-chosen profile beats ten stacked boxes.
- Organic subjects: overlapping Ellipsoids for the masses, TaperedTubes for limbs, necks and tails, Cones for ears and beaks, Lines for fur and whiskers.
- Repetition with variation: loops with rng for forests, crowds, city blocks, stones, bricks.
- Do not hand-draw shading strokes; use kit.Shade.
- A polyline needs enough points to look smooth: 40 or more for a curve.

Rules:
- Two solids must not share exactly the same surface (it hides both sets of lines); offset by 0.01.
- Keep it under about 1500 shapes and 4000 extra lines so it renders in a few seconds.
- A Tube or Lathe is one shape however many points it has; do not build curves from separate cylinders.
${ADVICE}
- Output raw Go source only: no markdown fence, no explanation.

Two complete example programs follow. They show the style and level of care expected; do not copy their subjects.

${EXAMPLES}`;

function run(cmd, args, { input = "", cwd, env, timeoutMs = 60_000, maxBytes = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
    let stdout = "";
    let stderr = "";
    let killedFor = null;
    const kill = (why) => { killedFor ??= why; child.kill("SIGKILL"); };
    const timer = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > maxBytes) kill("produced too much output"); });
    child.stderr.on("data", (d) => { if (stderr.length < 20_000) stderr += d; });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killedFor) reject(new Error(killedFor));
      else if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().slice(0, 3000) || `${cmd} exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function chat(model, messages) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "draws.ink",
    },
    body: JSON.stringify({ model, messages, max_tokens: 32000, reasoning: { effort: "medium" } }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? res.statusText}`);
  const choice = body?.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text) throw new Error("OpenRouter returned an empty reply");
  if (choice.finish_reason === "length") throw new Error("the model's reply was cut off before the scene was complete");
  return text;
}

async function renderJson(reply) {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("reply contained no JSON object");
  const scene = JSON.parse(reply.slice(start, end + 1));
  const svg = await run(RENDER_BIN, [], { input: JSON.stringify(scene) });
  return { svg, source: JSON.stringify(scene, null, 1) };
}

function extractGo(reply) {
  const fenced = reply.match(/```(?:go)?\s*\n([\s\S]*?)```/);
  const code = (fenced ? fenced[1] : reply).trim();
  if (!/^package main\b/m.test(code)) throw new Error("reply was not a Go program starting with `package main`");
  if (/^\s*\/\/go:/m.test(code)) throw new Error("//go: directives are not allowed");
  const imports = [];
  for (const block of code.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/"([^"]+)"/g)) imports.push(m[1]);
  }
  for (const m of code.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) imports.push(m[1]);
  const bad = imports.filter((i) => !ALLOWED_IMPORTS.includes(i));
  if (bad.length) throw new Error(`import not allowed: ${bad.join(", ")}. Allowed: ${ALLOWED_IMPORTS.join(", ")}`);
  return code + "\n";
}

// Compile the model's program inside the render module (so it can import
// kit), then run the binary under the macOS sandbox: no network, no file
// writes, no reads under /Users, no child processes, 60s limit.
async function renderCode(reply) {
  const code = extractGo(reply);
  const id = `s${randomUUID().replaceAll("-", "")}`;
  const srcDir = join(RENDER_DIR, "gen", id);
  const binDir = await realpath(await mkdtemp(join(tmpdir(), "sketch-bin-")));
  const bin = join(binDir, "scene");
  try {
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "main.go"), code);
    try {
      await run("go", ["build", "-o", bin, `./gen/${id}`], {
        cwd: RENDER_DIR,
        env: { ...process.env, CGO_ENABLED: "0", GOFLAGS: "-mod=readonly", GOPROXY: "off" },
      });
    } catch (err) {
      throw new Error(`compile error:\n${err.message.replaceAll(`gen/${id}/`, "")}`);
    }
    const svg = await run("/usr/bin/sandbox-exec", ["-D", `BIN=${bin}`, "-f", SANDBOX_PROFILE, bin], {
      env: {},
      timeoutMs: 60_000,
    });
    if (!svg.trimStart().startsWith("<svg")) throw new Error("the program did not produce a drawing; call kit.Run once and print nothing else");
    return { svg, source: code };
  } finally {
    await rm(srcDir, { recursive: true, force: true });
    await rm(binDir, { recursive: true, force: true });
  }
}

// linemerge joins ln's chopped segments and linesimplify drops redundant
// points. linesort additionally reorders strokes the way a pen plotter would
// travel; without it the strokes stay in ln's shape-by-shape order.
async function orderStrokes(svg, sort, weights = PEN.scene, page = ASPECTS.square.page) {
  const dir = await mkdtemp(join(tmpdir(), "sketch-"));
  try {
    const input = join(dir, "in.svg");
    const output = join(dir, "out.svg");
    await writeFile(input, svg);
    await run(VPYPE_BIN, [
      "read", input,
      "linemerge", "--tolerance", "0.5",
      ...(sort ? ["linesort"] : []),
      "linesimplify", "--tolerance", "0.15",
      "write", "--page-size", page.join("x"), output,
    ]);
    // vpype records its command line, temp paths included, in the metadata.
    const tidy = (await readFile(output, "utf8")).replace(/<metadata>[\s\S]*?<\/metadata>\s*/, "");
    return weigh(tidy, weights);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Both pipelines write three layers: 1 outlines, 2 detail, 3 shading. vpype
// keeps them as groups; give each its pen weight. Traced drawings keep closer
// to one weight, like the fineliner they were drawn with.
const PEN = {
  scene: { layer1: "1.7", layer2: "1.0", layer3: "0.65" },
  draw: { layer1: "1.9", layer2: "1.4", layer3: "1.1" },
};
function weigh(svg, weights) {
  return svg.replace(/<g ([^>]*\bid="(layer\d)"[^>]*)>/g, (tag, attrs, id) =>
    `<g ${attrs.replace(/stroke-width="[^"]*"/, `stroke-width="${weights[id] ?? "1.0"}"`)} stroke-linecap="round" stroke-linejoin="round">`);
}

async function rasterize(svg) {
  const dir = await mkdtemp(join(tmpdir(), "sketch-png-"));
  try {
    const input = join(dir, "in.svg");
    const output = join(dir, "out.png");
    await writeFile(input, svg);
    await run("rsvg-convert", ["-b", "white", "-w", "768", input, "-o", output]);
    return (await readFile(output)).toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REVIEW = `This image is the drawing your program produced. Look at it critically, as the person who asked for it would:
- Is the subject recognisable at a glance, with sensible proportions?
- Are parts connected that should be (nothing floating, nothing detached)?
- Is anything see-through, with lines showing that a solid should hide?
- Are there stray or broken lines, or areas so dense they read as a black patch?
- Is anything important missing, facing the wrong way, or hidden behind something else?

If the drawing is already good, reply with exactly OK. Otherwise reply with the complete corrected program only.`;

// What the image model is asked for. The style rules are there for the
// tracer as much as for looks: separate strokes trace cleanly, solid black
// and dense cross-hatching do not.
const DRAW_PROMPT = (subject, aspect = ASPECTS.square) => `Draw this as a pen-and-ink illustration: ${subject}

The style matters as much as the subject:
- Black fineliner on white paper. Lines only: no colour, no grey tones, no pencil, no ink wash.
- Clean, confident contour lines for every form, the main outlines a little heavier than the inner detail.
- Shade with hatching: groups of clearly separated parallel strokes that follow the form, enough to give the forms volume and to suggest texture such as fur, wood, stone or water. White paper shows between the strokes everywhere. No cross-hatching, no stippling, no solid black areas.
- No frame, border, panel, caption, text or signature. Draw what the request names plus at most a little ground under it, and let the drawing fade into blank paper at its edges.
- The subject fills most of ${aspect.words}, with a small margin all round.
- A flat, clean scan that fills the whole image: not a photograph of a sheet of paper, no desk, no pen, no hands, no cast shadows.`;

async function paint(model, prompt, aspect, timeoutMs) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "X-Title": "draws.ink",
    },
    body: JSON.stringify({
      model,
      modalities: speaks(model) ? ["image", "text"] : ["image"],
      image_config: { aspect_ratio: aspect.ratio },
      messages: [{ role: "user", content: DRAW_PROMPT(prompt, aspect) }],
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // A content filter answers 400 (the provider's) or 403 (OpenRouter's) and
    // says so in the metadata. The same words would be refused again.
    const meta = body?.error?.metadata;
    const blocked = [400, 403].includes(res.status)
      && /content|safety|moderat|policy|block/i.test([meta?.provider_error_code, meta?.raw, ...(meta?.reasons ?? [])].join(" "));
    throw Object.assign(new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? res.statusText}${blocked ? " (content refused)" : ""}`), { upstream: res.status, blocked });
  }
  const message = body?.choices?.[0]?.message;
  const url = message?.images?.[0]?.image_url?.url;
  const data = url?.match(/^data:image\/[\w.+-]+;base64,(.+)$/s);
  if (!data) throw new Error(`the image model returned no picture${message?.content ? `: ${String(message.content).slice(0, 300)}` : ""}`);
  return { url, bytes: Buffer.from(data[1], "base64"), cost: body.usage?.cost };
}

// trace.py finds the centre of every ink line and writes them as strokes in
// drawing order, in the same three layers the 3D renderer uses.
async function trace(bytes, page) {
  const dir = await mkdtemp(join(tmpdir(), "sketch-trace-"));
  try {
    const input = join(dir, "picture");
    const output = join(dir, "out.svg");
    await writeFile(input, bytes);
    const stats = JSON.parse(await run(PYTHON_BIN, [TRACE_SCRIPT, input, output, page.join("x")], { timeoutMs: 90_000 }));
    return { svg: await readFile(output, "utf8"), stats };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Providers refuse some requests, most often one that names a real person.
// A small model rewords such a request once, so there is still something to
// draw, and the visitor is told what was drawn instead.
const REWORD_PROMPT = `An image generator refused to draw a request, most likely because it names a real person, or a brand or character it will not depict.

Reword the request so that it can be drawn:
- Replace a real, named person with a plain generic figure, such as "a man", "a woman" or "a singer". Do not describe that person's looks, clothes or anything else that would make the figure recognisable as them.
- Replace a brand, a logo or a trademarked character with a generic equivalent.
- Keep everything else the request asks for.

Reply with the reworded request only: one short phrase, no quotes, no explanation. If the request is sexual, hateful or graphically violent, or nothing acceptable is left to draw, reply with exactly NO.`;

async function reword(prompt) {
  const refuse = (why) => Object.assign(new Error(`the request was refused and could not be reworded: ${why}`), { code: "blocked" });
  let body;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json", "X-Title": "draws.ink" },
      body: JSON.stringify({ model: REWORD_MODEL, max_tokens: 80, messages: [{ role: "system", content: REWORD_PROMPT }, { role: "user", content: prompt }] }),
    });
    body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body?.error?.message ?? res.statusText}`);
  } catch (err) {
    throw refuse(err.message);
  }
  const text = String(body?.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’.]+$/g, "");
  if (!text || /^no$/i.test(text) || text.length > MAX_PROMPT) throw refuse(text ? "the model declined" : "empty reply");
  if (text.toLowerCase() === prompt.toLowerCase()) throw refuse("the rewording changed nothing");
  return { text, cost: body.usage?.cost ?? 0 };
}

// `full` also works out the plotter stroke order and keeps the details the
// lab page shows; the public site needs neither.
async function draw(prompt, model, progress, full, aspect = ASPECTS.square) {
  let subject = prompt;   // what the image model is asked for: the prompt, or its rewording
  let extra = 0;          // what the rewording cost
  let lastError;
  for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    try {
      if (attempts === 1) progress("Drawing the picture…", "picture");
      else if (!lastError.blocked) progress(`Drawing the picture again (attempt ${attempts})…`, "again");
      const picture = await paint(model, subject, aspect, full ? 240_000 : 60_000);
      progress("Tracing the pen strokes…", "trace");
      const traced = await trace(picture.bytes, aspect.page);
      if (traced.stats.strokes < 40) throw new Error("the picture had too little line work to trace");
      if (traced.stats.strokes > MAX_STROKES) throw new Error("the picture was too dense to trace as line art");
      progress("Ordering the strokes…", "order");
      const [shape, plotter] = await Promise.all([
        orderStrokes(traced.svg, false, PEN.draw, aspect.page),
        full ? orderStrokes(traced.svg, true, PEN.draw, aspect.page) : null,
      ]);
      return {
        svg: { shape, plotter }, source: DRAW_PROMPT(subject, aspect), picture: full ? picture.url : undefined,
        drew: subject === prompt ? undefined : subject,
        mode: "draw", model, attempts, revised: false, traced: traced.stats, cost: (picture.cost ?? 0) + extra,
      };
    } catch (err) {
      lastError = err;
      console.error(`attempt ${attempts} failed: ${err.message}`);
      if (err.blocked) {
        // Refused twice: the rewording was not acceptable either.
        if (subject !== prompt) throw Object.assign(err, { code: "blocked" });
        progress("Finding another way to draw it…", "reword");
        const reworded = await reword(prompt);
        subject = reworded.text;
        extra = reworded.cost;
        continue;
      }
      // A rejected key, an empty balance or a provider limit will not get
      // better by asking again, and is not the visitor's doing.
      if ([401, 402, 403, 429].includes(err.upstream)) throw Object.assign(err, { code: "unavailable" });
    }
  }
  throw new Error(`could not produce a drawing after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

async function sketch(prompt, mode, model, revise, progress, full = true, aspect = ASPECTS.square) {
  if (mode === "draw") return draw(prompt, model, progress, full, aspect);
  const render = mode === "code" ? renderCode : renderJson;
  const kind = mode === "code" ? "Go program" : "JSON object";
  const messages = [
    { role: "system", content: mode === "code" ? CODE_PROMPT : JSON_PROMPT },
    { role: "user", content: prompt },
  ];
  const finish = async (drawing, extra) => {
    progress("Ordering the strokes…");
    const [plotter, shape] = await Promise.all([orderStrokes(drawing.svg, true), orderStrokes(drawing.svg, false)]);
    return { svg: { plotter, shape }, source: drawing.source, mode, model, ...extra };
  };

  let first;
  let attempts = 0;
  let lastError;
  while (!first && attempts < MAX_ATTEMPTS) {
    attempts++;
    progress(attempts === 1 ? "Designing the scene…" : `Fixing the scene (attempt ${attempts})…`);
    const reply = await chat(model, messages);
    messages.push({ role: "assistant", content: reply });
    try {
      progress("Rendering…");
      first = await render(reply);
    } catch (err) {
      lastError = err;
      console.error(`attempt ${attempts} failed: ${err.message}`);
      messages.push({ role: "user", content: `That scene failed: ${err.message}\nReply with the corrected ${kind} only.` });
    }
  }
  if (!first) throw new Error(`could not produce a renderable scene after ${MAX_ATTEMPTS} attempts: ${lastError.message}`);
  if (!revise) return finish(first, { attempts, revised: false });

  // Show the model its own drawing and let it correct what it sees.
  try {
    progress("Reviewing the drawing…");
    const png = await rasterize(first.svg);
    messages.push({
      role: "user",
      content: [
        { type: "text", text: REVIEW },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    });
    const reply = await chat(model, messages);
    if (/^\s*OK\b/.test(reply) && reply.trim().length < 40) return finish(first, { attempts, revised: false });
    progress("Rendering the revision…");
    const second = await render(reply);
    const draft = await orderStrokes(first.svg, false);
    return finish(second, { attempts, revised: true, draft });
  } catch (err) {
    console.error(`revision failed, keeping the first drawing: ${err.message}`);
    return finish(first, { attempts, revised: false, revisionError: err.message });
  }
}

// ------------------------------------------------------------------ HTTP

// The lab page keeps its script and styles inline.
const LAB_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'";

// Development only: the lab page and the landing page designs under review.
const LAB_PAGES = {
  "/lab": ["lab.html", "text/html; charset=utf-8"],
  "/designs": ["designs/index.html", "text/html; charset=utf-8"],
  "/designs/index.css": ["designs/index.css", "text/css; charset=utf-8"],
  ...Object.fromEntries([1, 2, 3, 4, 5].flatMap((n) => [
    [`/designs/${n}`, [`designs/${n}.html`, "text/html; charset=utf-8"]],
    [`/designs/${n}.css`, [`designs/${n}.css`, "text/css; charset=utf-8"]],
  ])),
};
const PAGES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/export.js": ["export.js", "text/javascript; charset=utf-8"],
  "/vendor/gifenc.mjs": ["vendor/gifenc.mjs", "text/javascript; charset=utf-8"],
  "/vendor/mp4-muxer.mjs": ["vendor/mp4-muxer.mjs", "text/javascript; charset=utf-8"],
  "/sample.svg": ["sample.svg", "image/svg+xml"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/favicon.ico": ["favicon.ico", "image/x-icon"],
  "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
  "/logo.svg": ["logo.svg", "image/svg+xml"],
  "/og.png": ["og.png", "image/png"],
  "/og-square.png": ["og-square.png", "image/png"],
  ...(LAB ? LAB_PAGES : {}),
};
const files = new Map();   // name -> { mtimeMs, body, gzipped, etag }

async function sendFile(req, res, [name, type]) {
  const path = join(ROOT, "public", name);
  const { mtimeMs } = await stat(path);
  let file = files.get(name);
  if (!file || file.mtimeMs !== mtimeMs) {
    const body = await readFile(path);
    file = { mtimeMs, body, gzipped: gzipSync(body), etag: `"${createHash("sha1").update(body).digest("base64url")}"` };
    files.set(name, file);
  }
  const headers = { "Content-Type": type, ETag: file.etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" };
  if (name === "lab.html") headers["Content-Security-Policy"] = LAB_CSP;
  if (req.headers["if-none-match"] === file.etag) return res.writeHead(304, headers).end();
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  if (gzip) headers["Content-Encoding"] = "gzip";
  res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : gzip ? file.gzipped : file.body);
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(body));
}

function refuse(res, status, code, retryAfter) {
  sendJson(res, status, refusal(code, retryAfter), retryAfter ? { "Retry-After": String(retryAfter) } : {});
}

// The limits of shared.mjs, counted in memory: they reset on restart and
// assume one server process.
const visitors = new Map();   // address -> times of that visitor's drawings in the last day
let everyone = [];            // times of all drawings in the last day
let inProgress = 0;

function admit(address, now = Date.now()) {
  if (GATED) return inProgress >= LIMITS.concurrent ? { status: 503, code: "busy", retryAfter: 10 } : null;
  const lastDay = (times) => times.filter((t) => now - t < DAY_MS);
  everyone = lastDay(everyone);
  const mine = lastDay(visitors.get(address) ?? []);
  const refused = decide({ mine, everyone: { count: everyone.length, oldest: everyone[0] }, inProgress, limits: LIMITS, now });
  if (refused) return refused;
  visitors.set(address, [...mine, now]);
  everyone.push(now);
  return null;
}
setInterval(() => {
  const now = Date.now();
  for (const [address, times] of visitors) if (times.every((t) => now - t >= DAY_MS)) visitors.delete(address);
}, WINDOW_MS).unref();

// Behind one proxy, the last X-Forwarded-For entry is the address the proxy
// saw; earlier entries are whatever the visitor sent and cannot be trusted.
function addressOf(req) {
  const forwarded = TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",").pop().trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

async function handleSketch(req, res) {
  if (!READY) return refuse(res, 503, "unavailable");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4000) return refuse(res, 413, "bad_prompt");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(res, 400, "bad_prompt");
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt.replace(/\s+/g, " ").trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT) return refuse(res, 400, "bad_prompt");
  const aspect = typeof body.aspect === "string" && Object.hasOwn(ASPECTS, body.aspect) ? body.aspect : "square";
  if (!LAB) {
    const refused = admit(addressOf(req));
    if (refused) return refuse(res, refused.status, refused.code, refused.retryAfter);
  }

  // Visitors get the default pipeline. Only the lab page and the test
  // harness, which say so, may choose and get the full details back.
  const lab = LAB && body.lab === true;
  const mode = lab && ["code", "json"].includes(body.mode) ? body.mode : "draw";
  const model = mode === "draw"
    ? (lab && IMAGE_MODELS.includes(body.model) ? body.model : DEFAULT_IMAGE_MODEL)
    : (MODELS.includes(body.model) ? body.model : DEFAULT_MODEL);

  // Newline-delimited JSON: progress lines while working, then {result} or {error}.
  // Behind the Worker the stream is left plain: compressed here, its progress
  // lines are held back on the way out and all arrive with the result.
  const gzip = !GATED && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    ...(gzip ? { "Content-Encoding": "gzip" } : {}),
  });
  const out = gzip ? createGzip() : res;
  if (gzip) out.pipe(res);
  const emit = (event) => {
    out.write(JSON.stringify(event) + "\n");
    if (gzip) out.flush();
  };
  const started = Date.now();
  const record = (fields) => console.log(JSON.stringify({ at: new Date().toISOString(), event: "sketch", ms: Date.now() - started, prompt, aspect, ...fields }));
  inProgress++;
  try {
    const result = await sketch(prompt, mode, model, body.revise !== false, (stage, step) => emit(lab ? { stage, step } : { step }), lab, ASPECTS[aspect]);
    emit({ result: lab ? { ...result, ms: Date.now() - started } : { svg: result.svg.shape, drew: result.drew } });
    record({ ok: true, attempts: result.attempts, strokes: result.traced?.strokes, cost: result.cost, drew: result.drew });
  } catch (err) {
    console.error(err);
    const code = ["unavailable", "blocked"].includes(err.code) ? err.code : "failed";
    emit({ error: { code, message: lab ? err.message : MESSAGES[code]() } });
    record({ ok: false, error: err.message });
  } finally {
    inProgress--;
    out.end();
  }
}

const READY = Boolean(API_KEY) && existsSync(PYTHON_BIN) && existsSync(VPYPE_BIN);

const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET" || req.method === "HEAD") {
      if (PAGES[path]) return await sendFile(req, res, PAGES[path]);
      if (path === "/healthz") return sendJson(res, READY ? 200 : 503, { ok: READY });
      if (LAB && path === "/api/models") {
        return sendJson(res, 200, {
          draw: { models: IMAGE_MODELS, default: DEFAULT_IMAGE_MODEL },
          scene: { models: MODELS, default: DEFAULT_MODEL },
        });
      }
      return res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found\n");
    }
    if (req.method === "POST" && path === "/api/sketch") return await handleSketch(req, res);
    res.writeHead(405, { Allow: "GET, HEAD, POST", "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed\n");
  } catch (err) {
    console.error(err);
    if (res.headersSent) res.end();
    else refuse(res, 500, "unavailable");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`draws.ink: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (draws with ${DEFAULT_IMAGE_MODEL})`);
  if (!API_KEY) console.error("No OpenRouter key: set OPENROUTER_API_KEY. Drawing is switched off.");
  if (!existsSync(PYTHON_BIN) || !existsSync(VPYPE_BIN)) console.error("Missing .venv with vpype and the tracer's libraries: run `pnpm setup`. Drawing is switched off.");
  if (LAB) console.log(`lab mode: /lab and /designs are served, limits are off; do not expose publicly`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();   // do not wait forever for drawings in progress
  });
}
