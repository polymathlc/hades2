// OWNER: AGENT-RUN
// ---------------------------------------------------------------------------
// run.js — THE SPINE OF A RUN.
//
// Everything else in EREBUS is a system that does one thing very well and
// knows nothing about the others. This file is the only place that knows what
// a RUN is: a descent through chambers, each one a fight, each cleared fight
// buying you a door, each door another chamber one step deeper and eventually
// a different biome. It owns nothing except that sequence — it spawns nothing,
// draws nothing and damages nothing. It listens and it calls.
//
// THE LOOP, in the order it happens:
//
//   enter    world.build() lays a chamber and emits 'room.built'. We seal the
//            doors, park the hero on a legal spawn, snap the camera, and ask
//            the spawner for a wave composed from (biome, depth, seed).
//   fight    spawner.js runs its own beats. We do not touch the fight.
//   clear    the spawner emits 'room.cleared' -> we unseal the doors and put
//            the exits on the bus so UI/audio can react.
//   choose   doors.js fires 'door.entered' when the hero walks a threshold ->
//            depth++, pick the next biome, rebuild, repeat.
//   die      'player.died' ends the run; after a beat the hero returns to the
//            Crossroads, where banked Nectar can be spent before the portal.
//
// WHY THE TRANSITION IS DEFERRED: world.build() disposes and rebuilds every
// geometry and material in the chamber. Doing that inside the door's own
// update, while the doors array is being iterated, deletes the object the
// caller is standing in. Every transition is therefore QUEUED and executed at
// the top of the next update, which is also where the fade lives.
//
// DETERMINISM: the run's seed comes from ctx.rng, never Date.now(); every
// derived seed is a pure function of (runSeed, depth). Two runs with the same
// seed are the same run, which is what makes the capture harness and the
// critic loop reproducible.
// ---------------------------------------------------------------------------

import { GOD_INFO, GOD_KEYS } from './boons.js';
import { MetaProgression } from './meta.js';
import { HomeBase, NectarDrop, TitanBloodDrop } from '../world/homebase.js';
import { CHARACTER_INFO, characterInfo, characterOwnsWeapon, godIdsForCharacter } from './characters.js';
import { FINAL_BOSS_DEPTH } from '../entities/spawner.js';

// The descent uses the same five-depth cadence as spawner.js. Depths 5, 10
// and 15 are regional bosses; clearing Heracles jumps directly to the
// heir-specific finale instead of clamping into endless Elysium.
const BIOMES = ['tartarus', 'asphodel', 'elysium'];

export class RunState {
  constructor() {
    this.depth = 0;
    this.biome = 'tartarus';
    this.boons = [];
    this.obols = 0;
    this.nectar = 0;
    this.seed = 1337;
    this.state = 'home';          // home | playing | cleared | choosing | transition | dead
    this.roomCleared = false;
    this.exits = [];
    this.kills = 0;
    this.rooms = 0;
    this.startedAt = 0;
    this._pending = null;         // queued transition
    this._deathT = 0;
    this._victoryT = 0;
    this._bound = false;
    this._home = null;
    this._drops = [];
    this._rewardedBosses = new Set();
    this.selectedWeapon = null;
    this.selectedCharacter = 'zagreus';
  }

