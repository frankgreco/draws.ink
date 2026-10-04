// Replays a drawing onto a canvas frame by frame and encodes the frames as a
// video or a GIF, all in the browser. Loaded only when someone asks for one.
const PAPER = [251, 250, 246];
const INK = [31, 29, 26];
const PEN = [210, 69, 47];
const MARK = "sketch"; // small wordmark in the corner of the animations

// Frames take the drawing's shape. A video's shorter side is 1080, which makes
// tall and wide drawings 1080x1920 and 1920x1080; the bitrate is for a square
// frame and grows with the frame. A GIF has as many pixels whatever its shape.
const VIDEO = { short: 1080, fps: 30, hold: 1.5, codec: "avc1.640028", bitrate: 1_000_000 };
const GIF = { pixels: 720 * 720, delay: 70, hold: 2500 }; // delays in ms; GIF timing is in hundredths of a second

const css = ([r, g, b], alpha = 1) => `rgba(${r}, ${g}, ${b}, ${alpha})`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// A stroke's points and the distance along it at each one.
function outline(el) {
  const xy = [];
  if (el.points?.numberOfItems) {
    for (let i = 0; i < el.points.numberOfItems; i++) {
      const p = el.points.getItem(i);
      xy.push(p.x, p.y);
    }
    if (el.tagName === "polygon") xy.push(xy[0], xy[1]);
  } else if (el.tagName === "line") {
    xy.push(el.x1.baseVal.value, el.y1.baseVal.value, el.x2.baseVal.value, el.y2.baseVal.value);
  } else {
    const length = el.getTotalLength();
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let i = 0; i <= steps; i++) {
      const p = el.getPointAtLength((length * i) / steps);
      xy.push(p.x, p.y);
    }
  }
  const along = new Float32Array(xy.length / 2);
  for (let i = 1; i < along.length; i++) {
    along[i] = along[i - 1] + Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1]);
  }
  return { xy, along, length: along[along.length - 1] };
}

