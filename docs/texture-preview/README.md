# Texture previews

Regenerate with:

```
node tools/texture-preview.mjs             # 176px bake, what is committed here
node tools/texture-preview.mjs --size 384  # closer inspection
node tools/texture-preview.mjs --only floor.elysium,stone.asphodel
```

Each sheet is one generated environment surface:

```
+---------------------------+----------+----------+
|                           |  ALBEDO  |  NORMAL  |
|   LIT, TILED 2x2          +----------+----------+
|                           | ROUGHNESS|    AO    |
+---------------------------+----------+----------+
```

The lit quadrant is tiled 2×2 deliberately — a wrap seam, a repeating blotch or
a surviving lattice shows up there and nowhere else. It is shaded with a compact
stand-in for `src/materials/painterly.js` (warm key, cool hemisphere fill, ramped
terminator, roughness-driven specular, the cyan art-directed rim, the plum ink
floor, and the material's own emissive), because a normal map, a roughness map
and an occlusion map cannot be judged as greyscale images.

`_contact-sheet.png` puts every lit preview on one page.

See `../texture-notes.md` for the measured before/after numbers.

## `_inengine-before-after.png`

The flat-tile sheets in this directory are **not sufficient on their own** — see
`docs/texture-notes.md` §4. Three regressions shipped in round 1 that were
invisible here and unmistakable in a play-camera frame.

`_inengine-before-after.png` is the in-engine gate: 3 rows (Tartarus / Asphodel /
Elysium) x 3 columns (play framing / colonnade framing / floor framing), each
cell **before on top, after underneath**, all at the shipping camera rig
(distance 12.6 m, pitch 45°, fov 36°, seed 1337, `?capture&q=high`).

Regenerate with `tools/capture.mjs` against `dist/` — see §4 for the exact
`window.EREBUS.capture` calls.
