"""Write a BDF -- the portable source format the other bitmap tools read.

bdfconv (u8g2), lv_font_conv (LVGL), FontForge, otf2bdf and bitsnpicas all take BDF,
so this is the file to keep if a format we do not emit is needed later.
"""

FOUNDRY = "deflect"
FAMILY = "Deflect Stencil"


def write(path, rasters, codepoints, cap, stroke_px, weight_name, ascent, descent,
          copyright_):
    """`rasters`: name -> Raster. `codepoints`: list of (codepoint, glyph name)."""
    boxes = [r for r in rasters.values() if r.w]
    x0 = min(r.xoff for r in boxes)
    y0 = min(r.yoff for r in boxes)
    x1 = max(r.xoff + r.w for r in boxes)
    y1 = max(r.yoff + r.h for r in boxes)
    px = ascent + descent
    avg = round(
        10 * sum(rasters[n].advance for _c, n in codepoints) / max(1, len(codepoints))
    )

    out = []
    w = out.append
    w("STARTFONT 2.1")
    w("COMMENT %s" % copyright_)
    w("COMMENT Capital height %d px (ink included), stroke %d px." % (cap, stroke_px))
    w("FONT -%s-%s-%s-R-Normal--%d-%d-72-72-P-%d-ISO10646-1"
      % (FOUNDRY, FAMILY.replace(" ", ""), weight_name, px, px * 10, avg))
    w("SIZE %d 72 72" % px)
    w("FONTBOUNDINGBOX %d %d %d %d" % (x1 - x0, y1 - y0, x0, y0))
    props = [
        ('FOUNDRY "%s"' % FOUNDRY),
        ('FAMILY_NAME "%s"' % FAMILY),
        ('WEIGHT_NAME "%s"' % weight_name),
        ('SLANT "R"'),
        ('SETWIDTH_NAME "Normal"'),
        ("PIXEL_SIZE %d" % px),
        ("POINT_SIZE %d" % (px * 10)),
        ("RESOLUTION_X 72"),
        ("RESOLUTION_Y 72"),
        ('SPACING "P"'),
        ("AVERAGE_WIDTH %d" % avg),
        ('CHARSET_REGISTRY "ISO10646"'),
        ('CHARSET_ENCODING "1"'),
        ("FONT_ASCENT %d" % ascent),
        ("FONT_DESCENT %d" % descent),
        ("CAP_HEIGHT %d" % cap),
        ("DEFAULT_CHAR 32"),
        ('COPYRIGHT "%s"' % copyright_),
    ]
    w("STARTPROPERTIES %d" % len(props))
    out.extend(props)
    w("ENDPROPERTIES")
    w("CHARS %d" % len(codepoints))
    for cp, name in codepoints:
        r = rasters[name]
        w("STARTCHAR %s" % _bdf_name(cp, name))
        w("ENCODING %d" % cp)
        w("SWIDTH %d 0" % round(r.advance * 1000.0 / px))
        w("DWIDTH %d 0" % r.advance)
        if r.w:
            w("BBX %d %d %d %d" % (r.w, r.h, r.xoff, r.yoff))
            w("BITMAP")
            nibbles = ((r.w + 7) // 8) * 2
            for row in r.bits:
                value = 0
                for b in row:
                    value = (value << 1) | b
                value <<= (nibbles * 4 - r.w)
                w("%0*X" % (nibbles, value))
        else:
            w("BBX 0 0 0 0")
            w("BITMAP")
        w("ENDCHAR")
    w("ENDFONT")
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")


def _bdf_name(cp, name):
    """A STARTCHAR name, unique per encoding.

    Several codepoints share a glyph -- a-z reuse the capitals and U+00A0 reuses the
    space -- but BDF names have to differ, so the aliases get their own.
    """
    if 0x61 <= cp <= 0x7A:
        return chr(cp)
    if cp > 0x7E:
        return "uni%04X" % cp
    return name
