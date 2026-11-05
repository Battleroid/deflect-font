"""Check the built OTF/TTF against the geometry they came from.

For every glyph, FreeType (via Pillow) renders the font and the script compares that
to an exact distance-field evaluation of the original polylines -- the same rule the
game's rasteriser uses: ink wherever a point lies within half a stroke of any segment.
Pixels near the edge are ignored, since antialiasing legitimately disagrees there.

    python tools/verify_vector.py [dist_dir]
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import stroke
from stroke import CAP_UNITS, GAP, SIDE, UNIT, UPM, WEIGHTS

SIZE = 240          # px per em when rendering
TOL_PX = 1.6        # ignore disagreement this close to an outline edge


def ref_distance(strokes, xs, ys):
    """Min distance (design units) from each (x, y) to the glyph's polylines."""
    px = xs[None, :, None]
    py = ys[:, None, None]
    segs = []
    for line in strokes:
        if len(line) == 1:
            segs.append((line[0], line[0]))
        else:
            segs.extend(zip(line, line[1:]))
    if not segs:
        return np.full((len(ys), len(xs)), 1e9)
    a = np.array([s[0] for s in segs], dtype=float)
    b = np.array([s[1] for s in segs], dtype=float)
    ax, ay = a[:, 0][None, None, :], a[:, 1][None, None, :]
    bx, by = b[:, 0][None, None, :], b[:, 1][None, None, :]
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    vv = vx * vx + vy * vy
    t = np.where(vv > 1e-12, (wx * vx + wy * vy) / np.where(vv > 1e-12, vv, 1), 0.0)
    t = np.clip(t, 0.0, 1.0)
    cx, cy = ax + t * vx, ay + t * vy
    return np.min(np.hypot(px - cx, py - cy), axis=2)


def check_font(path, weight):
    f = ImageFont.truetype(path, SIZE)
    r_design = weight * CAP_UNITS / 2.0
    scale = SIZE / UPM                      # px per font unit
    worst = (0.0, None)
    adv_bad = []
    for name, info in stroke.GLYPHS.items():
        cps = info["codepoints"]
        if not cps or not info["strokes"]:
            continue
        ch = chr(cps[0])

        # advance width
        want = (info["width"] + GAP) * UNIT * scale
        got = f.getlength(ch)
        if abs(got - round(want)) > 1.0:
            adv_bad.append((ch, got, want))

        # render with the pen at a known place, baseline anchored
        ox, oy = 60, 220
        img = Image.new("L", (int((info["width"] + GAP) * UNIT * scale) + 120, 300), 0)
        ImageDraw.Draw(img).text((ox, oy), ch, font=f, fill=255, anchor="ls")
        arr = np.asarray(img, dtype=float) / 255.0

        h, w = arr.shape
        # pixel centres -> design units
        xs = ((np.arange(w) + 0.5 - ox) / scale) / UNIT - SIDE
        ys = ((oy - np.arange(h) - 0.5) / scale) / UNIT
        dist = ref_distance(info["strokes"], xs, ys)
        inside = dist <= r_design
        # distance from the outline, in pixels
        edge_px = np.abs(dist - r_design) * UNIT * scale
        rendered = arr >= 0.5
        wrong = (rendered != inside) & (edge_px > TOL_PX)
        if wrong.any():
            depth = float(edge_px[wrong].max())
            if depth > worst[0]:
                worst = (depth, "%s (%d px)" % (name, int(wrong.sum())))
    return worst, adv_bad


def main():
    dist = sys.argv[1] if len(sys.argv) > 1 else os.path.join(stroke.ROOT, "dist")
    ok = True
    for style, (weight, _c, _s) in WEIGHTS.items():
        for sub, ext in (("otf", "otf"), ("ttf", "ttf")):
            path = os.path.join(dist, sub, "DeflectStencil-%s.%s" % (style, ext))
            (depth, who), adv = check_font(path, weight)
            status = "OK" if depth == 0.0 and not adv else "MISMATCH"
            if status != "OK":
                ok = False
            print(
                "%-8s %-3s  %-8s  worst stray ink %.2f px %s   advances off: %d"
                % (style, ext, status, depth, "(%s)" % who if who else "", len(adv))
            )
            for ch, got, want in adv[:5]:
                print("            advance %r got %.1f want %.1f" % (ch, got, want))
    print("ALL OK" if ok else "FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
