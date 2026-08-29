// OWNER: AGENT-RENDER — named colour-grade presets, one per biome.
// Values are authored against docs/ART_DIRECTION.md §2 (palette) and §3 (lighting doctrine).
// Every field here is live-tunable through ctx.post.setGrade({...}).

// helper: hex string -> linear-ish float triple used directly as a shader uniform colour
const H = (hex) => hex;

/**
 * A grade preset. Shader semantics:
 *   exposure      : scene-linear multiplier applied *before* AgX
 *   agxSlope/Power: per-channel filmic look controls inside the AgX log domain
 *   agxSat        : chroma of the filmic look
 *   contrast      : S-curve strength around `pivot`, applied display-referred
 *   lift/gamma/gain: classic 3-way colour corrector (per channel, RGB)
 *   curveR/G/B    : per-channel gamma curves (1.0 = untouched)
 *   shadowTint/midTint/highTint : multiplicative tints weighted by luminance masks
 *   satShadow/satMid/satHigh    : saturation-by-luminance (desaturate darks, keep mids hot)
 *   hueLobes      : up to 3 hue-vs-hue rotations [centerHue0..1, width, shiftAmount]
 *   vignette      : {amount, radius, softness, color}
 *   grain         : {amount, size, darkBoost}  darkBoost = extra grain in the shadows
 *   chroma        : radial chromatic aberration strength (in pixels at frame edge)
 *   bloom         : {threshold, knee, intensity, tint, radius}
 *   ao            : {intensity, radius, ink}   ink = the colour occlusion is tinted toward
 *   godrays       : {intensity, color, decay, density, weight}
 *   fog           : atmosphere tint/density (consumed by atmosphere.js + the fog pass)
 */
