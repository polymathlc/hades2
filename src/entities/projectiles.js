// OWNER: AGENT-COMBAT
// ---------------------------------------------------------------------------
// projectiles.js — one pooled, instanced, deterministic projectile system.
//
// 384 simultaneous bolts in TWO draw calls:
//   * CORE  — an elongated bipyramid, additive, stretched along velocity. This
//             is the near-white §5 "core": small, hot, unmistakable.
//   * GLOW  — camera-facing additive quads carrying a procedurally drawn
//             radial sprite. Each bolt also lays down GHOSTS of that quad at
//             its last N positions, which is the trail: no ribbon geometry, no
//             per-bolt draw call, and it reads as a streak at 1/8 resolution
//             exactly as §5 demands.
//
// The vfx ribbon trail (ctx.vfx.trail) is reserved for HERO projectiles — the
// thrown spear, the full-charge arrow — because that pool is small and those
// are the two bolts the player is actually watching.
//
// MOVEMENT KINDS  straight | arc (ballistic) | homing | bounce | orbit
// FLAGS           pierce, stick, reflectable, solid
//
// Determinism: no Math.random, no Date.now. Everything integrates on the fixed
// step. Zero allocation in update(): every record is pooled with primitive
// fields, matrices are composed into preallocated scratch objects.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { TEAM } from './hitbox.js';

const MAX = 384;
const GHOSTS = 4;               // trail samples carried per bolt
const GLOW_CAP = MAX * (GHOSTS + 1);

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

