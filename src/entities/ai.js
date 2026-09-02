// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// ai.js — the choreography layer.
//
// A Hades fight does not feel good because the enemies are clever. It feels
// good because at any instant the player can name exactly ONE threat, react to
// it, and be rewarded. Everything in this file exists to produce that:
//
//   1. ATTACK TOKENS  — a shared, arbitrated permission to commit. Only N
//      enemies may be inside a committed attack at once; everyone else is
//      forced into visible, non-threatening repositioning. This is the single
//      mechanism that turns "six things running at you" into a legible duel
//      with a chorus. Build it first, tune it last.
//   2. TELEGRAPH      — a wind-up state that broadcasts intent on the bus
//      BEFORE the strike, with a generous, data-authored duration. The tell is
//      the contract with the player; the damage is just bookkeeping.
//   3. PERCEPTION with a REACTION DELAY and a LAGGED aim point, so an enemy
//      never snaps to a frame-perfect read of the player. Enemies aim where you
//      WERE. Dodging works because their information is stale.
//   4. STEERING with real SEPARATION, so the roster never collapses into one
//      pixel. Enemies that pile up are unreadable and unfair — you cannot see
//      which of the four overlapping shades is the one winding up.
//
// AUTHORING API (this is the surface the roster uses):
//
//   const brain = new Brain(DEF, agent);        // DEF = { initial, states:{} }
//   brain.update(dt, ctx);
//
//   DEF.states.foo = {
//     enter(a, ctx) {},                          // optional
//     update(a, dt, ctx) { return 'bar'; },      // return a state name to switch
//     exit(a, ctx) {},                           // optional
//   }
//
//   a.perc      Perception      — .aware .dist .dirX .dirZ .aimX .aimZ .los
//   a.steer     Steer           — accumulate desired velocity, then .resolve()
//   a.tokens    TokenPool       — a.wantToken('melee') / a.dropToken()
//   a.telegraph(kind, dur, o)   — broadcast intent; a.tell.k in [0,1]
//
// EVERYTHING IS DETERMINISTIC: ctx.rng forks only, ctx.time only, and zero
// allocation inside update(). All the scratch lives at module scope.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, TAU } from '../core/math.js';

// ── module scratch (never allocate in a hot loop) ──────────────────────────
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _out = { x: 0, z: 0 };

/** small mutable 2-vector helper: keeps steering allocation-free */
export const V2 = (x = 0, z = 0) => ({ x, z });

// ═══════════════════════════════════════════════════════════════════════════
// ATTACK TOKENS
// ═══════════════════════════════════════════════════════════════════════════
//
// A pool of named permissions. An agent asks each frame; the pool grants to the
// best candidate and REVOKES on timeout so a stuck agent can never deadlock the
// fight. A grant carries a cooldown on release, so the same shade cannot lunge
// twice in a row while its friends circle — the pressure rotates around the
// player, which is what reads as choreography.
//
// TUNING (measured against Hades' Tartarus rooms):
//   melee slots       2   — three is a wall, one is a queue. Two alternates.
//   hold timeout    2.4s  — an agent that grabs and dithers is force-released.
//   reuse cooldown  1.05s — enforces rotation between attackers.
//   grant grace     0.18s — a fresh grant cannot be stolen; stops flicker.
export class TokenPool {
  constructor(slots = {}) {
    this.pools = new Map();
    for (const k in slots) this.define(k, slots[k]);
    this.t = 0;
  }
  define(name, o = {}) {
    const n = typeof o === 'number' ? o : (o.slots ?? 1);
    this.pools.set(name, {
      name, slots: n,
      hold: (o.hold ?? 2.4), cooldown: (o.cooldown ?? 1.05), grace: (o.grace ?? 0.18),
      holders: [],           // [{ agent, since, score }]
      cool: new Map(),       // agent -> time it may ask again
    });
    return this;
  }
  setSlots(name, n) { const p = this.pools.get(name); if (p) p.slots = n; return this; }
  slotsOf(name) { const p = this.pools.get(name); return p ? p.slots : 0; }

  /** true if `agent` currently holds a slot in `name`. */
  has(name, agent) {
    const p = this.pools.get(name); if (!p) return false;
    for (let i = 0; i < p.holders.length; i++) if (p.holders[i].agent === agent) return true;
    return false;
  }

