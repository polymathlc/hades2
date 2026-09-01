#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-perf.mjs — the frame-budget regression harness.
//
// WHAT IT MEASURES, and why these two numbers:
//
//   longest single frame   the hitch. A frame over ~33ms is a visible stutter;
//                          a frame over ~200ms is what a player calls "stuck".
//   transition duration    boss death -> the next chamber is live and playable.
//
// It drives the REAL shipped code — src/world/chamber.js's build generator,
// src/materials/texture-budget.js's prewarm, src/materials/recipes.js's actual
// texture synthesis — with a headless stand-in for the WebGL-only parts. The
// stand-in reproduces MaterialLibrary's TIMING POLICY exactly: a surface that
// is not in the cache when somebody asks for it is baked synchronously on the
// calling thread, which is what MaterialLibrary.set() does and is the single
// largest stall in the game.
//
//   --mode=before   the pre-fix path: one blocking world.build(), no prewarm.
//   --mode=after    the shipped path: sliced build + worker prewarm.
//   --mode=both     (default) run both and print the delta.
//   --tier=high     texture profile to measure at (low|med|high|ultra).
//   --json          machine-readable output.
//
// Both modes are real code paths in the shipping build: `before` is what
// build() still does for boot / the Crossroads / the capture harness, `after`
// is what a live room transition does.
// ---------------------------------------------------------------------------

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { World } from '../src/world/chamber.js';
import { RNG } from '../src/core/rng.js';
import { Profiler } from '../src/core/profiler.js';
import { nowMs } from '../src/core/scheduler.js';
import { textureProfileForTier, biomeTextureSets, prewarmBiomeTextures, ensureBiomeTextures }
  from '../src/materials/texture-budget.js';
import { RECIPES, bakeSet, resolveRecipe, BASE } from '../src/materials/recipes.js';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const MODE = String(args.get('mode') || 'both');
const TIER = String(args.get('tier') || 'high');
const JSON_OUT = !!args.get('json');
const FIGHT_SECONDS = Number(args.get('fight') || 2.5);
const FRAME_MS = 1000 / 60;

const RECIPES_URL = new URL('../src/materials/recipes.js', import.meta.url).href;

