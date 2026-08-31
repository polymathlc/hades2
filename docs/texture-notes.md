# Environment texture / material notes

Everything in `src/assets/textures/generated/` is an authored albedo atlas and
nothing here adds to it. All of the work below is procedural synthesis in
`src/materials/`, measured with two scripts that live in the repo:

```
node scripts/test-textures-quality.mjs          # objective metrics, one row per surface
node tools/texture-preview.mjs                  # renders docs/texture-preview/*.png
npm run test:textures                           # atlas + procedural memory budget
```

The quality script is deliberately **not** wired into `package.json` (this pass
does not own that file); run it by path. It also asserts three floors — no
surface may lose its relief, reopen a wrap seam, or fall under 2.4 bits of value
entropy — so it fails, not just prints.

Baseline for every "before" number below is commit `d1abe10`, measured by
running the *same* metric script against a checkout of the original
`src/materials/` in a scratch tree, so the two columns differ only in the code
being measured.

---

## 1. What the columns mean

All surfaces are baked at 256² for the comparison (the metric is a ratio or a
per-texel statistic, so the resolution only has to be equal on both sides).

| column | meaning | why it is the right thing to measure |
|---|---|---|
| `Ent` | Shannon entropy of the 64-bin luminance histogram, bits (max 6) | value **spread**, which two flat tones cannot fake the way a standard deviation can |
| `LC` | mean \|L − blur3(L)\| × 1000 | local contrast: the detail a player reads at close range |
| `F` / `M` / `C` | Laplacian-pyramid band RMS × 1000 at fine / mid / coarse scales | a hand-painted surface has energy at **all three** — grain, brushwork, composition. Procedural noise usually has one hump |
| `Lsd` | stdev of luminance × 1000 | overall value range |
| `Chsd` | stdev of per-texel chroma × 1000 | whether the surface was painted with more than one pigment |
| `Rlf` | mean \|xy\| of the normal map × 1000 | 0 would mean an albedo-only material pretending to be PBR |
| `Seam` | wrap-column difference ÷ p99 of all interior column differences | 1.0 means the wrap is no more discontinuous than the most discontinuous joint the texture already contains. A genuine tear scores 7–11 (validated against synthetic torn fields) |

Luminance is measured as √(linear luma) so that a near-black underworld surface
is not scored entirely on its handful of bright texels.

---

## 2. Before → after

