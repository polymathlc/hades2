// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// enemies/index.js — the roster registry and the EnemyManager.
//
// THE ROSTER (each one a distinct BLACK SHAPE — that is the acceptance test):
//   shade   thin vertical needle, one hooked blade        basic melee
//   brute   a WALL — rectangular tower shield             shielded, flank it
//   hexer   tall triangle robe + a ring on a staff        ranged ground AOE
//   hound   low horizontal quadruped, spined back         fast swarmer, x3
//   bloat   a circle on strings, hovering                 detonator
//   herald  crescent horns + orbiting shards              summoner, kill first
//   lancer  a long horizontal spear line                  lane charger, sidestep
//   siren   wide feathered wings                          blink flank assassin
//   oracle  halo above a tall robed figure                healer/ward, interrupt
//   riftstalker crescent mask + spectral blade            teleports onto ranged heroes
//   warden  a monolith with a horned crown + greatsword   BOSS, three phases
//   minotaur bull horns + a double-headed labrys           BOSS 2, wall charger
//   heracles lion pelt + a huge knotted club               BOSS 3, champion
//   hades   crown + bident                                 ZAGREUS FINALE
//   chronos clock halo + time scythe                       MELINOE FINALE
//
// The manager owns: pooling (an enemy is built once and reused forever), the
// attack-token pool, the telegraph renderer, the hard separation relax that
// guarantees no two bodies occupy one pixel, and the capture states this agent
// is responsible for (§5: combat, death, boss).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, TAU } from '../../core/math.js';
import { TokenPool } from '../ai.js';
import { Enemy, refreshFamilyRims } from './base.js';
import { Telegraphs } from './telegraph.js';
import { SHADE, BRUTE, brutePreDamage } from './melee.js';
import { HEXER, HERALD } from './casters.js';
import { HOUND, BLOAT } from './swarm.js';
import { LANCER, SIREN, ORACLE, RIFT_STALKER } from './variants.js';
import { WARDEN } from './boss.js';
import { MINOTAUR, HERACLES, HADES, CHRONOS } from './champions.js';
import { Spawner, bossForDepth } from '../spawner.js';

export const ROSTER = {
  shade: SHADE, brute: BRUTE, hexer: HEXER, herald: HERALD,
  hound: HOUND, bloat: BLOAT, lancer: LANCER, siren: SIREN,
  oracle: ORACLE, riftstalker: RIFT_STALKER, warden: WARDEN,
  minotaur: MINOTAUR, heracles: HERACLES, hades: HADES, chronos: CHRONOS,
};
export const ROSTER_IDS = Object.keys(ROSTER);

const _v = new THREE.Vector3();

export class EnemyManager {
  constructor() {
    this.list = [];           // LIVE enemies — the array player.js reads
    this.all = [];            // every instance ever built (pool)
    this.pools = new Map();   // kind -> [Enemy]
    this.out = { x: 0, z: 0 };
    this.enabled = true;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork ? ctx.rng.fork('enemies') : ctx.rng;

    // ── THE ATTACK-TOKEN TUNING ─────────────────────────────────────────
    // Two melee slots is the number. One reads as a queue (the room feels
    // passive and the other five are scenery); three is a wall you cannot
    // read, because two overlapping wind-ups on a 3/4 camera are one blob.
    // Two alternates: while one commits, the other is already closing, so
    // pressure is continuous but only ever one tell is at its peak.
    this.tokens = new TokenPool({
      melee: { slots: 2, hold: 2.4, cooldown: 1.05, grace: 0.18 },
      heavy: { slots: 1, hold: 3.2, cooldown: 1.8, grace: 0.25 },
      ranged: { slots: 1, hold: 3.0, cooldown: 2.2, grace: 0.3 },
      boss: { slots: 1, hold: 6.0, cooldown: 0.2, grace: 0.1 },
      free: { slots: 99, hold: 99, cooldown: 0 },
    });

    this.telegraphs = new Telegraphs(16).init(ctx);

    // one shared hurt-flash material: assigning it to mesh.material is
    // per-INSTANCE, so a family can share its real materials and still flash
    // individually. No material cloning, no shader recompiles.
    this.flashMat = new THREE.MeshBasicMaterial({ color: 0xfff0dc, toneMapped: false, fog: false });

    this.spawner = new Spawner();
    this.spawner.init(ctx, this);
    ctx.spawner = this.spawner;

    ctx.events.on('damage.dealt', (info) => this._onDamage(info));
    ctx.events.on('entity.died', (info) => this._onDied(info));
    ctx.events.on('capture.state', ({ name, args }) => this._captureState(name, args, ctx));
    ctx.events.on('room.built', () => { if (!ctx.CAPTURE) this.clear(); });
    // MaterialLibrary.setBiome() republishes the palette rim over every
    // painterly material without consulting userData.paintOverrides, so the
    // per-family rims are trampled on the first chamber change. Re-stamp.
    ctx.events.on('biome.changed', ({ name } = {}) => refreshFamilyRims(name || ctx.run?.biome));
    return this;
  }

