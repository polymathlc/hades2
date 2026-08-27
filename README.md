# EREBUS — Descent

A rogue-lite action game in the Hades genre, built in Three.js.
Isometric 3/4 camera, chamber-to-chamber runs, god boons, painterly underworld art direction.

**Everything is procedural.** No external art, audio, or model assets — every texture,
mesh, animation and sound is generated in code. See `docs/ART_DIRECTION.md` and
`docs/ARCHITECTURE.md`.

## Run
```bash
npm install
npm run dev        # http://localhost:5173
```

## Visual QA harness
```bash
tools/run-shots.sh shots/latest        # deterministic screenshots -> shots/latest/
```
The game exposes `window.EREBUS.capture` when loaded with `?capture=1`, giving a
fixed-timestep, seeded, scriptable camera so every capture is byte-comparable.

```bash
node tools/analyze.mjs shots/latest           # objective frame metrics + automatic warnings
node tools/ab.mjs shots/prev shots/latest ab  # blind side-by-side, randomised, sealed answer key
```

`analyze.mjs` measures value-band distribution, RMS contrast, saturation, shadow tint hue, detail
density, ground-plane luma and tiling autocorrelation, and fails the frame against the numeric
targets in `docs/ARCHITECTURE.md` §7.

`ab.mjs` randomises which build lands on which side so a reviewer cannot know what they are
praising. Drop reference stills into `refs/` (gitignored) to blind-compare against real artwork.
