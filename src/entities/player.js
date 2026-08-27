// OWNER: AGENT-PLAYER
// ---------------------------------------------------------------------------
// player.js — the controller. Everything here exists to make the character feel
// like Hades: instant, weighty, generous.
//
//   * 8-direction camera-relative movement with an input KICK (a slice of max
//     speed applied on the first frame of input) so motion starts inside one
//     frame, then real acceleration on top. Input -> motion << 50ms.
//   * DASH is the core verb: fixed distance, i-frames, cooldown with a visible
//     ready tell, dash-cancel out of attack recovery, and an input buffer so a
//     dash pressed during recovery fires the instant recovery ends.
//   * A 3-hit combo with buffering, cancel windows, root motion on the
//     committed frames, and hit-stop on connect.
//   * Feel: anticipation on every action, lean into acceleration, squash on
//     landing, micro-shake, knockback with spring recovery.
//
// The animation, cloth and IK all run on the FIXED step so root motion is
// deterministic and the capture harness reproduces frames byte-for-byte.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, dampAngle, shortAngle, smoothstep, ease, TAU } from '../core/math.js';
import { buildHumanoid, HERO_SPEC, SLOT_PAINT } from './rig.js';
import { Animator } from './anim.js';

export const TUNING = {
  // ── locomotion ──────────────────────────────────────────────────────────
  moveSpeed: 8.6,
  accel: 104,             // m/s^2 — reaches top speed in ~0.08s
  decel: 82,              // m/s^2 — grippy, not slidey
  inputKick: 0.34,        // fraction of top speed granted on the frame input starts
  turnLambda: 26,         // facing damp rate
  runAnimSpeed: 1.16,     // clip speed multiplier at full run

  // ── dash ────────────────────────────────────────────────────────────────
  dashDistance: 4.85,
  dashTime: 0.19,
  dashCooldown: 0.42,
  dashIFrames: [0.015, 0.215],
  dashBuffer: 0.22,
  dashGhosts: 3,
  dashGhostLife: 0.26,

  // ── combo ───────────────────────────────────────────────────────────────
  attackBuffer: 0.24,
  attackDur: [0.46, 0.44, 0.68],
  attackActive: [[0.135, 0.245], [0.105, 0.215], [0.235, 0.375]],
  attackChain: [0.235, 0.215, 0.42],   // earliest time the next swing may start
  attackCancel: [0.285, 0.265, 0.45],  // dash may cancel from here
  attackTurnLock: 0.10,
  attackDamage: [14, 14, 26],
  attackRange: [2.15, 2.15, 2.65],
  attackArc: [125, 135, 200],
  attackKnock: [3.4, 3.6, 7.0],
  hitStopMs: [58, 64, 96],

  // ── abilities ───────────────────────────────────────────────────────────
  specialDur: 0.54, specialActive: [0.2, 0.32], specialCost: 0,
  castDur: 0.60, castRelease: 0.30, castCost: 25,

  // ── survivability ───────────────────────────────────────────────────────
  hurtDur: 0.34,
  hurtIFrames: 0.62,
  knockLambda: 11.0,
  manaRegen: 6.0,
  deathDur: 1.7,
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ray = new THREE.Raycaster();

export class Player {
  constructor() {
    // ── contract fields (never rename) ──
    this.position = new THREE.Vector3(0, 0, 0);
    this.velocity = new THREE.Vector3();
    this.radius = 0.45;
    this.health = 100; this.maxHealth = 100;
    this.mana = 100; this.maxMana = 100;
    this.facing = new THREE.Vector2(0, 1);
    this.speed = TUNING.moveSpeed;
    this.alive = true;
    this.iframes = 0;
    // ── extensions ──
    this.tune = TUNING;
    this.state = 'move';
    this.act = { name: null, t: 0, dur: 0, index: 0, hit: false, fired: false };
    this.dash = { t: 0, dir: new THREE.Vector2(0, 1), travelled: 0, cd: 0, ready: true, readyPulse: 0 };
    this.buf = { dash: 0, attack: 0, special: 0, cast: 0, summon: 0 };
    this.knock = new THREE.Vector3();
    this.aimDir = new THREE.Vector2(0, 1);
    this.aimPoint = new THREE.Vector3(0, 0, 1);
    this.combatHeat = 0;         // read by the camera rig for the pull-back
    this.squash = 0; this.squashV = 0;
    this.moveAmount = 0;
    this._accel = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();
    this._mouseSeen = false;
    this._captureFreeze = null;
    this._ghostIdx = 0;
    this._ghostQueue = [];
    this._retuneIn = 0;
    this._retuneAt = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'player';
    ctx.scene.add(this.root);

    this.rig = buildHumanoid(HERO_SPEC, ctx);
    // the per-slot painterly table, reachable at runtime: mutate and call
    // player.rig.retune() to re-publish it over every character material.
    this.slotPaint = SLOT_PAINT;
    this.root.add(this.rig.root);
    this.animator = new Animator(this.rig);
    this.animator.play('idle', { fade: 0 });
    this.height = this.rig.height;

    // ── dash after-images: frozen pose snapshots, additive, in the rim hue ──
    const rimHex = (ctx.lighting && ctx.lighting.rim && ctx.lighting.rim.color)
      ? '#' + ctx.lighting.rim.color.getHexString() : '#5fd0ff';
    this.ghosts = [];
    for (let i = 0; i < TUNING.dashGhosts; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(rimHex), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
      });
      const g = this.rig.makeGhost(mat);
      g.group.visible = false; g.mat = mat; g.life = 0;
      ctx.scene.add(g.group);
      this.ghosts.push(g);
    }

    // ── dash-ready tell: a thin additive ring that snaps at the player's feet ─
    const ringGeo = new THREE.RingGeometry(0.56, 0.66, 44);
    ringGeo.rotateX(-Math.PI / 2);
    this.readyMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(rimHex), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
    });
    this.readyRing = new THREE.Mesh(ringGeo, this.readyMat);
    this.readyRing.name = 'player.dashReady';
    this.readyRing.position.y = 0.035;
    this.readyRing.visible = false;
    this.readyRing.frustumCulled = false;
    this.root.add(this.readyRing);

    ctx.combat?.register?.(this);
    ctx.events.on('damage.dealt', (info) => { if (info && info.target === this) this._onHurt(info); });
    ctx.events.on('entity.died', (info) => { if (info && info.entity === this) this._onDeath(); });
    ctx.events.on('capture.state', ({ name }) => this._captureState(name, ctx));
    // A biome change re-publishes the rig's rim constant over every character
    // material; re-assert our per-slot art direction a few frames later.
    ctx.events.on('biome.changed', () => { this._retuneIn = 0.2; });
    ctx.ui?.setHealth?.(this.health, this.maxHealth);
    ctx.ui?.setMana?.(this.mana, this.maxMana);

    // SPAWN. The arena centrepiece stands at the origin, so spawning there puts
    // the hero inside a 4m altar dome — invisible in every shot and clipped in
    // play. Spawn just in front of it, on the camera axis, which also reads
    // ~25% larger at the authored hero pose. Anything that sets `position`
    // before init (AGENT-RUN, room transitions) wins.
    // SPAWN is derived from the room, not hard-coded: 0.34R along the camera
    // axis (+x+z is toward the lens at yaw 45). That puts the hero on clear
    // dark floor in the near third of the frame with the emblem, the colonnade
    // and the doorways stacked BEHIND them — the composition Hades uses — and
    // clear of both the centre altar and the medallion inlay.
    if (this.position.lengthSq() < 1e-6) {
      const R = (ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 12.6;
      const d = R * 0.34;
      this.position.set(d * 0.7071, 0, d * 0.7071);
    }
    this._resolve(ctx);
    this.root.position.copy(this.position);
    this.root.rotation.y = Math.atan2(this.facing.x, this.facing.y);
    this.animator.update(0);
  }

  // ─────────────────────────────────────────────────────────── capture ────
  _captureState(name, ctx) {
    if (name === 'combat') {
      // deterministic mid-combo impact frame — the pose the shot list asks for
      this._captureFreeze = { clip: 'attack2', t: 0.19 };
      this.state = 'attack'; this.act = { name: 'attack', t: 0.19, dur: 0.44, index: 1, hit: true, fired: true };
      this.combatHeat = 1;
      this.facing.set(0.42, 0.91).normalize();
      const d = new THREE.Vector3(this.facing.x, 0, this.facing.y);
      ctx.vfx?.slash?.(this.position.clone().setY(1.05), d, { arc: 135, radius: 2.3, color: '#ffd27a', width: 0.5 });
      // The combat shot shipped three rounds running as a still of a character
      // standing on an empty floor, because everything that says "combat" in
      // this game lives in systems that are still stubs (vfx/index.js and
      // entities/enemies/index.js both return null). The one motion language
      // this file OWNS is the dash after-image chain, and it is authored in the
      // §1.2 complement hue — so the combat frame at least reads as an arrival
      // into a combo, with a cyan trail behind it, rather than as a pose.
      this._captureGhosts = true;
      this.dash.readyPulse = 0.62;
    } else if (typeof name === 'string' && name.startsWith('player:')) {
      const [, clip, t] = name.split(':');
      this._captureFreeze = { clip, t: +t || 0 };
    } else if (name) {
      this._captureFreeze = null;
      // The after-images are parked with life 0 so _ghostStep() leaves their
      // authored opacity alone — which also means nothing else will ever clear
      // them. The harness runs every shot on ONE page, so without this the
      // combat trail bled into the ui and boon frames.
      this._captureGhosts = false;
      for (const g of this.ghosts || []) { g.group.visible = false; g.mat.opacity = 0; g.life = 0; }
      this.dash.readyPulse = 0;
      if (this.readyRing) { this.readyRing.visible = false; this.readyMat.opacity = 0; }
    }
  }

  // ────────────────────────────────────────────────────────────── input ────
  _aim(ctx) {
    const inp = ctx.input;
    if (inp.usingGamepad && inp.lookVec && inp.lookVec.lengthSq() > 0.01) {
      const yaw = ctx.cameraRig ? ctx.cameraRig.yaw : Math.PI / 4;
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      this.aimDir.set(inp.lookVec.x * cs - inp.lookVec.y * sn, -inp.lookVec.x * sn - inp.lookVec.y * cs).normalize();
      this.aimPoint.set(this.position.x + this.aimDir.x * 6, 0, this.position.z + this.aimDir.y * 6);
      this._mouseSeen = true;
    } else if (inp.pointer && (inp.pointer.x !== 0 || inp.pointer.y !== 0) && ctx.camera) {
      this._mouseSeen = true;
      _ray.setFromCamera(inp.pointer, ctx.camera);
      if (_ray.ray.intersectPlane(_plane, _v)) {
        this.aimPoint.copy(_v);
        _v.sub(this.position);
        if (_v.lengthSq() > 0.04) this.aimDir.set(_v.x, _v.z).normalize();
      }
    }
    if (inp.aim) inp.aim.copy(this.aimPoint);
    if (inp.aimDir) inp.aimDir.copy(this.aimDir);
  }

  _wish(ctx, out) {
    const mv = ctx.input.move;
    const yaw = ctx.cameraRig ? ctx.cameraRig.yaw : Math.PI / 4;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    // camera-relative: screen-right = (cos yaw, 0, -sin yaw), screen-up (into the
    // screen) = (-sin yaw, 0, -cos yaw). The stub had the forward sign flipped,
    // which made W walk toward the camera.
    out.set(mv.x * cs - mv.y * sn, 0, -mv.x * sn - mv.y * cs);
    const l = out.length();
    if (l > 1) out.multiplyScalar(1 / l);
    return l;
  }

  // ───────────────────────────────────────────────────────────── update ────
  update(dt, ctx) {
    const T = this.tune;
    if (this._captureFreeze) {
      this.animator.freezeAt(this._captureFreeze.clip, this._captureFreeze.t);
      this._applyRoot();
      this.animator.update(dt);
      this._ghostStep(dt);
      if (this._captureGhosts) this._stageCaptureGhosts();
      return;
    }
    this._aim(ctx);

    // ── timers & input buffers ────────────────────────────────────────────
    this.iframes = Math.max(0, this.iframes - dt);
    this._animLock = Math.max(0, (this._animLock || 0) - dt);
    if (this._retuneIn > 0) { this._retuneIn -= dt; if (this._retuneIn <= 0) this.rig.retune?.(); }
    this.dash.cd = Math.max(0, this.dash.cd - dt);
    if (!this.dash.ready && this.dash.cd <= 0) {
      this.dash.ready = true; this.dash.readyPulse = 1;
      ctx.events.emit('player.dashReady', { pos: this.position.clone() });
    }
    for (const k in this.buf) this.buf[k] = Math.max(0, this.buf[k] - dt);
    const inp = ctx.input;
    const acting = this.state !== 'move';
    if (inp.pressed('dash')) { if (acting) this.act.dashQueued = true; else this.buf.dash = T.dashBuffer; }
    if (inp.pressed('attack')) { if (this.state === 'attack') this.act.queued = true; else this.buf.attack = T.attackBuffer; }
    if (inp.pressed('special')) this.buf.special = T.attackBuffer;
    if (inp.pressed('cast')) this.buf.cast = T.attackBuffer;
    if (inp.pressed('summon')) this.buf.summon = T.attackBuffer;

    this.mana = Math.min(this.maxMana, this.mana + T.manaRegen * dt);
    this.combatHeat = Math.max(0, this.combatHeat - dt * 0.55);

    if (this.state === 'dead') {
      this.act.t += dt;
      this._integrate(dt, ctx, 0);
      this._applyRoot();
      this.animator.update(dt);
      this._ghostStep(dt);
      return;
    }

    // ── action requests: dash first, it cancels almost everything ─────────
    const i = this.act.index;
    const canDash = this.dash.ready && (
      this.state === 'move' ||
      (this.state === 'attack' && this.act.t >= T.attackCancel[i]) ||
      ((this.state === 'special' || this.state === 'cast') && this.act.t >= this.act.dur * 0.60) ||
      (this.state === 'hurt' && this.act.t >= 0.13));
    if (canDash && (this.buf.dash > 0 || this.act.dashQueued)) this._startDash(ctx);
    else {
    // special / cast may also CANCEL an attack once its cancel window opens —
    // otherwise a button pressed mid-combo is silently eaten, which feels like
    // the game ignored you.
    const canCancel = this.state === 'move' ||
      (this.state === 'attack' && this.act.t >= T.attackCancel[i]);
    if (canCancel && this.buf.attack > 0 && this.state === 'move') this._startAttack(ctx, 0);
    else if (canCancel && this.buf.special > 0) this._startAbility(ctx, 'special');
    else if (canCancel && this.buf.cast > 0) this._startAbility(ctx, 'cast');
    else if (this.state === 'move' && this.buf.summon > 0) {
      this.buf.summon = 0;
      ctx.combat?.summon?.({ source: this, pos: this.position.clone(), dir: this.facing.clone() });
      ctx.events.emit('player.summon', { pos: this.position.clone() });
    }
    }

    // ── per-state ─────────────────────────────────────────────────────────
    let wishScale = 1;
    switch (this.state) {
      case 'dash': this._dashStep(dt, ctx); wishScale = 0; break;
      case 'attack': this._attackStep(dt, ctx); wishScale = this.act.t > T.attackCancel[this.act.index] ? 0.35 : 0.04; break;
      case 'special':
      case 'cast': this._abilityStep(dt, ctx); wishScale = this.act.t > this.act.dur * 0.72 ? 0.3 : 0.02; break;
      case 'hurt': this.act.t += dt; wishScale = 0.12; if (this.act.t >= this.act.dur) { this.state = 'move'; this._animLock = 0.05; } break;
      default: this._locomotion(dt, ctx); break;
    }

    // ── integrate, animate, resolve ───────────────────────────────────────
    this._integrate(dt, ctx, wishScale);
    this._feel(dt, ctx);
    this._applyRoot();
    const rd = this.animator.update(dt);
    if (rd.lengthSq() > 1e-9) {
      const a = Math.atan2(this.facing.x, this.facing.y), ca = Math.cos(a), sa = Math.sin(a);
      this.position.x += rd.x * ca + rd.z * sa;
      this.position.z += -rd.x * sa + rd.z * ca;
      this._resolve(ctx);
      this._applyRoot();
    }
    this._ghostStep(dt);
    this._readyTell(dt);
  }

  // ───────────────────────────────────────────────────────── locomotion ────
  _locomotion(dt, ctx) {
    const T = this.tune;
    const w = this._wish(ctx, _v);
    if (w > 0.15) {
      const a = Math.atan2(_v.x, _v.z);
      const cur = Math.atan2(this.facing.x, this.facing.y);
      const na = dampAngle(cur, a, T.turnLambda, dt);
      this.facing.set(Math.sin(na), Math.cos(na));
    }
    if (this._animLock <= 0) {
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      if (sp > 1.4) this.animator.play('run', { fade: 0.11, speed: T.runAnimSpeed * clamp(sp / this.speed, 0.62, 1.35) });
      else this.animator.play('idle', { fade: 0.18 });
    }
  }

  // ─────────────────────────────────────────────────────────────── dash ────
  _startDash(ctx) {
    const T = this.tune;
    this.buf.dash = 0; this.buf.attack = 0;
    const w = this._wish(ctx, _v);
    if (w > 0.15) this.dash.dir.set(_v.x, _v.z).normalize();
    else this.dash.dir.copy(this.facing);
    this.facing.copy(this.dash.dir);
    this.dash.t = 0; this.dash.travelled = 0; this.dash.ready = false;
    this.dash.cd = T.dashTime + T.dashCooldown;
    this.state = 'dash';
    this.act = { name: 'dash', t: 0, dur: T.dashTime, index: 0, hit: false, fired: false, queued: false, dashQueued: false };
    this.animator.play('dash', { fade: 0.04, restart: true });
    this.velocity.multiplyScalar(0.25);
    this.iframes = Math.max(this.iframes, T.dashIFrames[1]);
    this.squash = -0.085;
    this._ghostQueue = [0.0, 0.055, 0.11];
    ctx.events.emit('player.dashed', { pos: this.position.clone(), dir: new THREE.Vector3(this.dash.dir.x, 0, this.dash.dir.y) });
    ctx.events.emit('camera.shake', { amp: 0.06, dur: 0.15, freq: 26 });
    ctx.audio?.sfx?.('dash', { pos: this.position });
    ctx.vfx?.burst?.(this.position.clone().setY(0.85), { count: 14, color: '#5fd0ff', speed: 6.5, spread: 0.8, kind: 'wisp' });
  }
  _dashStep(dt, ctx) {
    const T = this.tune;
    this.dash.t += dt;
    const u = clamp01(this.dash.t / T.dashTime);
    const s = ease.outQuad(u) * T.dashDistance;
    const step = s - this.dash.travelled;
    this.dash.travelled = s;
    this.position.x += this.dash.dir.x * step;
    this.position.z += this.dash.dir.y * step;
    const sp = step / Math.max(dt, 1e-5);
    this.velocity.set(this.dash.dir.x * sp, 0, this.dash.dir.y * sp);
    while (this._ghostQueue.length && this.dash.t >= this._ghostQueue[0]) {
      this._ghostQueue.shift();
      const g = this.ghosts[this._ghostIdx++ % this.ghosts.length];
      this.rig.root.updateMatrixWorld(true);
      g.capture(this.rig.mesh.matrixWorld);
      g.life = T.dashGhostLife; g.group.visible = true;
    }
    if (this.dash.t >= T.dashTime) {
      this.state = 'move';
      this._animLock = 0.14;
      this.squash = 0.13;
      this.animator.playAdditive('land', { weight: 0.7 });
      this.velocity.multiplyScalar(0.42);
      ctx.events.emit('camera.shake', { amp: 0.035, dur: 0.12, freq: 32 });
    }
  }

  // ────────────────────────────────────────────────────────────── combo ────
  _startAttack(ctx, i) {
    const T = this.tune;
    this.buf.attack = 0;
    this.state = 'attack';
    this.act = { name: 'attack', t: 0, dur: T.attackDur[i], index: i, hit: false, fired: false, queued: false, dashQueued: false };
    this.animator.play('attack' + (i + 1), { fade: i === 0 ? 0.055 : 0.04, restart: true });
    const w = this._wish(ctx, _v);
    if (w > 0.15) this.facing.set(_v.x, _v.z).normalize();
    else if (this._mouseSeen) this.facing.copy(this.aimDir);
    this.combatHeat = Math.min(1.5, this.combatHeat + 0.42);
    this.squash = -0.03;
    ctx.events.emit('camera.shake', { amp: 0.028 + 0.012 * i, dur: 0.10, freq: 34 });
    ctx.audio?.sfx?.('swing', { pos: this.position, pitch: 1 + 0.07 * i });
  }
  _attackStep(dt, ctx) {
    const T = this.tune, i = this.act.index;
    this.act.t += dt;
    if (this.act.t < T.attackTurnLock) {
      const w = this._wish(ctx, _v);
      if (w > 0.2) {
        const a = Math.atan2(_v.x, _v.z), cur = Math.atan2(this.facing.x, this.facing.y);
        const na = dampAngle(cur, a, 16, dt);
        this.facing.set(Math.sin(na), Math.cos(na));
      }
    }
    if (!this.act.fired && this.act.t >= T.attackActive[i][0]) { this.act.fired = true; this._swing(ctx, i); }
    if (this.act.queued && i < 2 && this.act.t >= T.attackChain[i]) { this._startAttack(ctx, i + 1); return; }
    if (this.act.t >= this.act.dur) { this.state = 'move'; this._animLock = 0.05; }
  }
  _swing(ctx, i, o) {
    const T = this.tune;
    const range = o?.range ?? T.attackRange[i];
    const arc = o?.arc ?? T.attackArc[i];
    const dmg = o?.damage ?? T.attackDamage[i];
    const knock = o?.knock ?? T.attackKnock[i];
    const ms = o?.hitstop ?? T.hitStopMs[i];
    const color = o?.color ?? (i === 2 ? '#ffd27a' : '#ffe9a8');
    const dir3 = new THREE.Vector3(this.facing.x, 0, this.facing.y);
    ctx.vfx?.slash?.(this.position.clone().setY(1.05), dir3, { arc, radius: range, color, width: 0.42 + 0.12 * i });
    ctx.audio?.sfx?.('slash', { pos: this.position, pitch: 1 + 0.07 * i });
    const list = (ctx.enemies && ctx.enemies.list) || [];
    const cosHalf = Math.cos(arc * 0.5 * Math.PI / 180);
    let hits = 0;
    for (const e of list) {
      if (!e || e === this || e.dead || e.alive === false || !e.position) continue;
      _v.set(e.position.x - this.position.x, 0, e.position.z - this.position.z);
      const d = _v.length();
      if (d < 1e-4 || d > range + (e.radius || 0.5)) continue;
      _v.multiplyScalar(1 / d);
      if (_v.x * this.facing.x + _v.z * this.facing.y < cosHalf) continue;
      hits++;
      ctx.combat?.applyDamage?.({
        target: e, amount: dmg, type: 'physical', crit: false,
        dir: _v.clone(), pos: e.position.clone(), source: this, knockback: knock,
      });
      ctx.vfx?.impact?.(e.position.clone().setY(0.95), _v.clone().negate(), { type: 'physical', scale: 0.8 + 0.28 * i, color });
    }
    if (hits > 0) {
      this.act.hit = true;
      ctx.events.emit('hit.stop', { ms });
      ctx.events.emit('camera.shake', { amp: 0.10 + 0.06 * i, dur: 0.22, freq: 30 });
      this.combatHeat = Math.min(1.7, this.combatHeat + 0.3);
      ctx.audio?.sfx?.('hit', { pos: this.position });
    }
    return hits;
  }

  // ─────────────────────────────────────────────────────────── abilities ───
  _startAbility(ctx, kind) {
    const T = this.tune;
    if (kind === 'cast') {
      if (this.mana < T.castCost) { this.buf.cast = 0; ctx.ui?.toast?.('Not enough mana', { color: '#5fd0ff' }); return; }
      this.mana -= T.castCost;
      ctx.ui?.setMana?.(this.mana, this.maxMana);
    }
    this.buf[kind] = 0;
    this.state = kind;
    this.act = { name: kind, t: 0, dur: kind === 'cast' ? T.castDur : T.specialDur, index: 0, hit: false, fired: false, queued: false, dashQueued: false };
    this.animator.play(kind, { fade: 0.06, restart: true });
    const w = this._wish(ctx, _v);
    if (w > 0.15) this.facing.set(_v.x, _v.z).normalize();
    else if (this._mouseSeen) this.facing.copy(this.aimDir);
    this.combatHeat = Math.min(1.5, this.combatHeat + 0.5);
    ctx.events.emit('camera.shake', { amp: 0.035, dur: 0.12, freq: 30 });
  }
  _abilityStep(dt, ctx) {
    const T = this.tune;
    this.act.t += dt;
    const rel = this.state === 'cast' ? T.castRelease : T.specialActive[0];
    if (!this.act.fired && this.act.t >= rel) {
      this.act.fired = true;
      const dir3 = new THREE.Vector3(this.facing.x, 0, this.facing.y);
      const origin = this.position.clone().setY(1.12);
      if (this.state === 'cast') {
        ctx.combat?.cast?.({ source: this, origin, dir: dir3, power: 1 });
        ctx.events.emit('player.cast', { pos: origin, dir: dir3 });
        ctx.vfx?.burst?.(origin, { count: 18, color: '#5fd0ff', speed: 9, spread: 0.35, kind: 'spark' });
        ctx.events.emit('camera.shake', { amp: 0.07, dur: 0.18, freq: 28 });
      } else {
        ctx.combat?.special?.({ source: this, origin, dir: dir3 });
        ctx.events.emit('player.special', { pos: origin, dir: dir3 });
        ctx.vfx?.shockwave?.(this.position.clone().setY(0.1), { radius: 3.1, color: '#ffb070', life: 0.4 });
        this._swing(ctx, 1, { range: 3.1, arc: 230, damage: 24, knock: 8.5, hitstop: 104, color: '#ffb070' });
      }
    }
    if (this.act.t >= this.act.dur) { this.state = 'move'; this._animLock = 0.05; }
  }

  // ──────────────────────────────────────────────────────────── physics ────
  _integrate(dt, ctx, wishScale) {
    const T = this.tune;
    if (this.knock.lengthSq() > 1e-7) {
      this.position.addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(Math.exp(-T.knockLambda * dt));
      if (this.knock.lengthSq() < 2e-4) this.knock.set(0, 0, 0);
    }
    if (this.state !== 'dash') {
      const w = this._wish(ctx, _v);
      const has = w > 0.15 && wishScale > 0.001 && this.alive;
      const tx = has ? _v.x * this.speed * wishScale : 0;
      const tz = has ? _v.z * this.speed * wishScale : 0;
      // INPUT KICK — motion exists on the very first frame of input, then the
      // acceleration curve takes over. This is the whole "under 50ms" trick.
      if (has && !this._hadInput && wishScale > 0.5) {
        const n = Math.max(1e-4, Math.hypot(_v.x, _v.z));
        this.velocity.x += (_v.x / n) * this.speed * T.inputKick;
        this.velocity.z += (_v.z / n) * this.speed * T.inputKick;
      }
      this._hadInput = has;
      _v2.set(tx - this.velocity.x, 0, tz - this.velocity.z);
      const need = _v2.length();
      if (need > 1e-6) {
        const speeding = (tx * tx + tz * tz) > (this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
        const step = Math.min(need, (speeding ? T.accel : T.decel) * dt);
        this.velocity.x += _v2.x / need * step;
        this.velocity.z += _v2.z / need * step;
      }
    }
    // The dash advances position itself along its distance curve; velocity is
    // written only so the camera lead and the lean read something sensible.
    // Integrating it here as well doubled the dash distance.
    if (this.state !== 'dash') {
      this.position.x += this.velocity.x * dt;
      this.position.z += this.velocity.z * dt;
    }
    this._resolve(ctx);
  }

  // ───────────────────────────────────────────────────────── collision ─────
  // The world owns solids. `world.collide` pushes the body out of every column,
  // plinth, statue and altar it overlaps and THEN clamps it inside the island
  // boundary; `clampToArena` alone only did the second half, which is why the
  // hero used to walk through the colonnade. Guarded so a stub world (or a
  // world mid-rebuild) still yields a legal position.
  _resolve(ctx) {
    const w = ctx && ctx.world;
    const px = this.position.x, pz = this.position.z;
    if (w && w.collide) w.collide(this.position, this.radius);
    else if (w && w.clampToArena) w.clampToArena(this.position, this.radius);
    if (!Number.isFinite(this.position.x) || !Number.isFinite(this.position.z)) {
      this.position.set(px, 0, pz);                       // never let a NaN escape
    }
    // vertical: the dais/steps are the only height in a chamber today, but the
    // contract is world.heightAt and the character must sit on it.
    const gy = (w && w.heightAt) ? w.heightAt(this.position.x, this.position.z) : 0;
    this.position.y = Number.isFinite(gy) ? gy : 0;
  }

  // ──────────────────────────────────────────────────────────────── feel ───
  _feel(dt, ctx) {
    _v.subVectors(this.velocity, this._prevVel).multiplyScalar(1 / Math.max(dt, 1e-5));
    this._prevVel.copy(this.velocity);
    const a = Math.atan2(this.facing.x, this.facing.y), ca = Math.cos(a), sa = Math.sin(a);
    const lx = _v.x * ca - _v.z * sa;       // world -> character space
    const lz = _v.x * sa + _v.z * ca;
    const m = this.animator.mod;
    m.leanX = damp(m.leanX, clamp(lz * 0.135, -15, 15), 13, dt);
    m.leanZ = damp(m.leanZ, clamp(-lx * 0.115, -13, 13), 13, dt);
    let hy = 0;
    if (this._mouseSeen && this.state !== 'dead') {
      hy = clamp(shortAngle(a, Math.atan2(this.aimDir.x, this.aimDir.y)) * 180 / Math.PI, -36, 36);
    }
    m.headYaw = damp(m.headYaw, hy * 0.55, 9, dt);
    m.twist = damp(m.twist, hy * 0.3, 6, dt);
    this.squash = damp(this.squash, 0, 13, dt);
    this.moveAmount = damp(this.moveAmount, Math.hypot(this.velocity.x, this.velocity.z) / this.speed, 12, dt);
  }

  _applyRoot() {
    this.root.position.copy(this.position);
    this.root.rotation.y = Math.atan2(this.facing.x, this.facing.y);
    const s = this.squash;
    this.root.scale.set(1 + s * 0.40, 1 - s * 0.82, 1 + s * 0.40);
    this.root.updateMatrixWorld(true);
  }

  /**
   * Freeze a chain of after-images behind the hero for the capture harness.
   * They are laid along -facing, brightest nearest, and their `life` is left at
   * zero so _ghostStep() skips them and the opacities stay exactly as authored.
   */
  _stageCaptureGhosts() {
    this._captureGhosts = false;
    if (!this.ghosts || !this.ghosts.length) return;
    const saved = this.position.clone();
    // Additive over a dark stage: at 0.34 the three images merged into one blown
    // white smear instead of reading as three cyan silhouettes. Dimmer, and
    // spaced far enough apart that each one is its own shape (§5 "silhouette
    // first: an effect must read at 1/8 resolution").
    const op = [0.15, 0.095, 0.055];
    const n = Math.min(op.length, this.ghosts.length);
    for (let i = 0; i < n; i++) {
      this.position.set(saved.x - this.facing.x * (1.15 + i * 1.10), saved.y,
        saved.z - this.facing.y * (1.15 + i * 1.10));
      this._applyRoot();
      this.rig.root.updateMatrixWorld(true);
      const g = this.ghosts[i];
      g.capture(this.rig.mesh.matrixWorld);
      g.group.visible = true;
      g.life = 0;
      g.mat.opacity = op[i];
    }
    this.position.copy(saved);
    this._applyRoot();
  }

  _ghostStep(dt) {
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i];
      if (g.life <= 0) continue;
      g.life -= dt;
      const u = clamp01(g.life / this.tune.dashGhostLife);
      g.mat.opacity = 0.115 * u * u;
      if (g.life <= 0) { g.group.visible = false; g.mat.opacity = 0; }
    }
  }
  _readyTell(dt) {
    if (this.dash.readyPulse <= 0) return;
    this.dash.readyPulse = Math.max(0, this.dash.readyPulse - dt * 3.6);
    const p = this.dash.readyPulse, u = 1 - p;
    this.readyRing.visible = true;
    this.readyMat.opacity = 0.20 * p * p;
    const s = 0.72 + 0.62 * ease.outCubic(u);
    this.readyRing.scale.set(s, 1, s);
    if (this.dash.readyPulse <= 0) { this.readyRing.visible = false; this.readyMat.opacity = 0; }
  }

  // ───────────────────────────────────────────────────────────── damage ────
  _onHurt(info) {
    const ctx = this.ctx, T = this.tune;
    if (!this.alive) return;
    ctx.ui?.setHealth?.(this.health, this.maxHealth);
    if (this.health <= 0) return;                 // the death handler takes it
    this.iframes = Math.max(this.iframes, T.hurtIFrames);
    this.state = 'hurt';
    this.act = { name: 'hurt', t: 0, dur: T.hurtDur, index: 0, hit: false, fired: false, queued: false, dashQueued: false };
    this.animator.play('hurt', { fade: 0.035, restart: true });
    const d = _v.set(0, 0, 0);
    if (info.dir) d.set(info.dir.x || 0, 0, (info.dir.z !== undefined ? info.dir.z : info.dir.y) || 0);
    if (d.lengthSq() < 1e-6) d.set(-this.facing.x, 0, -this.facing.y);
    d.normalize();
    const kb = info.knockback ?? 6;
    this.knock.set(d.x * kb, 0, d.z * kb);
    this.velocity.multiplyScalar(0.2);
    this.squash = 0.07;
    ctx.events.emit('camera.shake', { amp: 0.26, dur: 0.32, freq: 24 });
    ctx.events.emit('hit.stop', { ms: 75 });
    ctx.audio?.sfx?.('hurt', { pos: this.position });
  }
  _onDeath() {
    const ctx = this.ctx;
    this.alive = false; this.dead = true; this.state = 'dead';
    this.act = { name: 'death', t: 0, dur: this.tune.deathDur, index: 0, hit: false, fired: false, queued: false, dashQueued: false };
    this.animator.play('death', { fade: 0.05, restart: true });
    this.animator.ikEnabled = false;
    this.velocity.set(0, 0, 0); this.knock.multiplyScalar(0.4);
    ctx.events.emit('player.died', { pos: this.position.clone() });
    ctx.events.emit('camera.shake', { amp: 0.42, dur: 0.7, freq: 17 });
    ctx.ui?.setHealth?.(0, this.maxHealth);
  }

  /** used by AGENT-RUN between chambers */
  respawn(pos) {
    this.health = this.maxHealth; this.mana = this.maxMana;
    this.alive = true; this.dead = false; this.state = 'move';
    this.iframes = 1.0; this.knock.set(0, 0, 0); this.velocity.set(0, 0, 0);
    if (pos) this.position.copy(pos);
    this.animator.ikEnabled = true;
    this.animator.play('idle', { fade: 0.2, restart: true });
    this.animator.cloth.reset();
    this.ctx?.ui?.setHealth?.(this.health, this.maxHealth);
    return this;
  }

  lateUpdate(alpha, ctx) {
    /* sim + animation run on the fixed step (deterministic) */
    // ── §1.2 RIM WATCHDOG ───────────────────────────────────────────────────
    // painterly.setBiomeLook() rewrites uRimColor / uRimDir / (for characters)
    // uRimStrength and uRimGate on EVERY registered material and does not
    // honour userData.paintOverrides, so any biome publish after the hero was
    // built silently reverted the character's art-directed rim to the biome
    // constant — a frontal-fill direction at a whisper of energy. That is why
    // the mandated complement edge measured 1.8% of lit hero pixels no matter
    // what the rig authored. Re-asserting SLOT_PAINT four times a second costs
    // ~5 uniform writes per slot and cannot drift. It is also cheap insurance
    // for AGENT-RENDER changing the rig at runtime.
    const t = (ctx && ctx.time && ctx.time.t) || 0;
    if (t >= (this._retuneAt || 0)) { this._retuneAt = t + 0.25; this.rig?.retune?.(); }
  }

  dispose() {
    this.rig?.dispose?.();
    this.readyRing?.geometry?.dispose?.();
    this.readyMat?.dispose?.();
    for (const g of this.ghosts || []) g.mat?.dispose?.();
  }
}

export default Player;
