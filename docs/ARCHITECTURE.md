# EREBUS — Architecture & Module Ownership Contract

**Stack:** Vite + Three.js `0.185.x`, ES modules, **zero external art assets**.
Every texture, mesh, animation, and sound is generated procedurally at runtime or authored as code.
Reason: determinism, no licensing, no network at runtime, infinite art-directable control.

**Genre:** isometric-3/4 rogue-lite action game (Hades-genre). NOT an FPS.

---

## 1. Golden rules for every agent

1. **Own only your files.** Never edit a file outside your ownership list (§3). If you need a
   change elsewhere, add it behind an existing contract or report it — do not edit.
2. **Never break the contract signatures in §2.** Extend, don't rewrite.
3. **The game must always run.** After your change: `npm run build` must succeed and
   `node tools/capture.mjs` must produce a non-black frame with zero console errors.
4. **No placeholder visuals left behind.** Untextured grey primitives are an auto-fail.
5. **Read `docs/ART_DIRECTION.md` first.** It is binding.
6. **Everything is deterministic.** Use `ctx.rng`, never `Math.random()`. Use `ctx.time`, never `Date.now()`/`performance.now()` in sim code.
7. **Perf budget** (on a real GPU at 1080p): 60fps target. Draw calls < 400. Triangles < 1.2M.
   Use instancing for anything repeated. Pool everything that spawns.

---

## 2. Core contracts (DO NOT CHANGE SIGNATURES)

### 2.1 Context object
Every system receives the shared `ctx`:

```js
ctx = {
  engine,          // Engine
  time:   { t, dt, fixedDt, frame, scale },   // scale = time dilation (hitstop/slowmo)
  rng,             // RNG   (see 2.3)
  input,           // Input (see 2.4)
  events,          // EventBus (see 2.5)
  renderer,        // THREE.WebGLRenderer
  scene,           // THREE.Scene
  camera,          // THREE.PerspectiveCamera
  post,            // PostFX      — render/postfx.js
  lighting,        // LightRig    — render/lighting.js
  mats,            // MaterialLibrary — materials/library.js
  world,           // World       — world/chamber.js
  player,          // Player      — entities/player.js
  combat,          // CombatSystem— entities/combat.js
  vfx,             // VFX         — vfx/index.js
  ui,              // UI          — ui/index.js
  audio,           // Audio       — audio/index.js
  run,             // RunState    — game/run.js
  quality,         // { tier:'low'|'med'|'high'|'ultra', dpr, shadows, ... }
  capture,         // null, or CaptureDriver when running the headless harness
}
```

### 2.2 System interface
```js
export class SomeSystem {
  async init(ctx) {}          // may await; called once, in dependency order
  update(dt, ctx) {}          // fixed-step sim; dt is ALWAYS ctx.time.fixedDt
  lateUpdate(alpha, ctx) {}   // per-frame, alpha = interpolation factor 0..1 (visuals only)
  resize(w, h, ctx) {}
  dispose() {}
}
```

### 2.3 RNG — `core/rng.js`
```js
rng.f()             // float [0,1)
rng.range(a,b)      // float
rng.int(a,b)        // int inclusive
rng.pick(arr)
rng.sign()
rng.gauss(mu, sd)
rng.fork(label)     // deterministic child stream — use one per subsystem
```

### 2.4 Input — `core/input.js`
```js
input.move          // THREE.Vector2, world-space-normalised intent, length<=1
input.aim           // THREE.Vector3 world point on the arena plane
input.aimDir        // THREE.Vector2 normalised from player to aim
input.pressed(a) / input.down(a) / input.released(a)
// actions: 'attack','special','cast','dash','summon','interact','pause','map'
```

### 2.5 EventBus — `core/events.js`
```js
events.on(name, fn) -> off()
events.emit(name, payload)
```
Canonical events (extend freely, never rename):
`damage.dealt {target,amount,crit,dir,pos,source}`
`entity.died {entity,pos}`
`player.dashed {pos,dir}`
`room.cleared {room}`
`room.entered {room}`
`boon.granted {boon}`
`hit.stop {ms}`
`camera.shake {amp,dur,freq}`

### 2.6 Damage model
```js
combat.applyDamage({ target, amount, type, crit, dir, pos, source, knockback, statuses })
```
`type`: `'physical'|'fire'|'lightning'|'frost'|'poison'|'arcane'`
Every damage application MUST emit `damage.dealt` so VFX/UI/audio can react.

### 2.7 Materials — `materials/library.js`
```js
mats.get(name, opts)   // returns a cached THREE.Material
mats.tex(name, opts)   // returns a cached THREE.Texture
```
Named materials that MUST exist (world/props/entities depend on these):
`stone.tartarus`, `stone.asphodel`, `marble.elysium`, `obsidian`, `gold.filigree`,
`bronze.verdigris`, `bone`, `lava`, `blood.pool`, `floor.tartarus`, `floor.asphodel`,
`floor.elysium`, `banner.crimson`, `wood.dark`, `iron.dark`, `crystal.violet`, `water.styx`

