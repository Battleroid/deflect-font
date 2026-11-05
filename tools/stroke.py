"""Deflect Stencil: the shared glyph source and the stroke-to-outline expansion.

The design lives in `reference/lib/font.py` as polylines on a grid 6 units tall
(baseline y = 0, cap height y = 6, y up). Everything downstream -- the OTF/TTF, the
BDF, the u8g2/GFX/LVGL bitmaps -- reads the glyph table from here so there is exactly
one copy of the shapes.
"""

import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "reference"))
from lib import font as _src  # noqa: E402

# --- design space ------------------------------------------------------------

UPM = 1000          # units per em of the built fonts
CAP_UNITS = 6.0     # cap height in design units
CAP = 700           # cap height in font units (stroke centre line)
UNIT = CAP / CAP_UNITS          # 116.6667 font units per design unit
GAP = _src.GAP                  # 1.3 design units between glyphs
SIDE = GAP / 2.0                # half the gap becomes a side bearing each side

WEIGHTS = {
    # name:        (stroke weight, OS/2 usWeightClass, style name)
    "Regular": (0.13, 400, "Regular"),
    "Bold":    (0.22, 700, "Bold"),
}

# --- glyph table -------------------------------------------------------------
# Start from the game's table, then make the two documented substitutions:
# U+005E becomes a real caret and the game's up-arrow moves to U+2191.

CARET = [[(0, 3.5), (1.5, 6), (3, 3.5)]]
ARROW = _src.GLYPHS["^"][1]
NOTDEF = [[(0.4, 0), (2.8, 0), (2.8, 6), (0.4, 6), (0.4, 0)]]

# --- glyphs the game never needed -------------------------------------------
# Drawn here, not in reference/lib/font.py: that file is a byte-identical snapshot
# of the game's table and stays that way, so everything additional is visibly
# separate. Same grid and the same vocabulary as the original:
#   * rounds are clipped octagons, not curves;
#   * a lone point is a dot, as in '.' and the dot of '!';
#   * tall marks overshoot to -0.5 and 6.5, the way '(' and ')' do;
#   * the dot of '?' sits where the dot of '!' does.
# Completing ASCII matters on a display: '?' and '_' for prompts and blanks, the
# brackets and the bar for drawing boxes, and the degree sign for temperatures.

# The dollar is the game's own S at full height with a bar through it, overshooting
# to the parenthesis extent. Squashing the S to clear the bar is the obvious move and
# it is wrong: it closes the gap between the S's three horizontals to 0.88 units,
# under a 1.32-unit bold stroke, and the glyph goes solid. Left full height those
# gaps are 1.58 and the counters survive.
_S = _src.GLYPHS["S"][1][0]

