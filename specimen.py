"""Specimen sheets of Deflect's stroke font, drawn with the game's own texture rasteriser
(reference/lib, copied from deflect/art/blender/lib). Run: python specimen.py [out_dir]."""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "reference"))
from lib import font, raster  # noqa: E402

OUT = sys.argv[1] if len(sys.argv) > 1 else HERE
os.makedirs(OUT, exist_ok=True)
PAPER = (0.93, 0.92, 0.88, 1)
INK = (0.1, 0.1, 0.1, 1)
GREY = (0.45, 0.45, 0.43, 1)
RED = (0.75, 0.15, 0.1, 1)

# --- Sheet 1: the glyph set, the weights the textures use, slant, seven segments, in use ---
W, H = 1800, 1480
c = raster.Canvas(W, H, PAPER)
y = 70
c.text(40, y, "DEFLECT STROKE FONT - SPECIMEN (CAP HEIGHT 6 UNITS, MONOLINE, ROUND CAPS)", 22, GREY, weight=0.13)
y += 90
glyphs = list(font.GLYPHS.keys())
rows = ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ", "0123456789", "".join(g for g in glyphs if not g.isalnum() and g != " ")]
for row in rows:
    c.text(40, y, " ".join(row), 64, INK, weight=0.13)
    y += 110
y += 10
c.text(40, y, "WEIGHT (STROKE WIDTH / CAP HEIGHT):", 22, GREY)
y += 70
for weight in (0.10, 0.13, 0.15, 0.17, 0.22):
    c.text(40, y, "%.2f" % weight, 30, GREY)
    c.text(200, y, "CTG CAL .50  100 LINKED  HALON 1301", 44, INK, weight=weight)
    y += 66
y += 10
c.text(40, y, "SLANT 0.18:", 22, GREY)
c.text(260, y + 4, "RECEIVER-TRANSMITTER RT-524/VRC", 44, INK, weight=0.13, slant=0.18)
y += 80
c.text(40, y, "SPACING 0.6 / 1.0 / 1.6:", 22, GREY)
x = 460
for spacing in (0.6, 1.0, 1.6):
    x += c.text(x, y, "FIRE", 44, INK, weight=0.13, spacing=spacing) + 60
y += 80
c.text(40, y, "SEVEN-SEGMENT TABLE:", 22, GREY)
c.rect(460, y - 58, 1410, y + 16, (0.08, 0.06, 0.05, 1), radius=6)
c.seg7(480, y - 48, 54, "0123456789", (1.0, 0.25, 0.12, 1), off=(0.22, 0.08, 0.06, 1))
c.seg7(1090, y - 48, 54, "-EHPACL", (1.0, 0.25, 0.12, 1), off=(0.22, 0.08, 0.06, 1))
y += 60
c.text(40, y + 20, "IN USE (DATA PLATE, TURRET NUMBER, BRIDGE CLASS DISC):", 22, GREY)
y += 50
# In use: a data plate and a stencil, as the textures paint them.
c.rect(40, y, 760, y + 150, (0.28, 0.3, 0.24, 1), radius=8)
c.text(400, y + 50, "TANK, COMBAT, FULL TRACKED", 26, (0.9, 0.88, 0.8, 1), weight=0.15, align="center", valign="middle")
c.text(400, y + 100, "SERIAL 22-0417  WT 42.1 T", 26, (0.9, 0.88, 0.8, 1), weight=0.15, align="center", valign="middle")
c.rect(800, y, 1180, y + 150, (0.36, 0.42, 0.24, 1), radius=4)
c.text(990, y + 75, "22", 110, (0.93, 0.93, 0.88, 1), weight=0.16, align="center", valign="middle")
c.circle(1300, y + 75, 72, (0.08, 0.08, 0.08, 1))
c.circle(1300, y + 75, 66, (0.92, 0.75, 0.1, 1))
c.text(1300, y + 75, "52", 52, (0.05, 0.05, 0.05, 1), weight=0.17, align="center", valign="middle")
raster.save_png(os.path.join(OUT, "specimen.png"), c.px, alpha=False)

# --- Sheet 2: construction on the unit grid (points of each polyline, width box, gap) ---
CELL = 30  # pixels per unit
cols = 9
names = [g for g in glyphs if g != " "]
cell_w = 6.0 * CELL
cell_h = 9.0 * CELL
rows_n = (len(names) + cols - 1) // cols
c = raster.Canvas(int(cols * cell_w + 80), int(rows_n * cell_h + 120), PAPER)
c.text(40, 60, "CONSTRUCTION: UNITS ON A GRID, BASELINE Y=0, CAP HEIGHT Y=6, Y UP. RED = ADVANCE WIDTH (THEN A GAP OF 1.3)", 18, GREY)
for i, ch in enumerate(names):
    col, row = i % cols, i // cols
    ox = 40 + col * cell_w + 0.6 * CELL
    base = 120 + row * cell_h + 7.2 * CELL  # baseline in pixels (y down)
    width, strokes = font.GLYPHS[ch]
    for gx in range(0, 6):
        c.line(ox + gx * CELL, base - 6.6 * CELL, ox + gx * CELL, base + 0.9 * CELL, 1, (0.82, 0.81, 0.77, 1))
    for gy in range(-1, 7):
        c.line(ox - 0.3 * CELL, base - gy * CELL, ox + 5.3 * CELL, base - gy * CELL, 1, (0.82, 0.81, 0.77, 1) if gy not in (0, 6) else (0.6, 0.6, 0.58, 1))
    c.line(ox + width * CELL, base - 6.6 * CELL, ox + width * CELL, base + 0.9 * CELL, 2, RED)
    pts = [[(ox + px * CELL, base - py * CELL) for px, py in s] for s in strokes]
    c.strokes(pts, 0.13 * 6 * CELL, (0.1, 0.1, 0.1, 0.55))
    c.strokes(pts, 2, INK)
    for s in pts:
        for p in s:
            c.circle(p[0], p[1], 3.5, RED)
    c.text(ox - 0.4 * CELL, base - 7.0 * CELL, ch if ch != " " else "SPACE", 18, GREY)
raster.save_png(os.path.join(OUT, "construction.png"), c.px, alpha=False)
print("ok")
