"""Build the vector fonts: Deflect Stencil Regular and Bold, as OTF (CFF) and TTF (glyf).

    python tools/build_vector.py [out_dir]

Outline construction: every stroke segment becomes a capsule (two sides, two
semicircular caps as cubics) and every lone point a circle; skia-pathops unions them
per glyph, so overlaps and joins resolve to one clean contour set with true curves.
"""

import os
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

import stroke
from stroke import CAP, GLYPHS, NOTDEF_NAME, SIDE, UNIT, UPM, WEIGHTS

VERSION = "1.000"
FAMILY = "Deflect Stencil"
PSFAMILY = "DeflectStencil"
COPYRIGHT = (
    "Deflect Stencil. Dedicated to the public domain under CC0 1.0 Universal. "
    "Drawn from the stroke font used on the vehicle textures in Deflect."
)
LICENSE = (
    "CC0 1.0 Universal. To the extent possible under law, the author has waived all "
    "copyright and related or neighbouring rights to this font."
)
LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/"
DESCRIPTION = (
    "A condensed monoline stencil sans with round caps, clipped-octagon rounds and "
    "military data-plate quirks: a slashed zero, a serifed I, a footed 1 and a Q whose "
    "tail crosses the bowl. Uppercase only; lowercase input renders as caps."
)

# One set of vertical metrics for both weights, so a line of Bold sits exactly where
# the same line of Regular does. The win values clear the heaviest ink.
TYPO_ASC, TYPO_DESC, TYPO_GAP = 800, -200, 200
WIN_ASC, WIN_DESC = 840, 190


def glyph_order():
    names = [NOTDEF_NAME] + [n for n in GLYPHS if n != NOTDEF_NAME]
    return names


def recorded_outline(name, radius, want_ccw):
    """Record a glyph's unioned outline, oriented so the outer contour runs the way
    the target format wants it (CFF: counter-clockwise; TrueType: clockwise)."""
    info = GLYPHS[name]
    if not info["strokes"]:
        return RecordingPen()
    path = stroke.stroke_to_path(
        info["strokes"], radius, scale=UNIT, dx=SIDE * UNIT, dy=0.0
    )
    rec = RecordingPen()
    path.draw(rec)
    contours = stroke.split_contours(rec.value)
    if not contours:
        return rec
    biggest = max(contours, key=lambda c: abs(stroke.contour_area(c)))
    is_ccw = stroke.contour_area(biggest) > 0
    if is_ccw == want_ccw:
        return rec
    flipped = RecordingPen()
    rec.replay(ReverseContourPen(flipped))
    return flipped


def advance_of(name):
    return round((GLYPHS[name]["width"] + stroke.GAP) * UNIT)


def build_one(style, weight, out_dir):
    radius = weight * CAP / 2.0
    order = glyph_order()
    advances = {n: advance_of(n) for n in order}

    # ---- outlines, both orientations -------------------------------------
    cff_rec = {n: recorded_outline(n, radius, want_ccw=True) for n in order}
    ttf_rec = {n: recorded_outline(n, radius, want_ccw=False) for n in order}

    # ---- metrics ---------------------------------------------------------
    metrics, bounds = {}, {}
    ymin, ymax = 0, CAP
    for n in order:
        bp = BoundsPen(None)
        cff_rec[n].replay(bp)
        if bp.bounds is None:
            metrics[n] = (advances[n], 0)
            bounds[n] = None
            continue
        x0, y0, x1, y1 = bp.bounds
        metrics[n] = (advances[n], round(x0))
        bounds[n] = (round(x0), round(y0), round(x1), round(y1))
        ymin, ymax = min(ymin, round(y0)), max(ymax, round(y1))

    cmap = {}
    for n in order:
        for cp in GLYPHS[n]["codepoints"]:
            cmap[cp] = n

    common = dict(
        style=style,
        weight_class=WEIGHTS[style][1],
        cap_height=round(CAP + radius),
        order=order,
        metrics=metrics,
        cmap=cmap,
        ink=(ymin, ymax),
    )

    otf = assemble(cff_rec, is_cff=True, **common)
    ttf = assemble(ttf_rec, is_cff=False, **common)

    os.makedirs(os.path.join(out_dir, "otf"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "ttf"), exist_ok=True)
    otf_path = os.path.join(out_dir, "otf", "%s-%s.otf" % (PSFAMILY, style))
    ttf_path = os.path.join(out_dir, "ttf", "%s-%s.ttf" % (PSFAMILY, style))
    otf.save(otf_path)
    ttf.save(ttf_path)

    woff = None
    try:
        import brotli  # noqa: F401

        ttf.flavor = "woff2"
        woff = os.path.join(out_dir, "ttf", "%s-%s.woff2" % (PSFAMILY, style))
        ttf.save(woff)
    except ImportError:
        pass
    return otf_path, ttf_path, woff, (ymin, ymax)


