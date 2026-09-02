// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// spawner.js — THE ENCOUNTER DIRECTOR.
//
// A Hades room is not "N enemies appear". It is a SCRIPT with a rhythm, and
// every wave is authored to one of four BEATS:
//
//   OPENER    cheap melee only, four bodies at most. You learn the room's
//             shape by moving, and nothing shoots at you yet.
//   PRESSURE  a MIXED composition: at least one ranged family plus melee, so
//             the room has a target priority (kill the caster, or turn and
//             deal with what is closing). From depth 4 this wave also gets
//             REINFORCEMENTS ON A TIMER — a trickle, not a dump.
//   ELITE     the shape-changer (a brute to flank, a lancer lane, a herald to
//             prioritise), and from depth 3 one body is an ELITE with an
//             affix the player answers differently. Preceded by the room's
//             longest breath: this is the wave that asks the question.
//   SURGE     deep rooms only. Pack units, fast stagger, velocity.
//
// Between waves there is a BREATHER — a beat of silence authored per beat, so
// pressure reads as pressure and relief as relief. A wave never lands on the
// frame the previous one died.
//
// Waves are composed from a deterministic BUDGET (points scale with depth AND
// biome) and a per-biome weighted pool, so a room is reproducible from
// (biome, depth, seed) alone and the critic loop compares like-for-like.
// Concurrency is capped (MAX_ALIVE): reinforcements queue behind the cap so a
// room escalates instead of saturating.
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
export const ENCOUNTER_POOLS = {
  tartarus: [
    { kind: 'shade', cost: 1, w: (d) => 6 },
    { kind: 'hound', cost: 1, w: (d) => (d >= 1 ? 4 : 1) },
    { kind: 'brute', cost: 3, w: (d) => (d >= 2 ? 3 : 0) },
    { kind: 'hexer', cost: 2, w: (d) => (d >= 2 ? 3 : 0.5) },
    { kind: 'bloat', cost: 2, w: (d) => (d >= 3 ? 2.5 : 0) },
    { kind: 'herald', cost: 3, w: (d) => (d >= 4 ? 1.6 : 0) },
    { kind: 'lancer', cost: 2, w: (d) => (d >= 2 ? 2.4 : 0) },
    { kind: 'siren', cost: 2, w: (d) => (d >= 3 ? 1.8 : 0) },
    { kind: 'oracle', cost: 3, w: (d) => (d >= 4 ? 1.2 : 0) },
    { kind: 'riftstalker', cost: 3, w: (d) => (d >= 4 ? 1.4 : 0) },
  ],
  asphodel: [
    { kind: 'hound', cost: 1, w: () => 6 },
    { kind: 'shade', cost: 1, w: () => 3 },
    { kind: 'bloat', cost: 2, w: (d) => (d >= 1 ? 4 : 1) },
    { kind: 'brute', cost: 3, w: (d) => (d >= 2 ? 3 : 0) },
    { kind: 'hexer', cost: 2, w: (d) => (d >= 2 ? 2.5 : 0) },
    { kind: 'herald', cost: 3, w: (d) => (d >= 3 ? 2 : 0) },
    { kind: 'lancer', cost: 2, w: (d) => (d >= 2 ? 2 : 0) },
    { kind: 'siren', cost: 2, w: (d) => (d >= 1 ? 3 : 0.5) },
    { kind: 'oracle', cost: 3, w: (d) => (d >= 3 ? 1.5 : 0) },
    { kind: 'riftstalker', cost: 3, w: (d) => (d >= 2 ? 2.0 : 0.4) },
  ],
  elysium: [
    { kind: 'brute', cost: 3, w: () => 4 },
    { kind: 'hexer', cost: 2, w: () => 4 },
    { kind: 'herald', cost: 3, w: () => 3 },
    { kind: 'shade', cost: 1, w: () => 3 },
    { kind: 'hound', cost: 1, w: () => 2 },
    { kind: 'bloat', cost: 2, w: () => 2 },
    { kind: 'lancer', cost: 2, w: () => 4 },
    { kind: 'siren', cost: 2, w: () => 3.5 },
    { kind: 'oracle', cost: 3, w: () => 2.8 },
    { kind: 'riftstalker', cost: 3, w: () => 3.4 },
  ],
};

// pack units always arrive together — a lone hound is a nuisance, three is a
// mechanic
const PACK = { hound: 3, shade: 2 };

