// Player-held Infernal and Nocturnal Arms. These are separate hand-mounted
// models rather than part of the skinned body, so changing the combat weapon
// changes the hero's silhouette as well as their move set.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ARMS WERE OFF THE PIPELINE ENTIRELY. Recorded because it is the single
// largest colour defect anyone has measured on this character, and none of it
// was visible from inside materials/.
//
//  1. WRONG PALETTE. materialsFor() built every part out of `WEAPONS[id].palette`
//     — for the xiphos that is { core:'#fffdf0', body:'#ffe9a8', glow:'#ffb04a' },
//     three near-white warm hexes authored for VFX tints. entities/rig.js's
//     HERO_PALETTE.blade '#8e93ab' ("steel, deliberately NOT white") and
//     bladeEdge '#d8cfae' reached no pixel of the sword the player is holding.
//     Measured on shots/base/03_hero_char.png, a patch of blade face rendered
//     rgb(240,226,168) — hue 48. The authored steel is hue 229. A 180-degree
//     error, and it was an error of ADDRESS: the right colour was never asked for.
//
//  2. RAW MeshStandardMaterial. Nothing here was ever passed through
//     materials/painterly.js, so the arms had no shading ramp, no coloured
//     shadow, no rim, no contour and no ink floor — and, critically, no
//     `litGain`. Every other surface on the hero is cut to litGain 0.42-0.56 by
//     entities/rig.js SLOT_PAINT; the sword took the key (18.0) and the subject
//     light (8.5) at full strength, so it rendered roughly two stops hotter than
//     the hand holding it and sat squarely on AgX's bleach shoulder. §7 names
//     "default Three.js MeshStandardMaterial ... in a shipped shot" as an
//     auto-fail; this was one.
//
//  3. METAL WITH NO ENVIRONMENT. `edge` ran metalness 0.96 and `body` 0.82 with
//     no envMap anywhere. In three a conductor's diffuse is albedo*(1-metalness)
//     — 4% for the edge — and its indirect specular comes from an environment
//     map it did not have. So the entire read of the blade was ONE broad direct
//     specular lobe of the warm key: a flat cream cutout, by construction,
//     whatever colour it was painted.
//
// The rebuild below fixes all three. Every arm is now built from one PAINT
// vocabulary — steel, edge, gold, gold-hot, gold-deep, leather, wrap, wood, and
// the weapon's own accent — patched with the CHARACTER look and pinned to
// SLOT_PAINT.metal / SLOT_PAINT.cloth so an arm is lit by exactly the same law
// as the armour on the arm that carries it. Per-weapon identity moves off the
// structural metal (where it was making twelve cream props) and on to the
// ACCENT, which is where §5's core/body/glow puts it anyway. (Those nine names
// are now vertex TINTS on four slot materials rather than nine materials of
// their own — see "ONE MATERIAL PER SLOT" below — but every hex is unchanged.)
// ─────────────────────────────────────────────────────────────────────────────

import * as THREE from 'three';
import { WEAPONS, WEAPON_IDS } from './weapons.js';
import { HERO_PALETTE, SLOT_PAINT, linRGB, tubeGeo } from './rig.js';
import { painterly, setPaint, paintParams, keyRef } from '../materials/painterly.js';

const Y = new THREE.Vector3(0, 1, 0);
const D = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);

// The furniture palette. Steel and its edge are §2/HERO_PALETTE values verbatim;
// the golds are the game's ornament spine; the leathers are the hero's own.
const P = {
  steel:    HERO_PALETTE.blade,      // '#8e93ab' — cool, and NOT white
  steelLit: '#a9aec4',               // the polished face just off the ridge
  steelDeep:'#3f4356',               // fuller floor / under-bevel
  edge:     HERO_PALETTE.bladeEdge,  // '#d8cfae' — the sharpened bevel
  gold:     HERO_PALETTE.metal,      // '#f0bb52'
  goldHot:  HERO_PALETTE.metalHot,   // '#ffe0a0' — arris only, never a face
  goldDeep: HERO_PALETTE.metalDeep,  // '#7d4c17'
  leather:  HERO_PALETTE.leather,    // '#37203f'
  wrap:     '#5a3550',               // the cord over the leather core
  wood:     '#4a2f22',
  bone:     '#cfc0a4',
};

// ── ONE MATERIAL PER SLOT, HUE PER VERTEX ────────────────────────────────────
// The rebuild above got the arms' COLOUR right and their COST wrong. It gave
// every arm its own thirteen-material vocabulary and modelled every quillon
// finial, cord turn and gem as a separate Mesh, so the equipped arm alone was
// 17 draw submissions (blade: 15 meshes, and the leaf's three material groups
// are three more) — doubled by the shadow pass. §9's frame budget is < 400
// calls and the capture measured 419.
//
// Nothing in bladeModel() — or in any of the other eleven — moves relative to
// its group. The runtime only ever toggles `group.visible`; the spear's throw
// is a projectile built in vfx/, not this mesh detaching, and no code anywhere
// outside this file looks a weapon sub-mesh up by name. So the parts do not
// need to be separate OBJECTS, only separate SURFACES.
//
// entities/rig.js already solved this for the body: it bakes the palette into a
// per-vertex COLOUR attribute and buckets parts by material SLOT, which is how
// several hundred authored pieces of hero render in five calls. The arsenal now
// runs the same law. The thirteen hexes collapse to four slot materials —
//
//   metal   the diffuse-led body metal      (steel, steelLit, steelDeep, gold,
//                                            goldDeep, bone)
//   edge    the specular-led narrow bevels  (edge, goldHot)
//   cloth   leather, cord and wood          (leather, wrap, wood)
//   accent / core   the one emissive        (the arm's identity glow)
//
// — and every hex that used to be a material is now a vertex colour. WHY FOUR
// AND NOT THREE: roughness is a material scalar, not a vertex attribute, and
// §4's "small, bright, sharp glint" IS the 0.15-roughness bevel. Folding the
// edge into the 0.44-roughness body would spread one broad lobe over the whole
// face and undo the exact thing the rebuild was for. Colour merges; a specular
// lobe width does not.
//
// The parts themselves survive as named, zero-cost WeaponPart anchors (see
// below), so the design is still addressable and still auditable — they simply
// stop being draw calls.
const SLOT_MAT = {
  metal:  { paint: 'metal', roughness: 0.44, metalness: 0.35, tune: { specGain: 0.44 } },
  // Roughness 0.15 and a raised specGain put the whole lobe inside a few pixels
  // — the sharpened bevel of the leaf, the guard's hot arris, the rail's rails.
  edge:   { paint: 'metal', roughness: 0.15, metalness: 0.42, tune: { specGain: 1.12, rimStrength: 2.2 } },
  cloth:  { paint: 'cloth', roughness: 0.85, metalness: 0.03 },
  accent: { paint: 'metal', roughness: 0.26, metalness: 0.10, tune: { specGain: 0.50 }, emissive: 'glow', emissiveIntensity: 0.55 },
  core:   { paint: 'metal', roughness: 0.20, metalness: 0.08, tune: { litGain: 0.30, specGain: 0.40 }, emissive: 'core', emissiveIntensity: 0.90 },
};
// Fixed iteration order — the merge must be byte-identical run to run.
const SLOT_ORDER = ['metal', 'edge', 'cloth', 'accent', 'core'];

/**
 * A weapon slot material. `paint` is the per-slot painterly table the hero's own
 * armour runs — importing it rather than restating it is what keeps an arm and
 * a bracer in the same light when either is retuned.
 *
 * The base colour is WHITE on purpose: every hue on the arm arrives through the
 * vertex-colour attribute the bake writes, exactly as it does on the body.
 */
function slotMaterial(slot, wp, owned, kr) {
  const cfg = SLOT_MAT[slot];
  const paint = SLOT_PAINT[cfg.paint];
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: cfg.roughness,
    // METALNESS IS CAPPED AT 0.42 ON PURPOSE. These arms have no prefiltered
    // environment (see the header), and a conductor without one loses both its
    // diffuse and its indirect specular. 0.30-0.42 keeps ~2/3 of the albedo in
    // the diffuse term — which is the only term that can carry a HUE here — and
    // still tints the direct lobe, so a low-roughness bevel gives §4's "small,
    // bright, sharp glint" without the body going dead.
    metalness: cfg.metalness,
    emissive: D(cfg.emissive ? (wp[cfg.emissive] || wp.glow) : '#000000'),
    emissiveIntensity: cfg.emissiveIntensity || 0,
    dithering: false,
  });
  m.vertexColors = true;
  painterly(m, { variant: 'character', keyRef: kr || keyRef(), ...paint });
  setPaint(m, paint);
  if (cfg.tune) setPaint(m, cfg.tune);
  // _applyRim in materials/library.js honours paintOverrides; these arms are
  // never in its cache, but declaring them keeps the contract identical to the
  // one entities/rig.js signs for the body.
  m.userData.paintOverrides = {
    rimStrength: (cfg.tune && cfg.tune.rimStrength) ?? paint.rimStrength,
    rimPower: (cfg.tune && cfg.tune.rimPower) ?? paint.rimPower,
    rimColor: paint.rimColor, rimDir: paint.rimDir,
  };
  m.needsUpdate = true;
  owned.add(m);
  return m;
}

