// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// library.js — MaterialLibrary (ARCHITECTURE.md §2.7)
//
//   mats.get(name, opts)   -> cached THREE.Material
//   mats.tex(name, opts)   -> cached THREE.Texture
//
// Every named material is synthesised at runtime from texgen.js: albedo +
// normal + roughness + AO (packed ORM) + emissive where it glows, then patched
// with the painterly shading model in painterly.js. Zero external assets.
//
// WHERE THE WORK HAPPENS. The recipe book itself lives in recipes.js, which
// imports no three.js, so the whole bake can run inside texworker.js on every
// core the machine has. init() fans the current biome's surfaces out across the
// pool and awaits them; anything asked for later that the pool never baked
// falls back to a synchronous main-thread bake, so a browser with no Worker
// support, or a name nobody predicted, still gets its texture.
//
// Extras other systems may use (all additive, nothing here breaks the contract):
//   mats.patch(mat, opts)        painterly-patch someone else's material
//   mats.character(opts)         a ready character-look MeshStandardMaterial
//   mats.setBiome(name)          retune rim / shadow tint for the whole scene
//   mats.env()                   the procedural PMREM the metals reflect
//   mats.ramp(name) / mats.color(name, t)
//   mats.detailTexture / mats.macroTexture
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import * as TG from './texgen.js';
import {
  RAMPS, INK, GOLD, TARTARUS, ASPHODEL, ELYSIUM, BIOMES,
  hexToRgb, rampAt,
} from './palette.js';
import {
  painterly, setPaint, setBiomeLook, updatePainterly, paintParams,
  ENVIRONMENT_LOOK, CHARACTER_LOOK,
} from './painterly.js';
import {
  RECIPES, bakeSet, resolveRecipe, BASE,
} from './recipes.js';
import { BakePool } from './bakepool.js';
import { compositeGeneratedAlbedo, loadGeneratedAlbedos } from './generated-textures.js';
import { textureProfileForTier } from './texture-budget.js';

const clamp01 = TG.clamp01;
const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

// Which surfaces a biome actually needs standing in its first chamber. Only
// these are baked during boot; the other biomes' stone and floor are baked when
// the run walks through the door into them (setBiome -> prebuild), so the boot
// screen never pays for scenery the player cannot see yet.
const SHARED_SETS = [
  'gold.filigree', 'gold.leaf', 'bronze.verdigris', 'iron.dark', 'crystal.violet',
  'character.hero', 'blood.pool', 'banner.crimson', 'wood.dark', 'water.styx',
  'medallion.tartarus',
  // the void skirt, the abyss embers, the bone dressing and the statue marble:
  // every chamber asks for these whatever biome it is, and each one caught
  // blocking the main thread in the sync path is ~0.5s of black screen
  'obsidian', 'lava', 'bone', 'marble.elysium',
  'characterrig.hound.hide', 'characterrig.hound.limbs', 'characterrig.hound.keratin',
  'shrine.divine', 'gold.divine',
];
const BIOME_SETS = {
  tartarus: ['floor.tartarus', 'stone.tartarus', 'stone.tartarus.bay',
    'stone.tartarus.column', 'stone.tartarus.arch', 'rubble.tartarus',
    'stone.tartarus.rim', 'bone.tartarus', 'bronze.tartarus', 'iron.tartarus', 'ceramic.tartarus', 'wood.tartarus'],
  asphodel: ['floor.asphodel', 'stone.asphodel', 'obsidian.asphodel',
    'lava.asphodel', 'rubble.asphodel', 'bone.asphodel', 'bronze.asphodel', 'iron.asphodel'],
  elysium: ['floor.elysium', 'marble.elysium'],
};

// ---------------------------------------------------------------------------
// MaterialLibrary
// ---------------------------------------------------------------------------

