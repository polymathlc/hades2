// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// props.js — the roster's PROP LIBRARY: every held and worn object that is not
// part of the skinned body (greatswords, staves, labrys, bident, scythe,
// horns, lances, wings, halos) is built from the vocabulary here.
//
// WHY THIS FILE EXISTS. Every family used to author its own props inline out
// of raw THREE primitives — the warden's greatsword was a BoxGeometry with a
// four-sided cone on the end, the minotaur's labrys two ConeGeometry(…, 4)
// pyramids, the hexer's staff a bare CylinderGeometry — and §7 names
// "untextured programmer-art boxes/cylinders" as an auto-fail. A box blade
// shows the camera one face and one value; a real blade is a DIAMOND section
// with two ground edges and a ridge, so the key rolls across it. The same
// argument holds for every horn (growth rings, not a smooth cone), every
// shaft (ferrules, a wrapped grip) and every ring (a chamfered band with a lit
// arris, not a torus sausage).
//
// The primitives are the ones rig.js already proved on the hero — tubeGeo with
// a superellipse section — so a boss's sword and the player's are made of the
// same language and read as one game.
//
// DRAW CALLS. A prop is bucketed by material SLOT exactly as rig.js and
// player-weapons.js do: every part is tinted per-vertex and merged, so a
// greatsword is three meshes (steel, gold, grip) no matter how many pieces it
// was authored from.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tubeGeo, linRGB } from '../rig.js';
import { charMaterial } from './base.js';
import { TAU, clamp01, lerp } from '../../core/math.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ── sections ────────────────────────────────────────────────────────────────
/** superellipse radius multiplier for tubeGeo's `shape` hook (see rig.js) */
export function superellipse(n) {
  return (th) => {
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
  };
}
/** a ground blade: two edges on the N axis, a ridge on the B axis */
export const DIAMOND = superellipse(1.25);
/** a struck plate: flat faces, tight corners */
export const PLATE = superellipse(5);
/** a fullered blade: the diamond with a groove down each flat */
export function fullered(depth = 0.30) {
  const D = DIAMOND;
  return (th) => {
    const s = Math.abs(Math.sin(th));
    const g = Math.exp(-Math.pow((1 - s) / 0.16, 2));
    return D(th) * (1 - depth * g);
  };
}

// ── paint ───────────────────────────────────────────────────────────────────
/**
 * tint(geo, hex | fn(x,y,z,u,v) -> hex, { y0, y1, aoLow, down })
 * Per-vertex linear colour with a vertical AO ramp (y0..y1) and a darkened
 * underside (`down` on faces whose normal points at the floor). This is the
 * hand AO §4 asks for, at the only resolution a merged prop can carry it.
 */
export function tint(geo, fn, o = {}) {
  const pos = geo.getAttribute('position'), uvA = geo.getAttribute('uv'), nrm = geo.getAttribute('normal');
  const n = pos.count, col = new Float32Array(n * 3), cache = new Map();
  const look = (h) => { let c = cache.get(h); if (!c) { c = linRGB(h); cache.set(h, c); } return c; };
  const isFn = typeof fn === 'function';
  const y0 = o.y0, y1 = o.y1, aoLow = o.aoLow ?? 0.55, down = o.down ?? 0.30;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const c = look(isFn ? fn(x, y, z, uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0) : fn);
    let ao = 1;
    if (y0 != null && y1 != null) { const t = clamp01((y - y0) / (y1 - y0 || 1)); ao = lerp(aoLow, 1, t * t * (3 - 2 * t)); }
    if (nrm) ao *= 1 - down * Math.max(0, -nrm.getY(i));
    col[i * 3] = c[0] * ao; col[i * 3 + 1] = c[1] * ao; col[i * 3 + 2] = c[2] * ao;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!uvA) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

/** the blade tint: `edge` on the two ground edges, `steel` on the faces */
export const edged = (steel, edge, ridge) => (x, y, z, u) =>
  ((u < 0.06 || u > 0.94 || (u > 0.44 && u < 0.56)) ? edge : (ridge && (Math.abs(u - 0.25) < 0.04 || Math.abs(u - 0.75) < 0.04) ? ridge : steel));
/** a chamfered band's tint: `hot` on both arrises, `face` between, `deep` underneath */
export const chamfered = (hot, face, deep) => (x, y, z, u) =>
  ((u > 0.205 && u < 0.295) || (u > 0.705 && u < 0.795)) ? hot : ((u < 0.12 || u > 0.88) ? deep : face);
/** a wrapped grip: alternating dark bands along the length */
export const wrapped = (a, b, n = 6) => (x, y, z, u, v) => ((Math.floor(v * n) % 2) ? a : b);

// ── assembly ────────────────────────────────────────────────────────────────
/** Merge a list of tinted geometries into one (normalising indexing). */
export function merge(list) {
  const src = list.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of src) { if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2)); }
  const out = mergeGeometries(src, false);
  for (let i = 0; i < src.length; i++) if (src[i] !== list[i]) src[i].dispose();
  return out;
}

