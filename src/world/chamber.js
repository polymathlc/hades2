// OWNER: AGENT-WORLD — STUB (integrator pass, wave 1).
//
// This is still a stub: no chamber graph, no room transitions, no prop kit.
// It exists so the material library and the light rig have real architecture to
// act on — a floor, an ashlar perimeter, columns, a gate, braziers that sit
// exactly where the light rig authored its practicals, and void shards that
// frame the arena as an island of light (ART_DIRECTION §1.8).
//
// AGENT-WORLD: replace wholesale. The only things other systems depend on are
// `bounds`, `center`, `clampToArena`, `heightAt`, `biome` and `setBiome`.
import * as THREE from 'three';

const KIT = {
  // §1.5 MATERIAL HIERARCHY: the wall, the column drums and the gate voussoirs
  // are three different stones. One `wall` entry handed to all of them is what
  // made the arch, the columns, the frieze and the perimeter read as the same
  // brown-violet substance in the same finish.
  tartarus: { floor: 'floor.tartarus', wall: 'stone.tartarus', bay: 'stone.tartarus.bay', trim: 'gold.filigree',
    column: 'stone.tartarus.column', arch: 'stone.tartarus.arch',
    metal: 'bronze.verdigris', ember: 'lava', rock: 'obsidian', accent: 'crystal.violet',
    medallion: 'medallion.tartarus' },
  asphodel: { floor: 'floor.asphodel', wall: 'stone.asphodel', trim: 'gold.filigree',
    metal: 'bronze.verdigris', ember: 'lava', rock: 'obsidian', accent: 'crystal.violet' },
  elysium: { floor: 'floor.elysium', wall: 'marble.elysium', trim: 'gold.filigree',
    metal: 'bronze.verdigris', ember: 'lava', rock: 'obsidian', accent: 'crystal.violet' },
};

// Fallback practical layout if the light rig has not published one.
const FALLBACK_PRACTICALS = [
  { pos: [11.0, 1.7, -6.0], color: '#ffa257' },
  { pos: [-11.0, 1.7, 6.0], color: '#ffa257' },
  { pos: [6.0, 1.7, 11.0], color: '#ff8a3e' },
  { pos: [-6.0, 1.7, -11.0], color: '#ff8a3e' },
];

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Authored prop geometry. ART_DIRECTION §7 bans "untextured programmer-art
// boxes/cylinders left visible", and a raw CylinderGeometry reads as a barrel
// no matter what is painted on it. These four masses each carry a deliberate
// silhouette decision: flutes, a flat fracture face, a chipped rim, a neck and
// handles. All are authored so their local +Y is up and their bottom is flat,
// which is what lets the placer snap them to the floor plane.
// ---------------------------------------------------------------------------

/** A toppled fluted column drum: 16 flutes, a bevelled rim, one flat break. */
function columnDrum(rng, o = {}) {
  // MAGNITUDE. At the §8 camera (34-40deg FOV, ~26m, 52deg pitch) a 7.7% radius
  // modulation is sub-pixel, so 16 shallow flutes read on screen as a plain
  // capped cylinder. 10 flutes at 21% of the radius each cast a shadow wide
  // enough to survive the resolve.
  const R = o.r ?? 0.52, H = o.h ?? 1.15, FL = o.flutes ?? 10, DEPTH = o.depth ?? 0.115;
  const g = new THREE.CylinderGeometry(R, R, H, FL * 2, 5, false);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  // a single tilted fracture plane through the drum, and a chipped rim
  const tilt = 0.17 + rng() * 0.16, tiltA = rng() * Math.PI * 2;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rad = Math.hypot(v.x, v.z);
    if (rad > 1e-4) {
      const a = Math.atan2(v.z, v.x);
      // flutes: a scalloped radius, deeper in the middle of the drum
      const band = 1 - Math.pow(Math.abs(v.y) / (H * 0.5), 3.0);
      const flute = (0.5 - 0.5 * Math.cos(a * FL)) * DEPTH * band;
      // rim bevel so the ends are not razor discs
      const rim = 1 - 0.28 * Math.pow(Math.abs(v.y) / (H * 0.5), 6.0);
      const k = ((rad - flute) * rim) / rad;
      v.x *= k; v.z *= k;
      // chipped upper rim
      if (v.y > H * 0.42) {
        const chip = Math.sin(a * 5 + tiltA * 2) * Math.sin(a * 3 - tiltA);
        v.y -= Math.max(0, chip) * 0.11;
      }
    }
    // flat fracture face across the top
    const cut = H * 0.5 - tilt * (Math.cos(tiltA) * v.x + Math.sin(tiltA) * v.z);
    if (v.y > cut) v.y = cut;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  // lay it on its side — the placer only ever spins it about world Y
  g.rotateZ(Math.PI / 2);
  g.rotateX(rng() * 0.25 - 0.125);
  g.computeBoundingBox();
  return g;
}

