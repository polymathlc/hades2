// OWNER: AGENT-COMBAT
// ---------------------------------------------------------------------------
// weapons.js — the Infernal Arms.  ALL TUNING IS DATA. The runtime below never
// contains a number that belongs to a weapon; it only reads this table.
//
// WHY THAT MATTERS: timings are the product. The reason Hades' blade feels
// different from its bow is not code, it is thirty numbers. Keeping them in one
// literal means a designer can retune the whole arsenal without ever opening
// the state machine, and means a diff of a balance pass is legible.
//
// THE FEEL CONTRACT, applied to every step:
//   WINDUP    must be READABLE. Nothing lands in under ~90ms of anticipation;
//             heavy commits telegraph for 200ms+ so they can be reacted to.
//   ACTIVE    must be SHORT and DECISIVE. 50-110ms. A long active frame turns
//             a swing into a bulldozer and destroys the reading of spacing.
//   RECOVERY  must be CANCELLABLE BY DASH well before it ends (see `cancel`),
//             because in this genre the dash is the answer to every mistake.
//   CHAIN     opens BEFORE recovery ends, so a buffered press flows instantly.
//   BUFFER    a press up to `buffer` seconds early is honoured. Generosity is
//             the difference between "tight" and "unresponsive".
//
// FOUR WEAPONS, FOUR RHYTHMS:
//   blade   fast, close, 3-hit, the 3rd a committed lunge with root motion
//   spear   long reach, slow pokes, a charged THROW that sticks and is recalled
//   bow     charge-to-fire, damage/pierce scale with charge, power shot at full
//   shield  a block that absorbs AND REFLECTS, plus a charged bash dash-attack
// ---------------------------------------------------------------------------

import { TEAM } from './hitbox.js';

const GOLD = '#ffe9a8', EMBER = '#ffb04a', ARTERIAL = '#e01f2d';
const RIM = '#5fd0ff', VERD = '#3f8f7a', WITCH = '#8ef0d0';

// A step's derived timeline:  t0 = windup, t1 = windup+active, dur = t1+recovery
const step = (o) => {
  o.t0 = o.windup; o.t1 = o.windup + o.active; o.dur = o.t1 + o.recovery;
  if (o.chain == null) o.chain = o.t1 + o.recovery * 0.34;
  if (o.cancel == null) o.cancel = o.t1 + o.recovery * 0.18;
  if (o.turnLock == null) o.turnLock = o.windup * 0.72;
  return o;
};

