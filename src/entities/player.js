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
//   * THE ARSENAL IS NOT HERE. entities/weapons.js owns every number that
//     decides what a swing does — windup, active frames, cancel marks, hitbox
//     shape, damage, knockback, hit-stop, VFX and SFX — and WeaponRuntime owns
//     the state machine that plays them. This file forwards the BUTTON and
//     maps the runtime's current step onto a pose. It never duplicates a
//     combat timing, which is why all four arms are reachable from one input
//     path instead of only the blade.
//   * Feel: anticipation on every action, lean into acceleration, squash on
//     landing, micro-shake, knockback with spring recovery.
//
// The animation, cloth and IK all run on the FIXED step so root motion is
// deterministic and the capture harness reproduces frames byte-for-byte.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, dampAngle, shortAngle, smoothstep, ease, TAU } from '../core/math.js';
import { buildHumanoid, HERO_SPEC, MELINOE_SPEC, SLOT_PAINT } from './rig.js';
import { createAvatarWeapons } from './player-weapons.js';
import { CHARACTER_INFO, characterInfo } from '../game/characters.js';
import { Animator } from './anim.js';
import { CAST_SHARD_MAX, castPresentation } from './cast.js';

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

  // ── input ───────────────────────────────────────────────────────────────
  // Attack and Special are NOT buffered here — WeaponRuntime has its own,
  // per-weapon buffer (weapons.js `buffer`), and two buffers stacked on one
  // button is how you get a swing you did not ask for. This is only for the
  // two verbs this file still owns.
  actionBuffer: 0.22,
  steerLambdaCommit: 15,   // facing damp inside an attack's turn window
  steerLambdaAim: 24,      // facing damp while charging or guarding

  // ── cast (weapon-agnostic: combat.js owns the bolt) ─────────────────────
  castDur: 0.60, castRelease: 0.30, castCost: 25,

  // ── survivability ───────────────────────────────────────────────────────
  hurtDur: 0.34,
  hurtIFrames: 0.62,
  knockLambda: 11.0,
  manaRegen: 6.0,
  deathDur: 1.7,
};

