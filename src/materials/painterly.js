// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// painterly.js — the SHADING LOOK.
//
// We do not rewrite Three's shader. We patch MeshStandardMaterial through
// onBeforeCompile and add, in order:
//
//   1. a soft 2-3 step shading RAMP around the terminator  (painted, not toon)
//   2. COLOURED SHADOWS  — shadow is a different hue, never neutral grey
//   3. a constant art-directed RIM light (fresnel, additive, complement hue,
//      driven by a fixed world direction — NOT a real light)
//   4. an optional thin colour-shifted inner CONTOUR that vanishes on lit edges
//   5. (opt-in) triplanar projection, a detail layer and a macro-variation
//      layer, which together are what stop large floors from tiling
//   6. (opt-in) per-instance / per-object colour variation
//
// Every parameter is a live uniform. `setBiomeLook()` retunes the whole scene
// in one call; `paintParams(mat)` hands any other system the uniform bag.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { BIOMES, hexToRgb } from './palette.js';

const REGISTRY = new Set();          // every patched material (weakly used)
let GLOBAL_TIME = 0;
let LAST_KEYREF = 2.2;               // see setKeyRefAll()

const col = (hex) => new THREE.Color().setRGB(...hexToRgb(hex), THREE.SRGBColorSpace);

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const ENVIRONMENT_LOOK = {
  rimColor: '#5fd0ff',
  // §1.2 is marked NON-NEGOTIABLE and the measured cyan coverage across the
  // whole shot sheet was 0.07-1.4%, all of it the portal quad. Two causes:
  // power 3.1 makes the fresnel band a couple of pixels wide (invisible on a
  // column at play distance) and strength 0.54 is a whisper against a key of
  // 12.0. A wide band at 1.9 with real energy is what draws an EDGE.
  // §1.2 SCOPES THE ART-DIRECTED RIM TO CHARACTERS. A power of 1.6 is a very
  // wide fresnel band — on a wall or a statue face that is not an edge light,
  // it is a WASH across the whole grazing half of the surface. 2.4 draws an
  // arris: a hairline on the actual silhouette of a form and nothing on its
  // faces. CHARACTER_LOOK deliberately keeps the wide 1.5 band, because a hero
  // ~120px tall needs a rim you can see at the §5 silhouette test.
  rimPower: 2.4,
  // CALIBRATED TO THE GRADE. AgX bleaches anything more than ~3 stops over
  // middle grey toward white, and with the corrected exposure middle grey is
  // scene-linear 0.018 — so a rim of 1.15 arrived as a white edge, not a CYAN
  // one, and the complement disappeared into the highlight re-hue. 0.34 lands
  // the band about one stop over the lit stone: bright, and still #5fd0ff.
  // §1.2 is NON-NEGOTIABLE and measured cyan coverage was 0.00-0.23% of frame:
  // 0.22 is not a rim, it is a rumour. 0.40 is the level at which a column
  // arris genuinely carries a cool edge at the play camera; the ground-plane
  // veto below is what keeps it off the floor.
  // §9.6 raised again: the rim is the frame's designated complement source and
  // the single strongest "light the EDGES, not the faces" device we have.
  // MEASURED CHARACTER-TO-WORLD RIM GAP: 1.25x. With 0.68 here against 0.85 on
  // CHARACTER_LOOK, and library.js _applyRim() mapping the rig's rim.intensity
  // through a clamp that SATURATED at 1.75 for environments and 1.45 for
  // characters, every wall, rubble chunk, plinth and statue in the chamber was
  // carrying essentially the same halo as the hero. When everything is rimmed,
  // nothing is separated from anything — which is the single most common way a
  // Hades-like frame loses its subject. 0.30 opens the preset gap to ~3.7x, and
  // the shipped hero (entities/rig.js SLOT_PAINT authors 9.8-13.2 and declares
  // it in paintOverrides so _applyRim leaves it alone) sits far above that.
  // 0.30 -> 0.465. ONE exact compensation, not a taste change: the biome rim is
  // now published as the PRE-IMAGE '#8fa4ff' rather than the raw '#5fd0ff'
  // (render/lighting.js), which corrects the world's rim hue from ~176 to 198
  // but carries 0.645x the luminance through painterly's multiply. 1/0.645 =
  // 1.55. Every environment material therefore renders the same rim LEVEL it
  // rendered before, in the right hue.
  rimStrength: 0.465,
  // POSITIVE Z: see the note in render/lighting.js. A rim aimed away from the
  // shipping camera is a rim nobody ever sees.
  rimDir: [-0.62, 0.34, 0.70],
  rimGate: [-0.40, 0.58],
  shadowTint: [0.72, 0.60, 1.14],
  shadowDepth: 0.55,
  rampSoftness: 0.16,
  rampStrength: 0.55,
  rampSteps: [0.30, 0.68],
  rampLevels: [0.05, 0.55, 1.0],
  keyRef: 2.2,
  contourColor: '#2a0f2e',
  contourStrength: 0.0,
  contourStart: 0.72,
  variation: 0.0,
  variationTint: '#8c3b46',
  specTint: 0.35,
  // ── THE VALUE LAW (§9) ────────────────────────────────────────────────────
  // How much of the rig actually lands on this surface. 1.0 = "lit like
  // everything else". Lower it on the GROUND PLANE so the floor can be a dark
  // stage without darkening the architecture standing on it — a global key cut
  // would take the ornament down with the floor, which is precisely the wrong
  // trade. These are art-directed *exposure* controls per surface class, the
  // real-time equivalent of a background painter simply not painting light on
  // the foreground apron. Emissives are deliberately NOT attenuated.
  litGain: 1.0,       // direct diffuse + direct specular
  ambGain: 1.0,       // indirect (hemisphere fill, ambient, IBL)
  // ── THE TONEMAP-AWARE BLOCK (§15, and the AgX shoulder) ───────────────────
  // EVERY ONE OF THESE SIX IS AN IDENTITY AT THE VALUES BELOW. They exist so
  // the CHARACTER preset can diverge from the environment without a single
  // environment pixel moving; grep for them in CHARACTER_LOOK for the values
  // that are actually art-directed, and for the measurements behind each.
  //
  // hiKnee / hiSlope — a hue-preserving shoulder on DIFFUSE only.
  //   Measured on the shipped hero: lit chest skin renders rgb(245,224,177),
  //   display luma 225. A neutral at display 225 is ~1.3 scene-linear, and AgX
  //   middle grey at the tartarus exposure of 1.36 is 0.018 — so the hero's lit
  //   half sits 6.2 stops over middle grey. AgX's inset converges everything
  //   past ~3 stops toward its white point, which is why #e8bd93 skin (hue 30),
  //   #f0bb52 gold (hue 42) and the sword all arrive inside a 4-degree hue band
  //   as the same cream. No downstream grade can undo that: the hue is gone
  //   before the grade ever sees the pixel.
  //   Compressing DIFFUSE and leaving directSpecular alone is the §4 split:
  //   "specular is a small, bright, sharp glint ... not a raised diffuse". The
  //   glint still reaches white and still pays for §9.3's highlight band; the
  //   broad lit planes come back down into AgX's linear midrange where a
  //   saturated hue survives. 0 disables the branch entirely.
  hiKnee: 0.0,        // scene-linear where the shoulder starts (0 = off)
  hiSlope: 2.4,       // log-shoulder hardness
  // chroma — §15.1: "saturation multipliers are ABOVE 1.0 in every band, in
  //   every biome. Chroma is added, never removed." The shipped tartarus grade
  //   runs agxSat 0.92 / satShadow 0.82 / satMid 0.92 / satHigh 0.82, i.e. it
  //   is still the bleach pass §15 was written to ban — but grades.js is shared
  //   with the environment grade, so the character path pre-compensates here
  //   instead. Applied AFTER the shadow tint and BEFORE the rim, so it lifts the
  //   surface's OWN hue and never amplifies the rim's cyan.
  chroma: 1.0,        // 1 = identity
  // rimTighten — an exponent on the fresnel term. Identity at 1.0.
  //   THE RIM WAS REPAINTING THE MANTLE. rimC * rimE on a cape pixel measured
  //   (0.010, 0.054, 0.084) scene-linear against the cape's own
  //   (0.017, 0.003, 0.090): the rim owned ~90% of the garment's GREEN channel,
  //   so a #3d1a5c plum rendered rgb(30,32,40) — hue 228, HSL sat 0.14, a
  //   neutral blue-black. A term that covers a whole garment is not a rim, it
  //   is a repaint, and §4 says the rim "must vanish on lit edges". Raising the
  //   exponent leaves the peak on the true silhouette untouched (fres -> 1 is a
  //   fixed point) and collapses the taper across the grazing half.
  rimTighten: 1.0,
  // rimSuppress / rimSuppressK — the key-suppression multiply, now a uniform so
  //   the environment keeps EXACTLY the shipped (0.42, 0.82, 1.06) x 3.2 while
  //   the character can run a gentler one. On the hero it was cutting RED to
  //   0.42 across every pixel more than ~62 degrees off the view axis, which is
  //   most of a cape and most of a shoulder.
  rimSuppress: [0.42, 0.82, 1.06],
  rimSuppressK: 3.2,
  // shadowNeutral — blends uShadowTint toward its own luminance. Identity at 0.
  //   The hero's cloth tint [0.46, 0.34, 1.30] is a 2.8x B/R gain laid on a
  //   plum that already runs B/R 2.1, which lands the mantle's shadow at
  //   B/R ~6 — blue, not violet. §15.3: "a violet shadow should be a RICH
  //   violet". This takes the skew off the tint without touching its VALUE, so
  //   the terminator does not move.
  shadowNeutral: 0.0,
  // ── THE INK FLOOR (§1.3, §2 ink ramp, §9.7) ──────────────────────────────
  // "Shadow is not 'less light' — it is a different COLOUR." Measured on the
  // round-3 shot sheet: 4.7% of 07_combat and 8.8% of 03_hero_char were at
  // LITERAL rgb(0,0,0), in slabs — the inward faces of the arena rim run, which
  // face away from the key and receive nothing but a hemi of 0.75 and an ambient
  // of 0.34 through a floor-class ambGain. A void slab beside a lit one is the
  // maximum possible local contrast, which is why its blocky silhouette read to
  // three separate reviewers as a "hard-aliased cast shadow" — the staircase is
  // visible because the step is 255 counts tall, not because the edge is
  // unfiltered. Colour is the fix; more AA is not.
  //
  // So: a scene-linear radiance floor, in the ink ramp's own hue, that only
  // fills in where the surface has genuinely gone to nothing. It is NOT a fill
  // light and it does NOT lift the frame: it is gated by a smoothstep on the
  // outgoing value, so a stone at even a tenth of key gets none of it, which is
  // what keeps §3's "fill never lifts blacks above ~0.06 luminance" and §9.1's
  // dark stage intact. `inkFloorGain` is per-surface-class, like litGain/ambGain.
  //
  // SIZING IS THE WHOLE JOB, and the first attempt at it did nothing at all —
  // the classic failure ARCHITECTURE §10 warns about. uInkFloor is a NORMALISED
  // colour (max component 0.054 linear), so a level of 0.0075 adds a peak
  // radiance of 4e-4; against an AgX middle grey of ~0.13 scene-linear that is
  // eleven stops down and arrives at the display as nothing. An in-place sweep
  // measured 0.0075 vs 0.030 as pureBlackFrac 0.1431 vs 0.1381 — i.e. a knob
  // that looked considered and was inert. 0.055 puts the blue channel at
  // ~0.0030 scene-linear, which is where a dead surface lands at display ~0.13
  // sRGB: a deep plum a critic can see into.
  inkFloor: '#2a1442',   // Shadow plum (§2), pushed a hair toward mid-violet
  inkFloorLevel: 0.055,  // scene-linear radiance at full fill
  inkFloorGain: 1.0,
  inkFloorGate: 0.030,   // outgoing value at which the fill has fully shut off
  // SPECULAR IS ALBEDO-INDEPENDENT. A dielectric's F0 is ~0.04 whatever colour
  // it is painted, so darkening a floor's albedo by 20x does NOT darken its
  // sheen by 20x — the specular lobe becomes a BRIGHTNESS PEDESTAL that no
  // amount of palette work can get under, and on a ground plane seen at a 52deg
  // grazing angle that lobe is wide. Measured: the arena floor's value was ~45%
  // pedestal, which is why every attempt to darken it by albedo alone stalled.
  specGain: 1.0,
};

