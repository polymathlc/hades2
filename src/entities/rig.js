// OWNER: AGENT-PLAYER
// ---------------------------------------------------------------------------
// rig.js — PROCEDURAL SKELETON + SKINNED CHARACTER BUILDER.
//
// Zero external assets. A humanoid THREE.Bone hierarchy is authored in code,
// a body is generated around it from parametric primitives (swept tubes and
// parametric sheets), and skin weights are solved from bone-SEGMENT distance
// with a smooth compact-support kernel ("capsule-space weighting").
//
// Everything is driven by a SPEC (see HERO_SPEC / docs in the agent report) so
// AGENT-ENEMY can build a whole roster on the same system:
//
//   const rig = buildHumanoid(spec, ctx);
//   scene.add(rig.root);
//   rig.bones.chest.rotation.x = 0.2;         // pose it
//
// SHADING: every slot goes through ctx.mats.get('character.*') — the painterly
// CHARACTER variant from materials/painterly.js (2-3 step ramp, coloured ink
// shadow, art-directed fresnel rim, colour-shifted inner contour). We never
// author a shader here. Per-vertex colour carries the palette AND hand-painted
// ambient occlusion (ART_DIRECTION §4), so one material covers many tints.
//
// THE VALUE LAW (§9): the character is the LIT SUBJECT. Skin, metal and blade
// are authored HIGH value / HIGH chroma; hair, cape and boots are the ink
// anchors that keep the silhouette readable. The floor is never allowed to be
// brighter than this.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { hexToRgb } from '../materials/palette.js';
import { setPaint } from '../materials/painterly.js';
import { TAU, clamp, clamp01, lerp, smoothstep } from '../core/math.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
export const D2R = Math.PI / 180;

const _c = new THREE.Color();
/** hex (sRGB) -> linear rgb triple, the space a vertex-colour attribute lives in. */
export function linRGB(hex) { _c.setRGB(...hexToRgb(hex), THREE.SRGBColorSpace); return [_c.r, _c.g, _c.b]; }