/** A shaded mesh through the roster's painterly character material. */
export function mesh(ctx, geo, slot, tag, opts) {
  const m = new THREE.Mesh(geo, charMaterial(ctx, slot, tag, opts));
  m.castShadow = true;
  m.frustumCulled = false;
  return m;
}

/** transform a geometry in place: pos [x,y,z], rot [rx,ry,rz] (radians), scale */
export function xf(geo, o = {}) {
  const m = new THREE.Matrix4();
  const s = o.s == null ? 1 : o.s;
  m.compose(V(...(o.p || [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.r || [0, 0, 0]))),
    typeof s === 'number' ? V(s, s, s) : V(...s));
  geo.applyMatrix4(m);
  return geo;
}

// ── vocabulary ──────────────────────────────────────────────────────────────
/** a straight shaft up +y from y0 to y1, slightly tapered */
export function shaft({ y0, y1, r0, r1 = r0, radial = 9, shape } = {}) {
  return tubeGeo([{ p: [0, y0, 0], r: r0 }, { p: [0, y1, 0], r: r1 }],
    { radial, capStart: 'flat', capEnd: 'flat', shape });
}

/** a horizontal chamfered ring (ferrule, collar, circlet) around +y at height y */
export function ring({ y, R, th = 0.008, hh = 0.02, seg = 20, radial = 8, a0 = 0, a1 = 360, cx = 0, cz = 0, ez = 1 } = {}) {
  const spine = [];
  for (let i = 0; i < seg; i++) {
    const t = seg > 1 ? i / (seg - 1) : 0, a = lerp(a0, a1, t) * Math.PI / 180;
    spine.push({ p: [cx + R * Math.sin(a), y, cz + R * Math.cos(a) * ez], r: 1, sx: th, sz: hh });
  }
  const full = Math.abs(a1 - a0) >= 359.9;
  return tubeGeo(spine, { radial, up: [0, 1, 0], capStart: full ? 'flat' : 'round', capEnd: full ? 'flat' : 'round', shape: PLATE });
}

/**
 * A BLADE. Diamond (or fullered) section swept along a spine.
 *   len, w (half width), th (half thickness)
 *   profile 'leaf' | 'straight' | 'kopis' | 'scimitar'
 *   base [x,y,z], dir [x,y,z] (unit-ish), across [x,y,z] — the edge axis
 *   curve: lateral bow of the spine as a fraction of len (kopis/scimitar)
 */
export function blade({ len, w, th, profile = 'leaf', base = [0, 0, 0], dir = [0, 1, 0], across = [1, 0, 0], curve = 0, fuller = 0, stations = 10, radial = 10, tip = 0.3 } = {}) {
  const d = V(...dir).normalize();
  const ac = V(...across); ac.addScaledVector(d, -ac.dot(d)).normalize();
  const up = new THREE.Vector3().crossVectors(d, ac);
  const b = V(...base);
  const spine = [];
  for (let i = 0; i < stations; i++) {
    const u = i / (stations - 1);
    let hw;
    if (profile === 'leaf') hw = w * (0.50 + 0.50 * Math.sin(Math.PI * Math.pow(u, 0.82))) * (1 - Math.pow(u, 3.6)) + 0.004;
    else if (profile === 'kopis') hw = w * (0.62 + 0.62 * Math.sin(Math.PI * Math.pow(u, 1.4))) * (1 - Math.pow(u, 5)) + 0.004;
    else if (profile === 'scimitar') hw = w * (0.85 + 0.35 * Math.sin(Math.PI * Math.pow(u, 1.2))) * (1 - Math.pow(u, 6)) + 0.004;
    else hw = w * (1 - 0.30 * u) * (1 - Math.pow(u, 9)) + 0.004;
    const ht = th * (1 - u * 0.72) + 0.0015;
    const p = b.clone().addScaledVector(d, len * u).addScaledVector(ac, curve * len * Math.sin(Math.PI * u) * (profile === 'kopis' ? Math.pow(u, 1.3) / Math.max(1e-3, Math.sin(Math.PI * u)) : 1));
    spine.push({ p: [p.x, p.y, p.z], r: hw, sx: 1, sz: ht / hw });
  }
  return tubeGeo(spine, {
    radial, capStart: 'flat', capEnd: 'round', capScale: tip, up: [up.x, up.y, up.z],
    shape: fuller > 0 ? fullered(fuller) : DIAMOND,
  });
}

/** a hexagonal cross-bar along x at height y; `curl` drops the quillon ends */
export function crossguard({ y, w, r = 0.02, z = 0, curl = 0, radial = 6 } = {}) {
  const hw = w * 0.5;
  return tubeGeo([
    { p: [-hw, y - curl, z], r: r * 0.78, sx: 0.7, sz: 1.35 },
    { p: [-hw * 0.82, y - curl * 0.35, z], r: r, sx: 0.72, sz: 1.5 },
    { p: [hw * 0.82, y - curl * 0.35, z], r: r, sx: 0.72, sz: 1.5 },
    { p: [hw, y - curl, z], r: r * 0.78, sx: 0.7, sz: 1.35 },
  ], { radial, capStart: 'round', capEnd: 'round', up: [0, 1, 0] });
}