export const CHARACTER_LOOK = {
  ...ENVIRONMENT_LOOK,
  // Retuned for a SMALL on-screen subject. At the shipping 3/4 camera the hero
  // is ~120px tall and a power-2.5 fresnel band is a couple of pixels wide —
  // it vanishes at the 1/8-resolution silhouette test §5 demands. Wider band,
  // hotter, and wrapped further round the form.
  rimPower: 1.5,
  // Raised with ENVIRONMENT_LOOK's cut so the preset gap is a real 3.7x rather
  // than the measured 1.25x. This is the value setBiomeLook() re-asserts over
  // every character material, so it is what enemies and NPCs get; the player
  // overrides it per slot in entities/rig.js.
  // 1.10 -> 1.70, the same exact x1.55 as ENVIRONMENT_LOOK and for the same
  // reason: it buys back the luminance the pre-image hex costs, nothing more.
  // library.js _applyRim() still clamps this through min(1.45,
  // rim.intensity/2.4), so the preset gap to the environment is unchanged.
  rimStrength: 1.70,
  rimGate: [-0.42, 0.55],
  rampSoftness: 0.11,
  rampStrength: 0.82,           // flatter, more graphic bands
  rampSteps: [0.26, 0.62],
  rampLevels: [0.10, 0.62, 1.0],
  // §4 colour-shifted inner contour, drawn in Shadow plum, dying on lit edges
  contourColor: '#241238',
  contourStrength: 0.55,
  contourStart: 0.62,
  shadowDepth: 0.72,
  // ── THE SUBJECT IS NOT AN EXPOSURE PROBLEM, IT IS A TRANSFORM PROBLEM ─────
  // See the derivations on ENVIRONMENT_LOOK. Every value here is measured
  // against the shipped hero, and every one of them is an identity on the
  // environment preset, so nothing in the chamber moves.
  //
  // hiKnee 0.26: the lit chest was ~1.3-1.8 scene-linear. Through the shoulder
  // 1.5 lands at ~0.55, which is 4.9 stops over middle grey instead of 6.2 —
  // inside the band where the AgX sweep still returns hue. Measured on the
  // simulator (tools note: probe/level.mjs), a #f0bb52 gold reflectance at
  // 1.30 scene-linear renders rgb(226,192,143), HSV chroma 0.37, hue 35; the
  // same gold at 0.45 renders rgb(185,145,90), HSV chroma 0.51. Same hue, half
  // again the chroma, and it is still 2.6x the measured floor luma of 57, so
  // §9.2's "hero out-values the floor by 2.5x or more" holds.
  hiKnee: 0.23,
  hiSlope: 2.2,
  // chroma 1.34: the grade takes roughly 1/(0.92 x 0.92) = 1.18x of chroma out
  // of the mid band and 1/(0.92 x 0.82) = 1.33x out of the top one. This is the
  // §15.1 compensation and nothing more — it is not a look, it is the inverse
  // of a bleach pass the character path is not allowed to edit.
  chroma: 1.40,
  // rimTighten 1.9: with the hero's authored rimPower 3.2 this is an effective
  // 6.1 on the cape's grazing half — the additive drops ~9x at fres 0.11 (the
  // body of a hanging mantle) and is unchanged at fres 1.0 (its silhouette).
  rimTighten: 1.9,
  // A gentler suppression: it still takes the warm out of the contour so the
  // complement is not read as white, but it no longer removes 58% of the RED
  // channel from every plum and every gold in the grazing band.
  rimSuppress: [0.66, 0.90, 1.04],
  rimSuppressK: 2.4,
  shadowNeutral: 0.34,
  // §1.3 / §15.3. The character's deep shadow is where the ink ramp is supposed
  // to live, and on the hero it was going to a near-neutral blue-black instead.
  // A slightly higher plum floor, admitted over a slightly wider gate, is what
  // keeps a shadowed mantle a colour rather than a hole. It is still two stops
  // under AgX middle grey, so it cannot milk the frame.
  inkFloorLevel: 0.098,
  inkFloorGate: 0.052,
};

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const VERT_PARS = /* glsl */`
varying vec3 vPaintWPos;
varying vec3 vPaintWNrm;
varying vec3 vPaintOrig;
`;

const VERT_BODY = /* glsl */`
{
  vec4 paintWP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    paintWP = batchingMatrix * paintWP;
  #endif
  #ifdef USE_INSTANCING
    paintWP = instanceMatrix * paintWP;
  #endif
  paintWP = modelMatrix * paintWP;
  vPaintWPos = paintWP.xyz;

  vec4 paintO = vec4( 0.0, 0.0, 0.0, 1.0 );
  #ifdef USE_INSTANCING
    paintO = instanceMatrix * paintO;
  #endif
  vPaintOrig = ( modelMatrix * paintO ).xyz;

  vec3 paintN = objectNormal;
  #ifdef USE_INSTANCING
    paintN = mat3( instanceMatrix ) * paintN;
  #endif
  vPaintWNrm = normalize( mat3( modelMatrix ) * paintN );
}
`;