  async init(ctx) {
    this.ctx = ctx;
    // A FORK, not a draw: pulling from ctx.rng here would shift every stream
    // that forks after us and break byte-identical replays.
    this._rng = ctx.rng.fork ? ctx.rng.fork('run') : ctx.rng;
    this.seed = this._rng.int(1, 1e9);
    this.biome = (ctx.world && ctx.world.biome) || 'tartarus';
    this.startedAt = ctx.time ? ctx.time.t : 0;

    this.meta = new MetaProgression(ctx).load();
    ctx.meta = this.meta;
    this.nectar = this.meta.nectar;
    ctx.boons?.rebuild?.();
    ctx.boons?._syncPlayer?.();

    // ── the four events that are the whole loop ──────────────────────────
    ctx.events.on('room.cleared', (e) => this._onCleared(e));
    ctx.events.on('player.died', () => this._onDeath());
    ctx.events.on('entity.died', (i) => { if (i && i.entity && i.entity !== ctx.player) this.kills++; });
    ctx.events.on('boon.granted', () => { this.boons = ctx.boons?.list?.().slice() || []; });
    ctx.events.on('boss.defeated', (i) => this._onBossDefeated(i));
    ctx.events.on('run.start', () => { if (this.state === 'home') this.startRun(); });
    ctx.events.on('run.abandon', () => this.enterHome());
    ctx.events.on('home.altarClosed', () => this._home?.releaseAltar?.());
    ctx.events.on('capture.state', ({ name, args }) => {
      if (name === 'home') {
        this.enterHome({ initial: true });
        if (args?.character) this._home?._selectCharacter?.(args.character);
        if (args?.weapon) this._home?._selectWeapon?.(args.weapon);
        if (args?.character || args?.weapon) {
          if (ctx.ui?.toasts) ctx.ui.toasts.length = 0;
          const C = characterInfo(this.selectedCharacter);
          const arm = this.selectedWeapon ? ctx.combat?.runtimes?.get?.(ctx.player)?.weapon : null;
          ctx.ui?.toast?.(`${C.name.toUpperCase()} · ${(arm?.name || C.game).toUpperCase()}`, { color: C.color, dur: 2.8 });
        }
      }
      else if (name === 'altar') {
        this.enterHome({ initial: true });
        if (this.meta && this.meta.nectar < 6) this.meta.nectar = 6; // capture-only preview; never save
        if (this.meta && this.meta.titanBlood < 4) this.meta.titanBlood = 4; // capture-only preview; never save
        if (this.meta && this.meta.darkness < 12) this.meta.darkness = 12; // capture-only preview; never save
        ctx.ui?.setResources?.(0, this.meta?.nectar || 0, this.meta?.titanBlood || 0, this.meta?.darkness || 0);
        ctx.ui?.showHomeUpgrades?.(this.meta);
        if (args?.page) ctx.ui?.nectarUI?._setPage?.(args.page);
      }
    });
    // A door can be entered from doors.js' own update; queue, never rebuild
    // underneath the iterator that called us.
    ctx.world?.doors?.onEnter?.((d) => this._onDoor(d));
    ctx.events.on('door.entered', (d) => this._onDoor(d));

    // The capture harness drives chambers itself (capture.state / room:*), so
    // the run must not also be advancing depth under it.
    if (!ctx.CAPTURE) this.enterHome({ initial: true });
    return this;
  }

  // ═══════════════════════════════════════════════════════════ chambers ═══
  /** The biome a given depth belongs to. */
  biomeFor(depth) {
    const d = Math.max(0, depth | 0);
    if (d <= 5) return BIOMES[0];
    if (d <= 10) return BIOMES[1];
    return BIOMES[2];
  }
  /** Pure function of (runSeed, depth) — the same run replays identically. */
  seedFor(depth) { return (this.seed * 2654435761 + depth * 40503) >>> 0; }

