"""Turn a raster pen drawing into single pen strokes.

    python trace.py picture.png drawing.svg [WIDTHxHEIGHT]

Writes an SVG on a page of that size (1024x1024 unless given) with three
layers in drawing order (1 main outlines, 2 detail, 3 shading) and prints one
line of JSON stats.
"""
import json
import math
import sys

import numpy as np
from PIL import Image
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.morphology import remove_small_objects, skeletonize

PAGE = 1024
SCALE = 2        # trace at 2x for smoother centrelines
SPUR = 7         # stubs shorter than this (trace px) are skeleton noise
REACH = 9        # how far along a branch to look when measuring its direction
MAXSPAN = 9      # a crossing is small; anything wider is not one junction
MARGIN = 0.06    # blank border kept round the finished drawing


def load(path, page):
    img = Image.open(path)
    if img.mode != "L":
        rgba = img.convert("RGBA")
        img = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("L")
    # The page at trace scale, in whole blocks of 4 for remove_frame.
    nw, nh = (-(-side * SCALE // 4) * 4 for side in page)
    k = min(nw / img.width, nh / img.height)
    w, h = max(1, round(img.width * k)), max(1, round(img.height * k))
    sheet = Image.new("L", (nw, nh), 255)
    sheet.paste(img.resize((w, h), Image.LANCZOS), ((nw - w) // 2, (nh - h) // 2))
    return np.asarray(sheet, dtype=np.float32) / 255


def find_ink(g):
    paper = ndi.gaussian_filter(ndi.maximum_filter(g, size=31), 16)   # local paper tone
    ink = remove_small_objects(g < 0.62 * np.maximum(paper, 1e-3), max_size=30)
    # Sometimes the picture is a photo of a sheet lying on a desk. The desk is
    # a large dim area reaching the edge of the picture: drop it and its rim.
    dim = ndi.binary_opening(g < 0.8 * np.percentile(g, 95), iterations=8)
    labels, count = ndi.label(dim)
    if count:
        size = np.bincount(labels.ravel())
        rim = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
        desk = np.isin(labels, [l for l in rim if l and size[l] > 0.004 * labels.size])
        if desk.any():
            ink &= ~ndi.binary_dilation(desk, iterations=28)
    return ink


def runs(row):
    """(start, end) of every run of True in a 1-D bool array."""
    d = np.diff(np.concatenate(([0], row.astype(np.int8), [0])))
    return zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist())


def rules(mask, least):
    """Long straight horizontal lines in mask as (row, start, end)."""
    band = mask[:-2] | mask[1:-1] | mask[2:]      # tolerate a slight tilt
    found = []
    for r in range(band.shape[0]):
        best = max(runs(band[r]), key=lambda se: se[1] - se[0], default=None)
        if best and best[1] - best[0] >= least:
            if found and r + 1 - found[-1][0] <= 3:
                found[-1] = (r + 1, min(found[-1][1], best[0]), max(found[-1][2], best[1]))
            else:
                found.append((r + 1, best[0], best[1]))
    return found


def remove_frame(ink):
    """Image models like to box their drawings, or show the edge of the sheet.
    Erase a ruled box, and any ruled line near the border with nothing beyond it."""
    f = 4
    h, w = ink.shape[0] // f, ink.shape[1] // f
    small = ink.reshape(h, f, w, f).any(axis=(1, 3))
    tall, broad, tol, pad = int(0.45 * h), int(0.45 * w), 7, 3
    rows, cols = rules(small, broad), rules(small.T, tall)
    near = lambda a, b: abs(a - b) <= tol
    top, bottom, left, right = 0, h, 0, w      # what is kept, in small pixels
    best = None
    for i, (yt, a0, a1) in enumerate(rows):
        for yb, b0, b1 in rows[i + 1:]:
            for j, (xl, c0, c1) in enumerate(cols):
                for xr, d0, d1 in cols[j + 1:]:
                    if (yb - yt >= tall and xr - xl >= broad
                            and near(a0, xl) and near(b0, xl) and near(a1, xr) and near(b1, xr)
                            and near(c0, yt) and near(d0, yt) and near(c1, yb) and near(d1, yb)):
                        if best is None or (yb - yt) * (xr - xl) > (best[1] - best[0]) * (best[3] - best[2]):
                            best = (yt, yb, xl, xr)
    if best:
        top, bottom, left, right = best[0] + pad, best[1] - pad, best[2] + pad, best[3] - pad
    empty = lambda area: area.size == 0 or area.mean() < 0.002
    for y, _, _ in rows:
        if y < 0.15 * h and empty(small[:max(y - pad, 0)]):
            top = max(top, y + pad)
        if y > 0.85 * h and empty(small[y + pad:]):
            bottom = min(bottom, y - pad)
    for x, _, _ in cols:
        if x < 0.15 * w and empty(small[:, :max(x - pad, 0)]):
            left = max(left, x + pad)
        if x > 0.85 * w and empty(small[:, x + pad:]):
            right = min(right, x - pad)
    kept = (top * f, bottom * f, left * f, right * f)
    if kept == (0, h * f, 0, w * f):
        return ink, kept, False
    out = np.zeros_like(ink)
    box = np.s_[kept[0]:kept[1], kept[2]:kept[3]]
    out[box] = ink[box]
    return out, kept, True


def drop_edge_scraps(ink, kept):
    """Ink lying wholly along an edge is the rim of the sheet, or what is left of a frame."""
    h, w = ink.shape
    top, bottom, left, right = kept
    band = lambda at_border: int((0.05 if at_border else 0.02) * math.sqrt(h * w))   # as wide on every side
    t, b = top + band(top == 0), bottom - band(bottom == h)
    l, r = left + band(left == 0), right - band(right == w)
    labels, _ = ndi.label(ink, structure=np.ones((3, 3)))
    scraps = [i + 1 for i, (ys, xs) in enumerate(ndi.find_objects(labels))
              if ys.stop <= t or ys.start >= b or xs.stop <= l or xs.start >= r]
    return ink & ~np.isin(labels, scraps) if scraps else ink


def dark_regions(ink, w):
    """Solid ink has no centreline to trace; it is outlined and hatched instead."""
    density = ndi.uniform_filter(ink.astype(np.float32), int(round(4 * w)) | 1)
    dark = ndi.binary_opening(density > 0.86, iterations=max(2, int(w)))
    dark = remove_small_objects(dark, max_size=int((4 * w) ** 2))
    if not dark.any():
        return dark
    filled = ndi.binary_closing(ink, iterations=int(w / 2) + 1)
    return ndi.binary_dilation(dark, iterations=max(2, int(1.5 * w))) & filled


def hatch(mask, step, flip, least):
    """Diagonal strokes covering mask, every `step` diagonals."""
    if not mask.any():
        return []
    m = mask[:, ::-1] if flip else mask
    h, w = m.shape
    out = []
    for i, k in enumerate(range(-h + 1 + step // 2, w, step)):
        d = np.diagonal(m, k)
        if not d.any():
            continue
        for a, b in runs(d):
            if b - a < least:
                continue
            r0, c0 = (a, a + k) if k >= 0 else (a - k, a)
            r1, c1 = r0 + (b - 1 - a), c0 + (b - 1 - a)
            if flip:
                c0, c1 = w - 1 - c0, w - 1 - c1
            seg = np.array([[r0, c0], [r1, c1]], dtype=float)
            out.append(seg if i % 2 else seg[::-1])
    return out


def centrelines(ink):
    """Skeleton of the ink as strokes that run straight on through crossings."""
    dist = ndi.distance_transform_edt(ink)
    ys, xs = np.nonzero(skeletonize(ink))
    pts = set(zip(ys.tolist(), xs.tolist()))

    def neighbours(p):
        y, x = p
        out = [q for q in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)) if q in pts]
        for dy in (-1, 1):
            for dx in (-1, 1):
                # a diagonal step only counts when no straight step covers it
                if (y + dy, x + dx) in pts and (y + dy, x) not in pts and (y, x + dx) not in pts:
                    out.append((y + dy, x + dx))
        return out

    adj = {p: neighbours(p) for p in pts}
    deg = lambda p: len(adj[p])
    nodes = {p for p in pts if deg(p) != 2}
    seen = set()

    def walk(a, b):
        path = [a, b]
        seen.add((a, b)); seen.add((b, a))
        while b not in nodes:
            n = adj[b]
            c = n[0] if n[1] == a else n[1]
            if (b, c) in seen:
                break
            seen.add((b, c)); seen.add((c, b))
            path.append(c)
            a, b = b, c
        return path

    paths = [walk(p, q) for p in nodes for q in adj[p] if (p, q) not in seen]
    paths += [walk(p, q) for p in pts if p not in nodes for q in adj[p] if (p, q) not in seen]

    # A skeleton puts a short bridge inside every crossing; merge its two ends
    # into one junction so the crossing lines can be matched up.
    parent, box = {}, {}

    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    alive = [True] * len(paths)
    for i, P in enumerate(paths):
        a, b = P[0], P[-1]
        if deg(a) >= 3 and deg(b) >= 3:
            width = 2 * float(np.mean([dist[q] for q in P]))
            if len(P) <= max(5, 1.6 * width):
                ra, rb = find(a), find(b)
                if ra == rb:
                    alive[i] = False
                    continue
                A = box.get(ra, [a[0], a[1], a[0], a[1]])
                B = box.get(rb, [b[0], b[1], b[0], b[1]])
                M = [min(A[0], B[0]), min(A[1], B[1]), max(A[2], B[2]), max(A[3], B[3])]
                if math.hypot(M[2] - M[0], M[3] - M[1]) <= MAXSPAN:
                    alive[i] = False
                    parent[ra] = rb
                    box[rb] = M
    for i, P in enumerate(paths):
        if alive[i]:
            ends = (deg(P[0]) == 1) + (deg(P[-1]) == 1)
            if (ends == 1 and len(P) < SPUR) or (ends == 2 and len(P) < 5):
                alive[i] = False

    members = {}
    for p in nodes:
        if deg(p) >= 3:
            members.setdefault(find(p), []).append(p)
    centre = {r: tuple(np.mean(m, axis=0)) for r, m in members.items()}

    branches = {}   # junction -> [(path, end)]
    for i, P in enumerate(paths):
        if alive[i]:
            for end, p in ((0, P[0]), (1, P[-1])):
                if deg(p) >= 3:
                    branches.setdefault(find(p), []).append((i, end))

    link, joint = {}, {}   # (path, end) -> the (path, end) it continues into / its junction point
    for r, bs in branches.items():
        c = np.array(centre[r])
        dirs = []
        for i, end in bs:
            P = paths[i]
            q = P[min(REACH, len(P) - 1)] if end == 0 else P[max(-REACH - 1, -len(P))]
            v = np.array(q, dtype=float) - c
            dirs.append(v / (np.linalg.norm(v) or 1))
            joint[(i, end)] = centre[r]
        pairs = sorted((float(dirs[a] @ dirs[b]), a, b) for a in range(len(bs)) for b in range(a + 1, len(bs)))
        used = set()
        for d, a, b in pairs:
            if a in used or b in used or bs[a][0] == bs[b][0]:
                continue
            if d < -0.55 or len(bs) == 2:
                used.update((a, b))
                link[bs[a]] = bs[b]
                link[bs[b]] = bs[a]

    done = [not a for a in alive]

    def chain(i, end):
        out, used = [], []
        while True:
            used.append(i)
            if (i, end) in joint:
                out.append(joint[(i, end)])
            out.extend(paths[i] if end == 0 else paths[i][::-1])
            far = (i, 1 - end)
            if far in joint:
                out.append(joint[far])
            nxt = link.get(far)
            if nxt is None or done[nxt[0]] or nxt[0] in used:
                return out, used
            i, end = nxt

    strokes = []
    starts = [(i, end) for i in range(len(paths)) for end in (0, 1) if (i, end) not in link]
    for i, end in starts + [(i, 0) for i in range(len(paths))]:   # open chains first, then closed loops
        if not done[i]:
            pts_, used = chain(i, end)
            for u in used:
                done[u] = True
            strokes.append(np.array(pts_, dtype=float))

    def width(P):
        iy = np.clip(np.rint(P[:, 0]).astype(int), 0, dist.shape[0] - 1)
        ix = np.clip(np.rint(P[:, 1]).astype(int), 0, dist.shape[1] - 1)
        return 2 * float(np.median(dist[iy, ix]))

    return strokes, [width(P) for P in strokes]


def smooth(P, k=3):
    n = len(P)
    if n < 5:
        return P
    c = np.cumsum(np.vstack([[0, 0], P]), axis=0)
    out = P.copy()
    for i in range(1, n - 1):
        w = min(i, n - 1 - i, k)
        out[i] = (c[i + w + 1] - c[i - w]) / (2 * w + 1)
    return out


def classify(strokes, widths):
    """1 main outlines, 2 detail, 3 shading (bundles of short parallel marks)."""
    n = len(strokes)
    length = np.array([np.linalg.norm(np.diff(P, axis=0), axis=1).sum() for P in strokes]) / SCALE
    chord = np.array([np.linalg.norm(P[-1] - P[0]) for P in strokes]) / SCALE
    mid = np.array([P[len(P) // 2] for P in strokes]) / SCALE
    theta = np.array([math.atan2(*(P[-1] - P[0])) % math.pi for P in strokes])
    width = np.array(widths) / SCALE
    typical = float(np.average(width, weights=length)) if n else 1.0

    marks = np.flatnonzero((chord >= 0.85 * length) & (length >= 8) & (length <= 170))
    shading = np.zeros(n, dtype=bool)
    if len(marks):
        tree = cKDTree(mid[marks])
        for i in marks:
            alike = 0
            for j in marks[tree.query_ball_point(mid[i], max(10.0, 0.45 * length[i]))]:
                turn = abs(theta[i] - theta[j])
                if j != i and min(turn, math.pi - turn) < 0.35 and 0.4 < length[j] / length[i] < 2.5:
                    alike += 1
            shading[i] = alike >= 2

    layer = np.full(n, 2)
    layer[(length >= 60) | ((width >= 1.25 * typical) & (length >= 24))] = 1
    layer[length < 12] = 3
    layer[shading] = 3
    return layer, length, typical


def nearest(strokes, at):
    """Greedy order: always draw whichever stroke starts closest to the pen."""
    out = []
    if not strokes:
        return out, at
    a = np.array([P[0] for P in strokes])
    b = np.array([P[-1] for P in strokes])
    left = np.ones(len(strokes), dtype=bool)
    for _ in strokes:
        da = np.where(left, np.hypot(*(a - at).T), np.inf)
        db = np.where(left, np.hypot(*(b - at).T), np.inf)
        i = int(np.argmin(np.minimum(da, db)))
        P = strokes[i] if da[i] <= db[i] else strokes[i][::-1]
        left[i] = False
        out.append(P)
        at = P[-1]
    return out, at


def main(src, dst, page=(PAGE, PAGE)):
    width, height = page
    ink = find_ink(load(src, page))
    ink, kept, framed = remove_frame(ink)
    ink = drop_edge_scraps(ink, kept)
    if not ink.any():
        open(dst, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}"/>')
        print(json.dumps({"strokes": 0}))
        return
    line = 2 * float(np.median(ndi.distance_transform_edt(ink)[skeletonize(ink)]))   # pen width, trace px
    dark = dark_regions(ink, line)
    core = ndi.binary_erosion(dark, iterations=max(2, round(0.9 * line))) if dark.any() else dark
    strokes, widths = centrelines(ink & ~core)     # the rim left behind traces as an outline
    layer, length, typical = classify(strokes, widths)

    step = max(4, round(1.1 * line * math.sqrt(2)))
    fill = hatch(dark, step, False, 2 * line) + hatch(dark, step, True, 2 * line)

    groups = {k: [smooth(P) for P, l in zip(strokes, layer) if l == k] for k in (1, 2, 3)}
    # Big shapes first, then the rest of the outline, then detail, then shading.
    size = lambda P: np.linalg.norm(np.diff(P, axis=0), axis=1).sum()
    big = sorted((P for P in groups[1] if size(P) >= 220 * SCALE), key=size, reverse=True)
    rest = [P for P in groups[1] if size(P) < 220 * SCALE]
    at = big[0][0] if big else np.zeros(2)
    ordered = {}
    first, at = nearest(big, at)
    more, at = nearest(rest, at)
    ordered[1] = first + more
    ordered[2], at = nearest(groups[2], at)
    ordered[3], at = nearest(groups[3] + fill, at)

    # Fit the drawing to the page with an even margin. Points are (row, column).
    every = np.vstack([P for g in ordered.values() for P in g])
    lo, hi = every.min(axis=0), every.max(axis=0)
    sides = np.array([height, width])
    room = (sides - 2 * MARGIN * min(page)) * SCALE
    zoom = min(float((room / np.maximum(hi - lo, 1e-9)).min()), 1.6)
    shift = sides / 2 - (lo + hi) / 2 * zoom / SCALE

    with open(dst, "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">\n')
        for k, group in ordered.items():
            f.write(f'<g id="layer{k}" fill="none" stroke="black" stroke-width="1">\n')
            for P in group:
                Q = P * zoom / SCALE + shift
                f.write('<polyline points="' + " ".join(f"{x:.2f},{y:.2f}" for y, x in Q) + '"/>\n')
            f.write("</g>\n")
        f.write("</svg>\n")
    print(json.dumps({
        "strokes": sum(len(g) for g in ordered.values()),
        "layers": [len(ordered[k]) for k in (1, 2, 3)],
        "framed": framed,
        "dark": round(float(dark.mean()) * 100, 2),
        "fill": len(fill),
        "line": round(typical, 2),
        "zoom": round(float(zoom), 2),
    }))


if __name__ == "__main__":
    size = sys.argv[3] if len(sys.argv) > 3 else f"{PAGE}x{PAGE}"
    main(sys.argv[1], sys.argv[2], tuple(int(side) for side in size.split("x")))
