/* DEFLECT -- every mesh in the game, built in code.
 *
 * House style: hard-edged flat vector. Low-poly boxes and triangular prisms,
 * MeshBasicMaterial with one flat colour per solid, and every solid wrapped in
 * a bold HEX.ink outline made from EdgesGeometry + LineSegments. No textures,
 * no gradients, no shadows, no smooth normals anywhere.
 *
 * World conventions:
 *   1 unit = 1 metre, +Y is up, the ground plane is y = 0.
 *   Every vehicle faces +Z, so  obj.rotation.y = Math.atan2(dx, dz)  aims it.
 *   A vehicle's origin is the centre of its hull footprint, sitting ON the ground.
 *   The camera is a tilted orthographic top-down, so the detail lives on TOP
 *   surfaces and every silhouette is designed to be read from directly above.
 *
 * Nothing here uses Math.random(): all variation comes from a seeded mulberry32
 * stream, so a given seed always rebuilds exactly the same map.
 */

import * as THREE from 'three';
import { HEX } from './palette.js';

/* ================================================================== *
 * Seeded randomness
 * ================================================================== */

/** mulberry32 -- tiny, fast, good enough, and reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stream for incidental clutter and effects -- never touches map generation. */
const fxRnd = mulberry32(0xc0ffee);

const range = (rnd, a, b) => a + rnd() * (b - a);

/* ================================================================== *
 * Shared resources
 *
 * Geometries and materials are cached by shape/colour and tagged
 * userData.shared = true. disposeGroup() leaves tagged resources alone (other
 * objects still point at them) and frees everything else.
 * ================================================================== */

const matCache = new Map();
const geoCache = new Map();
const edgeCache = new WeakMap();

function share(res) { res.userData.shared = true; return res; }

/** Flat, unlit fill colour. Shared per colour (and per side mode). */
function mat(hex, double) {
  const key = double ? hex + ':d' : hex;
  let m = matCache.get(key);
  if (!m) {
    m = share(new THREE.MeshBasicMaterial({
      color: hex,
      side: double ? THREE.DoubleSide : THREE.FrontSide,
    }));
    matCache.set(key, m);
  }
  return m;
}

/** The one outline material. Every silhouette line in the game uses it. */
const INK = share(new THREE.LineBasicMaterial({ color: HEX.ink }));
/** Chain-link and other wire drawn as plain lines, kept dim. */
const WIRE = share(new THREE.LineBasicMaterial({ color: HEX.grid }));

function cachedGeo(key, build) {
  let g = geoCache.get(key);
  if (!g) { g = share(build()); geoCache.set(key, g); }
  return g;
}

/* --- geometry builders. Everything stands on its own base (y = 0) so parts are
 * placed by the height they sit at, which keeps the maths honest. --- */

/** Box standing on its base, centred in x/z. */
function fbox(w, h, d) {
  return cachedGeo(`fbox|${w}|${h}|${d}`, () =>
    new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0));
}

/** Faceted pillar (turret body, hatch, fuel drum) standing on its base. */
function pillar(rTop, rBot, h, seg, twist = 0) {
  return cachedGeo(`pil|${rTop}|${rBot}|${h}|${seg}|${twist}`, () => {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
    if (twist) g.rotateY(twist);
    return g.translate(0, h / 2, 0);
  });
}

/** Gun barrel / pipe: faceted tube lying along +Z, from z = 0 to z = len. */
function barrel(r, len, seg = 8) {
  return cachedGeo(`bar|${r}|${len}|${seg}`, () =>
    new THREE.CylinderGeometry(r, r, len, seg, 1)
      .rotateX(Math.PI / 2).translate(0, 0, len / 2));
}

/** Square pyramid standing on its base -- the dragon's tooth primitive. */
function pyramid(side, h) {
  return cachedGeo(`pyr|${side}|${h}`, () =>
    new THREE.ConeGeometry(side * Math.SQRT1_2, h, 4, 1)
      .rotateY(Math.PI / 4).translate(0, h / 2, 0));
}

/** Tapered slab standing on its base: an earth berm or sloped concrete block. */
function berm(len, wid, h, taper = 0.55) {
  return cachedGeo(`berm|${len}|${wid}|${h}|${taper}`, () => {
    const g = new THREE.CylinderGeometry(taper, 1, h, 4, 1).rotateY(Math.PI / 4);
    g.scale(len / Math.SQRT2, 1, wid / Math.SQRT2);   // base side of a unit square quad = sqrt2
    return g.translate(0, h / 2, 0);
  });
}

/**
 * Triangular prism: base on y = 0, width w along X, depth d along Z, height h.
 * The sloped face looks forward (+Z) and rises toward the rear (-Z) -- i.e. a
 * glacis plate for a vehicle facing +Z. Hand-wound so every face stays flat.
 */
function prism(w, h, d) {
  return cachedGeo(`pri|${w}|${h}|${d}`, () => {
    const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
    const p0 = [x0, 0, z0], p1 = [x1, 0, z0], p2 = [x1, 0, z1],
          p3 = [x0, 0, z1], p4 = [x0, h, z0], p5 = [x1, h, z0];
    const tris = [
      p0, p2, p3,  p0, p1, p2,   // floor
      p0, p4, p5,  p0, p5, p1,   // rear plate
      p3, p2, p5,  p3, p5, p4,   // the slope
      p0, p3, p4,  p1, p5, p2,   // side triangles
    ];
    const pos = new Float32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) pos.set(tris[i], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  });
}

/** Flat disc lying in the XZ plane, radius 1. */
function disc(seg) {
  return cachedGeo(`disc|${seg}`, () => new THREE.CircleGeometry(1, seg).rotateX(-Math.PI / 2));
}

function ringGeo() {
  return cachedGeo('ring', () => new THREE.RingGeometry(0.74, 1, 22).rotateX(-Math.PI / 2));
}

/**
 * Muzzle-blast star: a ragged many-pointed polygon lying flat in the XZ plane
 * and thrown forward down the bore (+Z), so it reads as a drawn starburst from
 * the only camera angle the player has. Four variants are cached and picked at
 * random per shot, so no two flashes are the same shape.
 */
function blastStar(variant) {
  return cachedGeo(`blast|${variant}`, () => {
    const r2 = mulberry32((0x51de + variant * 7919) >>> 0);
    const spikes = 7, n = spikes * 2;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      let rad = (i % 2 === 0 ? 1 : 0.38) * (0.75 + r2() * 0.5);
      const fwd = Math.max(0, Math.cos(a));
      rad *= 1 + 1.5 * fwd * fwd;                 // longest point goes down the bore
      pts.push([Math.sin(a) * rad * 0.6, Math.cos(a) * rad]);
    }
    const arr = [];
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      arr.push(0, 0, 0, p[0], 0, p[1], q[0], 0, q[1]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return geo;
  });
}

/* --- outlines --- */

const noRaycast = () => {};

function edgesOf(geo) {
  let e = edgeCache.get(geo);
  if (!e) { e = share(new THREE.EdgesGeometry(geo, 1)); edgeCache.set(geo, e); }
  return e;
}

/** A solid with its outline already attached. This is how every part is made. */
function part(geo, hex, double) {
  const m = new THREE.Mesh(geo, mat(hex, double));
  const line = new THREE.LineSegments(edgesOf(geo), INK);
  line.raycast = noRaycast;
  m.add(line);
  return m;
}

/**
 * Flat paint: a mesh with NO outline. Only for markings on the ground, which
 * are pigment rather than objects -- outlining them would both lie about the
 * form and double the object count for no read.
 */
function paint(parent, geo, hex, x, y, z) {
  const m = new THREE.Mesh(geo, mat(hex));
  m.position.set(x, y, z);
  m.raycast = noRaycast;
  parent.add(m);
  return m;
}