  // ══════════════════════════════════════════════════════════ Crossroads ═══
  /** Return to the persistent home base. No encounter begins until the portal is crossed. */
  enterHome(o = {}) {
    const ctx = this.ctx;
    this._clearDrops();
    this._home?.dispose?.();
    this._home = null;

    if (!o.initial) {
      if (ctx.world?.biome !== 'tartarus' && ctx.world?.setBiome) ctx.world.setBiome('tartarus', ctx);
      else ctx.world?.build?.('tartarus', 'rotunda', 424242);
    }
    ctx.spawner?.stop?.();
    ctx.enemies?.clear?.();
    ctx.boons?.clear?.();
    ctx.player?.respawn?.();
    ctx.combat?.unlockWeapon?.();
    ctx.ui?.clearRunBoons?.();
    ctx.ui?.screen?.('game');

    this.depth = 0;
    this.biome = 'tartarus';
    this.state = 'home';
    this.roomCleared = false;
    this._pending = null;
    this._deathT = 0;
    this._victoryT = 0;
    this.obols = 0;
    this.nectar = this.meta?.nectar || 0;
    this.selectedWeapon = null;
    this.selectedCharacter = ctx.player?.characterId || this.selectedCharacter || 'zagreus';
    ctx.ui?.setResources?.(0, this.nectar, this.meta?.titanBlood || 0, this.meta?.darkness || 0);

    this._home = new HomeBase(ctx, {
      onPortal: () => this.startRun(),
      onAltar: () => ctx.ui?.showHomeUpgrades?.(this.meta),
      onMirror: () => ctx.ui?.showHomeUpgrades?.(this.meta, 'mirror'),
      character: this.selectedCharacter,
      onCharacter: (id) => {
        if (!CHARACTER_INFO[id]) return false;
        this.selectedCharacter = id;
        this.selectedWeapon = null;
        ctx.player?.setCharacter?.(id);
        const fallback = characterInfo(id).defaultWeapon;
        ctx.combat?.equip?.(fallback, { force: true, silent: true });
        ctx.ui?.toast?.(`${CHARACTER_INFO[id].name.toUpperCase()} · ${CHARACTER_INFO[id].game.toUpperCase()} ARSENAL`, { color: CHARACTER_INFO[id].color, dur: 2.5 });
        ctx.events.emit('home.characterSelected', { id, character: CHARACTER_INFO[id] });
        return true;
      },
      onWeapon: (id) => {
        if (!characterOwnsWeapon(this.selectedCharacter, id)) return false;
        const weapon = ctx.combat?.equip?.(id, { force: true, silent: true });
        if (!weapon) return false;
        this.selectedWeapon = id;
        ctx.ui?.toast?.(`${weapon.name.toUpperCase()} · BOUND FOR NEXT DESCENT`, { color: weapon.palette.body, dur: 2.4 });
        ctx.events.emit('home.weaponSelected', { id, weapon });
        return true;
      },
    }).enter();
    ctx.events.emit('home.entered', { nectar: this.nectar, titanBlood: this.meta?.titanBlood || 0,
      darkness: this.meta?.darkness || 0, gods: this.meta?.snapshot?.().gods || {}, character: this.selectedCharacter });
    return this;
  }

  /** Begin a fresh descent only after the hero physically crosses the home portal. */
  startRun() {
    if (this.state !== 'home') return false;
    const ctx = this.ctx;
    if (!this.selectedCharacter || !CHARACTER_INFO[this.selectedCharacter]) {
      ctx.ui?.toast?.('CHOOSE ZAGREUS OR MELINOE BEFORE ENTERING', { color: '#86e6c1', dur: 2.5 });
      return false;
    }
    if (!this.selectedWeapon) {
      ctx.ui?.toast?.('CHOOSE A COMPATIBLE ARM BEFORE ENTERING', { color: '#7ee0ff', dur: 2.5 });
      return false;
    }
    if (!characterOwnsWeapon(this.selectedCharacter, this.selectedWeapon)) return false;
    const boundWeapon = ctx.combat?.lockWeapon?.(this.selectedWeapon)
      || ctx.combat?.equip?.(this.selectedWeapon, { force: true, silent: true });
    if (!boundWeapon) return false;
    ctx.ui?.nectarUI?.close?.();
    this._home?.dispose?.();
    this._home = null;
    this.seed = this._rng ? this._rng.int(1, 1e9) : (this.seed + 7919);
    this.boons.length = 0;
    this.obols = this.meta?.startingObols?.() || 0;
    this.kills = 0;
    this.rooms = 0;
    this.exits.length = 0;
    this._rewardedBosses.clear();
    this.startedAt = ctx.time ? ctx.time.t : 0;
    ctx.boons?.clear?.();
    ctx.player?.respawn?.();
    ctx.ui?.clearRunBoons?.();
    ctx.ui?.setResources?.(this.obols, this.meta?.nectar || 0, this.meta?.titanBlood || 0, this.meta?.darkness || 0);
    this.biome = 'tartarus';
    this.enterRoom(0, 'tartarus');
    ctx.events.emit('run.started', {
      seed: this.seed, biome: this.biome, nectar: this.meta?.nectar || 0, darkness: this.meta?.darkness || 0,
      weapon: this.selectedWeapon, character: this.selectedCharacter,
    });
    return true;
  }

  godPool() { return godIdsForCharacter(this.selectedCharacter); }

