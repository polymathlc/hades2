// OWNER: AGENT-MODEL — the CHARACTER shader (ART_DIRECTION §1.2, §4).
// ---------------------------------------------------------------------------
// Every character, enemy, boss and hand-held arm is patched through here, on
// top of whatever materials/painterly.js already did to the material. The
// painterly patch owns the ink shadow, the maps and the key reference; this
// file owns the four things §4 lists for a character and nothing else:
//
//   1. A CONSTANT COLOURED RIM driven by a FIXED WORLD DIRECTION, not a scene
//      light. Fresnel-driven, additive, hue = the complement of the biome key
//      (Tartarus #5fd0ff, Asphodel #33e0c0, Elysium #ff5fa8). It is strongest
//      on the shadow-side contour and still a visible hairline on lit edges.
//      The base colour is pulled down under the rim so the complement stays a
//      HUE instead of adding up to white through the tonemapper.
//   2. A soft 2-3 step PAINTED RAMP near the terminator. Applied to the direct
//      share of the outgoing light only, so the ambient/ink side is untouched.
//   3. A thin COLOUR-SHIFTED INNER CONTOUR in the shadow-ramp colour that dies
//      on lit edges and under the rim.
//   4. A small, sharp SPECULAR GLINT — metal slots only.
//
// It also owns the HURT FLASH: `flashVariant(mat)` hands back a twin of the
// material with uChrFlash = 1, which brightens the base and paints the rim
// colour on the contour instead of swapping the body for a white cut-out. The
// twin shares every uniform object with its source (so biome retunes and the
// key reference reach it) and the same program cache key (so it costs no new
// shader program).
//
// painterly.js's own rim, key-suppression, contour and ramp are neutralised at
// the GLSL level when this patch is present — string replacements on the
// compiled source — so no amount of uniform churn (retune(), setBiomeLook(),
// familyRim()) can bring a second rim back on top of this one.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/** rim hue per biome: the complement of the key (§1.2) */
export const CHARACTER_RIM = {
  tartarus: '#5fd0ff',
  asphodel: '#33e0c0',
  elysium: '#ff5fa8',
};
/** shadow-ramp colour per biome — the contour is drawn in it */
export const CHARACTER_CONTOUR = {
  tartarus: '#241238',
  asphodel: '#1a1f3a',
  elysium: '#2a1436',
};
/**
 * The fixed WORLD direction the rim reads from. The shipping camera sits at
 * +X+Z (yaw 45) and its right vector is (0.707, 0, -0.707); the key comes from
 * screen-left, so the rim lives on the screen-RIGHT contour and over the top,
 * where the key is not.
 */
export const CHARACTER_RIM_DIR = [0.60, 0.46, -0.66];

const REGISTRY = new Set();
let _biome = 'tartarus';
const _c = new THREE.Color();

const lin = (hex) => new THREE.Color().setStyle(hex);

function rimHexFor(biome) { return CHARACTER_RIM[biome] || CHARACTER_RIM.tartarus; }
function contourHexFor(biome) { return CHARACTER_CONTOUR[biome] || CHARACTER_CONTOUR.tartarus; }

