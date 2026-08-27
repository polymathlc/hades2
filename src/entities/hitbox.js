// OWNER: AGENT-COMBAT
// ---------------------------------------------------------------------------
// hitbox.js — deterministic, pooled, allocation-free hit detection.
//
// WHY 2D + A HEIGHT BAND, NOT 3D:
//   EREBUS is a 3/4 isometric action game. The player reads the fight as a
//   TOP-DOWN diagram: "the arc reaches that far, that shape is dangerous". A
//   true 3D test disagrees with that diagram at exactly the moments that
//   matter (a jumping enemy, a raised weapon) and the fight stops feeling
//   fair. So every test here is a 2D test on the XZ ground plane, gated by a
//   simple [y0,y1] height band. It is faster, it is more predictable, and it
//   is what makes Hades' combat feel honest.
//
// SHAPES  circle | capsule | arc (cone sector) | ring (annulus, optionally
//         arc-limited) | box (OBB).  All swept: a hitbox that moves between
//         two frames tests the whole path, so a fast lunge cannot tunnel
//         through a small enemy at 120Hz.
//
// LIFECYCLE  A hitbox is DECLARED with the attack and is only LIVE between t0
//         and t1 — the "active frames". Outside that window it exists but hits
//         nothing. Windup and recovery are therefore real, readable, and
//         punishable, which is the whole point.
//
// BOOKKEEPING  hit-once-per-swing, pierce counts, max-target caps, team masks,
//         friendly fire flag.
//
// ZERO PER-FRAME ALLOCATION. Every record is pooled and every field is a
// primitive. spawn() copies primitives out of its descriptor; nothing is
// retained. The debug renderer writes into one preallocated Float32Array.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

// ── team masks ─────────────────────────────────────────────────────────────
export const TEAM = { PLAYER: 1, ENEMY: 2, NEUTRAL: 4, ALL: 7 };

export const SHAPE = { CIRCLE: 0, CAPSULE: 1, ARC: 2, RING: 3, BOX: 4 };
const SHAPE_ID = { circle: 0, capsule: 1, arc: 2, cone: 2, sector: 2, ring: 3, box: 4 };

const MAX_HITBOXES = 96;
const MAX_HIT_MEMORY = 24;      // distinct victims remembered per hitbox
const DEBUG_SEGMENTS = 3072;

const DEG = Math.PI / 180;

// ── 2D primitives (no allocation, no Math.hypot in hot loops) ──────────────

/** squared distance from point p to segment ab, on the XZ plane */
function distSqPointSeg(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const wx = px - ax, wz = pz - az;
  const vv = vx * vx + vz * vz;
  let t = vv > 1e-9 ? (wx * vx + wz * vz) / vv : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t, dz = wz - vz * t;
  return dx * dx + dz * dz;
}

export class HitboxSystem {
  constructor() {
    this.pool = [];
    this.live = [];             // indices into pool that are currently allocated
    this._seq = 1;
    this.debug = false;
    this.stats = { live: 0, tests: 0, hits: 0 };
  }

  init(ctx, combat) {
    this.ctx = ctx;
    this.combat = combat;
    for (let i = 0; i < MAX_HITBOXES; i++) this.pool.push(this._blank(i));
    this._buildDebug(ctx);
    return this;
  }

  _blank(slot) {
    return {
      slot, id: 0, alive: false,
      shape: 0,
      // placement (world, XZ + height band)
      x: 0, z: 0, px: 0, pz: 0, y0: 0, y1: 2.2,
      // orientation / extents
      ax: 0, az: 1,             // facing (unit) — arc/box/capsule direction
      r: 1, rIn: 0, len: 0, half: Math.PI, hw: 0.5, hl: 0.5,
      // follow an owner
      owner: null, follow: false, offF: 0, offR: 0, followFacing: true, swept: true,
      // timing (seconds, sim time)
      t: 0, t0: 0, t1: 0, life: 0,
      // filtering
      mask: TEAM.ENEMY, friendly: false, ownerTeam: TEAM.PLAYER,
      // budget
      pierce: 255, maxTargets: 255, hitCount: 0,
      // payload — copied verbatim into applyDamage()
      damage: 0, type: 'physical', knockback: 0, hitstop: 0, shake: 0,
      poiseDamage: 0, statusKind: null, statusStacks: 0, critBonus: 0,
      tag: '', color: null, on: null, source: null,
      // memory
      hits: new Array(MAX_HIT_MEMORY).fill(null), nHits: 0,
      // debug
      dbgR: 1, dbgG: 0.35, dbgB: 0.1,
    };
  }