  // ───────────────────────────────────────────────────────────── roster ──
  def(kind) { return ROSTER[kind] || SHADE; }

  /** Take an instance of `kind` from the pool, building one only if needed. */
  acquire(kind) {
    let pool = this.pools.get(kind);
    if (!pool) { pool = []; this.pools.set(kind, pool); }
    for (let i = 0; i < pool.length; i++) if (pool[i].dead && !pool[i].root.visible) return pool[i];
    const e = new Enemy(this.def(kind));
    e.init(this.ctx, this);
    e.dead = true; e.alive = false;
    pool.push(e); this.all.push(e);
    return e;
  }

  /**
   * spawn(kind, pos, opts) — the §2 contract entry point.
   * NEVER spawns on top of the player: the position is pushed to a legal,
   * collision-free point at least `minPlayerDist` from the hero, and the
   * entity materialises with a brief invulnerability (see Enemy.spawn).
   */
  spawn(kind, pos, opts = {}) {
    if (!ROSTER[kind]) return null;
    const ctx = this.ctx;
    const p = this.safePoint(pos ? (pos.x ?? pos[0] ?? 0) : 0, pos ? (pos.z ?? pos[2] ?? 0) : 0, opts);
    const e = this.acquire(kind);
    e.spawn(p.x, p.z, opts.depth ?? (ctx.run ? ctx.run.depth : 0), opts);
    if (ctx.player) e.snapFace(ctx.player.position.x - p.x, ctx.player.position.z - p.z);
    e.poiseMax = e.def.poiseMax ?? (e.def.poise >= 999 ? 120 : 24);
    e.poise = e.poiseMax;
    e.knockLambda = 11;              // we integrate our own knockback
    e.mass = e.def.mass ?? (1 + e.radius);
    if (e.def.kind === 'brute') this._armShield(e);
    ctx.combat?.register?.(e);
    if (this.list.indexOf(e) < 0) this.list.push(e);
    this._spawnFX(e, opts);
    ctx.events.emit('enemy.spawned', { entity: e, kind, pos: e.position.clone() });
    return e;
  }

  /** the brute's frontal shield, wired into the combat system's block hook */
  _armShield(e) {
    e.blocking = {
      absorb: (info) => {
        const mul = brutePreDamage(e, info);
        if (mul < 1) {
          e.def.onDamaged?.(e, info, this.ctx);
          e.stagger = 0;
        }
        return (info.amount || 0) * mul;
      },
    };
  }

  _spawnFX(e, opts) {
    const ctx = this.ctx;
    const c = e.def.identity || '#8ef0d0';
    ctx.vfx?.shockwave?.(_v.set(e.position.x, 0.04, e.position.z), { radius: 1.5 + e.radius, color: c, life: 0.42, opacity: 0.7 });
    ctx.vfx?.burst?.(_v.set(e.position.x, 0.35, e.position.z), { count: 14, color: c, speed: 5.5, spread: 1.25, kind: 'wisp' });
    ctx.vfx?.beam?.(
      new THREE.Vector3(e.position.x, 0.0, e.position.z),
      new THREE.Vector3(e.position.x, (e.height || 2) * 1.1, e.position.z),
      { color: c, width: 0.22 + e.radius * 0.2, life: 0.42, opacity: 0.5 });
    ctx.audio?.sfx?.('enemySpawn', { pos: e.position });
  }

