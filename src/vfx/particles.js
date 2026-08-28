// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// Pooled, instanced particle system.
//
//  * SoA state arrays, allocated once. Zero allocation per frame, zero GC.
//  * Two instanced batches share one program: ADDITIVE (the glow half of §5)
//    and ALPHA (the painted-smoke half). One draw call each.
//  * Colour over life runs through a real multi-stop RAMP baked to a LUT — not
//    a two-colour lerp, which is what makes VFX go muddy through the middle.
//  * Size over life is an authored 8-key curve, ease-out by default (§5 motion).
//  * Curl turbulence from a cheap divergence-free trig field.
//  * SOFT PARTICLES: analytic depth fade against the arena ground plane, done
//    per fragment from the camera ray, so nothing shows a hard intersection
//    line where a spray meets the floor. This costs no depth prepass and no
//    extra render target — for a 3/4 game whose particles live on a flat stage
//    it is exactly equivalent, and it stays correct in the capture harness
//    (which sets the camera pose AFTER lateUpdate has already run).
//  * Sub-frame spawn interpolation: a burst emitted along a moving transform
//    lays its particles down the swept path and back-integrates each one by its
//    fractional age, so a fast emitter streaks instead of clumping.
//  * Hard cap with graceful degradation: when the pool is full the oldest,
//    faintest particle is recycled rather than dropping the new spawn.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { rampAt } from '../materials/palette.js';
import { SHAPE, GRID, shapeAtlas, ATLAS_UV_GLSL } from './shapes.js';

const RAMP_N = 24;                      // colour LUT resolution
const CURVE_N = 9;                      // size curve keys

// ── per-instance layout ────────────────────────────────────────────────────
const F_POS = 3, F_VEL = 4, F_COL = 4, F_PAR = 4;

const VERT = /* glsl */`
precision highp float;
attribute vec3 iPos;
attribute vec4 iVel;      // xyz velocity, w = stretch amount (0 = billboard-rotate)
attribute vec4 iCol;      // rgb tint, a = opacity
attribute vec4 iPar;      // x size, y rotation, z atlas cell, w core boost
varying vec4 vCol;
varying vec2 vUv;
varying float vCore;
varying vec3 vWPos;
uniform vec2 uGrid;
${ATLAS_UV_GLSL}
void main(){
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec2 q = position.xy;
  vec2 dir;
  float sx = 1.0;
  if(iVel.w > 0.0){
    // velocity-aligned streak: orient in SCREEN space along the projected
    // velocity and stretch by speed. This is what makes sparks read as sparks.
    vec2 sv = vec2(dot(iVel.xyz, right), dot(iVel.xyz, up));
    float L = length(sv);
    dir = L > 1e-4 ? sv / L : vec2(1.0, 0.0);
    sx = 1.0 + iVel.w * min(L, 22.0);
  } else {
    dir = vec2(cos(iPar.y), sin(iPar.y));
  }
  vec2 o = vec2(dir.x * q.x * sx - dir.y * q.y, dir.y * q.x * sx + dir.x * q.y) * iPar.x;
  vec3 wp = iPos + right * o.x + up * o.y;
  vWPos = wp;
  vCol = iCol;
  vCore = iPar.w;
  vUv = atlasUV(position.xy + 0.5, iPar.z, uGrid);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uAtlas;
uniform float uSoft;      // world units of soft-particle fade
uniform float uGroundY;
uniform float uNear;
uniform float uGain;
varying vec4 vCol;
varying vec2 vUv;
varying float vCore;
varying vec3 vWPos;
void main(){
  vec4 t = texture2D(uAtlas, vUv);
  float a = vCol.a;
  // ── soft particles: fade where the sprite would cut the ground plane ──
  vec3 rd = vWPos - cameraPosition;
  float len = length(rd);
  rd /= max(len, 1e-4);
  if(rd.y < -1e-3){
    float tg = (uGroundY - cameraPosition.y) / rd.y;
    a *= clamp((tg - len) / uSoft, 0.0, 1.0);
  }
  a *= clamp((len - uNear) * 1.6, 0.0, 1.0);
  if(a <= 0.002) discard;
#ifdef ALPHA_BLEND
  vec3 c = vCol.rgb * (0.42 + 0.58 * t.r) + vec3(1.0) * t.g * vCore * 0.45;
  gl_FragColor = vec4(c, t.a * a);
#else
  // HDR LAYER GAINS. The post stack's bloom gate sits ~1.5 in scene-linear, so
  // the CORE (tiny) is pushed to ~3.0 and blooms hot, the BODY sits just over
  // the gate and blooms gently, and the wide GLOW stays UNDER it and never
  // blooms at all. That is how the frame gets a highlight band (§9.3) without
  // the bloom fog §7 bans.
  vec3 c = vCol.rgb * t.r * (1.30 * uGain)
         + vec3(1.0) * t.g * vCore * (2.60 * uGain)
         + vCol.rgb * t.b * (0.26 * uGain);
  gl_FragColor = vec4(c, a);
#endif
}`;

