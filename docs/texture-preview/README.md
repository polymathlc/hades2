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