  /**
   * A legal spawn point: inside the arena, out of solids, and away from the
   * player. Deterministic — it walks a golden-angle spiral, it never samples.
   */
  safePoint(x, z, opts = {}) {
    const ctx = this.ctx;
    const minD = opts.minPlayerDist ?? 5.2;
    const p = ctx.player ? ctx.player.position : null;
    const v = _v.set(x, 0, z);
    for (let i = 0; i < 24; i++) {
      v.set(x, 0, z);
      if (i > 0) {
        const a = i * 2.399963;            // golden angle — even, deterministic
        const r = 1.1 * Math.sqrt(i) * 1.35;
        v.x = x + Math.cos(a) * r; v.z = z + Math.sin(a) * r;
      }
      ctx.world?.clampToArena?.(v, 1.2);
      ctx.world?.collide?.(v, opts.radius ?? 0.7);
      if (!p) break;
      const d = Math.hypot(v.x - p.position?.x ?? p.x, 0);
      const dx = v.x - p.x, dz = v.z - p.z;
      if (dx * dx + dz * dz >= minD * minD) break;
    }
    return { x: v.x, z: v.z };
  }

  /** the herald / boss reinforcement call */
  summonFor(a, kind, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const ang = a.mem._sa = (a.mem._sa || this.rng.f() * TAU) + TAU / Math.max(1, count) + 0.11;
      const r = 2.2 + 0.5 * i;
      const e = this.spawn(kind, { x: a.position.x + Math.cos(ang) * r, z: a.position.z + Math.sin(ang) * r },
        { minPlayerDist: 4.5, wave: 99 });
      if (e) out.push(e);
    }
    return out;
  }
  /** the herald only summons when the room is not already saturated */
  canSummon(a) { return this.aliveCount < (a.def.summonCap ?? 7); }

  dustAt(ctx, pos, color) {
    if ((this._dustT = (this._dustT || 0) + 1) % 7) return;
    ctx.vfx?.burst?.(_v.set(pos.x, 0.12, pos.z), { count: 4, color, speed: 3, spread: 1.4, kind: 'dust', glow: false });
  }

  // ───────────────────────────────────────────────────────────── damage ──
  _onDamage(info) {
    const t = info.target;
    if (!t || t.faction !== 'enemy' || !t.onDamaged) return;
    if (info.staggered === false && (t.def.poise ?? 0) >= 999) return;
    t.onDamaged(info);
  }
  _onDied(info) {
    const e = info.entity;
    if (!e || e.faction !== 'enemy' || !e.onDied) return;
    if (e._deathT >= 0) return;
    e.onDied(info);
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    this.ctx.combat?.unregister?.(e);
    this.spawner.onEnemyDied(e);
  }

  // ─────────────────────────────────────────────────────────────── frame ──
  update(dt, ctx) {
    if (!this.enabled) return;
    this.tokens.update(dt);
    // token pressure scales with depth: deeper rooms let a third shade commit
    const depth = ctx.run ? (ctx.run.depth || 0) : 0;
    this.tokens.setSlots('melee', depth >= 8 ? 3 : 2);

    for (let i = 0; i < this.all.length; i++) {
      const e = this.all[i];
      if (e.root.visible) e.update(dt, ctx);
    }
    this._relax(dt);
    this.telegraphs.update(dt, ctx);
    this.spawner.update(dt, ctx);
    if (this._capMode === 'combat') this._holdCaptureTell(ctx);
  }

  /**
   * The capture harness steps 2 seconds of live simulation after `state()`
   * returns, so a tell posed inside setupCaptureCombat() has long since fired
   * by the time the shutter opens. This re-arms it every step, which keeps the
   * §5 requirement ("one mid-telegraph") true of the frame that is actually
   * written to disk rather than of an intermediate one nobody sees.
   */
  _holdCaptureTell(ctx) {
    const s = this._capStar;
    if (!s || s.dead) return;
    if (!s.tell.active) {
      s.attackCd = 0; s.stagger = 0; s.iframes = 0.4;
      this.tokens.reset();
      s.wantToken(s.def.tokenPool, 99);
      s.brain.set('windup', ctx);
    } else if (s.tell.k > 0.80) { s.tell.t = s.tell.dur * 0.62; s.tell.k = 0.62;
      if (s._tellHandle) { s._tellHandle.t = s._tellHandle.dur * 0.62; s._tellHandle.u.uK.value = 0.62; } }
    const h = this._capSecond;
    if (h && !h.dead && !h.tell.active) { h.attackCd = 0; h.iframes = 0.4; h.brain.set('cast', ctx); }
  }

  /**
   * HARD SEPARATION. Steering keeps enemies apart while they are free to move;
   * this guarantees it while they are not (mid-telegraph, mid-recovery, walled
   * into a corner). Two overlapping bodies are two unreadable bodies, and the
   * telegraph system's whole value evaporates if you cannot see whose it is.
   */
  _relax(dt) {
    const L = this.list;
    const n = L.length;
    if (n < 2) return;
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < n; i++) {
        const a = L[i]; if (a.dead) continue;
        for (let j = i + 1; j < n; j++) {
          const b = L[j]; if (b.dead) continue;
          const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
          const want = (a.radius + b.radius) * 1.06 + (a.crowdPad + b.crowdPad) * 0.5;
          const d2 = dx * dx + dz * dz;
          if (d2 >= want * want || d2 < 1e-8) continue;
          const d = Math.sqrt(d2);
          const push = (want - d) * 0.5;
          const ux = dx / d, uz = dz / d;
          // heavier bodies move less — the brute parts the crowd
          const wa = 1 / (1 + (a.def.knockResist || 0) * 4);
          const wb = 1 / (1 + (b.def.knockResist || 0) * 4);
          const s = wa + wb || 1;
          a.position.x -= ux * push * (wa / s) * 2; a.position.z -= uz * push * (wa / s) * 2;
          b.position.x += ux * push * (wb / s) * 2; b.position.z += uz * push * (wb / s) * 2;
        }
      }
    }
  }

  lateUpdate(alpha, ctx) {
    for (let i = 0; i < this.all.length; i++) if (this.all[i].root.visible) this.all[i].lateUpdate(alpha, ctx);
  }

  get aliveCount() { return this.list.length; }
  get boss() { for (const e of this.list) if (e.def.boss) return e; return null; }

  clear() {
    this._capMode = null; this._capStar = null; this._capSecond = null;
    for (const e of this.all) if (e.root.visible) { e.despawn(); this.ctx.combat?.unregister?.(e); }
    this.list.length = 0;
    this.tokens.reset();
    this.telegraphs.clear();
  }

  // ════════════════════════════════════════════════ CAPTURE STATES (§5) ═══
  _captureState(name, args, ctx) {
    if (name === 'combat') return this.setupCaptureCombat(ctx, args);
    if (name === 'doom') {
      const list = this.setupCaptureCombat(ctx, { depth: 3, plan: ['brute'] });
      const target = list && list[0];
      if (target) ctx.combat?.applyStatus?.(target, 'doom', 2, ctx.player, 72);
      return target;
    }
    if (name === 'death') return this.setupCaptureDeath(ctx, args);
    if (name === 'boss') return this.setupCaptureBoss(ctx, args);
  }

  /**
   * §5 combat: 4–6 enemies alive and ENGAGED, one mid-telegraph. Deterministic
   * placement in a ring around the hero, then the sim is stepped so the AI is
   * genuinely in its states rather than posed.
   */
  setupCaptureCombat(ctx, args) {
    this.clear();
    const p = ctx.player ? ctx.player.position : new THREE.Vector3();
    const depth = (args && args.depth) ?? 3;
    const plan = (args && args.plan) || ['brute', 'hexer', 'hound', 'lancer', 'riftstalker', 'oracle'];
    // ring tuned to the 'combat' capture pose (distance 12.6, fov 36): any
    // wider and half the roster falls outside the frame the critic reads.
    const R = 5.4;
    for (let i = 0; i < plan.length; i++) {
      const a = -0.55 + (i / plan.length) * TAU * 0.86;
      const r = R + ((i % 3) - 1) * 0.95;
      // hpMul: the harness steps 2s of real simulation AFTER this setup runs,
      // during which the player's frozen attack pose keeps connecting. Without
      // it half the roster is dead before the shutter opens and the 'combat'
      // frame shows an empty room, which is exactly the failure the shot list
      // already called out once.
      const e = this.spawn(plan[i], { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r }, { depth, minPlayerDist: 4.2, wave: 1, hpMul: 30 });
      if (e) { e.spawnGrace = 0; e.root.scale.setScalar(1); e.perc.aware = true; e.perc._init = true; e.perc.aimX = p.x; e.perc.aimZ = p.z; }
    }
    // settle the fight, then guarantee exactly one enemy is at the peak of its
    // tell — the frame has to answer "who is about to attack" instantly.
    for (let i = 0; i < 96; i++) this.update(1 / 60, ctx);
    this._capMode = 'combat';
    let star = this.list.find(e => e.kind === 'brute') || this.list[0];
    this._capStar = star;
    this._capSecond = this.list.find(e => e.kind === 'hexer');
    if (star) {
      this.tokens.reset();
      star.attackCd = 0;
      star.stagger = 0;
      star.brain.set('windup', ctx);
      if (!star.tell.active) {
        star.telegraph('heavy', 0.72, { shape: 'arc', radius: 3.4, arc: 118, follow: true, color: star.tellColor });
      }
      star.tell.t = star.tell.dur * 0.72;
      star.tell.k = 0.72;
      if (star._tellHandle) { star._tellHandle.t = star._tellHandle.dur * 0.72; star._tellHandle.u.uK.value = 0.72; }
    }
    // a second tell at low progress on the caster so the frame shows the RANGE
    const hex = this.list.find(e => e.kind === 'hexer');
    if (hex && !hex.tell.active) {
      hex.brain.set('cast', ctx);
      hex.tell.t = hex.tell.dur * 0.30; hex.tell.k = 0.30;
      if (hex._tellHandle) { hex._tellHandle.t = hex._tellHandle.dur * 0.30; hex._tellHandle.u.uK.value = 0.30; }
    }
    return this.list;
  }

  /** §5 death: an enemy at the most spectacular frame of its dissolve. */
  setupCaptureDeath(ctx, args) {
    this.clear();
    const p = ctx.player ? ctx.player.position : new THREE.Vector3();
    const plan = ['shade', 'shade', 'hound'];
    for (let i = 0; i < plan.length; i++) {
      const a = 0.4 + i * 1.5;
      const e = this.spawn(plan[i], { x: p.x + Math.cos(a) * 3.6, z: p.z + Math.sin(a) * 3.6 }, { depth: 3, minPlayerDist: 3.0 });
      if (e) { e.spawnGrace = 0; e.root.scale.setScalar(1); e.perc.aware = true; }
    }
    for (let i = 0; i < 30; i++) this.update(1 / 60, ctx);
    const victim = this.list[0];
    if (victim) {
      const dir = new THREE.Vector3(victim.position.x - p.x, 0, victim.position.z - p.z).normalize();
      ctx.combat?.applyDamage?.({
        target: victim, amount: victim.health + 500, type: 'physical', crit: true,
        dir, pos: victim.position.clone(), source: ctx.player, knockback: 6,
      });
      // step to the peak of the dissolve: flash gone, wisps out, body rising
      for (let i = 0; i < 16; i++) this.update(1 / 60, ctx);
    }
    return this.list;
  }

  /** §5 boss: any run boss on screen, mid-telegraph. */
  setupCaptureBoss(ctx, args) {
    this.clear();
    const p = ctx.player ? ctx.player.position : new THREE.Vector3();
    const depth = args?.depth ?? 5;
    const kind = ROSTER[args?.kind] ? args.kind : bossForDepth(depth, args?.character || ctx.run?.selectedCharacter || 'zagreus');
    // Negative arena diagonal is the far/upper side of the live isometric
    // camera, keeping a three-metre boss above the hero instead of cropped by
    // the HUD along the lower edge.
    const b = this.spawn(kind, { x: p.x - 4.2, z: p.z - 3.8 }, { depth, minPlayerDist: 5.0 });
    if (b) {
      b.spawnGrace = 0; b.root.scale.setScalar(1);
      b.perc.aware = true; b.perc._init = true; b.perc.aimX = p.x; b.perc.aimZ = p.z;
      b.health = b.maxHealth * 0.5;              // phase 2, so the adds exist
      b.mem.phase = 1; b.mem.pendingPhase = false;
      for (let i = 0; i < 40; i++) this.update(1 / 60, ctx);
      b.attackCd = 0;
      b.brain.set(b.def.captureState || 'cleave', ctx);
      b.tell.t = b.tell.dur * 0.68; b.tell.k = 0.68;
      if (b._tellHandle) { b._tellHandle.t = b._tellHandle.dur * 0.68; b._tellHandle.u.uK.value = 0.68; }
      if (kind === 'warden') {
        this.summonFor(b, 'hound', 2);
        for (const e of this.list) if (e !== b) { e.spawnGrace = 0; e.root.scale.setScalar(1); e.perc.aware = true; }
      }
    }
    return b;
  }

  dispose() { this.telegraphs.dispose(); }
}

export default EnemyManager;
