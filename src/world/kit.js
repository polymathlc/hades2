// OWNER: AGENT-WORLD
// ---------------------------------------------------------------------------
// THE ORNATE ARCHITECTURE KIT
//
// Every piece in here is procedural geometry authored to survive two tests:
//   1. THE SILHOUETTE TEST (ART_DIRECTION §5 / §9.4). Squint at the frame at
//      1/8 resolution: a column must read as a column, a statue as a figure, a
//      brazier as a brazier. Bare boxes and bare cylinders fail this instantly,
//      which is why nothing in this file is one — every mass carries mouldings,
//      flutes, lobes, a break or a curl.
//   2. THE EDGE-LIGHT TEST (§9.5 "ornament carries the light"). Highlights in a
//      Hades frame live on ARRISES: the fillet between two flutes, the lip of a
//      cornice, the rim of a bowl, the bead of an astragal. So every profile in
//      here is built out of small proud members that catch a rim, rather than
//      out of large flat faces that catch a wash.
//
// STRUCTURE
//   - low-level geometry algebra (merge / lathe / tapered tube / prisms)
//   - moulding vocabulary (egg-and-dart, bead-and-reel, dentils, meander)
//   - the factory API (column / arch / meanderBand / statue / brazier / ...)
//   - Batcher: walks a template Object3D and turns N placements of it into one
//     InstancedMesh per (geometry, material) pair. 200 rubble chunks = 1 call.
//
// Nothing here touches materials directly: a Kit is constructed with a role map
// ('wall' -> 'stone.tartarus') and asks ctx.mats for everything.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

// ===========================================================================
// 1. GEOMETRY ALGEBRA
// ===========================================================================

/** Minimal position/normal/uv merge. No BufferGeometryUtils dependency. */
export function mergeGeos(list, dispose = true) {
  const src = [];
  for (const g of list) {
    if (!g) continue;
    src.push(g.index ? g.toNonIndexed() : g);
  }
  if (!src.length) return new THREE.BufferGeometry();
  let n = 0;
  for (const g of src) n += g.attributes.position.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  let o = 0;
  for (let k = 0; k < src.length; k++) {
    const g = src[k], c = g.attributes.position.count;
    P.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) N.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) U.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
    if (src[k] !== list[k]) g.dispose();
  }
  if (dispose) for (const g of list) { if (g) g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Flat-shaded copy — carved stone reads by its facets, not by a smooth wash. */
export function faceted(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  if (g !== geo) geo.dispose();
  return g;
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _e = new THREE.Euler();

/** Accumulator for building a compound mass out of transformed primitives. */
export class Parts {
  constructor() { this.list = []; }
  /** add(geo, {p:[x,y,z], r:[rx,ry,rz], s:[sx,sy,sz]|number}) */
  add(geo, o) {
    if (!geo) return this;
    if (o) {
      const s = o.s == null ? 1 : o.s;
      _e.set(o.r ? o.r[0] : 0, o.r ? o.r[1] : 0, o.r ? o.r[2] : 0);
      _q.setFromEuler(_e);
      _v.set(o.p ? o.p[0] : 0, o.p ? o.p[1] : 0, o.p ? o.p[2] : 0);
      const sc = typeof s === 'number' ? { x: s, y: s, z: s } : { x: s[0], y: s[1], z: s[2] };
      geo.applyMatrix4(_m4.compose(_v, _q, sc));
    }
    this.list.push(geo);
    return this;
  }
  /** A box specified by its centre — the workhorse for mouldings. */
  box(w, h, d, p, r) { return this.add(new THREE.BoxGeometry(w, h, d), { p, r }); }
  concat(other) { for (const g of other.list) this.list.push(g); return this; }
  merge() { return mergeGeos(this.list); }
  mergeFaceted() { return faceted(mergeGeos(this.list)); }
}

// ===========================================================================
// 1b. IMPLICIT SURFACE — the difference between a MODEL and a PILE
// ===========================================================================
//
// A statue assembled from overlapping SphereGeometry/ConeGeometry primitives is
// a §7 auto-fail and it is instantly legible as one: every sphere-to-sphere
// intersection leaves a hard crease, every low-segment sphere leaves visible
// facet seams, and the interior shells of the union are still there, drawing
// pale slivers through the surface wherever two lobes graze. Review round 2
// counted the primitives on the Cerberus from a screenshot.
//
// The fix is not more segments. It is to stop shipping a union of SHELLS and
// start shipping a single welded SKIN. `Field` accumulates the same anatomical
// vocabulary — ellipsoids, round cones (a capsule whose two ends have different
// radii, which is every limb, neck, muzzle, fang and ear in the kit), rounded
// boxes — as SIGNED DISTANCES, blends them with a polynomial smooth-minimum so
// a haunch FAIRS into a flank instead of poking through it, lets sculpt marks
// be SUBTRACTED (eye sockets, a mouth line, a chisel groove), and polygonises
// the result with naive surface nets.
//
// What comes out is manifold, has no interior geometry, has one continuous
// normal field, and carries a baked ambient-occlusion vertex colour sampled
// from the field itself — which is the "hand AO in the crevices" §4 asks for
// and the single strongest cue that a form was CARVED rather than inflated.
// ---------------------------------------------------------------------------

const _BIG = 1e6;

function smin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

/** Signed distance to a round cone (a capsule with unequal end radii). */
function sdRoundCone(px, py, pz, ax, ay, az, bx, by, bz, r1, r2) {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  if (l2 < 1e-12) {
    const dx = px - ax, dy = py - ay, dz = pz - az;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - Math.max(r1, r2);
  }
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const y = pax * bax + pay * bay + paz * baz;
  const z = y - l2;
  const xvx = pax * l2 - bax * y, xvy = pay * l2 - bay * y, xvz = paz * l2 - baz * y;
  const x2 = xvx * xvx + xvy * xvy + xvz * xvz;
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const sgn = rr < 0 ? -1 : rr > 0 ? 1 : 0;
  const k = sgn * rr * rr * x2;
  if ((z < 0 ? -1 : z > 0 ? 1 : 0) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if ((y < 0 ? -1 : y > 0 ? 1 : 0) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(Math.max(0, x2 * a2 * il2)) + y * rr) * il2 - r1;
}

/**
 * A sculptable implicit volume.
 *   const F = new Field();
 *   F.ell([0,1,0],[0.6,0.5,0.45], 0.18);       // a mass
 *   F.cone([0,1,0],[1,1.2,0], 0.2, 0.05, 0.1); // a limb / horn / fang
 *   F.carve.ell([0.2,1.3,0.4],[0.09,0.07,0.09], 0.05);   // an eye socket
 *   const geo = F.build({ cell: 0.035, ao: 0.45 });
 */
export class Field {
  constructor() {
    this.add = [];
    this.cut = [];
    this._target = this.add;
    const self = this;
    // `F.carve.ell(...)` routes the next primitive into the subtractive list.
    this.carve = {
      ell: (...a) => { self._target = self.cut; self.ell(...a); self._target = self.add; return self; },
      cone: (...a) => { self._target = self.cut; self.cone(...a); self._target = self.add; return self; },
      box: (...a) => { self._target = self.cut; self.box(...a); self._target = self.add; return self; },
    };
  }
  _push(p) { this._target.push(p); return this; }

  /** Ellipsoid. c = [x,y,z], r = number | [rx,ry,rz], k = blend radius. */
  ell(c, r, k = 0.12) {
    const R = typeof r === 'number' ? [r, r, r] : r;
    const mn = Math.min(R[0], R[1], R[2]);
    return this._push({
      k,
      lo: [c[0] - R[0], c[1] - R[1], c[2] - R[2]],
      hi: [c[0] + R[0], c[1] + R[1], c[2] + R[2]],
      d: (x, y, z) => {
        const ax = (x - c[0]) / R[0], ay = (y - c[1]) / R[1], az = (z - c[2]) / R[2];
        return (Math.sqrt(ax * ax + ay * ay + az * az) - 1) * mn;
      },
    });
  }

  /** Round cone from a (radius ra) to b (radius rb) — limbs, necks, fangs. */
  cone(a, b, ra, rb = ra, k = 0.12) {
    const rM = Math.max(ra, rb);
    return this._push({
      k,
      lo: [Math.min(a[0], b[0]) - rM, Math.min(a[1], b[1]) - rM, Math.min(a[2], b[2]) - rM],
      hi: [Math.max(a[0], b[0]) + rM, Math.max(a[1], b[1]) + rM, Math.max(a[2], b[2]) + rM],
      d: (x, y, z) => sdRoundCone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], ra, rb),
    });
  }

  /** A polyline of round cones — one call for a whole tapered limb or tail. */
  tube(pts, radii, k = 0.12) {
    for (let i = 0; i < pts.length - 1; i++) {
      this.cone(pts[i], pts[i + 1], radii[Math.min(radii.length - 1, i)],
        radii[Math.min(radii.length - 1, i + 1)], k);
    }
    return this;
  }

  /** Rounded box — brow ridges, plates, blocky sculpted planes. */
  box(c, h, round = 0.03, k = 0.12, rot = 0) {
    const H = typeof h === 'number' ? [h, h, h] : h;
    const ca = Math.cos(rot), sa = Math.sin(rot);
    const ext = Math.hypot(H[0], H[2]) + round;
    return this._push({
      k,
      lo: [c[0] - ext, c[1] - H[1] - round, c[2] - ext],
      hi: [c[0] + ext, c[1] + H[1] + round, c[2] + ext],
      d: (x, y, z) => {
        const dx0 = x - c[0], dz0 = z - c[2];
        const dx = ca * dx0 + sa * dz0, dz = -sa * dx0 + ca * dz0;
        const qx = Math.abs(dx) - H[0], qy = Math.abs(y - c[1]) - H[1], qz = Math.abs(dz) - H[2];
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
        return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - round;
      },
    });
  }

  bounds(pad = 0) {
    const lo = [_BIG, _BIG, _BIG], hi = [-_BIG, -_BIG, -_BIG];
    for (const p of this.add) {
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], p.lo[i] - p.k); hi[i] = Math.max(hi[i], p.hi[i] + p.k);
      }
    }
    for (let i = 0; i < 3; i++) { lo[i] -= pad; hi[i] += pad; }
    return { lo, hi };
  }

  /**
   * Polygonise. Naive surface nets: one vertex per sign-changing cell placed at
   * the centroid of its edge crossings, quads walked around every crossing
   * edge. Manifold, smooth, and (unlike marching cubes) no 256-entry table.
   */
  build(opts = {}) {
    const cell = opts.cell ?? 0.038;
    const { lo, hi } = this.bounds(cell * 2.5);
    const nx = Math.max(3, Math.ceil((hi[0] - lo[0]) / cell) + 1);
    const ny = Math.max(3, Math.ceil((hi[1] - lo[1]) / cell) + 1);
    const nz = Math.max(3, Math.ceil((hi[2] - lo[2]) / cell) + 1);
    const F = new Float32Array(nx * ny * nz).fill(_BIG);
    const SX = 1, SY = nx, SZ = nx * ny;

    const stamp = (p, sub) => {
      const i0 = Math.max(0, Math.floor((p.lo[0] - p.k - lo[0]) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((p.hi[0] + p.k - lo[0]) / cell));
      const j0 = Math.max(0, Math.floor((p.lo[1] - p.k - lo[1]) / cell));
      const j1 = Math.min(ny - 1, Math.ceil((p.hi[1] + p.k - lo[1]) / cell));
      const k0 = Math.max(0, Math.floor((p.lo[2] - p.k - lo[2]) / cell));
      const k1 = Math.min(nz - 1, Math.ceil((p.hi[2] + p.k - lo[2]) / cell));
      for (let k = k0; k <= k1; k++) {
        const z = lo[2] + k * cell;
        for (let j = j0; j <= j1; j++) {
          const y = lo[1] + j * cell;
          let idx = k * SZ + j * SY + i0;
          for (let i = i0; i <= i1; i++, idx++) {
            const d = p.d(lo[0] + i * cell, y, z);
            F[idx] = sub ? -smin(-F[idx], -d, p.k) : smin(F[idx], d, p.k);
          }
        }
      }
    };
    for (const p of this.add) stamp(p, false);
    for (const p of this.cut) stamp(p, true);

    // ---- surface nets ----------------------------------------------------
    const CE = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const ED = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const vid = new Int32Array(cx * cy * cz).fill(-1);
    const V = [];
    const g = new Float64Array(8);
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      let neg = 0;
      for (let c = 0; c < 8; c++) {
        const v = F[(k + CE[c][2]) * SZ + (j + CE[c][1]) * SY + (i + CE[c][0])];
        g[c] = v; if (v < 0) neg++;
      }
      if (neg === 0 || neg === 8) continue;
      let ax = 0, ay = 0, az = 0, n = 0;
      for (let e = 0; e < 12; e++) {
        const a = ED[e][0], b = ED[e][1], va = g[a], vb = g[b];
        if ((va < 0) === (vb < 0)) continue;
        const t = va / (va - vb);
        ax += CE[a][0] + t * (CE[b][0] - CE[a][0]);
        ay += CE[a][1] + t * (CE[b][1] - CE[a][1]);
        az += CE[a][2] + t * (CE[b][2] - CE[a][2]);
        n++;
      }
      vid[k * cx * cy + j * cx + i] = V.length / 3;
      V.push(lo[0] + (i + ax / n) * cell, lo[1] + (j + ay / n) * cell, lo[2] + (k + az / n) * cell);
    }
    const CI = (i, j, k) => vid[k * cx * cy + j * cx + i];
    const T = [];
    const quad = (a, b, c, d, flip) => {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) T.push(a, c, b, a, d, c); else T.push(a, b, c, a, c, d);
    };
    for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const v0 = F[k * SZ + j * SY + i], s0 = v0 < 0;
      if (i + 1 < nx) { const v1 = F[k * SZ + j * SY + i + 1]; if (s0 !== (v1 < 0))
        quad(CI(i, j - 1, k - 1), CI(i, j, k - 1), CI(i, j, k), CI(i, j - 1, k), !s0); }
      if (j + 1 < ny) { const v1 = F[k * SZ + (j + 1) * SY + i]; if (s0 !== (v1 < 0))
        quad(CI(i - 1, j, k - 1), CI(i - 1, j, k), CI(i, j, k), CI(i, j, k - 1), !s0); }
      if (k + 1 < nz) { const v1 = F[(k + 1) * SZ + j * SY + i]; if (s0 !== (v1 < 0))
        quad(CI(i - 1, j - 1, k), CI(i, j - 1, k), CI(i, j, k), CI(i - 1, j, k), !s0); }
    }

    // ---- prune loose shells ----------------------------------------------
    // A carve that cuts clean through a thin feature (an ear, a fang) leaves
    // the far side floating. Those chips are exactly the "untextured shards
    // poking out of the shoulder" review round 2 called out, so a connected-
    // component pass drops anything under `minPart` of the main mass. It also
    // makes the sculpt forgiving: a groove can be authored deep without
    // risking debris in the shipped frame.
    let TRIS = T;
    if (opts.prune !== false) {
      const nv = V.length / 3;
      const par = new Int32Array(nv);
      for (let i = 0; i < nv; i++) par[i] = i;
      const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
      const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) par[b] = a; };
      for (let i = 0; i < T.length; i += 3) { uni(T[i], T[i + 1]); uni(T[i + 1], T[i + 2]); }
      const size = new Map();
      for (let i = 0; i < T.length; i += 3) { const r = find(T[i]); size.set(r, (size.get(r) || 0) + 1); }
      let big = 0; for (const v of size.values()) if (v > big) big = v;
      const minPart = (opts.minPart ?? 0.06) * big;
      TRIS = [];
      for (let i = 0; i < T.length; i += 3) {
        if ((size.get(find(T[i])) || 0) >= minPart) TRIS.push(T[i], T[i + 1], T[i + 2]);
      }
    }

    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(V);
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setIndex(TRIS);
    geo.computeVertexNormals();

    // ---- baked crevice AO, straight out of the field ---------------------
    // Five cone-ish taps along the normal: wherever the field comes back much
    // closer than the tap distance, something else is occluding — a fold, an
    // armpit, the gap under a jaw. This is §4's "hand AO in the crevices" and
    // it is what makes a carved form read as carved under a flat key.
    if (opts.ao !== false) {
      const aoAmt = opts.ao ?? 0.55;
      const nrm = geo.attributes.normal;
      const C = new Float32Array(V.length);
      const at = (x, y, z) => {
        const fi = (x - lo[0]) / cell, fj = (y - lo[1]) / cell, fk = (z - lo[2]) / cell;
        const i = Math.max(0, Math.min(nx - 1, Math.round(fi)));
        const j = Math.max(0, Math.min(ny - 1, Math.round(fj)));
        const k = Math.max(0, Math.min(nz - 1, Math.round(fk)));
        return F[k * SZ + j * SY + i];
      };
      const STEPS = [cell * 1.6, cell * 3.4, cell * 6.0, cell * 10.0];
      for (let v = 0; v < V.length / 3; v++) {
        const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
        const nxv = nrm.getX(v), nyv = nrm.getY(v), nzv = nrm.getZ(v);
        let occ = 0, wsum = 0;
        for (let s = 0; s < STEPS.length; s++) {
          const h = STEPS[s], w = 1 / (1 + s);
          const d = at(px + nxv * h, py + nyv * h, pz + nzv * h);
          occ += w * Math.max(0, (h - d) / h);
          wsum += w;
        }
        const ao = 1 - aoAmt * Math.min(1, occ / wsum * 1.35);
        C[v * 3] = C[v * 3 + 1] = C[v * 3 + 2] = ao;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    }

    // planar UVs are enough: everything wearing this skin projects triplanar.
    const U = new Float32Array((V.length / 3) * 2);
    for (let v = 0; v < V.length / 3; v++) {
      U[v * 2] = (P[v * 3] - lo[0]) * 0.9;
      U[v * 2 + 1] = (P[v * 3 + 1] - lo[1]) * 0.9;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * Lathe a 2D profile. `profile` is [[radius, y], ...] bottom to top.
 * Radii are clamped off zero so the axis never degenerates into a NaN normal.
 */
export function lathe(profile, seg = 20, opts = {}) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-3, r), y));
  const g = new THREE.LatheGeometry(pts, seg, opts.phiStart || 0, opts.phiLength || TAU);
  g.computeVertexNormals();
  return g;
}

