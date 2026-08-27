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
  rimPower: 1.6,
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
  rimStrength: 0.56,
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
};

export const CHARACTER_LOOK = {
  ...ENVIRONMENT_LOOK,
  // Retuned for a SMALL on-screen subject. At the shipping 3/4 camera the hero
  // is ~120px tall and a power-2.5 fresnel band is a couple of pixels wide —
  // it vanishes at the 1/8-resolution silhouette test §5 demands. Wider band,
  // hotter, and wrapped further round the form.
  rimPower: 1.5,
  rimStrength: 0.85,
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

float gPaintLit = 1.0;

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
`;

const FRAG_LAYER_PARS = /* glsl */`
uniform sampler2D tPaintDetail;
uniform sampler2D tPaintMacro;
uniform float uDetailScale;
uniform float uDetailStrength;
uniform float uMacroScale;
uniform float uMacroStrength;
uniform vec3  uMacroTint;
`;

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
    U.tPaintDetail    = { value: p.detail || null };
    U.tPaintMacro     = { value: p.macro || null };
    U.uDetailScale    = { value: p.detailScale ?? 7.0 };
    U.uDetailStrength = { value: useDetail ? (p.detailStrength ?? 0.55) : 0 };
    U.uMacroScale     = { value: p.macroScale ?? 0.018 };
    U.uMacroStrength  = { value: useMacro ? (p.macroStrength ?? 0.55) : 0 };
    U.uMacroTint      = { value: col(p.macroTint || '#ffffff') };
  }

  const key = [
    'paint2', o.variant || 'env', proj, stoch ? 's' : '-', useDetail ? 'd' : '-', useMacro ? 'm' : '-',
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
      // Large-scale value + hue drift. Two incommensurate scales so the drift
      // itself never repeats on the same period as the albedo.
      mapFrag += /* glsl */`
        {
          vec3 mc = texture2D( tPaintMacro, vPaintWPos.xz * uMacroScale ).rgb;
          vec3 m2 = texture2D( tPaintMacro, vPaintWPos.xz * uMacroScale * 0.283 + 0.31 ).rgb;
          vec3 m3 = texture2D( tPaintMacro, vPaintWPos.xz * uMacroScale * 3.1 - 0.62 ).rgb;
          vec3 m = ( mc * 0.5 + m2 * 0.34 + m3 * 0.16 ) * 2.0;
          m = mix( vec3( 1.0 ), m * mix( vec3( 1.0 ), uMacroTint * 1.7, 0.5 ), uMacroStrength );
          diffuseColor.rgb *= m;
        }
      `;
    }
    if (useDetail) {
      const dcoord = tri ? null : (planar || cyl) ? 'pUV * uDetailScale' : 'vMapUv * uDetailScale';
      mapFrag += tri ? /* glsl */`
        {
          float dfade = 1.0 - smoothstep( 8.0, 34.0, length( vPaintWPos - cameraPosition ) );
          vec3 d = paintTriSample( tPaintDetail, pWP, pBW, uDetailScale ).rgb * 2.0;
          diffuseColor.rgb *= mix( vec3( 1.0 ), d, uDetailStrength * dfade );
        }
      ` : `
        {
          // the detail layer has to survive to the WIDE camera: fading it out at
          // 34 units left the far floor carrying no high-frequency signal at all,
          // which is exactly the condition under which a short-lag autocorrelation
          // reads as a lattice
          float dfade = 1.0 - smoothstep( 16.0, 66.0, length( vPaintWPos - cameraPosition ) );
          vec3 d = texture2D( tPaintDetail, ${dcoord} ).rgb * 2.0;
          vec3 d2 = texture2D( tPaintDetail, ${dcoord} * 0.41 + 0.27 ).rgb * 2.0;
          diffuseColor.rgb *= mix( vec3( 1.0 ), d * 0.6 + d2 * 0.4, uDetailStrength * dfade );
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

    if (worldProj && !DBG.noMaps) {
      const normalFrag = tri ? /* glsl */`
            vec3 wn = paintTriNormal( normalMap, pWP, pBW, 1.0, pGN, normalScale );
      ` : cyl ? /* glsl */`
            vec3 mn = paintStochNormal( normalMap );
            mn.xy *= normalScale;
            vec3 pN = normalize( vPaintWNrm );
            vec3 pT = cross( pN, vec3( 0.0, 1.0, 0.0 ) );
            float pTl = length( pT );
            pT = pTl > 1e-3 ? pT / pTl : vec3( 1.0, 0.0, 0.0 );
            vec3 pB = cross( pT, pN );
            vec3 wn = normalize( pT * mn.x + pB * mn.y + pN * mn.z );
      ` : /* glsl */`
            vec3 mn = paintStochNormal( normalMap );
            mn.xy *= normalScale;
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
        reflectedLight.directSpecular *= mix( 1.0, clamp( sc, 0.0, 1.6 ), 0.55 ) * uLitGain;
      }
      #include <lights_fragment_end>
      {
        // §9.1 the floor is a DARK STAGE. Indirect light is what was actually
        // painting the ground plane periwinkle: a hemisphere is a uniform wash
        // and it lifts a 100%-up-facing surface harder than anything else in
        // the frame. Attenuating it per surface class is what lets the fill stay
        // rich on the architecture while the floor drops a full band.
        reflectedLight.indirectDiffuse  *= uAmbGain;
        reflectedLight.indirectSpecular *= uAmbGain;
      }
    `);

    // ---- 3+4. shadow tint, rim, contour ---------------------------------
    if (!DBG.noRim) shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', /* glsl */`
      {
        vec3 pEm = totalEmissiveRadiance;
        vec3 pLitCol = outgoingLight - pEm;

        // (2) COLOURED SHADOWS — shadow is a hue shift, not a grey multiply.
        float shMask = 1.0 - smoothstep( 0.02, 0.55, gPaintLit );
        vec3 tint = mix( vec3( 1.0 ), uShadowTint, shMask * uShadowDepth );
        pLitCol *= tint;

        // (3) ART-DIRECTED RIM — a constant, not a light.
        vec3 wN = normalize( inverseTransformDirection( normal, viewMatrix ) );
        vec3 wV = normalize( cameraPosition - vPaintWPos );
        float fres = pow( clamp( 1.0 - abs( dot( wN, wV ) ), 0.0, 1.0 ), uRimPower );
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
        float shBoost = mix( 1.0, 0.70, smoothstep( 0.05, 0.80, gPaintLit ) );
        float rimK = fres * gate * uRimStrength * shBoost;
        // RIM ENERGY IS ANCHORED TO THE RIG, not to a bare constant. The additive
        // term lives in SCENE-REFERRED space, so a bare 0.3 is one brightness at
        // exposure 2.9 and a completely different one at 1.2 — the rim would
        // silently vanish every time the grade or the rig was retuned. uKeyRef is
        // the irradiance a fully-lit surface receives, so uRimStrength now reads
        // as "fraction of full key", which is what an art director actually means.
        float rimE = rimK * uKeyRef * 0.026;
        // AgX's inset rotates saturated blue toward violet and bleaches anything
        // far over middle grey, so the mandated #5fd0ff arrived at the display
        // as a white-lavender edge. The PALETTE constant stays authoritative;
        // this only pre-compensates for a known property of the transform.
        vec3 rimC = uRimColor * vec3( 0.30, 1.22, 0.72 );
        pLitCol *= mix( vec3( 1.0 ), vec3( 0.42, 0.82, 1.06 ), clamp( rimK * 5.0, 0.0, 1.0 ) );
        pLitCol += rimC * rimE;

        // (4) inner contour — a colour-shifted dark edge that dies in the light
        #if 1
        if ( uContourStrength > 0.0 ) {
          float cf = smoothstep( uContourStart, 1.0, 1.0 - abs( dot( wN, wV ) ) );
          float cm = cf * uContourStrength * ( 1.0 - smoothstep( 0.10, 0.55, gPaintLit ) ) * ( 1.0 - gate * 0.75 );
          pLitCol = mix( pLitCol, pLitCol * uContourColor * 2.0, clamp( cm, 0.0, 1.0 ) );
        }
        #endif

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

export default { painterly, setPaint, setBiomeLook, updatePainterly, paintParams, environmentLook, characterLook };