def assemble(recs, is_cff, style, weight_class, cap_height, order, metrics, cmap, ink):
    fb = FontBuilder(UPM, isTTF=not is_cff)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)

    if is_cff:
        charstrings = {}
        for name in order:
            pen = T2CharStringPen(metrics[name][0], None)
            recs[name].replay(pen)
            charstrings[name] = pen.getCharString()
        fb.setupCFF(
            "%s-%s" % (PSFAMILY, style),
            {
                "FullName": "%s %s" % (FAMILY, style),
                "FamilyName": FAMILY,
                "Weight": style,
                "version": VERSION,
                "Notice": COPYRIGHT,
            },
            charstrings,
            {},
        )
    else:
        glyphs = {}
        for name in order:
            tt = TTGlyphPen(None)
            recs[name].replay(Cu2QuPen(tt, 0.4))
            glyphs[name] = tt.glyph()
        fb.setupGlyf(glyphs)

    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(
        ascent=TYPO_ASC, descent=TYPO_DESC, lineGap=TYPO_GAP
    )
    fb.setupNameTable(
        {
            "copyright": COPYRIGHT,
            "familyName": FAMILY,
            "styleName": style,
            "uniqueFontIdentifier": "%s %s; %s" % (FAMILY, style, VERSION),
            "fullName": "%s %s" % (FAMILY, style),
            "version": "Version %s" % VERSION,
            "psName": "%s-%s" % (PSFAMILY, style),
            "description": DESCRIPTION,
            "licenseDescription": LICENSE,
            "licenseInfoURL": LICENSE_URL,
        }
    )
    fb.setupOS2(
        version=4,                          # needed for USE_TYPO_METRICS (fsSelection bit 7)
        sTypoAscender=TYPO_ASC,
        sTypoDescender=TYPO_DESC,
        sTypoLineGap=TYPO_GAP,
        usWinAscent=WIN_ASC,
        usWinDescent=WIN_DESC,
        sCapHeight=cap_height,
        sxHeight=cap_height,
        usWeightClass=weight_class,
        usWidthClass=3,                     # condensed
        fsType=0,                           # installable, no embedding limits
        fsSelection=(1 << 5) | (1 << 7) if style == "Bold" else (1 << 6) | (1 << 7),
        panose=dict(
            bFamilyType=2,
            bSerifStyle=11,
            bWeight=8 if style == "Bold" else 5,
            bProportion=6,
            bContrast=2,
            bStrokeVariation=0,
            bArmStyle=0,
            bLetterForm=0,
            bMidline=0,
            bXHeight=0,
        ),
        achVendID="NONE",
    )
    fb.setupPost(isFixedPitch=0, underlinePosition=-150, underlineThickness=round(0.13 * CAP))
    fb.font["head"].macStyle = 1 if style == "Bold" else 0
    fb.font["head"].fontRevision = float(VERSION)
    return fb.font


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(stroke.ROOT, "dist")
    for style, (weight, _cls, _s) in WEIGHTS.items():
        otf, ttf, woff, ink = build_one(style, weight, out_dir)
        print("%-8s w=%.2f  ink y %d..%d" % (style, weight, ink[0], ink[1]))
        for p in (otf, ttf, woff):
            if p:
                print("          %s  %d bytes" % (os.path.basename(p), os.path.getsize(p)))


if __name__ == "__main__":
    main()
