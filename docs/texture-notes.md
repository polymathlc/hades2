# Environment texture / material notes

Everything in `src/assets/textures/generated/` is an authored albedo atlas and
nothing here adds to it. All of the work below is procedural synthesis in
`src/materials/`, measured with the scripts in the repo:

```
node scripts/test-textures-quality.mjs      # objective metrics + hard floors, one row per surface
npm run test:textures                       # atlas bytes + the RESIDENT procedural memory set
node tools/texture-preview.mjs              # renders docs/texture-preview/*.png
```

---

## 0. Round 2: what the previous version of this file got wrong

This document shipped once with claims that did not survive an adversarial
review. They are corrected here rather than quietly edited out, because the
corrections are most of what round 2 is.

| the claim | what is actually true |
|---|---|
| "Baseline for every before number is `d1abe10`" | The branch merged six upstream commits that rewrote `painterly.js`, `palette.js`, `recipes.js`, `texgen-core.js`, `library.js` and `generated-textures.js`. **Upstream's bleach-pass fix alone moved `floor.tartarus` from 3.90 to 4.01 bits, `rubble.tartarus` from 2.40 to 2.62 and `stone.tartarus` from 3.03 to 3.16 — most of the Tartarus improvement round 1 was credited with.** Every number below is now measured against **`812a7f4`, upstream-only**, so it credits this work and nothing else. |
| "`floor.tartarus` 3.90 → 4.02, nothing regressed" | Against upstream the surface had gained **nothing but grain**. Dithering the upstream albedo with zero-mean white noise to the same local contrast reproduced its whole metric profile and *beat* it on entropy. See §2 — the test is now in the repo. |
| "Bake cost ≈1.17x" | The set `BIOMES` actually names, at the tier `library.js` bakes at, was **1.51x**. It is now **1.38x** for a set that is four materials larger, and **1.23x** on the 37 recipes both trees share. §6 re-measures it, and the per-recipe table that did not reproduce is gone. |
| "only one biome is resident at a time … the peak is unchanged" | Both false. `src/core/preload.js::preloadSurfaces()` bakes **every** recipe at launch on purpose, and `MaterialLibrary.dispose()` has no call site anywhere in `src/`. The real resident set is **23.4 / 47.5 / 100.8 / 155.7 MiB** (low/med/high/ultra), not the 53 MiB the budget test was measuring. §7. |
| The quality script "asserts three floors … so it fails, not just prints" | It could not fail. `Ent < 2.4` against a historical worst of 2.40097, `Rlf < 0.004` against a worst of 0.0255, `Seam > 1.35` against a worst of 1.17. The pre-branch code passed all three. §8 replaces them with floors set just under the *current* worst, three of which the pre-branch code fails. |
| "Nothing regressed" | True of the metric table, which had never been checked against a frame. Three hero props were visibly worse in the engine: a 20-flute marble shaft that read as a moiré barcode, an Asphodel shaft that had lost the biome's ember accent, and an Elysium floor that read as gravel. §4 and §1. |

Two things the review confirmed and that are **kept unchanged**: both `tileGrid`
seam fixes (§5), and the nine surfaces that carry real structure (§2).

## 0a. Round 3: the fix for a regression was itself a regression

Round 2's headline hero-prop fix — splitting a dedicated `marble.elysium.column`
out of `marble.elysium` and giving it a correct `cylinderY` unwrap — shipped a
regression **worse than the thing it replaced**, and every number in §3 said it
was an improvement, because every number in §3 is measured on a flat sheet. In
the frame the Elysium pier read as grey bark.

| pier ROI, mean over the rectangle | `812a7f4` | round 2 | control | round 3 |
|---|---|---|---|---|
| left pier `342,262 80x115` — luminance | 133.1 | 97.9 (-26%) | 129.9 (-2%) | **128.4 (-3%)** |
| left pier — chroma (max−min channel) | 43.7 | 26.3 (-40%) | 39.9 (-9%) | **39.0 (-11%)** |
| left pier — local contrast (3x3) | 12.9 | 13.9 (+8%) | 14.8 (+15%) | **15.1 (+17%)** |
| right pier `988,382 42x140` — luminance | 130.6 | 108.4 (-17%) | 127.3 (-3%) | **137.7 (+5%)** |
| right pier — chroma | 41.0 | 28.7 (-30%) | 38.4 (-7%) | **40.1 (-2%)** |
| right pier — local contrast | 14.1 | 14.2 (+1%) | 14.3 (+2%) | **14.5 (+3%)** |

Both rectangles are fixed pixel rects in the 1600x900 `?capture&q=high&seed=1337`
frame at the shipping rig (12.6 m / 45° / fov 36°), Elysium, `state('play')`,
HUD suppressed. The geometry is identical across the trees, so the same rect
samples the same stone.