  // ───────────────────────────────────────────────────────────── spawn ────
  /**
   * spawn(desc) -> id (0 if the pool is saturated)
   *
   * desc = {
   *   shape:'circle'|'capsule'|'arc'|'ring'|'box',
   *   owner, source,            // owner drives follow; source is the damage credit
   *   x,z, y0,y1,               // world placement + height band (default owner's)
   *   forward:[x,z],            // facing for arc/box/capsule (default owner facing)
   *   offset:[fwd,right],       // local offset from owner
   *   radius, innerRadius, arcDeg, length, halfWidth,
   *   t0,t1,life,               // ACTIVE WINDOW, seconds from spawn
   *   mask, friendly,
   *   pierce, maxTargets,
   *   damage, type, knockback, hitstop, shake, poiseDamage, status, crit,
   *   follow:true, sweep:true, on(entity, hb, nx, nz)
   * }
   */
  spawn(d) {
    let h = null;
    for (let i = 0; i < this.pool.length; i++) { if (!this.pool[i].alive) { h = this.pool[i]; break; } }
    if (!h) return 0;

    h.alive = true; h.id = this._seq++;
    h.shape = SHAPE_ID[d.shape] ?? (typeof d.shape === 'number' ? d.shape : 0);
    h.owner = d.owner || null;
    h.source = d.source || d.owner || null;

    const o = h.owner;
    const ofF = d.offset ? d.offset[0] : 0;
    const ofR = d.offset ? d.offset[1] : 0;
    h.offF = ofF; h.offR = ofR;
    h.follow = d.follow !== false && !!o;
    h.followFacing = d.followFacing !== false;
    h.swept = d.sweep !== false;

    if (d.forward) { const l = Math.hypot(d.forward[0], d.forward[1]) || 1; h.ax = d.forward[0] / l; h.az = d.forward[1] / l; }
    else if (o && o.facing) { h.ax = o.facing.x; h.az = o.facing.y; }
    else { h.ax = 0; h.az = 1; }

    const bx = d.x != null ? d.x : (o && o.position ? o.position.x : 0);
    const bz = d.z != null ? d.z : (o && o.position ? o.position.z : 0);
    h.x = bx + h.ax * ofF - h.az * ofR;
    h.z = bz + h.az * ofF + h.ax * ofR;
    h.px = h.x; h.pz = h.z;

    const oy = o && o.position ? o.position.y : 0;
    h.y0 = d.y0 != null ? d.y0 : oy - 0.35;
    h.y1 = d.y1 != null ? d.y1 : oy + 2.35;

    h.r = d.radius ?? 1.0;
    h.rIn = d.innerRadius ?? 0;
    h.half = (d.arcDeg != null ? d.arcDeg : 360) * 0.5 * DEG;
    h.len = d.length ?? 0;
    h.hw = d.halfWidth ?? 0.5;
    h.hl = d.halfLength ?? (d.length ? d.length * 0.5 : 0.5);

    h.t = 0;
    h.t0 = d.t0 ?? 0;
    h.t1 = d.t1 ?? (h.t0 + 0.08);
    h.life = d.life ?? (h.t1 + 0.02);

    h.ownerTeam = d.ownerTeam ?? this.teamOf(h.source);
    h.mask = d.mask ?? (h.ownerTeam === TEAM.PLAYER ? TEAM.ENEMY : TEAM.PLAYER);
    h.friendly = !!d.friendly;

    h.pierce = d.pierce ?? 255;
    h.maxTargets = d.maxTargets ?? 255;
    h.hitCount = 0; h.nHits = 0;
    for (let i = 0; i < MAX_HIT_MEMORY; i++) h.hits[i] = null;

    h.damage = d.damage ?? 0;
    h.type = d.type || 'physical';
    h.knockback = d.knockback ?? 0;
    h.hitstop = d.hitstop ?? 0;
    h.shake = d.shake ?? 0;
    h.poiseDamage = d.poiseDamage ?? (d.damage ?? 0) * 0.5;
    h.statusKind = d.status || null;
    h.statusStacks = d.statusStacks ?? 1;
    h.critBonus = d.crit ?? 0;
    h.tag = d.tag || '';
    h.color = d.color || null;
    h.on = d.on || null;

    // debug tint: warm for player boxes, arterial for enemy boxes
    if (h.ownerTeam === TEAM.PLAYER) { h.dbgR = 1.0; h.dbgG = 0.78; h.dbgB = 0.34; }
    else { h.dbgR = 1.0; h.dbgG = 0.20; h.dbgB = 0.28; }

    this.live.push(h.slot);
    return h.id;
  }

