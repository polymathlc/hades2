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
