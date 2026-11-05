"""Read back every bitmap font that was written and check it pixel for pixel.

Nothing here trusts the emitters: each file is parsed off disk the way the target
library parses it (u8g2's run-length bit stream, Adafruit's packed glyph stream,
LVGL's cmap lookup plus bit stream, BDF's hex rows) and compared to a fresh render
of the design. Advances, bounding boxes and every pixel have to agree.

    python tools/verify_bitmap.py [dist_dir]
"""

import os
import re
import sys

import bitmap
import build_bitmap as B
import fmt_gfx
import fmt_u8g2
import stroke


# --- little C parsers --------------------------------------------------------

def c_array_bytes(text, name):
    m = re.search(r"\b%s\s*(?:\[[^\]]*\])?[^={;]*=\s*\{(.*?)\n\};" % re.escape(name),
                  text, re.S)
    if not m:
        raise SystemExit("array %s not found" % name)
    body = re.sub(r"/\*.*?\*/", " ", m.group(1), flags=re.S)
    return bytes(int(v, 16) for v in re.findall(r"0x([0-9A-Fa-f]{2})", body))


def unpack(data, offset, w, h):
    """MSB-first, rows run on, glyph starts on a byte boundary."""
    rows, bit = [], 0
    for _ in range(h):
        row = []
        for _ in range(w):
            byte = data[offset + (bit >> 3)]
            row.append((byte >> (7 - (bit & 7))) & 1)
            bit += 1
        rows.append(row)
    return rows


def expected(style, cap):
    _size, rasters = B.render_size(style, cap)
    return rasters


def fail(where, msg):
    print("  FAIL %-22s %s" % (where, msg))
    return 1


# --- per-format checks -------------------------------------------------------

def check_bdf(path, rasters, codes):
    text = open(path, encoding="ascii").read()
    bad, cur, seen = 0, None, {}
    names = []
    for line in text.splitlines():
        tok = line.split()
        if not tok:
            continue
        if tok[0] == "STARTCHAR":
            cur = {"rows": []}
            names.append(tok[1])
        elif cur is None:
            continue
        elif tok[0] == "ENCODING":
            cur["enc"] = int(tok[1])
        elif tok[0] == "DWIDTH":
            cur["dw"] = int(tok[1])
        elif tok[0] == "BBX":
            cur["bbx"] = tuple(int(v) for v in tok[1:5])
        elif tok[0] == "BITMAP":
            cur["reading"] = True
        elif tok[0] == "ENDCHAR":
            seen[cur["enc"]] = cur
            cur = None
        elif cur.get("reading") and re.fullmatch(r"[0-9A-Fa-f]+", tok[0]):
            cur["rows"].append(tok[0])

    if len(set(names)) != len(names):
        dupes = sorted({n for n in names if names.count(n) > 1})
        bad += fail("bdf", "STARTCHAR names repeat: %s" % ", ".join(dupes))
    if len(seen) != len(codes):
        bad += fail("bdf", "%d chars encoded, want %d" % (len(seen), len(codes)))

    for cp, name in codes.items():
        r = rasters[name]
        g = seen.get(cp)
        if g is None:
            bad += fail("bdf", "U+%04X missing" % cp)
            continue
        if g["dw"] != r.advance:
            bad += fail("bdf", "U+%04X advance %d != %d" % (cp, g["dw"], r.advance))
        if not r.w:
            continue
        if g["bbx"] != (r.w, r.h, r.xoff, r.yoff):
            bad += fail("bdf", "U+%04X bbx %s != %s" % (cp, g["bbx"], (r.w, r.h, r.xoff, r.yoff)))
            continue
        nb = (r.w + 7) // 8
        rows = [[(int(h, 16) >> (nb * 8 - 1 - i)) & 1 for i in range(r.w)]
                for h in g["rows"]]
        if rows != r.bits:
            bad += fail("bdf", "U+%04X pixels differ" % cp)
    return bad


def check_gfx(path, ident, rasters, codes):
    text = open(path, encoding="ascii").read()
    data = c_array_bytes(text, "%sBitmaps" % ident)
    m = re.search(r"%sGlyphs\[\][^=]*=\s*\{(.*?)\n\};" % ident, text, re.S)
    entries = re.findall(r"\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\}",
                         m.group(1))
    bad = 0
    if len(entries) != fmt_gfx.LAST - fmt_gfx.FIRST + 1:
        return fail("gfx", "%d entries, want %d" % (len(entries), fmt_gfx.LAST - fmt_gfx.FIRST + 1))
    for i, e in enumerate(entries):
        cp = fmt_gfx.FIRST + i
        off, gw, gh, adv, dx, dy = (int(v) for v in e)
        name = codes.get(cp)
        if name is None:                       # blank filler for a code we lack
            if gw or gh:
                bad += fail("gfx", "U+%04X should be blank" % cp)
            continue
        r = rasters[name]
        if adv != r.advance:
            bad += fail("gfx", "U+%04X advance %d != %d" % (cp, adv, r.advance))
        if not r.w:
            continue
        if (gw, gh, dx, dy) != (r.w, r.h, r.xoff, -(r.yoff + r.h)):
            bad += fail("gfx", "U+%04X box %s" % (cp, (gw, gh, dx, dy)))
            continue
        if unpack(data, off, gw, gh) != r.bits:
            bad += fail("gfx", "U+%04X pixels differ" % cp)
    return bad


