// OWNER: AGENT-RENDER — the light rig (ART_DIRECTION §3).
//
//   key        one strong directional per chamber, biome-tinted, tight shadow frustum
//   fill       low hemisphere tinted with the biome's shadow colour; never lifts the
//              blacks above ~0.06 luminance
//   rim        an ART-DIRECTED CONSTANT, not a real light. Published as a shared
//              uniform block for the material system to consume — we set it, we do
//              not reimplement painterly rim shading here.
//   bounce     a wide, very dim area light from the floor, tinted with the floor albedo
//   practicals a pool of point lights (braziers / lava / glyphs) flickering on
//              SMOOTHED NOISE — never a sine wave
//
// It also owns Atmosphere (main.js has no slot for it), and drives its lifecycle.
import * as THREE from 'three';
import { Atmosphere } from './atmosphere.js';
import { GRADES, DEFAULT_BIOME } from './shaders/grades.js';

// ── smoothed value-noise flicker (deterministic, seeded from ctx.rng) ────────
class Flicker {
  constructor(rng, n = 96){
    this.v = new Float32Array(n);
    for(let i = 0; i < n; i++) this.v[i] = rng ? rng.f() : 0.5;
    this.n = n;
  }
  _at(x){
    const n = this.n;
    const i = Math.floor(x), f = x - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);      // smootherstep
    const a = this.v[((i % n) + n) % n];
    const b = this.v[(((i + 1) % n) + n) % n];
    return a + (b - a) * u;
  }
  /** two incommensurate octaves: a slow breathe plus a fast guttering */
  value(t, speed = 1){
    const slow = this._at(t * 0.9 * speed);
    const fast = this._at(t * 4.7 * speed + 31.7);
    const fizz = this._at(t * 13.3 * speed + 71.3);
    return slow * 0.55 + fast * 0.30 + fizz * 0.15;
  }
}

