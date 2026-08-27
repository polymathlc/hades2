// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// The MESH effects — the things that must read as SHAPES at 1/8 resolution
// (ART_DIRECTION §5 "silhouette first"):
//
//   Rings    ground-plane shockwaves and AOE telegraphs. A real annulus lying
//            on the stage, not a billboard, so it reads as *ground* in 3/4.
//   Slashes  the money effect. A swept crescent RIBBON generated along the
//            actual swing arc: bright leading edge, saturated body, fading
//            tail, wiped on with a head/tail reveal so it draws itself.
//   Beams    core + glow + scrolling energy + end caps, cylindrically
//            billboarded in the vertex shader so it is camera-correct at draw
//            time (the capture harness poses the camera after lateUpdate).
//
// Every camera-dependent term is evaluated in a shader, never on the CPU.
// Every pool is fixed size and allocated at init.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const TAU = Math.PI * 2;
const easeOut = (t) => 1 - Math.pow(1 - t, 2.4);
const easeIn = (t) => t * t;

// ═══════════════════════════════════════════════════════════ RING ═════════
const RING_VERT = /* glsl */`
varying vec2 vUv;
uniform float uScale;
void main(){
  vUv = uv;
  vec3 p = position * vec3(uScale, 1.0, uScale);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const RING_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uSeed;
uniform float uThick;   // 0..1 fraction of the band that is lit
uniform float uCoreAmt;
uniform float uPhase;   // where the wave is strongest
void main(){
  float v = vUv.y;                    // 0 inner .. 1 outer
  float a = vUv.x;                    // around
  // hand-drawn wobble so the ring is never a perfect CAD circle
  float wob = 1.0 + 0.05 * sin(a * TAU_ * 5.0 + uSeed) + 0.03 * sin(a * TAU_ * 9.0 - uSeed * 1.7);
  float t = clamp(uThick * wob, 0.04, 1.0);
  // the leading (outer) edge is hard; the trailing wash is soft — a shockwave
  // has a direction and the falloff has to show it.
  float e = (1.0 - v) / max(t, 1e-3);
  float body = pow(smoothstep(1.0, 0.06, e), 1.9) * smoothstep(-0.02, 0.05, v);
  float core = smoothstep(0.30, 0.10, e) * smoothstep(0.01, 0.07, e);
  float glow = smoothstep(2.0, 0.0, e) * 0.16;
  // a real shockwave is not uniform: it is strongest on the side it travelled
  float sweep = 0.52 + 0.48 * pow(0.5 + 0.5 * cos((a - uPhase) * TAU_), 0.7);
  float bank = (0.88 + 0.12 * sin(a * TAU_ * 3.0 + uSeed * 2.3)) * sweep;
  vec3 c = uColor * body * bank * 1.45 + uCore * core * uCoreAmt * bank * 2.40 + uColor * glow * bank * 0.30;
  gl_FragColor = vec4(c, uOpacity);
}`.replace(/TAU_/g, '6.28318530718');

function ringGeometry(seg = 96) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array((seg + 1) * 2 * 3);
  const uv = new Float32Array((seg + 1) * 2 * 2);
  const idx = [];
  const INNER = 0.30;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * TAU, c = Math.cos(a), s = Math.sin(a);
    let o = (i * 2) * 3;
    pos[o] = c * INNER; pos[o + 1] = 0; pos[o + 2] = s * INNER;
    pos[o + 3] = c; pos[o + 4] = 0; pos[o + 5] = s;
    o = (i * 2) * 2;
    uv[o] = i / seg; uv[o + 1] = 0; uv[o + 2] = i / seg; uv[o + 3] = 1;
    if (i < seg) {
      const b = i * 2;
      idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  return g;
}

