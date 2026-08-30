// OWNER: AGENT-RENDER — the world's air.
//
//  * a painted void backdrop (never a flat colour): vertical value ramp, drifting
//    cloud/ash fbm, a horizon ember glow, and a slow current of far sparks
//  * instanced dust motes / embers / ash that catch the key light
//  * the authored height-fog + distance-haze parameters, pushed into the post
//    chain (the fog itself is evaluated in postfx.js against the depth buffer,
//    so it is art-directable and costs one pass instead of touching materials)
import * as THREE from 'three';
import { GRADES, DEFAULT_BIOME } from './shaders/grades.js';

const BACKDROP_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const BACKDROP_FRAG = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform float uTime;
uniform vec3  uZenith, uHorizon, uNadir, uGlow, uEmber;
uniform float uGlowY, uGlowSharp, uCloud, uEmberAmt, uExpComp;

float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
// 3D value noise: sampled on the view direction so the dome has NO seam
float vn3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = h13(i), n100 = h13(i + vec3(1,0,0)), n010 = h13(i + vec3(0,1,0)), n110 = h13(i + vec3(1,1,0));
  float n001 = h13(i + vec3(0,0,1)), n101 = h13(i + vec3(1,0,1)), n011 = h13(i + vec3(0,1,1)), n111 = h13(i + vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// A per-octave rotation is what stops 3D value noise from showing its lattice
// as a faint grid across the dome.
const mat3 NROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm3(vec3 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i = 0; i < 5; i++){ s += a * vn3(p); n += a; p = NROT * p * 2.07 + 7.3; a *= 0.5; }
  return s / n;
}

