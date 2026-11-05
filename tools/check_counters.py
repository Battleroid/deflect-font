"""Report which counters survive at which bitmap size.

A monoline design has a hard limit: the stroke is a fixed fraction of the cap height,
so a glyph needing two counters across its width runs out of room as the weight goes
up and the size comes down. This counts the enclosed background regions in each
rendered glyph, and how many pixels they hold, so the README can state where that
happens instead of guessing.

    python tools/check_counters.py [glyphs]

With no argument it checks the glyphs that are tight by construction. A count of 0
means the glyph has filled in solid; a count higher than the design's own counters
means snapping has pinched one region into several, which is cosmetic.
"""

import sys
from collections import deque

import bitmap
import build_bitmap as B
import stroke
from stroke import WEIGHTS

TIGHT = "@$&?%°08"          # the ones worth watching
EXPECTED = {"@": 2, "$": 2, "&": 2, "?": 0, "%": 0, "°": 1, "0": 2, "8": 2}


def counters(raster):
    """(number of enclosed background regions, total pixels in them)."""
    grid = raster.bits
    h = len(grid)
    w = len(grid[0]) if h else 0
    if not h:
        return 0, 0
    seen = [[False] * w for _ in range(h)]
    queue = deque()

    def flood():
        while queue:
            y, x = queue.popleft()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                a, b = y + dy, x + dx
                if 0 <= a < h and 0 <= b < w and not seen[a][b] and not grid[a][b]:
                    seen[a][b] = True
                    queue.append((a, b))
                    yield None

    for y in range(h):                       # seed from the border: outside ink
        for x in (0, w - 1):
            if not grid[y][x] and not seen[y][x]:
                seen[y][x] = True
                queue.append((y, x))
    for x in range(w):
        for y in (0, h - 1):
            if not grid[y][x] and not seen[y][x]:
                seen[y][x] = True
                queue.append((y, x))
    list(flood())

    regions = pixels = 0
    for y in range(h):
        for x in range(w):
            if not grid[y][x] and not seen[y][x]:
                regions += 1
                seen[y][x] = True
                queue.append((y, x))
                before = len(queue)
                count = 0
                while queue:
                    cy, cx = queue.popleft()
                    count += 1
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        a, b = cy + dy, cx + dx
                        if 0 <= a < h and 0 <= b < w and not seen[a][b] and not grid[a][b]:
                            seen[a][b] = True
                            queue.append((a, b))
                pixels += count
                del before
    return regions, pixels


def main():
    chars = sys.argv[1] if len(sys.argv) > 1 else TIGHT
    caps = sorted({c for v in B.CAPS.values() for c in v})
    print("enclosed counters per glyph: regions/pixels  (0 = filled in solid)")
    print("%-11s %-8s %s" % ("glyph", "style", "  ".join("cap%-2d" % c for c in caps)))
    for ch in chars:
        name = stroke.glyph_name(ch)
        for style in ("Regular", "Bold"):
            cells = []
            for cap in caps:
                if cap not in B.CAPS[style]:
                    cells.append("  -   ")
                    continue
                size = bitmap.Size(cap, WEIGHTS[style][0])
                n, px = counters(bitmap.render(name, size))
                flag = "!" if n == 0 and EXPECTED.get(ch, 0) else " "
                cells.append("%d/%-3d%s" % (n, px, flag))
            # print the glyph name, not the character: consoles here are cp1252
            print("%-11s %-8s %s" % (name, style, " ".join(cells)))
    print("\n'!' marks a glyph whose counters have closed up at that size.")
    print("Expected: " + ", ".join(
        "%s=%d" % (stroke.glyph_name(c), EXPECTED[c]) for c in chars if c in EXPECTED))


if __name__ == "__main__":
    main()