export class Rings {
  constructor(n = 14) {
    this.geo = ringGeometry(96);
    this.pool = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color('#ffb070') },
          uCore: { value: new THREE.Color('#fff6e0') },
          uOpacity: { value: 0 }, uSeed: { value: i * 1.7 },
          uThick: { value: 0.35 }, uScale: { value: 1 }, uCoreAmt: { value: 1 },
          uPhase: { value: 0 },
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(this.geo, mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = 28;
      m.name = 'vfx.ring' + i;
      this.pool.push({ mesh: m, mat, live: false, t: 0, life: 1, r0: 1, r1: 3, op: 1, thick: 0.35, ease: 2.4, tilt: 0 });
    }
  }
  addTo(root) { for (const p of this.pool) root.add(p.mesh); return this; }

  spawn(x, y, z, o = {}) {
    let s = null, oldest = this.pool[0];
    for (const p of this.pool) { if (!p.live) { s = p; break; } if (p.t / p.life > oldest.t / oldest.life) oldest = p; }
    if (!s) s = oldest;
    s.live = true; s.t = 0;
    s.life = o.life ?? 0.42;
    s.r0 = o.r0 ?? (o.radius ?? 2) * 0.18;
    s.r1 = o.radius ?? 2;
    s.op = o.opacity ?? 1;
    s.thick = o.thick ?? 0.34;
    s.ease = o.ease ?? 2.4;
    s.coreAmt = o.coreAmt ?? 1;
    s.hold = o.hold ?? 0;
    s.mesh.position.set(x, y ?? 0.03, z);
    s.mesh.rotation.set(0, o.rot ?? 0, 0);
    if (o.tiltX) s.mesh.rotation.x = o.tiltX;
    s.mat.uniforms.uColor.value.set(o.color || '#ffb070');
    s.mat.uniforms.uCore.value.set(o.core || '#fff6e0');
    s.mat.uniforms.uCoreAmt.value = s.coreAmt;
    s.mat.uniforms.uPhase.value = o.phase ?? 0;
    s.mat.uniforms.uThick.value = s.thick;
    s.mat.uniforms.uScale.value = s.r0;
    s.mat.uniforms.uOpacity.value = s.op;
    s.mesh.visible = true;
    return s;
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.live) continue;
      p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) { p.live = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; continue; }
      const e = 1 - Math.pow(1 - u, p.ease);
      const r = p.r0 + (p.r1 - p.r0) * e;
      p.mat.uniforms.uScale.value = r;
      // fade late, and thin the band as it expands so energy is conserved
      const fade = p.hold > 0 && u < p.hold ? 1 : Math.pow(1 - Math.max(0, (u - p.hold) / (1 - p.hold)), 1.7);
      p.mat.uniforms.uOpacity.value = p.op * fade;
      p.mat.uniforms.uThick.value = p.thick * (1 - 0.55 * e);
    }
  }
  clear() { for (const p of this.pool) { p.live = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; } }
  dispose() { this.geo.dispose(); for (const p of this.pool) p.mat.dispose(); }
}

// ══════════════════════════════════════════════════════════ SLASH ═════════
// A swept crescent ribbon. The geometry is the swing arc; the shading is the
// §5 three-layer construction across the ribbon's width.
const SLASH_SEG = 34;