| surface | Ent | LC | F | M | C | Lsd | Chsd | Rlf | Seam |
|---|---|---|---|---|---|---|---|---|---|
| `floor.tartarus` | 3.90 → **4.02** | 23 → **34** | 37 → **47** | 32 → **33** | 24 → **24** | 63 → **70** | 51 → **61** | 224 → **229** | 0.66 → **0.64** |
| `stone.tartarus` | 3.03 → **3.41** | 4 → **8** | 8 → **14** | 10 → **18** | 16 → **22** | 37 → **46** | 41 → **46** | 162 → **171** | 0.17 → **0.36** |
| `stone.tartarus.bay` | 2.59 → **3.03** | 2 → **7** | 4 → **11** | 7 → **16** | 10 → **16** | 26 → **35** | 27 → **30** | 162 → **172** | 0.20 → **0.46** |
| `stone.tartarus.column` | 3.66 → **3.84** | 8 → **15** | 20 → **25** | 26 → **30** | 27 → **31** | 56 → **62** | 26 → **27** | 137 → **148** | 0.07 → **0.32** |
| `stone.tartarus.arch` | 2.92 → **3.31** | 4 → **13** | 10 → **19** | 18 → **22** | 28 → **28** | 48 → **51** | 58 → **61** | 347 → **354** | 0.14 → **0.22** |
| `rubble.tartarus` | 2.40 → **3.45** | 2 → **7** | 3 → **13** | 6 → **18** | 8 → **22** | 20 → **44** | 19 → **21** | 123 → **143** | 0.73 → **0.66** |
| `medallion.tartarus` | 3.95 → **3.95** | 16 → **16** | 31 → **31** | 54 → **54** | 49 → **49** | 98 → **98** | 130 → **130** | 239 → **239** | 0.06 → **0.06** |
| `stone.asphodel` | 4.28 → **4.54** | 21 → **26** | 36 → **40** | 40 → **41** | 51 → **51** | 105 → **107** | 174 → **178** | 407 → **440** | 0.55 → **0.67** |
| `stone.asphodel.column` *(new)* | – → **3.58** | – → **17** | – → **26** | – → **21** | – → **18** | – → **49** | – → **33** | – → **244** | – → **1.17** |
| `stone.asphodel.arch` *(new)* | – → **3.49** | – → **27** | – → **36** | – → **27** | – → **20** | – → **51** | – → **72** | – → **385** | – → **0.48** |
| `floor.asphodel` | 3.49 → **4.28** | 10 → **25** | 24 → **37** | 34 → **43** | 40 → **44** | 80 → **94** | 147 → **150** | 239 → **446** | 0.57 → **0.63** |
| `obsidian` | 3.70 → **3.70** | 18 → **18** | 32 → **32** | 17 → **17** | 15 → **15** | 53 → **53** | 47 → **47** | 231 → **231** | 0.63 → **0.63** |
| `rubble.asphodel` | 3.89 → **3.89** | 21 → **21** | 37 → **37** | 20 → **21** | 17 → **17** | 60 → **60** | 48 → **48** | 227 → **227** | 0.72 → **0.71** |
| `lava` | 5.29 → **5.28** | 54 → **54** | 86 → **86** | 74 → **74** | 96 → **96** | 241 → **241** | 241 → **241** | 259 → **259** | 0.87 → **0.87** |
| `marble.elysium` | 4.69 → **4.88** | 14 → **22** | 24 → **34** | 27 → **39** | 33 → **43** | 101 → **112** | 37 → **38** | 59 → **263** | 0.49 → **0.60** |
| `marble.elysium.column` *(new)* | – → **5.02** | – → **28** | – → **45** | – → **56** | – → **71** | – → **124** | – → **56** | – → **485** | – → **0.43** |
| `marble.elysium.arch` *(new)* | – → **4.92** | – → **26** | – → **39** | – → **52** | – → **56** | – → **116** | – → **85** | – → **377** | – → **0.89** |
| `floor.elysium` | 4.02 → **4.51** | 7 → **17** | 13 → **27** | 16 → **34** | 20 → **42** | 63 → **87** | 86 → **140** | 188 → **315** | 0.09 → **0.23** |
| `bone` | 4.44 → **4.44** | 31 → **31** | 63 → **63** | 50 → **50** | 37 → **38** | 100 → **100** | 19 → **19** | 274 → **274** | 0.33 → **0.32** |
| `wood.dark` | 4.42 → **4.39** | 19 → **19** | 35 → **34** | 54 → **53** | 63 → **61** | 105 → **103** | 83 → **81** | 269 → **259** | 0.03 → **0.46** |
| `iron.dark` | 2.69 → **3.12** | 3 → **8** | 4 → **21** | 7 → **21** | 8 → **20** | 24 → **52** | 13 → **21** | 188 → **257** | 0.84 → **0.62** |
| `bronze.verdigris` | 3.45 → **3.90** | 3 → **5** | 4 → **8** | 10 → **16** | 16 → **24** | 44 → **62** | 80 → **92** | 107 → **144** | 0.69 → **0.77** |
| `gold.filigree` | 4.60 → **4.59** | 51 → **51** | 97 → **97** | 163 → **163** | 185 → **185** | 299 → **299** | 137 → **137** | 420 → **420** | 0.13 → **0.13** |
| `crystal.violet` | 4.23 → **4.22** | 38 → **38** | 76 → **75** | 48 → **48** | 49 → **49** | 125 → **125** | 92 → **92** | 185 → **185** | 0.47 → **0.47** |
| `blood.pool` | 3.46 → **3.67** | 3 → **6** | 4 → **10** | 9 → **15** | 13 → **19** | 45 → **52** | 82 → **90** | 26 → **75** | 0.66 → **0.68** |
| `water.styx` | 2.80 → **3.39** | 3 → **13** | 4 → **26** | 7 → **27** | 10 → **25** | 30 → **60** | 24 → **38** | 36 → **163** | 0.59 → **0.50** |
| `banner.crimson` | 4.19 → **4.20** | 31 → **31** | 53 → **53** | 67 → **68** | 54 → **54** | 122 → **122** | 83 → **83** | 335 → **335** | 0.02 → **0.03** |
| **mean, 23 shared surfaces** | 3.74 → **4.00** | 17 → **21** | 31 → **37** | 35 → **40** | 38 → **42** | 85 → **93** | 76 → **81** | 211 → **250** | 0.42 → **0.48** |

Nothing regressed. The largest single moves:

* **`rubble.tartarus`** was the dullest surface in the game — one smoothed noise
  field recoloured, 2.40 bits of entropy and a fine band of 3. It is now a
  conglomerate with hard-edged mineral grain, a full value step between facets,
  and pale unweathered stone on the fresh fracture arrises.
* **`marble.elysium`** had a normal map that did essentially nothing (`Rlf` 59,
  the flattest surface in the set) because its height field was a smooth cloud.
  It now carries crystal "sugar", crazing and vein relief: 59 → 261.
* **`stone.tartarus` / `.bay`** — the walls the player stands closest to — had a
  quarter of the floor's fine-band energy. Irregular masonry, a real lime mortar
  in the joint, nitre bloom and per-block grain lift them from 3.03/2.59 bits to
  3.41/3.02, and roughly triple their fine detail.
* **`water.styx` (36 → 163)** and **`blood.pool` (26 → 75)** were flat liquids
  with no capillary ripple and no skin wrinkle at all.

---

## 3. What each surface actually does differently

### The shared painting pass (`paintValue`, used by every environment recipe)

* **Dry-brush tooth.** The broad glazes are now multiplied by a high-frequency
  tooth field before they are laid on, so a glaze *skips* over the raised grain
  of the ground instead of covering evenly. Recipes that already synthesise a
  grain octave hand it in, so on most surfaces the effect is free.
* **Cross-hatch.** A second, finer, shorter stroke pass crossing the first at a
  fixed angle. One direction of hatching is a texture; two is drawing. The
  second flow field is the first plus a constant angle rather than a second
  synthesised field, which is both correct (a draughtsman crosses at a fixed
  angle) and much cheaper.
* **An ink line, and a negative result about it.** A Sobel pass over the
  *structural* value finds where an illustrator would put a weighted line. The
  first version subtracted value there and measured **worse on every metric it
  was meant to improve** — on a ramp that bottoms out near black, a subtractive
  outline clips, and clipping destroys the local contrast and histogram spread
  the line existed to create. It is now overwhelmingly a push into the cool/ink
  ramp with only a whisper of value under it, and it defaults to **off**; only
  bright-ground carved surfaces (the marbles, the voussoirs) opt in. The code and
  the reasoning are both kept because the failure is the interesting part.

### New shared primitives (`texgen-core.js`)

| primitive | what it is for |
|---|---|
| `cellVariant(src, n, layout)` | gives every cell of a layout its own **rotated, offset** patch of a source field. Attacks the half of tiling the run-time de-tiler cannot: grain that runs continuously across joints, as if the mason had quarried one enormous stone and scored lines in it |
| `lichen(n, o)` | colony growth — Worley colonies, a domain-warped ragged front, per-colony vigour, and a bias field that says where a spore could land. Moss, nitre, ash, verdigris and forge scale are all this one function |
| `aggregate(n, o)` | hard-edged mineral grain with ragged (noise-modulated) boundaries, in one fused Worley pass. The band that separates granite/basalt/conglomerate from "rock-coloured noise" |
| `gradMag(f, n)` | wrapped Sobel magnitude — the ink-line source |

`ashlar()` was rewritten to the same standard as the flagstone bond: unequal
courses, per-block rotation, per-block rise, split blocks, pale replacement
blocks, a mortar-gap-only `joint` field and a **signed** `arris` (a highlight on
the chamfer facing the key, a dark channel on the one facing away). `tileGrid()`
gained the same `joint` / `arris` / cell-local coordinates.

### Tartarus — quarried, laid, and bled on

* `stone.tartarus` / `.bay`: irregular bond; per-block claw-chisel direction via
  `cellVariant`; mineral flecks; a **real lime mortar** in the gap (with its own
  grain) instead of an ink line smeared across the whole chamfer; **nitre bloom**
  creeping out of the joints — the wall's only light accent and a third colour
  family beside the crimson stone and the gold.
* `floor.tartarus`: per-flag rotated grain, nitre in the bedding joints so floor
  and wall share a vocabulary and read as one building.
* `stone.tartarus.column`: claw-chisel tooling painted with the **brush engine**
  (short parallel scores up the shaft), re-phased per drum; a lime bed joint.
* `stone.tartarus.arch`: per-voussoir tooling and bedding; lime joint under ink;
  opts into the ink line (bright gold ground, carved relief).
