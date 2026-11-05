"""Encode and decode the u8g2 bitmap font format.

u8g2 ships no encoder on this machine (that is `bdfconv`, a C program), so this is a
from-scratch encoder written against csrc/u8g2_font.c, plus a decoder that is a literal
port of that file's `u8g2_font_decode_glyph` / `u8g2_read_font_info`. The decoder lets
every font we emit be round-tripped before it is written, and it was itself checked
against u8g2's own `u8g2_font_5x7_tr`.

Layout, for the record:
  23-byte header, then one record per glyph in ascending encoding order
  (encoding byte, record length byte, then a bit stream), then a zero terminator.
  The bit stream is little-endian within bytes. Signed fields are biased by
  2**(bits-1), not two's complement. The bitmap is a run-length code over the glyph's
  pixels read left-to-right, top-to-bottom: alternating (zeros, ones) pairs, each pair
  followed by one bit that repeats it.
"""

HEADER = 23


# --- bit stream --------------------------------------------------------------

class BitWriter:
    def __init__(self):
        self.bytes = bytearray()
        self.bit = 0

    def put(self, value, n):
        for i in range(n):
            if self.bit == 0:
                self.bytes.append(0)
            if (value >> i) & 1:
                self.bytes[-1] |= 1 << self.bit
            self.bit = (self.bit + 1) & 7

    def put_signed(self, value, n):
        self.put(value + (1 << (n - 1)), n)

    def flush(self):
        self.bit = 0
        return bytes(self.bytes)


class BitReader:
    def __init__(self, data, pos=0):
        self.data, self.pos, self.bit = data, pos, 0

    def get(self, n):
        value = 0
        for i in range(n):
            value |= ((self.data[self.pos] >> self.bit) & 1) << i
            self.bit += 1
            if self.bit == 8:
                self.bit = 0
                self.pos += 1
        return value

    def get_signed(self, n):
        return self.get(n) - (1 << (n - 1))


def bits_unsigned(values):
    hi = max(values) if values else 0
    n = 1
    while (1 << n) - 1 < hi:
        n += 1
    return min(n, 8)


def bits_signed(values):
    lo, hi = (min(values), max(values)) if values else (0, 0)
    n = 1
    while lo < -(1 << (n - 1)) or hi > (1 << (n - 1)) - 1:
        n += 1
    return min(n, 8)


# --- run-length code ---------------------------------------------------------

def _runs(pixels):
    """Pixel stream -> alternating (zeros, ones) run lengths, starting with zeros."""
    out, i, n = [], 0, len(pixels)
    while i < n:
        z = 0
        while i < n and not pixels[i]:
            z += 1
            i += 1
        o = 0
        while i < n and pixels[i]:
            o += 1
            i += 1
        out.append((z, o))
    return out


def _split(pairs, max0, max1):
    """Break any run too long for its field into several pairs."""
    out = []
    for z, o in pairs:
        while z > max0:
            out.append((max0, 0))
            z -= max0
        while o > max1:
            out.append((z, max1))
            z = 0
            o -= max1
        out.append((z, o))
    return out


def encode_bitmap(bw, pixels, bits0, bits1):
    pairs = _split(_runs(pixels), (1 << bits0) - 1, (1 << bits1) - 1)
    i = 0
    while i < len(pairs):
        z, o = pairs[i]
        run = 1
        while i + run < len(pairs) and pairs[i + run] == (z, o):
            run += 1
        bw.put(z, bits0)
        bw.put(o, bits1)
        for _ in range(run - 1):
            bw.put(1, 1)
        bw.put(0, 1)
        i += run


def _bitmap_cost(pixels, bits0, bits1):
    pairs = _split(_runs(pixels), (1 << bits0) - 1, (1 << bits1) - 1)
    total, i = 0, 0
    while i < len(pairs):
        run = 1
        while i + run < len(pairs) and pairs[i + run] == pairs[i]:
            run += 1
        total += bits0 + bits1 + run
        i += run
    return total


# --- encode ------------------------------------------------------------------