/** part() + place it + parent it. Returns the mesh. */
function at(parent, geo, hex, x, y, z, double) {
  const m = part(geo, hex, double);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

/* ================================================================== *
 * Vehicles
 * ================================================================== */

/** Common scaffolding so every vehicle Group carries the same contract. */
function vehicle(hull) {
  const g = new THREE.Group();
  const turret = new THREE.Group();
  g.add(turret);
  g.userData.turret = turret;
  g.userData.muzzle = null;
  g.userData.hull = hull;
  g.userData.tracks = [];
  return g;
}

/** Remember the rest height so the game can jiggle the tracks while driving. */
function track(g, mesh) {
  mesh.userData.baseY = mesh.position.y;
  g.userData.tracks.push(mesh);
  return mesh;
}

function muzzleAt(g, turret, x, y, z) {
  const m = new THREE.Object3D();
  m.position.set(x, y, z);
  turret.add(m);
  g.userData.muzzle = m;
  return m;
}

/**
 * PLAYER -- 6.6 x 3.3. Silhouette: a long bone slab with a blunt wedge nose, a
 * six-sided turret set slightly back with a rear bustle that makes the turret's
 * facing obvious from above, and a very long gun. The amber commander's hatch
 * and the amber engine-deck strip are the only warm colour on the field, so the
 * player's own tank pops out of a crowd of red.
 */
export function createPlayerTank() {
  const g = vehicle({ length: 6.6, width: 3.3, height: 2.11 });
  const turret = g.userData.turret;

  // running gear: full-length tracks, outer faces at +-1.65
  track(g, at(g, fbox(0.78, 0.62, 6.6), HEX.grey, -1.26, 0, 0));
  track(g, at(g, fbox(0.78, 0.62, 6.6), HEX.grey,  1.26, 0, 0));

  // hull: box from z -3.3 to 2.1, wedge nose from 2.1 to 3.3
  at(g, fbox(2.6, 0.9, 5.4), HEX.bone, 0, 0.35, -0.6);
  at(g, prism(2.6, 0.9, 1.2), HEX.bone, 0, 0.35, 2.7);

  // raised engine deck with louvre lines -- all the interest is on top
  at(g, fbox(2.3, 0.18, 1.6), HEX.boneDim, 0, 1.25, -2.2);
  for (let i = -1; i <= 1; i++) at(g, fbox(1.9, 0.06, 0.1), HEX.ink, 0, 1.43, -2.2 + i * 0.45);
  at(g, fbox(0.7, 0.07, 1.2), HEX.amber, 0.72, 1.43, -2.2);   // amber deck strip

  // turret
  turret.position.set(0, 1.25, -0.2);
  at(turret, pillar(1.34, 1.5, 0.72, 6, Math.PI / 6), HEX.boneDim, 0, 0, 0);
  at(turret, fbox(1.5, 0.5, 0.9), HEX.boneDim, 0, 0.1, -1.5);          // rear bustle
  at(turret, fbox(1.0, 0.5, 0.55), HEX.bone, 0, 0.2, 1.35);            // mantlet
  at(turret, pillar(0.4, 0.44, 0.16, 8), HEX.amber, 0.52, 0.72, -0.5); // amber hatch
  at(turret, fbox(0.26, 0.16, 0.8), HEX.boneDim, -0.62, 0.72, 0.1);    // roof MG

  // gun: 4.5 m past the turret front (z 1.5 -> 6.0)
  const gun = part(barrel(0.17, 4.5), HEX.boneDim);
  gun.position.set(0, 0.36, 1.5);
  turret.add(gun);
  at(turret, fbox(0.44, 0.44, 0.5), HEX.grey, 0, 0.14, 5.5);           // muzzle brake
  muzzleAt(g, turret, 0, 0.36, 6.05);

  return g;
}

/**
 * ENEMIES -- all three read apart by SHAPE from directly above, not just hue:
 *   light  : a small narrow dart. Pointed nose, tiny hex turret, stubby thin gun.
 *   medium : a plain rectangle. Flat side skirts squaring off the footprint, a
 *            slab turret, and two round fuel drums on the rear deck.
 *   heavy  : wide and long. Big trapezoid nose, overhanging side sponsons, a fat
 *            octagonal turret with one offset cupola, and a huge gun with a
 *            muzzle brake reaching well past everything else on the field.
 * Each one carries a small bone marking so it never reads as a flat red blob.
 */
export function createEnemyTank(variant = 'medium') {
  if (variant === 'light') return enemyLight();
  if (variant === 'heavy') return enemyHeavy();
  return enemyMedium();
}

function enemyLight() {
  const g = vehicle({ length: 4.6, width: 2.4, height: 1.52 });
  g.userData.variant = 'light';
  const turret = g.userData.turret;

  track(g, at(g, fbox(0.6, 0.5, 4.6), HEX.grey, -0.9, 0, 0));
  track(g, at(g, fbox(0.6, 0.5, 4.6), HEX.grey,  0.9, 0, 0));

  at(g, fbox(1.7, 0.6, 3.4), HEX.redLight, 0, 0.3, -0.6);     // hull -2.3 .. 1.1
  at(g, prism(1.7, 0.6, 1.2), HEX.redLight, 0, 0.3, 1.7);     // sharp nose -> 2.3
  at(g, fbox(1.3, 0.08, 0.9), HEX.red, 0, 0.9, -1.6);         // small rear deck

  turret.position.set(0, 0.9, -0.1);
  at(turret, pillar(0.82, 0.95, 0.45, 6, Math.PI / 6), HEX.redLight, 0, 0, 0);
  at(turret, fbox(1.1, 0.06, 0.22), HEX.bone, 0, 0.45, -0.1);       // bone stripe
  at(turret, pillar(0.26, 0.28, 0.12, 6), HEX.red, 0.3, 0.45, -0.5);

  const gun = part(barrel(0.1, 2.0, 6), HEX.red);
  gun.position.set(0, 0.24, 0.85);
  turret.add(gun);
  muzzleAt(g, turret, 0, 0.24, 2.9);

  return g;
}

function enemyMedium() {
  const g = vehicle({ length: 6.0, width: 3.0, height: 1.85 });
  g.userData.variant = 'medium';
  const turret = g.userData.turret;

  track(g, at(g, fbox(0.7, 0.55, 6.0), HEX.grey, -1.15, 0, 0));
  track(g, at(g, fbox(0.7, 0.55, 6.0), HEX.grey,  1.15, 0, 0));

  at(g, fbox(2.3, 0.75, 5.2), HEX.red, 0, 0.3, -0.4);          // hull -3.0 .. 2.2
  at(g, prism(2.3, 0.75, 0.8), HEX.red, 0, 0.3, 2.6);          // short nose -> 3.0

  // side skirts: they square the silhouette off into a clean rectangle
  at(g, fbox(0.14, 0.45, 5.2), HEX.redDark, -1.52, 0.6, -0.4);
  at(g, fbox(0.14, 0.45, 5.2), HEX.redDark,  1.52, 0.6, -0.4);

  // two fuel drums -- a pair of circles at the rear, unique to the medium
  at(g, pillar(0.32, 0.32, 0.6, 10), HEX.redDark, -0.72, 1.05, -2.1);
  at(g, pillar(0.32, 0.32, 0.6, 10), HEX.redDark,  0.72, 1.05, -2.1);

  turret.position.set(0, 1.05, -0.3);
  at(turret, fbox(2.0, 0.6, 2.2), HEX.red, 0, 0, 0);               // slab turret
  at(turret, fbox(0.9, 0.42, 0.5), HEX.redDark, 0, 0.1, 1.3);      // mantlet
  at(turret, fbox(0.8, 0.07, 0.55), HEX.bone, -0.45, 0.6, -0.6);   // bone plate
  at(turret, pillar(0.3, 0.33, 0.16, 8), HEX.redDark, 0.5, 0.6, -0.5);

  const gun = part(barrel(0.14, 3.4), HEX.redDark);
  gun.position.set(0, 0.3, 1.1);
  turret.add(gun);
  muzzleAt(g, turret, 0, 0.3, 4.55);

  return g;
}

function enemyHeavy() {
  const g = vehicle({ length: 7.8, width: 4.2, height: 2.28 });
  g.userData.variant = 'heavy';
  const turret = g.userData.turret;

  track(g, at(g, fbox(1.0, 0.75, 7.8), HEX.grey, -1.6, 0, 0));
  track(g, at(g, fbox(1.0, 0.75, 7.8), HEX.grey,  1.6, 0, 0));

  at(g, fbox(3.0, 0.95, 6.4), HEX.redDark, 0, 0.375, -0.7);     // hull -3.9 .. 2.5
  at(g, prism(3.0, 0.95, 1.4), HEX.redDark, 0, 0.375, 3.2);     // big wedge -> 3.9

  // overhanging sponsons: the heavy's top silhouette is wider than its tracks
  at(g, fbox(0.62, 0.3, 4.0), HEX.red, -1.78, 1.02, -0.9);
  at(g, fbox(0.62, 0.3, 4.0), HEX.red,  1.78, 1.02, -0.9);
  at(g, fbox(2.4, 0.16, 1.5), HEX.red, 0, 1.325, -2.9);         // engine deck
  at(g, fbox(1.6, 0.08, 0.3), HEX.bone, 0, 1.485, -2.9);        // bone marking

  turret.position.set(0, 1.325, -0.3);
  at(turret, pillar(1.58, 1.75, 0.95, 8, Math.PI / 8), HEX.redDark, 0, 0, 0);
  at(turret, fbox(1.3, 0.55, 0.7), HEX.redDark, 0, 0.2, 1.55);         // huge mantlet
  at(turret, pillar(0.42, 0.46, 0.3, 8), HEX.red, -0.88, 0.95, -0.7);  // offset cupola
  at(turret, fbox(0.9, 0.07, 0.6), HEX.bone, 0.75, 0.95, -0.55);

  const gun = part(barrel(0.22, 5.6, 10), HEX.red);
  gun.position.set(0, 0.48, 1.7);
  turret.add(gun);
  at(turret, fbox(0.6, 0.55, 0.85), HEX.redDark, 0, 0.2, 6.45);        // muzzle brake
  muzzleAt(g, turret, 0, 0.48, 7.4);

  return g;
}

/**
 * INFANTRY -- about a metre across. From above: an amber lozenge with a round
 * helmet in the middle and one thin grey rifle poking forward, which is enough
 * to show facing. No turret; the muzzle sits at the rifle tip.
 */
export function createInfantry() {
  const g = new THREE.Group();

  at(g, fbox(0.42, 0.44, 0.3), HEX.amberDim, 0, 0, 0);          // legs
  at(g, fbox(0.58, 0.44, 0.4), HEX.amber, 0, 0.42, 0);          // torso
  at(g, pillar(0.24, 0.27, 0.14, 8), HEX.amber, 0, 0.86, 0.02); // helmet
  at(g, fbox(0.08, 0.08, 0.95), HEX.grey, 0.27, 0.62, 0.3);     // rifle

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0.27, 0.66, 0.78);
  g.add(muzzle);

  g.userData.turret = null;
  g.userData.muzzle = muzzle;
  g.userData.hull = { length: 0.75, width: 0.8, height: 1.0 };
  g.userData.tracks = [];
  return g;
}

/* ================================================================== *
 * Environment pieces
 *
 * A Warsaw Pact / NATO gunnery range in Central Europe, about 1985: worn
 * concrete, frozen mud, utilitarian hardware, nothing decorative.
 *
 * Everything here is deliberately LOW CONTRAST against the floor -- only the
 * olive-drab ramp the palette sets aside for it (void / char / ground / grid /
 * edge) plus a whisper of HEX.grey -- so
 * the bone player and the red enemies stay the brightest things on screen. No
 * amber and no bright bone out here; those colours belong to the units.
 *
 * Every piece carries:
 *   userData.radius     bounding circle, used by the arena placer
 *   userData.obstacles  [{ x, z, radius, solid, height }] in LOCAL space
 * Collision radii are generous, so a tank never visually clips a solid. The
 * height is honest, so the game can let a gun fire over dragon's teeth and
 * sandbags while a blast wall or a tree line still blocks the shot.
 */

const CONCRETE = HEX.edge;     // the lightest tone out here
const EARTH = HEX.grid;        // berms, mud, hedges
const CHAR = HEX.char;         // burnt earth, shadow, hollows -- the palette's own

function scenic(radius) {
  const g = new THREE.Group();
  g.userData.radius = radius;
  g.userData.obstacles = [];
  g.userData.turret = null;
  g.userData.muzzle = null;
  g.userData.tracks = [];
  // a coarse footprint, so scenery answers the same questions a vehicle does
  g.userData.hull = { length: radius * 2, width: radius * 2, height: 1.2 };
  return g;
}

function obst(g, x, z, radius, solid = true, height = 2.0) {
  g.userData.obstacles.push({ x, z, radius, solid, height });
}