/** Broken masonry: a chipped block with one flat bed and sheared corners. */
function rubbleChunk(rng, o = {}) {
  const g = new THREE.BoxGeometry(o.w ?? 0.62, o.h ?? 0.40, o.d ?? 0.52, 2, 2, 2).toNonIndexed();
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  const n1 = rng() * 6.28, n2 = rng() * 6.28, n3 = rng() * 6.28;
  const minY = -(o.h ?? 0.40) * 0.5;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const d = Math.sin(v.x * 7 + n1) * Math.sin(v.y * 6 + n2) * Math.sin(v.z * 8 + n3);
    v.x += d * 0.085; v.z += d * 0.075;
    v.y += Math.sin(v.x * 9 + n3) * 0.05;
    // shear one corner off entirely — a fracture, not erosion
    const sh = v.x * 0.8 + v.z * 0.6 + v.y * 0.5;
    if (sh > 0.42) { v.x -= (sh - 0.42) * 0.5; v.z -= (sh - 0.42) * 0.4; }
    // the bed stays flat so it sits on the ground instead of hovering
    if (v.y < minY + 0.02) v.y = minY;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** A cracked amphora — neck, shoulder, two handles: a NON-convex silhouette. */
function amphora(rng) {
  const prof = [];
  const H = 1.30;
  const shape = [
    [0.02, 0.00], [0.13, 0.02], [0.17, 0.06], [0.26, 0.18], [0.33, 0.34],
    [0.35, 0.48], [0.32, 0.62], [0.24, 0.74], [0.15, 0.82], [0.126, 0.90],
    [0.14, 0.965], [0.185, 1.00],
  ];
  for (const [r, t] of shape) prof.push(new THREE.Vector2(Math.max(0.012, r * (1 + (rng() - 0.5) * 0.05)), t * H));
  const body = new THREE.LatheGeometry(prof, 28);
  const parts = [body];
  for (const sgn of [-1, 1]) {
    const h = new THREE.TorusGeometry(0.135, 0.075, 8, 16, Math.PI * 1.15);
    h.rotateY(Math.PI / 2);
    h.rotateZ(-Math.PI * 0.12);
    h.translate(sgn * 0.20, H * 0.80, 0);
    if (sgn < 0) h.scale(-1, 1, 1);
    parts.push(h);
  }
  const g = mergeGeos(parts);
  // topple it: the neck must break the vertical, not stand to attention
  g.rotateX(Math.PI * 0.46 + rng() * 0.1);
  g.rotateY(rng() * 0.6);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}


// ---------------------------------------------------------------------------
// A radial floor disc carrying an AUTHORED value gradient in its vertex colour.
// ART_DIRECTION §1.1: the ground plane must sit DOWN in the value structure so
// the character reads as the brightest object on screen. A flat CircleGeometry
// lit by a uniform hemisphere is one unmodulated slab from centre to skirt —
// which is precisely what made the floor the second-brightest large surface in
// the frame. The ramp here is PAINTED: a radial falloff, a directional gradient
// away from the key, and a warm pool under every brazier, exactly the way a
// background artist would glaze a floor plate.
// ---------------------------------------------------------------------------
function paintedFloorDisc(R, rings, seg, shade) {
  const nv = 1 + rings * seg;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
  const U = new Float32Array(nv * 2), C = new Float32Array(nv * 3);
  const idx = [];
  let w = 0;
  const put = (x, z, r) => {
    P[w * 3] = x; P[w * 3 + 1] = z; P[w * 3 + 2] = 0;      // authored in XY, mesh spins it flat
    N[w * 3 + 2] = 1;
    U[w * 2] = 0.5 + x / (2 * R); U[w * 2 + 1] = 0.5 + z / (2 * R);
    const c = shade(x, z, r / R);
    C[w * 3] = c[0]; C[w * 3 + 1] = c[1]; C[w * 3 + 2] = c[2];
    w++;
  };
  put(0, 0, 0);
  for (let k = 1; k <= rings; k++) {
    // radii biased outward: the medallion zone needs the vertex density, the
    // skirt only needs enough to carry the falloff
    const r = R * Math.pow(k / rings, 0.86);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      put(Math.cos(a) * r, Math.sin(a) * r, r);
    }
  }
  for (let i = 0; i < seg; i++) idx.push(0, 1 + i, 1 + ((i + 1) % seg));
  for (let k = 0; k < rings - 1; k++) {
    const a0 = 1 + k * seg, a1 = 1 + (k + 1) * seg;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      idx.push(a0 + i, a1 + i, a1 + j);
      idx.push(a0 + i, a1 + j, a0 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------
// A fluted, entasis-tapered Doric shaft. A raw cylinder with a box capital is a
// painted tube (§7); real flutes give the shaft an ink-dark crevice and a
// gold-caught arris, which is what separates two columns standing side by side.
// ---------------------------------------------------------------------------
function flutedShaft(rBase, rTop, H, flutes, depth, seg) {
  const g = new THREE.CylinderGeometry(1, 1, H, flutes * (seg || 3), 8, false);
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const rad = Math.hypot(v.x, v.z);
    // clamp: the float32 cap vertices land a few ULPs outside [0,1] and a
    // fractional pow() of a negative is NaN, which poisons the bounding sphere
    const t = Math.min(1, Math.max(0, v.y / H + 0.5));    // 0 at base, 1 at top
    // ENTASIS: a real Greek shaft swells slightly below the middle and tapers
    // to the neck. A straight linear taper reads as a traffic cone.
    const swell = 1 + 0.035 * Math.sin(Math.PI * Math.min(1, t * 1.15));
    const r = (rBase + (rTop - rBase) * Math.pow(t, 0.92)) * swell;
    if (rad > 1e-5) {
      const a = Math.atan2(v.z, v.x);
      // scalloped flutes, dying into the plain necking band at either end
      const band = Math.min(1, Math.min(t, 1 - t) * 9.0);
      const flute = (0.5 - 0.5 * Math.cos(a * flutes)) * depth * band;
      const k = (r - flute) / rad;
      v.x *= k; v.z *= k;
    } else { v.x *= r; v.z *= r; }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// A SENTINEL — a bronze funerary effigy standing guard at the gate.
//
// §1.2 demands the art-directed rim on "every character, enemy and hero prop",
// and §1.1 demands a mid-ground value band; a chamber whose tallest silhouettes
// are all cylinders gives the rim nothing human-shaped to draw. These are
// architecture, not actors: helmet crest, shoulder line, cloak wedge and a
// spear, authored so the silhouette survives the 1/8-resolution read.
// ---------------------------------------------------------------------------
function sentinel(rng) {
  const parts = [];
  const R = () => rng();
  // --- legs under a pleated kilt -----------------------------------------
  for (const sgn of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.088, 0.13, 1.02, 10, 1);
    leg.translate(sgn * 0.115, 0.51, sgn * 0.03);
    parts.push(leg);
  }
  const kiltPts = [];
  for (let i = 0; i <= 7; i++) { const t = i / 7; kiltPts.push(new THREE.Vector2(0.19 + 0.20 * Math.pow(t, 1.5), 1.52 - 0.60 * t)); }
  const kilt = new THREE.LatheGeometry(kiltPts, 14);
  parts.push(kilt);
  // --- torso: a cuirass that flares to a hard shoulder line ---------------
  const torsoPts = [];
  const prof = [[0.19, 0.00], [0.235, 0.10], [0.255, 0.26], [0.243, 0.44],
                [0.262, 0.60], [0.300, 0.74], [0.315, 0.86], [0.245, 0.93], [0.16, 0.97]];
  for (const [r, t] of prof) torsoPts.push(new THREE.Vector2(r, 1.50 + t * 0.86));
  const torso = new THREE.LatheGeometry(torsoPts, 16);
  torso.scale(1.28, 1, 0.72);                            // a chest is not a can
  parts.push(torso);
  // --- shoulders + arms ---------------------------------------------------
  for (const sgn of [-1, 1]) {
    const pauldron = new THREE.SphereGeometry(0.155, 12, 8);
    pauldron.scale(1, 0.72, 0.92);
    pauldron.translate(sgn * 0.375, 2.30, 0);
    parts.push(pauldron);
    const arm = new THREE.CylinderGeometry(0.072, 0.095, 0.92, 8, 1);
    arm.rotateZ(sgn * 0.14);
    arm.translate(sgn * 0.405, 1.86, 0.02);
    parts.push(arm);
  }
  // --- neck + helmeted head + crest --------------------------------------
  const neck = new THREE.CylinderGeometry(0.085, 0.11, 0.14, 8, 1);
  neck.translate(0, 2.42, 0);
  parts.push(neck);
  const head = new THREE.SphereGeometry(0.185, 14, 10);
  head.scale(0.94, 1.12, 1.0);
  head.translate(0, 2.63, 0.01);
  parts.push(head);
  // the crest is the whole point: it is what makes the silhouette read as a
  // helmeted figure and not as a lollipop at 1/8 resolution
  const crest = new THREE.CylinderGeometry(0.035, 0.035, 0.44, 6, 1, false);
  crest.scale(1, 1, 3.0);
  crest.translate(0, 2.92, -0.02);
  parts.push(crest);
  const crestArc = new THREE.TorusGeometry(0.20, 0.045, 6, 14, Math.PI * 0.95);
  crestArc.rotateY(Math.PI / 2);
  crestArc.translate(0, 2.86, 0.0);
  parts.push(crestArc);
  // --- cloak: a wedge hanging off the shoulders, the widest mass in the
  //     silhouette and the thing that stops the figure reading as a stick ---
  const cloak = new THREE.CylinderGeometry(0.62, 0.30, 1.78, 16, 4, true, Math.PI * 0.72, Math.PI * 1.56);
  const cp = cloak.attributes.position, cv = new THREE.Vector3();
  for (let i = 0; i < cp.count; i++) {
    cv.fromBufferAttribute(cp, i);
    const t = cv.y / 1.78 + 0.5;
    const a = Math.atan2(cv.z, cv.x);
    // folds: a scalloped hem so the cloak's bottom edge is drawn, not cut
    const fold = Math.sin(a * 7.0) * 0.035 * (1 - t);
    const k = 1 + fold / Math.max(0.05, Math.hypot(cv.x, cv.z));
    cv.x *= k; cv.z *= k;
    cv.y -= (1 - t) * (1 - t) * 0.10;
    cp.setXYZ(i, cv.x, cv.y, cv.z);
  }
  cloak.computeVertexNormals();
  cloak.translate(0, 1.52, -0.10);
  parts.push(cloak);
  // --- spear: a hard vertical that breaks the lintel line -----------------
  const haft = new THREE.CylinderGeometry(0.036, 0.040, 3.55, 8, 1);
  haft.translate(0.60, 1.72, 0.06);
  parts.push(haft);
  const blade = new THREE.ConeGeometry(0.105, 0.52, 8, 1);
  blade.translate(0.60, 3.68, 0.06);
  parts.push(blade);
  const butt = new THREE.ConeGeometry(0.055, 0.20, 6, 1);
  butt.rotateX(Math.PI);
  butt.translate(0.60, -0.04, 0.06);
  parts.push(butt);

  const g = mergeGeos(parts);
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}

/** Minimal position/normal/uv merge — no BufferGeometryUtils dependency. */
function mergeGeos(list) {
  const src = list.map((g) => (g.index ? g.toNonIndexed() : g));
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
    g.dispose();
    if (src[k] !== list[k]) list[k].dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  return out;
}

/** Flat-shaded copy of a geometry — carved stone reads by its facets. */
function faceted(geo) {
  if (!geo.index) { geo.computeVertexNormals(); return geo; }   // already non-indexed
  const g = geo.toNonIndexed();
  g.computeVertexNormals();
  geo.dispose();
  return g;
}

export class World {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.colliders = [];
    this.bounds = { r: 16 };
    this.center = new THREE.Vector3(0, 0, 0);
    this.biome = 'tartarus';
    this.props = [];
    this._geo = [];
  }

  async init(ctx) {
    this.ctx = ctx;
    this.rng = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('world') : ctx.rng;
    ctx.scene.add(this.root);
    const q = (typeof location !== 'undefined') ? new URLSearchParams(location.search) : null;
    const want = (q && q.get('biome')) || (ctx.run && ctx.run.biome) || this.biome;
    this.biome = KIT[want] ? want : 'tartarus';
    this.build(ctx);
    ctx.events?.on?.('capture.state', ({ name }) => {
      if (typeof name === 'string' && name.startsWith('biome:')) this.setBiome(name.slice(6), ctx);
    });
  }

  // ─────────────────────────────────────────────────────────────── build ──
  build(ctx) {
    const mats = ctx.mats;
    const kit = KIT[this.biome] || KIT.tartarus;
    const M = (n, opts) => (mats && mats.get ? mats.get(n, opts) : new THREE.MeshStandardMaterial({ color: 0x5a2331 }));
    const R = this.bounds.r;
    const rng = this.rng;
    const f = () => (rng && rng.f ? rng.f() : 0.5);

    const add = (mesh, name) => { mesh.name = name; this.root.add(mesh); return mesh; };
    const keep = (g) => { this._geo.push(g); return g; };
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), eu = new THREE.Euler();
    const pos = new THREE.Vector3(), scl = new THREE.Vector3();

    // ── floor ──────────────────────────────────────────────────────────────
    // The practical layout has to be read BEFORE the floor is built: the light
    // pools are glazed into the floor's vertex colour, which is how a painted
    // background gets a lit ground plane instead of a uniform slab (§1.1).
    const rigDef = ctx.lighting && ctx.lighting.rigDef;
    const practicalList = (rigDef && rigDef.practicals) || FALLBACK_PRACTICALS;
    const warmPools = practicalList
      .filter((p) => { const c = new THREE.Color(p.color || '#ffa257'); return c.r >= c.b * 1.15; })
      .map((p) => [p.pos[0], p.pos[2]]);
    // the key's horizontal SOURCE direction (dir is the direction it travels)
    const kdir = (rigDef && rigDef.key && rigDef.key.dir) || [0.73, -0.42, -0.53];
    let sx = -kdir[0], sz = -kdir[2];
    { const l = Math.hypot(sx, sz) || 1; sx /= l; sz /= l; }

    const sstep = (a, b, x0) => { const u = Math.min(1, Math.max(0, (x0 - a) / (b - a))); return u * u * (3 - 2 * u); };
    const floorShade = (x, z, t) => {
      // ── §9 THE VALUE LAW, painted into the ground plane ──────────────────
      // Review round 1: the floor was the BRIGHTEST large surface in the frame
      // (groundLuma 0.31 vs a frame median of 0.19) and the glaze here was a
      // direct cause — its depth term multiplied the NEAR floor by 2.35x, and
      // the near floor is exactly the band a 3/4 camera puts in the bottom of
      // frame. Hades composes the opposite way, and so do we now:
      //
      //   DARK PLINTH   t < 0.40   the stone the character stands on. It has to
      //                            be the darkest thing near the character or
      //                            the silhouette has nothing to read against.
      //   LIT ANNULUS   t ~ 0.66   the braziers stand on the ornament ring, so
      //                            the glaze paints light where the practicals
      //                            actually put it.
      //   DARK APRON    dep > 0.55 the near half of the arena — the frame's
      //                            foreground — falls away to near-ink so the
      //                            bottom of frame is a dark repoussoir.
      //   FAR RECESSION dep < 0.20 the far skirt dims into the distance haze.
      //
      // NOTE for other agents: `dep` is a WORLD-FIXED gradient along +X+Z. §8
      // pins the camera yaw at 45deg and it never rotates during play, so this
      // is a painted composition decision, not a view-dependent cheat. If the
      // camera ever gains yaw, this whole function has to be re-derived.
      // The annulus sits at t 0.74 — the radius the braziers stand on — and it
      // is NARROW, because the measured failure was a broad lit plate reaching
      // all the way in to the medallion. Inside 0.5 the stone is a dark plinth.
      // The annulus has a STEEP INNER EDGE, not a Gaussian: the mid-ground band
      // of a composed frame has to start somewhere, and a soft bell put lit
      // stone right where the character stands. Inside t 0.42 the floor is a
      // dark plinth; the lit ring runs from 0.56 out to the ornament ring and
      // then dies into the skirt.
      const ring = sstep(0.38, 0.55, t) * (1 - 0.70 * sstep(0.76, 1.00, t));
      // The plinth is DARK, not empty: at 0.07 it read as a hole cut in the
      // floor rather than as unlit stone, and a hole is not a stage. 0.125 is
      // the level at which the ashlar bed and the ichor staining are still
      // legible in the shadow while the ground plane stays a full band under
      // the architecture.
      let v = 0.125 + 1.45 * ring;
      const dep = Math.min(1, Math.max(0, 0.5 + 0.5 * ((x + z) * 0.70711 / (R + 0.9))));
      // The apron edge is SHARP on purpose and its position is load-bearing:
      // at the shipping camera it falls between the mid-ground band (dep < 0.57)
      // and the bottom-of-frame foreground (dep > 0.62), which is exactly the
      // boundary tools/analyze.mjs measures as depthBands. Softening it merges
      // the two bands back into one and the value law fails again.
      v *= 1 - 0.972 * sstep(0.53, 0.63, dep);         // the foreground apron
      v *= 1 - 0.30 * sstep(0.62, 1.00, dep);          // ...and it keeps falling
      v *= 0.74 + 0.26 * sstep(0.04, 0.30, dep);       // far skirt recedes
      // a whisper of the key's own azimuth so the glaze is not purely 1-D
      const g = 0.5 + 0.5 * ((x * sx + z * sz) / (R + 0.9));
      v *= 0.92 + 0.16 * g;
      // warm pools under the braziers — now a HUE cue on top of the annulus,
      // not a second brightness term (the practicals carry the luminance)
      let warm = 0;
      for (const [px, pz] of warmPools) {
        const d = Math.hypot(x - px, z - pz);
        warm += Math.max(0, 1 - d / 5.8) ** 2;
      }
      warm = Math.min(1.15, warm);
      v *= 1 + warm * 0.20;
      // §9.6 TWO HUES FROM THE GROUND UP. Lit stone drifts warm crimson, dark
      // stone drifts toward the #5fd0ff accent axis, so the floor's own value
      // structure carries the complement instead of relying on a fill light.
      const lit = Math.min(1, Math.max(0, (v - 0.16) / 1.40));
      const r  = v * (0.88 + 0.20 * lit) * (1 + warm * 0.14);
      const gg = v * (0.90 + 0.12 * lit);
      const b  = v * (1.26 - 0.36 * lit) * (1 - warm * 0.14);
      return [r, gg, b];
    };
    const floor = add(new THREE.Mesh(
      keep(paintedFloorDisc(R + 0.9, 22, 128, floorShade)),
      M(kit.floor, { vertexColors: true })), 'floor');
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;

    // Gold inlay rings. The mid ring at 11.2 clipped out of frame on three
    // sides in the play shot and read as a lens artifact rather than as
    // architecture — three concentric rings around the player is a bullseye,
    // and §1.5 says ornament belongs on the PERIPHERY so the eye can find the
    // character on a quiet floor.
    const trim = M(kit.trim);
    // long/thin members get plain hammered leaf: the composed filigree BAND
    // squashed on to a bar is a stripe generator, and stripes at this scale are
    // the aliasing the critique called "crawling white pixel strings".
    const leaf = M('gold.leaf');
    for (const [rad, thick] of [[7.9, 0.062], [R + 0.85, 0.16]]) {
      const ring = add(new THREE.Mesh(keep(new THREE.TorusGeometry(rad, thick, 10, 160)), leaf), 'inlay.' + rad);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      ring.castShadow = false; ring.receiveShadow = true;
    }

    // ── central medallion ─────────────────────────────────────────────────
    // A floor of nothing but ashlar reads as wallpaper from above; the medallion
    // breaks the grid and gives the composition a bullseye to sit the player in.
    // The rosette is an AUTHORED texture (concentric polar meander, sixteen
    // anthemion petals on the spoke axes, a solid emblem in the middle) — not
    // the generic rock material with a Worley field showing through it.
    // 5.05 put the player at the exact centre of the brightest, busiest, highest
    // -chroma element in the shot — inverted hierarchy. At 3.5 the ornament is a
    // BASE under the character rather than a halo around them.
    const MEDR = 3.5, MK = MEDR / 5.05;
    const medallion = add(new THREE.Mesh(keep(new THREE.CircleGeometry(MEDR, 96)),
      M(kit.medallion || kit.rock)), 'medallion');
    medallion.rotation.x = -Math.PI / 2;
    medallion.position.y = 0.012;
    medallion.receiveShadow = true;
    const SPOKES = 16;
    // 13cm is sub-pixel at 26m and the bar is emissive gold, so it aliased into
    // a string of crawling white dashes that lives in HDR before AA ever sees
    // it. 26cm keeps every spoke above 2px at the play camera (§7).
    const spokeGeo = keep(new THREE.BoxGeometry(2.9 * MK, 0.05, 0.26));
    const spokes = new THREE.InstancedMesh(spokeGeo, leaf, SPOKES);
    spokes.name = 'medallion.rays';
    spokes.receiveShadow = true;
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
      const rr = 3.35 * MK;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, 0));
      spokes.setMatrixAt(i, m4.compose(pos.set(Math.cos(a) * rr, 0.026, Math.sin(a) * rr), q,
        scl.set(1, 1, i % 2 ? 0.7 : 1)));
    }
    spokes.instanceMatrix.needsUpdate = true;
    this.root.add(spokes);
    for (const [rad, thick] of [[1.15 * MK, 0.06], [4.85 * MK, 0.075]]) {
      const r2 = add(new THREE.Mesh(keep(new THREE.TorusGeometry(rad, thick, 8, 96)), leaf), 'medallion.ring');
      r2.rotation.x = -Math.PI / 2;
      r2.position.y = 0.03;
    }

    // ── the island's edge: a stone skirt so the arena has thickness ────────
    const wallMat = M(kit.wall);
    const skirt = add(new THREE.Mesh(keep(new THREE.CylinderGeometry(R + 0.9, R + 0.2, 2.6, 128, 1, true)), wallMat), 'skirt');
    skirt.position.y = -1.3;
    skirt.receiveShadow = true;
    const underside = add(new THREE.Mesh(keep(new THREE.CircleGeometry(R + 0.25, 64)), M(kit.rock)), 'underside');
    underside.rotation.x = Math.PI / 2;
    underside.position.y = -2.6;

    // ── ashlar perimeter wall (instanced) ─────────────────────────────────
    // Arc across the far half of the arena with a gap for the gate at 270°.
    // The arc's two ends are the only places the wall can be seen from behind,
    // so they are kept well away from the 45-degree camera azimuth.
    const A0 = 132 * DEG, A1 = 340 * DEG;
    const COURSES = 4, COURSE_H = 0.82, BLOCK_W = 1.62;
    const wallR = R + 1.05;
    const gateA = 270 * DEG, gateHalf = 13 * DEG;
    const blocks = [];
    for (let c = 0; c < COURSES; c++) {
      const y = 0.06 + COURSE_H * (c + 0.5);
      const stagger = (c % 2) * 0.5;
      const span = A1 - A0;
      const n = Math.max(6, Math.round(span * wallR / BLOCK_W));
      for (let i = 0; i < n; i++) {
        const a = A0 + span * ((i + 0.5 + stagger) / n);
        if (Math.abs(((a - gateA + Math.PI) % (Math.PI * 2)) - Math.PI) < gateHalf) continue;
        // The arc has to END somewhere, and a full-height terminus seen edge-on
        // reads as a stack of lit slabs. Crumble the last few metres instead:
        // the courses step down and the wall dies into the void as a ruin.
        const edgeT = Math.min(Math.abs(a - A0), Math.abs(a - A1)) / (22 * DEG);
        if (c >= 1 && edgeT < 1 && f() > edgeT * 0.55 + 0.12 * c) continue;
        const jr = (f() - 0.5) * 0.07;
        const jh = (f() - 0.5) * 0.10;
        // blocks must OVERLAP their spacing: a gap between two blocks lets the
        // key light through and the wall reads as a picket fence
        const w = BLOCK_W * (1.03 + f() * 0.14);
        blocks.push({ a, y: y + jh, r: wallR + jr, w, h: COURSE_H * 0.94, d: 1.05 + f() * 0.22, tilt: (f() - 0.5) * 0.05 });
      }
    }
    // §1.5: the ashlar splits into two bays. Within 58 degrees of the door axis
    // the blocks wear the full gold meander; everything else wears a plain
    // two-rail fillet, so the ornament is a WAYFINDER instead of wallpaper.
    const bayMat = M(kit.bay || kit.wall);
    const blockGeo = keep(faceted(new THREE.BoxGeometry(1, 1, 1)));
    const gateDist = (a) => Math.abs(((a - gateA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const focalBlocks = blocks.filter((b) => gateDist(b.a) <= 58 * DEG);
    const plainBlocks = blocks.filter((b) => gateDist(b.a) > 58 * DEG);
    for (const [list, mat, nm] of [[focalBlocks, wallMat, 'wall.ashlar'], [plainBlocks, bayMat, 'wall.ashlar.plain']]) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(blockGeo, mat, list.length);
      im.name = nm;
      im.castShadow = true; im.receiveShadow = true;
      list.forEach((b, i) => {
        pos.set(Math.cos(b.a) * b.r, b.y, Math.sin(b.a) * b.r);
        eu.set(b.tilt, -b.a, b.tilt * 0.6);
        qt.setFromEuler(eu);
        scl.set(b.d, b.h, b.w);
        im.setMatrixAt(i, m4.compose(pos, qt, scl));
      });
      im.instanceMatrix.needsUpdate = true;
      this.root.add(im);
    }

    // solid backing behind the ashlar — mass, and no light leaks through seams.
    // Its own material instance: mutating `side` on the shared one would make
    // every stone surface in the game double-sided.
    const wallBackMat = M(kit.wall, { side: THREE.DoubleSide });
    for (const [s0, e0] of [[A0 + 15 * DEG, gateA - gateHalf], [gateA + gateHalf, A1 - 15 * DEG]]) {
      const back = add(new THREE.Mesh(
        keep(new THREE.CylinderGeometry(wallR + 0.62, wallR + 0.62, COURSES * COURSE_H + 0.2, 96, 1, true, s0, e0 - s0)),
        wallBackMat), 'wall.back');
      back.position.y = (COURSES * COURSE_H) * 0.5;
      back.castShadow = true; back.receiveShadow = true;
    }

    // End piers. Without them the arc simply stops, and at a grazing camera the
    // last few blocks read as a picket fence of lit slabs instead of a wall.
    const pierGeo = keep(faceted(new THREE.BoxGeometry(1.9, COURSES * COURSE_H + 0.55, 1.75)));
    for (const pa of [gateA - gateHalf - 0.02, gateA + gateHalf + 0.02]) {
      const pier = add(new THREE.Mesh(pierGeo, wallMat), 'wall.pier');
      pier.position.set(Math.cos(pa) * (wallR + 0.18), (COURSES * COURSE_H + 0.55) * 0.5, Math.sin(pa) * (wallR + 0.18));
      pier.rotation.y = -pa;
      pier.castShadow = true; pier.receiveShadow = true;
    }

    // A gold meander band capping the wall. §1.5: ornament is CONCENTRATED on
    // focal architecture and never uniformly spammed — a band at one intensity
    // around the whole circumference is wallpaper and it destroys the eye path.
    // So the band is cut into segments, its emissive falls off with angular
    // distance from the door axis, and the rear arc carries none at all.
    {
      const SEG = 7 * DEG;
      const arcs = [[A0, gateA - gateHalf], [gateA + gateHalf, A1]];
      const runs = [];
      for (const [s0, e0] of arcs) {
        for (let a = s0; a < e0 - SEG * 0.5; a += SEG) {
          const mid = a + SEG * 0.5;
          const dA = Math.abs(((mid - gateA + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / DEG;
          if (dA > 104) continue;                       // rear arc: no ornament
          const w = dA <= 30 ? 1.0 : Math.max(0.15, 1.0 - (dA - 30) / 90 * 0.85);
          runs.push({ a, w });
        }
      }
      // bucket the falloff so the whole band is 4 materials, not 25
      const bucket = (w) => Math.round(w * 4) / 4;
      const groups = new Map();
      for (const r of runs) {
        const b = bucket(r.w);
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(r.a);
      }
      // 0.15 tube radius put the band at ~2px on the far wall, which is where
      // it broke into a dashed line no amount of AA could hold (§7). 0.24 keeps
      // every segment above 2.5px at the play camera.
      const bandGeo = keep(new THREE.TorusGeometry(wallR, 0.24, 8, 12, SEG));
      for (const [b, list] of groups) {
        // let the metal REFLECT: emissive gold is a neon tube, not filigree
        const im = new THREE.InstancedMesh(bandGeo, M('gold.leaf', { emissiveIntensity: 0.07 + b * 0.26 }), list.length);
        im.name = 'wall.band';
        im.castShadow = true;
        list.forEach((a, i) => {
          eu.set(Math.PI / 2, 0, a, 'ZYX');
          qt.setFromEuler(eu);
          im.setMatrixAt(i, m4.compose(pos.set(0, COURSES * COURSE_H + 0.12, 0), qt, scl.set(1, 1, 1)));
        });
        im.instanceMatrix.needsUpdate = true;
        this.root.add(im);
      }
    }

    // ── columns ───────────────────────────────────────────────────────────
    const COLS = 8;
    const colR = R - 1.35, colH = 5.4;
    // §7: a raw cylinder with a box capital is a painted tube. 20 real flutes at
    // 9% of the shaft radius carve an ink crevice and a lit arris into every
    // column, and the entasis stops the shaft reading as a traffic cone.
    const shaftGeo = keep(flutedShaft(0.56, 0.455, colH, 20, 0.052, 3));
    const baseGeo = keep(faceted(new THREE.CylinderGeometry(0.68, 0.8, 0.46, 20, 1)));
    const capGeo = keep(faceted(new THREE.CylinderGeometry(0.84, 0.52, 0.5, 20, 1)));
    const abacusGeo = keep(faceted(new THREE.BoxGeometry(1.72, 0.24, 1.72)));
    // per-instance colour + world-projection offset: the shafts are triplanar,
    // so a per-instance YAW alone already re-registers the texture on each one,
    // and `variation` re-tones them so no two share a streak pattern.
    const colMat = M(kit.column || kit.wall, { variation: 0.22 });
    const shafts = new THREE.InstancedMesh(shaftGeo, colMat, COLS);
    const bases = new THREE.InstancedMesh(baseGeo, colMat, COLS);
    // §1.5 ORNAMENT HIERARCHY: only the pair flanking the door gets the bronze
    // echinus and the gold abacus. Every other column terminates in plain
    // stone, so the eye is told where the room's focus is.
    const plainCaps = new THREE.InstancedMesh(capGeo, colMat, COLS - 2);
    const caps = new THREE.InstancedMesh(capGeo, M(kit.metal), 2);
    const abaci = new THREE.InstancedMesh(abacusGeo, trim, 2);
    for (const im of [shafts, bases, caps, abaci, plainCaps]) { im.castShadow = true; im.receiveShadow = true; }
    shafts.name = 'column.shaft'; bases.name = 'column.base'; caps.name = 'column.cap';
    abaci.name = 'column.abacus'; plainCaps.name = 'column.cap.plain';
    const colAngles = [];
    for (let i = 0; i < COLS; i++) {
      const a = A0 + (A1 - A0) * ((i + 0.5) / COLS);
      // never plant a column in the doorway — flank it
      const d = ((a - gateA + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (Math.abs(d) < gateHalf + 9 * DEG) { colAngles.push(gateA + Math.sign(d || 1) * (gateHalf + 11 * DEG)); continue; }
      colAngles.push(a);
    }
    // rank the columns by how close they are to the door axis
    const dGate = colAngles.map((a) => Math.abs(((a - gateA + Math.PI * 3) % (Math.PI * 2)) - Math.PI));
    const order = colAngles.map((_, i) => i).sort((p, q) => dGate[p] - dGate[q]);
    const focal = new Set(order.slice(0, 2));
    let fi = 0, pi = 0;
    for (let i = 0; i < COLS; i++) {
      const a = colAngles[i];
      const x = Math.cos(a) * colR, z = Math.sin(a) * colR;
      // full-circle random yaw, not a +-2deg nudge: the shafts are world-space
      // triplanar, so spinning an instance genuinely re-registers its texture.
      const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f() * Math.PI * 2, 0));
      bases.setMatrixAt(i, m4.compose(pos.set(x, 0.23, z), yaw, scl.set(1, 1, 1)));
      shafts.setMatrixAt(i, m4.compose(pos.set(x, 0.46 + colH * 0.5, z), yaw, scl.set(1, 1, 1)));
      if (focal.has(i)) {
        caps.setMatrixAt(fi, m4.compose(pos.set(x, 0.46 + colH + 0.25, z), yaw, scl.set(1, 1, 1)));
        abaci.setMatrixAt(fi, m4.compose(pos.set(x, 0.46 + colH + 0.60, z), yaw, scl.set(1, 1, 1)));
        fi++;
      } else {
        plainCaps.setMatrixAt(pi, m4.compose(pos.set(x, 0.46 + colH + 0.25, z), yaw, scl.set(0.94, 0.88, 0.94)));
        pi++;
      }
    }
    for (const im of [shafts, bases, caps, abaci, plainCaps]) { im.instanceMatrix.needsUpdate = true; this.root.add(im); }

    // ── the gate (focal architecture, the 'arch' shot looks straight at it) ─
    const gate = new THREE.Group();
    gate.name = 'gate';
    gate.position.set(Math.cos(gateA) * (wallR + 0.1), 0, Math.sin(gateA) * (wallR + 0.1));
    gate.rotation.y = -gateA + Math.PI / 2;
    const jamb = keep(faceted(new THREE.BoxGeometry(1.35, 7.0, 1.5)));
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(jamb, wallMat);
      p.position.set(s * 3.1, 3.5, 0);
      p.castShadow = true; p.receiveShadow = true;
      gate.add(p);
    }
    const lintel = new THREE.Mesh(keep(faceted(new THREE.BoxGeometry(8.4, 1.0, 1.9))), wallMat);
    lintel.position.y = 7.45; lintel.castShadow = true; lintel.receiveShadow = true;
    gate.add(lintel);
    const band = new THREE.Mesh(keep(new THREE.BoxGeometry(8.5, 0.42, 2.02)), trim);
    band.position.y = 6.72; band.castShadow = true;
    gate.add(band);
    // the torus UV runs ALONG the arc, so the voussoir stone lays real radial
    // wedges across it instead of the wall's 3x2 bed smeared round a curve
    const arch = new THREE.Mesh(keep(new THREE.TorusGeometry(3.1, 0.52, 12, 40, Math.PI)), M(kit.arch || kit.wall));
    arch.position.y = 7.95; arch.castShadow = true; arch.receiveShadow = true;
    gate.add(arch);
    const keystone = new THREE.Mesh(keep(faceted(new THREE.BoxGeometry(1.0, 1.3, 2.1))), leaf);
    keystone.position.y = 11.1; keystone.castShadow = true;
    gate.add(keystone);
    // The doorway must not be a hole: without a backing you look straight
    // through it at the hazed backdrop and it reads as a blank grey panel.
    // Instead it is a dark corridor with one cold light deep inside — the only
    // full-chroma complement note in a warm frame (ART_DIRECTION §1.2).
    const rimC = (ctx.lighting && ctx.lighting.rim && ctx.lighting.rim.color)
      ? ctx.lighting.rim.color.clone() : new THREE.Color('#5fd0ff');
    this.doorMat = new THREE.ShaderMaterial({
      uniforms: {
        uCore: { value: new THREE.Color('#8fe4ff') },   // pale cyan core, TINY
        uBody: { value: new THREE.Color('#2ec6e8') },   // authored teal; AgX lands it on Poseidon cyan
        uMid:  { value: new THREE.Color('#8ef0d0') },   // Hecate witch-teal band
        uInk:  { value: new THREE.Color('#04070c') },
        uRim:  { value: rimC },
        uTime: { value: 0 },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform vec3 uCore, uBody, uMid, uInk, uRim; uniform float uTime;
        float h12(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        float vn(vec2 p){
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h12(i), h12(i + vec2(1,0)), f.x), mix(h12(i + vec2(0,1)), h12(i + vec2(1,1)), f.x), f.y);
        }
        float fbm3(vec2 p){ float a = 0.5, s = 0.0; for(int i = 0; i < 3; i++){ s += a * vn(p); p *= 2.03; a *= 0.5; } return s / 0.875; }
        // ridged: the fold gives the threshold FILAMENTS instead of a soft blur
        float ridged3(vec2 p){ return 1.0 - abs(fbm3(p) * 2.0 - 1.0); }
        void main(){
          // §6 BOLD FLAT SHAPES, and §1.5 says this is the room's focal element:
          // the whole composition points at it, so it cannot be an airbrushed
          // gradient. Polar coordinates + a radius-dependent angular drag give a
          // real VORTEX; three octaves of ridged fbm read in (swirl, radius) give
          // it filaments; a hard lip at 0.94 gives it an EDGE; and six slow
          // orbiting arcs give it motion that is legible at a glance.
          vec2 p = vec2((vUv.x - 0.5) * 1.42, (vUv.y - 0.46) * 1.04);
          float r = length(p * vec2(1.0, 0.78)) * 2.0;
          float a = atan(p.y, p.x);

          float sw = a + 2.30 / (r + 0.38) - uTime * 0.20;
          float n1 = ridged3(vec2(sw * 1.5, r * 3.0 - uTime * 0.26));
          float n2 = ridged3(vec2(sw * 3.0 + 11.0, r * 6.1 - uTime * 0.44));
          float n3 = vn(vec2(sw * 6.1 + 31.0, r * 10.5 - uTime * 0.72));
          float fieldN = n1 * 0.52 + n2 * 0.32 + n3 * 0.16;

          // 6 orbiting arcs, each on its own radius and its own slow rate
          float arcs = 0.0;
          for(int i = 0; i < 6; i++){
            float fi = float(i);
            float ang = a - uTime * (0.13 + fi * 0.031) - fi * 1.047;
            ang = mod(ang + 3.14159265, 6.28318531) - 3.14159265;
            float rr = 0.30 + 0.115 * fi;
            float d = (r - rr) * 13.0;
            arcs += exp(-d * d) * exp(-ang * ang * 1.7);
          }

          float rd = r + (fieldN - 0.5) * 0.22;
          float body = pow(max(0.0, 1.0 - rd * 0.90), 1.7);
          float core = pow(max(0.0, 1.0 - rd * 2.15), 2.2);
          // a HARD thin lip at 0.94 of the aperture: a threshold needs an edge,
          // otherwise it is a gradient and a gradient reads as a light leak
          float lip  = smoothstep(0.99, 0.935, rd) - smoothstep(0.935, 0.875, rd);
          float glow = pow(max(0.0, 1.0 - rd * 0.58), 3.0) * 0.30;

          // two-stop field (#5fd0ff core -> #241238 outer) with the filaments
          // carrying the value, then the accent notes laid over it
          vec3 c = mix(uInk, uBody, clamp(body * (0.22 + 1.30 * fieldN), 0.0, 1.0));
          c += uMid  * (lip * 1.85 + arcs * 0.62);
          c += uCore * core * (0.30 + 0.34 * fieldN);
          c += uRim  * glow * 0.42;

          // EMISSIVE GATED TO THE INNER 70% so the arch stone stays unblown
          c *= mix(0.10, 1.0, smoothstep(1.02, 0.70, rd));

          float breathe = 0.90 + 0.10 * sin(uTime * 0.7) * sin(uTime * 0.29 + 1.1);
          c *= breathe * 0.60;

          // the stone lintel occludes the top third: the threshold sits INSIDE
          // the architecture instead of floating in front of it
          c *= mix(0.16, 1.0, smoothstep(0.015, 0.33, 1.0 - vUv.y));
          // and the sill takes a bite out of the very bottom
          c *= mix(0.42, 1.0, smoothstep(0.0, 0.075, vUv.y));

          // Rolloff on the MAX CHANNEL, not per channel. A per-channel Reinhard
          // compresses the bright channels harder than the dark ones, which
          // pulls every ratio toward 1 — i.e. it desaturates exactly the element
          // that is supposed to be the only saturated cool note in the frame.
          float pk = max(c.r, max(c.g, c.b));
          c *= (pk / (1.0 + pk * 0.42)) / max(pk, 1e-4);
          // AgX's inset rotates saturated blue toward violet; the red channel is
          // held right down so the cyan survives the tonemap and the grade.
          c.r = min(c.r, 0.072);
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: THREE.FrontSide, toneMapped: false,
    });
    const doorGlow = new THREE.Mesh(keep(new THREE.PlaneGeometry(5.4, 7.0)), this.doorMat);
    doorGlow.name = 'gate.light';
    doorGlow.position.set(0, 3.5, 0.42);
    doorGlow.rotation.y = Math.PI;
    gate.add(doorGlow);

    // §1.5: the doorway is the room's focal architecture, so it carries the
    // heaviest ornament in the chamber — a gold archivolt with rosettes.
    const archivolt = new THREE.Mesh(keep(new THREE.TorusGeometry(3.06, 0.19, 8, 44, Math.PI)),
      M('gold.leaf', { emissiveIntensity: 0.30 }));
    archivolt.position.y = 7.95;
    archivolt.position.z = 0.86;
    archivolt.castShadow = true;
    gate.add(archivolt);
    const rosGeo = keep(new THREE.TorusGeometry(0.30, 0.085, 8, 18));
    const rosettes = new THREE.InstancedMesh(rosGeo, M('gold.leaf', { emissiveIntensity: 0.30 }), 5);
    rosettes.name = 'gate.rosettes';
    for (let i = 0; i < 5; i++) {
      const a = Math.PI * (0.14 + 0.72 * (i / 4));
      const q2 = new THREE.Quaternion();
      rosettes.setMatrixAt(i, m4.compose(pos.set(Math.cos(a) * 3.06, 7.95 + Math.sin(a) * 3.06, 0.99), q2, scl.set(1, 1, 1)));
    }
    rosettes.instanceMatrix.needsUpdate = true;
    gate.add(rosettes);

    // ── sentinels: two bronze effigies flanking the threshold ─────────────
    // §1.1 the mid-ground had no value band of its own and §1.2's rim had
    // nothing human-shaped to draw on. These are the chamber's only figures:
    // helmet crest, shoulder line, cloak wedge, spear — a silhouette that still
    // reads at 1/8 resolution, standing between the arena and the void so the
    // architecture finally sits ABOVE the floor and BELOW the ornament.
    {
      const plinthGeo = keep(faceted(new THREE.BoxGeometry(1.5, 0.86, 1.5)));
      const capGeoS = keep(faceted(new THREE.BoxGeometry(1.74, 0.20, 1.74)));
      const figGeo = keep(sentinel(f));
      const bronze = M(kit.metal);
      this.statues = [];
      for (const sgn of [-1, 1]) {
        const g2 = new THREE.Group();
        g2.name = 'sentinel';
        const aa = gateA + sgn * (gateHalf + 26 * DEG);
        const rr = wallR - 3.4;
        g2.position.set(Math.cos(aa) * rr, 0, Math.sin(aa) * rr);
        // face the arena centre, with a slight contrapposto turn
        g2.rotation.y = -aa + Math.PI / 2 + sgn * 0.22;
        const pl = new THREE.Mesh(plinthGeo, wallMat);
        pl.position.y = 0.43; pl.castShadow = true; pl.receiveShadow = true;
        const plc = new THREE.Mesh(capGeoS, wallMat);
        plc.position.y = 0.96; plc.castShadow = true; plc.receiveShadow = true;
        const fig = new THREE.Mesh(figGeo, bronze);
        fig.position.y = 1.06;
        fig.scale.setScalar(1.16);
        fig.castShadow = true; fig.receiveShadow = true;
        if (sgn < 0) fig.scale.x *= -1;             // mirrored pair, not clones
        g2.add(pl, plc, fig);
        this.root.add(g2);
        this.statues.push(g2);
      }
    }

    this.root.add(gate);
    this.gate = gate;

    // ── braziers, planted on the light rig's own practical positions ──────
    const practicals = practicalList;
    const warm = [], cool = [];
    for (const p of practicals) {
      const c = new THREE.Color(p.color || '#ffa257');
      (c.r >= c.b * 1.15 ? warm : cool).push(p);
    }
    if (warm.length) {
      const stemGeo = keep(faceted(new THREE.CylinderGeometry(0.28, 0.46, 1.35, 12, 1)));
      const bowlPts = [];
      for (let i = 0; i <= 9; i++) { const t = i / 9; bowlPts.push(new THREE.Vector2(0.20 + 0.52 * Math.pow(t, 0.72), 0.02 + 0.44 * t)); }
      const bowlGeo = keep(new THREE.LatheGeometry(bowlPts, 20));
      const coalGeo = keep(new THREE.IcosahedronGeometry(0.46, 1));
      const stems = new THREE.InstancedMesh(stemGeo, wallMat, warm.length);
      const bowls = new THREE.InstancedMesh(bowlGeo, M(kit.metal), warm.length);
      const coals = new THREE.InstancedMesh(coalGeo, M(kit.ember), warm.length);
      stems.name = 'brazier.stem'; bowls.name = 'brazier.bowl'; coals.name = 'brazier.coals';
      stems.castShadow = bowls.castShadow = true;
      stems.receiveShadow = bowls.receiveShadow = true;
      warm.forEach((p, i) => {
        const px = p.pos[0], pz = p.pos[2];
        const y = Math.max(0.9, p.pos[1]) - 0.85;
        const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f() * Math.PI, 0));
        stems.setMatrixAt(i, m4.compose(pos.set(px, y * 0.5 + 0.34, pz), yaw, scl.set(1, 1, 1)));
        bowls.setMatrixAt(i, m4.compose(pos.set(px, y + 0.34, pz), yaw, scl.set(1, 1, 1)));
        coals.setMatrixAt(i, m4.compose(pos.set(px, y + 0.60, pz), yaw, scl.set(1.05, 0.62, 1.05)));
      });
      for (const im of [stems, bowls, coals]) { im.instanceMatrix.needsUpdate = true; this.root.add(im); }
      this.coals = coals;

      // ── flames ────────────────────────────────────────────────────────
      // Y-axis billboards, 3-layer construction (core / body / glow) per
      // ART_DIRECTION §5. They are the brightest thing in the frame and the
      // visible source of the light pools the practicals cast.
      // §5 THREE-LAYER CONSTRUCTION, and the layers are real geometry, not one
      // gradient cone: a near-white CORE, a saturated BODY, and a wide low-alpha
      // additive GLOW, each drifting on its own smoothed-noise flicker (never a
      // sine). A single soft orange cone is the "flat 2D gradient" the critique
      // called out, and it has no shape language at all.
      const FLAME_FRAG = /* glsl */`
          varying vec2 vUv; uniform float uTime, uSeed; uniform vec3 uCore, uBody, uGlow;
          uniform float uLayer, uWidth, uAlpha;
          // smoothed value noise — the flicker must not be periodic
          float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
          float n11(float x){ float i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
                              return mix(h11(i), h11(i+1.0), f); }
          float flick(float t, float sp){
            return n11(t*0.9*sp) * 0.55 + n11(t*4.7*sp + 31.7) * 0.30 + n11(t*13.3*sp + 71.3) * 0.15;
          }
          void main(){
            float y = vUv.y;
            float fl = flick(uTime + uSeed * 7.3, 1.0 + uLayer * 0.55);
            float fl2 = flick(uTime * 1.7 + uSeed * 3.1 + 11.0, 0.8);
            // lateral sway grows with height and is driven by NOISE
            float sway = (fl - 0.5) * 0.30 * y * y + (fl2 - 0.5) * 0.10 * y;
            vec2 p = vec2(vUv.x - 0.5 - sway, y);
            // the tongue: a teardrop that pinches to a lick at the top
            float top = 0.62 + 0.38 * fl;                       // guttering height
            float w = uWidth * pow(max(0.0, 1.0 - y / top), 0.58) * smoothstep(0.0, 0.09, y);
            float d = abs(p.x) / max(w, 1e-3);
            // a second, thinner lick offset in phase so the flame has INTERNAL
            // structure instead of one smooth falloff
            float d2 = abs(p.x + (fl2 - 0.5) * 0.16 * y) / max(w * 0.42, 1e-3);
            float shape = smoothstep(1.06, 0.22, d);
            float lick  = smoothstep(1.0, 0.0, d2) * smoothstep(top, top * 0.22, y);
            float a = shape * smoothstep(top * 1.02, top * 0.52, y);
            vec3 c;
            if (uLayer < 0.5) {
              // CORE — near-white, tiny, low in the bowl
              c = uCore * (lick * 2.9 + a * 0.55) * smoothstep(0.55, 0.0, y);
            } else if (uLayer < 1.5) {
              // BODY — the saturated hue that carries the read
              c = uBody * (a * 1.30 + lick * 0.55);
            } else {
              // GLOW — wide, soft, low alpha, dying long before the tip
              float g = pow(max(0.0, 1.0 - length(vec2(p.x * 1.05, (y - 0.20) * 0.72))), 2.4);
              c = uGlow * g * 0.62;
            }
            gl_FragColor = vec4(c * uAlpha, 1.0);
          }`;
      const flameLayer = (layer, core, body, glow, width, alpha) => new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uSeed: { value: 0 },
          uCore: { value: new THREE.Color(core) },
          uBody: { value: new THREE.Color(body) },
          uGlow: { value: new THREE.Color(glow) },
          uLayer: { value: layer }, uWidth: { value: width }, uAlpha: { value: alpha },
        },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: FLAME_FRAG,
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      });
      // §2 palette: near-white core, Lava-hot body, Lava-deep glow
      // The alphas are SCENE-REFERRED (toneMapped:false writes straight into the
      // HDR buffer), so they carry the same 2.42x the light rig does now that
      // grades.js no longer runs an exposure of 2.90. They are also the frame's
      // designated top value band (§1.1) and the only thing that should be
      // over the bloom threshold, so the core is pushed a further half stop.
      const flameMats = [
        flameLayer(2, '#fff0b0', '#ff8c1a', '#c22a06', 0.62, 1.05),   // glow, back
        flameLayer(1, '#fff0b0', '#ff8c1a', '#c22a06', 0.36, 4.60),   // body
        flameLayer(0, '#fff0b0', '#ffc24a', '#c22a06', 0.24, 6.20),   // core, front
      ];
      const flameMat = flameMats[1];
      this.flameMat = flameMat;
      this.flameMats = flameMats;
      this.flames = [];
      const flameGeos = [keep(new THREE.PlaneGeometry(2.55, 2.5)),
                         keep(new THREE.PlaneGeometry(1.45, 2.25)),
                         keep(new THREE.PlaneGeometry(0.95, 1.75))];
      warm.forEach((p, i) => {
        const y = Math.max(0.9, p.pos[1]) - 0.85;
        const grp = new THREE.Group();
        grp.name = 'brazier.flame.' + i;
        grp.position.set(p.pos[0], y + 0.42, p.pos[2]);
        for (let L = 0; L < 3; L++) {
          const fl = new THREE.Mesh(flameGeos[L], flameMats[L]);
          // each layer sits on its own plane depth so the core is never
          // occluded by the glow, and each has its own vertical anchor
          fl.position.set(0, flameGeos[L].parameters.height * 0.5 + (L === 0 ? 0.10 : 0.16), L * 0.012);
          fl.renderOrder = 6 + L;
          grp.add(fl);
        }
        grp.userData.seed = i * 1.7 + 0.31;
        this.root.add(grp);
        this.flames.push(grp);
      });
    }
    // The cool practicals become crystal glyph shards — the accent hue. Any
    // that fall inside the doorway belong to the gate slab instead, and if that
    // leaves none we never ask for the crystal material at all (a texture set
    // nobody can see is ~0.3s of synthesis for nothing).
    const visibleCool = cool.filter((p) => {
      const ang = Math.atan2(p.pos[2], p.pos[0]);
      return Math.abs(((ang - gateA + Math.PI * 3) % (Math.PI * 2)) - Math.PI) >= gateHalf + 10 * DEG;
    });
    if (visibleCool.length) {
      const shardGeo = keep(faceted(new THREE.OctahedronGeometry(0.85, 1)));
      // §5: flat facets sharing one emissive read as purple origami. Give each
      // facet its own value from facet-normal-dot-key (a hard 3-band ramp, no
      // blending across the arris) plus a Hecate-teal fresnel so the facets
      // separate from one another instead of fusing into a flat plane.
      const crystalMat = M(kit.accent, { tint: '#57c8f0' });
      this.crystalMat = null;                       // owned by the library, not us
      const keyD = new THREE.Vector3().fromArray(kdir).normalize();
      if (crystalMat.userData && crystalMat.userData.paint) {
        const prev = crystalMat.onBeforeCompile;
        crystalMat.onBeforeCompile = (sh, rend) => {
          if (prev) { try { prev(sh, rend); } catch (e) { /* peer patches */ } }
          sh.uniforms.uCrKey = { value: keyD };
          sh.uniforms.uCrEdge = { value: new THREE.Color('#8ef0d0') };
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', `#include <common>
              uniform vec3 uCrKey; uniform vec3 uCrEdge;`)
            .replace('#include <opaque_fragment>', `
              {
                vec3 cn = normalize( inverseTransformDirection( normal, viewMatrix ) );
                float kd = dot( cn, -uCrKey );
                // HARD three-band facet ramp: 0.25 / 0.55 / 0.95, no soft falloff
                float band = kd < 0.05 ? 0.25 : ( kd < 0.46 ? 0.55 : 0.95 );
                outgoingLight *= band * 1.35;
                vec3 cv = normalize( cameraPosition - vPaintWPos );
                float fr = pow( clamp( 1.0 - abs( dot( cn, cv ) ), 0.0, 1.0 ), 2.2 );
                outgoingLight += uCrEdge * fr * 1.45;   // scene-referred: carries the 2.42x
              }
              #include <opaque_fragment>`);
        };
        crystalMat.customProgramCacheKey = () => 'crystal.facet';
        crystalMat.needsUpdate = true;
      }
      const shards = new THREE.InstancedMesh(shardGeo, crystalMat, visibleCool.length);
      shards.name = 'glyph.shard';
      shards.castShadow = true;
      visibleCool.forEach((p, i) => {
        const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, f() * Math.PI, 0.14));
        shards.setMatrixAt(i, m4.compose(pos.set(p.pos[0], Math.max(1.2, p.pos[1]), p.pos[2]), yaw, scl.set(0.8, 1.5, 0.8)));
      });
      shards.instanceMatrix.needsUpdate = true;
      this.root.add(shards);
    }

    // ── floor dressing ────────────────────────────────────────────────────
    // Four AUTHORED masses (fluted drum, amphora, two broken blocks), ten
    // instances total, each snapped so its lowest vertex sits 0.02 below the
    // floor plane and each spun to its own yaw so no two share a silhouette.
    // They cluster against the wall base and the column feet — evenly scattered
    // debris is just another isotropic-noise tell.
    {
      // §7: a 0.6m broken block wearing 3m wall features is a decal. Its own
      // recipe, authored at prop scale, plus a second slot for the fresh
      // fracture face so a break reads as newly exposed stone.
      const propMat = M('rubble.tartarus');
      const freshMat = M('rubble.tartarus', { tint: '#c3a094' });
      const kinds = [
        { geo: keep(columnDrum(f, { r: 0.54, h: 1.22 })), n: 3, s: [0.92, 1.20], mat: propMat },
        { geo: keep(columnDrum(f, { r: 0.44, h: 0.86, flutes: 8, depth: 0.10 })), n: 2, s: [0.85, 1.05], mat: propMat },
        { geo: keep(amphora(f)), n: 2, s: [0.80, 1.05], mat: propMat },
        // a freshly sheared block is NEWLY exposed stone: it must not be as
        // weathered as the wall it fell out of
        { geo: keep(rubbleChunk(f, { w: 0.68, h: 0.44, d: 0.56 })), n: 3, s: [0.70, 1.35], mat: freshMat },
      ];
      // anchors: the foot of a column, or the wall base — never mid-floor
      const anchors = [];
      for (const a of colAngles) anchors.push({ a, r: colR - 0.95 - f() * 0.7 });
      for (let i = 0; i < 6; i++) {
        const a = A0 + (A1 - A0) * ((i + 0.5) / 6) + (f() - 0.5) * 0.16;
        anchors.push({ a, r: R - 1.9 - f() * 1.5 });
      }
      let ai = Math.floor(f() * anchors.length);
      for (const kind of kinds) {
        const im = new THREE.InstancedMesh(kind.geo, kind.mat || propMat, kind.n);
        im.name = 'prop.debris';
        im.castShadow = true; im.receiveShadow = true;
        const bbMin = (kind.geo.boundingBox && kind.geo.boundingBox.min.y) || 0;
        for (let i = 0; i < kind.n; i++) {
          ai = (ai + 3 + Math.floor(f() * 3)) % anchors.length;
          const an = anchors[ai];
          const jitter = (f() - 0.5) * 0.9;
          const aa = an.a + jitter * 0.06;
          const rr = an.r + jitter;
          const sc = kind.s[0] + f() * (kind.s[1] - kind.s[0]);
          const yaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f() * Math.PI * 2, 0));
          // snap: lowest vertex 0.02 UNDER the floor, so nothing floats and
          // nothing intersects at an impossible angle
          const y = -bbMin * sc - 0.02;
          im.setMatrixAt(i, m4.compose(pos.set(Math.cos(aa) * rr, y, Math.sin(aa) * rr), yaw, scl.set(sc, sc, sc)));
        }
        im.instanceMatrix.needsUpdate = true;
        this.root.add(im);
      }
    }

    // ── void shards: broken masonry falling away from the island ──────────
    const SHARDS = 30;
    const shardGeo = keep(faceted(new THREE.IcosahedronGeometry(1, 0)));
    const voidIM = new THREE.InstancedMesh(shardGeo, M(kit.rock, { tint: '#241238' }), SHARDS);
    voidIM.name = 'void.shards';
    for (let i = 0; i < SHARDS; i++) {
      const a = f() * Math.PI * 2;
      const rad = R + 3.5 + f() * 16;
      const y = -1.5 - f() * 9;
      const s = 0.5 + f() * 2.1;
      const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(f() * 3, f() * 3, f() * 3));
      voidIM.setMatrixAt(i, m4.compose(pos.set(Math.cos(a) * rad, y, Math.sin(a) * rad), qq, scl.set(s, s * (0.5 + f() * 0.7), s)));
    }
    voidIM.instanceMatrix.needsUpdate = true;
    this.root.add(voidIM);

    this.colliders = [{ kind: 'circle', r: R, x: 0, z: 0, inside: true }];
  }

  // ─────────────────────────────────────────────────────────────── biome ──
  setBiome(name, ctx = this.ctx) {
    if (!KIT[name] || name === this.biome) return this;
    this.biome = name;
    // Announce FIRST: the light rig retunes itself, hands the new rim constant
    // and the new prefiltered sky to the material system, and re-authors its
    // practicals — all of which build() then reads while placing the chamber.
    ctx?.events?.emit?.('biome.changed', { name });
    this.clear();
    this.build(ctx);
    return this;
  }

  clear() {
    for (const c of this.root.children.slice()) this.root.remove(c);
    for (const g of this._geo) g.dispose?.();
    this._geo.length = 0;
    this.doorMat?.dispose?.();
    if (this.flameMats) for (const m of this.flameMats) m.dispose?.();
    else this.flameMat?.dispose?.();
    this.crystalMat?.dispose?.();
    this.gate = null; this.coals = null;
    this.flames = null; this.doorMat = null; this.flameMat = null;
    this.flameMats = null; this.crystalMat = null; this.statues = null;
  }

  // ───────────────────────────────────────────────────────── world query ──
  clampToArena(v3, radius = 0.4) {
    const r = this.bounds.r - radius;
    const d = Math.hypot(v3.x, v3.z);
    if (d > r) { const k = r / d; v3.x *= k; v3.z *= k; }
    return v3;
  }
  heightAt() { return 0; }

  update(dt, ctx) {
    const t = (ctx && ctx.time && ctx.time.t) || 0;
    if (this.doorMat) this.doorMat.uniforms.uTime.value = t;
    if (this.flameMats) for (const m of this.flameMats) m.uniforms.uTime.value = t;
    else if (this.flameMat) this.flameMat.uniforms.uTime.value = t;
  }

  /** Y-axis billboard the flames — cheap, and they never shear on the ground plane. */
  lateUpdate(alpha, ctx) {
    if (!this.flames || !ctx || !ctx.camera) return;
    const c = ctx.camera.position;
    for (const f of this.flames) f.rotation.y = Math.atan2(c.x - f.position.x, c.z - f.position.z);
    if (this.statues) for (const st of this.statues) st.visible = true;
  }
  dispose() { this.clear(); }
}