/** Resolve one material's effective rim colour: biome complement, tinted toward its family hue. */
function resolveRim(mat) {
  const U = mat.userData.charU;
  if (!U) return;
  const o = mat.userData.charOpts || {};
  U.uChrRimColor.value.setStyle(rimHexFor(_biome));
  if (o.familyRim) {
    _c.setStyle(o.familyRim);
    U.uChrRimColor.value.lerp(_c, o.familyMix ?? 0.35);
  }
  U.uChrFlashColor.value.copy(U.uChrRimColor.value).lerp(_c.set(1, 1, 1), 0.45);
  U.uChrContourColor.value.setStyle(contourHexFor(_biome));
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
const VERT_PARS = /* glsl */`
varying vec3 vChrWPos;
`;
const VERT_BODY = /* glsl */`
{
  vec4 chrP = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    chrP = instanceMatrix * chrP;
  #endif
  vChrWPos = ( modelMatrix * chrP ).xyz;
}
`;
const FRAG_PARS = /* glsl */`
varying vec3 vChrWPos;
uniform vec3  uChrRimColor;
uniform vec3  uChrRimDir;
uniform float uChrRimStrength;
uniform float uChrRimPower;
uniform vec2  uChrRimGate;
uniform vec2  uChrRampSteps;
uniform vec3  uChrRampLevels;
uniform float uChrRampSoft;
uniform float uChrRampStrength;
uniform vec3  uChrContourColor;
uniform float uChrContourStrength;
uniform float uChrContourStart;
uniform float uChrSpec;
uniform float uChrFlash;
uniform vec3  uChrFlashColor;
uniform float uChrKeyRef;
float chrLuma( vec3 c ){ return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;
const FRAG_BODY = /* glsl */`
{
  vec3 chrEm = totalEmissiveRadiance;
  vec3 chrCol = outgoingLight - chrEm;
  vec3 chrN = normalize( inverseTransformDirection( normal, viewMatrix ) );
  vec3 chrV = normalize( cameraPosition - vChrWPos );
  float chrNdV = clamp( dot( chrN, chrV ), 0.0, 1.0 );

  // ---- lit-ness (0 = full shadow, 1 = facing the key at full irradiance) --
  #ifdef CHR_PAINT
    float chrLit = gPaintLit;
  #else
    vec3 chrBase = max( diffuseColor.rgb, vec3( 0.03 ) );
    float chrLit = clamp( chrLuma( reflectedLight.directDiffuse / chrBase ) * PI / max( uChrKeyRef, 1e-3 ), 0.0, 1.0 );
  #endif

  // ---- (2) painted 2-3 step ramp on the DIRECT share ----------------------
  {
    float s = max( uChrRampSoft, 0.01 );
    float a = smoothstep( uChrRampSteps.x - s, uChrRampSteps.x + s, chrLit );
    float b = smoothstep( uChrRampSteps.y - s, uChrRampSteps.y + s * 1.4, chrLit );
    float q = mix( mix( uChrRampLevels.x, uChrRampLevels.y, a ), uChrRampLevels.z, b );
    q *= smoothstep( 0.0, 0.05, chrLit );
    float rk = clamp( mix( 1.0, q / max( chrLit, 0.02 ), uChrRampStrength ), 0.0, 2.2 );
    float dl = chrLuma( reflectedLight.directDiffuse + reflectedLight.directSpecular );
    float share = clamp( dl / max( chrLuma( chrCol ), 1e-4 ), 0.0, 1.0 );
    chrCol *= mix( 1.0, rk, share );
  }

  // ---- (4) metal glint: small, bright, sharp ------------------------------
  #if NUM_DIR_LIGHTS > 0
  if ( uChrSpec > 0.0 ) {
    vec3 chrL = normalize( inverseTransformDirection( directionalLights[ 0 ].direction, viewMatrix ) );
    vec3 chrH = normalize( chrV + chrL );
    float g = pow( max( dot( chrN, chrH ), 0.0 ), 160.0 );
    chrCol += g * uChrSpec * uChrKeyRef * 0.05 * smoothstep( 0.03, 0.30, chrLit ) * mix( diffuseColor.rgb, vec3( 1.0 ), 0.55 );
  }
  #endif

  // ---- (1) the constant rim: fixed world direction, fresnel, additive -----
  float chrFres = pow( 1.0 - chrNdV, uChrRimPower );
  float chrGate = smoothstep( uChrRimGate.x, uChrRimGate.y, dot( chrN, uChrRimDir ) );
  float chrRimK = chrFres * chrGate * uChrRimStrength * mix( 1.0, 0.58, smoothstep( 0.10, 0.85, chrLit ) );
  chrRimK = clamp( chrRimK, 0.0, 1.0 );
  vec3 chrRimC = uChrRimColor * ( uChrKeyRef * 0.085 );
  chrCol = chrCol * ( 1.0 - 0.60 * chrRimK ) + chrRimC * chrRimK;

  // ---- (3) inner contour in the shadow-ramp colour, dying in the light ----
  {
    float cf = smoothstep( uChrContourStart, 1.0, 1.0 - chrNdV );
    float cm = cf * uChrContourStrength * ( 1.0 - smoothstep( 0.08, 0.50, chrLit ) ) * ( 1.0 - chrGate * 0.85 );
    chrCol = mix( chrCol, chrCol * uChrContourColor * 2.0, clamp( cm, 0.0, 1.0 ) );
  }

  // ---- hurt flash: brightened base + rim-coloured outline -----------------
  if ( uChrFlash > 0.0 ) {
    float e = pow( 1.0 - chrNdV, 1.5 );
    vec3 fl = chrCol * 2.6 + uChrFlashColor * uChrKeyRef * ( 0.012 + 0.14 * e );
    chrCol = mix( chrCol, fl, uChrFlash );
  }
  outgoingLight = chrCol + chrEm;
}
#include <opaque_fragment>
`;

// painterly.js lines that would put a second rim / ramp / contour on top
const NEUTRALISE = [
  ['float sc = clamp( mix( 1.0, r / max( k, 1e-3 ), uRampStrength ), 0.0, 3.0 );', 'float sc = 1.0;'],
  ['float rimE = rimK * uKeyRef * 0.026;', 'float rimE = 0.0;'],
  ['pLitCol *= mix( vec3( 1.0 ), uRimSuppress, clamp( rimK * uRimSuppressK, 0.0, 1.0 ) );', ''],
  ['if ( uContourStrength > 0.0 ) {', 'if ( false ) {'],
];

function patchShader(shader, U) {
  Object.assign(shader.uniforms, U);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_BODY);
  let f = shader.fragmentShader;
  const hasPaint = f.indexOf('gPaintLit') >= 0;
  for (const [a, b] of NEUTRALISE) f = f.replace(a, b);
  f = f.replace('#include <common>', '#include <common>\n' + (hasPaint ? '#define CHR_PAINT\n' : '') + FRAG_PARS);
  f = f.replace('#include <opaque_fragment>', FRAG_BODY);
  shader.fragmentShader = f;
}

// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------
/**
 * Patch a character material in place. Idempotent.
 *
 * @param mat  a MeshStandardMaterial (painterly-patched or not)
 * @param o    { metal, glow, rimStrength, rimPower, contourStrength, familyRim, familyMix }
 */
export function characterShader(mat, o = {}) {
  if (!mat || !mat.isMaterial) return mat;
  if (mat.userData.charU) { setCharacterRim(mat, o); return mat; }
  const paint = mat.userData.paint || null;
  const metal = !!o.metal;
  const glow = !!o.glow;
  const U = {
    uChrRimColor:        { value: lin(rimHexFor(_biome)) },
    uChrRimDir:          { value: new THREE.Vector3(...(o.rimDir || CHARACTER_RIM_DIR)).normalize() },
    uChrRimStrength:     { value: o.rimStrength ?? (glow ? 0.45 : metal ? 0.95 : 1.0) },
    uChrRimPower:        { value: o.rimPower ?? (metal ? 2.6 : 2.2) },
    uChrRimGate:         { value: new THREE.Vector2(-0.30, 0.55) },
    uChrRampSteps:       { value: new THREE.Vector2(0.20, 0.56) },
    uChrRampLevels:      { value: new THREE.Vector3(0.14, 0.55, 1.0) },
    uChrRampSoft:        { value: 0.06 },
    uChrRampStrength:    { value: o.rampStrength ?? (glow ? 0.0 : 0.72) },
    uChrContourColor:    { value: lin(contourHexFor(_biome)) },
    uChrContourStrength: { value: o.contourStrength ?? (glow ? 0.0 : metal ? 0.55 : 0.80) },
    uChrContourStart:    { value: 0.58 },
    uChrSpec:            { value: metal ? (o.spec ?? 1.0) : 0.0 },
    uChrFlash:           { value: 0.0 },
    uChrFlashColor:      { value: lin('#ffffff') },
    // the key reference is SHARED with painterly's uniform object when there
    // is one, so MaterialLibrary.setRim()/setKeyRefAll() reach us for free.
    uChrKeyRef:          paint && paint.uKeyRef ? paint.uKeyRef : { value: 10.3 },
  };
  mat.userData.charU = U;
  mat.userData.charOpts = { familyRim: o.familyRim || null, familyMix: o.familyMix ?? 0.35 };
  resolveRim(mat);

  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  const prevIsOwn = Object.prototype.hasOwnProperty.call(mat, 'onBeforeCompile');
  // `this` is the material three is compiling for — the source or a flash
  // twin — so each reads its OWN uniform bag while sharing the painterly one.
  mat.onBeforeCompile = function (shader, renderer) {
    if (prevIsOwn && prev) { try { prev.call(this, shader, renderer); } catch (e) { /* other patches */ } }
    patchShader(shader, this.userData.charU);
  };
  mat.customProgramCacheKey = function () {
    const k = (typeof prevKey === 'function') ? prevKey.call(this) : '';
    return k + '|chr1';
  };
  mat.needsUpdate = true;
  REGISTRY.add(mat);
  return mat;
}

/** Re-point one material's family rim (hue mixed 35% into the biome complement). */
export function setCharacterRim(mat, o = {}) {
  const U = mat && mat.userData && mat.userData.charU;
  if (!U) return mat;
  const co = mat.userData.charOpts || (mat.userData.charOpts = {});
  if (o.familyRim !== undefined) co.familyRim = o.familyRim;
  if (o.familyMix !== undefined) co.familyMix = o.familyMix;
  if (o.rimStrength != null) U.uChrRimStrength.value = o.rimStrength;
  if (o.rimPower != null) U.uChrRimPower.value = o.rimPower;
  if (o.contourStrength != null) U.uChrContourStrength.value = o.contourStrength;
  if (o.rimDir) U.uChrRimDir.value.set(o.rimDir[0], o.rimDir[1], o.rimDir[2]).normalize();
  resolveRim(mat);
  return mat;
}

/** Switch every character material to a biome's rim complement. */
export function setCharacterBiome(name) {
  _biome = CHARACTER_RIM[name] ? name : 'tartarus';
  for (const m of REGISTRY) resolveRim(m);
  return _biome;
}
export function characterBiome() { return _biome; }

/** The live uniform bag of a patched material, or null. */
export function characterParams(mat) { return (mat && mat.userData && mat.userData.charU) || null; }

/**
 * The material's HURT-FLASH twin: same maps, same painterly bag, same program
 * key, uChrFlash pinned to 1. Cached on the source.
 */
export function flashVariant(mat) {
  if (!mat || !mat.userData || !mat.userData.charU) return mat;
  if (mat.userData.charFlash) return mat.userData.charFlash;
  const ud = mat.userData;
  mat.userData = {};                      // keep clone() from JSON-walking the uniform bags
  let t;
  try { t = mat.clone(); } finally { mat.userData = ud; }
  t.onBeforeCompile = mat.onBeforeCompile;
  t.customProgramCacheKey = mat.customProgramCacheKey;
  const U2 = Object.assign({}, ud.charU, { uChrFlash: { value: 1.0 } });
  t.userData = Object.assign({}, ud, { charU: U2, charFlash: null, charTwinOf: mat });
  t.name = (mat.name || 'character') + '.flash';
  t.needsUpdate = true;
  ud.charFlash = t;
  return t;
}

/** Flash twins for a material or a material array (cached). */
export function flashVariants(m) {
  if (Array.isArray(m)) {
    const key = '__chrFlashArr';
    if (m[key]) return m[key];
    const out = m.map(flashVariant);
    Object.defineProperty(m, key, { value: out, enumerable: false });
    return out;
  }
  return flashVariant(m);
}

export const characterRegistry = REGISTRY;
export default { characterShader, setCharacterRim, setCharacterBiome, characterBiome, characterParams, flashVariant, flashVariants, CHARACTER_RIM, CHARACTER_RIM_DIR };