  /**
   * request(name, agent, score) -> bool
   * `score` is "how much does this agent deserve to attack right now" — higher
   * wins. The roster passes -distance so the nearest threat commits, which is
   * also the one the player is looking at.
   */
  request(name, agent, score = 0) {
    const p = this.pools.get(name); if (!p) return false;
    for (let i = 0; i < p.holders.length; i++) {
      if (p.holders[i].agent === agent) { p.holders[i].score = score; return true; }
    }
    const cd = p.cool.get(agent);
    if (cd != null && this.t < cd) return false;
    if (p.holders.length < p.slots) { p.holders.push({ agent, since: this.t, score }); return true; }
    // steal from the weakest holder, but never from a fresh grant
    let worst = -1, worstScore = score;
    for (let i = 0; i < p.holders.length; i++) {
      const h = p.holders[i];
      if (this.t - h.since < p.grace) continue;
      if (h.agent.committed) continue;              // never yank a live attack
      if (h.score < worstScore) { worstScore = h.score; worst = i; }
    }
    if (worst < 0) return false;
    const victim = p.holders[worst];
    p.cool.set(victim.agent, this.t + p.cooldown * 0.5);
    victim.agent.onTokenLost && victim.agent.onTokenLost(name);
    p.holders[worst] = { agent, since: this.t, score };
    return true;
  }

  release(name, agent, cooldownMul = 1) {
    const p = this.pools.get(name); if (!p) return;
    for (let i = 0; i < p.holders.length; i++) {
      if (p.holders[i].agent === agent) {
        p.holders.splice(i, 1);
        p.cool.set(agent, this.t + p.cooldown * cooldownMul);
        return;
      }
    }
  }
  /** drop every slot an agent holds — call on death/despawn. */
  releaseAll(agent) { for (const p of this.pools.values()) this.release(p.name, agent); }