### 2.8 VFX — `vfx/index.js`
```js
vfx.impact(pos, normal, {type, scale, color})
vfx.slash(origin, dir, {arc, radius, color, width})
vfx.burst(pos, {count, color, speed, spread, kind})
vfx.trail(object3D, {color, width, life})
vfx.decal(pos, normal, {kind, size, color})
vfx.death(pos, {kind, color, scale})
vfx.beam(a, b, {color, width, life})
vfx.shockwave(pos, {radius, color, life})
```

### 2.9 UI — `ui/index.js`
```js
ui.setHealth(cur,max) / ui.setMana(cur,max) / ui.setCast(n)
ui.damageNumber(worldPos, amount, {crit, type})
ui.showBoonChoice(options) -> Promise<chosenBoon>
ui.toast(text, {icon, color})
ui.setRoom(depth, biome)
ui.screen('title'|'game'|'pause'|'death'|'victory')
```

### 2.10 Audio — `audio/index.js`
```js
audio.sfx(name, {pos, pitch, gain, variation})
audio.music.setBiome(name) / audio.music.setIntensity(0..1)
audio.duck(amount, ms)
```

---

## 3. File ownership map (one owner each — NO overlap)

| Area | Files | Owner agent |
|---|---|---|
| Boot & contracts | `src/main.js`, `src/core/**`, `docs/**`, `tools/**` | ORCHESTRATOR |
| Render pipeline | `src/render/**` | AGENT-RENDER |
| Materials/textures | `src/materials/**` | AGENT-MATERIAL |
| World & architecture | `src/world/**` | AGENT-WORLD |
| Player & camera rig | `src/entities/player.js`, `src/entities/camera.js`, `src/entities/rig.js` | AGENT-PLAYER |
| Weapons & combat | `src/entities/weapons.js`, `src/entities/combat.js`, `src/entities/projectiles.js` | AGENT-COMBAT |
| Enemies & AI | `src/entities/enemies/**`, `src/entities/ai.js` | AGENT-ENEMY |
| VFX | `src/vfx/**` | AGENT-VFX |
| UI | `src/ui/**` | AGENT-UI |
| Audio | `src/audio/**` | AGENT-AUDIO |
| Run/meta/boons | `src/game/**` | AGENT-RUN |

---

## 4. Capture harness (how the critics see the game)

`tools/capture.mjs <url> <out.png> <ms>` — single screenshot.
`tools/shots.mjs <preset>` — renders the deterministic shot list to `shots/`.

The game exposes a capture driver when loaded with `?capture=1`:
```js
window.EREBUS.capture = {
  ready: Promise<void>,
  seed(n), step(seconds), pose(name|{pos,target,fov}), state(name), hide(list), wait()
}
```
Capture mode: fixed dt, no vsync dependence, RNG reseeded, all timers driven by `step()`.
This guarantees byte-identical framing across runs so critics compare like-for-like.

Shot list lives in `tools/shotlist.json` — each entry `{id, state, pose, steps, note}`.

---

## 5. Capture states (REQUIRED for visual QA)

`tools/shotlist.json` drives the critic loop. Some shots request a named scenario via
`window.EREBUS.capture.state(name)`, which emits `capture.state {name, args}` on the event bus.
**Each owning system must listen for the states it is responsible for and deterministically set up
that scenario** (using `ctx.rng`, never wall-clock time), otherwise its shot is meaningless.

| State | Owner | Must produce |
|---|---|---|
| `combat` | AGENT-ENEMY + AGENT-COMBAT | Player mid-combo, 4–6 enemies alive and engaged, projectiles in flight |
| `vfxburst` | AGENT-VFX | A representative burst of the game's best effects at peak |
| `ui` | AGENT-UI | Full HUD visible and populated with plausible values |
| `boons` | AGENT-UI + AGENT-RUN | The boon-choice screen open with three real cards |
| `death` | AGENT-VFX + AGENT-ENEMY | An enemy death at its most spectacular frame |
| `boss` | AGENT-ENEMY | The boss on screen mid-telegraph |

Register with:
```js
ctx.events.on('capture.state', ({name}) => { if (name === 'combat') this.setupCaptureCombat(ctx); });
```

## 6. Concurrency etiquette

Multiple agents work in this checkout simultaneously.
- Build and capture with `bash tools/run-shots.sh shots/<yourname> "" <YOUR_PORT>` — never reuse
  another agent's port, and never `pkill` node/vite (you will kill a peer's build).
- Never run `git commit`, `git checkout`, `git stash`, `git reset`, or `git clean`.
- Code defensively against stubs: any system you did not write may be a no-op stub. Never assume
  another system's optional method exists — guard with `?.` or a presence check.

## 7. Objective frame metrics