EXTRAS = {
    # char: (advance width, [polyline, ...])
    "$": (4, [_S, [(2, 6.5), (2, -0.5)]]),
    "&": (4, [[(4, 1.8), (3.0, 0), (1.0, 0), (0, 1.2), (0, 2.3), (3.0, 4.3),
               (3.0, 5.2), (2.3, 6), (1.4, 6), (0.7, 5.2), (0.7, 3.9), (4, 0)]]),
    "?": (3.4, [[(0, 4.9), (0.9, 6), (2.5, 6), (3.4, 4.9), (3.4, 4.0),
                 (1.7, 2.6), (1.7, 1.8)], [(1.7, 0)]]),
    # One unbroken stroke, the way G and S are: the ring runs round from the
    # bottom-right, leaves a 2.6-unit opening there, then turns in and closes the
    # inner bowl. Wider than W, because two gaps 2 units across are what keeps the
    # ring and the bowl apart under a 1.32-unit bold stroke.
    "@": (6, [[(4.6, 0), (1.1, 0), (0, 1.3), (0, 4.7), (1.1, 6), (4.9, 6),
               (6, 4.7), (6, 2.2), (4, 1.8), (2, 1.8), (2, 4.2), (4, 4.2),
               (4, 1.8)]]),
    ";": (1, [[(0.5, 3.6)], [(0.6, 0.2), (0.2, -0.9)]]),
    # the underscore spans its whole advance (-GAP/2 to width+GAP/2) so a run of
    # them makes one unbroken rule
    "_": (3.6, [[(-0.65, -0.8), (4.25, -0.8)]]),
    "[": (1.8, [[(1.5, 6.5), (0.4, 6.5), (0.4, -0.5), (1.5, -0.5)]]),
    "]": (1.8, [[(0.3, 6.5), (1.4, 6.5), (1.4, -0.5), (0.3, -0.5)]]),
    "{": (2.2, [[(1.9, 6.5), (1.2, 6.0), (1.2, 3.6), (0.3, 3.0), (1.2, 2.4),
                 (1.2, 0.0), (1.9, -0.5)]]),
    "}": (2.2, [[(0.3, 6.5), (1.0, 6.0), (1.0, 3.6), (1.9, 3.0), (1.0, 2.4),
                 (1.0, 0.0), (0.3, -0.5)]]),
    "\\": (3, [[(0, 6), (3, 0)]]),
    "|": (1, [[(0.5, 6.5), (0.5, -0.5)]]),
    "~": (3.4, [[(0, 2.6), (0.85, 3.6), (2.55, 2.4), (3.4, 3.4)]]),
    "`": (1.2, [[(0.2, 6), (1.0, 5.0)]]),
    "°": (2.8, [[(0.2, 4.4), (0.85, 3.8), (1.75, 3.8), (2.4, 4.4), (2.4, 5.4),
                      (1.75, 6.0), (0.85, 6.0), (0.2, 5.4), (0.2, 4.4)]]),
    "×": (3, [[(0.3, 1.8), (2.7, 4.2)], [(0.3, 4.2), (2.7, 1.8)]]),
}

# Glyphs whose ink is meant to fill the advance and meet its neighbour, so the
# bitmap builder must not widen them to leave a gap.
CONNECTING = {"_"}

# glyph name -> (advance width in design units, [polyline, ...], [codepoints])
AGL = {
    " ": "space", "-": "hyphen", ".": "period", ",": "comma", ":": "colon",
    "/": "slash", "+": "plus", "(": "parenleft", ")": "parenright",
    "!": "exclam", "'": "quotesingle", '"': "quotedbl", "<": "less",
    ">": "greater", "=": "equal", "*": "asterisk", "#": "numbersign",
    "%": "percent", "^": "asciicircum",
    "$": "dollar", "&": "ampersand", "?": "question", "@": "at",
    ";": "semicolon", "_": "underscore", "[": "bracketleft", "]": "bracketright",
    "{": "braceleft", "}": "braceright", "\\": "backslash", "|": "bar",
    "~": "asciitilde", "`": "grave", "°": "degree", "×": "multiply",
}
DIGIT = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def glyph_name(ch):
    if ch.isalpha():
        return ch
    if ch.isdigit():
        return DIGIT[int(ch)]
    return AGL[ch]


def glyph_table():
    """Ordered dict: name -> dict(width, strokes, codepoints, connect)."""
    out = {".notdef": {"width": 3.2, "strokes": NOTDEF, "codepoints": [],
                       "connect": False}}
    source = list(_src.GLYPHS.items()) + list(EXTRAS.items())
    for ch, (width, strokes) in source:
        name = glyph_name(ch)
        cps = [ord(ch)]
        if ch.isalpha():
            cps.append(ord(ch.lower()))      # lowercase renders as caps, as the game does
        if ch == " ":
            cps.append(0x00A0)               # no-break space
        if ch == "^":
            strokes = CARET                  # a real caret at U+005E
        out[name] = {"width": width, "strokes": strokes, "codepoints": cps,
                     "connect": ch in CONNECTING}
    out["arrowup"] = {"width": 3, "strokes": ARROW, "codepoints": [0x2191],
                      "connect": False}
    return out


GLYPHS = glyph_table()
NOTDEF_NAME = ".notdef"


def advance_units(width):
    """Advance in design units: the glyph box plus one gap, split as side bearings."""
    return width + GAP


# --- stroke -> outline -------------------------------------------------------

K = 0.5522847498307936          # cubic approximation of a quarter circle


