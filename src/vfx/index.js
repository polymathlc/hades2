// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// EREBUS VFX — the contract in ARCHITECTURE.md §2.8, built to ART_DIRECTION §5.
//
//   vfx.impact(pos, normal, {type, scale, color})
//   vfx.slash(origin, dir, {arc, radius, color, width})
//   vfx.burst(pos, {count, color, speed, spread, kind})
//   vfx.trail(object3D, {color, width, life})
//   vfx.decal(pos, normal, {kind, size, color})
//   vfx.death(pos, {kind, color, scale})
//   vfx.beam(a, b, {color, width, life})
//   vfx.shockwave(pos, {radius, color, life})
//
// DOCTRINE, applied literally:
//  * Every effect is built from three layers — a small near-white CORE, a
//    saturated BODY in a god/biome colour, and a wide LOW-ALPHA additive GLOW.
//    The atlas packs those into R/G/B so one texture fetch gives all three.
//  * impact() always fires all four elements §5 demands: flash, ring shockwave,
//    radial sparks, decal. There is no "cheap" impact.
//  * Nothing is a round white dot and nothing is wispy grey smoke (§7).
//  * §9/§11 VALUE LAW: the bright cores are SMALL and hot; the glow is wide and
//    low alpha. Effects supply the frame's highlight band without flooding it —
//    the additive footprint of a full impact is a few hundred pixels above 0.6
//    luma, not a bloom fog over the arena.
//
// THE BEATS (round 2). combat.js and weapons.js announce the feel system on
// the bus — perfect chain, charge tiers, riposte, tip hit, backstab, elite
// arrival, boss enrage — and until this round nothing drew them. `_bindBeats`
// is the listener for every one of those, each a bold flat additive shape:
//   boss.enraged        red-gold triple shockwave + a persistent rim AURA that
//                       pulses under the boss until it dies
//   weapon.perfectChain a crisp gold ring at the blade's reach
//   weapon.charge.tier  a tick ring at the hero's feet, one radius per tier
//   player.riposte      a blue-white arc over the victim
//   weapon.tipHit       a spark spike straight up out of the tip
//   enemy.elite         an affix-coloured ring + a slow aura for six seconds
//   damage.backstab     a dark-red shard burst behind the victim
//   weapon.loose        a per-arm TRACER (bow, rail, flames, skull, spear...)
//
// THE ARMS. slash()/beam()/shockwave() take `o.weapon` and consult WEAPON_FX:
// blade = crescent, axe/coat = wide heavy crescent, spear = a long thin thrust
// streak, shield = a flat bash ring, fists = a short jab + chevrons, blades =
// twin thin ribbons, staff = crescent with runes, bow/rail/flames/skull = a
// charge glow and a tracer. A bow frame no longer matches a spear frame.
//
// RING CAP. Ground rings are the one shape that stacks unreadably (six of them
// filled the round-1 combat frame). shockwave() and the auras refuse to add a
// ring past RING_CAP live rings; impacts keep theirs (§5: all four, always).
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { GODS, GOLD, TARTARUS, INK, BIOMES } from '../materials/palette.js';
import { RNG } from '../core/rng.js';
import { SHAPE } from './shapes.js';
import { Particles } from './particles.js';
import { Rings, Slashes, Beams } from './impacts.js';
import { Trails } from './trails.js';
import { Decals } from './decals.js';
import { ScreenFX } from './screenfx.js';

const S = (t, c) => ({ t, c });
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _d = { x: 0, z: 0 };

/** live ground rings beyond this are refused (readability, §5 silhouette) */
export const RING_CAP = 7;

/** elite affix -> ring colour (matches the affix's answer, not the family) */
export const AFFIX_COLOR = Object.freeze({
  armoured: '#c9b8ff',   // lavender: commit to the heavy
  swift: '#77e5ff',      // ice: dash sooner
  volatile: '#ff8c1a',   // ember: kill it away from the pack
  warded: '#ffe14d',     // gold: cannot be stun-locked
});

/**
 * Per-arm shape language. `kind` picks the construction in slash()/beam();
 * the multipliers retune the ribbon; `tracer` is what weapon.loose draws.
 */
export const WEAPON_FX = Object.freeze({
  blade:  { kind: 'crescent' },
  axe:    { kind: 'heavy', widthMul: 1.55, bank: 0.98, riseMul: 1.4, lifeMul: 1.3, embers: 5 },
  coat:   { kind: 'heavy', widthMul: 1.2, bank: 0.8, riseMul: 1.1, lifeMul: 1.15, wisps: 4 },
  spear:  { kind: 'thrust', widthMul: 0.55, lifeMul: 0.8, tip: true, tracer: { width: 0.16, life: 0.2, len: 9, chev: 4 } },
  staff:  { kind: 'crescent', widthMul: 0.85, runes: 2, thrustRune: true, tracer: { width: 0.2, life: 0.24, len: 9, runes: 1 } },
  shield: { kind: 'bash', ring: 1.15 },
  fists:  { kind: 'jab', widthMul: 0.8, radiusMul: 0.72, lifeMul: 0.7, chev: 5 },
  blades: { kind: 'twin', widthMul: 0.55, lifeMul: 0.85 },
  bow:    { kind: 'crescent', tracer: { width: 0.10, life: 0.16, len: 12, core: '#fffdf0', star: 0.5 }, charge: 'draw' },
  rail:   { kind: 'crescent', tracer: { width: 0.14, life: 0.12, len: 17, core: '#eaf6ff', muzzle: true, casing: 2 }, charge: 'draw' },
  flames: { kind: 'crescent', tracer: { width: 0.26, life: 0.24, len: 8, embers: 8 }, charge: 'glow' },
  skull:  { kind: 'crescent', tracer: { width: 0.30, life: 0.30, len: 9, wisps: 6 }, charge: 'glow' },
});

// ── damage-type identity ───────────────────────────────────────────────────
// body = the saturated mid, glow = the wide halo, core = the hot centre.
const TYPES = {
  physical: { body: '#ffd27a', glow: '#ff8a3c', core: '#fffbe8', decal: 'ichor' },
  fire: { body: '#ff8c1a', glow: '#c22a06', core: '#fff0b0', decal: 'scorch' },
  lightning: { body: GODS.zeus, glow: '#7fd8ff', core: '#ffffff', decal: 'burn' },
  frost: { body: GODS.poseidon, glow: '#2a6fd0', core: '#eaffff', decal: 'scuff' },
  poison: { body: GODS.artemis, glow: '#1f6b3a', core: '#e6ffd0', decal: 'ichor' },
  arcane: { body: GODS.dionysus, glow: '#4b1d8a', core: '#f0dcff', decal: 'sigil' },
  shade: { body: GODS.hecate, glow: '#2c4a5c', core: '#dffaf0', decal: 'scorch' },
};

export class VFX {
  constructor() {
    this.enabled = true;
    this.root = null;
    this._pending = [];
    this._budget = 1;
    this._tierBudget = 1;
    this._doom = new Map();
    this._auras = [];        // {entity, color, core, radius, every, next, t, life, embers}
  }

  // ───────────────────────────────────────────────────────────────── init ──
  async init(ctx) {
    this.ctx = ctx;
    this.rng = new RNG('vfx');
    const tier = (ctx.quality && ctx.quality.tier) || 'high';
    const cap = tier === 'low' ? 700 : tier === 'med' ? 1400 : 2400;
    // Particle count must follow the selected graphics tier even when the
    // pool is empty. Previously Low emitted the same boss-death burst as
    // Ultra until the pool was already saturated, which made degradation
    // arrive one frame too late to prevent the hitch.
    this._tierBudget = tier === 'low' ? 0.38 : tier === 'med' ? 0.62 : tier === 'high' ? 0.82 : 1;
    this._budget = this._tierBudget;

    this.root = new THREE.Group();
    this.root.name = 'vfx';
    ctx.scene.add(this.root);

    // One shared dagger asset, cloned only while Doom is live. The clones
    // share geometry but own their materials so countdown opacity can change
    // independently on several enemies.
    this._doomTemplate = this._buildDoomKnife();
    // Parked in the graph, invisible. Doom's knife used to live entirely
    // outside the scene until the first Doom landed, so its three materials
    // compiled their programs inside that frame. Sitting here costs nothing to
    // draw (visible=false) and lets core/preload.js's compile + warm passes
    // find it like every other pooled effect. Clones still take their own
    // materials, so per-target countdown opacity is unaffected.
    this._doomTemplate.visible = false;
    this.root.add(this._doomTemplate);

    this.particles = new Particles({ cap }).init(ctx, this.root, this.rng);
    this.rings = new Rings(tier === 'low' ? 8 : 16).addTo(this.root);
    this.slashes = new Slashes(tier === 'low' ? 4 : 8).addTo(this.root);
    this.beams = new Beams(4).addTo(this.root);
    this.trails = new Trails(tier === 'low' ? 4 : 8).addTo(this.root);
    this.decals = new Decals(tier === 'low' ? 40 : 96).init(ctx, this.root);
    this.screen = new ScreenFX().init(ctx);

    this._defineParticles();
    this.setBiome((ctx.run && ctx.run.biome) || 'tartarus');

    ctx.events.on('biome.changed', ({ name }) => this.setBiome(name));
    ctx.events.on('capture.state', ({ name }) => this._captureState(name, ctx));
    this._bindBeats(ctx);
    // Enemy.onDied is the sole death-effect authority because it knows the
    // enemy's authored colour, direction and scale. Listening to entity.died
    // here as well used to emit a complete second death burst for every kill.
    ctx.events.on('room.built', () => this.clear());
    return this;
  }

