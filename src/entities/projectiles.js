// OWNER: AGENT-COMBAT
// ---------------------------------------------------------------------------
// projectiles.js — one pooled, instanced, deterministic projectile system.
//
// 384 simultaneous bolts in TWO draw calls:
//   * CORE  — an elongated bipyramid, additive, stretched along velocity. This
//             is the near-white §5 "core": small, hot, unmistakable.
//   * STREAK — a CONTINUOUS TAPERED RIBBON. The bolt's last N world positions
//             are stitched into a quad strip: one instanced quad per segment,
//             each quad's two ends carrying the width and the intensity of the
//             history points it spans, so the strip is a single unbroken
//             tapered streak with no seams and no steps. Camera-facing per
//             segment, built from the segment tangent and the view vector.
//             (This replaces the old GHOST quads. Four discrete sprites spaced
//             a bolt-length apart do not read as motion — they read as a
//             dotted line of separate circles, i.e. as a rendering bug.)
//   * GLOW  — ONE camera-facing additive quad at the head. Small and tight:
//             §5 wants the core hot and the glow low-alpha, and §9 will not
//             tolerate a bolt pooling light across the floor it flies over.
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
// TRAIL history points per bolt. Sampled once per fixed step, so this is also
// the tail length in frames: 8 @ 60 Hz = 0.133 s of streak, which at a typical
// 18 m/s bolt is a little over two body-lengths — a streak, not a comet tail.
const TRAIL = 8;
const SEGS = TRAIL;             // segments = points, counting the live head
const RIB_CAP = MAX * SEGS;
const GLOW_CAP = MAX;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