const FRAG_PARS = /* glsl */`
varying vec3 vPaintWPos;
varying vec3 vPaintWNrm;
varying vec3 vPaintOrig;

uniform vec3  uRimColor;
uniform vec3  uRimDir;
uniform vec2  uRimGate;
uniform float uRimPower;
uniform float uRimStrength;
uniform vec3  uShadowTint;
uniform float uShadowDepth;
uniform float uRampSoftness;
uniform float uRampStrength;
uniform vec2  uRampSteps;
uniform vec3  uRampLevels;
uniform float uKeyRef;
uniform vec3  uContourColor;
uniform float uContourStrength;
uniform float uContourStart;
uniform float uVariation;
uniform vec3  uVariationTint;
uniform float uPaintTime;
uniform float uLitGain;
uniform float uAmbGain;
uniform float uSpecGain;
uniform vec3  uInkFloor;      // ink ramp hue, scene-linear
uniform float uInkFloorLevel; // scene-linear radiance at full fill
uniform float uInkFloorGate;
uniform float uHiKnee;        // diffuse shoulder knee (0 = off)
uniform float uHiSlope;
uniform float uChroma;        // post-shade chroma multiplier (1 = off)
uniform float uRimTighten;    // fresnel exponent multiplier (1 = off)
uniform vec3  uRimSuppress;
uniform float uRimSuppressK;
uniform float uShadowNeutral; // 0 = the authored shadow tint, 1 = its luminance
uniform float uVertexHue;     // share of the vertex colour's CHROMA applied (its value always is)

float gPaintLit = 1.0;
// Set in the map fragment, consumed by the normal and roughness fragments,
// which three.js emits AFTER it. Micro-relief and roughness break-up therefore
// cost nothing beyond the detail/macro fetches the albedo already pays for.
vec2  gPaintBump   = vec2( 0.0 );   // tangent-space micro-normal xy
float gPaintDRough = 0.0;           // detail-scale roughness modulation
float gPaintMRough = 0.0;           // macro-scale roughness modulation

float paintHash13( vec3 p ){
  p = fract( p * 0.1031 );
  p += dot( p, p.yzx + 33.33 );
  return fract( ( p.x + p.y ) * p.z );
}

float paintRampCurve( float k ){
  float s = max( uRampSoftness, 0.012 );
  float a = smoothstep( uRampSteps.x - s, uRampSteps.x + s, k );
  float b = smoothstep( uRampSteps.y - s, uRampSteps.y + s * 1.4, k );
  return mix( mix( uRampLevels.x, uRampLevels.y, a ), uRampLevels.z, b );
}
`;

const FRAG_TRIPLANAR_PARS = /* glsl */`
uniform float uTriScale;
uniform float uTriSharp;
uniform float uStoch;

vec3 paintTriWeights( vec3 n ){
  vec3 b = pow( abs( n ), vec3( uTriSharp ) );
  return b / max( b.x + b.y + b.z, 1e-4 );
}
vec4 paintTriSample( sampler2D t, vec3 wp, vec3 w, float s ){
  return texture2D( t, wp.zy * s ) * w.x
       + texture2D( t, wp.xz * s ) * w.y
       + texture2D( t, wp.xy * s ) * w.z;
}
vec3 paintTriNormal( sampler2D t, vec3 wp, vec3 w, float s, vec3 n, vec2 sc ){
  vec3 nx = texture2D( t, wp.zy * s ).xyz * 2.0 - 1.0;
  vec3 ny = texture2D( t, wp.xz * s ).xyz * 2.0 - 1.0;
  vec3 nz = texture2D( t, wp.xy * s ).xyz * 2.0 - 1.0;
  nx.xy *= sc; ny.xy *= sc; nz.xy *= sc;
  nx = vec3( nx.xy + n.zy, abs( nx.z ) * n.x );
  ny = vec3( ny.xy + n.xz, abs( ny.z ) * n.y );
  nz = vec3( nz.xy + n.xy, abs( nz.z ) * n.z );
  return normalize( nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z );
}
`;

// ---------------------------------------------------------------------------
// STOCHASTIC (Heitz-Neyret) TILING.
//
// The old de-tiler was a 2-tap cross-fade between vec2(x,z) and vec2(-z,x) — a
// 90-degree swizzle of the SAME frame. An ashlar bed is axis-symmetric, so the
// lattice survived the swizzle intact, both taps agreed on where the seams were
// and the mix only ever blended two copies of one grid (measured autocorrelation
// 0.36-0.46 at the tile lag). The part that actually kills a lattice is a
// per-cell ROTATION, which is what this does: decompose the uv into a triangle
// grid, hash each of the three surrounding lattice points into an angle AND an
// offset, sample three rigidly-transformed copies and blend on the barycentric
// weights. Gradients are rotated with the uv so every tap keeps the correct mip
// and anisotropy (three.js exposes textureGrad as texture2DGradEXT).
// ---------------------------------------------------------------------------
const FRAG_PROJ_PARS = /* glsl */`
uniform float uTriScale;
uniform float uStoch;
uniform float uCircScale;

vec2  gStU[3];
vec2  gStDX[3];
vec2  gStDY[3];
mat2  gStR[3];
vec3  gStW = vec3( 1.0, 0.0, 0.0 );

vec2 paintHash22( vec2 p ){
  vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.xx + q.yz ) * q.zy );
}

/** three lattice points of the triangle containing uv, plus barycentrics */
void paintTriGrid( vec2 uv, out vec3 w, out vec2 v1, out vec2 v2, out vec2 v3 ){
  vec2 sk = mat2( 1.0, 0.0, -0.57735027, 1.15470054 ) * ( uv * 3.4641016 );
  vec2 baseId = floor( sk );
  vec3 t = vec3( fract( sk ), 0.0 );
  t.z = 1.0 - t.x - t.y;
  if ( t.z > 0.0 ) {
    w = vec3( t.z, t.y, t.x );
    v1 = baseId; v2 = baseId + vec2( 0.0, 1.0 ); v3 = baseId + vec2( 1.0, 0.0 );
  } else {
    w = vec3( -t.z, 1.0 - t.y, 1.0 - t.x );
    v1 = baseId + vec2( 1.0 ); v2 = baseId + vec2( 1.0, 0.0 ); v3 = baseId + vec2( 0.0, 1.0 );
  }
}

/** build the three rigid transforms once, before any map is read */
void paintStochFrame( vec2 uv, vec2 ddx, vec2 ddy, float amt ){
  gStU[0] = uv; gStU[1] = uv; gStU[2] = uv;
  gStDX[0] = ddx; gStDX[1] = ddx; gStDX[2] = ddx;
  gStDY[0] = ddy; gStDY[1] = ddy; gStDY[2] = ddy;
  gStR[0] = mat2( 1.0, 0.0, 0.0, 1.0 );
  gStR[1] = gStR[0]; gStR[2] = gStR[0];
  gStW = vec3( 1.0, 0.0, 0.0 );
  if ( amt <= 0.001 ) return;
  vec3 w; vec2 v1, v2, v3;
  // PATCH SIZE. The lattice is broken per triangle-grid cell, so the cell has to
  // be several tiles across or the floor stops reading as laid stone and starts
  // reading as scattered debris. 0.42 puts one patch at ~2.4 texture periods.
  paintTriGrid( uv * 0.42, w, v1, v2, v3 );
  // sharpen the barycentrics hard: a linear 3-way blend of a STRUCTURED texture
  // ghosts its seams (a flat blend also loses variance, which reads as a soft
  // grey haze exactly where the lattice used to be). At this exponent one tap
  // owns almost every pixel and the transitions are a few pixels wide.
  w = pow( w, vec3( 7.0 ) );
  w /= max( w.x + w.y + w.z, 1e-5 );
  gStW = w;
  vec2 ids[3]; ids[0] = v1; ids[1] = v2; ids[2] = v3;
  for ( int k = 0; k < 3; k++ ) {
    vec2 hs = paintHash22( ids[k] );
    // QUANTISED to 90 degrees, plus a per-cell OFFSET. A free rotation does kill
    // the lattice, but it also rotates the ashlar bed itself, and a floor whose
    // joints run at 23 degrees in one patch and 71 in the next reads as rubble,
    // not as masonry. Quarter turns keep every joint square to the world while
    // the offsets — which is what the old two-tap de-tiler never had — stop the
    // seams of neighbouring patches from ever lining up.
    float a = floor( hs.y * 4.0 ) * 1.57079633;
    float ca = cos( a ), sa = sin( a );
    mat2 R = mat2( ca, -sa, sa, ca );
    gStR[k] = R;
    gStU[k] = R * uv + hs * vec2( 13.71, 7.39 ) + float( k ) * 0.137;
    gStDX[k] = R * ddx;
    gStDY[k] = R * ddy;
  }
}

vec4 paintStochSample( sampler2D t ){
  return texture2DGradEXT( t, gStU[0], gStDX[0], gStDY[0] ) * gStW.x
       + texture2DGradEXT( t, gStU[1], gStDX[1], gStDY[1] ) * gStW.y
       + texture2DGradEXT( t, gStU[2], gStDX[2], gStDY[2] ) * gStW.z;
}

/** tangent-space normal, un-rotated per tap so the relief stays in register */
vec3 paintStochNormal( sampler2D t ){
  vec3 acc = vec3( 0.0 );
  for ( int k = 0; k < 3; k++ ) {
    vec3 n = texture2DGradEXT( t, gStU[k], gStDX[k], gStDY[k] ).xyz * 2.0 - 1.0;
    n.xy = n.xy * gStR[k];                 // row-vector product == R^T * n.xy
    acc += n * gStW[k];
  }
  return acc;
}

/**
 * The DETAIL layer through the same three rigid taps. It used to be read
 * straight off the world uv (pUV * uDetailScale), which meant the one layer
 * that tiles at 1.6m on the floor — well inside the lag window the tiling
 * metric scans — was the only layer the de-tiler never touched. Scaling the
 * rotated uv keeps each tap a rigid transform (R*(uv*s) + off*s), and the
 * micro-normal in GB is un-rotated per tap exactly as the main normal is.
 */
vec4 paintStochDetail( sampler2D t, float s, float off ){
  vec4 acc = vec4( 0.0 );
  for ( int k = 0; k < 3; k++ ) {
    vec4 d = texture2DGradEXT( t, gStU[k] * s + off, gStDX[k] * s, gStDY[k] * s );
    d.gb = ( d.gb - 0.5 ) * gStR[k] + 0.5;
    acc += d * gStW[k];
  }
  return acc;
}
`;