**The `control` column is the important one.** It is THIS tree, with one line
changed: `world/biomes.js` dressing the piers with `marble.elysium` again, the
way `812a7f4` did. It measures 2-3% under upstream on luminance and 7-9% under
on chroma — so that much of the gap belongs to everything else that has landed
on this branch (the biome light rig, the atmosphere and grade work, and this
branch's own changes to `marble.elysium`) and no amount of work on the shaft
recipe can recover it.

**Against that control, round 3's shaft is −1% / +8% on luminance and −2% / +5%
on chroma across the two piers.** Summed over both rectangles it is **+1.0% on
luminance against `812a7f4` itself** and **−6.6% on chroma, where the control is
−7.6%** — that is, the shaft now carries more chroma than the pier does when it
is dressed with `marble.elysium` in this tree, and the residual against upstream
is the tree's, not the recipe's. §4a has the causes and the fixes; the crops are
rows 1 and 2 of `docs/texture-preview/_inengine-before-after.png`.

Three smaller things this round also corrects, all of them things the last
review was right about: `world/biomes.js` still described the shaft recipe as
painting "twenty vertical channels" when it paints seven; §4 claimed the
in-engine sheet was gitignored and uncommitted when it is committed on purpose;
and that sheet was a grid of whole frames whose before and after cells were
indistinguishable at the size it shipped.

---

## 1. The three in-engine regressions, and what was done about them

None of these was visible on a flat 2x2 tile preview and all three are
unmistakable in a play-camera screenshot. That is the process failure behind
them, and §4 is the fix for the process.

### `marble.elysium.column` — a barcode, not a shaft

The recipe painted **twenty flutes** around the cylindrical unwrap. Two things
are wrong with that number and only one of them is about screen density.

* **Screen density.** The shaft is ~0.5 m across, the play camera is at 12.6 m
  on a 36° lens, so the lit half of a shaft is ~45 px. Twenty flutes across a
  half-turn is 2-4 px per flute, drawn with a hard arris either side. That is a
  pinstripe, and the mip chain turns it into crawling moiré.
* **It fought the geometry.** `world/kit.js::flutedShaft()` already *carves*
  14 (doric) / 18 (corinthian) flutes into the mesh, deliberately fewer and
  deeper than twenty so each arris catches a real lit edge. A texture drawing
  its own twenty on top of a carved fourteen beats against it at six cycles a
  turn. No amount of contrast tuning removes an interference band.

**Seven flutes.** Seven is half of fourteen, so the painted channel lands on
every second *carved* channel instead of beating with it, and one painted flute
is ~13 px on screen. The arris value step goes 0.22 → **0.085**, the flute's
height contribution 0.42 → **0.18**, and the hue push across the arris
0.30 → **0.12**: the paint's job is no longer to invent the flute (the mesh has
it) but to shade it.

That much survived review. What did not is everything else the split silently
changed — the emissive, the macro level, the ramp-brightness gate, the de-tiler
and the plate's density on a `cylinderY` unwrap. See §0a for the measurement and
§4a for the five causes.

### `stone.asphodel.column` — the ember came back, and the seam closed

Asphodel's floor and its arch both glow along their joints. That molten hairline
*is* the biome's accent, and the shaft shipped without one — a dull near-black
striped slab standing on a floor lit by ember seams, with no relationship to it.
The shared `stone.asphodel` material it replaced at least caught that light.

* An **ember hairline** now runs in the prism joints, gated on melt thickness
  and extinguished under settled ash, with its own emissive map
  (`emissiveIntensity: 0.26`). The joint ink drops 0.72 → 0.62 because the
  ember now supplies part of the joint's contrast, and roughness drops in the
  hot line so it reads as glass over melt.
* **The seam: 1.17 → 0.72**, the worst in the set to unremarkable. The cause was
  not the six-prism layout, it was `wobble: 0.010` — the six joints came out
  measurably different widths, so the p99 of the column-difference distribution
  sat *below* the widest joint, and when the wrap landed on that one the ratio
  blew out. A cooling front does not vary its spacing by 1% of the shaft.
  `wobble: 0.003` makes the six joints statistically interchangeable.
* **`circScale: 4.0 → 1.0`.** The six-prism plate was being wrapped *four times*
  around the shaft: twenty-four prism faces on a 0.5 m column, beating against
  the mesh's fourteen flutes. One turn, six prisms, which is what a columnar
  joint is and what the recipe was drawn for.

### `floor.elysium` / `marble.elysium` — marble, not gravel

Three separate multiplies were each fine on near-black Tartarus stone and each
wrong on cream marble, for the same reason: **a ramp is not linear, so the same
field amplitude is grain at one end of it and dirt at the other.**

1. **The aggregate blob.** `sugarBig` ran at `freq n>>5` — a 25 cm lump in world
   space. Halved to `n>>4` (~12 cm, the size a weathered marble crystal face
   actually is).
2. **Blob amplitude is now gated on ramp brightness.** The crystal facet is a
   *finish*, not a pigment: it keeps full amplitude in the height and roughness
   maps and its albedo share is scaled by `0.30 + 0.70·(1 − v)`, so bright
   marble gets about a third of what dark stone gets.
3. **The run-time detail layer.** `painterly.js` multiplies the lit albedo by a
   two-octave noise at `detailScale` × the tile frequency, and any surface that
   does not name a strength inherits **0.55**. `marble.elysium`,
   `marble.elysium.column` and `marble.elysium.arch` all inherited it; the floor
   asked for 0.45 at `detailScale: 9`, a 0.9 m period. On Tartarus's bottom-fifth
   albedo that is grain; on cream it is a 40-unit dust storm at exactly the
   frequency the frame reads as gravel. Now 0.18 at `detailScale: 5`, with
   `detailBump` and `detailRough` kept at full strength — the layer earns its
   keep as micro-relief, not as pigment. (Round 3 tried cutting `detailBump` and
   `detailRough` on the column as well and measured it: see §4a. It cost local
   contrast and bought no brightness, and it was reverted.)
4. Floor moss cover 0.40 → **0.20** at 0.92 → 0.60 strength, weighted harder
   into the joint/cavity/crazing seed bed. A third of a marble floor gone olive
   under a warm key is the difference between "moss in the joints" and "dirt".
5. Floor macro plate 0.40 of grey-violet `#8d86a4` → **0.26** of `#9a93ab`.

---

## 2. The noise-equivalence test — the bar this round had to clear

The single most useful thing the review did was build a control. It is now in
the repo as a method, and it is the acceptance test for every claim below.

> Bake the reference (`812a7f4`) albedo. Dither it with zero-mean white noise.
> Binary-search the amplitude until its **local contrast matches this branch's**.
> Then ask whether this branch beats that dithered control on the two things
> white noise cannot buy: **mid- and coarse-band energy**.
>
> `noise-ratio = (M + C)ᴴᴱᴬᴰ / (M + C)ᴺᴼᴵˢᴱ`

