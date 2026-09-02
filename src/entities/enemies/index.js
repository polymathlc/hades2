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
import { setCharacterBiome } from '../../render/shaders/character.js';
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
    // ...and it is now a MARKER: the visuals swap to the character shader's
    // flash twins (render/shaders/character.js) when handed this material,
    // so the flash is a rim-coloured outline over a brightened body instead
    // of a white cut-out. preload.js still warms this material directly.
    this.flashMat.userData.rimFlash = true;

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
    ctx.events.on('biome.changed', ({ name } = {}) => {
      setCharacterBiome(name || ctx.run?.biome);
      refreshFamilyRims(name || ctx.run?.biome);
    });
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
    if (ctx.run?.modifiers?.has?.('hardened') && !e.def.boss) { e.maxHealth = Math.round(e.maxHealth * 1.25); e.health = e.maxHealth; }
    if (opts.elite && !e.def.boss) this._makeElite(e, opts.elite, opts.depth ?? 0);
    ctx.combat?.register?.(e);
    if (this.list.indexOf(e) < 0) this.list.push(e);
    if (!opts.silent) this._spawnFX(e, opts);
    ctx.events.emit('enemy.spawned', { entity: e, kind, pos: e.position.clone(), elite: e.elite });
    return e;
  }

  /**
   * ELITES. One per elite wave from depth 3: bigger, tougher, and carrying
   * exactly one affix the player has to answer differently —
   *   armoured  flat damage reduction: small hits bounce, commit to the heavy
   *   swift     faster body and quicker tells: dash sooner, not later
   *   volatile  a bomb when it dies: kill it away from the pack, or kite it
   *   warded    regenerates poise fast and cannot be stun-locked
   */
  _makeElite(e, affix, depth) {
    e.elite = affix;
    e.maxHealth = Math.round(e.maxHealth * 1.7);
    e.health = e.maxHealth;
    e.damageMul = (e.damageMul || 1) * 1.2;
    e.visualScale = 1.14;
    e.root.scale.setScalar(0.001);
    e.mass = (e.mass || 1) * 1.35;
    if (affix === 'armoured') e.armour = 4 + depth * 0.8;
    else if (affix === 'swift') { e.speedMul = 1.22; e.tellMul = 0.9; }
    else if (affix === 'warded') { e.poiseMax = Math.round((e.poiseMax || 24) * 2.2); e.poise = e.poiseMax; }
    const c = e.def.identity || '#ffe14d';
    this.ctx.vfx?.shockwave?.(_v.set(e.position.x, 0.05, e.position.z), { radius: 3.2, color: c, life: 0.6 });
    this.ctx.ui?.toast?.(`ELITE · ${affix.toUpperCase()} ${(e.def.label || e.kind).toUpperCase()}`, { color: c, dur: 2.2 });
    this.ctx.events.emit('enemy.elite', { entity: e, affix, pos: e.position });
  }

  /**
   * The brute's frontal shield, wired into the combat system's block hook.
   * THE GUARD PHASE: every blocked hit chips a hidden guard meter. When it
   * empties, the shield drops — the brute is staggered, takes full damage
   * from any angle for a few seconds, and its tell ring says so. Then the
   * guard comes back. Flanking is still the fast answer; hammering the front
   * is now a slow answer instead of no answer.
   */
  _armShield(e) {
    e.blocking = {
      absorb: (info) => {
        const mul = brutePreDamage(e, info);
        if (mul < 1) {
          e.def.onDamaged?.(e, info, this.ctx);
          e.stagger = 0;
          e.mem.guard = (e.mem.guard ?? e.mem.guardMax ?? 80) - (info.amount || 0);
          if (e.mem.guard <= 0) this._guardBreak(e);
        }
        return (info.amount || 0) * mul;
      },
    };
  }

  _guardBreak(e) {
    const ctx = this.ctx;
    const dur = e.def.guardBreakTime ?? 3.4;
    e.shielded = false;
    e.mem.guard = 0;
    e.mem.guardBroken = dur;
    e.stagger = Math.max(e.stagger || 0, 0.9);
    e.committed = false;
    if (e.tell.active) e.endTell(false);
    this.tokens.releaseAll(e);
    this.telegraphs.spawn({ x: e.position.x, z: e.position.z, radius: 2.3, shape: 'ring', inner: 0.7,
      dur, color: '#ffe9a8', core: '#ffffff', owner: e, follow: true, alpha: 0.75 });
    ctx.vfx?.impact?.(_v.set(e.position.x + e.facing.x * 0.8, 1.3, e.position.z + e.facing.z * 0.8), new THREE.Vector3(-e.facing.x, 0, -e.facing.z), { type: 'physical', scale: 1.6, color: '#ffe9a8' });
    ctx.vfx?.burst?.(_v.set(e.position.x, 1.2, e.position.z), { count: 26, color: '#ffe9a8', speed: 10, spread: 1.3, kind: 'shard' });
    ctx.vfx?.shockwave?.(_v.set(e.position.x, 0.05, e.position.z), { radius: 2.6, color: '#ffe9a8', life: 0.4 });
    ctx.events.emit('hit.stop', { ms: 70 });
    ctx.events.emit('camera.shake', { amp: 0.16, dur: 0.3, freq: 26 });
    ctx.events.emit('enemy.guardBreak', { entity: e, pos: e.position, dur });
    ctx.ui?.toast?.('GUARD BROKEN', { color: '#ffe9a8', dur: 1.4 });
    ctx.audio?.sfx?.('stagger', { pos: e.position, gain: 1 });
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
    // THE DEAD-TIME GUARD: a requested point farther than maxPlayerDist from
    // the hero is pulled in along the hero's line before anything else. A
    // body that arrives 25 m out spends the wave walking, or never notices
    // the hero at all.
    if (p && opts.maxPlayerDist > 0) {
      const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
      if (d > opts.maxPlayerDist) { const k = opts.maxPlayerDist / d; x = p.x + dx * k; z = p.z + dz * k; }
    }
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
    // token pressure scales with depth: deeper rooms let a third shade commit,
    // and the FRENZY pact adds one more on top
    const depth = ctx.run ? (ctx.run.depth || 0) : 0;
    const mods = ctx.run?.modifiers;
    this.tokens.setSlots('melee', (depth >= 8 ? 3 : 2) + (mods?.has?.('frenzy') ? 1 : 0));
    this.tellMul = mods?.has?.('swift') ? 0.85 : 1;

    for (let i = 0; i < this.all.length; i++) {
      const e = this.all[i];
      if (e.root.visible) e.update(dt, ctx);
    }
    this._relax(dt);
    this.telegraphs.update(dt, ctx);
    this.spawner.update(dt, ctx);
    if (this._cap) this._holdCaptureTell(ctx);
  }

  /**
   * The capture harness steps 2 seconds of live simulation after `state()`
   * returns, so anything posed inside setupCaptureCombat() has long since
   * fired by the time the shutter opens. This re-arms the frame every step:
   * the brute stays mid shield-charge tell, the hexer keeps its bolt lane
   * drawn, and every other body is held on its authored surround slot so
   * nobody walks onto the hero (the round-1 frame had the brute standing ON
   * the player). The §5 requirement is of the frame that is written to disk.
   */
  _holdCaptureTell(ctx) {
    const cap = this._cap;
    if (!cap) return;
    const P = ctx.player;
    cap.t = (cap.t || 0) + 1 / 60;
    for (let i = 0; i < cap.slots.length; i++) {
      const sl = cap.slots[i], e = sl.e;
      if (!e || e.dead) continue;
      e.position.set(sl.x, 0, sl.z);
      e.velocity.set(0, 0, 0); e._knock.set(0, 0, 0);
      e.snapFace(P.position.x - sl.x, P.position.z - sl.z);
      e.attackCd = 9; e.iframes = 0.4; e.stagger = 0; e.spawnGrace = 0;
      e.root.scale.setScalar(e.visualScale || 1);
      if (sl.state === 'shieldCharge') {
        if (!e.tell.active || e.stateName !== 'shieldCharge') { this.tokens.reset(); e.wantToken('heavy', 99); e.brain.set('shieldCharge', ctx); }
        this._pinTell(e, 0.58, 0.72);
      } else if (sl.state === 'bolt') {
        if (!e.tell.active || e.stateName !== 'bolt') { e.wantToken('ranged', 99); e.brain.set('bolt', ctx); }
        this._pinTell(e, 0.34, 0.48);
      } else if (e.committed || e.tell.active) {
        // nobody else winds up in this frame: two tells is one blob
        if (e.tell.active) e.endTell(false);
        e.committed = false;
      }
    }
    // the elite's affix ring: VFX.clear() ran on capture.state after the
    // spawn, so announce it again once the frame is live
    if (!cap.elited && cap.elite && !cap.elite.dead) { cap.elited = true; ctx.events.emit('enemy.elite', { entity: cap.elite, affix: cap.elite.elite, pos: cap.elite.position }); }
  }
  /** keep a tell's progress cycling inside [lo, hi] so the sweep reads mid-wind-up */
  _pinTell(e, lo, hi) {
    if (!e.tell.active) return;
    if (hi <= lo || e.tell.k > hi) { e.tell.t = e.tell.dur * lo; e.tell.k = lo; if (e._tellHandle) { e._tellHandle.t = e._tellHandle.dur * lo; e._tellHandle.u.uK.value = lo; } }
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
          a._relaxed = true; b._relaxed = true;
        }
      }
    }
    // a separation push is the one move that bypassed world.collide(): it could
    // leave a body inside a column plinth or past the rim until its next step
    const W = this.ctx.world;
    if (W && W.collide) for (let i = 0; i < n; i++) { const e = L[i]; if (e._relaxed) { e._relaxed = false; W.collide(e.position, e.radius + 0.28); } }
  }

  lateUpdate(alpha, ctx) {
    for (let i = 0; i < this.all.length; i++) if (this.all[i].root.visible) this.all[i].lateUpdate(alpha, ctx);
  }

  get aliveCount() { return this.list.length; }
  get boss() { for (const e of this.list) if (e.def.boss) return e; return null; }

  clear() {
    this._cap = null;
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
   * §5 combat: 4-6 enemies alive and ENGAGED, one mid-telegraph, none on top
   * of the hero. Authored in the CAMERA's basis (up = away from the lens,
   * right = across the frame, see vfx/index.js _setupBurst) so every body
   * lands where the 'combat' pose can see it:
   *   brute        right, mid shield-charge — the LANE tell, aimed at the hero
   *   hexer        up-screen at 6 m — its bolt lane crosses the frame
   *   riftstalker  the ELITE, affix ring under it
   *   hound/lancer/shade on their surround slots at 2.6-3.8 m
   * Bodies are then HELD on those slots every step (see _holdCaptureTell)
   * instead of being simulated into a pile: round 1 stepped 96 frames of live
   * AI here and the brute finished standing on the player.
   */
  setupCaptureCombat(ctx, args) {
    this.clear();
    const P = ctx.player;
    const p = P ? P.position : new THREE.Vector3();
    const depth = (args && args.depth) ?? 3;
    const ux = -0.7071, uz = -0.7071, rx = 0.7071, rz = -0.7071;
    const at = (up, right) => ({ x: p.x + ux * up + rx * right, z: p.z + uz * up + rz * right });
    const plan = (args && args.plan) || null;
    const slots = plan
      ? plan.map((kind, i) => ({ kind, ...at(2.2 + (i % 2) * 1.4, ((i - (plan.length - 1) / 2) * 2.2)) }))
      : [
        // the boot chamber's cover columns stand up-screen of the hero, so
        // nothing that has to be READ (the lanes, the affix ring) goes there
        { kind: 'brute', ...at(-0.3, 3.9), state: 'shieldCharge' },   // right, level: lane runs left across open floor
        { kind: 'hexer', ...at(3.2, 5.4), state: 'bolt' },            // up-right, clear of the columns
        { kind: 'riftstalker', ...at(-2.5, -2.1), elite: 'swift' },   // down-left: the affix ring on open floor
        { kind: 'hound', ...at(0.8, -3.6) },
        { kind: 'lancer', ...at(2.6, -3.3) },
        { kind: 'shade', ...at(-2.1, 2.3) },
      ];
    for (const sl of slots) {
      // hpMul: the harness steps 2 s of real simulation after this runs, and
      // the player's frozen swing keeps connecting; without it half the roster
      // is dead before the shutter opens
      const e = this.spawn(sl.kind, { x: sl.x, z: sl.z }, { depth, minPlayerDist: 2.3, wave: 1, hpMul: 30, elite: sl.elite || null, silent: true });
      if (!e) continue;
      sl.x = e.position.x; sl.z = e.position.z; sl.e = e;
      e.spawnGrace = 0; e.root.scale.setScalar(e.visualScale || 1);
      e.perc.aware = true; e.perc._init = true; e.perc.aimX = p.x; e.perc.aimZ = p.z;
      e.attackCd = 9;
      e.snapFace(p.x - e.position.x, p.z - e.position.z);
    }
    this._cap = { slots, t: 0, elite: slots.find(s => s.elite)?.e || null, elited: false };
    // a few steps so the bodies settle into their gait, then pin the tells
    for (let i = 0; i < 8; i++) this.update(1 / 60, ctx);
    for (const sl of slots) {
      const e = sl.e; if (!e || e.dead) continue;
      if (sl.state === 'shieldCharge') { this.tokens.reset(); e.wantToken('heavy', 99); e.brain.set('shieldCharge', ctx); this._pinTell(e, 0.58, 0); }
      else if (sl.state === 'bolt') { e.wantToken('ranged', 99); e.brain.set('bolt', ctx); this._pinTell(e, 0.34, 0); }
      else e.brain.set(e.def.brain.states.circle ? 'circle' : (e.def.brain.initial || 'idle'), ctx);
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
