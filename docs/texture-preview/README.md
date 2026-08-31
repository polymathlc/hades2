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
invisible here and unmistakable in a play-camera frame; a fourth (the Elysium
pier reading as grey bark) shipped in round 2 and was invisible on the flat
tile too.

`_inengine-before-after.png` is the in-engine gate. It is **not** a grid of
whole frames — the version that was: at the size it shipped, the before and
after cells were indistinguishable and the sheet did not support its own
caption. It is now four **2x crops on named props**, before beside after:

| row | prop | recipe |
|---|---|---|
| 1 | Elysium pier shaft | `marble.elysium.column` |
| 2 | Elysium floor slab | `floor.elysium` |
| 3 | Tartarus flag bed | `floor.tartarus` |
| 4 | Asphodel shaft | `stone.asphodel.column` |

BEFORE is upstream-only `812a7f4` — the tree this branch has to beat, not an
earlier revision of the branch. AFTER is this branch. Both are the same frame:
the shipping camera rig (distance 12.6 m, pitch 45°, fov 36°), `seed=1337`,
`?capture&q=high`, `state('play')`, one biome switch per row's biome, and the
HUD-free `capture.clean()` frame so no UI is counted as scene content.

**This file is committed on purpose.** `.gitignore` has
`docs/texture-preview/*.png` (the flat-tile sheets really are regenerable from
`tools/texture-preview.mjs` alone), and this one is `git add -f`'d past it,
because reproducing it needs two builds of two different commits and half an
hour of software-rasterised rendering. `_contact-sheet.png` and the per-surface
sheets are NOT committed; this one and this one only is.

To regenerate:

```
# 1. the BEFORE tree
git archive 812a7f4 | tar -x -C /tmp/before && cd /tmp/before
ln -s <repo>/node_modules . && npx vite build --outDir dist
node <repo>/tools/serve.mjs dist 4801 &

# 2. the AFTER tree
npx vite build --outDir dist-after && node tools/serve.mjs dist-after 4804 &

# 3. one 1600x900 frame per biome per tree, via window.EREBUS.capture:
#      c.seed(1337); c.biome(b); c.state('play'); c.step(2.0);
#      c.pose({anchor:'rig', distance:12.6, pitchDeg:45, fov:36, lookHeight:3.3});
#      c.hud(false); c.render(); return c.clean();
#    (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers, swiftshader; ~5-10 min a tree)
# 4. crop the four prop rects out of the pairs and compose the sheet.
```

The crop rects are fixed pixel rectangles in that 1600x900 frame: the geometry
is identical between the two trees, so the same rect samples the same stone.
They are listed in `docs/texture-notes.md` §4 beside the measurements taken
over them.