A ratio of 1.0 means a white-noise dither of the old texture is worth exactly as
much as the work. Anything a player would call "more detail" — a joint, a bed, a
vesicle, a facet — lives in the mid and coarse bands and scores well above it.
Grain, a dry-brush tooth, a cross-hatch and a minified aggregate all live in the
fine band and score at or below it.


Method (`812a7f4` as the reference tree, both bakes at 256², control seeded
deterministically, amplitude found by 24-step bisection on local contrast):

| surface | fitted noise | Ent ref / **head** / noise | M ref / **head** / noise | C ref / **head** / noise | noise-ratio |
|---|---|---|---|---|---|
| `floor.tartarus` | 3.5% | 4.01 / **4.28** / 4.15 | 34 / **50** / 35 | 26 / **41** / 26 | **1.48** |
| `rubble.tartarus` | 2.1% | 2.62 / **3.54** / 2.72 | 6 / **18** / 8 | 9 / **23** / 9 | **2.45** |
| `water.styx` | 3.4% | 2.80 / **3.39** / 3.09 | 7 / **27** / 10 | 10 / **25** / 10 | **2.60** |
| `iron.dark` | 2.0% | 2.69 / **3.12** / 2.80 | 7 / **21** / 8 | 8 / **20** / 8 | **2.55** |
| `stone.tartarus.bay` | 1.8% | 2.78 / **3.11** / 2.86 | 7 / **16** / 8 | 10 / **16** / 11 | **1.73** |
| `floor.elysium` | 3.7% | 4.02 / **4.42** / 4.11 | 16 / **30** / 18 | 20 / **35** / 21 | **1.65** |
| `bronze.verdigris` | 1.0% | 3.45 / **3.90** / 3.47 | 10 / **16** / 10 | 16 / **24** / 16 | **1.54** |
| `blood.pool` | 1.8% | 3.46 / **3.67** / 3.50 | 9 / **15** / 9 | 13 / **19** / 13 | **1.54** |
| `stone.tartarus` | 1.8% | 3.16 / **3.48** / 3.23 | 11 / **18** / 11 | 17 / **22** / 17 | **1.44** |

**`floor.tartarus` is the one that had to change, and it is the reason the rest
of §1 exists.** The version that went to review measured 0.92: at a fitted 6.3%
white-noise dither the control matched its local contrast exactly, matched its
mid and coarse bands, and *beat* it on entropy (4.18 vs 4.09). Everything the
round-1 pass added to the largest surface in the game — a per-flag aggregate, a
dry-brush tooth, a cross-hatch — was in the fine band. Three changes fixed it:

1. **The `cellVariant` scale bug** (§5) — the per-flag aggregate was being
   minified elevenfold, which is why it landed as speckle.
2. **The tooth and the cross-hatch turned down to 0.20** on this recipe. Both
   are global `paintValue` defaults (0.55 / 0.7) and both are pure fine band.
3. **Bedding lamination.** A flagstone is a sedimentary slab split along its
   beds, and the split face shows the beds as broad wandering parallel laminae a
   hand's width apart. Run through `cellVariant` at true scale so each flag's
   laminae take its own angle, they stop at every joint and start again
   somewhere else — which is what a laid bed of split flags looks like, and
   which is content at exactly the scale the play camera resolves.

Result: mid band 34 → **50**, coarse 26 → **41**, local contrast held near the
reference (24 → 29) so the fitted control only needs a 3.5% dither, and the
ratio lands at **1.48**.

---

## 3. Metrics: `812a7f4` (upstream only) → this branch

Every surface baked at 256² through the real `bakeSet()` path, both columns
measured by the *same* script against two checkouts. Column meanings:

| column | meaning |
|---|---|
| `Ent` | Shannon entropy of the 64-bin luminance histogram, bits (max 6) — value spread that two flat tones cannot fake |
| `LC` | mean \|L − blur3(L)\| ×1000 — detail read at close range |
| `F` / `M` / `C` | Laplacian-pyramid band RMS ×1000, fine / mid / coarse. §2's whole argument is that the last two are the ones that count |
| `Rlf` | mean \|xy\| of the normal map ×1000 |
| `Seam` | wrap-column difference ÷ p99 of interior column differences. 1.0 = the wrap is no more discontinuous than the texture's own worst joint |
| `Rep` | largest autocorrelation at a 1/2, 1/3 or 1/4 offset — internal repetition, which `Seam` cannot see |
| noise-ratio | §2. **Bold ≥ 1.3**, the bar this round set itself |

Luminance is √(linear luma), so a near-black underworld surface is not scored
entirely on its handful of bright texels.