/**
 * A tube of varying radius swept along a polyline. This is the single most
 * useful primitive in the kit: volutes, claws, chains, tendrils, horns and
 * banner rods are all tapered tubes, and a tapered tube is the cheapest way to
 * put a real curve into a silhouette.
 */
export function taperedTube(points, radii, radial = 7, opts = {}) {
  const n = points.length;
  if (n < 2) return new THREE.BufferGeometry();
  const caps = opts.caps !== false;
  const tan = [], nrm = [], bin = [];
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(n - 1, i + 1)];
    tan.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  // parallel transport so the tube never spins around a bend
  let up = Math.abs(tan[0].y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  let nb = new THREE.Vector3().crossVectors(tan[0], up).normalize();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(tan[i - 1], tan[i]);
      const s = axis.length();
      if (s > 1e-6) {
        axis.divideScalar(s);
        const ang = Math.atan2(s, tan[i - 1].dot(tan[i]));
        nb = nb.clone().applyAxisAngle(axis, ang).normalize();
      }
    }
    nrm.push(nb.clone());
    bin.push(new THREE.Vector3().crossVectors(tan[i], nb).normalize());
  }
  const vcount = n * (radial + 1) + (caps ? 2 : 0);
  const P = new Float32Array(vcount * 3), U = new Float32Array(vcount * 2);
  const idx = [];
  let w = 0;
  for (let i = 0; i < n; i++) {
    const r = radii[Math.min(radii.length - 1, i)];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU;
      const ca = Math.cos(a), sa = Math.sin(a);
      P[w * 3] = points[i].x + (nrm[i].x * ca + bin[i].x * sa) * r;
      P[w * 3 + 1] = points[i].y + (nrm[i].y * ca + bin[i].y * sa) * r;
      P[w * 3 + 2] = points[i].z + (nrm[i].z * ca + bin[i].z * sa) * r;
      U[w * 2] = j / radial; U[w * 2 + 1] = i / (n - 1);
      w++;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  if (caps) {
    const c0 = w; P[w * 3] = points[0].x; P[w * 3 + 1] = points[0].y; P[w * 3 + 2] = points[0].z; w++;
    const c1 = w; P[w * 3] = points[n - 1].x; P[w * 3 + 1] = points[n - 1].y; P[w * 3 + 2] = points[n - 1].z; w++;
    for (let j = 0; j < radial; j++) {
      idx.push(c0, j + 1, j);
      const b = (n - 1) * (radial + 1);
      idx.push(c1, b + j, b + j + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Catenary sample points between a and b with `sag` metres of droop. */
export function catenary(a, b, sag, n = 14) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= Math.sin(Math.PI * t) * sag;
    out.push(p);
  }
  return out;
}

/**
 * A prism swept from a closed 2D outline along +Z. Used for the meander ribbon
 * and for any carved band that has to be REAL geometry rather than a texture.
 */
export function prism(outline, depth, opts = {}) {
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: opts.bevel !== false,
    bevelThickness: opts.bevelThickness ?? depth * 0.18,
    bevelSize: opts.bevelSize ?? depth * 0.16,
    bevelSegments: 1, curveSegments: opts.curveSegments ?? 2, steps: 1,
  });
  g.translate(0, 0, -depth * 0.5);
  return g;
}

/**
 * A fluted shaft with entasis. A raw cylinder is a painted tube (§7); real
 * flutes give a column an ink-dark crevice AND a lit arris, which is the whole
 * reason two columns standing side by side read as two objects.
 */
export function flutedShaft(rBase, rTop, H, flutes = 20, depth = 0.055, rings = 8) {
  // 3 segments per flute cannot resolve a cosine: the modulation aliased into a
  // faint hum and the shaft shipped as a smooth tube wearing an ashlar texture,
  // which is why critics read the colonnade as Roman coursed piers rather than
  // Greek columns. 5 samples per flute is the minimum that keeps the arris
  // sharp, and the caller now asks for real depth as well.
  const g = new THREE.CylinderGeometry(1, 1, H, flutes * 5, rings, false);
  const pos = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rad = Math.hypot(v.x, v.z);
    const t = Math.min(1, Math.max(0, v.y / H + 0.5));
    const swell = 1 + 0.038 * Math.sin(Math.PI * Math.min(1, t * 1.12));
    const r = (rBase + (rTop - rBase) * Math.pow(t, 0.92)) * swell;
    if (rad > 1e-5) {
      const a = Math.atan2(v.z, v.x);
      const band = Math.min(1, Math.min(t, 1 - t) * 11.0);
      const flute = (0.5 - 0.5 * Math.cos(a * flutes)) * depth * band;
      const k = (r - flute) / rad;
      v.x *= k; v.z *= k;
    } else { v.x *= r; v.z *= r; }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// ===========================================================================
// 1c. RELIEF SHADING — the difference between CARVED ornament and PRINTED
//     ornament, and the single biggest gap review found between this build and
//     Hades.
//
// A meander extruded off a wall has the SAME NORMAL as the wall it sits on:
// its front face and the masonry behind it receive identical irradiance, so the
// only thing separating them is albedo. That is a decal. It reads at gameplay
// distance as flat light-on-dark line-art — literally as the glyph "01010"
// where a bead-and-reel astragal should be.
//
// Carved ornament reads because of four things, and none of them is albedo:
//   1. a CHAMFERED ARRIS, so the top of every member turns up into the key and
//      the bottom turns away from it — a lit edge and a dark undercut,
//   2. CONTACT OCCLUSION where the member meets its host,
//   3. a value gradient ACROSS a round member (a bead is dark underneath),
//   4. a low ALBEDO contrast against the host, so LIGHT makes the contrast.
//
// (1) is geometry — see `chamferedPrism` and the rebuilt `meanderPeriod`.
// (2) and (3) are baked here into vertex colour: hand-painted occlusion, the
// architectural equivalent of §4's "subtle AO by hand", and it survives
// instancing (it is a per-vertex attribute, not a per-instance one) so a band
// of 300 instanced frets still costs one draw call.
//
// The shading is authored in the unit's OWN frame, relative to the direction it
// stands proud of its host (+Z by convention for every moulding in this kit),
// so the same bake is correct on a wall band, a floor band, an arch soffit or a
// vertical jamb run.
// ===========================================================================

/**
 * reliefShade(geo, opts) -> geo   (adds/multiplies a 'color' attribute)
 *
 *   seat     value at the host surface (contact occlusion at the root)
 *   seatEnd  fraction of the proud depth over which the occlusion lifts
 *   side     value on faces that face along the run rather than out of the host
 *   up       extra light on up-facing facets (the catch-light on a top arris)
 *   down     extra crush on down-facing facets (the undercut)
 *   axis     'z' (default) | 'y' | 'x' — which local axis is "proud of the host"
 *
 * Materials wearing this must be requested with { vertexColors: true }.
 */
export function reliefShade(geo, opts = {}) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  if (!pos || !nrm) return geo;
  const seat = opts.seat ?? 0.40;
  const seatEnd = opts.seatEnd ?? 0.55;
  const side = opts.side ?? 0.74;
  const up = opts.up ?? 0.20;
  const down = opts.down ?? 0.34;
  const gain = opts.gain ?? 1.0;
  const ax = opts.axis === 'y' ? 1 : opts.axis === 'x' ? 0 : 2;
  const comp = (a, i) => a.array[i * a.itemSize + ax];

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) { const v = comp(pos, i); if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1e-5, (hi - lo) * seatEnd);

  const prev = geo.attributes.color;
  const C = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // (2) contact occlusion: dark where the member is swallowed by its host
    let t = (comp(pos, i) - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    t = t * t * (3 - 2 * t);
    let k = seat + (1 - seat) * t;
    // (3) form: how much this facet looks OUT of the host rather than along it.
    // Front faces keep their value, returns and undercuts fall away — which is
    // what gives a bead a lit crown and a dark belly.
    const nx = nrm.array[i * 3], ny = nrm.array[i * 3 + 1], nz = nrm.array[i * 3 + 2];
    const out = ax === 0 ? nx : ax === 1 ? ny : nz;
    k *= side + (1 - side) * Math.max(0, out);
    // the catch-light / undercut pair — the reason a chamfer reads at 8 pixels
    k *= 1 + up * Math.max(0, ny) - down * Math.max(0, -ny);
    k = 1 + (k - 1) * gain;
    const c = k < 0.02 ? 0.02 : k > 1.6 ? 1.6 : k;
    const p0 = prev ? prev.array[i * prev.itemSize] : 1;
    C[i * 3] = C[i * 3 + 1] = C[i * 3 + 2] = c * p0;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
  return geo;
}

/**
 * Safety net for the relief bake: any geometry handed to a material that reads
 * vertex colours MUST carry the attribute, or WebGL feeds the shader the
 * default constant attribute (black) and the mesh vanishes. Plain members that
 * share an ornament material get a neutral white so they are unaffected.
 */
export function ensureColor(geo) {
  if (geo && geo.attributes && geo.attributes.position && !geo.attributes.color) {
    const C = new Float32Array(geo.attributes.position.count * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
  }
  return geo;
}

/**
 * A closed 2D outline extruded along +Z with a REAL 45-degree chamfer round
 * both arrises, centred on z=0. This is the workhorse behind every carved band
 * in the kit: the chamfer is what turns a flat inlay into a moulding, because
 * its top facet catches the key and its bottom facet is a shadow line.
 */
export function chamferedPrism(outline, depth, chamfer) {
  const ch = Math.max(1e-4, Math.min(chamfer, depth * 0.42));
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - 2 * ch), bevelEnabled: true,
    bevelThickness: ch, bevelSize: ch, bevelOffset: 0, bevelSegments: 1, steps: 1,
  });
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(0, 0, -(bb.min.z + bb.max.z) * 0.5);
  return g;
}

/** Deterministic float source adapter: accepts an RNG object or a function. */
function F(rng) {
  if (!rng) return () => 0.5;
  if (typeof rng === 'function') return rng;
  if (typeof rng.f === 'function') return () => rng.f();
  return () => 0.5;
}

// ===========================================================================
// 2. THE MOULDING VOCABULARY
// ===========================================================================

/**
 * EGG-AND-DART. One unit is an ovolo egg sitting in a shell with a dart
 * (an arrowhead on a stalk) in the gap. At gameplay distance the reading is
 * "a row of alternating round and pointed shapes catching the key" — which is
 * exactly what an egg-and-dart is for.
 */
export function eggAndDartUnit(h = 1) {
  const p = new Parts();
  // the egg: an ovoid, flattened at the back so it sits in the shell
  const egg = new THREE.SphereGeometry(0.30 * h, 9, 6);
  egg.scale(1.0, 1.30, 0.62);
  p.add(egg, { p: [0, 0.05 * h, 0.10 * h] });
  // the shell: a lathed crescent hugging the egg, open at the front
  p.add(lathe([[0.34, -0.42], [0.44, -0.20], [0.46, 0.10], [0.36, 0.42], [0.30, 0.50]]
    .map(([r, y]) => [r * h, y * h]), 10, { phiStart: -Math.PI * 0.62, phiLength: Math.PI * 1.24 }),
    { p: [0, 0, 0], r: [Math.PI / 2, 0, 0] });
  // the dart: a stalk with a small arrowhead, sitting between two eggs
  const stalk = new THREE.CylinderGeometry(0.028 * h, 0.055 * h, 0.52 * h, 4);
  p.add(stalk, { p: [0.50 * h, -0.02 * h, 0.20 * h] });
  const head = new THREE.ConeGeometry(0.11 * h, 0.28 * h, 4);
  p.add(head, { p: [0.50 * h, -0.34 * h, 0.20 * h], r: [Math.PI, 0, 0] });
  return reliefShade(faceted(p.merge()), { seat: 0.36, seatEnd: 0.60, side: 0.70, up: 0.24, down: 0.42 });
}

/**
 * BEAD-AND-REEL. Alternating bead and reel, standing on a continuous fillet.
 *
 * The old unit was an 8x5 flat-shaded sphere and three flat-shaded discs, which
 * at gameplay distance is six facets across six pixels: the beads read as hard
 * light-on-dark rings, i.e. as the characters "0 I 0 I 0" printed on the stone.
 * The bead is now SMOOTH (a round member reads by its gradient, not by its
 * facets), oblate so its crown faces up into the key, seated on a fillet that
 * gives the whole course a lit lower edge, and carries hand-baked occlusion so
 * its belly and its root against the wall are dark whatever the light does.
 */
export function beadAndReelUnit(h = 1) {
  const p = new Parts();
  // the bead — smooth, and squashed back into the wall so it is a hemisphere-
  // and-a-bit proud rather than a ball stuck on a flat
  const bead = new THREE.SphereGeometry(0.30 * h, 14, 10);
  bead.scale(1.0, 1.06, 0.80);
  p.add(bead, { p: [0, 0.02 * h, 0.06 * h] });
  // the reel — a spool between two discs, faceted so it contrasts with the bead
  const spool = faceted(new THREE.CylinderGeometry(0.125 * h, 0.125 * h, 0.34 * h, 10));
  p.add(spool, { p: [0.50 * h, 0, 0.02 * h], r: [0, 0, Math.PI / 2] });
  for (const s of [-1, 1]) {
    const disc = faceted(new THREE.CylinderGeometry(0.215 * h, 0.235 * h, 0.075 * h, 12));
    p.add(disc, { p: [0.50 * h + s * 0.17 * h, 0, 0.02 * h], r: [0, 0, Math.PI / 2] });
  }
  // the fillet the course stands on: a chamfered bar, so the astragal has a
  // continuous lit top arris and a continuous shadow under it (§9.5)
  p.add(chamferedPrism([[-0.5 * h, -0.20 * h], [0.5 * h, -0.20 * h],
    [0.5 * h, -0.02 * h], [-0.5 * h, -0.02 * h]], 0.30 * h, 0.055 * h),
    { p: [0.25 * h, 0, -0.06 * h] });
  return reliefShade(p.merge(), { seat: 0.34, seatEnd: 0.62, side: 0.70, up: 0.24, down: 0.42 });
}

/**
 * THE GREEK KEY (meander), as REAL CARVED GEOMETRY.
 *
 * The previous unit was five extruded boxes. That is real geometry and it still
 * read as printed line-art, because a box extruded off a wall presents the
 * camera one face whose normal is IDENTICAL to the wall's: the fret and the
 * masonry behind it get the same irradiance and only their albedo differs.
 * Light was doing no work at all.
 *
 * The period is now ONE closed spiral outline extruded with a genuine 45-degree
 * chamfer round its whole contour. That chamfer is the entire point: the upper
 * arris of every bar turns up into the key and fires, the lower arris turns
 * away and goes to ink, and the fret finally reads as a channel cut in stone
 * with a lit edge and a dark undercut instead of as a gold sticker.
 *
 * Grid: 8 x 8, ribbon 1 unit wide, traced counter-clockwise from the foot of
 * the riser round the outside of the spiral and back down its inside.
 */
export function meanderPeriod(h = 1, depth = 0.35) {
  const u = h / 8, o = -h * 0.5;
  const G = [
    [2, 1], [2, 6], [6, 6], [6, 4], [4, 4], [4, 5.6],
    [3, 5.6], [3, 3], [7, 3], [7, 7], [1, 7], [1, 1],
  ].map(([x, y]) => [x * u + o, y * u + o]);
  const d = Math.max(0.02 * h, depth * h);
  const g = chamferedPrism(G, d, Math.min(u * 0.34, d * 0.40));
  return reliefShade(faceted(g), { seat: 0.50, seatEnd: 0.50, side: 0.80, up: 0.24, down: 0.38 });
}

/**
 * The continuous rail the meander spirals rise from (one straight run). It is
 * the RECESSED BED as much as a member: shaded darker than the fret so the
 * carving sits in a channel rather than floating on the wall.
 */
export function meanderRail(h = 1, len = 1, depth = 0.35) {
  const d = Math.max(0.02 * h, depth * h);
  const g = chamferedPrism([[-len * 0.5, -h / 16], [len * 0.5, -h / 16],
    [len * 0.5, h / 16], [-len * 0.5, h / 16]], d, Math.min(h / 40, d * 0.36));
  return reliefShade(faceted(g), { seat: 0.34, seatEnd: 0.70, side: 0.62, up: 0.26, down: 0.44, gain: 1.15 });
}

