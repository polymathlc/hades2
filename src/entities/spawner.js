// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// spawner.js — THE ENCOUNTER DIRECTOR.
//
// A Hades room is not "N enemies appear". It is a SCRIPT with a rhythm:
//
//   BEAT 1  pressure    a small, legible wave you can beat by moving
//   BEAT 2  breath      ~1.6s of nothing while the last body dissolves
//   BEAT 3  escalation  a wave with a different SHAPE — a brute to flank, or
//                       three hounds so the room suddenly has velocity
//   BEAT 4  breath
//   BEAT 5  the ask     the composition that requires the room's actual answer
//
// Waves are composed from a deterministic BUDGET (points scale with depth) and
// a per-biome weighted pool, so a room is reproducible from (biome, depth,
// seed) alone and the critic loop compares like-for-like.
//
// The two rules that keep it fair:
//   * NEVER spawn on top of the player — every point goes through
//     manager.safePoint(), and every arrival costs a materialise window with
//     i-frames and a rising VFX column.
//   * NEVER spawn the next wave on the frame the last one died — the breath is
//     the beat that makes the pressure legible.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, lerp, TAU } from '../core/math.js';

// ── per-biome weighted pools. Weight is a function of depth so families fade
//    in as the run gets deeper rather than appearing fully formed at depth 1.
const POOLS = {
  tartarus: [
    { kind: 'shade', cost: 1, w: (d) => 6 },
    { kind: 'hound', cost: 1, w: (d) => (d >= 1 ? 4 : 1) },
    { kind: 'brute', cost: 3, w: (d) => (d >= 2 ? 3 : 0) },
    { kind: 'hexer', cost: 2, w: (d) => (d >= 2 ? 3 : 0.5) },
    { kind: 'bloat', cost: 2, w: (d) => (d >= 3 ? 2.5 : 0) },
    { kind: 'herald', cost: 3, w: (d) => (d >= 4 ? 1.6 : 0) },
  ],
  asphodel: [
    { kind: 'hound', cost: 1, w: () => 6 },
    { kind: 'shade', cost: 1, w: () => 3 },
    { kind: 'bloat', cost: 2, w: (d) => (d >= 1 ? 4 : 1) },
    { kind: 'brute', cost: 3, w: (d) => (d >= 2 ? 3 : 0) },
    { kind: 'hexer', cost: 2, w: (d) => (d >= 2 ? 2.5 : 0) },
    { kind: 'herald', cost: 3, w: (d) => (d >= 3 ? 2 : 0) },
  ],
  elysium: [
    { kind: 'brute', cost: 3, w: () => 4 },
    { kind: 'hexer', cost: 2, w: () => 4 },
    { kind: 'herald', cost: 3, w: () => 3 },
    { kind: 'shade', cost: 1, w: () => 3 },
    { kind: 'hound', cost: 1, w: () => 2 },
    { kind: 'bloat', cost: 2, w: () => 2 },
  ],
};

// pack units always arrive together — a lone hound is a nuisance, three is a
// mechanic
const PACK = { hound: 3, shade: 2 };

const _v = new THREE.Vector3();

export class Spawner {
  constructor() {
    this.active = false;
    this.waves = [];
    this.wave = -1;
    this.timer = 0;
    this.pending = [];      // staged arrivals inside the current wave
    this.cleared = true;
    this.roomId = 0;
  }

  init(ctx, mgr) {
    // The engine's system contract is init(ctx) — it never passes a second argument, so taking
    // the manager as a parameter left this.mgr undefined and beginRoom threw on the first
    // room.entered. Resolve it from the context, keeping the explicit form for direct callers.
    this.ctx = ctx; this.mgr = mgr || ctx.enemies;
    if (!this.mgr) { console.warn('[spawner] no EnemyManager on ctx.enemies — encounters disabled'); return this; }
    this.rng = ctx.rng.fork ? ctx.rng.fork('spawner') : ctx.rng;
    ctx.events.on('room.built', (e) => { this._room = e; if (!ctx.CAPTURE) this.beginRoom(e && e.biome, ctx.run ? ctx.run.depth : 0); });
    ctx.events.on('room.entered', (e) => { if (!ctx.CAPTURE) this.beginRoom(e && e.biome, (e && e.depth) ?? (ctx.run ? ctx.run.depth : 0)); });
    return this;
  }

  // ═══════════════════════════════════════════════════════ composition ═══
  /**
   * budget(depth) — the points a room may spend. The curve is deliberately
   * shallow early (rooms 1-3 teach) and then linear, because difficulty in a
   * rogue-lite comes from COMPOSITION, not from arithmetic.
   */
  budget(depth) { return 4 + Math.floor(depth * 1.35) + (depth >= 6 ? 2 : 0); }