| surface | Ent | LC | F | M | C | Rlf | Seam | Rep | noise-ratio |
|---|---|---|---|---|---|---|---|---|---|
| `floor.tartarus` | 4.01 → **4.28** | 24 → **29** | 39 → **44** | 34 → **50** | 26 → **41** | 224 → **242** | 0.66 → **0.66** | 0.19 → **0.10** | **1.48** |
| `stone.tartarus` | 3.16 → **3.48** | 4 → **8** | 8 → **14** | 11 → **18** | 17 → **22** | 162 → **171** | 0.17 → **0.39** | 0.31 → **0.19** | **1.44** |
| `stone.tartarus.bay` | 2.78 → **3.11** | 2 → **7** | 4 → **11** | 7 → **16** | 10 → **16** | 162 → **172** | 0.19 → **0.47** | 0.27 → **0.13** | **1.73** |
| `stone.tartarus.column` | 3.70 → **3.78** | 9 → **9** | 20 → **18** | 27 → **25** | 28 → **30** | 137 → **135** | 0.07 → **0.23** | 0.50 → **0.52** | 1.00 |
| `stone.tartarus.arch` | 3.08 → **3.36** | 4 → **6** | 10 → **12** | 18 → **20** | 29 → **29** | 347 → **348** | 0.14 → **0.15** | 0.87 → **0.73** | 1.04 |
| `rubble.tartarus` | 2.62 → **3.54** | 2 → **8** | 3 → **13** | 6 → **18** | 9 → **23** | 123 → **143** | 0.75 → **0.68** | 0.04 → **0.06** | **2.45** |
| `medallion.tartarus` | 3.98 → **3.97** | 16 → **16** | 31 → **31** | 54 → **54** | 49 → **49** | 239 → **239** | 0.06 → **0.06** | 0.08 → **0.08** | 1.00 |
| `stone.asphodel` | 4.28 → **4.65** | 21 → **27** | 36 → **42** | 40 → **44** | 51 → **53** | 407 → **454** | 0.55 → **0.63** | 0.03 → **0.05** | 1.05 |
| `stone.asphodel.column` *(new)* | – → **3.63** | – → **19** | – → **29** | – → **23** | – → **19** | – → **243** | – → **0.72** | – → **0.47** | – |
| `stone.asphodel.arch` *(new)* | – → **3.42** | – → **14** | – → **28** | – → **25** | – → **22** | – → **362** | – → **0.47** | – → **0.44** | – |
| `floor.asphodel` | 3.49 → **4.28** | 10 → **25** | 24 → **37** | 34 → **43** | 40 → **44** | 239 → **446** | 0.57 → **0.63** | 0.07 → **0.06** | 1.13 |
| `obsidian` | 3.70 → **3.70** | 18 → **18** | 32 → **32** | 17 → **17** | 15 → **15** | 231 → **231** | 0.63 → **0.63** | 0.01 → **0.01** | 1.00 |
| `rubble.asphodel` | 3.89 → **3.89** | 21 → **21** | 37 → **37** | 20 → **21** | 17 → **17** | 227 → **227** | 0.72 → **0.71** | 0.07 → **0.08** | 1.01 |
| `lava` | 5.29 → **5.28** | 54 → **54** | 86 → **86** | 74 → **74** | 96 → **96** | 259 → **259** | 0.87 → **0.87** | 0.08 → **0.08** | 1.00 |
| `marble.elysium` | 4.69 → **4.79** | 14 → **19** | 24 → **30** | 27 → **33** | 33 → **39** | 59 → **133** | 0.49 → **0.57** | 0.13 → **0.12** | 1.18 |
| `marble.elysium.column` *(new)* | – → **4.65** | – → **14** | – → **26** | – → **32** | – → **50** | – → **92** | – → **0.47** | – → **0.29** | – |
| `marble.elysium.arch` *(new)* | – → **4.86** | – → **21** | – → **34** | – → **47** | – → **51** | – → **372** | – → **0.94** | – → **0.47** | – |
| `floor.elysium` | 4.02 → **4.42** | 7 → **19** | 13 → **29** | 16 → **30** | 20 → **35** | 188 → **316** | 0.09 → **0.18** | 0.34 → **0.35** | **1.65** |
| `bone` | 4.44 → **4.44** | 31 → **31** | 63 → **63** | 50 → **50** | 37 → **38** | 274 → **274** | 0.33 → **0.32** | 0.03 → **0.03** | 1.00 |
| `wood.dark` | 4.42 → **4.39** | 19 → **19** | 35 → **34** | 54 → **53** | 63 → **61** | 269 → **259** | 0.03 → **0.46** | 0.34 → **0.37** | 0.98 |
| `iron.dark` | 2.69 → **3.12** | 3 → **8** | 4 → **21** | 7 → **21** | 8 → **20** | 188 → **257** | 0.84 → **0.62** | 0.18 → **0.07** | **2.55** |
| `bronze.verdigris` | 3.45 → **3.90** | 3 → **5** | 4 → **8** | 10 → **16** | 16 → **24** | 107 → **144** | 0.69 → **0.77** | 0.07 → **0.04** | **1.54** |
| `gold.filigree` | 4.60 → **4.59** | 51 → **51** | 97 → **97** | 163 → **163** | 185 → **185** | 420 → **420** | 0.13 → **0.13** | 0.73 → **0.73** | 1.00 |
| `crystal.violet` | 4.23 → **4.22** | 38 → **38** | 76 → **75** | 48 → **48** | 49 → **49** | 185 → **185** | 0.47 → **0.47** | 0.03 → **0.02** | 1.00 |
| `blood.pool` | 3.46 → **3.67** | 3 → **6** | 4 → **10** | 9 → **15** | 13 → **19** | 26 → **75** | 0.66 → **0.68** | 0.22 → **0.16** | **1.54** |
| `water.styx` | 2.80 → **3.39** | 3 → **13** | 4 → **26** | 7 → **27** | 10 → **25** | 36 → **163** | 0.59 → **0.50** | 0.29 → **0.16** | **2.60** |
| `banner.crimson` | 4.19 → **4.20** | 31 → **31** | 53 → **53** | 67 → **68** | 54 → **54** | 335 → **335** | 0.02 → **0.03** | 0.47 → **0.47** | 1.00 |
| **mean, 23 shared** | 3.78 → **4.02** | 17 → **20** | | 35 → **40** | 38 → **43** | 211 → **245** | | | |


### Reading the noise-ratio column honestly

Nine surfaces clear 1.3, nine are byte-for-byte unchanged from upstream and sit
at exactly 1.00 with a fitted noise amplitude of 0.0% (no claim is made about
them), and five are changed but do not clear the bar. Those five are named:

* **`stone.tartarus.column` 1.00 and `stone.tartarus.arch` 1.04** are the honest
  casualties of the `cellVariant` scale fix (§5). Their round-1 gain was largely
  their chisel and fleck fields minified 3-9x into fine speckle: the fine band
  went up, the frame did not get better. With the scale fixed they carry their
  tooling at the size it was drawn at, which is the right call in the engine and
  costs them the metric that was measuring the artefact. `stone.tartarus.column`
  also gains claw *tracks* — a mason works a claw chisel in vertical ribbons a
  hand wide, not as an even spray.