// ── the streak shader ──────────────────────────────────────────────────────
// One instanced quad per ribbon segment. Each instance carries the segment's
// two world endpoints plus the ribbon width and value at EACH end, and the
// quad is expanded across the segment IN THE VERTEX SHADER against the live
// camera. Two things follow, and both matter:
//   * consecutive segments share an edge EXACTLY (same endpoint, same width,
//     same value), so eight quads read as one continuous tapered ribbon
//     rather than as eight tiles with seams;
//   * the billboard is resolved at DRAW time, not in lateUpdate. The capture
//     harness poses the camera after lateUpdate has already run, so a
//     CPU-billboarded ribbon would be twisted in every shipped screenshot -
//     the same trap trails.js documents.
const RIB_VERT = /* glsl */`
attribute vec3 aA;         // world position of the OLDER end of this segment
attribute vec3 aB;         // world position of the NEWER end
attribute vec3 aCol;
attribute vec2 aFade;      // x = value at the tail end, y = at the head end
attribute vec2 aW;         // x = width at the tail end, y = at the head end
varying vec3 vCol;
varying float vK;
varying float vV;
void main() {
  float u = uv.x;                        // 0 = tail end of this segment, 1 = head
  vec3 P = mix(aA, aB, u);
  vec3 T = aB - aA;
  vec3 V = normalize(P - cameraPosition);
  vec3 S = cross(normalize(T), V);
  float l = length(S);
  S = l > 1e-4 ? S / l : vec3(0.0, 1.0, 0.0);
  P += S * (uv.y - 0.5) * mix(aW.x, aW.y, u);
  vCol = aCol;
  vK = mix(aFade.x, aFade.y, u);
  vV = uv.y * 2.0 - 1.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

// A hairline centre and a narrow saturated body. NO white core and no wide
// halo: the head sprite owns the hot spot, and a wide additive skirt on a bolt
// that crosses the whole arena is exactly the floor wash 9 outlaws.
const RIB_FRAG = /* glsl */`
precision highp float;
varying vec3 vCol;
varying float vK;
varying float vV;
void main() {
  float v = abs(vV);
  float edge = max(0.0, 1.0 - v);
  float body = edge * edge;
  float core = pow(max(0.0, 1.0 - v / 0.36), 2.4);
  vec3 c = vCol * (body * 0.46 + core * 0.80);
  gl_FragColor = vec4(c * vK, 1.0);
}`;

/** Draw the glow sprite once, in code. Hot small centre, wide soft halo. */
function makeGlowTexture() {
  const N = 64, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  // §5 / §9: the halo is the part that lands on the floor, so it is the part
  // that has to be cheap. The old ramp still carried 0.09 alpha out at 62% of
  // the radius; with a 0.8 m quad and several bolts in frame that is a wash.
  grd.addColorStop(0.00, 'rgba(255,255,255,1.00)');
  grd.addColorStop(0.09, 'rgba(255,255,255,0.82)');
  grd.addColorStop(0.22, 'rgba(255,255,255,0.26)');
  grd.addColorStop(0.44, 'rgba(255,255,255,0.055)');
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

    // ── STREAK: the tapered ribbon, one instanced quad per history segment ──
    const strip = new THREE.PlaneGeometry(1, 1);
    this._ribA = new THREE.InstancedBufferAttribute(new Float32Array(RIB_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this._ribB = new THREE.InstancedBufferAttribute(new Float32Array(RIB_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this._ribCol = new THREE.InstancedBufferAttribute(new Float32Array(RIB_CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this._ribFade = new THREE.InstancedBufferAttribute(new Float32Array(RIB_CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this._ribW = new THREE.InstancedBufferAttribute(new Float32Array(RIB_CAP * 2), 2).setUsage(THREE.DynamicDrawUsage);
    strip.setAttribute('aA', this._ribA);
    strip.setAttribute('aB', this._ribB);
    strip.setAttribute('aCol', this._ribCol);
    strip.setAttribute('aFade', this._ribFade);
    strip.setAttribute('aW', this._ribW);
    const ribMat = new THREE.ShaderMaterial({
      vertexShader: RIB_VERT, fragmentShader: RIB_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: true,
    });
    this.ribMesh = new THREE.InstancedMesh(strip, ribMat, RIB_CAP);
    this.ribMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ribMesh.frustumCulled = false;
    this.ribMesh.name = 'projectiles.streak';
    this.ribMesh.renderOrder = 11;
    this.ribMesh.count = 0;
    this.root.add(this.ribMesh);

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
      poiseDamage: 5, status: null, statusStacks: 1, statusPower: 0,
      team: TEAM.ENEMY, mask: TEAM.PLAYER, source: null,
      pierce: 1, hits: 0, bounces: 0, solid: true, reflectable: true,
      blastRadius: 0, crit: 0, follow: false,
      forks: 0, castTicks: 0, tickDamage: 0, castBeam: 0,
      expose: 0, boonGod: null, boonSlot: null, boonProc: false,
      homing: 0, target: null,
      orbX: 0, orbZ: 0, orbR: 3, orbW: 2.2, orbA: 0,
      cr: 1, cg: 0.7, cb: 0.3, size: 1, coreSize: 1,
      hx: new Float32Array(TRAIL), hy: new Float32Array(TRAIL), hz: new Float32Array(TRAIL),
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
    p.statusPower = d.statusPower ?? 0;

    p.source = d.source || null;
    p.team = d.team ?? (p.source ? (this.combat ? this.combat.hitboxes.teamOf(p.source) : TEAM.ENEMY) : TEAM.ENEMY);
    p.mask = d.mask ?? (p.team === TEAM.PLAYER ? TEAM.ENEMY : TEAM.PLAYER);

    p.pierce = d.pierce ?? 1; p.hits = 0;
    p.blastRadius = d.blastRadius ?? 0; p.crit = d.crit ?? 0;
    p.forks = d.forks ?? 0; p.castTicks = d.castTicks ?? 0; p.tickDamage = d.tickDamage ?? 0; p.castBeam = d.castBeam ?? 0;
    p.expose = d.expose ?? 0; p.boonGod = d.boonGod || null; p.boonSlot = d.boonSlot || null; p.boonProc = !!d.boonProc;
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
    for (let i = 0; i < TRAIL; i++) { p.hx[i] = p.x; p.hy[i] = p.y; p.hz[i] = p.z; }

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
        for (let g = TRAIL - 1; g > 0; g--) { p.hx[g] = p.hx[g - 1]; p.hy[g] = p.hy[g - 1]; p.hz[g] = p.hz[g - 1]; }
        p.hx[0] = p.x; p.hy[0] = p.y; p.hz[0] = p.z;
        if (p.hn < TRAIL) p.hn++;
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
    let ci = 0, gi = 0, ri = 0;
    const cCol = this.coreMesh.instanceColor.array;
    const gCol = this.glowMesh.instanceColor.array;
    const rA = this._ribA.array, rB = this._ribB.array;
    const rCol = this._ribCol.array, rFade = this._ribFade.array, rW = this._ribW.array;

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
      cCol[ci * 3] = Math.min(1.05, p.cr * 0.90 + 0.09) * k;
      cCol[ci * 3 + 1] = Math.min(1.05, p.cg * 0.90 + 0.075) * k;
      cCol[ci * 3 + 2] = Math.min(1.05, p.cb * 0.90 + 0.06) * k;
      ci++;

      if (!cam) continue;

      // GLOW — one tight head sprite. Small and low: §9 will not have a bolt
      // laying a 0.8 m disc of light on the floor it is flying over.
      const headS = p.radius * 1.90 * p.size * k;
      _m.compose(_v.set(p.x, p.y, p.z), _qc, _s.set(headS, headS, headS));
      this.glowMesh.setMatrixAt(gi, _m);
      gCol[gi * 3] = p.cr * 0.21 * k; gCol[gi * 3 + 1] = p.cg * 0.21 * k; gCol[gi * 3 + 2] = p.cb * 0.21 * k;
      gi++;

      // STREAK — stitch (head, h0 .. h(n-1)) into a continuous tapered ribbon.
      // Point i is i steps behind the head; q is its position along the trail
      // (1 at the head, 0 at the tail). Width tapers to a needle and value
      // falls faster than width, so the tail bleeds out instead of stopping.
      const n = p.hn;
      if (n < 1) continue;
      const wHead = p.radius * 1.06 * p.size;
      const kk = k * 0.92;
      let px = p.x, py = p.y, pz = p.z;         // newer end of the segment
      let wN = wHead, fN = kk;
      for (let g = 0; g < n && ri < RIB_CAP; g++) {
        const ox = p.hx[g], oy = p.hy[g], oz = p.hz[g];   // older end
        const dx = ox - px, dy = oy - py, dz = oz - pz;
        if (dx * dx + dy * dy + dz * dz > 1e-8) {
          const qO = Math.max(0, 1 - (g + 1) / TRAIL);
          const wO = wHead * Math.pow(qO, 0.80);
          const fO = kk * Math.pow(qO, 1.70);
          const o3 = ri * 3, o2 = ri * 2;
          rA[o3] = ox; rA[o3 + 1] = oy; rA[o3 + 2] = oz;
          rB[o3] = px; rB[o3 + 1] = py; rB[o3 + 2] = pz;
          rCol[o3] = p.cr; rCol[o3 + 1] = p.cg; rCol[o3 + 2] = p.cb;
          rFade[o2] = fO; rFade[o2 + 1] = fN;
          rW[o2] = wO; rW[o2 + 1] = wN;
          ri++;
          wN = wO; fN = fO;
        }
        px = ox; py = oy; pz = oz;
      }
    }
    this.coreMesh.count = ci;
    this.glowMesh.count = gi;
    this.ribMesh.count = ri;
    if (ci) { this.coreMesh.instanceMatrix.needsUpdate = true; this.coreMesh.instanceColor.needsUpdate = true; }
    if (gi) { this.glowMesh.instanceMatrix.needsUpdate = true; this.glowMesh.instanceColor.needsUpdate = true; }
    if (ri) {
      this._ribA.needsUpdate = true; this._ribB.needsUpdate = true;
      this._ribCol.needsUpdate = true; this._ribFade.needsUpdate = true; this._ribW.needsUpdate = true;
    }
  }

  dispose() {
    this.coreMesh?.geometry.dispose(); this.coreMesh?.material.dispose();
    this.glowMesh?.geometry.dispose(); this.glowMesh?.material.dispose();
    this.ribMesh?.geometry.dispose(); this.ribMesh?.material.dispose();
    this.glowTex?.dispose();
    if (this.root?.parent) this.root.parent.remove(this.root);
  }
}

export default ProjectileSystem;
