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
//   die      'player.died' ends the run; after a beat the descent restarts at
//            depth 0 in Tartarus with a fresh seed.
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

// The descent. Three biomes, four chambers each, a boss on the last of each —
// spawner.js already treats depth % 5 === 0 as a boss room, so the biome
// lengths line up with its own cadence.
const BIOMES = ['tartarus', 'asphodel', 'elysium'];
const CHAMBERS_PER_BIOME = 4;

export class RunState {
  constructor() {
    this.depth = 0;
    this.biome = 'tartarus';
    this.boons = [];
    this.seed = 1337;
    this.state = 'playing';       // playing | cleared | transition | dead
    this.roomCleared = false;
    this.exits = [];
    this.kills = 0;
    this.rooms = 0;
    this.startedAt = 0;
    this._pending = null;         // queued transition
    this._deathT = 0;
    this._bound = false;
  }

  async init(ctx) {
    this.ctx = ctx;
    // A FORK, not a draw: pulling from ctx.rng here would shift every stream
    // that forks after us and break byte-identical replays.
    this._rng = ctx.rng.fork ? ctx.rng.fork('run') : ctx.rng;
    this.seed = this._rng.int(1, 1e9);
    this.biome = (ctx.world && ctx.world.biome) || 'tartarus';
    this.startedAt = ctx.time ? ctx.time.t : 0;

    // ── the four events that are the whole loop ──────────────────────────
    ctx.events.on('room.cleared', (e) => this._onCleared(e));
    ctx.events.on('player.died', () => this._onDeath());
    ctx.events.on('entity.died', (i) => { if (i && i.entity && i.entity !== ctx.player) this.kills++; });
    // A door can be entered from doors.js' own update; queue, never rebuild
    // underneath the iterator that called us.
    ctx.world?.doors?.onEnter?.((d) => this._onDoor(d));
    ctx.events.on('door.entered', (d) => this._onDoor(d));

    // The capture harness drives chambers itself (capture.state / room:*), so
    // the run must not also be advancing depth under it.
    if (!ctx.CAPTURE) this.enterRoom(0, this.biome, { first: true });
    return this;
  }

  // ═══════════════════════════════════════════════════════════ chambers ═══
  /** The biome a given depth belongs to. */
  biomeFor(depth) {
    return BIOMES[Math.min(BIOMES.length - 1, Math.floor(depth / CHAMBERS_PER_BIOME))];
  }
  /** Pure function of (runSeed, depth) — the same run replays identically. */
  seedFor(depth) { return (this.seed * 2654435761 + depth * 40503) >>> 0; }

  /**
   * enterRoom(depth, biome, o) — build the chamber and open the encounter.
   *
   * o.first skips the world rebuild: world.init() already built the boot
   * chamber, and rebuilding it before the first frame throws away a whole
   * material bake for an identical room.
   */
  enterRoom(depth, biome, o = {}) {
    const ctx = this.ctx;
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
    if (this.state === 'dead' || this.roomCleared) return;
    this.roomCleared = true;
    this.state = 'cleared';
    // THE DOORS ARE THE REWARD. Unsealing is the only thing that happens on a
    // clear, and it must happen through the world so the sigils, thresholds
    // and the enter-trigger all come live together.
    this.ctx.world?.setCleared?.(true);
    this.exits = this.ctx.world?.getExits?.() || [];
    this.ctx.events.emit('run.roomCleared', {
      depth: this.depth, biome: this.biome, exits: this.exits,
      next: this.biomeFor(this.depth + 1), boss: !!(e && e.boss),
    });
  }

  _onDoor(d) {
    if (this.state !== 'cleared' || this._pending) return;
    const next = this.depth + 1;
    this._pending = { depth: next, biome: this.biomeFor(next), door: d ? d.index : 0, kind: d ? d.kind : null };
    this.state = 'transition';
    this.ctx.events.emit('run.transition', this._pending);
    this.ctx.events.emit('camera.shake', { amp: 0.05, dur: 0.22, freq: 22 });
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

  /** Start over. Called by UI, or automatically a few seconds after death. */
  restart() {
    const ctx = this.ctx;
    this.seed = this._rng ? this._rng.int(1, 1e9) : (this.seed + 7919);
    this.boons.length = 0;
    this.kills = 0; this.rooms = 0;
    this.startedAt = ctx.time ? ctx.time.t : 0;
    ctx.player?.respawn?.();
    this.enterRoom(0, BIOMES[0]);
    ctx.events.emit('run.started', { seed: this.seed, biome: this.biome });
    return this;
  }

  // ══════════════════════════════════════════════════════════════ frame ═══
  update(dt, ctx) {
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