/**
 * AN AUTHORED PART: a geometry, a paint token and a transform.
 *
 * It is deliberately NOT a Mesh. bakeArm() below transforms every part's
 * geometry into arm space, writes its paint into the vertex-colour attribute
 * and merges it with every other part in the same slot, so the whole arm ships
 * as three or four meshes. The Part stays in the graph as a named, geometry-free
 * anchor: it costs nothing to render, it keeps the authored design addressable
 * (`group.getObjectByName('avatar.weapon.blade.pommel')` still resolves, and
 * still carries the pommel's transform for anything that wants to hang a socket
 * or an emitter off it), and it is what makes the merge auditable — the part
 * list is still the part list.
 *
 * If a part ever has to MOVE relative to its arm, this is the seam: give it its
 * own Mesh in bakeArm() instead of folding it into a bucket. Nothing needs that
 * today — the runtime only toggles `group.visible`, and the spear's throw is a
 * projectile, not this mesh detaching.
 */
class WeaponPart extends THREE.Object3D {
  constructor(geometry, paint, name) {
    super();
    this.isWeaponPart = true;
    this.geometry = geometry;
    this.paint = paint;
    this.name = name;
  }
}

function addMesh(parent, geometry, paint, name) {
  const part = new WeaponPart(geometry, paint, name);
  parent.add(part);
  return part;
}

function rod(parent, a, b, radius, paint, name, sides = 8) {
  const delta = b.clone().sub(a);
  const part = addMesh(parent, new THREE.CylinderGeometry(radius, radius, delta.length(), sides), paint, name);
  part.position.copy(a).add(b).multiplyScalar(0.5);
  part.quaternion.setFromUnitVectors(Y, delta.normalize());
  return part;
}

/**
 * A wrapped grip: a leather core with cord turns over it. Three lines of
 * geometry, and it is the difference between "a cylinder" and "a hilt" at play
 * scale — the turns break the one long specular streak a bare cylinder gives
 * into a row of short ones, which is what reads as binding.
 */
function wrappedGrip(g, pal, { y, r0, r1, len, turns = 5, name }) {
  const coreGeo = new THREE.CylinderGeometry(r0, r1, len, 10);
  const core = addMesh(g, coreGeo, pal.leather, name);
  core.position.y = y;
  const out = [coreGeo];
  for (let i = 0; i < turns; i++) {
    const t = (i + 0.5) / turns;
    const r = r0 + (r1 - r0) * t;
    const ringGeo = new THREE.TorusGeometry(r * 0.98, r * 0.20, 5, 12);
    const ring = addMesh(g, ringGeo, pal.wrap, `${name}.wrap.${i}`);
    ring.position.y = y + len * (0.5 - t);
    ring.rotation.x = Math.PI / 2;
    ring.rotation.y = 0.20 * (i % 2 ? 1 : -1);
    out.push(ringGeo);
  }
  return out;
}

/**
 * The arm's PAINT TABLE: the same thirteen-name vocabulary the models are
 * authored against, but each name now resolves to a slot plus a linear vertex
 * tint instead of to a material of its own. The models did not change; what a
 * name MEANS did.
 */
function paintsFor(id) {
  const wp = WEAPONS[id].palette;
  // A per-arm tint on the structural steel: 16% toward the weapon's own body
  // hue, so the Nocturnal arms read cooler than the Infernal ones as black
  // shapes with a colour cast.
  //
  // THE TINT IS LUMINANCE-NORMALISED, and the first build of it was not — which
  // put the bug straight back. WEAPONS.blade.palette.body is GOLD '#ffe9a8', a
  // 92%-luminance hex; a plain lerp toward it dragged #8e93ab steel up AND warm,
  // and the sword measured rgb(206,177,169), hue 12 — pale and pink, i.e. the
  // same cream failure in a new place. Scaling the target to the base's own
  // luminance first makes this a HUE cast and nothing else: the steel keeps its
  // value and the cool stays cool.
  //
  // IT SURVIVES THE MERGE UNCHANGED. The per-arm identity was never carried by
  // the material — it is two hexes and an emissive — so moving the hexes into
  // the vertex-colour attribute moves the identity with them, byte for byte.
  const tintTo = (baseHex, towardHex, k) => {
    const a = D(baseHex), b = D(towardHex);
    const la = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b;
    const lb = Math.max(1e-4, 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b);
    b.multiplyScalar(la / lb);
    return '#' + a.lerp(b, k).getHexString();
  };
  const steel = tintTo(P.steel, wp.body || P.steel, 0.16);
  const steelLit = tintTo(P.steelLit, wp.body || P.steelLit, 0.14);
  // linRGB is entities/rig.js's own hex -> scene-linear conversion, so a weapon
  // vertex colour and a body vertex colour are made by the same function.
  const T = (slot, hex) => ({ slot, tint: linRGB(hex) });
  return {
    // THE BODY IS DIFFUSE-LED, THE EDGE IS SPECULAR-LED. §4: "specular is a
    // small, bright, sharp glint — jewelry and metal only", and the operative
    // word is SMALL. At roughness 0.30 the lobe covered the entire face and the
    // blade read as one pale wash, with the facets of the new section flattened
    // underneath it. The metal slot's 0.44 roughness and cut specGain hand the
    // body back to the diffuse ramp — which is what separates the four facets —
    // and leave the whole highlight budget to the edge slot's 0.15-roughness
    // bevel, where it belongs. steel / steelLit / steelDeep are now three tints
    // of one material: the ridge is still brighter than the mid-face, and the
    // FACET is still doing the work.
    steel:     T('metal', steel),
    steelLit:  T('metal', steelLit),
    steelDeep: T('metal', P.steelDeep),
    // THE EDGE. An edge bevel is the only geometry on a sword narrow enough to
    // give §4 its small, bright, sharp glint, so it keeps its own material.
    edge:      T('edge',  P.edge),
    gold:      T('metal', P.gold),
    goldHot:   T('edge',  P.goldHot),   // arris only, never a face — so: edge slot
    goldDeep:  T('metal', P.goldDeep),
    leather:   T('cloth', P.leather),
    wrap:      T('cloth', P.wrap),
    wood:      T('cloth', id === 'spear' ? '#533c31' : P.wood),
    bone:      T('metal', P.bone),
    // THE ACCENT carries the arm's identity, and it is the only emissive on it.
    // §5: a bright core, a saturated body, and nothing wide. Emissive is a
    // material uniform, not a vertex attribute — but an arm only ever has ONE
    // accent hue, so it costs exactly one more mesh and no generality.
    accent:    T('accent', wp.glow),
    core:      T('core', wp.core || wp.glow),
  };
}

// ── THE BAKE ────────────────────────────────────────────────────────────────

const _nm = new THREE.Matrix3();

/**
 * One part (or one material group of one part) reduced to flat arrays in arm
 * space, with its tint written per vertex.
 *
 * Only the vertices the range actually indexes are emitted, remapped in
 * first-encounter order — deterministic, and it is what lets a multi-group
 * geometry like the leaf split cleanly across two slots without dragging the
 * other slot's vertices along.
 */
function chunkOf(geo, matrix, from, count, tint) {
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal'), uvA = geo.getAttribute('uv');
  const index = geo.index ? geo.index.array : null;
  const map = new Map();
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const v = index ? index[from + i] : from + i;
    let n = map.get(v);
    if (n === undefined) { n = map.size; map.set(v, n); }
    idx[i] = n;
  }
  const n = map.size;
  const p = new Float32Array(n * 3), nr = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  _nm.getNormalMatrix(matrix);
  const me = matrix.elements, ne = _nm.elements;
  for (const [src, dst] of map) {
    const x = pos.getX(src), y = pos.getY(src), z = pos.getZ(src);
    const w = 1 / (me[3] * x + me[7] * y + me[11] * z + me[15] || 1);
    p[dst * 3]     = (me[0] * x + me[4] * y + me[8]  * z + me[12]) * w;
    p[dst * 3 + 1] = (me[1] * x + me[5] * y + me[9]  * z + me[13]) * w;
    p[dst * 3 + 2] = (me[2] * x + me[6] * y + me[10] * z + me[14]) * w;
    if (nrm) {
      const a = nrm.getX(src), b = nrm.getY(src), c = nrm.getZ(src);
      let nx = ne[0] * a + ne[3] * b + ne[6] * c;
      let ny = ne[1] * a + ne[4] * b + ne[7] * c;
      let nz = ne[2] * a + ne[5] * b + ne[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      nr[dst * 3] = nx / l; nr[dst * 3 + 1] = ny / l; nr[dst * 3 + 2] = nz / l;
    }
    if (uvA) { uv[dst * 2] = uvA.getX(src); uv[dst * 2 + 1] = uvA.getY(src); }
    col[dst * 3] = tint[0]; col[dst * 3 + 1] = tint[1]; col[dst * 3 + 2] = tint[2];
  }
  return { p, nr, uv, col, idx, n };
}