/**
 * DRAGON'S TEETH -- staggered rows of concrete pyramids sunk in a mud strip.
 * The signature Cold War anti-tank obstacle and the arena's main visual motif:
 * from above, a dotted zig-zag line of hard little diamonds.
 */
export function createDragonsTeeth(count = 7, seed = 1) {
  const rnd = mulberry32(seed);
  const step = 1.75;
  const span = (count - 1) * step;
  const g = scenic(span / 2 + 1.2);

  // one shared mud strip rather than a plinth per tooth -- same read from above
  // for a fraction of the objects
  at(g, fbox(span + 1.5, 0.14, 2.1), EARTH, 0, 0, 0);

  for (let i = 0; i < count; i++) {
    const x = -span / 2 + i * step;
    const z = (i % 2 ? 0.42 : -0.42) + range(rnd, -0.12, 0.12);
    const h = range(rnd, 0.95, 1.3);
    const tooth = at(g, pyramid(1.15, h), CONCRETE, x, 0.14, z);
    tooth.rotation.y = range(rnd, -0.14, 0.14);
  }

  /* The row collides as ONE continuous barrier described by a few fair-fitting
   * circles, rather than a circle per tooth: a single tooth is not something a
   * tank notices, but a poured belt of them is. Low, so a gun clears it. */
  const bR = 1.5;
  const steps = Math.max(2, Math.ceil((span + 1.3) / (bR * 1.6)));
  for (let i = 0; i < steps; i++) {
    obst(g, -span / 2 + (span * i) / (steps - 1), 0, bR, true, 1.45);
  }
  return g;
}

/**
 * REVETMENT -- a U-shaped earth bank opening forward (+Z). A tank reverses in
 * and fires out of the mouth; from above it reads as a thick open bracket.
 */
export function createRevetment() {
  const g = scenic(4.6);

  at(g, berm(8.4, 1.9, 1.2, 0.5), EARTH, 0, 0, -3.2);       // back bank
  at(g, berm(1.9, 4.4, 1.2, 0.5), EARTH, -3.4, 0, -1.0);    // left wing
  at(g, berm(1.9, 4.4, 1.2, 0.5), EARTH,  3.4, 0, -1.0);    // right wing
  // revetted inner face: a scrap of concrete retaining wall, half collapsed
  at(g, fbox(5.8, 0.3, 0.3), CONCRETE, 0, 0, -2.3);

  /* A shallow scoop, open the full width downrange: a tank reverses straight
   * out of it. Circles fit the banks rather than the whole U, so there is no
   * invisible no-go zone in the mouth. */
  for (const bx of [-2.9, 0, 2.9]) obst(g, bx, -3.2, 1.6, true, 1.2);
  for (const sx of [-3.4, 3.4]) {
    obst(g, sx, -2.1, 1.6, true, 1.2);
    obst(g, sx, 0.2, 1.6, true, 1.2);
  }
  return g;
}

/**
 * BLAST WALL -- a short run of concrete T-wall panels with splayed feet, with
 * one panel missing so a tank can shoot the gap. Reads as a dashed thick line.
 */
export function createBlastWall(len = 9) {
  const panel = 2.3, gap = 0.18;
  const n = Math.max(2, Math.round(len / (panel + gap)));
  const span = n * panel + (n - 1) * gap;
  const g = scenic(span / 2 + 0.8);
  const missing = n > 3 ? Math.floor(n / 2) : -1;

  for (let i = 0; i < n; i++) {
    if (i === missing) continue;
    const x = -span / 2 + panel / 2 + i * (panel + gap);
    at(g, fbox(panel, 0.3, 1.25), EARTH, x, 0, 0);          // foot
    at(g, fbox(panel - 0.2, 1.85, 0.34), CONCRETE, x, 0.3, 0);
    at(g, fbox(panel - 0.2, 0.1, 0.44), EARTH, x, 2.15, 0); // capping
    obst(g, x, 0, 1.28, true, 2.25);   // fits the panel; tall, so it stops a shot
  }
  return g;
}

/**
 * TREE LINE -- a bare 1985 field boundary: a low hedgerow bank with leafless
 * trees along it. Mostly here to break sightlines, so the canopies are wide and
 * dark and the trunks are solid.
 */
export function createTreeLine(len = 14, seed = 1) {
  const rnd = mulberry32(seed);
  const g = scenic(len / 2 + 1.4);

  // hedgerow bank in segments, with one deliberate gap
  const segs = Math.max(2, Math.round(len / 3.2));
  const gapAt = Math.floor(range(rnd, 1, segs - 0.01));
  for (let i = 0; i < segs; i++) {
    if (i === gapAt) continue;
    const x = -len / 2 + len * ((i + 0.5) / segs);
    at(g, berm(len / segs - 0.25, range(rnd, 1.5, 2.1), range(rnd, 0.75, 1.05), 0.6),
       EARTH, x, 0, range(rnd, -0.3, 0.3));
    obst(g, x, 0, 1.65, true, 1.1);    // the hedge BANK stops a tank
  }

  const trees = Math.max(2, Math.round(len / 4.5));
  for (let i = 0; i < trees; i++) {
    const x = -len / 2 + 1 + range(rnd, 0, len - 2);
    const z = range(rnd, -0.8, 0.8);
    const h = range(rnd, 2.6, 4.0);
    at(g, pillar(0.16, 0.28, h, 5), CHAR, x, 0.5, z);
    const crown = at(g, pillar(0.5, 1.5, 0.9, 6, range(rnd, 0, 1)), EARTH, x, 0.5 + h * 0.75, z);
    crown.scale.set(range(rnd, 0.9, 1.3), 1, range(rnd, 0.9, 1.3));
    // a bare tree is not an obstacle to sixty tonnes -- decoration only, but
    // tall, so the game may still use it to break a sightline
    obst(g, x, z, 1.1, false, 3.4);
  }
  return g;
}

/**
 * CRATER -- a flat scorched disc with a raised lip of thrown-up earth. Drivable
 * (solid: false), so it is cover for the eye rather than for the hull.
 */
export function createCrater(radius = 2.4) {
  const g = scenic(radius * 1.2);

  const floorDisc = at(g, disc(12), CHAR, 0, 0.03, 0);
  floorDisc.scale.set(radius, 1, radius);
  const inner = at(g, disc(10), HEX.ground, 0, 0.05, 0);
  inner.scale.set(radius * 0.52, 1, radius * 0.52);

  const lip = at(g, cachedGeo('lip', () =>
    new THREE.TorusGeometry(1, 0.26, 4, 12).rotateX(-Math.PI / 2).scale(1, 0.55, 1)),
    EARTH, 0, 0.04, 0);
  lip.scale.set(radius, 1, radius);

  obst(g, 0, 0, radius * 0.85, false, 0);
  return g;
}

/**
 * WRECK -- the hulk of a previous tank, half-buried and burnt out. Turret blown
 * off and lying beside the hull, gun bent at the sky. Good hard cover, and from
 * above a long dark mass that is clearly not a live tank.
 */
export function createWreck(seed = 1) {
  const rnd = mulberry32(seed);
  const g = scenic(3.0);

  const scorchDisc = at(g, disc(10), CHAR, 0, 0.025, 0);
  scorchDisc.scale.set(3.3, 1, 3.3);

  const hull = at(g, fbox(2.5, 0.85, 4.4), EARTH, 0, -0.22, 0);   // sunk into the mud
  hull.rotation.z = range(rnd, -0.09, 0.09);
  hull.rotation.y = range(rnd, -0.05, 0.05);
  at(g, fbox(2.1, 0.18, 1.5), CHAR, 0, 0.6, -1.1);                // burnt-open deck
  at(g, fbox(0.6, 0.4, 4.4), EARTH, -1.45, -0.3, 0);              // shed track
  at(g, fbox(0.6, 0.18, 3.0), CHAR, 1.5, 0, range(rnd, -0.6, 0.6));

  // the turret, upside down in the dirt a couple of metres off
  const tx = range(rnd, 1.6, 2.4) * (rnd() < 0.5 ? -1 : 1);
  const tz = range(rnd, -1.8, 1.8);
  const tur = at(g, pillar(1.1, 0.95, 0.55, 6), EARTH, tx, 0, tz);
  tur.rotation.set(range(rnd, -0.2, 0.2), range(rnd, 0, 3), range(rnd, -0.2, 0.2));
  const stub = at(g, barrel(0.17, 2.6, 6), CHAR, tx, 0.4, tz);
  stub.rotation.set(range(rnd, -0.9, -0.3), range(rnd, 0, 6), 0);

  obst(g, 0, -1.2, 1.7, true, 1.25);  // half-buried hull: real hull-down cover
  obst(g, 0,  1.2, 1.7, true, 1.25);
  obst(g, tx, tz, 1.3, false, 0.9);   // the blown-off turret is just debris
  return g;
}

/**
 * FUEL DRUMS -- range furniture. A stack of 200-litre drums, a couple on their
 * sides. From above: a tight cluster of small circles.
 */
export function createFuelDrums(n = 5) {
  const g = scenic(1.9);
  const ring = [[0, 0], [0.76, 0.18], [-0.7, 0.42], [0.2, -0.82], [-0.5, -0.6],
                [0.9, -0.5], [-0.95, -0.1]];
  for (let i = 0; i < Math.min(n, ring.length); i++) {
    const [x, z] = ring[i];
    at(g, pillar(0.34, 0.34, 0.92, 10), CONCRETE, x, 0, z);
    at(g, pillar(0.36, 0.36, 0.08, 10), EARTH, x, 0.42, z);   // rolling hoop
  }
  // one drum knocked over
  const down = at(g, barrel(0.34, 0.92, 10), EARTH, -0.2, 0.34, 1.35);
  down.rotation.y = 0.5;
  // a drum stack is knee-high clutter: drive over it
  obst(g, 0, 0, 1.5, false, 1.0);
  obst(g, -0.2, 1.35, 0.7, false, 0.7);
  return g;
}

/**
 * PIPE SECTION -- a length of concrete culvert dumped on the range, lying on its
 * side. Open-ended, so from above you read a dark bore straight through it.
 */