// deterministic hash noise — no RNG state, identical every run (§ determinism)
function h3(x, y, z) {
  let n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

// ---------------------------------------------------------------------------
// GEOMETRY KIT — exported so the enemy roster can reuse the same shape language
// ---------------------------------------------------------------------------

/**
 * Swept tube along a polyline spine with an elliptical, per-ring cross-section.
 * spine: [{ p:[x,y,z], r, sx, sz }]  — sx scales across the frame normal
 * (world-X-ish for vertical limbs), sz across the binormal (world-Z-ish).
 * opts: { radial, capStart:'round'|'flat'|'open', capEnd, capSeg, capScale,
 *         up, up2, shape(theta, t)->radiusMultiplier }
 */
export function tubeGeo(spine, o = {}) {
  const radial = o.radial ?? 12;
  const upRef = V(...(o.up || [0, 0, 1]));
  const alt = V(...(o.up2 || [1, 0, 0]));
  const n = spine.length;
  const P = spine.map(s => V(s.p[0], s.p[1], s.p[2]));
  const F = [];
  for (let i = 0; i < n; i++) {
    const t = V(0, 1, 0);
    if (n > 1) {
      if (i === 0) t.subVectors(P[1], P[0]);
      else if (i === n - 1) t.subVectors(P[n - 1], P[n - 2]);
      else t.subVectors(P[i + 1], P[i - 1]);
      t.normalize();
    }
    const up = Math.abs(upRef.dot(t)) > 0.93 ? alt : upRef;
    const N = new THREE.Vector3().crossVectors(up, t).normalize();
    const B = new THREE.Vector3().crossVectors(t, N).normalize();
    F.push({ t, N, B });
  }
  const rows = [];
  const capScale = o.capScale ?? 1;
  const emit = (i, rs, along) => {
    const s = spine[i], f = F[i];
    const c = P[i].clone().addScaledVector(f.t, along);
    const row = [];
    const sx = s.sx ?? 1, sz = s.sz ?? 1;
    for (let j = 0; j < radial; j++) {
      const th = (j / radial) * TAU;
      let rad = (s.r ?? 0.1) * rs;
      if (o.shape) rad *= o.shape(th, n > 1 ? i / (n - 1) : 0);
      row.push(c.clone()
        .addScaledVector(f.N, rad * sx * Math.cos(th))
        .addScaledVector(f.B, rad * sz * Math.sin(th)));
    }
    rows.push(row);
  };
  const CS = o.capSeg ?? 3;
  const cs = o.capStart ?? 'round', ce = o.capEnd ?? 'round';
  if (cs === 'round') for (let k = CS; k >= 1; k--) { const u = k / (CS + 0.35); emit(0, Math.sqrt(Math.max(0, 1 - u * u)), -u * spine[0].r * capScale); }
  else if (cs === 'flat') emit(0, 0.02, 0);
  for (let i = 0; i < n; i++) emit(i, 1, 0);
  if (ce === 'round') for (let k = 1; k <= CS; k++) { const u = k / (CS + 0.35); emit(n - 1, Math.sqrt(Math.max(0, 1 - u * u)), u * spine[n - 1].r * capScale); }
  else if (ce === 'flat') emit(n - 1, 0.02, 0);

  const R = rows.length;
  const pos = new Float32Array(R * radial * 3);
  const uv = new Float32Array(R * radial * 2);
  const idx = [];
  for (let i = 0; i < R; i++) for (let j = 0; j < radial; j++) {
    const k = i * radial + j, p = rows[i][j];
    pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
    uv[k * 2] = j / radial; uv[k * 2 + 1] = i / (R - 1 || 1);
  }
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * radial + j, b = i * radial + ((j + 1) % radial);
    const c2 = (i + 1) * radial + j, d = (i + 1) * radial + ((j + 1) % radial);
    idx.push(a, c2, b, b, c2, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Parametric SHEET with thickness — cloth, capes, pteruges, armour lames.
 * fn(u,v) -> THREE.Vector3 on the mid-surface. Front/back shells are separate
 * vertex sets (so the lining can be tinted differently) joined by a rim strip.
 * Writes a `side` attribute: +1 front, -1 back, 0 rim.
 */
export function sheetGeo(nu, nv, fn, thick = 0.018) {
  const NU = nu + 1, NV = nv + 1, COUNT = NU * NV;
  const mid = [], nrm = [];
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) mid.push(fn(i / nu, j / nv));
  const at = (i, j) => mid[clamp(i, 0, NU - 1) * NV + clamp(j, 0, NV - 1)];
  const du = new THREE.Vector3(), dv = new THREE.Vector3();
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
    du.subVectors(at(i + 1, j), at(i - 1, j));
    dv.subVectors(at(i, j + 1), at(i, j - 1));
    const nn = new THREE.Vector3().crossVectors(dv, du);
    if (nn.lengthSq() < 1e-12) nn.set(0, 0, 1); else nn.normalize();
    nrm.push(nn);
  }
  const pos = new Float32Array(COUNT * 2 * 3);
  const uv = new Float32Array(COUNT * 2 * 2);
  const side = new Float32Array(COUNT * 2);
  const h = thick * 0.5;
  for (let s = 0; s < 2; s++) for (let k = 0; k < COUNT; k++) {
    const o = s * COUNT + k, p = mid[k], nn = nrm[k], sg = s === 0 ? 1 : -1;
    pos[o * 3] = p.x + nn.x * h * sg; pos[o * 3 + 1] = p.y + nn.y * h * sg; pos[o * 3 + 2] = p.z + nn.z * h * sg;
    uv[o * 2] = ((k / NV) | 0) / nu; uv[o * 2 + 1] = (k % NV) / nv;
    side[o] = sg;
  }
  const idx = [];
  for (let i = 0; i < NU - 1; i++) for (let j = 0; j < NV - 1; j++) {
    const a = i * NV + j, b = a + 1, c = a + NV, d = c + 1;
    idx.push(a, c, b, b, c, d);
    const A = COUNT + a, B = COUNT + b, C = COUNT + c, D = COUNT + d;
    idx.push(A, B, C, B, D, C);
  }
  const rim = (a, b) => { idx.push(a, b, COUNT + a, b, COUNT + b, COUNT + a); };
  for (let j = 0; j < NV - 1; j++) rim((NU - 1) * NV + j + 1, (NU - 1) * NV + j);
  for (let j = 0; j < NV - 1; j++) rim(j, j + 1);
  for (let i = 0; i < NU - 1; i++) rim(i * NV, (i + 1) * NV);
  for (let i = 0; i < NU - 1; i++) rim((i + 1) * NV + NV - 1, i * NV + NV - 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('side', new THREE.BufferAttribute(side, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** scaled/positioned THREE primitive helper — returns a transformed geometry */
export function prim(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const m = new THREE.Matrix4();
  m.compose(V(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R)), V(...scale));
  geo.applyMatrix4(m);
  if (!geo.getAttribute('uv')) {
    const n = geo.getAttribute('position').count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

// ---------------------------------------------------------------------------
// SPEC
// ---------------------------------------------------------------------------

export const HERO_PALETTE = {
  // §9.2: the hero out-values the floor. Every slot sits ABOVE the stone
  // albedo — the character is the lit subject, not another dark prop.
  skin:      '#e8bd93',
  skinDeep:  '#a8654a',
  hair:      '#4a2c78',   // a plum that READS; a true black head is a hole
  hairTip:   '#7047a0',
  cloth:     '#8f1c36',   // chiton crimson
  clothDeep: '#4a0c20',
  cape:      '#3d1a5c',
  capeLine:  '#d1354f',   // lining — a hot flash when the mantle swings open
  metal:     '#f0bb52',
  // metalHot / bladeEdge are the two hottest albedos on the character and they
  // sit on METAL, i.e. on surfaces that also mirror the env rig's sharp key
  // lobe. At #fff4cf / #fff0b8 the girdle bosses read as a row of glowing
  // beads and the xiphos read as a lit sabre with a bloom halo — §4 asks for
  // "a small, bright, sharp glint", not an emissive weapon.
  metalHot:  '#ffe0a0',
  metalDeep: '#7d4c17',
  blade:     '#8e93ab',   // steel, deliberately NOT white: it blooms otherwise
  bladeEdge: '#d8cfae',
  leather:   '#37203f',
  glow:      '#7fe3ff',   // the accent complement (§1.2) — eyes, sigils
};

export const HERO_SPEC = {
  name: 'erebus.hero',
  height: 2.05,
  build: { shoulder: 1.0, limb: 1.0, bulk: 1.0 },
  palette: HERO_PALETTE,
  features: {
    pauldron: 'left',      // 'left' | 'right' | 'both' | 'none'
    crown: 'laurel',       // 'laurel' | 'none'
    cape: true,
    skirt: 8,              // number of pteruges panels (0 = none)
    greaves: true,
    bracers: true,
    harness: true,
    hair: 'swept',         // 'swept' | 'short' | 'none'
    witchArm: 'none',      // 'left' | 'right' | 'none'
    eyes: true,
    // Player weapons are separate hand-mounted models (player-weapons.js),
    // allowing the equipped arm to change silhouette at runtime.
    weapon: 'none',        // 'xiphos' | 'none'
  },
  // The eyes and the harness sigil are the only emissive on the character. At
  // 0.85 they clipped to white ping-pong balls instead of reading as the
  // #7fe3ff accent (§1.2), and two white dots are the first thing the eye finds
  // on a 100px head.
  // Widened +55% and banked down: at 0.42 the iris was a clipped WHITE dot
  // (measured: the eyes read pure white, not the authored #7fe3ff), so the one
  // chromatic accent on the face delivered a featureless highlight instead of
  // the §1.2 complement. A bigger, cooler eye reads as a SHAPE.
  glowIntensity: 0.30,
  rim: null,               // optional { color, strength } override for this actor
};

// Melinoe is not a recolour of Zagreus. Her narrower build, moon crown,
// asymmetrical silver arm, dark witch-cloth and mint/orange spell accents give
// her a different read even when both heirs are standing idle at game scale.
export const MELINOE_PALETTE = {
  skin:      '#e7bd9e',
  skinDeep:  '#a86d58',
  hair:      '#d9d1bd',
  hairTip:   '#83c8ae',
  cloth:     '#253b35',
  clothDeep: '#101c1b',
  cape:      '#182a29',
  capeLine:  '#ef9157',
  metal:     '#b9c8bd',
  metalHot:  '#eef6d8',
  metalDeep: '#536c65',
  blade:     '#8eb9aa',
  bladeEdge: '#e2f3da',
  leather:   '#211d29',
  glow:      '#77f0c2',
};

export const MELINOE_SPEC = {
  name: 'erebus.melinoe',
  height: 1.98,
  build: { shoulder: 0.88, limb: 0.94, bulk: 0.86 },
  palette: MELINOE_PALETTE,
  features: {
    pauldron: 'right',
    crown: 'moon',
    cape: true,
    skirt: 10,
    greaves: false,
    bracers: true,
    harness: true,
    hair: 'swept',
    witchArm: 'left',
    eyes: true,
    weapon: 'none',
  },
  glowIntensity: 0.38,
  rim: { color: '#84f2c8', strength: 0.76 },
};

/** deep-ish merge so a caller can override one feature without restating all. */
export function mergeSpec(base, over = {}) {
  return {
    ...base, ...over,
    build: { ...base.build, ...(over.build || {}) },
    palette: { ...base.palette, ...(over.palette || {}) },
    features: { ...base.features, ...(over.features || {}) },
  };
}

// ---------------------------------------------------------------------------
// SKELETON
// ---------------------------------------------------------------------------

function skeletonDef(spec) {
  const sw = spec.build?.shoulder ?? 1;
  const lm = spec.build?.limb ?? 1;
  const B = [];
  const add = (name, parent, p, t, r, group = 'body', weight = true) =>
    B.push({ name, parent, p, t, r, group, weight });

  add('root', null, [0, 0, 0], [0, 0.9, 0], 0.10, 'body', false);
  add('pelvis', 'root', [0, 0.955, 0], [0, 1.10, 0], 0.215);
  add('spine1', 'pelvis', [0, 1.10, -0.005], [0, 1.235, 0.005], 0.185);
  add('spine2', 'spine1', [0, 1.235, 0.005], [0, 1.375, 0.012], 0.195);
  add('chest', 'spine2', [0, 1.375, 0.012], [0, 1.52, 0.0], 0.245);
  add('neck', 'chest', [0, 1.52, 0.0], [0, 1.60, 0.006], 0.095);
  add('head', 'neck', [0, 1.60, 0.006], [0, 1.86, 0.012], 0.155);

  for (const s of [1, -1]) {
    const S = s > 0 ? 'L' : 'R';
    add('clav' + S, 'chest', [0.048 * s, 1.462, 0.018], [0.235 * s * sw, 1.455, 0.0], 0.115);
    add('arm' + S, 'clav' + S, [0.235 * s * sw, 1.455, 0.0], [0.245 * s * sw, 1.155, -0.012], 0.105);
    add('fore' + S, 'arm' + S, [0.245 * s * sw, 1.155, -0.012], [0.25 * s * sw, 0.905, 0.012], 0.085);
    add('hand' + S, 'fore' + S, [0.25 * s * sw, 0.905, 0.012], [0.252 * s * sw, 0.775, 0.038], 0.078);
    add('thigh' + S, 'pelvis', [0.105 * s, 0.925, 0.0], [0.115 * s, 0.53, -0.008], 0.135);
    add('shin' + S, 'thigh' + S, [0.115 * s, 0.53, -0.008], [0.12 * s, 0.115, -0.028], 0.105);
    add('foot' + S, 'shin' + S, [0.12 * s, 0.115, -0.028], [0.122 * s, 0.055, 0.075], 0.085);
    add('toe' + S, 'foot' + S, [0.122 * s, 0.055, 0.075], [0.122 * s, 0.045, 0.16], 0.065);
  }

  const chains = [];
  if (spec.features.hair !== 'none') {
    add('hairA', 'head', [0, 1.755, -0.075], [0, 1.655, -0.175], 0.135, 'hair');
    add('hairB', 'hairA', [0, 1.655, -0.175], [0, 1.548, -0.246], 0.115, 'hair');
    chains.push({ name: 'hair', bones: ['hairA', 'hairB'], stiff: 34, damp: 7.0, grav: 2.4, inertia: 0.5, maxAng: 0.42 });
  }
  if (spec.features.cape) {
    add('capeA', 'chest', [0, 1.482, -0.175], [0, 1.238, -0.238], 0.34, 'cape');
    add('capeB', 'capeA', [0, 1.238, -0.238], [0, 0.988, -0.300], 0.34, 'cape');
    add('capeC', 'capeB', [0, 0.988, -0.300], [0, 0.742, -0.358], 0.34, 'cape');
    add('capeD', 'capeC', [0, 0.742, -0.358], [0, 0.510, -0.405], 0.34, 'cape');
    chains.push({ name: 'cape', bones: ['capeA', 'capeB', 'capeC', 'capeD'], stiff: 13, damp: 3.4, grav: 5.6, inertia: 1.0, maxAng: 0.62 });
  }
  const NS = spec.features.skirt | 0;
  for (let i = 0; i < NS; i++) {
    const a = (22.5 + i * (360 / NS)) * D2R, S = Math.sin(a), C = Math.cos(a);
    add(`skirt${i}A`, 'pelvis', [0.155 * S, 0.930, 0.155 * C], [0.215 * S, 0.690, 0.215 * C], 0.135, 'skirt');
    add(`skirt${i}B`, `skirt${i}A`, [0.215 * S, 0.690, 0.215 * C], [0.290 * S, 0.445, 0.290 * C], 0.135, 'skirt');
    chains.push({ name: 'skirt' + i, bones: [`skirt${i}A`, `skirt${i}B`], stiff: 26, damp: 5.0, grav: 6.4, inertia: 1.0, maxAng: 0.52, angle: a });
  }

  const k = spec.height / 1.90;
  if (k !== 1) for (const b of B) { for (let i = 0; i < 3; i++) { b.p[i] *= k; b.t[i] *= k; } b.r *= k; }
  if (lm !== 1) for (const b of B) if (/arm|fore|hand|thigh|shin/.test(b.name)) b.r *= lm;
  return { list: B, chains };
}

// ---------------------------------------------------------------------------
// SKIN WEIGHTS — capsule-space distance with a compact smooth kernel
// ---------------------------------------------------------------------------

const _ab = new THREE.Vector3(), _ap = new THREE.Vector3();
function segDist(px, py, pz, a, b) {
  _ab.subVectors(b, a); _ap.set(px - a.x, py - a.y, pz - a.z);
  const L = _ab.lengthSq();
  const t = L > 1e-9 ? clamp01(_ap.dot(_ab) / L) : 0;
  const dx = _ap.x - _ab.x * t, dy = _ap.y - _ab.y * t, dz = _ap.z - _ab.z * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
// Wyvill soft-object kernel: C2 continuous, exactly zero at x>=1 (compact
// support is what stops a shoulder bone from tugging on a boot).
const kernel = (x) => { if (x >= 1) return 0; const u = 1 - x * x; return u * u * u; };

/**
 * @param {Float32Array} pos   vertex positions in BIND space
 * @param {Array} segs         [{i,name,a:Vec3,b:Vec3,r,weight}]
 * @param {Object} rule        { mode:'auto'|'rigid', bone, only:[names], bias:{}, spread, sharp }
 */
export function solveSkinWeights(pos, segs, rule = {}, byName = null) {
  const n = pos.length / 3;
  const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
  if (rule.mode === 'rigid') {
    const s = byName.get(rule.bone);
    for (let v = 0; v < n; v++) { SI[v * 4] = s ? s.i : 0; SW[v * 4] = 1; }
    return { SI, SW };
  }
  const only = rule.only ? new Set(rule.only) : null;
  const cand = segs.filter(s => s.weight && (!only || only.has(s.name)));
  const spread = rule.spread ?? 2.15;
  const sharp = rule.sharp ?? 1;
  const bias = rule.bias || null;
  const W = new Float64Array(cand.length);
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let sum = 0, best = -1, bestD = Infinity;
    for (let c = 0; c < cand.length; c++) {
      const s = cand[c];
      const d = segDist(x, y, z, s.a, s.b);
      if (d < bestD) { bestD = d; best = c; }
      let w = kernel(d / (s.r * spread));
      if (w > 0) { if (sharp !== 1) w = Math.pow(w, sharp); if (bias && bias[s.name] != null) w *= bias[s.name]; }
      W[c] = w; sum += w;
    }
    if (sum <= 1e-8) { SI[v * 4] = cand[best] ? cand[best].i : 0; SW[v * 4] = 1; continue; }
    // top 4
    let i0 = -1, i1 = -1, i2 = -1, i3 = -1, w0 = 0, w1 = 0, w2 = 0, w3 = 0;
    for (let c = 0; c < cand.length; c++) {
      const w = W[c]; if (w <= 0) continue;
      if (w > w0) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = i0; w1 = w0; i0 = c; w0 = w; }
      else if (w > w1) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = c; w1 = w; }
      else if (w > w2) { i3 = i2; w3 = w2; i2 = c; w2 = w; }
      else if (w > w3) { i3 = c; w3 = w; }
    }
    const tot = w0 + w1 + w2 + w3;
    SI[v * 4] = i0 >= 0 ? cand[i0].i : 0; SW[v * 4] = w0 / tot;
    SI[v * 4 + 1] = i1 >= 0 ? cand[i1].i : 0; SW[v * 4 + 1] = i1 >= 0 ? w1 / tot : 0;
    SI[v * 4 + 2] = i2 >= 0 ? cand[i2].i : 0; SW[v * 4 + 2] = i2 >= 0 ? w2 / tot : 0;
    SI[v * 4 + 3] = i3 >= 0 ? cand[i3].i : 0; SW[v * 4 + 3] = i3 >= 0 ? w3 / tot : 0;
  }
  return { SI, SW };
}

// ---------------------------------------------------------------------------
// HAND-PAINTED AMBIENT OCCLUSION (§4) — crevices authored in BIND space and
// baked to vertex colour. This is the "darkened crevices" the bible asks for,
// and it is what stops a procedurally-generated body from reading as plastic.
// ---------------------------------------------------------------------------
const CREVICE = [
  { p: [0, 1.508, 0.00], r: 0.19, k: 0.52 },   // neck join
  { p: [0, 1.640, 0.09], r: 0.11, k: 0.46 },   // under the chin
  { p: [0.19, 1.402, 0.00], r: 0.16, k: 0.50 },   // armpit L
  { p: [-0.19, 1.402, 0.00], r: 0.16, k: 0.50 },   // armpit R
  { p: [0, 0.880, 0.00], r: 0.17, k: 0.55 },   // crotch
  { p: [0, 0.945, 0.00], r: 0.21, k: 0.34 },   // under the girdle
  { p: [0.115, 0.530, -0.06], r: 0.11, k: 0.40 },  // back of knee L
  { p: [-0.115, 0.530, -0.06], r: 0.11, k: 0.40 },  // back of knee R
  // FACE. At 90px the face is four shapes: brow shadow, eye sockets, the plane
  // under the cheekbone and the shadow under the nose. Without them the head is
  // a lit egg, which is the single most "programmer art" thing a hero can be.
  { p: [0.048, 1.704, 0.130], r: 0.066, k: 0.80 }, // eye socket L
  { p: [-0.048, 1.704, 0.130], r: 0.066, k: 0.80 }, // eye socket R
  { p: [0.040, 1.648, 0.146], r: 0.038, k: 0.42 }, // mouth corner L
  { p: [-0.040, 1.648, 0.146], r: 0.038, k: 0.42 }, // mouth corner R
  { p: [0, 1.716, 0.150], r: 0.045, k: 0.55 }, // nasion
  { p: [0, 1.660, 0.150], r: 0.048, k: 0.50 }, // under the nose
  { p: [0.112, 1.672, 0.088], r: 0.070, k: 0.42 }, // cheek plane L
  { p: [-0.112, 1.672, 0.088], r: 0.070, k: 0.42 }, // cheek plane R
  { p: [0, 1.430, -0.115], r: 0.24, k: 0.46 },  // under the mantle
  { p: [0.245, 1.155, 0.05], r: 0.09, k: 0.34 },  // inner elbow L
  { p: [-0.245, 1.155, 0.05], r: 0.09, k: 0.34 },  // inner elbow R
  { p: [0, 1.10, 0.13], r: 0.13, k: 0.26 },  // navel / abdominal shadow
];

// NOTE: the crevice table is authored in the REFERENCE 1.90m space. Callers
// pass positions already divided by the spec's height scale.
function aoAt(x, y, z, H) {
  let ao = 1;
  for (let i = 0; i < CREVICE.length; i++) {
    const c = CREVICE[i];
    const dx = x - c.p[0], dy = y - c.p[1], dz = z - c.p[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / c.r;
    if (d < 1) ao *= 1 - c.k * (1 - smoothstep(d));
  }
  // painted vertical form gradient: the head carries the light, the boots are ink
  ao *= lerp(0.76, 1.06, smoothstep(clamp01(y / (H * 0.82))));
  // brush-grain so flat panels are never dead flat
  ao *= 0.965 + 0.07 * h3(x * 31.7, y * 27.3, z * 41.1);
  return ao;
}

// ---------------------------------------------------------------------------
// BODY
// ---------------------------------------------------------------------------

const SLOTS = ['skin', 'cloth', 'hair', 'metal', 'glow'];
const SLOT_MAT = {
  // `repeat` is how many times the baked set wraps across a limb's 0..1
  // cylindrical unwrap. A weave that wraps once around a forearm is a printed
  // pattern; three times is cloth.
  skin: { roughness: 0.60, metalness: 0.0, repeat: 2, mapped: true },
  cloth: { roughness: 0.88, metalness: 0.0, repeat: 3, mapped: true },
  hair: { roughness: 0.50, metalness: 0.02, repeat: 2, mapped: true },
  // metalness 0.95 + roughness 0.24 under a key of 38 turns a 60cm blade into
  // a 400px bloom blob. Metal here is ART metal: broad, warm, controlled.
  metal: { roughness: 0.34, metalness: 0.78 },
  glow: { roughness: 0.40, metalness: 0.0 },
};

// The character is lit FLAT and GRAPHIC (§4), not physically. Cutting litGain
// pulls the key side out of clipping; raising ambGain lifts the shadow side
// into a readable mid. That is the painted 2-3 band ramp the bible asks for,
// instead of a blown face on a black body.
// ── §1.2 / §4 / §9.6  THE CHARACTER RIM ──────────────────────────────────────
// The complement rim is the mechanism that separates a Hades character from its
// set. Three things were killing it and all three are fixed here, from the one
// file that is allowed to art-direct the hero:
//
// 1. DIRECTION. The rig publishes rim.dir [-0.62, 0.36, 0.70], which projects
//    onto SCREEN-LEFT at the shipping camera (yaw 45, pitch 50) — the same side
//    the key lights from. A rim that agrees with the key is not a rim; it is a
//    second key, and it is why the "second strongest light in the frame" drew
//    no edge anywhere on the hero.
//    The naive fix (flip Z to [-0.72, 0.30, -0.62]) is WRONG at this camera and
//    worth recording: with the eye vector V = (0.45, 0.77, 0.45), a normal whose
//    X+Z is that negative can only stay FRONT-FACING if its Y is large — and
//    painterly.js:632 vetoes the rim on anything with wN.y > 0.40 to keep it off
//    the ground plane. Back-Z rim and up-normal veto are mutually exclusive
//    here, so a Z-flip deletes the rim instead of moving it.
//    [0.68, 0.28, -0.68] is the direction that actually works: it lands on the
//    SCREEN-RIGHT contour (world camera-right is (0.707, 0, -0.707)), which is
//    the side the key does NOT light, at wN.y ~0.28 where the ground veto is
//    still fully open. Camera-facing normals score 0.21 on the gate but their
//    fresnel is ~0, so there is no frontal fill either way.
// 2. ENERGY. painterly.js scales the additive rim by a bare 0.026 of the key
//    reference. Measured, that left 1.8% of lit hero pixels carrying any cool
//    hue at all. rimStrength is the only multiplier on that term we own, so the
//    per-slot strengths below carry the ~4x the edge actually needs.
// 3. HUE. painterly.js:658 multiplies the authored rim colour component-wise by
//    vec3(0.30, 1.22, 0.72) as an AgX "pre-compensation". That drags the
//    mandated #5fd0ff (h197) toward green and crushes its red to 30%.
//    #8fa4ff is the pre-image of the palette value under that multiply: it
//    arrives at the display as rgb(79,179,222) = h198, s0.68 — §2's Tartarus
//    rim/accent. AGENT-MATERIAL: when painterly.js:658 ships as
//    `vec3 rimC = uRimColor;`, change RIM_HEX back to '#5fd0ff' and drop
//    rimStrength ~4x. Until then the palette is only reachable from here.
const RIM_HEX = '#8fa4ff';
const RIM_DIR = [0.68, 0.28, -0.68];
const RIM_GATE = [-0.45, 0.40];

// ── ROUND-2: THE CHARACTER IS THE LIT SUBJECT (§9.2, §4, §1.1) ───────────────
// The previous pass read "the hero is blowing out" and cut litGain to 0.18-0.30
// while RAISING ambGain to 0.86-0.94. The measurement that came back is the
// exact inverse of the doctrine: hero mean luma 46/255 against a set-dressing
// statue at 95/255, and hero bbox median 0.055 against groundLuma 0.038 — a
// 1.45x ratio where §9.2 mandates 2.5x. The decorative props were literally
// twice as bright as the protagonist.
//
// The arithmetic that caused it: the environment wall runs litGain 0.72 (now
// 0.46) at rampStrength 0.55, so its lit face keeps ~0.72 of the key. The hero
// ran 0.183 at rampStrength 0.95 (whose top level is 0.88), i.e. 0.161 — the
// walls were receiving FOUR AND A HALF TIMES the key the character did. No
// amount of rim or ramp work survives that.
//
// So: litGain goes ABOVE the environment (§4 "characters must NOT be lit like
// environment"), and the flat ambient wash — which is what actually deletes
// form, because a hemisphere lifts every normal equally — comes down with it.
// The lit face now lands ~1.8x the wall in irradiance and, with a #e8bd93 skin
// against #8c3b46 stone, several times that at the display.
//
// The RAMP is where the Hades look lives: a lifted first band makes the shadow
// side a flat painted MID instead of a hole, and the top band goes to 1.0 so
// the key side reaches a real value instead of being capped at 0.88.
// ── THE COOL HALF (§1.3 "shadow is a different COLOUR", §9.6) ───────────────
// Measured on the hero bounding box: 56% warm pixels against 2.8% cyan, where
// §9.6 asks for 8%. A rim alone cannot carry a complement across a form — a
// fresnel band is a contour, not a mass. The other half of the Hades trick is
// that the SHADOW side of a character lit by fire goes COLD: warm key, teal
// shadow, meeting at a hard painted terminator. `shadowTint` is that multiply,
// and at shadowDepth ~0.9 it puts a genuinely opposed hue over a THIRD of the
// character instead of over a dozen edge pixels.
// rimPower comes down with it: a power-2.3 fresnel band on a 190px figure is
// three pixels wide, which is a rumour rather than a rim.
//
// ── ROUND-4: THE LIT HALF WAS ONE VALUE BY CONSTRUCTION (§4) ────────────────
// The paragraph that used to stand here argued that rampLevels.z was "an
// exposure control" and that capping it at 0.66 was what preserved the hero's
// local colour. Read the shader and that is not what the two numbers do
// together. painterly.js computes
//     sc = mix( 1.0, r / k, uRampStrength )
// and multiplies the direct diffuse by it. directDiffuse is itself proportional
// to k, so at rampStrength 0.95 the product is ~r * keyRef * albedo: k cancels
// and every surface above the top ramp step returns EXACTLY ONE VALUE. The lit
// half of the character was a flat plane, and lowering z did not protect its
// hue — the flatness is what destroyed the hue, because a single value cannot
// carry a chiton, a mantle, skin and gold as four different things.
//
// Measured on the live page (in-place uniform sweep at the shipping pose, no
// rebuild): at rampStrength 0.95 / z 0.66 the hero's brightest 40px block sat
// at 0.611 display against a statue at 0.871 — the §14 subject test at 0.70:1
// where it wants >2:1. Restoring the gradient and raising the cap took the
// hero to 0.73 with visible modelling on the pauldron, the greave and the
// skirt panels for the first time.
//
// So: rampStrength drops to ~0.55-0.60, which keeps 40-45% of the true
// cosine falloff alive under the painted bands (§4's "soft 2-3 step ramp, not
// full toon, not full PBR"), and rampLevels.z goes up so the top band reaches
// a real value instead of being clamped a third of the way up.
//
// A WARNING THE SWEEP PRODUCED, worth recording: pushing litGain further does
// NOT keep paying. x1.55 / x2.2 / x3.0 measured 0.732 / 0.767 / 0.790 — the
// hero hits the AgX shoulder too, and past ~x1.5 all that is bought is hue
// loss. The subject test cannot be won on the hero's exposure alone; the
// competing background has to come DOWN, which is what the statue, brazier
// and colonnade caps in world/chamber.js are for.
export const SLOT_PAINT = {
  skin: {
    litGain: 0.49, ambGain: 0.44, specGain: 0.22, rimStrength: 10.4, rimPower: 1.75, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.30, 0.72, 1.78],
    rampLevels: [0.27, 0.50, 0.92], rampSteps: [0.30, 0.58], rampSoftness: 0.07, rampStrength: 0.60, shadowDepth: 0.88,
    contourStrength: 0.82, contourStart: 0.54,
  },
  cloth: {
    litGain: 0.47, ambGain: 0.42, specGain: 0.18, rimStrength: 12.0, rimPower: 1.70, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.26, 0.70, 1.90],
    rampLevels: [0.29, 0.52, 0.94], rampSteps: [0.30, 0.58], rampSoftness: 0.08, rampStrength: 0.58, shadowDepth: 0.92,
    contourStrength: 0.95, contourStart: 0.50,
  },
  hair: {
    litGain: 0.42, ambGain: 0.40, specGain: 0.16, rimStrength: 13.2, rimPower: 1.65, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.24, 0.66, 1.95],
    rampLevels: [0.22, 0.44, 0.86], rampSteps: [0.28, 0.56], rampSoftness: 0.07, rampStrength: 0.60, shadowDepth: 0.94,
    contourStrength: 1.00, contourStart: 0.48,
  },
  // METAL is the character's own highlight band (§9.3/§9.5): the gold lames,
  // the gorget, the greaves and the blade are the only pixels on the hero
  // allowed to reach genuine white, and they get there on a small sharp
  // SPECULAR glint (§4), not on a raised diffuse.
  metal: {
    litGain: 0.56, ambGain: 0.40, specGain: 0.68, rimStrength: 9.8, rimPower: 2.00, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.34, 0.74, 1.70],
    rampLevels: [0.26, 0.58, 1.00], rampSteps: [0.30, 0.56], rampSoftness: 0.055, rampStrength: 0.55, shadowDepth: 0.74,
    contourStrength: 0.70, contourStart: 0.56,
  },
  glow: { litGain: 0.22, ambGain: 0.30, specGain: 0.16, rimStrength: 0.30, rimPower: 2.30, rimDir: RIM_DIR },
};

function buildParts(spec) {
  const P = spec.palette, F = spec.features;
  const k = spec.height / 1.90;
  const parts = [];
  const add = (g, slot, tint, bind, ao) => { parts.push({ g, slot, tint, bind, ao }); return g; };
  const BODY = null; // resolved to the body-bone set by the caller

  // ── torso ────────────────────────────────────────────────────────────────
  add(tubeGeo([
    { p: [0, 0.920, 0.004], r: 0.150, sx: 1.28, sz: 0.86 },
    { p: [0, 0.985, 0.006], r: 0.162, sx: 1.30, sz: 0.84 },
    { p: [0, 1.100, 0.010], r: 0.140, sx: 1.22, sz: 0.82 },
    { p: [0, 1.235, 0.014], r: 0.163, sx: 1.30, sz: 0.83 },
    { p: [0, 1.375, 0.016], r: 0.190, sx: 1.36, sz: 0.80 },
    { p: [0, 1.462, 0.008], r: 0.180, sx: 1.50, sz: 0.74 },
    { p: [0, 1.520, 0.004], r: 0.108, sx: 1.14, sz: 0.94 },
  ], { radial: 18, capStart: 'round', capScale: 0.9, capEnd: 'flat' }), 'skin', P.skin, { only: 'body' });

  add(tubeGeo([{ p: [0, 1.470, 0.004], r: 0.074 }, { p: [0, 1.610, 0.008], r: 0.070 }],
    { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'skin', P.skin, { only: 'body' });

  // ── head ─────────────────────────────────────────────────────────────────
  add(prim(new THREE.SphereGeometry(1, 24, 16), { pos: [0, 1.694, 0.008], scale: [0.158, 0.177, 0.165] }),
    'skin', P.skin, { mode: 'rigid', bone: 'head' });
  add(prim(new THREE.SphereGeometry(1, 18, 12), { pos: [0, 1.622, 0.040], scale: [0.128, 0.094, 0.127] }),
    'skin', P.skin, { mode: 'rigid', bone: 'head' });
  add(tubeGeo([{ p: [0, 1.708, 0.148], r: 0.024 }, { p: [0, 1.658, 0.176], r: 0.017 }], { radial: 8 }),
    'skin', P.skin, { mode: 'rigid', bone: 'head' });
  add(tubeGeo([{ p: [-0.098, 1.734, 0.126], r: 0.025, sx: 0.48, sz: 0.85 },
  { p: [0, 1.739, 0.161], r: 0.025, sx: 0.48, sz: 0.85 },
  { p: [0.098, 1.734, 0.126], r: 0.025, sx: 0.48, sz: 0.85 }],
    { radial: 8, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, { mode: 'rigid', bone: 'head' });
  // BROW RIDGE. Skin, not hair: a hair-tinted bar across the eyeline read as a
  // fringe pulled down over the face at play distance. Lifted 12mm so the eye
  // assembly below has room to be three parts instead of one lozenge.
  add(tubeGeo([{ p: [-0.110, 1.7245, 0.098], r: 0.026, sx: 0.60, sz: 0.62 },
  { p: [0, 1.7275, 0.150], r: 0.027, sx: 0.60, sz: 0.62 },
  { p: [0.110, 1.7245, 0.098], r: 0.026, sx: 0.60, sz: 0.62 }],
    { radial: 8, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, { mode: 'rigid', bone: 'head' });

  // ── EYES (§4: the face must carry information at 90px) ───────────────────
  // Was: ONE emissive sphere per side at x +-0.056 / z 0.156. On a head
  // ellipsoid of half-axes (0.158, 0.177, 0.165) centred z 0.008 that corner
  // solves to 1.23 on the implicit — i.e. the outer corner of the right eye
  // hung OFF the head silhouette, a visible geometry error on the protagonist.
  // Pulled in to x +-0.048 / z 0.1545 (implicit 0.98-1.03: proud by ~1mm, which
  // is what makes an eyeball read as a bulge) and split into three parts:
  //   sclera-shadow lens   dark, wide  -> the socket
  //   iris                 emissive, HALF the old size -> a pupil, not a lamp
  //   upper lid            hair-tinted crescent -> the lash line that gives the
  //                        face an expression instead of a stare
  if (F.eyes) for (const s of [1, -1]) {
    add(prim(new THREE.SphereGeometry(1, 12, 8), { pos: [0.048 * s, 1.7055, 0.1545], rot: [0, 0, -11 * s], scale: [0.030, 0.017, 0.0135] }),
      'skin', P.skinDeep, { mode: 'rigid', bone: 'head' });
    add(prim(new THREE.SphereGeometry(1, 10, 8), { pos: [0.0475 * s, 1.7045, 0.1585], rot: [0, 0, -11 * s], scale: [0.020, 0.016, 0.0120] }),
      'glow', P.glow, { mode: 'rigid', bone: 'head' });
    add(tubeGeo([
      { p: [0.020 * s, 1.7145, 0.1455], r: 0.0050, sx: 1.0, sz: 0.62 },
      { p: [0.048 * s, 1.7195, 0.1560], r: 0.0072, sx: 1.0, sz: 0.62 },
      { p: [0.077 * s, 1.7130, 0.1400], r: 0.0048, sx: 1.0, sz: 0.62 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'hair', P.hair, { mode: 'rigid', bone: 'head' });
  }
  // MOUTH. There was no mouth geometry anywhere in the head block, so the face
  // carried exactly two features. A shallow skinDeep tube reads as a drawn line
  // at gameplay scale and as a closed mouth in the hero shot.
  add(tubeGeo([
    { p: [-0.031, 1.6455, 0.1600], r: 0.0062, sx: 1.0, sz: 0.55 },
    { p: [0, 1.6475, 0.1690], r: 0.0080, sx: 1.0, sz: 0.55 },
    { p: [0.031, 1.6455, 0.1600], r: 0.0062, sx: 1.0, sz: 0.55 },
  ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, { mode: 'rigid', bone: 'head' });
  // lower lip catch-light: a thin proud roll under the mouth line
  add(tubeGeo([
    { p: [-0.024, 1.6375, 0.1585], r: 0.0068, sx: 1.0, sz: 0.50 },
    { p: [0, 1.6385, 0.1665], r: 0.0090, sx: 1.0, sz: 0.50 },
    { p: [0.024, 1.6375, 0.1585], r: 0.0068, sx: 1.0, sz: 0.50 },
  ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, { mode: 'rigid', bone: 'head' });

  // ── hair: a cap wrapped on the skull + a swinging back mass + spikes ──────
  if (F.hair !== 'none') {
    const HC = V(0, 1.694, -0.008), HR = V(0.180, 0.198, 0.190);
    add(sheetGeo(6, 22, (u, v) => {
      const phi = (v - 0.5) * TAU;
      const thMax = lerp(1.14, 2.46, (1 - Math.cos(phi)) * 0.5);
      const th = Math.max(0.001, u * thMax);
      const back = (1 - Math.cos(phi)) * 0.5;
      const vol = 1.04 + 0.34 * clamp01((th - 0.45) * 1.3) * (0.35 + 0.65 * back);
      return V(HC.x + HR.x * vol * Math.sin(th) * Math.sin(phi),
        HC.y + HR.y * vol * Math.cos(th),
        HC.z + HR.z * vol * Math.sin(th) * Math.cos(phi) - 0.026 * back * u);
    }, 0.022), 'hair', (x, y, z, u) => (u > 0.86 ? P.hairTip : P.hair), { only: ['head', 'hairA'], bias: { head: 3.0 } });

    add(tubeGeo([
      { p: [0, 1.750, -0.108], r: 0.118, sx: 0.94, sz: 0.92 },
      { p: [0, 1.694, -0.162], r: 0.107, sx: 0.92, sz: 0.88 },
      { p: [0, 1.614, -0.210], r: 0.078, sx: 0.88, sz: 0.84 },
      { p: [0, 1.548, -0.258], r: 0.036, sx: 0.82, sz: 0.80 },
    ], { radial: 12, capStart: 'flat', capEnd: 'round' }), 'hair',
      (x, y, z) => (y < 1.60 ? P.hairTip : P.hair), { only: ['head', 'hairA', 'hairB'] });

    for (const s of [1, -1])
      add(tubeGeo([
        { p: [0.106 * s, 1.794, 0.070], r: 0.036 },
        { p: [0.158 * s, 1.792, -0.092], r: 0.031 },
        { p: [0.142 * s, 1.746, -0.236], r: 0.009 },
      ], { radial: 8, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y, z) => (z < -0.14 ? P.hairTip : P.hair), { only: ['head', 'hairA', 'hairB'] });
    for (const s of [1, -1]) {
      add(tubeGeo([
        { p: [0.030 * s, 1.836, 0.086], r: 0.030 },
        { p: [0.052 * s, 1.792, 0.156], r: 0.024 },
        { p: [0.070 * s, 1.752, 0.188], r: 0.007 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.775 ? P.hairTip : P.hair), { mode: 'rigid', bone: 'head' });
      add(tubeGeo([
        { p: [0.098 * s, 1.812, 0.048], r: 0.028 },
        { p: [0.132 * s, 1.766, 0.118], r: 0.022 },
        { p: [0.148 * s, 1.726, 0.146], r: 0.007 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.750 ? P.hairTip : P.hair), { mode: 'rigid', bone: 'head' });
    }
    add(tubeGeo([
      { p: [0, 1.874, 0.034], r: 0.038 },
      { p: [0, 1.890, -0.114], r: 0.032 },
      { p: [0, 1.836, -0.256], r: 0.009 },
    ], { radial: 8, capStart: 'flat', capEnd: 'round' }), 'hair',
      (x, y, z) => (z < -0.16 ? P.hairTip : P.hair), { only: ['head', 'hairA', 'hairB'] });
  }

  // ── laurel crown (§1.5 ornament carries the light) ───────────────────────
  if (F.crown === 'laurel') {
    add(prim(new THREE.TorusGeometry(0.172, 0.0115, 6, 32), { pos: [0, 1.806, -0.014], rot: [90, 0, 0], scale: [1, 1.06, 1] }),
      'metal', P.metal, { mode: 'rigid', bone: 'head' });
    const NL = 12;
    for (let i = 0; i < NL; i++) {
      const a = (i / NL) * 360 + 12;
      const leaf = new THREE.SphereGeometry(1, 8, 6);
      prim(leaf, { scale: [0.022, 0.046, 0.010], rot: [-52, 0, (i % 2 ? 8 : -8)] });
      prim(leaf, { rot: [0, a, 0], pos: [0.170 * Math.sin(a * D2R), 1.828, 0.178 * Math.cos(a * D2R) - 0.014] });
      add(leaf, 'metal', i % 3 === 0 ? P.metalHot : P.metal, { mode: 'rigid', bone: 'head' });
    }
    add(prim(new THREE.SphereGeometry(1, 10, 8), { pos: [0, 1.812, 0.172], scale: [0.016, 0.019, 0.011] }),
      'glow', P.glow, { mode: 'rigid', bone: 'head' });
  } else if (F.crown === 'moon') {
    // The witch's lunar circlet: a thin silver band, central moonstone and two
    // rising horn arcs. It deliberately breaks the round laurel silhouette.
    add(prim(new THREE.TorusGeometry(0.176, 0.0105, 7, 34), { pos: [0, 1.808, -0.012], rot: [90, 0, 0], scale: [1, 1.04, 1] }),
      'metal', P.metal, { mode: 'rigid', bone: 'head' });
    for (const s of [-1, 1]) {
      add(tubeGeo([
        { p: [0.040 * s, 1.842, 0.152], r: 0.012 },
        { p: [0.092 * s, 1.902, 0.126], r: 0.010 },
        { p: [0.120 * s, 1.948, 0.076], r: 0.0035 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), 'metal', P.metalHot, { mode: 'rigid', bone: 'head' });
    }
    add(prim(new THREE.OctahedronGeometry(0.031, 0), { pos: [0, 1.865, 0.174], scale: [0.78, 1.25, 0.52] }),
      'glow', P.glow, { mode: 'rigid', bone: 'head' });
  }

  // ── pauldrons ────────────────────────────────────────────────────────────
  // WAS: one SphereGeometry hemisphere 0.336m across — the SAME diameter as the
  // head (0.316 x 0.354) — wearing 6-segment tori whose tube facets read as
  // gear teeth at play scale. That is the closest thing in the package to a §7
  // "programmer-art primitive left visible".
  // NOW: three overlapping LAMES (articulated plates) stepping down the deltoid
  // with a hard 4mm reveal between them, each capped by a 12-segment gold arris.
  // The mass is cut 25% in width and 44% in height so the shoulder no longer
  // out-masses the head, and the stepped edges give the silhouette three
  // horizontal accents instead of one bald dome.
  const lamePlate = (s, bone, tint, o) => {
    // a shallow spherical shell segment: the plate itself
    const g = prim(new THREE.SphereGeometry(1, 22, 10, 0, TAU, 0, o.phi), { scale: o.scale });
    prim(g, { rot: [0, 0, -o.tilt * s], pos: [o.px * s, o.py, o.pz] });
    add(g, 'metal', tint, { mode: 'rigid', bone: bone(s) });
    // the arris: a gold roll on the plate's lower lip. 12 radial segments, not
    // 6 — at 6 the tube is a hexagon and the hexagon is what reads as a cog.
    const r = prim(new THREE.TorusGeometry(o.scale[0] * Math.sin(o.phi) * 0.995, o.tube, 12, 34), {
      rot: [90, 0, 0], pos: [0, o.scale[1] * Math.cos(o.phi), 0], scale: [1, 1, o.scale[2] / o.scale[0]],
    });
    prim(r, { rot: [0, 0, -o.tilt * s], pos: [o.px * s, o.py, o.pz] });
    add(r, 'metal', P.metalHot, { mode: 'rigid', bone: bone(s) });
  };
  const CL = (s) => 'clav' + (s > 0 ? 'L' : 'R');
  const AR = (s) => 'arm' + (s > 0 ? 'L' : 'R');
  const pauldron = (s) => {
    lamePlate(s, CL, (x, y) => (y > 1.50 ? P.metalHot : P.metal),
      { phi: 1.34, scale: [0.126, 0.088, 0.132], tilt: 18, px: 0.206, py: 1.462, pz: 0.006, tube: 0.0115 });
    lamePlate(s, CL, P.metal,
      { phi: 1.44, scale: [0.138, 0.076, 0.144], tilt: 26, px: 0.221, py: 1.418, pz: 0.004, tube: 0.0105 });
    lamePlate(s, AR, P.metalDeep,
      { phi: 1.50, scale: [0.147, 0.068, 0.152], tilt: 40, px: 0.244, py: 1.362, pz: 0.002, tube: 0.0100 });
    // the standing fin that breaks the dome's contour (§1.1: silhouette first)
    add(tubeGeo([{ p: [0.190 * s, 1.578, 0.004], r: 0.022 }, { p: [0.243 * s, 1.652, -0.030], r: 0.015 },
    { p: [0.272 * s, 1.704, -0.074], r: 0.004 }], { radial: 8, capStart: 'flat', capEnd: 'round' }),
      'metal', P.metalHot, { mode: 'rigid', bone: CL(s) });
  };
  const smallCap = (s) => {
    lamePlate(s, CL, P.metal,
      { phi: 1.26, scale: [0.112, 0.070, 0.114], tilt: 26, px: 0.216, py: 1.474, pz: 0.006, tube: 0.0092 });
    lamePlate(s, CL, P.metalDeep,
      { phi: 1.38, scale: [0.122, 0.058, 0.126], tilt: 34, px: 0.228, py: 1.436, pz: 0.004, tube: 0.0086 });
  };
  if (F.pauldron === 'left' || F.pauldron === 'both') pauldron(1);
  else if (F.pauldron !== 'none') smallCap(1);
  if (F.pauldron === 'right' || F.pauldron === 'both') pauldron(-1);
  else if (F.pauldron !== 'none') smallCap(-1);

  // ── harness, gorget, medallion ───────────────────────────────────────────
  if (F.harness) {
    add(tubeGeo([
      { p: [0.150, 1.508, 0.062], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [0.098, 1.400, 0.140], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [0.004, 1.276, 0.164], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [-0.098, 1.140, 0.150], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [-0.160, 1.020, 0.108], r: 0.028, sx: 1.50, sz: 0.42 },
    ], { radial: 10, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metalDeep, { only: ['chest', 'spine2', 'spine1'] });
    add(prim(new THREE.TorusGeometry(0.118, 0.021, 6, 26), { pos: [0, 1.498, 0.008], rot: [90, 0, 0], scale: [1, 1, 0.92] }),
      'metal', P.metalHot, { only: ['chest', 'neck'], bias: { chest: 2 } });
    add(prim(new THREE.SphereGeometry(1, 14, 10), { pos: [0.052, 1.352, 0.166], scale: [0.056, 0.056, 0.024] }),
      'metal', P.metalHot, { only: ['chest', 'spine2'] });
    add(prim(new THREE.SphereGeometry(1, 10, 8), { pos: [0.052, 1.352, 0.182], scale: [0.014, 0.014, 0.009] }),
      'glow', P.glow, { only: ['chest', 'spine2'] });
  }

  // ── girdle ───────────────────────────────────────────────────────────────
  add(prim(new THREE.TorusGeometry(0.182, 0.031, 7, 30), { pos: [0, 0.948, 0.008], rot: [90, 0, 0], scale: [1, 1, 0.74] }),
    'cloth', P.leather, { only: ['pelvis', 'spine1'] });
  add(prim(new THREE.BoxGeometry(0.086, 0.070, 0.034), { pos: [0, 0.948, 0.140] }),
    'metal', P.metalHot, { only: ['pelvis', 'spine1'] });

  // ── pteruges (the chiton skirt) ──────────────────────────────────────────
  const NS = F.skirt | 0;
  for (let i = 0; i < NS; i++) {
    const a0 = (22.5 + i * (360 / NS)) * D2R;
    const arc = (360 / NS) * 0.66 * D2R;
    add(sheetGeo(5, 4, (u, v) => {
      const flare = 1 + 0.30 * u * u;
      const a = a0 + (v - 0.5) * arc * flare;
      const rr = lerp(0.158, 0.300, u * u * 0.45 + u * 0.55);
      const y = lerp(0.938, 0.446, u);
      return V(rr * Math.sin(a), y, rr * Math.cos(a));
    }, 0.017), 'cloth',
      (x, y) => (y < 0.478 ? P.metalHot : (y < 0.516 ? P.metal : (y < 0.560 ? P.clothDeep : P.cloth))),
      { only: ['pelvis', `skirt${i}A`, `skirt${i}B`], bias: { pelvis: 0.55 } });
  }

  // ── mantle / cape ────────────────────────────────────────────────────────
  if (F.cape) {
    add(sheetGeo(9, 12, (u, v) => {
      const e = u * u * 0.50 + u * 0.50;
      const half = lerp(0.94, 0.88, e);
      const R = lerp(0.215, 0.438, e);
      const zc = lerp(0.045, 0.085, e);
      let y = lerp(1.502, 0.520, e);
      if (u > 0.58) y += 0.062 * Math.sin(v * Math.PI * 3.0) * ((u - 0.58) / 0.42);
      const ang = (v - 0.5) * 2 * half + 0.10 * Math.sin(Math.PI * u) * (v - 0.5);
      return V(R * Math.sin(ang), y, zc - R * Math.cos(ang));
    }, 0.022), 'cloth',
      (x, y, z, u, v, side) => (side < 0 ? P.capeLine : (y < 0.64 ? '#2a1240' : P.cape)),
      { only: ['chest', 'capeA', 'capeB', 'capeC', 'capeD'], bias: { chest: 0.7 } });
  }

  // ── arms / hands / bracers ───────────────────────────────────────────────
  for (const s of [1, -1]) {
    const S = s > 0 ? 'L' : 'R';
    const spectral = (F.witchArm === 'left' && S === 'L') || (F.witchArm === 'right' && S === 'R');
    add(tubeGeo([
      { p: [0.232 * s, 1.470, 0.004], r: 0.090 },
      { p: [0.242 * s, 1.320, -0.004], r: 0.073 },
      { p: [0.245 * s, 1.155, -0.012], r: 0.059 },
      { p: [0.248 * s, 1.020, 0.000], r: 0.056 },
      { p: [0.250 * s, 0.910, 0.012], r: 0.047 },
    ], { radial: 12, capStart: 'round', capScale: 0.7, capEnd: 'flat' }), spectral ? 'glow' : 'skin',
      spectral ? ((x, y) => y < 1.19 ? P.glow : P.metalHot) : P.skin, { only: 'body' });
    // ── HAND ───────────────────────────────────────────────────────────────
    // WAS: one smooth-skinned stub tube — a chamfered block with no fingers and
    // no thumb, AND (the worse half of the bug) bound with `only:'body'` while
    // the xiphos beside it is bound rigid to handR. In any extended-arm pose the
    // two solve differently and the blade visibly detaches from the fist, which
    // is the single most important contour in an action game's attack frame.
    // NOW: a closed fist bound RIGID to the same hand bone the weapon uses, so
    // hand and blade are one shape by construction, plus a knuckle roll, three
    // finger ridges and an opposed thumb at 42deg off the fist axis.
    const HN = 'hand' + S;
    add(tubeGeo([
      { p: [0.249 * s, 0.900, 0.014], r: 0.040, sx: 1.02, sz: 0.74 },
      { p: [0.251 * s, 0.862, 0.026], r: 0.043, sx: 1.06, sz: 0.78 },
      { p: [0.252 * s, 0.822, 0.038], r: 0.038, sx: 1.02, sz: 0.76 },
      { p: [0.252 * s, 0.792, 0.048], r: 0.028, sx: 0.94, sz: 0.70 },
    ], { radial: 10, capStart: 'round', capEnd: 'round', capScale: 0.85 }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin,
      { mode: 'rigid', bone: HN });
    // knuckle roll across the front of the fist — the arris that catches the key
    add(tubeGeo([
      { p: [0.215 * s, 0.868, 0.052], r: 0.0125 },
      { p: [0.252 * s, 0.872, 0.058], r: 0.0135 },
      { p: [0.286 * s, 0.866, 0.050], r: 0.0115 },
    ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.metalHot : P.skin, { mode: 'rigid', bone: HN });
    // three finger ridges curling back under the grip
    for (let fi = 0; fi < 3; fi++) {
      const dx = (-0.026 + fi * 0.026) * s;
      add(tubeGeo([
        { p: [0.252 * s + dx, 0.866, 0.058], r: 0.0115 },
        { p: [0.253 * s + dx, 0.836, 0.056], r: 0.0110 },
        { p: [0.253 * s + dx, 0.812, 0.040], r: 0.0095 },
      ], { radial: 7, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.metalDeep : P.skinDeep, { mode: 'rigid', bone: HN });
    }
    // thumb — laid across the grip, 42deg off the fist axis
    add(tubeGeo([
      { p: [0.216 * s, 0.884, 0.030], r: 0.0155 },
      { p: [0.205 * s, 0.856, 0.052], r: 0.0140 },
      { p: [0.212 * s, 0.832, 0.068], r: 0.0105 },
    ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin, { mode: 'rigid', bone: HN });
    if (spectral) {
      for (let ri = 0; ri < 3; ri++) {
        add(prim(new THREE.TorusGeometry(0.064 - ri * 0.006, 0.007, 6, 18), {
          pos: [0.249 * s, 1.07 - ri * 0.075, 0.004], rot: [90, 0, 0],
        }), 'glow', ri === 1 ? P.metalHot : P.glow, { mode: 'rigid', bone: 'fore' + S });
      }
    }
    if (F.bracers) {
      add(tubeGeo([{ p: [0.247 * s, 1.118, -0.008], r: 0.068 }, { p: [0.250 * s, 0.938, 0.010], r: 0.061 }],
        { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metalDeep, { mode: 'rigid', bone: 'fore' + S });
      add(prim(new THREE.TorusGeometry(0.066, 0.0105, 6, 20), { pos: [0.247 * s, 1.112, -0.008], rot: [90, 0, 0] }),
        'metal', P.metalHot, { mode: 'rigid', bone: 'fore' + S });
      add(prim(new THREE.TorusGeometry(0.060, 0.0095, 6, 20), { pos: [0.250 * s, 0.944, 0.010], rot: [90, 0, 0] }),
        'metal', P.metalHot, { mode: 'rigid', bone: 'fore' + S });
    }
  }

  // ── legs / greaves / boots ───────────────────────────────────────────────
  for (const s of [1, -1]) {
    const S = s > 0 ? 'L' : 'R';
    add(tubeGeo([
      { p: [0.104 * s, 0.950, 0.004], r: 0.114 },
      { p: [0.110 * s, 0.750, -0.002], r: 0.094 },
      { p: [0.115 * s, 0.530, -0.008], r: 0.069 },
      { p: [0.118 * s, 0.350, -0.016], r: 0.072 },
      { p: [0.120 * s, 0.160, -0.026], r: 0.049 },
    ], { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'skin', P.skin, { only: 'body' });
    if (F.greaves) {
      add(tubeGeo([
        { p: [0.115 * s, 0.548, -0.004], r: 0.081, sz: 1.02 },
        { p: [0.118 * s, 0.372, -0.014], r: 0.082, sz: 1.02 },
        { p: [0.120 * s, 0.186, -0.024], r: 0.058, sz: 1.02 },
      ], { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metal, { mode: 'rigid', bone: 'shin' + S });
      add(prim(new THREE.SphereGeometry(1, 14, 10), { pos: [0.115 * s, 0.548, 0.006], scale: [0.084, 0.076, 0.086] }),
        'metal', P.metalHot, { mode: 'rigid', bone: 'shin' + S });
      add(prim(new THREE.TorusGeometry(0.062, 0.0095, 6, 20), { pos: [0.120 * s, 0.190, -0.024], rot: [90, 0, 0] }),
        'metal', P.metalHot, { mode: 'rigid', bone: 'shin' + S });
    }
    add(tubeGeo([
      { p: [0.120 * s, 0.118, -0.052], r: 0.052 },
      { p: [0.121 * s, 0.078, 0.014], r: 0.058, sx: 0.96 },
      { p: [0.122 * s, 0.056, 0.094], r: 0.052, sx: 0.90 },
      { p: [0.122 * s, 0.046, 0.152], r: 0.028, sx: 0.84 },
    ], { radial: 10, capStart: 'round', capEnd: 'round', capScale: 0.8 }), 'cloth', P.leather,
      { only: ['foot' + S, 'toe' + S, 'shin' + S] });
  }

  // ── xiphos (AGENT-COMBAT can hide this: rig.setWeaponVisible(false)) ─────
  if (F.weapon === 'xiphos') {
    const HB = 'handR';
    // Reseated so the grip runs THROUGH the fist (0.900..0.792) and the guard
    // sits just clear of the little finger: hand and hilt now share one
    // silhouette instead of the blade floating beside a block.
    add(tubeGeo([{ p: [-0.250, 0.922, 0.012], r: 0.019 }, { p: [-0.253, 0.800, 0.046], r: 0.017 }],
      { radial: 8, capStart: 'round', capEnd: 'flat' }), 'cloth', P.leather, { mode: 'rigid', bone: HB });
    add(prim(new THREE.SphereGeometry(1, 12, 10), { pos: [-0.249, 0.934, 0.008], scale: [0.028, 0.024, 0.028] }),
      'metal', P.metalHot, { mode: 'rigid', bone: HB });
    add(tubeGeo([{ p: [-0.309, 0.788, 0.048], r: 0.015, sx: 0.62, sz: 1.55 },
    { p: [-0.197, 0.788, 0.048], r: 0.015, sx: 0.62, sz: 1.55 }],
      { radial: 8, capStart: 'round', capEnd: 'round', up: [0, 1, 0] }), 'metal', P.metalHot, { mode: 'rigid', bone: HB });
    const base = V(-0.255, 0.776, 0.052);
    const dir = V(-0.115, -1, 0.30).normalize();
    const across = V(1, 0, 0.28).normalize();
    add(sheetGeo(10, 3, (u, v) => {
      const L = 0.60;
      const w = 0.058 * (0.52 + 0.48 * Math.sin(Math.PI * Math.pow(clamp01(u), 0.82))) * (1 - Math.pow(u, 3.4));
      return base.clone().addScaledVector(dir, L * u).addScaledVector(across, (v - 0.5) * 2 * w);
    }, 0.017), 'metal', (x, y, z, u, v, side) => (side === 0 ? P.bladeEdge : P.blade), { mode: 'rigid', bone: HB });
  }

  return parts;
}

// ---------------------------------------------------------------------------
// ASSEMBLY
// ---------------------------------------------------------------------------

function paintPart(g, tint, aoFn, H, k) {
  const pos = g.getAttribute('position'), uvA = g.getAttribute('uv'), sdA = g.getAttribute('side');
  const n = pos.count, col = new Float32Array(n * 3);
  const cache = new Map();
  const look = (hx) => { let c = cache.get(hx); if (!c) { c = linRGB(hx); cache.set(hx, c); } return c; };
  const isFn = typeof tint === 'function';
  const constC = isFn ? null : look(tint);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let c = constC;
    if (isFn) {
      const r = tint(x / k, y / k, z / k, uvA ? uvA.getX(i) : 0, uvA ? uvA.getY(i) : 0, sdA ? sdA.getX(i) : 1);
      c = Array.isArray(r) ? r : look(r);
    }
    let ao = aoAt(x / k, y / k, z / k, 1.90);
    if (aoFn) ao *= aoFn(x, y, z);
    col[i * 3] = c[0] * ao; col[i * 3 + 1] = c[1] * ao; col[i * 3 + 2] = c[2] * ao;
  }
  return col;
}

function mergeBuckets(buckets) {
  let nv = 0, ni = 0;
  for (const b of buckets) for (const p of b.items) {
    nv += p.g.getAttribute('position').count;
    ni += p.g.index ? p.g.index.count : p.g.getAttribute('position').count;
  }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const col = new Float32Array(nv * 3), si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  const groups = [];
  for (const b of buckets) {
    const start = io;
    for (const p of b.items) {
      const P = p.g.getAttribute('position'), N = p.g.getAttribute('normal'), U = p.g.getAttribute('uv');
      const c = P.count;
      pos.set(P.array.subarray(0, c * 3), vo * 3);
      nrm.set(N.array.subarray(0, c * 3), vo * 3);
      if (U) uv.set(U.array.subarray(0, c * 2), vo * 2);
      col.set(p.col, vo * 3);
      si.set(p.SI, vo * 4); sw.set(p.SW, vo * 4);
      if (p.g.index) { const a = p.g.index.array; for (let i = 0; i < a.length; i++) idx[io + i] = a[i] + vo; io += a.length; }
      else { for (let i = 0; i < c; i++) idx[io + i] = i + vo; io += c; }
      vo += c;
    }
    groups.push({ start, count: io - start });
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  for (let i = 0; i < groups.length; i++) g.addGroup(groups[i].start, groups[i].count, i);
  g.computeBoundingSphere();
  return g;
}

function slotMaterial(ctx, slot, spec) {
  const cfg = SLOT_MAT[slot];
  const opts = { color: '#ffffff', roughness: cfg.roughness, metalness: cfg.metalness };
  if (slot === 'glow') opts.glowKey = spec.palette.glow;
  if (spec.rim) { if (spec.rim.color) opts.rimColor = spec.rim.color; if (spec.rim.strength != null) opts.rimStrength = spec.rim.strength; }
  // NAME CARE: MaterialLibrary routes anything starting with "character" to the
  // painterly CHARACTER shader ONLY IF the name does not resolve to a recipe —
  // and ALIASES maps the bare key `character` to the `character.hero` texture
  // set. So `character.skin` silently resolved to that recipe and dressed the
  // whole hero in a tiled woven albedo (it read as a Greek-key hatch crawling
  // over the face at play distance). `characterrig.*` keeps the character
  // branch AND stays in mats.cache, so setBiome()/setRim() still reach us.
  let m = null;
  const key = 'characterrig.' + slot + (spec.matTag ? '.' + spec.matTag : '');
  // ── §7 / §1.4  THE CHARACTER IS A PAINTED ASSET ─────────────────────────
  // This block used to null out map/normalMap/roughnessMap/metalnessMap/aoMap
  // on every character material, on the reasoning that "the hero is shaded by
  // vertex colour + the painted ramp" and an unauthored texture was worse than
  // none. The result was a figure with no weave, no leather grain, no metal
  // wear, no painted crevice AO and no hand-placed highlight anywhere on it —
  // a critic panel measured it as the single biggest reason the build reads as
  // untextured, and it is a §7 auto-fail in its own right.
  //
  // The maps now EXIST and are art-directed: `characterrig.skin/cloth/hair/
  // metal` in materials/recipes.js. They are authored as MODULATORS around a
  // high-key neutral, so vertex colour still carries every family's identity
  // hue and the texture supplies value and material. cfg.repeat is how many
  // times that set wraps across a limb's cylindrical unwrap.
  if (cfg.repeat) opts.repeat = cfg.repeat;
  if (cfg.mapped) { opts.roughness = 1.0; opts.metalness = 1.0; }   // let ORM drive
  if (ctx && ctx.mats && ctx.mats.get) m = ctx.mats.get(key, opts);
  if (!m) m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: cfg.roughness, metalness: cfg.metalness });
  if (!m.map) { m.roughness = cfg.roughness; m.metalness = cfg.metalness; }
  m.vertexColors = true;
  // DITHERING OFF. MaterialLibrary.character() enables three's ordered dither,
  // which is correct for an 8-bit backbuffer and catastrophic here: it adds
  // +-0.5/255 in SCENE-LINEAR, and with middle grey at ~0.018 that is an 11%
  // perturbation per pixel. On the shadow side of a character it stops being a
  // dither and becomes a hard binary hatch. The post chain does its own grain.
  m.dithering = false;
  if (slot === 'cloth' || slot === 'glow') { m.side = THREE.DoubleSide; m.shadowSide = THREE.DoubleSide; }
  if (slot === 'glow') {
    m.emissive.setRGB(...hexToRgb(spec.palette.glow), THREE.SRGBColorSpace);
    m.emissiveIntensity = spec.glowIntensity ?? 4.0;
    m.toneMapped = true;
  }
  const tune = SLOT_PAINT[slot];
  if (tune) {
    setPaint(m, tune);
    // MaterialLibrary._applyRim republishes the rig's rim constant over every
    // character material. It honours userData.paintOverrides, so declare every
    // value we art-direct per slot — INCLUDING the colour and the direction,
    // which is what the frontal-fill / mint-green rim bug came down to.
    m.userData.paintOverrides = {
      ...(m.userData.paintOverrides || {}),
      rimStrength: tune.rimStrength, rimPower: tune.rimPower,
      rimColor: tune.rimColor, rimDir: tune.rimDir,
    };
  }
  m.needsUpdate = true;
  return m;
}

/**
 * Build a complete skinned humanoid from a spec.
 * @returns rig — see the agent report for the full surface.
 */
export function buildHumanoid(spec_, ctx) {
  const spec = mergeSpec(HERO_SPEC, spec_ || {});
  const def = skeletonDef(spec);
  const H = spec.height;

  // ── bones ────────────────────────────────────────────────────────────────
  const bones = {}, boneList = [], byName = new Map();
  const bodyNames = [];
  for (let i = 0; i < def.list.length; i++) {
    const d = def.list[i];
    const b = new THREE.Bone();
    b.name = d.name;
    const pp = d.parent ? def.list.find(x => x.name === d.parent).p : [0, 0, 0];
    b.position.set(d.p[0] - pp[0], d.p[1] - pp[1], d.p[2] - pp[2]);
    bones[d.name] = b; boneList.push(b);
    byName.set(d.name, { i, name: d.name, a: V(...d.p), b: V(...d.t), r: d.r, weight: d.weight, group: d.group, def: d });
    if (d.group === 'body') bodyNames.push(d.name);
  }
  for (const d of def.list) if (d.parent) bones[d.parent].add(bones[d.name]);
  const segs = [...byName.values()];

  // ── geometry ─────────────────────────────────────────────────────────────
  // buildParts() authors in the reference 1.90m space; skeletonDef() has
  // already scaled the bones, so the body has to follow or a spec with a
  // different `height` produces a mesh that does not fit its own skeleton.
  // (AGENT-ENEMY: this is what makes `height` a real knob on the roster.)
  const K = spec.height / 1.90;
  const parts = buildParts(spec);
  if (K !== 1) for (const p of parts) p.g.scale(K, K, K);
  const bucketMap = new Map();
  for (const p of parts) {
    const rule = { ...(p.bind || {}) };
    if (rule.only === 'body') rule.only = bodyNames;
    const P = p.g.getAttribute('position');
    const { SI, SW } = solveSkinWeights(P.array, segs, rule, byName);
    const col = paintPart(p.g, p.tint, p.ao, H, K);
    if (p.g.getAttribute('side')) p.g.deleteAttribute('side');
    if (!bucketMap.has(p.slot)) bucketMap.set(p.slot, []);
    bucketMap.get(p.slot).push({ g: p.g, col, SI, SW });
  }
  const buckets = SLOTS.filter(s => bucketMap.has(s)).map(s => ({ slot: s, items: bucketMap.get(s) }));
  const geo = mergeBuckets(buckets);
  const materials = buckets.map(b => slotMaterial(ctx, b.slot, spec));

  // ── skinned mesh ─────────────────────────────────────────────────────────
  const root = new THREE.Group();
  root.name = spec.name;
  const mesh = new THREE.SkinnedMesh(geo, materials);
  mesh.name = spec.name + '.body';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  root.add(mesh);
  mesh.add(bones.root);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);
  mesh.bind(skeleton);
  skeleton.pose();

  // ── cloth chains: resolved bone refs + rest axes for the spring solver ───
  const chains = def.chains.map(c => {
    const list = c.bones.map(n => bones[n]);
    const axis = c.bones.map((n, i) => {
      const s = byName.get(n);
      const child = i < c.bones.length - 1 ? byName.get(c.bones[i + 1]) : null;
      const tip = child ? child.a.clone().sub(s.a) : s.b.clone().sub(s.a);
      return { len: tip.length(), dir: tip.clone().normalize(), local: tip.clone() };
    });
    return { ...c, list, axis, root: bones[c.bones[0]].parent };
  });

  const bind = boneList.map(b => ({ p: b.position.clone(), q: b.quaternion.clone() }));

  const rig = {
    spec, height: H, root, mesh, skeleton, bones, boneList, byName, chains, bind, materials,
    /** attachment point for AGENT-COMBAT weapons / AGENT-VFX emitters */
    socket(boneName) {
      const b = bones[boneName]; if (!b) return null;
      const o = new THREE.Object3D(); o.name = 'socket.' + boneName; b.add(o); return o;
    },
    setWeaponVisible(v) { rig._weaponHidden = !v; },
    /** re-assert our per-slot painterly tuning (call after 'biome.changed') */
    retune() {
      for (let i = 0; i < buckets.length; i++) {
        const t = SLOT_PAINT[buckets[i].slot];
        if (t) setPaint(materials[i], t);
      }
      return rig;
    },
    /** frozen after-image copy: shares the geometry, owns a cloned skeleton */
    makeGhost(material) {
      const gb = {}, gl = [];
      for (const d of def.list) {
        const b = new THREE.Bone(); b.name = d.name;
        b.position.copy(bones[d.name].position);
        gb[d.name] = b; gl.push(b);
      }
      for (const d of def.list) if (d.parent) gb[d.parent].add(gb[d.name]);
      const gm = new THREE.SkinnedMesh(geo, material);
      gm.frustumCulled = false; gm.castShadow = false; gm.receiveShadow = false;
      gm.add(gb.root); gm.updateMatrixWorld(true);
      const gs = new THREE.Skeleton(gl, skeleton.boneInverses.map(m => m.clone()));
      gm.bind(gs);
      const grp = new THREE.Group(); grp.add(gm); grp.matrixAutoUpdate = false;
      return {
        group: grp, mesh: gm, skeleton: gs, bones: gb,
        capture(worldMatrix) {
          for (let i = 0; i < gl.length; i++) {
            gl[i].position.copy(boneList[i].position);
            gl[i].quaternion.copy(boneList[i].quaternion);
            gl[i].scale.copy(boneList[i].scale);
          }
          grp.matrix.copy(worldMatrix); grp.matrixWorldNeedsUpdate = true;
          grp.updateMatrixWorld(true); gs.update();
        },
      };
    },
    dispose() {
      geo.dispose();
      for (const m of materials) m.dispose?.();
    },
  };
  return rig;
}

export default { buildHumanoid, HERO_SPEC, HERO_PALETTE, MELINOE_SPEC, MELINOE_PALETTE, mergeSpec, tubeGeo, sheetGeo, prim, solveSkinWeights, linRGB };
