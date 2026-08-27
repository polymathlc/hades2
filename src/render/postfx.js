// OWNER: AGENT-RENDER — the EREBUS post chain.
//
// FINAL PASS ORDER
//   0  scene            -> rtScene (HalfFloat HDR + depth texture)
//   1  GTAO             -> rtAO            (half res, hemisphere, depth-only)
//   2  AO bilateral     -> rtAO (x2, separable, depth aware)
//   3  atmosphere       -> rtA   (ink-tinted AO + analytic height fog + haze band)
//   4  depth of field   -> rtB   (CoC + separable blur + recombine, play plane locked)
//   5  bloom bright     -> mip0  (Karis average, high threshold, soft knee)
//   6  bloom downsample -> mip1..N
//   7  bloom upsample   -> mip N-1..0 (additive tent)
//   8  god rays         -> rtGR  (bright/occlusion mask + 2x radial blur from the key light)
//   9  motion blur      -> optional, OFF by default
//  10  composite+grade  -> rtLDR (CA, radial kick, flash, AgX, lift/gamma/gain,
//                                 curves, hue-vs-hue, sat-by-luma, vignette, grain, sRGB)
//  11  SMAA (or FXAA)   -> rtAA
//  12  resolve tent     -> DEFAULT FRAMEBUFFER
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FS_VERT } from './shaders/lib.js';
import {
  AO_FRAG, AO_BLUR_FRAG, ATMOS_FRAG,
  DOF_COC_FRAG, DOF_BLUR_FRAG, DOF_COMBINE_FRAG,
  BLOOM_BRIGHT_FRAG, BLOOM_DOWN_FRAG, BLOOM_UP_FRAG,
  GR_MASK_FRAG, GR_BLUR_FRAG, COMPOSITE_FRAG, BLIT_FRAG, FXAA_FRAG, MOTION_FRAG,
  LUM_INIT_FRAG, BOX4_FRAG,
} from './shaders/passes.js';
import { GRADES, DEFAULT_BIOME, cloneGrade, mergeGrade } from './shaders/grades.js';

const C = (hex) => new THREE.Color(hex);
/** hue-preserving tint: normalise so the brightest channel is 1. */
function normTint(hex, out = new THREE.Color()){
  out.set(hex);
  const m = Math.max(out.r, out.g, out.b, 1e-4);
  out.multiplyScalar(1 / m);
  return out;
}

