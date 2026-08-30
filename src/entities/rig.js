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
  // brow / lip / capeDeep were hard-coded inline before, which meant Melinoe
  // inherited a plum eyebrow and a violet cape shadow that belong to Zagreus.
  // A hero-specific hex authored inside buildParts() is a recolour waiting to
  // happen, and §14 says the two heirs must read as different SHAPES and
  // different COLOUR FAMILIES.
  brow:      '#2e1a3f',   // eyebrow + lash line: the darkest note on the face
  lip:       '#e0a086',
  capeDeep:  '#2a1240',   // the mantle's lower two-fifths — the ink anchor
};

export const HERO_SPEC = {
  name: 'erebus.hero',
  height: 2.05,
  // shoulder 1.06: measured on the hero shot the head spanned 0.48 of the
  // shoulder width where a Hades hero reads at 0.38-0.42. Half of that gap is
  // paid by the cranium trim in buildParts(), the other half by pushing the
  // clavicle out 6% — which now moves the arm MESH too, because SW is finally
  // threaded through the geometry.
  build: { shoulder: 1.06, limb: 1.0, bulk: 1.0 },
  palette: HERO_PALETTE,
  features: {
    pauldron: 'left',      // 'left' | 'right' | 'both' | 'none'
    crown: 'laurel',       // 'laurel' | 'none'
    cape: true,
    skirt: 8,              // number of pteruges panels (0 = none)
    greaves: true,
    bracers: true,
    harness: true,
    hair: 'swept',         // 'swept' | 'short' | 'long' | 'none'
    bodice: false,         // Zagreus is bare-chested; Melinoe is not
    witchArm: 'none',      // 'left' | 'right' | 'none'
    eyes: true,
    // Which hand is NOT making a fist. Both hands used to be the identical
    // closed grip, so a character standing with nothing in either hand still
    // held two invisible weapons — the clearest "puppet" tell on the model.
    openHand: 'left',
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
  // 0.30 still clipped: in 03_hero_char the irises rendered as two blown WHITE
  // discs with a bloom halo twice their geometric size — "two glowing dots",
  // which §b names as an outright fail. Part of that was the rim wash landing
  // on them as well (fixed in SLOT_PAINT below); the rest is that a 26mm
  // emissive on a 300mm head only needs to be the brightest note on the FACE,
  // not in the frame. 0.22 keeps it above the skin's specular and under the
  // bloom threshold.
  glowIntensity: 0.22,
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
  brow:      '#6b6152',   // warm ash: a plum brow on a bone-blonde head reads wrong
  lip:       '#e0a894',
  capeDeep:  '#0b1615',
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
    // 'long' adds a third hair bone and drops the nape mass to mid-back. It is
    // the cheapest way to make the two heirs different BLACK SHAPES (§14): at
    // 1/8 resolution a crown-height difference of 3cm is invisible, a 40cm
    // difference in hair length is not.
    hair: 'long',
    bodice: true,
    witchArm: 'left',
    eyes: true,
    // 'left' for both heirs: player-weapons.js mounts the blade, spear, fists,
    // rail, staff and axe on handR, so the RIGHT hand is the one that has to
    // keep a closed grip. Melinoe's open hand is also her witch arm, which is
    // where the spectral rings and the cast VFX live.
    openHand: 'left',
    weapon: 'none',
  },
  glowIntensity: 0.28,
  rim: { color: '#84f2c8', strength: 2.3 },
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
    if (spec.features.hair === 'long') {
      // A long mane needs a third link or it swings as one rigid plank. Lower
      // stiffness down the chain so the tip trails the root (overlap), which is
      // the whole reason secondary motion is worth solving at all.
      add('hairC', 'hairB', [0, 1.548, -0.246], [0, 1.310, -0.262], 0.100, 'hair');
      chains.push({ name: 'hair', bones: ['hairA', 'hairB', 'hairC'], stiff: 24, damp: 5.4, grav: 3.6, inertia: 0.8, maxAng: 0.50 });
    } else {
      chains.push({ name: 'hair', bones: ['hairA', 'hairB'], stiff: 34, damp: 7.0, grav: 2.4, inertia: 0.5, maxAng: 0.42 });
    }
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
  { p: [0.057, 1.704, 0.127], r: 0.068, k: 0.80 }, // eye socket L
  { p: [-0.057, 1.704, 0.127], r: 0.068, k: 0.80 }, // eye socket R
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
  { p: [0, 1.010, 0.140], r: 0.090, k: 0.30 },  // linea alba, below the navel

  // ── ROUND-5 ADDITIONS ────────────────────────────────────────────────────
  // Audited against the rendered hero shot rather than the list: every crevice
  // below was a place where two forms MEET and the frame showed one continuous
  // lit value across the join. Painted AO is what makes a procedural body read
  // as sculpted (§4); a join with no darkening is the plastic-toy tell.
  { p: [0, 1.330, 0.150], r: 0.075, k: 0.44 },  // sternum groove between the pecs
  { p: [0.076, 1.300, 0.132], r: 0.078, k: 0.38 },  // under the pectoral L
  { p: [-0.076, 1.300, 0.132], r: 0.078, k: 0.38 },  // under the pectoral R
  { p: [0.058, 1.462, 0.086], r: 0.062, k: 0.40 },  // clavicle pit L
  { p: [-0.058, 1.462, 0.086], r: 0.062, k: 0.40 },  // clavicle pit R
  { p: [0.246, 1.300, 0.000], r: 0.098, k: 0.40 },  // under the pauldron lames L
  { p: [-0.246, 1.300, 0.000], r: 0.098, k: 0.40 },  // under the pauldron lames R
  { p: [0.168, 1.446, -0.120], r: 0.130, k: 0.34 },  // under the mantle at the shoulder L
  { p: [-0.168, 1.446, -0.120], r: 0.130, k: 0.34 },  // under the mantle at the shoulder R
  { p: [0, 0.906, 0.000], r: 0.215, k: 0.30 },  // inside the girdle / under the belt
  { p: [0, 0.836, 0.000], r: 0.235, k: 0.20 },  // where the pteruges overlap the hip
  { p: [0.250, 0.930, 0.006], r: 0.058, k: 0.30 },  // under the bracer cuff L
  { p: [-0.250, 0.930, 0.006], r: 0.058, k: 0.30 },  // under the bracer cuff R
  { p: [0.120, 0.172, -0.018], r: 0.068, k: 0.30 },  // boot top / greave hem L
  { p: [-0.120, 0.172, -0.018], r: 0.068, k: 0.30 },  // boot top / greave hem R
  // FACE, second pass. The jaw, the ear and the hairline are three new form
  // junctions on the head; without their shadows the new geometry would just
  // be extra lit surface, which at 90px is worse than none.
  { p: [0.142, 1.660, 0.010], r: 0.058, k: 0.36 },  // ear-to-jaw notch L
  { p: [-0.142, 1.660, 0.010], r: 0.058, k: 0.36 },  // ear-to-jaw notch R
  { p: [0, 1.622, 0.150], r: 0.030, k: 0.40 },  // under the lower lip
  { p: [0.130, 1.744, 0.058], r: 0.058, k: 0.32 },  // temple L
  { p: [-0.130, 1.744, 0.058], r: 0.058, k: 0.32 },  // temple R
  { p: [0, 1.790, 0.128], r: 0.082, k: 0.30 },  // hairline shadow on the forehead
  { p: [0, 1.560, 0.084], r: 0.088, k: 0.32 },  // under the jaw, into the throat
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
//    ── ROUND-5 CORRECTION, AND IT OVERRULES THE PARAGRAPH ABOVE ────────────
//    rimStrength is NOT only a multiplier on the additive. painterly.js:921
//    reads
//        pLitCol *= mix( vec3(1.0), vec3(0.42, 0.82, 1.06), clamp(rimK*3.2,0,1) )
//    with rimK = fres * gate * uRimStrength * shBoost. That is a KEY-SUPPRESSION
//    multiply — it cuts red to 42% and lifts blue — and because of the clamp it
//    SATURATES. Solve for where it reaches 1 at the shipped numbers
//    (strength 10.4, rimPower 1.75, gate ~0.70): fres >= 0.0275, i.e. every
//    normal more than 33 DEGREES off the view vector. On a rounded figure that
//    is ~85% of the visible surface, so the "rim" was not a rim at all — it was
//    a global desaturating blue wash over the whole character, and it is the
//    single reason the hero rendered as a pale ice-blue snowman in 03_hero_char
//    while his authored #e8bd93 skin never reached the frame. The shader's own
//    comment records the same failure at rimK*5.0 and fixes it by cutting the
//    multiplier from 5.0 to 3.2; raising rimStrength 4x here more than undid it.
//    THE FIX IS DISTRIBUTION, NOT ENERGY — the same conclusion painterly.js
//    reached about the additive. Cut the strength ~5x and RAISE rimPower so the
//    fresnel band is narrow: at strength 1.9 / power 3.3 the suppression only
//    saturates outside a 69-degree cone, i.e. in the outer ~20 degrees of the
//    form, which IS the contour, and the additive at the contour lands at 0.29
//    scene-linear instead of 1.88 — under AgX's shoulder, so it arrives as a
//    saturated periwinkle edge rather than as white.
//    (Both numbers were computed against painterly.js:860/888/921 before being
//    changed, not swept: the cone angle is acos(1 - ((1/3.2)/(gate*strength))^
//    (1/power)) and the additive is 0.9^power * gate * strength * 1.16 * keyRef
//    * 0.026 with keyRef ~10.3.)
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
// ── ROUND-5: THE COOL HALF WAS TEAL, AND IT WAS DELETING THE INK ANCHORS ────
// The paragraph above is right that the shadow side of a fire-lit character
// must go COLD. The multiply it shipped does not do that; it does something
// else, and the hero shot shows it plainly.
//
// ARITHMETIC. The mantle's albedo #3d1a5c is linear (0.047, 0.010, 0.110).
// cloth.shadowTint multiplied its blue by 1.90 -> 0.208, i.e. the SHADOW side
// of the cape came back nearly twice as bright in blue as the cape's own lit
// albedo. The same term on skin (0.82, 0.55, 0.35) returns (0.246, 0.396,
// 0.623): green above red, which is hue ~215 — TEAL. §1.3 mandates 240-320
// (indigo / violet / black-plum) and §7 hard-bans neutral/greyed shadow; a
// hue-215 shadow is neither of those things, it is a second light in cyan.
//
// WHAT THE FRAME SHOWED. In 03_hero_char the mantle, the boots and the hair —
// the three surfaces this file's own header calls "the ink anchors that keep
// the silhouette readable" — rendered as the palest, coolest masses on the
// character, paler than the skin they are supposed to frame. The hero read as
// a pale-blue snowman in a bathrobe and the §14 black-shape test had nothing
// to separate figure from cape.
//
// THE FIX, and what it is NOT. The cool half stays: every slot still multiplies
// its shadow by a strongly blue-weighted vector, so the terminator still meets
// a warm key with an opposed hue over a third of the character (the thing the
// paragraph above was protecting). What changes is that RED now leads GREEN, so
// the shadow lands at hue 285-295 — a rich violet, §15.3's "a violet shadow
// should be a RICH violet" — and the blue gain drops from 1.90 to ~1.30 so a
// dark albedo stays dark. ambGain comes down on cloth and hair for the same
// reason: a hemisphere wash lifts every normal equally, and on the two darkest
// slots that wash IS the reason they stopped being dark.
export const SLOT_PAINT = {
  skin: {
    litGain: 0.49, ambGain: 0.44, specGain: 0.22, rimStrength: 1.90, rimPower: 3.30, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.52, 0.38, 1.35],
    rampLevels: [0.27, 0.50, 0.92], rampSteps: [0.30, 0.58], rampSoftness: 0.07, rampStrength: 0.60, shadowDepth: 0.86,
    contourStrength: 0.82, contourStart: 0.54,
  },
  cloth: {
    litGain: 0.47, ambGain: 0.37, specGain: 0.18, rimStrength: 2.20, rimPower: 3.20, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.46, 0.34, 1.30],
    rampLevels: [0.26, 0.49, 0.94], rampSteps: [0.30, 0.58], rampSoftness: 0.08, rampStrength: 0.58, shadowDepth: 0.90,
    contourStrength: 0.95, contourStart: 0.50,
  },
  hair: {
    litGain: 0.42, ambGain: 0.33, specGain: 0.16, rimStrength: 2.40, rimPower: 3.10, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.44, 0.32, 1.32],
    rampLevels: [0.20, 0.41, 0.86], rampSteps: [0.28, 0.56], rampSoftness: 0.07, rampStrength: 0.60, shadowDepth: 0.92,
    contourStrength: 1.00, contourStart: 0.48,
  },
  // METAL is the character's own highlight band (§9.3/§9.5): the gold lames,
  // the gorget, the greaves and the blade are the only pixels on the hero
  // allowed to reach genuine white, and they get there on a small sharp
  // SPECULAR glint (§4), not on a raised diffuse.
  metal: {
    litGain: 0.56, ambGain: 0.40, specGain: 0.68, rimStrength: 1.70, rimPower: 3.50, rimGate: RIM_GATE,
    rimColor: RIM_HEX, rimDir: RIM_DIR, shadowTint: [0.60, 0.46, 1.24],
    rampLevels: [0.26, 0.58, 1.00], rampSteps: [0.30, 0.56], rampSoftness: 0.055, rampStrength: 0.55, shadowDepth: 0.74,
    contourStrength: 0.70, contourStart: 0.56,
  },
  glow: { litGain: 0.22, ambGain: 0.30, specGain: 0.16, rimStrength: 0.30, rimPower: 2.30, rimDir: RIM_DIR },
};