/** Draw the glow sprite once, in code. Hot small centre, wide soft halo. */
function makeGlowTexture() {
  const N = 64, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  grd.addColorStop(0.14, 'rgba(255,255,255,0.86)');
  grd.addColorStop(0.32, 'rgba(255,255,255,0.34)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.09)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0.00)');
  g.fillStyle = grd; g.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

export class ProjectileSystem {
  constructor() {
    this.pool = [];
    this.live = [];
    this._seq = 1;
    this.count = 0;
  }

  init(ctx, combat) {
    this.ctx = ctx; this.combat = combat;
    for (let i = 0; i < MAX; i++) this.pool.push(this._blank(i));

    this.root = new THREE.Group();
    this.root.name = 'projectiles';
    ctx.scene.add(this.root);

    // ── CORE: an 8-face bipyramid, stretched down +Z at draw time ──────────
    const core = new THREE.OctahedronGeometry(0.5, 0);
    core.scale(1, 1, 2.15);
    const coreMat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.98,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    this.coreMesh = new THREE.InstancedMesh(core, coreMat, MAX);
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coreMesh.frustumCulled = false;
    this.coreMesh.name = 'projectiles.core';
    this.coreMesh.count = 0;
    this.root.add(this.coreMesh);

    // ── GLOW: camera-facing quads (heads + trail ghosts) ───────────────────
    this.glowTex = makeGlowTexture();
    const quad = new THREE.PlaneGeometry(1, 1);
    const glowMat = new THREE.MeshBasicMaterial({
      map: this.glowTex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 1, toneMapped: true,
    });
    this.glowMesh = new THREE.InstancedMesh(quad, glowMat, GLOW_CAP);
    this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.name = 'projectiles.glow';
    this.glowMesh.renderOrder = 12;
    this.glowMesh.count = 0;
    this.root.add(this.glowMesh);

    // instanceColor buffers
    this.coreMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.coreMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.glowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAP * 3), 3);
    this.glowMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    ctx.events.on('room.built', () => this.clear());
    return this;
  }

  _blank(slot) {
    return {
      slot, id: 0, alive: false,
      x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 1,
      kind: 0,                  // 0 straight 1 arc 2 homing 3 bounce 4 orbit
      speed: 18, gravity: 0, drag: 0,
      radius: 0.28, life: 3, t: 0,
      damage: 10, type: 'physical', knockback: 3, hitstop: 0, shake: 0,
      poiseDamage: 5, status: null, statusStacks: 1,
      team: TEAM.ENEMY, mask: TEAM.PLAYER, source: null,
      pierce: 1, hits: 0, bounces: 0, solid: true, reflectable: true,
      blastRadius: 0, crit: 0, follow: false,
      homing: 0, target: null,
      orbX: 0, orbZ: 0, orbR: 3, orbW: 2.2, orbA: 0,
      cr: 1, cg: 0.7, cb: 0.3, size: 1, coreSize: 1,
      hx: new Float32Array(GHOSTS), hy: new Float32Array(GHOSTS), hz: new Float32Array(GHOSTS),
      hn: 0, hAcc: 0,
      onHitFx: 'impact', onExpireFx: 'burst',
      carrier: null, trailHandle: null,
      _lastHit: null,
    };
  }

  // ────────────────────────────────────────────────────────────── spawn ────
  /**
   * fire(d) -> id
   * d = { x,y,z, dir:{x,z} | dx,dz, speed, kind, damage, type, radius, life,
   *       team|source, pierce, bounces, homing, target, gravity, drag,
   *       colour/color, size, knockback, hitstop, shake, status, hero:true }
   */
  fire(d) {
    let p = null;
    for (let i = 0; i < this.pool.length; i++) if (!this.pool[i].alive) { p = this.pool[i]; break; }
    if (!p) return 0;

    p.alive = true; p.id = this._seq++;
    p.x = d.x ?? 0; p.y = d.y ?? 1.05; p.z = d.z ?? 0;

    let dx = d.dx ?? (d.dir ? (d.dir.x ?? 0) : 0);
    let dz = d.dz ?? (d.dir ? (d.dir.z ?? d.dir.y ?? 1) : 1);
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    p.speed = d.speed ?? 18;
    p.vx = dx * p.speed; p.vz = dz * p.speed; p.vy = d.vy ?? 0;

    const K = { straight: 0, arc: 1, homing: 2, bounce: 3, orbit: 4 };
    p.kind = typeof d.kind === 'number' ? d.kind : (K[d.kind] ?? 0);
    if (p.kind === 1 && !d.vy) p.vy = d.rise ?? 4.2;
    p.gravity = d.gravity ?? (p.kind === 1 ? 9.6 : 0);
    p.drag = d.drag ?? 0;

    p.radius = d.radius ?? 0.30;
    p.life = d.life ?? 3.0; p.t = 0;
    p.damage = d.damage ?? 10;
    p.type = d.type || 'physical';
    p.knockback = d.knockback ?? 3;
    p.hitstop = d.hitstop ?? 0;
    p.shake = d.shake ?? 0;
    p.poiseDamage = d.poiseDamage ?? p.damage * 0.4;
    p.status = d.status || null;
    p.statusStacks = d.statusStacks ?? 1;

    p.source = d.source || null;
    p.team = d.team ?? (p.source ? (this.combat ? this.combat.hitboxes.teamOf(p.source) : TEAM.ENEMY) : TEAM.ENEMY);
    p.mask = d.mask ?? (p.team === TEAM.PLAYER ? TEAM.ENEMY : TEAM.PLAYER);

    p.pierce = d.pierce ?? 1; p.hits = 0;
    p.blastRadius = d.blastRadius ?? 0; p.crit = d.crit ?? 0;
    p.bounces = d.bounces ?? (p.kind === 3 ? 3 : 0);
    p.solid = d.solid !== false;
    p.reflectable = d.reflectable !== false;
    p.homing = d.homing ?? (p.kind === 2 ? 4.5 : 0);
    p.target = d.target || null;

    p.orbX = d.orbitX ?? p.x; p.orbZ = d.orbitZ ?? p.z;
    p.orbR = d.orbitRadius ?? 3; p.orbW = d.orbitSpeed ?? 2.2;
    p.orbA = d.orbitAngle ?? Math.atan2(p.z - p.orbZ, p.x - p.orbX);

    _c.set(d.color || d.colour || '#ffb04a');
    p.cr = _c.r; p.cg = _c.g; p.cb = _c.b;
    p.size = d.size ?? 1; p.coreSize = d.coreSize ?? 1;
    p.onHitFx = d.onHit || 'impact';
    p.onExpireFx = d.onExpire || 'burst';
    p.hn = 0; p.hAcc = 0; p._lastHit = null;
    for (let i = 0; i < GHOSTS; i++) { p.hx[i] = p.x; p.hy[i] = p.y; p.hz[i] = p.z; }

    // hero bolts get a real ribbon trail from the VFX pool
    if (d.hero && this.ctx.vfx && this.ctx.vfx.trail) {
      if (!p.carrier) { p.carrier = new THREE.Object3D(); this.root.add(p.carrier); }
      p.carrier.position.set(p.x, p.y, p.z);
      p.carrier.updateMatrixWorld(true);
      p.trailHandle = this.ctx.vfx.trail(p.carrier, {
        color: d.color || '#ffe9a8', width: d.trailWidth ?? 0.16, life: 0.22,
      });
    }

    this.live.push(p.slot);
    this.count = this.live.length;
    this.ctx.events.emit('projectile.fired', { id: p.id, pos: _v.set(p.x, p.y, p.z), type: p.type, source: p.source });
    return p.id;
  }

  /** Reflect a bolt back at its owner — the SHIELD's whole reason to exist. */
  reflect(p, byEntity, dmgMul = 2.0, speedMul = 1.35) {
    if (!p || !p.reflectable) return false;
    p.vx = -p.vx * speedMul; p.vz = -p.vz * speedMul; p.vy = -p.vy * 0.4;
    p.speed = Math.hypot(p.vx, p.vz);
    p.team = this.combat ? this.combat.hitboxes.teamOf(byEntity) : TEAM.PLAYER;
    p.mask = p.team === TEAM.PLAYER ? TEAM.ENEMY : TEAM.PLAYER;
    p.source = byEntity;
    p.damage *= dmgMul;
    p.hits = 0; p._lastHit = null;
    p.t = 0; p.life = Math.max(p.life, 2.2);
    p.cr = 0.68; p.cg = 0.90; p.cb = 1.0;      // flips to the §1.2 rim hue
    this.ctx.events.emit('projectile.reflected', { pos: _v.set(p.x, p.y, p.z), by: byEntity });
    this.ctx.vfx?.shockwave?.(_v2.set(p.x, 0.05, p.z), { radius: 1.5, color: '#5fd0ff', life: 0.3 });
    return true;
  }

  /** All live bolts whose team is hostile to `entity`, inside radius. */
  forEachIncoming(entity, radius, fn) {
    const ex = entity.position.x, ez = entity.position.z;
    const team = this.combat ? this.combat.hitboxes.teamOf(entity) : TEAM.PLAYER;
    for (let i = 0; i < this.live.length; i++) {
      const p = this.pool[this.live[i]];
      if (!p.alive || p.team === team) continue;
      const dx = p.x - ex, dz = p.z - ez;
      if (dx * dx + dz * dz <= radius * radius) fn(p);
    }
  }

  kill(p, why) {
    if (!p.alive) return;
    p.alive = false;
    if (p.trailHandle) { p.trailHandle.release?.(); p.trailHandle = null; }
    const i = this.live.indexOf(p.slot);
    if (i >= 0) this.live.splice(i, 1);
    this.count = this.live.length;
    if (why !== 'silent') {
      _c.setRGB(p.cr, p.cg, p.cb);
      const hex = '#' + _c.getHexString();
      if (p.onExpireFx === 'burst') this.ctx.vfx?.burst?.(_v.set(p.x, p.y, p.z), { count: 8, color: hex, speed: 5, spread: 1.0, kind: 'sparkFine' });
      else if (p.onExpireFx === 'impact') this.ctx.vfx?.impact?.(_v.set(p.x, p.y, p.z), _v2.set(-p.vx, 0, -p.vz), { type: p.type, scale: 0.55, color: hex });
    }
  }

  clear() { for (let i = this.live.length - 1; i >= 0; i--) this.kill(this.pool[this.live[i]], 'silent'); }

  // ───────────────────────────────────────────────────────────── update ────
  update(dt, ctx, targets) {
    const world = ctx.world;
    const R = (world && world.bounds && world.bounds.r) ? world.bounds.r + 3 : 40;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.pool[this.live[i]];
      p.t += dt;

      // ── integrate ──────────────────────────────────────────────────────
      if (p.kind === 4) {                                   // orbit
        p.orbA += p.orbW * dt;
        const nx = p.orbX + Math.cos(p.orbA) * p.orbR;
        const nz = p.orbZ + Math.sin(p.orbA) * p.orbR;
        p.vx = (nx - p.x) / Math.max(dt, 1e-5); p.vz = (nz - p.z) / Math.max(dt, 1e-5);
        p.x = nx; p.z = nz;
      } else {
        if (p.kind === 2 && p.homing > 0) {                 // homing
          const tg = p.target && !p.target.dead ? p.target : (p.target = this._acquire(p, targets));
          if (tg && tg.position) {
            const dx = tg.position.x - p.x, dz = tg.position.z - p.z;
            const dl = Math.hypot(dx, dz) || 1;
            const k = Math.min(1, p.homing * dt);
            p.vx += (dx / dl * p.speed - p.vx) * k;
            p.vz += (dz / dl * p.speed - p.vz) * k;
            const sl = Math.hypot(p.vx, p.vz) || 1;
            p.vx = p.vx / sl * p.speed; p.vz = p.vz / sl * p.speed;
          }
        }
        if (p.drag > 0) { const f = Math.max(0, 1 - p.drag * dt); p.vx *= f; p.vz *= f; }
        p.vy -= p.gravity * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      }

      // ── trail history ──────────────────────────────────────────────────
      p.hAcc += dt;
      if (p.hAcc >= 0.0083) {
        p.hAcc = 0;
        for (let g = GHOSTS - 1; g > 0; g--) { p.hx[g] = p.hx[g - 1]; p.hy[g] = p.hy[g - 1]; p.hz[g] = p.hz[g - 1]; }
        p.hx[0] = p.x; p.hy[0] = p.y; p.hz[0] = p.z;
        if (p.hn < GHOSTS) p.hn++;
      }
      if (p.carrier) { p.carrier.position.set(p.x, p.y, p.z); p.carrier.updateMatrixWorld(true); }

      // ── expiry ─────────────────────────────────────────────────────────
      if (p.t >= p.life) { this.kill(p, 'expire'); continue; }
      if (p.y < 0.06 && p.gravity > 0) {
        if (p.bounces > 0) { p.bounces--; p.y = 0.06; p.vy = Math.abs(p.vy) * 0.52; p.vx *= 0.82; p.vz *= 0.82; this._groundFx(p); }
        else { this._explode(p, targets); continue; }
      }
      if (p.x * p.x + p.z * p.z > R * R) { this.kill(p, 'expire'); continue; }

      // ── world solids (cheap: collide() pushes out in place) ────────────
      if (p.solid && world && world.collide && (ctx.time.frame + p.slot) % 2 === 0) {
        _v.set(p.x, p.y, p.z);
        world.collide(_v, p.radius);
        if (Math.abs(_v.x - p.x) > 1e-4 || Math.abs(_v.z - p.z) > 1e-4) {
          if (p.bounces > 0) {
            p.bounces--;
            const nx = _v.x - p.x, nz = _v.z - p.z;
            const nl = Math.hypot(nx, nz) || 1;
            const d = (p.vx * nx / nl + p.vz * nz / nl);
            p.vx -= 2 * d * nx / nl; p.vz -= 2 * d * nz / nl;
            p.x = _v.x; p.z = _v.z;
            this._wallFx(p, nx / nl, nz / nl);
          } else { p.x = _v.x; p.z = _v.z; this._explode(p, targets); continue; }
        }
      }

      // ── entity hits ────────────────────────────────────────────────────
      const n = targets.length;
      for (let j = 0; j < n; j++) {
        const e = targets[j];
        if (!e || e.dead || e.alive === false || !e.position || e === p.source || e === p._lastHit) continue;
        const t = this.combat.hitboxes.teamOf(e);
        if (!(t & p.mask)) continue;
        const ey1 = e.position.y + (e.height || 1.8);
        if (p.y < e.position.y - 0.3 || p.y > ey1 + 0.3) continue;
        const dx = e.position.x - p.x, dz = e.position.z - p.z;
        const rr = p.radius + (e.radius || 0.5);
        if (dx * dx + dz * dz > rr * rr) continue;

        const dl = Math.hypot(dx, dz) || 1;
        this.combat.projectileHit(p, e, dx / dl, dz / dl);
        p.hits++; p._lastHit = e;
        if (p.hits >= p.pierce) { this._explode(p, targets); break; }
      }
    }
    this.count = this.live.length;
  }

  _acquire(p, targets) {
    let best = null, bd = 1e9;
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      if (!e || e.dead || e.alive === false || !e.position) continue;
      if (!(this.combat.hitboxes.teamOf(e) & p.mask)) continue;
      const dx = e.position.x - p.x, dz = e.position.z - p.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  _hex(p) { _c.setRGB(p.cr, p.cg, p.cb); return '#' + _c.getHexString(); }
  _groundFx(p) { this.ctx.vfx?.shockwave?.(_v.set(p.x, 0.04, p.z), { radius: 0.9, color: this._hex(p), life: 0.24 }); }
  _wallFx(p, nx, nz) { this.ctx.vfx?.impact?.(_v.set(p.x, p.y, p.z), _v2.set(nx, 0, nz), { type: p.type, scale: 0.42, color: this._hex(p) }); }

  _explode(p, targets) {
    const hex = this._hex(p);
    this.ctx.vfx?.impact?.(_v.set(p.x, Math.max(0.2, p.y), p.z), _v2.set(-p.vx, 0, -p.vz), { type: p.type, scale: 0.7, color: hex });
    if (p.blastRadius > 0) {
      this.ctx.vfx?.shockwave?.(_v.set(p.x, 0.05, p.z), { radius: p.blastRadius, color: hex, life: 0.38 });
    }
    this.kill(p, 'silent');
  }

  // ─────────────────────────────────────────────────── instanced draw ────
  lateUpdate(alpha, ctx) {
    const cam = ctx.camera;
    if (cam) _qc.copy(cam.quaternion);
    let ci = 0, gi = 0;
    const cCol = this.coreMesh.instanceColor.array;
    const gCol = this.glowMesh.instanceColor.array;

    for (let i = 0; i < this.live.length; i++) {
      const p = this.pool[this.live[i]];
      // fade-in on spawn, fade-out at end of life so nothing pops
      const fin = Math.min(1, p.t / 0.05);
      const fout = Math.min(1, (p.life - p.t) / 0.14);
      const k = Math.max(0, Math.min(fin, fout));

      // CORE — stretched along velocity
      const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
      _v.set(p.vx / sp, p.vy / sp, p.vz / sp);
      if (Math.abs(_v.y) > 0.995) { _v.x += 0.02; _v.normalize(); }
      // orient +Z of the bipyramid along velocity: build from a lookAt basis
      _m.lookAt(_v2.set(0, 0, 0), _v, _up);
      _m.setPosition(p.x, p.y, p.z);
      const cs = p.radius * 1.02 * p.coreSize * k;
      _s.set(cs, cs, cs);
      _m.scale(_s);
      this.coreMesh.setMatrixAt(ci, _m);
      cCol[ci * 3] = Math.min(1.05, p.cr * 0.88 + 0.11) * k;
      cCol[ci * 3 + 1] = Math.min(1.05, p.cg * 0.88 + 0.09) * k;
      cCol[ci * 3 + 2] = Math.min(1.05, p.cb * 0.88 + 0.07) * k;
      ci++;

      // GLOW head + ghosts
      if (cam) {
        const headS = p.radius * 2.70 * p.size * k;
        _m.compose(_v.set(p.x, p.y, p.z), _qc, _s.set(headS, headS, headS));
        this.glowMesh.setMatrixAt(gi, _m);
        gCol[gi * 3] = p.cr * 0.38 * k; gCol[gi * 3 + 1] = p.cg * 0.38 * k; gCol[gi * 3 + 2] = p.cb * 0.38 * k;
        gi++;
        for (let g = 0; g < p.hn && gi < GLOW_CAP; g++) {
          const f = (1 - (g + 1) / (GHOSTS + 1)) * k;
          const s2 = headS * (0.86 - 0.16 * g);
          _m.compose(_v.set(p.hx[g], p.hy[g], p.hz[g]), _qc, _s.set(s2, s2, s2));
          this.glowMesh.setMatrixAt(gi, _m);
          gCol[gi * 3] = p.cr * f * 0.17; gCol[gi * 3 + 1] = p.cg * f * 0.17; gCol[gi * 3 + 2] = p.cb * f * 0.17;
          gi++;
        }
      }
    }
    this.coreMesh.count = ci;
    this.glowMesh.count = gi;
    if (ci) { this.coreMesh.instanceMatrix.needsUpdate = true; this.coreMesh.instanceColor.needsUpdate = true; }
    if (gi) { this.glowMesh.instanceMatrix.needsUpdate = true; this.glowMesh.instanceColor.needsUpdate = true; }
  }

  dispose() {
    this.coreMesh?.geometry.dispose(); this.coreMesh?.material.dispose();
    this.glowMesh?.geometry.dispose(); this.glowMesh?.material.dispose();
    this.glowTex?.dispose();
    if (this.root?.parent) this.root.parent.remove(this.root);
  }
}

export default ProjectileSystem;