export const GRADES = {
  // ── TARTARUS ─────────────────────────────────────────────────────────────
  // crimson stone, bone, blood. Warm amber key, cyan rim, plum ink.
  tartarus: {
    name: 'tartarus',
    // GENERATED-TEXTURE INTEGRATION. The authored atlases already contain
    // coloured brushwork. The former grade re-saturated that colour three
    // times (AgX, luminance bands, then full-strength violet/gold re-hues),
    // producing the fluorescent orange/purple posterisation seen on Pages.
    // Keep this transform deliberately restrained: material maps carry colour;
    // the grade only shapes value and gives the very darkest ink a cool bias.
    // §3 "histogram must have real content in the bottom 15% AND top 5%".
    // The old stack had a hard CEILING: white 0.78 clamped the display white
    // point, shoulder 0.18 compressed everything under it, and pivot 0.30 sat
    // three stops above the frame's median luma so the contrast S-curve could
    // only ever push pixels DOWN. Nothing in the frame reached white and the
    // gold topped out as a saturated orange instead of rolling through #ffe9a8.
    // EXPOSURE IS NOT A LIGHT RIG. 2.90 against 0.86 (asphodel) and 0.82
    // (elysium) was a 3.4x brute-force compensation for an underlit rig, and it
    // made every downstream value non-portable: the bloom threshold is
    // scene-referred, so it silently moved 3.4 stops; the key had to be
    // bleached to #ffb894 to stop it clipping; agxSat/satMid had to be pulled
    // under 1.0 to fight the resulting glare. The rig in render/lighting.js is
    // now authored 2.42x hotter (RIGS.tartarus) and the grade sits in family
    // with the other two biomes. Anything scene-referred that is NOT a light —
    // emissive intensities, the flame/portal quads, the atmosphere layers —
    // carries the same 2.42x.
    // +4% to hold the frame's overall level after the key came down from 26 to
    // 15.5 (render/lighting.js). Deliberately a SMALL lift: the rest of the
    // hero's lost light is given back locally by the subject key, because a
    // global exposure lift would hand the same stops to the ground plane, which
    // is exactly what §9.1 forbids. NOTE for whoever tunes this next — the
    // number in postfx.js `uExposure: { value: 1.06 }` is only an initialiser;
    // _syncUniforms overwrites it from THIS field every frame, so this is the
    // real exposure knob for Tartarus.
    exposure: 1.36,
    agxSlope: [1.01, 1.0, 0.99],
    agxPower: [1.03, 1.03, 1.05],
    // §2 asks for crimson stone and molten gold; the close-ups measured
    // meanSat 0.486-0.497 at mean luma 0.42-0.47, which is the arithmetic
    // definition of pastel. Chroma goes back up now the exposure is off it.
    agxSat: 0.92,
    // pivot 0.22 sat below the frame's median, so the S-curve could only ever
    // push pixels down and there was nothing on its lower arm to bite on.
    contrast: 0.68,
    // PIVOT FOLLOWS THE FRAME. The S-curve is a power law about this point, so
    // a pivot ABOVE the frame's tonal centre can only push pixels down — and
    // once §9.1 put the ground plane where it belongs, 0.34 sat two stops over
    // everything except the ornament and collapsed the whole image. 0.29 keeps
    // the architecture on the curve's upper arm and the floor on its lower one,
    // which is exactly the separation the value law is asking for.
    pivot: 0.28,
    // `black` SUBTRACTS a black point — raising it crushes, it does not protect
    // the darks. What keeps the bottom of the frame off dead #000 is the
    // positive violet `lift` below, which has to survive this subtraction.
    // hiRoll raised: 0.78 was compressing the top 22% of the display range so
    // hard that gold ornament and brazier cores shared one value with lit
    // stone. §9.3 wants real content in the top band; the roll still preserves
    // hue, it just starts later.
    black: 0.001, white: 0.96, shoulder: 0.16, hiRoll: 0.94,
    // §2: the ink ramp bottoms at #07060f — a VIOLET black, not a neutral zero.
    // A negative blue lift clipped the column bases to dead #000.
    lift:  [ 0.022,  0.020,  0.028 ],
    gamma: [ 1.00,  1.00,  1.01 ],
    // The warm gain was rotating every gold surface toward orange before the
    // hue lobes ever saw it. Keep the grade close to neutral and let the
    // PALETTE carry the warmth.
    // RED CLIPS FIRST under a saturated crimson key, and a clipped channel is a
    // hue that has stopped being a hue. The grade holds red DOWN a touch and
    // lets the palette carry the warmth (measured clipped-channel coverage has
    // to stay under 1.5% of every shipped frame).
    gain:  [ 1.00,  1.00,  1.00 ],
    curveR: 1.00, curveG: 1.00, curveB: 1.02,
    // §2 Shadow plum #241238 wants B/R ~1.56. The old #42287e measured 1.08 on
    // screen — magenta, not indigo — so the ink ramp was not being honoured.
    shadowTint: H('#302746'),   // muted plum ink, not electric violet
    midTint:    H('#f0ddd2'),   // warm-neutral: preserve material identity
    highTint:   H('#ffe8c5'),   // restrained warm-gold highlight rolloff
    // 0.86 was desaturating the ONE cool element in the frame (the mandated
    // #5fd0ff rim lives in the shadow band by construction — see painterly.js
    // shBoost). Hold chroma in the darks; the ink is a HUE, not a grey.
    satShadow: 0.82,
    // measured meanSaturation was 0.68 against a §7 target of 0.28-0.60: jewel
    // tones, not neon. The chroma belongs in the PALETTE, not in the grade.
    satMid:    0.92,
    // ROUND-4: A PRESCRIPTION THAT DID NOT SURVIVE THE IMAGE. A review round
    // named this as the thing bleaching the rim ("satHigh 0.76 is desaturating
    // the highlights the rim lives in"). Built at 0.88 and 0.94 and looked at:
    // it does not touch the rim, because the rim that matters lives on the
    // SHADOW-side contour and is therefore governed by satMid/satShadow — what
    // 0.88 actually did was crank the hero's key-lit skin from salmon to a flat
    // fluorescent orange with no modelling left in it, and push meanSaturation
    // from 0.61 to 0.65 against a §7 ceiling of 0.60. The chroma the frame was
    // missing was never in the top band. Left at 0.76; the rim is fixed where
    // it is delivered, in painterly.js shBoost.
    satHigh:   0.82,
    shadowMix: 0.32, highMix: 0.14, tintStrength: 0.48,
    hueLobes: [
      // narrowed + strengthened: 24% of the frame's chroma was sitting in the
      // 300-330deg pink-magenta bin, off the authored ink ramp entirely.
      [0.895, 0.055,  0.075],   // pink-magenta -> crimson
      // NARROW. The old 0.130-wide blue lobe reached down to h=0.549 and ate
      // the mandated #5fd0ff rim before it ever reached the display (§1.2).
      // and a narrow counter-rotation that pulls the periwinkle the tonemap
      // leaves behind back down on to the authored #5fd0ff cyan axis
      [0.660, 0.060, -0.085],
      // THE GOLD SPINE (§2). Warm key x warm albedo lands the ornament near
      // h=0.06 (#ff7a30) — the same hue as the brazier flame, so the filigree
      // had zero separation from the practicals. Rotate that band up into the
      // #e8c060–#f2c14e range so gold is a YELLOW again.
      [0.070, 0.058,  0.054],
    ],
    // §1.8 the frame is composed: the vignette is what turns a lit arena into an
    // ISLAND. It also does real work for §9.1 — the bottom corners of frame are
    // foreground floor, and a repoussoir is supposed to be dark.
    // `floor` is extra vignette weight BELOW frame centre — the foreground
    // repoussoir (§1.8) and the third value band (§9.4).
    vignette: { amount: 0.24, radius: 0.80, softness: 0.94, depth: 0.07, floor: 0.20, color: H('#1c1726') },
    grain:    { amount: 0.0070, size: 1.0, darkBoost: 1.8 },
    chroma:   0.45,
    // §1.7 "bloom is a paint layer over a core that has ALREADY gone bright" —
    // not the source of the brightness. At threshold 1.20 / intensity 0.78 it
    // was eating the medallion's polar meander and the anthemion petals into a
    // solid orange smear, and the #ffc27a tint pushed the core orange instead
    // of letting it resolve toward warm white.
    // THRESHOLD IS NOW EXPOSURE-ANCHORED (see postfx.js _bloomThreshold): the
    // number below is divided by the effective exposure before it reaches the
    // bright pass, so retuning exposure can never silently move the bloom
    // threshold again. 4.20 puts the gate ~4.5 stops over middle grey — only
    // the brazier cores, the portal and genuine gold highlights get through.
    // §9.3 THE FRAME MUST REACH BRIGHT. Measured bands.highlight was 0.008-0.015
    // against a floor of 0.04, i.e. the frame effectively had no highlight band
    // at all — and the fix is emphatically NOT a brighter floor. The gate stays
    // ~3.7 stops over middle grey so only genuine emissives (brazier cores, the
    // portal, lava veins, crystal) and real gold speculars get through it; what
    // changes is how much energy those cores are allowed to SPEND once through.
    // Intensity 3x and radius 1.5x turns each core into a wide painted halo,
    // which is where the top luma band comes from in every Hades frame.
        // CONCENTRATED, not wide. A big radius spends the same energy over a huge
    // area, and that is a PEDESTAL: it lifts the whole ground plane by a few
    // display points and it is what "bloom fog across the entire frame" (§7)
    // actually measures as. A high threshold with a tight radius puts the same
    // energy into small, genuinely white cores — which is what fills the top
    // luma band without touching the mid-tones.
        // RADIUS IS THE LEVER, NOT INTENSITY. The same energy spread wide is a
    // pedestal (§7 "bloom fog across the entire frame", and it is what the p90
    // ground check measures as a blazing floor); the same energy concentrated
    // is a HIGHLIGHT — more pixels genuinely over the top-band threshold, far
    // fewer pixels loitering in the 0.42-0.68 mid-bright range where they look
    // like haze. Tighten the radius before touching the threshold.
    // CLAMP IS THE LEVER (integration pass). radius and intensity control how
    // far and how hard the halo spreads, but `clamp` is what decides how much
    // energy a single blazing texel is allowed to inject into the mip chain at
    // all. At clamp 7.0 a brazier core (emissive ~8) put SEVEN units into mip0,
    // six mips of tent-blur then smeared that over a fifth of the frame and
    // every brazier in the chamber became a featureless orange lozenge that
    // swallowed the architecture behind it — ART_DIRECTION §7's "bloom fog
    // across the entire frame", and §1.7's "bloom must never wash out the ink
    // shadows". At clamp 3.0 the same core keeps a genuinely white centre and
    // a halo you can see the brazier rim through, which is what §5's core /
    // body / glow construction actually asks for.
    // §7 HARD BAN: "bloom fog across the entire frame", and §1.7 "bloom must
    // never wash out the ink shadows". At 5x on a brazier the surrounding
    // flagstone plaza was a single flat salmon value with ZERO surface
    // structure — the halo had eaten ~200px of stone in every direction and
    // destroyed the material work under it. That is not a paint layer, it is a
    // fog layer, and it is also the mechanism by which the perimeter braziers
    // took over the composition: each one injected a wide pedestal that raised
    // the whole top band of frame.
    // Four levers, all four moved, because any one of them alone just trades:
    //   threshold 1.85 -> 3.10  (exposure-anchored — see postfx._anchor — so
    //                            this is ~2.4 DISPLAY-referred: emissive cores,
    //                            the portal and real gold speculars only)
    //   intensity 1.70 -> 0.72  how much the halo is allowed to spend
    //   radius    0.34 -> 0.20  the same energy CONCENTRATED is a highlight;
    //                           spread wide it is a pedestal
    //   clamp     3.0  -> 1.7   how much a single blazing texel may inject into
    //                           mip0 before six tent blurs smear it
    // §9.3's bands.highlight >= 0.04 must still be met — and it is met the way
    // the law actually intends: from emissive CORES and gold speculars that are
    // genuinely bright, not from a smeared halo sitting over everything.
    bloom:    { threshold: 3.35, knee: 0.38, intensity: 0.58, tint: H('#ffe7c9'), radius: 0.16, clamp: 1.35 },
    // §9.7 contact. A 1.75u radius on a 3/4 camera is a soft dirt halo, not an
    // occlusion; 1.25 keeps the darkening where two surfaces actually meet, and
    // the ink goes several stops darker so the base of a column reads planted
    // instead of floating in a lilac smudge.
    ao:       { intensity: 0.82, radius: 1.10, power: 1.75, bias: 0.04, ink: H('#24182d') },
        // Godrays are ADDITIVE over the whole frame, so at 0.34 they were a second
    // bloom pedestal sitting on the ground plane. 0.12 keeps the shafts.
    // No screen-space sky shaft in Tartarus. At the fixed gameplay camera the
    // off-screen anchor produced a conspicuous vertical white ray unrelated to
    // any visible source; local braziers and rim lights still shape the room.
    godrays:  { enabled: false, intensity: 0, color: H('#f6a06e'), decay: 0.955, density: 0.72, weight: 0.5 },
    // §1.1 the background must be LOW value and HAZED. At density 0.030 /
    // hazeStart 26 the arena silhouette met a dead-#000 void at a razor edge
    // with no atmospheric band behind it at all.
    // ATMOSPHERIC PERSPECTIVE ONLY READS AS DEPTH WHEN THE NEAR PLANE IS OUTSIDE
    // THE HAZE. hazeStart 14 with the gameplay camera at 26u put the whole
    // playfield — foreground included — inside the ramp, so the desaturate-and-
    // tint was applied to the near floor as hard as to the far wall and the two
    // converged instead of separating. The ramp now lands on the perimeter and
    // the void only.
    // §9.4 THREE SEPARATED VALUE BANDS + §7 "blacks crushed to nothing".
    // The void was measuring 0.02-0.05 display over ~45% of the wide shot
    // (crushedPct 20.2), which does two bad things at once: it is a dead band,
    // and it drags the FRAME MEDIAN below the floor, so the floor scores as the
    // bright surface no matter how dark it is made. A painted void that sits at
    // ~0.12 — low value, low chroma, hazed, still unmistakably the darkest
    // *architecture-free* band — is what §1.1 actually asks for, and it is what
    // lets the arena's mid-ground read as the lit band above it.
        // DENSITY IS A PEDESTAL. `mix(col, fc, f)` REPLACES part of every surface
    // with the fog colour, so on a deliberately dark ground plane it is a
    // brightness FLOOR that no amount of albedo or glaze can get under — at
    // 0.042 it was holding the arena floor ~0.06 display above where the value
    // law needs it, and it flattened the far half of the wide shot into the
    // near half. The atmospheric band now comes from the distance HAZE (which
    // is depth-gated and desaturating) rather than from a thick medium.
    // §11 REVERSED. The paragraph above was written against the SCREEN-THIRDS
    // metric, which called the top of the frame "background" and therefore paid
    // out for brightening the sky. Measured by true depth the same build read
    //   near 0.038 / mid 0.081 / far 0.142
    // — the void four times the value of the play area, the frame's strongest
    // contrast at its own edge, and the image flat. haze #2f3a72 -> #414d8e and
    // voidSky 1.74 -> 2.30 were made to satisfy that metric and are undone here.
    //
    // What replaces them is a haze that can only ever SUBTRACT (see the
    // absorption ramp in shaders/passes.js): the colour is now a value the far
    // band is pulled DOWN to, not lifted up to, so it belongs on the ink ramp
    // between §2's deep shadow (#120b1e) and shadow plum (#241238) with just
    // enough blue left in it to keep distance cool against a fire-lit room.
    // hazeStart/End are pushed out past the chamber so the camera-distance ramp
    // only ever catches the abyss plate; hazeRadial does the chamber-anchored
    // work, biting just outside the rim (1.12R) and complete by 2.3R, which is
    // the whole void and nothing that stands on the island.
    // MEASURED, NOT ASSUMED: pulling the start inside the rim (0.82R / 1.7R) was
    // tried, on the theory that the close poses need the chamber's own wings to
    // recede. It does drop the far band (02 0.156->0.152, 06 0.187->0.172) but it
    // takes MORE off the mid band than it gives (01 mid 0.161->0.152), because
    // the mid band is largely the perimeter statuary and colonnade, which stand
    // at 0.8-1.0R. Net spread was worse on all four shots, so it is reverted.
    // Anything that hazes inside the rim hazes the subject.
    fog:      { color: H('#1c0b22'), far: H('#170e22'), density: 0.009, height: 0.14, haze: H('#151228'),
                hazeStart: 46, hazeEnd: 96, hazeDesat: 0.92,
                hazeR0: 1.12, hazeR1: 2.3, hazeRadial: 1.0, voidSky: 0.80 },
    dof:      { range: 52.0, nearRange: 16.0, maxBlur: 0.36, nearMax: 0.14, tilt: 0.08, tiltCenter: 0.60, focusRange: 14.0 },
  },

  // ── ASPHODEL ─────────────────────────────────────────────────────────────
  // obsidian isles on a lava sea. Blazing orange key, teal rim, blue-black ink.
  asphodel: {
    name: 'asphodel',
    exposure: 1.28,
    agxSlope: [1.02, 1.01, 1.00],
    agxPower: [1.05, 1.06, 1.08],
    agxSat: 1.04,
    contrast: 0.62,
    pivot: 0.30,
    black: 0.001, white: 0.94, shoulder: 0.20,
    lift:  [0.020, 0.019, 0.026],
    gamma: [1.00, 1.00, 1.02],
    gain:  [1.02, 1.00, 1.02],
    curveR: 0.94, curveG: 1.03, curveB: 1.10,
    shadowTint: H('#2b3f78'),   // obsidian shadow leans indigo-blue
    midTint:    H('#ffa156'),
    highTint:   H('#fff0b0'),
    satShadow: 0.96,
    satMid:    1.05,
    satHigh:   1.06,
    shadowMix: 0.30, highMix: 0.24, tintStrength: 0.72,
    hueLobes: [
      [0.90, 0.095, 0.075],     // magenta -> crimson
      [0.62, 0.060, 0.020],     // blues   -> indigo (narrow: the teal rim must survive)
      [0.48, 0.100, 0.030],     // cyans   -> teal (rim colour)
    ],
    vignette: { amount: 0.16, radius: 0.84, softness: 0.95, depth: 0.05, floor: 0.18, color: H('#211f31') },
    grain:    { amount: 0.0075, size: 1.0, darkBoost: 1.9 },
    chroma:   1.7,
    bloom:    { threshold: 1.58, knee: 0.44, intensity: 0.34, tint: H('#d98d60'), radius: 0.46, clamp: 2.0 },
    ao:       { intensity: 0.56, radius: 1.25, power: 1.55, bias: 0.055, ink: H('#30354d') },
    godrays:  { intensity: 0.0, color: H('#ff8c1a'), decay: 0.962, density: 0.0, weight: 0.0 },
    fog:      { color: H('#4a3b46'), far: H('#29283b'), density: 0.007, height: 0.14, haze: H('#303149'), hazeStart: 46, hazeEnd: 145, hazeDesat: 0.22, hazeR0: 1.24, hazeR1: 2.6, hazeRadial: 0.62 },
    dof:      { range: 50.0, nearRange: 16.0, maxBlur: 0.38, nearMax: 0.14, tilt: 0.08, tiltCenter: 0.60, focusRange: 14.0 },
  },

  // ── ELYSIUM ──────────────────────────────────────────────────────────────
  // marble, laurel, gold. Pale gold key, rose rim, cool violet-grey ink.
  elysium: {
    name: 'elysium',
    exposure: 0.98,
    agxSlope: [1.02, 1.02, 1.0],
    agxPower: [1.05, 1.05, 1.08],
    agxSat: 1.10,
    contrast: 0.55,
    pivot: 0.32,
    black: 0.001, white: 0.90, shoulder: 0.22,
    lift:  [0.012, 0.012, 0.018],
    gamma: [ 1.00,  1.00,  1.03 ],
    gain:  [ 1.04,  1.02,  0.97 ],
    curveR: 0.99, curveG: 1.00, curveB: 1.05,
    shadowTint: H('#6a5c9c'),   // marble shadow: cool violet-grey, still not neutral
    midTint:    H('#ffe0b8'),
    highTint:   H('#fff4d0'),
    satShadow: 1.08,
    satMid:    1.08,
    satHigh:   1.06,
    shadowMix: 0.30, highMix: 0.22, tintStrength: 0.78,
    hueLobes: [
      [0.72, 0.12, 0.040],      // violets -> rose (rim)
      [0.30, 0.12, -0.030],     // greens  -> verdant/olive
      [0.11, 0.09, -0.014],
    ],
    vignette: { amount: 0.18, radius: 0.84, softness: 0.95, depth: 0.06, floor: 0.16, color: H('#302943') },
    grain:    { amount: 0.0060, size: 1.0, darkBoost: 1.5 },
    chroma:   1.1,
    bloom:    { threshold: 1.35, knee: 0.45, intensity: 0.40, tint: H('#fff0bc'), radius: 0.42, clamp: 2.2 },
    ao:       { intensity: 0.60, radius: 1.40, power: 1.60, bias: 0.05, ink: H('#514a70') },
    godrays:  { intensity: 0.14, color: H('#fff0bc'), decay: 0.958, density: 0.62, weight: 0.42 },
    fog:      { color: H('#514f69'), far: H('#292d45'), density: 0.010, height: 0.13, haze: H('#4a4865'), hazeStart: 46, hazeEnd: 155, hazeDesat: 0.38, hazeR0: 1.20, hazeR1: 2.5, hazeRadial: 0.75 },
    dof:      { range: 56.0, nearRange: 17.0, maxBlur: 0.34, nearMax: 0.13, tilt: 0.08, tiltCenter: 0.60, focusRange: 15.0 },
  },
};

export const DEFAULT_BIOME = 'tartarus';

/** Deep-ish clone so live tweaks never mutate the preset table. */
export function cloneGrade(g){
  const out = {};
  for(const k in g){
    const v = g[k];
    if(Array.isArray(v)) out[k] = v.slice();
    else if(v && typeof v === 'object') out[k] = { ...v };
    else out[k] = v;
  }
  return out;
}

/** Shallow-per-group merge used by post.setGrade(partial). */
export function mergeGrade(dst, src){
  for(const k in src){
    const v = src[k];
    if(Array.isArray(v)) dst[k] = v.slice();
    else if(v && typeof v === 'object' && dst[k] && typeof dst[k] === 'object') Object.assign(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}