// The drawing as it stands at any point on its timeline. Finished strokes
// are kept on one canvas, so each frame only adds the stroke in progress.
// Call draw() with times that never go backwards.
function renderer(drawing, { width, height }) {
  const k = width / drawing.width;
  const unit = Math.min(width, height);
  const strokes = drawing.strokes.map((s) => ({ ...s, ...outline(s.el) }));
  const sheet = (options) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", options);
    context.lineCap = context.lineJoin = "round";
    context.strokeStyle = css(INK);
    return { canvas, context };
  };

  const done = sheet();
  done.context.fillStyle = css(PAPER);
  done.context.fillRect(0, 0, width, height);
  done.context.font = `600 ${Math.round(unit * 0.026)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  done.context.textAlign = "right";
  done.context.fillStyle = css(INK, 0.42);
  done.context.fillText(MARK, width - unit * 0.035, height - unit * 0.032);
  done.context.setTransform(k, 0, 0, k, 0, 0);
  const frame = sheet({ willReadFrequently: true });

  // Strokes s as far as `upto` along it, and returns where the pen is.
  const stroke = (context, s, upto) => {
    const { xy, along } = s;
    let x = xy[0];
    let y = xy[1];
    context.lineWidth = s.width;
    context.beginPath();
    context.moveTo(x, y);
    let i = 1;
    for (; i < along.length && along[i] <= upto; i++) context.lineTo((x = xy[2 * i]), (y = xy[2 * i + 1]));
    if (i < along.length && upto > along[i - 1]) {
      const t = (upto - along[i - 1]) / (along[i] - along[i - 1]);
      x += (xy[2 * i] - x) * t;
      y += (xy[2 * i + 1] - y) * t;
      context.lineTo(x, y);
    }
    context.stroke();
    return { x, y };
  };

  let finished = 0;
  const draw = (clock) => {
    while (finished < strokes.length && strokes[finished].end <= clock) {
      stroke(done.context, strokes[finished], Infinity);
      finished++;
    }
    const c = frame.context;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(done.canvas, 0, 0);
    const s = strokes[finished];
    if (!s) return;
    c.setTransform(k, 0, 0, k, 0, 0);
    let pen;
    const travelling = clock < s.start;
    if (travelling) {
      const u = Math.min(((clock - s.travelStart) / Math.max(s.start - s.travelStart, 1e-6)) * 1.3, 1);
      pen = { x: s.travelFrom.x + (s.from.x - s.travelFrom.x) * u, y: s.travelFrom.y + (s.from.y - s.travelFrom.y) * u };
    } else {
      pen = stroke(c, s, s.length * drawing.ease((clock - s.start) / (s.end - s.start)));
    }
    c.fillStyle = css(PEN, travelling ? 0.35 : 1);
    c.beginPath();
    c.arc(pen.x, pen.y, 5, 0, 2 * Math.PI);
    c.fill();
  };
  return { canvas: frame.canvas, context: frame.context, draw };
}

// H.264 wants even sides.
function videoSize(drawing) {
  const k = VIDEO.short / Math.min(drawing.width, drawing.height);
  return { width: 2 * Math.round((drawing.width * k) / 2), height: 2 * Math.round((drawing.height * k) / 2) };
}
const videoConfig = ({ width, height }) => ({
  codec: VIDEO.codec, width, height, framerate: VIDEO.fps,
  bitrate: Math.round((VIDEO.bitrate * width * height) / VIDEO.short ** 2),
});

export async function canMakeVideo(drawing) {
  try {
    return "VideoEncoder" in globalThis && (await VideoEncoder.isConfigSupported(videoConfig(videoSize(drawing)))).supported === true;
  } catch {
    return false;
  }
}

// An H.264 MP4: what Instagram, TikTok and phones' galleries take.
export async function makeVideo(drawing, onProgress) {
  const size = videoSize(drawing);
  const render = renderer(drawing, size);
  const { Muxer, ArrayBufferTarget } = await import("/vendor/mp4-muxer.mjs");
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", ...size, frameRate: VIDEO.fps },
    fastStart: "in-memory",
  });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => { failure = err; },
  });
  encoder.configure(videoConfig(size));
  try {
    const drawn = Math.ceil(drawing.seconds * VIDEO.fps);
    const total = drawn + Math.round(VIDEO.hold * VIDEO.fps); // then rest on the finished drawing
    for (let i = 0; i < total; i++) {
      if (failure) throw failure;
      render.draw(i < drawn ? (i / drawn) * drawing.total : Infinity);
      const picture = new VideoFrame(render.canvas, { timestamp: Math.round((i * 1e6) / VIDEO.fps), duration: Math.round(1e6 / VIDEO.fps) });
      // Keyframes of a detailed drawing are large and nobody seeks in a short clip.
      encoder.encode(picture, { keyFrame: i % (VIDEO.fps * 10) === 0 });
      picture.close();
      if (i % 8 === 0) {
        onProgress(i / total);
        await pause();
      }
      while (encoder.encodeQueueSize > 8 && !failure) await pause();
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    return new Blob([muxer.target.buffer], { type: "video/mp4" });
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

// A GIF needs few colours here: paper to ink, and the pen dot over each.
function palette() {
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const colours = [];
  for (let i = 0; i <= 15; i++) colours.push(mix(PAPER, INK, i / 15));
  for (let i = 1; i <= 6; i++) colours.push(mix(PAPER, PEN, i / 6));
  for (let i = 1; i <= 3; i++) colours.push(mix(PEN, INK, i / 4));
  colours.push([0, 255, 0]); // never matched: the slot that means "unchanged since the last frame"
  return colours;
}

export async function makeGif(drawing, onProgress) {
  const k = Math.sqrt(GIF.pixels / (drawing.width * drawing.height));
  const width = Math.round(drawing.width * k);
  const height = Math.round(drawing.height * k);
  const render = renderer(drawing, { width, height });
  const { GIFEncoder, applyPalette } = await import("/vendor/gifenc.mjs");
  const colours = palette();
  const unchanged = colours.length - 1;
  const gif = GIFEncoder();
  const drawn = Math.ceil((drawing.seconds * 1000) / GIF.delay);
  let previous = null;
  for (let i = 0; i <= drawn; i++) {
    const last = i === drawn;
    render.draw(last ? Infinity : (i / drawn) * drawing.total);
    const pixels = applyPalette(render.context.getImageData(0, 0, width, height).data, colours, "rgb565");
    // Most of the sheet is the same from one frame to the next; saying so
    // instead of repeating it is what keeps the file small.
    let changes = pixels;
    if (previous) {
      changes = new Uint8Array(pixels.length);
      for (let j = 0; j < pixels.length; j++) changes[j] = pixels[j] === previous[j] ? unchanged : pixels[j];
    }
    gif.writeFrame(changes, width, height, {
      palette: previous ? undefined : colours,
      delay: last ? GIF.hold : GIF.delay, // the last frame rests before the loop restarts
      transparent: Boolean(previous),
      transparentIndex: unchanged,
      dispose: 1,
    });
    previous = pixels;
    if (i % 4 === 0) {
      onProgress(i / drawn);
      await pause();
    }
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: "image/gif" });
}