  /** compose a deterministic wave list for (biome, depth). */
  compose(biome, depth) {
    const pool = POOLS[biome] || POOLS.tartarus;
    const live = pool.filter(p => p.w(depth) > 0);
    const total = this.budget(depth);
    // 2 waves shallow, 3 mid, 4 deep — pacing, not padding
    const nWaves = depth >= 7 ? 4 : depth >= 3 ? 3 : 2;
    const waves = [];
    // the first wave is always the smallest: the room opens legibly
    const split = [0.34, 0.30, 0.22, 0.14];
    for (let w = 0; w < nWaves; w++) {
      let left = Math.max(2, Math.round(total * (split[w] ?? 0.2) * (1 + w * 0.18)));
      const list = [];
      let guard = 0;
      while (left > 0 && guard++ < 24) {
        const pick = this.rng.weighted(live, (p) => p.w(depth) * (p.cost <= left ? 1 : 0.001));
        if (!pick || pick.cost > left + 1) break;
        const n = PACK[pick.kind] || 1;
        for (let i = 0; i < n && left > 0; i++) { list.push(pick.kind); left -= pick.cost; }
      }
      // an escalation wave always carries one shape-changer if it can afford it
      if (w === nWaves - 1 && depth >= 3 && !list.includes('herald') && !list.includes('brute')) {
        list.push(depth >= 5 ? 'herald' : 'brute');
      }
      waves.push({
        list,
        // BREATH: the gap before this wave arrives. Wave 0 is nearly instant so
        // the room starts; later waves get a real beat of silence.
        delay: w === 0 ? 0.55 : (depth >= 6 ? 1.35 : 1.8),
        // arrivals inside a wave are staggered so six things never pop at once
        stagger: 0.22,
        trigger: w === 0 ? 'immediate' : 'thinned',
      });
    }
    return waves;
  }

  // ══════════════════════════════════════════════════════════ lifecycle ═══
  beginRoom(biome, depth = 0, opts = {}) {
    const ctx = this.ctx;
    this.roomId++;
    this.mgr.clear();
    this.biome = biome || (ctx.world && ctx.world.biome) || 'tartarus';
    this.depth = depth | 0;
    this.rng.reseed(('room:' + this.biome + ':' + this.depth + ':' + (opts.seed ?? this.roomId)));
    this.boss = !!opts.boss || (this.depth > 0 && this.depth % 5 === 0);
    this.waves = this.boss ? this._bossWaves() : this.compose(this.biome, this.depth);
    this.wave = -1;
    this.timer = 0;
    this.pending.length = 0;
    this.active = true;
    this.cleared = false;
    this.spawnedTotal = 0;
    ctx.events.emit('encounter.begin', { biome: this.biome, depth: this.depth, waves: this.waves.length, boss: this.boss });
    return this;
  }

  _bossWaves() {
    return [
      { list: ['warden'], delay: 1.1, stagger: 0, trigger: 'immediate' },
      { list: ['shade', 'shade'], delay: 8.0, stagger: 0.3, trigger: 'timed' },
    ];
  }

  stop() { this.active = false; this.pending.length = 0; }

  onEnemyDied(e) {
    if (!this.active) return;
    // room.cleared is emitted from update() once the pipeline is genuinely
    // empty — checking it here would fire while a staged arrival is in flight.
  }

  // ═══════════════════════════════════════════════════════════════ frame ═══
  update(dt, ctx) {
    if (!this.active) return;
    this.timer += dt;

    // staged arrivals inside the current wave
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t <= 0) { this.pending.splice(i, 1); this._place(p.kind, p.index, p.count); }
    }

    const alive = this.mgr.aliveCount;
    const next = this.waves[this.wave + 1];
    if (next) {
      let go = false;
      if (this.wave < 0) go = this.timer >= next.delay;
      else if (next.trigger === 'timed') go = this.timer >= next.delay;
      // THINNED, not CLEARED: the next wave lands while two of the last are
      // still up, so the room never goes quiet in the middle of a fight — but
      // it does go quiet BETWEEN fights, which is the beat that reads.
      else go = (alive <= Math.max(1, Math.floor(this.waves[this.wave].list.length * 0.34)))
        && this.timer >= next.delay && this.pending.length === 0;
      if (go) this._launch();
      return;
    }

    if (!this.cleared && alive === 0 && this.pending.length === 0) {
      this.cleared = true;
      this.active = false;
      this.mgr.telegraphs.clear();
      ctx.events.emit('room.cleared', {
        room: this.roomId, biome: this.biome, depth: this.depth,
        boss: this.boss, spawned: this.spawnedTotal,
      });
      ctx.ui?.toast?.('Chamber cleared', { color: '#f2c14e' });
    }
  }

  _launch() {
    this.wave++;
    this.timer = 0;
    const w = this.waves[this.wave];
    if (!w) return;
    this.ctx.events.emit('wave.begin', { index: this.wave, count: w.list.length, depth: this.depth });
    for (let i = 0; i < w.list.length; i++) {
      this.pending.push({ kind: w.list[i], t: i * (w.stagger || 0), index: i, count: w.list.length });
    }
  }

  /**
   * Place one arrival. Enemies come in AROUND the player at a ring the player
   * can see, never behind the camera and never inside the hero's dash range.
   */
  _place(kind, index, count) {
    const ctx = this.ctx;
    const p = ctx.player ? ctx.player.position : _v.set(0, 0, 0);
    const R = ctx.world && ctx.world.bounds ? ctx.world.bounds.r : 16;
    // spread arrivals around the arc AWAY from the player's facing, biased to
    // the sides so nothing materialises directly in the hero's blind spot
    const base = this.rng.range(0, TAU);
    const a = base + (index / Math.max(1, count)) * TAU * 0.86;
    const ring = clamp(R * 0.62, 6.5, 12.5) + this.rng.range(-1.2, 1.2);
    const x = Math.cos(a) * ring, z = Math.sin(a) * ring;
    const e = this.mgr.spawn(kind, { x, z }, {
      depth: this.depth, wave: this.wave, minPlayerDist: 6.0,
    });
    if (e) this.spawnedTotal++;
    return e;
  }

  /** debug/authoring helper: force a specific composition right now. */
  force(list, opts = {}) {
    this.mgr.clear();
    this.active = true; this.cleared = false;
    this.waves = [{ list, delay: 0, stagger: opts.stagger ?? 0.15, trigger: 'immediate' }];
    this.wave = -1; this.timer = 99; this.pending.length = 0;
    return this;
  }
}

export default Spawner;
