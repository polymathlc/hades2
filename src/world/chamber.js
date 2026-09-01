// OWNER: AGENT-WORLD
// ---------------------------------------------------------------------------
// THE CHAMBER — arena generation, architecture assembly, collision, void.
//
// THE COMPOSITION THIS FILE EXISTS TO PRODUCE (ART_DIRECTION §1.8 / §9):
//
//      ┌─ sky / haze ────────────────────────────────────────┐  value band 3
//      │   ▓▓▓ upper storey, arcade, crowning cornice ▓▓▓    │  value band 2
//      │   ▒▒ colonnade, statues, banners, braziers ▒▒       │  <- lit EDGES
//      │      · · · · dark stage floor · · · ·               │  value band 1
//      └────── abyss ───────────────────────────────────────┘  ink
//
// The floor is the DARKEST large surface in the frame. Every highlight is on an
// arris: a capital, a cornice lip, a brazier rim, a gold inlay, a door sigil.
// The arena is an ISLAND: past the parapet there is nothing but a fall.
//
// Room shape is a RADIAL PROFILE R(theta) sampled at 256 angles. Every archetype
// in biomes.js is star-shaped about the origin, which makes the profile enough
// to drive the floor mesh, the swept rim mouldings, the skirt, the scatter mask
// AND collision — one representation, no duplication, and clampToArena stays a
// two-line lookup.
//
// CONTRACT (other systems depend on these — extend, never rename):
//   world.bounds.r                     max arena radius
//   world.center                       THREE.Vector3
//   world.biome / world.archetype
//   world.clampToArena(v3, radius)     -> v3, clamped inside the boundary
//   world.heightAt(x, z)               -> floor height (dais aware)
//   world.collide(pos, radius)         -> pos, pushed out of solids + boundary
//   world.raycastWalk(from, to, r)     -> {hit, t, point, normal}
//   world.build(biome, archetype, seed)
//   world.setBiome(name, ctx)
//   world.doors                        -> Doors (getChoices/onEnter/promptAnchor)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Kit, Parts, Batcher, lathe, faceted, mergeGeos, meanderPeriod, meanderRail, eggAndDartUnit,
         beadAndReelUnit, columnDrumGeo, rubbleChunkGeo, brokenCapitalGeo, taperedTube, catenary,
         Field, TAU, DEG } from './kit.js';
import { BIOMES, ARCHETYPES, ARCHETYPE_IDS, getBiome, getArchetype, DEFAULT_BIOME } from './biomes.js';
import { Doors } from './doors.js';
import { Props } from './props.js';
import { FrameScheduler } from '../core/scheduler.js';
import { profiler } from '../core/profiler.js';

const NA = 256;                    // profile angular resolution

// FACING CONVENTION. Rotating by -a + PI/2 about Y maps local +Z to (cos a,
// sin a) — i.e. RADIALLY OUTWARD, away from the arena. Almost everything in a
// chamber has a front (a statue's face, a fluted pilaster, a sconce's bowl, a
// door's sigil) and that front must look INWARD. Getting this backwards is
// invisible in code review and glaring in a screenshot, so it is named.
const faceIn = (a) => -a - Math.PI / 2;    // local +Z looks at the arena centre

// The art-directed rim direction for EVERYTHING in the chamber. See _M() below
// for the derivation; entities/rig.js carries the matching constant for the
// character. Screen-right at the §8 camera (yaw 45 / pitch 50), wN.y low enough
// that painterly.js's ground-plane veto stays open on a standing form.
const ENV_RIM_DIR = [0.68, 0.28, -0.68];
const faceOut = (a) => -a + Math.PI / 2;   // local +Z looks away into the void
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => { const u = clamp01((x - a) / (b - a || 1)); return u * u * (3 - 2 * u); };
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * A colour, renormalised so its LUMINANCE is 1. This is the single most
 * important helper in the glaze: a vertex colour multiplies albedo, so painting
 * with a raw palette colour (whose linear components are all well under 1)
 * silently multiplies the ground plane by ~0.15 and the floor disappears into
 * the void. Split the decision in two — `v` carries VALUE, the tint carries
 * HUE ONLY — and the painted structure becomes readable and tunable.
 */
function hueOf(c) {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return l > 1e-4 ? [c.r / l, c.g / l, c.b / l] : [1, 1, 1];
}

// cheap deterministic value noise for the floor mottle
function h2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h2(xi, yi), h2(xi + 1, yi), u), lerp(h2(xi, yi + 1), h2(xi + 1, yi + 1), u), v);
}

// ===========================================================================
// SHAPES — every archetype's plan, as a radial profile
// ===========================================================================
function buildProfile(arch, f) {
  const P = new Float32Array(NA);
  const R = arch.radius;
  const asp = arch.aspect ?? 1;
  const phase = f() * TAU;
  for (let i = 0; i < NA; i++) {
    const a = (i / NA) * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    let r = R;
    switch (arch.shape) {
      case 'oblong': {
        const A = R, B = R * asp;
        r = (A * B) / Math.sqrt((B * ca) * (B * ca) + (A * sa) * (A * sa));
        break;
      }
      case 'cruciform': {
        const armL = R, armW = R * 0.44;
        const rect = (hx, hz) => Math.min(
          Math.abs(ca) > 1e-4 ? hx / Math.abs(ca) : 1e6,
          Math.abs(sa) > 1e-4 ? hz / Math.abs(sa) : 1e6);
        r = Math.max(rect(armL, armW), rect(armW, armL));
        break;
      }
      case 'rounded-square': {
        const n = 4.6;
        r = R / Math.pow(Math.pow(Math.abs(ca), n) + Math.pow(Math.abs(sa), n), 1 / n);
        break;
      }
      case 'causeway': {
        // two round platforms joined by a bridge — the classic Hades causeway
        const half = R * 0.30, bridgeW = R * 0.30, d = R * 0.66;
        const rect = Math.min(
          Math.abs(ca) > 1e-4 ? (d + half) / Math.abs(ca) : 1e6,
          Math.abs(sa) > 1e-4 ? bridgeW / Math.abs(sa) : 1e6);
        let best = rect;
        for (const sgn of [-1, 1]) {
          const cx = sgn * d, cz = 0;
          const b = cx * ca + cz * sa;
          const c = cx * cx + cz * cz - half * half * 3.2;
          const disc = b * b - c;
          if (disc > 0) best = Math.max(best, b + Math.sqrt(disc));
        }
        r = best;
        break;
      }
      case 'lobed': {
        r = R * (1 + 0.11 * Math.sin(a * 3 + phase) + 0.055 * Math.sin(a * 7 - phase * 1.7));
        break;
      }
      default: r = R;
    }
    // Every arena edge is BROKEN stone, never a drawn circle: a low-amplitude
    // irregularity plus a few deliberate bites out of the near rim.
    r *= 1 + 0.020 * Math.sin(a * 5 + phase * 2.1) + 0.013 * Math.sin(a * 11 - phase);
    P[i] = Math.max(3.0, r);
  }
  // one smoothing pass so the collision normal never spikes
  const S = new Float32Array(NA);
  for (let i = 0; i < NA; i++) S[i] = (P[(i - 1 + NA) % NA] + 2 * P[i] + P[(i + 1) % NA]) * 0.25;
  return S;
}

