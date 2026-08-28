# EREBUS — Descent

An isometric 3/4 rogue-lite action game in Three.js, in the Hades genre: chamber-to-chamber runs,
god boons, four distinct weapons, a painterly Greek-underworld art direction.

**Everything is procedural.** No external art, audio, model or font files — every texture, mesh,
animation and sound is generated in code at runtime. ~40k lines.

---

## Play it

```bash
npm install
npm run dev          # then open the URL it prints (usually http://localhost:5173)
```

First load bakes the procedural texture library on a worker pool. On a slow machine that takes a
few seconds before the first chamber appears — this is a known rough edge, not a hang.

For a production build:

```bash
npm run build && npm run preview
```

### Controls

| Input | Action |
|---|---|
| **W A S D** / arrows | Move (camera-relative, 8-direction) |
| **Left mouse** | Attack — combos, with input buffering and cancel windows |
| **Right mouse** / **E** | Special (weapon-dependent: spin, throw, power shot, bash) |
| **Q** | Cast |
| **Space** / **Shift** | Dash — i-frames during the active window, cancels attack recovery |
| **1 2 3 4** | Equip blade / spear / bow / shield |
| **X** or **C** | Cycle weapon |
| **R** | Summon |
| **F** | Interact (doors, rewards) |
| **Esc** | Pause |

Gamepad is supported: left stick moves, right stick aims, face buttons map to attack/special/dash.

### The four weapons

Each is a separate rhythm, not a reskin — timings, cancel windows, hitbox shapes and knockback are
authored as data in `src/entities/weapons.js`.

- **Stygian Blade** — fast 3-hit combo, third hit a committed lunge with root motion
- **Spear** — long reach poke combo, plus a charged throw that sticks and is recalled
- **Bow** — charge to fire; damage and pierce scale with charge, power shot at full draw
- **Shield** — block absorbs and *reflects* projectiles; parry window rewards timing; charged bash

---

## What's in it

- Fixed-timestep engine with hit-stop and slow-mo, seeded RNG, twin-stick + gamepad input
- Procedural painterly PBR: brush-stroke layers, domain warping, palette ramps, worker-pool baked
- HDR pipeline: Beer–Lambert haze, multi-mip Karis bloom, god rays, per-biome grade, SMAA
- Ornate architecture with real carved relief — chamfered profiles, baked contact occlusion that
  survives instancing
- Six enemy families designed to pass a black-shape silhouette test, plus a three-phase boss
- Attack-token AI so only N enemies commit at once — the mechanism that keeps fights readable
- Drawn-shape VFX atlas, ribbon trails, pooled instanced particles
- Ornate HUD and god-coloured boon cards
- Synthesised adaptive score: Karplus-Strong plucked strings, procedural impulse responses per
  biome, stems that layer with combat intensity

---

## Visual QA harness

```bash
tools/run-shots.sh shots/latest          # deterministic screenshots + depth + clean companions
node tools/analyze.mjs shots/latest      # objective frame metrics and automatic warnings
node tools/ab.mjs shots/a shots/b out    # blind side-by-side, randomised, sealed answer key
node tools/crop.mjs in.png out.png x y w h zoom
```

`?capture=1` exposes a scriptable driver (seed → step → pose → render) so every capture is
byte-comparable. `ab.mjs` randomises which build lands on which side and seals the key, so a
reviewer cannot know what they are praising — it has already caught one regression that looked
like an improvement by every other measure.

See `docs/ART_DIRECTION.md` and `docs/ARCHITECTURE.md`. Note §10 and §13–14 of the art bible in
particular: **ten** metrics in this project turned out to be measuring the wrong thing, and not one
was caught by the numbers — every one was found by opening an image.

---

## Known rough edges

This is an early playable build, not a finished game.

- Blind critic panels score it in the mid-30s out of 100 against Hades II. It is not there.
- The hero can still be hard to pick out at a glance in a busy frame
- Cast shadows are hard-edged in places (being fixed)
- Texture bake on first load is slow
- The display serif falls back to a system font — bundling a font would break the no-external-assets rule