/** A run of dentils (the square teeth under a cornice). */
export function dentilUnit(h = 1) {
  // A raw box is a tooth with no arris. The chamfer gives each dentil a lit top
  // edge and a hard shadow line down its return, which is what makes a dentil
  // course read as a row of blocks instead of as a dashed line.
  const g = chamferedPrism([[-0.26 * h, -0.5 * h], [0.26 * h, -0.5 * h],
    [0.26 * h, 0.5 * h], [-0.26 * h, 0.5 * h]], 0.66 * h, 0.055 * h);
  return reliefShade(faceted(g), { seat: 0.42, seatEnd: 0.55, side: 0.70, up: 0.24, down: 0.40 });
}

/**
 * ACANTHUS LEAF. Three lobes a side, a channelled midrib and a curled tip,
 * built as a double-sided shell so it has real thickness in silhouette. This is
 * the single element that makes a capital read as Corinthian rather than as a
 * bucket, so it is worth its ~600 triangles.
 */
export function acanthusLeaf(opts = {}) {
  const L = opts.len ?? 1.0, W = opts.width ?? 0.42, T = opts.thick ?? 0.035;
  const curl = opts.curl ?? 0.42, lobes = opts.lobes ?? 3;
  const NS = 16, NT = 9;
  const front = [], back = [];
  const P = [], U = [], idx = [];
  const nv = NS * NT;
  for (let i = 0; i < NS; i++) {
    const s = i / (NS - 1);
    // the blade sweeps out from the bell then curls forward at the tip
    const bend = -curl * L * Math.pow(Math.max(0, s - 0.42) / 0.58, 2.1);
    const rise = L * s;
    let hw = W * Math.sin(Math.PI * Math.pow(s, 0.72)) * (1 - 0.22 * s);
    hw *= 1 + 0.30 * Math.cos(lobes * Math.PI * s * 2) * Math.min(1, s * 3);
    hw = Math.max(0.012, hw);
    for (let j = 0; j < NT; j++) {
      const t = (j / (NT - 1)) * 2 - 1;
      const x = t * hw;
      // channel: the leaf is a gutter, not a plate — this is what catches light
      const chan = (1 - t * t) * 0.16 * hw * 4.0 * (0.25 + 0.75 * s);
      const rib = Math.exp(-(t * 3.4) * (t * 3.4)) * 0.10 * L * (1 - s * 0.6);
      const y = rise - chan * 0.35;
      const z = bend - chan + rib;
      P.push(x, y, z);
      U.push((t * 0.5 + 0.5), s);
    }
  }
  for (let i = 0; i < NS - 1; i++) for (let j = 0; j < NT - 1; j++) {
    const a = i * NT + j;
    idx.push(a, a + NT, a + 1, a + 1, a + NT, a + NT + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // give it thickness: a mirrored shell offset backwards
  const b = g.clone();
  const bp = b.attributes.position, bn = g.attributes.normal;
  for (let i = 0; i < bp.count; i++) {
    bp.setXYZ(i, bp.getX(i) - bn.getX(i) * T, bp.getY(i) - bn.getY(i) * T, bp.getZ(i) - bn.getZ(i) * T);
  }
  const bi = b.index.array.slice();
  for (let i = 0; i < bi.length; i += 3) { const t = bi[i]; bi[i] = bi[i + 2]; bi[i + 2] = t; }
  b.setIndex(Array.from(bi));
  b.computeVertexNormals();
  return mergeGeos([g, b]);
}

/** A volute — the spiral scroll on an Ionic/Corinthian capital. */
export function volute(r0 = 0.24, turns = 1.85, tube = 0.055) {
  const pts = [], rad = [];
  const n = 26;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = t * TAU * turns;
    const r = r0 * Math.exp(-0.55 * t * turns);
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, t * tube * 0.9));
    rad.push(tube * (1 - 0.55 * t));
  }
  return taperedTube(pts, rad, 6);
}

// ===========================================================================
// 3. THE BATCHER — N placements of a template become 1 draw call per part
// ===========================================================================

export class Batcher {
  constructor(root, keep) {
    this.root = root;
    this.keep = keep || (() => {});
    this.buckets = new Map();     // key -> {geo, mat, mats:[], list:[Matrix4]}
    this._k = 0;
  }
  _key(geo, mat) {
    if (!geo.userData.__kid) geo.userData.__kid = 'g' + (this._k++);
    if (!mat.userData.__kid) mat.userData.__kid = 'm' + (this._k++);
    return geo.userData.__kid + '|' + mat.userData.__kid;
  }
  add(geo, mat, matrix, opts = {}) {
    if (!geo || !mat) return this;
    const k = this._key(geo, mat);
    let b = this.buckets.get(k);
    if (!b) { b = { geo, mat, list: [], cast: true, recv: true, name: opts.name || 'kit' }; this.buckets.set(k, b); }
    if (opts.cast === false) b.cast = false;
    if (opts.recv === false) b.recv = false;
    b.list.push(matrix.clone());
    return this;
  }
  /**
   * Record every mesh inside a template Object3D, transformed by `matrix`.
   * The template is never added to the scene — it is a mould.
   */
  addTemplate(template, matrix, opts = {}) {
    template.updateMatrixWorld(true);
    const m = new THREE.Matrix4();
    template.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.material) return;
      m.multiplyMatrices(matrix, o.matrixWorld);
      this.add(o.geometry, o.material, m, {
        name: o.name || opts.name,
        cast: o.castShadow !== false && opts.cast !== false,
        recv: o.receiveShadow !== false && opts.recv !== false,
      });
    });
    return this;
  }
  /** Materialise every bucket. Returns the created meshes. */
  build() {
    const out = [];
    for (const b of this.buckets.values()) {
      let mesh;
      if (b.list.length === 1) {
        mesh = new THREE.Mesh(b.geo, b.mat);
        b.list[0].decompose(mesh.position, mesh.quaternion, mesh.scale);
      } else {
        mesh = new THREE.InstancedMesh(b.geo, b.mat, b.list.length);
        for (let i = 0; i < b.list.length; i++) mesh.setMatrixAt(i, b.list[i]);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = true;
      }
      mesh.name = b.name;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      this.root.add(mesh);
      out.push(mesh);
    }
    this.buckets.clear();
    return out;
  }
  get drawCalls() { return this.buckets.size; }
}

// ===========================================================================
// 4. THE KIT
// ===========================================================================

export class Kit {
  /**
   * @param ctx   the shared context (needs ctx.mats)
   * @param roles role -> material-name map from biomes.js
   * @param rng   deterministic stream (ctx.rng.fork('world'))
   */
  constructor(ctx, roles, rng) {
    this.ctx = ctx;
    this.roles = roles || {};
    this.rng = rng;
    this.f = F(rng);
    this._geo = new Map();       // cache key -> geometry (owned, disposed by us)
    this._mat = new Map();
    // Per-role material defaults, set once by the chamber. This is where the
    // §9.5 "light the edges, not the faces" trim lives: a column shaft is the
    // largest single face in the mid-ground and at full rig gain it blows to
    // near-white, so its diffuse share comes down and its specular share (which
    // lives on the arrises between the flutes) goes up.
    this.roleOpts = {};
  }

  // ---- resources ---------------------------------------------------------
  /** Material for a role name ('wall','trim','metal',...) with optional opts. */
  mat(role, opts) {
    const name = this.roles[role] || role;
    const base = this.roleOpts[role];
    const merged = base ? { ...base, ...(opts || {}) } : opts;
    const key = role + '|' + (merged ? JSON.stringify(merged) : '');
    if (this._mat.has(key)) return this._mat.get(key);
    const m = this.ctx.mats && this.ctx.mats.get
      ? this.ctx.mats.get(name, merged)
      : new THREE.MeshStandardMaterial({ color: 0x5a2331 });
    this._mat.set(key, m);
    return m;
  }
  /** Cached geometry — every repeated piece is built exactly once. */
  geo(key, factory) {
    let g = this._geo.get(key);
    if (!g) { g = factory(); this._geo.set(key, g); }
    return g;
  }
  /** Register a one-off geometry so the chamber teardown disposes it. */
  own(g) { this._geo.set('own:' + this._geo.size, g); return g; }

  dispose() {
    for (const g of this._geo.values()) g.dispose?.();
    this._geo.clear();
    this._mat.clear();      // materials belong to the library, never disposed here
  }

  batcher(root) { return new Batcher(root); }

