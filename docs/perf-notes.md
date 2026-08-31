# EREBUS — frame-budget notes

Baseline: `codex/generated-texture-atlases` @ `d1abe10`.
All numbers reproduce with `npm run test:perf` (see *Harness* at the bottom).
Machine numbers are from this container (4 usable bake threads, contended); the
*ratios* and the *causes* are what transfer, not the absolute milliseconds.

---

## The symptom

> "After a boss dies, the game freezes / gets stuck loading for a long while."

That is a precise bug report, not a vague one. Bosses stand at depths **5, 10
and 15**, and the door out of a boss room is the door that **changes biome** —
Tartarus → Asphodel → Elysium. The freeze was the biome change, not the boss.

---

## What was actually blocking the main thread

### 1. Synchronous texture synthesis — **1.3–2.4 s, in one frame**  ← the freeze

`World.setBiome()` emits `biome.changed` and then rebuilds the chamber **in the
same synchronous task**. `MaterialLibrary.setBiome()` reacts to that event by
dispatching the new biome's bake across its worker pool — but it is not awaited,
and the main thread never yields, so not a single worker result can arrive before
the rebuild starts asking for surfaces. Every one of them therefore fell through
`MaterialLibrary.set()`'s "nobody predicted this" path, which bakes **on the
calling thread**.

Measured cost of that fallback at the `high` profile (`proceduralScale 0.58`),
`node .perf-tmp/bench3` style direct `bakeSet()` calls:

| biome | blocking bake | worst single recipe |
|---|---|---|
| Asphodel (depth 5 → 6) | **2386 ms** across 8 sets | `floor.asphodel` 645 ms |
| Elysium  (depth 10 → 11) | **864 ms** across 2 sets | `floor.elysium` 486 ms |

The browser console said so out loud the whole time —
`[mats] sync bake (blocked main thread): floor.asphodel …` — once per surface.

### 2. The chamber build itself — **70–275 ms, in one frame**

`World.build()` disposes the previous chamber and synthesises the next one — void,
floor, rim, back wall, colonnade, focal, braziers, hangings, doors, scatter — in
a single call. Per-section cost on this machine (warm):

```
floor      ~12ms   backwall  ~12ms   colonnade ~19ms   doors ~9ms
rim         ~7ms   braziers   ~7ms   focal      ~6ms   void  ~4ms
```

None of it is urgent to the millisecond. All of it was on one frame.

### 3. Shader programs deleted and recompiled on every chamber

Three.js frees a compiled program when the last material referencing it is
disposed. Two systems disposed theirs on every teardown:

* `world/doors.js` — the god **sigil** and **threshold** `ShaderMaterial`s, two
  per doorway, three doorways per chamber.
* `render/atmosphere.js` — the **mote** `ShaderMaterial`, one per air layer,
  rebuilt from scratch on every biome change.

So the first frame of every new chamber included a driver-side shader
compilation stall.

### 4. GPU upload storm on the new chamber's first frame

~30 freshly baked maps get their `texImage2D` + mipmap generation the first time
something draws with them, i.e. all at once, on the first frame of the new room.

### 5. The Warden re-built his own crown and greatsword on every spawn

`WARDEN.onSpawn()` guarded its rig dressing with `a.mem.built` — but
`Enemy.spawn()` does `for (const k in this.mem) delete this.mem[k]`, so the guard
never held. Every appearance re-ran two `mergeGeometries()` calls **and parented
a second crown and a second sword onto the same bones** (a correctness bug and a
leak as well as a hitch).

---

## The fixes

| # | Fix | File |
|---|---|---|
| 1 | **Prewarm the next biome's surfaces in the worker pool while the player is still fighting.** `RunState._prewarmAhead()` fires on every room entry for `biomeFor(depth+1)` and `biomeFor(depth+2)`, so Asphodel is baked from room 4 onward. The list is the union of MaterialLibrary's boot list and `world/biomes.js`'s role→recipe map, so a newly authored recipe is prewarmed the day it is added instead of silently reappearing as a stall. | `materials/texture-budget.js`, `game/run.js` |
| 2 | **Gate the transition on those surfaces** (`ensureBiomeTextures`, 4 s ceiling). Normally resolves on the next microtask because #1 already finished; the game keeps rendering during any wait instead of freezing. | `game/run.js` |
| 3 | **Time-slice the chamber build.** `World.beginBuild()` returns a suspendable task over a generator; `World.lateUpdate()` pumps it 3–6 ms per rendered frame, with the budget widening on frames that had slack. 25 yield points. `World.build()` still runs to completion in one call for boot, the Crossroads and the capture harness. | `world/chamber.js`, `core/scheduler.js` |
| 4 | **Pool the door shader materials** across chambers so their programs survive teardown; real disposal moved to `Doors.destroy()`. | `world/doors.js` |
| 5 | **Persist the atmosphere mote materials and geometry** across biome changes; only uniforms and attribute data are re-stamped. | `render/atmosphere.js` |
| 6 | **Trickle GPU uploads.** `RenderSystem.queueTextureWarm()` + `pumpTextureWarm()` call `renderer.initTexture()` a couple of ms at a time, and only on frames that were inside budget and not already carrying a chamber build. | `render/renderer.js` |
| 7 | **Pre-build enemy rigs one per frame** during a room's opening beat, instead of on the frame an enemy pops into the fight. | `entities/spawner.js` |
| 8 | **Move permanent rig dressing to construction time** via a new `def.onBuild` hook, fixing the Warden's per-spawn re-merge and duplicate attachments. | `entities/enemies/base.js`, `entities/enemies/boss.js` |
| 9 | **Frame instrumentation.** `core/profiler.js` records every frame's main-thread busy time plus named spans (`boss.transition`, `run.transition`) and sections (each build slice, each upload batch). `main.js` wraps `engine.step`; `EREBUS.perf.report()` in the console. | `core/profiler.js`, `main.js` |