  setBiome(name) {
    const B = BIOMES[name] || BIOMES.tartarus;
    this.biome = { name, key: B.key, rim: B.rim, accent: B.accent, shadow: B.shadow };
  }

  _buildDoomKnife() {
    const group = new THREE.Group();
    group.name = 'vfx.doom.knife';

    // Point-down diamond blade. A knife is deliberately literal here: Doom's
    // delay should be readable without remembering a colour/status legend.
    const bladeGeo = new THREE.ConeGeometry(0.17, 0.92, 4);
    bladeGeo.rotateY(Math.PI / 4); bladeGeo.rotateZ(Math.PI); bladeGeo.translate(0, -0.18, 0);
    const bladeMat = new THREE.MeshStandardMaterial({
      color: '#34203f', metalness: 0.82, roughness: 0.20,
      emissive: '#a05fe0', emissiveIntensity: 1.25,
    });
    const blade = new THREE.Mesh(bladeGeo, bladeMat); blade.name = 'doom.blade'; blade.castShadow = true;

    const guardGeo = new THREE.BoxGeometry(0.62, 0.075, 0.13); guardGeo.translate(0, 0.31, 0);
    const gripGeo = new THREE.CylinderGeometry(0.055, 0.07, 0.48, 8); gripGeo.translate(0, 0.57, 0);
    const pommelGeo = new THREE.OctahedronGeometry(0.11, 0); pommelGeo.translate(0, 0.84, 0);
    const metalMat = new THREE.MeshStandardMaterial({ color: '#d14b66', metalness: 0.74, roughness: 0.28, emissive: '#671738', emissiveIntensity: 0.75 });
    const handleMat = new THREE.MeshStandardMaterial({ color: '#201326', metalness: 0.25, roughness: 0.72, emissive: '#3c1339', emissiveIntensity: 0.35 });
    const guard = new THREE.Mesh(guardGeo, metalMat); guard.name = 'doom.guard';
    const grip = new THREE.Mesh(gripGeo, handleMat); grip.name = 'doom.grip';
    const pommel = new THREE.Mesh(pommelGeo, metalMat); pommel.name = 'doom.pommel';

    // The shrinking halo is the clock; the blade itself begins dropping only
    // in the final quarter so anticipation and impact are separate beats.
    const ringGeo = new THREE.TorusGeometry(0.43, 0.025, 7, 28);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#d879ff', transparent: true, opacity: 0.78, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const ring = new THREE.Mesh(ringGeo, ringMat); ring.name = 'doom.clock'; ring.position.y = 0.05; ring.rotation.x = Math.PI / 2;

    group.add(blade, guard, grip, pommel, ring);
    group.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; } });
    return group;
  }

  /** Bind one visible hanging knife to the live Doom status record. */
  doomMark(target, record) {
    if (!this.enabled || !target || !record || !this.root || !this._doomTemplate) return null;
    let mark = this._doom.get(target);
    if (!mark) {
      const object = this._doomTemplate.clone(true);
      // Geometry stays shared; dynamic countdown materials do not.
      object.traverse(o => { if (o.isMesh && o.material) o.material = o.material.clone(); });
      object.visible = true;
      this.root.add(object);
      mark = { object, ring: object.getObjectByName('doom.clock'), blade: object.getObjectByName('doom.blade'), record, impactT: 0, stacks: 1 };
      this._doom.set(target, mark);
    }
    mark.record = record;
    mark.stacks = record.stacks || 1;
    return mark;
  }

  /** The combat authority calls this on the exact frame Doom deals damage. */
  doomStrike(target) {
    const mark = this._doom.get(target);
    if (!mark) return;
    mark.record = null;
    mark.impactT = 0.14;
  }

  cancelDoom(target) { this._removeDoom(target); }

  _removeDoom(target) {
    const mark = this._doom.get(target);
    if (!mark) return;
    if (mark.object.parent) mark.object.parent.remove(mark.object);
    mark.object.traverse(o => { if (o.isMesh && o.material) o.material.dispose(); });
    this._doom.delete(target);
  }

  _updateDoom(dt, ctx) {
    const now = ctx.time.t;
    for (const [target, mark] of this._doom) {
      if ((!target || target.dead || target.alive === false) && mark.impactT <= 0) { this._removeDoom(target); continue; }
      const baseY = target?.root?.position?.y ?? target?.position?.y ?? 0;
      const height = target?.height || Math.max(1.3, (target?.radius || 0.5) * 2.8);
      const topY = baseY + height + 1.22;
      const hitY = baseY + height * 0.72;
      const pos = target?.position || _v.set(0, 0, 0);
      let y = topY;

      if (mark.record) {
        const k = clamp01(mark.record.t / Math.max(0.001, mark.record.dur));
        const drop = clamp01((k - 0.74) / 0.26);
        const fall = drop * drop * drop;
        y = topY + Math.sin(now * 5.2 + (target.id || 0)) * 0.075 * (1 - drop) + (hitY - topY) * fall;
        const ringScale = Math.max(0.12, 1 - k * 0.88);
        if (mark.ring) {
          mark.ring.scale.setScalar(ringScale);
          mark.ring.material.opacity = 0.30 + 0.56 * (1 - k);
        }
        if (mark.blade?.material) mark.blade.material.emissiveIntensity = 1.0 + 1.4 * k * k;
        mark.object.rotation.y += dt * (1.1 + k * 3.4);
        mark.object.rotation.z = Math.sin(now * 4.1) * 0.035 * (1 - drop);
        const s = 1 + Math.min(0.24, (mark.stacks - 1) * 0.08);
        mark.object.scale.setScalar(s);
      } else {
        y = hitY;
        mark.impactT -= dt;
        const s = Math.max(0.35, mark.impactT / 0.14);
        mark.object.scale.set(1.15 - s * 0.1, s, 1.15 - s * 0.1);
        if (mark.ring) mark.ring.material.opacity = 0;
        if (mark.impactT <= 0) { this._removeDoom(target); continue; }
      }
      mark.object.position.set(pos.x, y, pos.z);
    }
  }

  /** Resolve {type,color} into the 3-layer colour triple. */
  _colors(type, color) {
    const T = TYPES[type] || TYPES.physical;
    if (!color) return T;
    if (!this._ctmp) this._ctmp = { body: '', glow: '', core: '', decal: '' };
    const t = this._ctmp;
    t.body = color; t.glow = color; t.core = T.core; t.decal = T.decal;
    return t;
  }

  // ──────────────────────────────────────────────────── particle recipes ──
  _defineParticles() {
    const P = this.particles;

    // hot metal sparks: white-hot -> gold -> arterial -> ink. Four stops, so it
    // never becomes the grey-through-the-middle two-colour lerp.
    P.define('spark', {
      shape: SHAPE.spark, stretch: 0.055,
      ramp: [S(0, '#fffdf2'), S(0.16, GOLD.highlight), S(0.45, '#ff9a3c'), S(0.78, TARTARUS.blood), S(1, '#2a0610')],
      alpha: [[0, 1], [0.62, 0.95], [1, 0]],
      size: [[0, 0.55], [0.10, 1.0], [1, 0.30]],
      size0: 0.13, size1: 0.26, life: [0.32, 0.72], speed: [3.4, 9.5],
      emit: 'cone', spread: 0.85, gravity: 11, drag: 1.35, bounce: 0.34, core: 1.35,
    });
    P.define('sparkFine', {
      shape: SHAPE.diamond,
      ramp: [S(0, '#ffffff'), S(0.3, GOLD.highlight), S(0.7, '#ff7a3c'), S(1, '#3a0a14')],
      alpha: [[0, 0], [0.08, 1], [0.55, 0.8], [1, 0]],
      size: [[0, 0.2], [0.18, 1], [1, 0.1]],
      size0: 0.07, size1: 0.15, life: [0.28, 0.62], speed: [2.2, 6.5],
      emit: 'cone', spread: 1.1, gravity: 6.5, drag: 2.4, core: 1.6,
    });
    // the flash quad — one instance, huge, gone in 8 frames
    P.define('flash', {
      shape: SHAPE.burst,
      ramp: [S(0, '#ffffff'), S(0.22, GOLD.highlight), S(0.6, '#ff9a3c'), S(1, '#5a1206')],
      alpha: [[0, 1], [0.30, 0.85], [1, 0]],
      size: [[0, 0.32], [0.13, 1.15], [0.45, 1.0], [1, 0.72]],
      size0: 1.5, size1: 1.8, life: [0.15, 0.19], speed: [0, 0],
      emit: 'sphere', drag: 8, core: 1.5, rotVel: [-0.4, 0.4],
    });
    P.define('star', {
      shape: SHAPE.star,
      ramp: [S(0, '#ffffff'), S(0.35, '#ffe9a8'), S(1, '#ff7a2a')],
      alpha: [[0, 1], [0.24, 0.8], [1, 0]],
      size: [[0, 0.22], [0.11, 1.25], [1, 0.55]],
      size0: 1.1, size1: 1.4, life: [0.20, 0.26], speed: [0, 0],
      emit: 'sphere', drag: 9, core: 1.8, rotVel: [-1.1, 1.1],
    });
    P.define('ember', {
      shape: SHAPE.ember,
      ramp: [S(0, '#fff0b0'), S(0.25, '#ffb04a'), S(0.6, '#e0431a'), S(1, '#2a0710')],
      alpha: [[0, 0], [0.10, 1], [0.7, 0.8], [1, 0]],
      size: [[0, 0.4], [0.22, 1], [1, 0.35]],
      // §7: the ember field is the emitter a critic traced the 'evenly spaced
      // identical circles' to. A 2.2x uniform band is not a size distribution;
      // 6.7x sampled through the skew is.
      size0: 0.045, size1: 0.30, life: [0.7, 2.2], speed: [0.35, 2.6],
      emit: 'cone', spread: 0.75, gravity: -1.15, drag: 0.8, turb: 1.6, turbFreq: 0.9,
      core: 1.0, rotVel: [-1.2, 1.2],
    });
    // shade wisps for deaths — the colour runs OUT of the world, into ink
    P.define('wisp', {
      shape: SHAPE.wisp,
      ramp: [S(0, '#eafff8'), S(0.2, GODS.hecate), S(0.55, '#3f6f9c'), S(0.82, INK.violet), S(1, INK.void)],
      alpha: [[0, 0], [0.12, 0.95], [0.66, 0.7], [1, 0]],
      size: [[0, 0.35], [0.28, 1.15], [1, 0.55]],
      size0: 0.34, size1: 0.68, life: [0.65, 1.25], speed: [1.6, 4.6],
      emit: 'cone', spread: 0.95, gravity: -1.9, drag: 1.5, turb: 2.6, turbFreq: 0.7,
      core: 0.9, rotVel: [-0.8, 0.8],
    });
    // painted smoke: alpha-blended, DARK, plum — it subtracts light, it does
    // not add grey (§7 bans wispy grey smoke; this is an ink shape).
    P.define('smoke', {
      shape: SHAPE.puff, additive: false,
      ramp: [S(0, '#3a1d52'), S(0.35, INK.plum), S(1, INK.deep)],
      alpha: [[0, 0], [0.16, 0.52], [0.6, 0.34], [1, 0]],
      size: [[0, 0.45], [1, 1.65]],
      size0: 0.55, size1: 1.05, life: [0.75, 1.5], speed: [0.7, 2.1],
      emit: 'cone', spread: 0.9, gravity: -0.35, drag: 1.8, turb: 0.9, turbFreq: 0.6,
      core: 0.35, rotVel: [-0.9, 0.9],
    });
    P.define('shard', {
      shape: SHAPE.shard,
      ramp: [S(0, '#fff4d8'), S(0.3, GOLD.core), S(0.7, '#8c3b46'), S(1, '#1c0810')],
      alpha: [[0, 1], [0.7, 0.9], [1, 0]],
      size: [[0, 0.7], [0.15, 1], [1, 0.6]],
      size0: 0.14, size1: 0.30, life: [0.45, 0.95], speed: [2.4, 6.5],
      emit: 'cone', spread: 1.0, gravity: 14, drag: 0.9, bounce: 0.28, core: 0.8, rotVel: [-7, 7],
    });
    P.define('dust', {
      shape: SHAPE.speckle, additive: false,
      ramp: [S(0, '#6b5a63'), S(0.4, '#3a2334'), S(1, INK.deep)],
      alpha: [[0, 0], [0.12, 0.42], [1, 0]],
      size: [[0, 0.5], [1, 1.5]],
      size0: 0.30, size1: 0.62, life: [0.5, 1.1], speed: [1.5, 4.0],
      emit: 'disc', spread: 0.5, gravity: 1.2, drag: 3.0, core: 0.2, rotVel: [-1.5, 1.5],
    });
    P.define('chev', {
      shape: SHAPE.chevron, stretch: 0.02,
      ramp: [S(0, '#ffffff'), S(0.35, GOLD.highlight), S(1, '#ff6a2a')],
      alpha: [[0, 0.9], [0.4, 0.6], [1, 0]],
      size: [[0, 0.5], [0.2, 1], [1, 0.45]],
      size0: 0.30, size1: 0.55, life: [0.16, 0.30], speed: [5, 11],
      emit: 'cone', spread: 0.35, drag: 5.5, core: 1.2,
    });
    // The GLOW layer of §5, and therefore the single particle most able to
    // break §9: it is by definition wide, soft and low-frequency, so every
    // one of them that sits near the stage adds a broad lift to the floor.
    // Wide is right; the alpha is what has to stay small.
    P.define('mote', {
      shape: SHAPE.glow,
      ramp: [S(0, '#ffffff'), S(0.3, GOLD.highlight), S(0.75, '#ff8a3c'), S(1, '#2a0a12')],
      alpha: [[0, 0], [0.14, 0.30], [0.6, 0.17], [1, 0]],
      size: [[0, 0.4], [0.3, 1.1], [1, 0.5]],
      size0: 0.22, size1: 0.98, life: [0.28, 0.82], speed: [0.3, 2.4],
      emit: 'sphere', spread: 0.5, drag: 3.2, core: 0.45,
    });
    P.define('rune', {
      shape: SHAPE.rune,
      ramp: [S(0, '#ffffff'), S(0.25, GODS.hecate), S(0.7, '#2f7f9c'), S(1, INK.violet)],
      alpha: [[0, 0], [0.15, 0.85], [0.6, 0.5], [1, 0]],
      size: [[0, 0.5], [0.3, 1.0], [1, 1.35]],
      size0: 0.62, size1: 1.15, life: [0.6, 0.95], speed: [0.2, 0.9],
      // core was 1.1 — the sigil's every stroke went near-white and the layer
      // stopped carrying the god colour at all (§5.2 wants the BODY saturated
      // and the core tiny). 0.42 leaves a hot inner line and a teal glyph.
      emit: 'disc', spread: 0.6, gravity: -0.5, drag: 2.0, core: 0.42, rotVel: [-0.5, 0.5],
      aVar: 0.55,
    });
  }

  // ═════════════════════════════════════════════════════════ CONTRACT ═════

  /**
   * impact(pos, normal, {type, scale, color})
   * §5: flash quad + ring shockwave + radial sparks + decal. ALWAYS all four.
   */
  impact(pos, normal, o = {}) {
    if (!this.enabled || !pos) return;
    const s = (o.scale ?? 1) * this._budget;
    const C = this._colors(o.type, o.color);
    const P = this.particles;
    const nx = normal ? (normal.x || 0) : 0;
    const nz = normal ? (normal.z ?? normal.y ?? 0) : 0;
    const nl = Math.hypot(nx, nz) || 1;
    const ux = nx / nl, uz = nz / nl;
    const x = pos.x, y = pos.y ?? 1.0, z = pos.z;

    // 1 — FLASH: one big burst-star, one four-point flare. Tiny and hot.
    P.emit('flash', 1, { x, y, z, size: 0.50 * s, color: C.core });
    P.emit('star', 1, { x, y, z, size: 0.95 * s, color: C.body });
    P.emit('star', 1, { x, y, z, size: 0.52 * s, color: C.core, lifeMul: 0.72 });

    // 2 — RING SHOCKWAVE on the ground under the hit
    this.rings.spawn(x, 0.035, z, {
      radius: 0.62 + 0.42 * s, life: 0.26, color: C.body, core: C.core,
      thick: 0.55, opacity: 1.0, ease: 2.6, phase: (Math.atan2(uz, ux) / 6.283185 + 1) % 1,
    });

    // 3 — RADIAL SPARKS, thrown back along the hit normal
    const n1 = Math.round(9 + 9 * s);
    P.emit('spark', n1, { x, y, z, dx: ux, dy: 0.42, dz: uz, spread: 1.02, speed: 1.0 * (0.75 + 0.3 * s), color: C.body });
    P.emit('sparkFine', Math.round(5 + 6 * s), { x, y, z, dx: ux, dy: 0.55, dz: uz, spread: 1.35, speed: 0.9, color: C.core });
    P.emit('chev', 2, { x, y, z, dx: ux, dy: 0.18, dz: uz, spread: 0.30, speed: 1.0, color: C.body });
    P.emit('mote', 1, { x, y, z, size: 0.70 * s, color: C.glow });
    if (s > 0.9) P.emit('shard', 4, { x, y, z, dx: ux, dy: 0.6, dz: uz, spread: 0.9, speed: 0.85, color: C.body });
    P.emit('smoke', 2, { x, y: y - 0.15, z, dx: ux, dy: 0.5, dz: uz, spread: 0.8, speed: 0.5, size: 0.8 * s });

    // 4 — DECAL on the stage
    this.decals.spawn(x, 0, z, {
      kind: C.decal, size: (0.85 + 0.5 * s), rot: this.rng.range(0, 6.283),
      opacity: 0.42 + 0.20 * s,
    });
    return this;
  }

  /**
   * slash(origin, dir, {arc, radius, color, width})
   * THE money effect: a swept crescent ribbon along the real swing arc.
   */
  slash(origin, dir, o = {}) {
    if (!this.enabled || !origin || !dir) return;
    const color = o.color || GOLD.highlight;
    const glow = o.glow || this.biome.key;
    const FX = (o.weapon && WEAPON_FX[o.weapon]) || null;
    const kind = FX ? FX.kind : 'crescent';
    const arc = kind === 'bash' ? Math.min(o.arc ?? 106, 84) : kind === 'jab' ? Math.min(o.arc ?? 106, 70) : (o.arc ?? 106);
    const R = (o.radius ?? 2.05) * (FX?.radiusMul ?? 1) * (kind === 'bash' ? 0.85 : 1);
    const spin = o.spin ?? (this.rng.bool() ? 1 : -1);
    const width = (o.width ?? 0.30) * (FX?.widthMul ?? 1) * (kind === 'bash' ? 1.5 : 1);
    const life = (o.life ?? 0.30) * (FX?.lifeMul ?? 1) * (kind === 'bash' ? 0.75 : 1);
    const bank = o.bank ?? (FX?.bank ?? 1.24);
    const rise = o.rise ?? R * 0.34 * (FX?.riseMul ?? 1);
    this.slashes.spawn(origin, dir, {
      arc, radius: R, width, color, glow,
      core: o.core || '#fffdf0', life, y: origin.y ?? 1.05,
      bank, rise, spin, opacity: o.opacity ?? 1,
    });
    if (FX) this._armSlash(FX, kind, origin, dir, { arc, R, width, life, color, glow, spin });

    // sparks shed off the blade's leading edge, laid down the swept path with
    // sub-frame interpolation so they streak instead of clumping at one point
    const fx = dir.x || 0, fz = dir.z ?? dir.y ?? 0;
    const fl = Math.hypot(fx, fz) || 1;
    const a0 = Math.atan2(fz / fl, fx / fl) - (arc * Math.PI / 360) * spin;
    const a1 = Math.atan2(fz / fl, fx / fl) + (arc * Math.PI / 360) * spin;
    const y = (origin.y ?? 1.05) + R * 0.06;
    const P = this.particles;
    const N = 5;
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N;
      const b0 = a0 + (a1 - a0) * t0, b1 = a0 + (a1 - a0) * t1;
      const w = Math.pow(Math.sin(((t0 + t1) * 0.5) * Math.PI), 0.5);
      P.emit('sparkFine', 3, {
        x: origin.x + Math.cos(b1) * R * 0.95, y: y + R * 0.12 * (0.5 - t1), z: origin.z + Math.sin(b1) * R * 0.95,
        px: origin.x + Math.cos(b0) * R * 0.95, py: y + R * 0.12 * (0.5 - t0), pz: origin.z + Math.sin(b0) * R * 0.95,
        dx: Math.cos(b1 + 1.4 * spin), dy: 0.42, dz: Math.sin(b1 + 1.4 * spin),
        spread: 0.8, speed: 0.75 * w, color, dt: 0.02,
      });
    }
    P.emit('mote', 2, { x: origin.x, y: origin.y ?? 1.05, z: origin.z, size: 1.5, color: glow });
    return this;
  }

  /** burst(pos, {count, color, speed, spread, kind}) */
  burst(pos, o = {}) {
    if (!this.enabled || !pos) return;
    const kind = o.kind || 'spark';
    const name = this.particles.byName.has(kind) ? kind : 'spark';
    const n = Math.max(1, Math.round((o.count ?? 14) * this._budget));
    const d = o.dir || null;
    this.particles.emit(name, n, {
      x: pos.x, y: pos.y ?? 0.9, z: pos.z,
      dx: d ? d.x : 0, dy: d ? (d.y ?? 0.6) : 1, dz: d ? (d.z ?? 0) : 0,
      spread: o.spread ?? 0.85,
      speed: (o.speed ?? 5) / 5,
      color: o.color, size: o.size ?? 1, lifeMul: o.lifeMul ?? 1,
    });
    if (o.glow !== false) {
      this.particles.emit('mote', Math.max(1, Math.round(2 * this._budget)), { x: pos.x, y: pos.y ?? 0.9, z: pos.z, size: 1.2, color: o.color || this.biome.rim });
    }
    return this;
  }

  /** trail(object3D, {color, width, life}) -> handle {release(), kill(), setColor()} */
  trail(object3D, o = {}) {
    if (!this.enabled || !object3D) return null;
    return this.trails.attach(object3D, {
      color: o.color || this.biome.rim, core: o.core || '#ffffff',
      width: o.width ?? 0.14, life: o.life ?? 0.30, ttl: o.ttl ?? 0,
      opacity: o.opacity ?? 1, offsetY: o.offsetY ?? 0, minStep: o.minStep,
    });
  }

  /** decal(pos, normal, {kind, size, color}) */
  decal(pos, normal, o = {}) {
    if (!this.enabled || !pos) return;
    this.decals.spawn(pos.x, pos.y ?? 0, pos.z, {
      kind: o.kind || 'scorch', size: o.size ?? 1.2, color: o.color,
      rot: o.rot ?? this.rng.range(0, 6.283), life: o.life, opacity: o.opacity,
    });
    return this;
  }

  /**
   * death(pos, {kind, color, scale})
   * §5: a bright flash, a directional burst of shade-wisps, then dissolve
   * upward. Never a ragdoll flop.
   */
  death(pos, o = {}) {
    if (!this.enabled || !pos) return;
    const s = o.scale ?? 1;
    const body = o.color || GODS.hecate;
    const P = this.particles;
    const x = pos.x, y = (pos.y ?? 0.9), z = pos.z;
    // deathScale controls spatial drama, not unbounded particle count. Bosses
    // use scales near 3, so multiplying every layer by that value caused the
    // largest single-frame allocation in the game. Preserve the large flash,
    // ring and soul column while capping density and applying the tier budget.
    const densityScale = o.boss ? Math.min(1.25, Math.sqrt(Math.max(0.5, s))) : Math.min(1.6, s);
    const count = (base, min = 1) => Math.max(min, Math.round(base * densityScale * this._budget));

    // 1 — the flash
    P.emit('flash', 1, { x, y: y + 0.2, z, size: 0.62 * s, color: '#ffffff' });
    P.emit('star', 2, { x, y: y + 0.2, z, size: 0.75 * s, color: body });
    this.rings.spawn(x, 0.04, z, { radius: 0.95 * s, life: 0.30, color: body, core: '#ffffff', thick: 0.5, ease: 2.2, opacity: 0.85 });

    // 2 — the directional burst of shade-wisps
    const d = o.dir || null;
    P.emit('wisp', count(13, 3), {
      x, y, z, dx: d ? d.x : 0, dy: 1.0, dz: d ? d.z : 0, spread: d ? 0.75 : 1.15, speed: 0.85, color: body,
    });
    P.emit('smoke', count(6, 2), { x, y, z, dy: 1, spread: 0.9, speed: 0.5, size: 1.1 * Math.min(s, 2) });
    P.emit('spark', count(10, 3), { x, y, z, dy: 0.9, spread: 1.25, speed: 0.9, color: body });
    this.decals.spawn(x, 0, z, { kind: 'ichor', size: 1.5 * s, rot: this.rng.range(0, 6.283), opacity: 0.6 });

    // 3 — dissolve upward: a soul column plus three staggered ember releases
    this._at(0.05, () => {
      _v.set(x, y - 0.45, z); _v2.set(x, y + 1.75 * s, z);
      this.beams.spawn(_v, _v2, { color: body, core: '#eafcff', width: 0.24 * s, life: 0.55, opacity: 0.34 });
    });
    for (let k = 0; k < 3; k++) {
      this._at(0.08 + k * 0.12, () => {
        P.emit('ember', count(7, 2), { x, y: y - 0.3 + k * 0.45, z, dy: 1, spread: 0.42, speed: 0.55, color: body });
        if (this._budget >= 0.5 || k === 1) P.emit('rune', 1, { x, y: y + 0.35 + k * 0.5, z, size: 0.7 * s, color: body });
      });
    }
    return this;
  }

  /**
   * The per-arm half of a swing: what makes the axe frame heavy, the shield
   * frame a bash and the fists a flurry, on top of (or instead of) the ribbon.
   */
  _armSlash(FX, kind, origin, dir, q) {
    const P = this.particles;
    const fx = dir.x || 0, fz = dir.z ?? dir.y ?? 0;
    const fl = Math.hypot(fx, fz) || 1, ux = fx / fl, uz = fz / fl;
    const y = origin.y ?? 1.05;
    if (kind === 'heavy') {
      // a second, tighter ribbon inside the first: the double edge of a
      // labrys reads as WEIGHT, and the embers it sheds say the same
      this.slashes.spawn(origin, dir, { arc: q.arc * 0.86, radius: q.R * 0.70, width: q.width * 0.55, color: q.color, glow: q.glow, core: '#fffdf0', life: q.life * 0.9, y: y - 0.12, bank: 0.7, rise: q.R * 0.2, spin: q.spin, opacity: 0.75 });
      if (FX.embers) P.emit('ember', FX.embers, { x: origin.x + ux * q.R * 0.7, y: y + 0.2, z: origin.z + uz * q.R * 0.7, dx: ux, dy: 0.8, dz: uz, spread: 0.9, speed: 0.8, color: q.color });
      if (FX.wisps) P.emit('wisp', FX.wisps, { x: origin.x + ux * q.R * 0.6, y, z: origin.z + uz * q.R * 0.6, dx: ux, dy: 0.6, dz: uz, spread: 0.8, speed: 0.6, color: q.color });
    } else if (kind === 'bash') {
      // THE FLAT BASH RING: a disc of force at the shield's face, plus a
      // fan of chevrons thrown forward. No crescent tail — a shield does
      // not cut.
      const bx = origin.x + ux * q.R * 0.8, bz = origin.z + uz * q.R * 0.8;
      this.rings.spawn(bx, y - 0.05, bz, { radius: (FX.ring ?? 1.1), life: 0.22, color: q.color, core: '#ffffff', thick: 0.62, ease: 3.0, opacity: 0.95, phase: (Math.atan2(uz, ux) / 6.283185 + 1) % 1 });
      P.emit('chev', 6, { x: bx, y, z: bz, dx: ux, dy: 0.1, dz: uz, spread: 0.55, speed: 1.1, color: q.color });
      P.emit('star', 1, { x: bx, y, z: bz, size: 0.6, color: '#fffdf0' });
    } else if (kind === 'jab') {
      P.emit('chev', FX.chev ?? 5, { x: origin.x + ux * q.R * 0.75, y, z: origin.z + uz * q.R * 0.75, dx: ux, dy: 0.05, dz: uz, spread: 0.3, speed: 1.3, color: q.color });
      P.emit('star', 1, { x: origin.x + ux * q.R * 0.95, y, z: origin.z + uz * q.R * 0.95, size: 0.42, color: '#fffdf0', lifeMul: 0.7 });
    } else if (kind === 'twin') {
      // the sister blade: a second thin ribbon, mirrored, a hair lower
      this.slashes.spawn(origin, dir, { arc: q.arc * 0.9, radius: q.R * 0.84, width: q.width * 0.8, color: q.color, glow: q.glow, core: '#fffdf0', life: q.life, y: y - 0.22, bank: 1.1, rise: -q.R * 0.25, spin: -q.spin, opacity: 0.9 });
    }
    if (FX.runes) P.emit('rune', FX.runes, { x: origin.x + ux * q.R * 0.5, y: y + 0.3, z: origin.z + uz * q.R * 0.5, size: 0.7, color: q.color });
  }

  /** beam(a, b, {color, width, life}) — core + glow + scrolling energy + caps */
  beam(a, b, o = {}) {
    if (!this.enabled || !a || !b) return;
    const color = o.color || GODS.hecate;
    const FX = (o.weapon && WEAPON_FX[o.weapon]) || null;
    if (o.thrust && FX) return this._thrust(FX, a, b, o, color);
    const life = o.life ?? 0.45;
    this.beams.spawn(a, b, { color, core: o.core || '#ffffff', width: o.width ?? 0.22, life, opacity: o.opacity ?? 1 });
    const P = this.particles;
    // end caps
    P.emit('star', 1, { x: a.x, y: a.y, z: a.z, size: 0.5, color });
    P.emit('star', 1, { x: b.x, y: b.y, z: b.z, size: 0.62, color });
    P.emit('mote', 2, { x: b.x, y: b.y, z: b.z, size: 1.4, color });
    // energy shedding along the shaft
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    P.emit('sparkFine', 10, {
      x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5,
      px: a.x, py: a.y, pz: a.z,
      dx: dx / L, dy: dy / L + 0.3, dz: dz / L, spread: 1.2, speed: 0.5, color, dt: 0.03,
    });
    if ((b.y ?? 0) < 0.9) this.rings.spawn(b.x, 0.04, b.z, { radius: 0.8 * (o.width ?? 0.22) * 5, life: 0.35, color, thick: 0.34, opacity: 0.45 });
    return this;
  }

  /** shockwave(pos, {radius, color, life}) */
  shockwave(pos, o = {}) {
    if (!this.enabled || !pos) return;
    const color = o.color || this.biome.key;
    const R = o.radius ?? 3;
    const life = o.life ?? 0.45;
    const density = Math.max(0, o.density ?? 1);
    const q = this._budget * density;
    const ringsOk = this._ringOk();
    if (ringsOk) this.rings.spawn(pos.x, (pos.y ?? 0) + 0.04, pos.z, {
      radius: R, life, color, core: '#fff6e0', thick: 0.40, ease: 2.7, opacity: o.opacity ?? 0.85,
    });
    if (ringsOk && R > 2.4 && q >= 0.58 && this._ringOk(RING_CAP - 1)) this.rings.spawn(pos.x, (pos.y ?? 0) + 0.05, pos.z, {
      radius: R * 0.55, life: life * 0.72, color: o.core || '#fff2cf', thick: 0.22, ease: 3.1, opacity: 0.35,
      phase: o.phase ?? 0,
    });
    this.particles.emit('dust', Math.max(3, Math.round(16 * q)), { x: pos.x, y: 0.10, z: pos.z, spread: R * 0.22, speed: 0.9, size: 1.1 });
    this.particles.emit('sparkFine', Math.max(3, Math.round(12 * q)), { x: pos.x, y: 0.16, z: pos.z, dy: 0.28, spread: 1.45, speed: 1.1, color });
    if (q >= 0.5) this.particles.emit('mote', 1, { x: pos.x, y: 0.42, z: pos.z, size: 0.8, color });
    return this;
  }

  /** true while the floor can take another ring without turning into ripples */
  _ringOk(cap = RING_CAP) { return !this.rings.liveCount || this.rings.liveCount() < cap; }

  /**
   * THE THRUST STREAK — the spear's (and the staff's, and the shield jab's)
   * line: a long, thin, fast beam with a hot tip, chevrons racing down it and
   * nothing swept. Reads as "the hitbox is a line" at 1/8 resolution.
   */
  _thrust(FX, a, b, o, color) {
    const P = this.particles;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    if (FX.kind === 'bash' || FX.kind === 'jab') {
      // a shield jab / a gauntlet: short, blunt — the bash ring at the tip
      this.beams.spawn(a, b, { color, core: o.core || '#ffffff', width: (o.width ?? 0.3) * 0.9, life: 0.14, opacity: 0.9 });
      this.rings.spawn(b.x, b.y - 0.05, b.z, { radius: (FX.ring ?? 0.9) * 0.8, life: 0.2, color, core: '#ffffff', thick: 0.6, ease: 3.0, opacity: 0.9 });
      P.emit('chev', 4, { x: b.x, y: b.y, z: b.z, dx: ux, dy: 0.1, dz: uz, spread: 0.5, speed: 1.1, color });
      return this;
    }
    const w = (o.width ?? 0.30) * (FX.widthMul ?? 0.55);
    this.beams.spawn(a, b, { color, core: o.core || '#fffdf0', width: w, life: (o.life ?? 0.2) * (FX.lifeMul ?? 0.8), opacity: o.opacity ?? 1 });
    // chevrons race down the shaft, laid along it with sub-frame interpolation
    P.emit('chev', 5, { x: b.x - ux * 0.6, y: b.y - uy * 0.6, z: b.z - uz * 0.6, px: a.x, py: a.y, pz: a.z, dx: ux, dy: uy, dz: uz, spread: 0.12, speed: 1.4, color, dt: 0.03 });
    // the tip: a hot four-point star and a few fine sparks thrown forward
    P.emit('star', 1, { x: b.x, y: b.y, z: b.z, size: 0.55, color: '#fffdf0', lifeMul: 0.8 });
    P.emit('sparkFine', 6, { x: b.x, y: b.y, z: b.z, dx: ux, dy: 0.25, dz: uz, spread: 0.45, speed: 1.1, color });
    if (FX.thrustRune) P.emit('rune', 1, { x: b.x, y: b.y + 0.1, z: b.z, size: 0.6, color });
    return this;
  }

  // ═══════════════════════════════════════════════════════════ THE BEATS ══
  _bindBeats(ctx) {
    const on = (n, fn) => ctx.events.on(n, (e) => { if (this.enabled && e) fn(e); });
    on('boss.enraged', (e) => this.enrage(e.entity, e.pos || e.entity?.position));
    on('weapon.perfectChain', (e) => this.perfectChain(e.actor, e));
    on('weapon.charge.tier', (e) => this.chargeTick(e.actor, e.tier || 1, e.of || 3, e));
    on('weapon.charge.full', (e) => this.chargeTick(e.actor, (e.of || 3) + 1, e.of || 3, { ...e, full: true }));
    on('player.riposte', (e) => this.riposte(e.pos || e.target?.position, e.target));
    on('weapon.riposte', (e) => this.riposteArm(e.actor, e.color));
    on('weapon.tipHit', (e) => this.tipHit(e.pos || e.target?.position, e.target));
    on('enemy.elite', (e) => this.elite(e.entity, e.affix, e.pos || e.entity?.position));
    on('damage.backstab', (e) => this.backstab(e.target, e.source));
    on('weapon.loose', (e) => this.tracer(e.actor, e));
    on('enemy.blink', (e) => { if (e.pos) this.burst(_v.set(e.pos.x, 0.8, e.pos.z), { count: 10, color: e.entity?.def?.identity, speed: 5, spread: 1.1, kind: 'wisp' }); });
  }

  /**
   * boss.enraged: a red-gold shockwave in three widening rings, a column of
   * embers, a screen flash — and a persistent rim aura under the boss for the
   * rest of the fight. The rule change is visible from across the room.
   */
  enrage(entity, pos) {
    if (!pos) return;
    const body = '#ff5a3c', gold = GOLD.highlight;
    const x = pos.x, z = pos.z;
    for (let i = 0; i < 3; i++) {
      this._at(i * 0.09, () => {
        if (this._ringOk(RING_CAP + 2)) this.rings.spawn(x, 0.05 + i * 0.02, z, { radius: 3.2 + i * 2.4, life: 0.55 + i * 0.15, color: i === 1 ? gold : body, core: '#fff0c0', thick: 0.42, ease: 2.6, opacity: 0.9 });
      });
    }
    const P = this.particles;
    P.emit('flash', 1, { x, y: 1.6, z, size: 1.1, color: '#fff0c0' });
    P.emit('star', 2, { x, y: 1.6, z, size: 1.3, color: body });
    P.emit('ember', Math.round(30 * this._budget), { x, y: 0.5, z, dy: 1, spread: 0.9, speed: 1.3, color: gold });
    P.emit('spark', Math.round(18 * this._budget), { x, y: 1.2, z, dy: 0.7, spread: 1.4, speed: 1.2, color: body });
    this.screen?.flash?.(body, 0.42, 0.32);
    this.screen?.pulse?.(1.2, 0.7, 0.3);
    this.aura(entity, { color: body, core: gold, radius: Math.max(1.6, (entity?.radius || 1) * 2.1), every: 0.42, life: 1e9, embers: 2, opacity: 0.6 });
  }

  /**
   * A pulsing ring that follows an entity: the boss's enrage rim, the elite's
   * affix mark. One record per entity; re-arming refreshes it. Zero per-frame
   * allocation — the ring is re-spawned from the pool on a period.
   */
  aura(entity, o = {}) {
    if (!entity) return null;
    let a = null;
    for (let i = 0; i < this._auras.length; i++) if (this._auras[i].entity === entity) { a = this._auras[i]; break; }
    if (!a) { a = { entity, t: 0, next: 0 }; this._auras.push(a); }
    a.color = o.color || GOLD.highlight; a.core = o.core || '#ffffff';
    a.radius = o.radius ?? 1.4; a.every = o.every ?? 0.5; a.life = o.life ?? 5;
    a.embers = o.embers ?? 0; a.opacity = o.opacity ?? 0.55; a.t = 0; a.next = 0;
    return a;
  }
  _updateAuras(dt) {
    const A = this._auras;
    for (let i = A.length - 1; i >= 0; i--) {
      const a = A[i], e = a.entity;
      a.t += dt;
      if (!e || e.dead || e.alive === false || a.t > a.life || !e.position) { A.splice(i, 1); continue; }
      if (a.t < a.next) continue;
      a.next = a.t + a.every;
      const x = e.position.x, z = e.position.z;
      if (this._ringOk(RING_CAP + 1)) this.rings.spawn(x, 0.045, z, { radius: a.radius, r0: a.radius * 0.55, life: a.every * 1.5, color: a.color, core: a.core, thick: 0.30, ease: 2.0, opacity: a.opacity });
      if (a.embers) this.particles.emit('ember', a.embers, { x, y: 0.3, z, dy: 1, spread: 0.6, speed: 0.6, color: a.core });
    }
  }

  /** weapon.perfectChain: a crisp gold ring at the blade's reach — the metronome ticked */
  perfectChain(actor, e = {}) {
    if (!actor || !actor.position) return;
    const fx = actor.facing ? actor.facing.x : 0, fz = actor.facing ? (actor.facing.z ?? actor.facing.y ?? 1) : 1;
    const reach = Math.min(3.2, Math.max(1.2, (e.reach || 2.2) * 0.6));
    const x = actor.position.x + fx * reach, z = actor.position.z + fz * reach, y = 1.0;
    const streak = Math.min(4, e.streak || 1);
    this.rings.spawn(x, y, z, { radius: 0.72 + 0.12 * streak, r0: 0.25, life: 0.22, color: GOLD.highlight, core: '#ffffff', thick: 0.16, ease: 3.2, opacity: 0.95 });
    this.particles.emit('star', 1, { x, y, z, size: 0.48, color: '#fffdf0', lifeMul: 0.75 });
    this.particles.emit('diamond' in SHAPE ? 'sparkFine' : 'sparkFine', 4 + streak, { x, y, z, dy: 0.4, spread: 1.3, speed: 0.7, color: GOLD.highlight });
  }

  /** weapon.charge.tier: a tick ring at the hero's feet, one radius per tier; full = a flare */
  chargeTick(actor, tier, of, e = {}) {
    if (!actor || !actor.position) return;
    const x = actor.position.x, z = actor.position.z;
    const color = e.color || GOLD.highlight, glow = e.glow || color;
    const full = !!e.full;
    const r = 0.85 + 0.28 * Math.min(tier, of + 1);
    this.rings.spawn(x, 0.04, z, { radius: r, r0: r * 0.7, life: full ? 0.34 : 0.22, color: full ? '#ffffff' : color, core: '#ffffff', thick: full ? 0.26 : 0.14, ease: 3.0, opacity: full ? 1 : 0.8 });
    // the charge glow at the hands (a drawn bow, a gathering flame)
    const FX = e.weapon && WEAPON_FX[e.weapon];
    const hx = x + (actor.facing?.x || 0) * 0.5, hz = z + (actor.facing?.z ?? actor.facing?.y ?? 0) * 0.5;
    this.particles.emit('mote', 1, { x: hx, y: 1.15, z: hz, size: 0.7 + 0.25 * tier, color: glow });
    if (full) { this.particles.emit('star', 1, { x: hx, y: 1.15, z: hz, size: 0.9, color: '#ffffff' }); this.particles.emit('sparkFine', 8, { x: hx, y: 1.15, z: hz, dy: 0.5, spread: 1.4, speed: 0.8, color }); }
    else if (FX && FX.charge === 'glow') this.particles.emit('ember', 2, { x: hx, y: 1.0, z: hz, dy: 1, spread: 0.4, speed: 0.4, color });
  }

  /** player.riposte: the read was right — a blue-white arc over the victim */
  riposte(pos, target) {
    if (!pos) return;
    const x = pos.x, z = pos.z, y = (target?.height || 1.8) * 0.6;
    _v3.set(1, 0, 0);
    this.slashes.spawn({ x, y, z }, _v3, { arc: 150, radius: 1.5, width: 0.42, color: '#bfe9ff', glow: '#5fd0ff', core: '#ffffff', life: 0.28, y, bank: 0.35, rise: 0.3, spin: 1, opacity: 1 });
    this.particles.emit('chev', 6, { x, y, z, dy: 0.8, spread: 1.1, speed: 1.1, color: '#bfe9ff' });
    this.particles.emit('star', 1, { x, y: y + 0.4, z, size: 0.7, color: '#ffffff' });
    this.screen?.pulse?.(0.6, 0.35, 0.16);
  }
  /** weapon.riposte: the arm that carries the bonus flashes cold in the hand */
  riposteArm(actor, color) {
    if (!actor || !actor.position) return;
    const x = actor.position.x, z = actor.position.z;
    this.particles.emit('star', 1, { x, y: 1.25, z, size: 0.55, color: '#bfe9ff', lifeMul: 0.8 });
    this.particles.emit('mote', 1, { x, y: 1.1, z, size: 1.0, color: '#5fd0ff' });
  }

  /** weapon.tipHit: a spark spike straight up out of the point */
  tipHit(pos, target) {
    if (!pos) return;
    const x = pos.x, z = pos.z, y = (target?.height || 1.8) * 0.62;
    this.particles.emit('spark', 7, { x, y, z, dy: 1.4, spread: 0.22, speed: 1.35, color: '#fffdf0' });
    this.particles.emit('star', 1, { x, y: y + 0.2, z, size: 0.62, color: '#ffffff', lifeMul: 0.7 });
    this.particles.emit('chev', 3, { x, y, z, dy: 1.0, spread: 0.3, speed: 1.2, color: GOLD.highlight });
  }

  /** enemy.elite: an affix-coloured ring, and a slow aura for six seconds */
  elite(entity, affix, pos) {
    if (!pos) return;
    const color = AFFIX_COLOR[affix] || GOLD.highlight;
    this.rings.spawn(pos.x, 0.05, pos.z, { radius: 2.6, life: 0.6, color, core: '#ffffff', thick: 0.32, ease: 2.6, opacity: 0.95 });
    this.particles.emit('rune', 3, { x: pos.x, y: 0.4, z: pos.z, size: 0.9, color });
    this.particles.emit('sparkFine', 12, { x: pos.x, y: 0.3, z: pos.z, dy: 0.5, spread: 1.4, speed: 1.0, color });
    this.aura(entity, { color, core: '#ffffff', radius: Math.max(1.2, (entity?.radius || 0.5) * 2.4), every: 0.55, life: 6, opacity: 0.5 });
  }

  /** damage.backstab: a dark-red shard burst behind the victim's shoulders */
  backstab(target, source) {
    if (!target || !target.position) return;
    const x = target.position.x, z = target.position.z, y = (target.height || 1.8) * 0.7;
    const bx = source?.position ? source.position.x - x : 0, bz = source?.position ? source.position.z - z : 0;
    const bl = Math.hypot(bx, bz) || 1;
    this.particles.emit('shard', 6, { x, y, z, dx: -bx / bl, dy: 0.6, dz: -bz / bl, spread: 0.7, speed: 1.0, color: '#e01f2d' });
    this.particles.emit('star', 1, { x, y, z, size: 0.5, color: '#ff8a8a', lifeMul: 0.7 });
  }

  /**
   * weapon.loose: the per-arm TRACER. A bow shot is a thin gold line to the
   * horizon with a flare at the bow; the rail a white-blue streak with a
   * muzzle star and casings; the flames an ember cone; the skull a wisp
   * trail; the thrown spear a green line with chevrons.
   */
  tracer(actor, e = {}) {
    if (!actor || !actor.position) return;
    const FX = (e.weapon && WEAPON_FX[e.weapon]) || null;
    const T = FX && FX.tracer; if (!T) return;
    const fx = actor.facing ? actor.facing.x : 0, fz = actor.facing ? (actor.facing.z ?? actor.facing.y ?? 1) : 1;
    const fl = Math.hypot(fx, fz) || 1, ux = fx / fl, uz = fz / fl;
    const color = e.color || GOLD.highlight;
    const x0 = actor.position.x + ux * 0.7, z0 = actor.position.z + uz * 0.7, y = 1.15;
    const len = T.len * (e.full ? 1.25 : 1);
    _v.set(x0, y, z0); _v2.set(x0 + ux * len, y + 0.15, z0 + uz * len);
    this.beams.spawn(_v, _v2, { color, core: T.core || '#ffffff', width: T.width * (e.full ? 1.4 : 1), life: T.life, opacity: 0.95 });
    const P = this.particles;
    if (T.star) P.emit('star', 1, { x: x0, y, z: z0, size: T.star * (e.full ? 1.4 : 1), color: '#fffdf0', lifeMul: 0.7 });
    if (T.muzzle) { P.emit('star', 1, { x: x0, y, z: z0, size: 0.8, color: '#ffffff', lifeMul: 0.6 }); P.emit('burst' in SHAPE ? 'flash' : 'flash', 1, { x: x0, y, z: z0, size: 0.35, color: T.core || '#ffffff' }); }
    if (T.casing) P.emit('shard', T.casing, { x: x0 - ux * 0.3, y: y - 0.1, z: z0 - uz * 0.3, dx: -uz, dy: 0.9, dz: ux, spread: 0.4, speed: 0.6, color: GOLD.highlight });
    if (T.chev) P.emit('chev', T.chev, { x: x0 + ux * 2.5, y, z: z0 + uz * 2.5, px: x0, py: y, pz: z0, dx: ux, dy: 0, dz: uz, spread: 0.1, speed: 1.5, color, dt: 0.03 });
    if (T.embers) P.emit('ember', T.embers, { x: x0 + ux * 1.2, y, z: z0 + uz * 1.2, dx: ux, dy: 0.5, dz: uz, spread: 0.55, speed: 1.2, color });
    if (T.wisps) P.emit('wisp', T.wisps, { x: x0 + ux * 1.0, y, z: z0 + uz * 1.0, dx: ux, dy: 0.4, dz: uz, spread: 0.5, speed: 1.0, color });
    if (T.runes) P.emit('rune', T.runes, { x: x0 + ux * 1.5, y: y + 0.2, z: z0 + uz * 1.5, size: 0.7, color });
  }

  // ══════════════════════════════════════════════════════════ internals ═══
  /** Schedule `fn` `dt` seconds from now, on sim time. */
  _at(dt, fn) { this._pending.push({ t: this.ctx.time.t + dt, fn }); }

  clear() {
    for (const target of [...this._doom.keys()]) this._removeDoom(target);
    this._auras.length = 0;
    this.particles.clear(); this.rings.clear(); this.slashes.clear();
    this.beams.clear(); this.trails.clear(); this.decals.clear();
    this._pending.length = 0;
  }

  update(dt, ctx) {
    if (!this.enabled) return;
    const t = ctx.time.t;
    if (this._pending.length) {
      for (let i = this._pending.length - 1; i >= 0; i--) {
        if (this._pending[i].t <= t) { const p = this._pending[i]; this._pending.splice(i, 1); p.fn(); }
      }
    }
    this.particles.update(dt, t);
    this.rings.update(dt);
    this.slashes.update(dt);
    this.beams.update(dt, t);
    this.trails.update(dt);
    this.decals.update(dt);
    this.screen.update(dt);
    this._updateDoom(dt, ctx);
    this._updateAuras(dt);

    // graceful degradation: if the pool is saturated, thin new emissions
    const load = this.particles.count / this.particles.cap;
    const loadBudget = load > 0.9 ? 0.45 : load > 0.72 ? 0.72 : 1;
    this._budget = this._tierBudget * loadBudget;
  }

  lateUpdate(alpha, ctx) {
    if (!this.enabled) return;
    this.particles.flush();
    this.decals.flush();
  }

  resize() { }

  dispose() {
    for (const target of [...this._doom.keys()]) this._removeDoom(target);
    if (this._doomTemplate) {
      this._doomTemplate.traverse(o => { if (o.isMesh) { o.geometry?.dispose?.(); o.material?.dispose?.(); } });
      this._doomTemplate = null;
    }
    this.particles.dispose(); this.rings.dispose(); this.slashes.dispose();
    this.beams.dispose(); this.trails.dispose(); this.decals.dispose();
    this.screen.dispose();
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
  }

  // ═══════════════════════════════════════════════════ capture scenarios ══
  _captureState(name, ctx) {
    if (name === 'vfxburst') { this.clear(); this.rng.reseed('vfx:burst'); this._setupBurst(ctx); }
    else if (name === 'death') { this.clear(); this.rng.reseed('vfx:death'); this._setupDeath(ctx); }
    else if (name === 'doom') { /* EnemyManager just authored the live Doom mark; retain it. */ }
    else if (name) { this.clear(); }
  }

  _origin(ctx) {
    const p = ctx.player && ctx.player.position;
    _v2.set(p ? p.x : 0, 0, p ? p.z : 0);
    return _v2;
  }

  /**
   * `vfxburst` — the portfolio frame. tools/shotlist.json steps 0.35 s after
   * this fires, so every element is scheduled to land at ITS OWN peak on that
   * frame: the slash mid-wipe at full opacity, the shockwave at ~60% travel,
   * the sparks in flight and still hot, the beam open, the embers risen.
   *
   * Composition follows §9.6 / §11: one dominant warm hue (the Tartarus key)
   * carried by the slash and the impacts, opposed by the cold rim hue on the
   * beam and the shade wisps, over a floor that stays the dark stage.
   */
  _setupBurst(ctx) {
    const o = this._origin(ctx);
    const ox = o.x, oz = o.z;
    // SCREEN-SPACE BASIS. The rig looks down the world diagonal at yaw 45, so
    // "in front of the hero" in world space is straight DOWN the screen and an
    // effect authored there falls out of the bottom of the frame. `up` runs
    // away from camera (up the image), `right` runs across it. Composition is
    // authored in that basis, not in the hero's facing.
    const ux = -0.7071, uz = -0.7071;
    const rx = 0.7071, rz = -0.7071;
    const warm = GOLD.highlight, key = this.biome.key, cold = this.biome.rim;
    const P = this.particles;
    const at = (a, b) => ({ x: ox + ux * a + rx * b, z: oz + uz * a + rz * b });

    // ── the stage: marks already burned into the floor, low and dark ──
    const c1 = at(2.4, 0.3), c2 = at(1.1, -1.5);
    this.decals.spawn(c1.x, 0, c1.z, { kind: 'crack', size: 2.6, rot: 0.6, opacity: 0.55 });
    this.decals.spawn(c2.x, 0, c2.z, { kind: 'scorch', size: 1.5, rot: 2.1, opacity: 0.45 });

    // t=0.00 — embers already rising on the left; a telegraph burning out right
    this._at(0.00, () => {
      const t = at(1.6, 3.2);
      this.decals.spawn(t.x, 0, t.z, { kind: 'telegraph', size: 1.6, opacity: 0.30, color: TARTARUS.blood, life: 1.2 });
      const e = at(0.9, -2.9);
      P.emit('ember', 9, { x: e.x, y: 0.35, z: e.z, dy: 1, spread: 0.5, speed: 0.7, color: key });
    });

    // t=0.03 — the first slash of the combo, three-quarters faded by the frame
    this._at(0.03, () => {
      const p0 = at(0.55, -0.25);
      this.slash({ x: p0.x, y: 1.42, z: p0.z }, { x: ux, z: uz },
        { arc: 112, radius: 1.90, width: 0.26, color: key, glow: '#ff6a2a', spin: -1, life: 0.44, opacity: 0.6, bank: 1.05 });
    });

    // t=0.09 — the cold complement: a beam cast up and across (§9.6 two hues)
    this._at(0.09, () => {
      const a = at(0.3, 0.95); const b = at(2.1, 3.3);
      _v.set(a.x, 1.25, a.z);
      this.beams.spawn(_v, { x: b.x, y: 2.35, z: b.z },
        { color: cold, core: '#eafcff', width: 0.26, life: 0.66, opacity: 0.85 });
      P.emit('sparkFine', 9, { x: b.x, y: 2.35, z: b.z, px: a.x, py: 1.25, pz: a.z, dy: 0.5, spread: 1.2, speed: 0.6, color: cold, dt: 0.03 });
      P.emit('star', 1, { x: b.x, y: 2.35, z: b.z, size: 0.55, color: cold });
    });

    // t=0.245 — the heavy IMPACT, up-screen from the hero where the eye lands.
    // Timed so its ring is ~40% through its 0.30 s life on the captured frame:
    // a shockwave is a fast event, and a ring held past its prime reads as a
    // hoop lying on the floor rather than as a hit.
    this._at(0.245, () => {
      const i = at(1.95, 0.45);
      _v.set(i.x, 1.15, i.z);
      this.impact(_v, { x: -ux, z: -uz }, { type: 'physical', scale: 1.35, color: warm });
      // no second ring here: impact() already lays one at this spot and two
      // concentric rings in the same place read as pond ripples, not a hit
    });

    // t=0.20 — a shade death off to the left: second colour, and depth
    this._at(0.20, () => {
      const d = at(1.1, -2.5);
      this.death({ x: d.x, y: 1.0, z: d.z }, { color: cold, scale: 1.0, dir: { x: -rx, z: -rz } });
    });

    // t=0.22 — the MONEY CRESCENT, caught mid-wipe on the captured frame
    this._at(0.22, () => {
      const p1 = at(0.62, 0.18);
      this.slash({ x: p1.x, y: 1.32, z: p1.z }, { x: ux, z: uz },
        { arc: 104, radius: 2.20, width: 0.34, color: warm, glow: key, spin: 1, life: 0.34, bank: 1.30 });
    });

    // t=0.05 — an earlier, smaller hit: by the captured frame only its sparks
    // survive, which is what gives the burst a rhythm instead of one blob
    this._at(0.05, () => {
      const i = at(1.05, 1.85);
      _v.set(i.x, 1.45, i.z);
      this.impact(_v, { x: -rx * 0.9 - ux * 0.4, z: -rz * 0.9 - uz * 0.4 }, { type: 'physical', scale: 0.7, color: key });
    });

    // t=0.31 — the last hot frame: a crit flare four frames old
    this._at(0.31, () => {
      const i = at(1.95, 0.45);
      P.emit('star', 1, { x: i.x, y: 1.25, z: i.z, size: 0.66, color: '#fffdf2' });
      P.emit('sparkFine', 12, { x: i.x, y: 1.15, z: i.z, dy: 0.5, spread: 1.5, speed: 1.2, color: warm });
      P.emit('chev', 4, { x: i.x, y: 1.2, z: i.z, dx: ux, dy: 0.15, dz: uz, spread: 0.4, speed: 1.2, color: warm });
    });

    // the hero's dash ribbon, arriving from screen-left into the swing
    const tp = { x: ox - rx * 2.2, y: 1.05, z: oz - rz * 2.2 };
    const h = this.trails.attach(tp, { color: cold, width: 0.17, life: 0.45, opacity: 0.72, minStep: 0.05 });
    for (let i = 1; i <= 14; i++) {
      this._at(i * 0.016, () => {
        const k = i / 14;
        const bow = Math.sin(k * Math.PI) * 1.05;      // the dash curves in
        h.move(ox - rx * 2.6 * (1 - k) + ux * bow, 1.02 + 0.30 * Math.sin(k * 2.4), oz - rz * 2.6 * (1 - k) + uz * bow);
      });
    }
  }

  /** `death` — one enemy death held at its most spectacular frame. */
  _setupDeath(ctx) {
    const o = this._origin(ctx);
    const face = ctx.player && ctx.player.facing
      ? { x: ctx.player.facing.x, z: ctx.player.facing.y } : { x: 0.42, z: 0.91 };
    const fl = Math.hypot(face.x, face.z) || 1;
    const fx = face.x / fl, fz = face.z / fl;
    const px = o.x + fx * 2.2, pz = o.z + fz * 2.2;
    this._at(0.02, () => {
      _v.set(px, 1.05, pz);
      this.impact(_v, { x: -fx, z: -fz }, { type: 'physical', scale: 1.3 });
    });
    this._at(0.10, () => {
      this.death({ x: px, y: 1.05, z: pz }, { color: this.biome.rim, scale: 1.35, dir: { x: fx, z: fz } });
    });
    this._at(0.16, () => {
      this.shockwave({ x: px, y: 0, z: pz }, { radius: 3.4, color: this.biome.rim, life: 0.6 });
    });
  }
}

export default VFX;