export function createPipeSection() {
  const g = scenic(2.1);
  const tube = cachedGeo('pipe-out', () =>
    new THREE.CylinderGeometry(0.85, 0.85, 3.4, 12, 1, true)
      .rotateZ(Math.PI / 2));
  const bore = cachedGeo('pipe-in', () =>
    new THREE.CylinderGeometry(0.66, 0.66, 3.45, 12, 1, true)
      .rotateZ(Math.PI / 2));
  at(g, tube, CONCRETE, 0, 0.85, 0, true);
  at(g, bore, CHAR, 0, 0.85, 0, true);
  at(g, fbox(0.5, 0.2, 1.7), EARTH, -1.9, 0, 0);   // chock
  obst(g, -0.9, 0, 0.95, true, 1.7);  // solid concrete, and tall enough to stop a shot
  obst(g,  0.9, 0, 0.95, true, 1.7);
  return g;
}

/**
 * SANDBAG EMPLACEMENT -- three staggered courses of bags in a shallow arc, the
 * sort of thing a range safety officer stands behind.
 */
export function createSandbagNest() {
  const g = scenic(2.4);
  for (let row = 0; row < 3; row++) {
    const n = 4 - (row % 2 ? 1 : 0);
    const step = 0.9;
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * step;
      const z = (row % 2 ? 0.06 : -0.06) + Math.abs(x) * 0.12;
      at(g, fbox(0.84, 0.3, 0.56), HEX.grey, x, row * 0.29, z);
    }
  }
  // under a metre high and under three across: decoration, not an obstacle
  obst(g, -1.1, 0, 1.0, false, 0.9);
  obst(g,  1.1, 0, 1.0, false, 0.9);
  return g;
}

/**
 * OBSERVATION POST -- derelict concrete range tower: plinth, tapered shaft,
 * overhanging platform with a broken railing and dark viewing slits. The only
 * tall thing on the map, so it reads as a landmark from directly above.
 */
export function createObservationPost() {
  const g = scenic(2.4);

  at(g, fbox(3.2, 0.35, 3.2), EARTH, 0, 0, 0);                     // plinth
  at(g, berm(2.3, 2.3, 3.4, 0.82), CONCRETE, 0, 0.35, 0);          // shaft
  const deck = at(g, fbox(3.4, 0.3, 3.4), EARTH, 0, 3.75, 0);      // platform
  deck.rotation.y = 0.07;                                          // settled askew
  at(g, fbox(2.6, 0.5, 0.18), CONCRETE, 0, 4.05, -1.5);            // parapet, 3 sides
  at(g, fbox(0.18, 0.5, 2.6), CONCRETE, -1.5, 4.05, 0);
  at(g, fbox(0.18, 0.5, 1.3), CONCRETE, 1.5, 4.05, -0.6);          // broken run
  at(g, fbox(2.0, 0.22, 0.1), CHAR, 0, 3.0, 1.18);                 // viewing slits
  at(g, fbox(0.1, 0.22, 2.0), CHAR, -1.18, 3.0, 0);
  at(g, fbox(0.5, 1.1, 0.12), CHAR, 0.6, 0.35, 1.1);               // doorway
  obst(g, 0, 0, 2.1, true, 4.1);
  return g;
}

/**
 * CHAIN-LINK FENCE -- posts and wire drawn as plain dim line segments, with a
 * torn-open gap. Not solid: a tank drives straight through it, but it reads as
 * a boundary and clutters the sightline.
 */