`node tools/analyze.mjs shots/<dir>` prints hard numbers per frame and a list of automatic
warnings. Use it alongside your eyes — it catches what eyes rationalise away.

Healthy targets for a shipped EREBUS frame:
| Metric | Target | Why |
|---|---|---|
| `bands.shadow` | 0.20 – 0.55 | a real ink-shadow band exists |
| `bands.highlight` | 0.04 – 0.20 | the frame reaches genuinely bright values |
| `deepShadowPresent` | > 0.02 | true blacks are present |
| `rmsContrast` | > 0.20 | not milky |
| `meanSaturation` | 0.28 – 0.60 | jewel tones, not mud, not neon |
| `shadowTint.sat` | > 0.15 | shadows are coloured, not neutral grey |
| `shadowTint.hue` | 240 – 320 | shadows sit in the violet/plum range |
| `detailDensity` | > 0.010 | surfaces carry real texture |
| `depthBands.spread` | >= 0.18 | three separated value bands, measured by TRUE depth |
| `tiling.strength` | < 0.45 | no visible repeat |

`depthBands` is computed from a **linear view-depth companion** (`<shot>.depth.png`) that the capture
harness renders alongside every frame, bucketing luma by actual scene depth into near/mid/far
terciles. An earlier version bucketed by *screen thirds*, which is not depth: in a wide pose the top
third is mostly void, so the metric improved when you brightened the sky — the opposite of the
intended incentive. An agent caught and reported this. The screen-thirds figure is still emitted as
`screenThirds` for reference but is **never used as a gate**. If no depth companion exists,
`depthBands` is `null` and the value-band law simply is not checked, rather than checked wrongly.

`tiling.strength` measures a *prominent periodic peak* in the horizontal autocorrelation, detrended
against a local baseline. Raw autocorrelation is high for any smooth image, so an earlier version of
this metric reported 0.94 on a perfectly smooth gradient and sent agents chasing a repeat that did
not exist. It is now validated against synthetic cases: a smooth gradient scores 0, a hard 64px tile
scores 1.0 at period 64.
| `groundP90` | < 0.42 | no large blazing regions of floor |

`groundLuma`/`groundP90` sample the **true floor plane** in world space (reconstructed from the
depth companion: world Y within ±0.75 of the floor, inside the arena radius), reported as
`groundSource: "world-plane"`. An earlier version sampled the bottom 45% of the *frame*, which in a
combat shot is mostly the hero and their own VFX burst — an agent proved this by measuring the same
band with the hero's column excluded and getting 0.758 vs 0.332, i.e. the thing being blamed for
the failure was never setting it. Without a depth companion it falls back to the screen region and
says so via `groundSource: "screen-region(approx)"`.
| `crushedPct` | < 18 | shadows still hold detail |
| `blownPct` | < 3 | highlights are not clipped |

## 8. Blind A/B comparison

`node tools/ab.mjs <A> <B> <outDir> [seed]` composites two frames (or two whole shot
directories, paired by filename) side by side, **randomising which source lands on the left**, and
writes a sealed `KEY.json` answer sheet next to the output.

The critic agent is shown only the composite and asked which panel is better and why. It cannot
know which build it is praising. The orchestrator decodes `KEY.json` afterwards.

Two uses:
1. **Regression / progress proof** — `tools/ab.mjs shots/prev shots/latest shots/ab` proves a change
   actually improved the frame rather than just changing it.
2. **Against real reference** — drop reference stills into `refs/` (filenames matching the shot ids)
   and run `tools/ab.mjs refs shots/latest shots/ab-vs-ref`. The critic then performs a genuine
   two-image blind comparison. `refs/` is gitignored; reference images are never committed.

## 9. Measured performance budget (update these numbers when they change)

Measured on the recovered wave-2 build (headless SwiftShader; draw calls and counts are
GPU-independent, timings are not):

| Metric | Measured | Budget | Status |
|---|---|---|---|
| Draw calls | 312 | < 400 | ok |
| Triangles | 637k | < 1.2M | ok |
| Shader programs | 56 | < 80 | ok |
| Textures | 92 | — | watch |
| **Material generation** | **7080 ms** | **< 1500 ms** | **FAIL — P1** |

**Caveat on the timing:** 7080 ms was measured on this CI container's CPU under software
rendering. Texture synthesis is pure JS and CPU-bound, so a developer machine will be meaningfully
faster — the library's author targeted ~3 s. Treat 7080 ms as an upper bound, not the shipping
number. It is still too slow: even a third of it is a blank screen before the first chamber. Fixes, in order of preference:
1. Generate at lower resolution and upsample — most painterly surfaces do not need 2048².
2. Generate on demand per biome rather than the whole library up front.
3. Move synthesis into a Worker so it does not block the main thread, with a loading state.
4. Cache generated textures in IndexedDB keyed by a content hash, so only the first load pays.
Whoever owns `src/materials/**` next must bring this under 1500 ms.