const SLASH_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SLASH_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;      // saturated body
uniform vec3 uCore;       // near-white core
uniform vec3 uGlow;       // wide low-alpha halo
uniform float uHead;      // reveal front, 0..1 along the arc
uniform float uTail;      // erase back
uniform float uOpacity;
uniform float uSeed;
void main(){
  float u = vUv.x;          // along the arc (0 = swing start)
  float v = vUv.y;          // across the ribbon (0 = inner/trailing, 1 = leading edge)

  // ── the wipe: the arc draws itself on, then dissolves from the back ──
  float on  = smoothstep(uHead, uHead - 0.20, u);
  float off = smoothstep(uTail - 0.26, uTail + 0.02, u);
  float a = on * off;
  if(a <= 0.001) discard;

  // ── cross-section: glow (wide) / body (saturated) / core (thin, hot) ──
  // The mass is packed against the LEADING edge and washes out toward the
  // inner edge. An evenly-filled ribbon reads as a saucer from a 3/4 camera;
  // a crescent is a bright arc with a trailing wash behind it.
  float glow = pow(clamp(v, 0.0, 1.0), 2.0) * (1.0 - smoothstep(0.97, 1.0, v));
  float body = pow(clamp(v, 0.0, 1.0), 5.2) * (1.0 - smoothstep(0.94, 0.998, v));
  float core = smoothstep(0.855, 0.925, v) * (1.0 - smoothstep(0.955, 0.996, v));

  // taper to points at both tips of the arc
  float tap = pow(max(0.0, sin(u * 3.14159265)), 0.45);
  // brush streaks along the sweep — this is what stops it reading as plastic
  float streak = 0.78 + 0.22 * sin(u * 41.0 + uSeed) * sin(v * 7.0 - uSeed * 0.7);
  // the leading tip of the wipe is hottest
  float hot = smoothstep(uHead - 0.30, uHead, u);

  // §5 three layers, weighted for the HDR bloom gate: glow under it, body just
  // over it, core far over it. The core band is ~6% of the ribbon's width.
  vec3 c = uGlow * glow * 0.13
         + uColor * body * streak * (1.28 + hot * 0.80)
         + uCore * core * (2.30 + hot * 2.60);
  gl_FragColor = vec4(c * a * tap * uOpacity, 1.0);
}`;

export class Slashes {
  constructor(n = 8) {
    this.pool = [];
    for (let i = 0; i < n; i++) {
      const g = new THREE.BufferGeometry();
      const V = (SLASH_SEG + 1) * 2;
      const pos = new Float32Array(V * 3);
      const uv = new Float32Array(V * 2);
      const idx = new Uint16Array(SLASH_SEG * 6);
      for (let s = 0; s < SLASH_SEG; s++) {
        const b = s * 2, o = s * 6;
        idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 3;
        idx[o + 3] = b; idx[o + 4] = b + 3; idx[o + 5] = b + 2;
      }
      for (let s = 0; s <= SLASH_SEG; s++) {
        const t = s / SLASH_SEG, o = s * 4;
        uv[o] = t; uv[o + 1] = 0; uv[o + 2] = t; uv[o + 3] = 1;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
      const mat = new THREE.ShaderMaterial({
        vertexShader: SLASH_VERT, fragmentShader: SLASH_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color('#ffd27a') },
          uCore: { value: new THREE.Color('#fffdf0') },
          uGlow: { value: new THREE.Color('#ff9a3c') },
          uHead: { value: 0 }, uTail: { value: -1 }, uOpacity: { value: 0 },
          uSeed: { value: i * 2.3 },
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = 32;
      m.name = 'vfx.slash' + i;
      this.pool.push({ mesh: m, mat, geo: g, pos, live: false, t: 0, life: 0.3, op: 1 });
    }
  }
  addTo(root) { for (const p of this.pool) root.add(p.mesh); return this; }

  /**
   * Build the ribbon along the swing arc.
   * origin: pivot (world). dir: forward (unit, XZ). arc: degrees. radius, width.
   * bank: how far the blade plane is rolled out of horizontal (radians).
   * rise: vertical travel across the swing (world units, +start -> -end).
   */
  spawn(origin, dir, o = {}) {
    let s = null, oldest = this.pool[0];
    for (const p of this.pool) { if (!p.live) { s = p; break; } if (p.t / p.life > oldest.t / oldest.life) oldest = p; }
    if (!s) s = oldest;
    const arc = (o.arc ?? 130) * Math.PI / 180;
    const R = o.radius ?? 2.2;
    const W = (o.width ?? 0.45) * R;
    const bank = o.bank ?? 0.55;
    const rise = o.rise ?? R * 0.30;
    const spin = o.spin ?? 1;                    // +1 sweeps left->right
    const fy = o.y ?? 0;
    let fx = dir.x ?? 0, fz = dir.z ?? (dir.y ?? 0);
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const pos = s.pos;
    const cb = Math.cos(bank), sb = Math.sin(bank);
    for (let i = 0; i <= SLASH_SEG; i++) {
      const u = i / SLASH_SEG;
      const th = (-arc * 0.5 + arc * u) * spin;
      const c = Math.cos(th), sn = Math.sin(th);
      // forward rotated about Y
      const dx = fx * c - fz * sn, dz = fx * sn + fz * c;
      // the arc bulges: a real swing reaches furthest at the middle
      const r = R * (0.80 + 0.20 * Math.pow(Math.sin(u * Math.PI), 0.6));
      const y = fy + rise * (0.5 - u) * 1.4 + rise * 0.35 * Math.sin(u * Math.PI);
      const w = W * Math.pow(Math.max(0, Math.sin(u * Math.PI)), 0.55);
      // cross-section direction: radial rolled by `bank` toward vertical
      const nx = dx * cb, nz = dz * cb, ny = sb;
      const cx = origin.x + dx * r, cy = y, cz = origin.z + dz * r;
      const o1 = i * 6;
      pos[o1] = cx - nx * w * 0.5; pos[o1 + 1] = cy - ny * w * 0.5; pos[o1 + 2] = cz - nz * w * 0.5;
      pos[o1 + 3] = cx + nx * w * 0.5; pos[o1 + 4] = cy + ny * w * 0.5; pos[o1 + 5] = cz + nz * w * 0.5;
    }
    s.geo.attributes.position.needsUpdate = true;
    s.live = true; s.t = 0;
    s.life = o.life ?? 0.30;
    s.op = o.opacity ?? 1;
    s.mat.uniforms.uColor.value.set(o.color || '#ffd27a');
    s.mat.uniforms.uCore.value.set(o.core || '#fffdf0');
    s.mat.uniforms.uGlow.value.set(o.glow || o.color || '#ff9a3c');
    s.mat.uniforms.uHead.value = 0;
    s.mat.uniforms.uTail.value = -0.3;
    s.mat.uniforms.uOpacity.value = s.op;
    s.mesh.visible = true;
    return s;
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.live) continue;
      p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) { p.live = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; continue; }
      // fast in (the blade outruns the eye), slow out (the trail lingers)
      p.mat.uniforms.uHead.value = Math.pow(Math.min(1, u / 0.32), 0.62) * 1.30;
      p.mat.uniforms.uTail.value = -0.30 + 1.75 * Math.pow(Math.max(0, (u - 0.28) / 0.72), 1.35);
      p.mat.uniforms.uOpacity.value = p.op * (u < 0.18 ? 0.55 + 0.45 * (u / 0.18) : Math.pow(1 - (u - 0.18) / 0.82, 1.1));
    }
  }
  clear() { for (const p of this.pool) { p.live = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; } }
  dispose() { for (const p of this.pool) { p.geo.dispose(); p.mat.dispose(); } }
}

// ═══════════════════════════════════════════════════════════ BEAM ═════════
const BEAM_VERT = /* glsl */`
varying vec2 vUv;
uniform vec3 uA;
uniform vec3 uB;
uniform float uW;
void main(){
  vUv = uv;
  vec3 T = uB - uA;
  float L = length(T);
  T = L > 1e-4 ? T / L : vec3(1.0, 0.0, 0.0);
  vec3 P = mix(uA, uB, uv.x);
  vec3 V = normalize(P - cameraPosition);
  vec3 S = cross(T, V);
  float sl = length(S);
  S = sl > 1e-4 ? S / sl : vec3(0.0, 1.0, 0.0);
  // taper the ends so the beam has a nose, not a cut
  float taper = pow(max(0.0, sin(uv.x * 3.14159265)), 0.22);
  P += S * (uv.y * 2.0 - 1.0) * uW * taper;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const BEAM_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uT;
uniform float uSeed;
void main(){
  float v = abs(vUv.y * 2.0 - 1.0);
  float u = vUv.x;
  float core = pow(max(0.0, 1.0 - v / 0.11), 1.8);
  float body = pow(max(0.0, 1.0 - v / 0.70), 1.7);
  float glow = pow(max(0.0, 1.0 - v), 3.2) * 0.40;
  // scrolling energy — chevrons racing toward the far end
  float e = sin(u * 34.0 - uT * 26.0 + uSeed) * 0.5 + 0.5;
  float e2 = sin(u * 13.0 - uT * 11.0 - uSeed * 1.3) * 0.5 + 0.5;
  float energy = pow(e, 3.0) * 0.55 + pow(e2, 4.0) * 0.45;
  // end caps: a bright bloom at both terminals
  float cap = pow(max(0.0, 1.0 - u / 0.11), 2.2) + pow(max(0.0, 1.0 - (1.0 - u) / 0.14), 2.2);
  // the shaft loses energy toward the far terminal so it does not read as a
  // ruled line with two hard ends
  float run = mix(1.0, 0.45, smoothstep(0.15, 1.0, u));
  vec3 c = uColor * (body * (0.78 + 0.70 * energy) * run + glow * 0.40 * run)
         + uCore * (core * (0.30 + 0.34 * energy) * run + cap * 0.34 * (1.0 - v * 0.7));
  gl_FragColor = vec4(c * uOpacity, 1.0);
}`;

export class Beams {
  constructor(n = 4, seg = 28) {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array((seg + 1) * 2 * 3);
    const uv = new Float32Array((seg + 1) * 2 * 2);
    const idx = [];
    for (let i = 0; i <= seg; i++) {
      const t = i / seg, o = i * 4;
      uv[o] = t; uv[o + 1] = 0; uv[o + 2] = t; uv[o + 3] = 1;
      if (i < seg) { const b = i * 2; idx.push(b, b + 1, b + 3, b, b + 3, b + 2); }
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.geo = g;
    this.pool = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
        uniforms: {
          uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3(0, 1, 0) },
          uW: { value: 0.2 }, uColor: { value: new THREE.Color('#8ef0d0') },
          uCore: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0 },
          uT: { value: 0 }, uSeed: { value: i * 1.9 },
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = 31;
      m.name = 'vfx.beam' + i;
      this.pool.push({ mesh: m, mat, live: false, t: 0, life: 1, op: 1, w: 0.2 });
    }
  }
  addTo(root) { for (const p of this.pool) root.add(p.mesh); return this; }

  spawn(a, b, o = {}) {
    let s = null, oldest = this.pool[0];
    for (const p of this.pool) { if (!p.live) { s = p; break; } if (p.t / p.life > oldest.t / oldest.life) oldest = p; }
    if (!s) s = oldest;
    s.live = true; s.t = 0;
    s.life = o.life ?? 0.45;
    s.op = o.opacity ?? 1;
    s.w = o.width ?? 0.22;
    s.mat.uniforms.uA.value.set(a.x, a.y, a.z);
    s.mat.uniforms.uB.value.set(b.x, b.y, b.z);
    s.mat.uniforms.uColor.value.set(o.color || '#8ef0d0');
    s.mat.uniforms.uCore.value.set(o.core || '#ffffff');
    s.mat.uniforms.uW.value = s.w * 0.35;
    s.mat.uniforms.uOpacity.value = 0;
    s.mesh.visible = true;
    return s;
  }
  update(dt, t) {
    for (const p of this.pool) {
      if (!p.live) continue;
      p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) { p.live = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; continue; }
      // snap open, hold, whip closed
      const open = Math.min(1, u / 0.10);
      const close = u > 0.72 ? 1 - (u - 0.72) / 0.28 : 1;
      p.mat.uniforms.uW.value = p.w * (0.35 + 0.65 * easeOut(open)) * (0.35 + 0.65 * close);
      p.mat.uniforms.uOpacity.value = p.op * easeOut(open) * Math.pow(close, 0.8);
      p.mat.uniforms.uT.value = t;
    }
  }
  clear() { for (const p of this.pool) { p.live = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; } }
  dispose() { this.geo.dispose(); for (const p of this.pool) p.mat.dispose(); }
}

export { easeOut, easeIn };
