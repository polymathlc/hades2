# EREBUS — Art Direction Bible
### Target: match or exceed Supergiant's *Hades* (2020) and *Hades II* (2024) visual quality, in Three.js.

This document is BINDING. Every visual decision must be traceable to a rule here.
If a rule conflicts with "realism", the rule wins. We are not making a realistic game.
We are making a **painterly, illustrated, high-contrast mythic game**.

---

## 0. The One-Sentence Look
> A hand-painted Greek-underworld illustration that happens to be rendered in real time:
> saturated jewel-tone lighting, ink-dark shadow shapes, molten gold ornament,
> and characters that read instantly as bright silhouettes against a darker world.

---

## 1. Why Hades looks the way it does (the mechanisms we must reproduce)

Supergiant's look is NOT "good PBR". It is a set of deliberate illustration tricks.
Reproduce the *mechanism*, not just the vibe:

1. **Value separation by depth.** Foreground characters/props are HIGH value + HIGH chroma.
   Mid-ground architecture is mid-value. Background is LOW value, LOW chroma, and hazed.
   There must be at least 3 clearly separated value bands in every frame.
   Test: desaturate the frame to greyscale — the player must still pop instantly.

2. **Rim light is non-negotiable.** Every character, enemy, and hero prop carries a
   colored rim/back light that does not exist as a real light in the scene. It is an
   art-directed constant. Rim colour is the *complement* of the local key light.
   Tartarus: key = warm crimson/amber, rim = cyan/violet.
   Asphodel: key = orange lava, rim = teal.
   Elysium: key = gold/green, rim = magenta/rose.

3. **Ink shadows, not grey shadows.** Shadow is not "less light" — it is a *different colour*.
   Shadows shift toward deep indigo/violet/black-plum, never neutral grey, never brown-black.
   Shadow terminator is TIGHT and slightly hardened (a painted edge), not a soft PBR falloff.

4. **Painted texture, not photo texture.** No photoreal grunge, no tiling noise-slop.
   Textures must read as brushwork: directional strokes, colour variation *within* a material,
   deliberate darkened crevices, hand-placed highlights. Roughness should vary as an
   *artistic* map, not as a physical one.

5. **Ornament everywhere, but hierarchical.** Greek key (meander), acanthus, laurel,
   palmette, egg-and-dart, guilloche. Gold filigree edges catch light. But ornament
   is concentrated on focal architecture — never uniformly spammed.

6. **Bold, flat, additive VFX.** Effects read as *shapes* (crescents, rings, spikes, arcs)
   with a bright core, a saturated mid, and a soft outer glow. Never wispy grey smoke-sim.
   VFX shapes are large, confident, and short-lived.

7. **Bloom is a paint layer.** Wide, soft, coloured bloom on emissives only, with a high
   threshold so the whole frame doesn't fog. Bloom must never wash out the ink shadows.

8. **The frame is composed.** Vignette pulls the eye in. The arena is an island of light
   in a dark void. Negative space is used, not filled.

---

## 2. Palette (authoritative hex values)

### Global ink / shadow ramp (never use pure grey)
| Role | Hex |
|---|---|
| Void black | `#07060f` |
| Deep shadow | `#120b1e` |
| Shadow plum | `#241238` |
| Mid shadow violet | `#3a1d52` |

### Gold / bronze (the ornament spine of the whole game)
| Role | Hex |
|---|---|
| Gold highlight | `#ffe9a8` |
| Gold core | `#f2c14e` |
| Gold mid | `#c98f2b` |
| Bronze shadow | `#6d4416` |
| Verdigris | `#3f8f7a` |

### Tartarus (biome 1 — crimson stone, bone, blood)
| Role | Hex |
|---|---|
| Key light | `#ff5a3c` |
| Stone light | `#8c3b46` |
| Stone mid | `#5a2331` |
| Stone dark | `#2c1020` |
| Rim / accent | `#5fd0ff` |
| Blood / ichor | `#c81d3c` |

### Asphodel (biome 2 — obsidian isles on a lava sea)
| Role | Hex |
|---|---|
| Lava core | `#fff0b0` |
| Lava hot | `#ff8c1a` |
| Lava deep | `#c22a06` |
| Obsidian light | `#2a2740` |
| Obsidian dark | `#0d0b18` |
| Rim / accent | `#33e0c0` |

### Elysium (biome 3 — marble, laurel, gold, verdant)
| Role | Hex |
|---|---|
| Key light | `#ffe6a3` |
| Marble light | `#efe3cf` |
| Marble shadow | `#8a7f9c` |
| Verdant | `#3fa86a` |
| Deep green | `#14402f` |
| Rim / accent | `#ff5fa8` |

### God / boon identity colours (Hades II leans nocturnal — keep both registers)
| God | Hex | Feel |
|---|---|---|
| Zeus | `#ffe14d` | crackling gold-white |
| Poseidon | `#3fb8ff` | foaming cyan |
| Athena | `#c9b8ff` | pale lilac-silver |
| Aphrodite | `#ff6fae` | rose |
| Ares | `#e01f2d` | arterial red |
| Artemis | `#7ee06a` | green |
| Dionysus | `#a05fe0` | purple |
| Hermes | `#ff9a3c` | amber-orange |
| Hecate (H2) | `#8ef0d0` | witch-teal |
| Selene (H2) | `#dfe9ff` | moon silver |

