// OWNER: AGENT-COMBAT
// ---------------------------------------------------------------------------
// combat.js — the damage authority. Everything that hurts anything in EREBUS
// funnels through applyDamage(), which is why VFX, UI and audio can react to
// the whole game without knowing what a spear is.
//
// WHAT LIVES HERE
//   * applyDamage()      — the §2.6 contract, unchanged, now with resistances,
//                          crits, armour, poise, i-frames and status riders.
//   * DAMAGE TYPES       — physical/fire/lightning/frost/poison/arcane, each
//                          with a per-entity resistance table.
//   * STATUS EFFECTS     — burn, chill, shock, doom, weak. Stacking, per-stack
//                          scaling, deterministic tick on the fixed step.
//   * POISE / ARMOUR     — heavy enemies eat small hits without flinching and
//                          break spectacularly when their poise is gone. This
//                          is what stops stun-lock, which is the single fastest
//                          way to make an action game boring.
//   * KNOCKBACK          — an impulse with critically-damped spring recovery.
//   * COMBAT INTENSITY   — one 0..1 number, from recent damage + live enemies,
//                          published on the bus for camera, music and post.
//
// WHY INTENSITY IS HERE AND NOT IN THE CAMERA: three systems want the same
// curve. If each derives its own, they disagree by a frame or two and the
// frame's push-in, the music swell and the grade lag each other — which reads
// as mush. One authority, one event.
//
// HITSTOP AND SLOW-MO ARE THE ENGINE'S. We call engine.hitstop()/slowmo();
// we never touch ctx.time.scale.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { HitboxSystem, TEAM } from './hitbox.js';
import { ProjectileSystem } from './projectiles.js';
import { WEAPONS, WEAPON_IDS, WeaponRuntime } from './weapons.js';

const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

// ── damage identity ────────────────────────────────────────────────────────
export const DAMAGE_TYPES = ['physical', 'fire', 'lightning', 'frost', 'poison', 'arcane'];

// ── status catalogue — DATA. Tuning never touches the tick loop. ───────────
export const STATUS = {
  burn: {
    color: '#ff8c1a', type: 'fire', maxStacks: 8, dur: 3.2, refresh: true,
    tick: 0.45, dps: 3.2, dpsPerStack: 1.8, fx: 'ember',
  },
  chill: {
    color: '#3fb8ff', type: 'frost', maxStacks: 10, dur: 4.0, refresh: true,
    tick: 0.5, dps: 0, slowPerStack: 0.065, maxSlow: 0.55, shatterAt: 10, shatterDamage: 45, fx: 'sparkFine',
  },
  shock: {
    color: '#ffe14d', type: 'lightning', maxStacks: 5, dur: 2.6, refresh: true,
    tick: 0.62, dps: 2.4, dpsPerStack: 2.6, poisePerTick: 6, fx: 'spark',
  },
  doom: {
    // No tick damage: a visible knife hangs above the victim, its halo counts
    // down, and it falls during the final quarter before this burst resolves.
    color: '#a05fe0', type: 'arcane', maxStacks: 4, dur: 1.35, refresh: false,
    tick: 0, burst: 34, burstPerStack: 22, fx: 'rune',
  },
  weak: {
    color: '#8ef0d0', type: 'arcane', maxStacks: 3, dur: 5.0, refresh: true,
    tick: 0, outgoingPerStack: 0.18, maxOutgoing: 0.5, fx: 'wisp',
  },
};

// ── the intensity curve, in one place ──────────────────────────────────────
const INTENSITY = {
  damageWeight: 1 / 260,     // recent damage that saturates the term
  enemyWeight: 1 / 6,        // live enemies that saturate the term
  damageDecay: 0.62,         // per second
  rise: 7.5, fall: 1.35,     // damp rates toward the target
  emitDelta: 0.02,
};

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

export class CombatSystem {

  // ─────────────────────────────────────────────────────────────── init ────
  async init(ctx) {
    this.ctx = ctx;
    this.entities = new Set();
    this._list = [];                 // allocation-free iteration mirror
    this._dirty = true;

    this.hitboxes = new HitboxSystem().init(ctx, this);
    this.projectiles = new ProjectileSystem().init(ctx, this);

    this._status = new Map();        // entity -> array of live status records
    this._expose = new Map();        // entity -> { bonus, t }
    this._critMark = new Map();      // entity -> { chance, t }
    this._knock = [];                // entities under a knockback spring
    this._boonPulses = [];           // deterministic delayed boon strikes

    this.intensity = 0;
    this._recentDamage = 0;
    this._intensityEmitted = -1;

    this.rng = ctx.rng.fork ? ctx.rng.fork('combat') : ctx.rng;
    this._v3a = new THREE.Vector3(); this._v3b = new THREE.Vector3();

    // the player's weapon. Other actors get one on demand via runtimeFor().
    this.runtimes = new Map();
    this.weaponId = 'blade';
    // A descent binds one Infernal Arm. HomeBase is the only system allowed
    // to choose it; once the portal is crossed every later swap request is
    // rejected here, including rewards and any future UI/debug caller.
    this.weaponLocked = false;
    this.playerDrivesBlade = true;   // see special()

    ctx.hitboxes = this.hitboxes;
    ctx.projectiles = this.projectiles;
    ctx.weapons = this;

    this._cap = { on: false, t: 0, i: 0 };
    ctx.events.on('capture.state', ({ name }) => this._captureState(name, ctx));
    ctx.events.on('room.built', () => { this.hitboxes.clear(); this.projectiles.clear(); this._status.clear(); this._expose.clear(); this._critMark.clear(); this._knock.length = 0; this._boonPulses.length = 0; });
    return this;
  }

  clamp01(v) { return clamp01(v); }

  // ─────────────────────────────────────────────────────────── registry ────
  register(e) {
    if (!e) return;
    this.entities.add(e); this._dirty = true;
    if (e.poiseMax == null) e.poiseMax = e === this.ctx.player ? 0 : 24;
    if (e.poise == null) e.poise = e.poiseMax;
    if (e.iframes == null) e.iframes = 0;
    if (e.knockLambda == null) { e._combatKnock = true; if (!e.knock) e.knock = new THREE.Vector3(); }
  }
  unregister(e) {
    this.entities.delete(e); this._dirty = true;
    this._status.delete(e);
    this._expose.delete(e);
    this._critMark.delete(e);
    this.hitboxes.cancelByOwner(e);
    const i = this._knock.indexOf(e); if (i >= 0) this._knock.splice(i, 1);
  }
  _targets() {
    if (this._dirty) { this._list.length = 0; for (const e of this.entities) this._list.push(e); this._dirty = false; }
    return this._list;
  }