// ---------------------------------------------------------------------------
// THE RUNTIME -> POSE MAP.
//
// weapons.js names every combo step ('cut1', 'poke2', 'spin', 'loose'...) and
// WeaponRuntime publishes which one is live plus how long it lasts. That is
// everything an animator needs, so the mapping is a table, not a switch: a
// weapon key, a step name, a clip. The `_` entries cover the machine's
// non-combo states (charge / block / rush) and the fallback.
//
// TIME-SCALING, not re-authoring: each clip is played at
// `speed = clip.dur / step.dur`, so a clip authored once lands its
// anticipation on the step's WINDUP and its commit inside the step's ACTIVE
// window whatever weapons.js says those are today. Retuning a weapon retimes
// its animation for free, and no arm can ever play at another arm's rhythm.
// A weapon that plays the blade's clip is a bug, so every entry below is a
// pose authored for that arm — see anim.js §ARSENAL CLIPS.
// ---------------------------------------------------------------------------
export const WEAPON_ANIM = {
  blade:  { _fallback: 'attack1', _charge: 'attack3', _block: 'guard', _rush: 'dash',
            cut1: 'attack1', cut2: 'attack2', lunge: 'attack3', dashcut: 'dashSlash', sweep: 'special' },
  spear:  { _fallback: 'thrust1', _charge: 'throwWind', _block: 'guard', _rush: 'rush',
            poke1: 'thrust1', poke2: 'thrust2', dashthrust: 'dashThrust', spin: 'spin', loose: 'throw' },
  bow:    { _fallback: 'loose', _charge: 'draw', _block: 'guard', _rush: 'rush',
            loose: 'loose', kick: 'special', snapshot: 'loose' },
  shield: { _fallback: 'bash1', _charge: 'guard', _block: 'guard', _rush: 'rush',
            punch1: 'bash1', punch2: 'bash2' },
  fists:  { _fallback: 'bash1', _charge: 'guard', _block: 'guard', _rush: 'rush',
            jab1: 'bash1', jab2: 'bash2', jab3: 'attack1', jab4: 'bash2', dashupper: 'dashUpper', uppercut: 'special' },
  rail:   { _fallback: 'loose', _charge: 'draw', _block: 'guard', _rush: 'rush',
            loose: 'loose', bombard: 'castSweep', hipfire: 'loose' },
  staff:  { _fallback: 'thrust1', _charge: 'throwWind', _block: 'guard', _rush: 'rush',
            staff1: 'thrust1', staff2: 'spin', staff3: 'castSweep', loose: 'throw', dashstaff: 'dashThrust' },
  blades: { _fallback: 'attack1', _charge: 'draw', _block: 'guard', _rush: 'dash',
            knife1: 'attack1', knife2: 'attack2', knife3: 'attack3', shadowcut: 'dashSlash', loose: 'loose' },
  flames: { _fallback: 'loose', _charge: 'castRitual', _block: 'guard', _rush: 'rush',
            loose: 'cast', orbit: 'castSweep', dashflare: 'loose' },
  axe:    { _fallback: 'attack3', _charge: 'spin', _block: 'guard', _rush: 'rush',
            hew1: 'attack3', hew2: 'spin', moonwall: 'special', dashhew: 'dashSlash' },
  skull:  { _fallback: 'loose', _charge: 'castRitual', _block: 'guard', _rush: 'rush',
            loose: 'throw', skullrush: 'rush', dashskull: 'dashThrust' },
  coat:   { _fallback: 'bash1', _charge: 'guard', _block: 'guard', _rush: 'rush',
            gauntlet1: 'bash1', gauntlet2: 'bash2', gauntlet3: 'special', jetpunch: 'dashThrust', rockets: 'castSweep' },
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
    this.castMax = CAST_SHARD_MAX; this.castStock = CAST_SHARD_MAX;
    this.facing = new THREE.Vector2(0, 1);
    this.speed = TUNING.moveSpeed;
    this.alive = true;
    this.iframes = 0;
    // ── extensions ──
    this.tune = TUNING;
    this.state = 'move';
    this.act = { name: null, t: 0, dur: 0, index: 0, hit: false, fired: false };
    this.dash = { t: 0, dir: new THREE.Vector2(0, 1), travelled: 0, cd: 0, ready: true, readyPulse: 0 };
    this.buf = { dash: 0, cast: 0, summon: 0 };
    this.weapon = null;          // the live WeaponRuntime (combat.js owns it)
    this.blocking = null;        // set by WeaponRuntime while the guard is up
    this._animKey = null;        // last (weapon|state|step) we played a clip for
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
    this.characterId = 'zagreus';
  }

  async init(ctx) {
    this.ctx = ctx;
    this.root = new THREE.Group();
    this.root.name = 'player';
    ctx.scene.add(this.root);

    this._buildAvatar(ctx, this.characterId);
    this._offWeaponVisual = ctx.events.on('weapon.equipped', (info) => {
      if (info?.actor === this) this.weaponVisual?.equip(info.id);
    });

    // ── dash-ready tell: a thin additive ring that snaps at the player's feet ─
    const ringGeo = new THREE.RingGeometry(0.56, 0.66, 44);
    ringGeo.rotateX(-Math.PI / 2);
    this.readyMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(this.characterRimHex), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
    });
    this.readyRing = new THREE.Mesh(ringGeo, this.readyMat);
    this.readyRing.name = 'player.dashReady';
    this.readyRing.position.y = 0.035;
    this.readyRing.visible = false;
    this.readyRing.frustumCulled = false;
    this.root.add(this.readyRing);

    ctx.combat?.register?.(this);

    // ── THE ARSENAL ────────────────────────────────────────────────────────
    // One runtime, owned by combat.js (it ticks every runtime in its own
    // update, BEFORE this system runs, so by the time we animate below the
    // machine's step is already the current one).
    this.weapon = ctx.combat?.runtimeFor?.(this, ctx.combat.weaponId) || null;

    // RECONCILING `playerDrivesBlade`. The flag existed because this file used
    // to run its own hardcoded blade combo AND call combat.special() on the
    // same frame, so the table's version of the swing had to be suppressed or
    // the blade dealt double damage. That private path is gone: the runtime
    // now drives all four arms and nothing here applies damage. Leaving the
    // flag true would keep a live special-case that silently no-ops
    // `ctx.combat.special({source: player})` for one weapon out of four — a
    // trap for the next caller. Clearing it restores AGENT-COMBAT's stated
    // design ("Every other arm is ours end to end") for the blade as well.
    if (ctx.combat) ctx.combat.playerDrivesBlade = false;

    ctx.events.on('damage.dealt', (info) => { if (info && info.target === this) this._onHurt(info); });
    ctx.events.on('entity.died', (info) => { if (info && info.entity === this) this._onDeath(); });
    // PERFECT DODGE (combat.js decides; this file pays out the movement half):
    // the dash cooldown is refunded so the ready ring snaps the instant the
    // dash ends, and the hero reads as having earned another one.
    ctx.events.on('player.perfectDodge', () => this._onPerfectDodge());
    ctx.events.on('capture.state', ({ name }) => this._captureState(name, ctx));
    // A biome change re-publishes the rig's rim constant over every character
    // material; re-assert our per-slot art direction a few frames later.
    ctx.events.on('biome.changed', () => { this._retuneIn = 0.2; });
    ctx.ui?.setHealth?.(this.health, this.maxHealth);
    ctx.ui?.setMana?.(this.mana, this.maxMana);
    ctx.ui?.setCast?.(this.castStock, this.castMax);

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

  _buildAvatar(ctx, id) {
    const character = characterInfo(id);
    const spec = character.id === 'melinoe' ? MELINOE_SPEC : HERO_SPEC;
    this.characterId = character.id;
    this.rig = buildHumanoid(spec, ctx);
    // the per-slot painterly table, reachable at runtime: mutate and call
    // player.rig.retune() to re-publish it over every character material.
    this.slotPaint = SLOT_PAINT;
    this.root.add(this.rig.root);
    const current = character.weapons.includes(ctx.combat?.weaponId) ? ctx.combat.weaponId : character.defaultWeapon;
    this.weaponVisual = createAvatarWeapons(this.rig, current, character.weapons);
    this.animator = new Animator(this.rig);
    this.animator.play('idle', { fade: 0 });
    this.height = this.rig.height;

    const rimHex = character.id === 'melinoe' ? character.color
      : ((ctx.lighting && ctx.lighting.rim && ctx.lighting.rim.color)
        ? '#' + ctx.lighting.rim.color.getHexString() : '#5fd0ff');
    this.characterRimHex = rimHex;
    this.ghosts = [];
    for (let i = 0; i < TUNING.dashGhosts; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(rimHex), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
      });
      const ghost = this.rig.makeGhost(mat);
      ghost.group.visible = false; ghost.mat = mat; ghost.life = 0;
      ctx.scene.add(ghost.group);
      this.ghosts.push(ghost);
    }
    this._ghostIdx = 0;
    this._ghostQueue.length = 0;
    return character;
  }

  _disposeAvatar() {
    this.weaponVisual?.dispose?.();
    this.weaponVisual = null;
    for (const ghost of this.ghosts || []) {
      ghost.group?.removeFromParent?.();
      ghost.mat?.dispose?.();
    }
    this.ghosts = [];
    this.rig?.root?.removeFromParent?.();
    this.rig?.dispose?.();
    this.rig = null;
  }

  /** Rebuild the active heir at the Crossroads while preserving controller state. */
  setCharacter(id) {
    const character = CHARACTER_INFO[id];
    if (!character || character.id === this.characterId || !this.ctx) return character || null;
    this.weapon?.cancel?.();
    this.blocking = null;
    this._animKey = null;
    this._disposeAvatar();
    this._buildAvatar(this.ctx, id);
    this.readyMat?.color?.set?.(this.characterRimHex);
    this.root.position.copy(this.position);
    this.root.rotation.y = Math.atan2(this.facing.x, this.facing.y);
    this.animator.update(0);
    this.ctx.events?.emit?.('character.changed', { id, character, actor: this });
    return character;
  }

  // ─────────────────────────────────────────────────────────── capture ────
  _captureState(name, ctx) {
    if (name === 'combat') {
      // deterministic mid-combo impact frame — the pose the shot list asks for
      this._captureFreeze = { clip: 'attack2', t: 0.19 };
      this.state = 'weapon'; this.act = { name: 'cut2', t: 0.19, dur: 0.44, index: 1, hit: true, fired: true };
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
    this._boonSlamT = Math.max(0, (this._boonSlamT || 0) - dt);
    this._animLock = Math.max(0, (this._animLock || 0) - dt);
    if (this._retuneIn > 0) { this._retuneIn -= dt; if (this._retuneIn <= 0) this.rig.retune?.(); }
    this.dash.cd = Math.max(0, this.dash.cd - dt);
    if (!this.dash.ready && this.dash.cd <= 0) {
      this.dash.ready = true; this.dash.readyPulse = 1;
      ctx.events.emit('player.dashReady', { pos: this.position.clone() });
    }
    for (const k in this.buf) this.buf[k] = Math.max(0, this.buf[k] - dt);
    const inp = ctx.input;
    // THE ATTACK BUTTON GOES STRAIGHT TO THE ARM. press/release both matter:
    // the bow and the spear charge on hold, the shield guards on hold, and the
    // blade ignores the release entirely — that difference is data, not code.
    const W = this.weapon = ctx.combat?.runtimeFor
      ? ctx.combat.runtimeFor(this, ctx.combat.weaponId) : null;
    if (W && this.alive && this.state !== 'dead' && this.state !== 'hurt') {
      if (inp.pressed('attack')) {
        this._faceCursor();
        // During a dash this is a dedicated third move. Do not also feed a
        // standing Attack into the weapon state machine and then disguise it;
        // queue only the authored Dash Attack.
        if (this.state === 'dash' && W.queueDashAttack?.()) { /* dedicated route */ }
        else W.press('attack');
      }
      if (inp.pressed('special')) { this._faceCursor(); W.press('special'); }
      // WeaponRuntime.release() does not look at WHICH button was let go — it
      // just ends whatever hold is live. Forwarding both edges would therefore
      // let the ATTACK button drop a raised shield. Only the button that can
      // start a hold on this arm is allowed to end one, which is a property of
      // the weapon table (block.action / charge.action), not of this file.
      const hold = W.weapon.block ? 'special' : (W.weapon.charge && W.weapon.charge.action);
      if (hold && inp.released(hold)) { this._faceCursor(); W.release(hold); }
    }
    // A committed step can run longer than a normal buffer, and eating the
    // dash that gets you out of it is the worst thing this controller can do.
    if (inp.pressed('dash')) this.buf.dash = (W && W.busy) ? 0.55 : T.dashBuffer;
    if (inp.pressed('cast')) this.buf.cast = T.actionBuffer;
    if (inp.pressed('summon')) this.buf.summon = T.actionBuffer;

    this.mana = Math.min(this.maxMana, this.mana + T.manaRegen * (ctx.boons?.mods?.manaRegenMul || 1) * dt);
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
    // WHO decides an attack is cancellable: the WEAPON. `cancellable` reads the
    // live step's own `cancel` mark, so a blade's 3rd hit and a spear's spin
    // open at different times without this file knowing either number.
    const wFree = !W || W.cancellable;
    const canDash = this.dash.ready && (
      this.state === 'move' ||
      (this.state === 'weapon' && wFree) ||
      (this.state === 'cast' && this.act.t >= this.act.dur * 0.60) ||
      (this.state === 'hurt' && this.act.t >= 0.13));
    if (canDash && this.buf.dash > 0) this._startDash(ctx);
    else if ((this.state === 'move' || this.state === 'weapon') && (!W || !W.busy)) {
      if (this.buf.cast > 0) this._startCast(ctx);
      else if (this.buf.summon > 0) {
        this.buf.summon = 0;
        ctx.combat?.summon?.({ source: this, pos: this.position.clone(), dir: this.facing.clone() });
        ctx.events.emit('player.summon', { pos: this.position.clone() });
      }
    }

    // ── per-state ─────────────────────────────────────────────────────────
    let wishScale = 1;
    switch (this.state) {
      case 'dash': this._dashStep(dt, ctx); wishScale = 0; break;
      case 'cast': this._castStep(dt, ctx); wishScale = this.act.t > this.act.dur * 0.72 ? 0.3 : 0.02; break;
      case 'hurt': this.act.t += dt; wishScale = 0.12; if (this.act.t >= this.act.dur) { this.state = 'move'; this._animLock = 0.05; } break;
      default: wishScale = this._weaponStep(dt, ctx, W); break;
    }

    // ── integrate, animate, resolve ───────────────────────────────────────
    this._integrate(dt, ctx, wishScale);
    this._feel(dt, ctx);
    this._applyRoot();
    const rd = this.animator.update(dt);
    // CLIP root motion is only allowed when the WEAPON is not doing its own.
    // weapons.js `step.root` displaces the actor along an ease-out curve during
    // the active window; the blade's clips carry a root track from the days
    // this file drove them, and applying both doubled every lunge.
    if (this.state !== 'weapon' && rd.lengthSq() > 1e-9) {
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
    const mods = ctx.boons?.mods;
    const rider = mods?.rider?.dash;
    const boonColor = rider?.color || '#5fd0ff';
    this.buf.dash = 0;
    // THE DASH IS THE ANSWER TO EVERY MISTAKE (weapons.js, verbatim). Tell the
    // arm first: it kills its own live hitbox, drops the guard and clears any
    // charge, so a dash out of a swing cannot leave damage in the world.
    this.weapon?.press?.('dash');
    // Input.begin() exposes both edges for the whole fixed-step frame. Promote
    // the attack already buffered above when Dash+Attack landed together.
    if (ctx.input.pressed('attack')) this.weapon?.queueDashAttack?.();
    this.blocking = null;
    this._animKey = null;
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
    this.iframes = Math.max(this.iframes, T.dashIFrames[1] + (mods?.iframeAdd || 0));
    if (rider?.deflect) ctx.combat?.activateDeflect?.(this, rider.deflect, boonColor);
    const attackRider = mods?.rider?.attack;
    if (attackRider?.postDashBonus) this._boonPostDash = true;
    this.squash = -0.085;
    this._ghostQueue = [0.0, 0.055, 0.11];
    ctx.events.emit('player.dashed', { pos: this.position.clone(), dir: new THREE.Vector3(this.dash.dir.x, 0, this.dash.dir.y) });
    ctx.events.emit('camera.shake', { amp: 0.06, dur: 0.15, freq: 26 });
    ctx.audio?.sfx?.('dash', { pos: this.position });
    ctx.vfx?.burst?.(this.position.clone().setY(0.85), {
      count: rider ? 14 + (rider.tier || 1) * 4 : 14, color: boonColor, speed: rider ? 9 : 6.5, spread: 0.8,
      kind: ({ zeus: 'sparkFine', poseidon: 'wisp', athena: 'shard', aphrodite: 'mote', ares: 'rune', artemis: 'chev', dionysus: 'wisp', hermes: 'chev', hecate: 'rune', selene: 'star' })[rider?.god] || 'wisp',
    });
    this._dashBoon = rider ? { rider, mods, color: boonColor } : null;
    if (rider && rider.god !== 'poseidon') this._dashBoonBlast(ctx, rider, mods, boonColor);
  }
  _dashBoonBlast(ctx, rider, mods, boonColor) {
    const radius = 1.45 + (mods?.dashRadius || 0);
    ctx.hitboxes?.spawn?.({
      shape: 'circle', owner: this, source: this, follow: false,
      x: this.position.x, z: this.position.z, radius,
      t0: 0, t1: 0.10, life: 0.12, maxTargets: 8,
      damage: rider.bonus || 0, type: rider.type || 'arcane',
      knockback: 4 + (rider.knockback || 0) + (mods?.knockback || 0),
      status: rider.status, statusStacks: rider.stacks || 1, statusPower: rider.statusPower || 0,
      crit: rider.critChance || 0, expose: rider.expose || 0, critMark: rider.critMark || 0,
      boonGod: rider.god, boonSlot: 'dash', color: boonColor,
      tag: `boon:dash:${rider.god || 'divine'}`,
    });
    ctx.vfx?.shockwave?.(this.position.clone().setY(0.06), { radius, color: boonColor, life: 0.36 });
    if (['ares', 'dionysus'].includes(rider.god) && ctx.combat?._boonPulses) {
      ctx.combat._boonPulses.push({
        kind: rider.god === 'ares' ? 'cuts' : 'fog', t: 0.20, interval: 0.30, left: 3,
        source: this, x: this.position.x, z: this.position.z, radius,
        damage: (rider.bonus || 0) * 0.30, type: rider.type || 'arcane', color: boonColor,
        status: rider.status, statusStacks: rider.stacks || 1, statusPower: rider.statusPower || 0,
      });
    }
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
      if (this._dashBoon?.rider?.god === 'poseidon') {
        this._dashBoonBlast(ctx, this._dashBoon.rider, this._dashBoon.mods, this._dashBoon.color);
      }
      this._dashBoon = null;
      // Movement and attack aim are independent. `_startDash()` faces the
      // travel direction so the dash pose reads correctly, but the runtime
      // consumes a queued Dash-Strike at the start of the next fixed step.
      // Restore the LIVE cursor/stick aim here, after all dash displacement,
      // so both the attack hitbox and its root motion commit toward the
      // reticle. An ordinary dash keeps its travel-facing direction.
      if (this.weapon?.dashQueued) this._faceCursor();
      this.state = 'move';
      this._animLock = 0.14;
      this.squash = 0.13;
      this.animator.playAdditive('land', { weight: 0.7 });
      this.velocity.multiplyScalar(0.42);
      ctx.events.emit('camera.shake', { amp: 0.035, dur: 0.12, freq: 32 });
    }
  }

  // ──────────────────────────────────────────────────────────── arsenal ────
  /**
   * The weapon state, every frame. Returns the movement scale.
   *
   * This is the whole of what used to be _startAttack/_attackStep/_swing. The
   * runtime already advanced itself inside combat.update() this frame, so all
   * that is left is: pick the player state, decide whether the character may
   * still steer, and put the right pose on the right arm.
   */
  _weaponStep(dt, ctx, W) {
    const st = W ? W.state : 'idle';
    const busy = st !== 'idle';
    this.state = busy ? 'weapon' : 'move';
    this._syncWeaponAnim(ctx, W);
    if (!busy) { this._locomotion(dt, ctx); return 1; }

    // STEERING. A charge or a guard must track the aim — a bow you cannot
    // re-aim while drawn is a bow you never draw. A committed swing must not:
    // that is the contract the enemy reads when it sidesteps you.
    // NOTE the strike-state guard: the runtime does not null `step` when
    // it enters a rush, so testing the step alone would let you steer a shield
    // charge off its own line for the first few frames.
    const strike = st === 'attack' || st === 'dashAttack';
    const s = strike ? W.step : null;
    if (st === 'charge' || st === 'block') this._steer(dt, ctx, this.tune.steerLambdaAim);
    else if (strike && (!s || W.t < s.turnLock || W.t >= s.cancel)) {
      this._steer(dt, ctx, this.tune.steerLambdaCommit);
    }

    // keep `act` truthful for anything reading the controller (camera, UI)
    this.act.name = s ? s.name : st;
    this.act.t = W.t; this.act.dur = W.dur || 0; this.act.index = W.stepIndex;
    return W.moveScale;
  }

  /** damp the facing toward the move stick, or the aim if there is no stick. */
  _steer(dt, ctx, lambda) {
    let a;
    // Weapon commitment is cursor-authoritative. Movement may keep carrying
    // the hero sideways, but it must never rotate a drawn bow, held spear or
    // melee wind-up away from the reticle.
    if (this._mouseSeen) a = Math.atan2(this.aimDir.x, this.aimDir.y);
    else {
      const w = this._wish(ctx, _v);
      if (w <= 0.2) return;
      a = Math.atan2(_v.x, _v.z);
    }
    const cur = Math.atan2(this.facing.x, this.facing.y);
    const na = dampAngle(cur, a, lambda, dt);
    this.facing.set(Math.sin(na), Math.cos(na));
  }

  /** Snap the damage direction to the current world-space cursor ray. */
  _faceCursor() {
    if (this._mouseSeen && this.aimDir.lengthSq() > 0.01) this.facing.copy(this.aimDir).normalize();
  }

  /**
   * Map (weapon, runtime state, step) onto a clip, once per transition.
   *
   * The key includes the step INDEX as well as its name so a combo that loops
   * back to its own first step still restarts the pose, and includes the
   * weapon id so a mid-fight swap re-poses on the next frame.
   */
  _syncWeaponAnim(ctx, W) {
    if (!W) return;
    const st = W.state;
    const strike = st === 'attack' || st === 'dashAttack';
    const s = strike ? W.step : null;
    const key = W.weaponId + '|' + st + '|' + (s ? s.name : '-') + '|' + W.stepIndex;
    if (key === this._animKey) return;
    this._animKey = key;
    if (st === 'idle') { this._animLock = 0; return; }   // locomotion resumes

    const map = WEAPON_ANIM[W.weaponId] || WEAPON_ANIM.blade;
    const chg = W.weapon && W.weapon.charge;
    let clip = null, span = 0;
    if (strike) {
      clip = (s && map[s.name]) || map._fallback;
      span = s ? s.dur : 0.4;
    } else if (st === 'charge') {
      clip = map._charge;
      // the pose reaches full commitment exactly when the charge does
      span = Math.max(0.18, (chg && chg.fullHold) || 0.6);
    } else if (st === 'block') {
      clip = map._block; span = 0;                       // a loop; play at 1x
    } else if (st === 'rush') {
      clip = map._rush;
      span = (W._rushTime || 0.22) + ((chg && chg.recovery) || 0.3);
    } else if (st === 'reload') {
      clip = map._charge;
      span = W.weapon?.magazine?.reload || 1.2;
    }
    if (!clip || !this.animator.clips[clip]) clip = map._fallback;
    if (!this.animator.clips[clip]) return;

    const cd = this.animator.duration(clip);
    const speed = span > 0.02 ? clamp(cd / span, 0.3, 4.0) : 1;
    // chained combo steps cut in hard; a fresh action gets a real blend
    const fade = (st === 'attack' && W.stepIndex > 0) ? 0.04 : st === 'dashAttack' ? 0.025 : 0.075;
    this.animator.play(clip, { fade, restart: true, speed });
    this._animLock = 0.05;
    if (strike || st === 'rush') {
      this.combatHeat = Math.min(1.6, this.combatHeat + 0.42);
      this.squash = -0.03;
    }
  }

  // ─────────────────────────────────────────────────────────────── cast ────
  // The CAST is the one offensive verb that is NOT a weapon: combat.cast()
  // fires the same arcane bolt whatever you are holding, so its timing lives
  // here and duplicates nothing in weapons.js.
  _startCast(ctx) {
    const T = this.tune;
    const castSpeed = ctx.boons?.mods?.castSpeed || 1;
    const witchCast = this.characterId === 'melinoe';
    if (!witchCast && this.castStock <= 0) { this.buf.cast = 0; ctx.ui?.toast?.('All Cast shards are lodged', { color: '#c9b8ff' }); return; }
    if (witchCast && this.mana < T.castCost) { this.buf.cast = 0; ctx.ui?.toast?.('Not enough Magick', { color: '#86e6c1' }); return; }
    if (witchCast) {
      this.mana -= T.castCost;
      ctx.ui?.setMana?.(this.mana, this.maxMana);
      ctx.events?.emit?.('magick.spent', { amount: T.castCost, source: 'cast', character: this.characterId });
    }
    this.buf.cast = 0;
    this.weapon?.cancel?.(); this.blocking = null;
    this.state = 'cast';
    const rider = ctx.boons?.mods?.rider?.cast;
    const style = castPresentation(rider?.god);
    this.act = { name: 'cast', t: 0, dur: T.castDur / castSpeed, release: T.castRelease / castSpeed, index: 0, hit: false, fired: false, queued: false, dashQueued: false, castStyle: style };
    this._animKey = null;
    const clipDur = this.animator.duration(style.clip) || T.castDur;
    this.animator.play(style.clip, { fade: 0.06, restart: true, speed: clipDur / this.act.dur });
    if (this._mouseSeen) this._faceCursor();
    else {
      const w = this._wish(ctx, _v);
      if (w > 0.15) this.facing.set(_v.x, _v.z).normalize();
    }
    this.combatHeat = Math.min(1.5, this.combatHeat + 0.5);
    ctx.events.emit('camera.shake', { amp: 0.035, dur: 0.12, freq: 30 });
  }
  _castStep(dt, ctx) {
    this.act.t += dt;
    if (!this.act.fired && this.act.t >= this.act.release) {
      this.act.fired = true;
      const dir3 = new THREE.Vector3(this.facing.x, 0, this.facing.y);
      const origin = this.position.clone().setY(1.12);
      const usesShard = this.characterId !== 'melinoe';
      if (usesShard && !this.spendCastShard()) return;
      const projectile = ctx.combat?.cast?.({ source: this, origin, dir: dir3, power: 1 });
      if (!projectile && usesShard) this.restoreCastShard();
      const rider = ctx.boons?.mods?.rider?.cast;
      const style = this.act.castStyle || castPresentation(rider?.god);
      ctx.events.emit('player.cast', { pos: origin, dir: dir3, god: rider?.god || null, form: style.form });
      ctx.vfx?.burst?.(origin, { count: 12, color: rider?.color || '#5fd0ff', speed: 9, spread: 0.35, kind: style.fx });
      ctx.events.emit('camera.shake', { amp: 0.07, dur: 0.18, freq: 28 });
    }
    if (this.act.t >= this.act.dur) { this.state = 'move'; this._animLock = 0.05; }
  }

  spendCastShard() {
    if (this.castStock <= 0) return false;
    this.castStock--;
    this.ctx?.ui?.setCast?.(this.castStock, this.castMax);
    this.ctx?.events?.emit?.('cast.stock', { current: this.castStock, max: this.castMax, change: -1 });
    return true;
  }

  restoreCastShard(n = 1) {
    const before = this.castStock;
    this.castStock = Math.min(this.castMax, this.castStock + Math.max(0, n | 0));
    if (this.castStock === before) return false;
    this.ctx?.ui?.setCast?.(this.castStock, this.castMax);
    this.ctx?.events?.emit?.('cast.stock', { current: this.castStock, max: this.castMax, change: this.castStock - before });
    return true;
  }

  resetCastShards() {
    this.castStock = this.castMax;
    this.ctx?.ui?.setCast?.(this.castStock, this.castMax);
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
      const mods = ctx.boons?.mods;
      const boonMove = (mods?.moveMul || 1) * (this._boonSlamT > 0 ? 1 + (mods?.slamSpeed || 0) : 1);
      const moveSpeed = this.speed * boonMove;
      const tx = has ? _v.x * moveSpeed * wishScale : 0;
      const tz = has ? _v.z * moveSpeed * wishScale : 0;
      // INPUT KICK — motion exists on the very first frame of input, then the
      // acceleration curve takes over. This is the whole "under 50ms" trick.
      if (has && !this._hadInput && wishScale > 0.5) {
        const n = Math.max(1e-4, Math.hypot(_v.x, _v.z));
        this.velocity.x += (_v.x / n) * moveSpeed * T.inputKick;
        this.velocity.z += (_v.z / n) * moveSpeed * T.inputKick;
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

  _onPerfectDodge() {
    const T = this.tune;
    if (!this.alive) return;
    this.dash.cd = Math.min(this.dash.cd, Math.max(0.02, T.dashTime - this.dash.t + 0.02));
    this.combatHeat = Math.min(1.6, this.combatHeat + 0.35);
    this.squash = -0.05;
    this.ctx?.ui?.toast?.('PERFECT DODGE', { color: this.characterRimHex || '#5fd0ff', dur: 0.8 });
  }

  // ───────────────────────────────────────────────────────────── damage ────
  _onHurt(info) {
    const ctx = this.ctx, T = this.tune;
    if (!this.alive) return;
    ctx.ui?.setHealth?.(this.health, this.maxHealth);
    if (this.health <= 0) return;                 // the death handler takes it
    this.iframes = Math.max(this.iframes, T.hurtIFrames);
    this.weapon?.cancel?.(); this.blocking = null; this._animKey = null;
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
    this.weapon?.cancel?.(); this.blocking = null; this._animKey = null;
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
    this._perfectDodgeT = 0; this._perfectDodgeLock = 0; this.perfectDodges = 0;
    this.resetCastShards();
    this.alive = true; this.dead = false; this.state = 'move';
    this.weapon?.cancel?.(); this.blocking = null; this._animKey = null;
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
    if (this._onKey) { removeEventListener('keydown', this._onKey); this._onKey = null; }
    this._offWeaponVisual?.(); this._offWeaponVisual = null;
    this._disposeAvatar();
    this.readyRing?.geometry?.dispose?.();
    this.readyMat?.dispose?.();
  }
}

export default Player;