def check_lvgl(path, rasters, codes):
    text = open(path, encoding="ascii").read()
    data = c_array_bytes(text, "glyph_bitmap")
    dsc = [
        tuple(int(v) for v in g)
        for g in re.findall(
            r"\{\.bitmap_index = (-?\d+), \.adv_w = (-?\d+), \.box_w = (-?\d+), "
            r"\.box_h = (-?\d+), \.ofs_x = (-?\d+), \.ofs_y = (-?\d+)\}", text)
    ]
    ofs_list = [int(v) for v in re.findall(
        r"glyph_id_ofs_list_0\[\] = \{(.*?)\};", text, re.S)[0].replace("\n", " ").split(",") if v.strip()]
    cmaps = re.findall(
        r"\.range_start = (\d+), \.range_length = (\d+), \.glyph_id_start = (\d+),"
        r".*?\.type = (LV_FONT_FMT_TXT_CMAP_\w+)", text, re.S)

    def gid(cp):
        for start, length, id_start, kind in cmaps:
            start, length, id_start = int(start), int(length), int(id_start)
            if not start <= cp < start + length:
                continue
            if kind.endswith("FORMAT0_FULL"):
                return id_start + ofs_list[cp - start]
            return id_start + (cp - start)
        return 0

    bad = 0
    for cp, name in codes.items():
        r = rasters[name]
        g = gid(cp)
        if g == 0:
            bad += fail("lvgl", "U+%04X not found by the cmap" % cp)
            continue
        idx, adv, bw, bh, ox, oy = dsc[g]
        if adv != r.advance * 16:
            bad += fail("lvgl", "U+%04X adv_w %d != %d" % (cp, adv, r.advance * 16))
        if not r.w:
            continue
        if (bw, bh, ox, oy) != (r.w, r.h, r.xoff, r.yoff):
            bad += fail("lvgl", "U+%04X box %s != %s" % (cp, (bw, bh, ox, oy), (r.w, r.h, r.xoff, r.yoff)))
            continue
        if unpack(data, idx, bw, bh) != r.bits:
            bad += fail("lvgl", "U+%04X pixels differ" % cp)
    # a codepoint the design has no glyph for must resolve to id 0, so LVGL falls
    # back rather than drawing something arbitrary
    if gid(0x00BF) != 0:
        bad += fail("lvgl", "U+00BF resolves to a glyph but the design has none")
    return bad


def check_u8g2(text, ident, rasters, codes):
    data = c_array_bytes(text, ident)
    info = fmt_u8g2.read_info(data)
    bad = 0
    for cp, name in codes.items():
        if cp > 0xFF:
            continue
        r = rasters[name]
        got = fmt_u8g2.decode_glyph(data, info, cp)
        if got is None:
            bad += fail("u8g2", "U+%04X missing" % cp)
            continue
        grid, w, h, x, y, d = got
        if d != r.advance:
            bad += fail("u8g2", "U+%04X advance %d != %d" % (cp, d, r.advance))
        if not r.w:
            continue
        if (w, h, x, y) != (r.w, r.h, r.xoff, r.yoff) or grid != r.bits:
            bad += fail("u8g2", "U+%04X differs" % cp)
    if fmt_u8g2.find_glyph(data, info, 0x00BF) is not None:
        bad += fail("u8g2", "U+00BF present but the design has no such glyph")
    return bad


def main():
    dist = sys.argv[1] if len(sys.argv) > 1 else os.path.join(stroke.ROOT, "dist")
    u8g2_text = open(os.path.join(dist, "u8g2", "deflect_stencil_u8g2.c"), encoding="ascii").read()
    all_codes = B.code_map()
    ascii_codes = {c: n for c, n in all_codes.items() if 0x20 <= c <= 0x7E}

    total = 0
    for style in ("Regular", "Bold"):
        for cap in B.CAPS[style]:
            rasters = expected(style, cap)
            bad = 0
            bad += check_bdf(
                os.path.join(dist, "bdf", "DeflectStencil-%s-%d.bdf" % (style, cap)),
                rasters, all_codes)
            gid = B.gfx_ident(style, cap)
            bad += check_gfx(os.path.join(dist, "gfx", "%s.h" % gid), gid, rasters, ascii_codes)
            lid = B.ident_for(style, cap)
            bad += check_lvgl(os.path.join(dist, "lvgl", "%s.c" % lid), rasters, all_codes)
            bad += check_u8g2(u8g2_text, lid, rasters, all_codes)
            total += bad
            print("%-8s cap %2d  %s" % (style, cap, "OK" if bad == 0 else "%d PROBLEMS" % bad))
    print("\n%s" % ("ALL BITMAP FORMATS VERIFIED" if total == 0 else "%d problems" % total))
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
