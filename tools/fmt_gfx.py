"""Write an Adafruit_GFX font header.

Understood by Adafruit_GFX, TFT_eSPI, LovyanGFX and Arduino_GFX, so this one header
covers most colour TFTs on an ESP32. Layout, per Adafruit_GFX's drawChar():

  * glyph bitmaps are one continuous MSB-first bit stream with no padding between
    rows, and each glyph starts on a byte boundary;
  * GFXglyph is {bitmapOffset, width, height, xAdvance, xOffset, yOffset}, with
    yOffset measured down from the baseline to the top of the box (so negative);
  * the glyph array must be contiguous over `first`..`last`, so codes the design has
    no glyph for get an empty entry that advances like a space.

Lowercase entries point at the uppercase bitmaps rather than copying them: the design
is all caps, and this costs six bytes per letter instead of a second alphabet.
"""

FIRST, LAST = 0x20, 0x7E


def write(path, ident, rasters, by_code, y_advance, cap, stroke_px, note):
    """`by_code`: codepoint -> glyph name, for codepoints in FIRST..LAST."""
    data = bytearray()
    offsets = {}
    for name in sorted({n for n in by_code.values()}):
        r = rasters[name]
        if not r.w:
            continue
        offsets[name] = len(data)
        bits, acc, nbits = [], 0, 0
        for row in r.bits:
            for b in row:
                acc = (acc << 1) | b
                nbits += 1
                if nbits == 8:
                    bits.append(acc)
                    acc, nbits = 0, 0
        if nbits:
            bits.append(acc << (8 - nbits))
        data.extend(bits)

    space = rasters[by_code[0x20]]
    rows = []
    for cp in range(FIRST, LAST + 1):
        name = by_code.get(cp)
        if name is None:
            rows.append((0, 0, 0, space.advance, 0, 0, "(none)"))
            continue
        r = rasters[name]
        if not r.w:
            rows.append((0, 0, 0, r.advance, 0, 0, name))
        else:
            rows.append((offsets[name], r.w, r.h, r.advance, r.xoff,
                         -(r.yoff + r.h), name))

    out = []
    w = out.append
    guard = "_%s_H_" % ident.upper()
    w("// %s" % note)
    w("// Adafruit_GFX font. Capital height %d px (ink included), stroke %d px," % (cap, stroke_px))
    w("// line advance %d px. Draw with: tft.setFont(&%s);" % (y_advance, ident))
    w("#ifndef %s" % guard)
    w("#define %s" % guard)
    w("")
    w("#include <stdint.h>")
    w("#ifdef __AVR__")
    w("#include <avr/pgmspace.h>")
    w("#elif defined(ESP8266) || defined(ESP32)")
    w("#include <pgmspace.h>")
    w("#endif")
    w("#ifndef PROGMEM")
    w("#define PROGMEM")
    w("#endif")
    w("#ifndef _GFXFONT_H_")
    w("#include <gfxfont.h>")
    w("#endif")
    w("")
    w("const uint8_t %sBitmaps[] PROGMEM = {" % ident)
    for i in range(0, len(data), 12):
        w("    " + " ".join("0x%02X," % b for b in data[i:i + 12]))
    w("};")
    w("")
    w("const GFXglyph %sGlyphs[] PROGMEM = {" % ident)
    for cp, (off, gw, gh, adv, dx, dy, name) in zip(range(FIRST, LAST + 1), rows):
        w("    {%5d, %3d, %3d, %3d, %4d, %4d},   // 0x%02X %s"
          % (off, gw, gh, adv, dx, dy, cp, _label(cp, name)))
    w("};")
    w("")
    w("const GFXfont %s PROGMEM = {" % ident)
    w("    (uint8_t *)%sBitmaps," % ident)
    w("    (GFXglyph *)%sGlyphs," % ident)
    w("    0x%02X, 0x%02X, %d};" % (FIRST, LAST, y_advance))
    w("")
    w("// Approx. %d bytes" % (len(data) + 7 * (LAST - FIRST + 1) + 7))
    w("#endif  // %s" % guard)
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")
    return len(data) + 7 * (LAST - FIRST + 1)


def _label(cp, name):
    if name == "(none)":
        return "(not in this design -- blank)"
    ch = chr(cp)
    return "'%s'" % ch if ch.isprintable() and ch != " " else name