function buildParts(spec) {
  const P = spec.palette, F = spec.features;
  const k = spec.height / 1.90;
  // ── BUILD KNOBS ARE NOW REAL ────────────────────────────────────────────
  // `build.shoulder` and `build.bulk` were declared on every spec and read by
  // NOBODY: skeletonDef() scaled the clavicle/arm BONES by `shoulder` while
  // buildParts() authored the arm mesh at a fixed 0.232-0.250, so Melinoe's
  // arms hung 28mm outboard of her own skeleton and her "narrower build" was
  // a comment rather than a silhouette. SW/BK below are threaded through every
  // lateral offset and every limb radius, which is what makes the two heirs
  // distinguishable as black shapes (§14 subject test) instead of recolours.
  const SW = spec.build?.shoulder ?? 1;   // lateral scale: shoulders, arms, ornament
  const BK = spec.build?.bulk ?? 1;       // mass scale: limb and torso radii
  const parts = [];
  const add = (g, slot, tint, bind, ao) => { parts.push({ g, slot, tint, bind, ao }); return g; };
  const RH = { mode: 'rigid', bone: 'head' };
  const brow = P.brow || P.hair;

  /**
   * A swept BAND around a vertical axis — belts, pauldron lames, cuffs,
   * circlets. tubeGeo's frame puts N horizontal-radial and B vertical for a
   * horizontal spine, so `th` is the plate's THICKNESS and `hh` its HEIGHT.
   * That is exactly the difference between armour and the TorusGeometry rolls
   * this replaces: a torus tube is CIRCULAR, so its lit edge is a rounded
   * sausage with no arris for §4's "small, bright, sharp glint" to sit on. A
   * band has two arrises, and the tint callback can put gold on them (u is the
   * angle around the section: 0 inner, 0.25 top, 0.5 outer, 0.75 bottom).
   */
  const band = (o) => {
    const N = o.seg ?? 26, A0 = (o.a0 ?? 0) * D2R, A1 = (o.a1 ?? 360) * D2R;
    const spine = [];
    for (let i = 0; i < N; i++) {
      const t = N > 1 ? i / (N - 1) : 0, a = lerp(A0, A1, t);
      const prof = o.prof ? o.prof(t) : 1;
      const R = (o.R ?? 0.18) * (o.rx ? o.rx(a) : 1);
      spine.push({
        p: [(o.cx ?? 0) + R * Math.sin(a) * (o.ex ?? 1),
        (o.cy ?? 0) + (o.dy ? o.dy(a) : 0),
        (o.cz ?? 0) + R * Math.cos(a) * (o.ez ?? 1)],
        r: 1, sx: o.th, sz: o.hh * prof,
      });
    }
    return tubeGeo(spine, {
      radial: o.radial ?? 10, up: [0, 1, 0],
      capStart: o.cap ?? 'flat', capEnd: o.cap ?? 'flat',
    });
  };
  // gold on both arrises, the plate's own metal on the faces, ink underneath.
  // The hot band was 32% of the section, which at play scale is not an arris —
  // it is a pale sausage, and that is exactly how the three pauldron lames read
  // in 03_hero_char. 18% keeps a lit LINE on each edge with the plate's own
  // metal between them, which is what §4's "small, bright, sharp glint" means.
  const chamfer = (hot, face, deep) => (x, y, z, u) =>
    ((u > 0.205 && u < 0.295) || (u > 0.705 && u < 0.795)) ? hot
      : ((u < 0.12 || u > 0.88) ? deep : face);

  // ── torso ────────────────────────────────────────────────────────────────
  // A hero's torso is a WEDGE: wide deltoid shelf, cut waist, flared iliac.
  // sx at the chest rides SW so a narrow-build spec actually narrows.
  const tsx = (v) => v * lerp(1, SW, 0.72), tr = (v) => v * lerp(1, BK, 0.80);
  add(tubeGeo([
    { p: [0, 0.920, 0.004], r: tr(0.152), sx: 1.26, sz: 0.86 },
    { p: [0, 0.985, 0.006], r: tr(0.160), sx: 1.28, sz: 0.84 },
    { p: [0, 1.100, 0.010], r: tr(0.134), sx: 1.20, sz: 0.82 },   // waist, cut 4%
    { p: [0, 1.235, 0.014], r: tr(0.164), sx: 1.30, sz: 0.83 },
    { p: [0, 1.330, 0.016], r: tr(0.182), sx: tsx(1.34), sz: 0.82 },
    { p: [0, 1.400, 0.014], r: tr(0.193), sx: tsx(1.42), sz: 0.79 },
    { p: [0, 1.468, 0.006], r: tr(0.182), sx: tsx(1.56), sz: 0.73 },
    { p: [0, 1.520, 0.004], r: tr(0.108), sx: 1.14, sz: 0.94 },
  ], { radial: 20, capStart: 'round', capScale: 0.9, capEnd: 'flat' }), 'skin', P.skin, { only: 'torso' });

  // PECTORALS + trapezius. The chest was one smooth tube, so the largest lit
  // surface on the character carried no form at all and the harness strap read
  // as a stripe painted on a barrel. Two shallow plates and the sternum crevice
  // give the key something to break over.
  for (const s of [1, -1]) {
    add(prim(new THREE.SphereGeometry(1, 14, 10),
      { pos: [0.078 * SW * s, 1.366, 0.104], rot: [0, 0, -11 * s], scale: [0.106 * SW, 0.046, 0.062] }),
      'skin', P.skin, { only: 'torso' });
    // trapezius: the neck-to-shoulder slope. Without it the head sat on a flat
    // shelf and the neck sheared visibly whenever the head turned.
    add(tubeGeo([
      { p: [0.026 * s, 1.512, -0.010], r: 0.040, sx: 1.0, sz: 0.72 },
      { p: [0.104 * SW * s, 1.482, -0.006], r: 0.046, sx: 1.0, sz: 0.72 },
      { p: [0.186 * SW * s, 1.452, 0.000], r: 0.040, sx: 1.0, sz: 0.72 },
    ], { radial: 8, capStart: 'round', capEnd: 'round' }), 'skin', P.skin,
      { only: ['chest', 'neck', 'clavL', 'clavR'], bias: { chest: 1.4 } });
  }

  // BODICE. HERO_SPEC's torso is bare (Zagreus is), and MELINOE_SPEC inherited
  // that verbatim — so her spec's "different cloth" amounted to a skirt and a
  // cape over an identical naked torso. A clad chest is also the fastest value
  // break available on the upper body: dark cloth under a bright face.
  if (F.bodice) {
    add(tubeGeo([
      { p: [0, 0.985, 0.006], r: tr(0.166), sx: 1.28, sz: 0.84 },
      { p: [0, 1.100, 0.010], r: tr(0.140), sx: 1.20, sz: 0.82 },
      { p: [0, 1.235, 0.014], r: tr(0.170), sx: 1.30, sz: 0.83 },
      { p: [0, 1.330, 0.016], r: tr(0.188), sx: tsx(1.34), sz: 0.82 },
      { p: [0, 1.408, 0.014], r: tr(0.198), sx: tsx(1.42), sz: 0.79 },
      { p: [0, 1.452, 0.008], r: tr(0.188), sx: tsx(1.52), sz: 0.74 },
    ], { radial: 20, capStart: 'flat', capEnd: 'flat' }), 'cloth',
      (x, y) => ((y > 1.436 || y < 1.000) ? P.metalDeep : (y < 1.14 ? P.clothDeep : P.cloth)),
      { only: 'torso' });
  }

  // ILIAC CREST — the "V" that runs from the hip point down under the girdle.
  // On a bare-chested figure it is the only form between the navel and the belt
  // and without it the abdomen is 25cm of unbroken lit skin, which is the
  // largest featureless surface anywhere on the character.
  for (const s of [1, -1]) add(tubeGeo([
    { p: [0.126 * s, 1.010, 0.086], r: 0.0135, sx: 0.70, sz: 0.80 },
    { p: [0.086 * s, 0.960, 0.128], r: 0.0150, sx: 0.70, sz: 0.80 },
    { p: [0.034 * s, 0.916, 0.142], r: 0.0110, sx: 0.70, sz: 0.80 },
  ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, { only: 'torso' });

  add(tubeGeo([{ p: [0, 1.470, 0.004], r: 0.074 }, { p: [0, 1.610, 0.008], r: 0.069 }],
    { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'skin', P.skin, { only: 'torso' });

  // ═══ HEAD ════════════════════════════════════════════════════════════════
  // §4: the face must carry information at 90px. At the hero framing the head
  // is ~90px tall, so every feature here is sized against that: a 3mm form on a
  // 0.35m head is 0.8px and is therefore not worth authoring, while a 15mm
  // plane change is 4px and is the entire difference between a face and an egg.
  // CRANIUM. Measured on the rendered hero shot the figure stood 5.55 HEADS
  // tall (chin 1.556 to hair crest 1.898 = 0.342 on a 1.90 body); Hades and
  // Hades II both sit at 6.5-7, and 5.5 is the proportion of a chibi. The
  // braincase — not the face — is where the excess was: trimming the skull's
  // half-axes 0.177 -> 0.164 in Y and 0.157 -> 0.151 in X takes the top of the
  // head down 13mm and the width down 12mm WITHOUT moving a single facial
  // landmark, which is the only version of this fix that does not cost the
  // face its 90px legibility.
  add(prim(new THREE.SphereGeometry(1, 24, 18), { pos: [0, 1.690, 0.008], scale: [0.151, 0.164, 0.158] }),
    'skin', P.skin, RH);
  // JAW. Was a 0.256m-wide sphere — as wide as the cranium, which is precisely
  // what made the head read as a lit egg with dots on it. A jaw is NARROWER
  // than the skull and it has a corner; the mass is cut 12% and the gonial
  // angle is authored explicitly by the mandible tube below.
  add(prim(new THREE.SphereGeometry(1, 20, 14), { pos: [0, 1.640, 0.046], scale: [0.111, 0.079, 0.116] }),
    'skin', P.skin, RH);
  for (const s of [1, -1]) {
    // mandible: gonial angle under the ear -> along the jaw -> chin. A lit
    // arris here is what separates head from neck at play distance.
    add(tubeGeo([
      { p: [0.117 * s, 1.680, -0.016], r: 0.0150, sx: 0.66, sz: 1.0 },
      { p: [0.112 * s, 1.628, 0.024], r: 0.0158, sx: 0.66, sz: 1.0 },
      { p: [0.080 * s, 1.602, 0.098], r: 0.0146, sx: 0.78, sz: 1.0 },
      { p: [0.025 * s, 1.592, 0.140], r: 0.0126, sx: 0.90, sz: 1.0 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
    // zygomatic arch. The CREVICE table already darkened "the plane under the
    // cheekbone"; there was no cheekbone, so the shadow had nothing to be under.
    add(tubeGeo([
      { p: [0.134 * s, 1.702, 0.006], r: 0.0180, sx: 0.58, sz: 0.82 },
      { p: [0.114 * s, 1.696, 0.084], r: 0.0200, sx: 0.58, sz: 0.82 },
      { p: [0.068 * s, 1.688, 0.134], r: 0.0150, sx: 0.58, sz: 0.82 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
    // EARS. There were none. An earless head is the loudest mannequin cue there
    // is, and the ear is the only thing that breaks the skull's circle in
    // profile — i.e. it is half of the run-cycle silhouette.
    add(prim(new THREE.SphereGeometry(1, 10, 10),
      { pos: [0.150 * s, 1.688, -0.014], rot: [0, -16 * s, -9 * s], scale: [0.015, 0.038, 0.028] }),
      'skin', P.skin, RH);
    add(tubeGeo([
      { p: [0.156 * s, 1.704, -0.004], r: 0.0050, sx: 0.7, sz: 1.0 },
      { p: [0.161 * s, 1.686, -0.018], r: 0.0050, sx: 0.7, sz: 1.0 },
      { p: [0.154 * s, 1.670, -0.008], r: 0.0042, sx: 0.7, sz: 1.0 },
    ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, RH);
  }
  // chin
  add(prim(new THREE.SphereGeometry(1, 12, 10), { pos: [0, 1.598, 0.140], scale: [0.036, 0.028, 0.029] }),
    'skin', P.skin, RH);
  // NOSE — bridge, tip, nostril wings. The old part was a single 24mm tube:
  // a peg. The "under the nose" crevice needs a tip to sit under.
  add(tubeGeo([
    { p: [0, 1.7320, 0.1310], r: 0.0098, sx: 0.80, sz: 0.90 },
    { p: [0, 1.7080, 0.1500], r: 0.0130, sx: 0.82, sz: 0.90 },
    { p: [0, 1.6870, 0.1720], r: 0.0180, sx: 0.94, sz: 0.98 },
    { p: [0, 1.6710, 0.1635], r: 0.0140, sx: 1.08, sz: 0.82 },
  ], { radial: 8, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
  for (const s of [1, -1])
    add(prim(new THREE.SphereGeometry(1, 8, 6), { pos: [0.0195 * s, 1.6765, 0.1565], scale: [0.0125, 0.0105, 0.0140] }),
      'skin', P.skin, RH);
  // BROW. Was ONE straight horizontal skinDeep bar spanning the whole forehead:
  // at a 90px head that is a 4px dark plank and it read as a headband, not a
  // brow — and it was doing the eyebrow's job in the eyebrow's colour, so the
  // face had no separate expression line at all. Now the ridge is SKIN (a proud
  // form that catches the key, with the socket crevice supplying its shadow)
  // and the eyebrow is its own thin dark line above it, angled so the two ends
  // of the face are not parallel.
  for (const s of [1, -1]) {
    add(tubeGeo([
      { p: [0.014 * s, 1.7215, 0.1470], r: 0.0130, sx: 0.85, sz: 0.70 },
      { p: [0.060 * s, 1.7300, 0.1360], r: 0.0158, sx: 0.85, sz: 0.70 },
      { p: [0.107 * s, 1.7185, 0.0930], r: 0.0120, sx: 0.85, sz: 0.70 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
    add(tubeGeo([
      { p: [0.018 * s, 1.7350, 0.1490], r: 0.0058, sx: 1.0, sz: 0.52 },
      { p: [0.063 * s, 1.7430, 0.1375], r: 0.0074, sx: 1.0, sz: 0.52 },
      { p: [0.110 * s, 1.7280, 0.0935], r: 0.0046, sx: 1.0, sz: 0.52 },
    ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'hair', brow, RH);
  }

  // ── EYES ─────────────────────────────────────────────────────────────────
  // Four parts per eye: a dark almond socket, an iris HALF the socket's width,
  // a lash line and a lower lid. Measured at the hero framing the socket is
  // ~8px wide and the iris ~3px — a dark almond with a bright point in it,
  // where the previous 2:3 iris-to-socket ratio was a lamp with a rim.
  if (F.eyes) for (const s of [1, -1]) {
    // SOCKET SPACING is measured, not eyeballed: the face is 0.302 wide at eye
    // level and the canonical division is five eye-widths across it, so an eye
    // is 0.060 wide and the two centres sit 0.060 apart — i.e. at +-0.058, not
    // the +-0.0485 that left a half-eye gap and read as a doll.
    // The socket is tinted BROW, not skinDeep: #a8654a is a warm orange-brown
    // and at 90px it rendered as a ring around the iris, so each eye read as a
    // pair of goggles. A socket has to be the darkest note on the face or the
    // iris has nothing to be bright against.
    add(prim(new THREE.SphereGeometry(1, 12, 8), { pos: [0.0575 * s, 1.7050, 0.1500], rot: [0, 0, -10 * s], scale: [0.0300, 0.0170, 0.0140] }),
      'hair', brow, RH);
    add(prim(new THREE.SphereGeometry(1, 10, 8), { pos: [0.0565 * s, 1.7040, 0.1560], rot: [0, 0, -10 * s], scale: [0.0132, 0.0122, 0.0110] }),
      'glow', P.glow, RH);
    // lash line
    add(tubeGeo([
      { p: [0.028 * s, 1.7140, 0.1425], r: 0.0050, sx: 1.0, sz: 0.58 },
      { p: [0.057 * s, 1.7195, 0.1520], r: 0.0074, sx: 1.0, sz: 0.58 },
      { p: [0.088 * s, 1.7120, 0.1330], r: 0.0046, sx: 1.0, sz: 0.58 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'hair', brow, RH);
    // lower lid: a proud skin roll. It is the catch-light that stops the eye
    // from reading as a hole punched in the head.
    add(tubeGeo([
      { p: [0.031 * s, 1.6955, 0.1410], r: 0.0052, sx: 1.0, sz: 0.50 },
      { p: [0.057 * s, 1.6935, 0.1495], r: 0.0064, sx: 1.0, sz: 0.50 },
      { p: [0.085 * s, 1.6955, 0.1320], r: 0.0044, sx: 1.0, sz: 0.50 },
    ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
  }
  // MOUTH — the closed line, and a proud lower lip that carries the catch-light.
  add(tubeGeo([
    { p: [-0.034, 1.6440, 0.1580], r: 0.0060, sx: 1.0, sz: 0.55 },
    { p: [0, 1.6465, 0.1690], r: 0.0082, sx: 1.0, sz: 0.55 },
    { p: [0.034, 1.6440, 0.1580], r: 0.0060, sx: 1.0, sz: 0.55 },
  ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, RH);
  add(tubeGeo([
    { p: [-0.025, 1.6355, 0.1570], r: 0.0070, sx: 1.0, sz: 0.50 },
    { p: [0, 1.6365, 0.1660], r: 0.0092, sx: 1.0, sz: 0.50 },
    { p: [0.025, 1.6355, 0.1570], r: 0.0070, sx: 1.0, sz: 0.50 },
  ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.lip || P.skin, RH);

  // ── HAIR ─────────────────────────────────────────────────────────────────
  // WAS: a cap whose `vol` term inflated the wrap ellipsoid to 1.38x on top of
  // HR (0.180, 0.198, 0.190) — a 0.50m-wide mass on a 0.32m skull, reaching
  // z 0.196 when the face's own front plane is at z 0.147, i.e. a 5cm BRIM
  // hanging over the eyes. Measured against the skull's half-axes it was 1.55x;
  // in the 1/8 black-shape test (§14) the head-plus-hair blob was 60% of the
  // shoulder width and the figure read as a mushroom, and the laurel crown —
  // the only gold on the head — was authored at radius 0.172 INSIDE a 0.222
  // hair mass and never reached the frame at all.
  // NOW: the cap hugs the skull (peak 1.19x at the nape, 1.05x at the hairline),
  // the hairline sits 7cm above the brow so there is a lit forehead, and the
  // volume that used to be a dome is spent on directional locks that BREAK the
  // circle — which is what a silhouette is made of.
  if (F.hair !== 'none') {
    const LONG = F.hair === 'long';
    const HC = V(0, 1.690, -0.004), HR = V(0.164, 0.174, 0.170);
    add(sheetGeo(6, 24, (u, v) => {
      const phi = (v - 0.5) * TAU;
      const back = (1 - Math.cos(phi)) * 0.5;
      // thMax at the FRONT is the hairline. 0.99 rad put it at y 1.796 — 7cm
      // of bare forehead above the brow, which reads as balding, not as swept
      // hair. 1.17 lands it a third of the way down the face.
      // The exponent is solved, not tuned: a LINEAR blend put the side hairline
      // at y 1.652 and swallowed both ears whole (the ear spans 1.650-1.726),
      // which threw away the geometry added to break the skull's profile
      // circle. back^2.16 puts it at 1.716 — over the top of the ear, lobe
      // exposed — while leaving the nape unchanged at back = 1.
      const thMax = lerp(1.17, 2.36, Math.pow(back, 2.16));
      const th = Math.max(0.001, u * thMax);
      const vol = 1.03 + 0.16 * clamp01((th - 0.75) * 1.15) * (0.30 + 0.70 * back);
      // a shallow centre parting: the crown is a valley, not a dome
      const part = 1 - 0.045 * Math.exp(-Math.pow((phi) / 0.55, 2)) * clamp01((0.9 - th) * 2.4);
      return V(HC.x + HR.x * vol * Math.sin(th) * Math.sin(phi),
        HC.y + HR.y * vol * part * Math.cos(th),
        HC.z + HR.z * vol * Math.sin(th) * Math.cos(phi) - 0.030 * back * u);
    }, 0.020), 'hair', (x, y, z, u) => (u > 0.86 ? P.hairTip : P.hair), { only: ['head', 'hairA'], bias: { head: 3.0 } });

    // nape mass — a tapered wedge, not the fat sausage that used to weld itself
    // to the cap and read as one purple boulder in profile.
    add(tubeGeo(LONG ? [
      { p: [0, 1.748, -0.112], r: 0.100, sx: 1.02, sz: 0.86 },
      { p: [0, 1.672, -0.172], r: 0.098, sx: 1.02, sz: 0.78 },
      { p: [0, 1.560, -0.212], r: 0.092, sx: 1.00, sz: 0.68 },
      { p: [0, 1.420, -0.238], r: 0.080, sx: 0.96, sz: 0.60 },
      { p: [0, 1.286, -0.256], r: 0.056, sx: 0.88, sz: 0.54 },
      { p: [0, 1.180, -0.264], r: 0.020, sx: 0.78, sz: 0.48 },
    ] : [
      { p: [0, 1.746, -0.114], r: 0.102, sx: 1.02, sz: 0.86 },
      { p: [0, 1.682, -0.172], r: 0.096, sx: 1.00, sz: 0.78 },
      { p: [0, 1.606, -0.222], r: 0.070, sx: 0.92, sz: 0.70 },
      { p: [0, 1.528, -0.262], r: 0.028, sx: 0.80, sz: 0.60 },
    ], { radial: 12, capStart: 'flat', capEnd: 'round' }), 'hair',
      (x, y) => (y < (LONG ? 1.46 : 1.60) ? P.hairTip : P.hair),
      { only: ['head', 'hairA', 'hairB', 'hairC'] });

    // FACE-FRAMING LOCKS. The single most identifying shape on the head: two
    // long tresses falling from the temple past the jaw. They also fix the
    // ear/jaw junction, which was a bald sphere-on-sphere seam.
    // Deliberately UNEQUAL: the left tress runs past the jaw, the right stops
    // at the cheekbone. Two identical tresses framed the face like a pageboy
    // bob and left the head bilaterally symmetric, which is the one thing a
    // black shape cannot afford (§1.1, §14).
    for (const s of [1, -1]) {
      const L = s > 0 ? 1.0 : 0.66;
      add(tubeGeo([
        { p: [0.112 * s, 1.776, 0.096], r: 0.024, sx: 0.56, sz: 0.90 },
        { p: [0.134 * s, 1.716, 0.110], r: 0.020, sx: 0.48, sz: 0.88 },
        { p: [0.133 * s, lerp(1.716, 1.646, L), 0.102], r: 0.015, sx: 0.44, sz: 0.84 },
        { p: [0.118 * s, lerp(1.700, 1.588, L), 0.076], r: 0.005, sx: 0.40, sz: 0.80 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.664 ? P.hairTip : P.hair), RH);
    }

    // swept back-blades + a crest spike: the crown-breaking silhouette
    for (const s of [1, -1])
      add(tubeGeo([
        { p: [0.100 * s, 1.780, 0.062], r: 0.032 },
        { p: [0.154 * s, 1.778, -0.096], r: 0.027 },
        { p: [0.142 * s, 1.728, -0.244], r: 0.008 },
      ], { radial: 8, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y, z) => (z < -0.14 ? P.hairTip : P.hair), { only: ['head', 'hairA', 'hairB'] });
    for (const s of [1, -1]) {
      add(tubeGeo([
        { p: [0.030 * s, 1.820, 0.078], r: 0.027 },
        { p: [0.054 * s, 1.782, 0.152], r: 0.021 },
        { p: [0.074 * s, 1.748, 0.184], r: 0.006 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.786 ? P.hairTip : P.hair), RH);
      add(tubeGeo([
        { p: [0.092 * s, 1.800, 0.044], r: 0.025 },
        { p: [0.130 * s, 1.758, 0.116], r: 0.019 },
        { p: [0.148 * s, 1.722, 0.144], r: 0.006 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.758 ? P.hairTip : P.hair), RH);
    }
    add(tubeGeo([
      { p: [0, 1.856, 0.030], r: 0.033 },
      { p: [0, 1.874, -0.114], r: 0.028 },
      { p: [0, 1.824, -0.258], r: 0.008 },
    ], { radial: 8, capStart: 'flat', capEnd: 'round' }), 'hair',
      (x, y, z) => (z < -0.16 ? P.hairTip : P.hair), { only: ['head', 'hairA', 'hairB'] });
  }

  // ── crown (§1.5 ornament carries the light) ──────────────────────────────
  // The circlet radius goes 0.172 -> 0.196 and the leaves 0.170 -> 0.198: with
  // the hair cut back to 0.19 half-width the gold now sits OUTSIDE it and reads
  // as a crown rather than as flecks buried in a wig.
  if (F.crown === 'laurel') {
    // R 0.186 floated 40mm clear of the hair (solved: the cap's radius at
    // y 1.782 is 0.147-0.151 all round) and the circlet read as a hat brim
    // hovering over the head in 03_hero_char. 0.156 / ez 1.06 lands it 5mm
    // proud of the hair, which is where a circlet sits.
    add(band({ cy: 1.778, cz: -0.008, R: 0.156, ez: 1.06, th: 0.0085, hh: 0.0165, seg: 34, radial: 8 }),
      'metal', chamfer(P.metalHot, P.metal, P.metalDeep), RH);
    const NL = 14;
    for (let i = 0; i < NL; i++) {
      const a = (i / NL) * 360 + 12;
      const leaf = new THREE.SphereGeometry(1, 8, 6);
      // a leaf is a lens with a spine, not a bean: sz 0.008 makes it thin enough
      // that its lit face and its dark edge are two separate values at 90px.
      // -70 rather than -56: the leaves stand up and OUT, so they cut real
      // notches in the head's outline instead of lying flat on the circlet.
      prim(leaf, { scale: [0.023, 0.054, 0.008], rot: [-70, 0, (i % 2 ? 13 : -13)] });
      prim(leaf, { rot: [0, a, 0], pos: [0.156 * Math.sin(a * D2R), 1.800, 0.166 * Math.cos(a * D2R) - 0.008] });
      add(leaf, 'metal', i % 3 === 0 ? P.metalHot : P.metal, RH);
    }
    add(prim(new THREE.OctahedronGeometry(0.024, 0), { pos: [0, 1.786, 0.156], scale: [0.72, 1.20, 0.55] }),
      'glow', P.glow, RH);
  } else if (F.crown === 'moon') {
    // The witch's lunar circlet. It has to break the head circle HARDER than
    // the laurel does, because the moon crown is the fastest read on which
    // heir is on screen — so the horns are longer, thinner and swept back.
    add(band({ cy: 1.780, cz: -0.008, R: 0.158, ez: 1.06, th: 0.0080, hh: 0.0150, seg: 34, radial: 8 }),
      'metal', chamfer(P.metalHot, P.metal, P.metalDeep), RH);
    // The horns are one CRESCENT read as two arms: thick at the root, tapering
    // to points that curl back over the crown. Two straight spikes read as
    // insect antennae at play scale; a crescent reads as the moon, and the moon
    // is the whole point of the character.
    for (const s of [-1, 1]) {
      add(tubeGeo([
        { p: [0.034 * s, 1.806, 0.162], r: 0.0260, sx: 0.46, sz: 1.0 },
        { p: [0.096 * s, 1.852, 0.144], r: 0.0230, sx: 0.42, sz: 1.0 },
        { p: [0.152 * s, 1.906, 0.082], r: 0.0175, sx: 0.40, sz: 1.0 },
        { p: [0.178 * s, 1.950, -0.014], r: 0.0110, sx: 0.38, sz: 1.0 },
        { p: [0.162 * s, 1.974, -0.104], r: 0.0030, sx: 0.36, sz: 1.0 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), 'metal',
        (x, y) => (y > 1.90 ? P.metalHot : P.metal), RH);
    }
    add(prim(new THREE.OctahedronGeometry(0.034, 0), { pos: [0, 1.868, 0.180], scale: [0.78, 1.30, 0.52] }),
      'glow', P.glow, RH);
  }

  // ── pauldrons ────────────────────────────────────────────────────────────
  // WAS: three concentric SphereGeometry domes 0.29m across whose silhouette
  // outlines differed by a handful of pixels, so the "articulated lames" merged
  // into one bald 0.09m-deep mushroom cap that out-massed the head and read, in
  // the hero shot, as a stack of pancakes.
  // NOW: real LAMES — flattened bands swept around the deltoid, each with a
  // gold arris top and bottom (chamfer()), stepping outward and dropping at the
  // outer point, over a shallow cap carrying a fore-aft crest. Vertical mass is
  // cut ~55%, the horizontal wrap is kept, and the three plates now show three
  // separate lit edges instead of one smooth dome.
  const CL = (s) => 'clav' + (s > 0 ? 'L' : 'R');
  const AR = (s) => 'arm' + (s > 0 ? 'L' : 'R');
  const BX = (s) => 0.234 * SW * s;
  const lame = (s, bone, o) => {
    add(band({
      cx: BX(s), cy: o.y, cz: 0.004, R: o.R * SW, ex: s, ez: 0.98,
      a0: o.a0, a1: o.a1, th: o.th, hh: o.hh, seg: 15, radial: 10,
      dy: (a) => -o.drop * Math.sin(a),
      prof: (t) => 0.44 + 0.56 * Math.sin(Math.PI * t),
    }), 'metal', chamfer(P.metalHot, o.face || P.metal, P.metalDeep), { mode: 'rigid', bone });
  };
  const shoulderCap = (s, bone, o) => {
    // 12 segments, not 20: a shallow shell at 12 has visible facet arrises in
    // SILHOUETTE, and the plate is a struck plate rather than a turned dome.
    const g = prim(new THREE.SphereGeometry(1, 12, 5, 0, TAU, 0, 1.24), { scale: o.scale });
    prim(g, { rot: [0, 0, -o.tilt * s], pos: [BX(s) + o.px * s, o.py, 0.004] });
    // the crown of the cap only — the old +0.012 threshold put metalHot (which
    // is #ffe0a0, i.e. near white) over most of the dome and gave the shoulder
    // a bald pale highlight bigger than the head.
    add(g, 'metal', (x, y) => (y > o.py + o.scale[1] * 0.66 ? P.metalHot : P.metal), { mode: 'rigid', bone });
    // CREST: a fore-aft ridge over the crown of the cap. This is the one arris
    // the play camera (pitch 45, looking DOWN) actually sees, and without it the
    // top of the shoulder was the largest unbroken specular surface on the hero.
    add(tubeGeo([
      { p: [BX(s) + o.px * s, o.py + o.scale[1] * 0.56, -o.scale[2] * 0.88], r: 0.0090, sx: 0.8, sz: 1.2 },
      { p: [BX(s) + o.px * s + 0.010 * s, o.py + o.scale[1] * 1.02, 0.004], r: 0.0145, sx: 0.8, sz: 1.2 },
      { p: [BX(s) + o.px * s, o.py + o.scale[1] * 0.56, o.scale[2] * 0.90], r: 0.0085, sx: 0.8, sz: 1.2 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'metal', P.metalHot, { mode: 'rigid', bone });
  };
  const pauldron = (s) => {
    // 0.070 -> 0.054 of cap height. At 0.070 the dome was still the largest
    // unbroken specular surface on the character seen from the play camera
    // (pitch 45, looking down) and it read as a bald cap sitting on top of the
    // lames rather than as the top plate of the same harness.
    shoulderCap(s, CL(s), { scale: [0.114 * SW, 0.054, 0.126], tilt: 16, px: -0.004, py: 1.464 });
    lame(s, CL(s), { y: 1.452, R: 0.117, hh: 0.030, th: 0.0115, a0: -38, a1: 216, drop: 0.020, face: P.metal });
    // the middle lame's FACE goes deep: three plates all in bright metal gave
    // the shoulder one uninterrupted pale mass, and a stack of lames is only
    // legible if consecutive plates differ in value.
    lame(s, CL(s), { y: 1.394, R: 0.129, hh: 0.028, th: 0.0105, a0: -32, a1: 212, drop: 0.026, face: P.metalDeep });
    lame(s, AR(s), { y: 1.336, R: 0.135, hh: 0.025, th: 0.0095, a0: -26, a1: 208, drop: 0.030, face: P.metalDeep });
    // the standing fin that breaks the dome's contour (§1.1: silhouette first)
    add(tubeGeo([{ p: [0.192 * SW * s, 1.566, 0.004], r: 0.021, sx: 0.72, sz: 1.0 },
    { p: [0.250 * SW * s, 1.654, -0.030], r: 0.014, sx: 0.66, sz: 1.0 },
    { p: [0.284 * SW * s, 1.718, -0.078], r: 0.0035, sx: 0.6, sz: 1.0 }],
      { radial: 8, capStart: 'flat', capEnd: 'round' }),
      'metal', P.metalHot, { mode: 'rigid', bone: CL(s) });
  };
  const smallCap = (s) => {
    shoulderCap(s, CL(s), { scale: [0.099 * SW, 0.043, 0.107], tilt: 22, px: -0.006, py: 1.468 });
    lame(s, CL(s), { y: 1.436, R: 0.109, hh: 0.023, th: 0.0090, a0: -30, a1: 208, drop: 0.018, face: P.metalDeep });
  };
  if (F.pauldron === 'left' || F.pauldron === 'both') pauldron(1);
  else if (F.pauldron !== 'none') smallCap(1);
  if (F.pauldron === 'right' || F.pauldron === 'both') pauldron(-1);
  else if (F.pauldron !== 'none') smallCap(-1);

  // ── harness, gorget, medallion ───────────────────────────────────────────
  if (F.harness) {
    add(tubeGeo([
      { p: [0.150 * SW, 1.508, 0.062], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [0.098, 1.400, 0.140], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [0.004, 1.276, 0.164], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [-0.098, 1.140, 0.150], r: 0.030, sx: 1.55, sz: 0.42 },
      { p: [-0.160, 1.020, 0.108], r: 0.028, sx: 1.50, sz: 0.42 },
    ], { radial: 10, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metalDeep, { only: ['chest', 'spine2', 'spine1'] });
    // GORGET — a band, so it has a top and a bottom arris. The 6-segment torus
    // it replaces was a hexagonal sausage: at play scale its facets read as
    // tooling marks and it carried a single soft highlight.
    add(band({ cy: 1.498, cz: 0.008, R: 0.122, ez: 0.92, th: 0.0135, hh: 0.030, seg: 30, radial: 10 }),
      'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { only: ['chest', 'neck'], bias: { chest: 2 } });
    // SIGIL. Was a bare 0.056m egg with a 14mm dot on it — the largest single
    // ornament on the chest and it read as an egg. Now a rimmed disc with four
    // cardinal rays and the glow set into it: a struck medal.
    add(prim(new THREE.SphereGeometry(1, 16, 10), { pos: [0.052, 1.352, 0.164], scale: [0.050, 0.050, 0.020] }),
      'metal', P.metal, { only: ['chest', 'spine2'] });
    add(prim(new THREE.TorusGeometry(0.050, 0.0085, 8, 22), { pos: [0.052, 1.352, 0.170] }),
      'metal', P.metalHot, { only: ['chest', 'spine2'] });
    for (let i = 0; i < 4; i++) {
      const a = i * 90 + 45;
      add(prim(new THREE.SphereGeometry(1, 6, 5), {
        pos: [0.052 + 0.031 * Math.cos(a * D2R), 1.352 + 0.031 * Math.sin(a * D2R), 0.178],
        rot: [0, 0, a], scale: [0.019, 0.0055, 0.005],
      }), 'metal', P.metalHot, { only: ['chest', 'spine2'] });
    }
    add(prim(new THREE.OctahedronGeometry(0.017, 0), { pos: [0.052, 1.352, 0.180], scale: [1, 1, 0.55] }),
      'glow', P.glow, { only: ['chest', 'spine2'] });
  }

  // ── girdle ───────────────────────────────────────────────────────────────
  // WAS a TorusGeometry(0.182, 0.031) — a circular-section ring, which is why
  // the hero shot showed a black inner-tube floating in front of the waist. A
  // belt is a BAND: 10cm tall, 3cm thick, with a gold pinstripe on each arris
  // and a row of bosses. §1.5's "gold filigree edges catch light" needs an edge.
  add(band({
    cy: 0.948, cz: 0.008, R: 0.186 * lerp(1, BK, 0.7), ez: 0.76, th: 0.016, hh: 0.052,
    seg: 32, radial: 12,
  }), 'cloth', (x, y, z, u) => (((u > 0.18 && u < 0.31) || (u > 0.69 && u < 0.82)) ? P.metalDeep : P.leather),
    { only: ['pelvis', 'spine1'] });
  {
    // GIRDLE BOSSES. The spec has always claimed "gold girdle bosses"; there was
    // exactly ONE, a box on the front. Seven studs around the belt give the
    // waist a rhythm of tiny sharp glints (§4) and a value break between the
    // bare torso and the skirt.
    const NB = 9;
    for (let i = 0; i < NB; i++) {
      const a = (i / NB) * TAU + 0.35;
      if (Math.abs(Math.sin(a)) < 0.16 && Math.cos(a) > 0) continue;   // leave the buckle its space
      add(prim(new THREE.SphereGeometry(1, 8, 6), {
        pos: [0.196 * lerp(1, BK, 0.7) * Math.sin(a), 0.948, 0.150 * lerp(1, BK, 0.7) * Math.cos(a) + 0.008],
        scale: [0.020, 0.024, 0.016],
      }), 'metal', i % 2 ? P.metalHot : P.metal, { only: ['pelvis', 'spine1'] });
    }
  }
  add(prim(new THREE.BoxGeometry(0.082, 0.062, 0.030), { pos: [0, 0.948, 0.142] }),
    'metal', P.metal, { only: ['pelvis', 'spine1'] });
  add(prim(new THREE.BoxGeometry(0.050, 0.034, 0.020), { pos: [0, 0.948, 0.156] }),
    'metal', P.metalHot, { only: ['pelvis', 'spine1'] });

  // ── pteruges (the chiton skirt) ──────────────────────────────────────────
  // WAS: panels that FLARED 30% wider toward the hem, all exactly the same
  // length. That is a bell, and in the black-shape test the skirt read as a
  // solid drum with a straight bottom edge. Pteruges taper to rounded tongues
  // and they are cut in a long-short rhythm; that rhythm plus the taper is the
  // whole reason a Hades skirt reads as cloth in motion rather than as a barrel.
  const NS = F.skirt | 0;
  for (let i = 0; i < NS; i++) {
    const a0 = (22.5 + i * (360 / NS)) * D2R;
    // 0.76 of the pitch left 11 degrees of bare thigh between neighbouring
    // panels, and in 03_hero_char the skirt read as four crimson STRAPS over
    // bare legs rather than as a skirt. 0.90 closes the gaps to ~4 degrees at
    // the waist while the taper still opens them at the hem, which is what
    // pteruges actually do.
    const arc = (360 / NS) * 0.90 * D2R;
    const long = (i % 2 === 0) ? 1.0 : 0.885;
    add(sheetGeo(6, 5, (u, v) => {
      const taper = 1 - 0.34 * u * u;
      const a = a0 + (v - 0.5) * arc * taper;
      const rr = lerp(0.160, 0.292, u * u * 0.40 + u * 0.60);
      // rounded tongue: the corners lift as the panel narrows
      const y = lerp(0.938, 0.938 - 0.496 * long, u) + 0.034 * u * u * Math.abs(v - 0.5) * 2;
      return V(rr * Math.sin(a), y, rr * Math.cos(a));
    }, 0.017), 'cloth',
      (x, y, z, u) => (u > 0.905 ? P.metalHot : (u > 0.845 ? P.metal : (u > 0.755 ? P.clothDeep : P.cloth))),
      { only: ['pelvis', `skirt${i}A`, `skirt${i}B`], bias: { pelvis: 0.55 } });
  }

  // ── mantle / cape ────────────────────────────────────────────────────────
  if (F.cape) {
    // WAS: a symmetric sheet with ONE hem scallop authored in Y — a curtain. It
    // had no fold running down its length, so the biggest single surface on the
    // character carried one flat value, and its two halves were mirror images,
    // which is the fastest way to make a silhouette read as a mannequin.
    // NOW: unequal half-angles (the mantle is pinned at the pauldron shoulder
    // and falls open on the other side), five vertical folds whose depth grows
    // toward the hem, a standing collar behind the neck, and 12cm more length.
    add(sheetGeo(11, 18, (u, v) => {
      const e = u * u * 0.46 + u * 0.54;
      const t = (v - 0.5) * 2;                              // -1 .. +1
      const half = (t >= 0 ? lerp(1.00, 1.11, e) : lerp(0.76, 0.90, e));
      const R = lerp(0.204, 0.452, e);
      const zc = lerp(0.040, 0.120, e);
      // folds: radial ridges that deepen down the cloth. This is where a
      // mantle's light lives.
      const fold = Math.cos(v * Math.PI * 5.0) * (0.026 + 0.050 * e);
      const RR = R + fold;
      // DRAPE. The whole cloth swings 0.22 rad toward the character's left as
      // it falls, so the mantle trails off one hip instead of hanging like a
      // pair of curtains. In the 1/8 black-shape test a symmetric cape and a
      // symmetric torso add up to one vertical slab; this is the term that
      // makes the lower half of the silhouette lean.
      const ang = t * half + 0.10 * Math.sin(Math.PI * u) * t + 0.22 * e;
      let y = lerp(1.556, 0.398, e);
      y += (1 - smoothstep(clamp01(u * 3.0))) * 0.050 * (1 - t * t);   // collar
      // hem: five scallops, deep enough to notch the OUTLINE rather than just
      // shade the surface — the hem is the cape's only free edge and it is the
      // only place the cape can stop being a rectangle.
      y -= 0.092 * Math.sin(v * Math.PI * 5.0) * smoothstep(clamp01((u - 0.46) / 0.54));
      return V(RR * Math.sin(ang), y, zc - RR * Math.cos(ang));
    }, 0.024), 'cloth',
      (x, y, z, u, v, side) => (side < 0 ? P.capeLine : (u > 0.62 ? (P.capeDeep || P.cape) : P.cape)),
      { only: ['chest', 'capeA', 'capeB', 'capeC', 'capeD'], bias: { chest: 0.7 } });
    // shoulder clasps: the two points the mantle actually hangs from
    for (const s of [1, -1])
      add(prim(new THREE.SphereGeometry(1, 10, 8), { pos: [0.118 * SW * s, 1.498, -0.026], scale: [0.030, 0.030, 0.016] }),
        'metal', P.metalHot, { only: ['chest', 'clavL', 'clavR'] });
  }

  // ── arms / hands / bracers ───────────────────────────────────────────────
  const OPEN = F.openHand || 'left';
  for (const s of [1, -1]) {
    const S = s > 0 ? 'L' : 'R';
    const spectral = (F.witchArm === 'left' && S === 'L') || (F.witchArm === 'right' && S === 'R');
    // ELBOW DENSITY (skinning). The arm was one tube with a SINGLE ring at the
    // elbow: a 90-degree bend then has exactly one cross-section to distribute
    // it over, and the joint pinches to a crease. Rings at 1.220 / 1.090 either
    // side of the joint give the bend three sections and the elbow keeps its
    // volume; the 1.155 ring is also fattened 3mm into an olecranon so the bent
    // arm has a point instead of a dent.
    add(tubeGeo([
      { p: [0.232 * SW * s, 1.470, 0.004], r: 0.088 * BK },
      { p: [0.238 * SW * s, 1.362, -0.002], r: 0.077 * BK },
      { p: [0.243 * SW * s, 1.220, -0.010], r: 0.063 * BK },
      { p: [0.245 * SW * s, 1.155, -0.012], r: 0.061 * BK },
      { p: [0.247 * SW * s, 1.090, -0.006], r: 0.058 * BK },
      { p: [0.249 * SW * s, 1.000, 0.002], r: 0.056 * BK },
      { p: [0.250 * SW * s, 0.910, 0.012], r: 0.046 * BK },
    ], { radial: 12, capStart: 'round', capScale: 0.7, capEnd: 'flat' }), spectral ? 'glow' : 'skin',
      spectral ? ((x, y) => y < 1.19 ? P.glow : P.metalHot) : P.skin,
      // The arm answers to the arm chain ONLY. With `only:'body'` the chest
      // segment scored kernel 0.48 on the arm's topmost ring (distance 0.246
      // against a support radius of 0.527) and held ~19% of it, which is a
      // visible drag on any raise past ~90 degrees. The clavicle is kept as a
      // blend partner but biased to 0.4 so the deltoid follows the ARM.
      { only: ['clav' + S, 'arm' + S, 'fore' + S, 'hand' + S], bias: { ['clav' + S]: 0.40 } });
    // DELTOID CAP, rigid to the ARM bone. The shoulder seam is the classic
    // smear: the top of the arm tube is auto-weighted, so raising the arm past
    // ~70 degrees drags torso vertices with it and tears the joint open. A cap
    // that belongs entirely to the arm covers that seam by construction — the
    // same trick the fist uses to stay welded to the weapon.
    add(prim(new THREE.SphereGeometry(1, 16, 12),
      // Sized against the shoulder line, not against the seam it hides: at
      // y 1.446 with a 0.102 half-height the cap's crown reached 1.548, a full
      // 80mm ABOVE the torso's shoulder ring at 1.468, and in 03_hero_char it
      // read as a bare skin ball sitting on top of the armour. 1.428 / 0.082
      // tops out at 1.510, just under the pauldron cap, so it still covers the
      // seam and no longer breaks the shoulder's line.
      { pos: [0.228 * SW * s, 1.428, 0.002], rot: [0, 0, -7 * s], scale: [0.092 * BK, 0.082 * BK, 0.090 * BK] }),
      spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin, { mode: 'rigid', bone: 'arm' + S });

    const HN = 'hand' + S;
    const open = (OPEN === 'left' && S === 'L') || (OPEN === 'right' && S === 'R');
    // palm — shared by both hands
    add(tubeGeo([
      { p: [0.249 * SW * s, 0.900, 0.014], r: 0.040, sx: 1.02, sz: 0.74 },
      { p: [0.251 * SW * s, 0.862, 0.026], r: 0.043, sx: 1.06, sz: 0.78 },
      { p: [0.252 * SW * s, 0.822, 0.038], r: 0.038, sx: 1.02, sz: 0.76 },
      { p: [0.252 * SW * s, 0.792, 0.048], r: 0.028, sx: 0.94, sz: 0.70 },
    ], { radial: 10, capStart: 'round', capEnd: 'round', capScale: 0.85 }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin,
      { mode: 'rigid', bone: HN });
    if (open) {
      // THE OPEN HAND. Both hands used to be the identical closed fist, so a
      // character holding nothing still made a grip, which reads as a doll. The
      // free hand gets four separated, slightly curled fingers and a thumb
      // swung out of the palm plane — a relaxed hand, and still a shape a bow
      // grip or a shield strap sits inside.
      for (let fi = 0; fi < 4; fi++) {
        const dx = (-0.030 + fi * 0.020) * s, len = 1 - Math.abs(fi - 1.2) * 0.11;
        add(tubeGeo([
          { p: [0.250 * SW * s + dx, 0.812, 0.046], r: 0.0110 },
          { p: [0.251 * SW * s + dx * 1.10, 0.782 + 0.010 * (1 - len), 0.052], r: 0.0100 },
          { p: [0.252 * SW * s + dx * 1.18, 0.750 + 0.020 * (1 - len), 0.046], r: 0.0088 },
          { p: [0.252 * SW * s + dx * 1.22, 0.726 + 0.026 * (1 - len), 0.030], r: 0.0070 },
        ], { radial: 6, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin',
          spectral ? P.metalDeep : P.skin, { mode: 'rigid', bone: HN });
      }
      add(tubeGeo([
        { p: [0.220 * SW * s, 0.872, 0.036], r: 0.0150 },
        { p: [0.198 * SW * s, 0.840, 0.058], r: 0.0130 },
        { p: [0.192 * SW * s, 0.812, 0.076], r: 0.0095 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin,
        { mode: 'rigid', bone: HN });
    } else {
      // the fist, bound RIGID to the same bone the weapon uses so hand and hilt
      // are one shape by construction
      add(tubeGeo([
        { p: [0.215 * SW * s, 0.868, 0.052], r: 0.0125 },
        { p: [0.252 * SW * s, 0.872, 0.058], r: 0.0135 },
        { p: [0.286 * SW * s, 0.866, 0.050], r: 0.0115 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.metalHot : P.skin, { mode: 'rigid', bone: HN });
      for (let fi = 0; fi < 3; fi++) {
        const dx = (-0.026 + fi * 0.026) * s;
        add(tubeGeo([
          { p: [0.252 * SW * s + dx, 0.866, 0.058], r: 0.0115 },
          { p: [0.253 * SW * s + dx, 0.836, 0.056], r: 0.0110 },
          { p: [0.253 * SW * s + dx, 0.812, 0.040], r: 0.0095 },
        ], { radial: 7, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.metalDeep : P.skinDeep, { mode: 'rigid', bone: HN });
      }
      add(tubeGeo([
        { p: [0.216 * SW * s, 0.884, 0.030], r: 0.0155 },
        { p: [0.205 * SW * s, 0.856, 0.052], r: 0.0140 },
        { p: [0.212 * SW * s, 0.832, 0.068], r: 0.0105 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin, { mode: 'rigid', bone: HN });
    }
    if (spectral) {
      for (let ri = 0; ri < 3; ri++) {
        add(prim(new THREE.TorusGeometry((0.064 - ri * 0.006) * SW, 0.007, 8, 20), {
          pos: [0.249 * SW * s, 1.07 - ri * 0.075, 0.004], rot: [90, 0, 0],
        }), 'glow', ri === 1 ? P.metalHot : P.glow, { mode: 'rigid', bone: 'fore' + S });
      }
    }
    if (F.bracers) {
      add(tubeGeo([{ p: [0.247 * SW * s, 1.118, -0.008], r: 0.068 * BK }, { p: [0.250 * SW * s, 0.938, 0.010], r: 0.061 * BK }],
        { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metalDeep, { mode: 'rigid', bone: 'fore' + S });
      // rolled cuffs, as bands so each has a lit arris and an undercut
      add(band({ cx: 0.247 * SW * s, cy: 1.116, cz: -0.008, R: 0.070 * BK, th: 0.0090, hh: 0.017, seg: 22, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'fore' + S });
      add(band({ cx: 0.250 * SW * s, cy: 0.944, cz: 0.010, R: 0.064 * BK, th: 0.0085, hh: 0.015, seg: 22, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'fore' + S });
      // a raised spine down the bracer: one more arris for the key to run along
      add(tubeGeo([
        { p: [0.247 * SW * s + 0.062 * BK * s, 1.110, -0.006], r: 0.0075, sx: 0.8, sz: 1.0 },
        { p: [0.250 * SW * s + 0.058 * BK * s, 1.020, 0.002], r: 0.0080, sx: 0.8, sz: 1.0 },
        { p: [0.250 * SW * s + 0.055 * BK * s, 0.948, 0.010], r: 0.0060, sx: 0.8, sz: 1.0 },
      ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'metal', P.metalHot, { mode: 'rigid', bone: 'fore' + S });
    }
  }

  // ── legs / greaves / boots ───────────────────────────────────────────────
  for (const s of [1, -1]) {
    const S = s > 0 ? 'L' : 'R';
    // KNEE DENSITY, same argument as the elbow: rings at 0.600 and 0.462 give a
    // deep knee bend (the run clip reaches 86 degrees, attack3 reaches 64) three
    // sections to spread over instead of one, and the 0.530 ring is widened into
    // a patella so the bent leg has a knee cap rather than a crease.
    add(tubeGeo([
      { p: [0.104 * s, 0.950, 0.004], r: 0.114 * BK },
      { p: [0.110 * s, 0.750, -0.002], r: 0.094 * BK },
      { p: [0.113 * s, 0.600, -0.006], r: 0.076 * BK },
      { p: [0.115 * s, 0.530, -0.006], r: 0.072 * BK },
      { p: [0.117 * s, 0.462, -0.012], r: 0.070 * BK },
      { p: [0.118 * s, 0.350, -0.016], r: 0.072 * BK },
      { p: [0.120 * s, 0.160, -0.026], r: 0.049 * BK },
      // Same argument as the arm: the leg answers to its own chain, so a torso
      // twist can no longer smear the thigh and the pelvis cannot claim a shin.
    ], { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'skin', P.skin,
      { only: ['pelvis', 'thigh' + S, 'shin' + S, 'foot' + S], bias: { pelvis: 0.85 } });
    if (F.greaves) {
      add(tubeGeo([
        { p: [0.115 * s, 0.548, -0.004], r: 0.081 * BK, sz: 1.02 },
        { p: [0.118 * s, 0.372, -0.014], r: 0.082 * BK, sz: 1.02 },
        { p: [0.120 * s, 0.186, -0.024], r: 0.058 * BK, sz: 1.02 },
      ], { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metal, { mode: 'rigid', bone: 'shin' + S });
      // knee cop + a crest running the length of the greave: the shin is the
      // second-largest metal surface on the hero and it had one soft dome and
      // one hexagonal ring on it.
      add(prim(new THREE.SphereGeometry(1, 16, 10), { pos: [0.115 * s, 0.548, 0.006], scale: [0.084 * BK, 0.076, 0.086 * BK] }),
        'metal', P.metalHot, { mode: 'rigid', bone: 'shin' + S });
      add(tubeGeo([
        { p: [0.115 * s, 0.556, 0.070 * BK], r: 0.0115, sx: 0.8, sz: 1.0 },
        { p: [0.118 * s, 0.400, 0.064 * BK], r: 0.0100, sx: 0.8, sz: 1.0 },
        { p: [0.120 * s, 0.232, 0.030 * BK], r: 0.0065, sx: 0.8, sz: 1.0 },
      ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'metal', P.metalHot, { mode: 'rigid', bone: 'shin' + S });
      add(band({ cx: 0.120 * s, cy: 0.190, cz: -0.024, R: 0.062 * BK, th: 0.0085, hh: 0.016, seg: 22, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'shin' + S });
      add(band({ cx: 0.115 * s, cy: 0.556, cz: -0.004, R: 0.085 * BK, th: 0.0085, hh: 0.014, seg: 24, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'shin' + S });
    }
    add(tubeGeo([
      { p: [0.120 * s, 0.118, -0.052], r: 0.052 },
      { p: [0.121 * s, 0.078, 0.014], r: 0.058, sx: 0.96 },
      { p: [0.122 * s, 0.056, 0.094], r: 0.052, sx: 0.90 },
      { p: [0.122 * s, 0.046, 0.152], r: 0.028, sx: 0.84 },
    ], { radial: 10, capStart: 'round', capEnd: 'round', capScale: 0.8 }), 'cloth', P.leather,
      { only: ['foot' + S, 'toe' + S, 'shin' + S] });
    // boot cuff — an ink-to-metal break at the ankle so the leg does not run
    // into the floor as one continuous tube
    add(band({ cx: 0.120 * s, cy: 0.126, cz: -0.040, R: 0.056, ez: 1.15, th: 0.0080, hh: 0.014, seg: 20, radial: 8 }),
      'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { only: ['foot' + S, 'shin' + S] });
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
  // THE SHOULDER TEAR (§d). Measured by posing attack3 at t=0.17, where both
  // arms go overhead: the torso's shoulder shelf reaches x 0.296 while the arm
  // bone starts at 0.249, so ~47mm of TORSO sat outboard of the joint and
  // picked up 30-50% arm weight from the distance kernel. Raising the arm then
  // dragged that shelf with it and opened a stretched skin web from the chest
  // to the elbow — the single worst deformation on the character.
  // `only:'torso'` is the body set MINUS the arm chain, so torso vertices can
  // no longer follow an arm at all. The seam that leaves is covered by the
  // rigid deltoid cap, which belongs entirely to the arm bone.
  const torsoNames = bodyNames.filter(n => !/^(arm|fore|hand)/.test(n));
  const bucketMap = new Map();
  for (const p of parts) {
    const rule = { ...(p.bind || {}) };
    if (rule.only === 'body') rule.only = bodyNames;
    else if (rule.only === 'torso') rule.only = torsoNames;
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