* **`stone.asphodel` 1.05.** Its vesicles were running at `n>>5` and `n>>4` — an
  8-16 px bubble on a 512 plate — both sitting in the same top-of-spectrum band
  the fracture network already occupied, which is exactly why they measured as
  nothing. They now span more than an octave with the biggest at `n>>6`, and
  per-plate tone went 0.24 → 0.30 (+0.37 bits, M 40 → 44, C 51 → 53). That is a
  real improvement and it is still not a 1.3.
* **`floor.asphodel` 1.13.** The ratio is diluted by how much *fine* band this
  surface also gained (LC 10 → 25, which pushes the fitted control to a 5.6%
  dither). Its mid and coarse bands did move (34 → 43, 40 → 44), its relief
  nearly doubled (239 → 446) and the ember hairlines are real content — this is
  the biome's clearest in-engine win and it is untouched this round. The number
  is reported as measured rather than argued away.
* **`marble.elysium` 1.18**, down from 1.24 before this round's fixes. Cutting
  the aggregate blob out of the albedo and the normal scale from 1.25 to 0.85
  costs band energy; it also stops the wall being lit like exposed concrete.
  Where the metric and the frame disagree about a *known* artefact, the frame
  wins — that is the whole reason §4 exists.

---

## 4. The in-engine gate

**Every claim in the previous version of this file was validated on a flat
tile.** Three regressions that a flat tile cannot show were unmistakable in a
play-camera screenshot. So the workflow now ends in the engine, not in the
metric table.

```
npm run build
node tools/serve.mjs dist 4173 &
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/capture.mjs \
  'http://localhost:4173/?capture&q=high&seed=1337' shot.png
```

`window.EREBUS.capture` exposes `biome(name)`, `pose(p)`, `render()` and
`clean()` — the same frame with the HUD suppressed, for measurement — so a
three-biome comparison is a loop over `['tartarus','asphodel','elysium']` at the
shipping rig geometry (distance 12.6 m, pitch 45°, fov 36°).

**Boot the biome from the URL (`&biome=elysium`), do not switch into it.**
`materials/library.js::setBiome()` fires `prebuild()` without awaiting it, and
the biome light rig transitions over sim time that `capture.step()` has to
advance. A frame rendered straight after `capture.biome('elysium')` measured the
pier at **58% of its luminance and 53% of its local contrast**, lit by the
previous biome's rig — a measurement that says nothing about any texture. That
is a trap worth one paragraph.

### 4a. What the pier regression actually was

Five causes, in descending order of how much of the 26%/40% they account for.
All five are consequences of the same thing: a recipe was split out of
`marble.elysium` and silently stopped inheriting what the wall had.

1. **No emissive.** `marble.elysium` carries a warm cream fake-subsurface term.
   The shafts had it for free; the split dropped it, and the shadowed half of
   every pier went neutral grey. Restored, at 0.042 rather than the wall's 0.030
   — a pier is a free-standing object lit mostly by fill. (0.085, the value that
   once broke §14's subject test, is on the statuary's recipe and is untouched.)
2. **`macroStrength: 0.18` against the wall's inherited 0.55.** `painterly.js`
   derives the macro layer's LEVEL — a multiply toward `macroTint`, here
   `ELYSIUM.marbleLight` — from that number, so the shaft was getting a third of
   the warm lift the wall behind it got. Matched to the wall; the drift
   amplitude is capped at 0.24 either way, so it costs no extra blotch.
3. **The ramp-brightness gate was missing.** `0.30 + 0.70·(1 − v)` on the
   aggregate term, the fix that cured "marble reads as gravel" on the wall and
   the floor in round 2, was never applied to the two props. It is now on both
   `marble.elysium.column` and `marble.elysium.arch`.
4. **The de-tiler's blur went with the projection artefact.** Upstream dressed
   these piers through a flat world projection, and `painterly.js` runs its
   three-tap rotated de-tiler on flat world projections ONLY — the `cylinderY`
   branch passes `uStoch = 0` unconditionally, because rotating a cylindrical
   unwrap would shear the flute channels and snap the gold fillets. Averaging
   three rotated taps is a low-pass: it was quietly halving the stroke/tooth
   field as well as hiding the lattice. A correct unwrap removes both.
   `stochastic: true` cannot buy it back here — the shader refuses it on a
   cylinder by design — so the amplitude came out of the brushwork instead:
   `toothAmount` 0.55 → 0.30, cross-hatch off, fine hatch at two thirds count.
5. **Ground, crazing and moss, all at the wrong density.** One turn of the plate
   around a ~3 m barrel puts it on screen denser than the wall's `triScale: 0.20`
   ever does, so the same crack network, the same vein bruise and the same moss
   cover more of a lit face and integrate darker. Base 0.50 → 0.66, halo 0.30 →
   0.16, crazing 0.24 → 0.16 and its violet tint 0.55 → 0.42, moss cover 0.30 →
   0.18, `envMapIntensity` 0.6 → 0.85, `triScale` 0.34 → 0.30.

**One guess was wrong and is recorded rather than deleted.** An intermediate
version halved the height field's `grain` and `sugar` and cut `detailBump` /
`detailRough`, on the theory that normal-map noise at this density was what made
the pier dark. Measured, it moved luminance by under 1% and cost 25-30% of the
local contrast. It was reverted; the note is in the recipe.

### 4b. The sheet

**`docs/texture-preview/_inengine-before-after.png`** is **five 2x crops on
named props**, before beside after, every cell the same fixed pixel rectangle of
the same 1600x900 frame. It was a 3x3 grid of whole frames and it did not
support its own caption: at the size it shipped the before and after cells were
indistinguishable, including the row this file called "the single clearest
difference on the sheet". Whole frames at thumbnail size cannot show a texture.

