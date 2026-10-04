// Ask the server for a drawing, then play it back stroke by stroke.
const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const paper = $("paper");

// Seconds of pen time per unit of line, relative to outlines.
const PACE = { layer1: 1, layer2: 0.8, layer3: 0.45 };
const STEPS = {
  picture: "Sketching your idea…",
  again: "Trying a fresh sheet…",
  reword: "Finding another way to draw it…",
  trace: "Inking the lines…",
  order: "Picking up the pen…",
};
const GENERIC = "Something went wrong. Please try again.";
const EXAMPLE = "a lighthouse on a rocky island";
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

let current = null; // { svgText, prompt, width, height, strokes, pen, ink, total, seconds, note }
let frame = 0;
let wobble = true; // switched off on devices that cannot keep up with it

// The sheet takes the shape of what is on it: square, tall or wide.
const shapeSheet = (aspect) => { paper.parentNode.dataset.aspect = aspect; };

function mount(svgText, prompt) {
  // vpype writes style attributes on its layers, which the page's content
  // security policy would refuse (and report); they are not needed here.
  const src = new DOMParser().parseFromString(svgText.replace(/\sstyle="[^"]*"/g, ""), "image/svg+xml").documentElement;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "drawing");
  const viewBox = src.getAttribute("viewBox") ?? "0 0 1024 1024";
  svg.setAttribute("viewBox", viewBox);
  const [width, height] = viewBox.split(/[\s,]+/).slice(2).map(Number);
  shapeSheet(width > height * 1.2 ? "wide" : height > width * 1.2 ? "tall" : "square");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Pen drawing of ${prompt}`);
  // A slight wobble so the lines look drawn by a pen, not a printer.
  svg.innerHTML = `<defs><filter id="ink" x="-2%" y="-2%" width="104%" height="104%">
    <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="4"/>
    <feDisplacementMap in="SourceGraphic" scale="2.4" xChannelSelector="R" yChannelSelector="G"/>
  </filter></defs>`;
  const ink = document.createElementNS(NS, "g");
  if (wobble) ink.setAttribute("filter", "url(#ink)");
  ink.setAttribute("fill", "none");
  ink.setAttribute("stroke", "#1f1d1a");
  ink.setAttribute("stroke-linecap", "round");
  ink.setAttribute("stroke-linejoin", "round");
  svg.appendChild(ink);

  // Layers arrive in drawing order: outlines, then detail, then shading.
  const strokes = [];
  const layers = [...src.querySelectorAll("g[id^=layer]")];
  for (const layer of layers.length ? layers : [src]) {
    const group = document.createElementNS(NS, "g");
    group.setAttribute("stroke-width", layer.getAttribute("stroke-width") ?? "1.2");
    ink.appendChild(group);
    for (const el of layer.querySelectorAll("line, polyline, polygon, path")) {
      const copy = group.appendChild(document.importNode(el, false));
      strokes.push({ el: copy, pace: PACE[layer.id] ?? 1 });
    }
  }
  const pen = document.createElementNS(NS, "circle");
  pen.setAttribute("r", "5");
  pen.setAttribute("fill", "#d2452f");
  svg.appendChild(pen);
  paper.replaceChildren(svg);

  // Timeline in arbitrary units: travel to each stroke with the pen up, then
  // draw it. A seeded jitter keeps replays identical.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let clock = 0;
  let at = null;
  for (const s of strokes) {
    s.length = s.el.getTotalLength();
    s.from = s.el.getPointAtLength(0);
    s.to = s.el.getPointAtLength(s.length);
    s.el.style.strokeDasharray = `${s.length} ${s.length}`;
    s.el.style.strokeDashoffset = s.length;
    const hop = at ? Math.hypot(s.from.x - at.x, s.from.y - at.y) : 0;
    s.travelFrom = at ?? s.from;
    s.travelStart = clock;
    clock += Math.min(hop / 5, 60) + (hop > 4 ? 12 : 0); // pen-up moves are quick, with a small lift pause
    s.start = clock;
    clock += (s.length + 14) * s.pace * (0.85 + 0.35 * random());
    s.end = clock;
    at = s.to;
  }
  // Longer drawings get more time, within reason.
  const seconds = Math.min(28, Math.max(12, strokes.length / 70));
  return { svgText, prompt, width, height, strokes, pen, ink, total: clock, seconds };
}

// Slow at both ends of a stroke, faster through the middle.
const ease = (u) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI) * 0.55;

function finish() {
  cancelAnimationFrame(frame);
  for (const s of current.strokes) s.el.style.strokeDashoffset = 0;
  current.pen.style.display = "none";
}

function play() {
  cancelAnimationFrame(frame);
  const { strokes, pen, ink, total, seconds } = current;
  for (const s of strokes) s.el.style.strokeDashoffset = s.length;
  pen.style.display = "";
  const rate = total / (seconds * 1000); // timeline units per ms
  let index = 0;
  let clock = 0;
  let last = performance.now();
  let frames = 0;
  let slow = 0;
  const tick = (now) => {
    const dt = now - last;
    last = now;
    clock += Math.min(dt, 100) * rate;
    // The ink wobble is costly; drop it if the first frames come in slowly.
    if (wobble && ++frames > 5 && frames <= 45) {
      if (dt > 34) slow++;
      if (frames === 45 && slow > 20) {
        wobble = false;
        ink.removeAttribute("filter");
      }
    }
    while (index < strokes.length && clock >= strokes[index].end) {
      strokes[index].el.style.strokeDashoffset = 0;
      index++;
    }
    if (index >= strokes.length) {
      pen.style.display = "none";
      return;
    }
    const s = strokes[index];
    let p;
    if (clock < s.start) {
      const u = Math.min(((clock - s.travelStart) / Math.max(s.start - s.travelStart, 1e-6)) * 1.3, 1);
      p = { x: s.travelFrom.x + (s.from.x - s.travelFrom.x) * u, y: s.travelFrom.y + (s.from.y - s.travelFrom.y) * u };
      pen.setAttribute("fill-opacity", "0.35");
    } else {
      const done = s.length * ease((clock - s.start) / (s.end - s.start));
      s.el.style.strokeDashoffset = s.length - done;
      p = s.el.getPointAtLength(done);
      pen.setAttribute("fill-opacity", "1");
    }
    pen.setAttribute("cx", p.x);
    pen.setAttribute("cy", p.y);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

function show(svgText, prompt, example = false) {
  current = mount(svgText, prompt);
  $("actions").hidden = example;
  if (calm) finish();
  else play();
}

function showWorking(aspect) {
  cancelAnimationFrame(frame);
  current = null;
  shapeSheet(aspect);
  closeMenu();
  $("note").hidden = true;
  $("actions").hidden = true;
  const box = document.createElement("div");
  box.className = "working";
  box.innerHTML = `<svg class="scribble" viewBox="0 0 104 30" aria-hidden="true"><path d="M5 22C15 2 24 28 35 11s19 14 30-2 22 13 34-4"/></svg>
    <p class="stage"></p><p class="hint">This takes about 15 seconds.</p>`;
  paper.replaceChildren(box);
  setStage(STEPS.picture);
}

function setStage(text) {
  const stage = paper.querySelector(".stage");
  if (stage) stage.textContent = text;
  $("status").textContent = text;
}

// The line under the sheet: what was drawn in place of a refused request, or
// why a download failed.
function setNote(text) {
  $("note").textContent = text;
  $("note").hidden = !text;
}

function showNotice(message) {
  cancelAnimationFrame(frame);
  current = null;
  closeMenu();
  $("note").hidden = true;
  $("actions").hidden = true;
  const box = document.createElement("div");
  box.className = "notice";
  box.appendChild(document.createElement("p")).textContent = message;
  paper.replaceChildren(box);
  $("status").textContent = message;
}

// Errors whose message is written for the visitor.
class Told extends Error {}

async function request(prompt, aspect) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150_000);
  try {
    const res = await fetch("/api/sketch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, aspect }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Told((await res.json().catch(() => null))?.error?.message ?? GENERIC);
    // One JSON object per line: progress, then the result.
    let result = null;
    let buffer = "";
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.error) throw new Told(event.error.message ?? GENERIC);
        if (event.step) setStage(STEPS[event.step] ?? STEPS.picture);
        if (event.result) result = event.result;
      }
    }
    if (!result?.svg) throw new Told(GENERIC);
    return result;
  } catch (err) {
    if (err instanceof Told) throw err;
    if (err.name === "AbortError") throw new Told("That took too long. Please try again.");
    if (err instanceof TypeError) throw new Told("We couldn't reach the server. Check your connection and try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function setBusy(busy) {
  $("go").disabled = $("prompt").readOnly = busy;
  for (const choice of document.getElementsByName("aspect")) choice.disabled = busy;
  $("go").textContent = busy ? "Drawing…" : "Draw";
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("go").disabled) return;
  const prompt = ($("prompt").value.replace(/\s+/g, " ").trim() || $("prompt").placeholder).slice(0, 200);
  $("prompt").value = prompt;
  const aspect = document.querySelector("input[name=aspect]:checked")?.value ?? "square";
  setBusy(true);
  showWorking(aspect);
  try {
    const { svg, drew } = await request(prompt, aspect);
    show(svg, drew ?? prompt);
    // The image model would not draw the request as written; say what this is.
    current.note = drew ? `We couldn't draw that as asked, so this is “${drew}”.` : "";
    setNote(current.note);
    $("status").textContent = current.note || `Drawing ${prompt}.`;
  } catch (err) {
    if (!(err instanceof Told)) console.error(err);
    showNotice(err instanceof Told ? err.message : GENERIC);
  } finally {
    setBusy(false);
  }
});