  // ---- helpers -----------------------------------------------------------
  _mesh(geo, mat, name, cast = true, recv = true) {
    if (mat && mat.vertexColors) ensureColor(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name; m.castShadow = cast; m.receiveShadow = recv;
    return m;
  }

  // =========================================================================
  // COLUMN
  // =========================================================================
  /**
   * kit.column({ h, r, order:'doric'|'corinthian'|'ionic', ornate:bool })
   * Returns a Group: moulded base, fluted entasis shaft, carved capital.
   */
  column(opts = {}) {
    const H = opts.h ?? 6.2;
    const R = opts.r ?? 0.52;
    const order = opts.order || 'doric';
    const key = `col:${order}:${H.toFixed(2)}:${R.toFixed(2)}:${opts.ornate ? 1 : 0}`;
    const g = new THREE.Group();
    g.name = 'column';

    const stone = this.mat('column', { variation: 0.24 });
    const trim = this.mat('leaf');

    // ---- base: plinth, torus, scotia, torus, apophyge -------------------
    const baseH = R * 1.35;
    const baseGeo = this.geo(key + ':base', () => {
      const p = new Parts();
      p.add(faceted(new THREE.BoxGeometry(R * 2.55, baseH * 0.34, R * 2.55)), { p: [0, baseH * 0.17, 0] });
      p.add(lathe([
        [R * 1.30, 0.00], [R * 1.34, 0.06], [R * 1.30, 0.13],       // lower torus
        [R * 1.08, 0.17], [R * 0.99, 0.26], [R * 1.06, 0.36],       // scotia (concave)
        [R * 1.24, 0.42], [R * 1.27, 0.50], [R * 1.20, 0.57],       // upper torus
        [R * 1.05, 0.62], [R * 1.00, 0.72],                          // apophyge
      ].map(([r, y]) => [r, baseH * 0.34 + y * baseH * 1.05]), 22));
      return p.merge();
    });
    const baseTop = baseH * 0.34 + 0.72 * baseH * 1.05;
    g.add(this._mesh(baseGeo, stone, 'column.base'));

    // ---- shaft ----------------------------------------------------------
    const capH = order === 'corinthian' ? R * 2.35 : R * 1.15;
    const shaftH = H - baseTop - capH;
    // FLUTE DEPTH IS A READABILITY DECISION. At R*0.105 (~4.9cm on a 0.47m
    // shaft) a flute is sub-pixel at the 17.5m shipping camera and the column
    // reads as a plain drum. 20 shallow flutes also give a period finer than
    // the texture's own ashlar course, so the texture wins. Fewer, deeper
    // flutes: each arris is ~19cm apart and each groove is ~11cm deep, which
    // carries a real lit edge and a real ink line at play distance (§9.5).
    const shaftGeo = this.geo(key + ':shaft', () =>
      flutedShaft(R, R * 0.845, shaftH, order === 'doric' ? 14 : 18, R * 0.285, 10));
    const shaft = this._mesh(shaftGeo, stone, 'column.shaft');
    shaft.position.y = baseTop + shaftH * 0.5;
    g.add(shaft);

    // ---- necking: an astragal bead ring, then the capital ---------------
    const neckY = baseTop + shaftH;
    const astragal = this.geo(key + ':astragal', () =>
      lathe([[R * 0.845, -0.03], [R * 0.94, 0.0], [R * 0.90, 0.05], [R * 0.86, 0.075]], 22));
    const ast = this._mesh(astragal, opts.ornate ? trim : stone, 'column.astragal');
    ast.position.y = neckY;
    g.add(ast);

    if (order === 'corinthian') {
      // BELL + two tiers of acanthus + corner volutes + concave abacus.
      const bellGeo = this.geo(key + ':bell', () => lathe([
        [R * 0.84, 0.00], [R * 0.90, capH * 0.18], [R * 1.00, capH * 0.46],
        [R * 1.12, capH * 0.72], [R * 1.20, capH * 0.90], [R * 1.16, capH * 0.96],
      ], 20));
      const bell = this._mesh(bellGeo, stone, 'column.bell');
      bell.position.y = neckY;
      g.add(bell);

      const leafA = this.geo(key + ':leafA', () => acanthusLeaf({ len: capH * 0.52, width: R * 0.60, curl: 0.50, thick: R * 0.05 }));
      const leafB = this.geo(key + ':leafB', () => acanthusLeaf({ len: capH * 0.60, width: R * 0.66, curl: 0.42, thick: R * 0.05 }));
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const m = this._mesh(leafA, stone, 'column.acanthus');
        m.position.set(Math.cos(a) * R * 0.80, neckY + capH * 0.03, Math.sin(a) * R * 0.80);
        m.rotation.set(-0.30, -a + Math.PI / 2, 0);
        g.add(m);
      }
      for (let i = 0; i < 8; i++) {
        const a = ((i + 0.5) / 8) * TAU;
        const m = this._mesh(leafB, stone, 'column.acanthus');
        m.position.set(Math.cos(a) * R * 0.94, neckY + capH * 0.34, Math.sin(a) * R * 0.94);
        m.rotation.set(-0.40, -a + Math.PI / 2, 0);
        g.add(m);
      }
      const vol = this.geo(key + ':volute', () => volute(R * 0.40, 1.8, R * 0.085));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        const m = this._mesh(vol, opts.ornate ? trim : stone, 'column.volute');
        m.position.set(Math.cos(a) * R * 1.16, neckY + capH * 0.78, Math.sin(a) * R * 1.16);
        m.rotation.set(0.25, -a + Math.PI / 2, -0.5);
        g.add(m);
      }
      // abacus with concave sides + a central fleuron
      const abGeo = this.geo(key + ':abacus.c', () => {
        const p = new Parts();
        const w = R * 3.05, t = capH * 0.17;
        p.box(w, t, w, [0, 0, 0]);
        p.box(w * 1.06, t * 0.42, w * 1.06, [0, t * 0.42, 0]);
        for (const s of [-1, 1]) {
          // scoop the long faces so the abacus is not a slab
          const sc = new THREE.CylinderGeometry(w * 0.46, w * 0.46, t * 1.4, 14, 1, true);
          p.add(sc, { p: [s * w * 0.82, 0, 0] });
          p.add(sc.clone(), { p: [0, 0, s * w * 0.82] });
        }
        return faceted(p.merge());
      });
      const ab = this._mesh(abGeo, opts.ornate ? trim : stone, 'column.abacus');
      ab.position.y = neckY + capH * 0.93;
      g.add(ab);
      if (opts.ornate) {
        const fl = this.geo(key + ':fleuron', () => {
          const p = new Parts();
          p.add(lathe([[0.0, 0], [R * 0.16, R * 0.05], [R * 0.22, R * 0.14], [R * 0.10, R * 0.22], [R * 0.05, R * 0.30]], 10));
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU;
            const pet = new THREE.SphereGeometry(R * 0.12, 7, 5);
            pet.scale(1, 0.4, 1.7);
            p.add(pet, { p: [Math.cos(a) * R * 0.20, R * 0.10, Math.sin(a) * R * 0.20], r: [0, -a, 0.3] });
          }
          return p.merge();
        });
        for (const s of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const m = this._mesh(fl, trim, 'column.fleuron');
          m.position.set(s[0] * R * 1.45, neckY + capH * 0.99, s[1] * R * 1.45);
          g.add(m);
        }
      }
    } else {
      // DORIC: annulets, echinus (a real ovolo curve), abacus with a fillet.
      const capGeo = this.geo(key + ':cap.d', () => {
        const p = new Parts();
        for (let i = 0; i < 3; i++) {
          p.add(lathe([[R * 0.86, 0], [R * 0.94, 0.012], [R * 0.94, 0.036], [R * 0.86, 0.05]]
            .map(([r, y]) => [r, y + i * 0.055]), 22));
        }
        // echinus: a quarter-round that flares
        p.add(lathe([
          [R * 0.88, 0.17], [R * 1.02, 0.24], [R * 1.16, 0.33],
          [R * 1.27, 0.45], [R * 1.32, 0.58], [R * 1.33, 0.65],
        ].map(([r, y]) => [r, y * (capH / 0.65)]), 22));
        // abacus
        p.box(R * 2.78, capH * 0.26, R * 2.78, [0, capH * 0.80, 0]);
        p.box(R * 2.95, capH * 0.10, R * 2.95, [0, capH * 0.98, 0]);
        return p.merge();
      });
      // GOLD, not bronze. `metal` resolves to bronze.verdigris, and a green
      // capital is off-palette for Tartarus (§2). §2 also calls gold "the
      // ornament spine of the whole game" and §9.5 puts the highlight band on
      // ornament: the capital is the single most-seen piece of ornament in the
      // chamber and it is where the gold has to live.
      const cap = this._mesh(capGeo, opts.ornate ? trim : stone, 'column.capital');
      cap.position.y = neckY;
      g.add(cap);
      if (opts.ornate) {
        const ab = this._mesh(
          this.geo(key + ':abacus.d', () => faceted(new THREE.BoxGeometry(R * 3.05, capH * 0.13, R * 3.05))),
          trim, 'column.abacus');
        ab.position.y = neckY + capH * 1.04;
        g.add(ab);
      }
    }
    g.userData.height = H;
    g.userData.radius = R;
    return g;
  }

  // =========================================================================
  // ARCH
  // =========================================================================
  /**
   * kit.arch({ span, rise, depth, thickness, voussoirs, ornate })
   * A REAL voussoir arch: individual radial wedges with visible joints, an
   * archivolt moulding on the face, imposts, and a carved keystone.
   */
  arch(opts = {}) {
    const span = opts.span ?? 6.0;
    const R = span * 0.5;
    const th = opts.thickness ?? R * 0.30;
    const d = opts.depth ?? 1.5;
    const N = opts.voussoirs ?? 15;
    const springY = opts.springY ?? 0;
    const g = new THREE.Group();
    g.name = 'arch';
    const stone = this.mat('arch');
    const trim = this.mat('leaf');
    const key = `arch:${span.toFixed(2)}:${th.toFixed(2)}:${d.toFixed(2)}:${N}`;

    // one voussoir wedge: a trapezoidal prism, wider at the extrados
    const vgeo = this.geo(key + ':vouss', () => {
      const half = (Math.PI / N) * 0.5 * 0.92;
      const ri = R - th * 0.5, ro = R + th * 0.5;
      const p = [];
      const push = (x, y, z) => p.push(x, y, z);
      const a0 = -half, a1 = half;
      const c = [
        [Math.cos(a0) * ri, Math.sin(a0) * ri], [Math.cos(a1) * ri, Math.sin(a1) * ri],
        [Math.cos(a1) * ro, Math.sin(a1) * ro], [Math.cos(a0) * ro, Math.sin(a0) * ro],
      ];
      const shape = new THREE.Shape(c.map(([x, y]) => new THREE.Vector2(x, y)));
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: d, bevelEnabled: true, bevelThickness: th * 0.05, bevelSize: th * 0.045, bevelSegments: 1, steps: 1,
      });
      // the wedge is authored ON the +X axis at radius R about the arch centre,
      // so placing it is a single rotation about Z
      geo.translate(0, 0, -d * 0.5);
      return faceted(geo);
    });
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N;
      const a = Math.PI * t;
      const isKey = Math.abs(t - 0.5) < 0.5 / N;
      const m = this._mesh(vgeo, isKey && opts.ornate ? trim : stone, 'arch.voussoir');
      m.position.set(0, springY, 0);
      m.rotation.set(0, 0, a);
      g.add(m);
    }
    // ARCHIVOLT: a moulded band on the face — the lit edge of the whole arch
    const av = this.geo(key + ':archivolt', () => {
      const p = new Parts();
      p.add(new THREE.TorusGeometry(R + th * 0.44, th * 0.12, 7, 40, Math.PI));
      p.add(new THREE.TorusGeometry(R - th * 0.44, th * 0.09, 7, 40, Math.PI));
      return p.merge();
    });
    for (const s of [1, -1]) {
      const m = this._mesh(av, trim, 'arch.archivolt');
      m.position.set(0, springY, s * (d * 0.5 + th * 0.10));
      g.add(m);
    }
    // egg-and-dart running the intrados
    if (opts.ornate !== false) {
      // SIZE IS A READABILITY DECISION, not an archaeological one: a true
      // 15cm egg on a cornice 25m from the camera is sub-pixel, and sub-pixel
      // emissive detail is the aliasing §7 bans. These are deliberately chunky.
      const eu = th * 0.44;
      const unit = this.geo('ed:' + eu.toFixed(3), () => eggAndDartUnit(eu));
      const n = Math.max(8, Math.round((Math.PI * R) / (eu * 0.66)));
      for (let i = 0; i < n; i++) {
        const a = Math.PI * ((i + 0.5) / n);
        const m = this._mesh(unit, trim, 'arch.eggdart', true, false);
        m.position.set(Math.cos(a) * (R - th * 0.56), springY + Math.sin(a) * (R - th * 0.56), d * 0.5 + th * 0.06);
        m.rotation.set(0, 0, a + Math.PI / 2);
        g.add(m);
      }
    }
    // KEYSTONE: a proud wedge with a carved boss — the apex of the eye path
    const ks = this.geo(key + ':keystone', () => {
      const p = new Parts();
      p.box(th * 0.86, th * 1.55, d * 1.14, [0, 0, 0]);
      p.box(th * 1.05, th * 0.30, d * 1.20, [0, th * 0.72, 0]);
      const boss = new THREE.SphereGeometry(th * 0.28, 10, 8);
      boss.scale(1, 1.25, 0.7);
      p.add(boss, { p: [0, th * 0.05, d * 0.60] });
      // two small volute ears
      const v = volute(th * 0.20, 1.4, th * 0.05);
      p.add(v, { p: [-th * 0.40, th * 0.30, d * 0.56], r: [0, 0, 0] });
      const v2 = volute(th * 0.20, 1.4, th * 0.05);
      v2.scale(-1, 1, 1);
      p.add(v2, { p: [th * 0.40, th * 0.30, d * 0.56] });
      return p.merge();
    });
    const k = this._mesh(ks, trim, 'arch.keystone');
    k.position.set(0, springY + R + th * 0.12, 0);
    g.add(k);

    // IMPOSTS: the moulded blocks the arch springs from
    const imp = this.geo(key + ':impost', () => {
      const p = new Parts();
      p.box(th * 1.9, th * 0.30, d * 1.35, [0, 0, 0]);
      p.box(th * 2.1, th * 0.13, d * 1.5, [0, th * 0.21, 0]);
      p.box(th * 1.7, th * 0.16, d * 1.2, [0, -th * 0.22, 0]);
      return faceted(p.merge());
    });
    for (const s of [-1, 1]) {
      const m = this._mesh(imp, stone, 'arch.impost');
      m.position.set(s * R, springY - th * 0.2, 0);
      g.add(m);
    }
    g.userData.span = span;
    g.userData.crown = springY + R + th * 0.6;
    return g;
  }

  // =========================================================================
  // MEANDER BAND
  // =========================================================================
  /**
   * kit.meanderBand({ h, length | arc:{r,a0,a1}, depth, mat })
   * Real extruded Greek key. Returns a Group; instance it via a Batcher when
   * the same band appears more than once.
   */
  meanderBand(opts = {}) {
    const h = opts.h ?? 0.5;
    const depth = opts.depth ?? 0.28;
    const mat = opts.mat || this.mat('leaf');
    const g = new THREE.Group();
    g.name = 'meander';
    const period = this.geo(`meander:${h.toFixed(3)}:${depth.toFixed(3)}`, () => meanderPeriod(h, depth));

    if (opts.arc) {
      const { r, a0, a1 } = opts.arc;
      const arcLen = Math.abs(a1 - a0) * r;
      const n = Math.max(1, Math.floor(arcLen / h));
      const step = (a1 - a0) / n;
      for (let i = 0; i < n; i++) {
        const a = a0 + step * (i + 0.5);
        const m = this._mesh(period, mat, 'meander.period', true, false);
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        m.rotation.y = -a + (step > 0 ? Math.PI / 2 : -Math.PI / 2);
        g.add(m);
      }
      // the continuous rail, as short arc chords
      const railGeo = this.geo(`mrail:${h.toFixed(3)}:${depth.toFixed(3)}`, () => meanderRail(h, h * 1.02, depth));
      for (let i = 0; i < n; i++) {
        const a = a0 + step * (i + 0.5);
        const m = this._mesh(railGeo, mat, 'meander.rail', false, false);
        m.position.set(Math.cos(a) * r, -h * 0.5 + h / 16, Math.sin(a) * r);
        m.rotation.y = -a + (step > 0 ? Math.PI / 2 : -Math.PI / 2);
        g.add(m);
      }
    } else {
      const L = opts.length ?? 4;
      const n = Math.max(1, Math.floor(L / h));
      for (let i = 0; i < n; i++) {
        const m = this._mesh(period, mat, 'meander.period', true, false);
        m.position.x = -L * 0.5 + h * (i + 0.5);
        g.add(m);
      }
      const rail = this._mesh(this.own(meanderRail(h, n * h, depth)), mat, 'meander.rail', false, false);
      rail.position.y = -h * 0.5 + h / 16;
      g.add(rail);
    }
    return g;
  }

  // =========================================================================
  // CORNICE / ENTABLATURE
  // =========================================================================
  /**
   * kit.cornice({ length | arc, h, proud, ornate })
   * Architrave fasciae, a dentil course, egg-and-dart, and a crowning corona.
   * This is the piece that gives a wall a lit top edge instead of a cut-off.
   */
  cornice(opts = {}) {
    const H = opts.h ?? 1.15;
    const D = opts.d ?? 0.85;
    const stone = this.mat('wall');
    const trim = this.mat('leaf');
    const g = new THREE.Group();
    g.name = 'cornice';

    const make = (len) => {
      const key = `cornice:${H.toFixed(2)}:${D.toFixed(2)}:${len.toFixed(2)}`;
      return this.geo(key, () => {
        const p = new Parts();
        // architrave: three fasciae, each stepping proud
        p.box(len, H * 0.16, D * 0.72, [0, H * 0.08, 0]);
        p.box(len, H * 0.14, D * 0.80, [0, H * 0.23, D * 0.04]);
        p.box(len, H * 0.06, D * 0.90, [0, H * 0.33, D * 0.09]);
        // corona: the big overhang, with a drip fillet under it
        p.box(len, H * 0.20, D * 1.35, [0, H * 0.76, D * 0.24]);
        p.box(len, H * 0.07, D * 1.44, [0, H * 0.90, D * 0.28]);
        // cyma: a crowning ogee, approximated by two stepped fillets
        p.box(len, H * 0.09, D * 1.20, [0, H * 0.98, D * 0.18]);
        return faceted(p.merge());
      });
    };

    const dent = this.geo(`dentil:${H.toFixed(2)}`, () => dentilUnit(H * 0.19));
    const ed = this.geo(`ed:${(H * 0.20).toFixed(3)}`, () => eggAndDartUnit(H * 0.20));

    if (opts.arc) {
      const { r, a0, a1 } = opts.arc;
      const seg = opts.segLen ?? 1.4;
      const n = Math.max(2, Math.round(Math.abs(a1 - a0) * r / seg));
      const step = (a1 - a0) / n;
      const chord = 2 * r * Math.abs(Math.sin(step * 0.5)) * 1.03;
      const body = make(chord);
      for (let i = 0; i < n; i++) {
        const a = a0 + step * (i + 0.5);
        const m = this._mesh(body, stone, 'cornice.body');
        m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        m.rotation.y = -a + Math.PI / 2;
        g.add(m);
      }
      if (opts.ornate !== false) {
        const nd = Math.max(6, Math.round(Math.abs(a1 - a0) * r / (H * 0.34)));
        for (let i = 0; i < nd; i++) {
          const a = a0 + (a1 - a0) * ((i + 0.5) / nd);
          const m = this._mesh(dent, stone, 'cornice.dentil', true, false);
          m.position.set(Math.cos(a) * (r + D * 0.22), H * 0.50, Math.sin(a) * (r + D * 0.22));
          m.rotation.y = -a + Math.PI / 2;
          g.add(m);
        }
        const ne = Math.max(6, Math.round(Math.abs(a1 - a0) * r / (H * 0.132)));
        for (let i = 0; i < ne; i++) {
          const a = a0 + (a1 - a0) * ((i + 0.5) / ne);
          const m = this._mesh(ed, trim, 'cornice.eggdart', true, false);
          m.position.set(Math.cos(a) * (r + D * 0.36), H * 0.655, Math.sin(a) * (r + D * 0.36));
          m.rotation.set(-0.15, -a + Math.PI / 2, 0);
          g.add(m);
        }
      }
    } else {
      const L = opts.length ?? 6;
      g.add(this._mesh(make(L), stone, 'cornice.body'));
      if (opts.ornate !== false) {
        const nd = Math.max(4, Math.round(L / (H * 0.34)));
        for (let i = 0; i < nd; i++) {
          const m = this._mesh(dent, stone, 'cornice.dentil', true, false);
          m.position.set(-L * 0.5 + L * ((i + 0.5) / nd), H * 0.50, D * 0.22);
          g.add(m);
        }
        const ne = Math.max(4, Math.round(L / (H * 0.132)));
        for (let i = 0; i < ne; i++) {
          const m = this._mesh(ed, trim, 'cornice.eggdart', true, false);
          m.position.set(-L * 0.5 + L * ((i + 0.5) / ne), H * 0.655, D * 0.36);
          m.rotation.x = -0.15;
          g.add(m);
        }
      }
    }
    g.userData.height = H;
    return g;
  }

  // =========================================================================
  // LINTEL / WALL PANEL
  // =========================================================================
  /** A carved wall panel: recessed field, moulded frame, meander inlay band. */
  panel(opts = {}) {
    const w = opts.w ?? 3.0, h = opts.h ?? 4.0, d = opts.d ?? 0.5;
    const g = new THREE.Group();
    g.name = 'panel';
    const stone = this.mat('bay');
    const trim = this.mat('leaf');
    const key = `panel:${w.toFixed(2)}:${h.toFixed(2)}:${d.toFixed(2)}`;
    const body = this.geo(key, () => {
      const p = new Parts();
      p.box(w, h, d, [0, 0, 0]);
      // moulded frame proud of the field
      const fw = w * 0.10;
      p.box(w, fw * 0.9, d * 0.42, [0, h * 0.5 - fw * 0.45, d * 0.62]);
      p.box(w, fw * 0.9, d * 0.42, [0, -h * 0.5 + fw * 0.45, d * 0.62]);
      p.box(fw * 0.9, h, d * 0.42, [-w * 0.5 + fw * 0.45, 0, d * 0.62]);
      p.box(fw * 0.9, h, d * 0.42, [w * 0.5 - fw * 0.45, 0, d * 0.62]);
      return faceted(p.merge());
    });
    g.add(this._mesh(body, stone, 'panel.body'));
    if (opts.meander !== false) {
      const band = this.meanderBand({ h: Math.min(w * 0.16, h * 0.20), length: w * 0.76, depth: 0.22, mat: trim });
      band.position.set(0, opts.bandY ?? h * 0.22, d * 0.62);
      g.add(band);
    }
    if (opts.rosette) {
      const ros = this.geo('rosette:' + (w * 0.13).toFixed(3), () => this._rosetteGeo(w * 0.13));
      const m = this._mesh(ros, trim, 'panel.rosette');
      m.position.set(0, -h * 0.16, d * 0.60);
      g.add(m);
    }
    return g;
  }

  _rosetteGeo(r) {
    const p = new Parts();
    p.add(lathe([[r * 0.30, 0], [r * 0.34, r * 0.18], [r * 0.20, r * 0.34], [r * 0.06, r * 0.40]], 12));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const pet = new THREE.SphereGeometry(r * 0.34, 8, 6);
      pet.scale(0.55, 0.32, 1.0);
      p.add(pet, { p: [Math.cos(a) * r * 0.56, r * 0.10, Math.sin(a) * r * 0.56], r: [0, -a + Math.PI / 2, 0.25] });
    }
    p.add(new THREE.TorusGeometry(r * 0.92, r * 0.10, 7, 20), { p: [0, r * 0.04, 0], r: [Math.PI / 2, 0, 0] });
    return p.merge();
  }

  // =========================================================================
  // STATUES
  // =========================================================================
  /**
   * kit.statue(kind, opts) — 'robed' | 'shade' | 'hound' | 'caryatid' |
   * 'sentinel'. Every one is authored so its 1/8-resolution silhouette is
   * unambiguous: a cowl, a chain, three heads, a bowed head with raised arm.
   */
  statue(kind = 'robed', opts = {}) {
    const g = new THREE.Group();
    g.name = 'statue.' + kind;
    const scale = opts.scale ?? 1;
    const stoneMat = this.mat(opts.mat || 'metal', opts.matOpts);
    const key = 'statue:' + kind;
    const geo = this.geo(key, () => {
      switch (kind) {
        case 'shade': return this._shadeGeo();
        case 'hound': return this._houndGeo();
        case 'caryatid': return this._caryatidGeo();
        case 'sentinel': return this._sentinelGeo();
        default: return this._robedGeo();
      }
    });
    const m = this._mesh(geo, stoneMat, 'statue');
    m.scale.setScalar(scale);
    g.add(m);
    // ---- the statue's GOLD (§2 "the ornament spine", §9.5 "ornament carries
    // the light"). A statue is one mesh with one material, so every scrap of
    // gold in the room had to come from architecture: measured, saturated gold
    // was 1.2% of a gameplay frame. Each figure now carries a second, small
    // gold shell — a hoplon blazon, a studded collar, an offering bowl — which
    // is where the highlight band belongs and what a Supergiant statue always
    // has that a blockout does not.
    const trimFn = this['_' + kind + 'TrimGeo'];
    if (typeof trimFn === 'function') {
      const tg = this.geo(key + ':trim', () => trimFn.call(this));
      if (tg && tg.attributes.position.count) {
        const tm = this._mesh(tg, this.mat('leaf', { specGain: 1.35 }), 'statue.trim');
        tm.scale.setScalar(scale);
        g.add(tm);
        g.userData.trim = tm;
      }
    }
    if (opts.plinth !== false) {
      const ph = opts.plinthH ?? 0.95;
      const pw = opts.plinthW ?? 1.6;
      const pg = this.geo(`plinth:${pw.toFixed(2)}:${ph.toFixed(2)}`, () => {
        const p = new Parts();
        p.box(pw, ph * 0.72, pw, [0, ph * 0.36, 0]);
        p.box(pw * 1.16, ph * 0.13, pw * 1.16, [0, ph * 0.055, 0]);
        p.box(pw * 1.12, ph * 0.16, pw * 1.12, [0, ph * 0.80, 0]);
        p.box(pw * 1.20, ph * 0.07, pw * 1.20, [0, ph * 0.92, 0]);
        return faceted(p.merge());
      });
      // A plinth is a BASE. At full rig gain its big flat top and its two lit
      // faces became the brightest architecture in the lower half of the frame
      // — §9.5 puts the light on edges (its cap mouldings), not on its faces.
      // ROUND-2: at 0.66/0.82 the plinth's big flat top and its two lit faces
      // measured as the brightest pale slabs in the mid-ground of the wide
      // shot — a row of blown rectangles under every figure. §9.5 puts the
      // light on its cap mouldings, which is what specGain is for.
      const pl = this._mesh(pg, this.mat('wall', { litGain: 0.30, ambGain: 0.40, specGain: 1.4 }), 'statue.plinth');
      g.add(pl);
      m.position.y = ph * 0.96;
      if (g.userData.trim) g.userData.trim.position.y = ph * 0.96;
      g.userData.top = ph * 0.96;
    }
    return g;
  }

  /**
   * A robed, cowled mourner. The hood is the silhouette.
   *
   * REBUILT. foldify() was being called at amp 0.055 over 11 folds, which is
   * ~3cm of relief on a 1.2m-wide garment: at gameplay distance the robe was a
   * smooth cone and the critique "no drapery folds" was simply correct. The
   * folds are now 9cm and count 15, the shoulders are cut in so the cone reads
   * as a FIGURE, the arms are pushed clear of the mantle instead of being
   * buried inside it, and the cowl is a real hood with a dark face void under
   * an overhanging brow rather than a solid lump.
   */
  _robedGeo() {
    const p = new Parts();
    // ---- robe: a lathe with deep vertical fold modulation -----------------
    const robe = lathe([
      [0.62, 0.00], [0.665, 0.09], [0.615, 0.34], [0.548, 0.72], [0.492, 1.10],
      [0.452, 1.44], [0.428, 1.68], [0.446, 1.86], [0.408, 2.02], [0.300, 2.14], [0.190, 2.22],
    ], 68);
    foldify(robe, 15, 0.090, 0.45);
    p.add(robe);
    // hem break: the robe pools on the plinth, it does not end in a clean disc
    for (let i = 0; i < 15; i++) {
      const a = (i / 15) * TAU + 0.2;
      const pool = new THREE.SphereGeometry(0.095, 7, 5);
      pool.scale(1.6, 0.30, 0.9);
      p.add(pool, { p: [Math.cos(a) * 0.615, 0.032, Math.sin(a) * 0.615], r: [0, -a, 0] });
    }
    // ---- mantle over the shoulders, with a rolled edge --------------------
    const mantle = lathe([[0.205, 0], [0.375, 0.11], [0.452, 0.25], [0.430, 0.39], [0.352, 0.50]], 56);
    foldify(mantle, 16, 0.036, 0.35);
    p.add(mantle, { p: [0, 1.62, 0], s: [1.08, 1, 1.00] });
    p.add(new THREE.TorusGeometry(0.372, 0.038, 7, 30), { p: [0, 1.745, 0], r: [Math.PI / 2, 0, 0], s: [1.08, 1, 1.0] });
    // ---- cowl: an overhanging hood with a REAL void where the face is -----
    const hood = lathe([
      [0.155, 0.00], [0.235, 0.050], [0.286, 0.150], [0.300, 0.275], [0.272, 0.385],
      [0.196, 0.470], [0.098, 0.512],
    ], 40);
    hood.scale(1.04, 1, 1.26);
    p.add(hood, { p: [0, 2.02, -0.03] });
    // the brow of the hood, pulled forward over the face — an overhang, not a
    // mushroom cap: a thin roll on a 0.24 radius sitting low over the eyes
    p.add(new THREE.TorusGeometry(0.232, 0.040, 8, 24, Math.PI * 1.02), {
      p: [0, 2.222, 0.142], r: [1.26, 0, 0], s: [1.06, 1, 1.0],
    });
    // the face: a shadowed mask set back under the brow (a hole reads as a
    // hole only if there is something a little brighter inside it)
    const mask = new THREE.SphereGeometry(0.115, 12, 9);
    mask.scale(0.84, 1.06, 0.62);
    p.add(mask, { p: [0, 2.148, 0.122] });
    // chin and cheek planes catching a whisper of light inside the cowl
    p.add(new THREE.BoxGeometry(0.115, 0.048, 0.055), { p: [0, 2.068, 0.132], r: [0.28, 0, 0] });
    // ---- arms, clear of the mantle, hands cupped forward -------------------
    for (const s of [-1, 1]) {
      p.add(taperedTube([
        new THREE.Vector3(s * 0.330, 1.88, -0.01),
        new THREE.Vector3(s * 0.425, 1.68, 0.16),
        new THREE.Vector3(s * 0.372, 1.46, 0.36),
        new THREE.Vector3(s * 0.160, 1.34, 0.46),
      ], [0.118, 0.108, 0.094, 0.078], 9));
      // sleeve mouth: a flared cuff with its own folds
      const sleeve = lathe([[0.048, 0], [0.170, 0.10], [0.212, 0.27], [0.145, 0.38]], 34);
      foldify(sleeve, 8, 0.055, 0.3);
      p.add(sleeve, { p: [s * 0.372, 1.40, 0.36], r: [0.66, 0, s * 0.34] });
      // hand
      const hand = new THREE.SphereGeometry(0.068, 8, 7);
      hand.scale(1.25, 0.72, 1.0);
      p.add(hand, { p: [s * 0.145, 1.335, 0.465] });
    }
    // ---- rope girdle, knotted ---------------------------------------------
    p.add(new THREE.TorusGeometry(0.455, 0.038, 7, 30), { p: [0, 1.42, 0], r: [Math.PI / 2, 0, 0] });
    p.add(taperedTube([
      new THREE.Vector3(0.10, 1.42, 0.45), new THREE.Vector3(0.16, 1.18, 0.49),
      new THREE.Vector3(0.12, 0.94, 0.52), new THREE.Vector3(0.17, 0.76, 0.51),
    ], [0.036, 0.030, 0.026, 0.018], 6));
    const g = p.merge();
    g.computeBoundingBox();
    return g;
  }

  /** The mourner's GOLD: the offering bowl, the fibula and the girdle boss. */
  _robedTrimGeo() {
    const p = new Parts();
    // offering bowl held in the cupped hands — a bright disc for the key
    p.add(lathe([[0.02, 0], [0.185, 0.035], [0.225, 0.115], [0.212, 0.150], [0.175, 0.135]], 18),
      { p: [0, 1.355, 0.465] });
    p.add(new THREE.TorusGeometry(0.222, 0.022, 6, 22), { p: [0, 1.500, 0.465], r: [Math.PI / 2, 0, 0] });
    // fibula clasping the mantle at the throat
    p.add(lathe([[0.02, 0], [0.075, 0.02], [0.095, 0.06], [0.05, 0.10]], 12), { p: [0, 1.92, 0.26], r: [1.3, 0, 0] });
    // a bead course round the mantle roll — §9.5, the ornament takes the light
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      const bd = new THREE.SphereGeometry(0.030, 6, 5);
      p.add(bd, { p: [Math.cos(a) * 0.398, 1.745, Math.sin(a) * 0.372] });
    }
    // girdle boss
    p.add(new THREE.TorusGeometry(0.092, 0.024, 6, 16), { p: [0, 1.42, 0.455], r: [0, 0, 0] });
    const g = p.merge();
    g.computeBoundingBox();
    return g;
  }

  /** A chained shade: gaunt, arms hauled upward, lower body a dissolving column. */
  _shadeGeo() {
    const p = new Parts();
    // lower body tapers to a wisp — a shade has no feet
    const wisp = lathe([
      [0.10, 0.00], [0.28, 0.14], [0.36, 0.38], [0.40, 0.72], [0.38, 1.06],
      [0.34, 1.34], [0.31, 1.56],
    ], 20);
    foldify(wisp, 7, 0.07, 0.9);
    p.add(wisp);
    // ribcage: a hollow-chested torso
    const torso = lathe([
      [0.31, 0.00], [0.36, 0.14], [0.34, 0.30], [0.30, 0.44], [0.33, 0.58], [0.36, 0.70], [0.26, 0.78],
    ], 18);
    torso.scale(1.22, 1, 0.68);
    p.add(torso, { p: [0, 1.56, 0] });
    for (let i = 0; i < 4; i++) {
      const rib = new THREE.TorusGeometry(0.30 - i * 0.012, 0.022, 5, 14, Math.PI * 1.1);
      p.add(rib, { p: [0, 1.72 + i * 0.115, 0.02], r: [Math.PI / 2, 0, Math.PI * 0.05], s: [1.2, 0.7, 1] });
    }
    // head thrown back
    const head = new THREE.SphereGeometry(0.185, 12, 9);
    head.scale(0.86, 1.10, 0.94);
    p.add(head, { p: [0, 2.50, -0.06], r: [-0.42, 0, 0] });
    const jaw = new THREE.SphereGeometry(0.10, 8, 6);
    jaw.scale(1.0, 0.6, 1.2);
    p.add(jaw, { p: [0, 2.40, 0.08], r: [-0.3, 0, 0] });
    // arms hauled up and outward — the pose IS the read
    for (const s of [-1, 1]) {
      const arm = taperedTube([
        new THREE.Vector3(s * 0.30, 2.24, 0.0), new THREE.Vector3(s * 0.56, 2.52, -0.10),
        new THREE.Vector3(s * 0.70, 2.90, -0.16), new THREE.Vector3(s * 0.74, 3.22, -0.14),
      ], [0.115, 0.095, 0.078, 0.062], 7);
      p.add(arm);
      // manacle
      p.add(new THREE.TorusGeometry(0.085, 0.030, 6, 12), { p: [s * 0.74, 3.22, -0.14], r: [0.4, 0, s * 0.3] });
      // chain rising out of frame
      const links = catenary(new THREE.Vector3(s * 0.74, 3.22, -0.14), new THREE.Vector3(s * 0.96, 4.30, -0.26), 0.12, 8);
      for (let i = 0; i < links.length - 1; i++) {
        const t = new THREE.TorusGeometry(0.062, 0.020, 5, 10);
        const dir = new THREE.Vector3().subVectors(links[i + 1], links[i]).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        const gg = t.clone();
        gg.applyQuaternion(q);
        if (i % 2) gg.rotateZ(Math.PI / 2);
        gg.translate(links[i].x, links[i].y, links[i].z);
        p.add(gg);
        t.dispose();
      }
    }
    const g = p.merge();
    g.computeBoundingBox();
    return g;
  }

  /**
   * A three-headed hound. Squat, heavy, unmistakable at 1/8 resolution.
   *
   * REBUILT. The previous version was one SphereGeometry(0.62) egg with three
   * ball heads pushed into it: at gameplay distance the whole animal read as a
   * smooth blob with three black lumps, and the authored skull/muzzle/ear stack
   * was buried inside proxy spheres that out-massed it. The rules now are the
   * ones that make a Supergiant creature read:
   *   - the SILHOUETTE is articulated: chest > waist < haunch, not one ovoid;
   *   - each head is a real head — brow, long muzzle, lower jaw, fangs, ears —
   *     and it is BIG relative to the body, because the head is what names the
   *     creature at 1/8 resolution;
   *   - the mass is faceted, so it reads as CARVED rather than inflated;
   *   - the ornament (a studded collar) is a separate gold shell, because §9.5
   *     puts the highlight band on ornament and this is the only statue in the
   *     room large enough to carry it.
   */
  _houndGeo() {
    // ONE SKIN, NOT A PILE. Review round 2 counted the individual spheres and
    // cones on this animal from a shipping screenshot: the primitives were
    // unioned as SHELLS, so every lobe left an intersection crease, every
    // 14-segment sphere left facet seams, and the interior faces of the union
    // drew pale slivers through the surface. The anatomy below is unchanged —
    // articulated chest/waist/haunch, three big heads with real muzzles, jaws,
    // fangs, ears — but it is now authored as a SIGNED DISTANCE FIELD and
    // polygonised into a single welded, manifold shell with smooth-minimum
    // fairing at every joint and baked crevice AO in the vertex colour.
    const F = new Field();
    const B = 0.105;                   // fairing radius between the big masses
    const at = (o, f, u, s, yaw) => [  // point in a head's local frame
      o[0] + Math.cos(yaw) * f - Math.sin(yaw) * s,
      o[1] + u,
      o[2] + Math.sin(yaw) * f + Math.cos(yaw) * s,
    ];

    const head = (o, yaw, k) => {
      const P = (f, u, s) => at(o, f * k, u * k, s * k, yaw);
      // cranium: a directional wedge from occiput to brow, never a ball
      F.cone(P(-0.28, 0.02, 0), P(0.16, 0.04, 0), 0.26 * k, 0.31 * k, 0.10 * k);
      // cheeks / masseter — what gives a stone hound its heavy jaw
      for (const sd of [-1, 1]) F.ell(P(0.06, -0.06, sd * 0.18), [0.18 * k, 0.16 * k, 0.13 * k], 0.09 * k);
      // MUZZLE — the identity shape at 1/8 resolution
      F.cone(P(0.10, 0.01, 0), P(0.62, -0.04, 0), 0.215 * k, 0.115 * k, 0.07 * k);
      F.ell(P(0.655, -0.02, 0), [0.090 * k, 0.080 * k, 0.100 * k], 0.03 * k);
      // brow ridges: proud, with a hard edge, so the eye sits in a shelf
      for (const sd of [-1, 1]) F.box(P(0.20, 0.150, sd * 0.140), [0.125 * k, 0.040 * k, 0.085 * k], 0.02 * k, 0.030 * k, -yaw);
      // LOWER JAW, dropped and only lightly faired, so the mouth stays a GAP
      F.cone(P(0.09, -0.20, 0), P(0.52, -0.275, 0), 0.150 * k, 0.078 * k, 0.030 * k);
      // fangs, upper set hanging into the gap and lower set rising into it
      for (const sd of [-1, 1]) for (let i = 0; i < 2; i++) {
        const f = 0.29 + i * 0.17;
        F.cone(P(f, -0.085, sd * 0.092), P(f + 0.012, -0.195, sd * 0.092), 0.032 * k, 0.006 * k, 0.014 * k);
        F.cone(P(f + 0.03, -0.255, sd * 0.078), P(f + 0.04, -0.160, sd * 0.078), 0.027 * k, 0.005 * k, 0.012 * k);
      }
      // EARS — a FLAT triangular blade, not a spike. Three round cones fanned
      // from a spread base to a common tip give a thin plate with a real
      // broad-to-point taper, and (unlike a scooped cone) nothing can sever.
      for (const sd of [-1, 1]) {
        const tip = P(-0.36, 0.66, sd * 0.33);
        for (let j = -1; j <= 1; j++) {
          F.cone(P(-0.13 + j * 0.085, 0.15 + j * 0.055, sd * 0.185), tip, 0.052 * k, 0.012 * k, 0.038 * k);
        }
      }
      // EYES: the socket is CARVED first, then a blind stone orb set into it.
      for (const sd of [-1, 1]) {
        F.carve.ell(P(0.215, 0.022, sd * 0.150), [0.082 * k, 0.062 * k, 0.082 * k], 0.034 * k);
        F.ell(P(0.228, 0.024, sd * 0.150), [0.070 * k, 0.064 * k, 0.070 * k], 0.018 * k);
      }
    };

    const HEADS = [
      { yaw: -0.92, k: 1.10, y: 1.92, r: 0.72 },
      { yaw: 0.02, k: 1.26, y: 2.28, r: 0.90 },
      { yaw: 0.90, k: 1.08, y: 1.84, r: 0.70 },
    ];
    for (const H of HEADS) {
      const cy = Math.cos(H.yaw), sy = Math.sin(H.yaw);
      const nx = 0.56 + cy * H.r, nz = sy * H.r;
      F.tube([
        [0.34, 1.26, sy * 0.16],
        [0.56 + cy * 0.22, 1.58, sy * 0.34],
        [0.52 + cy * 0.50, H.y - 0.22, sy * 0.60],
        [nx - cy * 0.18, H.y - 0.04, nz - sy * 0.14],
      ], [0.28, 0.235, 0.195, 0.185], B);
      head([nx, H.y, nz], H.yaw, H.k);
    }

    // ---- body: chest / waist / rump, three masses faired into one form ----
    F.ell([0.34, 1.18, 0], [0.60, 0.56, 0.50], B);
    for (const sd of [-1, 1]) F.ell([0.30, 1.44, sd * 0.34], [0.30, 0.28, 0.18], 0.09);
    F.ell([-0.30, 1.06, 0], [0.52, 0.40, 0.37], B);
    F.ell([-0.96, 1.10, 0], [0.54, 0.52, 0.47], B);
    for (const sd of [-1, 1]) F.ell([-0.92, 1.02, sd * 0.30], [0.42, 0.40, 0.28], 0.10);
    // RIBS as PROUD ridges laid on the flank, not grooves cut into it. A groove
    // in a 0.4m-thick waist punches straight through; a ridge cannot, and §9.5
    // wants the highlight on the arris anyway — a raised rib catches the key,
    // a sunk one only ever reads as a black line.
    for (const sd of [-1, 1]) for (let i = 0; i < 5; i++) {
      const dx = 0.42 - i * 0.19;
      const pts = [], rad = [];
      for (let t = 0; t <= 4; t++) {
        const a = 0.34 + (t / 4) * 1.28;                      // top of flank -> belly
        pts.push([0.34 + dx - t * 0.045, 1.18 + 0.545 * Math.cos(a), sd * 0.495 * Math.sin(a)]);
        rad.push(0.052 - 0.006 * t);
      }
      F.tube(pts, rad, 0.075);
    }
    // NECK ROOT — one shared mass the three necks grow OUT of. Without it the
    // junction is a smooth Y and the animal reads as a body wearing three
    // growths; with it, the trio reads as one creature.
    F.ell([0.52, 1.46, 0], [0.34, 0.36, 0.46], 0.12);
    // and a carved mane ring over it, which is where the gold collar sits
    for (let i = 0; i < 13; i++) {
      const a = -1.15 + (i / 12) * 2.30;
      F.ell([0.44 - Math.sin(a) * 0.06, 1.46 + Math.cos(a) * 0.44, Math.sin(a) * 0.50],
        [0.115, 0.125, 0.115], 0.070);
    }
    // spine ridge
    F.tube([[0.60, 1.66, 0], [0.20, 1.62, 0], [-0.30, 1.48, 0], [-0.84, 1.58, 0]], [0.09, 0.09, 0.08, 0.10], 0.09);

    // ---- legs ------------------------------------------------------------
    for (const sd of [-1, 1]) {
      F.tube([[0.64, 1.24, sd * 0.42], [0.74, 0.80, sd * 0.45], [0.72, 0.36, sd * 0.45], [0.80, 0.10, sd * 0.45]],
        [0.24, 0.155, 0.115, 0.125], 0.09);
      F.ell([0.735, 0.80, sd * 0.45], [0.135, 0.125, 0.115], 0.06);
      F.tube([[-0.92, 1.16, sd * 0.40], [-1.06, 0.76, sd * 0.45], [-0.80, 0.38, sd * 0.45], [-0.88, 0.10, sd * 0.45]],
        [0.28, 0.17, 0.12, 0.13], 0.09);
      F.ell([-1.05, 0.78, sd * 0.45], [0.155, 0.145, 0.13], 0.06);
      for (const px of [-0.88, 0.80]) {
        F.ell([px + 0.05, 0.058, sd * 0.45], [0.19, 0.075, 0.155], 0.05);
        for (let t = -1; t <= 1; t++) {
          F.cone([px + 0.10, 0.055, sd * 0.45 + t * 0.088], [px + 0.245, 0.048, sd * 0.45 + t * 0.088], 0.062, 0.040, 0.030);
          F.cone([px + 0.245, 0.048, sd * 0.45 + t * 0.088], [px + 0.345, 0.030, sd * 0.45 + t * 0.088], 0.030, 0.004, 0.014);
        }
      }
    }

    // ---- serpent tail, thrown UP and back. A tail that hangs disappears into
    // the plinth; a tail that arcs above the rump is silhouette, which is what
    // §5's 1/8-resolution test is actually asking for.
    F.tube([[-1.34, 1.22, 0], [-1.72, 1.62, 0.10], [-1.92, 2.10, 0.34], [-1.74, 2.48, 0.66], [-1.36, 2.56, 0.86]],
      [0.150, 0.115, 0.085, 0.058, 0.028], 0.075);
    // a serpent head on the end of it — Cerberus's tail is a snake
    F.ell([-1.28, 2.56, 0.92], [0.11, 0.075, 0.085], 0.030);
    F.cone([-1.24, 2.55, 0.95], [-1.10, 2.52, 1.06], 0.070, 0.030, 0.022);

    const g = F.build({ cell: 0.0300, ao: 0.62, minPart: 0.05 });
    // authored nose-to-+X; every other figure in the kit looks down +Z, and the
    // chamber orients them all with one rule, so bring it into the convention
    g.rotateY(-Math.PI / 2);
    g.computeBoundingBox();
    return g;
  }

  /**
   * The hound's GOLD: a studded collar round the base of the three necks and a
   * pectoral drop. §9.5 — the ornament is where the highlight band lives, and a
   * separate mesh is the only way to get a second material onto a statue.
   */
  _houndTrimGeo() {
    const p = new Parts();
    // collar band round the neck root
    const band = new THREE.TorusGeometry(0.46, 0.072, 8, 26);
    p.add(band, { p: [0.50, 1.42, 0], r: [0, 0, Math.PI / 2 - 0.30], s: [1, 1, 0.92] });
    // studs
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU;
      const st = new THREE.ConeGeometry(0.062, 0.16, 5);
      const cx = 0.50 + Math.sin(a) * 0.46 * Math.sin(0.30);
      const cy = 1.42 + Math.cos(a) * 0.46;
      const cz = Math.sin(a) * 0.46 * Math.cos(0.30);
      p.add(st, { p: [cx + Math.cos(a) * 0.0, cy, cz], r: [Math.PI / 2 - a, 0, 0.30] });
    }
    // pectoral drop — a palmette hanging at the throat
    p.add(lathe([[0.02, 0], [0.13, 0.05], [0.16, 0.14], [0.09, 0.24], [0.03, 0.30]], 12),
      { p: [0.74, 1.06, 0], r: [0, 0, -0.5] });
    for (let i = 0; i < 5; i++) {
      const a = (-0.5 + i * 0.25);
      const pet = new THREE.SphereGeometry(0.075, 7, 5);
      pet.scale(1, 0.34, 1.9);
      p.add(pet, { p: [0.80 + Math.cos(a) * 0.10, 0.94 + Math.sin(a) * 0.06, 0], r: [Math.PI / 2, a, 0] });
    }
    const g = faceted(p.merge());
    g.rotateY(-Math.PI / 2);
    g.computeBoundingBox();
    return g;
  }

  /** A weeping caryatid: she carries an entablature basket on her head. */
  _caryatidGeo() {
    const p = new Parts();
    // chiton: fluted like a column shaft — that is the joke of a caryatid
    const skirt = lathe([
      [0.48, 0.00], [0.50, 0.16], [0.46, 0.60], [0.42, 1.02], [0.40, 1.30],
      [0.42, 1.48], [0.38, 1.64],
    ], 26);
    foldify(skirt, 16, 0.036, 0.35);
    p.add(skirt);
    // engaged leg breaking the drapery — the contrapposto
    const knee = new THREE.SphereGeometry(0.16, 9, 7);
    knee.scale(1, 1.6, 0.9);
    p.add(knee, { p: [0.16, 0.62, 0.34] });
    // torso
    const torso = lathe([
      [0.38, 0.00], [0.34, 0.14], [0.31, 0.30], [0.34, 0.46], [0.37, 0.60], [0.33, 0.70], [0.22, 0.76],
    ], 18);
    torso.scale(1.10, 1, 0.76);
    p.add(torso, { p: [0, 1.64, 0] });
    // himation folded across the chest
    const sash = new THREE.TorusGeometry(0.36, 0.055, 6, 18, Math.PI * 1.3);
    p.add(sash, { p: [0, 2.02, 0.05], r: [0.28, 0, 0.6], s: [1.1, 1, 0.75] });
    // head bowed, one arm raised to the face — the weeping read
    const head = new THREE.SphereGeometry(0.185, 12, 9);
    head.scale(0.90, 1.08, 0.94);
    p.add(head, { p: [0.05, 2.55, 0.06], r: [0.24, 0.2, 0.10] });
    // hair mass falling behind the shoulders
    const hair = lathe([[0.10, 0], [0.20, 0.10], [0.22, 0.26], [0.17, 0.44], [0.10, 0.56]], 14);
    p.add(hair, { p: [0.02, 2.30, -0.10], r: [-0.2, 0, 0], s: [1.2, 1, 0.9] });
    p.add(taperedTube([
      new THREE.Vector3(0.30, 2.32, 0.02), new THREE.Vector3(0.44, 2.16, 0.16),
      new THREE.Vector3(0.36, 2.36, 0.28), new THREE.Vector3(0.18, 2.50, 0.22),
    ], [0.115, 0.095, 0.085, 0.07], 8));
    p.add(taperedTube([
      new THREE.Vector3(-0.30, 2.30, 0.0), new THREE.Vector3(-0.42, 2.00, 0.10),
      new THREE.Vector3(-0.40, 1.72, 0.16), new THREE.Vector3(-0.34, 1.58, 0.20),
    ], [0.115, 0.095, 0.082, 0.075], 8));
    // the basket capital she carries
    const cap = lathe([
      [0.24, 0.00], [0.34, 0.06], [0.36, 0.20], [0.42, 0.32], [0.44, 0.40],
    ], 18);
    p.add(cap, { p: [0, 2.72, 0] });
    p.add(faceted(new THREE.BoxGeometry(1.02, 0.14, 1.02)), { p: [0, 3.18, 0] });
    p.add(faceted(new THREE.BoxGeometry(1.14, 0.06, 1.14)), { p: [0, 3.27, 0] });
    const g = p.merge();
    g.computeBoundingBox();
    return g;
  }

  /**
   * A helmeted hoplite sentinel: crest, cuirass, pteruges, round hoplon and
   * spear.
   *
   * REBUILT. The old build hung a CylinderGeometry(0.64, 0.30, ...) cloak on
   * it — radiusTOP 0.64, radiusBOTTOM 0.30 — so the drapery was WIDE AT THE
   * SHOULDER and NARROW AT THE FOOT. On a plinth at gameplay distance that
   * reads as an upside-down bucket with a ball on top, and because the shell
   * was 0.64 across it swallowed the arms, the spear grip and the kilt
   * entirely: the figure critics saw had no arms, no folds and no face because
   * none of them were visible, not because none were authored.
   * The cloak now tapers the right way, wraps only the BACK 190deg, and the
   * hoplon shield gives the silhouette the one big graphic disc that makes a
   * hoplite readable at 1/8 resolution.
   */
  _sentinelGeo() {
    const p = new Parts();
    // ---- legs: greaved, one engaged one free (contrapposto) ---------------
    for (const s of [-1, 1]) {
      const knee = 0.62 + (s > 0 ? 0.03 : 0);
      p.add(taperedTube([
        new THREE.Vector3(s * 0.135, 1.44, s > 0 ? 0.02 : -0.03),
        new THREE.Vector3(s * 0.150, knee + 0.30, 0.0),
        new THREE.Vector3(s * 0.155, knee, s > 0 ? 0.02 : -0.02),
        new THREE.Vector3(s * 0.152, 0.30, s > 0 ? 0.0 : -0.05),
        new THREE.Vector3(s * 0.150, 0.06, s > 0 ? 0.02 : -0.04),
      ], [0.150, 0.128, 0.098, 0.088, 0.100], 9));
      // greave: a proud plate down the shin
      const gr = lathe([[0.104, 0.00], [0.118, 0.10], [0.112, 0.30], [0.098, 0.48], [0.092, 0.56]], 12);
      p.add(gr, { p: [s * 0.152, 0.10, s > 0 ? 0.005 : -0.045], s: [1, 1, 0.86] });
      // sandal
      p.add(taperedTube([
        new THREE.Vector3(s * 0.150, 0.055, (s > 0 ? 0.02 : -0.04) - 0.06),
        new THREE.Vector3(s * 0.152, 0.035, (s > 0 ? 0.02 : -0.04) + 0.10),
        new THREE.Vector3(s * 0.150, 0.028, (s > 0 ? 0.02 : -0.04) + 0.22),
      ], [0.100, 0.090, 0.060], 7));
    }
    // ---- pteruges: a real flared kilt with cut leather straps -------------
    const kilt = lathe([
      [0.235, 1.52], [0.268, 1.40], [0.300, 1.24], [0.330, 1.08], [0.352, 0.96], [0.340, 0.92],
    ], 20);
    foldify(kilt, 16, 0.052, 0.5);
    p.add(kilt);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + 0.11;
      const r0 = 0.318, r1 = 0.366;
      const strap = new THREE.BoxGeometry(0.098, 0.30, 0.046);
      p.add(strap, { p: [Math.cos(a) * (r0 + r1) * 0.5, 0.86, Math.sin(a) * (r0 + r1) * 0.5], r: [0.14, -a + Math.PI / 2, 0] });
    }
    // ---- cuirass ----------------------------------------------------------
    const torso = lathe([
      [0.222, 1.50], [0.252, 1.62], [0.268, 1.78], [0.256, 1.94],
      [0.276, 2.10], [0.312, 2.24], [0.326, 2.36], [0.252, 2.44], [0.16, 2.48],
    ], 20);
    torso.scale(1.30, 1, 0.74);
    p.add(torso);
    // pectoral / abdominal modelling: a sculpted cuirass, not a smooth barrel
    for (const s of [-1, 1]) {
      const pec = new THREE.SphereGeometry(0.135, 10, 8);
      pec.scale(1.05, 0.80, 0.55);
      p.add(pec, { p: [s * 0.150, 2.16, 0.185] });
    }
    for (let i = 0; i < 3; i++) {
      const ab = new THREE.TorusGeometry(0.175 - i * 0.012, 0.024, 5, 14, Math.PI * 0.86);
      p.add(ab, { p: [0, 1.94 - i * 0.135, 0.145], r: [0.32, 0, Math.PI * 0.57], s: [1.35, 1, 0.6] });
    }
    // belt
    p.add(new THREE.TorusGeometry(0.268, 0.038, 7, 24), { p: [0, 1.56, 0.01], r: [Math.PI / 2, 0, 0], s: [1.24, 1, 0.80] });
    // ---- shoulders and arms (OUTSIDE the cloak this time) -----------------
    for (const s of [-1, 1]) {
      // layered pauldron: three lames, not one ball
      for (let li = 0; li < 3; li++) {
        const pd = new THREE.SphereGeometry(0.168 - li * 0.012, 12, 8, 0, TAU, 0, 1.36);
        pd.scale(1, 0.60 - li * 0.05, 0.94);
        p.add(pd, { p: [s * (0.372 + li * 0.012), 2.32 - li * 0.062, 0], r: [0, 0, -s * (0.14 + li * 0.12)] });
      }
    }
    // right arm holds the spear high; left arm carries the shield across
    p.add(taperedTube([
      new THREE.Vector3(0.40, 2.26, 0.02), new THREE.Vector3(0.455, 1.96, 0.10),
      new THREE.Vector3(0.470, 1.70, 0.20), new THREE.Vector3(0.455, 1.60, 0.26),
    ], [0.105, 0.088, 0.078, 0.072], 9));
    p.add(taperedTube([
      new THREE.Vector3(-0.40, 2.26, 0.02), new THREE.Vector3(-0.455, 2.02, 0.14),
      new THREE.Vector3(-0.420, 1.86, 0.30), new THREE.Vector3(-0.330, 1.82, 0.38),
    ], [0.105, 0.090, 0.080, 0.074], 9));
    // fists
    for (const [hx, hy, hz] of [[0.455, 1.56, 0.28], [-0.310, 1.81, 0.40]]) {
      const fist = new THREE.SphereGeometry(0.082, 8, 7);
      fist.scale(1, 1.15, 0.9);
      p.add(fist, { p: [hx, hy, hz] });
    }
    // ---- neck, head, helmet ------------------------------------------------
    p.add(new THREE.CylinderGeometry(0.088, 0.115, 0.14, 10), { p: [0, 2.44, 0] });
    const head = new THREE.SphereGeometry(0.185, 14, 10);
    head.scale(0.94, 1.12, 1.0);
    p.add(head, { p: [0, 2.64, 0.01] });
    // corinthian helm: a bowl, a nasal, two cheek pieces, an eye slot shadow
    const bowl = lathe([[0.198, 0.00], [0.206, 0.08], [0.196, 0.20], [0.150, 0.30], [0.070, 0.35]], 16);
    p.add(bowl, { p: [0, 2.60, 0.005], s: [1, 1, 1.06] });
    p.add(new THREE.TorusGeometry(0.196, 0.030, 7, 18), { p: [0, 2.60, 0.005], r: [Math.PI / 2, 0, 0], s: [1, 1, 1.06] });
    for (const s of [-1, 1]) {
      const cheek = new THREE.BoxGeometry(0.052, 0.20, 0.14);
      p.add(cheek, { p: [s * 0.162, 2.51, 0.055], r: [0.10, 0, s * 0.10] });
    }
    p.add(new THREE.BoxGeometry(0.042, 0.19, 0.055), { p: [0, 2.545, 0.175], r: [0.16, 0, 0] });
    // crest: a tall arc box, the tallest thing on the figure
    const crest = new THREE.CylinderGeometry(0.040, 0.040, 0.50, 6, 1, false);
    crest.scale(1, 1, 3.4);
    p.add(crest, { p: [0, 2.94, -0.03] });
    p.add(new THREE.TorusGeometry(0.215, 0.052, 7, 16, Math.PI * 0.92), { p: [0, 2.86, -0.02], r: [0, Math.PI / 2, 0] });
    // ---- cloak: BEHIND the figure, narrow at the shoulder, wide at the hem -
    const cloak = new THREE.CylinderGeometry(0.32, 0.74, 1.94, 20, 5, true, Math.PI * 0.44, Math.PI * 1.12);
    foldify(cloak, 11, 0.075, 0.85);
    p.add(cloak, { p: [0, 1.42, -0.14] });
    // a clasp roll along the top hem so the cloak has an edge, not a cut
    p.add(new THREE.TorusGeometry(0.325, 0.036, 6, 20, Math.PI * 1.12), { p: [0, 2.39, -0.14], r: [Math.PI / 2, 0, -Math.PI * 0.44] });
    // ---- spear -------------------------------------------------------------
    p.add(new THREE.CylinderGeometry(0.036, 0.040, 3.7, 8), { p: [0.475, 1.78, 0.28] });
    p.add(new THREE.ConeGeometry(0.098, 0.52, 8), { p: [0.475, 3.86, 0.28] });
    p.add(new THREE.ConeGeometry(0.052, 0.20, 6), { p: [0.475, -0.10, 0.28], r: [Math.PI, 0, 0] });
    const g = p.merge();
    g.computeBoundingBox();
    return g;
  }

  /** The sentinel's GOLD: hoplon shield face, crest rail and belt bosses. */
  _sentinelTrimGeo() {
    const p = new Parts();
    // HOPLON — a 0.98m dished disc on the left arm. The one big graphic shape.
    const dish = lathe([
      [0.00, 0.075], [0.16, 0.062], [0.30, 0.042], [0.40, 0.020], [0.46, 0.004],
      [0.49, -0.020], [0.47, -0.048], [0.40, -0.052], [0.20, -0.040], [0.02, -0.030],
    ], 26);
    // The shield faces the ARENA (+Z), not the side: a hoplon seen edge-on is a
    // stick, and the whole point of it is the 1m disc in the silhouette.
    const SP = [-0.40, 1.84, 0.40], TILT = -Math.PI / 2 + 0.16;
    p.add(dish, { p: SP, r: [TILT, 0, 0.10] });
    p.add(new THREE.TorusGeometry(0.475, 0.036, 7, 30), { p: SP, r: [-0.16, 0, 0.10] });
    // blazon: a radiating palmette boss
    p.add(lathe([[0.02, 0], [0.09, 0.03], [0.11, 0.08], [0.06, 0.13]], 12), { p: [SP[0], SP[1], SP[2] + 0.055], r: [TILT, 0, 0.10] });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const ray = new THREE.BoxGeometry(0.030, 0.22, 0.055);
      p.add(ray, { p: [SP[0] + Math.cos(a) * 0.20, SP[1] + Math.sin(a) * 0.20, SP[2] + 0.030], r: [-0.16, 0, -a + 0.10] });
    }
    // a bead course inside the rim — §1.5, ornament concentrated on the focus
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU;
      const bd = new THREE.SphereGeometry(0.030, 6, 5);
      p.add(bd, { p: [SP[0] + Math.cos(a) * 0.405, SP[1] + Math.sin(a) * 0.405, SP[2] + 0.028] });
    }
    // crest rail + belt bosses
    p.add(new THREE.TorusGeometry(0.222, 0.026, 6, 16, Math.PI * 0.92), { p: [0, 2.86, -0.02], r: [0, Math.PI / 2, 0] });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const b = new THREE.SphereGeometry(0.038, 7, 6);
      b.scale(1, 1, 0.6);
      p.add(b, { p: [Math.cos(a) * 0.33, 1.56, Math.sin(a) * 0.215], r: [0, -a, 0] });
    }
    const g = p.merge();
    g.computeBoundingBox();
    return g;
  }

  // =========================================================================
  // BRAZIER / SCONCE / CENSER
  // =========================================================================
  /**
   * kit.brazier({ h, r, kind:'tripod'|'bowl'|'column' })
   * userData.flame = local-space flame anchor. The chamber hands that point to
   * props.js, which owns the flame billboards and the pooled practical light.
   */
  brazier(opts = {}) {
    const H = opts.h ?? 1.95;
    const R = opts.r ?? 0.72;
    const g = new THREE.Group();
    g.name = 'brazier';
    const metal = this.mat('metal');
    const stone = this.mat('wall');
    // The library has no `lava` recipe yet, so the coals would resolve to plain
    // stone. An authored emissive keeps them reading as a live fire bed under
    // the flame billboards without inventing a new material.
    // ROUND-2: at 1.5 the coal bed inside every bowl blew a wide bloom halo
    // over the architecture behind it, and any far ornament silhouetted against
    // that halo (a dentil course, a cornice lip) crushed to pure black boxes —
    // §7's 'perfectly sharp, aliased edges' failure, visible at 1x in the
    // shipped frames. The coals are a source, not a lamp.
    const ember = this.mat('ember', { emissive: '#ff5e18', emissiveIntensity: 0.85, tint: '#4a1a10' });
    const key = `brazier:${H.toFixed(2)}:${R.toFixed(2)}`;

    const legsGeo = this.geo(key + ':legs', () => {
      const p = new Parts();
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.4;
        const cx = Math.cos(a), cz = Math.sin(a);
        // a real cabriole leg: out, in, out to a claw
        p.add(taperedTube([
          new THREE.Vector3(cx * R * 0.34, H * 0.86, cz * R * 0.34),
          new THREE.Vector3(cx * R * 0.72, H * 0.60, cz * R * 0.72),
          new THREE.Vector3(cx * R * 0.60, H * 0.30, cz * R * 0.60),
          new THREE.Vector3(cx * R * 0.86, H * 0.10, cz * R * 0.86),
          new THREE.Vector3(cx * R * 0.98, H * 0.015, cz * R * 0.98),
        ], [R * 0.115, R * 0.095, R * 0.075, R * 0.085, R * 0.10], 7));
        // claw toes
        for (let t = -1; t <= 1; t++) {
          const ta = a + t * 0.34;
          const toe = new THREE.SphereGeometry(R * 0.055, 6, 5);
          toe.scale(1.8, 0.8, 1);
          p.add(toe, { p: [Math.cos(ta) * R * 1.08, H * 0.018, Math.sin(ta) * R * 1.08], r: [0, -ta, 0] });
        }
        // scrolled knee ornament
        const v = volute(R * 0.13, 1.3, R * 0.035);
        p.add(v, { p: [cx * R * 0.74, H * 0.60, cz * R * 0.74], r: [0, -a + Math.PI / 2, 0.4] });
      }
      // binding ring
      p.add(new THREE.TorusGeometry(R * 0.66, R * 0.045, 6, 20), { p: [0, H * 0.42, 0], r: [Math.PI / 2, 0, 0] });
      return p.merge();
    });
    g.add(this._mesh(legsGeo, metal, 'brazier.legs'));

    const bowlGeo = this.geo(key + ':bowl', () => {
      const p = new Parts();
      p.add(lathe([
        [R * 0.28, 0.00], [R * 0.42, 0.06], [R * 0.66, 0.18], [R * 0.86, 0.34],
        [R * 0.98, 0.50], [R * 1.04, 0.62], [R * 1.00, 0.68], [R * 0.86, 0.62],
        [R * 0.80, 0.46], [R * 0.72, 0.28],
      ].map(([r, y]) => [r, y * H * 0.55 + H * 0.80]), 22));
      return p.merge();
    });
    g.add(this._mesh(bowlGeo, metal, 'brazier.bowl'));

    // egg-and-dart round the bowl rim: this is the edge the key catches (§9.5)
    const rimY = H * 0.80 + 0.62 * H * 0.55;
    const ed = this.geo(`ed:${(R * 0.20).toFixed(3)}`, () => eggAndDartUnit(R * 0.20));
    const nEd = 14;
    for (let i = 0; i < nEd; i++) {
      const a = (i / nEd) * TAU;
      const m = this._mesh(ed, this.mat('leaf'), 'brazier.rim', true, false);
      m.position.set(Math.cos(a) * R * 1.06, rimY - R * 0.10, Math.sin(a) * R * 1.06);
      m.rotation.set(0, -a + Math.PI / 2, 0);
      g.add(m);
    }

    const coalGeo = this.geo(key + ':coals', () => {
      const p = new Parts();
      const f = this.f;
      for (let i = 0; i < 7; i++) {
        const a = f() * TAU, rr = f() * R * 0.62;
        const c = new THREE.IcosahedronGeometry(R * (0.16 + f() * 0.14), 0);
        p.add(c, { p: [Math.cos(a) * rr, f() * R * 0.10, Math.sin(a) * rr], r: [f() * 3, f() * 3, f() * 3] });
      }
      return faceted(p.merge());
    });
    const coals = this._mesh(coalGeo, ember, 'brazier.coals', false, false);
    coals.position.y = rimY - R * 0.22;
    g.add(coals);

    if (opts.plinth) {
      const pg = this.geo(key + ':plinth', () => {
        const p = new Parts();
        p.box(R * 2.0, 0.30, R * 2.0, [0, 0.15, 0]);
        p.box(R * 2.3, 0.10, R * 2.3, [0, 0.05, 0]);
        return faceted(p.merge());
      });
      const pl = this._mesh(pg, stone, 'brazier.plinth');
      g.add(pl);
      g.children.forEach((c) => { if (c !== pl) c.position.y += 0.28; });
    }
    g.userData.flame = new THREE.Vector3(0, rimY + (opts.plinth ? 0.28 : 0) - R * 0.08, 0);
    g.userData.radius = R * 1.1;
    g.userData.height = H;
    return g;
  }

  /** A wall sconce: a bracket, a shallow bowl and a backplate palmette. */
  sconce(opts = {}) {
    const R = opts.r ?? 0.34;
    const g = new THREE.Group();
    g.name = 'sconce';
    const metal = this.mat('metal');
    const geo = this.geo(`sconce:${R.toFixed(2)}`, () => {
      const p = new Parts();
      // backplate: a palmette
      p.add(lathe([[R * 0.30, 0], [R * 0.70, R * 0.4], [R * 0.55, R * 0.9], [R * 0.15, R * 1.2]], 12,
        { phiStart: 0, phiLength: Math.PI }), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0], s: [1, 0.32, 1] });
      // bracket arm
      p.add(taperedTube([
        new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -R * 0.20, R * 0.40),
        new THREE.Vector3(0, R * 0.10, R * 0.76), new THREE.Vector3(0, R * 0.34, R * 0.82),
      ], [R * 0.13, R * 0.10, R * 0.09, R * 0.11], 6));
      // bowl
      p.add(lathe([[R * 0.16, 0], [R * 0.50, R * 0.18], [R * 0.72, R * 0.38], [R * 0.66, R * 0.42]], 16),
        { p: [0, R * 0.34, R * 0.82] });
      return p.merge();
    });
    g.add(this._mesh(geo, metal, 'sconce'));
    g.userData.flame = new THREE.Vector3(0, R * 0.72, R * 0.82);
    return g;
  }

  /** A censer hanging on three chains from a ceiling / cornice anchor. */
  censer(opts = {}) {
    const drop = opts.drop ?? 3.0;
    const R = opts.r ?? 0.44;
    const g = new THREE.Group();
    g.name = 'censer';
    const metal = this.mat('metal');
    const geo = this.geo(`censer:${R.toFixed(2)}:${drop.toFixed(2)}`, () => {
      const p = new Parts();
      // bowl with a pierced lid
      p.add(lathe([
        [R * 0.20, 0], [R * 0.60, R * 0.20], [R * 0.92, R * 0.46], [R * 1.00, R * 0.66], [R * 0.94, R * 0.72],
      ], 18));
      p.add(lathe([
        [R * 0.94, R * 0.72], [R * 0.80, R * 0.92], [R * 0.50, R * 1.10], [R * 0.20, R * 1.20],
        [R * 0.14, R * 1.32], [R * 0.22, R * 1.40], [R * 0.08, R * 1.52],
      ], 18));
      // ---- SUSPENSION -----------------------------------------------------
      // A CONTINUOUS ROD, not a row of separate torus links. Nine links strung
      // over a 7m drop put one 10cm bead every 80cm, and the shipped frames
      // carried three perfectly straight, evenly spaced DOTTED LINES across the
      // composition — the single most eye-catching thing in four of ten review
      // frames, and read (correctly) as a debug path or a broken emitter.
      // A chain at play distance is a LINE. It is drawn as one: a tapered tube
      // sampled every ~14cm whose radius alternates, so the beading is a
      // modulation of a continuous silhouette instead of a gap in it.
      const NL = Math.max(6, Math.round(drop / 0.14));
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        const links = catenary(
          new THREE.Vector3(Math.cos(a) * R * 0.94, R * 0.72, Math.sin(a) * R * 0.72),
          new THREE.Vector3(0, drop, 0), 0.10, NL);
        const rad = links.map((_, k) => R * (k % 2 ? 0.052 : 0.030));
        p.add(taperedTube(links, rad, 5));
      }
      p.add(new THREE.TorusGeometry(R * 0.16, R * 0.045, 6, 14), { p: [0, drop, 0], r: [Math.PI / 2, 0, 0] });
      return p.merge();
    });
    g.add(this._mesh(geo, metal, 'censer'));
    g.userData.flame = new THREE.Vector3(0, R * 0.5, 0);
    return g;
  }

  /** A hanging chain — for the arena rim falling into the void. */
  chain(opts = {}) {
    const from = opts.from || new THREE.Vector3(0, 0, 0);
    const to = opts.to || new THREE.Vector3(0, -6, 0);
    const sag = opts.sag ?? 0.4;
    const lr = opts.linkR ?? 0.10;
    const n = opts.links ?? 16;
    // A CONTINUOUS ROD. See censer() — a chain drawn as discrete links at any
    // real drop length ships as a dotted line across the composition.
    const seg = Math.max(8, Math.round(from.distanceTo(to) / (lr * 1.6)));
    const pts = catenary(from, to, sag, seg);
    const rad = pts.map((_, i) => lr * (i % 2 ? 0.46 : 0.26));
    const g = new THREE.Group();
    g.name = 'chain';
    // cast:false — a link is smaller than a shadow texel at chamber scale and
    // resolves as a hard aliased staircase on whatever it falls across.
    g.add(this._mesh(taperedTube(pts, rad, 5), this.mat('iron'), 'chain', false, false));
    return g;
  }

  // =========================================================================
  // BANNER
  // =========================================================================
  /**
   * kit.banner({ w, h, sag, wave }) — cloth with a real catenary top edge, a
   * travelling wave through the drop and a swallow-tailed hem. A flat quad
   * reads as a poster; the sag and the hem cut are what make it cloth.
   */
  banner(opts = {}) {
    const w = opts.w ?? 1.9, h = opts.h ?? 5.2;
    const sag = opts.sag ?? 0.20, wave = opts.wave ?? 0.16;
    const g = new THREE.Group();
    g.name = 'banner';
    // a separately-cached double-sided variant — never mutate `side` on the
    // library's shared instance, that would flip every crimson surface in the game
    const cloth = this.mat('cloth', { side: THREE.DoubleSide });
    const metal = this.mat('metal');
    const seed = opts.seed ?? this.f();
    const geo = this.own(clothGeo(w, h, sag, wave, seed));
    const m = this._mesh(geo, cloth, 'banner.cloth');
    g.add(m);
    // rod with finials
    const rod = this.geo(`bannerrod:${w.toFixed(2)}`, () => {
      const p = new Parts();
      p.add(new THREE.CylinderGeometry(0.055, 0.055, w * 1.34, 8), { p: [0, 0, 0], r: [0, 0, Math.PI / 2] });
      for (const s of [-1, 1]) {
        p.add(lathe([[0.05, 0], [0.13, 0.06], [0.10, 0.14], [0.14, 0.20], [0.05, 0.30]], 10),
          { p: [s * w * 0.67, 0, 0], r: [0, 0, -s * Math.PI / 2] });
      }
      return p.merge();
    });
    const r = this._mesh(rod, metal, 'banner.rod');
    r.position.y = 0.06;
    g.add(r);
    // tassels at the hem corners
    const tas = this.geo('tassel', () => {
      const p = new Parts();
      p.add(lathe([[0.02, 0], [0.07, 0.06], [0.06, 0.12], [0.09, 0.16], [0.02, 0.34]], 8), { p: [0, -0.34, 0], r: [Math.PI, 0, 0] });
      return p.merge();
    });
    for (const s of [-1, 1]) {
      const t = this._mesh(tas, metal, 'banner.tassel', true, false);
      t.position.set(s * w * 0.5, -h + 0.1, 0);
      g.add(t);
    }
    return g;
  }

  // =========================================================================
  // PARAPET / BALUSTRADE
  // =========================================================================
  /**
   * kit.parapet({ arc:{r,a0,a1} | points, h, mat })
   * Coping rail on lathed balusters with posts — the arena rim's lit top edge,
   * and the thing that turns a floating plate into an architectural terrace.
   */
  parapet(opts = {}) {
    const H = opts.h ?? 1.15;
    const g = new THREE.Group();
    g.name = 'parapet';
    const stone = this.mat('wall');
    const trim = this.mat('leaf');
    const bal = this.geo(`baluster:${H.toFixed(2)}`, () => lathe([
      [0.19, 0.00], [0.21, 0.05], [0.15, 0.10], [0.13, 0.16],
      [0.20, 0.26], [0.24, 0.38], [0.21, 0.50], [0.14, 0.60],
      [0.10, 0.68], [0.14, 0.76], [0.13, 0.84], [0.17, 0.92], [0.16, 1.00],
    ].map(([r, y]) => [r * H * 0.62, y * H * 0.78 + H * 0.11]), 14));
    const postGeo = this.geo(`ppost:${H.toFixed(2)}`, () => {
      const p = new Parts();
      p.box(H * 0.46, H, H * 0.46, [0, H * 0.5, 0]);
      p.box(H * 0.58, H * 0.10, H * 0.58, [0, H * 0.05, 0]);
      p.box(H * 0.56, H * 0.09, H * 0.56, [0, H * 0.96, 0]);
      p.add(lathe([[H * 0.16, 0], [H * 0.20, H * 0.08], [H * 0.10, H * 0.18], [H * 0.04, H * 0.24]], 10), { p: [0, H * 1.0, 0] });
      return faceted(p.merge());
    });

    const place = (x, z, rot) => {
      const m = this._mesh(bal, stone, 'parapet.baluster');
      m.position.set(x, 0, z); m.rotation.y = rot;
      g.add(m);
    };

    if (opts.arc) {
      const { r, a0, a1 } = opts.arc;
      const pitch = opts.pitch ?? H * 0.52;
      const n = Math.max(2, Math.round(Math.abs(a1 - a0) * r / pitch));
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5) / n);
        place(Math.cos(a) * r, Math.sin(a) * r, -a);
      }
      // base plinth + coping as arc chords
      const seg = 1.2;
      const ns = Math.max(2, Math.round(Math.abs(a1 - a0) * r / seg));
      const step = (a1 - a0) / ns;
      const chord = 2 * r * Math.abs(Math.sin(step * 0.5)) * 1.04;
      const railGeo = this.geo(`prail:${H.toFixed(2)}:${chord.toFixed(2)}`, () => {
        const p = new Parts();
        p.box(chord, H * 0.16, H * 0.72, [0, H * 0.08, 0]);
        p.box(chord, H * 0.06, H * 0.82, [0, H * 0.18, 0]);
        return faceted(p.merge());
      });
      const copGeo = this.geo(`pcop:${H.toFixed(2)}:${chord.toFixed(2)}`, () => {
        const p = new Parts();
        p.box(chord, H * 0.13, H * 0.86, [0, 0, 0]);
        p.box(chord, H * 0.05, H * 0.96, [0, -H * 0.085, 0]);
        return faceted(p.merge());
      });
      for (let i = 0; i < ns; i++) {
        const a = a0 + step * (i + 0.5);
        const rm = this._mesh(railGeo, stone, 'parapet.base');
        rm.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        rm.rotation.y = -a + Math.PI / 2;
        g.add(rm);
        const cm = this._mesh(copGeo, stone, 'parapet.coping');
        cm.position.set(Math.cos(a) * r, H * 0.92, Math.sin(a) * r);
        cm.rotation.y = -a + Math.PI / 2;
        g.add(cm);
      }
      if (opts.posts !== false) {
        const np = opts.postCount ?? Math.max(2, Math.round(Math.abs(a1 - a0) / (18 * DEG)));
        for (let i = 0; i <= np; i++) {
          const a = a0 + (a1 - a0) * (i / np);
          const m = this._mesh(postGeo, stone, 'parapet.post');
          m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
          m.rotation.y = -a;
          g.add(m);
        }
      }
    } else {
      const pts = opts.points || [new THREE.Vector3(-4, 0, 0), new THREE.Vector3(4, 0, 0)];
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const d = new THREE.Vector3().subVectors(b, a);
        const L = d.length(), rot = Math.atan2(d.x, d.z);
        const n = Math.max(1, Math.round(L / (H * 0.52)));
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) / n;
          place(a.x + d.x * t, a.z + d.z * t, rot);
        }
        const railGeo = this.geo(`prailL:${H.toFixed(2)}:${L.toFixed(2)}`, () => {
          const p = new Parts();
          p.box(L, H * 0.16, H * 0.72, [0, H * 0.08, 0]);
          p.box(L, H * 0.06, H * 0.82, [0, H * 0.18, 0]);
          p.box(L, H * 0.13, H * 0.86, [0, H * 0.92, 0]);
          p.box(L, H * 0.05, H * 0.96, [0, H * 0.835, 0]);
          return faceted(p.merge());
        });
        const rm = this._mesh(railGeo, stone, 'parapet.rail');
        rm.position.set((a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5);
        rm.rotation.y = rot - Math.PI / 2;
        g.add(rm);
      }
      for (const pt of pts) {
        const m = this._mesh(postGeo, stone, 'parapet.post');
        m.position.copy(pt);
        g.add(m);
      }
    }
    if (opts.trimBand) {
      const m = this.meanderBand({ h: H * 0.24, arc: opts.arc, depth: 0.20, mat: trim });
      m.position.y = H * 0.45;
      g.add(m);
    }
    g.userData.height = H;
    return g;
  }

  // =========================================================================
  // RUBBLE / DEBRIS / BONES / URNS
  // =========================================================================
  /** kit.rubble({kind, seed}) -> geometry-bearing Object3D (single mesh). */
  rubble(opts = {}) {
    const kind = opts.kind || 'chunk';
    const seed = opts.seed ?? 0;
    const key = `rubble:${kind}:${seed}`;
    const geo = this.geo(key, () => {
      const f = this.f;
      switch (kind) {
        case 'drum': return columnDrumGeo(f, opts);
        case 'slab': return slabGeo(f, opts);
        case 'urn': return amphoraGeo(f);
        case 'bones': return bonePileGeo(f);
        case 'capital': return brokenCapitalGeo(f, this);
        default: return rubbleChunkGeo(f, opts);
      }
    });
    const matRole = kind === 'bones' ? 'bone' : (opts.mat || 'rubble');
    const m = this._mesh(geo, this.mat(matRole), 'rubble.' + kind);
    return m;
  }

  /** Convenience: geometry only, for the chamber's own instancers. */
  rubbleGeo(kind, seed, opts = {}) { return this.rubble({ kind, seed, ...opts }).geometry; }

  /**
   * kit.instancer(geometry, material, count) — a thin InstancedMesh wrapper so
   * 200 rubble chunks cost one draw call and the caller never touches matrices.
   */
  instancer(geometry, material, count, opts = {}) {
    if (material && material.vertexColors) ensureColor(geometry);
    const im = new THREE.InstancedMesh(geometry, material, count);
    im.name = opts.name || 'instanced';
    im.castShadow = opts.cast !== false;
    im.receiveShadow = opts.recv !== false;
    im.count = 0;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
    im.userData.push = (x, y, z, ry = 0, scale = 1, rx = 0, rz = 0) => {
      if (im.count >= count) return false;
      e.set(rx, ry, rz);
      q.setFromEuler(e);
      v.set(x, y, z);
      if (typeof scale === 'number') s.set(scale, scale, scale); else s.set(scale[0], scale[1], scale[2]);
      im.setMatrixAt(im.count++, m.compose(v, q, s));
      im.instanceMatrix.needsUpdate = true;
      return true;
    };
    im.userData.pushMatrix = (mat) => {
      if (im.count >= count) return false;
      im.setMatrixAt(im.count++, mat);
      im.instanceMatrix.needsUpdate = true;
      return true;
    };
    im.userData.finish = () => { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); return im; };
    return im;
  }
}