| row | prop | BEFORE | what to look for |
|---|---|---|---|
| 1 | Elysium pier shaft `marble.elysium.column` | `812a7f4` | the shaft is pale warm marble in both; the round-3 one carries the flute's soft shading and a cooler side face |
| 2 | the same rect | **round 2** (`f69b8b0`) | this is the regression: dark grey-brown bark against warm cream. The starkest pair on the sheet |
| 3 | Elysium floor slab `floor.elysium` | `812a7f4` | before, an even grey-green mottle with no stone identity; after, a warm slab with violet veining and a legible joint |
| 4 | Tartarus flag bed `floor.tartarus` | `812a7f4` | the subtlest pair here, and it is called that rather than oversold: the flags gain per-flag tone and a bedding direction, over an even pink-and-cyan speckle |
| 5 | Asphodel shaft `stone.asphodel.column` | `812a7f4` | before, the pier wears the floor's polygonal ember network; after, vertical columnar prisms with the ember in the joint |

**This file is committed on purpose** — `git add -f` past `.gitignore`'s
`docs/texture-preview/*.png`. The flat-tile sheets really are regenerable from
`tools/texture-preview.mjs` alone and are not committed; this one needs two
builds of two different commits and half an hour of software-rasterised
rendering, so it is in the tree. The previous version of this section claimed it
was "regenerated, not committed", which was simply false. `docs/texture-preview/README.md`
has the regeneration recipe and the crop rectangles.

The `_contact-sheet.png` flat-tile sheet is still generated and still useful,
but it is no longer the last word on anything.

---

## 5. Tiling: two seam bugs (kept) and one scale bug (new)

The two `tileGrid` seam fixes from round 1 were independently verified and are
unchanged. Briefly:

1. **`tileGrid` hashed an out-of-range cell index.** The seam wobble displaces
   the sampling coordinate, so on the last column `ix` came out as `cols` — a
   cell that does not exist, hashing to a different tone, lobe and arris than
   cell 0, which is the same physical cell on the torus. Mortar coverage at the
   wrap: 1.000 → 0.419.
2. **A self-wrapping axis drew a joint across the wrap.** A one-row band or a
   one-column strip has a cell spanning the whole texture, so its cell-local
   coordinate wraps *inside* that cell and every signed term flips sign there.
   Cell-id discontinuity: 0.2724 → 0.0007.

### The new one: `cellVariant`'s `span` was minifying, not varying

`cellVariant(src, n, L, {span})` gives every cell its own rotated, offset patch
of a source field. `span` was documented as "what fraction of the whole texture
one cell reads" — which means the magnification it applies is
`span x cellsPerAxis`, **not** `span`.

On floor.elysium's 4x4 grid, `span: 0.80` is a mild 3.2x zoom-out and the grain
stays roughly in the band it was authored in. On `floor.tartarus`, a flagstone
bed **fifteen stones wide**, the same-looking `span: 0.75` is an **eleven-fold**
zoom-out: every mineral fleck, every chisel score, every bit of bedding is
squeezed to a ninth of its authored size and lands in the finest band of the
spectrum as speckle.

That is exactly what the measurement said had happened, and it explains the
pattern precisely: the surfaces with few, large cells (`stone.tartarus.bay`
1.73, `floor.elysium` 1.74) got real structure out of `cellVariant`, and the
surfaces with many small cells (`floor.tartarus`, the 15-voussoir arches) got
fine-band noise out of it.

`cellVariant` now takes **`zoom`** instead: "one cell reads a window `zoom`
times its own size". `zoom: 1` preserves scale exactly; 1.4-1.6 gives enough
slack that neighbouring cells cannot read the same patch. `tileGrid`, `ashlar`
and `flagBond` return their `cols`/`rows` so the primitive can do the division.
`span` still works and is still correct for the callers that were already using
it at a sane magnification.

### `Rep`: a periodicity metric, because `Seam` is blind to this by construction

`Seam` only ever looks at the wrap column, so a texture built out of two copies
of the same blob scores a *perfect* seam and still reads as a lattice on a
floor. `Rep` is the largest normalised autocorrelation of the value field at a
1/2, 1/3 or 1/4 texture offset, on both axes and the diagonal.

One finding to record honestly: **the review's specific claim that
`bronze.verdigris` and `iron.dark` "show an obvious 2x2 repeat" is not supported
by this measurement.** They score **0.04** and **0.07** — as close to zero as
anything in the set. What is periodic, and always was, is the drawn ornament:
`stone.tartarus.arch` (a 30-bead row over 15 voussoirs) at **0.73**,
`gold.filigree` at 0.73, `banner.crimson` at 0.47. Those are periodic on
purpose. The pre-branch `stone.tartarus.arch` measured **0.87**; this branch's
`cellVariant` work brought it to 0.73, which is the improvement, and the ceiling
is set at 0.80 so the pre-branch value fails and the current one passes.

---

## 6. Cost, re-measured

Method (`min` of 5 runs, whole `bakeSet()` through the real path, at the
resolutions `library.js::_size()` picks at tier `high`, over exactly the set
`BIOMES` names):

```
recipes bake cost, tier high, min of 5
  37 recipes shared with 812a7f4     4051 ms -> 4996 ms            = 1.23x
  4 recipes this branch adds                                          579 ms
  whole named set                    4051 ms -> 5576 ms            = 1.38x
```

The previous version of this file claimed 1.17x from a hand-picked 17-recipe
subset baked at 256², and shipped a per-recipe table that does not reproduce in
either direction (it claimed `floor.tartarus` at 1.84x — measured 1.20x — and
`medallion.tartarus` at 0.62x — measured 1.09x on a surface whose output is
byte-identical against upstream). **That table is deleted rather than corrected**: run-to-run
noise on one recipe on this machine is around ±5% even at min-of-5, so only the
totals and the largest individual moves are worth reporting.

Where the money goes, and what was bought back:

