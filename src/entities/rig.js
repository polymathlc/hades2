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
// COHERENT NOISE — the substrate the surface displacement is built on.
//
// h3 hashes an EXACT coordinate triple, so it has no spatial coherence at all.
// That is fine for the per-vertex brush-grain in aoAt (a colour jitter), and it
// is useless as a displacement field: neighbouring vertices get uncorrelated
// offsets, the recomputed normals turn into salt-and-pepper, and the mesh reads
// as static rather than as surface. Everything below is a coherent field whose
// finest wavelength is one lattice cell, so it can be band-limited against the
// mesh's own edge length — which is the whole discipline of this pass.
//
// ih() is an integer bit-mix rather than Math.sin: it is exactly reproducible
// (pure int32 ops, no transcendental), and it is ~8x faster than h3, which
// matters when the field is evaluated a few hundred thousand times per build.
// ---------------------------------------------------------------------------
function ih(a, b, c) {
  let n = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
  n = (n ^ (n >>> 16)) >>> 0;
  return n / 4294967296;
}
/**
 * SUPERELLIPSE cross-section radius multiplier for tubeGeo's `shape` hook.
 * n=2 is the ellipse the kit has always drawn; n=5 is a rounded rectangle with
 * flat faces and a tight corner — an armour plate rather than a rolled sausage.
 * Exactly 1 at theta = 0 and 90 degrees, so the section's bounding box (and
 * therefore the part's silhouette) is unchanged.
 */
function superellipse(n) {
  return (th) => {
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
  };
}
const SECT5 = superellipse(5);

const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);
/** C1 trilinear value noise, 0..1, wavelength 1 unit. */
function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = fade5(x - xi), fy = fade5(y - yi), fz = fade5(z - zi);
  const c000 = ih(xi, yi, zi), c100 = ih(xi + 1, yi, zi);
  const c010 = ih(xi, yi + 1, zi), c110 = ih(xi + 1, yi + 1, zi);
  const c001 = ih(xi, yi, zi + 1), c101 = ih(xi + 1, yi, zi + 1);
  const c011 = ih(xi, yi + 1, zi + 1), c111 = ih(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * fx, x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx, x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}
/** fractal sum, 0..1, mean ~0.5 */
function fbm(x, y, z, oct) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x, y, z); n += a; x *= 2.07; y *= 2.07; z *= 2.03; a *= 0.5; }
  return s / n;
}
/**
 * Worley F1 in lattice units — the structure behind hammer facets and leather
 * cells. One integer hash per cell rather than three: the mix is split into
 * three 10-bit fields for the feature point's jitter, which is 27 hashes per
 * sample instead of 81 and is the difference between this field being usable
 * on every metal and leather vertex and it being the build's bottleneck.
 */
function cellF1(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = 9;
  // The feature point in cell (i,j,k) lies at cell-corner + jitter in [0,1), so
  // the closest it can possibly be on an axis is `lo` below. Bounding with the
  // corner distance instead would be WRONG for the i=-1 column, whose corner is
  // up to 2 cells away while its feature point can sit right beside the sample.
  const bound = (c) => (c > 0 ? c : (c < -1 ? -(c + 1) : 0));
  for (let i = -1; i <= 1; i++) {
    const dxc = xi + i - x, lx = bound(dxc);
    if (lx * lx >= f1) continue;
    for (let j = -1; j <= 1; j++) {
      const dyc = yi + j - y, ly = bound(dyc);
      if (lx * lx + ly * ly >= f1) continue;
      for (let k = -1; k <= 1; k++) {
        const gx = xi + i, gy = yi + j, gz = zi + k;
        let n = (Math.imul(gx, 374761393) + Math.imul(gy, 668265263) + Math.imul(gz, 1274126177)) | 0;
        n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
        n = (n ^ (n >>> 16)) >>> 0;
        const dx = dxc + (n & 1023) * 0.0009765625;
        const dy = dyc + ((n >>> 10) & 1023) * 0.0009765625;
        const dz = zi + k - z + ((n >>> 20) & 1023) * 0.0009765625;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < f1) f1 = d;
      }
    }
  }
  return Math.sqrt(f1);
}

// ---------------------------------------------------------------------------
// GEOMETRY KIT — exported so the enemy roster can reuse the same shape language
// ---------------------------------------------------------------------------

/**
 * Swept tube along a polyline spine with an elliptical, per-ring cross-section.
 * spine: [{ p:[x,y,z], r, sx, sz }]  — sx scales across the frame normal
 * (world-X-ish for vertical limbs), sz across the binormal (world-Z-ish).
 * opts: { radial, capStart:'round'|'flat'|'open', capEnd, capSeg, capScale,
 *         up, up2, shape(theta, t)->radiusMultiplier, d }
 *
 * `d` is the TESSELLATION GAIN (default 1 = the shipped density, and at 1 every
 * line below runs the identical arithmetic it always did, so a caller that does
 * not opt in gets a byte-identical mesh). Above 1 it multiplies the radial
 * count and inserts linearly interpolated rings along the spine. Interpolation
 * is deliberately LINEAR, not spline: the new rings land exactly on the
 * existing chords, so the extra density changes the surface not at all and the
 * silhouette this pass inherits is preserved to the last millimetre. What the
 * new rings are FOR is carrying displacement (see displacePart), not smoothing.
 */
/** insert m-1 linearly interpolated rings inside every spine span (see tubeGeo). */
function densifySpine(spine, d) {
  const m = Math.max(1, Math.round(d));
  if (m <= 1) return spine;
  const L = (a, b, t) => a + (b - a) * t;
  const out = [spine[0]];
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1], b = spine[i];
    for (let s = 1; s <= m; s++) {
      const t = s / m;
      out.push({
        p: [L(a.p[0], b.p[0], t), L(a.p[1], b.p[1], t), L(a.p[2], b.p[2], t)],
        r: L(a.r ?? 0.1, b.r ?? 0.1, t), sx: L(a.sx ?? 1, b.sx ?? 1, t), sz: L(a.sz ?? 1, b.sz ?? 1, t),
      });
    }
  }
  return out;
}

export function tubeGeo(spine, o = {}) {
  const d = o.d ?? 1;
  const radial = d === 1 ? (o.radial ?? 12) : Math.max(3, Math.round((o.radial ?? 12) * d));
  if (d > 1 && spine.length > 1) spine = densifySpine(spine, d);
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
  const CS = d === 1 ? (o.capSeg ?? 3) : Math.max(1, Math.round((o.capSeg ?? 3) * d));
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
  // Rings wrap modulo `radial` and caps never converge to a point, so no two
  // vertices here share a position. displacePart uses this to skip the weld.
  g.userData.nodup = true;
  return g;
}

/**
 * Parametric SHEET with thickness — cloth, capes, pteruges, armour lames.
 * fn(u,v) -> THREE.Vector3 on the mid-surface. Front/back shells are separate
 * vertex sets (so the lining can be tinted differently) joined by a rim strip.
 * Writes a `side` attribute: +1 front, -1 back, 0 rim.
 *
 * `d` is the tessellation gain (1 = shipped, byte-identical). Unlike tubeGeo's
 * linear resample this genuinely RE-SAMPLES fn, which for the cape is a real
 * correction rather than a cosmetic one: its five folds and five hem scallops
 * were carried on nv=18, i.e. 3.6 samples per period, so the folds the author
 * wrote were aliased away before they ever reached the frame.
 */
export function sheetGeo(nu, nv, fn, thick = 0.018, d = 1) {
  if (d !== 1) { nu = Math.max(2, Math.round(nu * d)); nv = Math.max(2, Math.round(nv * d)); }
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
  g.userData.nodup = true;   // front and back shells are offset by `thick`
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
  // ── TESSELLATION (see DENSITY_ZONES) ─────────────────────────────────────
  // The hero is the one actor on screen at all times and the only one the
  // camera ever pushes in on, so it is the only place a 10x vertex budget buys
  // anything. 2.0 is "the full authored zone table"; 1.0 is the shipped mesh.
  // Enemies never see this value — mergeSpec() refuses to inherit it.
  density: 2.0,
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
  density: 2.0,
  rim: { color: '#84f2c8', strength: 2.3 },
};

/**
 * deep-ish merge so a caller can override one feature without restating all.
 *
 * `density` is the ONE field that is deliberately NOT inherited from `base`.
 * buildHumanoid() merges every actor onto HERO_SPEC, and it also builds all 15
 * enemy kinds (entities/enemies/base.js:303) — so a plain spread would hand the
 * hero's tessellation to the whole roster, multiply it by however many are on
 * screen under the attack-token AI, and blow the §9 triangle budget by an order
 * of magnitude. Opting in has to be explicit, per actor, every time.
 */