function createFenceRun(len = 12, seed = 1) {
  const rnd = mulberry32(seed);
  const bay = 2.6;
  const n = Math.max(2, Math.round(len / bay));
  const span = n * bay;
  const g = scenic(span / 2 + 0.5);
  const torn = Math.floor(range(rnd, 0, n));

  const panel = cachedGeo(`mesh|${bay}`, () => {
    const pts = [];
    const h = 1.9;
    for (let x = 0; x <= bay + 1e-6; x += bay / 6) { pts.push(x, 0.1, 0, x, h, 0); }
    for (let y = 0.1; y <= h + 1e-6; y += (h - 0.1) / 4) { pts.push(0, y, 0, bay, y, 0); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return geo;
  });

  for (let i = 0; i < n; i++) {
    const x0 = -span / 2 + i * bay;
    const post = at(g, pillar(0.08, 0.1, 2.1, 4), CHAR, x0, 0, 0);
    post.rotation.y = range(rnd, -0.1, 0.1);
    if (i === torn) continue;
    const wire = new THREE.LineSegments(panel, WIRE);
    wire.position.set(x0, 0, 0);
    wire.raycast = noRaycast;
    g.add(wire);
    obst(g, x0 + bay / 2, 0, bay * 0.55, false, 1.9);
  }
  at(g, pillar(0.08, 0.1, 2.1, 4), CHAR, span / 2, 0, 0);
  return g;
}

/**
 * GROUND MARKINGS -- a concrete apron with faded painted lane lines and numbered
 * firing-point ticks. Flat decals only: no collision, no height, no obstacles.
 */
function createApron(w, d, seed) {
  const rnd = mulberry32(seed);
  const g = scenic(Math.hypot(w, d) / 2);

  at(g, fbox(w, 0.04, d), EARTH, 0, 0.012, 0);               // the slab itself
  // expansion joints
  for (let x = -w / 2 + 3; x < w / 2 - 1; x += 3.5) paint(g, fbox(0.1, 0.02, d - 0.4), HEX.ground, x, 0.052, 0);
  // faded lane lines running down-range, dashed
  const lanes = Math.max(2, Math.round(w / 6));
  for (let i = 0; i <= lanes; i++) {
    const x = -w / 2 + (w * i) / lanes;
    for (let z = -d / 2 + 1; z < d / 2 - 0.5; z += 2.4) {
      paint(g, fbox(0.18, 0.02, 1.4), CONCRETE, x, 0.056, z + range(rnd, -0.1, 0.1));
    }
  }
  // firing-point markers: a bar plus tick marks, one per lane
  for (let i = 0; i < lanes; i++) {
    const x = -w / 2 + (w * (i + 0.5)) / lanes;
    paint(g, fbox(1.9, 0.02, 0.22), CONCRETE, x, 0.056, -d / 2 + 1.6);
    for (let t = 0; t <= i; t++) {
      paint(g, fbox(0.16, 0.02, 0.7), HEX.grey, x - 0.5 + t * 0.34, 0.058, -d / 2 + 2.5);
    }
  }
  return g;
}

/**
 * SCENERY -- the original brief's small clutter, now a thin wrapper over the
 * range pieces plus two leftovers of its own (rock, crate).
 */
export function createScenery(kind = 'rock', seed = 1) {
  if (kind === 'wreck') return createWreck(seed);
  if (kind === 'sandbag') return createSandbagNest();

  const rnd = mulberry32(seed);
  const g = scenic(1.6);

  if (kind === 'crate') {
    at(g, fbox(1.5, 1.15, 1.5), EARTH, 0, 0, 0);
    at(g, fbox(1.6, 0.08, 0.26), CONCRETE, 0, 1.15, 0);
    at(g, fbox(0.26, 0.08, 1.6), CONCRETE, 0, 1.15, 0);
    g.rotation.y = range(rnd, -0.4, 0.4);
    g.userData.hull = { length: 1.5, width: 1.5, height: 1.23 };
    obst(g, 0, 0, 1.2, false, 1.25);   // a crate is decoration
  } else {   // 'rock'
    const geo = cachedGeo('rock', () => new THREE.IcosahedronGeometry(0.9, 0));
    const m = part(geo, CONCRETE);
    m.scale.set(range(rnd, 1.1, 1.5), range(rnd, 0.5, 0.75), range(rnd, 1.0, 1.4));
    m.rotation.set(range(rnd, 0, 3), range(rnd, 0, 3), range(rnd, 0, 3));
    m.position.y = 0.35;
    g.add(m);
    g.userData.hull = { length: 2.2, width: 2.4, height: 1.1 };
    obst(g, 0, 0, 1.4, false, 1.1);    // so is a rock
  }
  return g;
}

/**
 * SUPPLY CRATE -- bone box with a bright amber cross on the lid, so it reads as
 * "pick me up" from directly overhead and never as enemy armour.
 */
export function createSupplyCrate() {
  const g = new THREE.Group();
  at(g, fbox(1.3, 1.0, 1.3), HEX.bone, 0, 0, 0);
  at(g, fbox(1.36, 0.1, 0.34), HEX.amber, 0, 1.0, 0);
  at(g, fbox(0.34, 0.1, 1.36), HEX.amber, 0, 1.0, 0);
  at(g, fbox(1.34, 0.16, 0.1), HEX.amberDim, 0, 0.45, 0.63);

  g.userData.turret = null;
  g.userData.muzzle = null;
  g.userData.tracks = [];
  g.userData.hull = { length: 1.3, width: 1.3, height: 1.1 };
  return g;
}

/* ================================================================== *
 * Arena
 * ================================================================== */

const CENTRE_CLEAR = 18;    // the player starts here: never build inside it
const COVER_TARGET = 0.20;  // roughly how much of the floor has something on it
/* A tank is 3.3 wide and 6.6 long and turns on its tracks, so it needs room to
 * manoeuvre rather than a slot to thread. No two solid set pieces may leave a
 * gap narrower than this between them; the arena enforces it by pruning. */
const MIN_GAP = 12;

/**
 * Bounding radius of each piece, known WITHOUT building it. These must stay in
 * step with the userData.radius each builder sets; the arena uses them to reject
 * candidate positions before any geometry is made.
 */
const RADIUS = {
  dragonsTeeth: (count) => ((count - 1) * 1.75) / 2 + 1.2,
  revetment: () => 4.6,
  blastWall: (len) => {
    const n = Math.max(2, Math.round(len / 2.48));
    return (n * 2.3 + (n - 1) * 0.18) / 2 + 0.8;
  },
  treeLine: (len) => len / 2 + 1.4,
  crater: (r) => r * 1.2,
  wreck: () => 3.0,
  fuelDrums: () => 1.9,
  pipeSection: () => 2.1,
  fenceRun: (len) => (Math.max(2, Math.round(len / 2.6)) * 2.6) / 2 + 0.5,
  sandbagNest: () => 2.4,
  observationPost: () => 2.4,
};

/** Rotate a piece's local obstacle into world space and record it. */
function stamp(out, piece, x, z, ry) {
  const cos = Math.cos(ry), sin = Math.sin(ry);
  for (const o of piece.userData.obstacles) {
    out.push({
      x: x + o.x * cos + o.z * sin,
      z: z - o.x * sin + o.z * cos,
      radius: o.radius,
      solid: o.solid,
      height: o.height,
    });
  }
}

/**
 * createArena(size, seed)
 *
 * A seeded Cold War gunnery range, laid out in zones that make sense together
 * rather than as a scatter of props: a firing line with its revetted bays,
 * painted apron and observation tower; the stores dump behind it; an impact
 * area of craters and burnt-out target hulks downrange; anti-tank belts of
 * dragon's teeth cutting across at an angle; and hedgerows along the old field
 * boundaries. The whole layout is rotated by a seeded angle.
 *
 * Hard rules, in order of priority:
 *   1. the central CENTRE_CLEAR-radius disc stays completely empty (player spawn)
 *   2. no two solid set pieces leave a gap narrower than MIN_GAP, so the player
 *      can always manoeuvre -- enforced by pruning after everything is placed
 *   3. every anti-tank belt is broken by openings, never a wall across the map
 *   4. only then, fill toward COVER_TARGET, and only with craters, which a tank
 *      drives straight through
 *
 * Returns, on userData:
 *   obstacles  [{ x, z, radius, solid, height }]  for collision + AI pathing
 *   spawnRing  radius at which enemies can safely appear
 *   size, half, playable, wall, seed, coverage, centreClear
 */
export function createArena(size = 150, seed = 1) {
  const rnd = mulberry32(seed);
  const g = new THREE.Group();
  const half = size / 2;
  const obstacles = [];

  /* --- floor, void, grid --- */

  const voidPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(size * 4, size * 4).rotateX(-Math.PI / 2), mat(HEX.void));
  voidPlane.position.y = -0.4;
  voidPlane.raycast = noRaycast;
  g.add(voidPlane);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), mat(HEX.ground));
  floor.name = 'floor';
  g.add(floor);

  const cells = Math.max(1, Math.round(size / 10));
  const grid = new THREE.GridHelper(size, cells, HEX.grid, HEX.grid);
  grid.position.y = 0.008;
  grid.material.depthWrite = false;
  grid.raycast = noRaycast;
  g.add(grid);

  /* --- boundary: kerb flush with the floor, wall standing outside it --- */

  const wallH = 1.6, wallT = 1.2;
  for (let i = 0; i < 4; i++) {
    const alongX = i < 2;
    const sign = i % 2 ? 1 : -1;
    const len = size + wallT * 2;
    at(g, alongX ? fbox(len, wallH, wallT) : fbox(wallT, wallH, len), HEX.edge,
       alongX ? 0 : sign * (half + wallT / 2), 0,
       alongX ? sign * (half + wallT / 2) : 0);
    at(g, alongX ? fbox(size, 0.12, 0.6) : fbox(0.6, 0.12, size), HEX.edge,
       alongX ? 0 : sign * (half - 0.3), 0.01,
       alongX ? sign * (half - 0.3) : 0);
  }

  /* ---------------------------------------------------------------- *
   * Zoned layout
   *
   * The range was built for a purpose, so it is laid out as one: a firing
   * line along one side with its apron and markings, the stores dump and the
   * observation post behind it, an impact area downrange full of shell holes
   * and the hulks that were the targets, anti-tank belts cutting across at an
   * angle, and old field boundaries picked out by hedgerows.
   *
   * Everything is positioned in RANGE-LOCAL coordinates:
   *   f = downrange, the direction the guns point
   *   c = cross-range, along the firing line
   * The whole frame is then rotated by a seeded angle, so no two seeds share
   * an orientation.
   *
   * Navigability beats density. Set pieces of different GROUPS must leave at
   * least MIN_GAP between them, which is enforced afterwards by pruning; two
   * segments of the same barrier share a group, so a belt or a hedgerow can
   * abut itself without the pass trying to punch a hole in it.
   * ---------------------------------------------------------------- */

  const theta = rnd() * Math.PI * 2;
  const ux = Math.cos(theta), uz = Math.sin(theta);     // downrange unit vector
  const vx = -uz, vz = ux;                              // cross-range unit vector
  const DOWN = Math.atan2(ux, uz);                      // rotation.y facing downrange
  const toWorld = (f, c) => [ux * f + vx * c, uz * f + vz * c];

  // keep well clear of the wall, so no piece ever leaves an untraversable slot
  // between itself and the kerb
  const limit = Math.max(CENTRE_CLEAR + 18, half - 16);
  const pieces = [];                                    // every placed set piece

  const inBounds = (x, z, r) => {
    const d = Math.hypot(x, z);
    return d - r >= CENTRE_CLEAR && d + r <= limit;
  };

  /* Solids placed so far, so a later piece can stop politely at an earlier one
   * instead of being torn out afterwards. Zones are placed in order of
   * importance, which is what makes the result predictable: the firing line is
   * laid out first and always survives intact, and a belt that runs into a
   * hedgerow simply ends there -- which is how it would have been poured. */
  const placedSolids = [];

  const gapOk = (obs, group) => {
    for (const a of obs) {
      if (!a.solid) continue;
      for (const b of placedSolids) {
        if (b.group === group) continue;             // same barrier: meant to abut
        if (Math.hypot(a.x - b.x, a.z - b.z) - a.radius - b.radius < MIN_GAP) return false;
      }
    }
    return true;
  };

  /**
   * Place one set piece. `group` ties abutting segments into a single logical
   * barrier; `prio` decides who survives the navigability pass (higher wins).
   * A piece that would crowd an earlier solid is refused outright.
   */
  const put = (radius, build, x, z, ry, group, prio = 1) => {
    if (!inBounds(x, z, radius)) return null;
    const piece = build();
    const obs = [];
    stamp(obs, piece, x, z, ry);
    // which barrier each circle belongs to: two circles of the SAME group are
    // meant to abut (a belt, a hedgerow), so MIN_GAP does not apply between them
    for (const o of obs) o.group = group;
    if (!gapOk(obs, group)) { disposeGroup(piece); return null; }

    piece.position.set(x, 0, z);
    piece.rotation.y = ry;
    g.add(piece);
    const rec = { group, prio, radius, obj: piece, obs, dead: false };
    pieces.push(rec);
    for (const o of obs) if (o.solid) placedSolids.push(o);
    return rec;
  };

  /** Same, in range-local coordinates, with ry relative to downrange. */
  const putL = (radius, build, f, c, ry, group, prio) => {
    const [x, z] = toWorld(f, c);
    return put(radius, build, x, z, DOWN + ry, group, prio);
  };

  /**
   * Lay a continuous barrier along a world-space line by walking it in
   * segments. Each piece is built along its own local +X, so the rotation that
   * aligns local +X with the run direction is atan2(-dz, dx).
   */
  const runLine = (x0, z0, x1, z1, segTarget, radiusOf, makeSeg, group, prio = 2) => {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1) return 0;
    const n = Math.max(1, Math.round(len / segTarget));
    const segLen = len / n;
    const ry = Math.atan2(-dz / len, dx / len);
    let placed = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * segLen;
      const x = x0 + (dx / len) * t, z = z0 + (dz / len) * t;
      if (put(radiusOf(segLen), () => makeSeg(segLen, i), x, z, ry, group, prio)) placed++;
    }
    return placed;
  };

  /** Teeth count that makes a row span segLen. */
  const teethFor = (segLen) => Math.max(3, Math.round(segLen / 1.75) + 1);

  /* --- ZONE 1: the firing line ------------------------------------- *
   * Revetted firing bays in an evenly spaced row, every one of them opening
   * downrange, with the painted apron and the firing-point numbers laid out in
   * front of them. The bays are spaced wider than MIN_GAP so a tank can drive
   * between any two of them, and each one is a shallow scoop that reverses out
   * rather than a pocket that traps you.                                     */

  const FL = -limit * 0.62;
  const bays = 4 + Math.floor(rnd() * 2);
  const baySpacing = 24;   // wider than MIN_GAP plus two revetment banks
  const lineHalf = ((bays - 1) * baySpacing) / 2;

  for (let i = 0; i < bays; i++) {
    putL(RADIUS.revetment(), createRevetment, FL, -lineHalf + i * baySpacing, 0, `bay${i}`, 4);
  }

  {
    const aw = lineHalf * 2 + 16, ad = 20;
    const [ax, az] = toWorld(FL + 6 + ad / 2, 0);
    const apron = createApron(aw, ad, (seed * 7919) >>> 0);
    apron.position.set(ax, 0, az);
    apron.rotation.y = DOWN;
    g.add(apron);                       // paint only -- no collision, no obstacles
  }

  // the tower, off one end of the line, overlooking the range
  const postSide = rnd() < 0.5 ? -1 : 1;
  const postC = postSide * (lineHalf + 16);
  putL(RADIUS.observationPost(), createObservationPost, FL - 4, postC, 0, 'post', 5);

  // sandbag nests in a small group beside the tower, and one at each end of the
  // line -- low cover for the range staff, never standing alone in a field
  for (let i = 0; i < 3; i++) {
    putL(RADIUS.sandbagNest(), createSandbagNest,
         FL + 4 + i * 4.2, postC - postSide * (6 + i * 1.5), 0, 'post', 3);
  }
  for (const s of [-1, 1]) {
    putL(RADIUS.sandbagNest(), createSandbagNest, FL + 2, s * (lineHalf + baySpacing * 0.55),
         0, `bayend${s}`, 2);
  }

  /* --- ZONE 2: the stores dump ------------------------------------- *
   * Drums, pipe sections and crates all in one place behind the line, in the
   * corner opposite the tower, screened by an L of blast wall. One group, so
   * the stores can be packed tight against each other the way a dump is.     */

  {
    const dumpC = -postSide * (lineHalf + 15);
    const dumpF = FL - 3;
    const [sx0, sz0] = toWorld(dumpF + 8, dumpC - 10);
    const [sx1, sz1] = toWorld(dumpF + 8, dumpC + 7);
    const [sx2, sz2] = toWorld(dumpF - 9, dumpC + 7);
    // the screen: across the downrange face, then round one flank
    runLine(sx0, sz0, sx1, sz1, 11, RADIUS.blastWall, (l) => createBlastWall(l), 'dump', 3);
    runLine(sx1, sz1, sx2, sz2, 11, RADIUS.blastWall, (l) => createBlastWall(l), 'dump', 3);

    const stores = [
      [0, -4], [3.6, -1.2], [-3.4, 0.4], [1.4, 3.2], [-2.2, 4.0], [4.2, 2.2],
    ];
    for (let i = 0; i < stores.length; i++) {
      const [df, dc] = stores[i];
      const f = dumpF + df, c = dumpC + dc;
      const s = (seed * 65537 + i * 131) >>> 0;
      if (i % 3 === 0) {
        const n = 4 + Math.floor(rnd() * 4);
        putL(RADIUS.fuelDrums(), () => createFuelDrums(n), f, c, range(rnd, 0, 3), 'dump', 2);
      } else if (i % 3 === 1) {
        putL(RADIUS.pipeSection(), createPipeSection, f, c, range(rnd, -0.5, 0.5), 'dump', 2);
      } else {
        putL(1.6, () => createScenery('crate', s), f, c, range(rnd, 0, 3), 'dump', 2);
      }
    }

    // chain-link along the open flank of the compound, with a torn-out gap.
    // Not solid -- a tank goes straight through it -- but it says "compound".
    const [fx0, fz0] = toWorld(dumpF - 9, dumpC - 10);
    const [fx1, fz1] = toWorld(dumpF + 8, dumpC - 10);
    runLine(fx0, fz0, fx1, fz1, 13, RADIUS.fenceRun,
            (l, i) => createFenceRun(l, (seed * 104729 + i * 59) >>> 0), 'dump', 2);
  }

  /* --- ZONE 3: anti-tank belts ------------------------------------- *
   * Continuous staggered teeth poured in long lines across the middle at an
   * angle to the range axis, anchored at the outer end and capped with a
   * concrete stub at the inner end. Every belt is broken into runs with a
   * BELT_GAP opening between them -- real belts left gaps for friendly
   * movement, covered by fire, and an unbroken wall would be miserable.      */

  const BELT_GAP = 18;    // the opening through a belt: wider than MIN_GAP
  const beltTarget = 2 + (rnd() < 0.5 ? 1 : 0);

  for (let laid = 0, tries = 0; laid < beltTarget && tries < 16; tries++) {
    const ang = theta + range(rnd, 0.45, 1.2) * (rnd() < 0.5 ? -1 : 1);
    const dx = Math.cos(ang), dz = Math.sin(ang);
    // belts live in the open ground between the firing line and the beaten
    // zone, crossing it at an angle
    const [mx, mz] = toWorld(limit * range(rnd, -0.12, 0.34),
                             limit * range(rnd, 0.2, 0.6) * (rnd() < 0.5 ? -1 : 1));
    // the line must miss the player's clear disc entirely
    const perp = Math.abs(mx * dz - mz * dx);
    if (perp < CENTRE_CLEAR + 8) continue;

    // how far the belt may run before it leaves the buildable area
    const half2 = Math.sqrt(Math.max(4, (limit - 9) ** 2 - perp * perp));
    const L = Math.min(range(rnd, 42, 64), 2 * half2);

    const mark = pieces.length, solidMark = placedSolids.length;
    let t = -L / 2, used = 0, run = 0, rows = 0;
    while (used < L - 8) {
      const runLen = Math.min(range(rnd, 20, 28), L - used);
      const group = `belt${laid}run${run}`;
      const sd = (seed * 977 + tries * 541 + run * 37) >>> 0;
      const n = runLine(mx + dx * t, mz + dz * t,
                        mx + dx * (t + runLen), mz + dz * (t + runLen), 10.5,
                        (l) => RADIUS.dragonsTeeth(teethFor(l)),
                        (l, i) => createDragonsTeeth(teethFor(l), (sd + i * 13) >>> 0),
                        group, 4);
      rows += n;
      /* Cap each run with a short concrete end block, so a belt is anchored to
       * something at both ends instead of simply stopping in a field. Same
       * group as the run, so it may sit right against the last tooth. */
      if (n > 0) {
        for (const end of [t - 2.4, t + runLen + 2.4]) {
          put(RADIUS.blastWall(5), () => createBlastWall(5),
              mx + dx * end, mz + dz * end, Math.atan2(-dz, dx), group, 4);
        }
      }
      used += runLen + BELT_GAP;
      t += runLen + BELT_GAP;
      run++;
    }

    /* A belt is a motif, not a souvenir: if this one could only squeeze in a
     * single stub row, take it back out and try somewhere else. */
    if (rows < 2) {
      for (let k = pieces.length - 1; k >= mark; k--) disposeGroup(pieces[k].obj);
      pieces.length = mark;
      placedSolids.length = solidMark;
      continue;
    }
    laid++;
  }

  /* --- ZONE 4: old field boundaries -------------------------------- *
   * Long hedgerows and bare tree lines running dead straight along the edges
   * of fields that were there before the range, two of them meeting at a
   * corner. They break sightlines without walling anything off, and they are
   * the one thing out here tall enough to stop a shot.                       */

  {
    // the corner has to sit far enough in that both arms stay inside
    const hF = limit * range(rnd, 0.44, 0.60) * (rnd() < 0.5 ? -1 : 1);
    const hC = limit * range(rnd, 0.42, 0.58) * (rnd() < 0.5 ? -1 : 1);
    const hs = (seed * 15485863) >>> 0;
    const seg = 15;
    const tl = (s) => (l, i) => createTreeLine(l, (s + i * 29) >>> 0);

    // the corner pair shares one group, so the two arms may meet
    const [ca0, cb0] = toWorld(hF, hC);
    const [ca1, cb1] = toWorld(hF, hC - Math.sign(hC) * range(rnd, 34, 52));
    const [ca2, cb2] = toWorld(hF - Math.sign(hF) * range(rnd, 26, 44), hC);
    runLine(ca0, cb0, ca1, cb1, seg, RADIUS.treeLine, tl(hs), 'hedgeA', 3);
    runLine(ca0, cb0, ca2, cb2, seg, RADIUS.treeLine, tl(hs + 7), 'hedgeA', 3);

    // and one lone boundary on the far flank, parallel to the range axis
    const fC = -Math.sign(hC) * limit * range(rnd, 0.6, 0.78);
    const [fa0, fb0] = toWorld(-limit * 0.3, fC);
    const [fa1, fb1] = toWorld(limit * range(rnd, 0.25, 0.5), fC);
    runLine(fa0, fb0, fa1, fb1, seg, RADIUS.treeLine, tl(hs + 19), 'hedgeB', 3);
  }

  /* --- ZONE 5: the impact area ------------------------------------- *
   * Shells land where people shoot, so the craters pile up downrange of the
   * firing line: dense in the middle of the beaten zone, thinning at the
   * edges. The wrecks were the targets, so they sit in it. Craters are not
   * solid, so they may overlap each other and never block a lane.            */

  const impactCount = rnd() < 0.55 ? 2 : 1;
  const impactSpots = [];
  for (let k = 0; k < impactCount; k++) {
    const iF = limit * range(rnd, 0.26, 0.52);
    const iC = (k === 0 ? 1 : -1) * limit * range(rnd, 0.02, 0.3);
    const iR = range(rnd, 20, 28) * (k === 0 ? 1 : 0.75);
    impactSpots.push([iF, iC, iR]);

    const holes = Math.round(range(rnd, 14, 22) * (k === 0 ? 1 : 0.7));
    for (let i = 0; i < holes; i++) {
      const a = range(rnd, 0, Math.PI * 2);
      const d = iR * rnd() ** 1.7;                 // crowd the middle
      const rad = range(rnd, 1.5, 3.8) * (1 - 0.4 * (d / iR));
      putL(RADIUS.crater(rad), () => createCrater(rad),
           iF + Math.cos(a) * d, iC + Math.sin(a) * d, range(rnd, 0, 3), `impact${k}`, 1);
    }

    const hulks = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < hulks; i++) {
      const a = range(rnd, 0, Math.PI * 2);
      const d = iR * range(rnd, 0.25, 1.05);
      const s = (seed * 31337 + k * 701 + i * 97) >>> 0;
      // knocked out facing roughly back up the range, as a target would be
      putL(RADIUS.wreck(), () => createWreck(s), iF + Math.cos(a) * d, iC + Math.sin(a) * d,
           Math.PI + range(rnd, -0.9, 0.9), `hulk${k}${i}`, 3);
    }
  }

  /* --- strays ------------------------------------------------------ *
   * A few shells fell short or wide, and one hulk was towed off and left.    */

  for (let i = 0; i < 7; i++) {
    const a = range(rnd, 0, Math.PI * 2);
    const d = range(rnd, CENTRE_CLEAR + 6, limit - 6);
    const rad = range(rnd, 1.3, 2.4);
    put(RADIUS.crater(rad), () => createCrater(rad),
        Math.cos(a) * d, Math.sin(a) * d, range(rnd, 0, 3), `stray${i}`, 1);
  }
  {
    const a = range(rnd, 0, Math.PI * 2);
    const d = range(rnd, CENTRE_CLEAR + 12, limit - 10);
    put(RADIUS.wreck(), () => createWreck((seed * 8191) >>> 0),
        Math.cos(a) * d, Math.sin(a) * d, range(rnd, 0, Math.PI * 2), 'strayhulk', 2);
  }

  /* --- navigability pass ------------------------------------------- *
   * A tank is 3.3 wide, 6.6 long and steers by its tracks: it needs room to
   * turn, not a slot to thread. So no two solid set pieces may leave a gap
   * narrower than MIN_GAP between them. Craters are not solid and are exempt.
   *
   * Conflicts are collected once, then pieces are dropped greedily -- lowest
   * priority and worst offender first -- until none remain. Dropping a whole
   * piece (rather than one of its obstacle circles) is what keeps collision
   * honest: no mesh is ever left behind without its obstacle.                */

  {
    const conflicts = new Map();        // piece index -> Set of piece indices
    const note = (i, j) => {
      if (!conflicts.has(i)) conflicts.set(i, new Set());
      conflicts.get(i).add(j);
    };
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const A = pieces[i], B = pieces[j];
        if (A.group === B.group) continue;              // same barrier: fine
        let bad = false;
        for (const a of A.obs) {
          if (!a.solid) continue;
          for (const b of B.obs) {
            if (!b.solid) continue;
            if (Math.hypot(a.x - b.x, a.z - b.z) - a.radius - b.radius < MIN_GAP) { bad = true; break; }
          }
          if (bad) break;
        }
        if (bad) { note(i, j); note(j, i); }
      }
    }

    const degree = (i) => (conflicts.get(i) ? conflicts.get(i).size : 0);
    for (;;) {
      let worst = -1;
      for (let i = 0; i < pieces.length; i++) {
        if (pieces[i].dead || degree(i) === 0) continue;
        if (worst < 0) { worst = i; continue; }
        const a = pieces[i], b = pieces[worst];
        if (a.prio !== b.prio) { if (a.prio < b.prio) worst = i; continue; }
        if (degree(i) !== degree(worst)) { if (degree(i) > degree(worst)) worst = i; continue; }
        if (a.radius < b.radius) worst = i;
      }
      if (worst < 0) break;
      const loser = pieces[worst];
      loser.dead = true;
      disposeGroup(loser.obj);
      for (const other of conflicts.get(worst)) conflicts.get(other).delete(worst);
      conflicts.set(worst, new Set());
    }
  }

  /* --- collect what survived --------------------------------------- */

  const area = size * size;
  let builtUp = 0, solidArea = 0;
  const solids = [];
  for (const p of pieces) {
    if (p.dead) continue;
    builtUp += Math.PI * p.radius * p.radius;
    for (const o of p.obs) {
      obstacles.push(o);
      if (o.solid) { solidArea += Math.PI * o.radius * o.radius; solids.push(o); }
    }
  }

  /* --- decoration ---------------------------------------------------- *
   * Everything from here down is scenery: shell holes, drum stacks, sandbags,
   * crates, rubble. None of it is solid, so none of it can narrow a lane or
   * give the AI something to grind against -- which means we can be generous
   * with it, and it is what carries the range up to COVER_TARGET. It is only
   * kept out of the solids themselves, so nothing sits inside a wall.        */

  const clearOfSolids = (x, z, r) => {
    for (const o of solids) if (Math.hypot(o.x - x, o.z - z) < o.radius + r + 0.5) return false;
    return true;
  };

  const deco = (radius, build, x, z, ry) => {
    if (!inBounds(x, z, radius) || !clearOfSolids(x, z, radius)) return false;
    const rec = put(radius, build, x, z, ry, 'deco', 0);
    if (!rec) return false;
    builtUp += Math.PI * radius * radius;
    for (const o of rec.obs) obstacles.push(o);
    return true;
  };

  for (let i = 0; i < 400 && builtUp / area < COVER_TARGET; i++) {
    // mostly in the impact areas and around the set pieces, some of it loose
    let x, z;
    if (impactSpots.length && i % 3 !== 2) {
      const [iF, iC, iR] = impactSpots[i % impactSpots.length];
      const a = range(rnd, 0, Math.PI * 2), d = iR * range(rnd, 0.15, 1.35);
      [x, z] = toWorld(iF + Math.cos(a) * d, iC + Math.sin(a) * d);
    } else {
      const a = range(rnd, 0, Math.PI * 2), d = range(rnd, CENTRE_CLEAR + 4, limit - 4);
      x = Math.cos(a) * d; z = Math.sin(a) * d;
    }
    const s = (seed * 2654435761 + i * 2246822519) >>> 0;
    const roll = rnd();
    if (roll < 0.52) {
      const rad = range(rnd, 1.4, 3.4);
      deco(RADIUS.crater(rad), () => createCrater(rad), x, z, range(rnd, 0, 3));
    } else if (roll < 0.68) {
      const n = 3 + Math.floor(rnd() * 5);
      deco(RADIUS.fuelDrums(), () => createFuelDrums(n), x, z, range(rnd, 0, 3));
    } else if (roll < 0.82) {
      deco(RADIUS.sandbagNest(), createSandbagNest, x, z, range(rnd, 0, Math.PI * 2));
    } else if (roll < 0.92) {
      deco(1.6, () => createScenery('rock', s), x, z, range(rnd, 0, 3));
    } else {
      deco(1.6, () => createScenery('crate', s), x, z, range(rnd, 0, 3));
    }
  }
  /* The range is static and runs to a few thousand nodes, so compose every
   * local matrix once and then stop three.js recomposing them every frame. The
   * order matters: update first (while matrixAutoUpdate is still on), freeze
   * after. Nothing in here ever moves again. */
  g.updateMatrixWorld(true);
  g.traverse((o) => { o.matrixAutoUpdate = false; });

  g.userData.size = size;
  g.userData.half = half;
  g.userData.seed = seed;
  g.userData.wall = { height: wallH, thickness: wallT };
  g.userData.playable = half - 1.2;                 // inside face of the kerb
  g.userData.obstacles = obstacles;
  g.userData.spawnRing = Math.min(limit - 4, Math.max(CENTRE_CLEAR + 14, half - 18));
  g.userData.centreClear = CENTRE_CLEAR;
  g.userData.minGap = MIN_GAP;
  /* coverage: how much of the floor is built up at all, decoration included --
   * what the range LOOKS like. solidCoverage: what a hull actually cannot pass
   * through. The second is necessarily small, because solids are kept few and
   * MIN_GAP apart on purpose. */
  g.userData.coverage = builtUp / area;
  g.userData.solidCoverage = solidArea / area;
  g.userData.solidCount = solids.length;
  return g;
}