def encode(glyphs, ascent_A, descent_g, ascent_para, descent_para):
    """`glyphs`: list of (encoding, Raster) sorted by encoding. Returns bytes."""
    inked = [g for _e, g in glyphs if g.w]
    bits_w = bits_unsigned([g.w for _e, g in glyphs])
    bits_h = bits_unsigned([g.h for _e, g in glyphs])
    bits_x = bits_signed([g.xoff for g in inked] or [0])
    bits_y = bits_signed([g.yoff for g in inked] or [0])
    bits_d = bits_signed([g.advance for _e, g in glyphs])

    streams = [
        [b for row in g.bits for b in row] for _e, g in glyphs
    ]
    best, bits0, bits1 = None, 2, 2
    for b0 in range(1, 9):
        for b1 in range(1, 9):
            cost = sum(_bitmap_cost(s, b0, b1) for s in streams if s)
            if best is None or cost < best:
                best, bits0, bits1 = cost, b0, b1

    records = []
    for (enc, g), pixels in zip(glyphs, streams):
        bw = BitWriter()
        bw.put(g.w, bits_w)
        bw.put(g.h, bits_h)
        bw.put_signed(g.xoff if g.w else 0, bits_x)
        bw.put_signed(g.yoff if g.w else 0, bits_y)
        bw.put_signed(g.advance, bits_d)
        if g.w:
            encode_bitmap(bw, pixels, bits0, bits1)
        body = bw.flush()
        records.append((enc, bytes([enc, len(body) + 2]) + body))

    # offsets are measured from the end of the header
    pos, start_A, start_a = 0, 0, 0
    for enc, rec in records:
        if enc >= 0x41 and start_A == 0:
            start_A = pos
        if enc >= 0x61 and start_a == 0:
            start_a = pos
        pos += len(rec)
    body = b"".join(rec for _e, rec in records)
    terminator = b"\x00\x00"            # font[1] == 0 ends the one-byte section
    start_unicode = len(body) + len(terminator)

    def sb(v):                           # signed byte
        return v & 0xFF

    header = bytes(
        [
            len(glyphs), 0, bits0, bits1,
            bits_w, bits_h, bits_x, bits_y, bits_d,
            max(g.w for _e, g in glyphs),
            max(g.h for _e, g in glyphs),
            sb(min((g.xoff for g in inked), default=0)),
            sb(min((g.yoff for g in inked), default=0)),
            sb(ascent_A), sb(descent_g), sb(ascent_para), sb(descent_para),
            start_A >> 8, start_A & 0xFF,
            start_a >> 8, start_a & 0xFF,
            start_unicode >> 8, start_unicode & 0xFF,
        ]
    )
    # an empty unicode section, so a lookup above 255 terminates at once
    return header + body + terminator + b"\x00\x00\x00\x00"


# --- decode (a port of u8g2_font.c, used to verify what we encode) -----------

def read_info(font):
    def sb(i):
        v = font[i]
        return v - 256 if v > 127 else v

    return dict(
        glyph_cnt=font[0], bbx_mode=font[1], bits_per_0=font[2], bits_per_1=font[3],
        bits_per_char_width=font[4], bits_per_char_height=font[5],
        bits_per_char_x=font[6], bits_per_char_y=font[7], bits_per_delta_x=font[8],
        max_char_width=font[9], max_char_height=font[10],
        x_offset=sb(11), y_offset=sb(12),
        ascent_A=sb(13), descent_g=sb(14), ascent_para=sb(15), descent_para=sb(16),
        start_pos_upper_A=(font[17] << 8) | font[18],
        start_pos_lower_a=(font[19] << 8) | font[20],
        start_pos_unicode=(font[21] << 8) | font[22],
    )


def find_glyph(font, info, encoding):
    pos = HEADER
    if encoding >= 0x61:
        pos += info["start_pos_lower_a"]
    elif encoding >= 0x41:
        pos += info["start_pos_upper_A"]
    while True:
        if font[pos + 1] == 0:
            return None
        if font[pos] == encoding:
            return pos + 2
        pos += font[pos + 1]


def decode_glyph(font, info, encoding):
    """Returns (pixels as rows of 0/1, w, h, xoff, yoff, advance) or None."""
    pos = find_glyph(font, info, encoding)
    if pos is None:
        return None
    br = BitReader(font, pos)
    w = br.get(info["bits_per_char_width"])
    h = br.get(info["bits_per_char_height"])
    x = br.get_signed(info["bits_per_char_x"])
    y = br.get_signed(info["bits_per_char_y"])
    d = br.get_signed(info["bits_per_delta_x"])
    if w == 0:
        return [], 0, 0, x, y, d

    grid = [[0] * w for _ in range(h)]
    lx = ly = 0

    def run(length, value):
        nonlocal lx, ly
        cnt = length
        while True:
            rem = w - lx
            current = min(cnt, rem)
            if value:
                for i in range(current):
                    if ly < h:
                        grid[ly][lx + i] = 1
            if cnt < rem:
                break
            cnt -= rem
            lx = 0
            ly += 1
        lx += cnt

    while True:
        a = br.get(info["bits_per_0"])
        b = br.get(info["bits_per_1"])
        while True:
            run(a, 0)
            run(b, 1)
            if br.get(1) == 0:
                break
        if ly >= h:
            break
    return grid, w, h, x, y, d