/** Concatenate one slot's chunks into a single indexed geometry. */
function mergeChunks(chunks) {
  let nv = 0, ni = 0;
  for (const c of chunks) { nv += c.n; ni += c.idx.length; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const c of chunks) {
    pos.set(c.p, vo * 3); nrm.set(c.nr, vo * 3); uv.set(c.uv, vo * 2); col.set(c.col, vo * 3);
    for (let i = 0; i < c.idx.length; i++) idx[io + i] = c.idx[i] + vo;
    io += c.idx.length; vo += c.n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Collapse an authored arm into one mesh per slot.
 *
 * Every WeaponPart in the group is flattened into arm space, bucketed by the
 * slot its paint names and merged. The parts stay in the graph as anchors (see
 * WeaponPart); what leaves is 6-17 draw submissions per arm, replaced by 3-4.
 *
 * @param g          the arm group, already fully authored
 * @param slotMat    (slot) => the arm's lazily-built material for that slot
 * @param geometries the disposal set — the MERGED geometries are the ones that
 *                   ever reach the GPU, so they are what has to be tracked
 */
function bakeArm(g, slotMat, geometries) {
  const buckets = new Map();
  const walk = (node, parentMatrix) => {
    for (const child of node.children) {
      child.updateMatrix();
      // Direct children keep their own matrix untouched — no re-multiplication,
      // so a part's baked position is bit-identical to the transform authored
      // for it. Only genuinely nested parts compose (there are none today).
      const m = parentMatrix ? new THREE.Matrix4().multiplyMatrices(parentMatrix, child.matrix) : child.matrix;
      if (child.isWeaponPart) {
        const geo = child.geometry;
        const total = geo.index ? geo.index.count : geo.getAttribute('position').count;
        // A part painted with an ARRAY carries one paint per material group —
        // the lenticular leaf is steel / edge / steelLit across its three — so
        // it splits across buckets by group rather than merging as a whole.
        const spans = Array.isArray(child.paint)
          ? geo.groups.map((gr, i) => [gr.start, gr.count, child.paint[Math.min(i, child.paint.length - 1)]])
          : [[0, total, child.paint]];
        for (const [start, count, paint] of spans) {
          if (!count) continue;
          let b = buckets.get(paint.slot);
          if (!b) buckets.set(paint.slot, b = []);
          b.push(chunkOf(geo, m, start, count, paint.tint));
        }
      }
      if (child.children.length) walk(child, m);
    }
  };
  walk(g, null);

  for (const slot of SLOT_ORDER) {
    const chunks = buckets.get(slot);
    if (!chunks || !chunks.length) continue;
    const geo = mergeChunks(chunks);
    geometries.add(geo);
    const mesh = new THREE.Mesh(geo, slotMat(slot));
    mesh.name = `${g.name}.${slot}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    g.add(mesh);
  }
  return g;
}

/**
 * An eight-sided lenticular blade section swept along a tapering leaf profile.
 *
 * Ring order, per station (x across the blade, z through its thickness):
 *   0 (+w, 0)  the cutting edge          4 (-w, 0)  the other cutting edge
 *   1 (+0.80w, +0.62t)  front bevel      5 (-0.80w, -0.62t)  back bevel
 *   2 (+0.26w, +t)      front mid-face   6 (-0.26w, -t)
 *   3 (-0.26w, +t)      front ridge      7 (+0.26w, -t)
 * ...walked as an 8-gon so the strips come out
 *   edge-bevel, mid-face, ridge, mid-face, edge-bevel, ... front and back.
 *
 * Three material groups fall out of it: 0 = the mid-faces (steel), 1 = the four
 * bevels that meet the cutting edge (the bright edge hex), 2 = the two ridge
 * strips. Groups, not separate meshes, because they must share vertices — a
 * seam between two meshes at a 20-degree dihedral shows as a crack the moment
 * the sword swings.
 */
// ── SWEPT PARTS ─────────────────────────────────────────────────────────────
// rig.js's tubeGeo with a superellipse section is how the body gets its
// arrises; the arms use the same sweep for anything that is not a leaf blade
// — bow staves, curved claws, crescents, cage ribs. `sectorGroups` then splits
// the sweep's index by radial sector into material groups, so a swept blade
// can carry the edge paint on its two edges and the ridge paint on its spine
// exactly as bladeSection() does, and bake into the same slots.
function superellipse(n) {
  return (th) => {
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return 1 / Math.pow(Math.pow(c, n) + Math.pow(s, n), 1 / n);
  };
}
const DIAMOND = superellipse(1.25);
const PLATE = superellipse(5);

/** regroup a tubeGeo index by radial sector: groupOf(j, radial) -> group id */
function sectorGroups(geo, radial, groupOf, nGroups = 3) {
  const src = geo.index.array;
  const by = Array.from({ length: nGroups }, () => []);
  const quads = src.length / 6;
  for (let q = 0; q < quads; q++) {
    const j = q % radial;
    const g = by[groupOf(j, radial)];
    for (let k = 0; k < 6; k++) g.push(src[q * 6 + k]);
  }
  const out = [];
  geo.clearGroups();
  let start = 0;
  for (let g = 0; g < nGroups; g++) {
    for (const v of by[g]) out.push(v);
    if (by[g].length) geo.addGroup(start, by[g].length, g);
    start += by[g].length;
  }
  geo.setIndex(out);
  return geo;
}
/** edges (sector 0 and radial/2) -> group 1, ridge (radial/4, 3radial/4) -> 2, faces -> 0 */
const bladeSectors = (j, R) => {
  const e = Math.min(j, Math.abs(j - R / 2), R - j);
  if (e < 0.6) return 1;
  const r = Math.min(Math.abs(j - R / 4), Math.abs(j - 3 * R / 4));
  return r < 0.6 ? 2 : 0;
};

/**
 * A swept blade with a diamond section along a spine of {p, r, sz} stations
 * (r = half width, sz = thickness/width). Three groups: face / edge / ridge.
 */
function sweptBlade(spine, o = {}) {
  const radial = o.radial ?? 10;
  const g = tubeGeo(spine, { radial, capStart: o.capStart || 'flat', capEnd: 'round', capScale: o.tip ?? 0.3, up: o.up, shape: o.shape || DIAMOND });
  return sectorGroups(g, radial, bladeSectors);
}

/** a chamfered ring around +y at height y (a ferrule, a collar, a rim) */
function bandRing({ y, R, th = 0.008, hh = 0.02, seg = 20, radial = 8, ez = 1 }) {
  const spine = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / (seg - 1)) * Math.PI * 2;
    spine.push({ p: [R * Math.sin(a), y, R * Math.cos(a) * ez], r: 1, sx: th, sz: hh });
  }
  return tubeGeo(spine, { radial, up: [0, 1, 0], capStart: 'flat', capEnd: 'flat', shape: PLATE });
}

/** a tapered tube through a list of Vector3s */
function taper(points, r0, r1, o = {}) {
  const n = points.length;
  const spine = points.map((p, i) => ({ p: [p.x, p.y, p.z], r: r0 + (r1 - r0) * (i / (n - 1)), sx: o.sx ?? 1, sz: o.sz ?? 1 }));
  return tubeGeo(spine, { radial: o.radial ?? 8, capStart: o.capStart || 'round', capEnd: o.capEnd || 'round', up: o.up, shape: o.shape });
}

/** a rounded-rectangle outline for bevelled plates */
function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const hw = w * 0.5, hh = h * 0.5;
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh); s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r); s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh); s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r); s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}
/** a bevelled plate: the chamfer is what makes a box read as forged */
function bevelPlate(w, h, depth, r = 0.02, bevel = 0.008) {
  const g = new THREE.ExtrudeGeometry(roundedRect(w, h, r), {
    depth: Math.max(1e-3, depth - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 1, curveSegments: 3, steps: 1,
  });
  g.translate(0, 0, -depth * 0.5);
  g.computeVertexNormals();
  return g;
}

/** a crescent (moon) plate in the x-y plane, extruded in z, bevelled */
function crescentPlate({ R, rIn, span, depth, bevel = 0.010, cx = 0, cy = 0, tipPull = 0.35 }) {
  const s = new THREE.Shape();
  const N = 16, a0 = -span * 0.5, a1 = span * 0.5;
  s.moveTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
  for (let i = 1; i <= N; i++) { const a = a0 + (a1 - a0) * i / N; s.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); }
  // the inner arc pulls toward the tips so the horns come to points
  for (let i = N; i >= 0; i--) {
    const a = a0 + (a1 - a0) * i / N;
    const k = 1 - tipPull * Math.pow(Math.abs(a) / (span * 0.5), 2.2);
    s.lineTo(cx + Math.cos(a) * rIn * k + (R - rIn) * (1 - k) * Math.cos(a), cy + Math.sin(a) * rIn * k + (R - rIn) * (1 - k) * Math.sin(a));
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: Math.max(1e-3, depth - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 2, curveSegments: 3, steps: 1,
  });
  g.translate(0, 0, -depth * 0.5);
  g.computeVertexNormals();
  return g;
}

function bladeSection({ stations, steps = 4 }) {
  // [x/halfWidth, z/halfThickness, materialGroup]
  //   group 1 = the bevel that meets the cutting edge (bright, narrow)
  //   group 0 = the mid-face      group 2 = the flat of the ridge
  const RING = [
    [1.00, 0.00, 1], [0.92, 0.34, 0], [0.55, 0.82, 0], [0.11, 1.00, 2],
    [-0.11, 1.00, 0], [-0.55, 0.82, 0], [-0.92, 0.34, 1], [-1.00, 0.00, 1],
    [-0.92, -0.34, 0], [-0.55, -0.82, 0], [-0.11, -1.00, 2],
    [0.11, -1.00, 0], [0.55, -0.82, 0], [0.92, -0.34, 1],
  ];
  const N = RING.length;
  // resample the control stations so the sweep is smooth enough to shade
  const rows = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      rows.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  rows.push(stations[stations.length - 1]);

  // EACH STRIP GETS ITS OWN VERTICES. This is the whole point, and building it
  // the obvious way (one shared ring, computeVertexNormals) threw it away: the
  // averaged normal across a 14-gon is a SMOOTH lens, and the blade came back
  // as a featureless pale almond with the bevel invisible — the third flat
  // sword in a row, arrived at from the opposite direction. Duplicating the
  // ring per strip makes each facet a ruled surface with one normal across its
  // width and a smooth blend along its length: faceted across the section,
  // continuous down the blade, which is what a ground blade actually is.
  const pos = [];
  const byGroup = [[], [], []];
  for (let i = 0; i < N; i++) {
    const a = RING[i], b = RING[(i + 1) % N];
    const base = pos.length / 3;
    for (const [y, w, th] of rows) {
      pos.push(a[0] * w, y, a[1] * th);
      pos.push(b[0] * w, y, b[1] * th);
    }
    for (let r = 0; r < rows.length - 1; r++) {
      const v = base + 2 * r;
      byGroup[a[2]].push(v, v + 1, v + 3, v, v + 3, v + 2);
    }
  }
  const index = [];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  let start = 0;
  for (let gi = 0; gi < byGroup.length; gi++) {
    index.push(...byGroup[gi]);
    geo.addGroup(start, byGroup[gi].length, gi);
    start += byGroup[gi].length;
  }
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

// ── THE XIPHOS ──────────────────────────────────────────────────────────────
// The one arm on screen in the shipped shots, so it gets the full pass: a leaf
// blade with a real lenticular section — cutting edge, bevel, mid-face, ridge —
// a six-sided gold quillon with a hot arris and turned finials, a ferrule, a
// wrapped grip and a gold pommel with the ember gem.
function bladeModel(pal, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.blade';
  g.userData.design = 'leaf-xiphos';
  const keep = (geo) => { geometries.add(geo); return geo; };

  // ── THE BLADE IS A SOLID OF REVOLUTION, NOT A CUT-OUT ────────────────────
  // Two builds of this were made out of coplanar plates — an extruded leaf with
  // ridge and fuller boxes laid on its face — and BOTH read as one flat pale
  // shape. The reason is not colour and no palette change can reach it: a plate
  // has ONE normal, so the shading ramp resolves the entire face to a single
  // band and there is nothing for a key to break over. The measured blade face
  // came back rgb(181,156,161) with a 1px hairline of fuller and nothing else.
  //
  // bladeSection() gives the leaf a real EIGHT-SIDED lenticular cross-section:
  // a cutting edge, a steep bevel, a flat mid-face and a ridge, mirrored front
  // and back. That is four distinct normals per half, so one bevel takes the key
  // while the other goes to the shadow band, the ridge draws a lit line down the
  // centre, and the silhouette is owned by the narrow bevel — which is exactly
  // where §4 wants "a small, bright, sharp glint" and nowhere else.
  const bladeGeo = keep(bladeSection({
    // (y, halfWidth, halfThickness) — the waist at -0.25 is what makes this a
    // xiphos rather than a dagger.
    stations: [
      [0.000, 0.046, 0.019], [-0.060, 0.062, 0.019], [-0.140, 0.079, 0.018],
      [-0.250, 0.086, 0.016], [-0.360, 0.073, 0.013], [-0.500, 0.053, 0.010],
      [-0.590, 0.034, 0.007], [-0.660, 0.002, 0.002],
    ],
    steps: 4,
  }));
  const blade = addMesh(g, bladeGeo, [pal.steel, pal.edge, pal.steelLit], 'avatar.weapon.blade.leaf');
  blade.position.set(0, -0.150, 0);

  // NO PAINTED FULLER. One was built as four thin boxes laid on the faces and
  // it read as two heavy grey stripes down a cream plate — a decal, not a
  // groove, because a box laid on a plane shares the plane's normal and so
  // shares its value. The section above already gives the face a bevel, a
  // mid-face and a ridge at three different angles to the key, which is where
  // a real fuller's value comes from.

  // A SIX-SIDED quillon, not a box. Same reason as the blade: a box shows the
  // camera one face and one value, while a hexagonal bar gives three facets at
  // 60 degrees, so the gold rolls from its deep through its core to its hot
  // instead of reading as one flat yellow rectangle.
  const guardGeo = keep(new THREE.CylinderGeometry(0.026, 0.026, 0.272, 6, 1));
  const guard = addMesh(g, guardGeo, pal.gold, 'avatar.weapon.blade.guard');
  guard.position.set(0, -0.146, 0);
  guard.rotation.set(0, 0, Math.PI / 2);
  guard.scale.set(1, 1, 0.82);
  const arrisGeo = keep(new THREE.BoxGeometry(0.268, 0.006, 0.013));
  const arris = addMesh(g, arrisGeo, pal.goldHot, 'avatar.weapon.blade.guard.arris');
  arris.position.set(0, -0.1315, 0.014);
  const underGeo = keep(new THREE.BoxGeometry(0.240, 0.007, 0.030));
  const under = addMesh(g, underGeo, pal.goldDeep, 'avatar.weapon.blade.guard.under');
  under.position.set(0, -0.164, 0);
  // Quillon finials: small turned blocks on the ends, so the crossguard stops
  // rather than just being cut off.
  for (const s of [-1, 1]) {
    const tipGeo = keep(new THREE.CylinderGeometry(0.020, 0.032, 0.026, 6, 1));
    const tip = addMesh(g, tipGeo, pal.goldHot, `avatar.weapon.blade.guard.tip.${s < 0 ? 'l' : 'r'}`);
    tip.position.set(s * 0.148, -0.146, 0);
    tip.rotation.set(0, 0, s * Math.PI / 2);
    tip.scale.set(1, 1, 0.82);
  }

  // FERRULE — the collar that closes the tang into the guard.
  const ferruleGeo = keep(new THREE.CylinderGeometry(0.036, 0.032, 0.030, 10));
  const ferrule = addMesh(g, ferruleGeo, pal.goldDeep, 'avatar.weapon.blade.ferrule');
  ferrule.position.y = -0.118;

  wrappedGrip(g, pal, { y: -0.044, r0: 0.026, r1: 0.030, len: 0.150, turns: 5, name: 'avatar.weapon.blade.grip' })
    .forEach(keep);

  const pommelGeo = keep(new THREE.OctahedronGeometry(0.048, 0));
  const pommel = addMesh(g, pommelGeo, pal.gold, 'avatar.weapon.blade.pommel');
  pommel.position.y = 0.052;
  pommel.scale.set(1.0, 0.86, 1.0);
  const gemGeo = keep(new THREE.OctahedronGeometry(0.020, 0));
  const gem = addMesh(g, gemGeo, pal.accent, 'avatar.weapon.blade.pommel.gem');
  gem.position.set(0, 0.052, 0.038);

  g.rotation.z = -0.08;
  return g;
}

function spearModel(pal, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.spear';
  g.userData.design = 'dory-leaf-spear';
  const keep = (geo) => { geometries.add(geo); return geo; };

  // an octagonal ash shaft with two cord bindings along its length
  const shaftGeo = keep(new THREE.CylinderGeometry(0.021, 0.027, 1.42, 8));
  const shaft = addMesh(g, shaftGeo, pal.wood, 'avatar.weapon.spear.shaft');
  shaft.position.y = -0.30;
  for (const [i, y] of [-0.62, 0.30].entries()) {
    const bindGeo = keep(bandRing({ y: 0, R: 0.0245, th: 0.006, hh: 0.030, seg: 12 }));
    addMesh(g, bindGeo, pal.wrap, `avatar.weapon.spear.binding.${i}`).position.y = y;
  }

  // SOCKET: a tapered collar with a chamfered lip, then the LEAF — the same
  // eight-sided lenticular section as the xiphos, with a waist below the
  // widest point so it reads as a dory head and not a spike on a pole.
  const collarGeo = keep(new THREE.CylinderGeometry(0.046, 0.034, 0.13, 10));
  addMesh(g, collarGeo, pal.gold, 'avatar.weapon.spear.collar').position.y = -1.02;
  const lipGeo = keep(bandRing({ y: 0, R: 0.048, th: 0.007, hh: 0.014, seg: 14 }));
  addMesh(g, lipGeo, pal.goldHot, 'avatar.weapon.spear.collar.arris').position.y = -0.965;
  const headGeo = keep(bladeSection({
    stations: [
      [0.000, 0.030, 0.014], [-0.070, 0.062, 0.016], [-0.160, 0.086, 0.016],
      [-0.260, 0.084, 0.014], [-0.350, 0.064, 0.011], [-0.430, 0.036, 0.007], [-0.500, 0.002, 0.002],
    ],
    steps: 4,
  }));
  const head = addMesh(g, headGeo, [pal.steel, pal.edge, pal.steelLit], 'avatar.weapon.spear.head');
  head.position.y = -1.07;
  // two lugs under the socket, the dory's distinguishing mark
  for (const sgn of [-1, 1]) {
    const lugGeo = keep(new THREE.ConeGeometry(0.018, 0.09, 5));
    const lug = addMesh(g, lugGeo, pal.gold, `avatar.weapon.spear.lug.${sgn < 0 ? 'l' : 'r'}`);
    lug.position.set(sgn * 0.055, -1.05, 0); lug.rotation.z = sgn * 1.15;
  }

  // SAUROTER: a square-section butt spike on its own ferrule
  const buttGeo = keep(new THREE.ConeGeometry(0.036, 0.26, 4));
  const butt = addMesh(g, buttGeo, pal.steelDeep, 'avatar.weapon.spear.butt');
  butt.position.y = 0.53; butt.rotation.y = Math.PI / 4;
  const ferruleGeo = keep(bandRing({ y: 0, R: 0.030, th: 0.008, hh: 0.028, seg: 12 }));
  addMesh(g, ferruleGeo, pal.goldDeep, 'avatar.weapon.spear.ferrule').position.y = 0.40;

  wrappedGrip(g, pal, { y: -0.035, r0: 0.031, r1: 0.033, len: 0.24, turns: 6, name: 'avatar.weapon.spear.grip' })
    .forEach(keep);

  g.rotation.z = 0.06;
  return g;
}

function bowModel(pal, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.bow';
  g.userData.design = 'recurve-heart-bow';
  const keep = (geo) => { geometries.add(geo); return geo; };

  // A RECURVE STAVE, not a noodle: the limb is a flat section (wide across
  // the bow plane, thin through it) that thickens at the grip and tapers to
  // the siyahs, with a gold belly inlay and gilt tips.
  const pts = [
    new THREE.Vector3(0.08, -0.66, 0), new THREE.Vector3(0.26, -0.48, 0), new THREE.Vector3(0.31, -0.24, 0),
    new THREE.Vector3(0.08, 0, 0), new THREE.Vector3(0.31, 0.24, 0), new THREE.Vector3(0.26, 0.48, 0),
    new THREE.Vector3(0.08, 0.66, 0),
  ];
  const curve = new THREE.CatmullRomCurve3(pts);
  const samples = curve.getPoints(28);
  const limbSpine = samples.map((p, i) => {
    const t = i / (samples.length - 1);
    const w = 0.016 + 0.018 * Math.sin(Math.PI * t) * (1 - 0.5 * Math.pow(Math.abs(t - 0.5) * 2, 4));
    return { p: [p.x, p.y, p.z], r: w, sx: 0.55, sz: 1.35 };
  });
  const limbGeo = keep(tubeGeo(limbSpine, { radial: 8, capStart: 'round', capEnd: 'round', shape: PLATE }));
  addMesh(g, limbGeo, pal.wood, 'avatar.weapon.bow.limbs');
  const backGeo = keep(new THREE.TubeGeometry(curve, 24, 0.008, 5, false));
  const back = addMesh(g, backGeo, pal.gold, 'avatar.weapon.bow.limbs.inlay');
  back.position.z = 0.018;
  // siyahs: the stiff gilt tips that carry the string nocks
  for (const [i, sgn] of [-1, 1].entries()) {
    const tipGeo = keep(taper([new THREE.Vector3(0.14, sgn * 0.58, 0), new THREE.Vector3(0.09, sgn * 0.66, 0), new THREE.Vector3(0.02, sgn * 0.70, 0)], 0.020, 0.008, { radial: 7, sx: 0.7, sz: 1.3, shape: PLATE }));
    addMesh(g, tipGeo, pal.goldHot, `avatar.weapon.bow.siyah.${i}`);
    // limb bindings
    const bindGeo = keep(bandRing({ y: 0, R: 0.022, th: 0.005, hh: 0.024, seg: 10, radial: 6 }));
    const b = addMesh(g, bindGeo, pal.wrap, `avatar.weapon.bow.binding.${i}`);
    b.position.set(0.285, sgn * 0.36, 0); b.rotation.z = sgn * 0.25;
  }

  const top = new THREE.Vector3(0.03, 0.70, 0);
  const nock = new THREE.Vector3(-0.13, 0, 0.006);
  const bottom = new THREE.Vector3(0.03, -0.70, 0);
  const stringA = rod(g, top, nock, 0.005, pal.bone, 'avatar.weapon.bow.string.top', 5);
  const stringB = rod(g, nock, bottom, 0.005, pal.bone, 'avatar.weapon.bow.string.bottom', 5);
  keep(stringA.geometry); keep(stringB.geometry);
  // the nocking point: a small serving on the string
  const servGeo = keep(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 6));
  addMesh(g, servGeo, pal.wrap, 'avatar.weapon.bow.serving').position.copy(nock);

  wrappedGrip(g, pal, { y: 0, r0: 0.038, r1: 0.040, len: 0.20, turns: 5, name: 'avatar.weapon.bow.grip' })
    .forEach(keep);
  g.getObjectByName('avatar.weapon.bow.grip').position.set(0.08, 0, 0);
  for (let i = 0; i < 5; i++) {
    const w = g.getObjectByName(`avatar.weapon.bow.grip.wrap.${i}`);
    if (w) w.position.x = 0.08;
  }
  // arrow rest + the heart
  const restGeo = keep(new THREE.BoxGeometry(0.05, 0.012, 0.03));
  addMesh(g, restGeo, pal.gold, 'avatar.weapon.bow.rest').position.set(0.045, 0.115, 0.012);
  const heartGeo = keep(new THREE.OctahedronGeometry(0.046, 0));
  const heart = addMesh(g, heartGeo, pal.accent, 'avatar.weapon.bow.heart');
  heart.position.set(0.10, 0, 0.040);
  heart.scale.set(1.05, 1.25, 0.7);

  g.position.set(0, -0.08, 0.035);
  g.rotation.z = -0.10;
  return g;
}

function shieldModel(pal, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.shield';
  g.userData.design = 'chaos-hoplite-shield';
  const keep = (geo) => { geometries.add(geo); return geo; };

  // the wooden core, seen from the back and the edge
  const diskGeo = keep(new THREE.CylinderGeometry(0.34, 0.36, 0.055, 28));
  const disk = addMesh(g, diskGeo, pal.wood, 'avatar.weapon.shield.disk');
  disk.rotation.x = Math.PI / 2;
  // A DISHED bronze face — a lathe that rises toward the boss with two
  // concentric steps, so the face carries three rings of light instead of one
  // flat disc's worth. Axis onto +z (out of the face).
  const dishGeo = keep(new THREE.LatheGeometry([
    [0.000, 0.062], [0.120, 0.058], [0.150, 0.048], [0.152, 0.040], [0.230, 0.030],
    [0.262, 0.024], [0.264, 0.014], [0.310, 0.004], [0.322, 0.000],
  ].map(([r, y]) => new THREE.Vector2(Math.max(0.002, r), y)), 28));
  dishGeo.rotateX(Math.PI / 2);
  dishGeo.computeVertexNormals();
  const face = addMesh(g, dishGeo, pal.gold, 'avatar.weapon.shield.face');
  face.position.z = 0.030;
  // the two step arrises, hot
  for (const [i, r] of [0.151, 0.263].entries()) {
    const arrisGeo = keep(new THREE.TorusGeometry(r, 0.006, 5, 36));
    const a = addMesh(g, arrisGeo, pal.goldHot, `avatar.weapon.shield.step.${i}`);
    a.position.z = 0.030 + (i === 0 ? 0.045 : 0.020);
  }

  // rolled rim + its arris, and a bead course inside it
  const rimGeo = keep(new THREE.TorusGeometry(0.335, 0.034, 7, 32));
  const rim = addMesh(g, rimGeo, pal.steel, 'avatar.weapon.shield.rim');
  rim.position.z = 0.046;
  const rimArris = keep(new THREE.TorusGeometry(0.350, 0.009, 5, 36));
  const ra = addMesh(g, rimArris, pal.goldHot, 'avatar.weapon.shield.rim.arris');
  ra.position.z = 0.052;
  const beadGeo = keep(new THREE.SphereGeometry(0.014, 6, 5));
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const b = addMesh(g, beadGeo, i % 2 ? pal.goldHot : pal.gold, `avatar.weapon.shield.bead.${i}`);
    b.position.set(Math.cos(a) * 0.294, Math.sin(a) * 0.294, 0.062);
  }

  // THE BOSS: a struck umbo on a collar, with eight radiating rays — the
  // starburst is the Chaos blazon and the one shape you read at play scale.
  const bossGeo = keep(new THREE.SphereGeometry(0.11, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5));
  bossGeo.rotateX(Math.PI / 2);
  const boss = addMesh(g, bossGeo, pal.gold, 'avatar.weapon.shield.boss');
  boss.scale.z = 0.55;
  boss.position.z = 0.090;
  const collarGeo = keep(new THREE.TorusGeometry(0.112, 0.012, 6, 24));
  addMesh(g, collarGeo, pal.goldDeep, 'avatar.weapon.shield.boss.collar').position.z = 0.090;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rayGeo = keep(taper([new THREE.Vector3(Math.cos(a) * 0.115, Math.sin(a) * 0.115, 0), new THREE.Vector3(Math.cos(a) * 0.225, Math.sin(a) * 0.225, 0)], 0.018, 0.004, { radial: 6, sx: 1, sz: 0.4, capStart: 'flat' }));
    addMesh(g, rayGeo, i % 2 ? pal.goldHot : pal.gold, `avatar.weapon.shield.ray.${i}`).position.z = 0.078;
  }
  const eyeGeo = keep(new THREE.OctahedronGeometry(0.040, 0));
  const eye = addMesh(g, eyeGeo, pal.accent, 'avatar.weapon.shield.boss.eye');
  eye.position.z = 0.138; eye.scale.set(1, 1, 0.5);

  const barGeo = keep(new THREE.BoxGeometry(0.26, 0.030, 0.020));
  for (let i = 0; i < 3; i++) {
    const bar = addMesh(g, barGeo, i === 1 ? pal.goldHot : pal.steelDeep, `avatar.weapon.shield.chaos.${i}`);
    bar.position.z = 0.128;
    bar.rotation.z = (i - 1) * Math.PI / 3;
  }

  wrappedGrip(g, pal, { y: 0, r0: 0.024, r1: 0.024, len: 0.28, turns: 4, name: 'avatar.weapon.shield.handle' })
    .forEach(keep);
  const handle = g.getObjectByName('avatar.weapon.shield.handle');
  handle.position.z = -0.075; handle.rotation.x = Math.PI / 2;
  // the porpax: the arm band behind the face
  const porpaxGeo = keep(new THREE.TorusGeometry(0.075, 0.012, 6, 16, Math.PI));
  const px = addMesh(g, porpaxGeo, pal.goldDeep, 'avatar.weapon.shield.porpax');
  px.position.set(0, 0.16, -0.06); px.rotation.set(Math.PI / 2, 0, 0);

  g.position.set(0, -0.16, 0.06);
  g.rotation.set(-0.08, 0.16, 0.02);
  return g;
}

function fistsModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.fists'; g.userData.design = 'malphon-lion-gauntlets';
  const keep = (geo) => { geometries.add(geo); return geo; };
  // the cuff, with a chamfered gold band at each end
  const cuffG = keep(new THREE.CylinderGeometry(0.105, 0.085, 0.30, 12));
  const cuff = addMesh(g, cuffG, pal.leather, 'avatar.weapon.fists.cuff'); cuff.position.y = -0.05;
  for (const [i, y] of [0.09, -0.185].entries()) {
    const bandG = keep(bandRing({ y: 0, R: i ? 0.088 : 0.104, th: 0.010, hh: 0.024, seg: 18 }));
    addMesh(g, bandG, pal.gold, `avatar.weapon.fists.cuff.band.${i}`).position.y = y;
  }
  // the LION'S MASK over the knuckles: a bevelled plate with a mane of four
  // articulated lames behind it and a brow ridge of four studs
  const knuckleG = keep(bevelPlate(0.30, 0.13, 0.16, 0.035, 0.012));
  const knuckle = addMesh(g, knuckleG, pal.gold, 'avatar.weapon.fists.knuckles'); knuckle.position.set(0, -0.23, 0.07);
  for (let i = 0; i < 4; i++) {
    const lameG = keep(bevelPlate(0.30 - i * 0.02, 0.05, 0.02, 0.012, 0.005));
    const lame = addMesh(g, lameG, i % 2 ? pal.goldDeep : pal.gold, `avatar.weapon.fists.lame.${i}`);
    lame.position.set(0, -0.155 + i * 0.045, 0.125 - i * 0.012); lame.rotation.x = -0.35;
  }
  const studG = keep(new THREE.OctahedronGeometry(0.016, 0));
  for (let i = 0; i < 4; i++) {
    const st = addMesh(g, studG, pal.goldHot, `avatar.weapon.fists.stud.${i}`);
    st.position.set(-0.105 + i * 0.07, -0.19, 0.152); st.scale.set(1, 1, 0.6);
  }
  // CLAWS: curved, tapered, and the three read as one paw from any angle
  for (let i = -1; i <= 1; i++) {
    const x = i * 0.085;
    const clawG = keep(taper([
      new THREE.Vector3(x, -0.29, 0.10), new THREE.Vector3(x * 1.1, -0.38, 0.13), new THREE.Vector3(x * 1.2, -0.47, 0.09), new THREE.Vector3(x * 1.25, -0.53, 0.03),
    ], 0.030, 0.004, { radial: 7, capStart: 'flat', shape: DIAMOND }));
    addMesh(g, clawG, pal.edge, `avatar.weapon.fists.claw.${i + 1}`);
  }
  const emberG = keep(new THREE.OctahedronGeometry(0.036, 0));
  const ember = addMesh(g, emberG, pal.accent, 'avatar.weapon.fists.ember');
  ember.position.set(0, -0.235, 0.158); ember.scale.set(1, 1.2, 0.5);
  g.rotation.z = -0.05; return g;
}

function railModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.rail'; g.userData.design = 'adamant-rail-cannon';
  const keep = (geo) => { geometries.add(geo); return geo; };
  // RECEIVER: a bevelled block, not a box, with a raised spine and two side
  // plates so the body carries four planes of light instead of one
  const bodyG = keep(bevelPlate(0.18, 0.72, 0.16, 0.03, 0.014));
  const body = addMesh(g, bodyG, pal.steel, 'avatar.weapon.rail.body'); body.position.y = -0.30;
  const spineG = keep(bevelPlate(0.06, 0.66, 0.04, 0.012, 0.006));
  addMesh(g, spineG, pal.steelLit, 'avatar.weapon.rail.spine').position.set(0, -0.30, 0.095);
  for (const sgn of [-1, 1]) {
    const plateG = keep(bevelPlate(0.30, 0.10, 0.03, 0.02, 0.006));
    const pl = addMesh(g, plateG, pal.steelDeep, `avatar.weapon.rail.plate.${sgn < 0 ? 'l' : 'r'}`);
    pl.position.set(sgn * 0.098, -0.34, 0); pl.rotation.y = sgn * Math.PI / 2;
    const r = addMesh(g, keep(new THREE.BoxGeometry(0.040, 0.68, 0.030)), pal.goldHot, `avatar.weapon.rail.rail.${sgn < 0 ? 'l' : 'r'}`);
    r.position.set(sgn * 0.072, -0.30, 0.086);
  }
  // BARREL with three chamfered bands and a vented muzzle brake
  const barrelG = keep(new THREE.CylinderGeometry(0.052, 0.070, 0.72, 14));
  const barrel = addMesh(g, barrelG, pal.steelDeep, 'avatar.weapon.rail.barrel'); barrel.position.y = -0.82;
  for (const [i, y] of [-0.70, -0.92, -1.10].entries()) {
    const bandG = keep(bandRing({ y: 0, R: 0.058 + i * 0.002, th: 0.010, hh: 0.028, seg: 18 }));
    addMesh(g, bandG, i === 1 ? pal.goldHot : pal.gold, `avatar.weapon.rail.barrel.band.${i}`).position.y = y;
  }
  const muzzleG = keep(new THREE.TorusGeometry(0.074, 0.018, 6, 18));
  const muzzle = addMesh(g, muzzleG, pal.accent, 'avatar.weapon.rail.muzzle'); muzzle.rotation.x = Math.PI / 2; muzzle.position.y = -1.19;
  const ventG = keep(new THREE.BoxGeometry(0.018, 0.06, 0.03));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const v = addMesh(g, ventG, pal.goldDeep, `avatar.weapon.rail.vent.${i}`);
    v.position.set(Math.cos(a) * 0.078, -1.16, Math.sin(a) * 0.078); v.rotation.y = -a;
  }
  // STOCK: a bevelled wooden shoulder piece with a gold butt plate
  const stockG = keep(bevelPlate(0.13, 0.30, 0.13, 0.03, 0.01));
  const stock = addMesh(g, stockG, pal.wood, 'avatar.weapon.rail.stock'); stock.position.set(0, 0.22, -0.03); stock.rotation.z = -0.18;
  const buttG = keep(bevelPlate(0.14, 0.05, 0.14, 0.02, 0.006));
  const butt = addMesh(g, buttG, pal.gold, 'avatar.weapon.rail.butt'); butt.position.set(0.03, 0.385, -0.03); butt.rotation.z = -0.18;
  return g;
}

function staffModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.staff'; g.userData.design = 'descura-crescent-staff';
  const keep = (geo) => { geometries.add(geo); return geo; };
  const shaftG = keep(new THREE.CylinderGeometry(0.024, 0.032, 1.58, 9));
  const shaft = addMesh(g, shaftG, pal.wood, 'avatar.weapon.staff.shaft'); shaft.position.y = -0.35;
  for (let i = 0; i < 3; i++) {
    const ferG = keep(bandRing({ y: 0, R: 0.028 + i * 0.002, th: 0.007, hh: 0.022, seg: 14 }));
    addMesh(g, ferG, pal.gold, `avatar.weapon.staff.ferrule.${i}`).position.y = -0.08 - i * 0.42;
  }
  // THE CRESCENT: a swept blade along an arc — a diamond section so the outer
  // rim is a ground edge and the horns taper to points, not a torus sausage.
  const arc = [];
  const N = 14, a0 = -0.20, a1 = Math.PI * 1.55 - 0.20;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), a = a0 + (a1 - a0) * t;
    const w = 0.026 + 0.030 * Math.sin(Math.PI * t);
    arc.push({ p: [Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0], r: w, sx: 1, sz: 0.28 });
  }
  const crownG = keep(sectorGroups(tubeGeo(arc, { radial: 10, capStart: 'round', capEnd: 'round', capScale: 0.4, up: [0, 0, 1], shape: DIAMOND }), 10, bladeSectors));
  const crown = addMesh(g, crownG, [pal.steel, pal.edge, pal.steelLit], 'avatar.weapon.staff.crescent'); crown.position.y = -1.18; crown.rotation.z = 0.72;
  // the moonstone in a three-prong claw setting
  const gemG = keep(new THREE.OctahedronGeometry(0.080, 0));
  const gem = addMesh(g, gemG, pal.accent, 'avatar.weapon.staff.moonstone'); gem.position.y = -1.18;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const prongG = keep(taper([new THREE.Vector3(Math.cos(a) * 0.03, -1.06, Math.sin(a) * 0.03), new THREE.Vector3(Math.cos(a) * 0.075, -1.14, Math.sin(a) * 0.075), new THREE.Vector3(Math.cos(a) * 0.05, -1.24, Math.sin(a) * 0.05)], 0.012, 0.003, { radial: 6, capStart: 'flat' }));
    addMesh(g, prongG, pal.goldHot, `avatar.weapon.staff.prong.${i}`);
  }
  const capG = keep(new THREE.CylinderGeometry(0.036, 0.028, 0.06, 10));
  addMesh(g, capG, pal.gold, 'avatar.weapon.staff.cap').position.y = -1.02;
  wrappedGrip(g, pal, { y: -0.30, r0: 0.030, r1: 0.031, len: 0.26, turns: 6, name: 'avatar.weapon.staff.grip' })
    .forEach(keep);
  return g;
}

function bladesModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.blades'; g.userData.design = 'lim-oros-sister-knives';
  const keep = (geo) => { geometries.add(geo); return geo; };
  for (const [i, x] of [-0.065, 0.065].entries()) {
    const z = i ? -0.025 : 0.025;
    // a waisted leaf knife with the same faceted section as the xiphos
    const bladeG = keep(bladeSection({
      stations: [
        [0.000, 0.030, 0.011], [-0.080, 0.044, 0.011], [-0.200, 0.052, 0.010],
        [-0.340, 0.058, 0.009], [-0.470, 0.042, 0.007], [-0.560, 0.022, 0.004], [-0.620, 0.002, 0.002],
      ],
      steps: 3,
    }));
    const blade = addMesh(g, bladeG, [pal.steel, pal.edge, pal.steelLit], `avatar.weapon.blades.sister.${i}`);
    blade.position.set(x, -0.10, z); blade.rotation.z = i ? -0.08 : 0.08;
    const guardG = keep(bevelPlate(0.11, 0.022, 0.044, 0.008, 0.004));
    const guard = addMesh(g, guardG, pal.gold, `avatar.weapon.blades.guard.${i}`);
    guard.position.set(x, -0.096, z);
    const ferG = keep(bandRing({ y: 0, R: 0.030, th: 0.006, hh: 0.014, seg: 12 }));
    addMesh(g, ferG, pal.goldHot, `avatar.weapon.blades.ferrule.${i}`).position.set(x, -0.082, z);
    wrappedGrip(g, pal, { y: 0.0, r0: 0.024, r1: 0.028, len: 0.17, turns: 4, name: `avatar.weapon.blades.grip.${i}` })
      .forEach(keep);
    const grip = g.getObjectByName(`avatar.weapon.blades.grip.${i}`);
    grip.position.set(x, 0.0, z);
    for (let w = 0; w < 4; w++) {
      const wr = g.getObjectByName(`avatar.weapon.blades.grip.${i}.wrap.${w}`);
      if (wr) { wr.position.x = x; wr.position.z = z; }
    }
    const pomG = keep(new THREE.OctahedronGeometry(0.026, 0));
    const pom = addMesh(g, pomG, i ? pal.accent : pal.gold, `avatar.weapon.blades.pommel.${i}`);
    pom.position.set(x, 0.10, z); pom.scale.set(1, 0.8, 1);
  }
  return g;
}

function flamesModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.flames'; g.userData.design = 'ygnium-umbral-torches';
  const keep = (geo) => { geometries.add(geo); return geo; };
  const handleG = keep(new THREE.CylinderGeometry(0.035, 0.05, 0.46, 10));
  const handle = addMesh(g, handleG, pal.leather, 'avatar.weapon.flames.handle'); handle.position.y = -0.08;
  for (let i = 0; i < 4; i++) {
    const wrG = keep(bandRing({ y: 0, R: 0.040 + i * 0.004, th: 0.006, hh: 0.016, seg: 12, radial: 6 }));
    addMesh(g, wrG, pal.wrap, `avatar.weapon.flames.handle.wrap.${i}`).position.y = 0.04 - i * 0.075;
  }
  // the BOWL and the CAGE: a gold cup with four curved ribs meeting over the
  // fire, so the torch has a lantern's silhouette and the core sits inside it
  const bowlG = keep(new THREE.LatheGeometry([[0.02, 0], [0.06, 0.02], [0.10, 0.06], [0.13, 0.10], [0.125, 0.115]].map(([r, y]) => new THREE.Vector2(r, y)), 14));
  bowlG.computeVertexNormals();
  addMesh(g, bowlG, pal.gold, 'avatar.weapon.flames.bowl').position.y = -0.40;
  const lipG = keep(bandRing({ y: 0, R: 0.128, th: 0.008, hh: 0.014, seg: 18 }));
  addMesh(g, lipG, pal.goldHot, 'avatar.weapon.flames.bowl.lip').position.y = -0.29;
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const c = Math.cos(a), sn = Math.sin(a);
    const ribG = keep(taper([
      new THREE.Vector3(c * 0.125, -0.29, sn * 0.125), new THREE.Vector3(c * 0.15, -0.44, sn * 0.15),
      new THREE.Vector3(c * 0.11, -0.60, sn * 0.11), new THREE.Vector3(c * 0.03, -0.68, sn * 0.03),
    ], 0.012, 0.006, { radial: 6, capStart: 'flat' }));
    addMesh(g, ribG, i % 2 ? pal.goldHot : pal.gold, `avatar.weapon.flames.rib.${i}`);
  }
  const finialG = keep(new THREE.OctahedronGeometry(0.030, 0));
  addMesh(g, finialG, pal.goldHot, 'avatar.weapon.flames.finial').position.y = -0.70;
  const fireG = keep(new THREE.OctahedronGeometry(0.10, 1));
  const fire = addMesh(g, fireG, pal.core, 'avatar.weapon.flames.core'); fire.position.y = -0.48; fire.scale.set(0.8, 1.5, 0.8);
  return g;
}

function axeModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.axe'; g.userData.design = 'zorephet-moonstone-axe';
  const keep = (geo) => { geometries.add(geo); return geo; };
  const shaftG = keep(new THREE.CylinderGeometry(0.032, 0.040, 1.52, 9));
  const shaft = addMesh(g, shaftG, pal.wood, 'avatar.weapon.axe.shaft'); shaft.position.y = -0.36;
  const ferG = keep(bandRing({ y: 0, R: 0.041, th: 0.008, hh: 0.024, seg: 14 }));
  addMesh(g, ferG, pal.goldDeep, 'avatar.weapon.axe.ferrule').position.y = 0.38;
  // LANGETS: two gold straps down the haft under the head
  for (const sgn of [-1, 1]) {
    const langetG = keep(bevelPlate(0.020, 0.38, 0.070, 0.006, 0.004));
    const l = addMesh(g, langetG, pal.gold, `avatar.weapon.axe.langet.${sgn < 0 ? 'l' : 'r'}`);
    l.position.set(sgn * 0.034, -0.98, 0);
  }
  // THE MOON: a bevelled crescent plate with its outer arc rimmed in the edge
  // paint, hung off a chamfered eye collar. The arris of the bevel is where
  // the key catches; the rim is the sharpened edge.
  const headG = keep(crescentPlate({ R: 0.46, rIn: 0.32, span: 1.70, depth: 0.075, bevel: 0.012, cx: 0.16, cy: -1.11, tipPull: 0.40 }));
  addMesh(g, headG, [pal.steel], 'avatar.weapon.axe.head');
  const edgeArc = [];
  for (let i = 0; i < 16; i++) {
    const t = i / 15, a = -0.85 + 1.70 * t;
    edgeArc.push({ p: [0.16 + Math.cos(a) * 0.462, -1.11 + Math.sin(a) * 0.462, 0], r: 0.014 + 0.010 * Math.sin(Math.PI * t), sx: 1, sz: 0.5 });
  }
  const edgeG = keep(tubeGeo(edgeArc, { radial: 8, capStart: 'round', capEnd: 'round', capScale: 0.5, up: [0, 0, 1], shape: DIAMOND }));
  addMesh(g, edgeG, pal.edge, 'avatar.weapon.axe.moon-edge');
  const eyeG = keep(bandRing({ y: 0, R: 0.052, th: 0.012, hh: 0.16, seg: 12 }));
  addMesh(g, eyeG, pal.gold, 'avatar.weapon.axe.eye').position.y = -1.11;
  const eyeArrisG = keep(bandRing({ y: 0, R: 0.056, th: 0.006, hh: 0.012, seg: 14 }));
  for (const [i, y] of [-1.19, -1.03].entries()) addMesh(g, eyeArrisG, pal.goldHot, `avatar.weapon.axe.eye.arris.${i}`).position.y = y;
  const backG = keep(taper([new THREE.Vector3(-0.05, -1.11, 0), new THREE.Vector3(-0.16, -1.13, 0), new THREE.Vector3(-0.24, -1.17, 0)], 0.045, 0.006, { radial: 7, capStart: 'flat', shape: PLATE }));
  addMesh(g, backG, pal.steelDeep, 'avatar.weapon.axe.spike');
  const gemG = keep(new THREE.OctahedronGeometry(0.060, 0));
  const gem = addMesh(g, gemG, pal.accent, 'avatar.weapon.axe.gem'); gem.position.set(0.15, -1.11, 0.045); gem.scale.set(1, 1.3, 0.6);
  wrappedGrip(g, pal, { y: -0.20, r0: 0.036, r1: 0.038, len: 0.28, turns: 6, name: 'avatar.weapon.axe.grip' })
    .forEach(keep);
  return g;
}

function skullModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.skull'; g.userData.design = 'revaal-argent-skull';
  const keep = (geo) => { geometries.add(geo); return geo; };
  // a CRANIUM, not a dodecahedron: a lathe with a brow ridge, cheekbones and
  // two sunk sockets around the accent eyes; a jaw of teeth under it
  const skullG = keep(new THREE.LatheGeometry([
    [0.00, 0.250], [0.10, 0.245], [0.17, 0.205], [0.215, 0.125], [0.225, 0.030],
    [0.205, -0.070], [0.165, -0.135], [0.110, -0.175], [0.03, -0.190],
  ].map(([r, y]) => new THREE.Vector2(Math.max(0.002, r), y)), 18));
  skullG.scale(1, 1.05, 0.90);
  skullG.computeVertexNormals();
  const skull = addMesh(g, skullG, pal.bone, 'avatar.weapon.skull.cranium'); skull.position.y = -0.28;
  const browG = keep(new THREE.TorusGeometry(0.19, 0.022, 6, 18, Math.PI * 0.8));
  const brow = addMesh(g, browG, pal.bone, 'avatar.weapon.skull.brow'); brow.position.set(0, -0.235, 0.04); brow.rotation.set(0.3, 0, -Math.PI * 0.4);
  const cheekG = keep(new THREE.SphereGeometry(0.05, 8, 6));
  for (const sgn of [-1, 1]) {
    const ck = addMesh(g, cheekG, pal.bone, `avatar.weapon.skull.cheek.${sgn < 0 ? 'l' : 'r'}`);
    ck.position.set(sgn * 0.13, -0.335, 0.13); ck.scale.set(1.1, 0.8, 1.0);
    const sockG = keep(new THREE.SphereGeometry(0.052, 8, 6));
    const so = addMesh(g, sockG, pal.steelDeep, `avatar.weapon.skull.socket.${sgn < 0 ? 'l' : 'r'}`);
    so.position.set(sgn * 0.078, -0.295, 0.150); so.scale.set(1.1, 0.9, 0.5);
    const eyeG = keep(new THREE.OctahedronGeometry(0.040, 0));
    const eye = addMesh(g, eyeG, pal.accent, `avatar.weapon.skull.eye.${sgn}`); eye.position.set(sgn * 0.075, -0.295, 0.175);
  }
  const circletG = keep(bandRing({ y: 0, R: 0.212, th: 0.010, hh: 0.026, seg: 26, ez: 0.92 }));
  addMesh(g, circletG, pal.gold, 'avatar.weapon.skull.circlet').position.y = -0.18;
  const nasalG = keep(new THREE.ConeGeometry(0.022, 0.07, 5));
  const nasal = addMesh(g, nasalG, pal.steelDeep, 'avatar.weapon.skull.nasal'); nasal.position.set(0, -0.36, 0.175); nasal.rotation.x = 0.4;
  // JAW: a U of bone with a row of teeth
  const jawArc = [];
  for (let i = 0; i < 9; i++) { const a = -0.55 + (i / 8) * 1.1; jawArc.push({ p: [Math.sin(a) * 0.19, 0, Math.cos(a) * 0.19 - 0.06], r: 0.030, sx: 1, sz: 0.8 }); }
  const jawG = keep(tubeGeo(jawArc, { radial: 8, capStart: 'round', capEnd: 'round', up: [0, 1, 0] }));
  addMesh(g, jawG, pal.bone, 'avatar.weapon.skull.jaw').position.y = -0.47;
  const toothG = keep(new THREE.ConeGeometry(0.012, 0.035, 4));
  for (let i = 0; i < 7; i++) {
    const a = -0.42 + (i / 6) * 0.84;
    const t = addMesh(g, toothG, pal.steelDeep, `avatar.weapon.skull.tooth.${i}`);
    t.position.set(Math.sin(a) * 0.165, -0.43, Math.cos(a) * 0.165 - 0.06); t.rotation.z = Math.PI;
  }
  const teethG = keep(new THREE.BoxGeometry(0.22, 0.022, 0.030));
  addMesh(g, teethG, pal.steelDeep, 'avatar.weapon.skull.teeth').position.set(0, -0.415, 0.10);
  return g;
}

function coatModel(pal, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.coat'; g.userData.design = 'xinth-jet-gauntlet';
  const keep = (geo) => { geometries.add(geo); return geo; };
  const armG = keep(new THREE.CylinderGeometry(0.12, 0.095, 0.48, 12));
  const arm = addMesh(g, armG, pal.leather, 'avatar.weapon.coat.gauntlet'); arm.position.y = -0.12;
  // ARTICULATED VAMBRACE: a bevelled shield plate over three curved lames
  const plateG = keep(bevelPlate(0.32, 0.34, 0.10, 0.04, 0.012));
  const plate = addMesh(g, plateG, pal.steel, 'avatar.weapon.coat.shield-plate'); plate.position.set(0, -0.18, 0.10);
  const plateArrisG = keep(new THREE.BoxGeometry(0.325, 0.012, 0.020));
  for (const y of [-0.02, -0.34]) {
    const pa = addMesh(g, plateArrisG, pal.goldHot, `avatar.weapon.coat.shield-plate.arris.${y < -0.2 ? 'b' : 't'}`);
    pa.position.set(0, y, 0.152);
  }
  for (let i = 0; i < 3; i++) {
    const lameG = keep(bandRing({ y: 0, R: 0.125 + i * 0.008, th: 0.010, hh: 0.040, seg: 14, radial: 6 }));
    const lame = addMesh(g, lameG, i % 2 ? pal.steelDeep : pal.steel, `avatar.weapon.coat.lame.${i}`);
    lame.position.y = 0.02 + i * 0.05;
  }
  const emblemG = keep(new THREE.OctahedronGeometry(0.05, 0));
  const em = addMesh(g, emblemG, pal.gold, 'avatar.weapon.coat.emblem'); em.position.set(0, -0.18, 0.15); em.scale.set(1, 1.3, 0.5);
  const coreG = keep(new THREE.OctahedronGeometry(0.026, 0));
  addMesh(g, coreG, pal.accent, 'avatar.weapon.coat.emblem.core').position.set(0, -0.18, 0.168);
  // JETS: two flared nozzles with a gold throat ring, angled back
  for (const sgn of [-1, 1]) {
    const jetG = keep(taper([new THREE.Vector3(sgn * 0.10, 0.06, -0.04), new THREE.Vector3(sgn * 0.11, 0.20, -0.07), new THREE.Vector3(sgn * 0.12, 0.31, -0.09)], 0.030, 0.052, { radial: 10, capStart: 'flat', capEnd: 'flat' }));
    addMesh(g, jetG, pal.steelDeep, `avatar.weapon.coat.jet.${sgn}`);
    const throatG = keep(bandRing({ y: 0, R: 0.050, th: 0.007, hh: 0.014, seg: 14 }));
    const th = addMesh(g, throatG, pal.goldHot, `avatar.weapon.coat.jet.${sgn}.throat`); th.position.set(sgn * 0.12, 0.30, -0.09); th.rotation.x = 0.2;
    const glowG = keep(new THREE.OctahedronGeometry(0.030, 0));
    addMesh(g, glowG, pal.accent, `avatar.weapon.coat.jet.${sgn}.flame`).position.set(sgn * 0.12, 0.33, -0.095);
  }
  return g;
}

const BUILDERS = {
  blade: bladeModel, spear: spearModel, bow: bowModel, shield: shieldModel,
  fists: fistsModel, rail: railModel, staff: staffModel, blades: bladesModel,
  flames: flamesModel, axe: axeModel, skull: skullModel, coat: coatModel,
};
const HAND = {
  blade: 'handR', spear: 'handR', bow: 'handL', shield: 'handL', fists: 'handR', rail: 'handR',
  staff: 'handR', blades: 'handR', flames: 'handL', axe: 'handR', skull: 'handL', coat: 'handL',
};

export const AVATAR_WEAPON_DESIGNS = Object.freeze({
  blade: 'leaf-xiphos',
  spear: 'dory-leaf-spear',
  bow: 'recurve-heart-bow',
  shield: 'chaos-hoplite-shield',
  fists: 'malphon-lion-gauntlets',
  rail: 'adamant-rail-cannon',
  staff: 'descura-crescent-staff',
  blades: 'lim-oros-sister-knives',
  flames: 'ygnium-umbral-torches',
  axe: 'zorephet-moonstone-axe',
  skull: 'revaal-argent-skull',
  coat: 'xinth-jet-gauntlet',
});

export function createAvatarWeapons(rig, initialId = 'blade', allowedIds = WEAPON_IDS) {
  if (!rig?.bones?.handR || !rig?.bones?.handL) throw new Error('Avatar weapons require handR and handL bones');
  const materials = new Set();
  const geometries = new Set();
  const groups = {};
  // THE RAMP HAS TO BE ANCHORED TO THE SAME KEY THE BODY IS ANCHORED TO.
  // painterly's ramp divides the recovered lit-ness by uKeyRef, so an arm built
  // against the 2.2 preset while the rig runs at ~16 has its whole ramp pinned
  // at the top level — a flat, fully-lit prop hanging off a modelled hero. The
  // hero's own slot materials carry the live value, so read it from them;
  // materials/library.js setRim() republishes it to the whole painterly
  // registry afterwards, which covers a later biome change.
  const kr = (rig.materials || []).reduce((acc, m) => {
    const u = paintParams(m);
    return acc || (u && u.uKeyRef ? u.uKeyRef.value : 0);
  }, 0);

  const ids = allowedIds.filter(id => WEAPONS[id] && BUILDERS[id]);
  for (const id of ids) {
    const wp = WEAPONS[id].palette;
    // LAZY, so an arm pays for the slots it actually uses. The spear has no
    // emissive at all and the sister knives have no edge-slot arris; building
    // the full table eagerly (as the first rebuild did) made 156 painterly
    // materials for 12 arms, of which 76 were ever bound.
    const cache = {};
    const slotMat = (slot) => cache[slot] || (cache[slot] = slotMaterial(slot, wp, materials, kr));
    // The builders' own `keep()` set. These are the AUTHORED geometries: after
    // the bake they exist only as source data for the merged buffers and never
    // reach the GPU, so they are released here and the disposal set tracks the
    // merged geometries instead.
    const authored = new Set();
    const group = BUILDERS[id](paintsFor(id), authored);
    bakeArm(group, slotMat, geometries);
    for (const geometry of authored) geometry.dispose();
    group.visible = false;
    group.userData.weaponId = id;
    group.userData.hand = HAND[id];
    rig.bones[HAND[id]].add(group);
    groups[id] = group;
  }

  const visual = {
    groups,
    materials,
    currentId: null,
    equip(id) {
      const next = groups[id] ? id : (groups.blade ? 'blade' : Object.keys(groups)[0]);
      for (const key of ids) groups[key].visible = key === next;
      visual.currentId = next;
      return groups[next];
    },
    dispose() {
      for (const group of Object.values(groups)) group.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
  visual.equip(initialId);
  return visual;
}

export default createAvatarWeapons;