/* ================================================================== *
 * FxPool -- sparks, explosions, smoke, tracers and scorch marks.
 *
 * Everything is pooled: geometries and fill materials are shared module-wide,
 * and the handful of per-object fading materials live with their pooled object
 * and get reused. update(dt) advances every live effect and removes dead ones
 * from the scene, so nothing accumulates. Scorch marks are capped at 60 and the
 * oldest is dropped.
 * ================================================================== */

const FX_POOL_CAP = 240;      // free objects kept per kind
const SCORCH_CAP = 60;

function fader(geo) {
  const m = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  mesh.raycast = noRaycast;
  return mesh;
}

export class FxPool {
  constructor(scene) {
    this.scene = scene;
    this.live = [];            // active effects
    this.pools = new Map();    // kind -> free objects
    this.scorches = [];        // oldest first, capped
    this._tmp = new THREE.Vector3();
  }

  /* --- pooling --- */

  _take(kind, build) {
    const free = this.pools.get(kind);
    const o = (free && free.length) ? free.pop() : build();
    o.visible = true;
    o.scale.set(1, 1, 1);
    o.rotation.set(0, 0, 0);
    return o;
  }

  _give(kind, obj) {
    this.scene.remove(obj);
    obj.visible = false;
    let free = this.pools.get(kind);
    if (!free) { free = []; this.pools.set(kind, free); }
    if (free.length < FX_POOL_CAP) free.push(obj);
    else disposeGroup(obj);
  }