const FRAG_LAYER_PARS = /* glsl */`
uniform sampler2D tPaintDetail;
uniform sampler2D tPaintMacro;
uniform float uDetailScale;
uniform float uDetailStrength;
uniform float uDetailBump;
uniform float uDetailRough;
uniform float uMacroScale;
uniform float uMacroStrength;
uniform vec3  uMacroTint;
uniform vec3  uMacroLevel;    // the MEAN multiply, held at the legacy constant
uniform vec3  uMacroTintDir;  // luminance-normalised hue direction
uniform float uMacroRough;
`;

// ---------------------------------------------------------------------------
// Macro-layer calibration
// ---------------------------------------------------------------------------
// The macro texture's old per-channel means, times the shader's `* 2.0`. These
// three numbers are what the whole layer evaluated to before the encoding was
// re-centred (library.js _macro carries the derivation), and they are kept here
// so uMacroLevel can reproduce the EXACT mean multiply every shipped material
// already had. The change to the macro layer is therefore a pure variance
// change: no surface in the game moves in average brightness, and any value-law
// measurement taken before it is still valid after it.
const MACRO_LEGACY_MEAN = [0.9964, 0.9100, 0.9336];

/** The legacy mean multiply for a (tint, strength) pair, or an explicit override. */
function macroLegacyLevel(tint, strength, override) {
  if (Array.isArray(override)) return new THREE.Vector3(override[0], override[1], override[2]);
  if (typeof override === 'number') return new THREE.Vector3(override, override, override);
  const t = [tint.r, tint.g, tint.b];
  const v = t.map((c, i) => 1 + strength * (MACRO_LEGACY_MEAN[i] * (0.5 + 0.85 * c) - 1));
  return new THREE.Vector3(v[0], v[1], v[2]);
}

/**
 * The macro tint as a LUMINANCE-NORMALISED direction, blended halfway to white.
 * The old code multiplied by the tint itself, which is why the layer was mostly
 * a darkening: #4a2c38 is 3.6% luminance, so `mix(1, tint*1.7, 0.5)` is a 0.54
 * grey multiply wearing a hue. Normalising means the hue drift is a HUE drift —
 * colour variation within one material (§1.4), not an exposure cut hiding in a
 * colour uniform.
 */
function macroHueDirection(tint) {
  const lum = Math.max(1e-4, 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b);
  const k = 0.55;
  return new THREE.Vector3(
    1 + (tint.r / lum - 1) * k,
    1 + (tint.g / lum - 1) * k,
    1 + (tint.b / lum - 1) * k,
  );
}

// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------

/**
 * Patch a MeshStandardMaterial (or MeshPhysicalMaterial) in place.
 *
 * @param {THREE.Material} mat
 * @param {object} o
 *   variant       'environment' | 'character'
 *   ...any key of ENVIRONMENT_LOOK
 *   triplanar     false | true              world-space projection
 *   triScale      world units -> uv scale   (default 0.25 = 4m per tile)
 *   triSharp      blend sharpness           (default 6)
 *   detail        THREE.Texture             second-scale detail layer
 *   detailScale   multiplier on triScale/uv (default 7)
 *   detailStrength
 *   macro         THREE.Texture             very large scale variation
 *   macroScale    (default 0.018 = ~55m)
 *   macroStrength
 *   macroTint     hex — the hue the macro layer drifts toward
 *   variation     0..1 per-object colour jitter
 */