// ===========================================================================
// SWEEP — a cross-section run around (part of) the arena boundary.
// This is how the curb, the skirt, the parapet rail and the abyss funnel are
// built: one mesh each, following ANY room shape.
// ===========================================================================
function sweep(profile, section, opts = {}) {
  const a0 = opts.a0 ?? 0, a1 = opts.a1 ?? TAU;
  const closed = opts.closed ?? (Math.abs(a1 - a0 - TAU) < 1e-6);
  const steps = opts.steps ?? Math.max(24, Math.round(NA * Math.abs(a1 - a0) / TAU));
  const M = section.length;
  const nSeg = closed ? steps : steps + 1;
  const P = new Float32Array(nSeg * M * 3);
  const U = new Float32Array(nSeg * M * 2);
  const C = opts.shade ? new Float32Array(nSeg * M * 3) : null;
  const idx = [];
  const rAt = (a) => {
    const t = ((a % TAU) + TAU) % TAU / TAU * NA;
    const i0 = Math.floor(t) % NA, i1 = (i0 + 1) % NA, ft = t - Math.floor(t);
    return profile[i0] * (1 - ft) + profile[i1] * ft;
  };
  for (let s = 0; s < nSeg; s++) {
    const a = a0 + (a1 - a0) * (closed ? s / steps : s / steps);
    const r0 = rAt(a) * (opts.radiusScale ?? 1) + (opts.radiusOffset ?? 0);
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let m = 0; m < M; m++) {
      const [dr, dy] = section[m];
      const rr = r0 + dr;
      const w = (s * M + m);
      P[w * 3] = ca * rr; P[w * 3 + 1] = dy; P[w * 3 + 2] = sa * rr;
      U[w * 2] = (a - a0) * r0 * 0.22; U[w * 2 + 1] = m / (M - 1);
      if (C) { const c = opts.shade(ca * rr, sa * rr, m / (M - 1), a); C[w * 3] = c[0]; C[w * 3 + 1] = c[1]; C[w * 3 + 2] = c[2]; }
    }
  }
  for (let s = 0; s < (closed ? steps : steps); s++) {
    const s1 = closed ? (s + 1) % steps : s + 1;
    for (let m = 0; m < M - 1; m++) {
      const a = s * M + m, b = s1 * M + m;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  if (C) g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(idx);
  // A moulding is CARVED: it has to read by its facets. Smooth-shading a swept
  // section averages the normals across every step in the profile and the whole
  // run turns into one soft tube — which is exactly what a rim moulding must
  // never look like.
  if (opts.flat) {
    const nonIdx = g.toNonIndexed();
    nonIdx.computeVertexNormals();
    nonIdx.computeBoundingBox();
    nonIdx.computeBoundingSphere();
    g.dispose();
    return nonIdx;
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ===========================================================================
// FLOOR — a radial mesh following the profile, carrying the painted glaze
// ===========================================================================
function radialFloor(profile, rings, shade, opts = {}) {
  const seg = opts.seg ?? 128;
  const nv = 1 + rings * seg;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
  const U = new Float32Array(nv * 2), C = new Float32Array(nv * 3);
  const idx = [];
  let w = 0;
  const rAt = (a) => {
    const t = ((a % TAU) + TAU) % TAU / TAU * NA;
    const i0 = Math.floor(t) % NA, i1 = (i0 + 1) % NA, ft = t - Math.floor(t);
    return profile[i0] * (1 - ft) + profile[i1] * ft;
  };
  // UV mode. A world-scaled unwrap is right for a floor whose material is
  // triplanar/world-projected; an emblem whose texture is authored as a polar
  // rosette across 0..1 needs a disc-local unwrap or it samples a corner of
  // its own artwork.
  const uvR = opts.uvRadius || 0;
  const put = (x, z, t) => {
    P[w * 3] = x; P[w * 3 + 1] = 0; P[w * 3 + 2] = z;
    N[w * 3 + 1] = 1;
    if (uvR) { U[w * 2] = 0.5 + x / (2 * uvR); U[w * 2 + 1] = 0.5 + z / (2 * uvR); }
    else { U[w * 2] = x * 0.05; U[w * 2 + 1] = z * 0.05; }
    const c = shade(x, z, t);
    C[w * 3] = c[0]; C[w * 3 + 1] = c[1]; C[w * 3 + 2] = c[2];
    w++;
  };
  put(0, 0, 0);
  for (let k = 1; k <= rings; k++) {
    const tk = Math.pow(k / rings, 0.88);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      const r = rAt(a) * tk;
      put(Math.cos(a) * r, Math.sin(a) * r, tk);
    }
  }
  // WINDING. Authored in the XZ plane with +Y up, a fan that runs from +X
  // toward +Z is CLOCKWISE seen from above, so the naive order produces a
  // downward normal and the whole ground plane back-face culls away. Every
  // triangle below is wound the other way on purpose.
  for (let i = 0; i < seg; i++) idx.push(0, 1 + ((i + 1) % seg), 1 + i);
  for (let k = 0; k < rings - 1; k++) {
    const b0 = 1 + k * seg, b1 = 1 + (k + 1) * seg;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      idx.push(b0 + i, b1 + j, b1 + i, b0 + i, b0 + j, b1 + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ===========================================================================
export class World {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'world';
    this.colliders = [];
    this.bounds = { r: 17 };
    this.center = new THREE.Vector3(0, 0, 0);
    this.biome = DEFAULT_BIOME;
    this.archetype = 'rotunda';
    this.seed = 1;
    this.profile = new Float32Array(NA).fill(17);
    this.dais = null;
    this.doors = new Doors();
    this.props = new Props();
    this._geo = [];
    this._mats = [];
    this._built = false;
    // Chamber assembly is sliced across frames; see beginBuild().
    this.sched = new FrameScheduler({ budgetMs: 5 });
    this._task = null;
    this._clearedPending = false;
    // Adaptive: if the last few frames were already slow (a big fight, a
    // saturated particle pool) the build gives ground rather than piling on.
    this._buildBudgetMs = 5;
  }

  // ------------------------------------------------------------------ init
  async init(ctx) {
    this.ctx = ctx;
    this.rngRoot = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('world') : ctx.rng;
    ctx.scene.add(this.root);

    const q = (typeof location !== 'undefined') ? new URLSearchParams(location.search) : null;
    const wantB = (q && q.get('biome')) || (ctx.run && ctx.run.biome) || this.biome;
    const wantA = (q && q.get('room')) || null;
    this.build(BIOMES[wantB] ? wantB : DEFAULT_BIOME, wantA || 'rotunda', 1337);

    ctx.events?.on?.('capture.state', ({ name, args }) => {
      if (typeof name !== 'string') return;
      if (name.startsWith('biome:')) this.setBiome(name.slice(6), ctx);
      else if (name.startsWith('room:')) this.build(this.biome, name.slice(5), (args && args.seed) || this.seed);
      else if (name === 'cleared') this.setCleared(true);
    });
    ctx.events?.on?.('room.cleared', () => this.setCleared(true));
    // The capture harness never fights an enemy, so the shot sheet would only
    // ever see sealed, dark doors. Open them once the room has settled.
    if (ctx.CAPTURE || ctx.capture) this.setCleared(true);
  }

  // ----------------------------------------------------------------- build
  /**
   * build(biome, archetype, seed) — fully re-runnable. Disposes everything the
   * previous chamber owned first, so a room transition leaks nothing.
   *
   * Runs to completion in ONE call, which is what boot, the capture harness and
   * the Crossroads want. A live room transition does NOT want it: see
   * beginBuild() below, which is the same generator pumped across frames.
   */
  build(biomeName, archetypeName, seed, opts = {}) {
    const task = this.beginBuild(biomeName, archetypeName, seed);
    if (!task) return this;
    if (opts.sliced) return this;               // caller drives it (see update)
    task.finish();
    return this;
  }

  /**
   * beginBuild() — start a chamber and hand back a suspendable task.
   *
   * WHY: measured on this machine a chamber costs 70-275ms of pure geometry
   * synthesis, spread fairly evenly across its sections. Executed in one call
   * that is a guaranteed multi-frame freeze on the exact frame the player walks
   * through a door. Sliced into ~25 yield points it is a run of ~5-19ms steps,
   * pumped a few milliseconds per frame by lateUpdate(). `npm run test:perf`
   * measures both paths.
   *
   * The PLAN step (teardown, profile, door angles, archetype) runs
   * synchronously before we return, because the caller places the hero and
   * snaps the camera against `bounds` immediately afterwards and those numbers
   * have to be the NEW room's.
   */
  beginBuild(biomeName, archetypeName, seed) {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (this._task && !this._task.done) this._task.cancel();
    const task = this.sched.add(this._buildGen(biomeName, archetypeName, seed), {
      label: 'world.build',
      onStep: (t, name, ms) => profiler.section('world.build:' + (typeof name === 'string' ? name : 'final'), ms),
    });
    this._task = task;
    task.step();                                 // the plan step, synchronously
    return task;
  }

  /** True while a sliced chamber build is still assembling. */
  get building() { return !!(this._task && !this._task.done); }

  /** Finish any in-flight sliced build right now (capture / teardown paths). */
  flushBuild() { if (this._task && !this._task.done) this._task.finish(); return this; }

  *_buildGen(biomeName, archetypeName, seed) {
    const ctx = this.ctx;
    if (!ctx) return this;
    this.clear();
    // A fresh chamber is sealed until it is won. setCleared() may be called
    // while the sliced build is still assembling (the doors do not exist yet),
    // so the intent is recorded here and re-applied on the final step.
    this._clearedPending = false;

    this.biome = BIOMES[biomeName] ? biomeName : this.biome;
    const B = getBiome(this.biome);
    this.seed = seed ?? this.seed;

    const rng = (this.rngRoot && this.rngRoot.fork)
      ? this.rngRoot.fork('chamber:' + this.biome + ':' + this.seed)
      : this.rngRoot;
    this.rng = rng;
    const f = (rng && rng.f) ? () => rng.f() : () => 0.5;

    // archetype: authored choice, or a deterministic weighted draw
    let aName = archetypeName;
    if (!aName || !ARCHETYPES[aName]) {
      const ids = ARCHETYPE_IDS;
      let tot = 0; for (const id of ids) tot += ARCHETYPES[id].weight;
      let r = f() * tot; aName = ids[0];
      for (const id of ids) { r -= ARCHETYPES[id].weight; if (r <= 0) { aName = id; break; } }
    }
    this.archetype = aName;
    const A = getArchetype(aName);

    const kit = new Kit(ctx, B.mats, rng);
    // §9.5: architecture is lit on its EDGES. Large faces (shafts, wall beds,
    // voussoirs) give back some diffuse and take more specular, so the arrises,
    // fillets and mouldings are what carry the highlight band instead of the
    // broad planes between them.
    // EXPOSURE. The rig's key runs at 26.0 and AgX bleaches saturated colour as
    // it approaches the shoulder, so at litGain ~0.94 a #8c3b46 crimson wall, a
    // #f2c14e gold capital and a bone statue all arrive at the display as the
    // SAME pale salmon — the "monochrome mud" §9.6 names, and the reason
    // measured highlightTint sat on hue 20-26 across ten frames while §2 puts
    // gold at 43. Backing the architecture off the shoulder is the only lever
    // this file has on that; the real fix is render/lighting.js (see report).
    // The mid-ground still sits a full band above the ground plane (§9.4): the
    // floor's own litGain is 0.60 on top of a 0.62 albedo glaze.
    kit.roleOpts = {
      // THE COLONNADE IS THE ROOM'S IDENTITY and it was reading as Roman
      // coursed ashlar. The shaft geometry IS fluted (kit.flutedShaft, now at
      // R*0.235 over 16 flutes), but stone.tartarus.column tiles a 6-row ashlar
      // bed at triScale 0.42 / circScale 4.0 — that is ~13 horizontal courses
      // and 4 vertical joints on a 5.4m shaft, i.e. a brick grid laid straight
      // over the flutes, and the grid wins. A Greek column IS built of drums,
      // so the answer is not to delete the joints but to make them DRUM-sized:
      // ~4 courses and 1.6 wraps puts a joint every ~1.2m and lets the flute
      // arrises be the dominant vertical rhythm.
      // rimPower is raised because a cylinder shows a wide fresnel band from
      // every angle: at the environment default (1.6) the cool edge washed the
      // whole shaft blue instead of drawing its arris.
      // ── ROUND-2: THE DEPTH GRADIENT RAN BACKWARDS (§1.1, §9.4) ─────────────
      // Measured depthBands were top 0.381 / mid 0.153 / bottom 0.031 — the
      // BACKGROUND colonnade was the brightest, most saturated and most
      // detailed surface in every composition frame, which is §1.1 exactly
      // reversed. Round 1's "the floor is too bright" was not fixed, it was
      // relocated to the back wall. The architecture is mid-ground: it is a
      // FRAME around the subject, not the subject. Its diffuse comes down hard
      // and its specular stays up, so the arrises, fillets and mouldings keep
      // carrying the highlight band (§9.5) while the broad faces recede.
      // ── ROUND-4: THE PAINTED RAMP DOES NOT CAP ANYTHING ABOVE THE KEY ─────
      // painterly.js computes k = clamp( pLit / uKeyRef, 0, 1 ). Every surface
      // receiving MORE irradiance than the key reference pins k at 1, where
      // r = rampLevels.z = 1 and sc = 1 — the ramp becomes a pass-through and
      // the diffuse runs on uncapped. That is the entire mid-ground band of a
      // Hades frame: masonry, statuary and brazier bowls standing one to three
      // metres from a practical, i.e. permanently over the key. Two measured
      // consequences, and they are the SAME defect:
      //   §14 subject test — the focal statue's 40px block sat at 0.859 display
      //     against a hero at 0.611. The props were out-valuing the protagonist
      //     by 1.4x and no amount of hero exposure closes that (the hero hits
      //     the same shoulder: x1.55/x2.2/x3.0 litGain measured 0.732/0.767/
      //     0.790, i.e. it stops paying).
      //   The relief shot — the wall field between the meander and the
      //     egg-and-dart measured p50 0.641 / p95 0.714, a 0.07 spread across
      //     400px, which the critic correctly called a dead flat salmon plane.
      //     Its painted variation IS in the albedo; the exposure was compressing
      //     it into the top of the AgX shoulder where nothing separates.
      // The only lever this file has is the diffuse gain, so the architecture
      // comes down until it sits in the transform's linear-ish midrange, where
      // the texture reads AND the hero out-values it. Specular stays where it
      // is: §9.5 puts the highlight band on the arrises, not the faces.
      // Verified in place against the live page, not through the build.
      column: { litGain: 0.40, ambGain: 0.56, specGain: 1.80, rimDir: ENV_RIM_DIR, rimStrength: 1.25,
                rimPower: 2.7, triScale: 0.155, circScale: 1.6 },
      wall:   { litGain: 0.34, ambGain: 0.50, specGain: 0.70, rimDir: ENV_RIM_DIR, rimStrength: 1.15 },
      bay:    { litGain: 0.32, ambGain: 0.46, specGain: 0.70, rimDir: ENV_RIM_DIR, rimStrength: 1.15 },
      arch:   { litGain: 0.44, ambGain: 0.50, specGain: 1.40, rimDir: ENV_RIM_DIR, rimStrength: 1.30 },
      // THE BRAZIER BOWL WAS NEVER GAINED AT ALL. Every other role here carries
      // an explicit litGain; `metal` did not, so bronze.verdigris ran at the
      // painterly default of 1.0 — three times the wall — on the one object in
      // the room that always stands INSIDE its own practical. That is why the
      // bowls read as pale blobs along the top edge of the money shot and why
      // dimming the statue alone never moved the frame's top block.
      metal:  { litGain: 0.34, ambGain: 0.46, specGain: 1.25, rimDir: ENV_RIM_DIR, rimStrength: 1.30 },
      // ...and neither was the CLOTH. A banner is a 2x4.6m flat plane hanging in
      // the upper band of every play framing, and it was running at 1.0/1.0 —
      // measured as the single brightest background block in the money shot
      // (0.744 display) once the statue was capped, i.e. a piece of drapery was
      // out-valuing the protagonist. Crimson silk lit by firelight is deep and
      // saturated, not a lantern.
      cloth:  { litGain: 0.30, ambGain: 0.42, specGain: 0.55, rimDir: ENV_RIM_DIR, rimStrength: 1.10 },
      iron:   { litGain: 0.34, ambGain: 0.44, specGain: 1.05, rimDir: ENV_RIM_DIR, rimStrength: 1.20 },
      // GOLD LIVES OR DIES ON SATURATION. §2 puts the gold core at #f2c14e
      // (hue 43); measured highlightTint across ten frames was hue 20-26 at
      // sat 0.87, i.e. salmon-white. Gold pushed past AgX's shoulder is not
      // gold any more, it is a bleached highlight — so the diffuse comes DOWN
      // and the sharp specular lobe (§4 "a small, bright, sharp glint") comes
      // up. A darker, saturated leaf with a hot arris reads more like metal
      // than a bright flat one ever does.
      // §2 calls gold "the ornament spine of the whole game" and §9.5 puts the
      // highlight band on it. Measured at 3x, the meander, dentils and fillets
      // were the SAME value as the wall carrying them, so they vanished at 1x.
      // Now that the stone has dropped a full band the leaf keeps its diffuse
      // and gets a much hotter sharp lobe: gold reads as gold-on-dark at any
      // zoom, which is the single most Hades-like thing this kit can do.
      leaf:   { specGain: 3.10, litGain: 0.60, ambGain: 0.62, rimDir: ENV_RIM_DIR, rimStrength: 1.30 },
    };
    this.kit = kit;

    // ---- plan ------------------------------------------------------------
    this.profile = buildProfile(A, f);
    let maxR = 0, minR = 1e9;
    for (let i = 0; i < NA; i++) { maxR = Math.max(maxR, this.profile[i]); minR = Math.min(minR, this.profile[i]); }
    this.bounds.r = maxR;
    this.bounds.rMin = minR;
    this.dais = A.dais ? { ...A.dais } : null;

    // Doors live in the FAR arc so they are always in the upper half of the
    // 45deg camera — the band §9 wants carrying the highlight, never behind us.
    const nDoors = A.doors ?? 3;
    const doorAngles = [];
    const spanA = 150 * DEG, spanB = 300 * DEG;
    for (let i = 0; i < nDoors; i++) {
      const t = nDoors === 1 ? 0.5 : i / (nDoors - 1);
      doorAngles.push(spanA + (spanB - spanA) * t + (f() - 0.5) * 8 * DEG);
    }
    this.doorAngles = doorAngles;

    // The plan's skeleton, resolved before any geometry is built so every
    // section agrees on it: where the back wall runs, which bays it leaves
    // between the doorways, and which of those bays is the room's focal axis.
    // (An earlier version derived the focal angle twice, in two different ways,
    // and the floor's light pool ended up 37 degrees from the thing it lit.)
    const WA = [128 * DEG, 322 * DEG];
    const marks = [WA[0] + 6 * DEG, ...doorAngles.slice().sort((p, q) => p - q), WA[1] - 6 * DEG];
    const bays = [];
    for (let i = 0; i < marks.length - 1; i++) {
      const w = marks[i + 1] - marks[i];
      if (w > 16 * DEG) bays.push({ a: (marks[i] + marks[i + 1]) * 0.5, w });
    }
    bays.sort((p, q) => q.w - p.w);
    this.wallArc = WA;
    this.focalAngle = bays.length ? bays[0].a : Math.PI * 1.25;

    // ---- assemble --------------------------------------------------------
    const G = {};                    // shared build state between sections
    G.A = A; G.B = B; G.kit = kit; G.f = f; G.rng = rng;
    G.wallArc = WA; G.bays = bays; G.focalAngle = this.focalAngle;
    G.keepOut = [];
    G.flamePoints = [];
    G.slots = [];

    // ── the assembly steps ────────────────────────────────────────────────
    // Each `yield` is a legal suspension point: the chamber is renderable (if
    // incomplete) at every one of them, so a sliced build reads as the room
    // assembling itself over ~15 frames instead of as a hard stall. The four
    // most expensive sections (void, floor, back wall, colonnade) are
    // generators of their own so they can suspend mid-section.
    yield 'plan';
    yield* this._buildVoid(ctx, G);
    yield* this._buildFloor(ctx, G);
    this._buildRim(ctx, G);         yield 'rim';
    yield* this._buildBackWall(ctx, G);
    yield* this._buildColonnade(ctx, G);
    this._buildFocal(ctx, G);       yield 'focal';
    this._buildBraziers(ctx, G);    yield 'braziers';
    this._buildHangings(ctx, G);    yield 'hangings';
    this._buildDoors(ctx, G);       yield 'doors';
    this._buildScatter(ctx, G);
    this._finishColliders(ctx, G);

    this.root.add(this.props.root);
    this.root.add(this.doors.root);
    yield 'scatter';

    // flames + their pooled practicals, and the void ember field
    if (G.flamePoints.length) {
      this.props.flameField(ctx, G.flamePoints, {
        core: '#fff0b0', body: B.id === 'elysium' ? '#ffcf6a' : '#ff8c1a', glow: '#c22a06',
        scale: 1.0,
      });
    }
    yield 'flames';
    // Water weeping out of the vault and falling through the chamber. It is
    // the only genuinely COOL moving element in a room full of fire, and it
    // occupies the upper band of the frame where §9.6 wants the complement.
    this.props.emberField(ctx, {
      // §9.6 needs the complement at frame scale and this is the only COOL
      // moving element in a room lit entirely by fire. Measured whole-frame
      // cyan on the gameplay framing was 5.8% against the 8% floor, so the
      // fall is doubled in count and pulled in over the play space rather than
      // hugging the wall.
      rng, count: 72, name: 'vault.drips', streak: true,
      color: B.accent, accent: B.accent, rise: false,
      rIn: maxR * 0.30, rOut: maxR * 0.96, yBase: (G.wallTop || 13) - 1.2, spread: 3.0, span: 12,
    });
    yield 'drips';
    this.props.emberField(ctx, {
      rng, count: Math.round(B.ember.count * (ctx.quality?.render?.motes ? 1 : 0.5)),
      color: B.ember.color, accent: B.ember.accent, rise: B.ember.rise,
      // OVER THE VOID, which is what this field is for: at rIn 0.55R more than
      // half the population spawned UNDER the arena plate, where it can only
      // ever be depth-rejected or leak through a seam in the floor as a
      // stripe of warm dots. Starting outside the rim also stops the ember
      // haze from competing with the play space for the eye.
      rIn: maxR * 1.12, rOut: maxR * 2.2, yBase: -1.0, spread: 13, span: 18,
    });
    this.props.ctx = ctx;
    yield 'embers';

    this._built = true;
    // The doors were rebuilt by this pass, so re-apply whatever seal state the
    // run asked for while they did not exist yet.
    this.doors.setSealed(!this._clearedPending, !!(ctx.CAPTURE || ctx.capture));
    ctx.events?.emit?.('room.built', { biome: this.biome, archetype: this.archetype, seed: this.seed });
    ctx.lighting?.fitShadows?.(ctx);
    return this;
  }

  // =========================================================================
  // VOID — the island framing (§1.8). Built FIRST so everything else sits on it.
  // =========================================================================
  *_buildVoid(ctx, G) {
    const { kit, B, f } = G;
    const R = this.bounds.r;

    // ---- the abyss floor: a huge, near-ink plate far below --------------
    // From the 52deg camera this fills everything beyond the arena rim, which
    // is what turns a floating plate into an island in a void. It carries its
    // own radial gradient so it is not a flat fill (§7).
    const voidC = hueOf(new THREE.Color(B.voidColor));
    const rimC = hueOf(new THREE.Color(B.voidRim));
    const lava = B.voidKind === 'lava';
    const abyssGeo = this._keep(radialFloor(new Float32Array(NA).fill(170), 14, (x, z, t) => {
      // brighter directly under the island (light spills over the rim), dying
      // to true ink at the horizon
      // The abyss must be DARK but never a hole: at zero it reads as a bug in
      // the frame rather than as depth. 0.05-0.13 display luma is a floor you
      // can just make out the shape of, which is what sells the fall.
      const d = Math.hypot(x, z);
      const k = Math.exp(-Math.max(0, d - R * 0.7) / (R * 1.7));
      const n = vnoise(x * 0.035, z * 0.035) * 0.5 + vnoise(x * 0.09, z * 0.09) * 0.28
        + vnoise(x * 0.22, z * 0.22) * 0.16;
      // §11.1: the abyss is the far band and it must be the DARKEST thing in
      // the frame — but the quarter of it that survives the haze is the only
      // gradient the void has, so the falloff under the island is authored
      // steeper rather than flatter. Dark, and still painted.
      const v = (lava ? 0.13 : 0.052) + k * (lava ? 0.62 : 0.090);
      const m = (0.70 + 0.60 * n);
      const hk = clamp01(k * 1.4);
      return [
        v * m * lerp(voidC[0], rimC[0], hk),
        v * m * lerp(voidC[1], rimC[1], hk),
        v * m * lerp(voidC[2], rimC[2], hk),
      ];
    }, { seg: 72 }));
    const abyssMat = this._M(B.voidKind === 'lava' ? B.mats.ember : B.mats.rock, {
      vertexColors: true, litGain: B.voidKind === 'lava' ? 0.5 : 0.22, ambGain: 0.30, specGain: 0.05,
      triplanar: true, triScale: 0.02, rimStrength: 0.0,
      emissiveIntensity: B.voidKind === 'lava' ? 0.55 : 0,
    });
    const abyss = new THREE.Mesh(abyssGeo, abyssMat);
    abyss.name = 'void.abyss';
    abyss.position.y = B.voidKind === 'lava' ? -22 : -34;
    abyss.receiveShadow = false;
    abyss.frustumCulled = false;
    this.root.add(abyss);

    yield 'void.abyss';

    // ---- the island's underside: a mass falling into the dark ------------
    const skirtShade = (x, z, t) => {
      // dark at the top (contact ink under the curb), a touch of bounce in the
      // middle, ink again as it falls away
      const v = (0.085 + 0.26 * Math.exp(-Math.pow((t - 0.30) * 3.0, 2))) * (1 - 0.55 * t);
      const n = 0.78 + 0.52 * vnoise(x * 0.22, z * 0.22);
      return [v * n * 1.10, v * n * 0.90, v * n * 1.34];
    };
    const skirt = new THREE.Mesh(this._keep(sweep(this.profile, [
      [0.35, 0.02], [0.25, -0.55], [-0.10, -1.6], [-0.55, -3.4],
      [-1.5, -6.2], [-3.2, -9.6], [-5.6, -13.0],
    ], { shade: skirtShade })), this._M(B.mats.rock, {
      vertexColors: true, litGain: 0.55, ambGain: 0.45, specGain: 0.1, triplanar: true, triScale: 0.055,
    }));
    skirt.name = 'void.skirt';
    skirt.castShadow = false; skirt.receiveShadow = true;
    this.root.add(skirt);

    yield 'void.underside';

    // ---- broken masonry adrift around the island -------------------------
    const S = B.shards;
    const shardGeos = [0, 1, 2].map((v) => this._keep(kit.rubbleGeo('chunk', 40 + v, { w: 2.2, h: 1.5, d: 1.9 })));
    const shardMat = this._M(B.mats.rock, { tint: '#1d1226', litGain: 0.22, ambGain: 0.30, specGain: 0.10, variation: 0.3, rimStrength: 0.22 });
    const im = kit.instancer(shardGeos[0], shardMat, S.count, { name: 'void.shards', recv: false });
    const im2 = kit.instancer(shardGeos[1], shardMat, S.count, { name: 'void.shards', recv: false });
    const im3 = kit.instancer(shardGeos[2], shardMat, S.count, { name: 'void.shards', recv: false });
    const ims = [im, im2, im3];
    for (let i = 0; i < S.count; i++) {
      const a = f() * TAU;
      const rr = R + S.spread[0] + f() * (S.spread[1] - S.spread[0]);
      const y = -S.drop[0] - f() * (S.drop[1] - S.drop[0]);
      const s = 0.5 + f() * 1.7;
      ims[i % 3].userData.push(Math.cos(a) * rr, y, Math.sin(a) * rr, f() * TAU, [s, s * (0.4 + f() * 0.8), s], f() * 3, f() * 3);
    }
    for (const m of ims) if (m.count) { m.userData.finish(); this.root.add(m); }
  }

  // =========================================================================
  // FLOOR — the dark stage (§9.1)
  // =========================================================================
  *_buildFloor(ctx, G) {
    const { B, A, kit, f } = G;
    const R = this.bounds.r;
    const gz = B.floorGlaze;
    const warmC = hueOf(new THREE.Color(gz.warm));
    const coolC = hueOf(new THREE.Color(gz.cool));

    // The brazier ring is decided here so the glaze can paint the light pools
    // exactly where the practicals will stand.
    // The hearth now stands beyond the playable rim. Combat ground must remain
    // completely clear: enemies cannot path around a decorative bowl if they
    // are already pressed against the arena boundary.
    const hearthA = this.focalAngle;
    const hearthR = this.radiusAt(hearthA) + 1.8;
    G.hearth = { x: Math.cos(hearthA) * hearthR, z: Math.sin(hearthA) * hearthR };

    const pools = this._brazierAnchors(G);
    // the hanging bowl over the arena — see _buildHangings. Its pool is wide
    // and gentle: it models the play space without lighting it like a stage.
    const fa0 = G.focalAngle;
    G.pools = pools;
    const glazePools = pools.concat([
      { x: Math.cos(fa0) * R * 0.26, z: Math.sin(fa0) * R * 0.26, rad: R * 0.44 },
      { x: G.hearth.x, z: G.hearth.z, rad: R * 0.32 },
    ]);

    const shade = (x, z, t) => {
      // ── §9.1 THE FLOOR IS A DARK STAGE ────────────────────────────────
      // base is unlit stone. It is deliberately NOT near-zero: a black hole in
      // the middle of the arena is not a stage, it is a pit, and the review
      // that produced that frame called it exactly that. The number that
      // matters is the RATIO to the architecture, not the absolute darkness.
      let v = gz.base;
      // warm pools under the braziers
      let warm = 0;
      for (const p of glazePools) {
        const d = Math.hypot(x - p.x, z - p.z);
        warm += Math.pow(Math.max(0, 1 - d / (p.rad || 6.2)), 2.0);
      }
      warm = Math.min(1.25, warm);
      v = lerp(v, gz.pool, Math.min(1, warm));
      // the skirt of the island falls away into the rim ink
      v *= 1 - gz.rimFall * sstep(0.62, 1.0, t);
      // ── COMPOSED DEPTH (§1.1 three value bands, §9.4 measurable) ────────
      // §8 pins the camera yaw at 45deg and it never rotates in play, so +X+Z
      // is always the NEAR half of the arena and -X-Z is always the far half.
      // The near half is the frame's foreground repoussoir and falls away; the
      // far half carries the brazier arc and the lit wall behind it. This is a
      // painted composition decision, not a view-dependent cheat — but if the
      // camera ever gains yaw it has to be re-derived.
      const dep = clamp01(0.5 + 0.5 * ((x + z) * 0.70711 / (R + 1.5)));
      // ── THE STAGE IS AN ISLAND OF LIGHT (§1.8), NOT A RAMP ────────────────
      // A monotonic near-bright / far-dark glaze cannot give the frame three
      // separated value bands: it puts the brightest floor in the bottom third,
      // which is exactly where §1.8 wants a dark repoussoir, and it collapses
      // the measured depth spread (0.101-0.179 against the 0.18 §9.4 demands).
      // A HUMP does what a stage-lighting designer does instead — the play
      // space in the middle distance is the lit island, the near apron falls
      // away into the frame's dark foreground, and the far half recedes toward
      // the ink ramp. The character stands just inside the lit island, so the
      // subject still has a stage under their feet and a contact shadow on it.
      // ── ROUND-3 (relief pass): the hump was SYMMETRIC, so the near apron
      // and the far apron fell away at the same rate and the frame's bottom
      // third measured 0.088 against a top third of 0.204 — a 0.116 spread
      // against §9.4's 0.18 floor. A stage-lighting designer does not light
      // the front of the stage and the back of it identically: the near apron
      // is the audience's side of the proscenium and it is DARK. The hump is
      // now pushed a little past centre and its near flank is twice as steep
      // as its far flank, so the foreground drops into the ink ramp while the
      // island itself and the far arc keep every scrap of value they had.
      const isle = dep < 0.54
        ? 1 - (0.54 - dep) / 0.24
        : 1 - (dep - 0.54) / 0.42;
      v *= 0.10 + 1.80 * sstep(0.0, 1.0, clamp01(isle));
      // and an explicit repoussoir crush on the nearest apron, where the frame
      // wants a dark shape to look past rather than readable masonry (§1.8)
      v *= 1 - 0.72 * sstep(0.58, 1.0, dep) * sstep(0.34, 0.98, t);
      // hand-glazed mottle so the ground plane is never one unmodulated slab
      const n = vnoise(x * 0.11, z * 0.11) * 0.62 + vnoise(x * 0.31, z * 0.31) * 0.26 + vnoise(x * 0.9, z * 0.9) * 0.12;
      v *= 0.86 + 0.30 * n;
      // §9.6 TWO HUES FROM THE GROUND UP: lit stone drifts to the biome warm,
      // unlit stone drifts to the complement, so the floor itself carries the
      // opposition instead of relying on a fill light.
      const lit = clamp01(warm * 1.1);
      // hue only — `v` above is the entire value decision
      // ROUND-2: 0.55 left the unlit floor sitting in the ambient's own plum,
      // so the ground plane carried no opposition at all and every frame
      // measured as one salmon hue over one violet one (§9.6's named failure).
      // hueOf() normalises to luminance, so pushing this changes HUE ONLY —
      // the value structure the law cares about is untouched.
      const k = 0.88;                              // how far the hue is pushed
      const r = v * lerp(1 + (coolC[0] - 1) * k, 1 + (warmC[0] - 1) * k, lit);
      const g = v * lerp(1 + (coolC[1] - 1) * k, 1 + (warmC[1] - 1) * k, lit);
      const b = v * lerp(1 + (coolC[2] - 1) * k, 1 + (warmC[2] - 1) * k, lit);
      return [r, g, b];
    };

    // A single incident-light response cannot serve ink-dark Tartarus and
    // naturally pale Elysium marble.  The ivory map already contributes far
    // more value; giving it the same 1.02/1.35 gains as crimson stone drives
    // the whole stage into the display shoulder and erases its brushwork.
    // This costs nothing at runtime (the material already exists) and keeps
    // the adjustment attached to the surface instead of dimming actors or FX.
    const floorResponse = B.id === 'elysium'
      ? { litGain: 0.23, ambGain: 0.31, specGain: 0.06 }
      : { litGain: 1.02, ambGain: 1.35, specGain: 0.26 };
    const floorMat = this._M(B.mats.floor, {
      vertexColors: true,
      // §9.1 asks for the floor to keep a small share of the KEY (so the stage
      // never out-values the actors) — but this chamber is an interior lit by
      // fire, and most of the ground plane sits in the architecture's shadow
      // where the key contributes nothing at all. Cutting lit and RAISING amb
      // is the split that gives a dark, readable stone floor instead of a hole:
      // the sunlit strips stay under the architecture, the shadowed ones stay
      // above zero and keep their masonry.
      // ── ROUND-2 ────────────────────────────────────────────────────────
      // ambGain 1.85 was the number that made this a vinyl sheet: a hemisphere
      // is a uniform wash, and at 1.85x it out-ran the key everywhere, so the
      // whole ground plane arrived as one smooth violet gradient with soft
      // cloud mottle and no direction in it at all. Meanwhile the measured
      // floor local median under the hero was 0.003 — round 1's "the floor is
      // too bright" had been answered by deleting the floor, and with no floor
      // value there is no contact shadow, no scale cue and no stage.
      // Key UP, wash DOWN: same average value, but now it is modelled — lit
      // strips where the braziers rake, ink where the architecture shadows.
      // AMBIENT IS WHAT MAKES A DARK FLOOR READABLE. The braziers are all on
      // the far arc and the key is blocked by the colonnade, so the NEAR apron
      // — the bottom third of every gameplay frame — receives essentially no
      // direct light at all: it measured 0.028 display, i.e. a hole. Lifting
      // the indirect share (which is uniform, and therefore cannot create a
      // hot spot) puts the ashlar back without touching the lit pools, and
      // groundLuma still lands ~0.10 against §9.1's 0.18 ceiling.
      ...floorResponse,
      // §1.4 "painted texture": floor.tartarus authors an 11x8 ashlar bond with
      // real seam ink, chipping, ichor stains and bone dust — and then projects
      // it at triScale 0.035, i.e. ONE 28.6m period across a 25m arena. Every
      // plate came out ~3m across and 36px/m, which is why the dedicated tiling
      // shot passed for the wrong reason: there was nothing there to repeat.
      // 0.072 = a 13.9m period, so a plate is ~1.3m and the joints, bevels and
      // per-stone tone all exist at play distance. The stochastic de-tiler in
      // painterly.js is already on for this projection and holds the lattice.
      // 0.072 (a 13.9m period) put the ashlar back at a readable world size but
      // the dedicated floor test then measured a 146px periodic peak at 0.62
      // against §7's ban on visible floor repetition. 0.050 = a 20m period,
      // still ~1.8m plates, and the macro layer is pushed hard enough to put
      // a low-frequency value drift across whole GROUPS of stones, which is
      // what actually decorrelates the joint lattice the metric samples.
      // ROUND-3. 0.050 was a 20m period over an 11x8 bond: plates 1.8m x 2.5m,
      // i.e. still too big to read as a laid stone, which is what the review
      // called the most damaging finding in the build. The plate now carries a
      // 16-course IRREGULAR bond (materials/recipes.js flagBond), so the SAME
      // projection scale yields a 1.12m course and a 0.9-1.5m stone. 0.056
      // trims the period to 17.9m to bring the stone size onto the mark; the
      // repeat is answered by the bond's irregularity and the macro drift, not
      // by hiding the stones.
      triScale: 0.056, macroStrength: 0.38,
      rimStrength: 0.06,
    });
    const floor = new THREE.Mesh(this._keep(radialFloor(this.profile, 26, shade, { seg: 144 })), floorMat);
    floor.name = 'floor';
    floor.receiveShadow = true;
    this.root.add(floor);
    yield 'floor.plate';

    // ---- the central inlay -----------------------------------------------
    // A rosette, but a DARK one. The previous chamber put a high-chroma, high-
    // value bullseye directly under the player: inverted hierarchy, and the
    // character had nothing to read against. Here the emblem is a shadow in the
    // stone with only its raised gold rails catching the key.
    // A PERFECT disc of perfectly periodic ornament is two problems at once:
    // it reads as a decal rather than as inlay, and a regular polar fret is a
    // genuine periodic signal on the ground plane (§7 bans visible repetition
    // on floors and tools/analyze.mjs measures it). This emblem is BROKEN: an
    // irregular edge where the stone has spalled away, and gold rails that are
    // arcs with pieces missing rather than closed rings.
    // Off-centre on purpose. A concentric emblem under the player's feet is a
    // bullseye: it makes the character the centre of a target rather than the
    // subject of a composition, and a perfectly regular polar fret centred in
    // frame is also the strongest periodic signal a floor can carry (§7).
    const MEDR = Math.min(4.8, R * 0.30);
    // Off-axis, but only just: far enough that the player is not standing in
    // the dead centre of a target, close enough that the emblem is still the
    // arena's centrepiece and the middle of the room is not empty.
    // ROUND-3: 0.115R put the emblem's centre essentially under the hero's
    // default mark, so the burst was a halo AROUND the character. 0.21R clears
    // it — the emblem is still the centrepiece of the room, but the hero now
    // stands BESIDE it and reads against plain stone.
    const medOff = new THREE.Vector2(Math.cos(G.focalAngle) * R * 0.21, Math.sin(G.focalAngle) * R * 0.21);
    const medProfile = new Float32Array(NA);
    const mph = f() * TAU;
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * TAU;
      let r = MEDR * (1 + 0.045 * Math.sin(a * 3 + mph) + 0.028 * Math.sin(a * 7 - mph * 1.7));
      // three bites out of the edge
      for (let k = 0; k < 3; k++) {
        const ba = mph * 1.7 + k * 2.31;
        const d = Math.abs(((a - ba + Math.PI * 3) % TAU) - Math.PI);
        r -= MEDR * 0.16 * Math.exp(-(d * 3.4) * (d * 3.4));
      }
      medProfile[i] = r;
    }
    // ANGULAR WEAR. The emblem's edge is already irregular, but its FRET is a
    // perfectly concentric band, and a concentric band sampled along any
    // horizontal scanline gives two mirror-image bright crossings — a genuine
    // periodic signal in the middle of the play space (tools/analyze.mjs
    // measured a 435px "period" that is exactly the left/right ring spacing,
    // and §7 bans visible repetition on floors). Burning a few soot wedges
    // through it kills the mirror AND is what a fire-lit floor in a ruin should
    // look like: worn where the traffic and the flame have been.
    // ROUND-2 CORRECTION. The wedges above were authored at up to 0.68 depth
    // over an angular support as narrow as 0.30rad, which on an already-dark
    // medallion drove a quarter of the emblem to near-zero across a near-hard
    // boundary: at gameplay distance it read as a HOLE punched through the
    // floor, cutting the outer meander ring in half. That is ornament degraded
    // to move a metric, which §10.3 forbids by name — the 435px "period" the
    // wedges existed to kill was a closed concentric ring, i.e. correct Greek
    // ornament, and the metric was the thing that was wrong. Soot is now wide
    // and shallow: it reads as soot.
    const wedges = [];
    for (let i = 0; i < 4; i++) wedges.push([f() * TAU, 0.85 + f() * 0.70, 0.10 + f() * 0.14]);
    const med = new THREE.Mesh(
      this._keep(radialFloor(medProfile, 6, (x, z) => {
        const n = vnoise(x * 0.5, z * 0.5) * 0.6 + vnoise(x * 1.4, z * 1.4) * 0.3;
        let g2 = 0.80 + 0.42 * n;
        const a2 = Math.atan2(z, x);
        for (const [wa, ww, wd] of wedges) {
          const d = Math.abs(((a2 - wa + Math.PI * 3) % TAU) - Math.PI) / ww;
          g2 *= 1 - wd * Math.exp(-d * d);
        }
        return [g2 * 1.02, g2 * 0.96, g2 * 1.10];
      }, { seg: 96, uvRadius: MEDR })),
      this._M(B.mats.medallion, {
        // The emblem is DARK INLAY with gold rails standing proud of it — that
        // is what the comment above says was intended and it is not what
        // shipped: at 0.72/0.62 the field was a flat mid plate and the rails
        // had nothing to stand out from.
        vertexColors: true, tint: '#7a606c',
        litGain: 0.56, ambGain: 0.44, specGain: 0.28, rimStrength: 0.05,
      }));
    med.name = 'floor.medallion';
    med.position.set(medOff.x, 0.014, medOff.y);
    med.receiveShadow = true;
    this.root.add(med);

    // §9.5 wants the ornament to carry light — but a rail this close to the
    // player must stay a LINE, never a lit plate, so it is hammered leaf with
    // no emissive, catching only a specular streak.
    // ROUND-2: with the emblem field cut to 0.40/0.30 the rails are the only
    // thing on it allowed to reach a value, and §2 wants them GOLD (#f2c14e),
    // not the same salmon as everything else. A hot sharp lobe on a saturated
    // tint is what makes metal read as metal (§4).
    // GOLD MUST READ AS GOLD (§2 "the ornament spine of the whole game").
    // Diffuse gold under a #ff7048 key is ORANGE by construction: the key's own
    // hue multiplies the albedo, so every rail measured at hue 20 while §2 puts
    // gold at 43. gold.leaf ships an authored emissive ramp (near-white core ->
    // #ffe9a8 -> #c98f2b) and an emissive is NOT multiplied by the key, so a
    // small amount of it is the only thing that can carry the hue home. Kept
    // low: this is a lit edge, not a lamp.
    const leaf = this._M(B.mats.leaf, { emissiveIntensity: 0.20, tint: '#f2c14e', litGain: 0.36, ambGain: 0.34, specGain: 2.40 });
    {
      // two shared arc geometries, placed by rotation — eight broken rails for
      // two draw calls instead of eight
      const ib = new Batcher(this.root);
      const im4 = new THREE.Matrix4(), iq = new THREE.Quaternion(), ione = new THREE.Vector3(1, 1, 1);
      // MEDR*0.99 / MEDR*0.44 are the emblem's own rails; the wide one at
      // 0.66R is the arena's orbit — the ring that gives the empty middle
      // distance of the floor something to describe its size with, exactly the
      // way a Hades arena is banded. All broken, none closed.
      // FLAT inlay, not a tube. A torus lying on the floor is a polished rod:
      // under a grazing key it catches a single fat specular line and the ring
      // reads as a comet trail scratched across the stone. A flat band with a
      // tiny proud lip reads as metal set INTO the floor, which is what it is.
      for (const [rad, thick, nSeg] of [[MEDR * 0.99, 0.075, 5], [MEDR * 0.44, 0.050, 3],
                                        [R * 0.665, 0.105, 6]]) {
        const span = (TAU / nSeg) * 0.70;
        const g2 = kit.geo(`inlay:${rad.toFixed(3)}:${nSeg}`, () => {
          const seg = Math.max(12, Math.round(span * 34));
          const ring = new THREE.RingGeometry(rad - thick, rad + thick, seg, 1, 0, span);
          const lip = new THREE.RingGeometry(rad - thick * 0.32, rad + thick * 0.32, seg, 1, 0, span);
          lip.translate(0, 0, 0.014);
          return mergeGeos([ring, lip]);
        });
        // The R*0.665 orbit is a hoop drawn AROUND the play space and it runs
        // straight through the foreground apron the value law needs dark, so it
        // is set down a stop from the emblem's own rails.
        // §1.1 wants the FOREGROUND high-value / high-chroma. The orbit rail is
        // the one piece of drawn ornament that crosses the near apron, so it is
        // the cheapest legitimate way to put a bright, saturated, hand-placed
        // note in the bottom band without lighting the floor itself.
        const railMat = rad > R * 0.5
          ? this._M(B.mats.leaf, { emissiveIntensity: 0.14, tint: '#f2c14e', litGain: 0.32, ambGain: 0.30, specGain: 2.10 })
          : leaf;
        let a = f() * TAU;
        for (let k = 0; k < nSeg; k++) {
          // default XYZ order applies Z first: spin the ring in its own plane,
          // THEN lay it flat. 'ZYX' would tip the flat ring out of horizontal.
          iq.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -a));
          im4.compose(new THREE.Vector3(rad < R * 0.5 ? medOff.x : 0, 0.030, rad < R * 0.5 ? medOff.y : 0), iq, ione);
          ib.add(g2, railMat, im4, { name: 'floor.inlay', cast: false });
          a += TAU / nSeg + (f() - 0.5) * 0.12;
        }
      }
      ib.build();
    }

    yield 'floor.inlay';

    // ---- THE OUTER MEANDER BAND (§9.7 / §1.5) ------------------------------
    // The play framing measured the LEAST detailed shot in the package
    // (detailDensity 0.024-0.027 against 0.048 at close range): everything
    // drawn on the ground plane lived inside r < 0.30R, so the outer two thirds
    // of the arena was a smooth violet gradient with soft blobs on it — exactly
    // the "huge soft purple blobs across the floor" §9.7 bans. A real Greek key
    // laid into the outer floor gives that annulus drawn ornament, a directional
    // arris for the brazier pools to rake across, and a second concentric
    // reading of the room's size. It is REAL geometry (the same meanderPeriod
    // the cornices use) so it carves and catches light instead of decalling.
    {
      const bandR = R * 0.775;
      const bh = 0.62;                                    // pattern height
      const per = kit.geo(`floor.meander:${bh.toFixed(2)}`, () => {
        const g2 = meanderPeriod(bh, 0.16);
        g2.rotateX(-Math.PI / 2);                          // lay the fret flat
        return g2;
      });
      const rail = kit.geo(`floor.meanderRail:${bh.toFixed(2)}`, () => {
        const g2 = meanderRail(bh, (TAU * bandR) / 96 + 0.03, 0.16);
        g2.rotateX(-Math.PI / 2);
        return g2;
      });
      // hammered leaf, no emissive: at this radius the band runs through the
      // near apron the value law needs dark, so it is allowed a specular arris
      // and nothing else.
      const bandMat = this._M(B.mats.leaf, {
        emissiveIntensity: 0.14, vertexColors: true, tint: '#d9b552',
        litGain: 0.26, ambGain: 0.22, specGain: 2.30,
      });
      const stoneMat = this._M(B.mats.bay, { litGain: 0.36, ambGain: 0.58, variation: 0.20 });
      const N = Math.max(24, Math.round((TAU * bandR) / (bh * 1.06)));
      // A CLOSED ring of perfectly periodic fret is the one thing §7 bans on a
      // floor, so the band is broken into four runs with worn gaps between
      // them and each run starts on a different phase.
      const runs = [[0.06, 0.30], [0.34, 0.28], [0.66, 0.14], [0.83, 0.13]];
      const fret = kit.instancer(per, bandMat, N + 8, { name: 'floor.meander', cast: false });
      const bed = kit.instancer(rail, stoneMat, N + 8, { name: 'floor.meander.bed', cast: false });
      for (const [t0, tl] of runs) {
        const i0 = Math.floor(t0 * N), i1 = Math.floor((t0 + tl) * N);
        for (let i = i0; i < i1; i++) {
          const a = (i / N) * TAU;
          const rr = bandR * (1 + 0.006 * Math.sin(a * 5.0 + 1.3));
          fret.userData.push(Math.cos(a) * rr, 0.030, Math.sin(a) * rr, faceIn(a), 1);
          bed.userData.push(Math.cos(a) * (rr + bh * 0.60), 0.020, Math.sin(a) * (rr + bh * 0.60), faceIn(a), 1);
        }
      }
      if (fret.count) { fret.userData.finish(); this.root.add(fret); }
      if (bed.count) { bed.userData.finish(); this.root.add(bed); }
    }

    yield 'floor.meander';

    // ---- COLD SIGILS IN THE PLAY AREA (§9.6 two hues, §9.3 highlight band) --
    // Measured cyan occupancy across the whole shot sheet was 3.8-6.5% against
    // §9.6's 8% floor, and every cool source in the room was on the FAR
    // perimeter where the vignette eats it: ten frames of salmon-on-plum with
    // no cool note anywhere a player actually stands. §9.3 also asks for the
    // highlight band to come from "emissives (flame, lava, GLYPHS)" and never
    // from a lit floor — a small saturated glyph burning in the dark stage does
    // both jobs at once and costs the ground plane no value at all.
    {
      const accent = B.accent || '#5fd0ff';
      const sigil = kit.geo('floor.sigil', () => {
        const p2 = new Parts();
        // an eight-point star of thin bars set into the stone, with a lozenge
        // eye — a drawn shape, not a glowing disc (§5 silhouette first)
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * TAU;
          const L = i % 2 ? 0.30 : 0.52;
          p2.add(new THREE.BoxGeometry(L, 0.030, 0.055),
            { p: [Math.cos(a) * (0.16 + L * 0.5), 0, Math.sin(a) * (0.16 + L * 0.5)], r: [0, -a, 0] });
        }
        p2.add(new THREE.OctahedronGeometry(0.135, 0), { p: [0, 0.045, 0], s: [1, 0.55, 1] });
        p2.add(new THREE.TorusGeometry(0.175, 0.028, 5, 18), { p: [0, 0.012, 0], r: [Math.PI / 2, 0, 0] });
        return faceted(p2.merge());
      });
      const sigilMat = this._M(B.mats.crystal, {
        // 2.1 clipped every sigil to a white core: eight white starbursts
        // scattered across the play floor out-read the protagonist and looked
        // like pickups, not architecture (§1.5 bans uniformly spammed ornament,
        // §9.2 says the hero is the brightest thing in the play area). At 0.62
        // they stay SATURATED cyan instead of blowing to white.
        tint: accent, emissive: accent, emissiveIntensity: 0.62,
        litGain: 0.30, ambGain: 0.35, specGain: 1.5, rimStrength: 0.9, rimColor: accent,
      });
      // a stubby crystal cluster: the same accent standing UP, so the cool note
      // also appears on a silhouette rather than only flat on the floor
      const shard = kit.geo('floor.shard', () => {
        const p2 = new Parts();
        p2.add(new THREE.OctahedronGeometry(0.34, 0), { p: [0, 0.30, 0], s: [0.46, 1.55, 0.46], r: [0.10, 0.4, 0.06] });
        p2.add(new THREE.OctahedronGeometry(0.21, 0), { p: [0.19, 0.17, 0.07], s: [0.46, 1.25, 0.46], r: [0.24, 1.1, 0.30] });
        p2.add(new THREE.OctahedronGeometry(0.16, 0), { p: [-0.17, 0.13, -0.09], s: [0.48, 1.15, 0.48], r: [-0.20, 2.0, -0.28] });
        return faceted(p2.merge());
      });
      const NS2 = 7;
      const sIM = kit.instancer(sigil, sigilMat, NS2, { name: 'floor.sigil', cast: false, recv: false });
      const cIM = kit.instancer(shard, sigilMat, NS2, { name: 'floor.shard', cast: false, recv: false });
      for (let i = 0; i < NS2; i++) {
        // golden-angle spacing so nothing lines up with the brazier arc or with
        // the meander runs, and two radii so the accent reads at two depths
        // Pushed OUT to the apron between the meander runs. A cool note in the
        // near-dark ring is what §9.6 is actually asking for; the same glyph at
        // r 0.4R sat under the player's feet and turned the play space into a
        // field of markers.
        const a = i * 2.39996 + 0.7;
        const rr = R * (i % 2 ? 0.70 : 0.87) * (0.97 + 0.06 * Math.sin(i * 1.7));
        const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
        if (!this.insideXZ(x, z, 1.4)) continue;
        sIM.userData.push(x, this.heightAt(x, z) + 0.035, z, a * 0.7, 0.74 + 0.20 * Math.sin(i * 2.3));
        if (i % 2 === 0) {
          const sa = a + 0.30, sr = rr - 2.6;
          const sx = Math.cos(sa) * sr, sz = Math.sin(sa) * sr;
          if (this.insideXZ(sx, sz, 1.0)) cIM.userData.push(sx, this.heightAt(sx, sz), sz, sa, 0.85 + 0.3 * Math.sin(i));
        }
      }
      if (sIM.count) { sIM.userData.finish(); this.root.add(sIM); }
      if (cIM.count) { cIM.userData.finish(); this.root.add(cIM); }
    }

    // A raised bronze BOSS at the emblem's centre. §9.5 says ornament carries
    // the light: this is the one place on the ground plane that is allowed a
    // real specular hit, and it is what stops a floor close-up from being a
    // frame with no top value band at all.
    {
      // an OMPHALOS: the navel stone at the middle of the chamber. Wide and
      // LOW — a bronze disc you walk over, not an obstacle you walk round, and
      // emphatically not a pale boulder sitting where the hero stands. It is
      // built in TWO materials on purpose: a dark bronze dome (so it never
      // out-values the character, §9.2) set in a burst of gold rays (so the
      // ground plane still gets the one genuine specular hit §9.5 asks for).
      const br = MEDR * 0.27;
      const domeGeo = kit.geo(`floor.boss:${MEDR.toFixed(2)}`, () => lathe(
        [[br * 1.24, 0.0], [br * 1.30, 0.05], [br * 1.22, 0.09],
         [br * 0.98, 0.11], [br * 0.72, 0.17], [br * 0.36, 0.22], [br * 0.14, 0.24], [0.02, 0.25]]
          .map(([r2, y2]) => [r2, y2 * MEDR * 0.17]), 30));
      const rayGeo = kit.geo(`floor.rays:${MEDR.toFixed(2)}`, () => {
        // §9.2, COMPOSITION NOT PHOTOMETRY. Fourteen equal rays around a
        // CLOSED torus is a sunburst, and a sunburst sits behind the hero's
        // default mark as a bigger, more regular, higher-contrast shape than
        // the hero himself — a squinted thumbnail finds the ring first every
        // time. Photometric fixes (dimming it) do not help, because what the
        // eye locks onto is the SHAPE: a complete bright annulus reads as a
        // halo around whatever stands in it.
        // So the ring is BROKEN and the burst is made irregular. Three arcs
        // with real gaps, rays of three different lengths with two of them
        // missing entirely, and the whole burst turned off-axis so it never
        // frames the character concentrically. It still reads as ruined gold
        // ornament at the middle of the room; it no longer reads as a target.
        const p = new Parts();
        const RN = 14;
        for (let i = 0; i < RN; i++) {
          if (i === 3 || i === 4 || i === 10) continue;       // gaps in the burst
          const a = (i / RN) * TAU + 0.21;
          const L = br * (i % 3 === 0 ? 1.30 : i % 3 === 1 ? 0.86 : 1.06);
          p.add(new THREE.BoxGeometry(L, MEDR * 0.022, br * 0.155),
            { p: [Math.cos(a) * (br * 1.30 + L * 0.5), MEDR * 0.012, Math.sin(a) * (br * 1.30 + L * 0.5)], r: [0, -a, 0] });
        }
        // a broken rail, not a closed ring: three arcs of unequal span
        const arcs = [[0.10, 1.62], [1.95, 2.35], [3.55, 2.05]];
        for (const [a0, span] of arcs) {
          // Euler XYZ applies Z first, so the Z term rotates the arc's START
          // within the torus's own plane before it is laid flat by the X term.
          p.add(new THREE.TorusGeometry(br * 1.30, MEDR * 0.020, 6, 26, span),
            { p: [0, MEDR * 0.014, 0], r: [Math.PI / 2, 0, a0] });
        }
        return p.merge();
      });
      const dome = new THREE.Mesh(domeGeo, this._M(B.mats.metal, {
        tint: '#5f4322', specGain: 2.0, litGain: 0.60, ambGain: 0.7,
      }));
      dome.name = 'floor.boss';
      dome.position.set(medOff.x, 0.02, medOff.y);
      dome.castShadow = true; dome.receiveShadow = true;
      this.root.add(dome);
      // NO emissive. An emissive gold ray glows over its whole area, which is
      // what tools/analyze.mjs measures as "large regions of the ground still
      // blazing"; a purely SPECULAR ray puts the same energy into a few pixels
      // on its arris, which is what §9.5 actually asks for.
      // §9.2 the HERO is the brightest large-ish shape in the play area. The
      // omphalos burst sits at the middle of every gameplay frame and it was
      // matching the character's own top values (measured p95 0.737 vs 0.701) —
      // the one piece of floor ornament allowed to compete with the subject.
      // Set down so the ground plane's specular hit stays a hit, not a rival.
      // and set down again: with the ring broken the burst no longer needs to
      // be a value rival to stay legible as ornament (§9.5 lights EDGES).
      // ROUND-4: the burst is BEHIND the hero's default mark in every gameplay
      // frame. It is already broken and off-axis (see rayGeo), but it was still
      // matching the character's own top values; a sunburst at the subject's
      // value is a halo whatever its shape. Set a full band under the hero.
      const rays = new THREE.Mesh(rayGeo, this._M(B.mats.leaf, { emissiveIntensity: 0.0, specGain: 0.78, litGain: 0.28, ambGain: 0.34 }));
      rays.name = 'floor.boss.rays';
      rays.position.set(medOff.x, 0.02, medOff.y);
      rays.receiveShadow = true;
      this.root.add(rays);
    }

    // Broken slabs lying across the emblem. They finish the "ruined inlay"
    // read, and they are what stops the fret from being an unbroken periodic
    // band across the middle of every frame.
    {
      const sb = new Batcher(this.root);
      const sm4 = new THREE.Matrix4(), sq = new THREE.Quaternion();
      // These spall slabs sit dead centre of the emblem, i.e. dead centre of
      // every gameplay frame. At litGain 0.82 the rubble albedo read as a
      // BROWN CARPET laid over the ornament — the brightest non-ornament patch
      // on the ground plane, and (being a dense fibrous texture) the only real
      // periodic signal tools/analyze.mjs could find on the floor. They are
      // broken stone in shadow; light them like it.
      const slabMat = this._M(B.mats.rubble, { variation: 0.26, litGain: 0.66, ambGain: 0.50 });
      // ROUND-2: these were 1.9-3.0m slabs dropped anywhere from 0.45R to
      // 1.05R of a 3.8m emblem — between them they blacked out a QUARTER of the
      // medallion and cut the outer fret in half, which is what read at
      // gameplay distance as a hole in the floor. Smaller, fewer, kept off the
      // fret, and lit enough to read as fallen stone rather than as absence.
      for (let i = 0; i < 3; i++) {
        const g2 = kit.rubbleGeo('slab', 70 + i, { w: 0.85 + f() * 0.55, d: 0.62 + f() * 0.44, t: 0.14 });
        const a = f() * TAU, rr = MEDR * (0.78 + f() * 0.34);
        sq.setFromEuler(new THREE.Euler((f() - 0.5) * 0.12, f() * TAU, (f() - 0.5) * 0.12));
        sm4.compose(new THREE.Vector3(medOff.x + Math.cos(a) * rr, 0.055, medOff.y + Math.sin(a) * rr),
          sq, new THREE.Vector3(1, 1, 1));
        sb.add(g2, slabMat, sm4, { name: 'floor.spall' });
      }
      sb.build();
    }

    yield 'floor.sigils';

    // ---- raised dais -----------------------------------------------------
    if (this.dais) {
      const d = this.dais;
      const cx = d.at ? d.at[0] : 0, cz = d.at ? d.at[1] : 0;
      d.x = cx; d.z = cz;
      const steps = d.steps ?? 3;
      const p = new Parts();
      for (let i = 0; i < steps; i++) {
        const rr = d.r + (steps - i) * 0.52;
        const hh = d.h * ((i + 1) / steps);
        p.add(lathe([[rr, 0], [rr, hh], [rr - 0.52, hh]], 48), { p: [0, 0, 0] });
      }
      p.add(new THREE.CircleGeometry(d.r, 48), { p: [0, d.h + 0.002, 0], r: [-Math.PI / 2, 0, 0] });
      const dm = new THREE.Mesh(this._keep(faceted(p.merge())),
        this._M(B.mats.dais, { litGain: 0.85, ambGain: 0.6, rimStrength: 0.18 }));
      dm.name = 'floor.dais';
      dm.position.set(cx, 0, cz);
      dm.castShadow = true; dm.receiveShadow = true;
      this.root.add(dm);
      G.keepOut.push({ x: cx, z: cz, r: d.r + steps * 0.52 + 0.4 });
    }
  }

  // =========================================================================
  // RIM — curb, parapet, broken edge, hanging chains
  // =========================================================================
  _buildRim(ctx, G) {
    const { B, A, kit, f } = G;
    const R = this.bounds.r;
    // The rim runs right across the bottom of every gameplay frame. At full
    // rig gain the curb + coping became the brightest continuous shape in the
    // shot — a lit hoop drawn around the play space, which is the opposite of
    // what a foreground repoussoir is for. It keeps its lit top arris and gives
    // back diffuse.
    // The rim runs across the bottom of every gameplay frame — the one piece of
    // built architecture in the FOREGROUND band §1.1 wants at high value. Its
    // indirect share is lifted so the curb, the coping and the parapet read as
    // a described edge instead of dissolving into the apron.
    const stone = this._M(B.mats.rim || B.mats.wall, { variation: 0.22, litGain: 0.60, ambGain: 0.95, specGain: 1.30 });

    // ---- the curb: a moulded stone edge all the way round ----------------
    // This is the island's LIT TOP EDGE. Without it the floor stops at a razor
    // line and the arena reads as a decal instead of a terrace (§9.5).
    const curb = new THREE.Mesh(this._keep(sweep(this.profile, [
      [-0.72, 0.02], [-0.72, 0.20], [-0.50, 0.24], [-0.50, 0.40],
      [-0.16, 0.44], [0.06, 0.40], [0.10, 0.22], [0.16, 0.04], [0.18, -0.40],
    ], { flat: true })), stone);
    curb.name = 'rim.curb';
    curb.castShadow = true; curb.receiveShadow = true;
    this.root.add(curb);

    // a gold fillet running the very lip — the thinnest, brightest line in the
    // composition, and the thing that draws the island's shape from above
    const fillet = new THREE.Mesh(this._keep(sweep(this.profile, [
      [-0.26, 0.442], [-0.19, 0.478], [-0.08, 0.455],
    ], { a0: 122 * DEG, a1: 328 * DEG, closed: false, flat: true })),
      this._M(B.mats.leaf, { emissiveIntensity: 0.0 }));
    fillet.name = 'rim.fillet';
    fillet.castShadow = false; fillet.receiveShadow = true;
    this.root.add(fillet);

    // ---- parapet on the NEAR arc ------------------------------------------
    // The near arc is what the 45deg camera puts across the bottom of frame.
    // A balustrade there gives the foreground an ornate, mid-value repoussoir
    // instead of an empty band of floor.
    const nearA0 = 318 * DEG, nearA1 = 502 * DEG;    // through 0 / 360
    const parapetH = 1.25;
    // Balusters and copings are placed by hand along the PROFILE rather than by
    // kit.parapet's arc helper, so the rim follows whatever shape the room is.
    const balGeo = kit.geo(`baluster:${parapetH.toFixed(2)}`, () => lathe([
      [0.19, 0.00], [0.21, 0.05], [0.15, 0.10], [0.13, 0.16],
      [0.20, 0.26], [0.24, 0.38], [0.21, 0.50], [0.14, 0.60],
      [0.10, 0.68], [0.14, 0.76], [0.13, 0.84], [0.17, 0.92], [0.16, 1.00],
    ].map(([r, y]) => [r * parapetH * 0.62, y * parapetH * 0.78 + parapetH * 0.11]), 14));

    const rAt = (a) => this.radiusAt(a);
    const balN = Math.round((nearA1 - nearA0) * R / (parapetH * 0.56));
    const balIM = kit.instancer(balGeo, stone, balN + 4, { name: 'rim.baluster' });
    // gaps: a real ruin has whole sections of balustrade missing
    const gaps = [];
    for (let i = 0; i < 3; i++) { const c = nearA0 + (nearA1 - nearA0) * (0.12 + f() * 0.76); gaps.push([c - (5 + f() * 9) * DEG, c + (5 + f() * 9) * DEG]); }
    const inGap = (a) => gaps.some(([g0, g1]) => a > g0 && a < g1);
    for (let i = 0; i < balN; i++) {
      const a = nearA0 + (nearA1 - nearA0) * ((i + 0.5) / balN);
      if (inGap(a)) continue;
      const rr = rAt(a) - 0.52;
      balIM.userData.push(Math.cos(a) * rr, 0.30, Math.sin(a) * rr, -a, 1);
    }
    if (balIM.count) { balIM.userData.finish(); this.root.add(balIM); }

    // coping + base rail as swept runs, cut where the balusters are missing
    const runs = [];
    let cur = nearA0;
    for (const [g0, g1] of gaps.sort((p, q) => p[0] - q[0])) {
      if (g0 > cur) runs.push([cur, Math.min(g0, nearA1)]);
      cur = Math.max(cur, g1);
    }
    if (cur < nearA1) runs.push([cur, nearA1]);
    for (const [s0, s1] of runs) {
      if (s1 - s0 < 3 * DEG) continue;
      const rail = new THREE.Mesh(this._keep(sweep(this.profile, [
        [-0.86, 0.30], [-0.86, 0.46], [-0.74, 0.52], [-0.30, 0.52], [-0.18, 0.46], [-0.18, 0.30],
      ], { a0: s0, a1: s1, closed: false, flat: true })), stone);
      rail.name = 'rim.rail';
      rail.castShadow = true; rail.receiveShadow = true;
      this.root.add(rail);
      const cop = new THREE.Mesh(this._keep(sweep(this.profile, [
        [-0.94, parapetH * 0.90], [-0.94, parapetH * 1.02], [-0.80, parapetH * 1.09],
        [-0.24, parapetH * 1.09], [-0.10, parapetH * 1.02], [-0.10, parapetH * 0.90],
      ], { a0: s0, a1: s1, closed: false, flat: true })), stone);
      cop.name = 'rim.coping';
      cop.castShadow = true; cop.receiveShadow = true;
      this.root.add(cop);
    }

    // ---- posts at the ends of each run + a gold urn finial ---------------
    const postGeo = kit.geo('rim.post', () => {
      const p = new Parts();
      p.box(0.62, parapetH * 1.18, 0.62, [0, parapetH * 0.59, 0]);
      p.box(0.80, 0.13, 0.80, [0, 0.07, 0]);
      p.box(0.76, 0.12, 0.76, [0, parapetH * 1.16, 0]);
      return faceted(p.merge());
    });
    const finGeo = kit.geo('rim.finial', () => lathe([
      [0.06, 0], [0.20, 0.10], [0.26, 0.24], [0.20, 0.40], [0.10, 0.50], [0.13, 0.58], [0.05, 0.68],
    ], 14));
    const postIM = kit.instancer(postGeo, stone, runs.length * 2 + 2, { name: 'rim.post' });
    const finIM = kit.instancer(finGeo, this._M(B.mats.metal), runs.length * 2 + 2, { name: 'rim.finial' });
    for (const [s0, s1] of runs) {
      for (const a of [s0, s1]) {
        const rr = rAt(a) - 0.52;
        postIM.userData.push(Math.cos(a) * rr, 0, Math.sin(a) * rr, -a, 1);
        finIM.userData.push(Math.cos(a) * rr, parapetH * 1.22, Math.sin(a) * rr, -a, 1);
      }
    }
    if (postIM.count) { postIM.userData.finish(); this.root.add(postIM); }
    if (finIM.count) { finIM.userData.finish(); this.root.add(finIM); }

    // ---- hanging chains falling off the rim into the dark ----------------
    // ONE CONTINUOUS ROD PER CHAIN. Eighteen discrete torus links strung over a
    // 13m drop put one bead every 70cm, and in the review frames those beads
    // read as perfectly straight, evenly spaced DOTTED LINES bisecting the
    // composition — the single most eye-catching element in four of ten frames
    // and (correctly) read as a debug path. At play distance a chain is a LINE;
    // it is drawn as one, with an alternating radius so the beading modulates
    // the silhouette instead of interrupting it.
    // NO SHADOW CASTING. A chain link is ~8cm of geometry and the chamber's
    // shadow map spans ~28m, so a hanging chain resolves to 3-4 shadow texels
    // and lands on the back wall as a hard, black, STAIR-STEPPED diagonal
    // ~800px long — a §7 auto-fail. Chains are silhouette dressing.
    // §7 AA BAN, ROUND-3. The alternating 0.055/0.032 radius put every other
    // ring of the tube at 6.4cm diameter. At the relief-inspection framing that
    // is ~2px on screen, and a 2px-wide primitive whose material sat at the
    // library's iron albedo with no emissive floor rendered as a PURE BLACK
    // (0,1,1) stair-stepped diagonal 460px long across the focal statue, with a
    // ONE-pixel transition to the stone behind it. SMAA has nothing to work
    // with at that width: the geometry never covers enough of a pixel to
    // produce the gradient the filter searches for, so the staircase survives.
    //
    // Three changes, none of which delete the chains (they are the only thing
    // that describes the drop off the rim):
    //   1. A HARD WORLD-SPACE FLOOR ON THE RADIUS, derived from the framing:
    //      at 1600x900 and the narrowest lens the shot list uses (fov 32), one
    //      metre subtends 1569/d px. MIN_PX / that, at the farthest distance a
    //      chain is ever seen from, is the smallest radius that is allowed to
    //      exist. Anything the taper would have driven under it is clamped up.
    //   2. CULL, DO NOT THIN. If a chain still cannot make MIN_PX it is not
    //      drawn at all — a missing chain costs nothing, an unresolvable one is
    //      an auto-fail.
    //   3. AN EMISSIVE FLOOR IN THE INK RAMP (#120b1e = §2 deep shadow). The
    //      chain is now the darkest thing in the room but it is no longer BELOW
    //      the void black, so its edge is a step inside the ramp rather than a
    //      step off the bottom of it, and the rim can carry its silhouette.
    const ch = B.chains;
    {
      const MIN_PX = 3.2;                       // §7: below this SMAA cannot resolve an edge
      const PX_PER_M_AT_1M = 1569;              // 900px tall frame, fov 32
      const REF_CAM = 36;                       // the wide pose, the farthest framing we ship
      const parts = [];
      let culled = 0;
      for (let i = 0; i < ch.count; i++) {
        const a = f() * TAU;
        const rr = rAt(a) - 0.1;
        const outR = rr + 1.2 + f() * 1.6;
        const from = new THREE.Vector3(Math.cos(a) * rr, 0.20, Math.sin(a) * rr);
        const to = new THREE.Vector3(Math.cos(a) * outR, -ch.drop * (0.6 + f() * 0.8), Math.sin(a) * outR);
        // worst-case viewing distance: the camera orbits the arena, so a chain
        // on the far rim sits REF_CAM + its own radius away from the lens.
        const dist = REF_CAM + outR;
        const minRadius = (MIN_PX * dist) / (2 * PX_PER_M_AT_1M);
        // the beading still modulates the silhouette, but between two radii
        // that are BOTH above the floor instead of one that is under it
        const fat = Math.max(minRadius * 1.45, 0.078);
        const thin = Math.max(minRadius, 0.054);
        if (thin * 2 * (PX_PER_M_AT_1M / dist) < MIN_PX) { culled++; continue; }
        const n = Math.max(10, Math.round(from.distanceTo(to) / 0.16));
        const pts = catenary(from, to, ch.sag, n);
        parts.push(taperedTube(pts, pts.map((_, k) => (k % 2 ? fat : thin)), 6));
      }
      if (parts.length) {
        const cm = new THREE.Mesh(this._keep(mergeGeos(parts)),
          this._M(B.mats.iron, {
            litGain: 0.42, ambGain: 0.46, specGain: 0.9,
            // NOT a glow: 0.07 display luma, two stops under the bloom
            // threshold. This is the ink ramp's floor made unconditional so
            // the chain can never render at absolute zero against lit stone.
            emissive: new THREE.Color('#120b1e'), emissiveIntensity: 1.0,
          }));
        cm.name = 'rim.chains';
        cm.castShadow = false; cm.receiveShadow = false;
        this.root.add(cm);
      }
      void culled;
    }
  }

  // =========================================================================
  // BACK WALL — the two-storey mass that gives the frame its mid value band
  // =========================================================================
  *_buildBackWall(ctx, G) {
    const { A, B, kit, f } = G;
    if (A.wall.arcs === 'none') return;
    const R = this.bounds.r;
    const batch = new Batcher(this.root);

    // ── THE BACK WALL IS THE BACKGROUND (§1.1) ────────────────────────────
    // These two materials cover the largest surface in the upper third of
    // every composition frame and they were running at the library's default
    // gains, i.e. lit exactly like the foreground. Measured depthBands ran
    // top 0.381 / mid 0.153 / bottom 0.031. The wall now recedes: a third of
    // the key, a plum multiply toward §2's mid shadow violet (#3a1d52), and a
    // specular share small enough that the ashlar faces stop flaring. What
    // survives is the ORNAMENT on it — the meander, the cornice, the sigils —
    // which is where §9.5 wants the light anyway.
    // §11.2 LIGHT THE MID-GROUND. The wall was authored as one recessive mass,
    // which was right when the whole frame ran backwards and wrong now: the
    // focal architecture is supposed to be the BRIGHTEST band, and the ashlar
    // around the gates is that architecture. The two materials now do opposite
    // jobs instead of the same job at two strengths —
    //   wallMat  the FOCAL bays, within 34deg of a doorway: nearly double the
    //            key, a real specular share so the chamfered arrises catch it,
    //            and less hemisphere so the light that lands is DIRECTIONAL and
    //            the courses model. This is the lit stage behind the player.
    //   bayMat   every other bay: dropped a further third into the plum. These
    //            are the dark wings the eye is supposed to fall past. Uniform
    //            perimeter lighting is what made the top of every frame one
    //            continuous salmon band with no depth in it.
    // ROUND-4: §14's subject test SUPERSEDES §11.2 where they collide, and here
    // they collided. "The focal bays are the brightest band" was implemented as
    // nearly double the key on a pale lavender tint, and the result measured
    // 0.694-0.744 display in the top-edge blocks against a hero at 0.669 — the
    // wall behind the player was brighter than the player. The bays stay the
    // brightest ARCHITECTURE (bayMat is 0.19, the floor lower still) but they
    // now sit a clear band UNDER the subject, and the tint comes off white so
    // the ashlar reads as lit crimson stone rather than as bleached plaster.
    const wallMat = this._M(B.mats.wall, { variation: 0.20, litGain: 0.30, ambGain: 0.40, specGain: 1.45, tint: '#7f6786' });
    const bayMat = this._M(B.mats.bay, { variation: 0.26, litGain: 0.19, ambGain: 0.40, specGain: 0.42, tint: '#5b4869' });
    // ── ORNAMENT MUST READ AS RELIEF, NOT AS PRINT (§9.5, relief pass) ────
    // At 0.06 emissive and full gains against a wall running litGain 0.36, the
    // gold and the masonry were separated by ALBEDO ALONE — measured as flat
    // near-white shapes on near-black stone, which at gameplay distance is
    // line-art, not carving. The three corrections work together:
    //   tint      pulls the raw albedo down to a MID gold so the fret no longer
    //             out-values the wall before a photon arrives;
    //   ambGain   stops the hemisphere fill from lifting the undercuts, so the
    //             chamfers actually have a dark side to be lit against;
    //   specGain  gives the chamfered arris a real specular hit, so the
    //             CONTRAST IS MADE BY LIGHT — which is the whole point.
    // vertexColors switches on the hand-baked contact occlusion every moulding
    // unit now carries (kit.js reliefShade): dark at the root where it meets
    // the wall, dark on the undercut, light on the crown.
    // ROUND-4: a #f4ece0 albedo at litGain 1.02 is gold pushed past the AgX
    // shoulder, which is the exact failure this file complains about elsewhere
    // ("gold pushed past the shoulder is not gold any more, it is a bleached
    // highlight"). The diffuse comes back into the linear midrange and the
    // sharp lobe keeps carrying the highlight band (§9.5).
    const leaf = this._M(B.mats.leaf, {
      emissiveIntensity: 0.04, vertexColors: true, tint: '#f4ece0',
      litGain: 0.66, ambGain: 0.52, specGain: 2.30,
    });
    const metal = this._M(B.mats.metal);

    const [a0, a1] = G.wallArc;
    const H1 = A.wall.height ?? 5.6;                   // lower storey
    const storeys = A.wall.storeys ?? 2;
    const rAt = (a) => this.radiusAt(a) + 0.55;

    // door openings we must not build across
    const openings = this.doorAngles.map((a) => ({ a, half: 15 * DEG }));
    const inOpening = (a) => openings.some((o) => Math.abs(((a - o.a + Math.PI * 3) % TAU) - Math.PI) < o.half);

    // ---- ASHLAR: courses of individual blocks -----------------------------
    const blockGeo = kit.geo('wall.block', () => faceted(new THREE.BoxGeometry(1, 1, 1)));
    const BLOCK_W = 1.72;
    const blocks = [];
    // courses fill exactly [0.36, H1] so the top of the masonry meets the
    // astragal and the meander band instead of growing through them
    const courses = Math.max(3, Math.round((H1 - 0.36) / 0.90));
    const COURSE_H = (H1 - 0.36) / courses;
    for (let c = 0; c < courses; c++) {
      const y = 0.36 + COURSE_H * (c + 0.5);
      const stagger = (c % 2) * 0.5;
      const n = Math.max(8, Math.round((a1 - a0) * R / BLOCK_W));
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5 + stagger) / n);
        if (inOpening(a)) continue;
        // the arc has to END somewhere: crumble the last few metres into ruin
        const edgeT = Math.min(Math.abs(a - a0), Math.abs(a - a1)) / (20 * DEG);
        if (c >= 1 && edgeT < 1 && f() > edgeT * 0.6 + 0.10 * c) continue;
        if (A.wall.ruined && f() < 0.06 * (c + 1)) continue;
        // Jitter is SEASONING, not structure: at high amplitude the courses
        // stop reading as bedded masonry and the wall becomes a shelf of loose
        // slabs with light leaking between them.
        blocks.push({ a, y: y + (f() - 0.5) * 0.025, r: rAt(a) + (f() - 0.5) * 0.03,
          w: BLOCK_W * (1.06 + f() * 0.07), h: COURSE_H * 0.965, d: 1.15 + f() * 0.07, tilt: (f() - 0.5) * 0.014 });
      }
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pv = new THREE.Vector3(), sv = new THREE.Vector3();
    const focal = blocks.filter((b) => openings.some((o) => Math.abs(((b.a - o.a + Math.PI * 3) % TAU) - Math.PI) < 34 * DEG));
    const plain = blocks.filter((b) => focal.indexOf(b) < 0);
    for (const [list, mat, nm] of [[focal, wallMat, 'wall.ashlar'], [plain, bayMat, 'wall.ashlar.bay']]) {
      if (!list.length) continue;
      const im = kit.instancer(blockGeo, mat, list.length, { name: nm });
      for (const b of list) {
        e.set(b.tilt, -b.a, b.tilt * 0.6); q.setFromEuler(e);
        pv.set(Math.cos(b.a) * b.r, b.y, Math.sin(b.a) * b.r);
        sv.set(b.d, b.h, b.w);
        im.userData.pushMatrix(m4.compose(pv, q, sv));
      }
      im.userData.finish();
      this.root.add(im);
    }

    yield 'wall.ashlar';

    // ---- solid backing so no light leaks through the joints --------------
    // Cut into runs between the doorways: a continuous shell would brick the
    // exits up, and the exits are the whole point of the room.
    const runsW = [];
    {
      const cuts = openings.map((o) => [o.a - o.half, o.a + o.half]).sort((p, q) => p[0] - q[0]);
      let cur = a0 - 2 * DEG;
      for (const [c0, c1] of cuts) {
        if (c0 > cur) runsW.push([cur, Math.min(c0, a1 + 2 * DEG)]);
        cur = Math.max(cur, c1);
      }
      if (cur < a1 + 2 * DEG) runsW.push([cur, a1 + 2 * DEG]);
    }
    const backMat = this._M(B.mats.wall, { side: THREE.DoubleSide, variation: 0.18, litGain: 0.20, ambGain: 0.38, specGain: 0.38, tint: '#5d4c6a' });
    for (const [s0, s1] of runsW) {
      if (s1 - s0 < 2 * DEG) continue;
      const back = new THREE.Mesh(this._keep(sweep(this.profile, [
        [1.15, 0.0], [1.15, H1 + 0.4],
      ], { a0: s0, a1: s1, closed: false, radiusOffset: 0.0 })), backMat);
      back.name = 'wall.back';
      back.castShadow = true; back.receiveShadow = true;
      this.root.add(back);
      const plinth = new THREE.Mesh(this._keep(sweep(this.profile, [
        [-0.15, 0.0], [-0.15, 0.30], [0.06, 0.36], [0.06, 0.0],
      ], { a0: s0, a1: s1, closed: false, radiusOffset: 0.55, flat: true })), wallMat);
      plinth.name = 'wall.plinth';
      plinth.castShadow = true; plinth.receiveShadow = true;
      this.root.add(plinth);
    }
    G.wallRuns = runsW;

    yield 'wall.backing';

    // ---- pilasters: hard verticals every bay ------------------------------
    const nBays = 11;
    const pilGeo = kit.geo('wall.pilaster', () => {
      const p = new Parts();
      p.box(1.15, H1, 0.62, [0, H1 * 0.5, 0]);
      p.box(1.38, 0.34, 0.86, [0, 0.17, 0]);
      p.box(1.28, 0.16, 0.78, [0, 0.42, 0]);
      p.box(1.40, 0.30, 0.92, [0, H1 - 0.15, 0]);
      p.box(1.54, 0.13, 1.02, [0, H1 + 0.04, 0]);
      for (let k = -1; k <= 1; k++) {
        p.add(new THREE.CylinderGeometry(0.075, 0.075, H1 * 0.70, 8, 1, false, 0, Math.PI),
          { p: [k * 0.26, H1 * 0.52, 0.31], r: [0, Math.PI, 0] });
      }
      return faceted(p.merge());
    });
    const pilIM = kit.instancer(pilGeo, wallMat, nBays + 2, { name: 'wall.pilaster' });
    const bayCentres = [];
    for (let i = 0; i <= nBays; i++) {
      const a = a0 + (a1 - a0) * (i / nBays);
      if (inOpening(a)) continue;
      const rr = rAt(a) - 0.28;
      pilIM.userData.push(Math.cos(a) * rr, 0, Math.sin(a) * rr, faceIn(a), 1);
    }
    for (let i = 0; i < nBays; i++) {
      const a = a0 + (a1 - a0) * ((i + 0.5) / nBays);
      if (!inOpening(a)) bayCentres.push(a);
    }
    if (pilIM.count) { pilIM.userData.finish(); this.root.add(pilIM); }

    yield 'wall.pilasters';

    // ---- carved panels in every bay ---------------------------------------
    // Flat ashlar between pilasters is a brick wall; a recessed, moulded field
    // is architecture. Only the bays around the room's focal axis carry the
    // gold meander and a rosette (§1.5: ornament is a wayfinder, not wallpaper).
    if (bayCentres.length) {
      const pb = new Batcher(this.root);
      const bayArc = (a1 - a0) / nBays;
      const pw = Math.min(3.9, (bayArc * R) - 1.5);
      const ph = Math.min(3.6, H1 - 1.5);
      const rich = kit.panel({ w: pw, h: ph, d: 0.42, meander: true, rosette: true, bandY: ph * 0.24 });
      const plainP = kit.panel({ w: pw, h: ph, d: 0.42, meander: false });
      const focalA = this.doorAngles.length ? this.doorAngles[Math.floor(this.doorAngles.length / 2)] : Math.PI;
      const pm = new THREE.Matrix4(), pq = new THREE.Quaternion(), pone = new THREE.Vector3(1, 1, 1);
      for (const a of bayCentres) {
        const dA = Math.abs(((a - focalA + Math.PI * 3) % TAU) - Math.PI);
        const rr = rAt(a) - 0.30;
        pq.setFromEuler(new THREE.Euler(0, faceIn(a), 0));
        pm.compose(new THREE.Vector3(Math.cos(a) * rr, 0.55 + ph * 0.5, Math.sin(a) * rr), pq, pone);
        pb.addTemplate(dA < 40 * DEG ? rich : plainP, pm, { name: 'wall.panel' });
      }
      pb.build();
      rich.clear(); plainP.clear();
    }

    yield 'wall.panels';

    // ---- GREEK KEY BAND, real extruded geometry, capping the lower storey --
    {
      const h = 0.62, depth = 0.30;
      const per = kit.geo(`meander:${h.toFixed(3)}:${depth.toFixed(3)}`, () => {
        return meanderPeriod(h, depth);
      });
      const railG = kit.geo(`mrail:${h.toFixed(3)}:${depth.toFixed(3)}`, () => meanderRail(h, h * 1.03, depth));
      const n = Math.round((a1 - a0) * R / h);
      const perIM = kit.instancer(per, leaf, n + 2, { name: 'wall.meander', recv: false });
      const railIM = kit.instancer(railG, leaf, n + 2, { name: 'wall.meander.rail', recv: false });
      for (let i = 0; i < n; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5) / n);
        if (inOpening(a)) continue;
        const rr = rAt(a) - 0.22;
        perIM.userData.push(Math.cos(a) * rr, H1 + 0.58, Math.sin(a) * rr, faceOut(a), 1);
        railIM.userData.push(Math.cos(a) * rr, H1 + 0.58 - h * 0.5 + h / 16, Math.sin(a) * rr, faceOut(a), 1);
      }
      if (perIM.count) { perIM.userData.finish(); this.root.add(perIM); }
      if (railIM.count) { railIM.userData.finish(); this.root.add(railIM); }
      // a bead-and-reel astragal carrying the band — the small proud member
      // that gives the whole course a lit lower edge
      const bh = 0.46;
      const brGeo = kit.geo(`br:${bh.toFixed(3)}`, () => beadAndReelUnit(bh));
      const nb = Math.round((a1 - a0) * R / (bh * 0.80));
      const brIM = kit.instancer(brGeo, leaf, nb + 2, { name: 'wall.beadreel', recv: false });
      for (let i = 0; i < nb; i++) {
        const a = a0 + (a1 - a0) * ((i + 0.5) / nb);
        if (inOpening(a)) continue;
        const rr = rAt(a) - 0.30;
        brIM.userData.push(Math.cos(a) * rr, H1 + 0.16, Math.sin(a) * rr, faceOut(a), 1);
      }
      if (brIM.count) { brIM.userData.finish(); this.root.add(brIM); }
    }

    yield 'wall.key';

    // ---- mid cornice ------------------------------------------------------
    this._corniceRun(ctx, G, { a0, a1, y: H1 + 1.42, h: 0.95, dOut: 0.55, mat: wallMat, trim: leaf, openings });

    yield 'wall.cornice';

    // ---- upper storey: a blind arcade ------------------------------------
    if (storeys >= 2) {
      // Storey heights are TUNED, not guessed. Measured against the shot sheet:
      // taller is not automatically better, because past a point the upper
      // storey stops adding lit architecture to the frame's top third and just
      // pushes the arcade (and its cool lamps) out of frame above it.
      const H2 = H1 + 2.30;
      const upH = 5.4;
      const arcSpan = 2.9;
      // §1.1 / §9.6: the upper storey is BACKGROUND. It loses chroma, loses
      // value and drifts toward the biome's complement, so the frame gains a
      // real warm-front / cool-back separation instead of one salmon field.
      // Cool, but NOT dark: this band sits across the top of every gameplay
      // frame and it is the only thing that can hold a value above the stage.
      // Low chroma + high value + the complement hue = "distance" (§1.1) while
      // still giving the frame its top band.
      // Cool AND bright. The trick is the SPLIT, not the tint: a warm key at
      // full gain drags any surface it touches into the key's own hue, so the
      // background gives most of its key back and takes a large share of the
      // (indigo) hemisphere instead. That is what makes distance read as cool
      // in a room lit by fire, and it is the §9.6 complement at real scale.
      // ROUND-2. This was tint #e2e6ff at ambGain 7.60 — a near-white surface
      // taking SEVEN AND A HALF TIMES the hemisphere — and it is the single
      // biggest reason the measured depth gradient ran backwards: the top
      // storey of the far wall was the brightest large surface in the game.
      // The SPLIT (cool back / warm front) is the right idea and it stays; it
      // is the VALUE that was wrong. §1.1 asks the background for low value AND
      // low chroma-through-haze, so the band keeps its complement hue, gets
      // MORE saturated (a dark saturated blue is distance; a pale blue-white is
      // a light source) and drops nearly two stops.
      // §11.1 again. This band is the top edge of every play frame and it was
      // taking 2.6x the hemisphere on a pale periwinkle albedo, i.e. it was a
      // large soft LIGHT SOURCE sitting at the farthest point in the room. The
      // cool/warm split is the right idea and stays; the value is halved and the
      // hue is pushed deeper so distance reads as a dark saturated blue rather
      // than as a lit wall.
      const coolStone = { tint: '#5d6ba8', litGain: 0.20, ambGain: 1.30, specGain: 0.26, variation: 0.18, rimStrength: 1.0 };
      const archT = kit.arch({ span: arcSpan, thickness: 0.52, depth: 0.75, voussoirs: 11, springY: 2.3, ornate: false });
      const archStone = this._M(B.mats.arch), archCool = this._M(B.mats.arch, coolStone);
      archT.traverse((o) => { if (o.isMesh && o.material === archStone) o.material = archCool; });
      const nicheGeo = kit.geo('wall.niche', () => {
        const p = new Parts();
        // a dark recess behind each blind arch: a half-cylinder facing in
        p.add(new THREE.CylinderGeometry(arcSpan * 0.5, arcSpan * 0.5, 3.2, 18, 1, true, -Math.PI / 2, Math.PI), { p: [0, 1.6, 0] });
        p.add(new THREE.SphereGeometry(arcSpan * 0.5, 18, 8, -Math.PI / 2, Math.PI, 0, Math.PI / 2), { p: [0, 3.2, 0] });
        return p.merge();
      });
      const nicheMat = this._M(B.mats.rock, { tint: '#1a1020', litGain: 0.30, ambGain: 0.35, rimStrength: 0.10, side: THREE.DoubleSide });
      const upperMat = this._M(B.mats.wall, { ...coolStone, side: THREE.DoubleSide });
      const upperWall = new THREE.Mesh(this._keep(sweep(this.profile, [
        [0.70, H2 - 0.2], [0.70, H2 + upH],
      ], { a0: a0 + 4 * DEG, a1: a1 - 4 * DEG, closed: false, radiusOffset: 0.55 })), upperMat);
      upperWall.name = 'wall.upper';
      // ── THE SHADOW POLICY, and it is load-bearing ────────────────────────
      // The key sits at 38deg. A 15m wall on the key's azimuth throws a 19m
      // shadow — which is the whole arena. The measured result was a ground
      // plane at display luma 0.02: not a dark stage, a black hole, with every
      // scrap of floor light coming from the braziers. Nothing above the first
      // storey casts: the room keeps its height and its silhouette, and the key
      // gets back on to the middle of the floor where the long, described
      // column shadows can read against it (§9.7).
      upperWall.castShadow = false; upperWall.receiveShadow = true;
      this.root.add(upperWall);

      for (const a of bayCentres) {
        const rr = rAt(a) - 0.05;
        const m = new THREE.Matrix4();
        const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, faceIn(a), 0));
        m.compose(new THREE.Vector3(Math.cos(a) * rr, H2, Math.sin(a) * rr), qq, new THREE.Vector3(1, 1, 1));
        batch.addTemplate(archT, m, { name: 'wall.arcade', cast: false });
        const nm = new THREE.Mesh(nicheGeo, nicheMat);
        nm.position.set(Math.cos(a) * (rr + 0.55), H2, Math.sin(a) * (rr + 0.55));
        nm.rotation.y = faceOut(a);   // the shell is on the far side; it OPENS inward
        nm.receiveShadow = true;
        this.root.add(nm);
      }
      // Pilasters continuing up between the arches. Without them the upper
      // storey is a smooth swept band with holes cut in it; with them the bays
      // read as a bay SYSTEM running the full height of the room, which is what
      // makes an interior feel built rather than extruded.
      {
        const upPil = kit.geo('wall.pilaster.up', () => {
          const p = new Parts();
          p.box(0.92, upH * 0.86, 0.50, [0, upH * 0.43, 0]);
          p.box(1.14, 0.26, 0.66, [0, 0.13, 0]);
          p.box(1.06, 0.12, 0.60, [0, 0.32, 0]);
          p.box(1.16, 0.26, 0.70, [0, upH * 0.86 - 0.13, 0]);
          p.box(1.30, 0.11, 0.80, [0, upH * 0.86 + 0.05, 0]);
          return faceted(p.merge());
        });
        const nUp = nBays;
        const upIM = kit.instancer(upPil, upperMat, nUp + 2, { name: 'wall.pilaster.up', cast: false });
        for (let i = 0; i <= nUp; i++) {
          const a = a0 + (a1 - a0) * (i / nUp);
          if (a < a0 + 3 * DEG || a > a1 - 3 * DEG) continue;
          const rr = rAt(a) + 0.18;
          upIM.userData.push(Math.cos(a) * rr, H2 - 0.1, Math.sin(a) * rr, faceIn(a), 1);
        }
        if (upIM.count) { upIM.userData.finish(); this.root.add(upIM); }
      }

      // §9.6 TWO HUES. Every brazier in the chamber is warm, so without a cold
      // source at scale the whole frame collapses into one salmon family. A
      // COLD LAMP burning in each dark niche is the classic Hades answer: it
      // sits high on the far wall (mid/background band), it is small and
      // saturated rather than broad and washy, and it draws the arcade's arches
      // as silhouettes against it.
      const glyphGeo = kit.geo('wall.glyph', () => {
        const p = new Parts();
        p.add(new THREE.OctahedronGeometry(0.62, 1), { p: [0, 0, 0], s: [0.72, 1.55, 0.72] });
        p.add(new THREE.OctahedronGeometry(0.30, 0), { p: [0.34, -0.55, 0.10], s: [0.7, 1.3, 0.7], r: [0.3, 0.4, 0.25] });
        p.add(new THREE.OctahedronGeometry(0.24, 0), { p: [-0.30, -0.70, -0.06], s: [0.7, 1.1, 0.7], r: [-0.2, 0.9, -0.3] });
        return faceted(p.merge());
      });
      const accent = B.accent;
      const glyphMat = this._M(B.mats.crystal, {
        tint: accent, emissive: accent, emissiveIntensity: 1.15,
        litGain: 0.55, ambGain: 0.5, specGain: 1.4, rimStrength: 1.1, rimColor: accent,
      });
      const glyphIM = kit.instancer(glyphGeo, glyphMat, bayCentres.length, { name: 'wall.glyph', recv: false, cast: false });
      for (const a of bayCentres) {
        const rr = rAt(a) + 0.10;
        glyphIM.userData.push(Math.cos(a) * rr, H2 + 1.55, Math.sin(a) * rr, faceIn(a), 1);
      }
      if (glyphIM.count) { glyphIM.userData.finish(); this.root.add(glyphIM); }
      batch.build();
      // crowning cornice, and a gold cyma running its lip. This is the highest
      // line in the room and it sits across the top of every wide frame: §9.5
      // wants the light on the EDGES of architecture, and there is no edge in
      // the chamber more structural than the one where the wall meets the dark.
      const crownY = H2 + upH + 0.3;
      this._corniceRun(ctx, G, { a0: a0 + 3 * DEG, a1: a1 - 3 * DEG, y: crownY, h: 1.20, dOut: 0.85, mat: upperMat, trim: leaf, openings: [], cast: false });
      const cyma = new THREE.Mesh(this._keep(sweep(this.profile, [
        [1.00, crownY + 0.60], [1.30, crownY + 0.66], [1.34, crownY + 0.80], [1.08, crownY + 0.84],
      ], { a0: a0 + 3 * DEG, a1: a1 - 3 * DEG, closed: false, radiusOffset: 0.55, flat: true })),
        this._M(B.mats.leaf, { emissiveIntensity: 0.16, specGain: 1.5 }));
      cyma.name = 'wall.cyma';
      cyma.castShadow = false; cyma.receiveShadow = true;
      this.root.add(cyma);
      G.wallTop = H2 + upH + 1.5;
    } else {
      G.wallTop = H1 + 2.4;
    }
    G.wallH1 = H1;
    G.bayCentres = bayCentres;
  }

  /** A cornice swept round an arc, with dentils and egg-and-dart instanced. */
  _corniceRun(ctx, G, o) {
    const { kit, B } = G;
    const R = this.bounds.r;
    const body = new THREE.Mesh(this._keep(sweep(this.profile, [
      [0.30, o.y - o.h * 0.52], [0.30, o.y - o.h * 0.30],
      [0.30 + o.dOut * 0.4, o.y - o.h * 0.26], [0.30 + o.dOut * 0.4, o.y - o.h * 0.10],
      [0.30 + o.dOut, o.y + o.h * 0.10], [0.30 + o.dOut, o.y + o.h * 0.24],
      [0.30 + o.dOut * 0.55, o.y + o.h * 0.34], [0.30 + o.dOut * 0.55, o.y + o.h * 0.46],
      [0.30, o.y + o.h * 0.52],
    ], { a0: o.a0, a1: o.a1, closed: false, radiusOffset: 0.55, flat: true })), o.mat);
    body.name = 'cornice';
    body.castShadow = o.cast !== false; body.receiveShadow = true;
    this.root.add(body);

    const inOpening = (a) => (o.openings || []).some((op) => Math.abs(((a - op.a + Math.PI * 3) % TAU) - Math.PI) < op.half);
    // dentils
    const dh = o.h * 0.22;
    const dGeo = kit.geo(`dentil:${dh.toFixed(3)}`, () => faceted(new THREE.BoxGeometry(dh * 0.55, dh, dh * 0.72)));
    const nd = Math.round((o.a1 - o.a0) * R / (dh * 1.9));
    const dIM = kit.instancer(dGeo, o.mat, nd + 2, { name: 'cornice.dentils', recv: false, cast: o.cast !== false });
    for (let i = 0; i < nd; i++) {
      const a = o.a0 + (o.a1 - o.a0) * ((i + 0.5) / nd);
      if (inOpening(a)) continue;
      const rr = this.radiusAt(a) + 0.55 + 0.30 + o.dOut * 0.55;
      dIM.userData.push(Math.cos(a) * rr, o.y - o.h * 0.12, Math.sin(a) * rr, -a + Math.PI / 2, 1);
    }
    if (dIM.count) { dIM.userData.finish(); this.root.add(dIM); }
    // egg-and-dart under the corona — the lit arris of the whole wall
    const eh = o.h * 0.42;
    const eGeo = kit.geo(`ed:${eh.toFixed(3)}`, () => eggAndDartUnit(eh));
    const ne = Math.round((o.a1 - o.a0) * R / (eh * 0.70));
    const eIM = kit.instancer(eGeo, o.trim, ne + 2, { name: 'cornice.eggdart', recv: false, cast: o.cast !== false });
    for (let i = 0; i < ne; i++) {
      const a = o.a0 + (o.a1 - o.a0) * ((i + 0.5) / ne);
      if (inOpening(a)) continue;
      const rr = this.radiusAt(a) + 0.55 + 0.30 + o.dOut * 0.92;
      eIM.userData.push(Math.cos(a) * rr, o.y + o.h * 0.30, Math.sin(a) * rr, faceIn(a), 1);
    }
    if (eIM.count) { eIM.userData.finish(); this.root.add(eIM); }
  }

  // =========================================================================
  // COLONNADE — the mid-ground value band
  // =========================================================================
  *_buildColonnade(ctx, G) {
    const { A, B, kit, f } = G;
    const R = this.bounds.r;
    const per = A.peristyle || { count: 12, order: 'doric', h: 7.5 };
    const batch = new Batcher(this.root);
    const inOpening = (a) => this.doorAngles.some((d) => Math.abs(((a - d + Math.PI * 3) % TAU) - Math.PI) < 17 * DEG);

    // EVERY perimeter column wears its order. `ornate:false` dressed the capital
    // in plain shaft stone, so the whole colonnade — the largest run of
    // architecture in any frame — carried no gold at all, and measured
    // saturated gold was 1.2% of a gameplay frame against §2's "ornament spine
    // of the whole game". The capital is a small, bright, high-up shape: it is
    // exactly what §9.5 means by lighting the EDGES of architecture.
    // ── PAINTED AERIAL PERSPECTIVE (§1.1 "background is LOW value, LOW chroma
    // and hazed") ─────────────────────────────────────────────────────────
    // There is no distance haze in this game: render/shaders/grades.js authors
    // hazeStart 40 / hazeEnd 58 over a 25m arena shot from 14-26 units, so no
    // architecture in the chamber ever receives any. The measured consequence
    // was depthBands top 0.38 / mid 0.15 / bottom 0.03 — the far colonnade was
    // the brightest, most saturated and most detailed surface in every frame,
    // which is §1.1 exactly reversed.
    // Until the grade ships a usable haze band this is the world's own answer,
    // and it is the answer a background painter would give anyway: the far
    // colonnade is simply PAINTED darker and cooler than the near one. §8 pins
    // the camera yaw at 45deg and it never rotates in play, so +X+Z is always
    // near and -X-Z is always far — the same rule the floor glaze already uses.
    const withRole = (over, fn) => {
      const save = {};
      for (const k in over) { save[k] = kit.roleOpts[k]; kit.roleOpts[k] = { ...(kit.roleOpts[k] || {}), ...over[k] }; }
      const out = fn();
      for (const k in over) kit.roleOpts[k] = save[k];
      return out;
    };
    // #3a1d52 is §2's mid shadow violet; multiplied into the albedo it is a
    // recession toward the ink ramp rather than a grey knock-down.
    const FAR = {
      column: { litGain: 0.20, ambGain: 0.34, specGain: 0.70, tint: '#43315a' },
      leaf:   { litGain: 0.24, ambGain: 0.26, specGain: 0.90, tint: '#5f5470' },
    };
    // Four full column templates is the single most expensive allocation in a
    // chamber (~19ms). One per slice.
    const plain = kit.column({ h: per.h, r: per.h * 0.075, order: per.order, ornate: true });
    yield 'colonnade.tmpl.plain';
    const ornate = kit.column({ h: per.h * 1.05, r: per.h * 0.079, order: per.order, ornate: true });
    yield 'colonnade.tmpl.ornate';
    const plainFar = withRole(FAR, () => kit.column({ h: per.h, r: per.h * 0.0751, order: per.order, ornate: true }));
    yield 'colonnade.tmpl.plainFar';
    const ornateFar = withRole(FAR, () => kit.column({ h: per.h * 1.05, r: per.h * 0.0791, order: per.order, ornate: true }));
    yield 'colonnade.tmpl.ornateFar';
    // depth 0 = the far rim, 1 = the near rim. Everything past the room's
    // mid-line takes the recession.
    const depthOf = (x, z) => clamp01(0.5 + 0.5 * ((x + z) * 0.70711 / (R + 1.5)));

    const cols = [];
    if (per.grid) {
      // a hypostyle grid: rows of columns marching across the hall
      const step = R * 0.52;
      for (let ix = -1; ix <= 1; ix++) for (let iz = -1; iz <= 1; iz++) {
        if (ix === 0 && iz === 0) continue;
        const x = ix * step, z = iz * step;
        if (!this.insideXZ(x, z, 1.6)) continue;
        cols.push({ x, z, ornate: Math.abs(ix) + Math.abs(iz) === 2 });
      }
      // plus a ring against the wall
      for (let i = 0; i < 8; i++) {
        const a = 140 * DEG + (170 * DEG) * (i / 7);
        if (inOpening(a)) continue;
        const rr = this.radiusAt(a) - 2.1;
        cols.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, ornate: false });
      }
    } else if (per.sides) {
      // two files down the long axis
      for (const side of [-1, 1]) {
        for (let i = 0; i < Math.round(per.count / 2); i++) {
          const t = (i + 0.5) / Math.round(per.count / 2);
          const x = lerp(-R * 0.80, R * 0.80, t);
          const z = side * (R * (A.shape === 'causeway' ? 0.26 : 0.52));
          if (!this.insideXZ(x, z, 1.4)) continue;
          cols.push({ x, z, ornate: i === 0 || i === Math.round(per.count / 2) - 1 });
        }
      }
    } else if (per.atCorners) {
      for (let i = 0; i < per.count; i++) {
        const a = (i / per.count) * TAU + Math.PI / per.count;
        const rr = this.radiusAt(a) * 0.42;
        cols.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, ornate: i % 2 === 0 });
      }
    } else {
      // §8 pins the camera yaw at 45deg, so the arc around theta=45deg is the
      // rim between the lens and the arena. A column standing there crops the
      // play space and puts a lit vertical across the foreground. The peristyle
      // therefore runs the far three-quarters and the near quarter stays open,
      // which is also exactly how Hades frames a chamber.
      for (let i = 0; i < per.count; i++) {
        const a = (i / per.count) * TAU + 0.11;
        if (inOpening(a)) continue;
        const nearD = Math.abs(((a - 45 * DEG + Math.PI * 3) % TAU) - Math.PI);
        if (nearD < 52 * DEG) continue;
        const rr = this.radiusAt(a) - 2.35;
        cols.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, ornate: false });
      }
      // the pair flanking the centre door wears the full order (§1.5 hierarchy)
      const dA = this.doorAngles[Math.floor(this.doorAngles.length / 2)] ?? Math.PI;
      for (const s of [-1, 1]) {
        const a = dA + s * 22 * DEG;
        const rr = this.radiusAt(a) - 2.6;
        cols.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr, ornate: true });
      }
    }

    // Peristyles are scenery, not combat cover. Normalize every plan's column
    // layout onto an exterior ring so hypostyle grids and side files cannot
    // create pockets that pin melee enemies against the boundary.
    for (const c of cols) {
      const a = Math.atan2(c.z, c.x);
      const rr = this.radiusAt(a) + 0.9;
      c.x = Math.cos(a) * rr;
      c.z = Math.sin(a) * rr;
    }

    yield 'colonnade.columns';

    // ---- ONE BAY IN FOUR HAS FALLEN (§1.5, §1.8) --------------------------
    // A rotationally symmetric colonnade gives the chamber no FRONT: every
    // heading looks the same, so the player cannot orient and the frame has no
    // landmark. Collapsing a regular quarter of the ring — a snapped stump, its
    // drums rolled out across the floor, its capital lying on its side — is the
    // asymmetric feature Hades always plants for exactly that reason, and it
    // costs three instanced buckets.
    const ruinMat = this._M(B.mats.rubble, { variation: 0.28, litGain: 0.46, ambGain: 0.62 });
    const colStoneMat = this._M(B.mats.column, { variation: 0.24 });
    const rubBatch = new Batcher(this.root);
    const rm4 = new THREE.Matrix4(), rq = new THREE.Quaternion();
    const colR = per.h * 0.075;
    const fallBay = (c) => {
      const y0 = this.heightAt(c.x, c.z);
      // the stump: the column's own base plus one and a bit of shaft, snapped
      const stumpH = colR * (1.6 + f() * 1.5);
      const stump = kit.geo(`ruin.stump:${stumpH.toFixed(2)}:${colR.toFixed(2)}`, () => {
        const p2 = new Parts();
        p2.add(faceted(new THREE.BoxGeometry(colR * 2.55, colR * 0.46, colR * 2.55)), { p: [0, colR * 0.23, 0] });
        const sh = columnDrumGeo(f, { r: colR * 0.98, h: stumpH, flutes: 8, depth: colR * 0.22 });
        p2.add(sh, { p: [0, colR * 0.46 + stumpH * 0.5, 0] });
        return p2.merge();
      });
      rq.setFromEuler(new THREE.Euler(0, f() * TAU, 0));
      rm4.compose(new THREE.Vector3(c.x, y0, c.z), rq, one);
      rubBatch.add(stump, colStoneMat, rm4, { name: 'colonnade.stump' });
      // its drums, rolled out toward the arena
      const inward = Math.atan2(-c.z, -c.x);
      for (let d = 0; d < 3; d++) {
        const dist = 1.5 + d * 1.25 + f() * 0.7;
        const dx = c.x + Math.cos(inward) * dist + (f() - 0.5) * 1.1;
        const dz = c.z + Math.sin(inward) * dist + (f() - 0.5) * 1.1;
        if (!this.insideXZ(dx, dz, 1.0)) continue;
        const dg = kit.geo(`ruin.drum:${d}`, () => columnDrumGeo(f, { r: colR * 0.96, h: colR * 2.1, flutes: 8, depth: colR * 0.22 }));
        rq.setFromEuler(new THREE.Euler(Math.PI / 2 + (f() - 0.5) * 0.16, f() * TAU, (f() - 0.5) * 0.2));
        rm4.compose(new THREE.Vector3(dx, y0 + colR * 0.96, dz), rq, one);
        rubBatch.add(dg, colStoneMat, rm4, { name: 'colonnade.drum' });
        this.colliders.push({ kind: 'circle', x: dx, z: dz, r: colR * 1.1 });
        G.keepOut.push({ x: dx, z: dz, r: colR * 1.6 });
      }
      // the capital, on its side, acanthus up — the readable landmark shape
      const capG = kit.geo('ruin.cap', () => brokenCapitalGeo(f, kit));
      const cdist = 2.9 + f() * 0.8;
      const cx = c.x + Math.cos(inward) * cdist, cz = c.z + Math.sin(inward) * cdist;
      if (this.insideXZ(cx, cz, 1.2)) {
        rq.setFromEuler(new THREE.Euler(0, f() * TAU, 0));
        rm4.compose(new THREE.Vector3(cx, y0, cz), rq, one);
        rubBatch.add(capG, colStoneMat, rm4, { name: 'colonnade.capital.fallen' });
        this.colliders.push({ kind: 'circle', x: cx, z: cz, r: 0.9 });
        G.keepOut.push({ x: cx, z: cz, r: 1.5 });
      }
      // spall
      for (let k = 0; k < 4; k++) {
        const a2 = f() * TAU, rr2 = 0.9 + f() * 2.6;
        const rx = c.x + Math.cos(inward) * 1.2 + Math.cos(a2) * rr2;
        const rz = c.z + Math.sin(inward) * 1.2 + Math.sin(a2) * rr2;
        if (!this.insideXZ(rx, rz, 0.6)) continue;
        const cg = kit.geo(`ruin.chunk:${k}`, () => rubbleChunkGeo(f, { w: 0.5 + f() * 0.5, h: 0.3 + f() * 0.28, d: 0.42 + f() * 0.4 }));
        rq.setFromEuler(new THREE.Euler((f() - 0.5) * 0.5, f() * TAU, (f() - 0.5) * 0.5));
        rm4.compose(new THREE.Vector3(rx, this.heightAt(rx, rz) + 0.12, rz), rq, one);
        rubBatch.add(cg, ruinMat, rm4, { name: 'colonnade.spall' });
      }
    };

    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    let ci = -1;
    for (const c of cols) {
      ci++;
      // Ruined plans keep missing columns as silhouette gaps, but never spill
      // solid drums or capitals back onto the playable floor.
      if ((A.peristyle.ruined && f() < 0.22) || (!c.ornate && ci % 4 === 2)) continue;
      qq.setFromEuler(new THREE.Euler(0, f() * TAU, 0));
      m.compose(new THREE.Vector3(c.x, this.heightAt(c.x, c.z), c.z), qq, one);
      const far = depthOf(c.x, c.z) < 0.46;
      batch.addTemplate(c.ornate ? (far ? ornateFar : ornate) : (far ? plainFar : plain), m, { name: 'colonnade' });
      G.keepOut.push({ x: c.x, z: c.z, r: per.h * 0.075 * 2.2 });
      G.slots.push({ x: c.x, z: c.z, w: 1.0, spread: 2.4 });
    }
    batch.build();
    rubBatch.build();
    G.columns = cols;
    G.colH = per.h;

    yield 'colonnade.ruin';

    // ---- an ARCHITRAVE tying the wall columns together --------------------
    // Free-standing posts read as a fence. A beam across their capitals is what
    // makes the room read as built architecture.
    if (!per.grid && !per.sides && G.wallArc) {
      const [wa0, wa1] = G.wallArc;
      const y = per.h + 0.30;
      const beam = new THREE.Mesh(this._keep(sweep(this.profile, [
        [-2.9, y], [-2.9, y + 0.62], [-2.1, y + 0.70], [-2.1, y + 0.10],
      ], { a0: wa0 + 6 * DEG, a1: wa1 - 6 * DEG, closed: false, flat: true })),
        this._M(B.mats.wall, { side: THREE.DoubleSide, variation: 0.16 }));
      beam.name = 'colonnade.architrave';
      beam.castShadow = true; beam.receiveShadow = true;
      this.root.add(beam);
    }

    // dispose the templates (their geometry is cached in the kit, not here)
    plain.clear(); ornate.clear(); plainFar.clear(); ornateFar.clear();
  }

  // =========================================================================
  // FOCAL — the thing the room points at
  // =========================================================================
  _buildFocal(ctx, G) {
    const { A, B, kit, f } = G;
    const R = this.bounds.r;
    const batch = new Batcher(this.root);
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    // MARBLE, NOT VERDIGRIS. `metal` resolves to bronze.verdigris, whose green
    // is off-palette for Tartarus (§2 lists no green here at all; verdigris is
    // a bronze patina and #3fa86a is Elysium's) and which is what put a swirled
    // bile-green marble on the Cerberus. `bone` is an authored Tartarus
    // material -- crimson stone, BONE, blood -- and it puts the statuary a full
    // value band above the wall behind it, which is what §9.4 wants from the
    // mid-ground. The gold trim shell rides on top of it.
    // ...but a marble figure at full rig gain is the BRIGHTEST thing in the
    // room, which inverts §9.2 (the hero out-values everything in the play
    // area) just as surely as a bright floor does. Statuary is mid-ground: one
    // band above the wall, one band below the character, and its highlight
    // lives on the gold trim's specular rather than on its diffuse.
    // ...and TINTED toward §2's marble: bone's own ramp tops out at #f7f1e0,
    // which under a brazier at intensity 200 is a white blob with no form left
    // in it. #c3bacb pulls it to marble light over marble shadow (#efe3cf /
    // #8a7f9c) and the litGain cut is what puts the modelling back.
    // ── ROUND-2 §7 HARD BAN ("uniform flat-lit geometry with no rim and no
    // value separation"). kit.js authors pteruges straps, a sculpted cuirass,
    // pectoral spheres, a belt torus, three-lame pauldrons on the sentinel, and
    // a full muzzle / jaw / fang / ear / paw stack on the hound. NONE of it
    // survived to screen, and the cause was not the geometry: at litGain 0.34
    // against ambGain 0.56 a figure receives a third of the key and is
    // dominated by a flat hemisphere wash. With no terminator every carved
    // surface collapses to one tone and the mesh reads as its own bounding
    // primitive — a cone with a ball on it. Key up 2.5x, ambient halved, so the
    // directional light carves the relief that is already there.
    // PROJECTION. `bone` ships triplanar:false, so a statue merged out of ~200
    // primitives gave EVERY sphere and tube its own full copy of the texture:
    // the bone speckle came out at 20cm across and the Cerberus read as a
    // LEOPARD at 3x. World-space projection at a 0.6m period turns the same
    // texture back into stone grain.
    // VALUE BAND. §9.2 says the HERO is the brightest large-ish shape in the
    // play area; measured, the sentinel and the hound were 95/255 against a
    // hero at 46/255. The gains below now carve the relief, but a #c3bacb
    // marble under a brazier is still a pale MASS, so the tint comes down a
    // band too: statuary sits one band above the wall and one below the
    // character, and its highlight lives on the gold trim's specular.
    // MATERIAL. `bone` ships triplanar:false, so a statue merged out of ~200
    // primitives gave EVERY sphere and tube its own full copy of the texture —
    // the bone speckle came out 20cm across and the Cerberus read as a LEOPARD
    // at 3x. Forcing world projection on `bone` only swapped the leopard for a
    // checkerboard, because that recipe's field is a tile grid. Statuary wants
    // a STONE with directional veining, which is exactly what marble is: it
    // projects triplanar by design, it carves instead of spotting, and tinted
    // to §2's marble shadow (#8a7f9c) it stays inside the Tartarus ink ramp
    // rather than importing Elysium's white.
    // §11.2: "the statuary behind the play space" is named in the correction as
    // part of the band that must carry the light. The key share goes up and the
    // gold trim's specular goes up with it, so the figures model harder instead
    // of just getting paler — the tint is deliberately NOT raised, because a
    // pale mass is what §9.2 was protecting the hero from.
    // ── ROUND-4: THE STATUE WAS THE BRIGHTEST OBJECT IN THE GAME (§9.2/§14) ──
    // Three critic rounds running, the subject test failed on this material.
    // Measured at the shipping pose: the focal hound's 40px block read 0.859
    // display against a hero at 0.611 — the set dressing out-valued the
    // protagonist by 1.4x, in the frame whose entire job is to show him.
    // It is not enough to nudge this. A statue stands two metres from a brazier
    // practical, so its k pins at 1 and the painted ramp stops capping (see the
    // roleOpts note above): the diffuse gain is the whole cap. 0.56 -> 0.20,
    // ambient down with it, and the marble tint pulled off Elysium white into
    // the Tartarus ink ramp so the figure reads as DARK STONE with a lit gold
    // trim and a cool arris — which is what a Supergiant statue actually is —
    // rather than as a pale mass. specGain deliberately UNCHANGED: §9.5 keeps
    // the highlight band on the trim, the fillets and the muzzle's arris.
    // ambGain kept a little above the diffuse cut: at 0.24 the inspection pose
    // showed the hound as a solid black mass with no form on its shade side,
    // which trades one §7 failure for another. 0.34 gives the shadow half a
    // readable plum interior without adding anything to the lit half's value.
    // AND THE SPECULAR WAS THE OTHER HALF OF IT. With the diffuse capped, the
    // brightest cell left in the whole money-shot thumbnail was still the hound
    // — its HAUNCH, a broad convex marble surface returning a near-white
    // env-map lobe at specGain 1.95 on a recipe that also paints gold veins as
    // metal (marble.elysium: metal = gMask * 0.8). §9.5 wants the highlight on
    // ornament, and this statue HAS ornament: `statue.trim` is a separate mesh
    // on gold.leaf and it keeps its lobe. The stone body does not need one.
    const deity = B.props.focalStatue;
    const statueTint = ({ hades: '#5d5268', poseidon: '#675d67', zeus: '#746c7d' })[deity] || '#6a5f73';
    const statueVein = ({ hades: '#482138', poseidon: '#285365', zeus: '#6a522c' })[deity] || '#5a2331';
    const statueMat = { mat: 'marble.elysium', matOpts: { tint: statueTint, litGain: 0.22, ambGain: 0.34,
      specGain: 0.80, envMapIntensity: 0.20, variation: 0.14, variationTint: statueVein, triScale: 0.42 } };

    // Statues stand on the wall arc between the doors, facing the arena.
    const kinds = B.props.statues;
    const placed = [];
    // The bays BETWEEN the doorways are the only places a figure can stand;
    // build() resolved them, so nothing can grow out of a threshold.
    const gaps = G.bays;
    const spots = gaps.slice(1, 1 + Math.min(kinds.length, 3)).map((g2, i) => ({ a: g2.a, kind: kinds[i % kinds.length] }));
    for (const s of spots) {
      const rr = this.radiusAt(s.a) + 1.6;
      // SIZED TO THE LENS. A figure whose head leaves the top of the play
      // camera's frame is not "monumental", it is cropped: §14's critic read the
      // focal hound as "cropped into the corner", and no lighting work fixes a
      // silhouette the frame cuts in half. The perimeter figures come down a
      // notch and the focal one (below) comes down further, so a statue's whole
      // silhouette — head, shoulders, plinth — lands inside the upper third.
      const st = kit.statue(s.kind, { scale: s.kind === 'hound' ? 1.20 : 1.02, plinth: true, plinthH: 0.95, plinthW: s.kind === 'hound' ? 2.4 : 1.7, ...statueMat });
      qq.setFromEuler(new THREE.Euler(0, faceIn(s.a) + (f() - 0.5) * 0.3, 0));
      const x = Math.cos(s.a) * rr, z = Math.sin(s.a) * rr;
      m.compose(new THREE.Vector3(x, 0, z), qq, one);
      batch.addTemplate(st, m, { name: 'statue' });
      st.clear();
      G.keepOut.push({ x, z, r: 2.2 });
      G.slots.push({ x, z, w: 1.4, spread: 2.6 });
      placed.push({ x, z });
    }

    // The focal statue: bigger, standing in the WIDEST bay of the back wall.
    const fa = G.focalAngle;
    if (A.focal === 'throne' && this.dais && !deity) {
      const d = this.dais;
      const th = kit.geo('throne', () => {
        const p = new Parts();
        p.box(2.6, 0.55, 2.2, [0, 0.28, 0]);
        p.box(2.3, 3.1, 0.5, [0, 1.55, -0.85]);
        p.box(2.7, 0.4, 0.7, [0, 3.25, -0.85]);
        for (const s of [-1, 1]) {
          p.box(0.42, 1.5, 2.0, [s * 1.1, 1.3, 0]);
          p.add(lathe([[0.24, 0], [0.30, 0.2], [0.16, 0.5], [0.24, 0.7], [0.10, 0.9]], 12), { p: [s * 1.1, 2.05, 0.85] });
        }
        return faceted(p.merge());
      });
      const tm = new THREE.Mesh(th, this._M(B.mats.wall));
      const tr = this.radiusAt(fa) + 2.0;
      tm.position.set(Math.cos(fa) * tr, 0, Math.sin(fa) * tr);
      tm.rotation.y = faceIn(fa);
      tm.castShadow = true; tm.receiveShadow = true;
      this.root.add(tm);
    } else {
      const rr = this.radiusAt(fa) + 2.0;
      const st = kit.statue(deity, { scale: 1.34, plinth: true, plinthH: 1.05, plinthW: 3.0, ...statueMat });
      qq.setFromEuler(new THREE.Euler(0, faceIn(fa), 0));
      const x = Math.cos(fa) * rr, z = Math.sin(fa) * rr;
      m.compose(new THREE.Vector3(x, 0, z), qq, one);
      batch.addTemplate(st, m, { name: 'statue.focal' });
      st.clear();
      G.keepOut.push({ x, z, r: 3.4 });
      G.slots.push({ x, z, w: 2.0, spread: 3.4 });
    }
    batch.build();
    G.focalAngle = fa;
  }

  // =========================================================================
  // BRAZIERS — placed on the light rig's own practicals wherever it can be done
  // =========================================================================
  _brazierAnchors(G) {
    const { f } = G;
    const ctx = this.ctx;
    const rig = ctx.lighting && ctx.lighting.rigDef;
    const list = (rig && rig.practicals) || [];
    const warm = list.filter((p) => { const c = new THREE.Color(p.color || '#ffa257'); return c.r >= c.b * 1.15; });
    const out = [];
    // one warm practical is reserved for the hanging bowl over the arena, so
    // the play space gets a modelling light instead of only a rim of fire
    const n = Math.max(4, (warm.length || 5) - 1);
    for (let i = 0; i < n; i++) {
      const src = warm[i];
      let a, r;
      if (src) {
        a = Math.atan2(src.pos[2], src.pos[0]);
        r = Math.hypot(src.pos[0], src.pos[2]);
      } else {
        a = 120 * DEG + (240 * DEG) * (i / n);
        r = this.bounds.r * 0.74;
      }
      // never in a doorway
      for (const d of this.doorAngles) {
        if (Math.abs(((a - d + Math.PI * 3) % TAU) - Math.PI) < 14 * DEG) a = d + 17 * DEG;
      }
      // Fire bowls light the rim from outside the collision boundary. They
      // remain visible and still own their practical lights, but no longer
      // occupy a point an enemy can be clamped against.
      r = this.radiusAt(a) + 0.9;
      out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, rad: 6.4, light: src ? i : -1 });
    }
    return out;
  }

  _buildBraziers(ctx, G) {
    const { B, kit, f } = G;
    const pools = G.pools || this._brazierAnchors(G);
    const batch = new Batcher(this.root);
    const template = kit.brazier({ h: 2.05, r: 0.74, plinth: true });
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const flameLocal = template.userData.flame.clone();
    pools.forEach((p, i) => {
      qq.setFromEuler(new THREE.Euler(0, f() * TAU, 0));
      m.compose(new THREE.Vector3(p.x, this.heightAt(p.x, p.z), p.z), qq, one);
      batch.addTemplate(template, m, { name: 'brazier' });
      G.flamePoints.push({
        x: p.x, y: this.heightAt(p.x, p.z) + flameLocal.y + 0.10, z: p.z,
        seed: (i * 0.371 + 0.13) % 1, scale: 1.0,
      });
      G.keepOut.push({ x: p.x, z: p.z, r: 2.0 });
      G.slots.push({ x: p.x, z: p.z, w: 0.7, spread: 2.8 });
    });
    // the hearth: squat, wide, low enough to read from a floor-level camera
    {
      const hb = kit.brazier({ h: 1.15, r: 1.05, plinth: true });
      const hm = new THREE.Matrix4(), hq = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, f() * TAU, 0));
      hm.compose(new THREE.Vector3(G.hearth.x, this.heightAt(G.hearth.x, G.hearth.z), G.hearth.z), hq, new THREE.Vector3(1, 1, 1));
      batch.addTemplate(hb, hm, { name: 'hearth' });
      G.flamePoints.push({
        x: G.hearth.x, y: this.heightAt(G.hearth.x, G.hearth.z) + hb.userData.flame.y + 0.08,
        z: G.hearth.z, seed: 0.83, scale: 1.0,
      });
      hb.clear();
      G.keepOut.push({ x: G.hearth.x, z: G.hearth.z, r: 2.6 });
      G.slots.push({ x: G.hearth.x, z: G.hearth.z, w: 0.8, spread: 3.0 });
    }
    batch.build();
    template.clear();

    // Move the rig's own warm practicals on to the braziers we actually built.
    // The rig authors COUNT and COLOUR; the room owns WHERE, because only the
    // room knows its plan. (Runtime light positioning only — never their file.)
    const rig = ctx.lighting;
    if (rig && rig._practicals) {
      const warm = rig._practicals.filter((l) => l.color && l.color.r >= l.color.b * 1.15);
      warm.forEach((l, i) => {
        if (i >= pools.length) {
          // the spare goes up on to the hanging bowl (its position is derived
          // from the same focal axis, so it lands wherever the bowl is hung)
          const fa = this.focalAngle, rr = this.bounds.r * 0.26;
          l.position.set(Math.cos(fa) * rr, 7.6, Math.sin(fa) * rr);
          l.distance = Math.max(l.distance, 16);
          return;
        }
        const p = pools[i];
        l.position.set(p.x, this.heightAt(p.x, p.z) + 2.35, p.z);
      });
      // the cool washes go up on to the wall / capitals of THIS room
      const cool = rig._practicals.filter((l) => !(l.color && l.color.r >= l.color.b * 1.15));
      const [wa0, wa1] = G.wallArc || [130 * DEG, 320 * DEG];
      // ── A WASH IS NOT LIGHTING (§11.2, §1.5 "ornament is concentrated on
      // focal architecture — never uniformly spammed") ─────────────────────
      // These were spread at even fractions of the wall arc regardless of their
      // authored intensity, so however the rig weighted them the room came out
      // lit like a corridor: one continuous band of equal value across the top
      // of every play frame, brightest wherever the arc happened to start. That
      // even band is precisely what the true-depth pass measured as inverted
      // aerial perspective — the strongest value in the frame sitting at its
      // edge instead of on the subject.
      // The lights are now sorted BRIGHTEST FIRST and placed by distance from
      // the focal gate, alternating either side of it. The room gets one lit
      // bay group behind the play space and falls away into dark wings toward
      // the camera, which is the composition §11 asks for and the reason the
      // focal ashlar (see _buildBackWall) is authored to catch the light.
      const seq = [0, -26 * DEG, 26 * DEG, -74 * DEG, 74 * DEG, -118 * DEG, 118 * DEG];
      const fa = this.focalAngle;
      const lo = wa0 + 7 * DEG, hi = wa1 - 7 * DEG;
      [...cool].sort((a, b) => b.intensity - a.intensity).forEach((l, i) => {
        let a = fa + (seq[i] ?? ((i % 2 ? 1 : -1) * 150 * DEG));
        while (a < lo - Math.PI) a += TAU;
        while (a > lo + Math.PI) a -= TAU;
        a = Math.min(Math.max(a, lo), Math.max(lo, hi));
        // STAND-OFF. The rig authors these at intensity 215-290 / distance 17,
        // numbers chosen when the plan was r=17. On a r=12.6 plan a 1.5m
        // stand-off puts a 265cd source a metre and a half off the masonry and
        // the bay panels blow to white. 3.4m back keeps the wash on the wall
        // and off its own hotspot.
        const rr = this.radiusAt(a) - 3.4;
        l.position.set(Math.cos(a) * rr, (G.wallH1 || 5.5) + 1.4 + (i % 2) * 2.2, Math.sin(a) * rr);
      });
    }
  }

  // =========================================================================
  // HANGINGS — banners, censers, wall sconces
  // =========================================================================
  _buildHangings(ctx, G) {
    const { B, kit, f } = G;
    const [wa0, wa1] = G.wallArc || [130 * DEG, 320 * DEG];
    const H1 = G.wallH1 || 5.5;
    const inOpening = (a) => this.doorAngles.some((d) => Math.abs(((a - d + Math.PI * 3) % TAU) - Math.PI) < 17 * DEG);

    // ---- banners hanging from the mid cornice ----------------------------
    const nB = B.props.banners;
    const variants = [0, 1, 2].map((i) => kit.banner({ w: 2.0, h: 4.6 + i * 0.5, sag: 0.22, wave: 0.18, seed: 0.13 + i * 0.29 }));
    for (let i = 0; i < nB; i++) {
      const a = wa0 + (wa1 - wa0) * ((i + 0.5) / nB);
      if (inOpening(a)) continue;
      const rr = this.radiusAt(a) - 0.1;
      const v = variants[i % 3];
      const g = v.clone(true);
      g.position.set(Math.cos(a) * rr, H1 + 0.30, Math.sin(a) * rr);
      g.rotation.y = faceIn(a);             // the painted face looks INTO the room
      g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.root.add(g);
      this.props.addSway(g, { amp: 0.020, rate: 0.36 + f() * 0.22, phase: f() * 10, axis: 'x', drift: 0.4 });
    }
    for (const v of variants) v.clear();

    // ---- THE HANGING BRAZIER over the arena -------------------------------
    // A chamber lit only from its rim has a dead middle: the play space gets no
    // modelling light, the floor emblem is a flat dark disc, and the character
    // has nothing above them to separate their crown from the ground. A great
    // chained bowl hanging off-axis over the arena fixes all three at once and
    // is about as Hades as an object gets. Its pool is registered with the
    // floor glaze, so the ground plane is painted around it.
    {
      const fa = G.focalAngle ?? Math.PI * 1.25;
      const hx = Math.cos(fa) * this.bounds.r * 0.26;
      const hz = Math.sin(fa) * this.bounds.r * 0.26;
      const hy = 7.4;
      G.hangPos = [hx, hy + 0.2, hz];
      const big = kit.censer({ drop: (G.wallTop || 14) - hy + 1.0, r: 1.05 });
      big.position.set(hx, hy, hz);
      // NOT a blanket traverse. kit.censer() deliberately ships its suspension
      // rods as a separate, NON-CASTING mesh (§7: a 5cm rod resolves to 1-2
      // shadow texels and lands as a hard aliased black staircase across
      // whatever is behind it — it did exactly that across the focal statue).
      // Turning castShadow on for every mesh in the group put it straight back.
      big.traverse((o) => { if (o.isMesh && o.name !== 'censer.susp') o.castShadow = true; });
      this.root.add(big);
      this.props.addSway(big, { amp: 0.022, rate: 0.24, phase: 3.1, axis: 'z', drift: 0.8 });
      G.flamePoints.push({ x: hx, y: hy + 0.55, z: hz, seed: 0.62, scale: 0.95 });
      // borrow a pooled practical if the rig has one spare
      ctx.lighting?.acquireLight?.({
        color: '#ffb070', intensity: 210, distance: 15, decay: 2.0,
        pos: [hx, hy + 0.2, hz], flicker: 0.34, speed: 0.63, kind: 'practical',
      });
    }

    // ---- censers hanging over the arena ----------------------------------
    const nC = B.props.censers;
    const cen = kit.censer({ drop: 3.4, r: 0.46 });
    for (let i = 0; i < nC; i++) {
      const a = wa0 + (wa1 - wa0) * ((i + 0.75) / (nC + 0.5));
      const rr = this.radiusAt(a) - 3.4;
      const g = cen.clone(true);
      const y = (G.wallTop || 12) - 3.9;
      g.position.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      // see the arena censer above: the suspension rods never cast
      g.traverse((o) => { if (o.isMesh && o.name !== 'censer.susp') o.castShadow = true; });
      this.root.add(g);
      this.props.addSway(g, { amp: 0.045, rate: 0.30 + f() * 0.2, phase: f() * 10, axis: 'z', drift: 0.7 });
      G.flamePoints.push({ x: Math.cos(a) * rr, y: y + 0.34, z: Math.sin(a) * rr, seed: (0.4 + i * 0.19) % 1, scale: 0.58 });
    }
    cen.clear();

    // ---- wall sconces flanking every door --------------------------------
    const sc = kit.sconce({ r: 0.42 });
    const batch = new Batcher(this.root);
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    // Outboard of the door piers (the opening is +-15deg and the piers reach
    // ~9deg), so a sconce is always mounted on solid masonry and never left
    // hanging in the middle of a threshold.
    const flameLocal = sc.userData.flame;
    for (const d of this.doorAngles) {
      for (const s of [-1, 1]) {
        const a = d + s * 20 * DEG;
        const rr = this.radiusAt(a) - 0.15;
        qq.setFromEuler(new THREE.Euler(0, faceIn(a), 0));
        const y = 3.5;
        m.compose(new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr), qq, one);
        batch.addTemplate(sc, m, { name: 'sconce' });
        const fr = rr - flameLocal.z;      // the bowl sits inboard of the plate
        G.flamePoints.push({
          x: Math.cos(a) * fr, y: y + flameLocal.y + 0.06, z: Math.sin(a) * fr,
          seed: Math.abs(Math.sin(a * 12.9898) * 43758.5453) % 1, scale: 0.42,
        });
      }
    }
    batch.build();
    sc.clear();
  }

  // =========================================================================
  // DOORS
  // =========================================================================
  _buildDoors(ctx, G) {
    const { kit, B, rng } = G;
    const anchors = this.doorAngles.map((a) => ({
      x: Math.cos(a) * (this.radiusAt(a) - 0.9),
      z: Math.sin(a) * (this.radiusAt(a) - 0.9),
      y: 0, angle: a, width: 4.0, height: 4.4,
    }));
    this.doors.build(ctx, kit, { anchors, biome: B, rng });
    for (const a of anchors) {
      G.keepOut.push({ x: a.x, z: a.z, r: 4.6 });
    }
    if (this._clearedPending) this.doors.setSealed(false);
  }

  // =========================================================================
  // SCATTER
  // =========================================================================
  _buildScatter(ctx, G) {
    // Three deliberately placed steles break the longest firing lanes. They
    // sit in the middle band, with broad gaps on every side, rather than among
    // perimeter architecture where knockback used to pin players and enemies.
    const { B } = G;
    const stone = this._M(B.mats.column, { variation: 0.22, litGain: 0.43, ambGain: 0.54, specGain: 1.05 });
    const trim = this._M(B.mats.leaf, { emissiveIntensity: 0.02, litGain: 0.36, ambGain: 0.42, specGain: 1.55 });
    const baseGeo = this._keep(new THREE.CylinderGeometry(1.02, 1.10, 0.28, 10));
    const bodyGeo = this._keep(new THREE.BoxGeometry(1.72, 2.30, 0.64));
    const capGeo = this._keep(new THREE.BoxGeometry(2.02, 0.24, 0.82));
    const blocks = (x, z, r) => G.keepOut.some(k => {
      const rr = r + (k.r || 0) + 0.55;
      return (x - k.x) * (x - k.x) + (z - k.z) * (z - k.z) < rr * rr;
    });
    let built = 0;
    for (let probe = 0; probe < 24 && built < 3; probe++) {
      const a = 0.32 + probe * (TAU / 24);
      const ring = 5.5 + (probe % 2) * 0.75;
      const x = Math.cos(a) * ring, z = Math.sin(a) * ring;
      if (!this.insideXZ(x, z, 3.0) || blocks(x, z, 1.02)) continue;
      const root = new THREE.Group();
      root.name = `combat.cover.${built + 1}`;
      root.position.set(x, this.heightAt(x, z), z);
      root.rotation.y = a + Math.PI * 0.5;
      const base = new THREE.Mesh(baseGeo, stone); base.position.y = 0.14;
      const body = new THREE.Mesh(bodyGeo, stone); body.position.y = 1.43;
      const cap = new THREE.Mesh(capGeo, trim); cap.position.y = 2.58;
      for (const m of [base, body, cap]) { m.castShadow = true; m.receiveShadow = true; }
      root.add(base, body, cap); this.root.add(root);
      this.colliders.push({ kind: 'circle', x, z, r: 1.02, combatCover: true });
      G.keepOut.push({ x, z, r: 1.85 });
      built++;
    }
  }

  // =========================================================================
  _finishColliders(ctx, G) {
    // Perimeter architecture remains non-solid so it cannot form knockback
    // traps. Only the sparse, explicitly tagged central firing cover survives.
    for (let i = this.colliders.length - 1; i >= 0; i--) {
      if (!this.colliders[i]?.combatCover) this.colliders.splice(i, 1);
    }
    // A coarse uniform grid so collide() and raycastWalk() stay O(1)-ish even
    // with a hundred solids in a hypostyle hall.
    const R = this.bounds.r + 4;
    const cell = 4;
    const n = Math.ceil((R * 2) / cell);
    const grid = new Array(n * n);
    for (let i = 0; i < grid.length; i++) grid[i] = null;
    const idx = (x, z) => {
      const ix = Math.min(n - 1, Math.max(0, Math.floor((x + R) / cell)));
      const iz = Math.min(n - 1, Math.max(0, Math.floor((z + R) / cell)));
      return iz * n + ix;
    };
    // Every collider kind has to publish a footprint or it never lands in the
    // grid and collide() silently ignores it — which is exactly how a solid
    // becomes a ghost. AABBs get their extents; circles get their radius.
    for (const c of this.colliders) {
      let x0, x1, z0, z1;
      if (c.kind === 'aabb') {
        x0 = Math.min(c.x0, c.x1) - 0.8; x1 = Math.max(c.x0, c.x1) + 0.8;
        z0 = Math.min(c.z0, c.z1) - 0.8; z1 = Math.max(c.z0, c.z1) + 0.8;
      } else {
        const r = (c.r ?? 1) + 0.8;
        x0 = c.x - r; x1 = c.x + r; z0 = c.z - r; z1 = c.z + r;
      }
      for (let x = x0; x <= x1 + cell * 0.5; x += cell * 0.5) {
        for (let z = z0; z <= z1 + cell * 0.5; z += cell * 0.5) {
          const k = idx(Math.min(x, x1), Math.min(z, z1));
          if (!grid[k]) grid[k] = [];
          if (grid[k].indexOf(c) < 0) grid[k].push(c);
        }
      }
    }
    this._grid = { grid, n, cell, R, idx };
  }

  // =========================================================================
  // QUERIES — the contract other systems call
  // =========================================================================
  /** Interpolated boundary radius at a world angle. */
  radiusAt(a) {
    const t = ((a % TAU) + TAU) % TAU / TAU * NA;
    const i0 = Math.floor(t) % NA, i1 = (i0 + 1) % NA, ft = t - Math.floor(t);
    return this.profile[i0] * (1 - ft) + this.profile[i1] * ft;
  }

  insideXZ(x, z, margin = 0) {
    const d = Math.hypot(x, z);
    if (d < 1e-4) return true;
    return d + margin <= this.radiusAt(Math.atan2(z, x));
  }

  /** Legacy contract — kept exactly, now shape-aware. */
  clampToArena(v3, radius = 0.4) {
    const d = Math.hypot(v3.x, v3.z);
    if (d < 1e-5) return v3;
    const r = this.radiusAt(Math.atan2(v3.z, v3.x)) - radius - 0.55;
    if (d > r) { const k = r / d; v3.x *= k; v3.z *= k; }
    return v3;
  }

  heightAt(x, z) {
    const d = this.dais;
    if (!d) return 0;
    const dx = x - (d.x || 0), dz = z - (d.z || 0);
    const r = Math.hypot(dx, dz);
    const steps = d.steps ?? 3;
    if (r > d.r + steps * 0.52) return 0;
    if (r <= d.r) return d.h;
    const k = Math.ceil((r - d.r) / 0.52);
    return d.h * Math.max(0, (steps - k + 1) / steps);
  }

  /**
   * collide(pos, radius) -> pos
   * Pushes `pos` out of every solid it overlaps, then clamps it inside the
   * arena boundary. Mutates and returns `pos` (a THREE.Vector3 or {x,z}).
   */
  collide(pos, radius = 0.4) {
    const g = this._grid;
    let list = this.colliders;
    if (g) {
      const cell = g.grid[g.idx(pos.x, pos.z)];
      list = cell || EMPTY;
    }
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.kind === 'aabb') {
        const cx = Math.max(c.x0, Math.min(pos.x, c.x1));
        const cz = Math.max(c.z0, Math.min(pos.z, c.z1));
        const dx = pos.x - cx, dz = pos.z - cz;
        const d = Math.hypot(dx, dz);
        if (d > 1e-5) {
          // outside the box: push along the shortest exit vector
          if (d < radius) { const k = (radius - d) / d; pos.x += dx * k; pos.z += dz * k; }
        } else {
          // INSIDE the box. Clamping to the nearest point returns the point
          // itself, so the naive push moves along an arbitrary axis and can
          // leave the body still inside — a body that spawns inside a solid
          // then walks through it. Eject through the nearest FACE instead.
          const ex0 = pos.x - c.x0, ex1 = c.x1 - pos.x;
          const ez0 = pos.z - c.z0, ez1 = c.z1 - pos.z;
          const m = Math.min(ex0, ex1, ez0, ez1);
          if (m === ex0) pos.x = c.x0 - radius;
          else if (m === ex1) pos.x = c.x1 + radius;
          else if (m === ez0) pos.z = c.z0 - radius;
          else pos.z = c.z1 + radius;
        }
      } else {
        const dx = pos.x - c.x, dz = pos.z - c.z;
        const rr = c.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          // An actor can materialise at the exact centre of a circular solid.
          // With a zero direction the usual radial push is also zero, leaving
          // it trapped forever; choose a deterministic exit in that one case.
          if (d2 < 1e-10) { pos.x = c.x + rr; pos.z = c.z; continue; }
          const d = Math.sqrt(d2);
          const k = (rr - d) / d;
          pos.x += dx * k; pos.z += dz * k;
        }
      }
    }
    this.clampToArena(pos, radius);
    return pos;
  }

  /**
   * raycastWalk(from, to, radius) -> {hit, t, point, normal}
   * Straight-line walkability for AI. `t` is the fraction of the segment that
   * is clear. Cheap: analytic against circles, sampled against the boundary.
   */
  raycastWalk(from, to, radius = 0.4) {
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    const out = { hit: false, t: 1, point: new THREE.Vector3(to.x, 0, to.z), normal: new THREE.Vector3(0, 0, 0) };
    if (len < 1e-5) return out;
    const ux = dx / len, uz = dz / len;
    let best = 1;
    let bn = null;
    for (const c of this.colliders) {
      if (c.kind === 'aabb') {
        // proper slab test against the box grown by `radius`. A bounding-circle
        // proxy reports a hit on any path that merely passes near a long thin
        // box, and an AI that believes it cannot walk down an open corridor is
        // worse than no walkability test at all.
        const x0 = c.x0 - radius, x1 = c.x1 + radius;
        const z0 = c.z0 - radius, z1 = c.z1 + radius;
        let tmin = 0, tmax = 1;
        let ok = true;
        for (const [o, dd, lo, hi] of [[from.x, dx, x0, x1], [from.z, dz, z0, z1]]) {
          if (Math.abs(dd) < 1e-6) { if (o < lo || o > hi) { ok = false; break; } continue; }
          let t0 = (lo - o) / dd, t1 = (hi - o) / dd;
          if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
          tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
          if (tmin > tmax) { ok = false; break; }
        }
        if (ok && tmin < best) {
          best = tmin;
          const mx = from.x + dx * tmin, mz = from.z + dz * tmin;
          bn = { x: mx - Math.max(c.x0, Math.min(mx, c.x1)), z: mz - Math.max(c.z0, Math.min(mz, c.z1)) };
          if (Math.abs(bn.x) < 1e-6 && Math.abs(bn.z) < 1e-6) bn = { x: -ux, z: -uz };
        }
        continue;
      }
      const cx = c.x, cz = c.z, cr = c.r;
      const R2 = cr + radius;
      const ox = from.x - cx, oz = from.z - cz;
      const b = ox * ux + oz * uz;
      const cc = ox * ox + oz * oz - R2 * R2;
      if (cc < 0) { best = 0; bn = { x: ox, z: oz }; break; }
      const disc = b * b - cc;
      if (disc <= 0) continue;
      const s = -b - Math.sqrt(disc);
      if (s >= 0 && s < len) {
        const t = s / len;
        if (t < best) {
          best = t;
          bn = { x: from.x + ux * s - cx, z: from.z + uz * s - cz };
        }
      }
    }
    // boundary
    const steps = Math.max(2, Math.ceil(len / 1.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (t > best) break;
      const x = from.x + dx * t, z = from.z + dz * t;
      if (!this.insideXZ(x, z, radius + 0.55)) {
        best = Math.max(0, (i - 1) / steps);
        bn = { x: -x, z: -z };
        break;
      }
    }
    out.t = best;
    out.hit = best < 0.999;
    out.point.set(from.x + dx * best, 0, from.z + dz * best);
    if (bn) {
      const l = Math.hypot(bn.x, bn.z) || 1;
      out.normal.set(bn.x / l, 0, bn.z / l);
    }
    return out;
  }

  /** All exits, for AGENT-RUN / AGENT-UI. */
  getExits() { return this.doors.getChoices(); }

  setCleared(v = true) {
    this._clearedPending = v;
    const snap = !!(this.ctx && (this.ctx.CAPTURE || this.ctx.capture));
    this.doors.setSealed(!v, snap);
    return this;
  }

  // =========================================================================
  // BIOME / LIFECYCLE
  // =========================================================================
  setBiome(name, ctx = this.ctx, opts = {}) {
    if (!BIOMES[name] || name === this.biome) return this;
    // Announce FIRST: the light rig retunes, publishes a new rim constant and
    // a new prefiltered sky, and re-authors its practicals — all of which
    // build() then reads while laying out the chamber.
    ctx?.events?.emit?.('biome.changed', { name });
    this.build(name, null, this.seed, opts);
    return this;
  }

  /** Swap to a fresh room of the same biome (chamber transition). */
  nextRoom(seed, archetype, opts = {}) {
    return this.build(this.biome, archetype || null, seed ?? (this.seed + 1), opts);
  }

  /**
   * Material lookup that survives a stubbed material system. ARCHITECTURE §6
   * ("code defensively against stubs") — the world is built during init and a
   * peer agent's half-written library must not take the whole game down with
   * it. Never ships an untextured grey (§7): the fallback is painted stone.
   */
  _M(name, opts) {
    const m = this.ctx && this.ctx.mats;
    // §1.2 / §9.6. render/lighting.js publishes rim.dir with a POSITIVE Z, which
    // at the shipping camera (yaw 45, pitch 50) projects onto SCREEN-LEFT — the
    // same side the key lights from. Adding the complement on top of the key
    // side just adds up to white, which is why measured cyan occupancy was
    // 3.8-6.5% against §9.6's 8% floor while the rim was nominally the second
    // strongest source in the frame. ENV_RIM_DIR moves it to the screen-RIGHT
    // contour, where the key is not, so every column arris, cornice lip and
    // statue edge in the room carries a genuinely saturated cool edge. The
    // shader's own ground-plane veto keeps it off the floor.
    const o2 = (opts && opts.rimDir) ? opts : { ...(opts || {}), rimDir: ENV_RIM_DIR };
    if (m && typeof m.get === 'function') {
      try { return m.get(name, o2); } catch (e) { /* fall through */ }
    }
    if (!this._fallbackMat) {
      this._fallbackMat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#5a2331'), roughness: 0.85, metalness: 0.05 });
      this._mats.push(this._fallbackMat);
    }
    return this._fallbackMat;
  }

  _keep(g) { this._geo.push(g); return g; }

  clear() {
    this.doors.dispose();
    this.props.dispose();
    for (const c of this.root.children.slice()) this.root.remove(c);
    for (const g of this._geo) g.dispose?.();
    this._geo.length = 0;
    for (const m of this._mats) m.dispose?.();
    this._mats.length = 0;
    if (this.kit) { this.kit.dispose(); this.kit = null; }
    this.colliders.length = 0;
    this._grid = null;
    this._built = false;
  }

  update(dt, ctx) {
    this.props.update(dt, ctx);
    this.doors.update(dt, ctx);
  }

  /**
   * ONE pump per rendered frame (update() runs per fixed sub-step, lateUpdate
   * does not). The budget breathes with the measured frame time: a frame that
   * is already over 20ms gets the minimum slice, a comfortable frame gets more,
   * so the build finishes fast on a fast machine without ever being the thing
   * that drops a frame on a slow one.
   */
  lateUpdate(alpha, ctx) {
    if (!this._task || this._task.done) return;
    const renderDt = (ctx && ctx.time && ctx.time.renderDt) ? ctx.time.renderDt * 1000 : 16.7;
    const slack = 16.7 - Math.min(16.7, renderDt);
    this._buildBudgetMs = Math.max(3, Math.min(6, 3 + slack * 0.35));
    this.sched.run(this._buildBudgetMs);
  }

  dispose() { this.sched.cancelAll(); this._task = null; this.clear(); this.doors.destroy?.(); }
}

const EMPTY = [];

export default World;
