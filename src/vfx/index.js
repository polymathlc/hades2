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
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

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
  }

  // ───────────────────────────────────────────────────────────────── init ──
  async init(ctx) {
    this.ctx = ctx;
    this.rng = new RNG('vfx');
    const tier = (ctx.quality && ctx.quality.tier) || 'high';
    const cap = tier === 'low' ? 700 : tier === 'med' ? 1400 : 2400;

    this.root = new THREE.Group();
    this.root.name = 'vfx';
    ctx.scene.add(this.root);

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
    ctx.events.on('entity.died', (d) => {
      if (!d || !d.pos || d.entity === ctx.player) return;
      this.death(d.pos, { color: d.color, scale: d.scale || 1 });
    });
    ctx.events.on('room.built', () => this.clear());
    return this;
  }

  setBiome(name) {
    const B = BIOMES[name] || BIOMES.tartarus;
    this.biome = { name, key: B.key, rim: B.rim, accent: B.accent, shadow: B.shadow };
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
      size0: 0.10, size1: 0.22, life: [0.9, 1.8], speed: [0.5, 1.9],
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
    P.define('mote', {
      shape: SHAPE.glow,
      ramp: [S(0, '#ffffff'), S(0.3, GOLD.highlight), S(0.75, '#ff8a3c'), S(1, '#2a0a12')],
      alpha: [[0, 0], [0.14, 0.55], [0.6, 0.35], [1, 0]],
      size: [[0, 0.4], [0.3, 1.1], [1, 0.5]],
      size0: 0.55, size1: 1.0, life: [0.35, 0.7], speed: [0.4, 1.8],
      emit: 'sphere', spread: 0.5, drag: 3.2, core: 0.45,
    });
    P.define('rune', {
      shape: SHAPE.rune,
      ramp: [S(0, '#ffffff'), S(0.25, GODS.hecate), S(0.7, '#2f7f9c'), S(1, INK.violet)],
      alpha: [[0, 0], [0.15, 0.85], [0.6, 0.5], [1, 0]],
      size: [[0, 0.5], [0.3, 1.0], [1, 1.35]],
      size0: 0.7, size1: 1.0, life: [0.6, 0.95], speed: [0.2, 0.9],
      emit: 'disc', spread: 0.6, gravity: -0.5, drag: 2.0, core: 1.1, rotVel: [-0.5, 0.5],
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
    P.emit('sparkFine', Math.round(7 + 8 * s), { x, y, z, dx: ux, dy: 0.55, dz: uz, spread: 1.35, speed: 0.9, color: C.core });
    P.emit('chev', 3, { x, y, z, dx: ux, dy: 0.18, dz: uz, spread: 0.30, speed: 1.0, color: C.body });
    P.emit('mote', 1, { x, y, z, size: 0.85 * s, color: C.glow });
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
    const arc = o.arc ?? 106;
    const R = o.radius ?? 2.05;
    const spin = o.spin ?? (this.rng.bool() ? 1 : -1);
    this.slashes.spawn(origin, dir, {
      arc, radius: R, width: o.width ?? 0.30, color, glow,
      core: o.core || '#fffdf0', life: o.life ?? 0.30, y: origin.y ?? 1.05,
      bank: o.bank ?? 1.24, rise: o.rise ?? R * 0.34, spin, opacity: o.opacity ?? 1,
    });

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
      this.particles.emit('mote', 2, { x: pos.x, y: pos.y ?? 0.9, z: pos.z, size: 1.2, color: o.color || this.biome.rim });
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

    // 1 — the flash
    P.emit('flash', 1, { x, y: y + 0.2, z, size: 0.62 * s, color: '#ffffff' });
    P.emit('star', 2, { x, y: y + 0.2, z, size: 0.75 * s, color: body });
    this.rings.spawn(x, 0.04, z, { radius: 0.95 * s, life: 0.30, color: body, core: '#ffffff', thick: 0.5, ease: 2.2, opacity: 0.85 });

    // 2 — the directional burst of shade-wisps
    const d = o.dir || null;
    P.emit('wisp', Math.round(13 * s), {
      x, y, z, dx: d ? d.x : 0, dy: 1.0, dz: d ? d.z : 0, spread: d ? 0.75 : 1.15, speed: 0.85, color: body,
    });
    P.emit('smoke', Math.round(6 * s), { x, y, z, dy: 1, spread: 0.9, speed: 0.5, size: 1.1 * s });
    P.emit('spark', Math.round(10 * s), { x, y, z, dy: 0.9, spread: 1.25, speed: 0.9, color: body });
    this.decals.spawn(x, 0, z, { kind: 'ichor', size: 1.5 * s, rot: this.rng.range(0, 6.283), opacity: 0.6 });

    // 3 — dissolve upward: a soul column plus three staggered ember releases
    this._at(0.05, () => {
      _v.set(x, y - 0.45, z); _v2.set(x, y + 1.75 * s, z);
      this.beams.spawn(_v, _v2, { color: body, core: '#eafcff', width: 0.24 * s, life: 0.55, opacity: 0.34 });
    });
    for (let k = 0; k < 3; k++) {
      this._at(0.08 + k * 0.12, () => {
        P.emit('ember', Math.round(7 * s), { x, y: y - 0.3 + k * 0.45, z, dy: 1, spread: 0.42, speed: 0.55, color: body });
        P.emit('rune', 1, { x, y: y + 0.35 + k * 0.5, z, size: 0.7 * s, color: body });
      });
    }
    return this;
  }

  /** beam(a, b, {color, width, life}) — core + glow + scrolling energy + caps */
  beam(a, b, o = {}) {
    if (!this.enabled || !a || !b) return;
    const color = o.color || GODS.hecate;
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
    this.rings.spawn(pos.x, (pos.y ?? 0) + 0.04, pos.z, {
      radius: R, life, color, core: '#fff6e0', thick: 0.40, ease: 2.7, opacity: o.opacity ?? 0.85,
    });
    if (R > 2.4) this.rings.spawn(pos.x, (pos.y ?? 0) + 0.05, pos.z, {
      radius: R * 0.55, life: life * 0.72, color: o.core || '#fff2cf', thick: 0.22, ease: 3.1, opacity: 0.35,
      phase: o.phase ?? 0,
    });
    this.particles.emit('dust', 16, { x: pos.x, y: 0.10, z: pos.z, spread: R * 0.22, speed: 0.9, size: 1.1 });
    this.particles.emit('sparkFine', 12, { x: pos.x, y: 0.16, z: pos.z, dy: 0.28, spread: 1.45, speed: 1.1, color });
    this.particles.emit('mote', 1, { x: pos.x, y: 0.35, z: pos.z, size: 1.1, color });
    return this;
  }

  // ══════════════════════════════════════════════════════════ internals ═══
  /** Schedule `fn` `dt` seconds from now, on sim time. */
  _at(dt, fn) { this._pending.push({ t: this.ctx.time.t + dt, fn }); }

  clear() {
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

    // graceful degradation: if the pool is saturated, thin new emissions
    const load = this.particles.count / this.particles.cap;
    this._budget = load > 0.9 ? 0.45 : load > 0.72 ? 0.72 : 1;
  }

  lateUpdate(alpha, ctx) {
    if (!this.enabled) return;
    this.particles.flush();
    this.decals.flush();
  }

  resize() { }

  dispose() {
    this.particles.dispose(); this.rings.dispose(); this.slashes.dispose();
    this.beams.dispose(); this.trails.dispose(); this.decals.dispose();
    this.screen.dispose();
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
  }

  // ═══════════════════════════════════════════════════ capture scenarios ══
  _captureState(name, ctx) {
    if (name === 'vfxburst') { this.clear(); this.rng.reseed('vfx:burst'); this._setupBurst(ctx); }
    else if (name === 'death') { this.clear(); this.rng.reseed('vfx:death'); this._setupDeath(ctx); }
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
