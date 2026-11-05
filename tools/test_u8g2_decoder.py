"""Check the u8g2 decoder in fmt_u8g2.py against u8g2's own `u8g2_font_5x7_tr`.

The decoder is what every font this project emits gets round-tripped through, so it
has to be right. Point this at a checkout (or a download) of u8g2's
tools/font/build/single_font_files/u8g2_font_5x7_tr.c and tools/font/bdf/5x7.bdf:

    python tools/test_u8g2_decoder.py <dir with the two reference files>
"""

import os
import re
import sys

import fmt_u8g2 as U

ESCAPES = {"n": 10, "t": 9, "r": 13, "a": 7, "b": 8, "f": 12, "v": 11}


def c_string_bytes(text):
    """Concatenate and unescape the C string literals in the array initialiser.

    Only the text between the declaration's `=` and its `;`, so the name inside
    U8G2_FONT_SECTION(...) is not mistaken for font data.
    """
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    parts = []
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', text, re.S):
        before = text[:m.start()].rstrip()
        if before.endswith("("):          # U8G2_FONT_SECTION("name"), not font data
            continue
        parts.append(m.group(1))
    raw = "".join(parts)
    out = bytearray()
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch != "\\":
            out.append(ord(ch))
            i += 1
            continue
        i += 1
        ch = raw[i]
        if ch in "01234567":
            j = i
            while j < len(raw) and j - i < 3 and raw[j] in "01234567":
                j += 1
            out.append(int(raw[i:j], 8))
            i = j
        elif ch == "x":
            j = i + 1
            while j < len(raw) and raw[j] in "0123456789abcdefABCDEF":
                j += 1
            out.append(int(raw[i + 1:j], 16))
            i = j
        else:
            out.append(ESCAPES.get(ch, ord(ch)))
            i += 1
    # u8g2 writes its fonts as a C string, so the array's last byte is the implicit
    # NUL -- and that NUL is what terminates the one-byte glyph section.
    out.append(0)
    return bytes(out)


def parse_bdf(path):
    glyphs, cur = {}, None
    for line in open(path, encoding="latin-1"):
        tok = line.split()
        if not tok:
            continue
        if tok[0] == "STARTCHAR":
            cur = {"rows": []}
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
            glyphs[cur["enc"]] = cur
            cur = None
        elif cur.get("reading") and re.fullmatch(r"[0-9A-Fa-f]+", tok[0]):
            cur["rows"].append(tok[0])
    return glyphs


def trim(rows, w, h, x, y):
    """Reduce to the ink box, the way u8g2 stores it."""
    if not any(any(r) for r in rows):
        return [], 0, 0, 0, 0
    top = min(i for i, r in enumerate(rows) if any(r))
    bot = max(i for i, r in enumerate(rows) if any(r))
    left = min(j for r in rows for j, v in enumerate(r) if v)
    right = max(j for r in rows for j, v in enumerate(r) if v)
    return (
        [r[left:right + 1] for r in rows[top:bot + 1]],
        right - left + 1, bot - top + 1, x + left, y + (h - 1 - bot),
    )


def main():
    ref = sys.argv[1] if len(sys.argv) > 1 else "."
    font = c_string_bytes(open(os.path.join(ref, "u8g2_font_5x7_tr.c"), encoding="latin-1").read())
    bdf = parse_bdf(os.path.join(ref, "5x7.bdf"))
    info = U.read_info(font)
    print("header:", {k: info[k] for k in (
        "glyph_cnt", "bits_per_0", "bits_per_1", "bits_per_char_width",
        "bits_per_char_height", "bits_per_char_x", "bits_per_char_y",
        "bits_per_delta_x", "max_char_width", "max_char_height", "ascent_A",
        "descent_g", "start_pos_upper_A", "start_pos_lower_a")})

    checked = bad = 0
    for enc in range(32, 127):
        got = U.decode_glyph(font, info, enc)
        if got is None:
            print("MISSING", enc)
            bad += 1
            continue
        if enc not in bdf:
            continue
        grid, w, h, x, y, d = got
        bw, bh, bx, by = bdf[enc]["bbx"]
        nb = (bw + 7) // 8
        rows = [
            [(int(r, 16) >> (nb * 8 - 1 - i)) & 1 for i in range(bw)]
            for r in bdf[enc]["rows"][:bh]
        ]
        want = trim(rows, bw, bh, bx, by)
        mine = trim(grid, w, h, x, y)
        checked += 1
        if want != mine or d != bdf[enc]["dw"]:
            bad += 1
            if bad <= 3:
                print("MISMATCH %d (%r): advance %d/%d box %s/%s"
                      % (enc, chr(enc), d, bdf[enc]["dw"], mine[1:], want[1:]))
    print("checked %d glyphs against u8g2's own font -- mismatches: %d" % (checked, bad))
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