Nothing here lowers visual quality. Same geometry, same texture resolution, same
particle counts, same post chain — the work is simply not all on one frame any
more, and the work that can happen early does.

---

## Measured: before → after

`npm run test:perf` — boss dies at depth 5, player crosses the door into
Asphodel at depth 6. Three consecutive runs on a contended container:

```
                        BEFORE                AFTER
longest single frame    1944 ms               16 ms     (119x)
                        2466 ms               11 ms     (222x)
                        1994 ms               17 ms     (117x)

blocking texture bake   1803 / 2329 / 1827 ms  0 ms  (0 sets, every run)
transition wall time    1944 / 2466 / 1994 ms  586 / 582 / 1668 ms
transition frames       1 (the freeze)         12-15 frames of normal play
```

* **The freeze is gone.** The worst frame in the whole transition is now inside
  or near a 60 Hz budget instead of two seconds of an unresponsive tab.
* **Zero blocking bakes.** The `sync bake (blocked main thread)` line no longer
  appears during a transition at all.
* The "after" wall time is not a stall — it is 12–15 *live, rendered, playable*
  frames while the chamber assembles. The one 1668 ms outlier is the harness's
  deliberately pessimistic 2.5 s fight window on a 4-thread contended box; a real
  room lasts 20–60 s, and the browser run below shows the pool finishing long
  before the door.

Chamber build in isolation (same code, sliced vs. one call):

```
one call   87-275 ms in a single frame
sliced     25 steps, worst step ~15-19 ms warm (~47 ms on a cold JIT),
           ~210-280 ms total spread over 13-17 frames
```

Browser verification (Chromium + SwiftShader, `q=med`, `vite preview`): the
transition completes correctly — `biome: asphodel`, `depth: 6`, `runState:
playing`, 3 doors, spawner active, 128 chamber objects, **no `sync bake` lines
during the transition**, 187 textures pre-uploaded by the warm queue, zero page
errors. Absolute frame times from a software rasteriser are meaningless (a
single rendered frame there is >1 s), which is why the harness of record is the
Node one.

---

## Known, not fixed (out of this agent's file ownership)

* `world/props.js` mints and disposes two `ShaderMaterial`s per chamber (the
  flame field and the ember field), so those two programs are still recompiled
  on every chamber. Same one-line fix as `doors.js` — pool them.
* `MaterialLibrary.set()`'s synchronous fallback still exists (it must: a
  missing texture is worse than a slow one). It is now unreachable on the
  transition path, but a surface that is in neither `_bootSets` nor
  `biomes.js`'s role map would still find it. Watch the console for
  `[mats] sync bake (blocked main thread)` — that line is the tripwire.
* `characterrig.skin / .cloth / .hair` still bake synchronously during boot
  (~270 ms total). Boot, not gameplay, but it belongs in the boot prebuild list.

---

## Harness

```
npm run test:perf                 # before + after + delta, exits 1 on regression
node scripts/test-perf.mjs --mode=after --tier=low
node scripts/test-perf.mjs --json
node scripts/test-perf.mjs --fight=10        # longer prewarm window
```

It drives the real shipped code — `world/chamber.js`'s build generator,
`materials/texture-budget.js`'s prewarm, `materials/recipes.js`'s actual
synthesis — with a headless stand-in for the WebGL-only parts. The stand-in
reproduces `MaterialLibrary`'s **timing policy** exactly, including the
synchronous fallback bake, and runs the prewarm through real `worker_threads` so
the "after" number is honest about where the CPU time went. `--mode=before` is
the pre-fix path, which is still a live path in the shipping build (boot, the
Crossroads and the capture harness all take it).

The pass condition is adversarial on purpose: the sliced path must be **more
than twice** as good on longest-frame *and* must record **zero** milliseconds of
blocking bake, or the script exits non-zero.
