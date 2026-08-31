// OWNER: AGENT-WORLD
// ---------------------------------------------------------------------------
// THE DRESSING LAYER — scatter, and everything in the chamber that MOVES.
//
// Two jobs:
//   1. `scatter()` — a deterministic, weighted, COMPOSITION-AWARE placer. It
//      refuses to put anything in the play area, keeps the focal wall heavy and
//      the centre empty (§1.8 "negative space is used, not filled"), and packs
//      every kind into one InstancedMesh per (geometry, material).
//   2. The animated props: guttering brazier flames, falling embers over the
//      abyss, swaying banners and chains, and drips off the arch keystones.
//
// Everything animated here is driven by ctx.time (never Date.now) and every
// random draw comes from the world RNG fork, so two runs of the capture harness
// are byte-identical.
//
// PERFORMANCE: flames are ONE instanced draw per layer for the whole chamber —
// the billboard is done in the vertex shader, not on the CPU. Embers and drips
// are single instanced quads animated entirely from a time uniform.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { TAU } from './kit.js';

// ---------------------------------------------------------------------------
// Flame — 3 layers (core / body / glow), instanced, Y-billboarded in the vertex
// shader, guttering on smoothed noise (never a sine). ART_DIRECTION §5.
// ---------------------------------------------------------------------------
const FLAME_VERT = /* glsl */`
  attribute float aSeed;
  attribute vec2 aScale;
  varying vec2 vUv;
  varying float vSeed;
  void main(){
    vUv = uv; vSeed = aSeed;
    vec4 o = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec3 wo = (modelMatrix * o).xyz;
    vec3 toCam = cameraPosition - wo; toCam.y = 0.0;
    float l = length(toCam);
    toCam = l > 1e-4 ? toCam / l : vec3(0.0, 0.0, 1.0);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 p = wo + right * (position.x * aScale.x) + vec3(0.0, 1.0, 0.0) * (position.y * aScale.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const FLAME_FRAG = /* glsl */`
  varying vec2 vUv; varying float vSeed;
  uniform float uTime, uLayer, uWidth, uAlpha;
  uniform vec3 uCore, uBody, uGlow;
  float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float n11(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(h11(i), h11(i + 1.0), f); }
  float flick(float t, float sp){
    return n11(t * 0.9 * sp) * 0.55 + n11(t * 4.7 * sp + 31.7) * 0.30 + n11(t * 13.3 * sp + 71.3) * 0.15;
  }
  void main(){
    float y = vUv.y;
    float fl  = flick(uTime + vSeed * 7.3, 1.0 + uLayer * 0.55);
    float fl2 = flick(uTime * 1.7 + vSeed * 3.1 + 11.0, 0.8);
    float sway = (fl - 0.5) * 0.30 * y * y + (fl2 - 0.5) * 0.10 * y;
    vec2 p = vec2(vUv.x - 0.5 - sway, y);
    float top = 0.62 + 0.38 * fl;
    float w = uWidth * pow(max(0.0, 1.0 - y / top), 0.58) * smoothstep(0.0, 0.09, y);
    float d  = abs(p.x) / max(w, 1e-3);
    float d2 = abs(p.x + (fl2 - 0.5) * 0.16 * y) / max(w * 0.42, 1e-3);
    float shape = smoothstep(1.06, 0.22, d);
    float lick  = smoothstep(1.0, 0.0, d2) * smoothstep(top, top * 0.22, y);
    float a = shape * smoothstep(top * 1.02, top * 0.52, y);
    vec3 c;
    if(uLayer < 0.5){
      c = uCore * (lick * 2.9 + a * 0.55) * smoothstep(0.55, 0.0, y);
    } else if(uLayer < 1.5){
      c = uBody * (a * 1.30 + lick * 0.55);
    } else {
      // GLOW — the same TONGUE, widened and blurred. A radial blob here is what
      // turned every brazier into a glowing egg: the halo has to be the shape of
      // the fire, or the fire stops reading as fire the moment bloom touches it.
      float g = smoothstep(2.05, 0.0, d) * smoothstep(top * 1.35, top * 0.10, y) * smoothstep(0.0, 0.20, y);
      c = uGlow * g * 0.55;
    }
    gl_FragColor = vec4(c * uAlpha, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Embers over the void: instanced quads on a looping vertical drift, entirely
// vertex-shader driven so 200 of them cost one draw call and zero CPU.
// ---------------------------------------------------------------------------
const EMBER_VERT = /* glsl */`
  attribute vec3 aOrigin;
  attribute vec3 aParam;     // x: phase, y: speed, z: size
  varying vec2 vUv; varying float vLife; varying float vSeed;
  uniform float uTime, uRise, uSpan, uStreak;
  void main(){
    vUv = uv; vSeed = aParam.x;
    float t = fract(aParam.x + uTime * aParam.y * 0.045);
    vLife = t;
    float dy = uRise > 0.5 ? (t * uSpan) : (-t * uSpan);
    vec3 wo = aOrigin;
    wo.y += dy;
    // a lazy horizontal wander so the field never reads as a falling grid
    wo.x += sin(t * 6.2831 * 1.3 + aParam.x * 31.0) * 0.9 * (1.0 - uStreak);
    wo.z += cos(t * 6.2831 * 1.1 + aParam.x * 17.0) * 0.9 * (1.0 - uStreak);
    vec3 toCam = cameraPosition - wo;
    float l = length(toCam);
    toCam = l > 1e-4 ? toCam / l : vec3(0.0, 0.0, 1.0);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    vec3 up = normalize(cross(toCam, right));
    float s = aParam.z * (0.35 + 0.65 * sin(t * 3.14159));
    // uStreak stretches the quad vertically and kills the horizontal wander:
    // an ember drifts, a drip FALLS, and the difference is entirely in shape
    // an ember is a moving object: it is longer along its travel than across it
    vec3 p = wo + right * (position.x * s * mix(0.44, 0.22, uStreak))
                + up * (position.y * s * mix(1.15, 5.0, uStreak));
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const EMBER_FRAG = /* glsl */`
  varying vec2 vUv; varying float vLife; varying float vSeed;
  uniform vec3 uHot, uCool;
  void main(){
    // §7 bans "particles that are obvious round white dots" and §5.2 asks for a
    // three-layer construction. The previous build measured as a scatter of
    // small round warm dots across the floor, which is exactly the banned read.
    // NOW: the sprite is anisotropic — squashed across the direction of travel
    // and drawn out along it at ~2.6:1 — with a near-white CORE at ~20% of the
    // sprite, a saturated BODY in the ember hue, and a wide low-alpha GLOW.
    vec2 p = vUv - 0.5;
    vec2 q = vec2(p.x * 2.6, p.y);          // motion-aligned elongation
    float r = length(q) * 2.0;
    float tail = exp(-max(0.0, (p.y + 0.06)) * 6.0);
    float core = pow(max(0.0, 1.0 - r * 4.4), 2.0);          // tiny, near-white
    float body = pow(max(0.0, 1.0 - r * 1.7), 2.4);          // saturated hue
    float glow = pow(max(0.0, 1.0 - r * 0.92), 3.0) * 0.30;  // wide, faint
    float fade = sin(vLife * 3.14159);
    vec3 c = mix(uCool, uHot, clamp(body * 1.6, 0.0, 1.0));
    c = mix(c, mix(c, vec3(1.0), 0.65), clamp(core * 2.2, 0.0, 1.0));
    float a = (core * 0.9 + body * 1.05 + glow * tail) * fade;
    gl_FragColor = vec4(c * a * 1.35, 1.0);
  }
`;

export class Props {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'props';
    this.flames = null;
    this.embers = null;
    this._mats = [];
    this._geo = [];
    this._sway = [];       // {obj, amp, rate, phase, axis}
    this._lights = [];
    this._t = 0;
    // ── WHY THE SHADER MATERIALS ARE POOLED ────────────────────────────────
    // Every chamber mints a fresh ShaderMaterial for each of the three flame
    // layers and one for the ember field, and dispose() destroyed them on the
    // way out. Disposing a ShaderMaterial drops three.js' refcount on its
    // PROGRAM to zero, so the driver throws the compiled shader away and the
    // next chamber recompiles it from source — a synchronous driver stall
    // landing on the first frame of a room transition, which is the frame that
    // can least afford one. (Under a software rasteriser one program is tens of
    // seconds; on a real GPU it is single-digit milliseconds, but it is a
    // hitch either way and it is entirely avoidable.)
    // The uniform VALUES differ per chamber; the programs do not. So the
    // materials are recycled across chambers exactly as world/doors.js does,
    // and only their uniforms are re-stamped. `destroy()` is the real teardown.
    this._shaderPool = { 'flame0': [], 'flame1': [], 'flame2': [], ember: [] };
    this._shaderLive = [];
  }

  /**
   * Take a ShaderMaterial of `kind` out of the pool (or mint one), stamped with
   * this chamber's uniform values. See the constructor note.
   */
  _shaderMat(kind, vertexShader, fragmentShader, params, values) {
    const pool = this._shaderPool[kind] || (this._shaderPool[kind] = []);
    let m = pool.pop();
    if (!m) {
      const uniforms = {};
      for (const k in values) {
        const v = values[k];
        uniforms[k] = { value: (v && v.isColor) ? v.clone() : v };
      }
      m = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, ...params });
      m.userData.poolKind = kind;
    } else {
      for (const k in values) {
        const u = m.uniforms[k], v = values[k];
        if (!u) { m.uniforms[k] = { value: (v && v.isColor) ? v.clone() : v }; continue; }
        if (u.value && u.value.isColor && v && v.isColor) u.value.copy(v);
        else u.value = v;
      }
    }
    this._shaderLive.push(m);
    return m;
  }

  // =========================================================================
  // DETERMINISTIC WEIGHTED SCATTER
  // =========================================================================
  /**
   * scatter(kit, opts)
   *   slots    : [{x, z, w}]  candidate anchors with a placement weight
   *   mix      : { kindName: weight }
   *   count    : how many pieces to place
   *   keepOut  : [{x, z, r}]  circles nothing may intersect (play lanes, doors)
   *   root     : where to add the InstancedMeshes
   *
   * Everything of one kind lands in ONE InstancedMesh. Returns the colliders
   * the chamber should register for the pieces big enough to block movement.
   */
  scatter(kit, opts = {}) {
    const rng = opts.rng;
    const f = rng && rng.f ? () => rng.f() : () => 0.5;
    const slots = opts.slots || [];
    const mix = opts.mix || { chunk: 1 };
    const total = Math.max(0, Math.round(opts.count ?? 40));
    const keepOut = opts.keepOut || [];
    const root = opts.root || this.root;
    if (!slots.length || !total) return [];

    const kinds = Object.keys(mix);
    const wsum = kinds.reduce((s, k) => s + mix[k], 0) || 1;

    // budget per kind, then a fixed set of geometry variants per kind so no two
    // neighbours share a silhouette but the draw-call count stays flat
    const VARIANTS = 3;
    const colliders = [];
    const placed = [];

    for (const kind of kinds) {
      const n = Math.max(0, Math.round(total * (mix[kind] / wsum)));
      if (!n) continue;
      const cfg = KIND_CFG[kind] || KIND_CFG.chunk;
      for (let v = 0; v < VARIANTS; v++) {
        const share = Math.floor(n / VARIANTS) + (v < n % VARIANTS ? 1 : 0);
        if (!share) continue;
        const geo = kit.rubbleGeo(kind, v, cfg.geo || {});
        const mat = kit.mat(cfg.mat || 'rubble',
          cfg.mat === 'bone' ? { tint: cfg.tint, variation: 0.22, specGain: 0.5 }
            : (v === 1 && cfg.tint) ? { tint: cfg.tint, variation: 0.28 } : { variation: 0.18 });
        const im = kit.instancer(geo, mat, share, { name: 'prop.' + kind });
        const bbMin = (geo.boundingBox && geo.boundingBox.min.y) || 0;
        let tries = 0;
        while (im.count < share && tries < share * 40) {
          tries++;
          // weighted slot draw
          let r = f() * slots.reduce((s, sl) => s + sl.w, 0);
          let sl = slots[0];
          for (const s of slots) { r -= s.w; if (r <= 0) { sl = s; break; } }
          const jr = (f() - 0.5) * (sl.spread ?? 2.2);
          const ja = f() * TAU;
          const x = sl.x + Math.cos(ja) * Math.abs(jr);
          const z = sl.z + Math.sin(ja) * Math.abs(jr);
          const sc = cfg.scale[0] + f() * (cfg.scale[1] - cfg.scale[0]);
          const rad = (cfg.radius ?? 0.5) * sc;
          let ok = true;
          for (const k of keepOut) {
            const dx = x - k.x, dz = z - k.z;
            if (dx * dx + dz * dz < (k.r + rad) * (k.r + rad)) { ok = false; break; }
          }
          if (ok && opts.inside && !opts.inside(x, z, rad)) ok = false;
          if (ok) {
            for (const p of placed) {
              const dx = x - p.x, dz = z - p.z;
              if (dx * dx + dz * dz < (p.r + rad) * (p.r + rad) * 0.55) { ok = false; break; }
            }
          }
          if (!ok) continue;
          const y = -bbMin * sc - 0.02 + (cfg.sink ?? 0);
          im.userData.push(x, y, z, f() * TAU, sc, (f() - 0.5) * (cfg.tilt ?? 0.10), (f() - 0.5) * (cfg.tilt ?? 0.10));
          placed.push({ x, z, r: rad });
          if (cfg.blocks) colliders.push({ kind: 'circle', x, z, r: rad * 0.8 });
        }
        if (im.count > 0) { im.userData.finish(); root.add(im); }
      }
    }
    return colliders;
  }

  // =========================================================================
  // FLAMES
  // =========================================================================
  /**
   * flameField(points, opts) — points are world-space flame anchors.
   * One instanced draw per layer. Also asks the light rig for a pooled
   * practical per point (and copes with the budget being spent).
   */
  flameField(ctx, points, opts = {}) {
    if (!points.length) return null;
    const core = opts.core || '#fff0b0';
    const body = opts.body || '#ff8c1a';
    const glow = opts.glow || '#c22a06';
    const scale = opts.scale ?? 1;
    const g = new THREE.Group();
    g.name = 'flames';
    // ART_DIRECTION §7 bans "bloom fog across the entire frame". The first pass
    // at these numbers put a 2.5m-square additive glow quad on fourteen flames
    // and every brazier became a pink balloon that swallowed the architecture
    // it was supposed to light. The GLOW is now narrow and weak; the read comes
    // from the BODY and the tiny near-white CORE, which is where §5 puts it.
    // ── ROUND-4: A FLAME IS toneMapped:false, SO IT IS THE ONE THING IN THE
    // FRAME THE GRADE CANNOT PULL BACK. ─────────────────────────────────────
    // Diagnostic (live page, every painterly material in the room crushed to
    // 0.25x diffuse): the brightest background block LEFT in the money shot was
    // a flame body at 0.561 display, at the top edge, out-valuing the hero.
    // The braziers stand on the perimeter, so their flames land in the top band
    // of every play framing and the eye goes there instead of to the subject.
    // §5 puts the read on a tiny near-white CORE with a saturated body behind
    // it, so the core keeps its alpha and the BODY — the big warm mass that was
    // doing the damage — comes down and in. Height comes down with it: a 2m
    // flame on a 2m brazier is a bonfire, not a lamp.
    // ...and the CORE comes back UP after measuring the first cut: bands.highlight
    // fell 0.027 -> 0.017 on the money shot, and \u00a79.3 names flame as one of the
    // four legitimate sources of the highlight band. The near-white core is
    // exactly that source \u2014 a few hundred hot pixels, not a wide warm mass \u2014 so
    // it is the one layer that should have gone UP while the body came down.
    const layers = [
      { L: 2, w: 0.52, a: 0.042, wide: 0.90 * scale, tall: 1.74 * scale, core, body, glow },
      { L: 1, w: 0.32, a: 0.40, wide: 0.62 * scale, tall: 1.58 * scale, core, body, glow },
      { L: 0, w: 0.22, a: 1.42, wide: 0.44 * scale, tall: 1.34 * scale, core, body: '#ffc24a', glow },
    ];
    const mats = [];
    layers.forEach((cfg, li) => {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.translate(0, 0.5, 0);
      this._geo.push(geo);
      const mat = this._shaderMat('flame' + li, FLAME_VERT, FLAME_FRAG, {
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }, {
        uTime: 0,
        uCore: new THREE.Color(cfg.core),
        uBody: new THREE.Color(cfg.body),
        uGlow: new THREE.Color(cfg.glow),
        uLayer: cfg.L, uWidth: cfg.w, uAlpha: cfg.a,
      });
      mats.push(mat);
      const im = new THREE.InstancedMesh(geo, mat, points.length);
      im.name = 'flame.layer' + li;
      im.frustumCulled = false;
      im.renderOrder = 6 + li;
      const seeds = new Float32Array(points.length);
      const scales = new Float32Array(points.length * 2);
      const m = new THREE.Matrix4();
      points.forEach((p, i) => {
        m.makeTranslation(p.x, p.y, p.z);
        im.setMatrixAt(i, m);
        seeds[i] = (p.seed ?? i * 0.37) % 1;
        scales[i * 2] = cfg.wide * (p.scale ?? 1);
        scales[i * 2 + 1] = cfg.tall * (p.scale ?? 1);
      });
      im.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      im.geometry.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 2));
      im.instanceMatrix.needsUpdate = true;
      g.add(im);
    });
    this.root.add(g);
    this.flames = { group: g, mats };
    return this.flames;
  }

  /** Ask the rig for a pooled practical at each flame it can afford. */
  bindLights(ctx, points, opts = {}) {
    const L = ctx.lighting;
    if (!L || !L.acquireLight) return;
    for (const p of points) {
      if (typeof L.freeLights === 'number' && L.freeLights <= 0) break;
      const l = L.acquireLight({
        color: opts.color || '#ffb070',
        intensity: opts.intensity ?? 150,
        distance: opts.distance ?? 10,
        decay: 2.0,
        pos: [p.x, p.y + 0.2, p.z],
        flicker: 0.42, speed: 0.7 + (p.seed ?? 0) * 0.8, kind: 'practical',
      });
      if (l) this._lights.push(l);
    }
  }

  // =========================================================================
  // EMBERS OVER THE VOID
  // =========================================================================
  emberField(ctx, opts = {}) {
    const n = Math.max(0, Math.round(opts.count ?? 120));
    if (!n) return null;
    const rng = opts.rng;
    const f = rng && rng.f ? () => rng.f() : () => 0.5;
    const geo = new THREE.PlaneGeometry(1, 1);
    this._geo.push(geo);
    const mat = this._shaderMat('ember', EMBER_VERT, EMBER_FRAG, {
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, side: THREE.DoubleSide, toneMapped: false,
    }, {
      uTime: 0,
      uHot: new THREE.Color(opts.color || '#ff8a44'),
      uCool: new THREE.Color(opts.accent || '#5fd0ff'),
      uRise: opts.rise ? 1 : 0,
      uSpan: opts.span ?? 16,
      uStreak: opts.streak ? 1 : 0,
    });
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.name = opts.name || 'void.embers';
    im.frustumCulled = false;
    im.renderOrder = 5;
    const origin = new Float32Array(n * 3), param = new Float32Array(n * 3);
    const m = new THREE.Matrix4();
    const rIn = opts.rIn ?? 8, rOut = opts.rOut ?? 30;
    const yBase = opts.yBase ?? -1.0;
    // DISTRIBUTION. Two consecutive draws from the world's LCG are correlated
    // enough that `(angle, radius) = (f(), f())` laid the whole field out on a
    // lattice: the shipped frames carried two long, evenly-spaced DOTTED LINES
    // of embers running across the void, which reads as a bug, not as air.
    // Golden-angle spacing with a stratified radius is deterministic, uses one
    // draw per ember for jitter only, and scatters properly.
    for (let i = 0; i < n; i++) {
      // STRATIFIED ANGLE, RANDOM RADIUS. Drawing (angle, radius) as two
      // consecutive LCG values laid the field on a lattice and the shipped
      // frames carried long evenly-spaced DOTTED LINES of particles across the
      // arena. Golden-angle spacing removes the lattice but substitutes
      // phyllotaxis parastichies, which are lines too. One jittered sector per
      // particle with an independent radius has neither.
      const a = ((i + f()) / n) * TAU;
      const r = rIn + (rOut - rIn) * Math.sqrt(f());
      origin[i * 3] = Math.cos(a) * r;
      origin[i * 3 + 1] = yBase - f() * (opts.spread ?? 10);
      origin[i * 3 + 2] = Math.sin(a) * r;
      param[i * 3] = f();
      param[i * 3 + 1] = 0.55 + f() * 1.15;
      param[i * 3 + 2] = 0.13 + f() * 0.30;
      im.setMatrixAt(i, m.identity());
    }
    im.geometry.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
    im.geometry.setAttribute('aParam', new THREE.InstancedBufferAttribute(param, 3));
    im.instanceMatrix.needsUpdate = true;
    this.root.add(im);
    const field = { mesh: im, mat };
    if (opts.streak) { (this.drips = this.drips || []).push(field); }
    else this.embers = field;
    return field;
  }

  // =========================================================================
  // SWAY — banners, chains, censers
  // =========================================================================
  /** Register an Object3D to sway on smoothed noise. Cheap; CPU, few objects. */
  addSway(obj, opts = {}) {
    this._sway.push({
      obj,
      amp: opts.amp ?? 0.035,
      rate: opts.rate ?? 0.45,
      phase: opts.phase ?? 0,
      axis: opts.axis || 'z',
      base: obj.rotation.clone(),
      drift: opts.drift ?? 0.6,
    });
    return obj;
  }

  // =========================================================================
  update(dt, ctx) {
    this._t = (ctx && ctx.time && ctx.time.t) || (this._t + dt);
    if (this.flames) for (const m of this.flames.mats) m.uniforms.uTime.value = this._t;
    if (this.embers) this.embers.mat.uniforms.uTime.value = this._t;
    if (this.drips) for (const d of this.drips) d.mat.uniforms.uTime.value = this._t;
    for (const s of this._sway) {
      // two incommensurate rates: never a clean pendulum
      const a = Math.sin(this._t * s.rate + s.phase) * 0.68
        + Math.sin(this._t * s.rate * 2.37 + s.phase * 1.7) * 0.32;
      const b = Math.sin(this._t * s.rate * 0.61 + s.phase * 2.3);
      if (s.axis === 'z') { s.obj.rotation.z = s.base.z + a * s.amp; s.obj.rotation.x = s.base.x + b * s.amp * s.drift; }
      else if (s.axis === 'x') { s.obj.rotation.x = s.base.x + a * s.amp; s.obj.rotation.z = s.base.z + b * s.amp * s.drift; }
      else { s.obj.rotation.y = s.base.y + a * s.amp; }
    }
  }

  /**
   * Tear the dressing down between chambers. The animated-prop ShaderMaterials
   * are RECYCLED rather than disposed so their compiled programs survive the
   * transition — see the constructor note. `destroy()` is the real teardown.
   */
  dispose() {
    const L = this.ctx && this.ctx.lighting;
    for (const l of this._lights) { try { L && L.releaseLight && L.releaseLight(l); } catch (e) { /* rig may be gone */ } }
    this._lights.length = 0;
    for (const m of this._shaderLive) {
      const kind = m.userData.poolKind;
      (this._shaderPool[kind] || (this._shaderPool[kind] = [])).push(m);
    }
    this._shaderLive.length = 0;
    for (const m of this._mats) m.dispose?.();
    for (const g of this._geo) g.dispose?.();
    this._mats.length = 0; this._geo.length = 0;
    this._sway.length = 0;
    this.flames = null; this.embers = null; this.drips = null;
    this.root.clear();
  }

  /** Final teardown (page unload / world dispose): free the pooled programs. */
  destroy() {
    this.dispose();
    for (const kind in this._shaderPool) {
      for (const m of this._shaderPool[kind]) m.dispose?.();
      this._shaderPool[kind].length = 0;
    }
    return this;
  }
}

// Per-kind placement rules. `blocks` marks the pieces big enough that the
// player should collide with them rather than walk through.
const KIND_CFG = {
  chunk:   { mat: 'rubble', scale: [0.65, 1.35], radius: 0.42, tilt: 0.14, tint: '#c3a094' },
  slab:    { mat: 'rubble', scale: [0.75, 1.30], radius: 0.85, tilt: 0.20, sink: -0.04 },
  drum:    { mat: 'rubble', scale: [0.85, 1.25], radius: 0.62, tilt: 0.06, blocks: true },
  urn:     { mat: 'ceramic', scale: [0.78, 1.10], radius: 0.40, tilt: 0.05 },
  bones:   { mat: 'bone',   scale: [0.80, 1.30], radius: 0.44, tilt: 0.04, tint: '#cfc0a2' },
  capital: { mat: 'rubble', scale: [0.85, 1.20], radius: 0.66, tilt: 0.05, blocks: true },
};

export default Props;