// ───────────────────────────────────────────────────────── worker bake pool ──
// The same shape as src/materials/bakepool.js: N threads, one recipe each,
// pixel buffers transferred back. This is what makes the "after" number honest
// — the synthesis really does happen off the measured thread.
const WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
let mod = null;
parentPort.on('message', async (msg) => {
  try {
    if (!mod) mod = await import(workerData.recipes);
    const set = mod.bakeSet(msg.key, msg.n);
    if (!set) { parentPort.postMessage({ id: msg.id, ok: false }); return; }
    parentPort.postMessage({ id: msg.id, ok: true, set }, mod.bakeTransferables(set));
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
  }
});
`;

class BakeThreads {
  constructor(n) {
    this.workers = []; this.idle = []; this.queue = []; this.pending = new Map(); this._id = 1;
    for (let i = 0; i < n; i++) {
      const w = new Worker(WORKER_SRC, { eval: true, workerData: { recipes: RECIPES_URL } });
      w.unref();
      w.on('message', (m) => this._done(w, m));
      w.on('error', () => this._done(w, { id: -1, ok: false }));
      this.workers.push(w); this.idle.push(w);
    }
  }
  bake(key, n) {
    return new Promise((resolve) => { this.queue.push({ key, n, resolve }); this._pump(); });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(), job = this.queue.shift(), id = this._id++;
      this.pending.set(id, job);
      w.postMessage({ id, key: job.key, n: job.n });
    }
  }
  _done(w, msg) {
    const job = this.pending.get(msg && msg.id);
    if (job) { this.pending.delete(msg.id); job.resolve(msg.ok ? msg.set : null); }
    this.idle.push(w); this._pump();
  }
  async close() { for (const w of this.workers) await w.terminate(); }
}

// ─────────────────────────────────────────────── headless material library ──
/**
 * MaterialLibrary without WebGL. Everything that decides FRAME COST is real:
 * the recipe, the resolution policy, the cache key, and — critically — the
 * synchronous fallback bake that fires when a chamber asks for a surface
 * nobody predicted.
 */
class HeadlessMats {
  constructor(pool, profile) {
    this.setCache = new Map();
    this.cache = new Map();
    this.scale = profile.proceduralScale;
    this._pool = pool;
    this.syncBakes = [];       // [{ name, ms }] — every main-thread stall
    this.syncMs = 0;
  }
  _size(rec) {
    const n = Math.round(((rec && rec.size) || BASE) * this.scale / 64) * 64;
    return Math.max(128, Math.min(2048, n));
  }
  _bootSets(biome) { return biomeTextureSets(null, biome); }

  /** The blocking path: MaterialLibrary.set()'s "nobody predicted this" bake. */
  set(name) {
    const key = resolveRecipe(name);
    if (!key) return null;
    const n = this._size(RECIPES[key]);
    const ck = key + '|' + n;
    if (this.setCache.has(ck)) return this.setCache.get(ck);
    const t0 = nowMs();
    const b = bakeSet(key, n);
    const dt = nowMs() - t0;
    this.syncBakes.push({ name: key, ms: dt });
    this.syncMs += dt;
    this.setCache.set(ck, b || { name: key, size: n });
    return this.setCache.get(ck);
  }

  /** The non-blocking path: bake across the pool, install when it lands. */
  async prebuild(names) {
    if (!this._pool) return;
    const jobs = [];
    for (const name of names || []) {
      const key = resolveRecipe(name);
      if (!key) continue;
      const n = this._size(RECIPES[key]);
      const ck = key + '|' + n;
      if (this.setCache.has(ck) || jobs.some((j) => j.ck === ck)) continue;
      jobs.push({ key, n, ck });
    }
    jobs.sort((a, b) => b.n - a.n);
    const raw = await Promise.all(jobs.map((j) => this._pool.bake(j.key, j.n)));
    for (let i = 0; i < jobs.length; i++) {
      this.setCache.set(jobs[i].ck, raw[i] || { name: jobs[i].key, size: jobs[i].n });
    }
  }

  get(name, opts) {
    const key = String(name);
    if (this.cache.has(key)) return this.cache.get(key);
    this.set(key);                               // the chamber touches the atlas
    const m = new THREE.MeshStandardMaterial();
    this.cache.set(key, m);
    return m;
  }
  tex() { return null; }
  setBiome() { return this; }
  setRim() { return this; }
}

// ──────────────────────────────────────────────────────────── the harness ──
class Bus {
  constructor() { this.m = new Map(); }
  on(k, f) { if (!this.m.has(k)) this.m.set(k, []); this.m.get(k).push(f); return this; }
  emit(k, p) { for (const f of (this.m.get(k) || []).slice()) f(p); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * One run of "fight at depth 5, kill the boss, walk through the door into
 * Asphodel at depth 6" — the single worst transition in the game, because it
 * is the one that changes biome.
 */
async function measure(mode, pool, profile) {
  const prof = new Profiler();
  const events = new Bus();
  const mats = new HeadlessMats(mode === 'after' ? pool : null, profile);
  const ctx = {
    scene: new THREE.Scene(), rng: new RNG(1337), events, mats,
    quality: { tier: TIER, render: { motes: true } },
    time: { renderDt: 1 / 60, t: 0 }, profiler: prof,
  };

  const world = new World();
  await world.init(ctx);
  // Boss chamber at depth 5, Tartarus. Built and paid for before we measure.
  world.build('tartarus', null, 90210);
  const tartarusSyncMs = mats.syncMs;
  mats.syncBakes.length = 0; mats.syncMs = 0;

  // ── the fight ──────────────────────────────────────────────────────────
  // Real wall-clock frames, because that is what gives the worker pool the
  // chance the shipping game gives it. `after` prewarms the next biome here,
  // exactly as RunState._prewarmAhead() does on room.entered.
  if (mode === 'after') prewarmBiomeTextures(mats, 'asphodel');

  const fightFrames = Math.round(FIGHT_SECONDS * 60);
  for (let i = 0; i < fightFrames; i++) {
    const t0 = nowMs();
    ctx.time.t += 1 / 60;
    world.update(1 / 60, ctx);
    world.lateUpdate(0, ctx);
    const busy = nowMs() - t0;
    prof.frame(busy);
    await sleep(FRAME_MS - busy);
  }

  // ── the boss dies; the player crosses the door ─────────────────────────
  prof.spanStart('transition');
  const tStart = nowMs();
  let transitionFrames = 0;

  if (mode === 'before') {
    // THE OLD PATH: world.setBiome() emits biome.changed and then rebuilds the
    // chamber in the same synchronous task, so every Asphodel surface falls
    // through to the blocking bake and the whole build lands on one frame.
    const t0 = nowMs();
    world.setBiome('asphodel', ctx);
    const busy = nowMs() - t0;
    prof.frame(busy);
    transitionFrames = 1;
  } else {
    // THE SHIPPED PATH: wait (normally zero, the pool finished during the
    // fight) for the surfaces, then pump the sliced build a few ms per frame.
    let waited = 0;
    const tw = nowMs();
    await ensureBiomeTextures(mats, 'asphodel');
    waited = nowMs() - tw;
    let t0 = nowMs();
    world.setBiome('asphodel', ctx, { sliced: true });
    let busy = nowMs() - t0;
    prof.frame(busy);
    transitionFrames = 1;
    let guard = 0;
    while (world.building && guard++ < 600) {
      await sleep(Math.max(0, FRAME_MS - busy));
      t0 = nowMs();
      ctx.time.t += 1 / 60;
      world.update(1 / 60, ctx);
      world.lateUpdate(0, ctx);
      busy = nowMs() - t0;
      prof.frame(busy);
      transitionFrames++;
    }
    ctx.waitedMs = waited;
  }

  const wallMs = nowMs() - tStart;
  prof.spanEnd('transition');
  const span = prof.spans.get('transition');
  const stats = prof.frameStats();
  world.dispose();

  return {
    mode,
    longestFrameMs: +span.longestFrameMs.toFixed(1),
    transitionMs: +wallMs.toFixed(1),
    transitionFrames,
    blockingBakeMs: +mats.syncMs.toFixed(1),
    blockingBakes: mats.syncBakes.length,
    worstBake: mats.syncBakes.slice().sort((a, b) => b.ms - a.ms)[0] || null,
    waitedForTexturesMs: +(ctx.waitedMs || 0).toFixed(1),
    allFrames: stats,
    bootBakeMs: +tartarusSyncMs.toFixed(1),
  };
}

function line(r) {
  return [
    `  mode                        ${r.mode}`,
    `  LONGEST SINGLE FRAME        ${r.longestFrameMs.toFixed(1)} ms`,
    `  transition wall time        ${r.transitionMs.toFixed(1)} ms over ${r.transitionFrames} frame(s)`,
    `  blocking texture bake       ${r.blockingBakeMs.toFixed(1)} ms in ${r.blockingBakes} set(s)`
      + (r.worstBake ? `  (worst: ${r.worstBake.name} ${r.worstBake.ms.toFixed(0)}ms)` : ''),
    `  waited on worker pool       ${r.waitedForTexturesMs.toFixed(1)} ms`,
  ].join('\n');
}

async function main() {
  const profile = textureProfileForTier(TIER);
  const cores = Math.max(2, Math.min(6, (await import('node:os')).cpus().length));
  const pool = new BakeThreads(cores);

  const modes = MODE === 'both' ? ['before', 'after'] : [MODE];
  const out = [];
  for (const m of modes) out.push(await measure(m, pool, profile));
  await pool.close();

  if (JSON_OUT) { console.log(JSON.stringify({ tier: TIER, cores, results: out }, null, 2)); return; }

  console.log('');
  console.log('EREBUS frame-budget harness — boss death at depth 5 -> Asphodel at depth 6');
  console.log(`tier ${TIER} (proceduralScale ${profile.proceduralScale}), ${cores} bake threads, ${FIGHT_SECONDS}s of fight before the door`);
  console.log('');
  for (const r of out) { console.log(line(r)); console.log(''); }

  if (out.length === 2) {
    const [b, a] = out;
    const fx = (x, y) => (y > 0 ? (x / y).toFixed(1) + 'x' : 'n/a');
    console.log('  ── DELTA ───────────────────────────────────────────────');
    console.log(`  longest frame        ${b.longestFrameMs.toFixed(0)}ms -> ${a.longestFrameMs.toFixed(0)}ms   (${fx(b.longestFrameMs, a.longestFrameMs)} better)`);
    console.log(`  blocking bake        ${b.blockingBakeMs.toFixed(0)}ms -> ${a.blockingBakeMs.toFixed(0)}ms`);
    console.log(`  transition wall      ${b.transitionMs.toFixed(0)}ms -> ${a.transitionMs.toFixed(0)}ms`);
    console.log('');
    const ok = a.longestFrameMs < b.longestFrameMs * 0.5 && a.blockingBakeMs < 1;
    console.log(ok ? '  perf ok: the transition no longer blocks the main thread.'
                   : '  PERF REGRESSION: the sliced/prewarmed path is not beating the blocking one.');
    if (!ok) process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