  /**
   * enterRoom(depth, biome, o) — build the chamber and open the encounter.
   *
   * o.first skips the world rebuild: world.init() already built the boot
   * chamber, and rebuilding it before the first frame throws away a whole
   * material bake for an identical room.
   */
  enterRoom(depth, biome, o = {}) {
    const ctx = this.ctx;
    // World-space gate UI belongs to exactly one room. Clear it before the
    // chamber is rebuilt so a previous room can never project stale labels
    // onto the new geometry.
    ctx.ui?.clearPrompts?.();
    ctx.ui?.clearSigils?.();
    this._clearDrops();
    this.depth = depth;
    this.rooms++;
    this.roomCleared = false;
    this.state = 'playing';
    this._pending = null;

    const world = ctx.world;
    const changedBiome = biome && biome !== this.biome;
    this.biome = biome || this.biome;

    if (world) {
      if (!o.first) {
        // setBiome() announces 'biome.changed' FIRST (the light rig retunes,
        // publishes a new rim constant and a new sky, PostFX re-grades and the
        // atmosphere re-hazes) and THEN rebuilds the chamber against it, which
        // is the only order that produces one consistent frame. A same-biome
        // chamber is just a fresh layout on the same rig.
        if (changedBiome && world.setBiome) world.setBiome(this.biome, ctx);
        else if (world.build) world.build(this.biome, null, this.seedFor(depth));
      } else if (changedBiome) {
        if (world.setBiome) world.setBiome(this.biome, ctx);
      }
      // sealed until the room is won: the doors ARE the reward
      world.setCleared?.(false);
    }
    // Defensive: a stub world that cannot set a biome still gets the rest of
    // the pipeline retuned, because §2.5 says the bus is the contract.
    if (changedBiome && !(world && world.setBiome)) {
      ctx.events.emit('biome.changed', { name: this.biome });
      ctx.lighting?.setBiome?.(this.biome, ctx);
      ctx.post?.setBiome?.(this.biome);
    }

    this._placePlayer(o.first);

    ctx.events.emit('room.entered', {
      depth, biome: this.biome, seed: this.seedFor(depth),
      boss: depth > 0 && depth % 5 === 0, first: !!o.first,
    });
    // spawner.js subscribes to room.built AND room.entered, so it has already
    // composed the encounter by the time we get here. The direct call is the
    // safety net for the case that would otherwise be unwinnable: a chamber
    // with sealed doors and nothing alive to kill.
    if (ctx.spawner && !ctx.spawner.active) {
      ctx.spawner.beginRoom(this.biome, depth, { seed: this.seedFor(depth) });
    }
    ctx.ui?.setDepth?.(depth, this.biome);
    return this;
  }