// ── authored rigs ───────────────────────────────────────────────────────────
// NOTE ON RIM DIRECTION (§1.2, "non-negotiable"):
// the shading gate is dot(worldNormal, uRimDir), so the rim lands on surfaces
// whose normal points ALONG uRimDir. The shipping camera sits at yaw 45deg on
// the +X/+Z side, so any rim direction with a negative Z component fires on the
// far side of every object and is invisible from the play camera — which is
// exactly why the mandated #5fd0ff edge did not appear in a single frame. The Z
// term must be POSITIVE: up, camera-left, and toward the lens.
// dir = the direction the key light TRAVELS (from the source into the scene).
const RIGS = {
  tartarus: {
    // §1.1 three-band value structure: the fill is a WHISPER. Everything the
    // frame reads as "lit" comes from the key or a practical, so the ground
    // plane can sit at 0.15-0.20 luma and a character burns out of it.
    //
    // KEY ELEVATION. The old dir sat at 40deg, which on this azimuth threw every
    // column / brazier / pier shadow straight AWAY from the 45deg play camera —
    // i.e. behind the object that cast it. 25deg roughly doubles the shadow
    // length and sweeps it across camera-visible floor, which is the only thing
    // that stops the ground plane reading as one unmodulated slab.
    // 25deg buys long cast shadows but the 132-340deg perimeter arc then
    // shadows most of the arena from this azimuth. 32deg keeps roughly 1.6x the
    // old shadow length while letting the key back on to the ground plane.
    // §2 puts the Tartarus key at #ff5a3c (HSV sat 0.76). It had been bleached
    // to #ffb894 (sat 0.42) purely to stop an over-exposed rig from clipping,
    // which removed the biome's identity from every lit surface in the game.
    // #ff7a52 is sat 0.68 and it survives the corrected exposure intact.
    // INTENSITY: the whole rig is authored 2.42x hotter than it was, because
    // grades.js no longer carries a 2.90 exposure to compensate for it. The
    // extra 1.6x on top is the luminance the saturated key gives back.
    // §9 THE VALUE LAW. The rig used to be authored so that the FLOOR read as
    // lit — key 52 x NdotL 0.545 on a 100%-up-facing plane was the single
    // largest irradiance in the frame, and the measured result was a salmon
    // ground plane 62% brighter than the frame median. The floor is now cut at
    // the MATERIAL (floor.tartarus litGain/ambGain in materials/library.js), so
    // the key can stay strong for the architecture without ever painting the
    // stage. Everything below is authored around that split.
    //
    // KEY. Lowered from 52 because the ground-plane cut no longer has to be
    // paid for by the whole rig, and raised in elevation from -0.545 to -0.615:
    // the 32deg sun threw column shadows two-thirds of the way across the arena
    // as huge soft lozenges (§9.7 "stains, not shadows"). At 38deg they are
    // still long enough to describe the form and short enough to read as cast
    // shapes with an end.
        // §2 puts the Tartarus key at #ff5a3c. #ff8a58 was a bleached compromise
    // and it is what made every lit stone in the chamber read SALMON — one hue
    // family across the whole frame (§9.6). #ff7048 is most of the way back to
    // the authored crimson; the intensity is raised to hold the same luminance
    // (a saturated key delivers ~0.83x the luma of a pale one at equal power,
    // and materials/library.js _keyRef() tracks that automatically).
    key:    { color: '#ff7048', intensity: 75.0, dir: [0.646, -0.615, -0.452] },
    // §3: "fill ... never lifts blacks above ~0.06 luminance". At 2.60 with a
    // saturated periwinkle sky this was the brightest thing landing on the
    // floor after the key, and it is what turned every cast shadow into a
    // lilac stain instead of an ink shape. The fill is now a WHISPER in the
    // authored plum, and the cool note in the frame is carried by the RIM and
    // by real cyan practicals instead of by a wash.
    hemi:   { sky: '#31336e', ground: '#170d26', intensity: 1.50 },
    // A tight warm pool that grazes the standing forms near the centre — the
    // §3 fake bounce, not a lift.
    bounce: { color: '#8a3a34', intensity: 2.00, size: [11, 11], y: 1.6 },
    bounce2:{ color: '#3a1a20', intensity: 0.58, size: [34, 34], y: 0.12 },
    // §1.2 non-negotiable, and §9.6 wants the complement genuinely VISIBLE.
    // The rim is now the second-strongest light in the frame by design: it is
    // what draws every vertical edge in the chamber.
    rim:    { color: '#5fd0ff', dir: [-0.62, 0.36, 0.70], intensity: 9.2, power: 1.30, wrap: 0.55 },
    ambient:{ color: '#241238', intensity: 0.50 },
    godrayAnchor: [0.22, 1.06],
    // §9.5 "ornament carries the light": keyGain drives the sharp specular lobe
    // the gold filigree, the bronze and the brazier rims reflect, and it is the
    // cheapest route to a real highlight band that is NOT a lit floor.
    env:    { zenith: '#150e30', horizon: '#33183e', nadir: '#140916', keyGain: 30.0, keySharp: 200, keyWide: 0.07, rimGain: 6.4, rimSharp: 22, bounce: '#8c2f26', bounceGain: 0.03, intensity: 1.05 },
    // §9.5 + §9.6. Two families:
    //   WARM  tight brazier pools, radius ~8.5, sitting ON the ornament ring so
    //         the light lands on the annulus of floor the glaze paints bright
    //         and dies before it reaches the near apron (§9.1).
    //   COOL  #5fd0ff wall / capital washes. These are the ones that put the
    //         mid-ground architecture a full value band ABOVE the ground plane
    //         and carry the mandated complement into the frame at scale.
    practicals: [
      // WARM braziers on the arc theta 132-316deg. They are deliberately spread
      // from dep 0.13 to dep 0.52 and NONE of them sits in the foreground apron
      // (dep > 0.60): §1.8 + §9.1 want the near half of the arena to be a dark
      // repoussoir, and a brazier standing in it lights exactly the band the
      // value law needs black. Spreading them this wide also stops the arena
      // from developing an unlit gap between the brazier arc and the apron,
      // which is what collapsed the wide shot's mid band into its near band.
      // chamber.js reads these positions to place the brazier GEOMETRY, so the
      // props follow the lights automatically — move one and the prop moves.
      { pos: [ -8.30, 1.7,   9.21], color: '#ffb070', intensity: 430, distance: 10.5, speed: 1.00 },
      { pos: [-12.39, 1.7,   0.43], color: '#ffb070', intensity: 430, distance: 10.5, speed: 0.83 },
      { pos: [ -8.92, 1.7,  -8.61], color: '#ff9a52', intensity: 380, distance: 10.0, speed: 1.21 },
      { pos: [  0.00, 1.7, -12.40], color: '#ff9a52', intensity: 380, distance: 10.0, speed: 0.72 },
      { pos: [  8.92, 1.7,  -8.61], color: '#ffb070', intensity: 430, distance: 10.5, speed: 0.94 },
      // COOL #5fd0ff washes on the perimeter masonry, the column capitals and
      // the gate. §9.4 needs the mid/background architecture to sit a full value
      // band ABOVE the ground plane, and §9.6 needs the complement at scale —
      // these do both jobs at once, and they are aimed at surfaces the floor
      // barely sees (floor.tartarus litGain keeps what does reach it negligible).
      { pos: [  0.0, 4.6, -13.4], color: '#5fd0ff', intensity: 1050, distance: 17, speed: 0.44, flicker: 0.14 },
      { pos: [-13.4, 4.8,  -7.4], color: '#4fc4f0', intensity: 950, distance: 17, speed: 0.61, flicker: 0.12 },
      { pos: [ -7.4, 6.6, -13.4], color: '#3fb8ff', intensity: 760, distance: 19, speed: 0.31, flicker: 0.09 },
      { pos: [ 13.2, 6.6,  -9.4], color: '#3fb8ff', intensity: 760, distance: 19, speed: 0.27, flicker: 0.09 },
      { pos: [-14.6, 5.0,   3.6], color: '#5fd0ff', intensity: 860, distance: 17, speed: 0.52, flicker: 0.14 },
    ],
  },
  asphodel: {
    key:    { color: '#ffc884', intensity: 8.8, dir: [0.586, -0.668, -0.459] },
    hemi:   { sky: '#4e4a94', ground: '#5a1c06', intensity: 0.24 },
    bounce: { color: '#e0600f', intensity: 0.30, size: [30, 30], y: 0.2 },
    rim:    { color: '#33e0c0', dir: [-0.66, 0.32, 0.68], intensity: 2.4, power: 2.2, wrap: 0.34 },
    ambient:{ color: '#231b46', intensity: 0.05 },
    godrayAnchor: [0.26, -0.08],
    env:    { zenith: '#0e0c26', horizon: '#3a1c0e', nadir: '#4a1605', keyGain: 16.0, keySharp: 220, keyWide: 0.06, rimGain: 1.9, rimSharp: 34, bounce: '#ff6a12', bounceGain: 0.07, intensity: 0.32 },
    practicals: [
      { pos: [ 12.0, 0.6,  -4.0], color: '#ff8c1a', intensity: 120, distance: 13, speed: 0.9 },
      { pos: [-10.0, 0.6,   9.0], color: '#ff8c1a', intensity: 120, distance: 13, speed: 1.15 },
      { pos: [  2.0, 0.5,  13.0], color: '#fff0b0', intensity: 80, distance: 11, speed: 1.4 },
      { pos: [ -7.0, 0.5, -12.0], color: '#c22a06', intensity: 60, distance: 12, speed: 0.62 },
    ],
  },
  elysium: {
    key:    { color: '#fff0d0', intensity: 9.2, dir: [0.632, -0.630, -0.451] },
    hemi:   { sky: '#9a90cc', ground: '#1c4c3a', intensity: 0.30 },
    bounce: { color: '#c9bda4', intensity: 0.32, size: [30, 30], y: 0.25 },
    rim:    { color: '#ff5fa8', dir: [-0.58, 0.40, 0.71], intensity: 2.2, power: 2.3, wrap: 0.30 },
    ambient:{ color: '#3d3560', intensity: 0.06 },
    godrayAnchor: [0.24, 1.04],
    env:    { zenith: '#141c40', horizon: '#332f4c', nadir: '#13201c', keyGain: 20.0, keySharp: 220, keyWide: 0.07, rimGain: 1.5, rimSharp: 34, bounce: '#3fa86a', bounceGain: 0.05, intensity: 0.36 },
    practicals: [
      { pos: [ 10.5, 2.2,  -7.0], color: '#ffe14d', intensity: 70, distance: 11, speed: 0.8 },
      { pos: [-10.5, 2.2,   7.0], color: '#ffe14d', intensity: 70, distance: 11, speed: 1.05 },
      { pos: [  0.0, 3.0, -13.0], color: '#ff5fa8', intensity: 46, distance: 11, speed: 0.55 },
      { pos: [  7.0, 1.4,  11.0], color: '#3fa86a', intensity: 40, distance: 10, speed: 1.3 },
    ],
  },
};

