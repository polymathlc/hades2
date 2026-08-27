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
    exposure: 1.20,
    agxSlope: [1.06, 1.0, 0.96],
    agxPower: [1.16, 1.18, 1.24],
    // §2 asks for crimson stone and molten gold; the close-ups measured
    // meanSat 0.486-0.497 at mean luma 0.42-0.47, which is the arithmetic
    // definition of pastel. Chroma goes back up now the exposure is off it.
    agxSat: 0.98,
    // pivot 0.22 sat below the frame's median, so the S-curve could only ever
    // push pixels down and there was nothing on its lower arm to bite on.
    contrast: 0.95,
    pivot: 0.34,
    // `black` SUBTRACTS a black point — raising it crushes, it does not protect
    // the darks. What keeps the bottom of the frame off dead #000 is the
    // positive violet `lift` below, which has to survive this subtraction.
    black: 0.008, white: 0.86, shoulder: 0.30, hiRoll: 0.78,
    // §2: the ink ramp bottoms at #07060f — a VIOLET black, not a neutral zero.
    // A negative blue lift clipped the column bases to dead #000.
    lift:  [ 0.010,  0.004,  0.026 ],
    gamma: [ 1.00,  1.02,  1.05 ],
    // The warm gain was rotating every gold surface toward orange before the
    // hue lobes ever saw it. Keep the grade close to neutral and let the
    // PALETTE carry the warmth.
    // RED CLIPS FIRST under a saturated crimson key, and a clipped channel is a
    // hue that has stopped being a hue. The grade holds red DOWN a touch and
    // lets the palette carry the warmth (measured clipped-channel coverage has
    // to stay under 1.5% of every shipped frame).
    gain:  [ 1.00,  1.00,  0.99 ],
    curveR: 1.00, curveG: 1.02, curveB: 1.08,
    // §2 Shadow plum #241238 wants B/R ~1.56. The old #42287e measured 1.08 on
    // screen — magenta, not indigo — so the ink ramp was not being honoured.
    shadowTint: H('#2e2382'),   // ink shadows push INDIGO-violet, never grey
    midTint:    H('#e0a48f'),
    highTint:   H('#ffdcae'),   // highlights toward warm gold
    // 0.86 was desaturating the ONE cool element in the frame (the mandated
    // #5fd0ff rim lives in the shadow band by construction — see painterly.js
    // shBoost). Hold chroma in the darks; the ink is a HUE, not a grey.
    satShadow: 0.95,
    // measured meanSaturation was 0.68 against a §7 target of 0.28-0.60: jewel
    // tones, not neon. The chroma belongs in the PALETTE, not in the grade.
    satMid:    0.98,
    satHigh:   0.80,
    shadowMix: 0.58, highMix: 0.26, tintStrength: 1.0,
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
    vignette: { amount: 0.66, radius: 0.60, softness: 0.86, depth: 0.12, color: H('#150820') },
    grain:    { amount: 0.0070, size: 1.0, darkBoost: 1.8 },
    chroma:   1.35,
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
    bloom:    { threshold: 4.20, knee: 0.42, intensity: 0.34, tint: H('#ffe0b8'), radius: 0.80, clamp: 3.0 },
    ao:       { intensity: 0.95, radius: 1.75, power: 2.0, bias: 0.04, ink: H('#3a1d52') },
    godrays:  { intensity: 0.26, color: H('#ff7a44'), decay: 0.955, density: 0.72, weight: 0.5 },
    // §1.1 the background must be LOW value and HAZED. At density 0.030 /
    // hazeStart 26 the arena silhouette met a dead-#000 void at a razor edge
    // with no atmospheric band behind it at all.
    // ATMOSPHERIC PERSPECTIVE ONLY READS AS DEPTH WHEN THE NEAR PLANE IS OUTSIDE
    // THE HAZE. hazeStart 14 with the gameplay camera at 26u put the whole
    // playfield — foreground included — inside the ramp, so the desaturate-and-
    // tint was applied to the near floor as hard as to the far wall and the two
    // converged instead of separating. The ramp now lands on the perimeter and
    // the void only.
    fog:      { color: H('#2a1030'), far: H('#180b24'), density: 0.042, height: 0.14, haze: H('#241338'), hazeStart: 30, hazeEnd: 70, hazeDesat: 0.75, voidSky: 0.17 },
    dof:      { range: 52.0, nearRange: 16.0, maxBlur: 0.36, nearMax: 0.14, tilt: 0.08, tiltCenter: 0.60, focusRange: 14.0 },
  },

  // ── ASPHODEL ─────────────────────────────────────────────────────────────
  // obsidian isles on a lava sea. Blazing orange key, teal rim, blue-black ink.
  asphodel: {
    name: 'asphodel',
    exposure: 0.86,
    agxSlope: [1.10, 0.99, 0.92],
    agxPower: [1.12, 1.20, 1.30],
    agxSat: 1.10,
    contrast: 0.94,
    pivot: 0.32,
    black: 0.028, white: 0.74, shoulder: 0.20,
    lift:  [-0.010, -0.014, -0.008],
    gamma: [ 0.99,  1.03,  1.08 ],
    gain:  [ 1.10,  0.98,  0.93 ],
    curveR: 0.94, curveG: 1.03, curveB: 1.10,
    shadowTint: H('#2b3f78'),   // obsidian shadow leans indigo-blue
    midTint:    H('#ffa156'),
    highTint:   H('#fff0b0'),
    satShadow: 0.94,
    satMid:    1.24,
    satHigh:   0.98,
    shadowMix: 0.48, highMix: 0.36, tintStrength: 1.0,
    hueLobes: [
      [0.90, 0.095, 0.075],     // magenta -> crimson
      [0.62, 0.060, 0.020],     // blues   -> indigo (narrow: the teal rim must survive)
      [0.48, 0.100, 0.030],     // cyans   -> teal (rim colour)
    ],
    vignette: { amount: 0.58, radius: 0.64, softness: 0.86, depth: 0.18, color: H('#0d0b18') },
    grain:    { amount: 0.0075, size: 1.0, darkBoost: 1.9 },
    chroma:   1.7,
    bloom:    { threshold: 1.10, knee: 0.5, intensity: 0.76, tint: H('#ffa03c'), radius: 1.08, clamp: 6.0 },
    ao:       { intensity: 0.95, radius: 1.65, power: 2.0, bias: 0.04, ink: H('#161a3a') },
    godrays:  { intensity: 0.34, color: H('#ff8c1a'), decay: 0.962, density: 0.80, weight: 0.55 },
    fog:      { color: H('#3a1408'), far: H('#0d0b18'), density: 0.026, height: 0.18, haze: H('#150f26'), hazeStart: 32, hazeEnd: 124, hazeDesat: 0.54 },
    dof:      { range: 50.0, nearRange: 16.0, maxBlur: 0.38, nearMax: 0.14, tilt: 0.08, tiltCenter: 0.60, focusRange: 14.0 },
  },

  // ── ELYSIUM ──────────────────────────────────────────────────────────────
  // marble, laurel, gold. Pale gold key, rose rim, cool violet-grey ink.
  elysium: {
    name: 'elysium',
    exposure: 0.82,
    agxSlope: [1.02, 1.02, 1.0],
    agxPower: [1.14, 1.14, 1.18],
    agxSat: 1.02,
    contrast: 0.76,
    pivot: 0.38,
    black: 0.020, white: 0.78, shoulder: 0.15,
    lift:  [-0.008, -0.008, -0.002],
    gamma: [ 1.00,  1.00,  1.03 ],
    gain:  [ 1.04,  1.02,  0.97 ],
    curveR: 0.99, curveG: 1.00, curveB: 1.05,
    shadowTint: H('#6a5c9c'),   // marble shadow: cool violet-grey, still not neutral
    midTint:    H('#ffe0b8'),
    highTint:   H('#fff4d0'),
    satShadow: 1.00,
    satMid:    1.14,
    satHigh:   1.02,
    shadowMix: 0.44, highMix: 0.28, tintStrength: 1.0,
    hueLobes: [
      [0.72, 0.12, 0.040],      // violets -> rose (rim)
      [0.30, 0.12, -0.030],     // greens  -> verdant/olive
      [0.11, 0.09, -0.014],
    ],
    vignette: { amount: 0.48, radius: 0.70, softness: 0.88, depth: 0.24, color: H('#241a3a') },
    grain:    { amount: 0.0060, size: 1.0, darkBoost: 1.5 },
    chroma:   1.1,
    bloom:    { threshold: 1.05, knee: 0.45, intensity: 0.62, tint: H('#ffe6a3'), radius: 0.95, clamp: 6.0 },
    ao:       { intensity: 0.88, radius: 1.85, power: 1.9, bias: 0.04, ink: H('#3d3560') },
    godrays:  { intensity: 0.28, color: H('#ffe6a3'), decay: 0.958, density: 0.76, weight: 0.52 },
    fog:      { color: H('#3c3a56'), far: H('#191a2e'), density: 0.020, height: 0.13, haze: H('#3a3654'), hazeStart: 38, hazeEnd: 145, hazeDesat: 0.60 },
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