export class MaterialLibrary {
  constructor() {
    this.cache = new Map();       // materialKey -> THREE.Material
    this.texCache = new Map();    // texKey -> THREE.Texture
    this.setCache = new Map();    // name|size -> texture set
    this.generatedMaps = new Map(); // recipe key -> image-generated albedo
    this.animated = [];
    // ms  = the time boot actually WAITED (wall)
    // cpu = the summed synthesis cost across every thread that did the work
    this.stats = { ms: 0, cpu: 0, built: 0, texels: 0, sync: [] };
    this.biome = 'tartarus';
    this.scale = 1;
    this.generatedScale = 1;
    this.anisotropy = 4;
    this._t = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    const tier = (ctx.quality && ctx.quality.tier) || 'high';
    // Texture work is quadratic. The old .55/.75/1.0 policy still generated
    // millions of texels and decoded nine full 1536×1024 atlases. These
    // browser-first profiles intentionally trade close-up definition for
    // shorter loading, lower memory pressure and steadier frame delivery.
    const profile = textureProfileForTier(tier);
    this.scale = profile.proceduralScale;
    this.generatedScale = profile.generatedScale;
    this.anisotropy = profile.anisotropy;
    const q = ctx.quality || {};
    if (typeof q.texScale === 'number' && q.texScale > 0) this.scale = q.texScale;
    else q.texScale = this.scale;          // publish what we chose, so tools can read it
    this.biome = (ctx.run && ctx.run.biome) || this.biome;

    setBiomeLook(this.biome);
    if (ctx.events && ctx.events.on) ctx.events.on('biome.changed', ({ name }) => this.setBiome(name));

    // Fan this biome's surfaces out across the cores. Everything the first
    // chamber will ask for is baked here, in parallel, before the world builds;
    // whatever the pool cannot deliver falls through to the sync path in set().
    const t0 = now();
    // Leave CPU capacity for the browser, input and operating system on weaker
    // machines instead of occupying every core during procedural texture boot.
    const workerLimit = tier === 'low' ? 2 : tier === 'med' ? 4 : tier === 'high' ? 6 : 8;
    this._pool = new BakePool(workerLimit);
    // Decode the authored albedo atlases while the worker pool synthesises PBR
    // support maps. Neither job needs to wait on the other.
    const generated = this._loadGeneratedAlbedos();
    const baking = this.prebuild(this._bootSets());   // dispatches synchronously
    // the shared world-projected layers, painted here while the pool works
    this.detailTexture = this._detail();
    this.macroTexture = this._macro();
    await Promise.all([baking, generated]);
    this._applyGeneratedAlbedos();
    this.stats.wallMs = now() - t0;
    this.stats.workers = this._pool.available ? this._pool.size : 0;
    const w = this.stats.workers || 1;
    console.info(`[mats] ${this.stats.built} sets / ${(this.stats.texels / 1e6).toFixed(1)} Mtexel`
      + ` — boot waited ${this.stats.wallMs.toFixed(0)}ms`
      + ` for ${this.stats.cpu.toFixed(0)}ms of synthesis on ${w} worker${w > 1 ? 's' : ''}`
      + ` (${(this.stats.cpu / Math.max(1, this.stats.wallMs)).toFixed(2)}x parallel)`
      + `, texScale ${this.scale}, ${this.generatedMaps.size} generated albedo bindings`);
    // Anything that took the synchronous path is a surface nobody predicted:
    // it blocked the main thread. If this list is ever long, add the names to
    // BIOME_SETS / SHARED_SETS above rather than making the recipe cheaper.
    if (this.stats.sync.length) console.info('[mats] sync bakes:', this.stats.sync.join(', '));
  }

  async _loadGeneratedAlbedos() {
    try {
      const renderer = this.ctx && this.ctx.renderer;
      const max = renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy
        ? renderer.capabilities.getMaxAnisotropy() : 8;
      // Generated atlas cells are retained for lazy materials, so downscaling
      // them is a large RAM/VRAM saving in addition to reducing seam-processing
      // work. Procedural normals/ORM keep their normal tier-specific scale.
      const aniso = Math.min(this.anisotropy, Math.max(1, max));
      this.generatedMaps = await loadGeneratedAlbedos(aniso, this.generatedScale);
      this._applyGeneratedAlbedos();
    } catch (error) {
      // Procedural albedo remains a complete fallback for offline/file builds,
      // constrained browsers, and corrupt asset caches.
      this.generatedMaps = new Map();
      console.warn('[mats] generated albedo atlases unavailable; using procedural colour', error);
    }
  }

  _applyGeneratedAlbedos() {
    if (!this.generatedMaps.size) return;
    for (const set of this.setCache.values()) {
      const generated = this.generatedMaps.get(set.name);
      if (!generated || set.generatedSource === generated) continue;
      if (set.map && set.map !== set.proceduralMap) set.map.dispose();
      set.map = compositeGeneratedAlbedo(set.proceduralMap, generated, this.anisotropy);
      set.generatedSource = generated;
    }
  }

  /** The recipe names this biome's first chamber will ask for. */
  _bootSets(biome = this.biome) {
    return [...(BIOME_SETS[biome] || BIOME_SETS.tartarus), ...SHARED_SETS];
  }

  /**
   * Bake a list of named surfaces in parallel and install them in the cache.
   * Safe to call at any time — already-cached sets are skipped, and a failed
   * worker just means set() bakes it synchronously on first use.
   */
  async prebuild(names) {
    if (!this._pool || !this._pool.available) return;
    const jobs = [];
    for (const name of names) {
      const key = this._resolve(name);
      if (!key) continue;
      const n = this._size(RECIPES[key]);
      const ck = key + '|' + n;
      if (this.setCache.has(ck) || jobs.some((j) => j.ck === ck)) continue;
      jobs.push({ key, n, ck });
    }
    // longest job first: with 3 workers and one 1024² floor, scheduling the
    // floor last would leave two cores idle waiting for it.
    jobs.sort((a, b) => b.n - a.n);
    const t0 = now();
    const raw = await Promise.all(jobs.map((j) => this._pool.bake(j.key, j.n)));
    for (let i = 0; i < jobs.length; i++) {
      if (!raw[i]) continue;                       // pool failed -> lazy sync bake
      this.stats.cpu += raw[i].cpuMs || 0;
      this.setCache.set(jobs[i].ck, this._install(raw[i]));
    }
    this.stats.ms += now() - t0;
  }