  _spawn(kind, obj, cfg) {
    obj.frustumCulled = false;
    this.scene.add(obj);
    this.live.push({
      kind, obj, t: 0,
      life: cfg.life,
      vel: cfg.vel || null,
      grav: cfg.grav || 0,
      floor: cfg.floor === undefined ? null : cfg.floor,
      spin: cfg.spin || null,
      s0: cfg.s0 === undefined ? 1 : cfg.s0,
      s1: cfg.s1 === undefined ? (cfg.s0 === undefined ? 1 : cfg.s0) : cfg.s1,
      fade: cfg.fade || 0,
      pop: cfg.pop || false,       // snap to full size, then hold (muzzle flash)
      delay: cfg.delay || 0,       // hold invisible first (a rising smoke column)
    });
    if (cfg.delay) obj.visible = false;
    return obj;
  }

  /* --- effects --- */

  /** Short-lived hard little sparks thrown out along a surface normal. */
  spark(position, normalVec3, colorHex = HEX.amber, count = 10) {
    const n = this._tmp.set(0, 1, 0);
    if (normalVec3) n.copy(normalVec3);
    if (n.lengthSq() < 1e-6) n.set(0, 1, 0);
    n.normalize();
    const geo = cachedGeo('fx-spark', () => new THREE.BoxGeometry(0.16, 0.16, 0.16));
    for (let i = 0; i < count; i++) {
      const m = this._take('spark', () => {
        const mesh = new THREE.Mesh(geo, mat(colorHex));
        mesh.raycast = noRaycast;
        return mesh;
      });
      m.material = mat(colorHex);
      m.position.copy(position);
      const speed = 5 + fxRnd() * 9;
      const vel = new THREE.Vector3(
        n.x * speed + (fxRnd() - 0.5) * 7,
        n.y * speed + fxRnd() * 5 + 1,
        n.z * speed + (fxRnd() - 0.5) * 7);
      this._spawn('spark', m, {
        life: 0.16 + fxRnd() * 0.2, vel, grav: 20, floor: 0.06,
        s0: 0.7 + fxRnd() * 0.6, s1: 0.05,
      });
    }
  }

  /** Expanding ground ring + a bright flash + tumbling debris. */
  explosion(position, scale = 1) {
    const ring = this._take('ring', () => fader(ringGeo()));
    ring.material.color.setHex(HEX.amber);
    ring.material.opacity = 1;
    ring.position.set(position.x, 0.07, position.z);
    ring.renderOrder = 2;
    this._spawn('ring', ring, { life: 0.42, s0: 0.5 * scale, s1: 4.2 * scale, fade: 1 });

    const flash = this._take('flash', () => fader(disc(10)));
    flash.material.color.setHex(HEX.white);
    flash.material.opacity = 1;
    flash.position.set(position.x, position.y + 0.35, position.z);
    flash.renderOrder = 3;
    this._spawn('flash', flash, { life: 0.1, s0: 2.1 * scale, s1: 0.9 * scale, fade: 1 });

    const inner = this._take('flash', () => fader(disc(10)));
    inner.material.color.setHex(HEX.amber);
    inner.material.opacity = 0.95;
    inner.position.set(position.x, position.y + 0.3, position.z);
    inner.renderOrder = 2;
    this._spawn('flash', inner, { life: 0.26, s0: 1.2 * scale, s1: 2.8 * scale, fade: 0.95 });

    const geo = cachedGeo('fx-debris', () => new THREE.BoxGeometry(0.34, 0.34, 0.34));
    const tints = [HEX.edge, HEX.grid, HEX.grey];
    const count = Math.round(8 + 6 * scale);
    for (let i = 0; i < count; i++) {
      const hex = tints[i % tints.length];
      const m = this._take('debris', () => {
        const mesh = part(geo, hex);
        mesh.raycast = noRaycast;
        return mesh;
      });
      m.material = mat(hex);
      m.position.set(position.x, position.y + 0.3, position.z);
      const s = 0.6 + fxRnd() * 0.8;
      m.scale.setScalar(s);
      const sp = 4 + fxRnd() * 9 * scale;
      const a = fxRnd() * Math.PI * 2;
      this._spawn('debris', m, {
        life: 0.6 + fxRnd() * 0.7,
        vel: new THREE.Vector3(Math.cos(a) * sp, 5 + fxRnd() * 7, Math.sin(a) * sp),
        grav: 22, floor: 0.12,
        spin: new THREE.Vector3(
          (fxRnd() - 0.5) * 12, (fxRnd() - 0.5) * 12, (fxRnd() - 0.5) * 12),
        s0: s, s1: s,
      });
    }
  }

