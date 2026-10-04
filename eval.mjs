// Renders a set of prompts with one or more models and builds a contact
// sheet, so changes can be judged side by side. Needs the server running in
// lab mode (SKETCH_LAB=1, which `pnpm dev` sets).
//   node eval.mjs [--limit 6] [--models a,b,c] [--mode draw|code|json] [--revise off] [--name label]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BASE = `http://localhost:${process.env.PORT ?? 5177}`;
const all = (await readFile(arg("prompts", "prompts.txt"), "utf8")).split("\n").map((s) => s.trim()).filter(Boolean);
const prompts = all.slice(0, Number(arg("limit", all.length)));
const mode = arg("mode", "draw");
const catalogue = await fetch(`${BASE}/api/models`);
if (!catalogue.ok) {
  console.error("The server is not in lab mode. Start it with `pnpm dev` (SKETCH_LAB=1).");
  process.exit(1);
}
const { models: known, default: def } = (await catalogue.json())[mode === "draw" ? "draw" : "scene"];
const models = arg("models", def).split(",").map((m) => known.find((k) => k.includes(m)) ?? m);
const revise = arg("revise", "on") !== "off";
const dir = join("out", "eval", arg("name", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")));
await mkdir(dir, { recursive: true });

const jobs = [];
models.forEach((model, mi) => prompts.forEach((prompt, pi) => jobs.push({ model, mi, prompt, pi })));
const results = [];
const worker = async () => {
  for (let job; (job = jobs.shift()); ) {
    const png = join(dir, `m${job.mi}-p${String(job.pi).padStart(2, "0")}.png`);
    const row = { model: job.model, prompt: job.prompt, png };
    try {
      const res = await fetch(`${BASE}/api/sketch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lab: true, prompt: job.prompt, mode, model: job.model, revise }),
      });
      if (!res.ok) throw new Error((await res.json()).error.message);
      const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const failed = events.find((e) => e.error);
      if (failed) throw new Error(failed.error.message);
      const data = events.find((e) => e.result)?.result;
      if (!data) throw new Error("no result");
      if (data.draft) {
        await writeFile(png.replace(".png", ".draft.svg"), data.draft);
        execFileSync("rsvg-convert", ["-b", "white", "-w", "420", png.replace(".png", ".draft.svg"), "-o", png.replace(".png", ".draft.png")]);
      }
      const svg = png.replace(".png", ".svg");
      await writeFile(svg, data.svg.shape);
      await writeFile(png.replace(".png", { draw: ".txt", code: ".go", json: ".json" }[mode]), data.source);
      if (data.picture) await writeFile(png.replace(".png", ".picture.png"), Buffer.from(data.picture.split(",")[1], "base64"));
      execFileSync("rsvg-convert", ["-b", "white", "-w", "420", svg, "-o", png]);
      Object.assign(row, { ok: true, ms: data.ms, attempts: data.attempts, revised: data.revised, cost: data.cost, traced: data.traced, strokes: (data.svg.shape.match(/<(line|polyline|polygon) /g) ?? []).length });
    } catch (err) {
      execFileSync("magick", ["-size", "420x420", "xc:#f3d9d6", png]);
      Object.assign(row, { ok: false, error: String(err.message).slice(0, 300) });
    }
    results.push(row);
    console.log(`${row.ok ? "ok  " : "FAIL"} ${job.model.split("/")[1]} · ${job.prompt}${row.ok ? ` · ${(row.ms / 1000).toFixed(0)}s · ${row.attempts} attempt(s)${row.revised ? " · revised" : ""}` : ` · ${row.error}`}`);
  }
};
await Promise.all(Array.from({ length: Number(arg("concurrency", 6)) }, worker));
await writeFile(join(dir, "results.json"), JSON.stringify(results, null, 1));

// Contact sheet: one row per prompt, one column per model.
const tiles = [];
prompts.forEach((prompt, pi) => models.forEach((model, mi) => {
  tiles.push("(", join(dir, `m${mi}-p${String(pi).padStart(2, "0")}.png`), "-set", "label", `${model.split("/")[1]}\n${prompt}`, ")");
}));
const sheet = join(dir, "sheet.png");
execFileSync("magick", ["montage", ...tiles, "-tile", `${models.length}x`, "-geometry", "420x420+6+6", "-font", "/System/Library/Fonts/Supplemental/Arial.ttf", "-pointsize", "13", sheet]);

for (const model of models) {
  const rows = results.filter((r) => r.model === model);
  const ok = rows.filter((r) => r.ok);
  const avg = (f) => (ok.reduce((a, r) => a + f(r), 0) / (ok.length || 1));
  console.log(`${model}: ${ok.length}/${rows.length} rendered, first-try ${ok.filter((r) => r.attempts === 1).length}, avg ${(avg((r) => r.ms) / 1000).toFixed(0)}s, avg ${avg((r) => r.strokes).toFixed(0)} strokes${ok.some((r) => r.cost) ? `, avg $${avg((r) => r.cost ?? 0).toFixed(3)}` : ""}`);
}
console.log(`sheet: ${sheet}`);