export class PostFX {
  constructor(){
    this.enabled = true;
    this.ready = false;
    this.biome = DEFAULT_BIOME;
    this._quads = [];
    this._rts = [];
    this._flash = { color: new THREE.Color('#ffffff'), amt: 0, t: 0, dur: 0.001, peak: 0, falloff: 0.62 };
    this._pulse = { chroma: 0, radial: 0, t: 0, dur: 0.001 };
    this._prevViewProj = new THREE.Matrix4();
    this._adapt = 1;
    this._lumPixel = new Uint8Array(4);
    this._curViewProj = new THREE.Matrix4();
    this._lightUV = new THREE.Vector2(0.5, 0.35);
    this._lightFade = 0;
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tmpC = new THREE.Color();
    // 1x1 black so a disabled pass never binds an undefined sampler
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  // ───────────────────────────────────────────────────────────────── init ──
  async init(ctx){
    this.ctx = ctx;
    const q = (ctx.quality && ctx.quality.render) || {};
    this.q = q;
    this.renderer = ctx.renderer;
    if(!this.renderer){ this.enabled = false; return; }

    this.scale = q.renderScale ?? 1;
    this.aoScale = q.aoScale ?? 0.5;
    this.grScale = q.godraysScale ?? 0.5;
    this.dofScale = q.dofScale ?? 0.5;
    this.mipCount = Math.max(2, q.bloomMips ?? 6);

    // ── live, critic-tunable parameter block ───────────────────────────────
    // window.EREBUS.ctx.post.params.<pass>.enabled = false  →  instant A/B
    this.params = {
      master: 1.0,
      ssaa:       { scale: this.scale },
      ao:         { enabled: q.ao !== false },
      fog:        { enabled: q.fog !== false, scatter: 0.55, voidFog: 0.55, densityMul: 1.0, hazeAmount: 1.0 },
      dof:        { enabled: q.dof !== false, autoFocus: true, focus: 26, focusRange: 6.5, tilt: 0.22, tiltCenter: 0.56, tapStride: 1.5 },
      bloom:      { enabled: q.bloom !== false },
      godrays:    { enabled: q.godrays !== false, threshold: 2.45, occludeGeo: 0.12, stride: 1.0 },
      motionBlur: { enabled: false, amount: 0.55, maxPx: 14 },
      chroma:     { enabled: q.chroma !== false, scale: 1.0 },
      vignette:   { enabled: true, depth: 0.22 },
      grain:      { enabled: q.grain !== false, scale: 1.0 },
      grade:      { enabled: true },
      // Art-directed auto-exposure. The biome grade still sets the look; this
      // only compensates for how bright the shipped materials actually are, so
      // a frame can never come back black or blown while other systems iterate.
      // §1.8 island of light in a DARK VOID. This is a SAFETY TRIM, not an
      // auto-exposure. A wide adaptation range is fundamentally wrong for this
      // genre: the wide establishing shot contains more void than the play
      // shot, so it metered darker, adapted up, and inflated the backdrop into
      // a mauve haze brighter than the arena it was supposed to frame. The
      // biome grade owns the level; this only stops another system's bright
      // content from blowing the frame while it iterates. +-0.2 stops, no more.
      // A 0.66 centre weight on a game whose brightest object is a fixed emissive
      // medallion in the middle of the arena means the meter is metering the
      // MEDALLION: 05_floor graded hot-red and 06_architecture graded cool-mauve
      // off the same chamber and the same rig, purely because the camera moved.
      // That is a feedback loop, not a grade. Near-flat weighting, +-0.03 stops,
      // and OFF entirely in the capture harness so A/B comparisons are valid.
      autoExposure: { enabled: true, target: 0.085, min: 0.97, max: 1.03, speed: 2.2, centerWeight: 0.15 },
      aa:         { enabled: (q.aa ?? 'smaa') !== 'none', mode: q.aa ?? 'smaa' },
    };

    // The capture harness must grade every shot identically or the critics are
    // measuring a moving target (see the note on centreWeight above).
    if(ctx.quality && ctx.quality.preserveDrawingBuffer) this.params.autoExposure.enabled = false;

    this.grade = cloneGrade(GRADES[this.biome] || GRADES[DEFAULT_BIOME]);
    this._syncParamsFromGrade();

    this._buildMaterials();
    this._allocate();

    // SMAA needs its lookup textures decoded before the first capture frame.
    if(this.params.aa.mode === 'smaa'){
      try {
        this.smaa = new SMAAPass();
        this.smaa.renderToScreen = false;
        await this._awaitSMAA(this.smaa);
        this.smaa.setSize(this.W, this.H);
      } catch(e){
        this.smaa = null;
        this.params.aa.mode = 'fxaa';
      }
    }

    ctx.events?.on?.('hit.stop', ({ ms }) => this.pulse({ chroma: 1.0, radial: 0.55, dur: Math.max(0.12, (ms || 60) / 1000 + 0.09) }));
    ctx.events?.on?.('post.pulse', (p) => this.pulse(p || {}));
    ctx.events?.on?.('post.flash', (p) => this.flash(p || {}));
    ctx.events?.on?.('biome.changed', ({ name }) => this.setBiome(name));

    this.ready = true;
  }

  async _awaitSMAA(pass){
    const imgs = [pass._areaTexture, pass._searchTexture].map(t => t && t.image).filter(Boolean);
    if(!imgs.length) return;
    const t0 = Date.now();
    while(Date.now() - t0 < 3000){
      if(imgs.every(i => i.complete !== false && (i.naturalWidth === undefined || i.naturalWidth > 0))) return;
      await new Promise(r => setTimeout(r, 16));
    }
  }

  // ────────────────────────────────────────────────────────── materials ──
  _mat(frag, uniforms, defines){
    const m = new THREE.ShaderMaterial({
      vertexShader: FS_VERT, fragmentShader: frag,
      uniforms, defines: defines || {},
      depthTest: false, depthWrite: false, transparent: false,
    });
    return m;
  }

  _buildMaterials(){
    const q = this.q;

    this.mAO = this._mat(AO_FRAG, {
      tDepth: { value: null }, uTexel: { value: new THREE.Vector2() },
      uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() },
      uNear: { value: 0.5 }, uFar: { value: 400 },
      uRadius: { value: 1.35 }, uBias: { value: 0.045 }, uPower: { value: 1.7 },
    }, { AO_DIRS: Math.max(2, q.aoDirs ?? 5), AO_STEPS: Math.max(2, q.aoSteps ?? 5) });

    this.mAOBlur = this._mat(AO_BLUR_FRAG, {
      tAO: { value: null }, tDepth: { value: null },
      uDir: { value: new THREE.Vector2() },
      uNear: { value: 0.5 }, uFar: { value: 400 }, uSharpness: { value: 6.0 },
    });

    // CONTACT occlusion. The wide 1.35-world-unit GTAO tap at half res with a
    // bilateral blur averages the thin wedge where a wall meets the floor
    // straight out of existence, which is why nothing in the frame reads as
    // GROUNDED. A second, very short-radius tap is multiplied into the wide one
    // so props sit on the stone instead of decalling on to it.
    this.mAOMul = this._mat(/* glsl */`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tA, tB;
      uniform float uStrength;
      void main(){
        float a = texture2D(tA, vUv).r;
        float b = texture2D(tB, vUv).r;
        b = mix(1.0, b, uStrength);
        gl_FragColor = vec4(vec3(a * b), 1.0);
      }`, {
      tA: { value: null }, tB: { value: null }, uStrength: { value: 1.0 },
    });

    this.mAtmos = this._mat(ATMOS_FRAG, {
      tScene: { value: null }, tAO: { value: null }, tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uNear: { value: 0.5 }, uFar: { value: 400 },
      uInk: { value: C('#3a1d52') }, uAOAmount: { value: 0.85 }, uAOEnabled: { value: 1 },
      uFogEnabled: { value: 1 },
      uFogNear: { value: C('#2a1030') }, uFogFar: { value: C('#160a20') },
      uFogDensity: { value: 0.03 }, uFogFalloff: { value: 0.16 }, uFogBase: { value: 0 },
      uVoidFog: { value: 0.55 }, uArenaR: { value: 16 },
      uKeyDir: { value: new THREE.Vector3(-0.5, -0.7, -0.5) }, uKeyColor: { value: C('#ff5a3c') },
      uScatter: { value: 0.55 },
      uHaze: { value: C('#241238') },
      uHazeStart: { value: 26 }, uHazeEnd: { value: 120 }, uHazeDesat: { value: 0.62 }, uVoidSky: { value: 0.30 }, uHazeAmount: { value: 1 },
      // §11: the recession is anchored to the CHAMBER as well as to the lens.
      // hazeR0/hazeR1 are multiples of the arena radius, so the play space is
      // never hazed and everything past the rim recedes identically from every
      // pose. hazeRadial 0 disables the radial ramp for a biome that does not
      // want it.
      uHazeR0: { value: 1.15 }, uHazeR1: { value: 2.4 }, uHazeRadial: { value: 0 },
    });

    this.mDofCoc = this._mat(DOF_COC_FRAG, {
      tScene: { value: null }, tDepth: { value: null },
      uNear: { value: 0.5 }, uFar: { value: 400 },
      uFocus: { value: 26 }, uFocusRange: { value: 6.5 }, uFarRange: { value: 26 }, uNearRange: { value: 9 },
      uMaxBlur: { value: 0.85 }, uNearMax: { value: 0.3 },
      uTilt: { value: 0.22 }, uTiltCenter: { value: 0.56 },
    });
    this.mDofBlur = this._mat(DOF_BLUR_FRAG, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.mDofComb = this._mat(DOF_COMBINE_FRAG, { tScene: { value: null }, tBlur: { value: null } });

    this.mBright = this._mat(BLOOM_BRIGHT_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uThreshold: { value: 1.05 }, uKnee: { value: 0.55 }, uClamp: { value: 6.0 },
    });
    this.mDown = this._mat(BLOOM_DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mUp = this._mat(BLOOM_UP_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.0 }, uScale: { value: 1.0 },
    });
    this.mUp.blending = THREE.AdditiveBlending;
    this.mUp.transparent = true;