export class LightRig {
  constructor(){
    this.biome = DEFAULT_BIOME;
    this.keyDir = new THREE.Vector3(0.621, -0.641, -0.451).normalize();
    this.keyColor = new THREE.Color('#ff6a44');
    this.godrayAnchor = [0.22, 1.06];
    this.pool = [];
    this._practicals = [];
    this._t = 0;
    this.params = { key: true, fill: true, bounce: true, practicals: true, shadows: true, exposureBias: 1 };
  }

  async init(ctx){
    this.ctx = ctx;
    const q = (ctx.quality && ctx.quality.render) || {};
    this.q = q;
    this.rng = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('lighting') : null;

    this.group = new THREE.Group();
    this.group.name = 'lightrig';
    ctx.scene.add(this.group);

    // ── key ────────────────────────────────────────────────────────────────
    this.key = new THREE.DirectionalLight('#ffb894', 12.0);
    this.key.name = 'key';
    this.key.castShadow = !!q.shadows && ctx.quality.shadows !== false;
    const sm = q.shadowMap ?? 2048;
    this.key.shadow.mapSize.set(sm, sm);
    // §1.3: the terminator is a painted edge. A wide PCF radius turns a cast
    // shadow into a smudge, which is exactly what "reads as dirt" looks like.
    // §9.7 "cast shadows must read as shadows, not stains". A PCF radius is
    // measured in TEXELS, but it is spent at whatever world scale the ortho
    // frustum happens to be, so 1.5 over a 38u frustum is a genuinely soft
    // edge on a 3m-wide column shadow. 0.85 keeps just enough softening to
    // kill the staircase and lets the shape keep a painted edge.
    this.key.shadow.radius = Math.min(1.0, (q.shadowRadius ?? 1.4) * 0.6);
    // A tight ortho frustum around the arena keeps the texel density high, which
    // is what makes the shadow read as a painted shape rather than a smear.
    this.key.shadow.bias = -0.00015;
    // A large normalBias walks the shadow off the base of whatever casts it,
    // which is exactly the contact the eye uses to plant an object on a floor.
    this.key.shadow.normalBias = 0.012;
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 60;
    this.keyTarget = new THREE.Object3D();
    this.keyTarget.name = 'key.target';
    this.key.target = this.keyTarget;
    this.group.add(this.key, this.keyTarget);

    // ── fill (hemisphere, tinted with the biome shadow colour) ─────────────
    this.hemi = new THREE.HemisphereLight('#4a3a72', '#3a1d52', 0.26);
    this.hemi.name = 'fill.hemi';
    this.group.add(this.hemi);

    // A whisper of true ambient so nothing in the frame is a dead 0.0 — the
    // bible wants ink, not void, in the shadow shapes.
    this.ambient = new THREE.AmbientLight('#3a1d52', 0.075);
    this.ambient.name = 'fill.ambient';
    this.group.add(this.ambient);

    // ── floor bounce (fake GI) ─────────────────────────────────────────────
    // TWO plates, not one. `bounce` is a small centre POOL with real falloff to
    // the skirt (a 26x26 plate over a 32u arena is a uniform wash, which is what
    // made the ground read as one flat slab); `bounce2` is the §3 fake bounce
    // proper — wide, dim, sitting at 0.15 so it grazes, and tinted with the
    // FLOOR albedo so the light coming back off the stone is the stone's colour.
    try {
      const { RectAreaLightUniformsLib } = await import('three/examples/jsm/lights/RectAreaLightUniformsLib.js');
      RectAreaLightUniformsLib.init();
      this.bounce = new THREE.RectAreaLight('#6e3560', 0.16, 13, 13);
      this.bounce.name = 'bounce';
      this.bounce.position.set(0, 0.9, 0);
      this.bounce.rotation.x = -Math.PI / 2;      // facing up off the floor
      this.group.add(this.bounce);
      this.bounce2 = new THREE.RectAreaLight('#3c1d25', 0.40, 30, 30);
      this.bounce2.name = 'bounce.floor';
      this.bounce2.position.set(0, 0.15, 0);
      this.bounce2.rotation.x = -Math.PI / 2;
      this.group.add(this.bounce2);
    } catch(e){
      // RectAreaLight unavailable — fall back to a very wide, dim point light.
      this.bounce = new THREE.PointLight('#6e3560', 4, 60, 1.2);
      this.bounce.name = 'bounce.fallback';
      this.bounce.position.set(0, 0.9, 0);
      this.group.add(this.bounce);
      this.bounce2 = null;
    }

    // ── rim: an art-directed constant published for the material system ────
    this.rim = {
      color: new THREE.Color('#5fd0ff'),
      dir: new THREE.Vector3(-0.62, 0.36, 0.70).normalize(),
      intensity: 5.0, power: 1.5, wrap: 0.50,
    };
    // Shared uniform block. materials/library.js should bind these objects
    // straight into its painterly shaders (onBeforeCompile) so a biome change
    // costs zero recompiles.
    this.rimUniforms = {
      uRimColor:     { value: this.rim.color },
      uRimDir:       { value: this.rim.dir },
      uRimIntensity: { value: this.rim.intensity },
      uRimPower:     { value: this.rim.power },
      uRimWrap:      { value: this.rim.wrap },
      uKeyDir:       { value: this.keyDir },
      uKeyColor:     { value: this.keyColor },
      uInkColor:     { value: new THREE.Color('#3a1d52') },
    };

    // ── pooled practical lights ────────────────────────────────────────────
    this.budget = Math.max(2, q.practicalLights ?? 8);
    for(let i = 0; i < this.budget; i++){
      const l = new THREE.PointLight('#ffffff', 0, 12, 1.6);
      l.name = 'practical.' + i;
      l.visible = false;
      l.castShadow = false;
      l.userData.free = true;
      this.group.add(l);
      this.pool.push(l);
    }
    this._flickers = [];
    for(let i = 0; i < this.budget + 4; i++) this._flickers.push(new Flicker(this.rng));

    // ── procedural IBL ────────────────────────────────────────────────────
    // Without an environment, every metal in the game (gold filigree, bronze,
    // iron) resolves to black: a metal has no diffuse lobe, it can only reflect.
    // So the rig authors its own tiny HDR equirect and prefilters it. Zero assets.
    this._pmrem = null;
    this._envRT = null;
    this._envTex = null;

    // ── atmosphere (we own its lifecycle) ─────────────────────────────────
    this.atmosphere = new Atmosphere();
    await this.atmosphere.init(ctx);
    ctx.atmosphere = this.atmosphere;

    const start = (ctx.run && ctx.run.biome) || (ctx.world && ctx.world.biome) || DEFAULT_BIOME;
    this.setBiome(start, ctx);

    // pipeline self-test rig (?renderdebug=1) — see render/debugscene.js
    try {
      if(typeof location !== 'undefined' && new URLSearchParams(location.search).has('renderdebug')){
        const { RenderDebugScene } = await import('./debugscene.js');
        this.debugScene = new RenderDebugScene().build(ctx);
        ctx.renderDebug = this.debugScene;
      }
    } catch(e){ /* debug rig is optional; never break the game for it */ }

    ctx.events?.on?.('biome.changed', ({ name }) => this.setBiome(name, ctx));
    ctx.events?.on?.('room.entered', () => this.fitShadows(ctx));
  }