def _circle(pen, cx, cy, r):
    k = K * r
    pen.moveTo((cx + r, cy))
    pen.curveTo((cx + r, cy + k), (cx + k, cy + r), (cx, cy + r))
    pen.curveTo((cx - k, cy + r), (cx - r, cy + k), (cx - r, cy))
    pen.curveTo((cx - r, cy - k), (cx - k, cy - r), (cx, cy - r))
    pen.curveTo((cx + k, cy - r), (cx + r, cy - k), (cx + r, cy))
    pen.closePath()


def _capsule(pen, p0, p1, r):
    """One segment of a monoline stroke: two sides plus two semicircular caps."""
    (x0, y0), (x1, y1) = p0, p1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length < 1e-9:
        _circle(pen, x0, y0, r)
        return
    ux, uy = dx / length, dy / length
    nx, ny = uy, -ux        # right normal: makes the capsule run counter-clockwise,
    k = K * r               # the same way as _circle, so the union adds rather than cancels
    a = (x0 + nx * r, y0 + ny * r)
    b = (x1 + nx * r, y1 + ny * r)
    c = (x1 - nx * r, y1 - ny * r)
    d = (x0 - nx * r, y0 - ny * r)
    e = (x1 + ux * r, y1 + uy * r)          # far cap apex
    f = (x0 - ux * r, y0 - uy * r)          # near cap apex
    pen.moveTo(a)
    pen.lineTo(b)
    pen.curveTo((b[0] + ux * k, b[1] + uy * k), (e[0] + nx * k, e[1] + ny * k), e)
    pen.curveTo((e[0] - nx * k, e[1] - ny * k), (c[0] + ux * k, c[1] + uy * k), c)
    pen.lineTo(d)
    pen.curveTo((d[0] - ux * k, d[1] - uy * k), (f[0] - nx * k, f[1] - ny * k), f)
    pen.curveTo((f[0] + nx * k, f[1] + ny * k), (a[0] - ux * k, a[1] - uy * k), a)
    pen.closePath()


# Each segment is grown by this much at both ends before the union. Exactly abutting
# round caps are tangent curves, which Skia's path ops sometimes refuse or resolve into
# slivers; overlapping them by a twentieth of a font unit (5e-5 em) avoids that and is
# far below any rounding the formats do.
EPS = 0.05


def _segments(strokes, scale, dx, dy, eps=EPS):
    out = []
    for line in strokes:
        pts = [(x * scale + dx, y * scale + dy) for x, y in line]
        if len(pts) == 1:
            out.append((pts[0], pts[0]))
            continue
        for p0, p1 in zip(pts, pts[1:]):
            ddx, ddy = p1[0] - p0[0], p1[1] - p0[1]
            length = math.hypot(ddx, ddy)
            if eps and length > 1e-9:
                ux, uy = ddx / length, ddy / length
                p0 = (p0[0] - ux * eps, p0[1] - uy * eps)
                p1 = (p1[0] + ux * eps, p1[1] + uy * eps)
            out.append((p0, p1))
    return out


def stroke_to_path(strokes, r, scale=1.0, dx=0.0, dy=0.0):
    """Union of every capsule and dot in `strokes`, as a skia-pathops Path.

    Coordinates are design units; `scale`, `dx`, `dy` put them in font units.
    `r` is the stroke half-width, already in font units.
    """
    import pathops

    raw = pathops.Path()
    pen = raw.getPen()
    for p0, p1 in _segments(strokes, scale, dx, dy):
        _capsule(pen, p0, p1, r)
    out = pathops.Path()
    pathops.union([raw], out.getPen())
    return out


def contour_area(contour):
    """Signed area of one recorded contour, from its on- and off-curve points.

    The control polygon's sign matches the true area's for these shapes, which is all
    the orientation check needs.
    """
    pts = []
    for op, args in contour:
        if op == "moveTo":
            pts.append(args[0])
        elif op == "lineTo":
            pts.append(args[0])
        elif op in ("curveTo", "qCurveTo"):
            pts.extend(p for p in args if p is not None)
    total = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        total += x0 * y1 - x1 * y0
    return total / 2.0


def split_contours(recording):
    """Split a RecordingPen value list into per-contour lists."""
    out, cur = [], []
    for op, args in recording:
        if op == "moveTo" and cur:
            out.append(cur)
            cur = []
        cur.append((op, args))
    if cur:
        out.append(cur)
    return out