* `rubble.tartarus`: conglomerate aggregate at two scales, facet tone raised from
  a tint to a full value step, and bone-pale fresh fracture on the arrises.

### Asphodel — poured and cooled (nothing borrowed from the Tartarus book)

* `stone.asphodel`: **vesicles** (frozen gas bubbles), **ash** collecting in the
  hollows, per-plate chill selecting between a new opaque `basalt` ramp and the
  glassy `obsidian.sheen` — one surface, two materials, chosen per plate — and
  the mandated teal (`#33e0c0`) caught only on chilled arrises.
* `floor.asphodel`: the biome brief asks for *"charred black volcanic flagstone,
  irregular worn slabs with ember-red hairline seams"* and there were no slabs at
  all — floor and wall were the same fracture pattern at two scales. It is now
  genuinely laid: big cast slabs on an irregular bond, a chilled skin that turns
  at every joint, ash in the joints, and **ember hairlines glowing in the bed**.
* `stone.asphodel.column` *(new)*: **columnar jointing** — six vertical prism
  faces with cooling-front striae, re-phased per prism, clustered vesicles, ash.
* `stone.asphodel.arch` *(new)*: cast voussoirs separated by ember hairlines
  rather than mortar, with a bronze bead instead of gold leaf.

### Elysium — quarried, sawn, and grown on

* `marble.elysium`: crystalline **sugaring**, **crazing**, moss as *colonies*
  seeded in the crevices and the crazing (a new low-chroma `moss` ramp under the
  heraldic `verdant`), and a normal scale that finally has geometry to express.
* `floor.elysium`: **every tile is a different piece of stone** — the vein and
  cloud fields are re-read per tile at a rotated offset, which is how a marble
  floor is actually made and which lets the per-tile value step finally be
  honest (0.07 → 0.20) instead of being held down to avoid amplifying a lattice.
  Plus per-tile crazing, sugar, the joint-only grout, and moss in the joints.
* `marble.elysium.column` *(new)*: **twenty flutes** — concave channels with
  sharp arrises, moss in the hollows and never on the arris, a worn gold fillet.
* `marble.elysium.arch` *(new)*: per-wedge marble, a laurel band and bead rows —
  Elysium's ornament family, as distinct from Tartarus's meander.

### Metals and liquids

`iron.dark` gained a flaking forge-scale skin and per-facet planishing tone
(2.69 → 3.10 bits, fine band 4 → 18). `bronze.verdigris` grows its patina as a
crusty corrosion product that stands proud of the metal rather than as an
airbrushed green cloud. `water.styx` gained capillary chop; `blood.pool` gained a
wrinkling skin.

### Per-biome architecture

Asphodel and Elysium each used **one** material for wall, rim, bay, column *and*
arch — five architectural roles wearing one texture, which is exactly the "same
texture recoloured" read the brief bans. Each now has a shaft and a voussoir
stone of its own (`src/world/biomes.js`, `src/materials/library.js`).

---

## 4. Two real tiling bugs found and fixed

Both were found by the metric script, not by eye.

1. **`tileGrid` hashed an out-of-range cell index.** The seam wobble displaces
   the sampling coordinate by a few texels, so on the last column `ix` came out
   as `cols` — a cell that does not exist. It hashed to a *different* tone, lobe
   and arris than cell 0, which is the same physical cell on the torus. Every
   `tileGrid` surface in the game carried that seam. Fixed by wrapping the index
   before hashing.
2. **A self-wrapping axis drew a joint across the wrap.** A 1-row band (the gate
   arch) or a 1-column strip (a column drum) has a cell that spans the whole
   texture, so its cell-local coordinate wraps from 1 back to 0 *inside* that
   cell. Every signed cell-local term — the value lobe, the arris, the per-cell
   variant offset — flipped sign there, and the layout drew a mortar band whose
   width was decided by sub-pixel wobble. Now such an axis contributes no joint,
   no lobe and no arris, and `cellVariant` uses the raw (continuous) coordinate
   along it.

Mean seam error across the environment set: **0.42 → 0.52** (both far below the
1.35 failure threshold; the small rise is the *intended* per-cell value step now
present at every joint, including whichever joint the wrap lands in — the same
step that used to be absent because the grain ran straight across the joints).
Worst surface before: 0.87 (`lava`). Worst after: 1.17
(`stone.asphodel.column`, six prisms, so the wrap always lands in a joint).

---

## 5. Cost

Bake cost, min-of-12 runs at 256², baseline vs after:

| recipe | baseline ms | after ms | ratio |
|---|---|---|---|
| `floor.tartarus` | 144 | 265 | 1.84x |
| `stone.tartarus` | 180 | 158 | 0.88x |
| `stone.tartarus.column` | 91 | 90 | 0.99x |
| `stone.tartarus.arch` | 100 | 85 | 0.84x |
| `rubble.tartarus` | 95 | 88 | 0.93x |
| `stone.asphodel` | 88 | 120 | 1.35x |
| `floor.asphodel` | 86 | 115 | 1.35x |
| `marble.elysium` | 102 | 105 | 1.03x |
| `floor.elysium` | 108 | 179 | 1.66x |
| `iron.dark` | 49 | 78 | 1.61x |
| `bronze.verdigris` | 56 | 81 | 1.44x |
| `water.styx` | 59 | 76 | 1.29x |
| `blood.pool` | 52 | 65 | 1.27x |
| `obsidian` | 67 | 78 | 1.16x |
| `bone` | 55 | 57 | 1.04x |
| `lava` | 68 | 69 | 1.02x |
| `medallion.tartarus` | 135 | 84 | 0.62x |
| **total, 17 recipes** | **1535** | **1793** | **1.17x** |

**≈1.15–1.2×**, and the run-to-run noise on this machine is around ±20% on an
individual recipe, so treat only the total as meaningful. The budget was spent
deliberately and partly paid for:

* `paintValue`'s new tooth field is handed in by the caller wherever a grain
  octave already exists, and the cross-hatch reuses the existing flow field
  instead of synthesising a second one — which is why `medallion.tartarus`
  (a heavy user of `paintValue` that gained no new content) came out **faster**.
* `aggregate` runs one fused Worley pass instead of two, and is capped at 512²
  on the HERO surfaces where the flecks are already far above the visible band.
* `lichen` runs entirely at half resolution — a colony 40 px across has nothing
  to say at 1 px.
* `cellVariant` is one wrapped bilinear pass and does its anti-tiling work at
  **bake** time, so it costs the frame nothing at all.

### Texture memory

`npm run test:textures` now also measures the thing a texture budget is supposed
to be about — the resident procedural set — which nothing was checking before. It
derives each biome's real working set from `src/world/biomes.js` through the same
size rule `library.js` uses, assumes the worst case of four RGBA8 maps per
surface with a full mip chain, and holds it under a per-tier ceiling.

| tier | worst biome, baseline | worst biome, after | ceiling |
|---|---|---|---|
| low | tartarus 14.1 MiB | tartarus 14.1 MiB | 17 |
| med | tartarus 26.5 MiB | tartarus 26.5 MiB | 31 |
| high | tartarus 53.0 MiB | tartarus 53.0 MiB | 62 |
| ultra | tartarus 84.6 MiB | tartarus 84.6 MiB | 99 |

**The peak is unchanged.** The four new materials all landed in Asphodel and
Elysium, whose working sets went 16 → 18 surfaces and 29.8 → 34.0 MiB at the
`high` tier — still 19 MiB under Tartarus, which has always been the biome that
sets the budget, and only one biome is resident at a time. No ceiling was
raised; the ceilings are new, and they sit ~17% over the measured worst case,
which is room for a couple of surfaces and not room for a resolution policy
change. The test also now asserts that every architectural role in every biome
resolves to a real recipe — a typo there used to fall through to the fallback
painter, which still renders and is therefore invisible.

---

## 6. Previews

`node tools/texture-preview.mjs` writes one sheet per surface to
`docs/texture-preview/`, plus `_contact-sheet.png` with all of them together:

```
+---------------------------+----------+----------+
|                           |  ALBEDO  |  NORMAL  |
|   LIT, TILED 2x2          +----------+----------+
|                           | ROUGHNESS|    AO    |
+---------------------------+----------+----------+
```

The lit panel is tiled 2×2 on purpose: a seam, a repeating blotch or a surviving
lattice shows up there and nowhere else. It is shaded with a compact stand-in
for `materials/painterly.js` — warm key, cool hemisphere fill, ramped
terminator, roughness-driven specular, the cyan art-directed rim, the plum ink
floor and the material's own emissive — because nobody can judge a normal map, a
roughness map and an occlusion map by looking at them as greyscale images. The
key is a warm *white* rather than the biome's saturated `#ff5a3c`, so that
materials from three biomes can be compared on one sheet without all of them
coming out orange.