    this.mGRMask = this._mat(GR_MASK_FRAG, {
      tSrc: { value: null }, tDepth: { value: null },
      uThreshold: { value: 0.85 }, uOccludeGeo: { value: 0.12 },
    });
    this.mGRBlur = this._mat(GR_BLUR_FRAG, {
      tSrc: { value: null }, uLightUV: { value: new THREE.Vector2(0.5, 0.3) },
      uDensity: { value: 0.75 }, uDecay: { value: 0.955 }, uWeight: { value: 0.5 }, uStride: { value: 1.0 },
    }, { GR_SAMPLES: Math.max(8, q.godraysSamples ?? 24) });

    this.mMotion = this._mat(MOTION_FRAG, {
      tSrc: { value: null }, tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uRes: { value: new THREE.Vector2() }, uAmount: { value: 0.55 }, uMaxPx: { value: 14 },
    });

    this.mComp = this._mat(COMPOSITE_FRAG, {
      tScene: { value: null }, tBloom: { value: null }, tGodrays: { value: null },
      uRes: { value: new THREE.Vector2() }, uAspect: { value: 1.78 }, uMaster: { value: 1 },
      uBloomIntensity: { value: 0.48 }, uBloomTint: { value: C('#ffe0b8') },
      uGRIntensity: { value: 0.42 }, uGRColor: { value: C('#ff7a44') },
      uChroma: { value: 1.35 }, uRadial: { value: 0 },
      uFlashColor: { value: C('#ffffff') }, uFlashAmount: { value: 0 }, uFlashFalloff: { value: 0.62 },
      uExposure: { value: 1.06 },
      uAgxSlope: { value: new THREE.Vector3(1, 1, 1) }, uAgxPower: { value: new THREE.Vector3(1.15, 1.15, 1.2) },
      uAgxSat: { value: 1.18 },
      uLift: { value: new THREE.Vector3() }, uGamma: { value: new THREE.Vector3(1, 1, 1) },
      uGain: { value: new THREE.Vector3(1, 1, 1) }, uCurve: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: 0.45 }, uLogPivot: { value: -1.556 }, uShoulder: { value: 0.15 },
      uBlack: { value: 0.012 }, uWhite: { value: 1.0 }, uHiRoll: { value: 1.0 },
      uShadowTint: { value: C('#4b2b78') }, uMidTint: { value: C('#ffb28a') }, uHighTint: { value: C('#ffe6b4') },
      uTintStrength: { value: 1 }, uShadowMix: { value: 0.45 }, uHighMix: { value: 0.3 },
      uSatShadow: { value: 0.62 }, uSatMid: { value: 1.26 }, uSatHigh: { value: 0.94 },
      uHueLobe0: { value: new THREE.Vector3(0.66, 0.13, 0.055) },
      uHueLobe1: { value: new THREE.Vector3(0.04, 0.10, 0.02) },
      uHueLobe2: { value: new THREE.Vector3(0.12, 0.09, -0.018) },
      uVigAmount: { value: 0.52 }, uVigRadius: { value: 0.78 }, uVigSoft: { value: 0.62 },
      uVigDepth: { value: 0.22 }, uVigFloor: { value: 0.0 }, uVigColor: { value: C('#1a0a22') },
      uGrainAmount: { value: 0.03 }, uGrainSize: { value: 1.25 }, uGrainDark: { value: 2.1 }, uGrainSeed: { value: 0 },
    });

    this.mLumInit = this._mat(LUM_INIT_FRAG, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uCenterW: { value: 0.55 },
    });
    this.mBox4 = this._mat(BOX4_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });

    this.mFxaa = this._mat(FXAA_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.mBlit = this._mat(BLIT_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uTent: { value: 0 } });

    this.quad = new FullScreenQuad(this.mBlit);
  }

  // ───────────────────────────────────────────────────────── allocation ──
  _rt(w, h, opts = {}){
    const rt = new THREE.WebGLRenderTarget(Math.max(2, w | 0), Math.max(2, h | 0), {
      type: opts.byte ? THREE.UnsignedByteType : THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: !!opts.depth, stencilBuffer: false, generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
      samples: 0,
    });
    if(opts.depth){
      const dt = new THREE.DepthTexture(Math.max(2, w | 0), Math.max(2, h | 0));
      dt.type = THREE.UnsignedIntType;
      dt.format = THREE.DepthFormat;
      dt.minFilter = THREE.NearestFilter;
      dt.magFilter = THREE.NearestFilter;
      rt.depthTexture = dt;
    }
    this._rts.push(rt);
    return rt;
  }

  _internal(){
    const v = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(v);
    return {
      w: Math.max(4, Math.round(v.x * this.params.ssaa.scale)),
      h: Math.max(4, Math.round(v.y * this.params.ssaa.scale)),
      cw: Math.max(4, Math.round(v.x)), ch: Math.max(4, Math.round(v.y)),
    };
  }

  _allocate(){
    for(const rt of this._rts) rt.dispose();
    this._rts.length = 0;
    const s = this._internal();
    this.W = s.w; this.H = s.h; this.CW = s.cw; this.CH = s.ch;

    this.rtScene = this._rt(s.w, s.h, { depth: true });
    this.rtA = this._rt(s.w, s.h);
    this.rtB = this._rt(s.w, s.h);

    const aw = Math.max(4, Math.round(s.w * this.aoScale)), ah = Math.max(4, Math.round(s.h * this.aoScale));
    this.rtAO = this._rt(aw, ah);
    this.rtAO2 = this._rt(aw, ah);
    this.rtAO3 = this._rt(aw, ah);
    this.rtAO4 = this._rt(aw, ah);

    const dw = Math.max(4, Math.round(s.w * this.dofScale)), dh = Math.max(4, Math.round(s.h * this.dofScale));
    this.rtDofA = this._rt(dw, dh);
    this.rtDofB = this._rt(dw, dh);

    this.mips = [];
    let mw = Math.max(4, s.w >> 1), mh = Math.max(4, s.h >> 1);
    for(let i = 0; i < this.mipCount; i++){
      this.mips.push(this._rt(mw, mh));
      mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1);
      if(mw < 16 || mh < 12) break;
    }

    const gw = Math.max(4, Math.round(s.w * this.grScale * 0.5)), gh = Math.max(4, Math.round(s.h * this.grScale * 0.5));
    this.rtGR1 = this._rt(gw, gh);
    this.rtGR2 = this._rt(gw, gh);

    // metering pyramid: 64 -> 1, RGBA8 so the readback is a plain Uint8Array
    this.lum = [];
    for(let n = 64; n >= 1; n >>= 1) this.lum.push(this._rt(n, n, { byte: true }));

    this.rtLDR = this._rt(s.w, s.h, { byte: true });
    this.rtAA = this._rt(s.w, s.h, { byte: true });

    if(this.smaa) this.smaa.setSize(s.w, s.h);
  }

  resize(w, h, ctx){
    if(!this.ready) return;
    this._allocate();
  }

  // ────────────────────────────────────────────────────────────── API ──
  /** Switch the whole look to a named biome grade. Keeps per-pass toggles. */
  setBiome(name){
    if(!GRADES[name]) return this;
    this.biome = name;
    const toggles = {};
    for(const k in this.params) if(this.params[k] && typeof this.params[k] === 'object' && 'enabled' in this.params[k]) toggles[k] = this.params[k].enabled;
    this.grade = cloneGrade(GRADES[name]);
    this._syncParamsFromGrade();
    for(const k in toggles) if(this.params[k]) this.params[k].enabled = toggles[k];
    return this;
  }

  /** Merge a partial grade. e.g. post.setGrade({ exposure:1.2, bloom:{intensity:1.1} }) */
  setGrade(partial){
    if(!partial) return this;
    mergeGrade(this.grade, partial);
    this._syncParamsFromGrade();
    // also allow direct per-pass writes through the same call
    for(const k in partial){
      if(this.params[k] && typeof partial[k] === 'object' && !Array.isArray(partial[k])) Object.assign(this.params[k], partial[k]);
    }
    return this;
  }

  /** 0..1 master blend of the whole grade against a neutral filmic tonemap. */
  setIntensity(v){ this.params.master = THREE.MathUtils.clamp(v ?? 1, 0, 1); return this; }

  /** Hit feedback: a chromatic + radial-blur kick that decays over `dur`. */
  pulse({ chroma = 1, radial = 0.5, dur = 0.18 } = {}){
    this._pulse.chroma = Math.max(this._pulse.chroma, chroma);
    this._pulse.radial = Math.max(this._pulse.radial, radial);
    this._pulse.dur = Math.max(0.02, dur);
    this._pulse.t = 0;
    return this;
  }

  /** Screen flash, additive and pre-tonemap so it rolls off filmically. */
  flash({ color = '#ffffff', intensity = 1, dur = 0.22, falloff = 0.62 } = {}){
    this._flash.color.set(color);
    this._flash.peak = Math.max(this._flash.peak * 0.5, intensity);
    this._flash.dur = Math.max(0.02, dur);
    this._flash.falloff = falloff;
    this._flash.t = 0;
    this._flash.amt = this._flash.peak;
    return this;
  }

  // ───────────────────────────────────────────────────────── internals ──
  /**
   * Convert a DISPLAY-referred threshold into the scene-referred units the
   * bright pass and the godray mask actually see. Both of those passes run
   * before the composite applies `exposure`, so without this every threshold in
   * the grade table is implicitly multiplied by whatever exposure happens to be
   * set — which is how the bloom gate drifted 3.4 stops when tartarus was
   * pushed to exposure 2.90 (ART_DIRECTION §1.7, "bloom is a paint layer").
   */
  _anchor(v){
    const g = this.grade || {};
    return v / Math.max(0.05, (g.exposure ?? 1) * (this._adapt || 1));
  }

  _syncParamsFromGrade(){
    const g = this.grade;
    const p = this.params;
    // pull the preset's per-pass numbers into the live param groups so the
    // critic can poke any of them without knowing where they came from
    p.bloom = Object.assign(p.bloom || {}, { enabled: p.bloom?.enabled ?? true }, g.bloom);
    p.ao = Object.assign(p.ao || {}, { enabled: p.ao?.enabled ?? true }, g.ao);
    p.godrays = Object.assign({ threshold: 2.45, occludeGeo: 0.12, stride: 1.0 }, p.godrays || {}, g.godrays);
    p.vignette = Object.assign({ depth: 0.22 }, p.vignette || {}, g.vignette);
    p.grain = Object.assign({ scale: 1 }, p.grain || {}, g.grain);
    p.chroma = Object.assign({ scale: 1 }, p.chroma || {}, { amount: g.chroma });
    p.dof = Object.assign({ autoFocus: true, focus: 26, focusRange: 6.5, tilt: 0.22, tiltCenter: 0.56, tapStride: 1.5 }, p.dof || {}, g.dof);
    p.fog = Object.assign({ scatter: 0.55, voidFog: 0.55, densityMul: 1, hazeAmount: 1 }, p.fog || {}, g.fog);
  }

  lateUpdate(alpha, ctx){
    const dt = (ctx.time && ctx.time.unscaledDt) || 0;
    if(this._pulse.t < this._pulse.dur){ this._pulse.t = Math.min(this._pulse.dur, this._pulse.t + dt); }
    if(this._flash.t < this._flash.dur){ this._flash.t = Math.min(this._flash.dur, this._flash.t + dt); }
  }

  _blit(mat, target, additive = false){
    const r = this.renderer;
    this.quad.material = mat;
    r.setRenderTarget(target);
    if(additive){ r.autoClear = false; } else { r.autoClear = true; }
    this.quad.render(r);
    r.autoClear = true;
  }

  // ───────────────────────────────────────────────────────────── render ──
  render(ctx){
    const r = this.renderer || ctx.renderer;
    if(!r || !this.ready){ if(r){ r.setRenderTarget(null); r.render(ctx.scene, ctx.camera); } return; }

    // resolution can change under us (resize, dpr, tier switch)
    const s = this._internal();
    if(s.w !== this.W || s.h !== this.H) this._allocate();

    const cam = ctx.camera, scene = ctx.scene;
    const p = this.params, g = this.grade;
    const atm = ctx.atmosphere || null;
    const lig = ctx.lighting || null;

    cam.updateMatrixWorld();
    this._curViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    // ── 0. scene -> HDR ────────────────────────────────────────────────────
    r.setRenderTarget(this.rtScene);
    r.autoClear = true;
    r.render(scene, cam);

    const depth = this.rtScene.depthTexture;
    const near = cam.near, far = cam.far;

    // ── 1-2. ambient occlusion ─────────────────────────────────────────────
    const aoOn = p.ao.enabled && (this.q.ao !== false);
    let aoTex = this.rtAO.texture;
    if(aoOn){
      const u = this.mAO.uniforms;
      u.tDepth.value = depth;
      u.uTexel.value.set(1 / this.rtAO.width, 1 / this.rtAO.height);
      u.uProj.value.copy(cam.projectionMatrix);
      u.uInvProj.value.copy(cam.projectionMatrixInverse);
      u.uNear.value = near; u.uFar.value = far;
      u.uRadius.value = p.ao.radius ?? 1.35;
      u.uBias.value = p.ao.bias ?? 0.045;
      u.uPower.value = p.ao.power ?? 1.7;
      this._blit(this.mAO, this.rtAO);

      const b = this.mAOBlur.uniforms;
      b.tDepth.value = depth; b.uNear.value = near; b.uFar.value = far;
      b.tAO.value = this.rtAO.texture; b.uDir.value.set(1 / this.rtAO.width, 0);
      this._blit(this.mAOBlur, this.rtAO2);
      b.tAO.value = this.rtAO2.texture; b.uDir.value.set(0, 1 / this.rtAO.height);
      this._blit(this.mAOBlur, this.rtAO);

      // ── 1b. short-radius CONTACT tap, multiplied into the wide term ──────
      // Half the blur width of the wide pass so the 6-12px wedge at a wall base
      // survives the bilateral filter instead of being averaged flat.
      u.uRadius.value = p.ao.contactRadius ?? 0.30;
      u.uBias.value = p.ao.contactBias ?? 0.02;
      u.uPower.value = p.ao.contactPower ?? 2.4;
      this._blit(this.mAO, this.rtAO3);
      b.tAO.value = this.rtAO3.texture; b.uDir.value.set(0.5 / this.rtAO.width, 0);
      this._blit(this.mAOBlur, this.rtAO4);
      b.tAO.value = this.rtAO4.texture; b.uDir.value.set(0, 0.5 / this.rtAO.height);
      this._blit(this.mAOBlur, this.rtAO3);

      this.mAOMul.uniforms.tA.value = this.rtAO.texture;
      this.mAOMul.uniforms.tB.value = this.rtAO3.texture;
      this.mAOMul.uniforms.uStrength.value = p.ao.contact ?? 0.85;
      this._blit(this.mAOMul, this.rtAO4);
      aoTex = this.rtAO4.texture;
    }

    // ── 3. atmosphere composite (ink AO + height fog + haze) ───────────────
    {
      const u = this.mAtmos.uniforms;
      u.tScene.value = this.rtScene.texture;
      u.tAO.value = aoTex;
      u.tDepth.value = depth;
      u.uInvViewProj.value.copy(this._curViewProj).invert();
      u.uCamPos.value.copy(cam.position);
      u.uNear.value = near; u.uFar.value = far;
      u.uAOEnabled.value = aoOn ? 1 : 0;
      u.uInk.value.set(p.ao.ink || '#3a1d52');
      u.uAOAmount.value = p.ao.intensity ?? 0.85;

      const fogOn = p.fog.enabled && (this.q.fog !== false);
      u.uFogEnabled.value = fogOn ? 1 : 0;
      u.uFogNear.value.set(p.fog.color || '#2a1030');
      u.uFogFar.value.set(p.fog.far || '#160a20');
      u.uFogDensity.value = (p.fog.density ?? 0.03) * (p.fog.densityMul ?? 1) * (atm?.fogScale ?? 1);
      u.uFogFalloff.value = p.fog.height ?? 0.16;
      u.uFogBase.value = atm?.fogBase ?? 0;
      u.uVoidFog.value = p.fog.voidFog ?? 0.55;
      u.uArenaR.value = (ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 16;
      u.uScatter.value = p.fog.scatter ?? 0.55;
      if(lig && lig.keyDir) u.uKeyDir.value.copy(lig.keyDir);
      if(lig && lig.keyColor) u.uKeyColor.value.copy(lig.keyColor);
      u.uHaze.value.set(p.fog.haze || '#241238');
      u.uHazeStart.value = p.fog.hazeStart ?? 26;
      u.uHazeEnd.value = p.fog.hazeEnd ?? 120;
      u.uHazeDesat.value = p.fog.hazeDesat ?? 0.62;
      u.uHazeR0.value = p.fog.hazeR0 ?? 1.15;
      u.uHazeR1.value = p.fog.hazeR1 ?? 2.4;
      u.uHazeRadial.value = fogOn ? (p.fog.hazeRadial ?? 0) : 0;
      u.uHazeAmount.value = p.fog.hazeAmount ?? 1;
      u.uVoidSky.value = fogOn ? (p.fog.voidSky ?? 0.30) : 0;
      this._blit(this.mAtmos, this.rtA);
    }

    let src = this.rtA;

    // ── 4. depth of field ──────────────────────────────────────────────────
    if(p.dof.enabled && this.q.dof !== false){
      let focus = p.dof.focus;
      if(p.dof.autoFocus){
        const t = (ctx.player && ctx.player.position) ? ctx.player.position : this._tmpV.set(0, 1, 0);
        focus = cam.position.distanceTo(t);
      }
      const u = this.mDofCoc.uniforms;
      u.tScene.value = src.texture; u.tDepth.value = depth;
      u.uNear.value = near; u.uFar.value = far;
      u.uFocus.value = focus;
      u.uFocusRange.value = p.dof.focusRange ?? 6.5;
      u.uFarRange.value = p.dof.range ?? 26;
      u.uNearRange.value = p.dof.nearRange ?? 9;
      u.uMaxBlur.value = p.dof.maxBlur ?? 0.85;
      u.uNearMax.value = p.dof.nearMax ?? 0.3;
      u.uTilt.value = p.dof.tilt ?? 0.22;
      u.uTiltCenter.value = p.dof.tiltCenter ?? 0.56;
      this._blit(this.mDofCoc, this.rtDofA);

      const bu = this.mDofBlur.uniforms;
      // Tap stride must stay under ~1.5 half-res texels or the 13-tap gaussian
      // undersamples and lays a visible weave over flat, fully-defocused areas
      // (the void). Gentle DoF is the brief anyway.
      const rad = (p.dof.tapStride ?? 1.5);
      bu.tSrc.value = this.rtDofA.texture; bu.uDir.value.set(rad / this.rtDofA.width, 0);
      this._blit(this.mDofBlur, this.rtDofB);
      bu.tSrc.value = this.rtDofB.texture; bu.uDir.value.set(0, rad / this.rtDofA.height);
      this._blit(this.mDofBlur, this.rtDofA);

      const cu = this.mDofComb.uniforms;
      cu.tScene.value = src.texture; cu.tBlur.value = this.rtDofA.texture;
      this._blit(this.mDofComb, this.rtB);
      src = this.rtB;
    }

    // ── 9. (optional) camera motion blur, before the additive layers ───────
    if(p.motionBlur.enabled){
      const u = this.mMotion.uniforms;
      u.tSrc.value = src.texture; u.tDepth.value = depth;
      u.uInvViewProj.value.copy(this._curViewProj).invert();
      u.uPrevViewProj.value.copy(this._prevViewProj);
      u.uRes.value.set(this.W, this.H);
      u.uAmount.value = p.motionBlur.amount;
      u.uMaxPx.value = p.motionBlur.maxPx;
      const dst = (src === this.rtA) ? this.rtB : this.rtA;
      this._blit(this.mMotion, dst);
      src = dst;
    }

    // ── auto-exposure metering (same frame, so captures stay deterministic) ─
    this._meter(ctx, src);

    // ── 5-7. multi-mip bloom ───────────────────────────────────────────────
    const bloomOn = p.bloom.enabled && this.mips.length >= 2 && this.q.bloom !== false;
    if(bloomOn){
      const bu = this.mBright.uniforms;
      bu.tSrc.value = src.texture;
      bu.uTexel.value.set(1 / this.W, 1 / this.H);
      // EXPOSURE-ANCHORED. The bright pass runs on the SCENE-REFERRED buffer,
      // but `exposure` is applied later in the composite — so a scene-linear
      // threshold silently moves by however many stops the grade's exposure
      // moves. That is exactly how a 2.15 threshold under an exposure of 2.90
      // ended up gating at 0.74 display-referred and fogged every lit surface
      // in the frame. Dividing here makes the authored number DISPLAY-referred
      // and this class of bug cannot recur when anyone retunes exposure.
      bu.uThreshold.value = this._anchor(p.bloom.threshold ?? 2.35);
      bu.uKnee.value = Math.max(0.01, p.bloom.knee ?? 0.5);
      bu.uClamp.value = Math.max(1.0, p.bloom.clamp ?? 6.0);
      this._blit(this.mBright, this.mips[0]);

      for(let i = 1; i < this.mips.length; i++){
        const s0 = this.mips[i - 1];
        this.mDown.uniforms.tSrc.value = s0.texture;
        this.mDown.uniforms.uTexel.value.set(1 / s0.width, 1 / s0.height);
        this._blit(this.mDown, this.mips[i]);
      }
      const radius = p.bloom.radius ?? 1.0;
      for(let i = this.mips.length - 1; i > 0; i--){
        const s0 = this.mips[i];
        this.mUp.uniforms.tSrc.value = s0.texture;
        this.mUp.uniforms.uTexel.value.set(1 / s0.width, 1 / s0.height);
        this.mUp.uniforms.uRadius.value = radius;
        this.mUp.uniforms.uScale.value = 1.0;
        this._blit(this.mUp, this.mips[i - 1], true);
      }
    }

    // ── 8. volumetric shafts ───────────────────────────────────────────────
    const grOn = p.godrays.enabled && this.q.godrays !== false;
    if(grOn){
      this._updateLightUV(ctx, cam, lig);
      const mu = this.mGRMask.uniforms;
      mu.tSrc.value = src.texture; mu.tDepth.value = depth;
      mu.uThreshold.value = this._anchor(p.godrays.threshold ?? 2.45);
      mu.uOccludeGeo.value = p.godrays.occludeGeo ?? 0.12;
      this._blit(this.mGRMask, this.rtGR1);

      const gu = this.mGRBlur.uniforms;
      gu.uLightUV.value.copy(this._lightUV);
      gu.uDensity.value = p.godrays.density ?? 0.75;
      gu.uDecay.value = p.godrays.decay ?? 0.955;
      gu.uWeight.value = p.godrays.weight ?? 0.5;
      gu.tSrc.value = this.rtGR1.texture; gu.uStride.value = 1.0 * (p.godrays.stride ?? 1);
      this._blit(this.mGRBlur, this.rtGR2);
      gu.tSrc.value = this.rtGR2.texture; gu.uStride.value = 3.0 * (p.godrays.stride ?? 1);
      this._blit(this.mGRBlur, this.rtGR1);
    }

    // ── 10. composite + grade ──────────────────────────────────────────────
    this._updateGradeUniforms(ctx, src, bloomOn, grOn);
    this._blit(this.mComp, this.rtLDR);

    // ── 11. anti-aliasing ──────────────────────────────────────────────────
    let final = this.rtLDR;
    if(p.aa.enabled){
      if(p.aa.mode === 'smaa' && this.smaa){
        r.autoClear = true;
        this.smaa.renderToScreen = false;
        this.smaa.render(r, this.rtAA, this.rtLDR, 0, false);
        final = this.rtAA;
      } else if(p.aa.mode !== 'none'){
        this.mFxaa.uniforms.tSrc.value = this.rtLDR.texture;
        this.mFxaa.uniforms.uTexel.value.set(1 / this.W, 1 / this.H);
        this._blit(this.mFxaa, this.rtAA);
        final = this.rtAA;
      }
    }

    // ── 12. resolve to the DEFAULT FRAMEBUFFER (never leave it in an FBO) ───
    this.mBlit.uniforms.tSrc.value = final.texture;
    this.mBlit.uniforms.uTexel.value.set(1 / this.W, 1 / this.H);
    this.mBlit.uniforms.uTent.value = this.params.ssaa.scale;
    this.quad.material = this.mBlit;
    r.setRenderTarget(null);
    r.autoClear = true;
    this.quad.render(r);

    this._prevViewProj.copy(this._curViewProj);
  }

  /**
   * Centre-weighted geometric-mean metering. Runs inside the same render call
   * that consumes it, so a headless capture is byte-identical every run: there
   * is no frame-to-frame history to seed.
   */
  _meter(ctx, src){
    const p = this.params.autoExposure;
    if(!p || !p.enabled || !this.lum || !this.lum.length){ this._adapt = 1; return; }
    const r = this.renderer;
    this.mLumInit.uniforms.tSrc.value = src.texture;
    this.mLumInit.uniforms.uTexel.value.set(1 / this.W, 1 / this.H);
    this.mLumInit.uniforms.uCenterW.value = p.centerWeight ?? 0.66;
    this._blit(this.mLumInit, this.lum[0]);
    for(let i = 1; i < this.lum.length; i++){
      this.mBox4.uniforms.tSrc.value = this.lum[i - 1].texture;
      this.mBox4.uniforms.uTexel.value.set(1 / this.lum[i - 1].width, 1 / this.lum[i - 1].height);
      this._blit(this.mBox4, this.lum[i]);
    }
    const one = this.lum[this.lum.length - 1];
    try { r.readRenderTargetPixels(one, 0, 0, 1, 1, this._lumPixel); }
    catch(e){ this._adapt = 1; return; }
    const w = this._lumPixel[1] / 255;
    if(w < 0.004){ return; }
    const norm = (this._lumPixel[0] / 255) / w;
    const avgL = Math.pow(2, norm * 32 - 16);
    // NOTE: deliberately NOT divided by the grade's exposure. Dividing by it
    // would make the biome's authored exposure cancel out of `grade.exposure *
    // adapt` entirely; keeping it out leaves that value as a real per-biome
    // stop bias applied on top of the adaptation.
    const want = THREE.MathUtils.clamp((p.target ?? 0.050) / Math.max(1e-5, avgL), p.min ?? 0.90, p.max ?? 1.15);
    if(ctx.capture){
      this._adapt = want;                       // deterministic: converge instantly
    } else {
      const dt = Math.min(0.1, (ctx.time && ctx.time.unscaledDt) || 1 / 60);
      this._adapt += (want - this._adapt) * (1 - Math.exp(-(p.speed ?? 2.2) * dt));
    }
    this.meteredLuma = avgL;
  }

  _updateLightUV(ctx, cam, lig){
    // The radial-blur origin. In a 3/4 iso frame the key light is almost always
    // off-screen above, so an authored per-biome anchor beats a raw projection —
    // shafts should pour into frame from the direction the biome's light lives.
    const p = this.params.godrays;
    const anchor = p.anchorUV || (lig && lig.godrayAnchor);
    if(anchor){
      this._lightUV.set(anchor[0], anchor[1]);
      this._lightFade = 1;
      return;
    }
    const dir = (lig && lig.keyDir) ? lig.keyDir : this._tmpV2.set(-0.55, -0.7, -0.45).normalize();
    const a = (ctx.player && ctx.player.position) ? ctx.player.position : { x: 0, y: 0, z: 0 };
    const v = this._tmpV.set(a.x - dir.x * 120, (a.y || 0) - dir.y * 120, a.z - dir.z * 120);
    v.applyMatrix4(cam.matrixWorldInverse);
    if(v.z > -cam.near) v.z = -cam.near;           // pull points behind the camera forward
    v.applyMatrix4(cam.projectionMatrix);
    this._lightUV.set(
      THREE.MathUtils.clamp(v.x * 0.5 + 0.5, -0.8, 1.8),
      THREE.MathUtils.clamp(v.y * 0.5 + 0.5, -0.8, 1.8),
    );
    const d = Math.hypot(this._lightUV.x - 0.5, this._lightUV.y - 0.5);
    this._lightFade = THREE.MathUtils.clamp(1 - (d - 0.95) / 1.1, 0, 1);
  }

  _updateGradeUniforms(ctx, src, bloomOn, grOn){
    const u = this.mComp.uniforms, p = this.params, g = this.grade;
    u.tScene.value = src.texture;
    u.tBloom.value = bloomOn ? this.mips[0].texture : this.black;
    u.tGodrays.value = grOn ? this.rtGR1.texture : this.black;
    u.uRes.value.set(this.W, this.H);
    u.uAspect.value = this.W / Math.max(1, this.H);
    u.uMaster.value = p.master;

    u.uBloomIntensity.value = bloomOn ? (p.bloom.intensity ?? 0.48) : 0;
    u.uBloomTint.value.set(p.bloom.tint || '#ffffff');
    u.uGRIntensity.value = grOn ? (p.godrays.intensity ?? 0.42) * this._lightFade : 0;
    u.uGRColor.value.set(p.godrays.color || '#ffffff');

    // pulse decay (ease-out cubic)
    const pk = 1 - Math.min(1, this._pulse.t / this._pulse.dur);
    const pe = pk * pk * pk;
    if(pe <= 0.001){ this._pulse.chroma = 0; this._pulse.radial = 0; }
    u.uChroma.value = p.chroma.enabled ? (p.chroma.amount ?? 1.3) * (p.chroma.scale ?? 1) * (1 + this._pulse.chroma * pe * 5.0) : 0;
    u.uRadial.value = this._pulse.radial * pe;

    // flash decay
    const fk = 1 - Math.min(1, this._flash.t / this._flash.dur);
    this._flash.amt = this._flash.peak * fk * fk;
    if(fk <= 0.001) this._flash.peak = 0;
    u.uFlashColor.value.copy(this._flash.color);
    // The flash is additive in SCENE-referred space, so it has to be divided by
    // the effective exposure or its perceived strength would swing with the
    // auto-exposure adaptation. intensity 1.0 ~= triples the frame's mid-tones.
    const effExp = Math.max(0.05, (g.exposure ?? 1) * this._adapt);
    u.uFlashAmount.value = this._flash.amt * 0.30 / effExp;
    u.uFlashFalloff.value = this._flash.falloff;

    const on = p.grade.enabled;
    u.uExposure.value = (g.exposure ?? 1) * (ctx.quality?.exposure ?? 1) * this._adapt;
    u.uAgxSlope.value.fromArray(on ? (g.agxSlope || [1, 1, 1]) : [1, 1, 1]);
    u.uAgxPower.value.fromArray(on ? (g.agxPower || [1, 1, 1]) : [1, 1, 1]);
    u.uAgxSat.value = on ? (g.agxSat ?? 1) : 1;

    u.uLift.value.fromArray(on ? (g.lift || [0, 0, 0]) : [0, 0, 0]);
    u.uGamma.value.fromArray(on ? (g.gamma || [1, 1, 1]) : [1, 1, 1]);
    u.uGain.value.fromArray(on ? (g.gain || [1, 1, 1]) : [1, 1, 1]);
    u.uCurve.value.set(on ? (g.curveR ?? 1) : 1, on ? (g.curveG ?? 1) : 1, on ? (g.curveB ?? 1) : 1);
    u.uContrast.value = on ? (g.contrast ?? 0) : 0;
    u.uBlack.value = on ? (g.black ?? 0.02) : 0;
    u.uWhite.value = on ? (g.white ?? 1.0) : 1.0;
    u.uHiRoll.value = on ? (g.hiRoll ?? 1.0) : 1.0;
    const pivot = THREE.MathUtils.clamp(g.pivot ?? 0.4, 0.05, 0.95);
    u.uLogPivot.value = Math.log2(pivot);
    u.uShoulder.value = on ? (g.shoulder ?? 0.15) : 0;

    normTint(g.shadowTint || '#ffffff', u.uShadowTint.value);
    normTint(g.midTint || '#ffffff', u.uMidTint.value);
    normTint(g.highTint || '#ffffff', u.uHighTint.value);
    u.uTintStrength.value = on ? (g.tintStrength ?? 1) : 0;
    u.uShadowMix.value = g.shadowMix ?? 0.45;
    u.uHighMix.value = g.highMix ?? 0.30;
    u.uSatShadow.value = on ? (g.satShadow ?? 1) : 1;
    u.uSatMid.value = on ? (g.satMid ?? 1) : 1;
    u.uSatHigh.value = on ? (g.satHigh ?? 1) : 1;
    const hl = (on && g.hueLobes) ? g.hueLobes : [[0, 0.1, 0], [0, 0.1, 0], [0, 0.1, 0]];
    u.uHueLobe0.value.fromArray(hl[0] || [0, 0.1, 0]);
    u.uHueLobe1.value.fromArray(hl[1] || [0, 0.1, 0]);
    u.uHueLobe2.value.fromArray(hl[2] || [0, 0.1, 0]);

    const v = p.vignette;
    u.uVigAmount.value = v.enabled ? (v.amount ?? 0.5) : 0;
    u.uVigRadius.value = v.radius ?? 0.78;
    u.uVigSoft.value = v.softness ?? 0.6;
    u.uVigDepth.value = v.depth ?? 0.22;
    u.uVigFloor.value = v.floor ?? 0.0;
    normTint(v.color || '#1a0a22', u.uVigColor.value);

    const gr = p.grain;
    u.uGrainAmount.value = gr.enabled ? (gr.amount ?? 0.03) * (gr.scale ?? 1) : 0;
    u.uGrainSize.value = Math.max(1, gr.size ?? 1.25);
    u.uGrainDark.value = gr.darkBoost ?? 2.0;
    u.uGrainSeed.value = ((ctx.time?.frame ?? 0) % 89) * 7.13;   // deterministic
  }

  dispose(){
    for(const rt of this._rts) rt.dispose();
    this._rts.length = 0;
    if(this.quad) this.quad.dispose();
    if(this.smaa) this.smaa.dispose?.();
  }
}
