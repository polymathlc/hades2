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