* **`aggregate` resolution is now set by the GRAIN, not the texture.** It walks a
  3x3 Worley neighbourhood per texel and was running at full resolution on every
  448-1024 surface. Fourteen texels across one grain resolves a ragged crystal
  boundary with room to spare, so `res = max(256, freq x 14)`. On a 448 wall
  whose flecks are `freq 18` that is 252 instead of 448 — a third of the work.
  The 256 floor is not slack: below it the saving is one millisecond and the
  cost is real (dropping `iron.dark`'s flake field to 224 measured −0.05 bits
  and a third of its fine band, for 2 ms).
* **`lichen` runs at n/4 rather than n/2.** A colony 40 px across has nothing to
  say at 1 px, let alone at 0.5 px. Measured at 768: 68 ms → 17 ms per call.
* Not the cross-hatch. It was the obvious suspect and it is **0.6 ms** at 448 —
  the second `strokes` pass reuses the first flow field, which is most of why.
  The +20% on the four `stone.tartarus` variants is `aggregate` + two
  `cellVariant` passes + `lichen`, and it buys the mineral band those walls were
  measured as lacking.

The honest summary: this is a real cost, it is smaller than it was, and it is
spent on content that clears §2's bar rather than on grain that does not.

---

## 7. Texture memory — the resident set, not the biggest biome

The previous version of this file said "only one biome is resident at a time"
and "the peak is unchanged". Both are false and neither is a subtle call:

* `src/core/preload.js::preloadSurfaces()` bakes **every** recipe in `RECIPES`
  at launch, deliberately, so nothing takes a synchronous bake during play. All
  50 sets are resident from the loading screen onward.
* `MaterialLibrary.dispose()` has **no call site anywhere in `src/`**. Nothing
  is ever freed; switching biome only ever adds.

`npm run test:textures` now sums over `Object.keys(RECIPES)`:

| tier | resident, all 50 recipes | ceiling | worst single biome (context only) |
|---|---|---|---|
| low | **23.4 MiB** | 27 | tartarus 14.1 |
| med | **47.5 MiB** | 55 | tartarus 26.5 |
| high | **100.8 MiB** | 116 | tartarus 53.0 |
| ultra | **155.7 MiB** | 179 | tartarus 84.6 |

Model: albedo + normal + ORM + emissive, RGBA8, at `library.js::_size()`'s tier
resolution, with a full mip chain (×4/3). Emissive is counted for every surface
rather than only the ones that have it, because a budget is a worst case and
because that is what the next surface to gain a glow will cost. The ceilings sit
~15% over the measured figure: room for a handful of surfaces, and *not* room
for a resolution-policy change. If a change pushes past one, the answer is to
justify the memory or to stop preloading everything — not to raise the number.

The four materials this branch adds cost **8.6 MiB** of that at `high`
(4 x 320² x 4 maps x 4/3), which is the honest price of Asphodel and Elysium
having their own shafts and voussoirs instead of one wall texture in five roles.

---

## 8. The quality floors are now binding

`node scripts/test-textures-quality.mjs` exits non-zero on four assertions. They
are set just under the measured worst of the current set, and the worst is named
next to each so the next person can see the margin:

| floor | now | headroom | worst surface now | pre-branch worst | pre-branch verdict |
|---|---|---|---|---|---|
| `Ent >= 3.00` | 3.113 | 3.8% | `stone.tartarus.bay` | 2.62 `rubble.tartarus` | **FAILS** |
| `Seam <= 1.00` | 0.939 | 6.1% | `marble.elysium.arch` | 0.87 `lava` | passes |
| `Rlf >= 0.060` | 0.0754 | 25.6% | `blood.pool` | 0.026 `blood.pool` | **FAILS** |
| `Rep <= 0.80` | 0.729 | 8.8% | `stone.tartarus.arch` | 0.87 same surface | **FAILS** |

**Which surface each gate is pinned to, stated plainly.** A floor set just under
the measured worst has, by construction, very little margin, and two of these
have less than the table suggests:

* **`Rep` is pinned to a PAIR** — `stone.tartarus.arch` 0.7294 and
  `gold.filigree` 0.7272, two thousandths apart. Both are legitimately periodic
  objects (a fifteen-voussoir arch; a drawn filigree grille), so their score is
  the ornament they are supposed to have. There is no version of either that
  scores much lower and is still that object. If a future change pushes one past
  0.80, the thing to look at is the ornament pitch, not this number.
* **`Seam` is pinned to `marble.elysium.arch`**, and it came into this round at
  **0.97** — a 3% margin on a gate this branch set itself. It is at 0.939 now
  because the aggregate term in that recipe gained the same ramp-brightness gate
  `marble.elysium` and `floor.elysium` already had (§1), which took energy out
  of the plate's brightest columns — which is where its wrap error lived. That
  is margin bought by work on the surface. **It is still the tightest of the four
  and it is still one surface deep**; neither threshold was moved to create it.

The old assertions were `Ent < 2.4` against a historical worst of 2.40097,
`Rlf < 0.004` against a worst of 0.0255, and `Seam > 1.35` against a worst of
1.17. All three passed on the pre-branch code as well as the new code. A floor
that cannot fail is worse than no floor, because it reads as a guarantee.

`Seam <= 1.00` does not fail on the pre-branch code, and that is stated rather
than hidden: what it *does* fail on is the version of **this branch** that went
to the last review, where `stone.asphodel.column` measured 1.17.

No surface is exempted from `Rep`. Drawn ornament is periodic on purpose and
lands at 0.47-0.73; the ceiling sits above that deliberately, because the
failure it exists to catch — a whole texture built out of two copies of one
blob — scores far higher than any bead row does.


---

## 9. What each surface actually does differently

Unchanged from round 1 except where §1 and §5 revise it. Kept short here; the
reasoning lives in the comments beside the code.

### The shared painting pass (`paintValue`)

* **Dry-brush tooth** — glazes are multiplied by a high-frequency tooth field so
  a glaze *skips* over the raised grain instead of covering evenly. Recipes that
  already synthesise a grain octave hand it in, so on most surfaces it is free.