// ── threat by biome: the same depth is a harder room deeper in the descent
export const BIOME_THREAT = { tartarus: 1.0, asphodel: 1.15, elysium: 1.32 };
export const BEATS = Object.freeze(['opener', 'pressure', 'elite', 'surge']);
export const ELITE_AFFIXES = Object.freeze(['armoured', 'swift', 'volatile', 'warded']);
const RANGED = new Set(['hexer', 'herald', 'oracle']);
const CHEAP = new Set(['shade', 'hound']);
const SHAPERS = ['herald', 'brute', 'lancer', 'siren', 'oracle', 'riftstalker'];
// breath before each beat (seconds of quiet after the previous wave thins)
const BREATH = { opener: 0.55, pressure: 1.4, elite: 2.1, surge: 1.2 };
/** how many bodies may be alive at once; reinforcements queue behind this */
export function maxAliveFor(depth) { return clamp(4 + Math.floor((depth | 0) / 2), 4, 9); }

// Boss cadence is every five depths. The first encounter remains the Warden;
// the second and third are distinct mythic opponents instead of repeats.
export const BOSS_SEQUENCE = ['warden', 'minotaur', 'heracles'];
export const FINAL_BOSS_DEPTH = 20;
export const FINAL_BOSSES = Object.freeze({ zagreus: 'hades', melinoe: 'chronos' });
export function bossForDepth(depth, character = 'zagreus') {
  const encounter = Math.max(1, Math.floor((depth | 0) / 5));
  if (encounter >= 4) return FINAL_BOSSES[character] || FINAL_BOSSES.zagreus;
  return BOSS_SEQUENCE[Math.min(BOSS_SEQUENCE.length, encounter) - 1];
}