  /** Put the hero on legal ground for the new chamber and stop the camera drifting. */
  _placePlayer(first) {
    const ctx = this.ctx, p = ctx.player;
    if (!p || first) { if (p) ctx.cameraRig?.snap?.(p.position); return; }
    const R = (ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 12.6;
    const d = R * 0.34;
    p.position.set(d * 0.7071, 0, d * 0.7071);
    p.velocity.set(0, 0, 0);
    p.knock?.set?.(0, 0, 0);
    p.facing.set(-0.7071, -0.7071);        // face the room, not the door you came from
    p.iframes = Math.max(p.iframes || 0, 0.6);
    p.state = 'move';
    p.weapon?.cancel?.();
    p._resolve?.(ctx);
    ctx.cameraRig?.snap?.(p.position);
  }

  // ═════════════════════════════════════════════════════════════ events ═══
  _onCleared(e) {
    if (this.state === 'home' || this.state === 'dead' || this.roomCleared) return;
    this.roomCleared = true;
    if (e?.boss && this.depth >= FINAL_BOSS_DEPTH) {
      this.state = 'victory';
      this._victoryT = 0;
      this.exits.length = 0;
      this.ctx.world?.setCleared?.(false);
      this.ctx.ui?.clearPrompts?.();
      this.ctx.ui?.clearSigils?.();
      this.ctx.spawner?.stop?.();
      if (!this.ctx.CAPTURE) this.meta?.awardDarkness?.(8, { source: 'final-boss' });
      const boss = this.selectedCharacter === 'melinoe' ? 'CHRONOS' : 'HADES';
      const hero = characterInfo(this.selectedCharacter).name.toUpperCase();
      this.ctx.events.emit('run.victory', {
        depth: this.depth, biome: this.biome, boss: boss.toLowerCase(),
        character: this.selectedCharacter, rooms: this.rooms, kills: this.kills,
      });
      this.ctx.ui?.toast?.(`${boss} DEFEATED · ${hero}'S DESCENT COMPLETE`, {
        color: this.selectedCharacter === 'melinoe' ? '#86e6c1' : '#ff657f', dur: 7.0,
      });
      return;
    }
    this.state = 'cleared';
    // THE DOORS ARE THE REWARD. Unsealing is the only thing that happens on a
    // clear, and it must happen through the world so the sigils, thresholds
    // and the enter-trigger all come live together.
    this.ctx.world?.setCleared?.(true);
    this.exits = this.ctx.world?.getExits?.() || [];
    this.ctx.ui?.clearPrompts?.();
    this.ctx.ui?.clearSigils?.();
    for (const exit of this.exits) {
      if (!exit?.god || !exit?.anchor) continue;
      this.ctx.ui?.sigil?.(exit.anchor, { god: exit.god, slot: exit.god === 'hephaestus' ? 'forge' : 'passive', rarity: 'rare', height: 0.25 });
      this.ctx.ui?.prompt?.(exit.anchor, `${exit.godName || GOD_INFO[exit.god]?.name || 'GOD'} · ${exit.kind?.toUpperCase?.() || 'BOON'}`, { key: 'W', height: 1.15, dur: 1e9 });
    }
    const heal = this.ctx.boons?.mods?.clearHeal || 0;
    if (heal > 0 && this.ctx.player) {
      this.ctx.player.health = Math.min(this.ctx.player.maxHealth, this.ctx.player.health + heal);
      this.ctx.ui?.setHealth?.(this.ctx.player.health, this.ctx.player.maxHealth);
    }
    if (!this.ctx.CAPTURE) {
      const darkness = e?.boss ? 3 : 1;
      this.meta?.awardDarkness?.(darkness, { source: e?.boss ? 'boss' : 'chamber' });
    }
    this.ctx.events.emit('run.roomCleared', {
      depth: this.depth, biome: this.biome, exits: this.exits,
      next: this.biomeFor(this.depth + 1), boss: !!(e && e.boss),
    });
  }

  _onDoor(d) {
    if (this.state !== 'cleared' || this._pending) return;
    // The chosen gate is no longer an available choice. Remove the entire
    // previous set immediately, including while the boon modal is open.
    this.ctx.ui?.clearPrompts?.();
    this.ctx.ui?.clearSigils?.();
    // Crossing any gate earns an audience with one deity. The sigil reward
    // still resolves (health or obols), then the run pauses before
    // rebuilding the next chamber until one of that god's three boons is chosen.
    if (d?.kind !== 'boon') this._applyReward(d?.kind);
    this.state = 'choosing';
    this._claimBoon(d).catch(() => this._queueTransition(d));
  }

  async _claimBoon(d) {
    const state = this.ctx.boons;
    const rng = this._rng?.fork ? this._rng.fork(`boon:${this.depth}:${d?.index || 0}`) : this._rng;
    const pool = this.godPool();
    const god = d?.god && pool.includes(d.god) ? d.god : (rng?.pick ? rng.pick(pool) : pool[(this.depth + (d?.index || 0)) % pool.length]);
    const offers = state?.roll?.(rng, {
      count: 3, god, weapon: this.ctx.combat?.weaponId, character: this.selectedCharacter,
      allowDuo: false, upgradeChance: 0.58,
    }) || [];
    const choice = this.ctx.ui?.showBoonChoice?.(offers, { upgradeChance: 0.58 });
    if (choice && typeof choice.then === 'function') await choice;
    else if (offers[0]) state?.grant?.(offers[0]);
    this.boons = state?.list?.().slice() || [];
    this._queueTransition(d);
  }

  _applyReward(kind) {
    const ctx = this.ctx;
    if (kind === 'health' && ctx.player) {
      const heal = Math.max(35, ctx.player.maxHealth * 0.35);
      ctx.player.health = Math.min(ctx.player.maxHealth, ctx.player.health + heal);
      ctx.ui?.setHealth?.(ctx.player.health, ctx.player.maxHealth);
      ctx.ui?.toast?.('Centaur Heart', { color: '#de526f' });
    } else if (kind === 'gold') {
      this.obols += 75 + this.depth * 5;
      ctx.ui?.setResources?.(this.obols, this.meta?.nectar || 0, this.meta?.titanBlood || 0, this.meta?.darkness || 0);
      ctx.ui?.toast?.('Charon’s Obols', { color: '#f2c14e' });
    }
  }

  _queueTransition(d) {
    if (this._pending) return;
    const next = this.depth === 15 ? FINAL_BOSS_DEPTH : this.depth + 1;
    this._pending = { depth: next, biome: this.biomeFor(next), door: d ? d.index : 0, kind: d ? d.kind : null };
    this.state = 'transition';
    this.ctx.events.emit('run.transition', this._pending);
    this.ctx.events.emit('camera.shake', { amp: 0.05, dur: 0.22, freq: 22 });
  }

  _onBossDefeated(i) {
    const entity = i?.entity;
    const rewardKey = `${this.seed}:${this.depth}`;
    if (!entity || this.state === 'home' || this._rewardedBosses.has(rewardKey)) return;
    this._rewardedBosses.add(rewardKey);
    const amount = 2;
    const origin = i.pos || entity.position;
    const nectarPos = origin.clone?.() || { ...origin };
    if (nectarPos) nectarPos.x = (nectarPos.x || 0) - 0.8;
    const drop = new NectarDrop(this.ctx, nectarPos, amount, gained => {
      this.meta?.awardNectar?.(gained, { source: 'boss' });
      this.nectar = this.meta?.nectar || 0;
      this.ctx.ui?.setResources?.(this.obols, this.nectar, this.meta?.titanBlood || 0, this.meta?.darkness || 0);
      this.ctx.ui?.toast?.(`NECTAR +${gained} · BANKED AT THE CROSSROADS`, { color: '#d8b6ff', dur: 3.2 });
      this.ctx.events.emit('boss.nectarCollected', { entity, amount: gained, total: this.nectar });
    });
    this._drops.push(drop);
    const bloodPos = origin.clone?.() || { ...origin };
    if (bloodPos) bloodPos.x = (bloodPos.x || 0) + 0.8;
    const blood = new TitanBloodDrop(this.ctx, bloodPos, 1, gained => {
      this.meta?.awardTitanBlood?.(gained, { source: 'boss' });
      this.ctx.ui?.setResources?.(this.obols, this.meta?.nectar || 0, this.meta?.titanBlood || 0, this.meta?.darkness || 0);
      this.ctx.ui?.toast?.(`TITAN BLOOD +${gained} · FORGE UPGRADES UNLOCKED`, { color: '#ff756b', dur: 3.2 });
      this.ctx.events.emit('boss.titanBloodCollected', { entity, amount: gained, total: this.meta?.titanBlood || 0 });
    });
    this._drops.push(blood);
    const bossName = entity.def?.label || i?.name || 'THE BOSS';
    this.ctx.ui?.toast?.(`${bossName.toUpperCase()} DROPPED NECTAR + TITAN BLOOD`, { color: '#ff9a6b', dur: 2.8 });
  }

  _clearDrops() {
    for (const drop of this._drops) drop?.dispose?.();
    this._drops.length = 0;
  }

  _onDeath() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this._deathT = 0;
    this.ctx.spawner?.stop?.();
    this.ctx.events.emit('run.ended', {
      depth: this.depth, biome: this.biome, rooms: this.rooms,
      kills: this.kills, boons: this.boons.length,
      time: (this.ctx.time ? this.ctx.time.t : 0) - this.startedAt,
    });
    this.ctx.ui?.toast?.('You have died', { color: '#c81d3c' });
  }

  /** Death and abandon always return to the Crossroads before another run. */
  restart() {
    return this.enterHome();
  }

  // ══════════════════════════════════════════════════════════════ frame ═══
  update(dt, ctx) {
    if (this.state === 'home') {
      this._home?.update?.(dt);
      return;
    }
    for (let i = this._drops.length - 1; i >= 0; i--) {
      if (this._drops[i]?.update?.(dt)) this._drops.splice(i, 1);
    }
    if (this.state === 'victory') {
      this._victoryT += dt;
      if (this._victoryT > 9.0) this.enterHome();
      return;
    }
    if (this._pending) {
      const t = this._pending;
      this._pending = null;
      this.enterRoom(t.depth, t.biome, { door: t.door });
      return;
    }
    if (this.state === 'dead') {
      this._deathT += dt;
      if (this._deathT > 4.5) this.restart();
    }
  }
}

export default RunState;
