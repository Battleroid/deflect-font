"""Proof sheets for the built fonts.

    python tools/proof.py [out_dir] [dist_dir]

proof-vector.png  the OTF/TTF glyph set and weights, plus an A/B against the game's
                  own rasteriser with the difference shown underneath.
proof-bitmap.png  every bitmap size at 1:1 and magnified, so the pixels are visible.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

import bitmap
import build_bitmap as B
import stroke
from stroke import UPM, WEIGHTS

sys.path.insert(0, os.path.join(stroke.ROOT, "reference"))
from lib import raster as game_raster  # noqa: E402

PAPER = (238, 236, 227)
INK = (26, 26, 26)
GREY = (120, 118, 112)
RED = (190, 40, 26)
BLUE = (30, 70, 150)

SAMPLES = [
    "CTG CAL .50  100 LINKED",
    "TANK, COMBAT, FULL TRACKED",
    "SERIAL 22-0417  WT 42.1 T",
]


def ui(sz=15):
    for name in ("consola.ttf", "cour.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, sz)
        except OSError:
            continue
    return ImageFont.load_default()


def ab_pair(path, text, cap_px, weight, width, height, baseline, x0):
    """Draw `text` twice -- once with the game's rasteriser, once from the built font
    -- putting each glyph at the same whole-pixel pen position in both.

    Letting either side run its own line layout would compare spacing, not shapes:
    FreeType rounds every advance to a whole pixel and the em size to an integer, so
    a long line drifts by a pixel or so per word. Placing glyph by glyph takes that
    out and leaves only the difference in the letterforms themselves, which is what
    this is for. (The font also splits the gap into two side bearings where the
    game's pen has none, so the game's x is nudged right by half a gap.)
    """
    size = round(cap_px / (700 / UPM))
    f = ImageFont.truetype(path, size)
    bearing = stroke.SIDE * cap_px / 6.0
    game = game_raster.Canvas(width, height, (0, 0, 0, 1))
    img = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(img)
    pen = float(x0)
    for ch in text:
        game.text(pen + bearing, baseline, ch, cap_px, (1, 1, 1, 1), weight=weight)
        draw.text((round(pen), baseline), ch, font=f, fill=255, anchor="ls")
        pen += f.getlength(ch)
    px = np.asarray(game.px, dtype=float)
    return (px[:, :, 0] if px.ndim == 3 else px), np.asarray(img, dtype=float) / 255.0


def vector_sheet(out_dir, dist):
    rows = [
        "ABCDEFGHIJKLM", "NOPQRSTUVWXYZ", "0123456789",
        "- . , : ; / \\ + = < > ( ) [ ] { } |",
        "! ? ' \" # $ % & * @ ^ ~ ` _ ° × ↑",
    ]
    W, H = 1800, 1120
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    small, tiny = ui(16), ui(13)

    reg = os.path.join(dist, "otf", "DeflectStencil-Regular.otf")
    bold = os.path.join(dist, "otf", "DeflectStencil-Bold.otf")
    # The game's `size` is the cap height measured to the stroke's centre line, and
    # that is where this font puts 700/1000, so this ratio makes the two comparable.
    CENTRE_CAP = 700 / UPM   # the game measures cap height to the stroke centre

    d.text((40, 30), "DEFLECT STENCIL - VECTOR PROOF (OTF/CFF; the TTF is identical)",
           font=small, fill=GREY)
    y = 70
    for i, row in enumerate(rows):
        px = 64 if i < 3 else 48
        f = ImageFont.truetype(reg, round(px / CENTRE_CAP))
        d.text((40, y + px), " ".join(row) if i < 3 else row, font=f, fill=INK, anchor="ls")
        y += px + 28
    y += 6
    d.text((40, y), "REGULAR 0.13 / BOLD 0.22, SAME VERTICAL METRICS", font=small, fill=GREY)
    y += 26
    for path, style in ((reg, "Regular"), (bold, "Bold")):
        f = ImageFont.truetype(path, round(44 / CENTRE_CAP))
        d.text((40, y + 44), SAMPLES[0] + "   HALON 1301", font=f, fill=INK, anchor="ls")
        y += 64
    y += 16

    # ---- A/B against the game's rasteriser ------------------------------
    d.text((40, y), "A/B AGAINST THE GAME'S OWN RASTERISER (reference/lib/raster.py)",
           font=small, fill=GREY)
    y += 28
    strip_h = 70
    for style, path, weight in (("Regular", reg, 0.13), ("Bold", bold, 0.22)):
        text = SAMPLES[1]
        cap_px = 46
        sw, sh, base, x0 = 1500, strip_h, 56, 10
        a, b = ab_pair(path, text, cap_px, weight, sw, sh, base, x0)
        diff = np.abs(a - b)
        for label, arr, colour in (
            ("game", a, INK), ("font", b, BLUE), ("difference x4", diff * 4.0, RED)
        ):
            d.text((40, y + 20), "%s %s" % (style.lower(), label), font=tiny, fill=GREY)
            layer = np.clip(arr, 0, 1)[:, :, None]
            tile = (np.array(PAPER) * (1 - layer) + np.array(colour) * layer)
            img.paste(Image.fromarray(tile.astype("uint8")), (230, y))
            y += strip_h - 16
        y += 10
    d.text((40, H - 34),
           "the difference row is the absolute difference, multiplied by four: "
           "what is left is antialiasing on the outline edge only.",
           font=tiny, fill=GREY)
    path = os.path.join(out_dir, "proof-vector.png")
    img.save(path)
    return path


def strip(rasters, text, asc, desc):
    """Render a line of text at 1:1 into an L-mode image; baseline at row `asc`."""
    codes = B.code_map()
    glyphs = [rasters[codes[ord(ch)]] for ch in text.upper() if ord(ch) in codes]
    width = max(1, sum(g.advance for g in glyphs))
    img = Image.new("L", (width, asc + desc), 0)
    px = img.load()
    pen = 0
    for g in glyphs:
        for j, row in enumerate(g.bits):
            y = asc - (g.yoff + g.h) + j
            for i, b in enumerate(row):
                if b and 0 <= y < img.height and 0 <= pen + g.xoff + i < width:
                    px[pen + g.xoff + i, y] = 255
        pen += g.advance
    return img


def tint(mask, colour):
    a = np.asarray(mask, dtype=float)[:, :, None] / 255.0
    return Image.fromarray(
        (np.array(PAPER) * (1 - a) + np.array(colour) * a).astype("uint8")
    )


def bitmap_sheet(out_dir):
    full = "DEFLECT 22-0417 @ 23°C ?"
    short = "DEFLECT 22"             # the magnified column, kept narrow enough to fit
    entries = [(s, c) for s in ("Regular", "Bold") for c in B.CAPS[s]]
    tiny, small = ui(13), ui(16)
    zoom, W, pad = 3, 1800, 16
    x_label, x_1to1, x_zoom = 40, 330, 860
    blocks = []
    for style, cap in entries:
        _size, rasters = B.render_size(style, cap)
        asc, desc, line = B.line_metrics(cap)
        blocks.append((style, cap, rasters, asc, desc, line,
                       strip(rasters, full, asc, desc),
                       strip(rasters, short, asc, desc)))
    H = 78 + sum(max(26, b[7].height * zoom) + pad for b in blocks)
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    d.text((40, 22), "DEFLECT STENCIL - BITMAP PROOF: every size at 1:1, then magnified x3.",
           font=small, fill=GREY)
    d.text((40, 46), "cap is the capital height in pixels, ink included; stroke, ascent, "
                     "descent and line advance are what the generated fonts declare.",
           font=tiny, fill=GREY)
    y = 78
    for style, cap, rasters, asc, desc, line, s1, s3 in blocks:
        stroke_px = bitmap.Size(cap, WEIGHTS[style][0]).stroke
        row_h = max(26, s3.height * zoom)
        d.text((x_label, y + row_h // 2 - 7),
               "%-7s cap %2d  stroke %d  asc %2d desc %d  line %2d"
               % (style, cap, stroke_px, asc, desc, line), font=tiny, fill=GREY)
        s1 = s1.crop((0, 0, min(s1.width, x_zoom - x_1to1 - 30), s1.height))
        img.paste(tint(s1, INK), (x_1to1, y + row_h // 2 - s1.height // 2))
        big = s3.resize((s3.width * zoom, s3.height * zoom), Image.NEAREST)
        big = big.crop((0, 0, min(big.width, W - x_zoom - 40), big.height))
        img.paste(tint(big, INK), (x_zoom, y))
        y += row_h + pad
    path = os.path.join(out_dir, "proof-bitmap.png")
    img.save(path)
    return path


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else stroke.ROOT
    dist = sys.argv[2] if len(sys.argv) > 2 else os.path.join(stroke.ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    print(vector_sheet(out_dir, dist))
    print(bitmap_sheet(out_dir))


if __name__ == "__main__":
    main()