  // ────────────────────────────────────────────────────────── weapons ─────
  runtimeFor(actor, weaponId) {
    let r = this.runtimes.get(actor);
    if (!r) { r = new WeaponRuntime(this, actor, weaponId || this.weaponId); this.runtimes.set(actor, r); }
    else if (weaponId && r.weaponId !== weaponId) r.equip(weaponId);
    return r;
  }
  /** Equip at the Crossroads. During a descent only the bound arm is legal. */
  equip(id, o = {}) {
    if (!WEAPONS[id]) return null;
    if (this.weaponLocked && id !== this.weaponId && !o.force) {
      this.ctx.ui?.toast?.('INFERNAL ARM BOUND FOR THIS DESCENT', { color: WEAPONS[this.weaponId]?.palette?.body || '#c9b8ff' });
      return null;
    }
    this.weaponId = id;
    const p = this.ctx.player;
    // runtimeFor(actor, id) already performs the swap when the id differs.
    // Calling equip() again here emitted duplicate HUD/audio events.
    if (p) this.runtimeFor(p, id);
    if (!o.silent) this.ctx.ui?.toast?.(WEAPONS[id].name, { color: WEAPONS[id].palette.body });
    return WEAPONS[id];
  }
  lockWeapon(id = this.weaponId) {
    const weapon = this.equip(id, { force: true, silent: true });
    if (!weapon) return null;
    this.weaponLocked = true;
    this.ctx.events?.emit?.('weapon.locked', { id, weapon });
    return weapon;
  }
  unlockWeapon() {
    this.weaponLocked = false;
    this.ctx.events?.emit?.('weapon.unlocked', { id: this.weaponId });
  }
  cycleWeapon(o = {}) {
    if (this.weaponLocked && !o.force) {
      this.ctx.ui?.toast?.('INFERNAL ARM BOUND FOR THIS DESCENT', { color: WEAPONS[this.weaponId]?.palette?.body || '#c9b8ff' });
      return null;
    }
    const i = WEAPON_IDS.indexOf(this.weaponId);
    return this.equip(WEAPON_IDS[(i + 1) % WEAPON_IDS.length], o);
  }