* **Cross-hatch** — a second, shorter, finer stroke pass crossing the first at a
  fixed angle, reusing the first flow field (0.6 ms at 448).
* **Both default to 0.55 / 0.7 and both are turned down to 0.20 on
  `floor.tartarus`.** They are pure fine-band energy; on a wall read from two
  metres that is brushwork, and on the largest surface in the game seen at a
  45° grazing angle it is the grain a white-noise control reproduces for free.
* **An ink line, and a negative result about it.** A Sobel pass over the
  structural value finds where an illustrator would weight a line. The first
  version subtracted value there and measured worse on every metric it was
  meant to improve — on a ramp that bottoms out near black a subtractive outline
  clips, and clipping destroys the local contrast and histogram spread the line
  existed to create. It is now overwhelmingly a push into the cool/ink ramp and
  defaults to **off**; only bright-ground carved surfaces opt in.

### New shared primitives (`texgen-core.js`)

| primitive | what it is for |
|---|---|
| `cellVariant(src, n, L, {zoom})` | every cell of a layout gets its own **rotated, offset** patch of a source field, at its authored scale (§5). Attacks the half of tiling the run-time de-tiler cannot: grain that runs continuously across joints |
| `lichen(n, o)` | colony growth — Worley colonies, a domain-warped ragged front, per-colony vigour, a spore-bias field. Moss, nitre, ash, verdigris and forge scale are all this one function, at n/4 |
| `aggregate(n, o)` | hard-edged mineral grain with ragged boundaries in one fused Worley pass, at `max(256, freq x 14)` |
| `gradMag(f, n)` | wrapped Sobel magnitude — the ink-line source |

`ashlar()` and `tileGrid()` were rewritten to the flagstone bond's standard:
unequal courses, per-block rotation and rise, split and replacement blocks, a
mortar-gap-only `joint` field, and a **signed** `arris` (a highlight on the
chamfer facing the key, a dark channel on the one facing away). All three
layouts now also report their `cols`/`rows` so `cellVariant` can scale properly.

### Tartarus — quarried, laid, and bled on

* `stone.tartarus` / `.bay`: irregular bond; per-block claw-chisel direction;
  mineral flecks; a real lime mortar in the gap; **nitre bloom** creeping out of
  the joints — the wall's only light accent and a third colour family.
* `floor.tartarus`: per-flag rotated grain at its authored scale, nitre in the
  bedding joints, and **bedding lamination** — a flagstone is a sedimentary slab
  split along its beds and the split face shows the beds as broad wandering
  parallel laminae, each flag at its own angle. That is the mid- and coarse-band
  content this surface was measured as lacking, and it is what a floor looks
  like at walking distance.
* `stone.tartarus.column`: claw tooling painted with the brush engine, now
  arriving in vertical **tracks** and re-phased per drum; a lime bed joint.
* `stone.tartarus.arch`: per-voussoir tooling and bedding at true scale; lime
  joint under ink; opts into the ink line (bright gold ground, carved relief).
* `rubble.tartarus`: conglomerate aggregate at two scales, a full value step
  between facets, bone-pale fresh fracture on the arrises. 2.62 → 3.53 bits and
  the highest noise-ratio in the set.

### Asphodel — poured and cooled

* `stone.asphodel`: **vesicles** over more than an octave, **ash** in the
  hollows, per-plate chill selecting between an opaque `basalt` ramp and the
  glassy `obsidian.sheen`, and the mandated teal caught only on chilled arrises.
* `floor.asphodel`: big cast slabs on an irregular bond, a chilled skin that
  turns at every joint, ash in the joints, **ember hairlines glowing in the
  bed**. The clearest in-engine win of round 1 and untouched.
* `stone.asphodel.column`: columnar jointing — six vertical prism faces (one
  turn of the shaft, not four), cooling-front striae re-phased per prism,
  clustered vesicles, ash, and the ember hairline restored (§1).
* `stone.asphodel.arch`: cast voussoirs separated by ember hairlines rather than
  mortar, with a bronze bead instead of gold leaf.

### Elysium — quarried, sawn, and grown on

* `marble.elysium`: crystalline sugaring and crazing in the height and roughness
  maps, moss as *colonies* seeded in the crevices, and a normal scale sized so
  the facets read as polished stone rather than as exposed aggregate (§1).
* `floor.elysium`: every tile is a different piece of stone — vein and cloud
  fields re-read per tile at a rotated offset. Veining now carries **value**, not
  only hue, so it survives the biome's floor glaze (§1).
* `marble.elysium.column`: **seven** flutes, shading the fourteen the mesh
  carves rather than fighting them (§1); moss in the hollows, never on the
  arris; a worn gold fillet. Dressed to the same ground, macro level, emissive
  whisper and aggregate gate as the wall it is cut from, because when it was
  not, the pier measured 26% darker and 40% greyer than the wall in frame
  (§0a, §4a).
* `marble.elysium.arch`: per-wedge marble, a laurel band and bead rows —
  Elysium's ornament family, distinct from Tartarus's meander. Its aggregate
  term carries the same ramp-brightness gate as the wall and the floor; that is
  also what took its wrap-seam score from 0.97 to 0.939 (§8).

### Metals and liquids

`iron.dark` gained a flaking forge-scale skin and per-facet planishing tone.
`bronze.verdigris` grows its patina as a crusty corrosion product standing proud
of the metal rather than as an airbrushed green cloud. `water.styx` gained
capillary chop; `blood.pool` gained a wrinkling skin. All four clear §2's bar
comfortably (1.54-2.60).

---

## 10. Previews

`node tools/texture-preview.mjs` writes one sheet per surface to
`docs/texture-preview/`, plus `_contact-sheet.png`:

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
roughness map and an occlusion map by looking at them as greyscale images.

**It is not sufficient on its own.** See §4: it does not show screen-space
density, it does not show the run-time detail and macro layers, it does not
show the biome's lighting rig or grade, and all three of round 1's regressions
were invisible in it.