  /** Slow dark puff that drifts upward and swells. */
  smoke(position, scale = 1) {
    const m = this._take('smoke', () => fader(disc(8)));
    m.material.color.setHex(HEX.grid);
    m.material.opacity = 0.8;
    m.position.set(position.x, position.y + 0.12, position.z);
    m.rotation.y = fxRnd() * Math.PI * 2;
    m.renderOrder = 1;
    this._spawn('smoke', m, {
      life: 1.3 + fxRnd() * 0.9,
      vel: new THREE.Vector3((fxRnd() - 0.5) * 0.5, 0.55, (fxRnd() - 0.5) * 0.5),
      s0: 0.7 * scale, s1: 2.6 * scale, fade: 0.8,
    });
  }

  /**
   * MUZZLE FLASH -- the main gun going off, which is the thing the player does
   * most, so it is big and brash: a ragged amber starburst thrown down the bore
   * with a white core inside it, plus a thin ring punching out of the muzzle as
   * the shockwave. It snaps to full size in about 20 ms and is gone by 90.
   *
   * Deliberately NOT outlined: the house style outlines solids, and a flash is
   * light rather than matter -- the hard polygon edges already read as drawn.
   */
  muzzleFlash(position, directionVec3, scale = 1) {
    const yaw = directionVec3 ? Math.atan2(directionVec3.x, directionVec3.z) : 0;
    const v = Math.floor(fxRnd() * 4);

    const outer = this._take(`blast${v}`, () => fader(blastStar(v)));
    outer.material.color.setHex(HEX.amber);
    outer.material.opacity = 1;
    outer.position.copy(position);
    outer.rotation.y = yaw + range(fxRnd, -0.22, 0.22);   // a little roll each shot
    outer.renderOrder = 5;
    this._spawn(`blast${v}`, outer, {
      life: 0.09, s0: 0.5 * scale, s1: 1.3 * scale, fade: 1, pop: true,
    });

    const w = (v + 1) % 4;
    const core = this._take(`blast${w}`, () => fader(blastStar(w)));
    core.material.color.setHex(HEX.white);
    core.material.opacity = 1;
    core.position.copy(position);
    core.rotation.y = yaw + range(fxRnd, -0.3, 0.3);
    core.renderOrder = 6;
    this._spawn(`blast${w}`, core, {
      life: 0.055, s0: 0.34 * scale, s1: 0.8 * scale, fade: 1, pop: true,
    });

    const ring = this._take('ring', () => fader(ringGeo()));
    ring.material.color.setHex(HEX.amber);
    ring.material.opacity = 0.9;
    ring.position.copy(position);
    ring.renderOrder = 5;
    this._spawn('ring', ring, { life: 0.13, s0: 0.3 * scale, s1: 2.3 * scale, fade: 0.9 });

    if (directionVec3) this.spark(position, directionVec3, HEX.amber, 3);
  }

  /**
   * BARREL SMOKE -- the puff that lingers after the shot. Flat polygonal puffs
   * in dim grey-olive that trail OFF the muzzle down the line of fire, swell,
   * and fade over about a second.
   */
  barrelSmoke(position, directionVec3, scale = 1) {
    const dx = directionVec3 ? directionVec3.x : 0;
    const dz = directionVec3 ? directionVec3.z : 1;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    const puffs = 3 + Math.floor(fxRnd() * 2);

    for (let i = 0; i < puffs; i++) {
      const seg = 5 + (i % 3);
      const m = this._take(`puff${seg}`, () => fader(disc(seg)));
      m.material.color.setHex(i % 2 ? HEX.grid : HEX.edge);
      m.material.opacity = 0.55;
      const along = (0.9 + i * 1.5) * scale;
      m.position.set(position.x + nx * along, position.y + fxRnd() * 0.25,
                     position.z + nz * along);
      m.rotation.y = fxRnd() * Math.PI * 2;
      m.renderOrder = 1;
      this._spawn(`puff${seg}`, m, {
        life: 0.7 + fxRnd() * 0.5,
        vel: new THREE.Vector3(nx * (2.2 + fxRnd()) + (fxRnd() - 0.5),
                               0.35 + fxRnd() * 0.3,
                               nz * (2.2 + fxRnd()) + (fxRnd() - 0.5)),
        s0: (0.5 + i * 0.12) * scale, s1: (1.5 + i * 0.3) * scale, fade: 0.55,
      });
    }
  }

  /**
   * WRECK SMOKE -- a column rising off a dead tank for five or six seconds, so
   * a kill leaves a mark on the battlefield instead of vanishing. The puffs are
   * staggered by a delay, so the column keeps coming rather than arriving all
   * at once, and each one rises, spreads and thins.
   */
  wreckSmoke(position, scale = 1) {
    const puffs = 7;
    for (let i = 0; i < puffs; i++) {
      const seg = 5 + (i % 3);
      const m = this._take(`puff${seg}`, () => fader(disc(seg)));
      m.material.color.setHex(i % 3 === 0 ? HEX.char : HEX.grid);
      m.material.opacity = 0.72;
      m.position.set(position.x + (fxRnd() - 0.5) * 1.2 * scale,
                     position.y + 0.3,
                     position.z + (fxRnd() - 0.5) * 1.2 * scale);
      m.rotation.y = fxRnd() * Math.PI * 2;
      m.renderOrder = 1;
      this._spawn(`puff${seg}`, m, {
        life: 2.2 + fxRnd() * 1.5,
        delay: i * (0.3 + fxRnd() * 0.12),
        vel: new THREE.Vector3((fxRnd() - 0.5) * 0.7, 1.05 + fxRnd() * 0.5,
                               (fxRnd() - 0.5) * 0.7),
        s0: 0.8 * scale, s1: (3.2 + fxRnd()) * scale, fade: 0.72,
      });
    }
  }

  /** A fading line: MG bursts and shell paths. */
  tracer(from, to, colorHex = HEX.amber, life = 0.07) {
    const line = this._take('tracer', () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const l = new THREE.Line(geo, new THREE.LineBasicMaterial({
        transparent: true, depthWrite: false,
      }));
      l.frustumCulled = false;
      l.raycast = noRaycast;
      return l;
    });
    const p = line.geometry.attributes.position;
    p.setXYZ(0, from.x, from.y, from.z);
    p.setXYZ(1, to.x, to.y, to.z);
    p.needsUpdate = true;
    line.material.color.setHex(colorHex);
    line.material.opacity = 1;
    line.renderOrder = 4;
    this._spawn('tracer', line, { life, fade: 1 });
  }

  /** Flat dark burn left on the ground. Capped; the oldest is dropped. */
  scorch(position, scale = 1) {
    const m = this._take('scorch', () => fader(disc(10)));
    m.material.color.setHex(HEX.char);
    m.material.opacity = 0.85;
    m.position.set(position.x, 0.035, position.z);
    m.rotation.y = fxRnd() * Math.PI * 2;
    m.scale.setScalar((1.0 + fxRnd() * 0.4) * scale);
    m.renderOrder = -1;
    this.scene.add(m);
    this.scorches.push(m);
    while (this.scorches.length > SCORCH_CAP) this._give('scorch', this.scorches.shift());
    return m;
  }

  /* --- lifecycle --- */

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const e = this.live[i];
      if (e.delay > 0) {
        e.delay -= dt;
        if (e.delay > 0) continue;
        e.obj.visible = true;
      }
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) {
        this.live.splice(i, 1);
        this._give(e.kind, e.obj);
        continue;
      }
      const o = e.obj;
      if (e.vel) {
        if (e.grav) e.vel.y -= e.grav * dt;
        o.position.addScaledVector(e.vel, dt);
        if (e.floor !== null && o.position.y < e.floor) {
          o.position.y = e.floor;
          e.vel.set(e.vel.x * 0.4, Math.abs(e.vel.y) * 0.22, e.vel.z * 0.4);
        }
      }
      if (e.spin) {
        o.rotation.x += e.spin.x * dt;
        o.rotation.y += e.spin.y * dt;
        o.rotation.z += e.spin.z * dt;
      }
      if (e.s0 !== e.s1) {
        // a flash punches out to full size in the first fifth of its life and
        // then just fades; everything else grows evenly
        const t = e.pop ? Math.min(1, k * 5) : k;
        const s = e.s0 + (e.s1 - e.s0) * t;
        o.scale.set(s, s, s);
      }
      if (e.fade) o.material.opacity = e.fade * (1 - k);
    }
  }

  /** Wipe every effect and every scorch, returning all of it to the pools. */
  clear() {
    for (let i = 0; i < this.live.length; i++) this._give(this.live[i].kind, this.live[i].obj);
    this.live.length = 0;
    for (let i = 0; i < this.scorches.length; i++) this._give('scorch', this.scorches[i]);
    this.scorches.length = 0;
  }

  /** Drop the pools too, freeing the per-effect fading materials. */
  dispose() {
    this.clear();
    for (const free of this.pools.values()) for (const o of free) disposeGroup(o);
    this.pools.clear();
  }
}

/* ================================================================== *
 * Teardown
 * ================================================================== */

/**
 * Free everything a group owns. Shared, cached geometries and materials (tagged
 * userData.shared) are left alone -- other objects still reference them, and the
 * cache would otherwise hand out disposed resources.
 */
export function disposeGroup(g) {
  if (!g) return;
  g.traverse((o) => {
    const geo = o.geometry;
    if (geo && !geo.userData.shared) geo.dispose();
    const m = o.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (const one of list) if (one && !one.userData.shared) one.dispose();
  });
  if (g.parent) g.parent.remove(g);
}