  // ── hooks player.js already calls (ARCHITECTURE §2, do not rename) ──────
  special({ source, origin, dir } = {}) {
    if (!source) return;
    // player.js owns the BLADE's own special swing (it calls _swing itself the
    // same frame it calls us). Running the table's version too would apply the
    // damage twice. Every other arm is ours end to end.
    if (source === this.ctx.player && this.weaponId === 'blade' && this.playerDrivesBlade) return;
    const r = this.runtimeFor(source, this.weaponId);
    r.press('special');
    // weapons without a hold state resolve immediately on the same frame
    if (r.state === 'charge' || r.state === 'block') r.release('special');
  }
  cast({ source, origin, dir, power = 1 } = {}) {
    if (!source || !origin || !dir) return;
    const mods = source === this.ctx.player ? this.ctx.boons?.mods : null;
    const rider = mods?.rider?.cast || null;
    const forge = source === this.ctx.player ? mods?.forge?.[this.weaponId] : null;
    const forgeCastMul = forge?.castMul || 1;
    const color = rider?.color || '#a05fe0';
    const god = rider?.god;
    const fxKind = ({ zeus: 'sparkFine', poseidon: 'wisp', athena: 'shard', aphrodite: 'mote', ares: 'rune', artemis: 'chev', dionysus: 'wisp', hermes: 'chev', hecate: 'rune', selene: 'star' })[god] || 'spark';
    // Selene's ray is a real sustained line: five separately-resolving pulses
    // over one second, so enemies entering the beam late can still be struck.
    if (mods?.castBeam && rider) {
      this._boonPulses.push({
        kind: 'beam', t: 0, interval: 0.20, left: 5, source,
        x: origin.x, z: origin.z, dx: dir.x, dz: dir.z,
        damage: rider.bonus * power * (mods.castMul || 1) * forgeCastMul * (mods.dmgMul || 1) / 5,
        type: rider.type || 'arcane', color, god, status: rider.status,
        statusStacks: rider.stacks || 1, statusPower: rider.statusPower || 0,
      });
      this.ctx.vfx?.beam?.(origin, this._v3a.set(origin.x + dir.x * 15, origin.y, origin.z + dir.z * 15), { color, width: 0.48, life: 1.0 });
      this.ctx.vfx?.burst?.(origin, { count: 22, color, speed: 8, spread: 0.34, kind: fxKind, dir });
      this.ctx.events.emit('camera.shake', { amp: 0.09, dur: 0.24, freq: 28 });
      return;
    }
    const damage = mods?.castTicks && rider
      ? rider.bonus * power * (mods.castMul || 1) * forgeCastMul * (mods.dmgMul || 1)
      : 26 * power * (mods?.castMul || 1) * forgeCastMul * (mods?.dmgMul || 1) + (rider?.bonus || 0);
    const forgeSeek = forge?.castSeek || 0;
    const forgeBounces = forge?.castBounces || 0;
    const castHoming = Math.max(mods?.castSeek ? 7.5 : 0, forgeSeek);
    // The CAST remains weapon-agnostic, but its damage identity, status,
    // seeking and burst size now visibly inherit the chosen god.
    this.projectiles.fire({
      x: origin.x, y: origin.y, z: origin.z, dx: dir.x, dz: dir.z,
      kind: castHoming ? 'homing' : forgeBounces ? 'bounce' : 'straight', homing: castHoming,
      speed: 30 + 8 * power, radius: 0.30 + Math.min(0.34, (mods?.castRadius || 0) * 0.12), life: 1.4,
      damage,
      type: rider?.type || 'arcane', pierce: 3 + Math.round(forge?.castPierce || 0), bounces: Math.round(forgeBounces), knockback: 3.2 + (mods?.knockback || 0), hitstop: 62,
      poiseDamage: god === 'athena' ? 999 : damage * 0.4,
      status: rider ? rider.status : 'doom', statusStacks: rider?.stacks || 1, statusPower: rider?.statusPower || 0,
      color, size: rider ? 1.55 + (rider.tier || 1) * 0.14 : 1.5,
      coreSize: rider ? 1.30 + (rider.tier || 1) * 0.11 : 1.3,
      blastRadius: Math.max(mods?.castRadius || 0, forge?.castBlast || 0), crit: rider?.critChance || 0,
      forks: mods?.castForks || 0, castTicks: mods?.castTicks || 0, tickDamage: rider?.bonus || 0,
      boonGod: god, boonSlot: 'cast', expose: rider?.expose || 0,
      source, hero: true, onExpire: 'impact',
    });
    this.ctx.vfx?.burst?.(origin, { count: rider ? 15 + (rider.tier || 1) * 4 : 14, color, speed: 9, spread: 0.42, kind: fxKind, dir });
    if (rider && (mods?.castRadius || ['poseidon', 'dionysus', 'selene'].includes(god))) {
      this.ctx.vfx?.shockwave?.(this._v3a.set(origin.x, 0.07, origin.z), { radius: 1.6 + (mods?.castRadius || 0) * 0.35, color, life: 0.38 });
    }
    this.ctx.events.emit('camera.shake', { amp: 0.07, dur: 0.18, freq: 28 });
    if (forge && (forge.castMul > 1 || forge.castBlast || forge.castPierce || forge.castSeek || forge.castBounces)) {
      this.ctx.events.emit('forge.triggered', { weapon: this.weaponId, effect: 'cast' });
    }
  }
  summon({ source, pos, dir } = {}) {
    if (!source || !pos) return;
    const mods = source === this.ctx.player ? this.ctx.boons?.mods : null;
    const call = mods?.rider?.call;
    // R is a commitment, not a projectile fountain. The old fallback had no
    // recharge at all and each of its three motes carried 255 pierce for six
    // seconds, so rapidly tapping R could erase a room. Calls and the fallback
    // now share the same visible recharge state.
    if ((source._boonCallCd || 0) > 0) {
      this.ctx.ui?.toast?.(`Call recharging: ${source._boonCallCd.toFixed(1)}s`, { color: call?.color || '#8ef0d0' });
      return false;
    }
    if (call) {
      const radius = 4.25 + (call.tier || 1) * 0.15;
      const damage = (call.bonus || 0) * (mods.callMul || 1) * (mods.dmgMul || 1);
      for (const target of this._targets()) {
        if (!target || target === source || target === this.ctx.player || target.dead || target.alive === false) continue;
        const dx = target.position.x - pos.x, dz = target.position.z - pos.z;
        if (dx * dx + dz * dz > radius * radius) continue;
        const d = Math.hypot(dx, dz) || 1;
        this.applyDamage({ target, amount: damage, type: call.type || 'arcane', source,
          dir: this._v3a.set(dx / d, 0, dz / d), pos: target.position, knockback: 5,
          status: call.status, statusStacks: call.stacks || 1, statusPower: call.statusPower || 0,
          boonGod: call.god, boonSlot: 'call' });
      }
      source._boonCallCd = 14 / Math.max(0.25, mods.callCharge || 1);
      if (mods.callRefund > 0 && source.mana != null) {
        source.mana = Math.min(source.maxMana || source.mana, source.mana + mods.callRefund);
        this.ctx.ui?.setMana?.(source.mana, source.maxMana);
      }
      this.ctx.vfx?.shockwave?.(pos.clone().setY(0.06), { radius, color: call.color, life: 0.72 });
      this.ctx.vfx?.burst?.(pos.clone().setY(1.1), { count: 42, color: call.color, speed: 13, spread: 1.35, kind: 'star' });
      this.ctx.events.emit('player.called', { pos, god: call.god, damage, radius });
      this.ctx.events.emit('camera.shake', { amp: 0.24, dur: 0.42, freq: 24 });
      return true;
    }
    // Three short-lived shade motes remain readable and useful, but each can
    // now hit only three foes instead of piercing the room indefinitely.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      this.projectiles.fire({
        x: pos.x + Math.cos(a) * 2.25, y: 1.15, z: pos.z + Math.sin(a) * 2.25,
        kind: 'orbit', orbitX: pos.x, orbitZ: pos.z, orbitRadius: 2.25, orbitSpeed: 2.8, orbitAngle: a,
        radius: 0.26, life: 4.5, damage: 7, type: 'arcane', pierce: 3,
        knockback: 1.4, hitstop: 24, color: '#8ef0d0', size: 1.05, source,
      });
    }
    source._boonCallCd = 14;
    this.ctx.events.emit('player.summoned', { pos });
    return true;
  }

  /** Athena action window: nullifies direct hits and reflects hostile bolts. */
  activateDeflect(source, seconds, color = '#b7e4ff') {
    if (!source || seconds <= 0) return;
    source._boonDeflectT = Math.max(source._boonDeflectT || 0, seconds);
    this.ctx.vfx?.shockwave?.(source.position.clone().setY(0.08), { radius: 1.7, color, life: Math.min(0.5, seconds) });
    this.ctx.events.emit('boon.deflect', { source, seconds, color });
  }

  // ═══════════════════════════════════════════════════════ APPLY DAMAGE ════
  /**
   * applyDamage({ target, amount, type, crit, dir, pos, source, knockback, statuses })
   *   -> the damage actually dealt (0 if it was ignored)
   * SIGNATURE IS FROZEN — every extra rider is optional.
   */
  applyDamage(info) {
    const t = info.target;
    if (!t || t.dead || t.alive === false) return 0;
    const ctx = this.ctx;

    // i-frames apply to ANY entity that carries them, not just the player.
    if ((t.iframes || 0) > 0 && !info.ignoreIFrames) return 0;
    if (t.invulnerable) return 0;

    let amount = info.amount || 0;
    const type = info.type || 'physical';
    const src = info.source;

    if (t === ctx.player) {
      const mods = ctx.boons?.mods;
      const dodge = (mods?.dodge || 0) + ((t._boonDeflectT || 0) > 0 ? (mods?.deflectDodge || 0) : 0);
      if (dodge > 0 && this.rng.f() < dodge) {
        ctx.vfx?.burst?.(t.position.clone().setY(1.0), { count: 10, color: '#f2c14e', speed: 7, spread: 0.8, kind: 'chev' });
        ctx.events.emit('damage.dodged', { target: t, source: src, pos: t.position });
        return 0;
      }
      if ((t._boonDeflectT || 0) > 0 && !info.ignoreDeflect) {
        ctx.vfx?.burst?.(t.position.clone().setY(1.0), { count: 16, color: '#b7e4ff', speed: 9, spread: 1.0, kind: 'shard' });
        ctx.events.emit('damage.deflected', { target: t, source: src, pos: t.position });
        return 0;
      }
      amount *= mods?.damageTaken || 1;
    }

    // ── a blocking wielder gets first refusal ────────────────────────────
    if (t.blocking && t.blocking.absorb) amount = t.blocking.absorb({ ...info, amount });
    if (amount <= 0) return 0;

    // ── attacker debuffs (weak) ─────────────────────────────────────────
    if (src) {
      const w = this._stack(src, 'weak');
      if (w) amount *= 1 - Math.min(STATUS.weak.maxOutgoing, w * STATUS.weak.outgoingPerStack);
    }

    // Player-side conditional boons are resolved here, the one authority that
    // sees hit type, target statuses and source together.
    const playerMods = src === ctx.player ? ctx.boons?.mods : null;
    const exposure = this._expose.get(t);
    if (playerMods && exposure) amount *= 1 + exposure.bonus;
    if (playerMods) {
      const hangover = this._stack(t, 'burn');
      if (hangover) {
        amount *= 1 + hangover * (playerMods.hangoverAmp || 0);
        if (this._stack(t, 'weak')) amount *= 1 + hangover * (playerMods.hangoverVsWeak || 0);
      }
    }

    // ── crit ────────────────────────────────────────────────────────────
    let crit = !!info.crit;
    if (!crit) {
      const chance = (info.critChance || 0) + ((src && src.critChance) || 0)
        + (playerMods ? (this._critMark.get(t)?.chance || 0) : 0)
        + (playerMods && type === 'lightning' ? (playerMods.lightningCrit || 0) : 0);
      if (chance > 0 && this.rng.f() < chance) crit = true;
    }
    if (crit) amount *= (info.critMul ?? (src && src.critMul) ?? 2.0);

    // ── resistances / armour ────────────────────────────────────────────
    const res = t.resist ? (t.resist[type] ?? 0) : 0;
    amount *= (1 - res);
    if (t.armour) amount = Math.max(amount * 0.15, amount - t.armour);
    // chilled targets take more; that is the reason to stack it
    const chill = this._stack(t, 'chill');
    if (chill) amount *= 1 + chill * 0.02;

    amount = Math.max(0, Math.round(amount * 10) / 10);

    // ── poise / stagger ─────────────────────────────────────────────────
    let staggered = false;
    if (t.poiseMax > 0) {
      t.poise -= (info.poiseDamage ?? amount * 0.5);
      t.poiseRegenDelay = 0.85;
      if (t.poise <= 0) {
        t.poise = t.poiseMax; staggered = true;
        ctx.events.emit('entity.staggered', { entity: t, pos: info.pos || t.position, dir: info.dir });
      }
    } else staggered = true;   // no poise = always flinches

    // ── commit ──────────────────────────────────────────────────────────
    t.health = (t.health ?? 1) - amount;
    if (t === ctx.player) {
      t.iframes = Math.max(t.iframes || 0, t.tune ? t.tune.hurtIFrames : 0.6);
      ctx.ui?.setHealth?.(Math.max(0, t.health), t.maxHealth || 100);
    }

    // ── knockback with spring recovery ──────────────────────────────────
    const kb = info.knockback || 0;
    if (kb > 0 && info.dir) {
      const mass = t.mass || 1;
      const k = (kb / mass) * (staggered ? 1 : 0.28);
      if (!t.knock) t.knock = new THREE.Vector3();
      t.knock.x += (info.dir.x || 0) * k;
      t.knock.z += (info.dir.z ?? info.dir.y ?? 0) * k;
      if (t._combatKnock && this._knock.indexOf(t) < 0) this._knock.push(t);
    }

    // ── status riders ───────────────────────────────────────────────────
    if (info.statuses) for (const s of info.statuses) this.applyStatus(t, s.kind || s, s.stacks || 1, src, s.power || 0);
    if (info.status) this.applyStatus(t, info.status, info.statusStacks || 1, src, info.statusPower || 0);
    if (info.expose > 0 && src === ctx.player) this._expose.set(t, { bonus: info.expose, t: 5.0 });
    if (info.critMark > 0 && src === ctx.player) this._critMark.set(t, { chance: info.critMark, t: 4.0 });

    // ── the canonical event (§2.5) + the UI number ──────────────────────
    const pos = info.pos || t.position;
    ctx.events.emit('damage.dealt', { target: t, amount, crit, dir: info.dir, pos, source: src, type, staggered, knockback: kb });
    ctx.events.emit('damage.number', { pos, amount, crit, type, target: t });
    ctx.ui?.damageNumber?.(pos, amount, { crit, type });

    this._recentDamage += amount * (t === ctx.player ? 2.2 : 1);

    if (!info.boonProc && t === ctx.player && src && src !== t && !src.dead && playerMods == null) {
      const mods = ctx.boons?.mods;
      if (mods?.retaliate > 0 && this.rng.f() < mods.retaliate) {
        this.applyDamage({ target: src, amount: mods.retaliateDmg, type: 'lightning', source: t,
          pos: src.position, dir: null, poiseDamage: 999, boonProc: true, ignoreIFrames: true });
        ctx.vfx?.beam?.(t.position.clone().setY(1.1), src.position.clone().setY(1.1), { color: '#ffe14d', width: 0.18, life: 0.22 });
      }
    }

    if (!info.boonProc && playerMods && t.health > 0) {
      if (crit && playerMods.critRiftDmg > 0) {
        this.applyDamage({ target: t, amount: playerMods.critRiftDmg, type: 'arcane', source: src,
          pos, dir: null, poiseDamage: 999, boonProc: true, ignoreIFrames: true });
        ctx.vfx?.shockwave?.(t.position.clone().setY(0.06), { radius: 2.1, color: '#c81d3c', life: 0.34 });
      }
      if (kb > 0) this._tryWallSlam(t, info, playerMods);
    }

    // ── death ───────────────────────────────────────────────────────────
    if (t.health <= 0) {
      t.dead = true; t.alive = false; t.health = 0;
      this._status.delete(t);
      this._expose.delete(t);
      this._critMark.delete(t);
      this.hitboxes.cancelByOwner(t);
      ctx.events.emit('entity.died', { entity: t, pos: pos || t.position, dir: info.dir, source: src, type });
      if (t !== ctx.player) { this.hitstop(70); this._recentDamage += 40; }
    }
    return amount;
  }

  /** engine hitstop, suppressed in the capture harness (it stops sim time). */
  hitstop(ms) {
    if (!ms) return;
    if (this.ctx.CAPTURE) return;
    this.ctx.engine?.hitstop?.(ms);
    this.ctx.events.emit('hit.stop', { ms });
  }

  // ────────────────────────────────────────────────────── status effects ───
  applyStatus(target, kind, stacks = 1, source = null, power = 0) {
    const D = STATUS[kind];
    if (!D || !target || target.dead) return;
    let list = this._status.get(target);
    if (!list) { list = []; this._status.set(target, list); }
    let rec = null;
    for (let i = 0; i < list.length; i++) if (list[i].kind === kind) { rec = list[i]; break; }
    const sourceMods = source === this.ctx.player ? this.ctx.boons?.mods : null;
    const duration = D.dur * (sourceMods?.statusDuration?.[kind] || 1);
    if (!rec) { rec = { kind, stacks: 0, t: 0, dur: duration, tick: 0, source, power: 0 }; list.push(rec); }
    rec.stacks = Math.min(D.maxStacks, rec.stacks + stacks);
    if (D.refresh) { rec.t = 0; rec.dur = duration; }
    rec.source = source || rec.source;
    rec.power = Math.max(rec.power || 0, power || 0);
    this.ctx.events.emit('status.applied', { target, kind, stacks: rec.stacks, color: D.color });
    if (kind === 'doom') this.ctx.vfx?.doomMark?.(target, rec);
    // chill shatter: the payoff for a full stack bar
    if (kind === 'chill' && D.shatterAt && rec.stacks >= D.shatterAt) {
      rec.stacks = 0;
      const bonus = sourceMods ? (sourceMods.shatterDmg || 0) + (sourceMods.moonlightShatter || 0) : 0;
      this.applyDamage({ target, amount: D.shatterDamage + bonus, type: 'frost', source, pos: target.position, dir: null, poiseDamage: 999, boonProc: true });
      this.ctx.vfx?.burst?.(target.position, { count: 22, color: D.color, speed: 9, spread: 1.2, kind: 'shard' });
      this.ctx.events.emit('status.shatter', { target, kind });
    }
  }
  _stack(e, kind) {
    const l = this._status.get(e); if (!l) return 0;
    for (let i = 0; i < l.length; i++) if (l[i].kind === kind) return l[i].stacks;
    return 0;
  }
  /** Movement multiplier from chill — read by whoever moves the entity. */
  slowOf(e) {
    const c = this._stack(e, 'chill'); if (!c) return 1;
    return 1 - Math.min(STATUS.chill.maxSlow, c * STATUS.chill.slowPerStack);
  }

  _statusTick(dt) {
    for (const [e, list] of this._status) {
      if (!e || e.dead || e.alive === false) { this._status.delete(e); continue; }
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i], D = STATUS[r.kind];
        r.t += dt;
        if (D.tick > 0) {
          r.tick += dt;
          if (r.tick >= D.tick) {
            r.tick -= D.tick;
            const dps = r.kind === 'burn' && r.power > 0
              ? r.power * r.stacks
              : (D.dps || 0) + (D.dpsPerStack || 0) * (r.stacks - 1);
            if (dps > 0) {
              this.applyDamage({
                target: e, amount: dps * D.tick, type: D.type, source: r.source,
                pos: e.position, dir: null, poiseDamage: D.poisePerTick || 0, ignoreIFrames: true,
              });
            }
            this.ctx.vfx?.burst?.(_v.set(e.position.x, e.position.y + 0.9, e.position.z),
              { count: 3, color: D.color, speed: 2.4, spread: 1.1, kind: D.fx, glow: false });
          }
        }
        if (r.t >= r.dur) {
          if (r.kind === 'doom') {
            const sourceMods = r.source === this.ctx.player ? this.ctx.boons?.mods : null;
            const weakBonus = sourceMods && this._stack(e, 'weak') ? (sourceMods.doomVsWeak || 0) : 0;
            const authored = r.power > 0 ? r.power : D.burst + D.burstPerStack * (r.stacks - 1);
            const dmg = authored + (sourceMods?.doomDmg || 0) + weakBonus;
            // The hanging knife has spent the final quarter of its timer
            // falling. Resolve the hit on the exact frame its point reaches
            // the target, then leave it embedded for a few frames of impact.
            this.ctx.vfx?.doomStrike?.(e);
            this.applyDamage({ target: e, amount: dmg, type: D.type, source: r.source, pos: e.position, dir: null, poiseDamage: 999, ignoreIFrames: true });
            this.ctx.vfx?.shockwave?.(_v.set(e.position.x, 0.06, e.position.z), { radius: 2.4, color: D.color, life: 0.4 });
            this.ctx.vfx?.burst?.(_v.set(e.position.x, e.position.y + 1.0, e.position.z), { count: 20, color: D.color, speed: 8, spread: 1.2, kind: 'rune' });
          }
          list.splice(i, 1);
          this.ctx.events.emit('status.expired', { target: e, kind: r.kind });
        }
      }
      if (!list.length) this._status.delete(e);
    }
  }

  // ────────────────────────────────────────── hitbox / projectile resolve ──
  /** Called by HitboxSystem when a live hitbox overlaps a valid target. */
  hit(h, e, nx, nz) {
    const dealt = this.applyDamage({
      target: e, amount: h.damage, type: h.type, crit: false,
      critChance: h.critBonus > 0 ? h.critBonus : 0,
      dir: _v.set(nx, 0, nz), pos: _v2.set(e.position.x, e.position.y + 1.0, e.position.z),
      source: h.source, knockback: h.knockback, poiseDamage: h.poiseDamage,
      status: h.statusKind, statusStacks: h.statusStacks,
      statusPower: h.statusPower, expose: h.expose, critMark: h.critMark, boonGod: h.boonGod, boonSlot: h.boonSlot,
    });
    if (dealt <= 0) return;
    const col = h.color || '#ffd27a';
    this.ctx.vfx?.impact?.(_v2.set(e.position.x, e.position.y + 1.0, e.position.z), _v.set(-nx, 0, -nz),
      { type: h.type, scale: 0.6 + Math.min(0.9, h.damage / 34), color: col });
    if (h.hitCount === 1) {
      this.hitstop(h.hitstop);
      if (h.shake) this.ctx.events.emit('camera.shake', { amp: h.shake, dur: 0.22, freq: 30 });
      this.ctx.audio?.sfx?.('hit', { pos: e.position });
    }
  }

  projectileHit(p, e, nx, nz) {
    const dealt = this.applyDamage({
      target: e, amount: p.damage, type: p.type,
      critChance: p.crit || 0,
      dir: _v.set(nx, 0, nz), pos: _v2.set(e.position.x, e.position.y + 1.0, e.position.z),
      source: p.source, knockback: p.knockback, poiseDamage: p.poiseDamage,
      status: p.status, statusStacks: p.statusStacks,
      statusPower: p.statusPower, expose: p.expose, boonGod: p.boonGod, boonSlot: p.boonSlot, boonProc: p.boonProc,
    });
    if (dealt <= 0) return;
    if (p.forks > 0 && p.hits === 0) {
      const candidates = [];
      for (const target of this._targets()) {
        if (!target || target === e || target === p.source || target === this.ctx.player || target.dead || target.alive === false) continue;
        const dx = target.position.x - e.position.x, dz = target.position.z - e.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= 49) candidates.push({ target, d2 });
      }
      candidates.sort((a, b) => a.d2 - b.d2);
      for (let i = 0; i < Math.min(p.forks, candidates.length); i++) {
        const target = candidates[i].target;
        this.applyDamage({ target, amount: p.damage * 0.64, type: 'lightning', source: p.source,
          pos: target.position, dir: null, status: 'shock', statusStacks: 1, boonProc: true });
        this.ctx.vfx?.beam?.(e.position.clone().setY(1.0), target.position.clone().setY(1.0), { color: '#ffe14d', width: 0.13, life: 0.18 });
      }
    }
    if (p.castTicks > 1 && p.hits === 0) {
      this._boonPulses.push({ kind: 'cuts', t: 0.11, interval: 0.13, left: p.castTicks - 1,
        source: p.source, target: e, x: e.position.x, z: e.position.z,
        damage: p.tickDamage || p.damage, type: p.type, color: new THREE.Color(p.cr, p.cg, p.cb).getStyle(), god: p.boonGod });
    }
    if (p.boonGod === 'dionysus' && p.boonSlot === 'cast' && p.hits === 0) {
      this._boonPulses.push({ kind: 'fog', t: 0.24, interval: 0.42, left: 3,
        source: p.source, x: e.position.x, z: e.position.z, radius: Math.max(2.2, p.blastRadius),
        damage: p.damage * 0.18, type: 'poison', color: '#a05fe0', status: 'burn', statusStacks: p.statusStacks, statusPower: p.statusPower });
    }
    if (p.blastRadius > 0) {
      const r2 = p.blastRadius * p.blastRadius;
      for (const target of this._targets()) {
        if (!target || target === e || target === p.source || target === this.ctx.player || target.dead || target.alive === false) continue;
        const dx = target.position.x - e.position.x, dz = target.position.z - e.position.z;
        if (dx * dx + dz * dz > r2) continue;
        this.applyDamage({
          target, amount: p.damage * 0.62, type: p.type, critChance: p.crit || 0,
          dir: _v.set(dx, 0, dz).normalize(), pos: target.position, source: p.source,
          knockback: p.knockback * 0.7, poiseDamage: p.poiseDamage,
          status: p.status, statusStacks: p.statusStacks,
          statusPower: p.statusPower, expose: p.expose, boonGod: p.boonGod, boonSlot: p.boonSlot,
        });
      }
      const blastColor = new THREE.Color(p.cr, p.cg, p.cb).getStyle();
      this.ctx.vfx?.shockwave?.(_v2.set(e.position.x, 0.06, e.position.z), { radius: p.blastRadius, color: blastColor, life: 0.38 });
    }
    this.hitstop(p.hitstop);
    if (p.shake) this.ctx.events.emit('camera.shake', { amp: p.shake, dur: 0.2, freq: 31 });
  }

  _tryWallSlam(target, info, mods) {
    const world = this.ctx.world;
    if (!world || !target?.position || !info.dir) return;
    const x = target.position.x, z = target.position.z;
    const d = Math.hypot(x, z) || 1;
    const a = Math.atan2(z, x);
    const r = world.radiusAt ? world.radiusAt(a) : (world.bounds?.r || 18);
    const outward = (info.dir.x * x + (info.dir.z ?? info.dir.y ?? 0) * z) / d;
    if (d < r - (target.radius || 0.5) - 3.0 || outward < 0.18) return;
    if (mods.wallSlamDmg > 0) {
      this.applyDamage({ target, amount: mods.wallSlamDmg, type: 'physical', source: info.source,
        pos: target.position, dir: null, poiseDamage: 999, boonProc: true, ignoreIFrames: true });
    }
    if (mods.seaStormDmg > 0 && !target.dead) {
      this.applyDamage({ target, amount: mods.seaStormDmg, type: 'lightning', source: info.source,
        pos: target.position, dir: null, poiseDamage: 999, status: 'shock', statusStacks: 1,
        boonProc: true, ignoreIFrames: true });
      this.ctx.vfx?.beam?.(target.position.clone().add(new THREE.Vector3(0, 7, 0)), target.position.clone().setY(1.0), { color: '#ffe14d', width: 0.22, life: 0.22 });
    }
    if (mods.slamSpeed > 0 && info.source) info.source._boonSlamT = 3.0;
    this.ctx.vfx?.shockwave?.(target.position.clone().setY(0.06), { radius: 2.0, color: '#5fd0ff', life: 0.32 });
    this.ctx.events.emit('boon.wallSlam', { target, source: info.source, damage: mods.wallSlamDmg + mods.seaStormDmg });
  }

  _updateBoonPulses(dt) {
    for (let i = this._boonPulses.length - 1; i >= 0; i--) {
      const q = this._boonPulses[i];
      q.t -= dt;
      if (q.t > 0) continue;
      q.t += q.interval;
      if (q.target && !q.target.dead) { q.x = q.target.position.x; q.z = q.target.position.z; }
      if (q.kind === 'beam') {
        this.hitboxes.spawn({ shape: 'capsule', owner: null, source: q.source,
          x: q.x, z: q.z, forward: [q.dx, q.dz], length: 15, radius: 0.46,
          t0: 0, t1: 0.06, life: 0.08, maxTargets: 12, damage: q.damage,
          type: q.type, knockback: 1.4, status: q.status, statusStacks: q.statusStacks,
          statusPower: q.statusPower, color: q.color, boonGod: q.god, boonSlot: 'cast', tag: 'boon:lunar-ray' });
      } else {
        const radius = q.radius || 1.55;
        for (const target of this._targets()) {
          if (!target || target === q.source || target === this.ctx.player || target.dead || target.alive === false) continue;
          const dx = target.position.x - q.x, dz = target.position.z - q.z;
          if (dx * dx + dz * dz > radius * radius) continue;
          this.applyDamage({ target, amount: q.damage, type: q.type, source: q.source,
            pos: target.position, dir: null, status: q.status, statusStacks: q.statusStacks,
            statusPower: q.statusPower, boonProc: true, ignoreIFrames: true });
        }
        const p = this._v3a.set(q.x, 0.08, q.z);
        if (q.kind === 'cuts') this.ctx.vfx?.slash?.(p, this._v3b.set(1, 0, 0), { arc: 210, radius, width: 0.34, color: q.color, spin: q.left % 2 ? 1 : -1 });
        else this.ctx.vfx?.shockwave?.(p, { radius, color: q.color, life: 0.30 });
      }
      q.left--;
      if (q.left <= 0) this._boonPulses.splice(i, 1);
    }
  }

  // ─────────────────────────────────────────────────────────── update ──────
  update(dt, ctx) {
    const targets = this._targets();

    // timers
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      if (!e) continue;
      if (e.iframes > 0 && e !== ctx.player) e.iframes = Math.max(0, e.iframes - dt);
      if (e.poiseMax > 0 && e.poise < e.poiseMax) {
        if (e.poiseRegenDelay > 0) e.poiseRegenDelay -= dt;
        else e.poise = Math.min(e.poiseMax, e.poise + e.poiseMax * 0.6 * dt);
      }
    }

    const player = ctx.player;
    if (player) {
      player._boonCallCd = Math.max(0, (player._boonCallCd || 0) - dt);
      player._boonDeflectT = Math.max(0, (player._boonDeflectT || 0) - dt);
      if (player._boonDeflectT > 0) {
        this.projectiles.forEachIncoming(player, 2.0, (p) => this.projectiles.reflect(p, player, 1.65, 1.25));
      }
    }
    for (const [target, rec] of this._expose) {
      rec.t -= dt;
      if (rec.t <= 0 || !target || target.dead) this._expose.delete(target);
    }
    for (const [target, rec] of this._critMark) {
      rec.t -= dt;
      if (rec.t <= 0 || !target || target.dead) this._critMark.delete(target);
    }

    // knockback spring — impulse decays, position follows. Entities that
    // integrate their own knock (the player) are left alone.
    for (let i = this._knock.length - 1; i >= 0; i--) {
      const e = this._knock[i];
      if (!e || e.dead || !e.knock) { this._knock.splice(i, 1); continue; }
      const k = e.knock;
      e.position.x += k.x * dt; e.position.z += k.z * dt;
      const f = Math.exp(-(e.knockLambdaOwn || 11) * dt);
      k.x *= f; k.z *= f;
      ctx.world?.collide?.(e.position, e.radius || 0.5);
      if (k.x * k.x + k.z * k.z < 0.0009) { k.set(0, 0, 0); this._knock.splice(i, 1); }
    }

    this._statusTick(dt);
    this._updateBoonPulses(dt);
    for (const r of this.runtimes.values()) r.update(dt);
    this.hitboxes.update(dt, targets);
    this.projectiles.update(dt, ctx, targets);

    if (this._cap.on) this._captureTick(dt, ctx);

    // ── COMBAT INTENSITY ─────────────────────────────────────────────────
    this._recentDamage *= Math.exp(-INTENSITY.damageDecay * dt);
    let live = 0;
    for (let i = 0; i < targets.length; i++) {
      const e = targets[i];
      if (e && e !== ctx.player && !e.dead && e.alive !== false) live++;
    }
    if (!live && ctx.enemies && ctx.enemies.aliveCount) live = ctx.enemies.aliveCount;
    const target = clamp01(
      Math.min(1, this._recentDamage * INTENSITY.damageWeight) * 0.62 +
      Math.min(1, live * INTENSITY.enemyWeight) * 0.38
    );
    const lam = target > this.intensity ? INTENSITY.rise : INTENSITY.fall;
    this.intensity += (target - this.intensity) * (1 - Math.exp(-lam * dt));
    if (Math.abs(this.intensity - this._intensityEmitted) > INTENSITY.emitDelta) {
      this._intensityEmitted = this.intensity;
      ctx.events.emit('combat.intensity', { value: this.intensity, enemies: live });
      ctx.audio?.music?.setIntensity?.(this.intensity);
    }
  }

  lateUpdate(alpha, ctx) {
    this.projectiles.lateUpdate(alpha, ctx);
    this.hitboxes.drawDebug(ctx);
  }

  // ═════════════════════════════════════════════ capture.state('combat') ═══
  // AGENT-COMBAT's half of §5's combat scenario: a LIVE hitbox on the player's
  // committed swing, hostile fire converging from three sides, the player's own
  // bolt leaving frame, and ground telegraphs marking what is about to hurt.
  //
  // The harness calls state() and THEN steps 2.0s, so a one-shot burst would
  // have expired by the time the shutter opens. This is a scripted timeline
  // instead, authored backwards from t=2.0: every entry below is placed so that
  // it is at its most readable moment in the captured frame.
  _captureState(name, ctx) {
    if (name === 'combat') { this._cap.on = true; this._cap.t = 0; this._cap.i = 0; this.equip('blade'); }
    else if (name) {
      // leaving the combat frame: this harness runs every shot on ONE page, so
      // without an explicit teardown the bolts and telegraphs bleed into the
      // vfx, ui and boon frames.
      if (this._cap.on) { this._cap.on = false; this.projectiles.clear(); this.hitboxes.clear(); ctx.vfx?.clear?.(); }
    }
  }

  _capBolt(o) { return this.projectiles.fire(o); }

  _captureTick(dt, ctx) {
    const T0 = this._cap.t; this._cap.t += dt;
    const T = this._cap.t;
    const P = ctx.player; if (!P) return;
    const px = P.position.x, pz = P.position.z;
    const fx = P.facing.x, fz = P.facing.y;
    const at = (mark) => T0 < mark && T >= mark;

    // NOTE ON TIMING: hitstop sets ctx.time.scale to 0, so a shot that asks for
    // 2.0s of stepping can receive noticeably less SIM time once the fight is
    // actually landing hits. An absolutely-scheduled finale therefore misses
    // the shutter. Everything after the opening volley is a PULSE on a period
    // shorter than its own lifetime, so whenever the frame is grabbed there is
    // a live hitbox, a fresh crescent and bolts in the air.

    // 0.05 — the room is hot, and two patches of ground are marked hostile
    if (at(0.05)) {
      this.intensity = 0.92; this._recentDamage = 240;
      P.combatHeat = Math.max(P.combatHeat || 0, 1.25);
      for (let i = 0; i < 2; i++) {
        const a = -0.95 + i * 1.9;
        ctx.vfx?.decal?.(_v.set(px + Math.cos(a) * 4.6, 0, pz + Math.sin(a) * 4.6), null,
          { kind: 'sigil', size: 1.9, color: '#e01f2d', opacity: 0.30 });
      }
    }

    // 0.45 — the volley: three bolts from the rim, closing slowly enough that
    // they are still legible mid-flight whenever the shutter opens
    if (at(0.45)) {
      for (let i = 0; i < 3; i++) {
        const a = 2.45 + i * 0.68;
        const ox = px + Math.cos(a) * 11.0, oz = pz + Math.sin(a) * 11.0;
        this._capBolt({
          x: ox, y: 1.15, z: oz, dx: px - ox, dz: pz - oz, kind: 'straight',
          speed: 5.4, radius: 0.30, life: 6, damage: 12, type: 'fire',
          color: i === 1 ? '#ff5a3c' : '#ff8c1a', size: 1.0, coreSize: 1.0, team: TEAM.ENEMY,
        });
      }
    }
    // 0.60 — two lobbed shells, caught mid-arc
    if (at(0.60)) {
      for (let i = 0; i < 2; i++) {
        const a = -0.55 + i * 1.9;
        const ox = px + Math.cos(a) * 8.0, oz = pz + Math.sin(a) * 8.0;
        this._capBolt({
          x: ox, y: 0.9, z: oz, dx: px - ox, dz: pz - oz, kind: 'arc',
          speed: 6.2, rise: 6.4, gravity: 5.2, radius: 0.34, life: 6, damage: 16, type: 'fire',
          color: '#c22a06', size: 1.1, coreSize: 1.0, team: TEAM.ENEMY, solid: false,
        });
      }
    }
    // 0.74 — two witch-teal seekers curving in from behind
    if (at(0.74)) {
      for (let i = 0; i < 2; i++) {
        const a = 3.95 + i * 0.55;
        const ox = px + Math.cos(a) * 9.0, oz = pz + Math.sin(a) * 9.0;
        this._capBolt({
          x: ox, y: 1.3, z: oz, dx: px - ox, dz: pz - oz, kind: 'homing',
          speed: 4.6, homing: 0.9, target: P, radius: 0.26, life: 6, damage: 9, type: 'arcane',
          color: '#8ef0d0', size: 0.95, coreSize: 0.95, team: TEAM.ENEMY, solid: false,
        });
      }
    }
    // 0.88 — two orbiting shade-motes: the cast that is already running
    if (at(0.88)) {
      for (let i = 0; i < 2; i++) {
        const a = i * Math.PI;
        this._capBolt({
          x: px + Math.cos(a) * 2.5, y: 1.25, z: pz + Math.sin(a) * 2.5, kind: 'orbit',
          orbitX: px, orbitZ: pz, orbitRadius: 2.5, orbitSpeed: 2.6, orbitAngle: a,
          radius: 0.22, life: 8, damage: 8, type: 'arcane', color: '#c9b8ff',
          size: 0.9, source: P, team: TEAM.PLAYER, pierce: 255,
        });
      }
    }

    // ── THE PULSE ────────────────────────────────────────────────────────
    // period 0.42s, hitbox live for 0.40s of it: the committed third-hit arc
    // from the blade table is live in the captured frame, and the crescent
    // that sells it is never older than 0.42s.
    if (T >= 1.00 && T - (this._cap.pulse || 0) >= 0.42) {
      this._cap.pulse = T;
      const n = this._cap.i++;
      const s = WEAPONS.blade.combo[2];
      this.hitboxes.spawn({
        shape: 'arc', owner: P, source: P, radius: s.hitbox.radius, arcDeg: s.hitbox.arcDeg,
        offset: s.hitbox.offset, t0: 0.01, t1: 0.40, life: 0.44,
        damage: s.damage, knockback: s.knockback, poiseDamage: s.poise,
        hitstop: 0, shake: 0, color: s.vfx.color, tag: 'capture:lunge',
      });
      ctx.vfx?.slash?.(_v.set(px, 1.02, pz), _v2.set(fx, 0, fz),
        { arc: s.vfx.arc, radius: s.vfx.radius, width: 0.46, color: s.vfx.color, glow: '#ff5a3c', spin: 1 });
      // the swing CONNECTS: sparks on the arc and a number over each
      for (let i = 0; i < 2; i++) {
        const a = Math.atan2(fz, fx) + (i ? 0.62 : -0.68);
        const hx = px + Math.cos(a) * 2.35, hz = pz + Math.sin(a) * 2.35;
        ctx.vfx?.impact?.(_v.set(hx, 1.05, hz), _v2.set(-Math.cos(a), 0, -Math.sin(a)),
          { type: 'physical', scale: i ? 0.45 : 0.7, color: '#ffb04a' });
        const dn = new THREE.Vector3(hx, 1.6, hz);
        ctx.events.emit('damage.number', { pos: dn, amount: i ? 29 : 54, crit: i === 0, type: 'physical' });
        ctx.ui?.damageNumber?.(dn, i ? 29 : 54, { crit: i === 0, type: 'physical' });
      }
      ctx.events.emit('camera.shake', { amp: 0.14, dur: 0.24, freq: 29 });
      // the player answers with a bolt of their own, leaving frame
      this._capBolt({
        x: px + fx * 0.8, y: 1.18, z: pz + fz * 0.8,
        dx: fx * 0.72 + fz * 0.69, dz: fz * 0.72 - fx * 0.69,
        kind: 'straight', speed: 11, radius: 0.28, life: 3, damage: 30, type: 'physical',
        color: '#ffe9a8', size: 1.2, coreSize: 1.1, source: P, team: TEAM.PLAYER, hero: true, pierce: 3,
      });
      // and the ground under one of the marked patches erupts
      const ta = -0.9 + (n % 2) * 1.9;
      ctx.vfx?.shockwave?.(_v.set(px + Math.cos(ta) * 4.6, 0.05, pz + Math.sin(ta) * 4.6),
        { radius: 2.1, color: '#e01f2d', life: 0.5, opacity: 0.45 });
    }
  }

  dispose() {
    this.hitboxes.dispose();
    this.projectiles.dispose();
  }
}

export { TEAM, WEAPONS, WEAPON_IDS };
export default CombatSystem;