$("replay").addEventListener("click", () => current && play());

// ---------------------------------------------------------------- downloads

const menu = $("formats");
let exporting = false;

function closeMenu() {
  menu.hidden = true;
  $("download").setAttribute("aria-expanded", "false");
}

$("download").addEventListener("click", async () => {
  if (!menu.hidden) return closeMenu();
  menu.hidden = false;
  $("download").setAttribute("aria-expanded", "true");
  menu.querySelector("button:not([hidden])").focus();
  // Not every browser can encode video; offer it only where it works.
  const { canMakeVideo } = await import("/export.js");
  menu.querySelector("[data-format=mp4]").hidden = !(current && (await canMakeVideo(current)));
});
document.addEventListener("click", (e) => {
  if (!menu.hidden && !e.target.closest(".menu")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (menu.hidden) return;
  if (e.key === "Escape") {
    closeMenu();
    $("download").focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...menu.querySelectorAll("button:not([hidden])")];
    const next = items.indexOf(document.activeElement) + (e.key === "ArrowDown" ? 1 : -1);
    items[(next + items.length) % items.length].focus();
  }
});

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// The finished drawing on its paper, whatever the animation is doing.
async function makeImage() {
  const width = current.width * 2;
  const height = current.height * 2;
  const svg = paper.querySelector("svg.drawing").cloneNode(true);
  svg.querySelector("circle")?.remove();
  for (const el of svg.querySelectorAll("[style]")) el.removeAttribute("style");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  const sheet = document.createElementNS(NS, "rect");
  sheet.setAttribute("width", "100%");
  sheet.setAttribute("height", "100%");
  sheet.setAttribute("fill", "#fbfaf6");
  svg.insertBefore(sheet, svg.firstChild);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
}

