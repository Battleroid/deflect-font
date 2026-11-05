"""Small numpy rasterizer used to paint the texture atlases.

Everything is in pixels with the origin at the top-left corner and y pointing down.
Shapes are drawn from signed distance functions with one pixel of anti-aliasing,
so edges stay clean at any size. Colours are straight (non-premultiplied) sRGB RGBA
floats in 0..1. Runs on Blender's bundled Python (numpy only, no Pillow).
"""

import math
import struct
import zlib

import numpy as np

from . import font


def rgba(color, alpha=None):
	"""'#rrggbb', '#rrggbbaa', (r, g, b) or (r, g, b, a) -> np.array of 4 floats."""
	if isinstance(color, str):
		h = color.lstrip("#")
		vals = [int(h[i:i + 2], 16) / 255.0 for i in range(0, len(h), 2)]
		if len(vals) == 3:
			vals.append(1.0)
	else:
		vals = list(color)
		if len(vals) == 3:
			vals.append(1.0)
	out = np.array(vals, np.float32)
	if alpha is not None:
		out[3] = alpha
	return out


def mix(a, b, t):
	return rgba(a) * (1.0 - t) + rgba(b) * t


def shade(color, factor):
	"""Multiplies rgb by factor, keeps alpha."""
	c = rgba(color).copy()
	c[:3] = np.clip(c[:3] * factor, 0.0, 1.0)
	return c


def _coverage(d, soft=1.0):
	return np.clip(0.5 - d / soft, 0.0, 1.0)