  /** Turn a bake's raw byte buffers into the cached THREE texture set. */
  _install(b) {
    const n = b.size, key = b.name;
    if (b.error) console.warn('[mats] recipe failed:', key, b.error);
    const generated = this.generatedMaps.get(key);
    const aniso = this.anisotropy;
    const proceduralMap = TG.byteTexture(b.map, n, { anisotropy: aniso, srgb: true });
    const set = {
      name: key, size: n,
      proceduralMap,
      map: generated ? compositeGeneratedAlbedo(proceduralMap, generated, aniso) : proceduralMap,
      generatedSource: generated || null,
      normalMap: TG.byteTexture(b.normalMap, n, { anisotropy: aniso }),
      ormMap: TG.byteTexture(b.ormMap, n, { anisotropy: aniso }),
      emissiveMap: b.emissiveMap ? TG.byteTexture(b.emissiveMap, n, { anisotropy: Math.min(4, aniso), srgb: true }) : null,
      emissiveIntensity: b.emissiveIntensity ?? 0,
      params: b.params || {},
      paint: b.paint || {},
      animate: b.animate || null,
    };
    set.map.name = key + '.albedo';
    set.normalMap.name = key + '.normal';
    set.ormMap.name = key + '.orm';
    if (set.emissiveMap) set.emissiveMap.name = key + '.emissive';
    this.stats.built++; this.stats.texels += n * n;
    return set;
  }

  // ---- procedural environment (metals must have something to reflect) ------
  /**
   * A tiny painted equirect sky -> PMREM. Without this every metal in the game
   * renders as a black mirror, which is the loudest "programmer art" tell there
   * is. It is authored from the biome ramp so the reflections stay in palette.
   */
  env(biome = this.biome) {
    // The light rig authors and prefilters the biome sky (lighting.js
    // _buildEnvironment) and publishes it as `ctx.lighting.envTexture`. If it is
    // there we bind THAT — one PMREM for the whole game means the reflection in
    // the gold matches the light that is actually hitting it. We only synthesise
    // our own when the rig is absent (unit tests, tools, a stubbed rig).
    const rigEnv = this.ctx && this.ctx.lighting && this.ctx.lighting.envTexture;
    if (rigEnv) return rigEnv;
    if (!this._envCache) this._envCache = new Map();
    if (this._envCache.has(biome)) return this._envCache.get(biome);
    let tex = null;
    try {
      const r = this.ctx && this.ctx.renderer;
      if (r) {
        const B = BIOMES[biome] || BIOMES.tartarus;
        const lin = (hex, k = 1) => {
          const c = hexToRgb(hex);
          const f = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * k;
          return [f(c[0]), f(c[1]), f(c[2])];
        };
        const sky = lin(INK.violet, 0.30);
        const zen = lin(INK.deep, 0.16);
        const horiz = lin(B.fog, 0.55);
        const ground = lin(B.bounce, 0.42);
        const keyC = lin(B.key, 7.0);
        const accC = lin(B.accent, 2.2);
        const W = 128, H = 64;
        const data = new Float32Array(W * H * 4);
        const kd = B.keyDir, klen = Math.hypot(kd[0], kd[1], kd[2]) || 1;
        const kx = kd[0] / klen, ky = kd[1] / klen, kz = kd[2] / klen;
        for (let y = 0; y < H; y++) {
          const theta = (y + 0.5) / H * Math.PI;          // 0 = up
          const cy = Math.cos(theta), sy = Math.sin(theta);
          for (let x = 0; x < W; x++) {
            const phi = (x + 0.5) / W * Math.PI * 2;
            const dx = sy * Math.cos(phi), dz = sy * Math.sin(phi), dy = cy;
            let R, G, Bc;
            if (dy >= 0) {
              const t = Math.pow(dy, 0.65);
              R = horiz[0] + (zen[0] + sky[0] - horiz[0]) * t;
              G = horiz[1] + (zen[1] + sky[1] - horiz[1]) * t;
              Bc = horiz[2] + (zen[2] + sky[2] - horiz[2]) * t;
            } else {
              const t = Math.pow(-dy, 0.55);
              R = horiz[0] + (ground[0] - horiz[0]) * t;
              G = horiz[1] + (ground[1] - horiz[1]) * t;
              Bc = horiz[2] + (ground[2] - horiz[2]) * t;
            }
            // the key light, as a soft warm disc
            const kdot = dx * kx + dy * ky + dz * kz;
            const kb = Math.pow(Math.max(0, kdot), 26) + Math.pow(Math.max(0, kdot), 3) * 0.10;
            R += keyC[0] * kb; G += keyC[1] * kb; Bc += keyC[2] * kb;
            // a cool accent bounce opposite it, so metal has a two-tone reflection
            const ab = Math.pow(Math.max(0, -kdot), 5) * 0.30;
            R += accC[0] * ab * 0.4; G += accC[1] * ab; Bc += accC[2] * ab * 1.2;
            const i = (y * W + x) * 4;
            data[i] = R; data[i + 1] = G; data[i + 2] = Bc; data[i + 3] = 1;
          }
        }
        const src = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
        src.mapping = THREE.EquirectangularReflectionMapping;
        src.colorSpace = THREE.NoColorSpace;
        src.minFilter = src.magFilter = THREE.LinearFilter;
        src.needsUpdate = true;
        const pm = new THREE.PMREMGenerator(r);
        tex = pm.fromEquirectangular(src).texture;
        pm.dispose(); src.dispose();
      }
    } catch (e) { tex = null; }
    this._envCache.set(biome, tex);
    return tex;
  }