const _v = new THREE.Vector3();
/** no arrival may land farther than this from the hero (the dead-time guard) */
export const SPAWN_MAX_DIST = 14.0;

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
  budget(depth, biome = 'tartarus') {
    return Math.round((4 + Math.floor(depth * 1.35) + (depth >= 6 ? 2 : 0)) * (BIOME_THREAT[biome] || 1));
  }

  /** which beat a wave index plays in a room of nWaves */
  beatFor(w, nWaves, depth) {
    if (w === 0) return 'opener';
    if (nWaves === 2) return 'pressure';
    if (w === 1) return 'pressure';
    if (w === 2) return depth >= 3 ? 'elite' : 'pressure';
    return 'surge';
  }

  /**
   * compose a deterministic wave list for (biome, depth).
   * `trial` (from run.js) and `modifiers` (the run's pacts) shape the room:
   * an ambush adds timed reinforcements, an elite trial adds a second elite,
   * the RESTLESS pact trickles bodies into every wave past the opener.
   */
  compose(biome, depth, trial = null, modifiers = null) {
    const pool = ENCOUNTER_POOLS[biome] || ENCOUNTER_POOLS.tartarus;
    const live = pool.filter(p => p.w(depth) > 0);
    const total = this.budget(depth, biome);
    // 2 waves shallow, 3 mid, 4 deep — pacing, not padding
    const nWaves = depth >= 7 ? 4 : depth >= 3 ? 3 : 2;
    const split = nWaves === 2 ? [0.42, 0.58] : nWaves === 3 ? [0.30, 0.38, 0.32] : [0.24, 0.30, 0.26, 0.20];
    const cheap = live.filter(p => CHEAP.has(p.kind));
    const ranged = live.filter(p => RANGED.has(p.kind));
    const waves = [];
    for (let w = 0; w < nWaves; w++) {
      const beat = this.beatFor(w, nWaves, depth);
      let left = Math.max(2, Math.round(total * split[w]));
      const list = [];
      let guard = 0;
      // the OPENER teaches: cheap melee only, and never more than four bodies
      const source = beat === 'opener' && cheap.length ? cheap : beat === 'surge' && cheap.length ? cheap : live;
      // PRESSURE forces a mixed composition: one ranged family first, so the
      // wave has a priority target, then the rest by weight
      if (beat === 'pressure' && depth >= 2 && ranged.length) {
        const r = this.rng.weighted(ranged, (p) => p.w(depth));
        if (r && r.cost <= left + 1) { list.push(r.kind); left -= r.cost; }
      }
      while (left > 0 && guard++ < 24) {
        if (beat === 'opener' && list.length >= 4) break;
        const pick = this.rng.weighted(source, (p) => p.w(depth) * (p.cost <= left ? 1 : 0.001));
        if (!pick || pick.cost > left + 1) break;
        const n = PACK[pick.kind] || 1;
        for (let i = 0; i < n && left > 0; i++) { list.push(pick.kind); left -= pick.cost; }
      }
      // the ELITE beat always carries one shape-changer if it can afford it
      if (beat === 'elite' && !list.some(kind => SHAPERS.includes(kind))) {
        const specialist = depth >= 9 ? (depth % 2 ? 'riftstalker' : 'oracle') : depth >= 5 ? (depth % 2 ? 'siren' : 'herald') : 'lancer';
        list.push(specialist);
      }
      if (beat === 'pressure' && nWaves === 2 && depth >= 3 && !list.some(kind => SHAPERS.includes(kind))) list.push('lancer');
      // one body per elite wave becomes an ELITE from depth 3; an elite trial
      // promotes one in the pressure wave as well
      let elite = -1, affix = null;
      if ((beat === 'elite' && depth >= 3) || (beat === 'pressure' && trial === 'elite')) {
        let best = -1, bestCost = 0;
        for (let i = 0; i < list.length; i++) {
          const c = (pool.find(p => p.kind === list[i]) || { cost: 1 }).cost;
          if (c > bestCost) { bestCost = c; best = i; }
        }
        elite = best; affix = this.rng.pick(ELITE_AFFIXES);
      }
      // REINFORCEMENTS ON A TIMER. Small, late, and behind the alive cap.
      const trickle = [];
      const restless = !!(modifiers && modifiers.has && modifiers.has('restless'));
      if (beat === 'pressure' && depth >= 4) trickle.push({ kind: 'shade', at: 7.5 });
      if (beat !== 'opener' && (trial === 'ambush' || restless)) {
        const a = cheap.length ? this.rng.pick(cheap).kind : 'shade';
        const b = cheap.length ? this.rng.pick(cheap).kind : 'shade';
        trickle.push({ kind: a, at: 5.5 }, { kind: b, at: 10.5 });
      }
      waves.push({
        beat, list, elite, affix, trickle,
        // BREATH: the gap before this wave arrives. The opener is nearly
        // instant so the room starts; the elite beat gets the longest silence.
        delay: BREATH[beat] * (depth >= 6 && beat !== 'elite' ? 0.8 : 1),
        // arrivals inside a wave are staggered so six things never pop at once
        stagger: beat === 'surge' ? 0.16 : 0.22,
        trigger: w === 0 ? 'immediate' : 'thinned',
      });
    }
    return waves;
  }

  // ══════════════════════════════════════════════════════════ lifecycle ═══
  beginRoom(biome, depth = 0, opts = {}) {
    const ctx = this.ctx;
    this.roomId++;
    this.roomT = 0;
    this.mgr.clear();
    this.biome = biome || (ctx.world && ctx.world.biome) || 'tartarus';
    this.depth = depth | 0;
    this.rng.reseed(('room:' + this.biome + ':' + this.depth + ':' + (opts.seed ?? this.roomId)));
    this.boss = !!opts.boss || (this.depth > 0 && this.depth % 5 === 0);
    this.trial = opts.trial ?? ctx.run?.trial ?? null;
    this.modifiers = opts.modifiers ?? ctx.run?.modifiers ?? null;
    this.maxAlive = maxAliveFor(this.depth) + (this.modifiers?.has?.('frenzy') ? 1 : 0);
    this.waves = this.boss ? this._bossWaves() : this.compose(this.biome, this.depth, this.trial, this.modifiers);
    this.wave = -1;
    this.timer = 0;
    this.pending.length = 0;
    this.active = true;
    this.cleared = false;
    this.spawnedTotal = 0;
    this.elitesSpawned = 0;
    ctx.events.emit('encounter.begin', { biome: this.biome, depth: this.depth, waves: this.waves.length, boss: this.boss, trial: this.trial, maxAlive: this.maxAlive });
    return this;
  }

  _bossWaves() {
    const character = this.ctx?.run?.selectedCharacter || this.ctx?.player?.characterId || 'zagreus';
    const boss = bossForDepth(this.depth, character);
    const waves = [
      { beat: 'boss', list: [boss], delay: 1.1, stagger: 0, trigger: 'immediate', trickle: [], elite: -1 },
      { beat: 'pressure', list: ['shade', 'shade'], delay: 8.0, stagger: 0.3, trigger: 'timed', trickle: [], elite: -1 },
    ];
    // the later bosses get a second timed reinforcement so the arena never
    // settles into a duel the player has already solved
    if ((this.depth | 0) >= 10) waves.push({ beat: 'surge', list: ['hound', 'hound', 'hound'], delay: 34.0, stagger: 0.25, trigger: 'timed', trickle: [], elite: -1 });
    return waves;
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
    this.roomT = (this.roomT || 0) + dt;

    // staged arrivals inside the current wave
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      p.t -= dt;
      if (p.t <= 0) { this.pending.splice(i, 1); this._place(p.kind, p.index, p.count, { elite: p.elite }); }
    }

    const alive = this.mgr.aliveCount;
    // timed reinforcements inside the live wave, held behind the alive cap
    const cur = this.wave >= 0 ? this.waves[this.wave] : null;
    if (cur && cur.trickle && cur.trickle.length) {
      for (let i = 0; i < cur.trickle.length; i++) {
        const t = cur.trickle[i];
        if (t.done || this.timer < t.at) continue;
        if (this.mgr.aliveCount >= (this.maxAlive || 8)) continue;
        t.done = true;
        const e = this._place(t.kind, i, cur.trickle.length, { reinforcement: true });
        if (e) ctx.events.emit('wave.reinforce', { index: this.wave, kind: t.kind, entity: e, depth: this.depth });
      }
    }
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
        boss: this.boss, spawned: this.spawnedTotal, trial: this.trial, elites: this.elitesSpawned,
        time: this.roomT || 0,
      });
      ctx.ui?.toast?.('Chamber cleared', { color: '#f2c14e' });
    }
  }

  _launch() {
    this.wave++;
    this.timer = 0;
    const w = this.waves[this.wave];
    if (!w) return;
    if (w.trickle) for (let i = 0; i < w.trickle.length; i++) w.trickle[i].done = false;
    this.ctx.events.emit('wave.begin', { index: this.wave, count: w.list.length, depth: this.depth, beat: w.beat, elite: w.elite >= 0 ? w.affix : null });
    for (let i = 0; i < w.list.length; i++) {
      // the elite arrives LAST, announced, when the rest of its wave is already
      // on the floor — the question is asked after the room is set
      const order = w.elite === i ? w.list.length - 1 : (i > w.elite && w.elite >= 0 ? i - 1 : i);
      this.pending.push({ kind: w.list[i], t: order * (w.stagger || 0) + (w.elite === i ? 0.35 : 0), index: i, count: w.list.length, elite: w.elite === i ? w.affix : null });
    }
  }

  /**
   * Place one arrival. Enemies come in AROUND the player at a ring the player
   * can see, never behind the camera and never inside the hero's dash range.
   */
  _place(kind, index, count, o = {}) {
    const ctx = this.ctx;
    const p = ctx.player ? ctx.player.position : _v.set(0, 0, 0);
    const R = ctx.world && ctx.world.bounds ? ctx.world.bounds.r : 16;
    // spread arrivals around the arc AWAY from the player's facing, biased to
    // the sides so nothing materialises directly in the hero's blind spot
    const base = this.rng.range(0, TAU);
    const a = base + (index / Math.max(1, count)) * TAU * 0.86;
    // THE ARRIVAL RING IS MEASURED FROM THE HERO, NOT THE ORIGIN. A ring around
    // the arena centre put a body 25-35 m from a hero standing near a wall,
    // and that body spent six seconds walking (or, past its perception range,
    // standing) while the wave "ended" without it. Arrivals now come in on the
    // hero's side of the room: ~11 m out for a wave, ~7 m for a reinforcement,
    // never past SPAWN_MAX_DIST, and the arena rim clamps whatever falls
    // outside — which lands the body on the rim of the hero's half.
    const want = o.reinforcement ? clamp(R * 0.42, 6.5, 9.0) : clamp(R * 0.62, 9.0, 12.5);
    const ring = want + this.rng.range(-1.4, 1.4);
    const x = p.x + Math.cos(a) * ring, z = p.z + Math.sin(a) * ring;
    const e = this.mgr.spawn(kind, { x, z }, {
      depth: this.depth, wave: this.wave, minPlayerDist: 6.0, maxPlayerDist: SPAWN_MAX_DIST, elite: o.elite || null,
    });
    if (e) { this.spawnedTotal++; if (e.elite) this.elitesSpawned++; }
    return e;
  }

  /** debug/authoring helper: force a specific composition right now. */
  force(list, opts = {}) {
    this.mgr.clear();
    this.active = true; this.cleared = false;
    this.waves = [{ beat: 'forced', list, delay: 0, stagger: opts.stagger ?? 0.15, trigger: 'immediate', trickle: [], elite: opts.elite ?? -1, affix: opts.affix || null }];
    this.wave = -1; this.timer = 99; this.pending.length = 0;
    return this;
  }
}

export default Spawner;