  // ─────────────────────────────────────────────────────────────── biome ──
  setBiome(name, ctx = this.ctx){
    const rig = RIGS[name] || RIGS[DEFAULT_BIOME];
    this.biome = RIGS[name] ? name : DEFAULT_BIOME;
    this.rigDef = rig;

    this.key.color.set(rig.key.color);
    this.key.intensity = rig.key.intensity;
    this.keyColor.copy(this.key.color);
    this.keyDir.fromArray(rig.key.dir).normalize();

    this.hemi.color.set(rig.hemi.sky);
    this.hemi.groundColor.set(rig.hemi.ground);
    this.hemi.intensity = rig.hemi.intensity;

    this.ambient.color.set(rig.ambient.color);
    this.ambient.intensity = rig.ambient.intensity;

    if(this.bounce){
      this.bounce.color.set(rig.bounce.color);
      this.bounce.intensity = rig.bounce.intensity;
      if(this.bounce.isRectAreaLight){
        this.bounce.width = rig.bounce.size[0];
        this.bounce.height = rig.bounce.size[1];
      }
      this.bounce.position.y = rig.bounce.y;
    }
    if(this.bounce2){
      const b2 = rig.bounce2 || { color: rig.bounce.color, intensity: 0, size: [30, 30], y: 0.15 };
      this.bounce2.color.set(b2.color);
      this.bounce2.intensity = b2.intensity;
      if(this.bounce2.isRectAreaLight){ this.bounce2.width = b2.size[0]; this.bounce2.height = b2.size[1]; }
      this.bounce2.position.y = b2.y;
    }

    this.rim.color.set(rig.rim.color);
    this.rim.dir.fromArray(rig.rim.dir).normalize();
    this.rim.intensity = rig.rim.intensity;
    this.rim.power = rig.rim.power;
    this.rim.wrap = rig.rim.wrap;
    this.rimUniforms.uRimIntensity.value = this.rim.intensity;
    this.rimUniforms.uRimPower.value = this.rim.power;
    this.rimUniforms.uRimWrap.value = this.rim.wrap;
    this.rimUniforms.uInkColor.value.set((GRADES[this.biome] || GRADES[DEFAULT_BIOME]).ao.ink);
    this.godrayAnchor = rig.godrayAnchor.slice();

    // Rebuild the prefiltered sky FIRST: the material system binds it straight
    // off `this.envTexture`, so it has to exist before the handshake below.
    if(ctx) this._buildEnvironment(ctx, rig);

    // hand the rim constant to the material system — set it, don't reimplement it
    const payload = {
      color: this.rim.color, dir: this.rim.dir, intensity: this.rim.intensity,
      power: this.rim.power, wrap: this.rim.wrap,
      keyDir: this.keyDir, keyColor: this.keyColor,
      ink: this.rimUniforms.uInkColor.value, uniforms: this.rimUniforms, biome: this.biome,
      env: this.envTexture || null, keyIntensity: this.key.intensity,
    };
    if(ctx && ctx.mats){
      // The material system owns the painterly shading; we only publish the
      // constants. setRim() also carries the biome, so one call retunes every
      // painted material's rim colour, shadow ink and key reference together.
      if(typeof ctx.mats.setRim === 'function') ctx.mats.setRim(payload);
      else if(typeof ctx.mats.setLighting === 'function') ctx.mats.setLighting(payload);
      else if(typeof ctx.mats.setBiome === 'function') ctx.mats.setBiome(this.biome);
    }
    ctx?.events?.emit?.('lighting.rim', payload);

    // authored practicals for this biome
    this._releaseAllPracticals();
    if(this.params.practicals){
      for(const p of rig.practicals){
        const l = this.acquireLight({
          color: p.color, intensity: p.intensity, distance: p.distance, decay: 2.0,
          pos: p.pos, flicker: p.flicker ?? 0.42, speed: p.speed, kind: 'practical',
        });
        if(l) this._practicals.push(l);
      }
    }

    if(ctx){
      ctx.post?.setBiome?.(this.biome);
      this.atmosphere?.setBiome?.(this.biome, ctx);
      this.fitShadows(ctx);
    }
    return this;
  }