**Rule:** a single frame uses at most 2 dominant hues + gold + the ink ramp.
Third hue only as a small accent (< 5% of pixels).

---

## 3. Lighting doctrine

- **Key**: one dominant directional/area source per chamber, warm or cold per biome, strong.
- **Fill**: hemisphere fill tinted with the biome's shadow colour, LOW intensity (never lifts blacks above ~0.06 luminance).
- **Rim**: art-directed constant, applied in the character shader, complement hue, driven by a fixed world direction not a real light.
- **Practicals**: braziers, lava cracks, sconces, glyphs — emissive + a real point light with tight range, flickering with a smoothed noise (not sine).
- **Bounce**: fake it — a large, very dim area light from the floor tinted with the floor's albedo.
- **Contrast target**: histogram must have real content in the bottom 15% AND top 5%. No milky mid-grey frames.

---

## 4. Character rendering doctrine

Characters must NOT be lit like environment. They get a dedicated shader:
- Reduced shading bands near the terminator (a soft 2–3 step ramp, not full toon, not full PBR) — "painted" shading.
- Constant colored rim (see §1.2), fresnel-driven, additive.
- A subtle **ambient occlusion by hand**: darkened crevices baked into vertex colour or a gradient map.
- Slight **outline**: NOT a uniform black line. A dark, *colour-shifted* inner contour from a
  fresnel term in the shadow ramp colour. Thin, and it must vanish on lit edges.
- Specular is a small, bright, sharp glint — jewelry and metal only.

---

## 5. VFX doctrine

- Silhouette first: an effect must read at 1/8 resolution.
- 3-layer construction: **core** (near-white, tiny), **body** (saturated god colour), **glow** (wide, low alpha, additive).
- Motion: fast in (2–4 frames), hold, slow out. Ease-out scale, never linear.
- Slashes are **crescents** with a swept ribbon, not particle sprays.
- Impacts: a flash quad + a ring shockwave + radial sparks + a decal. Always all four.
- Death: a bright flash, a directional burst of shade-wisps, then dissolve upward. Never ragdoll-flop alone.
- Screen: hitstop 40–90ms on heavy hits, chromatic pulse, radial blur kick, shake with decaying noise.

---

## 6. UI doctrine

- Type: high-contrast serif for display (Cinzel-like), clean humanist sans for body.
- Panels: dark stone/obsidian with a **gold filigree frame** — corner palmettes, a meander band, and a beaded inner rule.
- Boon cards: portrait-ish god emblem, god colour halo, rarity ring (Common bronze → Rare silver → Epic gold → Heroic prismatic).
- Everything has a soft inner shadow and a warm outer glow. Nothing is flat-#333-rectangle.
- Motion: cards ease in with a slight overshoot + a light sweep across the gold.
- Numbers on hit: bold serif, warm white, scale-punch then float and fade; crits are larger, gold, with a shadow.

---

## 7. Hard bans (auto-fail in critique)
- Neutral grey shadows or a milky low-contrast frame.
- Default Three.js `MeshStandardMaterial` grey/white untextured surfaces in a shipped shot.
- Uniform flat-lit geometry with no rim and no value separation.
- Visible tiling repetition on floors.
- Perfectly sharp, aliased edges (must have AA) or unresolved shimmer.
- Bloom fog across the entire frame.
- Untextured "programmer art" boxes/cylinders left visible.
- Particles that are obvious round white dots.
- UI that looks like an HTML form.

---

## 8. Camera (genre-defining)
- Perspective camera, FOV ~34–40° (long lens compresses depth like Hades).
- Pitch ~52° down, yaw fixed at 45° world-aligned (true 3/4 iso feel with perspective depth).
- Follows player with critically-damped spring; leads slightly toward aim.
- Pulls back on combat intensity; pushes in on dialogue/reward moments.
- Never rotates during combat. Stability is part of the readability.

---

## 9. THE VALUE LAW (added after review round 1 — this overrides taste)

Review found the single most damaging error a Hades-like frame can make: **the ground plane was the
brightest large surface in the frame.** Hades never does this. The floor is a DARK STAGE; the
character, the ornament and the effects are the LIT SUBJECTS on it.

These are measurable, non-negotiable:

1. **The floor is the darkest large surface.** Median luma of the ground plane must be
   **below 0.18** (display luma, 0–1) and must be **below the frame median**.
   `node tools/analyze.mjs` reports `groundLuma` and `groundVsFrame` — `groundVsFrame` must be < 1.0.
2. **The character out-values the floor by 2.5× or more.** The hero is the brightest large-ish
   shape in the play area. If you cannot find the character instantly in a squinted thumbnail,
   the frame has failed.
