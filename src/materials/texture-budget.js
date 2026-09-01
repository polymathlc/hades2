// OWNER: AGENT-MATERIAL / AGENT-PERF
// ---------------------------------------------------------------------------
// texture-budget.js — how much texture a browser tier may spend, and WHEN the
// spending happens.
//
// Resolution is the dominant cost because synthesis, decoded RAM, mip storage
// and upload bandwidth all grow with width².
//
// THE TIMING HALF OF THIS FILE IS THE ONE THAT KILLED FRAMES. MaterialLibrary
// bakes a biome's surfaces in a worker pool, but it only starts that bake when
// `biome.changed` fires — and the chamber rebuild that follows runs in the SAME
// synchronous task. The workers never get a chance to answer, so every surface
// the new biome needs falls through MaterialLibrary.set()'s "nobody predicted
// this" path and is synthesised ON THE MAIN THREAD. Measured on this machine at
// the `high` profile: entering Asphodel = 1362ms of blocking bake (floor 402ms,
// stone 273ms, obsidian 209ms, …); entering Elysium = 301ms. That is the
// "the game freezes after the boss dies" report, exactly: bosses live at depths
// 5/10/15 and the door out of a boss room is the door that changes biome.
//
// prewarmBiomeTextures() dispatches the same bake through the same worker pool
// MINUTES earlier — while the player is still fighting — so by the time the
// door is crossed every set is already in the cache and set() never blocks.
// ---------------------------------------------------------------------------

import { BIOMES } from '../world/biomes.js';

export const TEXTURE_PROFILES = Object.freeze({
  low: Object.freeze({ proceduralScale: 0.30, generatedScale: 0.25, anisotropy: 2 }),
  med: Object.freeze({ proceduralScale: 0.42, generatedScale: 0.50, anisotropy: 4 }),
  high: Object.freeze({ proceduralScale: 0.58, generatedScale: 0.75, anisotropy: 8 }),
  ultra: Object.freeze({ proceduralScale: 0.75, generatedScale: 1.00, anisotropy: 12 }),
});

export function textureProfileForTier(tier = 'med') {
  return TEXTURE_PROFILES[tier] || TEXTURE_PROFILES.med;
}

// A standalone mirror of MaterialLibrary's per-biome surface list. The library
// owns one authoritative copy (`_bootSets`) and world/biomes.js owns the other
// (every role a chamber names); we ask BOTH and take the union, because a miss
// here is not a missing texture — it is a 200-300ms main-thread bake landing on
// the transition frame. This literal list is the last-resort fallback for a
// stubbed or partial material system, and lets tools reason about the bake
// without constructing one.
export const BIOME_TEXTURE_SETS = Object.freeze({
  tartarus: Object.freeze(['floor.tartarus', 'stone.tartarus', 'stone.tartarus.bay',
    'stone.tartarus.column', 'stone.tartarus.arch', 'rubble.tartarus',
    'stone.tartarus.rim', 'bone.tartarus', 'bronze.tartarus', 'iron.tartarus',
    'ceramic.tartarus', 'wood.tartarus']),
  asphodel: Object.freeze(['floor.asphodel', 'stone.asphodel', 'obsidian.asphodel',
    'lava.asphodel', 'rubble.asphodel', 'bone.asphodel', 'bronze.asphodel', 'iron.asphodel']),
  elysium: Object.freeze(['floor.elysium', 'marble.elysium']),
});

/**
 * Every surface a chamber in `biome` will ask for on its first frame.
 *
 * The union of three sources, deduplicated:
 *   1. MaterialLibrary's own boot list for that biome (the shared surfaces),
 *   2. world/biomes.js's role -> recipe map, which is literally what the
 *      chamber's Kit will name while it lays the room out, and
 *   3. the local mirror above, for a stubbed material system.
 * Source 2 matters: it is maintained by whoever adds a recipe, so a new
 * `stone.asphodel.arch` is prewarmed the day it is authored instead of
 * silently reappearing as a 229ms stall on the boss-room exit.
 */
export function biomeTextureSets(mats, biome) {
  const out = [];
  const seen = new Set();
  const push = (n) => { if (typeof n === 'string' && n && !seen.has(n)) { seen.add(n); out.push(n); } };

  if (mats && typeof mats._bootSets === 'function') {
    try {
      const names = mats._bootSets(biome);
      if (Array.isArray(names)) for (const n of names) push(n);
    } catch (e) { /* stubbed library — the other two sources still stand */ }
  }
  const B = BIOMES[biome];
  if (B && B.mats) for (const k in B.mats) push(B.mats[k]);
  const mirror = BIOME_TEXTURE_SETS[biome] || BIOME_TEXTURE_SETS.tartarus;
  for (const n of mirror) push(n);
  return out;
}

/**
 * Bake `biome`'s surfaces in the worker pool, ahead of anybody needing them.
 *
 * Resolves when the pool has installed them (or immediately when they are
 * already cached, or when there is no pool and the sync path is the only path).
 * Never rejects: a prewarm that fails is a slow transition, not a broken game.
 */
export function prewarmBiomeTextures(mats, biome, opts = {}) {
  if (!mats || typeof mats.prebuild !== 'function' || !biome) return Promise.resolve(false);
  const key = 'prewarm:' + biome;
  if (!mats.__prewarm) {
    try { Object.defineProperty(mats, '__prewarm', { value: new Map(), enumerable: false, writable: true }); }
    catch (e) { mats.__prewarm = new Map(); }
  }
  const cache = mats.__prewarm;
  if (cache.has(key) && !opts.force) return cache.get(key);
  const names = biomeTextureSets(mats, biome);
  // Chunked on purpose. MaterialLibrary.prebuild() awaits every job and then
  // INSTALLS them all in one microtask — and installing means building the
  // THREE textures and compositing the authored albedo, which is main-thread
  // work. One burst of eighteen sets mid-fight is its own little hitch, so the
  // prewarm is fed a few surfaces at a time and the installs land spread out.
  const CHUNK = opts.chunk || 6;
  let p = Promise.resolve(true);
  for (let i = 0; i < names.length; i += CHUNK) {
    const slice = names.slice(i, i + CHUNK);
    p = p.then(() => mats.prebuild(slice)).then(() => true, () => false);
  }
  cache.set(key, p);
  return p;
}

/**
 * Wait until `biome` is safe to build against. Cheap when already warm: the
 * library skips cached sets, so this is one empty Promise.all.
 */
export function ensureBiomeTextures(mats, biome) {
  return prewarmBiomeTextures(mats, biome);
}

export default TEXTURE_PROFILES;