  // ---- shared layers ------------------------------------------------------
  _detail() {
    if (this._detailTex) return this._detailTex;
    // shared layers obey texScale as well — on the low tier this is the
    // difference between 256^2 and 128^2 of brushwork per frame of boot
    const n = this._shared(256);
    const rng = TG.makeRng('detail');
    const g = TG.fbm(n, { freq: 16, octaves: 4, seed: 1201, ppc: 3 });
    const flow = TG.flowField(n, { base: 0.5, swirl: 1.4, freq: 4, seed: 1202 });
    const s = new Float32Array(n * n);
    TG.strokes(s, n, { rng, flow, count: Math.round(n * 3.5), len: [n * 0.03, n * 0.10], width: [0.9, 2.0], value: [0.05, 0.16], bristle: 0.75, taper: 1.9 });
    TG.strokes(s, n, { rng, flow: TG.flowField(n, { base: 2.0, swirl: 1.1, freq: 5, seed: 1203 }), count: Math.round(n * 2.7), len: [n * 0.02, n * 0.08], width: [0.8, 1.6], value: [-0.14, -0.04], bristle: 0.8, taper: 2.1 });
    const out = new Float32Array(n * n);
    for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + (g[i] - 0.5) * 0.42 + s[i] * 1.05);

    // ── THE DETAIL LAYER NOW CARRIES SURFACE, NOT JUST TONE ──────────────────
    // It used to be `fieldTexture(out)` — one scalar replicated across r,g,b.
    // The shader multiplied the ALBEDO by it and nothing else, so at the play
    // camera the micro-scale read as a flat value grain painted on a perfectly
    // smooth plane: no relief, no lighting response, and one roughness for the
    // whole surface. Measured on the round-5 baseline, 04_material and
    // 11_relief_detail came back at rmsContrast 0.127/0.137 against a 0.20
    // floor with the wall bays reading as flat panels.
    //
    // Three of the four channels were carrying a copy of the first, so this
    // costs one texture fetch — the same fetch — and buys:
    //   R  the value grain, exactly as before (the albedo look is unchanged)
    //   GB a tangent-space MICRO-NORMAL, so the grain catches the key and the
    //      surface has relief at the scale a brush leaves it
    //   A  a ROUGHNESS modulation at a coarser, incommensurate scale — §1.4's
    //      "roughness should vary as an ARTISTIC map", and the cheapest way
    //      there is to make one material read as several.
    const chip = TG.fbm(n, { freq: 34, octaves: 3, seed: 1204, ppc: 3 });
    const relief = new Float32Array(n * n);
    for (let i = 0; i < relief.length; i++) relief[i] = clamp01(out[i] * 0.60 + chip[i] * 0.40);
    const { gx, gy } = TG.gradientPair(relief, n, 0.34);
    // dry/polished patches at ~6 periods across the detail tile, i.e. a scale
    // BETWEEN the grain and the macro layer, which is the octave neither of
    // them was covering
    const wet = TG.fbm(n, { freq: 6, octaves: 4, seed: 1205 });
    const rgh = new Float32Array(n * n);
    for (let i = 0; i < rgh.length; i++) rgh[i] = clamp01(0.5 + (wet[i] - 0.5) * 1.7 + (chip[i] - 0.5) * 0.35);
    this._detailTex = TG.byteTexture(TG.packChannels8(out, gx, gy, rgh, n), n,
      { anisotropy: Math.min(4, this.anisotropy) });
    this._detailTex.name = 'detail.grain';
    return this._detailTex;
  }

  _macro() {
    if (this._macroTex) return this._macroTex;
    const n = this._shared(256);
    const a = TG.warp2(TG.fbm(n, { freq: 2, octaves: 5, seed: 2201 }), n, { amp: 0.12, freq: 2, seed: 2202 });
    const b = TG.warp2(TG.fbm(n, { freq: 3, octaves: 5, seed: 2203 }), n, { amp: 0.10, freq: 2, seed: 2204 });
    const c = TG.warp2(TG.fbm(n, { freq: 5, octaves: 5, seed: 2205 }), n, { amp: 0.09, freq: 3, seed: 2206 });
    // ── THE MACRO LAYER WAS INERT, AND THAT IS ARITHMETIC, NOT TASTE ─────────
    // The old encoding put every channel at ~0.455-0.498 with a standard
    // deviation of 0.05. The shader then computed
    //     m = (mc*0.5 + m2*0.34 + m3*0.16) * 2.0            -> 0.94 +- 0.032
    //     m = mix(1, m * mix(1, tint*1.7, 0.5), strength)
    // For the floor (strength 0.30, tint #4a2c38 -> linear 0.068/0.027/0.041)
    // that evaluates to a multiply of 0.858/0.847/0.851 with a 1-sigma swing of
    // 0.010 — i.e. the one term in the shader whose job is to break a large
    // floor's repeat was a 15% GLOBAL DARKENING with a 1% ripple on it. The
    // wall (strength 0.40, #6b4a58) measured the same way: 0.834 +- 0.015.
    // That is the same class of defect as the ink-floor note in painterly.js:
    // a knob that looked considered and did nothing.
    //
    // So the encoding is now explicitly a ZERO-MEAN DEVIATION and the mean
    // multiply is a separate, named uniform (uMacroLevel) that painterly.js
    // seeds with the exact legacy constant above — every surface keeps the
    // average brightness it shipped with, and only the VARIANCE changes. The
    // fields are contrast-expanded to a standard deviation near 0.26 so the
    // drift is something a critic can see across a bay.
    //   R  the broad value drift        (one macroScale period)
    //   G  a hue / roughness selector, deliberately decorrelated from R
    //   B  a second value field, sampled by the shader at two SHORTER scales
    //      so the layer finally has energy at the 3-10m band where a floor's
    //      repeat actually reads. R alone lives at 80m and could only ever
    //      contribute a gradient across a 12m frame.
    const dev = (f) => {
      const o = TG.normalize01(new Float32Array(f), 0, 1);
      for (let i = 0; i < o.length; i++) o[i] = clamp01(0.5 + (o[i] - 0.5) * 1.30);
      return o;
    };
    const A = dev(a), B = dev(b), C = dev(c);
    const rgbF = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
      const j = i * 3;
      rgbF[j] = A[i] * 255;
      rgbF[j + 1] = B[i] * 255;
      rgbF[j + 2] = C[i] * 255;
    }
    this._macroTex = TG.rgbTexture(rgbF, n, { linear: true, anisotropy: Math.min(4, this.anisotropy) });
    this._macroTex.name = 'macro.variation';
    return this._macroTex;
  }

  /** A shared-layer resolution, snapped to 64 and scaled by the quality tier. */
  _shared(nominal) {
    return Math.max(128, Math.round(nominal * this.scale / 64) * 64);
  }

  // ---- texture set --------------------------------------------------------
  _size(rec) {
    // Multiples of 64, NOT powers of two: WebGL2 mipmaps NPOT textures fine and
    // snapping down to the previous power of two threw away up to 44% of the
    // authored resolution (a nominal 768 silently became 512).
    const nominal = (rec && rec.size) || BASE;
    const n = Math.round(nominal * this.scale / 64) * 64;
    return Math.max(128, Math.min(2048, n));
  }

  _resolve(name) { return resolveRecipe(name); }

  /**
   * Build (or fetch) the cached texture set for a named material.
   *
   * Fast path: init() already baked it in a worker. Slow path: nobody predicted
   * this name, so bake it here and now — a one-frame hitch is the correct price
   * for a surface that would otherwise be missing.
   */
  set(name) {
    const key = this._resolve(name);
    if (!key) return null;
    const n = this._size(RECIPES[key]);
    const ck = key + '|' + n;
    if (this.setCache.has(ck)) return this.setCache.get(ck);
    const t0 = now();
    const b = bakeSet(key, n);
    if (!b) return null;
    const set = this._install(b);
    const dt = now() - t0;
    this.stats.ms += dt; this.stats.cpu += dt;
    this.stats.sync.push(key + ' ' + dt.toFixed(0) + 'ms');
    // A surface nobody predicted: this one blocked the main thread. Add its
    // name to BIOME_SETS / SHARED_SETS so the pool bakes it during boot.
    console.info('[mats] sync bake (blocked main thread):', key, dt.toFixed(0) + 'ms');
    this.setCache.set(ck, set);
    return set;
  }

  // ---- the contract -------------------------------------------------------
  /** mats.get(name, opts) -> cached THREE.Material */
  get(name, opts = {}) {
    const key = name + '|' + stableKey(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    // ART_DIRECTION §4: characters are NOT lit like environment. Any name in the
    // `character.*` namespace resolves to the painterly character shader —
    // 2-3 step ramp, hand AO, fresnel rim bound to the light rig's constant and
    // a colour-shifted inner contour — instead of an environment texture set.
    // (AGENT-PLAYER / AGENT-ENEMY: ask for 'character.painterly', not a stone.)
    if (typeof name === 'string' && name.startsWith('character') && !this._resolve(name)) {
      const m = this.character(opts);
      m.name = name;
      this.cache.set(key, m);
      this._applyRim(m);
      return m;
    }
    const set = this.set(name);
    const m = set ? this._material(set, opts) : this._fallbackMaterial(name, opts);
    m.name = name;
    this.cache.set(key, m);
    return m;
  }

  /** mats.tex(name, opts) -> cached THREE.Texture (never throws, never null) */
  tex(name, opts = {}) {
    const which = opts.map || opts.channel || 'albedo';
    const key = 'tex:' + name + '|' + which + '|' + stableKey(opts);
    if (this.texCache.has(key)) return this.texCache.get(key);
    let t = null;
    if (name === 'detail' || name === 'detail.grain') t = this._detail();
    else if (name === 'macro' || name === 'macro.variation') t = this._macro();
    else {
      const set = this.set(name);
      if (set) {
        t = which === 'normal' ? set.normalMap
          : (which === 'orm' || which === 'roughness' || which === 'ao' || which === 'metalness') ? set.ormMap
            : which === 'emissive' ? (set.emissiveMap || set.map)
              : set.map;
      }
    }
    if (!t) t = this._neutral();
    if (opts.repeat) { t = t.clone(); t.repeat.set(opts.repeat, opts.repeat); t.needsUpdate = true; }
    this.texCache.set(key, t);
    return t;
  }

  _neutral() {
    if (this._neutralTex) return this._neutralTex;
    const d = new Uint8Array(4 * 4 * 4).fill(200);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    const t = new THREE.DataTexture(d, 4, 4, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    t.name = 'neutral';
    this._neutralTex = t;
    return t;
  }

  _material(set, opts) {
    const paintOpts = { ...set.paint };
    const own = {};
    // split THREE material params from our own options
    const MINE = ['triplanar', 'projection', 'triScale', 'triSharp', 'stochastic', 'circScale',
      'detail', 'detailScale', 'detailStrength', 'detailBump', 'detailRough',
      'macro', 'macroScale', 'macroStrength', 'macroTint', 'macroLevel', 'macroRough',
      'variation', 'variationTint',
      'variant', 'rimColor', 'rimPower', 'rimStrength', 'rimDir', 'rimGate', 'shadowTint',
      'shadowDepth', 'rampSoftness', 'rampStrength', 'rampSteps', 'rampLevels', 'keyRef',
      'contourColor', 'contourStrength', 'contourStart', 'repeat', 'size', 'painterly', 'tint', 'envMap',
      'litGain', 'ambGain', 'specGain'];
    const three = {};
    for (const k in opts) {
      if (MINE.indexOf(k) >= 0) own[k] = opts[k];
      else three[k] = opts[k];
    }
    Object.assign(paintOpts, own);

    const repeat = opts.repeat;
    const worldProj = paintOpts.triplanar || paintOpts.projection === 'triplanar' || paintOpts.projection === 'planarY';
    const tx = (t) => {
      if (!t) return null;
      if (!repeat || worldProj) return t;
      const c = t.clone(); c.repeat.set(repeat, repeat); c.needsUpdate = true; return c;
    };

    const params = {
      map: tx(set.map),
      normalMap: tx(set.normalMap),
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: tx(set.ormMap),
      metalnessMap: tx(set.ormMap),
      aoMap: tx(set.ormMap),
      aoMapIntensity: 1.0,
      roughness: 1.0,
      metalness: 1.0,
      envMapIntensity: 1.0,
      dithering: true,
      ...set.params,
    };
    if (set.emissiveMap) {
      params.emissiveMap = tx(set.emissiveMap);
      params.emissive = new THREE.Color(0xffffff);
      params.emissiveIntensity = set.emissiveIntensity;
    }
    if (opts.envMap !== false) {
      const e = this.env();
      if (e) {
        params.envMap = e;
        // Dielectrics only get a whisper of IBL — enough to keep the shadow
        // side from going dead, not enough to fight the authored light rig.
        params.envMapIntensity = (set.params && set.params.envMapIntensity) != null ? set.params.envMapIntensity : 0.13;
      }
    }
    const mat = new THREE.MeshStandardMaterial(params);
    if (opts.tint) mat.color.setRGB(...hexToRgb(opts.tint), THREE.SRGBColorSpace);
    // remaining THREE params (side, transparent, opacity, depthWrite, ...)
    try { mat.setValues(three); } catch (e) { /* ignore hostile opts */ }

    if (paintOpts.painterly !== false) {
      painterly(mat, {
        detail: this.detailTexture,
        macro: this.macroTexture,
        keyRef: this._keyRef(),
        ...BIOME_PAINT(this.biome),
        ...paintOpts,
      });
    }
    mat.userData.paintOverrides = paintOpts;
    this._applyRim(mat);
    if (set.animate) this.animated.push({ mat, set, cfg: set.animate });
    return mat;
  }

  _fallbackMaterial(name, opts) {
    // Never ship an untextured grey primitive (ART_DIRECTION §7). Unknown names
    // get the biome's stone so the frame still reads as painted.
    const set = this.set('stone.tartarus');
    if (set) return this._material(set, opts);
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(0x5a2331), roughness: 0.8 });
  }

  /**
   * The irradiance a fully-lit surface receives from the key. The painterly
   * ramp divides by this, and the rim is now scaled by it, so it has to track
   * the key's COLOUR as well as its intensity: a saturated #ff7a52 key delivers
   * 1.6x less luminance than a bleached #ffb894 one at the same intensity, and
   * ignoring that slides the whole terminator the moment the palette is
   * corrected back toward §2.
   */
  _keyRef() {
    const L = this.ctx && this.ctx.lighting;
    const i = (L && L.key && L.key.intensity) || 3.6;
    const c = L && L.key && L.key.color;
    const lum = c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) : 0.62;
    return Math.max(0.8, i * Math.max(0.12, lum) * 1.07);
  }

  // ---- extras other systems may use --------------------------------------
  /** Painterly-patch a material owned by another system. */
  patch(mat, opts = {}) {
    if (!mat) return mat;
    painterly(mat, { keyRef: this._keyRef(), ...BIOME_PAINT(this.biome), ...opts });
    return mat;
  }

  /** A ready-to-use character-look material (stronger rim, flatter ramp). */
  character(opts = {}) {
    const { color = '#c9b8ff', roughness = 0.62, metalness = 0.0, ...rest } = opts;
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...hexToRgb(color), THREE.SRGBColorSpace),
      roughness, metalness, dithering: true,
    });
    if (metalness > 0) {
      const e = this.env();
      if (e) { m.envMap = e; m.envMapIntensity = 0.6; }
    }
    painterly(m, { variant: 'character', keyRef: this._keyRef(), ...BIOME_PAINT(this.biome), ...rest });
    return m;
  }

  /** Retune rim / shadow tint for a biome across every patched material. */
  setBiome(name) {
    if (!BIOMES[name]) return this;
    this.biome = name;
    setBiomeLook(name);                       // palette rim / shadow tint / contour
    // Bake the new biome's stone and floor across the pool. Not awaited: the
    // world rebuild that follows will ask for them and take the sync path if it
    // wins the race, and every later request finds them cached.
    this.prebuild(this._bootSets(name));
    const e = this.env();
    for (const m of this.cache.values()) {
      if (e && m.envMap && m.envMap !== e) { m.envMap = e; m.needsUpdate = true; }
      this._applyRim(m);                      // the light rig's constant wins over the palette
    }
    return this;
  }

  // ---- the light rig <-> material handshake -------------------------------
  /**
   * The light rig publishes its ART-DIRECTED rim constant (and the biome's ink
   * colour + key reference) here; lighting.js calls this from setBiome(). We
   * BIND it — we never reimplement rim shading on the render side, and the
   * render side never reaches into our uniforms.
   *
   * payload = { color, dir, intensity, power, wrap, keyDir, keyColor, ink, biome }
   */
  setRim(payload) {
    if (!payload) return this;
    this._rim = payload;
    if (payload.env) this._bindEnv(payload.env);
    if (payload.biome && BIOMES[payload.biome] && payload.biome !== this.biome) return this.setBiome(payload.biome);
    for (const m of this.cache.values()) this._applyRim(m);
    return this;
  }

  /** Re-point every metal at the current prefiltered sky. */
  _bindEnv(tex) {
    if (!tex) return this;
    for (const m of this.cache.values()) {
      if (m.envMap && m.envMap !== tex) { m.envMap = tex; m.needsUpdate = true; }
    }
    return this;
  }

  /** Alias — some rigs call setLighting(). */
  setLighting(payload) { return this.setRim(payload); }

  /**
   * Push the published rim onto one material. A recipe that authored its own
   * rim (crystal, lava, blood) keeps its colour: hero materials are allowed to
   * disagree with the biome constant, everything else follows the rig.
   */
  _applyRim(mat) {
    const U = paintParams(mat);
    if (!U) return mat;
    if (U.uKeyRef) U.uKeyRef.value = this._keyRef();
    const rim = this._rim;
    if (!rim) return mat;
    const ov = mat.userData.paintOverrides || {};
    const cfg = mat.userData.paintConfig || {};
    const isChar = cfg.variant === 'character';
    if (rim.color && !ov.rimColor) U.uRimColor.value.copy(rim.color);
    if (rim.dir && !ov.rimDir) U.uRimDir.value.copy(rim.dir).normalize();
    if (rim.power && !ov.rimPower) U.uRimPower.value = rim.power;
    if (rim.intensity != null && ov.rimStrength == null) {
      const base = isChar ? CHARACTER_LOOK.rimStrength : ENVIRONMENT_LOOK.rimStrength;
      // The old mapping SATURATED at rim.intensity 2.2 (0.45 + 2.2*0.62 = 1.81
      // vs a 1.8 cap), so raising the rig's rim from 2.4 to 5.0 changed nothing
      // at all — which is exactly why the mandated #5fd0ff edge never appeared
      // no matter what the rig authored. Normalise around the reference 2.4 and
      // leave real headroom above it.
      // Headroom raised again with §9.6: the rim is now the frame's designated
      // COMPLEMENT source, and it also has to survive a key that was cut from
      // 52 to 34 (rimE is anchored to uKeyRef, so a smaller key silently makes
      // a smaller rim unless the strength moves the other way).
      const k = Math.min(isChar ? 1.45 : 1.75, Math.max(0.55, rim.intensity / 2.4));
      U.uRimStrength.value = base * k;
    }
    // the grade's AO ink is the same ink the contour should be drawn in
    if (rim.ink && !ov.contourColor) U.uContourColor.value.copy(rim.ink);
    return mat;
  }

  ramp(name) { return RAMPS[name] || RAMPS.ash; }
  color(name, t = 0.7) { const r = RAMPS[name]; return r ? rampAt(r, t) : [1, 0, 1]; }

  // ---- lifecycle ----------------------------------------------------------
  update(dt, ctx) { /* fixed-step sim: nothing to do */ }

  lateUpdate(alpha, ctx) {
    const t = (ctx && ctx.time && ctx.time.t) || 0;
    this._t = t;
    updatePainterly(t);
    // Defensive: if the light rig never called setRim() (stubbed rig, or a
    // different boot order) pull its published constant once, so the rim can
    // never be stale relative to the lighting.
    if (!this._rim && ctx && ctx.lighting && ctx.lighting.rim) {
      const L = ctx.lighting;
      this.setRim({
        color: L.rim.color, dir: L.rim.dir, intensity: L.rim.intensity, power: L.rim.power,
        ink: L.rimUniforms && L.rimUniforms.uInkColor && L.rimUniforms.uInkColor.value,
        biome: L.biome,
      });
    }
    for (const a of this.animated) {
      const c = a.cfg, m = a.mat;
      if (c.scroll) {
        const sx = c.scroll[0] * t, sy = c.scroll[1] * t;
        if (m.map) m.map.offset.set(sx, sy);
        if (m.emissiveMap && m.emissiveMap !== m.map) m.emissiveMap.offset.set(sx * 1.35, sy * 1.35);
        if (m.normalMap) m.normalMap.offset.set(sx * 0.7, sy * 0.7);
      }
      if (c.pulse && a.set.emissiveIntensity) {
        const p = 1 + c.pulse * (Math.sin(t * 1.7) * 0.5 + Math.sin(t * 0.61 + 1.3) * 0.35);
        m.emissiveIntensity = a.set.emissiveIntensity * p;
      }
    }
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    const disposed = new Set();
    for (const s of this.setCache.values()) {
      if (s.map && !disposed.has(s.map)) { s.map.dispose(); disposed.add(s.map); }
      if (s.proceduralMap && !disposed.has(s.proceduralMap)) { s.proceduralMap.dispose(); disposed.add(s.proceduralMap); }
      if (s.normalMap) s.normalMap.dispose();
      if (s.ormMap) s.ormMap.dispose();
      if (s.emissiveMap) s.emissiveMap.dispose();
    }
    for (const t of this.generatedMaps.values()) {
      if (!disposed.has(t)) { t.dispose(); disposed.add(t); }
    }
    this.cache.clear(); this.texCache.clear(); this.setCache.clear(); this.generatedMaps.clear(); this.animated.length = 0;
  }
}

// biome-specific painterly defaults
function BIOME_PAINT(biome) {
  const B = BIOMES[biome] || BIOMES.tartarus;
  return { rimColor: B.rim, rimDir: B.rimDir, shadowTint: B.shadowTint, contourColor: B.contour };
}

function stableKey(o) {
  if (!o) return '';
  const keys = Object.keys(o).sort();
  let s = '';
  for (const k of keys) {
    const v = o[k];
    s += k + '=' + (v && v.isTexture ? (v.name || v.uuid) : v && v.isColor ? v.getHexString() : Array.isArray(v) ? v.join(',') : String(v)) + ';';
  }
  return s;
}

export { RECIPES, painterly, setPaint, setBiomeLook };
export default MaterialLibrary;