/** an octahedral pommel / gem */
export function gem(r, p = [0, 0, 0], s = [1, 1, 1]) {
  return xf(new THREE.OctahedronGeometry(r, 0), { p, s });
}

/**
 * A HORN: a tapered tube along a curve with growth ripples down its length.
 *   from, ctrl, to: Vector3 control points (quadratic bezier)
 *   r0 root radius; ripples: count of rings
 */
export function horn({ from, ctrl, to, r0, ripples = 12, n = 12, radial = 9, flat = 1 } = {}) {
  const spine = [];
  const a = V(...from), c = V(...ctrl), b = V(...to);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), mt = 1 - t;
    const p = a.clone().multiplyScalar(mt * mt).addScaledVector(c, 2 * mt * t).addScaledVector(b, t * t);
    const rr = r0 * (1 - t) * (1 - 0.25 * t) + 0.004;
    spine.push({ p: [p.x, p.y, p.z], r: rr, sx: 1, sz: flat });
  }
  return tubeGeo(spine, {
    radial, capStart: 'flat', capEnd: 'round', capScale: 0.6,
    shape: (th, t) => 1 + 0.07 * Math.sin(t * Math.PI * ripples) * (1 - t * 0.6),
  });
}

/**
 * An AXE HEAD: a crescent plate with a bevelled edge, extruded in z.
 *   R outer radius of the edge arc, span (radians) of the arc, depth (z), inner
 *   radius rIn where it meets the haft. Returns geometry centred on the haft.
 */
export function axeHead({ R = 0.55, span = 1.6, depth = 0.045, rIn = 0.14, side = 1, y = 0 } = {}) {
  const s = new THREE.Shape();
  const N = 14;
  const a0 = -span * 0.5, a1 = span * 0.5;
  s.moveTo(side * rIn, y + Math.sin(a0) * R * 0.55);
  for (let i = 0; i <= N; i++) {
    const a = lerp(a0, a1, i / N);
    s.lineTo(side * Math.cos(a) * R, y + Math.sin(a) * R);
  }
  s.lineTo(side * rIn, y + Math.sin(a1) * R * 0.55);
  s.lineTo(side * rIn * 0.9, y + Math.sin(a1) * R * 0.30);
  s.lineTo(side * rIn * 0.9, y + Math.sin(a0) * R * 0.30);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: depth * 0.4, bevelEnabled: true, bevelThickness: depth * 0.3, bevelSize: R * 0.09,
    bevelSegments: 2, curveSegments: 4, steps: 1,
  });
  g.translate(0, 0, -depth * 0.2);
  g.computeVertexNormals();
  return g;
}

/** a sleeve of leather wrap between y0 and y1 (a wrapped grip) */
export function grip({ y0, y1, r, radial = 9 } = {}) {
  return tubeGeo([{ p: [0, y0, 0], r }, { p: [0, (y0 + y1) * 0.5, 0], r: r * 1.06 }, { p: [0, y1, 0], r }],
    { radial, capStart: 'flat', capEnd: 'flat' });
}

/** a flattened, curved FEATHER (tube with a thin section and a slight bow) */
export function feather({ from, to, w, bow = 0.08, n = 6, radial = 7 } = {}) {
  const a = V(...from), b = V(...to);
  const d = b.clone().sub(a);
  const L = d.length(); d.normalize();
  const side = Math.abs(d.y) > 0.9 ? V(1, 0, 0) : V(0, 1, 0);
  const nrm = new THREE.Vector3().crossVectors(d, side).normalize();
  const spine = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = a.clone().addScaledVector(d, L * t).addScaledVector(nrm, bow * L * Math.sin(Math.PI * t));
    const hw = w * (0.35 + 0.65 * Math.sin(Math.PI * Math.pow(t, 0.7))) * (1 - Math.pow(t, 4)) + 0.004;
    spine.push({ p: [p.x, p.y, p.z], r: hw, sx: 1, sz: 0.22 });
  }
  return tubeGeo(spine, { radial, capStart: 'round', capEnd: 'round', capScale: 0.4, up: [nrm.x, nrm.y, nrm.z], shape: DIAMOND });
}

/** n claws / spikes radiating from a centre, tips pulled toward `toward` */
export function claws({ n = 3, y = 0, R = 0.16, len = 0.3, r0 = 0.05, tilt = 0.5, phase = 0 } = {}) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * TAU;
    const cx = Math.cos(a), cz = Math.sin(a);
    parts.push(tubeGeo([
      { p: [cx * R, y, cz * R], r: r0 },
      { p: [cx * R * (1 - tilt * 0.5), y + len * 0.55, cz * R * (1 - tilt * 0.5)], r: r0 * 0.6 },
      { p: [cx * R * (1 - tilt), y + len, cz * R * (1 - tilt)], r: 0.004 },
    ], { radial: 7, capStart: 'flat', capEnd: 'round' }));
  }
  return merge(parts);
}

export default { superellipse, DIAMOND, PLATE, fullered, tint, edged, chamfered, wrapped, merge, mesh, xf, shaft, ring, blade, crossguard, gem, horn, axeHead, grip, feather, claws };
