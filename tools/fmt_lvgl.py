"""Write an LVGL C font (lv_font_fmt_txt, 1 bit per pixel, uncompressed).

The output compiles against LVGL 8 and LVGL 9: the two differ only in a cache field
on lv_font_fmt_txt_dsc_t and in whether lv_font_t is const, both behind #if guards,
and every initialiser is designated, so fields either version lacks stay zero.

Bitmap layout matches what lv_font_fmt_txt expects for bpp 1: box_w * box_h bits per
glyph, MSB first, rows run on with no padding, each glyph starting on a byte boundary.
"""

import textwrap


def _glyph_bits(r):
    out, acc, n = bytearray(), 0, 0
    for row in r.bits:
        for b in row:
            acc = (acc << 1) | b
            n += 1
            if n == 8:
                out.append(acc)
                acc, n = 0, 0
    if n:
        out.append(acc << (8 - n))
    return out


def write(path, ident, rasters, by_code, line_height, base_line, cap, stroke_px, note):
    """`by_code`: codepoint -> glyph name. Codepoints 0x20..0x7E become one
    FORMAT0_FULL cmap; anything outside it gets a one-entry FORMAT0_TINY cmap."""
    names = [n for n in dict.fromkeys(by_code.values())]
    ids = {n: i + 1 for i, n in enumerate(names)}        # id 0 is "not found"

    data = bytearray()
    index = {}
    for n in names:
        index[n] = len(data)
        data.extend(_glyph_bits(rasters[n]))

    ascii_cps = [cp for cp in by_code if 0x20 <= cp <= 0x7E]
    lo, hi = min(ascii_cps), max(ascii_cps)
    ofs_list = [ids.get(by_code.get(cp), 0) for cp in range(lo, hi + 1)]
    extra = sorted(cp for cp in by_code if not (0x20 <= cp <= 0x7E))

    out = []
    w = out.append
    w("/*")
    w(" * %s" % note)
    w(" * LVGL font, 1 bpp. Capital height %d px (ink included), stroke %d px." % (cap, stroke_px))
    w(" * Use with: lv_obj_set_style_text_font(obj, &%s, 0);" % ident)
    w(" */")
    w("")
    w("#ifdef LV_LVGL_H_INCLUDE_SIMPLE")
    w("#include \"lvgl.h\"")
    w("#else")
    w("#include \"lvgl/lvgl.h\"")
    w("#endif")
    w("")
    w("#ifndef %s" % ident.upper())
    w("#define %s 1" % ident.upper())
    w("#endif")
    w("")
    w("#if %s" % ident.upper())
    w("")
    w("/*-----------------")
    w(" *    BITMAPS")
    w(" *----------------*/")
    w("")
    w("static LV_ATTRIBUTE_LARGE_CONST const uint8_t glyph_bitmap[] = {")
    for n in names:
        chunk = _glyph_bits(rasters[n])
        if not chunk:
            w("    /* %s: blank */" % n)
            continue
        w("    /* %s */" % n)
        for i in range(0, len(chunk), 12):
            w("    " + " ".join("0x%02X," % b for b in chunk[i:i + 12]))
    w("};")
    w("")
    w("/*---------------------")
    w(" *  GLYPH DESCRIPTION")
    w(" *--------------------*/")
    w("")
    w("static const lv_font_fmt_txt_glyph_dsc_t glyph_dsc[] = {")
    w("    {.bitmap_index = 0, .adv_w = 0, .box_w = 0, .box_h = 0, .ofs_x = 0, .ofs_y = 0},")
    for n in names:
        r = rasters[n]
        w("    {.bitmap_index = %d, .adv_w = %d, .box_w = %d, .box_h = %d, "
          ".ofs_x = %d, .ofs_y = %d},   /* %s */"
          % (index[n], r.advance * 16, r.w, r.h, r.xoff if r.w else 0,
             r.yoff if r.w else 0, n))
    w("};")
    w("")
    w("/*---------------------")
    w(" *  CHARACTER MAPPING")
    w(" *--------------------*/")
    w("")
    w("static const uint8_t glyph_id_ofs_list_0[] = {")
    for line in textwrap.wrap(" ".join("%d," % v for v in ofs_list), 92):
        w("    " + line)
    w("};")
    w("")
    w("static const lv_font_fmt_txt_cmap_t cmaps[] = {")
    w("    {")
    w("        .range_start = %d, .range_length = %d, .glyph_id_start = 0," % (lo, hi - lo + 1))
    w("        .unicode_list = NULL, .glyph_id_ofs_list = glyph_id_ofs_list_0,")
    w("        .list_length = %d, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_FULL" % len(ofs_list))
    w("    },")
    for cp in extra:
        w("    {")
        w("        .range_start = %d, .range_length = 1, .glyph_id_start = %d,"
          % (cp, ids[by_code[cp]]))
        w("        .unicode_list = NULL, .glyph_id_ofs_list = NULL,")
        w("        .list_length = 0, .type = LV_FONT_FMT_TXT_CMAP_FORMAT0_TINY")
        w("    },")
    w("};")
    w("")
    w("/*--------------------")
    w(" *  ALL CUSTOM DATA")
    w(" *--------------------*/")
    w("")
    w("#if LVGL_VERSION_MAJOR == 8")
    w("static lv_font_fmt_txt_glyph_cache_t cache;")
    w("#endif")
    w("")
    w("static const lv_font_fmt_txt_dsc_t font_dsc = {")
    w("    .glyph_bitmap = glyph_bitmap,")
    w("    .glyph_dsc = glyph_dsc,")
    w("    .cmaps = cmaps,")
    w("    .kern_dsc = NULL,")
    w("    .kern_scale = 0,")
    w("    .cmap_num = %d," % (1 + len(extra)))
    w("    .bpp = 1,")
    w("    .kern_classes = 0,")
    w("    .bitmap_format = 0,")
    w("#if LVGL_VERSION_MAJOR == 8")
    w("    .cache = &cache,")
    w("#endif")
    w("};")
    w("")
    w("/*-----------------")
    w(" *  PUBLIC FONT")
    w(" *----------------*/")
    w("")
    w("const lv_font_t %s = {" % ident)
    w("    .get_glyph_dsc = lv_font_get_glyph_dsc_fmt_txt,")
    w("    .get_glyph_bitmap = lv_font_get_bitmap_fmt_txt,")
    w("    .line_height = %d," % line_height)
    w("    .base_line = %d," % base_line)
    w("    .subpx = LV_FONT_SUBPX_NONE,")
    w("    .underline_position = %d," % -max(1, stroke_px))
    w("    .underline_thickness = %d," % stroke_px)
    w("    .dsc = &font_dsc,")
    w("    .fallback = NULL,")
    w("};")
    w("")
    w("#endif /* %s */" % ident.upper())
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        fh.write("\n".join(out) + "\n")
    # rough flash cost: bitmaps + glyph table + cmap table + the two descriptors
    return (len(data) + 6 * (len(names) + 1) + len(ofs_list)
            + 16 * (1 + len(extra)) + 24 + 32)