  update(dt) {
    this.t += dt;
    for (const p of this.pools.values()) {
      for (let i = p.holders.length - 1; i >= 0; i--) {
        const h = p.holders[i];
        const a = h.agent;
        if (!a || a.dead || a.alive === false) { p.holders.splice(i, 1); continue; }
        if (this.t - h.since > p.hold && !a.committed) {
          p.holders.splice(i, 1);
          p.cool.set(a, this.t + p.cooldown);
          a.onTokenLost && a.onTokenLost(p.name);
        }
      }
      if (p.cool.size > 64) { for (const [k, v] of p.cool) if (v < this.t) p.cool.delete(k); }
    }
  }
  reset() { for (const p of this.pools.values()) { p.holders.length = 0; p.cool.clear(); } }
  debug() {
    const o = {};
    for (const p of this.pools.values()) o[p.name] = `${p.holders.length}/${p.slots}`;
    return o;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PERCEPTION
// ═══════════════════════════════════════════════════════════════════════════
//
// Stale by design. Three separate lags, because they fail differently:
//   reaction  — how long after the player becomes visible before the agent
//               ACTS on it. Without this every enemy in the room turns on the
//               same frame and the room reads as one organism.
//   aimLag    — the agent's belief about WHERE the player is, damped. This is
//               what makes a dash actually dodge: the telegraph was aimed at a
//               position you have already left.
//   losEvery  — line-of-sight is a raycast; do it on a stagger, not per frame.
export class Perception {
  constructor(o = {}) {
    this.range = o.range ?? 26;
    this.reaction = o.reaction ?? 0.28;
    this.aimLambda = o.aimLambda ?? 6.5;     // lower = more stale = easier to dodge
    this.losEvery = o.losEvery ?? 0.17;
    this.needsLOS = o.needsLOS ?? false;
    this.aware = false;
    this.dist = 999; this.dirX = 0; this.dirZ = 1;
    this.aimX = 0; this.aimZ = 0;            // lagged belief
    this.los = true;
    this._react = 0; this._losT = 0; this._init = false;
  }
  reset() { this.aware = false; this._react = 0; this._init = false; this.los = true; }

  update(dt, self, target, ctx) {
    if (!target) { this.aware = false; return this; }
    const dx = target.position.x - self.position.x;
    const dz = target.position.z - self.position.z;
    const d = Math.hypot(dx, dz) || 1e-4;
    this.dist = d; this.dirX = dx / d; this.dirZ = dz / d;

    if (!this._init) { this.aimX = target.position.x; this.aimZ = target.position.z; this._init = true; }
    this.aimX = damp(this.aimX, target.position.x, this.aimLambda, dt);
    this.aimZ = damp(this.aimZ, target.position.z, this.aimLambda, dt);

    this._losT -= dt;
    if (this._losT <= 0) {
      this._losT = this.losEvery + (self.id % 7) * 0.011;   // deterministic stagger
      if (this.needsLOS && ctx.world && ctx.world.raycastWalk) {
        _a.set(self.position.x, 0.9, self.position.z);
        _b.set(target.position.x, 0.9, target.position.z);
        const r = ctx.world.raycastWalk(_a, _b, 0.25);
        this.los = !(r && r.hit);
      } else this.los = true;
    }
    const seen = d < this.range && this.los;
    if (seen) { if (!this.aware) { this._react += dt; if (this._react >= this.reaction) this.aware = true; } }
    else { this._react = 0; }
    return this;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STEERING
// ═══════════════════════════════════════════════════════════════════════════
//
// Accumulate weighted desires into one vector, then resolve() once. Every
// method writes into the agent's own scratch — no allocation, ever.
export class Steer {
  constructor(agent) {
    this.a = agent;
    this.x = 0; this.z = 0; this.w = 0;
    this.maxSpeed = 4;
  }
  begin(maxSpeed) { this.x = 0; this.z = 0; this.w = 0; this.maxSpeed = maxSpeed; return this; }
  add(x, z, w = 1) { this.x += x * w; this.z += z * w; this.w += w; return this; }

  /** straight at a point, full speed */
  seek(tx, tz, w = 1) {
    const a = this.a;
    const dx = tx - a.position.x, dz = tz - a.position.z;
    const d = Math.hypot(dx, dz) || 1e-4;
    return this.add(dx / d, dz / d, w);
  }
  flee(tx, tz, w = 1) {
    const a = this.a;
    const dx = a.position.x - tx, dz = a.position.z - tz;
    const d = Math.hypot(dx, dz) || 1e-4;
    return this.add(dx / d, dz / d, w);
  }
  /** decelerate into a point instead of overshooting and jittering on it */
  arrive(tx, tz, slow = 2.2, w = 1) {
    const a = this.a;
    const dx = tx - a.position.x, dz = tz - a.position.z;
    const d = Math.hypot(dx, dz) || 1e-4;
    const k = d < slow ? (d / slow) : 1;
    return this.add((dx / d) * k, (dz / d) * k, w);
  }
  /** hold a standoff RING around a point: radial correction + tangential drift */
  orbit(tx, tz, radius, dir = 1, w = 1, tangentMul = 1) {
    const a = this.a;
    const dx = a.position.x - tx, dz = a.position.z - tz;
    const d = Math.hypot(dx, dz) || 1e-4;
    const ux = dx / d, uz = dz / d;
    const err = clamp((d - radius) / Math.max(0.6, radius * 0.45), -1, 1);
    // tangent, sign flips the circling direction
    const tanX = -uz * dir, tanZ = ux * dir;
    return this.add(tanX * tangentMul - ux * err, tanZ * tangentMul - uz * err, w);
  }
  /**
   * SEPARATION — the non-negotiable one. Enemies that occupy the same pixel are
   * unreadable, so this is weighted hard and has a floor: even a fully
   * committed attacker still gets pushed apart.
   */
  separation(list, w = 1.6) {
    const a = this.a;
    let sx = 0, sz = 0, n = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === a || !o || o.dead || o.alive === false || !o.position) continue;
      const dx = a.position.x - o.position.x, dz = a.position.z - o.position.z;
      const want = (a.radius + (o.radius || 0.5)) * 1.55 + (o.crowdPad || 0);
      const d2 = dx * dx + dz * dz;
      if (d2 > want * want || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const k = (want - d) / want;
      sx += (dx / d) * k; sz += (dz / d) * k; n++;
    }
    if (!n) return this;
    return this.add(sx, sz, w);
  }
  /**
   * WALL AVOIDANCE via the real world query. One probe along the current
   * desire, one along the arena radial — the second is what keeps a circling
   * enemy from grinding along the parapet.
   */
  avoidWalls(ctx, probe = 1.9, w = 2.2) {
    const a = this.a;
    const w2 = ctx.world;
    if (!w2) return this;
    const len = Math.hypot(this.x, this.z);
    if (len < 1e-4) return this;
    const ux = this.x / len, uz = this.z / len;
    if (w2.raycastWalk) {
      _a.set(a.position.x, 0.6, a.position.z);
      _b.set(a.position.x + ux * probe, 0.6, a.position.z + uz * probe);
      const r = w2.raycastWalk(_a, _b, a.radius);
      if (r && r.hit) {
        const nx = r.normal ? (r.normal.x || 0) : -ux;
        const nz = r.normal ? (r.normal.z || 0) : -uz;
        // slide along the wall rather than stopping dead against it
        const dot = ux * nx + uz * nz;
        this.add(ux - nx * dot * 2, uz - nz * dot * 2, w * 0.6);
        this.add(nx, nz, w);
      }
    }
    // keep off the abyss lip
    if (w2.radiusAt) {
      const d = Math.hypot(a.position.x, a.position.z);
      const R = w2.radiusAt(Math.atan2(a.position.z, a.position.x)) - a.radius - 1.05;
      if (d > R && d > 1e-4) this.add(-a.position.x / d, -a.position.z / d, w * 1.4);
    }
    return this;
  }

  /**
   * Normalised desired direction * maxSpeed, written into `out`.
   * The magnitude term matters: when the weighted desires CANCEL (an agent
   * held at its standoff ring with separation pushing back) the result is a
   * short vector, and the agent should idle there rather than sprint along
   * whatever residue survived. Dividing by the accumulated weight is what
   * turns "everything agrees" into full speed and "everyone disagrees" into a
   * settle.
   */
  resolve(out) {
    const len = Math.hypot(this.x, this.z);
    if (len < 1e-5) { out.x = 0; out.z = 0; return out; }
    const mag = Math.min(1, len / Math.max(1e-4, this.w * 0.62));
    const k = (this.maxSpeed * mag) / len;
    out.x = this.x * k; out.z = this.z * k;
    return out;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BEHAVIOUR — a flat, authorable hierarchical state machine
// ═══════════════════════════════════════════════════════════════════════════
//
// Flat on purpose. A behaviour TREE re-evaluates a whole graph per tick and
// makes "how long have I been winding up" awkward to express; combat states are
// fundamentally timed and exclusive. Hierarchy is provided by `any`, a guard
// list evaluated before the active state — that is where "if I got hit, go to
// hurt" and "if the player died, go idle" live, once, instead of in every leaf.
//
//   const DEF = {
//     initial: 'idle',
//     any(a, dt, ctx) { if (a.stagger > 0) return 'hurt'; },
//     states: { idle: {...}, chase: {...} },
//   };
export class Brain {
  constructor(def, agent) {
    this.def = def; this.a = agent;
    this.state = null; this.t = 0; this.prev = null;
    this.set(def.initial || Object.keys(def.states)[0]);
  }
  set(name, ctx) {
    if (name === this.state) return this;
    const S = this.def.states[name];
    if (!S) return this;
    const old = this.def.states[this.state];
    if (old && old.exit) old.exit(this.a, ctx);
    this.prev = this.state; this.state = name; this.t = 0;
    this.a.stateName = name;
    if (S.enter) S.enter(this.a, ctx);
    return this;
  }
  is(name) { return this.state === name; }
  update(dt, ctx) {
    this.t += dt;
    if (this.def.any) { const n = this.def.any(this.a, dt, ctx); if (n && n !== this.state) { this.set(n, ctx); } }
    const S = this.def.states[this.state];
    if (!S || !S.update) return;
    const n = S.update(this.a, dt, ctx);
    if (n && n !== this.state) this.set(n, ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAPH
// ═══════════════════════════════════════════════════════════════════════════
//
// A telegraph is DATA, and it is GENEROUS. These are the authored floors for
// the whole roster; a designer raises them, never lowers them, and every one is
// long enough to dash out of at the player's 0.19s dash.
//
//   light melee   0.42s   — a shade's overhead. Readable, punishable.
//   heavy melee   0.72s   — the brute's shield bash: you have time to flank.
//   ranged AOE    1.05s   — the caster's ground circle. Walk out, do not dash.
//   detonation    1.35s   — the bomber. Long, because the answer is to LEAVE.
//   boss slam     0.85s   — big, slow, and the vulnerability window follows it.
export const TELEGRAPH = {
  lightMelee: 0.42,
  heavyMelee: 0.72,
  dash: 0.55,
  rangedAOE: 1.05,
  bolt: 0.68,
  detonate: 1.35,
  summon: 1.15,
  bossSlam: 0.85,
  bossSweep: 0.95,
  bossVolley: 1.10,
  // follow-ups and specialists. A combo's SECOND swing may be quicker than a
  // first because the first already announced the fight; a blink strike is
  // read from the arrival mark, so its own tell is short but never absent.
  comboFollow: 0.30,
  blinkStrike: 0.36,
  shieldCharge: 0.80,
  volley: 0.90,
  guardBreak: 0.55,
};

/**
 * Mixed into every agent by EnemyBase. Broadcasts on the bus so VFX/UI/audio
 * can draw the tell without knowing anything about the roster, and drives
 * `a.tell.k` in [0,1] for the agent's own wind-up pose and emissive pump.
 */
export function beginTelegraph(a, ctx, kind, dur, o = {}) {
  a.tell.active = true;
  a.tell.kind = kind;
  a.tell.t = 0;
  a.tell.dur = Math.max(0.08, dur);
  a.tell.k = 0;
  a.tell.color = o.color || a.tellColor || '#ff5a3c';
  a.tell.shape = o.shape || 'arc';
  a.tell.radius = o.radius ?? 2.4;
  a.tell.arc = o.arc ?? 90;
  a.tell.x = o.x ?? a.position.x;
  a.tell.z = o.z ?? a.position.z;
  a.tell.dirX = o.dirX ?? a.facing.x;
  a.tell.dirZ = o.dirZ ?? a.facing.z;
  a.tell.follow = o.follow ?? false;
  ctx.events.emit('enemy.telegraph', {
    entity: a, kind, dur: a.tell.dur, pos: a.position, color: a.tell.color,
    shape: a.tell.shape, radius: a.tell.radius, arc: a.tell.arc,
    x: a.tell.x, z: a.tell.z, dirX: a.tell.dirX, dirZ: a.tell.dirZ,
  });
  return a.tell;
}
export function endTelegraph(a, ctx, fired = true) {
  if (!a.tell.active) return;
  a.tell.active = false;
  ctx.events.emit('enemy.telegraph.end', { entity: a, kind: a.tell.kind, fired });
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** cone hit test in the XZ plane — the roster's one melee primitive. */
export function inCone(a, target, range, arcDeg, dirX, dirZ) {
  if (!target || !target.position) return false;
  const dx = target.position.x - a.position.x, dz = target.position.z - a.position.z;
  const d = Math.hypot(dx, dz);
  if (d > range + (target.radius || 0.45)) return false;
  if (d < 1e-4) return true;
  const c = Math.cos(arcDeg * 0.5 * Math.PI / 180);
  return ((dx / d) * dirX + (dz / d) * dirZ) >= c;
}

/** disc hit test in the XZ plane. */
export function inDisc(x, z, target, radius) {
  if (!target || !target.position) return false;
  const dx = target.position.x - x, dz = target.position.z - z;
  return (dx * dx + dz * dz) <= (radius + (target.radius || 0.45)) ** 2;
}

/**
 * A deterministic circling sign per agent — half the roster goes clockwise, so
 * the ring around the player is never a single rotating conga line.
 */
export function orbitSign(id) { return (id & 1) ? 1 : -1; }

/**
 * SURROUND SLOTS — the flanking formation.
 *
 * Every melee agent without the token owns a SLOT on the standoff ring, fanned
 * across the player's sides and back, away from where the hero is looking.
 * Rank is by id, so the assignment is deterministic and stable until someone
 * dies, at which point the ring closes up. Pure orbiting produces a conga line
 * that the player can face all at once; slots produce a pincer that forces the
 * camera-side read — "who is behind me" — which is the whole reason a pack of
 * shades is scarier than one.
 *
 * Writes into `out` ({x,z}); allocation-free.
 */
export function surroundSlot(a, list, tx, tz, faceX, faceZ, radius, out, filter = null) {
  let n = 0, rank = 0;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || o.dead || o.alive === false || !o.position) continue;
    const d = o.def;
    if (d && (d.boss || d.tokenPool === 'ranged' || d.tokenPool === 'free')) continue;
    if (filter && !filter(o)) continue;
    if (o.id < a.id) rank++;
    n++;
  }
  const fl = Math.hypot(faceX, faceZ) || 1;
  // behind the player's facing; a lone agent sits square behind, a pack fans
  // out to a pincer, never a full ring (the front stays open to read)
  const base = Math.atan2(faceZ / fl, faceX / fl) + Math.PI;
  const spread = n <= 1 ? 0 : Math.min(TAU * 0.72, 0.85 * n);
  const ang = n <= 1 ? base : base + (rank / (n - 1) - 0.5) * spread;
  out.x = tx + Math.cos(ang) * radius;
  out.z = tz + Math.sin(ang) * radius;
  return out;
}

export default {
  TokenPool, Perception, Steer, Brain, TELEGRAPH,
  beginTelegraph, endTelegraph, inCone, inDisc, orbitSign, surroundSlot, V2,
};