// ===========================================================================
// 5. FREE GEOMETRY FACTORIES (used by the Kit and by props.js)
// ===========================================================================

/** Radial fold modulation — turns a lathe into cloth or drapery. */
// NOTE FOR CALLERS: a fold needs at least ~4 lathe segments to survive. The
// mourner's robe was folded 15 times across a 30-segment lathe — 2 segments per
// fold — so the modulation aliased away completely and the garment shipped as a
// smooth cone. Match `seg >= folds * 4` or the folds are not there.
export function foldify(geo, folds = 10, amp = 0.05, taper = 0.6) {
  const pos = geo.attributes.position, v = new THREE.Vector3();
  geo.computeBoundingBox();
  const y0 = geo.boundingBox.min.y, y1 = geo.boundingBox.max.y, dy = Math.max(1e-4, y1 - y0);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rad = Math.hypot(v.x, v.z);
    if (rad < 1e-4) continue;
    const a = Math.atan2(v.z, v.x);
    const t = (v.y - y0) / dy;
    const k = 1 + (amp * Math.cos(a * folds) * (1 - taper * t)) / Math.max(0.06, rad) * rad;
    v.x *= k; v.z *= k;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Cloth surface with catenary sag, a travelling wave and a swallow-tail hem. */
export function clothGeo(w, h, sag, wave, seed = 0) {
  const NU = 13, NV = 20;
  const P = [], U = [], idx = [];
  for (let j = 0; j < NV; j++) {
    const tv = j / (NV - 1);
    for (let i = 0; i < NU; i++) {
      const tu = i / (NU - 1);
      const x = (tu - 0.5) * w;
      // hem: a swallow tail, deepest at the edges
      const hemCut = Math.pow(Math.abs(tu - 0.5) * 2, 1.6) * h * 0.16;
      const y = -tv * (h - hemCut) - Math.sin(Math.PI * tu) * sag * (1 - tv * 0.55);
      // the wave grows down the drop and shifts phase with height
      const z = Math.sin(tu * Math.PI * 2.2 + seed * 6.0 + tv * 2.1) * wave * (0.25 + tv)
        + Math.sin(tu * Math.PI * 4.7 + seed * 3.1) * wave * 0.35 * tv;
      P.push(x, y, z);
      U.push(tu, 1 - tv);
    }
  }
  for (let j = 0; j < NV - 1; j++) for (let i = 0; i < NU - 1; i++) {
    const a = j * NU + i;
    idx.push(a, a + NU, a + 1, a + 1, a + NU, a + NU + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** A toppled fluted column drum with a fracture face and a chipped rim. */
export function columnDrumGeo(f, o = {}) {
  const R = o.r ?? 0.55, H = o.h ?? 1.2, FL = o.flutes ?? 10, DEPTH = o.depth ?? 0.115;
  const g = new THREE.CylinderGeometry(R, R, H, FL * 2, 5, false);
  const pos = g.attributes.position, v = new THREE.Vector3();
  const tilt = 0.17 + f() * 0.16, tiltA = f() * TAU;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rad = Math.hypot(v.x, v.z);
    if (rad > 1e-4) {
      const a = Math.atan2(v.z, v.x);
      const band = 1 - Math.pow(Math.abs(v.y) / (H * 0.5), 3.0);
      const flute = (0.5 - 0.5 * Math.cos(a * FL)) * DEPTH * band;
      const rim = 1 - 0.28 * Math.pow(Math.abs(v.y) / (H * 0.5), 6.0);
      const k = ((rad - flute) * rim) / rad;
      v.x *= k; v.z *= k;
      if (v.y > H * 0.42) {
        const chip = Math.sin(a * 5 + tiltA * 2) * Math.sin(a * 3 - tiltA);
        v.y -= Math.max(0, chip) * 0.11;
      }
    }
    const cut = H * 0.5 - tilt * (Math.cos(tiltA) * v.x + Math.sin(tiltA) * v.z);
    if (v.y > cut) v.y = cut;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.rotateZ(Math.PI / 2);
  g.rotateX(f() * 0.25 - 0.125);
  g.computeBoundingBox();
  return g;
}

/** Broken masonry: a chipped block with a flat bed and a sheared corner. */
export function rubbleChunkGeo(f, o = {}) {
  const g = new THREE.BoxGeometry(o.w ?? 0.66, o.h ?? 0.42, o.d ?? 0.54, 2, 2, 2).toNonIndexed();
  const pos = g.attributes.position, v = new THREE.Vector3();
  const n1 = f() * 6.28, n2 = f() * 6.28, n3 = f() * 6.28;
  const minY = -(o.h ?? 0.42) * 0.5;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = Math.sin(v.x * 7 + n1) * Math.sin(v.y * 6 + n2) * Math.sin(v.z * 8 + n3);
    v.x += d * 0.09; v.z += d * 0.08;
    v.y += Math.sin(v.x * 9 + n3) * 0.05;
    const sh = v.x * 0.8 + v.z * 0.6 + v.y * 0.5;
    if (sh > 0.42) { v.x -= (sh - 0.42) * 0.5; v.z -= (sh - 0.42) * 0.4; }
    if (v.y < minY + 0.02) v.y = minY;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** A cracked paving slab, tipped and half-sunk. */
export function slabGeo(f, o = {}) {
  const w = o.w ?? 1.5, d = o.d ?? 1.15, t = o.t ?? 0.22;
  const g = new THREE.BoxGeometry(w, t, d, 3, 1, 3).toNonIndexed();
  const pos = g.attributes.position, v = new THREE.Vector3();
  const n1 = f() * 6.28, n2 = f() * 6.28;
  const cutA = f() * TAU, cutD = (f() - 0.5) * w * 0.35;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // fracture: shear everything past a chord line off the slab
    const s = Math.cos(cutA) * v.x + Math.sin(cutA) * v.z - cutD;
    if (s > 0) { v.x -= Math.cos(cutA) * s * 0.9; v.z -= Math.sin(cutA) * s * 0.9; }
    v.y += Math.sin(v.x * 5 + n1) * Math.sin(v.z * 4 + n2) * t * 0.22;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** A cracked amphora — neck, shoulder, two handles: a NON-convex silhouette. */
export function amphoraGeo(f) {
  const H = 1.32;
  const prof = [];
  for (const [r, t] of [
    [0.02, 0.00], [0.13, 0.02], [0.17, 0.06], [0.26, 0.18], [0.33, 0.34],
    [0.35, 0.48], [0.32, 0.62], [0.24, 0.74], [0.15, 0.82], [0.126, 0.90],
    [0.14, 0.965], [0.185, 1.00]]) prof.push([Math.max(0.012, r * (1 + (f() - 0.5) * 0.05)), t * H]);
  const parts = [lathe(prof, 22)];
  for (const sgn of [-1, 1]) {
    const h = new THREE.TorusGeometry(0.135, 0.072, 7, 14, Math.PI * 1.15);
    h.rotateY(Math.PI / 2); h.rotateZ(-Math.PI * 0.12);
    h.translate(sgn * 0.20, H * 0.80, 0);
    if (sgn < 0) h.scale(-1, 1, 1);
    parts.push(h);
  }
  const g = mergeGeos(parts);
  g.rotateX(Math.PI * 0.46 + f() * 0.1);
  g.rotateY(f() * 0.6);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** A pile of bones: femurs, ribs and a skull. Reads instantly in silhouette. */
export function bonePileGeo(f) {
  const p = new Parts();
  for (let i = 0; i < 5; i++) {
    const L = 0.42 + f() * 0.34;
    const shaft = new THREE.CylinderGeometry(0.036, 0.032, L, 6);
    const a = f() * TAU, tilt = (f() - 0.5) * 0.8;
    const x = (f() - 0.5) * 0.55, z = (f() - 0.5) * 0.55, y = 0.045 + f() * 0.12;
    p.add(shaft, { p: [x, y, z], r: [Math.PI / 2 + tilt * 0.4, a, tilt] });
    for (const s of [-1, 1]) {
      const knob = new THREE.SphereGeometry(0.058, 7, 5);
      knob.scale(1, 0.8, 1.25);
      p.add(knob, {
        p: [x + Math.cos(a) * L * 0.5 * s, y + tilt * L * 0.3 * s, z + Math.sin(a) * L * 0.5 * s],
        r: [0, -a, 0],
      });
    }
  }
  for (let i = 0; i < 3; i++) {
    const rib = new THREE.TorusGeometry(0.22 + f() * 0.08, 0.022, 5, 10, Math.PI * 0.9);
    p.add(rib, { p: [(f() - 0.5) * 0.5, 0.06 + f() * 0.05, (f() - 0.5) * 0.5], r: [Math.PI / 2 + (f() - 0.5) * 0.5, f() * TAU, 0] });
  }
  // skull
  const sk = new THREE.SphereGeometry(0.145, 11, 8);
  sk.scale(1.0, 0.92, 1.12);
  const sx = (f() - 0.5) * 0.3, sz = (f() - 0.5) * 0.3;
  p.add(sk, { p: [sx, 0.16, sz] });
  const jaw = new THREE.SphereGeometry(0.10, 8, 6);
  jaw.scale(1.05, 0.55, 1.1);
  p.add(jaw, { p: [sx + 0.06, 0.075, sz + 0.10] });
  for (const s of [-1, 1]) {
    const socket = new THREE.SphereGeometry(0.048, 7, 5);
    p.add(socket, { p: [sx + 0.08, 0.185, sz + s * 0.062] });
  }
  const g = p.merge();
  g.computeBoundingBox();
  return g;
}

/** A broken capital lying on its side — carved detail at ground level. */
export function brokenCapitalGeo(f, kit) {
  const R = 0.52;
  const p = new Parts();
  p.add(lathe([[R * 0.84, 0], [R * 1.02, R * 0.34], [R * 1.24, R * 0.72], [R * 1.30, R * 0.95]], 16));
  p.add(faceted(new THREE.BoxGeometry(R * 2.7, R * 0.32, R * 2.7)), { p: [0, R * 1.12, 0] });
  const leaf = acanthusLeaf({ len: R * 0.9, width: R * 0.5, curl: 0.42, thick: R * 0.05 });
  for (let i = 0; i < 5; i++) {
    const a = (i / 8) * TAU;
    const l = leaf.clone();
    p.add(l, { p: [Math.cos(a) * R * 0.86, R * 0.06, Math.sin(a) * R * 0.86], r: [-0.32, -a + Math.PI / 2, 0] });
  }
  leaf.dispose();
  const g = p.merge();
  g.rotateZ(Math.PI * (0.42 + f() * 0.2));
  g.rotateY(f() * TAU);
  g.computeBoundingBox();
  // reseat on the ground
  const min = g.boundingBox.min.y;
  g.translate(0, -min, 0);
  g.computeBoundingBox();
  return g;
}

export default Kit;
