"""Draw overview.png: the specimen that heads the README.

Type only -- no labels, no measurements, no captions. Three lines set to the full
measure, then the three places the lettering came from: a data plate, a turret
number and a bridge class disc. Everything is drawn with the built OTF, so the
picture is the deliverable rather than a mock-up of it.

    python tools/overview.py [out_dir] [dist_dir]
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

import stroke
from stroke import UPM

SS = 2                      # supersample, then downsample for clean edges
W, H = 1600, 1000
MARGIN = 72
MEASURE = W - 2 * MARGIN

PAPER = (237, 235, 224)
INK = (24, 24, 24)
PLATE = (71, 77, 61)
PLATE_INK = (228, 223, 203)
TURRET = (92, 107, 61)
TURRET_INK = (236, 236, 223)
DISC_RING = (18, 18, 18)
DISC = (233, 190, 26)

CENTRE_CAP = 700 / UPM      # cap height to the stroke centre line, as a fraction of the em

LINES = [
    ("Regular", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    ("Regular", "0123456789 & $ @ # % ? ! ° ×"),
    ("Bold", "TANK, COMBAT, FULL TRACKED"),
]


def font_for(dist, style, size):
    return ImageFont.truetype(
        os.path.join(dist, "otf", "DeflectStencil-%s.otf" % style), max(1, int(size))
    )


def fit(dist, style, text, measure):
    """The em size at which `text` is exactly `measure` wide."""
    probe = font_for(dist, style, 200)
    width = probe.getlength(text)
    return int(200 * measure / width)


def cap_text(d, dist, style, text, x, baseline, size, fill, anchor="ls"):
    d.text((x, baseline), text, font=font_for(dist, style, size), fill=fill, anchor=anchor)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else stroke.ROOT
    dist = sys.argv[2] if len(sys.argv) > 2 else os.path.join(stroke.ROOT, "dist")

    img = Image.new("RGB", (W * SS, H * SS), PAPER)
    d = ImageDraw.Draw(img)
    m = MARGIN * SS
    measure = MEASURE * SS

    y = 96 * SS
    for style, text in LINES:
        size = fit(dist, style, text, measure)
        cap = size * CENTRE_CAP
        y += cap
        cap_text(d, dist, style, text, m, y, size, INK)
        y += 0.52 * cap

    # --- the three places it came from ----------------------------------
    y = int(y + 52 * SS)
    box_h = 212 * SS
    plate_w = 690 * SS
    turret_w = 330 * SS
    gap = 42 * SS

    # data plate
    x0 = m
    d.rounded_rectangle([x0, y, x0 + plate_w, y + box_h], radius=10 * SS, fill=PLATE)
    size = fit(dist, "Regular", "TANK, COMBAT, FULL TRACKED", plate_w - 90 * SS)
    cap = size * CENTRE_CAP
    cx = x0 + plate_w / 2
    cap_text(d, dist, "Regular", "TANK, COMBAT, FULL TRACKED",
             cx, y + box_h / 2 - 0.30 * box_h + cap / 2, size, PLATE_INK, anchor="ms")
    # the three lines sit at -0.30 / 0 / +0.30 of the box, so the leading is even
    # and the margins above and below the block match
    size2 = fit(dist, "Regular", "SERIAL 22-0417   WT 42.1 T", plate_w - 90 * SS)
    cap2 = size2 * CENTRE_CAP
    cap_text(d, dist, "Regular", "SERIAL 22-0417   WT 42.1 T",
             cx, y + box_h / 2 + cap2 / 2, size2, PLATE_INK, anchor="ms")
    size3 = fit(dist, "Regular", "HALON 1301   CTG CAL .50", plate_w - 90 * SS)
    cap3 = size3 * CENTRE_CAP
    cap_text(d, dist, "Regular", "HALON 1301   CTG CAL .50",
             cx, y + box_h / 2 + 0.30 * box_h + cap3 / 2, size3, PLATE_INK, anchor="ms")

    # turret number
    x1 = x0 + plate_w + gap
    d.rounded_rectangle([x1, y, x1 + turret_w, y + box_h], radius=5 * SS, fill=TURRET)
    size = int(box_h * 0.66 / CENTRE_CAP)
    cap_text(d, dist, "Regular", "22", x1 + turret_w / 2,
             y + box_h / 2 + size * CENTRE_CAP / 2, size, TURRET_INK, anchor="ms")

    # bridge class disc
    r = box_h / 2
    cxx = x1 + turret_w + gap + r
    d.ellipse([cxx - r, y, cxx + r, y + box_h], fill=DISC_RING)
    d.ellipse([cxx - r * 0.92, y + r * 0.08, cxx + r * 0.92, y + box_h - r * 0.08], fill=DISC)
    size = fit(dist, "Bold", "52", r * 1.3)      # fit the chord, not the diameter
    cap_text(d, dist, "Bold", "52", cxx, y + box_h / 2 + size * CENTRE_CAP / 2,
             size, (14, 14, 14), anchor="ms")

    bottom = y + box_h + 90 * SS
    img = img.crop((0, 0, W * SS, int(bottom)))
    img = img.resize((W, int(bottom / SS)), Image.LANCZOS)
    path = os.path.join(out_dir, "overview.png")
    img.save(path)
    print("%s  %dx%d" % (path, img.width, img.height))
    return path


if __name__ == "__main__":
    main()
