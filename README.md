# EREBUS — Descent

An isometric 3/4 rogue-lite action game in Three.js, in the Hades genre: a persistent Crossroads
home base, chamber-to-chamber runs, god boons, four distinct weapons, and a painterly
Greek-underworld art direction.

The game uses a **hybrid painterly material pipeline**: eight image-generated albedo atlases provide
authored colour and brushwork for every named surface, while code generates the matching normals,
roughness, metalness, ambient occlusion, emissive masks, anti-tiling projection, meshes, animation,
and sound at runtime. No downloaded stock textures, models, audio, or fonts. ~40k lines.

---

## Play it

**Easiest — no install of any kind.** Download [`standalone/play.html`](standalone/play.html)
(1.7 MB, one file) and double-click it. It opens in your browser and runs. Everything is inlined;
there is no server, no Node, no npm.

**As a desktop app:**
```bash
npm install
npm run desktop      # Electron window
npm run dist:win     # -> release/EREBUS-Descent-*-win-x64.exe (72 MB portable)
```

**For development:**
```bash
npm install
npm run dev          # then open the URL it prints (usually http://localhost:5173)
npm run standalone   # rebuild standalone/play.html
```

First load bakes the procedural texture library on a worker pool. On a slow machine that takes a
few seconds before the first chamber appears — this is a known rough edge, not a hang.

The browser build now starts in **Auto** graphics mode. It uses available memory, CPU count, screen
size, pixel density, mobile input, and data-saver preference to choose Low, Medium, or High. Low
mode renders at a reduced resolution, disables shadows and the expensive cinematic passes, halves
the simulation workload, uses fewer lights and particles, and leaves CPU cores free while textures
are built. The pause-menu **Settings** screen can save Auto, Low, Medium, High, or Ultra; changing it
at the home base reloads safely and applies the full tier. `?q=low` is also available as an immediate
URL override for older computers.

For a production build:

```bash
npm run build && npm run preview
```

### Controls

| Input | Action |
|---|---|
| **W A S D** / arrows | Move (camera-relative, 8-direction) |
| **Left mouse** | Attack toward cursor — melee combos or the bow’s charged shot |
| **Right mouse** | Cursor-aimed special (weapon-dependent: sweep, spear throw, kick, guard) |
| **Q** | Cast |
| **Space** / **Shift** | Dash — i-frames during the active window, cancels attack recovery |
| **R** | God Call / Summon |
| **E** or **F** | Interact; approach a hovering weapon at home and press to equip it |
| **Esc** | Pause |
| **H** | Open the in-game controls guide |

Gamepad is supported: left stick moves, right stick aims, face buttons map to attack/special/dash,
and the Menu button pauses. The pause menu includes persistent Master, Music, and Effects volume controls.

### The four weapons

Each is a separate rhythm, not a reskin — timings, cancel windows, hitbox shapes and knockback are
authored as data in `src/entities/weapons.js`. Choose one from the hovering Crossroads armory before
entering the portal; that arm is bound for the entire descent.

- **Stygian Blade** — fast 3-hit combo, third hit a committed lunge with root motion
- **Spear** — long reach poke combo, plus a charged throw that sticks and is recalled
- **Bow** — charge to fire; damage and pierce scale with charge, power shot at full draw
- **Shield** — block absorbs and *reflects* projectiles; parry window rewards timing; charged bash

---

## What's in it

- Fixed-timestep engine with hit-stop and slow-mo, seeded RNG, twin-stick + gamepad input
- Hybrid painterly PBR: image-generated albedo atlases, procedural PBR support maps, brush-stroke
  layers, domain warping, palette ramps, worker-pool baked
- HDR pipeline: Beer–Lambert haze, multi-mip Karis bloom, god rays, per-biome grade, SMAA
- Ornate architecture with real carved relief — chamfered profiles, baked contact occlusion that
  survives instancing
- Six enemy families designed to pass a black-shape silhouette test, plus a three-phase boss
- Crossroads home base with a run portal, boss-dropped Nectar, persistent saves, and two permanent upgrade tracks for every god
- Attack-token AI so only N enemies commit at once — the mechanism that keeps fights readable
- Drawn-shape VFX atlas, ribbon trails, pooled instanced particles
- Ornate HUD and god-coloured boon cards with generated deity portraits, rarity upgrades, and god-specific combat VFX
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