export const WEAPONS = {

  // ═══════════════════════════════════════════════════════ STYGIAN BLADE ═══
  // The metronome. 3 hits in ~1.1s, tiny commitment on 1-2, a real one on 3.
  blade: {
    id: 'blade', name: 'Stygian Blade', kind: 'melee',
    palette: { core: '#fffdf0', body: GOLD, glow: EMBER },
    buffer: 0.24, moveScale: 0.30, critChance: 0.08, critMul: 1.9,
    combo: [
      step({
        name: 'cut1', windup: 0.115, active: 0.075, recovery: 0.205,
        hitbox: { shape: 'arc', radius: 2.30, arcDeg: 128, offset: [0.35, 0], maxTargets: 4 },
        damage: 15, type: 'physical', knockback: 3.4, poise: 9, hitstop: 56,
        shake: { amp: 0.085, dur: 0.16, freq: 33 },
        root: { distance: 0.55, ease: 2.0 },
        vfx: { call: 'slash', arc: 132, radius: 2.35, width: 0.40, y: 1.05, spin: 1 },
        sfx: 'blade.swing1',
      }),
      step({
        name: 'cut2', windup: 0.095, active: 0.070, recovery: 0.195,
        hitbox: { shape: 'arc', radius: 2.35, arcDeg: 140, offset: [0.35, 0], maxTargets: 4 },
        damage: 15, type: 'physical', knockback: 3.7, poise: 10, hitstop: 62,
        shake: { amp: 0.095, dur: 0.17, freq: 33 },
        root: { distance: 0.62, ease: 2.0 },
        vfx: { call: 'slash', arc: 144, radius: 2.40, width: 0.44, y: 1.02, spin: -1 },
        sfx: 'blade.swing2',
      }),
      step({
        // THE COMMIT. Long tell, big arc, real root motion, real recovery.
        name: 'lunge', windup: 0.225, active: 0.105, recovery: 0.335,
        chain: 0.62, cancel: 0.44,
        hitbox: { shape: 'arc', radius: 2.85, arcDeg: 205, offset: [0.55, 0], maxTargets: 6 },
        damage: 29, type: 'physical', knockback: 7.4, poise: 26, hitstop: 98,
        shake: { amp: 0.165, dur: 0.26, freq: 29 },
        root: { distance: 2.65, ease: 2.6 },
        vfx: { call: 'slash', arc: 212, radius: 2.95, width: 0.60, y: 1.00, color: EMBER, spin: 1 },
        sfx: 'blade.lunge',
      }),
    ],
    // dash-strike: cheap, fast, the reason you dash INTO a fight
    dashAttack: step({
      name: 'dashcut', windup: 0.075, active: 0.070, recovery: 0.180,
      hitbox: { shape: 'arc', radius: 2.5, arcDeg: 160, offset: [0.5, 0], maxTargets: 5 },
      damage: 18, type: 'physical', knockback: 5.0, poise: 14, hitstop: 68,
      shake: { amp: 0.11, dur: 0.18, freq: 32 },
      root: { distance: 1.35, ease: 2.2 },
      vfx: { call: 'slash', arc: 168, radius: 2.6, width: 0.5, y: 1.1, color: RIM, spin: -1 },
      sfx: 'blade.dashcut',
    }),
    special: step({
      name: 'sweep', windup: 0.185, active: 0.090, recovery: 0.300,
      hitbox: { shape: 'ring', radius: 3.35, innerRadius: 0.6, arcDeg: 360, maxTargets: 10 },
      damage: 24, type: 'physical', knockback: 8.6, poise: 34, hitstop: 104,
      shake: { amp: 0.19, dur: 0.30, freq: 27 },
      vfx: { call: 'shockwave', radius: 3.4, color: EMBER, life: 0.42 },
      sfx: 'blade.sweep',
    }),
  },

  // ═══════════════════════════════════════════════════════ ETERNAL SPEAR ═══
  // Reach and patience. Pokes are capsules, not arcs — the hitbox is a LINE,
  // so spacing, not sweeping, is the skill. The throw is the payoff.
  spear: {
    id: 'spear', name: 'Eternal Spear', kind: 'melee',
    palette: { core: '#f4ffff', body: VERD, glow: RIM },
    buffer: 0.26, moveScale: 0.38, critChance: 0.10, critMul: 2.0,
    combo: [
      step({
        name: 'poke1', windup: 0.135, active: 0.060, recovery: 0.210,
        hitbox: { shape: 'capsule', radius: 0.62, length: 3.55, offset: [0.35, 0], maxTargets: 3, pierce: 3 },
        damage: 17, type: 'physical', knockback: 4.2, poise: 10, hitstop: 58,
        shake: { amp: 0.075, dur: 0.15, freq: 34 },
        root: { distance: 0.95, ease: 2.4 },
        vfx: { call: 'thrust', length: 3.9, width: 0.30, y: 1.10, color: VERD },
        sfx: 'spear.poke1',
      }),
      step({
        name: 'poke2', windup: 0.115, active: 0.060, recovery: 0.200,
        hitbox: { shape: 'capsule', radius: 0.64, length: 3.75, offset: [0.35, 0], maxTargets: 3, pierce: 3 },
        damage: 18, type: 'physical', knockback: 4.4, poise: 11, hitstop: 62,
        shake: { amp: 0.08, dur: 0.16, freq: 34 },
        root: { distance: 1.05, ease: 2.4 },
        vfx: { call: 'thrust', length: 4.1, width: 0.32, y: 1.06, color: VERD },
        sfx: 'spear.poke2',
      }),
      step({
        name: 'spin', windup: 0.200, active: 0.095, recovery: 0.320,
        chain: 0.58, cancel: 0.41,
        hitbox: { shape: 'ring', radius: 3.05, innerRadius: 0.5, arcDeg: 360, maxTargets: 8 },
        damage: 26, type: 'physical', knockback: 6.8, poise: 24, hitstop: 92,
        shake: { amp: 0.15, dur: 0.24, freq: 30 },
        root: { distance: 0.9, ease: 2.0 },
        vfx: { call: 'slash', arc: 350, radius: 3.1, width: 0.52, y: 0.98, color: RIM, spin: 1 },
        sfx: 'spear.spin',
      }),
    ],
    // CHARGED THROW: hold to wind, release to throw. The spear sticks where it
    // lands and is RECALLED — the recall is its own damaging projectile.
    charge: {
      action: 'special',
      minHold: 0.10, fullHold: 0.72,
      windup: 0.145, recovery: 0.285,
      tell: { color: VERD, ringFrom: 2.4, ringTo: 0.9 },
      projectile: {
        kind: 'straight', speed: 26, speedFull: 40, radius: 0.34, life: 1.05,
        damage: 22, damageFull: 52, pierce: 2, pierceFull: 5,
        type: 'physical', knockback: 6.0, hitstop: 88, color: VERD,
        size: 1.35, coreSize: 1.5, hero: true, stick: true, onExpire: 'impact',
      },
      recall: {
        speed: 34, damage: 16, damageFull: 30, pierce: 8, radius: 0.42,
        color: RIM, hitstop: 54, knockback: 3.5,
      },
      shake: { amp: 0.13, dur: 0.22, freq: 30 },
      sfx: 'spear.throw',
    },
  },

  // ═════════════════════════════════════════════════ HEART-SEEKING BOW ═════
  // Charge-to-fire. The whole weapon is one decision: how long do you dare hold
  // still. Damage and pierce scale continuously; the full charge is a POWER
  // SHOT with its own colour, its own sound and a much bigger payload.
  bow: {
    id: 'bow', name: 'Heart-Seeking Bow', kind: 'ranged',
    palette: { core: '#ffffff', body: GOLD, glow: RIM },
    buffer: 0.20, moveScale: 0.55, critChance: 0.14, critMul: 2.35,
    charge: {
      action: 'attack',
      minHold: 0.06, fullHold: 0.58, overHold: 0.78,   // past overHold it decays back
      windup: 0.055, recovery: 0.230, recoveryFull: 0.320,
      tell: { color: GOLD, ringFrom: 1.9, ringTo: 0.55 },
      projectile: {
        kind: 'straight', speed: 34, speedFull: 52, radius: 0.22, life: 1.5,
        damage: 12, damageFull: 44, pierce: 1, pierceFull: 4,
        type: 'physical', knockback: 2.4, knockbackFull: 7.5,
        hitstop: 40, hitstopFull: 96, color: GOLD, colorFull: '#fffdf0',
        size: 0.95, sizeFull: 1.9, coreSize: 1.0, coreSizeFull: 1.7, hero: true,
        crit: 0.0, critFull: 0.35,
      },
      shake: { amp: 0.05, dur: 0.12, freq: 36 }, shakeFull: { amp: 0.16, dur: 0.26, freq: 28 },
      sfx: 'bow.loose', sfxFull: 'bow.power',
    },
    // point-blank kick — the bow's answer to being cornered
    special: step({
      name: 'kick', windup: 0.105, active: 0.070, recovery: 0.240,
      hitbox: { shape: 'arc', radius: 2.05, arcDeg: 150, offset: [0.3, 0], maxTargets: 5 },
      damage: 14, type: 'physical', knockback: 11.0, poise: 30, hitstop: 74,
      shake: { amp: 0.12, dur: 0.20, freq: 31 },
      vfx: { call: 'shockwave', radius: 2.2, color: RIM, life: 0.30 },
      sfx: 'bow.kick',
    }),
  },

  // ════════════════════════════════════════════════════ SHIELD OF CHAOS ════
  // The only weapon with a defensive state. Block absorbs damage in a frontal
  // arc, REFLECTS projectiles back doubled, and charges the bash while held.
  shield: {
    id: 'shield', name: 'Shield of Chaos', kind: 'melee',
    palette: { core: '#ffffff', body: '#c9b8ff', glow: RIM },
    buffer: 0.24, moveScale: 0.34, critChance: 0.06, critMul: 1.8,
    combo: [
      step({
        name: 'punch1', windup: 0.120, active: 0.070, recovery: 0.215,
        hitbox: { shape: 'box', halfLength: 1.35, halfWidth: 0.95, offset: [1.35, 0], maxTargets: 4 },
        damage: 16, type: 'physical', knockback: 5.2, poise: 16, hitstop: 64,
        shake: { amp: 0.10, dur: 0.17, freq: 32 },
        root: { distance: 0.7, ease: 2.1 },
        vfx: { call: 'slash', arc: 96, radius: 2.1, width: 0.55, y: 1.05, color: '#c9b8ff', spin: 1 },
        sfx: 'shield.bash1',
      }),
      step({
        name: 'punch2', windup: 0.135, active: 0.080, recovery: 0.290,
        hitbox: { shape: 'box', halfLength: 1.55, halfWidth: 1.10, offset: [1.5, 0], maxTargets: 5 },
        damage: 25, type: 'physical', knockback: 9.5, poise: 30, hitstop: 96,
        shake: { amp: 0.17, dur: 0.26, freq: 28 },
        root: { distance: 1.0, ease: 2.1 },
        vfx: { call: 'shockwave', radius: 2.6, color: '#c9b8ff', life: 0.34 },
        sfx: 'shield.bash2',
      }),
    ],
    block: {
      action: 'special',
      raise: 0.085,                 // frames before the guard is live — a real tell
      arcDeg: 190, absorb: 0.86,    // 86% of damage in the arc is eaten
      chipMul: 0.14, reflectMul: 2.0, reflectSpeed: 1.4,
      perfect: 0.16,                // a parry window at the start of the raise
      perfectHitstop: 120, perfectSlowmo: [0.35, 0.22],
      color: '#c9b8ff', sfx: 'shield.block', sfxReflect: 'shield.reflect',
    },
    charge: {
      action: 'special', requiresBlock: true,
      minHold: 0.30, fullHold: 1.05,
      windup: 0.090, recovery: 0.300,
      dash: { distance: 5.4, distanceFull: 9.2, time: 0.20, timeFull: 0.30 },
      hitbox: { shape: 'circle', radius: 1.25, maxTargets: 6, pierce: 6 },
      damage: 22, damageFull: 46, knockback: 9.0, knockbackFull: 15.0,
      poise: 40, hitstop: 92, hitstopFull: 128,
      shake: { amp: 0.14, dur: 0.24, freq: 29 }, shakeFull: { amp: 0.24, dur: 0.34, freq: 25 },
      color: '#c9b8ff', sfx: 'shield.rush',
    },
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

// ---------------------------------------------------------------------------
// WeaponRuntime — reads the table, drives ONE wielder.
//
// A "wielder" is any object with { position:Vector3, facing:Vector2, radius }.
// It is deliberately not "the player": enemies, the boss and the training
// dummy all run the same machine, which is why an enemy's telegraph reads the
// same way the player's does. If the wielder exposes optional hooks
// (onWeaponState, animLock) they are called; otherwise they are skipped.
// ---------------------------------------------------------------------------
export class WeaponRuntime {
  constructor(combat, wielder, weaponId = 'blade') {
    this.combat = combat; this.ctx = combat.ctx; this.actor = wielder;
    this.equip(weaponId);
    this.state = 'idle';        // idle | attack | charge | block | rush
    this.step = null; this.stepIndex = -1;
    this.t = 0; this.dur = 0;
    this.hbId = 0; this.fired = false;
    this.queued = false; this.buffer = 0;
    this.charge = 0; this.holding = false;
    this.rootDone = 0;
    this.stuck = null;           // the thrown spear waiting to be recalled
    this.blockT = 0;
  }

  equip(id) {
    const w = WEAPONS[id] || WEAPONS.blade;
    this.weapon = w; this.weaponId = w.id;
    this.state = 'idle'; this.step = null; this.stepIndex = -1; this.charge = 0;
    this.ctx?.events.emit('weapon.equipped', { id: w.id, name: w.name, actor: this.actor });
    return w;
  }

  get busy() { return this.state !== 'idle' && this.state !== 'block'; }
  /** Recovery is dash-cancellable from the step's `cancel` mark. */
  get cancellable() { return this.state !== 'attack' || (this.step && this.t >= this.step.cancel); }
  get moveScale() {
    if (this.state === 'idle') return 1;
    if (this.state === 'block' || this.state === 'charge') return this.weapon.moveScale;
    if (this.step && this.t >= this.step.cancel) return this.weapon.moveScale;
    return 0.06;
  }

  // ───────────────────────────────────────────────────────────── input ────
  press(action) {
    const w = this.weapon;
    if (action === 'attack') {
      this.actionSlot = 'attack';
      if (w.charge && w.charge.action === 'attack') { this.holding = true; if (!this.busy) this._beginCharge(); return; }
      if (this.state === 'attack') { this.queued = true; return; }
      this.buffer = w.buffer;
      return;
    }
    if (action === 'special') {
      this.actionSlot = 'special';
      if (w.block) { this._beginBlock(); return; }
      if (w.charge && w.charge.action === 'special') { this.holding = true; if (!this.busy) this._beginCharge(); return; }
      if (w.special && !this.busy) this._beginStep(w.special, -1);
      return;
    }
    if (action === 'dash' && this.cancellable) this.cancel();
  }
  release(action) {
    const w = this.weapon;
    this.holding = false;
    if (this.state === 'charge') this._releaseCharge();
    else if (this.state === 'block') this._endBlock();
  }
  cancel() {
    if (this.hbId) { this.combat.hitboxes.cancel(this.hbId); this.hbId = 0; }
    this.state = 'idle'; this.step = null; this.queued = false; this.charge = 0;
  }

  // ───────────────────────────────────────────────────────────── update ────
  update(dt) {
    if (this.buffer > 0) this.buffer -= dt;
    if (this.blockT > 0) this.blockT -= dt;
    const actionDt = this.actor === this.ctx.player && this.actionSlot === 'attack'
      ? dt * (this.ctx.boons?.mods?.attackSpeed || 1) : dt;

    switch (this.state) {
      case 'idle':
        if (this.buffer > 0 && this.weapon.combo) { this.buffer = 0; this._beginStep(this.weapon.combo[0], 0); }
        break;
      case 'attack': this._stepAttack(actionDt); break;
      case 'charge': this._stepCharge(actionDt); break;
      case 'rush': this._stepRush(dt); break;
      case 'block': this._stepBlock(dt); break;
    }
  }

  _stepAttack(dt) {
    const s = this.step;
    this.t += dt;
    if (s.root && s.root.distance > 0) this._rootMotion(dt, s);
    if (!this.fired && this.t >= s.t0) { this.fired = true; this._fire(s); }
    if (this.queued && this.weapon.combo && this.stepIndex >= 0 && this.stepIndex < this.weapon.combo.length - 1 && this.t >= s.chain) {
      this.queued = false;
      this._beginStep(this.weapon.combo[this.stepIndex + 1], this.stepIndex + 1);
      return;
    }
    if (this.t >= s.dur) { this.state = 'idle'; this.step = null; this.queued = false; }
  }

  _rootMotion(dt, s) {
    // Ease-out displacement over the ACTIVE window only. Root motion during
    // windup would make the tell lie about where the attack lands.
    const a = this.combat.clamp01((this.t - s.t0) / Math.max(1e-4, (s.t1 - s.t0) + s.recovery * 0.35));
    const k = 1 - Math.pow(1 - a, s.root.ease);
    const want = s.root.distance * k;
    const d = want - this.rootDone;
    if (d <= 0) return;
    this.rootDone = want;
    const A = this.actor;
    A.position.x += A.facing.x * d;
    A.position.z += A.facing.y * d;
    this.ctx.world?.collide?.(A.position, A.radius || 0.45);
  }

  _beginStep(s, idx) {
    this.state = 'attack'; this.step = s; this.stepIndex = idx;
    this.t = 0; this.fired = false; this.queued = false; this.rootDone = 0;
    this.dur = s.dur;
    const A = this.actor;
    this.ctx.events.emit('weapon.step', { weapon: this.weaponId, step: s.name, actor: A, dur: s.dur, t0: s.t0, t1: s.t1 });
    A.onWeaponState?.('attack', s);
    this.ctx.audio?.sfx?.(s.sfx, { pos: A.position });
    if (s.shake) this.ctx.events.emit('camera.shake', { amp: s.shake.amp * 0.32, dur: 0.08, freq: 36 });
  }

  /** The active frame: one hitbox, one effect, one sound. */
  _fire(s) {
    const A = this.actor, C = this.combat;
    const hb = s.hitbox;
    const slot = s === this.weapon.special ? 'special' : 'attack';
    const { mods, rider } = this._boon(slot);
    const slotMul = slot === 'special' ? (mods?.specialMul || 1) : (mods?.attackMul || 1);
    const dashBonus = slot === 'attack' && A._boonPostDash && rider?.postDashBonus ? rider.postDashBonus : 0;
    if (dashBonus) A._boonPostDash = false;
    const damage = s.damage * slotMul * (mods?.dmgMul || 1) + (rider?.bonus || 0) + dashBonus;
    const color = rider?.color || (s.vfx && s.vfx.color) || this.weapon.palette.body;
    if (hb) {
      this.hbId = C.hitboxes.spawn({
        shape: hb.shape, owner: A, source: A,
        radius: hb.radius, innerRadius: hb.innerRadius, arcDeg: hb.arcDeg,
        length: hb.length, halfWidth: hb.halfWidth, halfLength: hb.halfLength,
        offset: hb.offset, maxTargets: hb.maxTargets ?? 6, pierce: hb.pierce ?? 255,
        t0: 0, t1: s.t1 - s.t0, life: s.t1 - s.t0 + 0.02,
        damage, type: rider?.type || s.type || 'physical', knockback: s.knockback + (rider?.knockback || 0) + (mods?.knockback || 0),
        poiseDamage: s.poise, hitstop: s.hitstop, shake: s.shake ? s.shake.amp : 0,
        status: rider?.status || s.status, statusStacks: rider?.stacks || 1, statusPower: rider?.statusPower || 0,
        crit: (s.crit || 0) + (this.weapon.critChance || 0) + (rider?.critChance || 0),
        expose: rider?.expose || 0, boonGod: rider?.god, boonSlot: slot,
        color,
        tag: this.weaponId + ':' + s.name,
      });
    }
    this._playVfx(s, rider, slot);
    if (slot === 'special' && rider?.deflect) C.activateDeflect(A, rider.deflect, rider.color);
    if (slot === 'special' && rider?.god === 'zeus') {
      C.hitboxes.spawn({ shape: 'circle', owner: A, source: A, follow: false,
        x: A.position.x, z: A.position.z, radius: 3.2, t0: 0, t1: 0.08, life: 0.10,
        maxTargets: 10, damage: Math.max(1, (rider.bonus || 0) * 0.55), type: 'lightning',
        knockback: 2.2, status: 'shock', statusStacks: 1, crit: rider.critChance || 0,
        color, boonGod: 'zeus', boonSlot: 'special', tag: 'boon:thunder-flourish' });
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x, 0.08, A.position.z), { radius: 3.2, color, life: 0.32 });
    }
    this.ctx.audio?.sfx?.(s.sfx + '.hit', { pos: A.position, gain: 0.5 });
  }

  _boon(slot) {
    if (this.actor !== this.ctx.player) return { mods: null, rider: null };
    const mods = this.ctx.boons?.mods || null;
    return { mods, rider: mods?.rider?.[slot] || null };
  }

  _playVfx(s, rider = null, slot = 'attack') {
    const v = s.vfx; if (!v) return;
    const A = this.actor, ctx = this.ctx;
    const P = this.combat._v3a.set(A.position.x, v.y ?? 1.05, A.position.z);
    const D = this.combat._v3b.set(A.facing.x, 0, A.facing.y);
    const col = rider?.color || v.color || this.weapon.palette.body;
    if (v.call === 'slash') {
      ctx.vfx?.slash?.(P, D, { arc: v.arc ?? 130, radius: v.radius ?? 2.3, width: v.width ?? 0.44, color: col, glow: this.weapon.palette.glow, spin: v.spin });
    } else if (v.call === 'shockwave') {
      ctx.vfx?.shockwave?.(this.combat._v3a.set(A.position.x, 0.06, A.position.z), { radius: v.radius ?? 3, color: col, life: v.life ?? 0.4 });
    } else if (v.call === 'thrust') {
      // a spear thrust is a BEAM, not a crescent — the shape language has to
      // tell you the hitbox is a line before the damage number does
      const b = this.combat._v3b.set(A.position.x + A.facing.x * (v.length ?? 3.8), v.y ?? 1.08, A.position.z + A.facing.y * (v.length ?? 3.8));
      ctx.vfx?.beam?.(P, b, { color: col, width: v.width ?? 0.30, life: 0.20 });
    }
    if (rider) this._playBoonFx(rider, P, D, slot);
  }

  _playBoonFx(rider, pos, dir, slot) {
    const ctx = this.ctx, col = rider.color || '#f2c14e';
    const tier = rider.tier || 1;
    const kind = {
      zeus: 'sparkFine', poseidon: 'wisp', athena: 'shard', aphrodite: 'mote',
      ares: 'rune', artemis: 'chev', dionysus: 'wisp', hermes: 'chev',
      hecate: 'rune', selene: 'star',
    }[rider.god] || 'spark';
    ctx.vfx?.burst?.(pos, {
      count: (slot === 'special' ? 15 : 9) + tier * 3, color: col,
      speed: slot === 'special' ? 9 : 6.5, spread: rider.god === 'poseidon' ? 1.15 : 0.65,
      kind, dir,
    });
    if (['poseidon', 'athena', 'dionysus', 'selene'].includes(rider.god)) {
      ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.07, this.actor.position.z), {
        radius: (slot === 'special' ? 2.6 : 1.8) + tier * 0.12, color: col, life: 0.32,
      });
    }
  }

  // ───────────────────────────────────────────────────────────── charge ────
  _beginCharge() {
    const c = this.weapon.charge; if (!c) return;
    this.state = 'charge'; this.t = 0; this.charge = 0; this.fired = false;
    this.actor.onWeaponState?.('charge', c);
    this.ctx.events.emit('weapon.charge.begin', { weapon: this.weaponId, actor: this.actor });
  }
  _stepCharge(dt) {
    const c = this.weapon.charge;
    this.t += dt;
    this.charge = this.combat.clamp01((this.t - c.windup) / Math.max(1e-4, c.fullHold - c.windup));
    // the tell: a ring that closes on the wielder as the shot ripens, and a
    // sharp flash at exactly full charge so the timing is learnable by eye
    if (this.charge >= 1 && !this._fullPing) {
      this._fullPing = true;
      this.ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.06, this.actor.position.z), { radius: 1.5, color: c.tell?.color || '#ffe9a8', life: 0.26 });
      this.ctx.audio?.sfx?.('charge.full', { pos: this.actor.position });
      this.ctx.events.emit('weapon.charge.full', { weapon: this.weaponId, actor: this.actor });
    }
    if (!this.holding && this.t >= c.windup + c.minHold) this._releaseCharge();
  }
  _releaseCharge() {
    const c = this.weapon.charge; if (!c) { this.state = 'idle'; return; }
    const full = this.charge >= 0.999;
    this._fullPing = false;
    if (this.weaponId === 'shield') return this._beginRush(full);
    this._loose(c, this.charge, full);
    this.state = 'attack';
    this.step = { name: 'loose', t0: 0, t1: 0.01, dur: (full ? (c.recoveryFull ?? c.recovery) : c.recovery), cancel: c.recovery * 0.3, chain: 1e9, root: null, sfx: '' };
    this.t = 0; this.fired = true; this.stepIndex = -1; this.queued = false;
  }
  _loose(c, k, full) {
    const A = this.actor, P = c.projectile;
    const lerp = (a, b) => a + ((b ?? a) - a) * k;
    const slot = c.action === 'special' ? 'special' : 'attack';
    const { mods, rider } = this._boon(slot);
    const slotMul = slot === 'special' ? (mods?.specialMul || 1) : (mods?.attackMul || 1);
    const col = rider?.color || (full && P.colorFull ? P.colorFull : P.color);
    const dashBonus = slot === 'attack' && A._boonPostDash && rider?.postDashBonus ? rider.postDashBonus : 0;
    if (dashBonus) A._boonPostDash = false;
    const id = this.combat.projectiles.fire({
      x: A.position.x + A.facing.x * 0.7, y: 1.12, z: A.position.z + A.facing.y * 0.7,
      dx: A.facing.x, dz: A.facing.y,
      kind: P.kind, speed: lerp(P.speed, P.speedFull), radius: P.radius, life: P.life,
      damage: lerp(P.damage, P.damageFull) * slotMul * (mods?.dmgMul || 1) + (rider?.bonus || 0) + dashBonus,
      type: rider?.type || P.type,
      pierce: Math.round(lerp(P.pierce, P.pierceFull)),
      knockback: lerp(P.knockback, P.knockbackFull) + (rider?.knockback || 0) + (mods?.knockback || 0), hitstop: lerp(P.hitstop, P.hitstopFull),
      color: col, size: lerp(P.size, P.sizeFull), coreSize: lerp(P.coreSize, P.coreSizeFull),
      crit: lerp(P.crit ?? 0, P.critFull ?? 0) + (this.weapon.critChance || 0) + (rider?.critChance || 0),
      status: rider?.status || P.status, statusStacks: rider?.stacks || P.statusStacks || 1, statusPower: rider?.statusPower || 0,
      expose: rider?.expose || 0, boonGod: rider?.god, boonSlot: slot,
      source: A, hero: true, onExpire: P.onExpire || 'burst',
      shake: full ? 0.2 : 0.08,
    });
    if (P.stick) this.stuck = id;
    const sh = full && c.shakeFull ? c.shakeFull : c.shake;
    if (sh) this.ctx.events.emit('camera.shake', sh);
    this.ctx.audio?.sfx?.(full && c.sfxFull ? c.sfxFull : c.sfx, { pos: A.position });
    this.ctx.vfx?.burst?.(this.combat._v3a.set(A.position.x + A.facing.x * 0.8, 1.14, A.position.z + A.facing.y * 0.8),
      { count: full ? 22 : 9, color: col, speed: full ? 11 : 6, spread: 0.45, kind: 'chev', dir: this.combat._v3b.set(A.facing.x, 0.12, A.facing.y) });
    if (rider) this._playBoonFx(rider, this.combat._v3a.set(A.position.x + A.facing.x, 1.1, A.position.z + A.facing.y), this.combat._v3b.set(A.facing.x, 0.12, A.facing.y), slot);
    if (slot === 'special' && rider?.deflect) this.combat.activateDeflect(A, rider.deflect, rider.color);
    this.ctx.events.emit('weapon.loose', { weapon: this.weaponId, charge: k, full, actor: A });
    if (full) this.ctx.engine?.slowmo?.(0.55, 0.10);
  }

  // ────────────────────────────────────────────────── shield rush / block ──
  _beginRush(full) {
    const c = this.weapon.charge;
    const { mods, rider } = this._boon('special');
    this.state = 'rush'; this.t = 0; this.rootDone = 0; this._rushFull = full;
    this._rushDist = full ? c.dash.distanceFull : c.dash.distance;
    this._rushTime = full ? c.dash.timeFull : c.dash.time;
    this.actor.onWeaponState?.('rush', c);
    this.hbId = this.combat.hitboxes.spawn({
      shape: c.hitbox.shape, owner: this.actor, source: this.actor,
      radius: c.hitbox.radius, maxTargets: c.hitbox.maxTargets, pierce: c.hitbox.pierce,
      t0: 0, t1: this._rushTime, life: this._rushTime + 0.02,
      damage: (full ? c.damageFull : c.damage) * (mods?.specialMul || 1) * (mods?.dmgMul || 1) + (rider?.bonus || 0),
      type: rider?.type || c.type || 'physical',
      knockback: (full ? c.knockbackFull : c.knockback) + (rider?.knockback || 0) + (mods?.knockback || 0),
      poiseDamage: c.poise, hitstop: full ? c.hitstopFull : c.hitstop,
      status: rider?.status, statusStacks: rider?.stacks || 1, statusPower: rider?.statusPower || 0,
      crit: (this.weapon.critChance || 0) + (rider?.critChance || 0), expose: rider?.expose || 0,
      boonGod: rider?.god, boonSlot: 'special',
      shake: (full ? c.shakeFull : c.shake).amp, color: rider?.color || c.color, tag: 'shield:rush',
    });
    this.ctx.vfx?.shockwave?.(this.combat._v3a.set(this.actor.position.x, 0.06, this.actor.position.z), { radius: full ? 2.6 : 1.8, color: rider?.color || c.color, life: 0.3 });
    if (rider) this._playBoonFx(rider, this.combat._v3a.set(this.actor.position.x, 1.0, this.actor.position.z), this.combat._v3b.set(this.actor.facing.x, 0, this.actor.facing.y), 'special');
    if (rider?.deflect) this.combat.activateDeflect(this.actor, rider.deflect, rider.color);
    this.ctx.events.emit('camera.shake', full ? c.shakeFull : c.shake);
    this.ctx.audio?.sfx?.(c.sfx, { pos: this.actor.position });
  }
  _stepRush(dt) {
    const c = this.weapon.charge;
    this.t += dt;
    const a = this.combat.clamp01(this.t / this._rushTime);
    const want = this._rushDist * (1 - Math.pow(1 - a, 2.4));
    const d = want - this.rootDone; this.rootDone = want;
    const A = this.actor;
    A.position.x += A.facing.x * d; A.position.z += A.facing.y * d;
    this.ctx.world?.collide?.(A.position, A.radius || 0.45);
    if (this.t >= this._rushTime + c.recovery) { this.state = 'idle'; this.hbId = 0; }
  }

  _beginBlock() {
    const b = this.weapon.block; if (!b) return;
    if (this.busy) return;
    this.state = 'block'; this.t = 0; this.blockT = 0; this.holding = true;
    this.actor.blocking = this;
    this.actor.onWeaponState?.('block', b);
    this.ctx.audio?.sfx?.(b.sfx, { pos: this.actor.position });
    this.ctx.events.emit('weapon.block.begin', { actor: this.actor, weapon: this.weaponId });
  }
  _stepBlock(dt) {
    const b = this.weapon.block, c = this.weapon.charge;
    this.t += dt;
    // reflect anything hostile that enters the guard arc
    const A = this.actor;
    if (this.t >= b.raise) {
      const half = Math.cos(b.arcDeg * 0.5 * Math.PI / 180);
      this.combat.projectiles.forEachIncoming(A, 1.9, (p) => {
        const dx = p.x - A.position.x, dz = p.z - A.position.z;
        const l = Math.hypot(dx, dz) || 1;
        if ((dx / l) * A.facing.x + (dz / l) * A.facing.y < half) return;
        if (this.combat.projectiles.reflect(p, A, b.reflectMul, b.reflectSpeed)) {
          this.ctx.audio?.sfx?.(b.sfxReflect, { pos: A.position });
          this.ctx.events.emit('camera.shake', { amp: 0.09, dur: 0.16, freq: 33 });
          this.combat.hitstop(52);
        }
      });
    }
    if (c && c.requiresBlock) this.charge = this.combat.clamp01((this.t - c.minHold) / Math.max(1e-4, c.fullHold - c.minHold));
    if (!this.holding) this._endBlock();
  }
  _endBlock() {
    const c = this.weapon.charge;
    this.actor.blocking = null;
    if (c && c.requiresBlock && this.t >= c.minHold) { this._beginRush(this.charge >= 0.999); return; }
    this.state = 'idle';
    this.ctx.events.emit('weapon.block.end', { actor: this.actor });
  }

  /** Called by CombatSystem before damage lands on a blocking wielder. */
  absorb(info) {
    const b = this.weapon.block;
    if (!b || this.state !== 'block') return info.amount;
    const A = this.actor;
    const d = info.dir;
    if (d) {
      const half = Math.cos(b.arcDeg * 0.5 * Math.PI / 180);
      // info.dir points from the attacker toward the victim
      if (-(d.x * A.facing.x + (d.z ?? 0) * A.facing.y) < half) return info.amount;
    }
    const perfect = this.t <= b.perfect;
    this.ctx.vfx?.impact?.(this.combat._v3a.set(A.position.x + A.facing.x * 0.9, 1.15, A.position.z + A.facing.y * 0.9),
      this.combat._v3b.set(-A.facing.x, 0, -A.facing.y), { type: 'arcane', scale: perfect ? 1.2 : 0.7, color: b.color });
    this.ctx.events.emit('weapon.blocked', { actor: A, perfect, amount: info.amount });
    if (perfect) {
      this.combat.hitstop(b.perfectHitstop);
      this.ctx.engine?.slowmo?.(b.perfectSlowmo[0], b.perfectSlowmo[1]);
      return 0;
    }
    this.combat.hitstop(40);
    return info.amount * (1 - b.absorb) + info.amount * b.chipMul * 0;
  }

  /** Recall the stuck spear — it flies home through everything in the way. */
  recall() {
    const c = this.weapon.charge;
    if (!c || !c.recall) return false;
    const P = this.combat.projectiles;
    const A = this.actor;
    // fire the return leg from wherever the throw ended up (or from max range)
    const ox = A.position.x + A.facing.x * 7.5, oz = A.position.z + A.facing.y * 7.5;
    const dx = A.position.x - ox, dz = A.position.z - oz;
    P.fire({
      x: ox, y: 1.1, z: oz, dx, dz, kind: 'straight',
      speed: c.recall.speed, radius: c.recall.radius, life: 1.1,
      damage: c.recall.damage, pierce: c.recall.pierce, knockback: c.recall.knockback,
      hitstop: c.recall.hitstop, color: c.recall.color, source: A, hero: true, size: 1.2,
    });
    this.stuck = null;
    this.ctx.audio?.sfx?.('spear.recall', { pos: A.position });
    return true;
  }
}

export default WEAPONS;