export function mergeSpec(base, over = {}) {
  return {
    ...base, ...over,
    density: over.density ?? 1,
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
  const M = cand.length;
  const W = new Float64Array(M);
  // ── COMPACT-SUPPORT EARLY-OUT ──────────────────────────────────────────
  // This solve is O(vertices x segments) and it happens at SPAWN, so a 10x
  // denser hero would pay 10x for it — a visible hitch on the first frame of a
  // chamber. The fix is not to give the density back: the Wyvill kernel is
  // EXACTLY zero beyond r*spread, so a vertex outside a segment's box can be
  // rejected with six compares instead of a projection and a sqrt, and the
  // result is bit-for-bit what the full loop returned. On the hero that is a
  // ~47-segment inner loop of which typically 3-6 boxes contain any given
  // vertex, and it is the reason the build got FASTER per vertex, not slower.
  const bx0 = new Float64Array(M), bx1 = new Float64Array(M);
  const by0 = new Float64Array(M), by1 = new Float64Array(M);
  const bz0 = new Float64Array(M), bz1 = new Float64Array(M);
  for (let c = 0; c < M; c++) {
    const s = cand[c], R = s.r * spread;
    bx0[c] = Math.min(s.a.x, s.b.x) - R; bx1[c] = Math.max(s.a.x, s.b.x) + R;
    by0[c] = Math.min(s.a.y, s.b.y) - R; by1[c] = Math.max(s.a.y, s.b.y) + R;
    bz0[c] = Math.min(s.a.z, s.b.z) - R; bz1[c] = Math.max(s.a.z, s.b.z) + R;
  }
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let sum = 0;
    for (let c = 0; c < M; c++) {
      if (x < bx0[c] || x > bx1[c] || y < by0[c] || y > by1[c] || z < bz0[c] || z > bz1[c]) { W[c] = 0; continue; }
      const s = cand[c];
      const d = segDist(x, y, z, s.a, s.b);
      let w = kernel(d / (s.r * spread));
      if (w > 0) { if (sharp !== 1) w = Math.pow(w, sharp); if (bias && bias[s.name] != null) w *= bias[s.name]; }
      W[c] = w; sum += w;
    }
    if (sum <= 1e-8) {
      // outside every support: fall back to the nearest segment. Rare enough
      // that the full distance sweep only runs here, not on the hot path.
      let best = -1, bestD = Infinity;
      for (let c = 0; c < M; c++) {
        const s = cand[c], d = segDist(x, y, z, s.a, s.b);
        if (d < bestD) { bestD = d; best = c; }
      }
      SI[v * 4] = cand[best] ? cand[best].i : 0; SW[v * 4] = 1; continue;
    }
    // top 4
    let i0 = -1, i1 = -1, i2 = -1, i3 = -1, w0 = 0, w1 = 0, w2 = 0, w3 = 0;
    for (let c = 0; c < M; c++) {
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
// The squared radius is precomputed and tested FIRST: `d < 1` is exactly
// `dsq < r*r`, so the early-out is arithmetically free of consequence and it
// removes ~55 of the 60 sqrt() calls per vertex. At 25k vertices that was
// noise; at 200k it is most of the paint pass.
for (const c of CREVICE) c.r2 = c.r * c.r;
function aoAt(x, y, z, H) {
  let ao = 1;
  for (let i = 0; i < CREVICE.length; i++) {
    const c = CREVICE[i];
    const dx = x - c.p[0], dy = y - c.p[1], dz = z - c.p[2];
    const dsq = dx * dx + dy * dy + dz * dz;
    if (dsq >= c.r2) continue;
    ao *= 1 - c.k * (1 - smoothstep(Math.sqrt(dsq) / c.r));
  }
  // painted vertical form gradient: the head carries the light, the boots are ink
  ao *= lerp(0.76, 1.06, smoothstep(clamp01(y / (H * 0.82))));
  // brush-grain so flat panels are never dead flat
  ao *= 0.965 + 0.07 * h3(x * 31.7, y * 27.3, z * 41.1);
  return ao;
}

// ===========================================================================
// ADAPTIVE TESSELLATION — WHERE THE TRIANGLES GO
// ===========================================================================
// Subdividing a smooth form adds nothing. A sphere at 24x18 and the same sphere
// at 96x72 render identically and the second costs 8x the memory and 8x the
// skinning solve. Density is only worth paying for where something is going to
// be WRITTEN into it (see the displacement fields below), so it is authored as
// a FIELD over bind space, times a WEIGHT per material, rather than as a
// global multiplier: the drape, the free edges of cloth, the hair and the
// ornament get it; the face, the torso and the soles of the boots do not.
// That order is the opposite of the one this table shipped with, and the two
// paragraphs below are why it changed.
//
// `spec.density` is the one knob. 1 is the shipped mesh and every code path
// short-circuits to the identical arithmetic, so an actor that does not opt in
// is byte-identical — which is the whole enemy-blast-radius contract, since
// buildHumanoid() also builds all 15 enemy kinds. Each zone's `g` is the RATE
// at which it gains density: the factor applied is
// `1 + (density - 1) * g * SLOT_DENSITY[slot]`.
//
// ── WHY THERE IS A SLOT TERM, AND WHY THE FACE IS NOT THE TOP ZONE ─────────
// The first version of this table allocated by ANATOMICAL IMPORTANCE: the face
// took g 3.05 and 42.9% of the hero's triangles because a face is the thing a
// player looks at. That is a reasonable prior and it was WRONG, and it was
// wrong in a way that only a measurement could show.
//
// The experiment: render the dense-DISPLACED mesh and a dense-UNDISPLACED
// control from identical cameras at identical resolution (so tessellation
// cannot bias the metric), classify every covered pixel by the bind-space
// point it came from, and take the per-pixel normal Laplacian. Ratio of
// displaced over undisplaced is then literally "how much shading structure the
// displacement put on screen HERE". Eight yaws, hero, idle, 520x1120:
//
//   surface                    displaced/undisplaced   dense/shipped   px
//   cloth  (mantle)                    3.17                1.22       850k
//   cloth  (loose, outside zones)      3.44                0.99        81k
//   cloth  (pteruges)                  2.11                1.07       230k
//   hair                               1.26                0.90       213k
//   metal                              1.07                1.00       444k
//   SKIN                               1.04                1.00       561k
//   skin at the FACE specifically      1.09                0.97       106k
//
// Two things fall out of that table and neither was guessable:
//   1. DENSITY ON ITS OWN BUYS NOTHING. The dense/shipped column is ~1.00
//      everywhere. Triangles are a CARRIER for the displacement field, never a
//      product in themselves — subdividing a smooth form leaves it smooth.
//   2. The payoff is a property of the MATERIAL, not of the body part. Cloth
//      drapes, so a fold field has something to fold; skin over bone is
//      already the shape it wants to be, and a 5mm anatomy delta on a 90px
//      face moves the shading by 4%. The face was paying ~3x the triangles of
//      the mantle for a twentieth of its effect.
//
// So the gain is now a product of WHERE (the zone field: silhouette, joints,
// ornament) and WHAT (the slot: how much displacement that material carries).
// The zone table keeps the head high because the head is also where the hair
// and the crown are, and the slot term is what stops the FACE from spending
// like the hair does.
const DENSITY_BASE = 1.55;
const DENSITY_ZONES = [
  // head: hair mass, crown ornament and face. Cut 3.05 -> 2.60 and then cut
  // again by slot — hair keeps 0.62 of it, the face skin 0.22. Measured face
  // payoff after the change is in the report; the face is not abandoned, it is
  // priced (it still sits well above the shipped mesh's density).
  { p: [0, 1.712, 0.060], r: [0.29, 0.27, 0.31], g: 2.60 },
  // hands: knuckles, tendons and finger separations, all at 10-20mm. 2.55 ->
  // 2.10; measured skin payoff here is 1.061, i.e. the knuckle field is real
  // but small, and the hand is 10cm of screen at the play camera.
  { p: [0.250, 0.845, 0.040], r: [0.135, 0.150, 0.155], g: 2.10, m: 1 },
  // shoulder / pauldron: HELD. The lames are metal (payoff 1.089, and the
  // superellipse arris that gives §4 its glint needs the radial count), and
  // this is the largest specular plate the play camera looking DOWN sees.
  { p: [0.238, 1.420, 0.000], r: [0.190, 0.200, 0.185], g: 2.05, m: 1 },
  // the two joints the animation actually bends hard (§ elbow/knee density).
  // The elbow is bare skin and measured 0.998 — it gets the silhouette floor
  // and nothing more. The knee is a greave: metal, 1.163, and it keeps its g.
  { p: [0.246, 1.150, -0.005], r: [0.115, 0.135, 0.115], g: 1.75, m: 1 },
  { p: [0.116, 0.530, -0.005], r: [0.115, 0.140, 0.130], g: 1.90, m: 1 },
  // chest / abdomen: clavicle, sternum, pectoral, iliac crest. Measured 1.012
  // — the lowest payoff on the figure. 1.75 -> 1.60, and the slot term takes
  // the rest.
  { p: [0, 1.290, 0.070], r: [0.270, 0.300, 0.240], g: 1.60 },
  // the waist cinch — where the cloth compresses and the girdle ornament sits.
  // RAISED 1.90 -> 2.15: it is cloth, and the compression folds are the one
  // place the drape field has a hard boundary condition to work against.
  { p: [0, 0.950, 0.000], r: [0.260, 0.140, 0.240], g: 2.15 },
  // the pteruges: free cloth edges, eight panels each with its own curl.
  // RAISED 2.35 -> 3.40. Payoff 2.11, and this zone is also carrying a
  // SILHOUETTE result rather than only a shading one — the strips resolve as
  // separate strips instead of one scalloped skirt — so it would keep its
  // density on the black-shape test alone.
  { p: [0, 0.700, 0.000], r: [0.380, 0.300, 0.380], g: 3.40 },
  // the mantle: the single biggest surface on the figure, 850k of the 2.5M
  // measured pixels, and the highest payoff anywhere at 3.17. RAISED
  // 2.30 -> 3.80. This is where the density that used to sit on the face went,
  // and the cape view's Laplacian went 0.956 -> 1.075 (2.11x the shipped mesh)
  // on the way, which is the whole reason this rebalance is not a downgrade.
  { p: [0, 1.020, -0.290], r: [0.620, 0.680, 0.430], g: 3.80 },
  // BOOTS AND SOLES: explicitly held DOWN. Ink anchors, barely lit, and the
  // sole is never seen. Measured 1.022-1.08, which confirms the suppression.
  { p: [0.121, 0.075, 0.050], r: [0.130, 0.130, 0.175], g: 0.30, m: 1 },
];
/**
 * How much of a zone's gain each material slot actually collects, set by the
 * measured displaced/undisplaced Laplacian ratio above (cloth 2.08 over the
 * whole figure, hair 1.26, metal 1.07, skin 1.04) rather than by anatomy.
 * Cloth is the reference at 1.0. Skin is not zero: the silhouette floor, the
 * joint bends and the hand still want to be finer than the shipped mesh, and
 * 0.30 of a 2.6 zone is still a 1.78x subdivision of the face. Skin was swept
 * — 0.22 / 0.30 / 0.38 measure the face at 0.961 / 0.976 / 0.981 of the
 * SHIPPED mesh's Laplacian and cost 96.5k / 105.4k / 109.2k triangles, so the
 * curve is flat past 0.30 and 0.30 is where it stops being worth buying.
 */
const SLOT_DENSITY = { cloth: 1.00, hair: 0.62, metal: 0.42, skin: 0.30, glow: 0.30 };
const DZONES = (() => {
  const out = [];
  for (const z of DENSITY_ZONES) {
    out.push(z);
    if (z.m) out.push({ p: [-z.p[0], z.p[1], z.p[2]], r: z.r, g: z.g });
  }
  for (const z of out) { z.ir = [1 / z.r[0], 1 / z.r[1], 1 / z.r[2]]; }
  return out;
})();
/** tessellation gain at a bind-space point: max over the zones, smoothly. */
function zoneGain(x, y, z) {
  let g = DENSITY_BASE;
  for (let i = 0; i < DZONES.length; i++) {
    const Z = DZONES[i];
    const dx = (x - Z.p[0]) * Z.ir[0], dy = (y - Z.p[1]) * Z.ir[1], dz = (z - Z.p[2]) * Z.ir[2];
    const t = dx * dx + dy * dy + dz * dz;
    if (t >= 1) continue;
    const w = (1 - t) * (1 - t);                 // C1, zero at the boundary
    const v = DENSITY_BASE + (Z.g - DENSITY_BASE) * w;
    if (Z.g < DENSITY_BASE) { if (v < g) g = v; }  // suppression zones pull DOWN
    else if (v > g) g = v;
  }
  return g;
}

// ===========================================================================
// AUTHORED SURFACE DISPLACEMENT
// ===========================================================================
// This is the half of the job the density exists for. Every field below is a
// pure function of a BIND-space position (reference 1.90m), so it is
// deterministic, it is identical for every duplicated vertex at a seam WITHIN
// one part, and it survives skinning because it is baked before the bind pose
// is taken. Across a PART boundary it is not continuous, and the reason is
// under displacePart() — the field's value is position-pure, but what gets
// applied is value TIMES DIRECTION, and both the direction and the choice of
// field belong to the part rather than to the point.
//
// AMPLITUDE DISCIPLINE (§5 silhouette-first, §14 black-shape test). The
// spectrum is deliberate and it is a spectrum, not one octave:
//   low   anatomy / drape        4 - 9 mm    reshapes FORM
//   mid   folds, facets, grooves 1 - 3 mm    reshapes SURFACE
//   fine  weave, grain, strand   0.2 - 0.6 mm reshapes SHADING only
// 9mm on a 2.05m figure is 0.4% of height. At the shipping framing the hero is
// ~190px tall, so the largest term here moves a silhouette edge by 0.8px and
// the black shape the previous pass fixed is untouched.

// ── ANATOMY (skin) ─────────────────────────────────────────────────────────
// Ellipsoidal form deltas in bind space. `a` is metres, positive = proud.
// m:1 mirrors the entry to the other side of the body.
//
// AMPLITUDES ARE SET BY SLOPE, NOT BY TASTE. What a surface reads as is the
// ANGLE it turns through, which for a feature of height A over a radius R is
// about 2A/R. The first version of this table was authored by eye at 3-7mm and
// measured 0.914 deg/mm of surface curvature against the undisplaced mesh's
// 0.843 — i.e. after nine times the triangles the form carried 8% more
// modelling, which is exactly the failure this whole pass exists to avoid.
// A deltoid stands ~12mm proud over an 80mm radius on a real arm; that is a
// 17-degree turn and it is what makes a shoulder read as muscle.
const ANATOMY = [
  // ── shoulder girdle and back
  { p: [0.078, 1.468, 0.068], r: [0.082, 0.032, 0.048], a: -0.0105, m: 1 },  // clavicle hollow
  { p: [0.062, 1.462, 0.030], r: [0.070, 0.026, 0.040], a: 0.0075, m: 1 },  // clavicle bone, proud
  { p: [0.104, 1.492, -0.024], r: [0.115, 0.048, 0.080], a: 0.0100, m: 1 },  // trapezius slope
  { p: [0.246, 1.404, 0.000], r: [0.078, 0.090, 0.084], a: 0.0130, m: 1 },  // deltoid swell
  { p: [0.108, 1.398, -0.132], r: [0.075, 0.080, 0.048], a: 0.0070, m: 1 },  // scapula
  { p: [0, 1.252, -0.148], r: [0.019, 0.290, 0.055], a: -0.0080 },           // spinal furrow
  { p: [0.045, 1.556, 0.052], r: [0.022, 0.062, 0.032], a: 0.0068, m: 1 },  // sterno-mastoid
  // ── chest and trunk
  { p: [0, 1.348, 0.150], r: [0.022, 0.095, 0.052], a: -0.0092 },           // sternum groove
  { p: [0.082, 1.372, 0.116], r: [0.070, 0.058, 0.058], a: 0.0070, m: 1 },  // pectoral mass
  { p: [0.082, 1.300, 0.126], r: [0.078, 0.020, 0.055], a: -0.0060, m: 1 },  // under the pectoral
  { p: [0.152, 1.282, 0.030], r: [0.048, 0.105, 0.092], a: 0.0058, m: 1 },  // serratus / rib flank
  { p: [0, 1.062, 0.150], r: [0.012, 0.095, 0.048], a: -0.0068 },           // linea alba
  { p: [0.042, 1.128, 0.146], r: [0.034, 0.032, 0.044], a: 0.0054, m: 1 },  // rectus, upper
  { p: [0.042, 1.058, 0.150], r: [0.034, 0.030, 0.044], a: 0.0050, m: 1 },  // rectus, lower
  { p: [0.108, 1.012, 0.106], r: [0.046, 0.038, 0.058], a: 0.0062, m: 1 },  // iliac crest ridge
  // ── arm
  { p: [0.243, 1.288, 0.034], r: [0.058, 0.092, 0.056], a: 0.0105, m: 1 },  // biceps
  { p: [0.244, 1.282, -0.048], r: [0.056, 0.098, 0.050], a: 0.0082, m: 1 },  // triceps
  { p: [0.246, 1.152, -0.028], r: [0.034, 0.038, 0.030], a: 0.0060, m: 1 },  // olecranon
  { p: [0.248, 1.074, 0.016], r: [0.056, 0.088, 0.054], a: 0.0094, m: 1 },  // forearm flexor mass
  { p: [0.250, 0.938, 0.006], r: [0.038, 0.036, 0.038], a: 0.0046, m: 1 },  // ulnar styloid
  // ── hand: the knuckle row and the tendons behind it
  { p: [0.234, 0.822, 0.048], r: [0.013, 0.015, 0.017], a: 0.0044, m: 1 },
  { p: [0.248, 0.818, 0.052], r: [0.013, 0.015, 0.017], a: 0.0048, m: 1 },
  { p: [0.262, 0.822, 0.050], r: [0.013, 0.015, 0.017], a: 0.0044, m: 1 },
  { p: [0.276, 0.828, 0.044], r: [0.012, 0.014, 0.016], a: 0.0038, m: 1 },
  { p: [0.250, 0.868, 0.044], r: [0.038, 0.034, 0.024], a: -0.0040, m: 1 },  // metacarpal hollow
  // ── leg
  { p: [0.108, 0.800, 0.062], r: [0.062, 0.120, 0.070], a: 0.0092, m: 1 },  // rectus femoris
  { p: [0.112, 0.760, -0.058], r: [0.058, 0.130, 0.060], a: 0.0070, m: 1 },  // hamstring
  { p: [0.116, 0.534, 0.058], r: [0.046, 0.054, 0.042], a: 0.0100, m: 1 },  // patella
  { p: [0.117, 0.300, 0.046], r: [0.015, 0.180, 0.032], a: 0.0080, m: 1 },  // tibial ridge
  { p: [0.100, 0.372, -0.010], r: [0.044, 0.110, 0.056], a: 0.0080, m: 1 },  // gastrocnemius
  // ── head. Held to roughly half the body's slope on purpose: the face already
  // carries dedicated geometry for the brow ridge, the zygomatic arch and the
  // mandible, and this field lands ON TOP of it. Overdriving here does not add
  // definition, it swells landmarks the previous pass measured into place.
  { p: [0.056, 1.7285, 0.1305], r: [0.058, 0.022, 0.042], a: 0.0046, m: 1 },  // brow ridge
  { p: [0, 1.7180, 0.1420], r: [0.019, 0.019, 0.028], a: -0.0034 },           // glabella dip
  { p: [0.128, 1.7405, 0.0560], r: [0.040, 0.043, 0.048], a: -0.0044, m: 1 },  // temporal hollow
  { p: [0.098, 1.6890, 0.0960], r: [0.045, 0.040, 0.045], a: 0.0046, m: 1 },  // cheekbone plane
  { p: [0.086, 1.6560, 0.0980], r: [0.040, 0.036, 0.044], a: -0.0042, m: 1 },  // buccal hollow
  { p: [0.113, 1.6420, 0.0180], r: [0.036, 0.046, 0.046], a: 0.0044, m: 1 },  // gonial / jaw plane
  { p: [0.040, 1.6480, 0.1460], r: [0.017, 0.028, 0.028], a: -0.0032, m: 1 },  // nasolabial
  { p: [0, 1.6600, 0.1560], r: [0.010, 0.015, 0.020], a: -0.0026 },           // philtrum
  { p: [0, 1.6045, 0.1400], r: [0.028, 0.022, 0.028], a: 0.0034 },           // chin button
  { p: [0, 1.7920, 0.1180], r: [0.068, 0.038, 0.058], a: 0.0036 },           // frontal eminence
  { p: [0, 1.5720, 0.0840], r: [0.053, 0.030, 0.046], a: -0.0044 },           // submental hollow
];
const ANAT = (() => {
  const out = [];
  for (const e of ANATOMY) {
    out.push(e);
    if (e.m) out.push({ p: [-e.p[0], e.p[1], e.p[2]], r: e.r, a: e.a });
  }
  for (const e of out) e.ir = [1 / e.r[0], 1 / e.r[1], 1 / e.r[2]];
  return out;
})();
function anatomy(x, y, z) {
  let d = 0;
  for (let i = 0; i < ANAT.length; i++) {
    const e = ANAT[i];
    const dx = (x - e.p[0]) * e.ir[0], dy = (y - e.p[1]) * e.ir[1], dz = (z - e.p[2]) * e.ir[2];
    const t = dx * dx + dy * dy + dz * dz;
    if (t >= 1) continue;
    const u = 1 - t;
    d += e.a * u * u;
  }
  return d;
}

// ── shared sub-fields ──────────────────────────────────────────────────────
/** hammered planishing: shallow dished facets with a slightly proud boundary. */
function planish(x, y, z, f, depth) {
  const c = cellF1(x * f, y * f, z * f);
  return depth * (c * c * 2.2 - 0.62);
}
/**
 * The finest CLOTH octave. Not a thread-scale weave: at the cape's ~14mm edge
 * length the finest wavelength the mesh can carry without aliasing is ~35mm, and
 * a real weave is under a millimetre. This is the cloth's TUMBLE — the shallow
 * irregularity of a woven sheet that has been worn — and the actual weave lives
 * in the ORM set characterrig.cloth supplies. Pretending otherwise here would
 * just be Nyquist noise dressed up as detail.
 */
function tumble(x, y, z, f, a) {
  // Deliberately NOT a crossed sine pair. That is a regular grid, and a regular
  // grid on a 16mm-edge mesh rendered as a visible checker across the mantle —
  // §7's "visible tiling repetition" ban applies to a character surface exactly
  // as it does to a floor. An fbm stretched 3:1 along the fall gives the same
  // energy at the same scale with no period to find.
  return a * (fbm(x * f, y * f * 0.34, z * f, 2) - 0.5) * 2;
}
/** a row of raised stitches running around the body axis at height y0. */
function stitchRow(x, y, z, y0, w, n, a) {
  const t = (y - y0) / w;
  if (t * t > 9) return 0;
  const g = Math.exp(-t * t);
  const p = 0.5 + 0.5 * Math.cos(Math.atan2(x, z) * n);
  return a * g * smoothstep(clamp01((p - 0.42) / 0.30));
}

// ── per-slot fields ────────────────────────────────────────────────────────
// dsp keys: 'sk' skin | 'cl.cape' | 'cl.skirt' | 'cl.bodice' | 'cl.leather'
//           'hr' hair | 'mt.plate' | 'mt.band' | 'mt.orn' | 'mt.blade' | 'no'
function dSkin(x, y, z) {
  let d = anatomy(x, y, z);
  const head = smoothstep(clamp01((y - 1.535) / 0.090));
  // MID BAND. The first pass had anatomy and grain and nothing between them,
  // which is why the arms measured as smooth tubes: a 90mm-wavelength
  // undulation is what carries the small tendon/vein/fat structure that sits
  // under the named muscles, and its absence leaves a 40mm-to-300mm hole in
  // the spectrum right where the eye reads "flesh".
  d += (fbm(x * 22, y * 22, z * 22, 2) - 0.5) * 2 * (0.0022 - 0.0009 * head);
  // FINE grain, band-limited to what the mesh can carry: ~17mm on the body,
  // ~7.5mm on the face. A true pore is 0.2mm and is NOT resolvable by geometry
  // at any budget this project has — that belongs to the albedo/ORM set in
  // materials/recipes.js, and claiming otherwise would just be aliasing.
  const f = 58 + 74 * head;
  const a = 0.00095 - 0.00045 * head;
  d += (fbm(x * f, y * f, z * f, 3) - 0.5) * 2 * a;
  return d;
}
function dCape(x, y, z) {
  // e = how far the cloth has fallen from the two shoulder clasps it hangs on.
  const e = clamp01((1.556 - y) / 1.16);
  const th = Math.atan2(x, -(z - 0.08));
  // CATENARY DRAPE. A sheet pinned at two points does not fold in parallel
  // pipes: the folds are pinched at the supports and FAN as they fall, because
  // the free length between adjacent contact points grows downward. That is the
  // `- 7.5 * e` on the angular frequency, and it is the term that makes a cape
  // read as hanging rather than as corrugated iron.
  // 21 waves per turn over the mantle's ~2.2 rad of sweep is ~7 folds across it,
  // i.e. a 130mm fold at the hem; at 11mm deep that is a 30-degree turn, which
  // is a fold. The 5.4/5.4mm this started at was a 4-degree ripple.
  // The phase is jittered by a coarse noise so the folds are not evenly spaced:
  // evenly spaced folds are corrugation, and cloth gathers unevenly at the two
  // points it actually hangs from.
  const jit = 1.7 * vnoise(th * 1.6, e * 2.2, 0.5);
  let d = Math.cos(th * (21 - 7.5 * e) + 0.55 * e + jit) * 0.0110 * smoothstep(clamp01((e - 0.04) / 0.26));
  // a secondary break riding on the primary, drifting so the two never line up
  d += Math.cos(th * 47 - 1.75 * e + 2.1 + jit * 1.7) * 0.0030 * smoothstep(clamp01((e - 0.14) / 0.36));
  // WIND-LIFTED TRAILING EDGE. The hem is the only free edge the mantle has.
  d += 0.0120 * smoothstep(clamp01((e - 0.78) / 0.22)) * (0.42 + 0.58 * Math.sin(th * 9.4 + 0.7));
  // collar compression where the cloth is gathered into the clasps
  d -= 0.0052 * Math.cos(th * 26) * (1 - smoothstep(clamp01(e / 0.12)));
  d += tumble(x, y, z, 200, 0.0011);
  return d;
}
function dSkirt(x, y, z, i, NS) {
  const a0 = (22.5 + i * (360 / NS)) * D2R;
  let da = Math.atan2(x, z) - a0;
  while (da > Math.PI) da -= TAU;
  while (da < -Math.PI) da += TAU;
  const s = clamp(da / ((Math.PI / NS) * 0.90), -1, 1);   // -1..1 across the panel
  const u = clamp01((0.938 - y) / 0.50);                  // 0..1 down the panel
  // EACH PTERUGE CARRIES ITS OWN CURL, and it is deterministic per panel: a
  // skirt whose panels all curl identically is a lampshade.
  const r = ih(i * 7 + 3, 11, 5);
  let d = (r < 0.5 ? 1 : -1) * (0.0090 + 0.0070 * r) * u * u * (1 - 0.5 * s * s);
  // a spine down the tongue's centre with a gutter either side of it, its phase
  // shifted per panel so eight identical panels do not read as a machined part
  d += 0.0038 * Math.cos(s * Math.PI * 3 + (r - 0.5) * 1.1) * smoothstep(clamp01(u * 2.4));
  // COMPRESSION WRINKLES at the waist cinch: the panel is gathered under the
  // girdle, so the top 10cm carries horizontal buckling that dies out downward.
  d -= 0.0042 * Math.cos((0.938 - y) * 150 + r * TAU) * Math.exp(-(u / 0.24) * (u / 0.24));
  d += tumble(x, y, z, 200, 0.0011);
  return d;
}
function dBodice(x, y, z) {
  const th = Math.atan2(x, z);
  const e = clamp01((1.44 - y) / 0.44);
  let d = Math.cos(th * 26 + 2.4 * e) * 0.0044 * smoothstep(clamp01((e - 0.10) / 0.30));
  // the waist cinch again — this is where cloth over a torso actually creases
  d -= 0.0042 * Math.cos((y - 1.020) * 130) * Math.exp(-Math.pow((y - 1.045) / 0.075, 2));
  d += tumble(x, y, z, 200, 0.0010);
  return d;
}
function dLeather(x, y, z) {
  // grain: a cracked cell structure with a fine tumble over it
  const c = cellF1(x * 44, y * 44, z * 44);
  let d = -0.0021 * smoothstep(clamp01((0.36 - c) / 0.36));
  d += (fbm(x * 70, y * 70, z * 70, 2) - 0.5) * 0.0016;
  // STITCH LINES. Bead counts are set by what the mesh under them can resolve,
  // not by what a real seam has: the boot sits in the SUPPRESSED density zone
  // (§DENSITY_ZONES — soles do not earn triangles), so its topline gets a
  // coarse scalloped welt rather than a stitch row that would alias into a
  // shimmer. The girdle sits in the waist zone and can carry a real row.
  d += stitchRow(x, y, z, 0.128, 0.011, 13, 0.0016);
  d += stitchRow(x, y, z, 0.986, 0.009, 34, 0.0013);
  d += stitchRow(x, y, z, 0.910, 0.009, 34, 0.0013);
  return d;
}
function dHair(x, y, z) {
  // A hair MASS reads as hair rather than as a helmet when it is grooved into
  // clumps. Grooves run along the flow, so they vary ACROSS it: the azimuth
  // around the head axis is a good flow-crossing coordinate for the cap, the
  // nape, the tresses and the swept blades alike, and the y-drift stops the
  // grooves from being perfectly meridional.
  const rxz = Math.sqrt(x * x + (z + 0.030) * (z + 0.030));
  // THE CROWN. A groove field that is purely a function of azimuth has constant
  // ANGULAR pitch, so its arc pitch collapses toward the axis and it converged
  // into a hard 23-spoke sunburst on top of the head — a starburst no head has,
  // and the first thing the eye found in the hero crop.
  // The obvious fix, scaling the frequency by rxz to hold the ARC pitch
  // constant, cannot be used: the frequency then stops being an integer and
  // atan2's +-pi branch cut opens a seam down the back of the head. So the
  // frequency stays 23 and the groove AMPLITUDE fades out over the crown
  // instead, handing it to the clump octave — which is what a whorl looks like
  // and costs nothing.
  const ax = smoothstep(clamp01((rxz - 0.020) / 0.085));
  // jitter at a 55mm wavelength, not 140mm: the point is to break the fan's
  // regularity near the crown, and a noise coarser than the fan cannot.
  const s = Math.atan2(x, z + 0.030) * 23 + (1.86 - y) * 2.0 + 1.9 * vnoise(x * 18, y * 18, z * 18);
  const groove = Math.pow(0.5 - 0.5 * Math.cos(s), 0.6);
  let d = ax * (0.0026 - 0.0052 * groove);                // 45mm pitch, 5.2mm deep
  d += ax * 0.0014 * Math.sin(s * 3.0);                   // strand relief inside each clump
  d += (fbm(x * 13, y * 13, z * 13, 2) - 0.5) * 0.0090;   // clumping: fat and thin locks
  return d;
}
function dPlate(x, y, z, c) {
  // hammered planishing facets — ~16mm dishes, the mark of a struck plate
  let d = planish(x, y, z, 62, 0.0011);
  if (c) {
    // PUNCHED / REPOUSSE ornament, raised proud of the plate: a bead ring
    // around the plate's own centre with a rosette of rays inside it.
    const rx = x - c[0], ry = y - c[1], rz = z - c[2];
    const rr = Math.sqrt(rx * rx + rz * rz + ry * ry * 0.35);
    const ring = Math.exp(-Math.pow((rr - c[3]) / (c[3] * 0.17), 2));
    const bead = Math.pow(0.5 + 0.5 * Math.cos(Math.atan2(rx, rz) * 16), 3);
    d += 0.0024 * ring * (0.30 + 0.70 * bead);
  }
  return d;
}
function dBand(x, y, z, c) {
  let d = planish(x, y, z, 96, 0.00062);
  if (c) d += 0.0013 * Math.pow(0.5 + 0.5 * Math.cos(Math.atan2(x - c[0], z - c[2]) * 26), 4);
  return d;
}
function dBlade(x, y, z) {
  // the xiphos: a shallow fuller down the centre and grind lines along the length
  const px = x + 0.255, py = y - 0.776, pz = z - 0.052;
  const w = px * 0.96319 + pz * 0.26969;
  const l = px * -0.10902 + py * -0.94800 + pz * 0.28440;
  let d = -0.0020 * Math.exp(-Math.pow(w / 0.016, 2)) * smoothstep(clamp01((l - 0.03) / 0.10));
  d += 0.00028 * Math.sin(w * 620);
  return d;
}

/** the field, dispatched on the part's dsp key. */
function dispAt(k, x, y, z, arg) {
  switch (k) {
    case 'sk': return dSkin(x, y, z);
    case 'cl.cape': return dCape(x, y, z);
    case 'cl.skirt': return dSkirt(x, y, z, arg[0], arg[1]);
    case 'cl.bodice': return dBodice(x, y, z);
    case 'cl.leather': return dLeather(x, y, z);
    case 'hr': return dHair(x, y, z);
    case 'mt.plate': return dPlate(x, y, z, arg);
    case 'mt.band': return dBand(x, y, z, arg);
    case 'mt.orn': return planish(x, y, z, 120, 0.00055);
    case 'mt.blade': return dBlade(x, y, z);
    default: return 0;
  }
}
const SLOT_DISP = { skin: 'sk', cloth: 'cl.bodice', hair: 'hr', metal: 'mt.orn', glow: 'no' };

// ---------------------------------------------------------------------------
// DISPLACEMENT APPLICATION, AND THE NORMAL RECOMPUTE THAT MAKES IT VISIBLE
//
// The single most likely way for this whole pass to silently fail is to move
// the vertices and keep the old normals: the mesh would then shade EXACTLY as
// it did before and every triangle added would be invisible. So normals are
// rebuilt geometrically here, and two details are load-bearing:
//
// 1. WELDED DISPLACEMENT DIRECTION. Coincident vertices that carry different
//    normals (a BoxGeometry corner, a SphereGeometry UV seam) would be pushed
//    apart if each followed its own normal, opening cracks along every hard
//    edge. Each position-group is displaced once, along the average of the
//    group's normals, which is watertight by construction WITHIN A PART.
//
//    IT IS NOT WATERTIGHT ACROSS PARTS, and that is a real, measured, known
//    limitation rather than an oversight. displacePart() runs per part, so two
//    parts that meet at a shared position each pick their own displacement
//    field (`mt.band` on a cuff against `mt.plate` on the bracer it rings) and
//    their own surface normal, and the shared position therefore moves twice,
//    differently. Note what is NOT the cause: the field's magnitude is a pure
//    function of bind-space position and is perfectly continuous. Displacement
//    is magnitude TIMES DIRECTION, and direction is a property of the surface,
//    not of the point — so no amount of position-purity can make it agree.
//
//    MEASURED, hero, every pair of vertices within 0.3mm before displacement
//    (24,155 pairs): 1,895 separate by more than 0.05mm, worst 3.75mm, and the
//    breakdown is metal/metal 1,274, cloth/cloth 351, hair/hair 266,
//    skin/anything 3. Every one of those is two STACKED SOLIDS — a cuff around
//    a bracer, a greave lame over a boot, one skirt panel over the next, one
//    hair lock over another — not two halves of one surface, so a relative
//    move cannot open a hole in a closed volume; it can only slide one plate
//    on another by 3mm. (Before the density rebalance the same test found 80
//    groups in the SKIN slot, at the wrist, jaw, elbow and ankle, where the
//    parts genuinely do share a surface; those are gone, because skin no
//    longer tessellates finely enough for the two parts to land on the same
//    positions. That is a side effect, not a fix.)
//
//    The fix, if it is ever wanted, is a two-phase weld: accumulate one
//    position -> (direction, magnitude) map across every part in a slot, then
//    displace from that map. It costs a second pass over ~60k vertices and an
//    arbitrary tie-break for which part's field wins at a shared position, and
//    it is not worth ~8ms of a build this pass is already trying to shorten
//    for a 3mm slide between two plates that no shot has ever shown.
// 2. SMOOTHING-GROUP-AWARE RE-AVERAGE. Rebuilding normals with a naive
//    per-vertex average leaves a sphere's UV seam shaded as a visible line
//    (its two duplicates each see only half the faces). Re-averaging across a
//    position-group fixes that, but doing it unconditionally would round off
//    the buckle's box corners. So duplicates are merged only when their
//    ORIGINAL normals agreed to within ~57 degrees, which is exactly the
//    smoothing-group rule an offline tool would apply.
// ---------------------------------------------------------------------------
const _qkey = (x, y, z) =>
  ((Math.round(x * 10000) + 32768) * 65536 + (Math.round(y * 10000) + 32768)) * 65536
  + (Math.round(z * 10000) + 32768);

function displacePart(g, slot, dsp) {
  const key = (typeof dsp === 'string' ? dsp : (dsp && dsp.k)) || g.userData.dk || SLOT_DISP[slot] || 'no';
  if (key === 'no') return null;
  const arg = (dsp && dsp.a) || g.userData.dc || null;
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const P = g.getAttribute('position'), N = g.getAttribute('normal');
  const pa = P.array, na = N.array, n = P.count;
  const orig = na.slice();

  // Position groups, as linked lists (no per-group allocation). The map is the
  // single most expensive thing in this function, so the primitives that
  // provably have no coincident vertices — tubeGeo and sheetGeo, which are ~95%
  // of the budget — skip it entirely and take the identity grouping.
  const dup = !g.userData.nodup;
  const next = new Int32Array(n).fill(-1);
  let head = null;
  if (dup) {
    head = new Map();
    for (let i = 0; i < n; i++) {
      const k = _qkey(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]);
      const h = head.get(k);
      if (h === undefined) head.set(k, i); else { next[i] = h; head.set(k, i); }
    }
  }
  const starts = dup ? head.values() : null;
  const cav = new Float32Array(n);
  const dir = dup ? new Float32Array(n * 3) : na;

  if (!dup) {
    for (let i = 0; i < n; i++) {
      const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
      const d = dispAt(key, x, y, z, arg);
      pa[i * 3] += na[i * 3] * d; pa[i * 3 + 1] += na[i * 3 + 1] * d; pa[i * 3 + 2] += na[i * 3 + 2] * d;
      cav[i] = d < 0 ? clamp01(-d / 0.0050) : 0;
    }
  } else for (const start of starts) {
    // welded displacement direction for this position
    let ax = 0, ay = 0, az = 0;
    for (let i = start; i !== -1; i = next[i]) { ax += orig[i * 3]; ay += orig[i * 3 + 1]; az += orig[i * 3 + 2]; }
    let L = Math.sqrt(ax * ax + ay * ay + az * az);
    if (L < 1e-9) { ax = orig[start * 3]; ay = orig[start * 3 + 1]; az = orig[start * 3 + 2]; L = 1; }
    ax /= L; ay /= L; az /= L;
    const x = pa[start * 3], y = pa[start * 3 + 1], z = pa[start * 3 + 2];
    const d = dispAt(key, x, y, z, arg);
    // CAVITY -> the hand-painted AO that had nowhere to land at 25k triangles.
    // Every concavity the displacement authors darkens itself, so a cape fold's
    // trough, a hair groove, a planished dish and a knuckle valley all get the
    // §4 "darkened crevice" for free and at the right scale.
    const c = d < 0 ? clamp01(-d / 0.0050) : 0;
    for (let i = start; i !== -1; i = next[i]) {
      pa[i * 3] += ax * d; pa[i * 3 + 1] += ay * d; pa[i * 3 + 2] += az * d;
      dir[i * 3] = ax; dir[i * 3 + 1] = ay; dir[i * 3 + 2] = az;
      cav[i] = c;
    }
  }
  P.needsUpdate = true;

  // ── geometric normals, area-weighted, then merged per smoothing group ────
  const acc = new Float64Array(n * 3);
  const idx = g.index ? g.index.array : null;
  const m = idx ? idx.length : n;
  for (let t = 0; t + 2 < m; t += 3) {
    const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
    const ax0 = pa[i0 * 3], ay0 = pa[i0 * 3 + 1], az0 = pa[i0 * 3 + 2];
    const ex = pa[i1 * 3] - ax0, ey = pa[i1 * 3 + 1] - ay0, ez = pa[i1 * 3 + 2] - az0;
    const fx = pa[i2 * 3] - ax0, fy = pa[i2 * 3 + 1] - ay0, fz = pa[i2 * 3 + 2] - az0;
    const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
    acc[i0 * 3] += cx; acc[i0 * 3 + 1] += cy; acc[i0 * 3 + 2] += cz;
    acc[i1 * 3] += cx; acc[i1 * 3 + 1] += cy; acc[i1 * 3 + 2] += cz;
    acc[i2 * 3] += cx; acc[i2 * 3 + 1] += cy; acc[i2 * 3 + 2] += cz;
  }
  if (!dup) {
    for (let i = 0; i < n; i++) {
      let x = acc[i * 3], y = acc[i * 3 + 1], z = acc[i * 3 + 2];
      let L = Math.sqrt(x * x + y * y + z * z);
      if (L < 1e-14) { x = orig[i * 3]; y = orig[i * 3 + 1]; z = orig[i * 3 + 2]; L = 1; }
      na[i * 3] = x / L; na[i * 3 + 1] = y / L; na[i * 3 + 2] = z / L;
    }
    N.needsUpdate = true;
    return cav;
  }
  for (const start of head.values()) {
    if (next[start] === -1) {
      const x = acc[start * 3], y = acc[start * 3 + 1], z = acc[start * 3 + 2];
      const L = Math.sqrt(x * x + y * y + z * z) || 1;
      na[start * 3] = x / L; na[start * 3 + 1] = y / L; na[start * 3 + 2] = z / L;
      continue;
    }
    for (let i = start; i !== -1; i = next[i]) {
      let sx = 0, sy = 0, sz = 0;
      const ox = orig[i * 3], oy = orig[i * 3 + 1], oz = orig[i * 3 + 2];
      for (let j = start; j !== -1; j = next[j]) {
        if (i !== j && ox * orig[j * 3] + oy * orig[j * 3 + 1] + oz * orig[j * 3 + 2] < 0.55) continue;
        sx += acc[j * 3]; sy += acc[j * 3 + 1]; sz += acc[j * 3 + 2];
      }
      let L = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (L < 1e-14) { sx = dir[i * 3]; sy = dir[i * 3 + 1]; sz = dir[i * 3 + 2]; L = 1; }
      na[i * 3] = sx / L; na[i * 3 + 1] = sy / L; na[i * 3 + 2] = sz / L;
    }
  }
  N.needsUpdate = true;
  return cav;
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
  // The 5th argument is the DISPLACEMENT DESCRIPTOR (see dispAt). It is
  // optional: a part that does not name one inherits the key its primitive
  // stashed in userData, and failing that its slot's default.
  // The tessellation wrappers below hand back a THUNK rather than a geometry
  // when density is on, because the density field now reads the material SLOT
  // (see SLOT_DENSITY) and add() is the only place that knows it. Every one of
  // the ~110 authoring call sites is already `add(WRAPPER(...), slot, ...)`,
  // so the slot arrives here with no call site changed. A plain geometry —
  // prim(), a hand-built merge, or any wrapper at density 1 — passes through.
  const add = (g, slot, tint, bind, dsp) => {
    const geo = typeof g === 'function' ? g(slot) : g;
    parts.push({ g: geo, slot, tint, bind, dsp }); return geo;
  };

  // ── TESSELLATION WRAPPERS ────────────────────────────────────────────────
  // Each part inherits the density of the PLACE it occupies (DENSITY_ZONES)
  // scaled by what its MATERIAL can carry (SLOT_DENSITY), so adaptivity is
  // authored once as a field instead of fifty times as a literal. At density 1
  // every wrapper degenerates to the bare primitive with byte-identical
  // arguments and returns it directly.
  const DENS = spec.density ?? 1;
  // SLOT_DENSITY is a REFINEMENT weight — it says which materials can CARRY the
  // displacement the extra triangles exist for. A density below 1 is not a
  // refinement but a REDUCTION (the silhouette proxy, which is never
  // displaced and is only ever rasterised as an outline), and a reduction has
  // to come off every slot equally or the weighting inverts: weighting a
  // negative term makes skin shrink LESS than cloth, and the proxy came out
  // 70% heavier than the mesh it is supposed to stand in for.
  const gainAt = (slot, x, y, z) =>
    1 + (DENS - 1) * zoneGain(x, y, z) * (DENS > 1 ? (SLOT_DENSITY[slot] ?? 1) : 1);
  const TUBE = (spine, o = {}) => {
    if (DENS === 1 || o.d != null) return tubeGeo(spine, o);
    // averaged over the spine, not sampled at its midpoint: the leg runs from
    // hip to ankle through three different zones, and the midpoint alone would
    // hand the whole limb whichever zone happens to sit at its centre.
    return (slot) => {
      let s = 0;
      for (const q of spine) s += gainAt(slot, q.p[0], q.p[1], q.p[2]);
      return tubeGeo(spine, { ...o, d: s / spine.length });
    };
  };
  const SHEET = (nu, nv, fn, th) => {
    if (DENS === 1) return sheetGeo(nu, nv, fn, th);
    const c = fn(0.5, 0.5);
    return (slot) => sheetGeo(nu, nv, fn, th, gainAt(slot, c.x, c.y, c.z));
  };
  const ball = (w, h, o, d) =>
    prim(new THREE.SphereGeometry(1, Math.max(4, Math.round(w * d)), Math.max(3, Math.round(h * d))), o);
  const BALL = (w, h, o) => {
    if (DENS === 1 || !o.pos) return ball(w, h, o, 1);
    return (slot) => ball(w, h, o, gainAt(slot, o.pos[0], o.pos[1], o.pos[2]));
  };
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
  const bandAt = (o, bg) => {
    // ── THE ARRIS (§4 "a small, bright, sharp glint") ─────────────────────
    // A glint is small and sharp because the edge RADIUS is small: the highlight
    // is the reflection of the key swept across the corner, and its width is
    // proportional to that radius. An elliptical section has no small radius
    // anywhere, which is why these bands still read as soft rolls even after
    // they stopped being TorusGeometry sausages. Under density the section
    // becomes a SUPERELLIPSE: flat faces, and a corner radius set by the
    // exponent rather than by the semi-axes. The bounding box is unchanged
    // (rad is exactly 1 at 0 and at 90 degrees), so nothing moves in
    // silhouette — the plate simply acquires two real edges for the key to
    // catch, which is also where chamfer() has always been putting its gold.
    // n = 5 against the radial count the ornament zones supply (10 -> ~28)
    // puts 3-4 samples across the corner, which is what "resolvable" means.
    const N = Math.max(2, Math.round((o.seg ?? 26) * (1 + (bg - 1) * 0.75)));
    const A0 = (o.a0 ?? 0) * D2R, A1 = (o.a1 ?? 360) * D2R;
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
    const g = tubeGeo(spine, {
      radial: Math.max(3, Math.round((o.radial ?? 10) * (1 + (bg - 1) * 1.45))), up: [0, 1, 0],
      capStart: o.cap ?? 'flat', capEnd: o.cap ?? 'flat',
      shape: bg > 1 ? SECT5 : undefined,
    });
    g.userData.dk = 'mt.band';
    g.userData.dc = [o.cx ?? 0, o.cy ?? 0, o.cz ?? 0];
    return g;
  };
  const band = (o) => (DENS === 1
    ? bandAt(o, 1)
    : (slot) => bandAt(o, gainAt(slot, o.cx ?? 0, o.cy ?? 0, o.cz ?? 0)));
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
  add(TUBE([
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
    add(BALL(14, 10,
      { pos: [0.078 * SW * s, 1.366, 0.104], rot: [0, 0, -11 * s], scale: [0.106 * SW, 0.046, 0.062] }),
      'skin', P.skin, { only: 'torso' });
    // trapezius: the neck-to-shoulder slope. Without it the head sat on a flat
    // shelf and the neck sheared visibly whenever the head turned.
    add(TUBE([
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
    add(TUBE([
      { p: [0, 0.985, 0.006], r: tr(0.166), sx: 1.28, sz: 0.84 },
      { p: [0, 1.100, 0.010], r: tr(0.140), sx: 1.20, sz: 0.82 },
      { p: [0, 1.235, 0.014], r: tr(0.170), sx: 1.30, sz: 0.83 },
      { p: [0, 1.330, 0.016], r: tr(0.188), sx: tsx(1.34), sz: 0.82 },
      { p: [0, 1.408, 0.014], r: tr(0.198), sx: tsx(1.42), sz: 0.79 },
      { p: [0, 1.452, 0.008], r: tr(0.188), sx: tsx(1.52), sz: 0.74 },
    ], { radial: 20, capStart: 'flat', capEnd: 'flat' }), 'cloth',
      (x, y) => ((y > 1.436 || y < 1.000) ? P.metalDeep : (y < 1.14 ? P.clothDeep : P.cloth)),
      { only: 'torso' }, 'cl.bodice');
  }

  // ILIAC CREST — the "V" that runs from the hip point down under the girdle.
  // On a bare-chested figure it is the only form between the navel and the belt
  // and without it the abdomen is 25cm of unbroken lit skin, which is the
  // largest featureless surface anywhere on the character.
  for (const s of [1, -1]) add(TUBE([
    { p: [0.126 * s, 1.010, 0.086], r: 0.0135, sx: 0.70, sz: 0.80 },
    { p: [0.086 * s, 0.960, 0.128], r: 0.0150, sx: 0.70, sz: 0.80 },
    { p: [0.034 * s, 0.916, 0.142], r: 0.0110, sx: 0.70, sz: 0.80 },
  ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, { only: 'torso' });

  add(TUBE([{ p: [0, 1.470, 0.004], r: 0.074 }, { p: [0, 1.610, 0.008], r: 0.069 }],
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
  add(BALL(24, 18, { pos: [0, 1.690, 0.008], scale: [0.151, 0.164, 0.158] }),
    'skin', P.skin, RH);
  // JAW. Was a 0.256m-wide sphere — as wide as the cranium, which is precisely
  // what made the head read as a lit egg with dots on it. A jaw is NARROWER
  // than the skull and it has a corner; the mass is cut 12% and the gonial
  // angle is authored explicitly by the mandible tube below.
  add(BALL(20, 14, { pos: [0, 1.640, 0.046], scale: [0.111, 0.079, 0.116] }),
    'skin', P.skin, RH);
  for (const s of [1, -1]) {
    // mandible: gonial angle under the ear -> along the jaw -> chin. A lit
    // arris here is what separates head from neck at play distance.
    add(TUBE([
      { p: [0.117 * s, 1.680, -0.016], r: 0.0150, sx: 0.66, sz: 1.0 },
      { p: [0.112 * s, 1.628, 0.024], r: 0.0158, sx: 0.66, sz: 1.0 },
      { p: [0.080 * s, 1.602, 0.098], r: 0.0146, sx: 0.78, sz: 1.0 },
      { p: [0.025 * s, 1.592, 0.140], r: 0.0126, sx: 0.90, sz: 1.0 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
    // zygomatic arch. The CREVICE table already darkened "the plane under the
    // cheekbone"; there was no cheekbone, so the shadow had nothing to be under.
    add(TUBE([
      { p: [0.134 * s, 1.702, 0.006], r: 0.0180, sx: 0.58, sz: 0.82 },
      { p: [0.114 * s, 1.696, 0.084], r: 0.0200, sx: 0.58, sz: 0.82 },
      { p: [0.068 * s, 1.688, 0.134], r: 0.0150, sx: 0.58, sz: 0.82 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
    // EARS. There were none. An earless head is the loudest mannequin cue there
    // is, and the ear is the only thing that breaks the skull's circle in
    // profile — i.e. it is half of the run-cycle silhouette.
    add(BALL(10, 10,
      { pos: [0.150 * s, 1.688, -0.014], rot: [0, -16 * s, -9 * s], scale: [0.015, 0.038, 0.028] }),
      'skin', P.skin, RH);
    add(TUBE([
      { p: [0.156 * s, 1.704, -0.004], r: 0.0050, sx: 0.7, sz: 1.0 },
      { p: [0.161 * s, 1.686, -0.018], r: 0.0050, sx: 0.7, sz: 1.0 },
      { p: [0.154 * s, 1.670, -0.008], r: 0.0042, sx: 0.7, sz: 1.0 },
    ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, RH);
  }
  // chin
  add(BALL(12, 10, { pos: [0, 1.598, 0.140], scale: [0.036, 0.028, 0.029] }),
    'skin', P.skin, RH);
  // NOSE — bridge, tip, nostril wings. The old part was a single 24mm tube:
  // a peg. The "under the nose" crevice needs a tip to sit under.
  add(TUBE([
    { p: [0, 1.7320, 0.1310], r: 0.0098, sx: 0.80, sz: 0.90 },
    { p: [0, 1.7080, 0.1500], r: 0.0130, sx: 0.82, sz: 0.90 },
    { p: [0, 1.6870, 0.1720], r: 0.0180, sx: 0.94, sz: 0.98 },
    { p: [0, 1.6710, 0.1635], r: 0.0140, sx: 1.08, sz: 0.82 },
  ], { radial: 8, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
  for (const s of [1, -1])
    add(BALL(8, 6, { pos: [0.0195 * s, 1.6765, 0.1565], scale: [0.0125, 0.0105, 0.0140] }),
      'skin', P.skin, RH);
  // BROW. Was ONE straight horizontal skinDeep bar spanning the whole forehead:
  // at a 90px head that is a 4px dark plank and it read as a headband, not a
  // brow — and it was doing the eyebrow's job in the eyebrow's colour, so the
  // face had no separate expression line at all. Now the ridge is SKIN (a proud
  // form that catches the key, with the socket crevice supplying its shadow)
  // and the eyebrow is its own thin dark line above it, angled so the two ends
  // of the face are not parallel.
  for (const s of [1, -1]) {
    add(TUBE([
      { p: [0.014 * s, 1.7215, 0.1470], r: 0.0130, sx: 0.85, sz: 0.70 },
      { p: [0.060 * s, 1.7300, 0.1360], r: 0.0158, sx: 0.85, sz: 0.70 },
      { p: [0.107 * s, 1.7185, 0.0930], r: 0.0120, sx: 0.85, sz: 0.70 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
    add(TUBE([
      { p: [0.018 * s, 1.7350, 0.1490], r: 0.0058, sx: 1.0, sz: 0.52 },
      { p: [0.063 * s, 1.7430, 0.1375], r: 0.0074, sx: 1.0, sz: 0.52 },
      { p: [0.110 * s, 1.7280, 0.0935], r: 0.0046, sx: 1.0, sz: 0.52 },
    ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'hair', brow, RH, 'no');
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
    add(BALL(12, 8, { pos: [0.0575 * s, 1.7050, 0.1500], rot: [0, 0, -10 * s], scale: [0.0300, 0.0170, 0.0140] }),
      'hair', brow, RH, 'no');
    add(BALL(10, 8, { pos: [0.0565 * s, 1.7040, 0.1560], rot: [0, 0, -10 * s], scale: [0.0132, 0.0122, 0.0110] }),
      'glow', P.glow, RH);
    // lash line
    add(TUBE([
      { p: [0.028 * s, 1.7140, 0.1425], r: 0.0050, sx: 1.0, sz: 0.58 },
      { p: [0.057 * s, 1.7195, 0.1520], r: 0.0074, sx: 1.0, sz: 0.58 },
      { p: [0.088 * s, 1.7120, 0.1330], r: 0.0046, sx: 1.0, sz: 0.58 },
    ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'hair', brow, RH, 'no');
    // lower lid: a proud skin roll. It is the catch-light that stops the eye
    // from reading as a hole punched in the head.
    add(TUBE([
      { p: [0.031 * s, 1.6955, 0.1410], r: 0.0052, sx: 1.0, sz: 0.50 },
      { p: [0.057 * s, 1.6935, 0.1495], r: 0.0064, sx: 1.0, sz: 0.50 },
      { p: [0.085 * s, 1.6955, 0.1320], r: 0.0044, sx: 1.0, sz: 0.50 },
    ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skin, RH);
  }
  // MOUTH — the closed line, and a proud lower lip that carries the catch-light.
  add(TUBE([
    { p: [-0.034, 1.6440, 0.1580], r: 0.0060, sx: 1.0, sz: 0.55 },
    { p: [0, 1.6465, 0.1690], r: 0.0082, sx: 1.0, sz: 0.55 },
    { p: [0.034, 1.6440, 0.1580], r: 0.0060, sx: 1.0, sz: 0.55 },
  ], { radial: 6, capStart: 'round', capEnd: 'round' }), 'skin', P.skinDeep, RH);
  add(TUBE([
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
    add(SHEET(6, 24, (u, v) => {
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
    add(TUBE(LONG ? [
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
      add(TUBE([
        { p: [0.112 * s, 1.776, 0.096], r: 0.024, sx: 0.56, sz: 0.90 },
        { p: [0.134 * s, 1.716, 0.110], r: 0.020, sx: 0.48, sz: 0.88 },
        { p: [0.133 * s, lerp(1.716, 1.646, L), 0.102], r: 0.015, sx: 0.44, sz: 0.84 },
        { p: [0.118 * s, lerp(1.700, 1.588, L), 0.076], r: 0.005, sx: 0.40, sz: 0.80 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.664 ? P.hairTip : P.hair), RH);
    }

    // swept back-blades + a crest spike: the crown-breaking silhouette
    for (const s of [1, -1])
      add(TUBE([
        { p: [0.100 * s, 1.780, 0.062], r: 0.032 },
        { p: [0.154 * s, 1.778, -0.096], r: 0.027 },
        { p: [0.142 * s, 1.728, -0.244], r: 0.008 },
      ], { radial: 8, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y, z) => (z < -0.14 ? P.hairTip : P.hair), { only: ['head', 'hairA', 'hairB'] });
    for (const s of [1, -1]) {
      add(TUBE([
        { p: [0.030 * s, 1.820, 0.078], r: 0.027 },
        { p: [0.054 * s, 1.782, 0.152], r: 0.021 },
        { p: [0.074 * s, 1.748, 0.184], r: 0.006 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.786 ? P.hairTip : P.hair), RH);
      add(TUBE([
        { p: [0.092 * s, 1.800, 0.044], r: 0.025 },
        { p: [0.130 * s, 1.758, 0.116], r: 0.019 },
        { p: [0.148 * s, 1.722, 0.144], r: 0.006 },
      ], { radial: 7, capStart: 'flat', capEnd: 'round' }), 'hair',
        (x, y) => (y < 1.758 ? P.hairTip : P.hair), RH);
    }
    add(TUBE([
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
      const LG = DENS === 1 ? 1 : gainAt('metal', 0.156 * Math.sin(a * D2R), 1.800, 0.166 * Math.cos(a * D2R));
      const leaf = new THREE.SphereGeometry(1, Math.round(8 * LG), Math.round(6 * LG));
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
      add(TUBE([
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
    // 12 radial segments is the SHIPPED count and it is deliberately low so the
    // shallow shell shows facet arrises in silhouette. Under density the shell
    // is a struck plate carrying planishing and a repousse bead ring, so it
    // needs the resolution to hold them.
    const cg = DENS === 1 ? 1 : gainAt('metal', BX(s) + o.px * s, o.py, 0.004);
    const g = prim(new THREE.SphereGeometry(1, Math.round(12 * cg), Math.round(5 * cg), 0, TAU, 0, 1.24), { scale: o.scale });
    prim(g, { rot: [0, 0, -o.tilt * s], pos: [BX(s) + o.px * s, o.py, 0.004] });
    g.userData.dk = 'mt.plate';
    g.userData.dc = [BX(s) + o.px * s, o.py, 0.004, o.scale[0] * 0.66];
    // the crown of the cap only — the old +0.012 threshold put metalHot (which
    // is #ffe0a0, i.e. near white) over most of the dome and gave the shoulder
    // a bald pale highlight bigger than the head.
    add(g, 'metal', (x, y) => (y > o.py + o.scale[1] * 0.66 ? P.metalHot : P.metal), { mode: 'rigid', bone });
    // CREST: a fore-aft ridge over the crown of the cap. This is the one arris
    // the play camera (pitch 45, looking DOWN) actually sees, and without it the
    // top of the shoulder was the largest unbroken specular surface on the hero.
    add(TUBE([
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
    add(TUBE([{ p: [0.192 * SW * s, 1.566, 0.004], r: 0.021, sx: 0.72, sz: 1.0 },
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
    add(TUBE([
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
    add(BALL(16, 10, { pos: [0.052, 1.352, 0.164], scale: [0.050, 0.050, 0.020] }),
      'metal', P.metal, { only: ['chest', 'spine2'] });
    {
      const tg = DENS === 1 ? 1 : gainAt('metal', 0.052, 1.352, 0.170);
      add(prim(new THREE.TorusGeometry(0.050, 0.0085, Math.round(8 * tg), Math.round(22 * tg)), { pos: [0.052, 1.352, 0.170] }),
        'metal', P.metalHot, { only: ['chest', 'spine2'] });
    }
    for (let i = 0; i < 4; i++) {
      const a = i * 90 + 45;
      add(BALL(6, 5, {
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
    { only: ['pelvis', 'spine1'] }, 'cl.leather');
  {
    // GIRDLE BOSSES. The spec has always claimed "gold girdle bosses"; there was
    // exactly ONE, a box on the front. Seven studs around the belt give the
    // waist a rhythm of tiny sharp glints (§4) and a value break between the
    // bare torso and the skirt.
    const NB = 9;
    for (let i = 0; i < NB; i++) {
      const a = (i / NB) * TAU + 0.35;
      if (Math.abs(Math.sin(a)) < 0.16 && Math.cos(a) > 0) continue;   // leave the buckle its space
      add(BALL(8, 6, {
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
    add(SHEET(6, 5, (u, v) => {
      const taper = 1 - 0.34 * u * u;
      const a = a0 + (v - 0.5) * arc * taper;
      const rr = lerp(0.160, 0.292, u * u * 0.40 + u * 0.60);
      // rounded tongue: the corners lift as the panel narrows
      const y = lerp(0.938, 0.938 - 0.496 * long, u) + 0.034 * u * u * Math.abs(v - 0.5) * 2;
      return V(rr * Math.sin(a), y, rr * Math.cos(a));
    }, 0.017), 'cloth',
      (x, y, z, u) => (u > 0.905 ? P.metalHot : (u > 0.845 ? P.metal : (u > 0.755 ? P.clothDeep : P.cloth))),
      { only: ['pelvis', `skirt${i}A`, `skirt${i}B`], bias: { pelvis: 0.55 } }, { k: 'cl.skirt', a: [i, NS] });
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
    add(SHEET(11, 18, (u, v) => {
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
      { only: ['chest', 'capeA', 'capeB', 'capeC', 'capeD'], bias: { chest: 0.7 } }, 'cl.cape');
    // shoulder clasps: the two points the mantle actually hangs from
    for (const s of [1, -1])
      add(BALL(10, 8, { pos: [0.118 * SW * s, 1.498, -0.026], scale: [0.030, 0.030, 0.016] }),
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
    add(TUBE([
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
    add(BALL(16, 12,
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
    add(TUBE([
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
        add(TUBE([
          { p: [0.250 * SW * s + dx, 0.812, 0.046], r: 0.0110 },
          { p: [0.251 * SW * s + dx * 1.10, 0.782 + 0.010 * (1 - len), 0.052], r: 0.0100 },
          { p: [0.252 * SW * s + dx * 1.18, 0.750 + 0.020 * (1 - len), 0.046], r: 0.0088 },
          { p: [0.252 * SW * s + dx * 1.22, 0.726 + 0.026 * (1 - len), 0.030], r: 0.0070 },
        ], { radial: 6, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin',
          spectral ? P.metalDeep : P.skin, { mode: 'rigid', bone: HN });
      }
      add(TUBE([
        { p: [0.220 * SW * s, 0.872, 0.036], r: 0.0150 },
        { p: [0.198 * SW * s, 0.840, 0.058], r: 0.0130 },
        { p: [0.192 * SW * s, 0.812, 0.076], r: 0.0095 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin,
        { mode: 'rigid', bone: HN });
    } else {
      // the fist, bound RIGID to the same bone the weapon uses so hand and hilt
      // are one shape by construction
      add(TUBE([
        { p: [0.215 * SW * s, 0.868, 0.052], r: 0.0125 },
        { p: [0.252 * SW * s, 0.872, 0.058], r: 0.0135 },
        { p: [0.286 * SW * s, 0.866, 0.050], r: 0.0115 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.metalHot : P.skin, { mode: 'rigid', bone: HN });
      for (let fi = 0; fi < 3; fi++) {
        const dx = (-0.026 + fi * 0.026) * s;
        add(TUBE([
          { p: [0.252 * SW * s + dx, 0.866, 0.058], r: 0.0115 },
          { p: [0.253 * SW * s + dx, 0.836, 0.056], r: 0.0110 },
          { p: [0.253 * SW * s + dx, 0.812, 0.040], r: 0.0095 },
        ], { radial: 7, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.metalDeep : P.skinDeep, { mode: 'rigid', bone: HN });
      }
      add(TUBE([
        { p: [0.216 * SW * s, 0.884, 0.030], r: 0.0155 },
        { p: [0.205 * SW * s, 0.856, 0.052], r: 0.0140 },
        { p: [0.212 * SW * s, 0.832, 0.068], r: 0.0105 },
      ], { radial: 8, capStart: 'round', capEnd: 'round' }), spectral ? 'glow' : 'skin', spectral ? P.glow : P.skin, { mode: 'rigid', bone: HN });
    }
    if (spectral) {
      for (let ri = 0; ri < 3; ri++) {
        const rg = DENS === 1 ? 1 : gainAt('glow', 0.249 * SW * s, 1.07 - ri * 0.075, 0.004);
        add(prim(new THREE.TorusGeometry((0.064 - ri * 0.006) * SW, 0.007, Math.round(8 * rg), Math.round(20 * rg)), {
          pos: [0.249 * SW * s, 1.07 - ri * 0.075, 0.004], rot: [90, 0, 0],
        }), 'glow', ri === 1 ? P.metalHot : P.glow, { mode: 'rigid', bone: 'fore' + S });
      }
    }
    if (F.bracers) {
      add(TUBE([{ p: [0.247 * SW * s, 1.118, -0.008], r: 0.068 * BK }, { p: [0.250 * SW * s, 0.938, 0.010], r: 0.061 * BK }],
        { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metalDeep, { mode: 'rigid', bone: 'fore' + S },
        { k: 'mt.plate', a: [0.249 * SW * s, 1.028, 0.001, 0.062] });
      // rolled cuffs, as bands so each has a lit arris and an undercut
      add(band({ cx: 0.247 * SW * s, cy: 1.116, cz: -0.008, R: 0.070 * BK, th: 0.0090, hh: 0.017, seg: 22, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'fore' + S });
      add(band({ cx: 0.250 * SW * s, cy: 0.944, cz: 0.010, R: 0.064 * BK, th: 0.0085, hh: 0.015, seg: 22, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'fore' + S });
      // a raised spine down the bracer: one more arris for the key to run along
      add(TUBE([
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
    add(TUBE([
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
      add(TUBE([
        { p: [0.115 * s, 0.548, -0.004], r: 0.081 * BK, sz: 1.02 },
        { p: [0.118 * s, 0.372, -0.014], r: 0.082 * BK, sz: 1.02 },
        { p: [0.120 * s, 0.186, -0.024], r: 0.058 * BK, sz: 1.02 },
      ], { radial: 12, capStart: 'flat', capEnd: 'flat' }), 'metal', P.metal, { mode: 'rigid', bone: 'shin' + S },
        { k: 'mt.plate', a: [0.118 * s, 0.400, 0.010, 0.070] });
      // knee cop + a crest running the length of the greave: the shin is the
      // second-largest metal surface on the hero and it had one soft dome and
      // one hexagonal ring on it.
      add(BALL(16, 10, { pos: [0.115 * s, 0.548, 0.006], scale: [0.084 * BK, 0.076, 0.086 * BK] }),
        'metal', P.metalHot, { mode: 'rigid', bone: 'shin' + S },
        { k: 'mt.plate', a: [0.115 * s, 0.548, 0.006, 0.055] });
      add(TUBE([
        { p: [0.115 * s, 0.556, 0.070 * BK], r: 0.0115, sx: 0.8, sz: 1.0 },
        { p: [0.118 * s, 0.400, 0.064 * BK], r: 0.0100, sx: 0.8, sz: 1.0 },
        { p: [0.120 * s, 0.232, 0.030 * BK], r: 0.0065, sx: 0.8, sz: 1.0 },
      ], { radial: 7, capStart: 'round', capEnd: 'round' }), 'metal', P.metalHot, { mode: 'rigid', bone: 'shin' + S });
      add(band({ cx: 0.120 * s, cy: 0.190, cz: -0.024, R: 0.062 * BK, th: 0.0085, hh: 0.016, seg: 22, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'shin' + S });
      add(band({ cx: 0.115 * s, cy: 0.556, cz: -0.004, R: 0.085 * BK, th: 0.0085, hh: 0.014, seg: 24, radial: 8 }),
        'metal', chamfer(P.metalHot, P.metal, P.metalDeep), { mode: 'rigid', bone: 'shin' + S });
    }
    add(TUBE([
      { p: [0.120 * s, 0.118, -0.052], r: 0.052 },
      { p: [0.121 * s, 0.078, 0.014], r: 0.058, sx: 0.96 },
      { p: [0.122 * s, 0.056, 0.094], r: 0.052, sx: 0.90 },
      { p: [0.122 * s, 0.046, 0.152], r: 0.028, sx: 0.84 },
    ], { radial: 10, capStart: 'round', capEnd: 'round', capScale: 0.8 }), 'cloth', P.leather,
      { only: ['foot' + S, 'toe' + S, 'shin' + S] }, 'cl.leather');
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
    add(TUBE([{ p: [-0.250, 0.922, 0.012], r: 0.019 }, { p: [-0.253, 0.800, 0.046], r: 0.017 }],
      { radial: 8, capStart: 'round', capEnd: 'flat' }), 'cloth', P.leather, { mode: 'rigid', bone: HB }, 'cl.leather');
    add(BALL(12, 10, { pos: [-0.249, 0.934, 0.008], scale: [0.028, 0.024, 0.028] }),
      'metal', P.metalHot, { mode: 'rigid', bone: HB });
    add(TUBE([{ p: [-0.309, 0.788, 0.048], r: 0.015, sx: 0.62, sz: 1.55 },
    { p: [-0.197, 0.788, 0.048], r: 0.015, sx: 0.62, sz: 1.55 }],
      { radial: 8, capStart: 'round', capEnd: 'round', up: [0, 1, 0] }), 'metal', P.metalHot, { mode: 'rigid', bone: HB });
    const base = V(-0.255, 0.776, 0.052);
    const dir = V(-0.115, -1, 0.30).normalize();
    const across = V(1, 0, 0.28).normalize();
    add(SHEET(10, 3, (u, v) => {
      const L = 0.60;
      const w = 0.058 * (0.52 + 0.48 * Math.sin(Math.PI * Math.pow(clamp01(u), 0.82))) * (1 - Math.pow(u, 3.4));
      return base.clone().addScaledVector(dir, L * u).addScaledVector(across, (v - 0.5) * 2 * w);
    }, 0.017), 'metal', (x, y, z, u, v, side) => (side === 0 ? P.bladeEdge : P.blade), { mode: 'rigid', bone: HB }, 'mt.blade');
  }

  return parts;
}

// ---------------------------------------------------------------------------
// ASSEMBLY
// ---------------------------------------------------------------------------

function paintPart(g, tint, cav, H, k) {
  const pos = g.getAttribute('position'), uvA = g.getAttribute('uv'), sdA = g.getAttribute('side');
  const pa = pos.array, ua = uvA ? uvA.array : null, sa = sdA ? sdA.array : null;
  const n = pos.count, col = new Float32Array(n * 3);
  const cache = new Map();
  const look = (hx) => { let c = cache.get(hx); if (!c) { c = linRGB(hx); cache.set(hx, c); } return c; };
  const isFn = typeof tint === 'function';
  const constC = isFn ? null : look(tint);
  // NOTE: `/ k`, not `* (1/k)`. Multiplying by the reciprocal is a different
  // floating-point result in the last bit, and the vertex-colour attribute is
  // part of the byte-identity contract every non-opted-in actor relies on.
  for (let i = 0; i < n; i++) {
    const x = pa[i * 3], y = pa[i * 3 + 1], z = pa[i * 3 + 2];
    let c = constC;
    if (isFn) {
      const r = tint(x / k, y / k, z / k, ua ? ua[i * 2] : 0, ua ? ua[i * 2 + 1] : 0, sa ? sa[i] : 1);
      c = Array.isArray(r) ? r : look(r);
    }
    let ao = aoAt(x / k, y / k, z / k, 1.90);
    // ── CREVICE AO, RESOLVED (§4) ─────────────────────────────────────────
    // The CREVICE table is a list of ~60 hand-placed spheres, and at 25k
    // triangles that was the only AO the mesh could carry: anything smaller
    // than a vertex spacing had nowhere to land. The displacement pass has
    // just authored a concavity at every fold trough, hair groove, planished
    // dish, stitch gutter and knuckle valley — each of which is a crevice by
    // definition — so it darkens itself, at exactly the scale it was cut.
    if (cav) ao *= 1 - 0.38 * cav[i];
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

  /**
   * Author, displace and skin one complete slot-bucketed geometry for `sp`.
   * Factored out so a second, cheaper geometry can be built against the SAME
   * skeleton for the dash after-images (see ghostGeometry below).
   */
  const buildGeometry = (sp, outline) => {
    const K2 = sp.height / 1.90;
    const parts = buildParts(sp);
    // DISPLACEMENT runs in the reference 1.90m space, between authoring and the
    // height scale, so a spec with a different `height` gets detail scaled with
    // it rather than a fixed 0.5mm grain on a 2.4m brute. At density 1 nothing
    // here executes at all and the mesh is byte-identical.
    //
    // `outline` builds the SILHOUETTE PROXY, whose two consumers — the shadow
    // map and the flat additive dash after-images — record an outline and
    // nothing else. It therefore skips both surface passes: the displacement
    // field (whose whole output is shading structure the shadow map cannot
    // record and a flat MeshBasicMaterial cannot show) and the vertex paint
    // (player.js builds the ghost material with vertexColors off, and the
    // proxy's own material has colorWrite off). Measured on the hero: the
    // proxy build goes 15.0ms -> 8.2ms and its mean silhouette IoU against the
    // dense mesh goes 0.9622 -> 0.9591, which is 0.31% of an outline that only
    // ever appears as a shadow or as a 0.4-opacity additive flat.
    if (!outline && (sp.density ?? 1) !== 1) for (const p of parts) p.cav = displacePart(p.g, p.slot, p.dsp);
    if (K2 !== 1) for (const p of parts) p.g.scale(K2, K2, K2);
    const bucketMap = new Map();
    for (const p of parts) {
      const rule = { ...(p.bind || {}) };
      if (rule.only === 'body') rule.only = bodyNames;
      else if (rule.only === 'torso') rule.only = torsoNames;
      const P = p.g.getAttribute('position');
      const { SI, SW } = solveSkinWeights(P.array, segs, rule, byName);
      const col = outline ? new Float32Array(P.count * 3) : paintPart(p.g, p.tint, p.cav, sp.height, K2);
      if (p.g.getAttribute('side')) p.g.deleteAttribute('side');
      if (!bucketMap.has(p.slot)) bucketMap.set(p.slot, []);
      bucketMap.get(p.slot).push({ g: p.g, col, SI, SW });
    }
    const bl = SLOTS.filter(x => bucketMap.has(x)).map(x => ({ slot: x, items: bucketMap.get(x) }));
    return { geo: mergeBuckets(bl), buckets: bl };
  };

  const built = buildGeometry(spec);
  const geo = built.geo, buckets = built.buckets;
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

  // ── THE SILHOUETTE PROXY ─────────────────────────────────────────────────
  // One reduced mesh on this same skeleton, built on first use and shared by
  // the dash after-images and the shadow caster — the two consumers that record
  // only an OUTLINE and can see none of this pass's surface work.
  //
  // 0.8 is measured, not guessed. Rasterising each candidate against the dense
  // hero at the shipping framing, four yaws, and taking the mean silhouette
  // IoU (re-measured after the density rebalance):
  //     the hero itself      113564 tris  1.0000
  //     density 1.0           25304 tris  0.9800   (what the ghosts used to use)
  //     density 0.8 displaced  9500 tris  0.9622
  //     density 0.8 OUTLINE    9500 tris  0.9591   <- what is built
  //     density 0.75           6952 tris  0.9053
  // i.e. a proxy at 38% of the shipped mesh's triangles is within 2.1% of the
  // outline the shipped mesh itself draws, and 0.75 falls off a cliff, so 0.8
  // is a knee and not a point on a slope. Dropping the displacement from the
  // proxy (see buildGeometry's `outline`) costs 0.31% of that IoU and saves
  // 6.8ms of build; a shadow map and a 0.4-opacity additive ghost cannot
  // record 0.31% of an outline.
  const PROXY_DENSITY = 0.8;
  let ghostGeo = null;
  const ghostGeometry = () => {
    if (ghostGeo) return ghostGeo;
    ghostGeo = (spec.density ?? 1) === 1 ? geo : buildGeometry({ ...spec, density: PROXY_DENSITY }, true).geo;
    return ghostGeo;
  };

  // ── SHADOW LOD ───────────────────────────────────────────────────────────
  // A shadow map records a SILHOUETTE at a few hundred pixels. Every gain this
  // pass bought — the clavicle hollow, the planished facets, the stitch rows,
  // the pore grain — is invisible in it by construction, and the character was
  // paying full price twice: measured in 07_combat, the depth pass submitted
  // the hero's whole mesh for a second time, for a shape a 9,500-triangle
  // proxy describes to within 2% at that resolution.
  // So the dense mesh stops casting and a proxy on the SAME skeleton casts
  // instead. It is in the scene graph rather than hidden because three renders
  // the shadow map by walking the scene and honours `material.visible` there
  // too — an invisible object casts nothing. `colorWrite:false` + no depth
  // write is what makes it contribute nothing to the beauty pass while still
  // being a shadow caster; it costs one draw call and ~10k triangles.
  let shadowProxy = null;
  if ((spec.density ?? 1) !== 1) {
    mesh.castShadow = false;
    // THE PROXY'S MATERIAL MUST COMPILE NO NEW SHADER.
    // Nothing it draws is ever written, so its only real requirement is to add
    // no program: §9 budgets programs at 80 and this scene already measures 81
    // without the proxy. A fresh MeshBasicMaterial took it to 85 (a
    // basic+skinning permutation the scene did not have, plus its depth
    // variants); matching the ghosts' basic material got it to 84.
    //
    // A CLONE IS NOT AUTOMATICALLY FREE, AND AN EARLIER VERSION OF THIS COMMENT
    // CLAIMED IT WAS. THREE.Material.copy() transfers the declared material
    // fields; it does NOT transfer own function properties, and
    // materials/painterly.js installs BOTH of the ones that decide the program
    // — `onBeforeCompile` and `customProgramCacheKey` — as own properties on
    // the instance. A bare clone therefore falls back to Material.prototype's
    // empty onBeforeCompile and undefined cache key, WebGLPrograms hashes the
    // source function text into the key, and the two disagree:
    //     source key  'paint3:character:...'
    //     clone key   'onBeforeCompile( /* shaderobject, renderer */ ) {}'
    // which is a different program, compiled and linked, and it is the whole of
    // the 82nd program the §9 budget was failing on. Carrying the two functions
    // across makes the keys identical again, and three hands back the program
    // the hero is already using. Measured with renderer.info.programs.length in
    // 07_combat: 82 before, 80 after.
    //
    // The shadow pass needs nothing extra: three builds its depth material from
    // the source material's maps and side, so the proxy reuses the same skinned
    // depth permutation the hero's own caster used before this change.
    // colorWrite/depthWrite are GL state rather than defines, so switching them
    // off is free and does not perturb the key either.
    const src = materials[0];
    let pm;
    if (src && src.clone) {
      pm = src.clone();
      if (src.onBeforeCompile) pm.onBeforeCompile = src.onBeforeCompile;
      if (src.customProgramCacheKey) pm.customProgramCacheKey = src.customProgramCacheKey;
      // painterly()'s onBeforeCompile closes over the SOURCE material's uniform
      // bag, so the clone has to point at the same userData or a later
      // setPaint()/setBiome() would edit one and the shader would read the
      // other. Sharing it is correct here precisely because the proxy writes no
      // colour: it has no look of its own to keep separate.
      pm.userData = src.userData;
    } else pm = new THREE.MeshBasicMaterial();
    pm.colorWrite = false; pm.depthWrite = false; pm.name = spec.name + '.shadowlod';
    shadowProxy = new THREE.SkinnedMesh(ghostGeometry(), pm);
    shadowProxy.name = spec.name + '.shadowlod';
    shadowProxy.castShadow = true;
    shadowProxy.receiveShadow = false;
    shadowProxy.frustumCulled = false;
    shadowProxy.matrixAutoUpdate = false;
    root.add(shadowProxy);
    shadowProxy.updateMatrixWorld(true);
    shadowProxy.bind(skeleton, mesh.bindMatrix);
  }

  const rig = {
    spec, height: H, root, mesh, skeleton, bones, boneList, byName, chains, bind, materials,
    /** the density-1 shadow caster, or null when this actor is not tessellated */
    shadowProxy,
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
    /**
     * frozen after-image copy: owns a cloned skeleton, and — once the actor is
     * dense — a SEPARATE cheap geometry rather than the hero's own.
     *
     * MEASURED, and it was the single biggest line in the frame. player.js
     * keeps TUNING.dashGhosts = 3 after-images, the renderer submits each of
     * them twice per frame, and every one of those six submissions was the
     * hero's full geometry. In 07_combat that came to 1,327,854 of the frame's
     * 2,620,076 triangles — half of the entire §9 scene budget, spent on three
     * flat MeshBasicMaterial silhouettes at ~0.4 opacity during a 0.16s dash,
     * on a mesh whose detail is pores and hammer facets that a flat colour
     * cannot show at all.
     *
     * The ghosts get the silhouette proxy instead (see PROXY_DENSITY), which
     * measures as faithful an outline as the mesh they used to share, built
     * lazily so every enemy in the roster pays nothing for it.
     */
    makeGhost(material) {
      const gb = {}, gl = [];
      for (const d of def.list) {
        const b = new THREE.Bone(); b.name = d.name;
        b.position.copy(bones[d.name].position);
        gb[d.name] = b; gl.push(b);
      }
      for (const d of def.list) if (d.parent) gb[d.parent].add(gb[d.name]);
      const gm = new THREE.SkinnedMesh(ghostGeometry(), material);
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
      if (ghostGeo && ghostGeo !== geo) ghostGeo.dispose();
      shadowProxy?.material?.dispose?.();
      for (const m of materials) m.dispose?.();
    },
  };
  return rig;
}

export default { buildHumanoid, HERO_SPEC, HERO_PALETTE, MELINOE_SPEC, MELINOE_PALETTE, mergeSpec, tubeGeo, sheetGeo, prim, solveSkinWeights, linRGB };