export function painterly(mat, o = {}) {
  if (!mat || mat.userData?.paint) return mat;
  const preset = o.variant === 'character' ? CHARACTER_LOOK : ENVIRONMENT_LOOK;
  const p = { ...preset, ...o };

  const U = {
    uRimColor:        { value: col(p.rimColor) },
    uRimDir:          { value: new THREE.Vector3(...p.rimDir).normalize() },
    uRimGate:         { value: new THREE.Vector2(p.rimGate[0], p.rimGate[1]) },
    uRimPower:        { value: p.rimPower },
    uRimStrength:     { value: p.rimStrength },
    uShadowTint:      { value: new THREE.Vector3(...p.shadowTint) },
    uShadowDepth:     { value: p.shadowDepth },
    uRampSoftness:    { value: p.rampSoftness },
    uRampStrength:    { value: p.rampStrength },
    uRampSteps:       { value: new THREE.Vector2(p.rampSteps[0], p.rampSteps[1]) },
    uRampLevels:      { value: new THREE.Vector3(...p.rampLevels) },
    uKeyRef:          { value: p.keyRef },
    uContourColor:    { value: col(p.contourColor) },
    uContourStrength: { value: p.contourStrength },
    uContourStart:    { value: p.contourStart },
    uVariation:       { value: p.variation || 0 },
    uVariationTint:   { value: col(p.variationTint) },
    uPaintTime:       { value: 0 },
    uLitGain:         { value: p.litGain ?? 1.0 },
    uAmbGain:         { value: p.ambGain ?? 1.0 },
    uSpecGain:        { value: p.specGain ?? 1.0 },
    uInkFloor:        { value: col(p.inkFloor ?? ENVIRONMENT_LOOK.inkFloor) },
    uInkFloorLevel:   { value: (p.inkFloorLevel ?? ENVIRONMENT_LOOK.inkFloorLevel) * (p.inkFloorGain ?? 1.0) },
    uInkFloorGate:    { value: p.inkFloorGate ?? ENVIRONMENT_LOOK.inkFloorGate },
    uHiKnee:          { value: p.hiKnee ?? 0.0 },
    uHiSlope:         { value: Math.max(0.05, p.hiSlope ?? 2.4) },
    uChroma:          { value: p.chroma ?? 1.0 },
    uRimTighten:      { value: p.rimTighten ?? 1.0 },
    uRimSuppress:     { value: new THREE.Vector3(...(p.rimSuppress || ENVIRONMENT_LOOK.rimSuppress)) },
    uRimSuppressK:    { value: p.rimSuppressK ?? ENVIRONMENT_LOOK.rimSuppressK },
    uShadowNeutral:   { value: p.shadowNeutral ?? 0.0 },
    uVertexHue:       { value: p.vertexHue ?? 1.0 },
  };

  // projection: 'uv' | 'planarY' (world XZ) | 'cylinderY' | 'triplanar'
  const proj = p.projection || (p.triplanar ? 'triplanar' : 'uv');
  const tri = proj === 'triplanar';
  const planar = proj === 'planarY';
  const cyl = proj === 'cylinderY';
  const worldProj = tri || planar || cyl;
  const useDetail = !!p.detail;
  const useMacro = !!p.macro;
  // Stochastic de-tiling: three rigidly ROTATED taps on a triangle lattice.
  // Only for the flat world projection — rotating a cylindrical unwrap would
  // destroy the horizontal ashlar courses it exists to preserve.
  const stoch = planar && (p.stochastic ?? 0.85) > 0;

  if (worldProj) {
    U.uTriScale = { value: p.triScale ?? 0.25 };
    U.uStoch = { value: stoch ? (p.stochastic ?? 0.85) : 0 };
    U.uCircScale = { value: p.circScale ?? 3.0 };
  }
  if (tri) U.uTriSharp = { value: p.triSharp ?? 6.0 };
  if (useDetail || useMacro) {
    const macroTint = col(p.macroTint || '#ffffff');
    const macroStrength = useMacro ? (p.macroStrength ?? 0.55) : 0;
    // AMPLITUDE IS NOW A SEPARATE KNOB FROM THE MEAN, and it has to be, because
    // the old `macroStrength` was doing both jobs at once and the variance half
    // of it was ~1% (see MACRO_LEGACY_MEAN). Reading the shipped strengths as a
    // drift amplitude directly would hand a recipe that never set one — and so
    // inherited 0.55 — a +-55% blotch it was never authored against. The legacy
    // MEAN still comes from macroStrength so no surface moves in average
    // brightness; the drift is capped unless a recipe opts in explicitly.
    const macroDrift = useMacro ? (p.macroDrift ?? Math.min(macroStrength, 0.24)) : 0;
    U.tPaintDetail    = { value: p.detail || null };
    U.tPaintMacro     = { value: p.macro || null };
    U.uDetailScale    = { value: p.detailScale ?? 7.0 };
    U.uDetailStrength = { value: useDetail ? (p.detailStrength ?? 0.55) : 0 };
    // Micro-relief and roughness break-up ride the detail fetch. Defaults are
    // deliberately non-zero: every world-projected surface in the game wants
    // them, and a surface that does not can set them to 0 in its recipe.
    U.uDetailBump     = { value: useDetail ? (p.detailBump ?? 0.50) : 0 };
    U.uDetailRough    = { value: useDetail ? (p.detailRough ?? 0.26) : 0 };
    U.uMacroScale     = { value: p.macroScale ?? 0.018 };
    U.uMacroStrength  = { value: macroDrift };
    U.uMacroTint      = { value: macroTint };
    U.uMacroLevel     = { value: macroLegacyLevel(macroTint, macroStrength, p.macroLevel) };
    U.uMacroTintDir   = { value: macroHueDirection(macroTint) };
    U.uMacroRough     = { value: useMacro ? (p.macroRough ?? 0.20) : 0 };
  }

  const key = [
    'paint3', o.variant || 'env', proj, stoch ? 's' : '-', useDetail ? 'd' : '-', useMacro ? 'm' : '-',
    p.variation ? 'v' : '-', p.contourStrength > 0 ? 'c' : '-',
  ].join(':');

  const DBG = (typeof window !== 'undefined' && window.__PAINT_DEBUG) || {};
  const prevOBC = mat.onBeforeCompile;

  mat.onBeforeCompile = (shader, renderer) => {
    if (prevOBC) { try { prevOBC(shader, renderer); } catch (e) { /* other agents' patches */ } }
    Object.assign(shader.uniforms, U);

    // ---- vertex ----------------------------------------------------------
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + VERT_BODY);

    // ---- fragment pars ---------------------------------------------------
    let pars = FRAG_PARS;
    if (tri) pars += FRAG_TRIPLANAR_PARS;
    else if (planar || cyl) pars += FRAG_PROJ_PARS;
    if (useDetail || useMacro) pars += FRAG_LAYER_PARS;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + pars);

    // ---- projection frame ------------------------------------------------
    // World coords / blend weights / de-tiling mask, established once before
    // any map is read so every channel stays in register.
    let frame = '';
    if (tri) frame = /* glsl */`
      vec3 pWP = vPaintWPos * uTriScale;
      vec3 pGN = normalize( vPaintWNrm );
      vec3 pBW = paintTriWeights( pGN );
    `;
    else if (planar) frame = /* glsl */`
      vec2 pUV = vPaintWPos.xz * uTriScale;
      paintStochFrame( pUV, dFdx( pUV ), dFdy( pUV ), uStoch );
    `;
    else if (cyl) frame = /* glsl */`
      // CYLINDRICAL UNWRAP. Triplanar on a fluted shaft blends continuously
      // between the X and Z planes as the surface curves, which drags an ashlar
      // bed into vertical smears that read as stained plywood. Unwrapping the
      // angle keeps the courses horizontal and the joints vertical. The angular
      // derivative is computed ANALYTICALLY so the atan branch cut does not
      // leave a mip seam down one side of every column.
      vec2 pRel = vPaintWPos.xz - vPaintOrig.xz;
      float pR2 = max( dot( pRel, pRel ), 1e-4 );
      vec2 pdRelX = dFdx( pRel ), pdRelY = dFdy( pRel );
      float pAng = atan( pRel.y, pRel.x );
      float pK = uCircScale * 0.15915494;                 // 1/(2*PI)
      vec2 pUV = vec2( pAng * pK, vPaintWPos.y * uTriScale )
               + paintHash22( floor( vPaintOrig.xz * 3.7 + 0.5 ) ) * vec2( 1.0, 4.0 );
      vec2 pDDX = vec2( ( pRel.x * pdRelX.y - pRel.y * pdRelX.x ) / pR2 * pK, dFdx( vPaintWPos.y ) * uTriScale );
      vec2 pDDY = vec2( ( pRel.x * pdRelY.y - pRel.y * pdRelY.x ) / pR2 * pK, dFdy( vPaintWPos.y ) * uTriScale );
      paintStochFrame( pUV, pDDX, pDDY, 0.0 );
    `;

    // one sampling expression shared by every channel
    const S = (tex, swiz = '') => {
      if (tri) return `paintTriSample( ${tex}, pWP, pBW, 1.0 )${swiz}`;
      if (planar || cyl) return `paintStochSample( ${tex} )${swiz}`;
      return null;
    };

    // ---- albedo ----------------------------------------------------------
    let mapFrag = frame;
    mapFrag += worldProj ? `
      #ifdef USE_MAP
        diffuseColor *= ${S('map')};
      #endif
    ` : `
      #include <map_fragment>
    `;
    if (useMacro) {
      // ── LARGE-SCALE VALUE + HUE DRIFT, WITH ENERGY WHERE THE EYE READS ─────
      // Three things changed here and each was measured, not guessed.
      //
      // (1) MEAN vs VARIANCE. The old expression folded a 0.85 exposure cut and
      //     a 1% ripple into one multiply (see MACRO_LEGACY_MEAN). uMacroLevel
      //     now carries that exact mean and `md` carries a real, zero-mean
      //     deviation — at the floor's strength 0.30 a +-30% value drift, 1-sigma
      //     about +-11%. Same average surface, an actual painted drift on it.
      //
      // (2) SCALE. The old octaves were 1x, 0.283x and 3.1x of macroScale: for
      //     the floor that is 80m, 283m and 26m. Across a 12m play frame the
      //     first two are a gradient and a constant, so nothing in the layer
      //     operated at the 3-10m band where a 17.9m plate's repeat is legible.
      //     8.9x and 23.5x put octaves at ~9m and ~3.4m on the floor (~1.5m and
      //     ~0.57m on the wall, which is weathering-patch scale).
      //
      // (3) PROJECTION. It sampled vPaintWPos.xz on EVERY surface, so on a
      //     vertical wall the entire macro layer was constant in Y — the one
      //     term that could break up a tall flat bay was a vertical smear.
      //     Triplanar materials now sample it triplanar.
      const M = (k, off) => (tri
        ? `paintTriSample( tPaintMacro, vPaintWPos * ( uMacroScale * ${k} ) + ${off}, pBW, 1.0 ).rgb`
        : `texture2D( tPaintMacro, vPaintWPos.xz * ( uMacroScale * ${k} ) + ${off} ).rgb`);
      mapFrag += /* glsl */`
        {
          vec3 mA = ${M('1.0', '0.0')};
          vec3 mB = ${M('8.9', '0.37')};
          vec3 mC = ${M('23.5', '-0.61')};
          float md = clamp( ( ( mA.r - 0.5 ) * 1.15 + ( mB.b - 0.5 ) * 0.80
                            + ( mC.b - 0.5 ) * 0.55 ) * 1.55, -1.0, 1.0 );
          gPaintMRough = ( mA.g - 0.5 ) * 1.10 + ( mB.g - 0.5 ) * 0.85;
          vec3 m = uMacroLevel * ( 1.0 + md * uMacroStrength );
          // the SHADED patches take the biome's hue; the lit ones stay on the
          // recipe's own colour. A wash that tinted both equally is a filter,
          // not weathering.
          m *= mix( vec3( 1.0 ), uMacroTintDir, clamp( -md, 0.0, 1.0 ) * uMacroStrength * 0.9 );
          diffuseColor.rgb *= m;
        }
      `;
    }
    if (useDetail) {
      const dcoord = tri ? null : (planar || cyl) ? 'pUV * uDetailScale' : 'vMapUv * uDetailScale';
      // planar / cylindrical projections read the detail through the
      // stochastic frame (identity taps when uStoch is 0, so the cylinder is
      // byte-identical to before); a plain uv material keeps the direct read
      const dTap = (s, off) => ((planar || cyl)
        ? `paintStochDetail( tPaintDetail, uDetailScale * ${s}, ${off} )`
        : `texture2D( tPaintDetail, ${dcoord} * ${s} + ${off} )`);
      // R is the value grain the albedo always used (byte-identical content, so
      // the painted tone is unchanged); GB and A are the micro-normal and the
      // roughness modulation that the same fetch now also carries.
      mapFrag += tri ? /* glsl */`
        {
          float dfade = 1.0 - smoothstep( 8.0, 40.0, length( vPaintWPos - cameraPosition ) );
          vec4 dS = paintTriSample( tPaintDetail, pWP, pBW, uDetailScale );
          diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( dS.r * 2.0 ), uDetailStrength * dfade );
          gPaintBump   = ( dS.gb - 0.5 ) * 2.0 * uDetailBump * dfade;
          gPaintDRough = ( dS.a - 0.5 ) * 2.0 * uDetailRough * dfade;
        }
      ` : `
        {
          // the detail layer has to survive to the WIDE camera: fading it out at
          // 34 units left the far floor carrying no high-frequency signal at all,
          // which is exactly the condition under which a short-lag autocorrelation
          // reads as a lattice
          float dfade = 1.0 - smoothstep( 16.0, 72.0, length( vPaintWPos - cameraPosition ) );
          vec4 dS = ${dTap('1.0', '0.0')};
          vec4 d2 = ${dTap('0.41', '0.27')};
          float dv = dS.r * 1.2 + d2.r * 0.8;                 // mean 1.0, as before
          diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( dv ), uDetailStrength * dfade );
          gPaintBump   = ( ( dS.gb - 0.5 ) + ( d2.gb - 0.5 ) * 0.45 ) * 2.0 * uDetailBump * dfade;
          gPaintDRough = ( ( dS.a - 0.5 ) * 0.70 + ( d2.a - 0.5 ) * 0.50 ) * 2.0 * uDetailRough * dfade;
        }
      `;
    }
    if (p.variation > 0) {
      mapFrag += /* glsl */`
        {
          float vh = paintHash13( floor( vPaintOrig * 2.37 ) + 0.5 );
          float vh2 = paintHash13( floor( vPaintOrig * 1.11 ) + 7.3 );
          diffuseColor.rgb *= mix( vec3( 1.0 ), uVariationTint * 1.7, ( vh - 0.5 ) * uVariation + 0.5 * uVariation );
          diffuseColor.rgb *= 1.0 + ( vh2 - 0.5 ) * uVariation * 0.55;
        }
      `;
    }
    if (!DBG.noMaps) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', mapFrag);

    // ---- vertex colour: VALUE always, HUE by consent ----------------------
    // A surface that receives vertex colours (the arena floor, the void skirt)
    // gets them from the world as a value glaze AND a hue push. The value half
    // is composition — pools, the island hump, the repoussoir crush — and it is
    // always applied in full. The hue half is a per-material decision: on the
    // Tartarus floor the world's k=0.88 push toward '#2b83c4' / '#ffb070'
    // multiplied a crimson albedo into 2-5m cyan and salmon patches that the
    // round-1 critique read as a colour blotch (§1.4 noise-slop) and that hid
    // every per-flag stroke under it. `vertexHue` lets a recipe keep the value
    // structure and take only a share of the chroma, so the painted per-stone
    // colour variation owns the surface again. Identity at 1.0 (the default —
    // no material moves unless its recipe asks).
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', /* glsl */`
      #if defined( USE_COLOR_ALPHA )
        vec3 pVC = vColor.rgb;
        diffuseColor.a *= vColor.a;
      #elif defined( USE_COLOR )
        vec3 pVC = vColor.rgb;
      #else
        vec3 pVC = vec3( 1.0 );
      #endif
      {
        float pVL = dot( pVC, vec3( 0.2126, 0.7152, 0.0722 ) );
        diffuseColor.rgb *= mix( vec3( pVL ), pVC, uVertexHue );
      }
    `);

    if (worldProj && !DBG.noMaps) {
      // gPaintBump is the detail layer's micro-relief, added AFTER normalScale
      // so a recipe that deliberately flattens its baked normal (the floor runs
      // 0.40) still gets brush-scale surface. It is what turns the detail layer
      // from a value grain painted on glass into something the key can catch.
      const normalFrag = tri ? /* glsl */`
            vec3 wn = paintTriNormal( normalMap, pWP, pBW, 1.0, pGN, normalScale );
            {
              // any stable tangent frame will do for an isotropic grain
              vec3 tUp = mix( vec3( 0.0, 1.0, 0.0 ), vec3( 1.0, 0.0, 0.0 ), step( 0.9, abs( wn.y ) ) );
              vec3 tU = normalize( cross( wn, tUp ) );
              vec3 tV = cross( wn, tU );
              wn = normalize( wn + tU * gPaintBump.x + tV * gPaintBump.y );
            }
      ` : cyl ? /* glsl */`
            vec3 mn = paintStochNormal( normalMap );
            mn.xy *= normalScale;
            mn.xy += gPaintBump;
            vec3 pN = normalize( vPaintWNrm );
            vec3 pT = cross( pN, vec3( 0.0, 1.0, 0.0 ) );
            float pTl = length( pT );
            pT = pTl > 1e-3 ? pT / pTl : vec3( 1.0, 0.0, 0.0 );
            vec3 pB = cross( pT, pN );
            vec3 wn = normalize( pT * mn.x + pB * mn.y + pN * mn.z );
      ` : /* glsl */`
            vec3 mn = paintStochNormal( normalMap );
            mn.xy *= normalScale;
            mn.xy += gPaintBump;
            vec3 wn = normalize( vec3( mn.x, mn.z, mn.y ) );
      `;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `
          #ifdef USE_NORMALMAP_TANGENTSPACE
            {
              ${normalFrag}
              normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
            }
          #else
            #include <normal_fragment_maps>
          #endif
        `)
        .replace('#include <roughnessmap_fragment>', `
          float roughnessFactor = roughness;
          #ifdef USE_ROUGHNESSMAP
            roughnessFactor *= ${S('roughnessMap', '.g')};
          #endif
          ${(useDetail || useMacro) ? `
          // §1.4: "roughness should vary as an ARTISTIC map, not as a physical
          // one." The baked ORM already varies with the height field, but every
          // recipe clamps it into a narrow band (the floor shipped min 0.78 /
          // max 0.99) so the whole plate is one sheen and reads as one
          // substance. Two extra bands of variation, from maps we are already
          // sampling: brush-scale dry/polished patches from the detail layer,
          // and weathering-scale ones from the macro layer. This is the
          // cheapest device in the file for making one material read as several.
          roughnessFactor = clamp(
            roughnessFactor * ( 1.0 + gPaintDRough + gPaintMRough * uMacroRough ), 0.045, 1.0 );
          ` : ''}
        `)
        .replace('#include <metalnessmap_fragment>', `
          float metalnessFactor = metalness;
          #ifdef USE_METALNESSMAP
            metalnessFactor *= ${S('metalnessMap', '.b')};
          #endif
        `)
        .replace('#include <emissivemap_fragment>', `
          #ifdef USE_EMISSIVEMAP
            totalEmissiveRadiance *= ${S('emissiveMap', '.rgb')};
          #endif
        `)
        .replace('#include <aomap_fragment>', `
          #ifdef USE_AOMAP
            float ambientOcclusion = ( ${S('aoMap', '.r')} - 1.0 ) * aoMapIntensity + 1.0;
            reflectedLight.indirectDiffuse *= ambientOcclusion;
            #if defined( USE_ENVMAP ) && defined( STANDARD )
              float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
              reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness );
            #endif
          #endif
        `);
    }

    // ---- 1+2. painted shading ramp --------------------------------------
    if (!DBG.noRamp) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_end>', /* glsl */`
      {
        // Recover a scalar "lit-ness" from the accumulated direct diffuse.
        // It already contains light colour, distance falloff AND shadow maps,
        // so ramping it hardens the shadow terminator too — exactly what a
        // painted shadow shape needs.
        vec3 pBase = max( material.diffuseColor, vec3( 0.03 ) );
        vec3 pIrr = reflectedLight.directDiffuse / pBase;
        float pLit = dot( pIrr, vec3( 0.2126, 0.7152, 0.0722 ) ) * PI;
        float k = clamp( pLit / max( uKeyRef, 1e-3 ), 0.0, 1.0 );
        gPaintLit = k;
        float r = paintRampCurve( k );
        float sc = clamp( mix( 1.0, r / max( k, 1e-3 ), uRampStrength ), 0.0, 3.0 );
        reflectedLight.directDiffuse *= sc * uLitGain;
        reflectedLight.directSpecular *= mix( 1.0, clamp( sc, 0.0, 1.6 ), 0.55 ) * uLitGain * uSpecGain;
      }
      #include <lights_fragment_end>
      {
        // §9.1 the floor is a DARK STAGE. Indirect light is what was actually
        // painting the ground plane periwinkle: a hemisphere is a uniform wash
        // and it lifts a 100%-up-facing surface harder than anything else in
        // the frame. Attenuating it per surface class is what lets the fill stay
        // rich on the architecture while the floor drops a full band.
        reflectedLight.indirectDiffuse  *= uAmbGain;
        reflectedLight.indirectSpecular *= uAmbGain * uSpecGain;
      }
      {
        // ── THE DIFFUSE SHOULDER (§4, §15) ─────────────────────────────────
        // uHiKnee is 0 on the environment preset, so this whole block is dead
        // code for every surface in the chamber. On the character it is the one
        // thing that gets the subject off AgX's bleach shoulder without taking a
        // single stop off the specular glint that §9.3 makes the frame's
        // highlight band. A max-norm compressor: the RATIO between the three
        // channels is exactly preserved, so it cannot shift a hue — it can only
        // stop a hue being thrown away by the transform downstream.
        if ( uHiKnee > 0.0 ) {
          vec3 dd = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
          float pv = max( max( dd.r, dd.g ), dd.b );
          float s = pv / uHiKnee;
          float c = ( s <= 1.0 ) ? s : ( 1.0 + log( 1.0 + ( s - 1.0 ) * uHiSlope ) / uHiSlope );
          float f = ( pv > 1e-5 ) ? ( c * uHiKnee / pv ) : 1.0;
          reflectedLight.directDiffuse   *= f;
          reflectedLight.indirectDiffuse *= f;
        }
      }
    `);

    // ---- 3+4. shadow tint, rim, contour ---------------------------------
    if (!DBG.noRim) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', /* glsl */`
      {
        vec3 pEm = totalEmissiveRadiance;
        vec3 pLitCol = outgoingLight - pEm;

        // (2) COLOURED SHADOWS — shadow is a hue shift, not a grey multiply.
        float shMask = 1.0 - smoothstep( 0.02, 0.55, gPaintLit );
        // uShadowNeutral is 0 on the environment preset: st is then the
        // authored tint, byte for byte. On the character it takes the B/R skew
        // off the tint while holding its LUMINANCE fixed, so the terminator
        // does not move and the shadow stays a rich violet instead of sliding
        // to blue-black (§1.3, §15.3).
        vec3 st = uShadowTint;
        if ( uShadowNeutral > 0.0 ) {
          float stl = dot( st, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 sn = mix( st, vec3( stl ), uShadowNeutral );
          float snl = max( dot( sn, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
          st = sn * ( stl / snl );
        }
        vec3 tint = mix( vec3( 1.0 ), st, shMask * uShadowDepth );
        pLitCol *= tint;

        // §15.1 CHROMA IS ADDED, NEVER REMOVED. Identity at uChroma 1.0, which
        // is the environment preset. Deliberately placed HERE — after the
        // shadow tint, before the rim — so it lifts the surface's own hue and
        // never amplifies the complement that is about to be added on top.
        if ( uChroma != 1.0 ) {
          float pcl = dot( pLitCol, vec3( 0.2126, 0.7152, 0.0722 ) );
          pLitCol = max( vec3( 0.0 ), mix( vec3( pcl ), pLitCol, uChroma ) );
        }

        // (3) ART-DIRECTED RIM — a constant, not a light.
        vec3 wN = normalize( inverseTransformDirection( normal, viewMatrix ) );
        vec3 wV = normalize( cameraPosition - vPaintWPos );
        float fres = pow( clamp( 1.0 - abs( dot( wN, wV ) ), 0.0, 1.0 ), uRimPower * uRimTighten );
        float gate = smoothstep( uRimGate.x, uRimGate.y, dot( wN, uRimDir ) );
        // GROUND PLANE VETO. A rim is a SILHOUETTE device: it belongs on the
        // contour of a standing form. On a 30m up-facing floor seen at a 52deg
        // pitch the fresnel term is large everywhere past mid-frame, so the
        // constant sprayed a cyan wash across the entire ground plane and turned
        // crimson stone into periwinkle vinyl. Kill it on anything facing up.
        gate *= 1.0 - smoothstep( 0.40, 0.86, wN.y );
        // §1.2 the rim is the COMPLEMENT of the key. Adding cyan on top of a
        // warm-lit surface just adds up to white — which is exactly what the
        // measured edges were: pale lavender, not #5fd0ff. A painted rim also
        // SUPPRESSES the key hue where it falls, so the complement stays
        // saturated instead of bleaching through the tonemap.
        // The rim belongs on the CONTOUR, which is exactly where the key also
        // falls on a convex form. Crushing it to 0.34 on lit pixels deleted it
        // from every silhouette it was authored for; 0.70 keeps it alive on a
        // lit arris while still letting the shadow side carry the strongest note.
        // THIS IS THE LEVER. rimK is the same fresnel band on both halves of a
        // convex form, so at 0.70 on lit pixels the constant was spending most
        // of its energy on the KEY-LIT contour — where it lands on top of a
        // salmon at two stops over middle grey and adds up to white. That white
        // arris is what three review rounds measured as "the rim is a slate
        // sheen, there is no third hue in the frame": the cool was being
        // delivered exactly where the transform is guaranteed to bleach it.
        // 1.16 / 0.70 inverts that. The shadow-side contour — dark, low
        // chroma, sitting in AgX's linear midrange where a saturated blue
        // survives intact — carries the accent, and the lit side keeps a
        // hairline instead of a halo. Same total energy, opposite distribution,
        // and it is the distribution the bible actually specifies (§1.2 "rim /
        // BACK light", §4 "it must vanish on lit edges").
        // TWO VALUES WERE VETOED BY THE WIDE SHOT, IN ORDER. 0.30 on the lit
        // half cut every lit contour in the chamber by 2.3x: the Cerberus
        // statuary went from a readable pale mass to a plum silhouette and the
        // frame mean fell 20% (44.6 -> 35.9). 0.52 plus a 2x lift on the presets
        // did not recover it either (35.5), which located the cause — the
        // statuary and the hero carry paintOverrides.rimStrength, so a preset
        // lift never reaches them and only shBoost does. The lit half therefore
        // stays exactly where it was at 0.70 and the whole redistribution is the
        // 1.16 on the SHADOW half: strictly additive, on the side of the form
        // §1.2 asks for, and it cannot take value out of the frame.
        float shBoost = mix( 1.16, 0.70, smoothstep( 0.05, 0.80, gPaintLit ) );
        float rimK = fres * gate * uRimStrength * shBoost;
        // RIM ENERGY IS ANCHORED TO THE RIG, not to a bare constant. The additive
        // term lives in SCENE-REFERRED space, so a bare 0.3 is one brightness at
        // exposure 2.9 and a completely different one at 1.2 — the rim would
        // silently vanish every time the grade or the rig was retuned. uKeyRef is
        // the irradiance a fully-lit surface receives, so uRimStrength now reads
        // as "fraction of full key", which is what an art director actually means.
        //
        // THE ANCHOR WAS THE BUG (round-4). 0.026 of the key reference is, at the
        // shipped rig (keyRef ~ 15.5 x 0.62 x 1.07 = 10.3), an additive of
        // 0.27 x rimK scene-linear against a lit stone sitting at ~0.5-1.5. On
        // the hero that put the cool term one to two stops UNDER the surface it
        // was supposed to draw on top of, so the only thing visible was the
        // multiplicative suppression below — which is a DESATURATION, not a hue.
        // That is why every review round measured the character edge as slate
        // grey-lavender and called the frame monochrome: there was no third
        // element, only warm and warm-with-the-red-taken-out.
        //
        // ...BUT RAISING THIS IS NOT THE FIX, AND THAT WAS MEASURED, NOT
        // ASSUMED. A 2.35x lift here (0.0611) was built, shipped to the live
        // page and looked at: the hero's contour went WHITE, not cyan — the
        // additive simply climbed past the point where AgX's shoulder bleaches
        // hue, which is the exact failure the 0.34 note above already records.
        // The energy was never the problem; the DISTRIBUTION was. The anchor
        // stays where entities/rig.js calibrated its per-slot 9.8-13.2 against,
        // and the cool is bought instead by shBoost below, which moves it off
        // the lit half of the form and on to the shadow-side contour where §1.2
        // and §4 put it in the first place.
        float rimE = rimK * uKeyRef * 0.026;
        // AgX's inset rotates saturated blue toward violet and bleaches anything
        // far over middle grey, so the mandated #5fd0ff arrived at the display
        // as a white-lavender edge. The PALETTE constant stays authoritative;
        // this only pre-compensates for a known property of the transform.
        //
        // WHAT THIS MULTIPLY ACTUALLY IS, and why it must not be removed blind:
        // it is the PRE-IMAGE operator, and entities/rig.js authors RIM_HEX
        // '#8fa4ff' as the pre-image of the spec's '#5fd0ff' under it — that pair
        // measures rgb(79,179,222), hue 198, at the display, which IS the spec.
        // A review round read the raw hex, called it authored-wrong, and
        // prescribed setting it to '#5fd0ff'; doing that WITH this multiply still
        // in place double-compensates and lands the hero's edge at hue ~176, a
        // green-cyan. Verified by arithmetic on both hexes before touching it.
        //
        // The operator is therefore LEFT EXACTLY AS AUTHORED, and the mirror bug
        // it exposed is fixed on the input side instead: render/lighting.js was
        // publishing the SPEC hex '#5fd0ff' to every world and enemy material,
        // which through this multiply arrives at hue ~176 — a green-cyan. So the
        // hero's edge and every other edge in the chamber were two different
        // hues both claiming to be the one mandated accent. RIGS.tartarus.rim
        // now publishes the same pre-image the hero uses. See lighting.js.
        vec3 rimC = uRimColor * vec3( 0.30, 1.22, 0.72 );
        // KEY SUPPRESSION IS NOT THE RIM. This multiply takes the warm out of
        // whatever the rim lands on so the complement is not just added to a
        // salmon and read as white. But at rimK * 5.0 it saturated across the
        // whole grazing half of the coat while the additive above was still a
        // whisper — i.e. the visible "rim" was a desaturating WASH with no hue in
        // it, which is exactly the "reads as sheen" failure. x3.2 still takes
        // the warm out of the contour but no longer saturates across the whole
        // grazing half, so the suppression cannot outrun the colour it exists to
        // protect. (x1.6 was tried and is too far the other way: it hands the
        // lit half back at full chroma and the hero reads as flat orange.)
        // (uRimSuppress / uRimSuppressK default to exactly the shipped
        // (0.42, 0.82, 1.06) and 3.2 — the environment is unchanged. The
        // character runs a gentler pair; see CHARACTER_LOOK.)
        pLitCol *= mix( vec3( 1.0 ), uRimSuppress, clamp( rimK * uRimSuppressK, 0.0, 1.0 ) );
        pLitCol += rimC * rimE;

        // (4) inner contour — a colour-shifted dark edge that dies in the light
        #if 1
        if ( uContourStrength > 0.0 ) {
          float cf = smoothstep( uContourStart, 1.0, 1.0 - abs( dot( wN, wV ) ) );
          float cm = cf * uContourStrength * ( 1.0 - smoothstep( 0.10, 0.55, gPaintLit ) ) * ( 1.0 - gate * 0.75 );
          pLitCol = mix( pLitCol, pLitCol * uContourColor * 2.0, clamp( cm, 0.0, 1.0 ) );
        }
        #endif

        // (5) THE INK FLOOR — §1.3 "shadow is a different COLOUR, never an
        // absence", §2's ink ramp bottoms at #07060f, and §9.7 wants shadow
        // SHAPES rather than stains. Measured on round 3: 4.7-8.8% of the
        // shipped frames were at literal rgb(0,0,0), in hard-edged slabs.
        // Gated on the surface's own outgoing value so it fills the void and
        // nothing else: at a tenth of key the gate is already shut, so this
        // cannot lift the ground plane (§9.1) or milk the frame (§7). It is
        // added BEFORE the emissive so a glowing bead still sits on top of ink.
        {
          float pv = dot( pLitCol, vec3( 0.2126, 0.7152, 0.0722 ) );
          // The gate is a FIXED scene-linear threshold, not a multiple of the
          // level: tying the two together meant raising the ink also widened
          // the set of pixels it touched, which is how a floor becomes a lift.
          // 0.030 is ~2 stops under AgX middle grey — a stone at even a tenth
          // of key is already past it.
          float voidK = 1.0 - smoothstep( 0.0, uInkFloorGate, pv );
          pLitCol += uInkFloor * ( uInkFloorLevel * voidK );
        }

        outgoingLight = pLitCol + pEm;
      }
      #include <opaque_fragment>
    `);

    mat.userData.paintShader = shader;
  };

  mat.customProgramCacheKey = () => key;
  mat.userData.paint = U;
  mat.userData.paintConfig = p;
  mat.needsUpdate = true;
  REGISTRY.add(mat);
  return mat;
}

// ---------------------------------------------------------------------------
// Runtime control
// ---------------------------------------------------------------------------

/** The live uniform bag for a patched material (or null). */
export function paintParams(mat) { return (mat && mat.userData && mat.userData.paint) || null; }

/**
 * Set one or more painterly uniforms on a material.
 *   setPaint(mat, { rimColor:'#33e0c0', rimStrength: 0.9 })
 */
export function setPaint(mat, values = {}) {
  const U = paintParams(mat);
  if (!U) return mat;
  for (const k in values) {
    const v = values[k];
    const u = U['u' + k[0].toUpperCase() + k.slice(1)];
    if (!u) continue;
    if (u.value && u.value.isColor) u.value.setRGB(...hexToRgb(v), THREE.SRGBColorSpace);
    else if (u.value && u.value.isVector3) Array.isArray(v) ? u.value.set(v[0], v[1], v[2]) : u.value.setScalar(v);
    else if (u.value && u.value.isVector2) Array.isArray(v) ? u.value.set(v[0], v[1]) : u.value.setScalar(v);
    else u.value = v;
  }
  return mat;
}

/**
 * Retune every patched material (or a given list) for a biome. This is the
 * one-call knob the world/lighting systems use when the player changes chamber.
 */
export function setBiomeLook(biome, list) {
  const B = BIOMES[biome] || BIOMES.tartarus;
  const targets = list || REGISTRY;
  for (const m of targets) {
    const U = paintParams(m);
    if (!U) continue;
    const isChar = m.userData.paintConfig && m.userData.paintConfig.variant === 'character';
    U.uRimColor.value.setRGB(...hexToRgb(B.rim), THREE.SRGBColorSpace);
    U.uRimDir.value.set(B.rimDir[0], B.rimDir[1], B.rimDir[2]).normalize();
    U.uShadowTint.value.set(B.shadowTint[0], B.shadowTint[1], B.shadowTint[2]);
    U.uContourColor.value.setRGB(...hexToRgb(B.contour), THREE.SRGBColorSpace);
    if (isChar) { U.uRimStrength.value = CHARACTER_LOOK.rimStrength; U.uRimGate.value.set(CHARACTER_LOOK.rimGate[0], CHARACTER_LOOK.rimGate[1]); }
  }
  return B;
}

/**
 * Publish the rig's key reference to EVERY patched material, cached or not.
 *
 * MaterialLibrary._applyRim only walks `this.cache`, which is correct for every
 * surface the library owns — but the hand-mounted arms in entities/
 * player-weapons.js are painterly-patched without ever entering that cache, so
 * they were the one class of character material whose ramp was anchored to the
 * 2.2 preset while the rig ran at ~16. Nothing else in the project calls
 * painterly() outside the library, so this is a superset of one.
 */
export function setKeyRefAll(v) {
  if (!(v > 0)) return;
  LAST_KEYREF = v;
  for (const m of REGISTRY) {
    const U = paintParams(m);
    if (U && U.uKeyRef) U.uKeyRef.value = v;
  }
}

/** The last key reference the light rig published (for materials built later). */
export function keyRef() { return LAST_KEYREF; }

/** Advance animated painterly uniforms. Called from MaterialLibrary.lateUpdate. */
export function updatePainterly(t) {
  GLOBAL_TIME = t;
  for (const m of REGISTRY) {
    const U = paintParams(m);
    if (U && U.uPaintTime) U.uPaintTime.value = t;
  }
}

export const painterlyRegistry = REGISTRY;
export const environmentLook = (o = {}) => ({ ...ENVIRONMENT_LOOK, ...o, variant: 'environment' });
export const characterLook = (o = {}) => ({ ...CHARACTER_LOOK, ...o, variant: 'character' });

export default { painterly, setPaint, setBiomeLook, setKeyRefAll, keyRef, updatePainterly, paintParams, environmentLook, characterLook };