  // ───────────────────────────────────────────────────────── environment ──
  /**
   * Author a small HDR equirect in code and prefilter it with PMREM.
   * Content: the biome's vertical value ramp, a hot lobe where the key lives, a
   * cool complement lobe where the rim lives, and a floor-bounce lift below the
   * horizon. This is the specular counterpart to the hemisphere fill.
   */
  _buildEnvironment(ctx, rig){
    const renderer = ctx.renderer;
    if(!renderer || !rig || !rig.env) return;
    const E = rig.env;
    const W = 128, H = 64;
    const data = new Float32Array(W * H * 4);

    const zen = new THREE.Color(E.zenith), hor = new THREE.Color(E.horizon), nad = new THREE.Color(E.nadir);
    const keyC = new THREE.Color(rig.key.color);
    const rimC = new THREE.Color(rig.rim.color);
    const bnc = new THREE.Color(E.bounce || '#000000');
    const kd = new THREE.Vector3().fromArray(rig.key.dir).normalize();   // travel direction
    const rd = new THREE.Vector3().fromArray(rig.rim.dir).normalize();
    const smooth = (t) => { t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); };

    for(let j = 0; j < H; j++){
      const v = (j + 0.5) / H;
      const y = v * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      for(let i = 0; i < W; i++){
        const u = (i + 0.5) / W;
        const phi = (u - 0.5) * Math.PI * 2;
        const dx = r * Math.cos(phi), dz = -r * Math.sin(phi);

        let cr, cg, cb;
        if(y < 0){ const t = smooth((y + 1) / 1.0); cr = nad.r + (hor.r - nad.r) * t; cg = nad.g + (hor.g - nad.g) * t; cb = nad.b + (hor.b - nad.b) * t; }
        else     { const t = smooth(y);            cr = hor.r + (zen.r - hor.r) * t; cg = hor.g + (zen.g - hor.g) * t; cb = hor.b + (zen.b - hor.b) * t; }

        // hot key lobe (the direction the light comes FROM is -keyDir)
        let d = -(dx * kd.x + y * kd.y + dz * kd.z);
        if(d > 0){
          const k = Math.pow(d, E.keySharp || 220) * E.keyGain;
          // plus a broad, low-energy warm wash so ROUGH metals still read as
          // metal instead of collapsing to black between the sun and the base
          const kw = Math.pow(d, 2) * (E.keyWide || 0);
          cr += keyC.r * (k + kw); cg += keyC.g * (k + kw); cb += keyC.b * (k + kw);
        }
        // cool complement lobe where the art-directed rim lives
        let d2 = dx * rd.x + y * rd.y + dz * rd.z;
        if(d2 > 0){ const k2 = Math.pow(d2, E.rimSharp || 34) * E.rimGain; cr += rimC.r * k2; cg += rimC.g * k2; cb += rimC.b * k2; }
        // floor bounce below the horizon
        const bk = smooth((-y - 0.05) / 0.6) * (E.bounceGain || 0);
        cr += bnc.r * bk; cg += bnc.g * bk; cb += bnc.b * bk;

        const o = (j * W + i) * 4;
        data[o] = cr; data[o + 1] = cg; data[o + 2] = cb; data[o + 3] = 1;
      }
    }

    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    try {
      if(!this._pmrem){ this._pmrem = new THREE.PMREMGenerator(renderer); this._pmrem.compileEquirectangularShader(); }
      const rt = this._pmrem.fromEquirectangular(tex);
      if(this._envRT) this._envRT.dispose();
      this._envRT = rt;
      ctx.scene.environment = rt.texture;
      if('environmentIntensity' in ctx.scene) ctx.scene.environmentIntensity = E.intensity ?? 1;
      this.envTexture = rt.texture;
    } catch(e){
      // If PMREM is unavailable the raw equirect still beats a black metal.
      ctx.scene.environment = tex;
      this.envTexture = tex;
    }
    if(this._envTex) this._envTex.dispose();
    this._envTex = tex;
  }

  // ───────────────────────────────────────────────────────────── shadows ──
  /** Fit the key light's ortho frustum tightly to the arena (crisp, no acne). */
  fitShadows(ctx = this.ctx){
    const r = ((ctx && ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 16);
    const cx = (ctx && ctx.world && ctx.world.center) ? ctx.world.center : { x: 0, y: 0, z: 0 };
    // Clamp the ortho frustum to the arena itself (+2u for the wall and the
    // gate). Every texel spent outside the island is a texel the terminator
    // does not get.
    // Every texel spent outside the island is a texel the terminator does not
    // get: 1.35 instead of 2.0 buys ~7% more density for free.
    const half = r + 1.35;
    const dist = r * 1.9 + 10;
    this.keyTarget.position.set(cx.x || 0, (cx.y || 0) + 1.0, cx.z || 0);
    this.key.position.set(
      this.keyTarget.position.x - this.keyDir.x * dist,
      this.keyTarget.position.y - this.keyDir.y * dist,
      this.keyTarget.position.z - this.keyDir.z * dist,
    );
    const c = this.key.shadow.camera;
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.near = Math.max(0.5, dist - r * 1.55);
    c.far = dist + r * 1.75;
    c.updateProjectionMatrix();
    this.key.shadow.needsUpdate = true;
    this.keyTarget.updateMatrixWorld();
    return this;
  }

  // ──────────────────────────────────────────────────────── light pool ──
  /**
   * Borrow a pooled point light. Returns null when the budget is spent — callers
   * must handle that (emissive-only fallback), which is the whole point of the
   * budget. Options: {color,intensity,distance,decay,pos,flicker,speed,kind}
   */
  acquireLight(opts = {}){
    const l = this.pool.find(p => p.userData.free);
    if(!l) return null;
    l.userData.free = false;
    l.userData.kind = opts.kind || 'fx';
    l.userData.base = opts.intensity ?? 10;
    l.userData.flicker = opts.flicker ?? 0;
    l.userData.speed = opts.speed ?? 1;
    l.userData.phase = this.rng ? this.rng.f() * 100 : 0;
    l.userData.flick = this._flickers[this.pool.indexOf(l) % this._flickers.length];
    l.color.set(opts.color || '#ffffff');
    l.intensity = l.userData.base;
    l.distance = opts.distance ?? 12;
    l.decay = opts.decay ?? 1.7;
    if(opts.pos) l.position.set(opts.pos[0] ?? opts.pos.x ?? 0, opts.pos[1] ?? opts.pos.y ?? 0, opts.pos[2] ?? opts.pos.z ?? 0);
    l.visible = true;
    return l;
  }

  releaseLight(l){
    if(!l || l.userData.free) return;
    l.userData.free = true;
    l.visible = false;
    l.intensity = 0;
    const i = this._practicals.indexOf(l);
    if(i >= 0) this._practicals.splice(i, 1);
  }

  _releaseAllPracticals(){
    for(const l of this._practicals.slice()) this.releaseLight(l);
    this._practicals.length = 0;
  }

  /** Number of pooled lights still available. */
  get freeLights(){ return this.pool.reduce((n, l) => n + (l.userData.free ? 1 : 0), 0); }

  // ────────────────────────────────────────────────────────────── frame ──
  update(dt, ctx){
    this._t += dt;
    this.key.visible = this.params.key;
    this.hemi.visible = this.params.fill;
    this.ambient.visible = this.params.fill;
    if(this.bounce) this.bounce.visible = this.params.bounce;
    if(this.bounce2) this.bounce2.visible = this.params.bounce;
    this.key.castShadow = this.params.shadows && !!this.q.shadows && ctx.quality.shadows !== false;

    // SMOOTHED-NOISE flicker (never a sine wave)
    for(const l of this.pool){
      if(l.userData.free || !l.userData.flicker) continue;
      const f = l.userData.flick;
      if(!f) continue;
      const n = f.value(this._t + l.userData.phase, l.userData.speed);
      const amp = l.userData.flicker;
      l.intensity = l.userData.base * (1 - amp + amp * (0.45 + 1.15 * n));
    }
  }

  lateUpdate(alpha, ctx){
    this.atmosphere?.lateUpdate?.(alpha, ctx);
    this.debugScene?.sync?.(ctx);
  }

  resize(w, h, ctx){ this.atmosphere?.resize?.(w, h, ctx); }

  dispose(){
    this._envRT?.dispose?.();
    this._envTex?.dispose?.();
    this._pmrem?.dispose?.();
    this.atmosphere?.dispose?.();
    if(this.key) this.key.dispose?.();
  }
}
