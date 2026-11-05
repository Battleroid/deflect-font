"""Rasterise the stroke font onto a pixel grid, crisply.

Small bitmap fonts only look clean if the stems land on whole pixels, so this does
not downsample an outline. It scales the design so the capital band fills exactly
`cap` rows of ink, rounds the stroke to a whole number of pixels, snaps every point
so a stem of that width covers a whole number of columns, and then takes one sample
per pixel centre. The result has no grey, no half-lit stems and no stray pixels.

Geometry note: `cap` is the OUTER height of a capital, ink included -- ask for 8 and
an E is 8 rows tall. The vector fonts report the same thing in OS/2 sCapHeight, so a
line set in either lands at the same visual size.
"""

import math

import stroke
from stroke import CAP_UNITS, GAP, SIDE


class Raster:
    """One glyph rendered to pixels.

    `bits` is a list of rows, top row first, each a list of 0/1 of length `w`.
    `xoff` is the left edge of the ink box measured from the pen, in pixels.
    `yoff` is the bottom edge of the ink box measured from the baseline, y up
    (negative means it descends), matching BDF's BBX.
    """

    __slots__ = ("name", "bits", "w", "h", "xoff", "yoff", "advance")

    def __init__(self, name, bits, w, h, xoff, yoff, advance):
        self.name, self.bits = name, bits
        self.w, self.h = w, h
        self.xoff, self.yoff = xoff, yoff
        self.advance = advance

    def rows_as_ints(self):
        return [int("".join(str(b) for b in row) or "0", 2) for row in self.bits]


class Size:
    """The scaling for one (cap height, weight) pair."""

    def __init__(self, cap, weight):
        self.cap = cap
        self.stroke = max(1, round(weight * cap))
        self.half = self.stroke / 2.0
        # design units -> pixels, so that ink spans exactly `cap` rows
        self.scale = (cap - self.stroke) / CAP_UNITS
        self.weight = weight

    def snap(self, v):
        """Put a stroke centre where a stroke of this width covers whole pixels."""
        return round(v - self.half) + self.half

    def x_px(self, xd):
        return self.snap(SIDE * self.scale + self.half + xd * self.scale)

    def y_px(self, yd):
        """y up, 0 = the baseline row boundary."""
        return self.snap(self.half + yd * self.scale)

    def advance_px(self, width):
        return max(1, round((width + GAP) * self.scale))


def _segments(strokes, size):
    segs = []
    for line in strokes:
        pts = [(size.x_px(x), size.y_px(y)) for x, y in line]
        if len(pts) == 1:
            segs.append((pts[0], pts[0]))
        else:
            segs.extend(zip(pts, pts[1:]))
    return segs


def _hit(segs, px, py, half):
    for (x0, y0), (x1, y1) in segs:
        dx, dy = x1 - x0, y1 - y0
        vv = dx * dx + dy * dy
        if vv < 1e-12:
            t = 0.0
        else:
            t = ((px - x0) * dx + (py - y0) * dy) / vv
            t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        ex, ey = px - (x0 + t * dx), py - (y0 + t * dy)
        if ex * ex + ey * ey <= half * half + 1e-9:
            return True
    return False


def render(name, size):
    """Rasterise one glyph. Returns a Raster, or None for a blank glyph."""
    info = stroke.GLYPHS[name]
    advance = size.advance_px(info["width"])
    segs = _segments(info["strokes"], size)
    if not segs:
        return Raster(name, [], 0, 0, 0, 0, advance)

    pad = size.half + 1.5
    xs = [p[0] for s in segs for p in s]
    ys = [p[1] for s in segs for p in s]
    c0, c1 = math.floor(min(xs) - pad), math.ceil(max(xs) + pad)
    r0, r1 = math.floor(min(ys) - pad), math.ceil(max(ys) + pad)

    grid = {}
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            if _hit(segs, c + 0.5, r + 0.5, size.half):
                grid[(c, r)] = 1
    if not grid:
        return Raster(name, [], 0, 0, 0, 0, advance)

    cols = [c for c, _ in grid]
    rows = [r for _, r in grid]
    cmin, cmax = min(cols), max(cols)
    rmin, rmax = min(rows), max(rows)
    w, h = cmax - cmin + 1, rmax - rmin + 1
    bits = [
        [grid.get((cmin + i, rmax - j), 0) for i in range(w)]
        for j in range(h)                       # top row first
    ]
    # Keep at least one blank column before the next glyph: at small sizes the
    # design's own gap (1.3 units less a stroke) falls below a pixel and letters
    # would touch. Glyphs meant to meet their neighbour, like the underscore, opt
    # out and keep the advance the scaling gives them.
    if not info["connect"]:
        advance = max(advance, cmax + 2)
    return Raster(name, bits, w, h, cmin, rmin, advance)


def render_all(cap, weight, names=None):
    size = Size(cap, weight)
    names = names or [n for n in stroke.GLYPHS if GLYPH_HAS_CODE(n)]
    return size, {n: render(n, size) for n in names}


def GLYPH_HAS_CODE(name):
    return bool(stroke.GLYPHS[name]["codepoints"])


def font_box(rasters):
    """(width, height, xoff, yoff) covering every glyph: BDF's FONTBOUNDINGBOX."""
    boxes = [r for r in rasters.values() if r.w]
    x0 = min(r.xoff for r in boxes)
    y0 = min(r.yoff for r in boxes)
    x1 = max(r.xoff + r.w for r in boxes)
    y1 = max(r.yoff + r.h for r in boxes)
    return x1 - x0, y1 - y0, x0, y0


def ascent_descent(rasters):
    """Ink above and below the baseline, as positive numbers."""
    boxes = [r for r in rasters.values() if r.w]
    asc = max(r.yoff + r.h for r in boxes)
    desc = -min(r.yoff for r in boxes)
    return asc, desc