// ---------------------------------------------------------------------------
class Batch {
  constructor(cap, additive, atlas) {
    this.cap = cap;
    this.n = 0;
    this.iPos = new Float32Array(cap * F_POS);
    this.iVel = new Float32Array(cap * F_VEL);
    this.iCol = new Float32Array(cap * F_COL);
    this.iPar = new Float32Array(cap * F_PAR);

    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (arr, c) => { const a = new THREE.InstancedBufferAttribute(arr, c); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(this.iPos, F_POS); this.aVel = mk(this.iVel, F_VEL);
    this.aCol = mk(this.iCol, F_COL); this.aPar = mk(this.iPar, F_PAR);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iVel', this.aVel);
    g.setAttribute('iCol', this.aCol); g.setAttribute('iPar', this.aPar);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: (additive ? '' : '#define ALPHA_BLEND\n') + FRAG,
      uniforms: {
        uAtlas: { value: atlas },
        uGrid: { value: new THREE.Vector2(GRID, GRID) },
        uSoft: { value: 0.85 },
        uGroundY: { value: 0.0 },
        uNear: { value: 0.35 },
        uGain: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 30 : 26;
    this.mesh.name = additive ? 'vfx.particles.add' : 'vfx.particles.alpha';
    this.geo = g;
  }
  reset() { this.n = 0; }
  push(x, y, z, vx, vy, vz, stretch, r, g, b, a, size, rot, cell, core) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    let o = i * 3; this.iPos[o] = x; this.iPos[o + 1] = y; this.iPos[o + 2] = z;
    o = i * 4; this.iVel[o] = vx; this.iVel[o + 1] = vy; this.iVel[o + 2] = vz; this.iVel[o + 3] = stretch;
    this.iCol[o] = r; this.iCol[o + 1] = g; this.iCol[o + 2] = b; this.iCol[o + 3] = a;
    this.iPar[o] = size; this.iPar[o + 1] = rot; this.iPar[o + 2] = cell; this.iPar[o + 3] = core;
  }
  flush() {
    const n = this.n;
    this.geo.instanceCount = n;
    if (n === 0) return;
    const up = (a, c) => {
      if (a.clearUpdateRanges) { a.clearUpdateRanges(); a.addUpdateRange(0, n * c); }
      a.needsUpdate = true;
    };
    up(this.aPos, F_POS); up(this.aVel, F_VEL); up(this.aCol, F_COL); up(this.aPar, F_PAR);
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------------------
/** A curl-ish, divergence-light trig field. Cheap, smooth, tileless. */
function curl(x, y, z, t, o) {
  const a = 0.62, b = 0.47;
  o.x = Math.sin(y * a + t * 1.10) * Math.cos(z * b - t * 0.37);
  o.y = Math.sin(z * a - t * 0.83) * Math.cos(x * b + t * 0.51);
  o.z = Math.sin(x * a + t * 0.66) * Math.cos(y * b - t * 0.92);
}
const _curl = { x: 0, y: 0, z: 0 };
const _C = new THREE.Color();

const easeOut = (t) => 1 - Math.pow(1 - t, 2.2);

/** Bake a ramp (array of {t,c}) into a flat rgba LUT. */
function bakeRamp(stops, alpha) {
  const lut = new Float32Array(RAMP_N * 4);
  for (let i = 0; i < RAMP_N; i++) {
    const t = i / (RAMP_N - 1);
    const c = rampAt(stops, t);
    lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = alpha ? sampleCurve(alpha, t) : 1;
  }
  return lut;
}
function bakeCurve(keys) {
  const c = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) c[i] = sampleKeys(keys, i / (CURVE_N - 1));
  return c;
}
function sampleKeys(keys, t) {
  // keys: [[t,v], ...] sorted
  if (!keys || !keys.length) return 1;
  if (t <= keys[0][0]) return keys[0][1];
  const n = keys.length;
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0; while (i < n - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1];
  const k = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * (k * k * (3 - 2 * k));
}
function sampleCurve(curve, t) {
  const x = Math.min(0.99999, Math.max(0, t)) * (CURVE_N - 1);
  const i = x | 0, f = x - i;
  return curve[i] + (curve[i + 1] - curve[i]) * f;
}

// ---------------------------------------------------------------------------
export class Particles {
  constructor(opts = {}) {
    const cap = opts.cap ?? 2400;
    this.cap = cap;
    // SoA state
    this.px = new Float32Array(cap); this.py = new Float32Array(cap); this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.age = new Float32Array(cap); this.life = new Float32Array(cap);
    this.rot = new Float32Array(cap); this.rotV = new Float32Array(cap);
    this.sizeJ = new Float32Array(cap); this.seed = new Float32Array(cap);
    this.def = new Int16Array(cap);
    this.alive = new Uint8Array(cap);
    // per-particle tint override, hue-normalised so it never darkens the ramp
    this.tr = new Float32Array(cap).fill(1);
    this.tg = new Float32Array(cap).fill(1);
    this.tb = new Float32Array(cap).fill(1);
    this.count = 0;
    this.free = new Int32Array(cap);
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
    this.freeN = cap;
    this.defs = [];
    this.byName = new Map();
    this.dropped = 0;
  }

  init(ctx, root, rng) {
    this.ctx = ctx;
    if (rng) this.rng = rng;
    const atlas = shapeAtlas();
    const tier = (ctx.quality && ctx.quality.tier) || 'high';
    const scale = tier === 'low' ? 0.35 : tier === 'med' ? 0.6 : 1;
    this.addB = new Batch(Math.round(this.cap * 0.8 * scale), true, atlas);
    this.alphaB = new Batch(Math.round(this.cap * 0.3 * scale), false, atlas);
    root.add(this.addB.mesh); root.add(this.alphaB.mesh);
    return this;
  }

  /**
   * Register a particle definition (an "emitter recipe").
   * @param {string} name
   * @param {object} d
   *   shape        atlas cell (SHAPE.*)
   *   ramp         [{t,c}] colour ramp — the BODY colour over life
   *   alpha        [[t,v]] opacity curve over life
   *   size         [[t,v]] size multiplier over life
   *   size0/size1  base size range (world units)
   *   life         [min,max] seconds
   *   speed        [min,max] initial speed
   *   emit         'cone'|'sphere'|'disc'|'ring'|'box'|'edge'
   *   spread       cone half-angle (radians) / disc radius
   *   gravity      world units/s²  (positive pulls down)
   *   drag         per-second exponential damping
   *   turb         curl amplitude
   *   turbFreq     curl time scale
   *   rotVel       [min,max] rad/s
   *   stretch      >0 = velocity-aligned streak, value scales length by speed
   *   core         core (near-white) boost 0..2
   *   additive     bool (default true)
   *   bounce       0..1 floor restitution (0 = off)
   *   floorY       ground height for bounce
   */
  define(name, d) {
    const def = {
      name,
      shape: d.shape ?? SHAPE.diamond,
      lut: bakeRamp(d.ramp || [{ t: 0, c: '#ffffff' }, { t: 1, c: '#ffffff' }],
        bakeCurve(d.alpha || [[0, 1], [0.72, 0.9], [1, 0]])),
      sizeC: bakeCurve(d.size || [[0, 0.35], [0.14, 1], [1, 0.22]]),
      // ── §7 "particles that are obvious round white dots" ───────────────
      // The old defaults were size0 0.22 / size1 0.42 — a 1.9x band sampled
      // UNIFORMLY, which in practice means every particle in a spray lands
      // within a hair of the same on-screen radius. Add a shared alpha curve
      // with no per-particle variance and the population becomes N copies of
      // one disc: the frames shipped strings of identical circles that read
      // as a debug path visualiser, not as air.
      //
      // Three independent variates fix it, and they have to be independent or
      // the population still marches in step:
      //   sizeSkew  — the band is now 7x wide and sampled through pow(u, k),
      //               so most particles are small and a few are large. That is
      //               what a real spray looks like; a uniform band is not.
      //   aVar      — per-particle opacity multiplier, uniform 1-aVar .. 1,
      //               so brightness varies BETWEEN particles and not only
      //               along one shared life curve.
      //   coreVar   — per-particle hot-core boost, decorrelated from both.
      size0: d.size0 ?? 0.05, size1: d.size1 ?? 0.34,
      sizeSkew: d.sizeSkew ?? 2.1,
      aVar: d.aVar ?? 0.72,
      coreVar: d.coreVar ?? 0.85,
      life0: (d.life && d.life[0]) ?? 0.35, life1: (d.life && d.life[1]) ?? 0.6,
      spd0: (d.speed && d.speed[0]) ?? 2, spd1: (d.speed && d.speed[1]) ?? 5,
      emit: d.emit || 'sphere',
      spread: d.spread ?? 0.6,
      gravity: d.gravity ?? 0,
      drag: d.drag ?? 2.0,
      turb: d.turb ?? 0,
      turbFreq: d.turbFreq ?? 1,
      rot0: (d.rotVel && d.rotVel[0]) ?? -2, rot1: (d.rotVel && d.rotVel[1]) ?? 2,
      stretch: d.stretch ?? 0,
      core: d.core ?? 1,
      additive: d.additive !== false,
      bounce: d.bounce ?? 0,
      floorY: d.floorY ?? 0.02,
      opacity: d.opacity ?? 1,
    };
    def.id = this.defs.length;
    this.defs.push(def);
    this.byName.set(name, def);
    return def;
  }

  get(name) { return this.byName.get(name); }

  _alloc() {
    if (this.freeN > 0) return this.free[--this.freeN];
    // graceful degradation: steal the particle closest to death
    let best = -1, bestU = -1;
    for (let i = 0; i < this.cap; i += 7) {          // sparse scan, O(1)-ish
      if (!this.alive[i]) continue;
      const u = this.age[i] / this.life[i];
      if (u > bestU) { bestU = u; best = i; }
    }
    this.dropped++;
    return best;
  }

  /**
   * Emit `n` particles.
   * @param {object|string} def  definition or its name
   * @param {number} n
   * @param {object} o  { x,y,z, dx,dy,dz (direction), px,py,pz (previous origin
   *                      for sub-frame interpolation), speed, size, spread,
   *                      color (override tint), dt }
   */
  emit(def, n, o) {
    const D = typeof def === 'string' ? this.byName.get(def) : def;
    if (!D || n <= 0) return;
    const rng = this.rng || (this.rng = this.ctx.rng.fork('vfx.particles'));
    const ox = o.x || 0, oy = o.y || 0, oz = o.z || 0;
    const hasPrev = o.px !== undefined;
    const dx = o.dx ?? 0, dy = o.dy ?? 1, dz = o.dz ?? 0;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / dl, ay = dy / dl, az = dz / dl;
    // orthonormal basis about the emit axis
    let ux = 0, uy = 0, uz = 0;
    if (Math.abs(ay) < 0.92) { ux = -az; uy = 0; uz = ax; } else { ux = 1; uy = 0; uz = 0; }
    let ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const wx = ay * uz - az * uy, wy = az * ux - ax * uz, wz = ax * uy - ay * ux;
    const spread = o.spread ?? D.spread;
    const sub = o.dt ?? 0;
    let tr = 1, tg = 1, tb = 1;
    if (o.color) {
      const c = _C.set(o.color);
      const m = Math.max(c.r, c.g, c.b, 1e-3);
      tr = c.r / m; tg = c.g / m; tb = c.b / m;
      // keep a floor so a strongly hued tint never kills the near-white core
      tr = 0.18 + 0.82 * tr; tg = 0.18 + 0.82 * tg; tb = 0.18 + 0.82 * tb;
    }

    for (let k = 0; k < n; k++) {
      const i = this._alloc();
      if (i < 0) return;
      this.alive[i] = 1;
      this.def[i] = D.id;
      const f = n > 1 ? k / n : 0;               // sub-frame fraction
      let sx = ox, sy = oy, sz = oz;
      if (hasPrev) { sx = o.px + (ox - o.px) * f; sy = o.py + (oy - o.py) * f; sz = o.pz + (oz - o.pz) * f; }

      // ── emission shape ──
      let px = 0, py = 0, pz = 0, vxx = ax, vyy = ay, vzz = az;
      const r1 = rng.f(), r2 = rng.f();
      if (D.emit === 'cone') {
        const a = r1 * Math.PI * 2, s = Math.sin(spread * Math.sqrt(r2)), c = Math.cos(spread * Math.sqrt(r2));
        const cs = Math.cos(a) * s, sn = Math.sin(a) * s;
        vxx = ax * c + ux * cs + wx * sn; vyy = ay * c + uy * cs + wy * sn; vzz = az * c + uz * cs + wz * sn;
      } else if (D.emit === 'disc' || D.emit === 'ring') {
        const a = r1 * Math.PI * 2;
        const rr = D.emit === 'ring' ? spread * (0.88 + 0.12 * r2) : spread * Math.sqrt(r2);
        px = (ux * Math.cos(a) + wx * Math.sin(a)) * rr;
        py = (uy * Math.cos(a) + wy * Math.sin(a)) * rr;
        pz = (uz * Math.cos(a) + wz * Math.sin(a)) * rr;
        const l = Math.hypot(px, py, pz) || 1;
        vxx = px / l; vyy = py / l; vzz = pz / l;
      } else if (D.emit === 'box') {
        px = (r1 - 0.5) * spread * 2; py = (rng.f() - 0.5) * spread * 2; pz = (r2 - 0.5) * spread * 2;
      } else if (D.emit === 'edge') {
        // a line along the emit axis — for slash trails and beams
        const t = r1;
        px = ax * spread * (t - 0.5) * 2; py = ay * spread * (t - 0.5) * 2; pz = az * spread * (t - 0.5) * 2;
        vxx = ux * (rng.f() - 0.5) * 2 + ay; vyy = 0.7 + rng.f() * 0.6; vzz = wz * (rng.f() - 0.5) * 2;
        const l = Math.hypot(vxx, vyy, vzz) || 1; vxx /= l; vyy /= l; vzz /= l;
      } else {
        const a = r1 * Math.PI * 2, z = r2 * 2 - 1, s = Math.sqrt(1 - z * z);
        vxx = Math.cos(a) * s; vyy = z * (0.55 + 0.45 * spread); vzz = Math.sin(a) * s;
        const l = Math.hypot(vxx, vyy, vzz) || 1; vxx /= l; vyy /= l; vzz /= l;
      }

      // SPEED: the def's band, widened by a skewed jitter. A band alone leaves
      // the population travelling as a shell; a long tail is what lets a few
      // particles outrun the rest and break the arriving-in-lockstep read.
      const spd = (o.speed ?? 1) * rng.range(D.spd0, D.spd1) * (0.55 + 1.05 * rng.f() * rng.f());
      this.px[i] = sx + px; this.py[i] = sy + py; this.pz[i] = sz + pz;
      this.vx[i] = vxx * spd + (o.vx || 0); this.vy[i] = vyy * spd + (o.vy || 0); this.vz[i] = vzz * spd + (o.vz || 0);
      this.age[i] = sub * (1 - f);              // sub-frame back-integration
      this.life[i] = rng.range(D.life0, D.life1) * (o.lifeMul ?? 1);
      this.rot[i] = rng.range(0, Math.PI * 2);
      this.rotV[i] = rng.range(D.rot0, D.rot1);
      // SKEWED size draw (see define()): pow() pushes the mass of the
      // population toward size0 and leaves a thin tail of big ones, so a spray
      // has a silhouette instead of a cadence.
      const su = rng.f();
      this.sizeJ[i] = (D.size0 + (D.size1 - D.size0) * (su <= 0 ? 0 : Math.pow(su, D.sizeSkew))) * (o.size ?? 1);
      this.seed[i] = rng.f();
      // life jitter ON TOP of the def's own [life0,life1] band: two particles
      // born on the same frame must not die on the same frame, or the whole
      // spray blinks out together and the eye reads a scripted sequence.
      this.life[i] *= 0.72 + rng.f() * 0.56;
      this.tr[i] = tr; this.tg[i] = tg; this.tb[i] = tb;
      // advance by the sub-frame age so a fast emitter streaks
      if (this.age[i] > 0) {
        const a2 = this.age[i];
        this.px[i] += this.vx[i] * a2; this.py[i] += this.vy[i] * a2; this.pz[i] += this.vz[i] * a2;
      }
      this.count++;
    }
  }

  update(dt, t) {
    const cap = this.cap;
    for (let i = 0; i < cap; i++) {
      if (!this.alive[i]) continue;
      const D = this.defs[this.def[i]];
      let a = this.age[i] + dt;
      if (a >= this.life[i]) {
        this.alive[i] = 0; this.count--;
        if (this.freeN < cap) this.free[this.freeN++] = i;
        continue;
      }
      this.age[i] = a;
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      if (D.turb > 0) {
        curl(this.px[i] * D.turbFreq, this.py[i] * D.turbFreq, this.pz[i] * D.turbFreq, t + this.seed[i] * 6.28, _curl);
        vx += _curl.x * D.turb * dt; vy += _curl.y * D.turb * dt; vz += _curl.z * D.turb * dt;
      }
      vy -= D.gravity * dt;
      const k = 1 - Math.min(0.95, D.drag * dt);
      vx *= k; vy *= k; vz *= k;
      let px = this.px[i] + vx * dt, py = this.py[i] + vy * dt, pz = this.pz[i] + vz * dt;
      if (D.bounce > 0 && py < D.floorY && vy < 0) { py = D.floorY; vy = -vy * D.bounce; vx *= 0.72; vz *= 0.72; }
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.px[i] = px; this.py[i] = py; this.pz[i] = pz;
      this.rot[i] += this.rotV[i] * dt;
    }
  }

  /** Fill the instance buffers. Camera-independent — safe with the capture harness. */
  flush() {
    const A = this.addB, B = this.alphaB;
    A.reset(); B.reset();
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const D = this.defs[this.def[i]];
      const u = this.age[i] / this.life[i];
      const x = Math.min(0.99999, Math.max(0, u)) * (RAMP_N - 1);
      const j = x | 0, f = x - j, o = j * 4, o2 = o + 4;
      const lut = D.lut;
      const r = (lut[o] + (lut[o2] - lut[o]) * f) * this.tr[i];
      const g = (lut[o + 1] + (lut[o2 + 1] - lut[o + 1]) * f) * this.tg[i];
      const b = (lut[o + 2] + (lut[o2 + 2] - lut[o + 2]) * f) * this.tb[i];
      // PER-PARTICLE BRIGHTNESS. `lut` is one alpha curve shared by the whole
      // definition, so without this every live particle of an emitter sits at
      // exactly the same opacity for its age — the thing that made a spray
      // read as a row of stamped circles. seed is uniform [0,1); a second,
      // decorrelated variate is pulled out of it by a golden-ratio rotation
      // so size, alpha and core never move together.
      const sd = this.seed[i];
      const sd2 = (sd * 1.6180339887 + 0.5) % 1;
      const al = (lut[o + 3] + (lut[o2 + 3] - lut[o + 3]) * f) * D.opacity
        * ((1 - D.aVar) + D.aVar * sd);
      if (al <= 0.004) continue;
      const size = this.sizeJ[i] * sampleCurve(D.sizeC, u);
      const core = D.core * (1 - u * 0.75) * (1 - D.coreVar * 0.5 + D.coreVar * sd2);
      const tgt = D.additive ? A : B;
      tgt.push(this.px[i], this.py[i], this.pz[i],
        this.vx[i], this.vy[i], this.vz[i], D.stretch,
        r, g, b, al, size, this.rot[i], D.shape, core);
    }
    A.flush(); B.flush();
  }

  setSoft(v) { this.addB.mat.uniforms.uSoft.value = v; this.alphaB.mat.uniforms.uSoft.value = v; }
  setGroundY(v) { this.addB.mat.uniforms.uGroundY.value = v; this.alphaB.mat.uniforms.uGroundY.value = v; }

  clear() {
    for (let i = 0; i < this.cap; i++) this.alive[i] = 0;
    this.freeN = this.cap;
    for (let i = 0; i < this.cap; i++) this.free[i] = this.cap - 1 - i;
    this.count = 0;
    this.addB.reset(); this.alphaB.reset(); this.addB.flush(); this.alphaB.flush();
  }

  dispose() { this.addB.dispose(); this.alphaB.dispose(); }
}

export { easeOut, sampleKeys };
export default Particles;
