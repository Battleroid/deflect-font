/* Range markings painted on the ground, set in Deflect Stencil.
 *
 * This is the typeface doing the job it was drawn for. The text is rendered to a
 * canvas, eaten away at random so it looks like paint that has had tracks run over
 * it for a decade, and laid flat on the dirt. Everything is kept dim: it is set
 * dressing, and the player and the enemies must stay the brightest things on screen.
 */

import * as THREE from 'three';
import { CSS } from './palette.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One canvas of worn stencil paint. */
function paintTexture(text, rng, { weight = 700, pad = 0.18, wear = 0.42 } = {}) {
  const size = 200;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');

  ctx.font = `${weight} ${size}px "Deflect Stencil", monospace`;
  const w = Math.ceil(ctx.measureText(text).width * (1 + pad));
  c.width = Math.max(16, w);
  c.height = Math.ceil(size * 1.45);

  const g = c.getContext('2d');
  g.font = `${weight} ${size}px "Deflect Stencil", monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffffff';
  g.fillText(text, c.width / 2, c.height / 2);

  // Scuff it: punch transparent blobs out of the paint, heavier toward the middle
  // where the tracks would run.
  g.globalCompositeOperation = 'destination-out';
  const blobs = Math.floor((c.width / 40) * 14 * wear);
  for (let i = 0; i < blobs; i++) {
    const x = rng() * c.width;
    const y = c.height * (0.2 + rng() * 0.6);
    const r = 3 + rng() * rng() * 26;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // a couple of long scrapes across the lettering
  g.lineWidth = 6 + rng() * 10;
  for (let i = 0; i < 2; i++) {
    g.beginPath();
    g.moveTo(-10, rng() * c.height);
    g.lineTo(c.width + 10, rng() * c.height);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: c.width / c.height };
}

function decal(text, rng, opts) {
  const { tex, aspect } = paintTexture(text, rng, opts);
  const h = opts.height;
  const geo = new THREE.PlaneGeometry(h * aspect, h);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: opts.opacity ?? 0.3,
    color: opts.color ?? CSS.edge,
    depthWrite: false,
    toneMapped: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.rotation.z = opts.spin || 0;
  m.position.set(opts.x, 0.03, opts.z);
  m.renderOrder = 1;          // sit on the ground, under everything else
  return m;
}

/* What a Warsaw Pact gunnery range has painted on it. */
const LAYOUT = [
  { t: '01', h: 13, r: 0.30, a: 0.15 },
  { t: '02', h: 13, r: 0.30, a: 1.35 },
  { t: '03', h: 13, r: 0.30, a: 2.70 },
  { t: '04', h: 13, r: 0.30, a: 3.95 },
  { t: '05', h: 13, r: 0.30, a: 5.25 },
  { t: 'FIRING POINT', h: 5.0, r: 0.52, a: 0.62 },
  { t: 'DANGER AREA', h: 5.6, r: 0.70, a: 2.05 },
  { t: 'NO ENTRY', h: 5.2, r: 0.72, a: 3.50 },
  { t: 'RANGE CONTROL', h: 4.6, r: 0.55, a: 4.60 },
  { t: 'LANE 2', h: 6.2, r: 0.44, a: 5.80 },
  { t: '< 400 M', h: 4.4, r: 0.63, a: 1.10 },
  { t: 'CTG CAL .50', h: 4.0, r: 0.66, a: 2.95 },
  { t: 'HALON 1301', h: 4.0, r: 0.60, a: 0.95 },
  { t: 'WT 42.1 T', h: 4.2, r: 0.48, a: 4.15 },
];

/**
 * Build the ground markings. The web font may still be loading when this is
 * called, so the group comes back empty and fills itself in once the face is
 * ready -- otherwise the canvas would rasterise a fallback and the whole point
 * would be lost.
 */
export function makeDecals(arenaRadius, seed = 11) {
  const group = new THREE.Group();
  group.name = 'decals';

  const fill = () => {
    const rng = mulberry32(seed);
    for (const item of LAYOUT) {
      const a = item.a + (rng() - 0.5) * 0.25;
      const r = arenaRadius * item.r;
      group.add(decal(item.t, rng, {
        x: Math.sin(a) * r,
        z: Math.cos(a) * r,
        height: item.h,
        spin: (rng() - 0.5) * Math.PI * 1.6,
        opacity: 0.2 + rng() * 0.16,
        color: rng() < 0.3 ? CSS.grid : CSS.edge,
      }));
    }
  };

  if (document.fonts && document.fonts.load) {
    document.fonts.load('700 200px "Deflect Stencil"')
      .then(() => document.fonts.ready)
      .then(fill)
      .catch(fill);
  } else {
    fill();
  }
  return group;
}
