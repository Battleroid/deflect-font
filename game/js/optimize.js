/* Weld the static scenery into a handful of draw calls.
 *
 * The arena is built from a few thousand little meshes, each with its own
 * outline, which came to ~1350 draw calls and about 34 fps -- on nineteen
 * thousand triangles. The cost is entirely per-object overhead, not geometry.
 *
 * None of it ever moves, so its world transforms can be baked in and everything
 * sharing a material merged into one buffer. Frustum culling is given up in the
 * process, which is a good trade when the whole map is a dozen objects.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A key that only groups geometries that can actually be merged together. */
function signature(obj) {
  const attrs = Object.keys(obj.geometry.attributes).sort().join(',');
  return `${obj.type}|${obj.material.uuid}|${attrs}|${obj.geometry.index ? 'i' : 'n'}`;
}

/**
 * Flatten `root` in place. Anything named in `keep` (or any descendant of it) is
 * left alone, for the few things that still need to move or be addressed.
 * Returns a small report so the saving can be measured.
 */
export function flattenStatic(root, keep = []) {
  root.updateMatrixWorld(true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const buckets = new Map();
  const skip = new Set(keep);
  let considered = 0;

  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isLineSegments) return;
    if (obj === root) return;
    // leave anything explicitly kept, and anything under it
    for (let p = obj; p; p = p.parent) if (skip.has(p.name)) return;
    // vertex-coloured helpers (the grid) merge badly; leave them be
    if (obj.material && obj.material.vertexColors) return;
    if (Array.isArray(obj.material)) return;

    const key = signature(obj);
    let b = buckets.get(key);
    if (!b) { b = { sample: obj, geoms: [], objs: [] }; buckets.set(key, b); }
    const g = obj.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, obj.matrixWorld));
    b.geoms.push(g);
    b.objs.push(obj);
    considered++;
  });

  let merged = 0;
  let batches = 0;
  for (const { sample, geoms, objs } of buckets.values()) {
    if (geoms.length < 2) { for (const g of geoms) g.dispose(); continue; }
    let geo = null;
    try { geo = mergeGeometries(geoms, false); } catch { geo = null; }
    for (const g of geoms) g.dispose();
    // a bucket that cannot merge keeps its originals untouched
    if (!geo) continue;

    const out = sample.isLineSegments
      ? new THREE.LineSegments(geo, sample.material)
      : new THREE.Mesh(geo, sample.material);
    out.renderOrder = sample.renderOrder;
    out.frustumCulled = false;
    out.matrixAutoUpdate = false;
    out.updateMatrix();
    out.name = 'merged';

    for (const o of objs) o.parent?.remove(o);
    root.add(out);
    merged += objs.length;
    batches++;
  }

  return { considered, batches, mergedObjects: merged };
}