// Everything the video and GIF need, copied now so a new drawing started
// meanwhile does not disturb them.
function timeline() {
  const { width, height, total, seconds, strokes } = current;
  return {
    width, height, total, seconds, ease,
    strokes: strokes.map((s) => ({
      el: s.el, width: Number(s.el.parentNode.getAttribute("stroke-width")),
      start: s.start, end: s.end, travelStart: s.travelStart, travelFrom: s.travelFrom, from: s.from,
    })),
  };
}

const FORMATS = {
  png: { busy: "Saving image…", make: () => makeImage() },
  svg: { busy: "Saving…", make: async () => new Blob([current.svgText], { type: "image/svg+xml" }) },
  mp4: { busy: "Making video…", failed: "The video couldn't be made on this device. Try the GIF.", make: async (report) => (await import("/export.js")).makeVideo(timeline(), report) },
  gif: { busy: "Making GIF…", failed: "The GIF couldn't be made on this device.", make: async (report) => (await import("/export.js")).makeGif(timeline(), report) },
};

menu.addEventListener("click", async (e) => {
  const format = e.target.closest("button")?.dataset.format;
  if (!format || !current || exporting) return;
  const { busy, failed, make } = FORMATS[format];
  const slug = current.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "drawing";
  const button = $("download");
  closeMenu();
  exporting = button.disabled = true;
  button.textContent = $("status").textContent = busy;
  setNote("");
  try {
    download(await make((done) => { button.textContent = `${busy} ${Math.round(done * 100)}%`; }), `draws-ink-${slug}.${format}`);
    $("status").textContent = "Downloaded.";
    setNote(current?.note ?? "");
  } catch (err) {
    console.error(err);
    $("status").textContent = failed ?? "That couldn't be saved. Please try again.";
    setNote($("status").textContent);
  } finally {
    exporting = button.disabled = false;
    button.textContent = "Download";
  }
});

// Greet visitors with a drawing in progress rather than a blank sheet.
fetch("/sample.svg")
  .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`sample ${res.status}`))))
  .then((svg) => { if (!current && !$("go").disabled) show(svg, EXAMPLE, true); })
  .catch(() => {});