void main(){
  float y = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  // three-stop painted ramp: nadir (below the island) -> horizon -> zenith
  vec3 col = (y < 0.5)
    ? mix(uNadir, uHorizon, smoothstep(0.0, 0.5, y))
    : mix(uHorizon, uZenith, smoothstep(0.5, 1.0, y));

  // drifting ash / cloud strata — the backdrop must never read as a flat fill
  vec3 d3 = vec3(vDir.x, vDir.y * 1.7, vDir.z);
  // domain warp: turns the noise from "cells" into painted strata
  d3 += 0.42 * vec3(fbm3(d3 * 1.9 + 2.0) - 0.5, fbm3(d3 * 1.9 + 11.0) - 0.5, fbm3(d3 * 1.9 + 23.0) - 0.5);
  float c1 = fbm3(d3 * 2.6 + vec3(uTime * 0.012, uTime * -0.006, 0.0));
  float c2 = fbm3(d3 * 6.4 + vec3(uTime * -0.020, uTime * 0.010, 5.0));
  float clouds = clamp(mix(c1, c2, 0.42) * 1.35 - 0.18, 0.0, 1.4);
  col = mix(col, col * (0.20 + 1.35 * clouds), uCloud);
  // very soft large-scale mottling keeps banding out of the gradient
  col *= 0.90 + 0.22 * fbm3(d3 * 1.05 + 3.1);

  // horizon ember glow — the far light of the underworld
  float band = exp(-pow((vDir.y - uGlowY) * uGlowSharp, 2.0));
  col += uGlow * band * (0.55 + 0.45 * clouds);

  // far sparks drifting upward in the void
  vec2 sp = vec2(atan(vDir.z, vDir.x) * 1.35, vDir.y * 2.4);
  vec2 gp = vec2(sp.x * 3.0, sp.y * 3.0 - uTime * 0.06);
  vec2 gi = floor(gp), gf = fract(gp);
  float spark = 0.0;
  for(int x = -1; x <= 1; x++){
    for(int yq = -1; yq <= 1; yq++){
      vec2 o = vec2(float(x), float(yq));
      vec2 rnd = vec2(h12(gi + o), h12(gi + o + 17.3));
      if(rnd.x < 0.86) continue;
      vec2 d = gf - o - rnd;
      float r = dot(d, d);
      spark += exp(-r * 260.0) * (0.4 + 0.6 * rnd.y);
    }
  }
  col += uEmber * spark * uEmberAmt;

  // 1/255 blue-ish noise dither: a 3-stop gradient across a 300u dome bands
  // visibly in the upper quadrant otherwise (§7 bans that).
  float dth = (h12(gl_FragCoord.xy * 1.0) + h12(gl_FragCoord.yx * 1.7 + 13.1) - 1.0) * (1.0 / 255.0);
  col += dth * 0.5;

  gl_FragColor = vec4(max(col, vec3(0.0)) * uExpComp, 1.0);
}`;

const MOTE_VERT = /* glsl */`
attribute vec3 aSeed;      // (phase, speed, sizeScale)
attribute vec3 aTint;
varying vec3 vTint;
varying float vFade;
varying float vSeed;
uniform float uTime;
uniform float uSize;
uniform float uRise;
uniform float uSpanY;
uniform float uProjScale;
uniform vec3  uCenter;
void main(){
  vec3 p = position;
  float t = uTime * aSeed.y + aSeed.x * 100.0;
  // slow buoyant drift; wrap in Y so the field never empties
  p.y = mod(p.y + uTime * uRise * aSeed.y, uSpanY);
  p.x += sin(t * 0.35) * 0.9 + sin(t * 0.11) * 2.2;
  p.z += cos(t * 0.29) * 0.9 + cos(t * 0.13) * 2.2;
  p += uCenter;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float d = -mv.z;
  vFade = smoothstep(1.5, 6.0, d) * (1.0 - smoothstep(46.0, 110.0, d));
  vFade *= 0.42 + 0.34 * sin(t * 1.7) + 0.24 * sin(t * 4.31 + aSeed.x * 9.0);
  vTint = aTint;
  vSeed = aSeed.x;
  gl_PointSize = clamp(uSize * aSeed.z * uProjScale / max(0.6, d), 1.0, 44.0);
  gl_Position = projectionMatrix * mv;
}`;

const MOTE_FRAG = /* glsl */`
precision highp float;
varying vec3 vTint;
varying float vFade;
varying float vSeed;
uniform float uIntensity;
uniform float uExpComp;
uniform float uShape;     // 0 = four-point ember star, 1 = drifting streak
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  // ART_DIRECTION §7 bans "obvious round dots". Two authored silhouettes:
  //   * a four-point ember star (a spark catching the key)
  //   * a 3:1 velocity-aligned streak (drifting ash)
  // Both carry a hot core and a saturated halo, and NO white — whiteness is
  // the bloom's job, not the particle's.
  float a = vSeed * 6.2831;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
  vec2 e = rot * q;

  // four-point star: an astroid-ish distance field, sharp on the diagonals
  vec2 s = abs(e);
  float star = (s.x + s.y) * 0.72 + max(s.x, s.y) * 0.46;
  // streak: a 3:1 ellipse with a tapered tail
  vec2 t = e; t.x /= 0.34;
  float tail = clamp(t.y * 0.5 + 0.5, 0.0, 1.0);
  t.y *= mix(1.70, 0.72, tail);
  float streak = length(t);

  float r = mix(star, streak, uShape);
  if(r > 1.0) discard;
  float core = pow(max(0.0, 1.0 - r * 2.0), 3.0);
  float halo = pow(max(0.0, 1.0 - r), 2.4);
  vec3 col = vTint * (halo * 1.05 + core * 2.6);
  gl_FragColor = vec4(col * vFade * uIntensity * uExpComp, 1.0);
}`;

// ── authored per-biome air ──────────────────────────────────────────────────
const AIR = {
  tartarus: {
    // The void is the DARKEST band in the histogram, always (§1.8). These are
    // ~45% down on the first pass, where the upper third of the wide shot read
    // as a flat mid-value purple haze brighter than the arena.
    // §9.4: the void is still the darkest band that contains no architecture,
    // but a DEAD band is not a band. At the old values the wide shot measured
    // 20% of its pixels crushed under display 0.02, which both kills §1.1's
    // "hazed background" and drags the frame median below the floor so the
    // floor can never win the value law. These sit ~1.5 stops up: painted,
    // low-chroma, and still unmistakably the bottom of the frame.
    // §11 (true-depth pass): measured by real scene depth the void was the
    // BRIGHTEST band in the frame at 0.142 against a 0.038 play area. The dome
    // is the painted half of that and it comes down a stop and loses most of
    // its chroma: a value ramp that still reads as a ramp, still drifts, still
    // carries embers, but sits UNDER everything that stands on the island. The
    // glow band and the ember amount are held — a dark backdrop is required, a
    // dead one is not (§9.4: a dead band is not a band), and the embers are the
    // only motion in the negative space.
    // ROUND-4, MEASURED. Three review rounds in a row reported a "hard-aliased
    // fully black cast shadow" slicing across the upper architecture of 03-08
    // and 11. It is not a shadow: with lighting.params.shadows = false and
    // key.castShadow = false the region is byte-identical, and a painterly ink
    // floor pushed through every patched material moves it by 0.5%. It is THIS
    // DOME — the abyss between the arena island and the outer colonnade, seen
    // through the gap. At the values above it measured mean rgb(2,2,4) with
    // 92% of the band at LITERAL rgb(0,0,0) after the vignette, so the arena
    // rim's coursed slabs were silhouetted against absolute zero. A 255-count
    // step is what makes a blocky silhouette read as a staircase; the step is
    // the defect, not the edge filtering (2x SSAA + SMAA are both working).
    //
    // §2 names Void black as #07060f — a VIOLET black, not a zero — and §9.4's
    // own note here already said "a dead band is not a band". These are ~3.2x
    // up in linear, which lands the void around display 0.05-0.09: still far
    // under the play floor (0.055-0.075) and the lit mid-ground (0.15-0.21), so
    // §11's far < near < mid ordering is untouched, but the negative space now
    // carries hue, the strata read, and the ember glow has something to sit on.
    zenith: '#242040', horizon: '#382a4b', nadir: '#1b1728',
    glow: '#42171d', glowY: -0.24, glowSharp: 4.2, cloud: 0.62,
    ember: '#e8a24a', emberAmt: 0.34,
    motes: [
      // Recoloured off the GOLD ramp (§2 gold core -> bronze shadow) so the
      // ambient particulate reinforces the gold spine instead of adding a
      // third hue. Sizes span 3x across the population.
      // SCENE-REFERRED: these carry the same 2.42x the light rig does now that
      // grades.js tartarus runs at exposure 1.20 instead of 2.90.
      { tint: '#f2c14e', count: 0.14, size: 0.30, rise: 0.60, span: 15, intensity: 3.60, shape: 0.0 },  // ember stars
      { tint: '#ffe9a8', count: 0.18, size: 0.11, rise: 0.34, span: 19, intensity: 1.21, shape: 0.0 }, // fine sparks
      { tint: '#6d4416', count: 0.62, size: 0.36, rise: 0.09, span: 13, intensity: 0.18, shape: 1.0 },// ash streaks
    ],
  },
  asphodel: {
    zenith: '#282c46', horizon: '#4b383d', nadir: '#222536',
    glow: '#60362e', glowY: -0.22, glowSharp: 3.2, cloud: 0.46,
    ember: '#d07a45', emberAmt: 0.26,
    motes: [
      { tint: '#c86b3d', count: 0.14, size: 0.24, rise: 0.62, span: 16, intensity: 0.62 },
      { tint: '#e8c59d', count: 0.10, size: 0.09, rise: 0.42, span: 21, intensity: 0.30 },
      { tint: '#6e8791', count: 0.42, size: 0.26, rise: 0.10, span: 13, intensity: 0.045, shape: 1.0 },
    ],
  },
  elysium: {
    zenith: '#202944', horizon: '#393c50', nadir: '#191e30',
    glow: '#4d513c', glowY: -0.06, glowSharp: 2.9, cloud: 0.52,
    ember: '#ffeeb8', emberAmt: 0.35,
    motes: [
      { tint: '#ffe6a3', count: 0.20, size: 0.22, rise: 0.30, span: 17, intensity: 1.1 },
      { tint: '#b8e8c4', count: 0.20, size: 0.10, rise: 0.17, span: 16, intensity: 0.42 },
      { tint: '#c48ab8', count: 0.60, size: 0.32, rise: 0.07, span: 14, intensity: 0.07, shape: 1.0 },
    ],
  },
};

export class Atmosphere {
  constructor(){
    this.enabled = true;
    this.biome = DEFAULT_BIOME;
    this.fogScale = 1.0;
    this.fogBase = 0.0;
    this.layers = [];
    this.params = { backdrop: true, motes: true, moteScale: 1.0, backdropIntensity: 1.0, exposureCompensate: 1.0 };
  }

  async init(ctx){
    this.ctx = ctx;
    const q = (ctx.quality && ctx.quality.render) || {};
    this.root = new THREE.Group();
    this.root.name = 'atmosphere';
    this.root.frustumCulled = false;
    ctx.scene.add(this.root);

    // fog is evaluated in the post chain against the depth buffer
    ctx.scene.fog = null;

    // ── backdrop dome ──────────────────────────────────────────────────────
    this.backMat = new THREE.ShaderMaterial({
      vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uZenith: { value: new THREE.Color('#0a0714') },
        uHorizon: { value: new THREE.Color('#2a0f24') },
        uNadir: { value: new THREE.Color('#08050e') },
        uGlow: { value: new THREE.Color('#5e1420') },
        uEmber: { value: new THREE.Color('#ff7a3c') },
        uGlowY: { value: -0.1 }, uGlowSharp: { value: 3.0 },
        uCloud: { value: 0.6 }, uEmberAmt: { value: 0.5 }, uExpComp: { value: 1.0 },
      },
      side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.backMat);
    this.dome.name = 'void.backdrop';
    this.dome.scale.setScalar(300);
    this.dome.renderOrder = -1000;
    this.dome.frustumCulled = false;
    this.root.add(this.dome);

    // ── mote / ember / ash layers ──────────────────────────────────────────
    this.moteBudget = Math.max(120, q.motes ?? 1200);
    // Low quality intentionally permits zero particle layers; the painted
    // backdrop remains, while an entire transparent draw pass disappears.
    this.layerCount = Math.max(0, Math.min(3, q.dustLayers ?? 3));
    this._rng = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('atmosphere') : null;
    this._buildLayers(ctx);

    this.setBiome(this.biome, ctx);
    ctx.atmosphere = this;
  }

  _rand(){ return this._rng ? this._rng.f() : 0.5; }

  _buildLayers(ctx){
    for(const l of this.layers){ this.root.remove(l.points); l.points.geometry.dispose(); l.points.material.dispose(); }
    this.layers.length = 0;
    const air = AIR[this.biome] || AIR.tartarus;
    const R = ((ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 16) * 1.5;

    for(let li = 0; li < this.layerCount; li++){
      const def = air.motes[li] || air.motes[0];
      const n = Math.max(24, Math.floor(this.moteBudget * def.count));
      const pos = new Float32Array(n * 3);
      const seed = new Float32Array(n * 3);
      const tint = new Float32Array(n * 3);
      const c = new THREE.Color(def.tint);
      for(let i = 0; i < n; i++){
        // disc-biased scatter so the density follows the arena, not a cube
        const a = this._rand() * Math.PI * 2;
        const rr = Math.sqrt(this._rand()) * R;
        pos[i * 3 + 0] = Math.cos(a) * rr;
        pos[i * 3 + 1] = this._rand() * def.span;
        pos[i * 3 + 2] = Math.sin(a) * rr;
        seed[i * 3 + 0] = this._rand();
        seed[i * 3 + 1] = 0.35 + this._rand() * 1.25;
        // 3x size spread across the population, weighted small
        seed[i * 3 + 2] = 0.38 + this._rand() * this._rand() * 2.4;
        // per-particle hue jitter so a layer never reads as one flat colour
        const j = 0.82 + this._rand() * 0.36;
        tint[i * 3 + 0] = c.r * j;
        tint[i * 3 + 1] = c.g * j * (0.9 + this._rand() * 0.2);
        tint[i * 3 + 2] = c.b * j;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
      geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 3 + def.span);

      const mat = new THREE.ShaderMaterial({
        vertexShader: MOTE_VERT, fragmentShader: MOTE_FRAG,
        uniforms: {
          uTime: { value: 0 }, uSize: { value: def.size }, uRise: { value: def.rise },
          uSpanY: { value: def.span }, uProjScale: { value: 700 },
          uIntensity: { value: def.intensity }, uExpComp: { value: 1.0 },
          uShape: { value: def.shape ?? 0.0 },
          uCenter: { value: new THREE.Vector3(0, 0, 0) },
        },
        transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: true, fog: false, toneMapped: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.name = 'atmos.motes.' + li;
      pts.frustumCulled = false;
      pts.renderOrder = 10;
      this.root.add(pts);
      this.layers.push({ points: pts, def });
    }
  }

  /** Authored air per biome. Also pushes the fog/haze band into the post chain. */
  setBiome(name, ctx = this.ctx){
    const air = AIR[name] || AIR[DEFAULT_BIOME];
    const changed = name !== this.biome;
    this.biome = AIR[name] ? name : DEFAULT_BIOME;

    const u = this.backMat.uniforms;
    u.uZenith.value.set(air.zenith);
    u.uHorizon.value.set(air.horizon);
    u.uNadir.value.set(air.nadir);
    u.uGlow.value.set(air.glow);
    u.uEmber.value.set(air.ember);
    u.uGlowY.value = air.glowY;
    u.uGlowSharp.value = air.glowSharp;
    u.uCloud.value = air.cloud;
    u.uEmberAmt.value = air.emberAmt;

    if(changed) this._buildLayers(ctx || this.ctx);
    else this._retintLayers(air);

    // authored height fog / distance haze -> post
    const g = GRADES[this.biome] || GRADES[DEFAULT_BIOME];
    this.fog = { ...g.fog };
    if(ctx && ctx.post && ctx.post.setGrade) ctx.post.setGrade({ fog: this.fog });
    return this;
  }

  _retintLayers(air){
    for(let i = 0; i < this.layers.length; i++){
      const def = air.motes[i] || air.motes[0];
      const m = this.layers[i].points.material;
      m.uniforms.uSize.value = def.size;
      m.uniforms.uRise.value = def.rise;
      m.uniforms.uSpanY.value = def.span;
      m.uniforms.uIntensity.value = def.intensity;
      if(m.uniforms.uShape) m.uniforms.uShape.value = def.shape ?? 0.0;
      this.layers[i].def = def;
    }
  }

  lateUpdate(alpha, ctx){
    if(!this.root) return;
    const t = (ctx.time && ctx.time.t) || 0;
    this.root.visible = this.enabled;
    this.dome.visible = this.params.backdrop;
    this.backMat.uniforms.uTime.value = t;
    // The void must stay the darkest band even when auto-exposure lifts the
    // scene, so the backdrop and the motes are authored in display terms and
    // divided back out by the adaptation the post chain applied.
    const adapt = (ctx.post && ctx.post._adapt) ? ctx.post._adapt : 1;
    // Clamped at 1: the backdrop is authored in display terms, so adaptation
    // may darken it but must never inflate it above the authored value — that
    // inflation is exactly what turned the establishing shot into a lit fog.
    const comp = Math.min(1.0, Math.pow(1 / Math.max(0.05, adapt), this.params.exposureCompensate ?? 1.0));
    this.backMat.uniforms.uExpComp.value = comp;

    // keep the dome and the mote field anchored to the camera plane so the
    // player never walks out of the weather
    const cam = ctx.camera;
    if(cam) this.dome.position.set(cam.position.x, 0, cam.position.z);
    const anchor = (ctx.player && ctx.player.position) ? ctx.player.position : null;
    let projScale = 700;
    if(cam && ctx.renderer){
      const sz = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
      projScale = sz.y * cam.projectionMatrix.elements[5] * 0.5;
    }

    for(const l of this.layers){
      l.points.visible = this.params.motes;
      const u = l.points.material.uniforms;
      u.uTime.value = t;
      u.uIntensity.value = l.def.intensity * this.params.moteScale;
      u.uExpComp.value = comp;
      u.uProjScale.value = projScale;
      if(anchor) u.uCenter.value.set(0, 0, 0);
    }
  }

  resize(){}

  dispose(){
    for(const l of this.layers){ l.points.geometry.dispose(); l.points.material.dispose(); }
    this.layers.length = 0;
    if(this.dome){ this.dome.geometry.dispose(); this.backMat.dispose(); }
  }
}