class Canvas:
	"""RGBA float image. `origin` offsets every draw call (used for atlas gutters)."""

	def __init__(self, w, h, fill=(0, 0, 0, 0), origin=(0.0, 0.0)):
		self.w = int(w)
		self.h = int(h)
		self.ox, self.oy = float(origin[0]), float(origin[1])
		self.px = np.empty((self.h, self.w, 4), np.float32)
		self.px[:] = rgba(fill)

	# --- internals ---

	def _grid(self, x0, y0, x1, y1):
		x0 += self.ox
		x1 += self.ox
		y0 += self.oy
		y1 += self.oy
		ix0 = max(0, int(math.floor(x0)))
		iy0 = max(0, int(math.floor(y0)))
		ix1 = min(self.w, int(math.ceil(x1)))
		iy1 = min(self.h, int(math.ceil(y1)))
		if ix0 >= ix1 or iy0 >= iy1:
			return None
		xs = np.arange(ix0, ix1, dtype=np.float32) + 0.5 - self.ox
		ys = np.arange(iy0, iy1, dtype=np.float32) + 0.5 - self.oy
		X, Y = np.meshgrid(xs, ys)
		return (slice(iy0, iy1), slice(ix0, ix1)), X, Y

	def _over(self, sl, cov, color):
		c = rgba(color)
		a = np.clip(cov, 0.0, 1.0) * c[3]
		self._composite(sl, a, np.broadcast_to(c[:3], a.shape + (3,)))

	def _over_field(self, sl, cov, rgb):
		"""Like _over but with a per-pixel rgb array (h, w, 3)."""
		self._composite(sl, np.clip(cov, 0.0, 1.0), rgb)

	def _composite(self, sl, a, rgb):
		# Straight-alpha "over". Where the result stays fully transparent the old rgb is kept,
		# so transparent decal pixels keep their fill colour and mips don't fringe dark.
		dst = self.px[sl]
		da = dst[..., 3]
		oa = a + da * (1.0 - a)
		visible = oa > 1e-6
		safe = np.where(visible, oa, 1.0)
		for k in range(3):
			mixed = (rgb[..., k] * a + dst[..., k] * da * (1.0 - a)) / safe
			dst[..., k] = np.where(visible, mixed, dst[..., k])
		dst[..., 3] = oa

	# --- whole image ---

	def fill(self, color):
		self.px[:] = rgba(color)

	def full_grid(self):
		"""Pixel-centre coordinates (in draw space) for the whole canvas."""
		xs = np.arange(self.w, dtype=np.float32) + 0.5 - self.ox
		ys = np.arange(self.h, dtype=np.float32) + 0.5 - self.oy
		return np.meshgrid(xs, ys)

	def multiply(self, field, amount=1.0):
		"""rgb *= lerp(1, field, amount). field is (h, w) matching the canvas."""
		f = 1.0 + (field - 1.0) * amount
		self.px[..., :3] *= f[..., None]
		np.clip(self.px, 0.0, 1.0, out=self.px)

	def tint_field(self, field, color, amount=1.0):
		"""Blends towards color by field (0..1) * amount across the whole canvas."""
		c = rgba(color)
		t = np.clip(field * amount * c[3], 0.0, 1.0)[..., None]
		self.px[..., :3] = self.px[..., :3] * (1.0 - t) + c[:3] * t

	def paste(self, other, x, y):
		self.px[y:y + other.h, x:x + other.w] = other.px

	# --- shapes ---

	def rect(self, x0, y0, x1, y1, color, radius=0.0, soft=1.0):
		if x1 < x0:
			x0, x1 = x1, x0
		if y1 < y0:
			y0, y1 = y1, y0
		g = self._grid(x0 - 1, y0 - 1, x1 + 1, y1 + 1)
		if g is None:
			return
		sl, X, Y = g
		cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
		hx, hy = (x1 - x0) * 0.5 - radius, (y1 - y0) * 0.5 - radius
		qx = np.abs(X - cx) - hx
		qy = np.abs(Y - cy) - hy
		d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius
		self._over(sl, _coverage(d, soft), color)

	def frame(self, x0, y0, x1, y1, width, color, radius=0.0):
		"""Rectangle outline centred on the given edges."""
		g = self._grid(x0 - width, y0 - width, x1 + width, y1 + width)
		if g is None:
			return
		sl, X, Y = g
		cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
		hx, hy = (x1 - x0) * 0.5 - radius, (y1 - y0) * 0.5 - radius
		qx = np.abs(X - cx) - hx
		qy = np.abs(Y - cy) - hy
		d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - radius
		self._over(sl, _coverage(np.abs(d) - width * 0.5), color)

	def circle(self, cx, cy, r, color, soft=1.0):
		g = self._grid(cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2)
		if g is None:
			return
		sl, X, Y = g
		d = np.hypot(X - cx, Y - cy) - r
		self._over(sl, _coverage(d, soft), color)

	def ring(self, cx, cy, r, width, color):
		g = self._grid(cx - r - width - 2, cy - r - width - 2, cx + r + width + 2, cy + r + width + 2)
		if g is None:
			return
		sl, X, Y = g
		d = np.abs(np.hypot(X - cx, Y - cy) - r) - width * 0.5
		self._over(sl, _coverage(d), color)

	def arc(self, cx, cy, r, width, a0, a1, color):
		"""Ring segment. Angles in degrees, 0 = +x (right), increasing clockwise (screen)."""
		g = self._grid(cx - r - width - 2, cy - r - width - 2, cx + r + width + 2, cy + r + width + 2)
		if g is None:
			return
		sl, X, Y = g
		dist = np.hypot(X - cx, Y - cy)
		d = np.abs(dist - r) - width * 0.5
		ang = np.degrees(np.arctan2(Y - cy, X - cx))
		span = (a1 - a0) % 360.0
		rel = (ang - a0) % 360.0
		inside = np.minimum(rel, span - rel)
		inside = np.where(rel <= span, inside, -np.minimum(rel - span, 360.0 - rel))
		ang_px = np.radians(inside) * np.maximum(dist, 1.0)
		cov = _coverage(d) * np.clip(0.5 + ang_px, 0.0, 1.0)
		self._over(sl, cov, color)

	def pie(self, cx, cy, r, a0, a1, color):
		g = self._grid(cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2)
		if g is None:
			return
		sl, X, Y = g
		dist = np.hypot(X - cx, Y - cy)
		ang = np.degrees(np.arctan2(Y - cy, X - cx))
		span = (a1 - a0) % 360.0
		rel = (ang - a0) % 360.0
		inside = np.minimum(rel, span - rel)
		inside = np.where(rel <= span, inside, -np.minimum(rel - span, 360.0 - rel))
		ang_px = np.radians(inside) * np.maximum(dist, 1.0)
		cov = _coverage(dist - r) * np.clip(0.5 + ang_px, 0.0, 1.0)
		self._over(sl, cov, color)

	def line(self, x0, y0, x1, y1, width, color):
		self.polyline([(x0, y0), (x1, y1)], width, color)

	def polyline(self, pts, width, color, closed=False):
		self.strokes([pts], width, color, closed)

	def strokes(self, lines, width, color, closed=False):
		"""Several polylines drawn as one layer (round caps and joins, no double blending)."""
		segs = []
		for pts in lines:
			n = len(pts)
			if n == 1:
				segs.append((pts[0], pts[0]))
			for i in range(n - 1 + (1 if closed and n > 2 else 0)):
				segs.append((pts[i], pts[(i + 1) % n]))
		if not segs:
			return
		xs = [p[0] for s in segs for p in s]
		ys = [p[1] for s in segs for p in s]
		pad = width + 2
		g = self._grid(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
		if g is None:
			return
		sl, X, Y = g
		d = np.full(X.shape, 1e9, np.float32)
		for (ax, ay), (bx, by) in segs:
			dx, dy = bx - ax, by - ay
			ll = dx * dx + dy * dy
			if ll < 1e-9:
				t = 0.0
			else:
				t = np.clip(((X - ax) * dx + (Y - ay) * dy) / ll, 0.0, 1.0)
			d = np.minimum(d, np.hypot(X - (ax + t * dx), Y - (ay + t * dy)))
		self._over(sl, _coverage(d - width * 0.5), color)

	def polygon(self, pts, color, soft=1.0):
		xs = [p[0] for p in pts]
		ys = [p[1] for p in pts]
		g = self._grid(min(xs) - 2, min(ys) - 2, max(xs) + 2, max(ys) + 2)
		if g is None:
			return
		sl, X, Y = g
		n = len(pts)
		d = np.full(X.shape, 1e9, np.float32)
		inside = np.zeros(X.shape, bool)
		for i in range(n):
			ax, ay = pts[i]
			bx, by = pts[(i + 1) % n]
			dx, dy = bx - ax, by - ay
			ll = dx * dx + dy * dy
			t = np.clip(((X - ax) * dx + (Y - ay) * dy) / max(ll, 1e-9), 0.0, 1.0)
			d = np.minimum(d, np.hypot(X - (ax + t * dx), Y - (ay + t * dy)))
			cond = ((ay > Y) != (by > Y)) & (X < (bx - ax) * (Y - ay) / np.where(by - ay == 0, 1e-9, by - ay) + ax)
			inside ^= cond
		sd = np.where(inside, -d, d)
		self._over(sl, _coverage(sd, soft), color)

	def gradient_rect(self, x0, y0, x1, y1, c0, c1, vertical=True):
		g = self._grid(x0, y0, x1, y1)
		if g is None:
			return
		sl, X, Y = g
		t = (Y - y0) / max(y1 - y0, 1e-6) if vertical else (X - x0) / max(x1 - x0, 1e-6)
		t = np.clip(t, 0.0, 1.0)[..., None]
		a0, a1 = rgba(c0), rgba(c1)
		col = a0[None, None, :] * (1 - t) + a1[None, None, :] * t
		self._over_field(sl, np.ones(X.shape, np.float32) * col[..., 3], col[..., :3])

	def radial(self, cx, cy, r, c_in, c_out):
		"""Radial gradient disc (c_in at the centre, c_out at r)."""
		g = self._grid(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1)
		if g is None:
			return
		sl, X, Y = g
		dist = np.hypot(X - cx, Y - cy)
		t = np.clip(dist / r, 0.0, 1.0)[..., None]
		a0, a1 = rgba(c_in), rgba(c_out)
		col = a0 * (1 - t) + a1 * t
		self._over_field(sl, _coverage(dist - r) * col[..., 3], col[..., :3])

	# --- text ---

	def text(self, x, y, s, size, color, weight=0.13, align="left", valign="baseline", spacing=1.0, slant=0.0):
		"""Monoline stroke text. size = cap height in pixels. Returns the advance width."""
		lines, width = font.layout(s, size, spacing, slant)
		if align == "center":
			x -= width * 0.5
		elif align == "right":
			x -= width
		if valign == "middle":
			y += size * 0.5
		elif valign == "top":
			y += size
		placed = [[(x + px, y + py) for px, py in line] for line in lines]
		if placed:
			self.strokes(placed, max(1.0, size * weight), color)
		return width

	def seg7(self, x, y, h, digits, on, off=None, slant=0.12, weight=0.16):
		"""Seven-segment readout. (x, y) is the top-left of the first digit."""
		w = h * 0.55
		t = h * weight
		adv = w + h * 0.3
		for ch in digits:
			if ch == " ":
				x += adv
				continue
			if ch == ".":
				self.circle(x - h * 0.12, y + h - t * 0.5, t * 0.55, on)
				continue
			segs = font.SEG7.get(ch, "")
			for name, (ax, ay, bx, by) in font.SEG7_LINES.items():
				col = on if name in segs else off
				if col is None:
					continue
				p0 = (x + ax * w + (1 - ay) * h * slant, y + ay * h)
				p1 = (x + bx * w + (1 - by) * h * slant, y + by * h)
				self._segment_bar(p0, p1, t, col)
			x += adv

	def _segment_bar(self, p0, p1, t, color):
		dx, dy = p1[0] - p0[0], p1[1] - p0[1]
		ll = math.hypot(dx, dy)
		ux, uy = dx / ll, dy / ll
		inset = t * 0.6
		a = (p0[0] + ux * inset, p0[1] + uy * inset)
		b = (p1[0] - ux * inset, p1[1] - uy * inset)
		nx, ny = -uy * t * 0.5, ux * t * 0.5
		m0 = (a[0] + ux * t * 0.5, a[1] + uy * t * 0.5)
		m1 = (b[0] - ux * t * 0.5, b[1] - uy * t * 0.5)
		self.polygon([a, (m0[0] + nx, m0[1] + ny), (m1[0] + nx, m1[1] + ny), b, (m1[0] - nx, m1[1] - ny), (m0[0] - nx, m0[1] - ny)], color)


# --- noise ---

def value_noise(w, h, cells_x, cells_y, seed):
	"""Tileable value noise in 0..1 with cells_x by cells_y lattice cells over the image."""
	rng = np.random.default_rng(seed)
	lat = rng.random((cells_y, cells_x)).astype(np.float32)
	xs = (np.arange(w, dtype=np.float32) + 0.5) * cells_x / w
	ys = (np.arange(h, dtype=np.float32) + 0.5) * cells_y / h
	x0 = np.floor(xs).astype(np.int64)
	y0 = np.floor(ys).astype(np.int64)
	fx = xs - x0
	fy = ys - y0
	sx = fx * fx * (3 - 2 * fx)
	sy = fy * fy * (3 - 2 * fy)
	x0 %= cells_x
	y0 %= cells_y
	x1 = (x0 + 1) % cells_x
	y1 = (y0 + 1) % cells_y
	a = lat[y0][:, x0]
	b = lat[y0][:, x1]
	c = lat[y1][:, x0]
	d = lat[y1][:, x1]
	top = a + (b - a) * sx[None, :]
	bot = c + (d - c) * sx[None, :]
	return top + (bot - top) * sy[:, None]


def fbm(w, h, cells, octaves=4, seed=0, gain=0.5, aspect=None):
	"""Tileable fractal noise in 0..1. cells = lattice cells across the width at octave 0."""
	if aspect is None:
		aspect = h / w
	total = np.zeros((h, w), np.float32)
	amp = 1.0
	norm = 0.0
	for i in range(octaves):
		cx = max(1, int(round(cells * (2 ** i))))
		cy = max(1, int(round(cells * aspect * (2 ** i))))
		total += value_noise(w, h, cx, cy, seed + i * 101) * amp
		norm += amp
		amp *= gain
	return total / norm


def smoothstep(e0, e1, x):
	t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
	return t * t * (3 - 2 * t)


# --- output ---

def save_png(path, px, alpha=True):
	h, w = px.shape[:2]
	data = (np.clip(px, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
	channels = 4 if alpha else 3
	data = data[..., :channels]
	raw = np.zeros((h, w * channels + 1), np.uint8)
	raw[:, 1:] = data.reshape(h, w * channels)

	def chunk(tag, body):
		return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

	color_type = 6 if alpha else 2
	png = b"\x89PNG\r\n\x1a\n"
	png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
	png += chunk(b"IDAT", zlib.compress(raw.tobytes(), 9))
	png += chunk(b"IEND", b"")
	with open(path, "wb") as f:
		f.write(png)