3. **The frame must reach bright.** `bands.highlight` must be **≥ 0.04**. A frame with no highlight
   band is a flat frame no matter how pretty the hue. Highlights come from: emissives (flame, lava,
   glyphs), gold specular hits, rim light, and VFX — *never* from a broadly lit floor.
4. **Three separated value bands, measurably.** Median display luma of foreground, mid-ground and
   background must span **≥ 0.18** total. Everything sitting inside a 0.02 luma spread is the
   failure mode review called "a lighting test", and it is an automatic P0.
5. **Ornament carries the light.** Gold filigree, capitals, brazier rims and trim are where the
   highlights live. Light the *edges* of architecture, not its faces.
6. **Two hues, not one.** A frame that is entirely one hue family (e.g. everything salmon/orange
   with purple shadows) is monochrome mud. The biome key hue must be opposed by its rim/accent hue
   from §2, and the accent must be genuinely visible — at least 8% of pixels.
7. **Cast shadows must read as shadows, not stains.** Tight, directional, with a defined edge.
   Huge soft purple blobs across the floor are a failure.


---

## 10. Metrics are a floor, never a target (Goodhart's warning)

During the value-law pass an agent optimised `tools/analyze.mjs` to a full pass on all ten shots
while the frame visibly got **worse** — a bright salmon floor with a dark vignetted centre satisfied
a ground-plane metric that sampled only the centre. The numbers said pass; the eye said regression.

Rules that follow from this:

1. **A passing metric never ends an iteration.** It only means you have not failed grossly. You stop
   when the frame *looks* right, judged by opening the PNG and looking at it.
2. **A failing metric always ends an iteration.** Failures are real; passes are weak evidence.
3. **Never tune a value specifically to move a metric.** Tune it because the frame looks better, then
   check the metric did not regress.
4. If you find yourself reasoning about how to satisfy a measurement, stop and look at the image
   instead. If the measurement and your eye disagree, **your eye wins and the metric is the bug** —
   report it so the tooling gets fixed.


---

## 11. Aerial perspective is inverted (found by the true-depth metric)

Measuring luma by real scene depth rather than screen position revealed the frame's remaining
structural error:

| Band | Measured | Required |
|---|---|---|
| near — the play area | 0.038 | mid-dark, the stage |
| mid — focal architecture | 0.081 | **the brightest band** |
| far — background | **0.142** | **the darkest, least saturated band** |

The background is roughly four times brighter than the foreground. That is inverted: it pulls the
eye out of the play space and flattens the image, because the strongest value contrast sits at the
edge of the frame instead of on the subject.

Worse, the previous screen-thirds metric actively rewarded making this worse — brightening the void
raised its score. Any work that raised `voidSky` or lifted the haze to satisfy it should be undone.

**Required correction:**
1. **Crush the far band.** The void/backdrop and everything beyond the arena drops to a low value
   and low chroma. Distance haze desaturates toward the ink ramp — it must never *lift* value.
2. **Light the mid-ground.** The focal architecture — the back wall, the bays, the statuary behind
   the play space — is the brightest band in the frame. Light it from its own practicals and let
   the ornament's chamfers catch it.
3. **Keep the near band dark.** The play floor stays the dark stage (§9), with the character reading
   against it.
4. The ordering `far < near < mid` with a total spread >= 0.18 is now checked automatically by
   `tools/analyze.mjs` whenever a `.depth.png` companion exists.


---

## 12. Correction to §11, and what is actually left

§11 was written from the tercile-bucketed metric, which split depth samples by pixel count. In a
close pose that puts all three cuts inside the floor, so its "far" band was the focal architecture,
not the void. **§11's claim that the background was four times brighter than the foreground was an
artifact of that bucketing** and cannot be verified retroactively — the frames it described have no
depth companions. Treat §11's *direction* as correct (background dark, mid-ground lit) and its
*numbers* as void.

Measured properly, by world radius from the arena centre:

| Shot | near (play) | mid (architecture) | far (void) | ordering |
|---|---|---|---|---|
| arena_wide | 0.075 | **0.151** | 0.024 | correct |
| gameplay | 0.055 | **0.176** | 0.075 | correct |
| architecture | 0.077 | **0.206** | 0.173 | correct |

**The ordering law now passes.** The mid-ground carries the light and the void is darkest. What is
still short is the SPREAD: 0.12–0.13 against a 0.18 floor. Closing it means pushing the lit
mid-ground band harder — the ornament, statuary and focal bays, not the floor — rather than
touching the near or far bands, which are already where they belong.

### A framing problem the metric exposed

`pixelShare` on the gameplay pose is `[0.82, 0.17, 0.01]`: 82% of the frame is play-area floor and
**1% is void**. The pose shows an unbroken wall of architecture edge to edge, so §1.8's "island of
light in a dark void" cannot be judged from it at all — and no amount of lighting work will make
that frame read the way a Hades combat frame reads. The gameplay pose in `tools/shotlist.json`
needs real void in frame: pull back, raise the camera, or frame across a rim so the abyss is
visible behind the play space.