  /** Cancel a hitbox by id (used when an attack is interrupted). */
  cancel(id) {
    for (let i = 0; i < this.live.length; i++) {
      const h = this.pool[this.live[i]];
      if (h.id === id) { h.alive = false; h.owner = null; h.source = null; h.on = null; this.live.splice(i, 1); return true; }
    }
    return false;
  }
  cancelByOwner(owner) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const h = this.pool[this.live[i]];
      if (h.owner === owner) { h.alive = false; h.owner = null; h.source = null; h.on = null; this.live.splice(i, 1); }
    }
  }
  clear() {
    for (let i = 0; i < this.live.length; i++) { const h = this.pool[this.live[i]]; h.alive = false; h.owner = null; h.source = null; h.on = null; }
    this.live.length = 0;
  }

  teamOf(e) {
    if (!e) return TEAM.NEUTRAL;
    if (e.team === 'player' || e === (this.ctx && this.ctx.player)) return TEAM.PLAYER;
    if (e.team === 'enemy') return TEAM.ENEMY;
    if (e.team === 'neutral') return TEAM.NEUTRAL;
    return TEAM.ENEMY;
  }

  // ──────────────────────────────────────────────────────────── update ────
  update(dt, targets) {
    this.stats.live = this.live.length; this.stats.tests = 0; this.stats.hits = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const h = this.pool[this.live[i]];
      h.px = h.x; h.pz = h.z;
      h.t += dt;

      // follow the owner (a swing tracks the body that threw it)
      const o = h.owner;
      if (h.follow && o && o.position) {
        if (h.followFacing && o.facing) { h.ax = o.facing.x; h.az = o.facing.y; }
        h.x = o.position.x + h.ax * h.offF - h.az * h.offR;
        h.z = o.position.z + h.az * h.offF + h.ax * h.offR;
        h.y0 = o.position.y - 0.35; h.y1 = o.position.y + 2.35;
      }

      if (h.t >= h.t0 && h.t <= h.t1) this._test(h, targets);

      if (h.t >= h.life || h.hitCount >= h.maxTargets) {
        h.alive = false; h.owner = null; h.source = null; h.on = null;
        this.live.splice(i, 1);
      }
    }
  }

  _remember(h, e) {
    for (let i = 0; i < h.nHits; i++) if (h.hits[i] === e) return false;
    if (h.nHits < MAX_HIT_MEMORY) h.hits[h.nHits++] = e;
    return true;
  }

  _test(h, targets) {
    const n = targets.length;
    for (let i = 0; i < n; i++) {
      const e = targets[i];
      if (!e || e.dead || e.alive === false || !e.position) continue;
      if (e === h.source && !h.friendly) continue;
      const t = this.teamOf(e);
      if (!(t & h.mask)) continue;
      if (!h.friendly && t === h.ownerTeam) continue;

      // height band — the 2.5D gate
      const ey0 = e.position.y, ey1 = e.position.y + (e.height || 1.8);
      if (ey1 < h.y0 || ey0 > h.y1) continue;

      const er = e.radius || 0.5;
      this.stats.tests++;
      if (!this._overlap(h, e.position.x, e.position.z, er)) continue;
      if (!this._remember(h, e)) continue;

      h.hitCount++;
      this.stats.hits++;
      this._resolve(h, e);
      if (h.hitCount >= h.pierce || h.hitCount >= h.maxTargets) return;
    }
  }

  /** normal from the hitbox toward the victim, written into _nx/_nz */
  _nx = 0; _nz = 1;

  _overlap(h, ex, ez, er) {
    const R = h.r + er;
    switch (h.shape) {
      case SHAPE.CIRCLE: {
        // swept circle == capsule from the previous centre to the current one
        const d2 = h.swept ? distSqPointSeg(ex, ez, h.px, h.pz, h.x, h.z)
          : (ex - h.x) * (ex - h.x) + (ez - h.z) * (ez - h.z);
        if (d2 > R * R) return false;
        this._normalFrom(h.x, h.z, ex, ez);
        return true;
      }
      case SHAPE.CAPSULE: {
        const bx = h.x + h.ax * h.len, bz = h.z + h.az * h.len;
        const d2 = distSqPointSeg(ex, ez, h.x, h.z, bx, bz);
        if (d2 > R * R) return false;
        this._normalFrom(h.x, h.z, ex, ez);
        return true;
      }
      case SHAPE.ARC: {
        const dx = ex - h.x, dz = ez - h.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R * R) return false;
        if (h.rIn > 0 && d2 < (h.rIn - er) * (h.rIn - er)) return false;
        const d = Math.sqrt(d2);
        if (d <= er) { this._nx = h.ax; this._nz = h.az; return true; }   // inside the apex
        const cos = (dx * h.ax + dz * h.az) / d;
        // expand the sector by the victim's angular radius so a big body
        // clipped by the edge of the arc still counts — generosity, on purpose
        const grow = Math.asin(Math.min(0.999, er / Math.max(d, 1e-3)));
        const ang = Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos);
        if (ang > h.half + grow) return false;
        this._nx = dx / d; this._nz = dz / d;
        return true;
      }
      case SHAPE.RING: {
        const dx = ex - h.x, dz = ez - h.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > h.r + er || d < h.rIn - er) return false;
        if (h.half < Math.PI - 1e-3 && d > 1e-3) {
          const cos = (dx * h.ax + dz * h.az) / d;
          const grow = Math.asin(Math.min(0.999, er / Math.max(d, 1e-3)));
          const ang = Math.acos(cos < -1 ? -1 : cos > 1 ? 1 : cos);
          if (ang > h.half + grow) return false;
        }
        if (d > 1e-3) { this._nx = dx / d; this._nz = dz / d; } else { this._nx = h.ax; this._nz = h.az; }
        return true;
      }
      case SHAPE.BOX: {
        // OBB vs circle, in the box's local frame (forward = ax/az)
        const dx = ex - h.x, dz = ez - h.z;
        const lf = dx * h.ax + dz * h.az;              // along forward
        const lr = -dx * h.az + dz * h.ax;             // along right
        const cf = lf < -h.hl ? -h.hl : lf > h.hl ? h.hl : lf;
        const cr = lr < -h.hw ? -h.hw : lr > h.hw ? h.hw : lr;
        const ddf = lf - cf, ddr = lr - cr;
        if (ddf * ddf + ddr * ddr > er * er) return false;
        this._normalFrom(h.x, h.z, ex, ez);
        return true;
      }
    }
    return false;
  }

  _normalFrom(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const l = Math.sqrt(dx * dx + dz * dz);
    if (l > 1e-4) { this._nx = dx / l; this._nz = dz / l; } else { this._nx = 0; this._nz = 1; }
  }

  _resolve(h, e) {
    const nx = this._nx, nz = this._nz;
    if (h.on) { h.on(e, h, nx, nz); return; }
    const c = this.combat;
    if (!c) return;
    c.hit(h, e, nx, nz);
  }

  // ───────────────────────────────────────────────────── debug drawing ────
  // Behind ctx.quality.debugHitboxes. This is a DEVELOPER view: it is drawn as
  // depth-tested-off coloured line work so an active frame can be verified by
  // eye against the effect that is meant to sell it. It is never on in a
  // shipped frame (§7 bans programmer art on screen).
  _buildDebug(ctx) {
    const g = new THREE.BufferGeometry();
    this._dbgPos = new Float32Array(DEBUG_SEGMENTS * 2 * 3);
    this._dbgCol = new Float32Array(DEBUG_SEGMENTS * 2 * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this._dbgPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this._dbgCol, 3));
    g.setDrawRange(0, 0);
    const m = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending });
    this.dbgMesh = new THREE.LineSegments(g, m);
    this.dbgMesh.name = 'combat.hitboxDebug';
    this.dbgMesh.frustumCulled = false;
    this.dbgMesh.renderOrder = 9000;
    this.dbgMesh.visible = false;
    if (ctx && ctx.scene) ctx.scene.add(this.dbgMesh);
  }

  _seg(x0, z0, x1, z1, y, r, gc, b) {
    if (this._dbgN >= DEBUG_SEGMENTS) return;
    const i = this._dbgN * 6;
    const p = this._dbgPos, c = this._dbgCol;
    p[i] = x0; p[i + 1] = y; p[i + 2] = z0;
    p[i + 3] = x1; p[i + 4] = y; p[i + 5] = z1;
    c[i] = r; c[i + 1] = gc; c[i + 2] = b;
    c[i + 3] = r; c[i + 4] = gc; c[i + 5] = b;
    this._dbgN++;
  }

  _arcOutline(h, y, k) {
    const a0 = Math.atan2(h.az, h.ax) - h.half, a1 = Math.atan2(h.az, h.ax) + h.half;
    const N = 22;
    const rIn = h.rIn;
    let px = h.x + Math.cos(a0) * h.r, pz = h.z + Math.sin(a0) * h.r;
    if (rIn > 0) this._seg(h.x + Math.cos(a0) * rIn, h.z + Math.sin(a0) * rIn, px, pz, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
    else this._seg(h.x, h.z, px, pz, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
    for (let i = 1; i <= N; i++) {
      const a = a0 + (a1 - a0) * (i / N);
      const cx = h.x + Math.cos(a) * h.r, cz = h.z + Math.sin(a) * h.r;
      this._seg(px, pz, cx, cz, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
      px = cx; pz = cz;
    }
    if (rIn > 0) this._seg(px, pz, h.x + Math.cos(a1) * rIn, h.z + Math.sin(a1) * rIn, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
    else this._seg(px, pz, h.x, h.z, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
  }

  _circleOutline(cx, cz, r, y, R, G, B) {
    const N = 26; let px = cx + r, pz = cz;
    for (let i = 1; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      this._seg(px, pz, x, z, y, R, G, B); px = x; pz = z;
    }
  }

  drawDebug(ctx) {
    const on = !!(ctx.quality && ctx.quality.debugHitboxes) || this.debug;
    if (!this.dbgMesh) return;
    this.dbgMesh.visible = on;
    if (!on) return;
    this._dbgN = 0;
    const y = 0.08;
    for (let i = 0; i < this.live.length; i++) {
      const h = this.pool[this.live[i]];
      const live = h.t >= h.t0 && h.t <= h.t1;
      const k = live ? 1.0 : 0.22;    // dim during windup/recovery — the window IS the design
      switch (h.shape) {
        case SHAPE.ARC: this._arcOutline(h, y, k); break;
        case SHAPE.RING: this._arcOutline(h, y, k); this._circleOutline(h.x, h.z, h.rIn, y, h.dbgR * k, h.dbgG * k, h.dbgB * k); break;
        case SHAPE.CIRCLE: this._circleOutline(h.x, h.z, h.r, y, h.dbgR * k, h.dbgG * k, h.dbgB * k); break;
        case SHAPE.CAPSULE: {
          const bx = h.x + h.ax * h.len, bz = h.z + h.az * h.len;
          this._circleOutline(h.x, h.z, h.r, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
          this._circleOutline(bx, bz, h.r, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
          const rx = -h.az * h.r, rz = h.ax * h.r;
          this._seg(h.x + rx, h.z + rz, bx + rx, bz + rz, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
          this._seg(h.x - rx, h.z - rz, bx - rx, bz - rz, y, h.dbgR * k, h.dbgG * k, h.dbgB * k);
          break;
        }
        case SHAPE.BOX: {
          const fx = h.ax * h.hl, fz = h.az * h.hl, rx = -h.az * h.hw, rz = h.ax * h.hw;
          const x0 = h.x + fx + rx, z0 = h.z + fz + rz;
          const x1 = h.x + fx - rx, z1 = h.z + fz - rz;
          const x2 = h.x - fx - rx, z2 = h.z - fz - rz;
          const x3 = h.x - fx + rx, z3 = h.z - fz + rz;
          const R = h.dbgR * k, G = h.dbgG * k, B = h.dbgB * k;
          this._seg(x0, z0, x1, z1, y, R, G, B); this._seg(x1, z1, x2, z2, y, R, G, B);
          this._seg(x2, z2, x3, z3, y, R, G, B); this._seg(x3, z3, x0, z0, y, R, G, B);
          break;
        }
      }
    }
    const g = this.dbgMesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.setDrawRange(0, this._dbgN * 2);
  }

  dispose() {
    if (this.dbgMesh) {
      this.dbgMesh.geometry.dispose(); this.dbgMesh.material.dispose();
      if (this.dbgMesh.parent) this.dbgMesh.parent.remove(this.dbgMesh);
    }
  }
}

export default HitboxSystem;
