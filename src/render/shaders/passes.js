// OWNER: AGENT-RENDER — every fragment shader in the EREBUS post chain.
import { COMMON, DEPTH, AGX } from './lib.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ambient occlusion — normal-oriented hemisphere (GTAO-family) straight off
//    the depth buffer. Normals are reconstructed with a best-edge 4-tap so the
//    silhouettes of the filigree stay clean.
// ─────────────────────────────────────────────────────────────────────────────
export const AO_FRAG = /* glsl */`
precision highp float;
${COMMON}
${DEPTH}
uniform sampler2D tDepth;
uniform vec2  uTexel;      // 1/aoResolution
uniform mat4  uProj;
uniform mat4  uInvProj;
uniform float uNear, uFar;
uniform float uRadius;     // world-space radius
uniform float uBias;
uniform float uPower;
varying vec2 vUv;

vec3 viewAt(vec2 uv){
  float d = texture2D(tDepth, uv).x;
  return viewFromDepth(uv, d, uInvProj);
}

void main(){
  float d = texture2D(tDepth, vUv).x;
  if(d >= 0.99999){ gl_FragColor = vec4(1.0); return; }

  vec3 c = viewFromDepth(vUv, d, uInvProj);

  // reconstruct a normal, choosing the neighbour pair with the smaller depth step
  vec3 pl = viewAt(vUv - vec2(uTexel.x, 0.0));
  vec3 pr = viewAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pd = viewAt(vUv - vec2(0.0, uTexel.y));
  vec3 pu = viewAt(vUv + vec2(0.0, uTexel.y));
  vec3 dx = (abs(pr.z - c.z) < abs(c.z - pl.z)) ? (pr - c) : (c - pl);
  vec3 dy = (abs(pu.z - c.z) < abs(c.z - pd.z)) ? (pu - c) : (c - pd);
  vec3 n = normalize(cross(dx, dy));
  if(dot(n, normalize(-c)) < 0.0) n = -n;

  // world radius -> uv radius at this depth
  vec2 rUV = vec2(uProj[0][0], uProj[1][1]) * 0.5 * uRadius / max(0.05, -c.z);
  rUV = min(rUV, vec2(0.12));           // clamp so near-camera pixels don't thrash the cache

  float rot = ign(gl_FragCoord.xy) * TAU;
  float occ = 0.0;
  float total = 0.0;

  for(int i = 0; i < AO_DIRS; i++){
    float a = rot + float(i) * (TAU / float(AO_DIRS));
    vec2 dir = vec2(cos(a), sin(a));
    for(int j = 1; j <= AO_STEPS; j++){
      float t = (float(j) - 0.5 + 0.5 * hash12(gl_FragCoord.xy + float(i * 7 + j))) / float(AO_STEPS);
      t = t * t;                        // bias samples toward the contact point
      vec2 suv = vUv + dir * rUV * t;
      if(suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      float sd = texture2D(tDepth, suv).x;
      if(sd >= 0.99999) { total += 1.0; continue; }
      vec3 sp = viewFromDepth(suv, sd, uInvProj);
      vec3 v = sp - c;
      float len = length(v);
      if(len < 1e-4){ total += 1.0; continue; }
      float ndv = dot(n, v / len);
      float att = clamp(1.0 - len / uRadius, 0.0, 1.0);
      occ += max(0.0, ndv - uBias) * att * att;
      total += 1.0;
    }
  }

  float ao = 1.0 - occ / max(1.0, total);
  ao = pow(clamp(ao, 0.0, 1.0), uPower);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Depth-aware separable blur for the AO buffer.
// ─────────────────────────────────────────────────────────────────────────────
export const AO_BLUR_FRAG = /* glsl */`
precision highp float;
${COMMON}
${DEPTH}
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2  uDir;        // (1/w,0) or (0,1/h)
uniform float uNear, uFar;
uniform float uSharpness;
varying vec2 vUv;
void main(){
  float dc = linearDepth(texture2D(tDepth, vUv).x, uNear, uFar);
  float sum = 0.0, wsum = 0.0;
  for(int i = -4; i <= 4; i++){
    float fi = float(i);
    vec2 uv = vUv + uDir * fi;
    float s = texture2D(tAO, uv).r;
    float dz = linearDepth(texture2D(tDepth, uv).x, uNear, uFar) - dc;
    float w = exp(-fi * fi * 0.12) * exp(-dz * dz * uSharpness);
    sum += s * w; wsum += w;
  }
  float o = sum / max(1e-4, wsum);
  gl_FragColor = vec4(o, o, o, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Atmosphere composite — coloured (ink-tinted) AO + analytic exponential
//    height fog + the distance-haze band the bible demands.
// ─────────────────────────────────────────────────────────────────────────────
export const ATMOS_FRAG = /* glsl */`
precision highp float;
${COMMON}
${DEPTH}
uniform sampler2D tScene;
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform mat4  uInvViewProj;
uniform vec3  uCamPos;
uniform float uNear, uFar;
// AO
uniform vec3  uInk;
uniform float uAOAmount;
uniform float uAOEnabled;
// fog
uniform float uFogEnabled;
uniform vec3  uFogNear, uFogFar;
uniform float uFogDensity, uFogFalloff, uFogBase;
uniform float uVoidFog, uArenaR;
uniform vec3  uKeyDir, uKeyColor;
uniform float uScatter;
// haze
uniform vec3  uHaze;
uniform float uHazeStart, uHazeEnd, uHazeDesat, uHazeAmount;
uniform float uVoidSky;
varying vec2 vUv;

void main(){
  vec3 col = texture2D(tScene, vUv).rgb;
  float d  = texture2D(tDepth, vUv).x;

  if(d < 0.99999){
    // ── ink-coloured ambient occlusion ────────────────────────────────────
    if(uAOEnabled > 0.5){
      float ao = texture2D(tAO, vUv).r;
      float k  = mix(1.0, ao, uAOAmount);
      col *= mix(uInk, vec3(1.0), k);
    }

    vec3 wp   = worldFromDepth(vUv, d, uInvViewProj);
    vec3 ray  = wp - uCamPos;
    float dist = length(ray);
    vec3 rd   = ray / max(dist, 1e-4);

    if(uFogEnabled > 0.5){
      // ── analytic exponential height fog ─────────────────────────────────
      float b  = uFogFalloff;
      float ry = rd.y * b;
      float t  = (abs(ry) < 1e-3) ? dist : (1.0 - exp(-dist * ry)) / ry;
      float fi = uFogDensity * exp(-b * (uCamPos.y - uFogBase)) * t;

      // the void beyond and below the arena is much thicker
      float outside = smoothstep(uArenaR * 0.85, uArenaR * 2.2, length(wp.xz));
      float below   = smoothstep(0.0, -7.0, wp.y);
      fi += (outside * 0.65 + below * 0.9) * uVoidFog * min(dist * 0.06, 2.5);

      float f = 1.0 - exp(-max(0.0, fi));
      float ph = pow(max(0.0, dot(rd, -uKeyDir)), 5.0);
      vec3 fc = mix(uFogNear, uFogFar, clamp(dist / 80.0, 0.0, 1.0)) + uKeyColor * ph * uScatter;
      col = mix(col, fc, clamp(f, 0.0, 1.0));
    }

    // ── distance haze: push the far band low-value / low-chroma ───────────
    float h = smoothstep(uHazeStart, uHazeEnd, dist) * uHazeAmount;
    if(h > 0.001){
      float l = luma(col);
      col = mix(col, vec3(l), uHazeDesat * h);
      col = mix(col, uHaze, h * 0.72);
    }
  } else {
    // ── the VOID is not #000 ────────────────────────────────────────────────
    // §1.1 wants the background LOW and HAZED and §1.8 wants an island of light,
    // not a die-cut. With nothing behind the arena the silhouette met dead black
    // at a razor edge over 30% of the frame. An authored vertical gradient plus
    // a broad horizon band gives the arena something to dissolve into.
    vec3 far4 = worldFromDepth(vUv, 0.9999, uInvViewProj);
    vec3 rd = normalize(far4 - uCamPos);
    float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
    float horizon = exp(-pow((up - 0.50) * 5.2, 2.0));
    // THE VOID IS A PAINTED BAND, NOT A HOLE (§1.1 "background LOW value, LOW
    // chroma, and HAZED"; §9.4 three separated bands). It used to be built from
    // uFogFar, which is the SURFACE fog colour and therefore has to stay very
    // dark or it becomes a brightness pedestal on every lit surface in the
    // frame. Driving the void off uHaze instead decouples the two: the haze
    // colour is only ever seen at distance, so it can carry a real value while
    // the surface fog stays a whisper. Below the horizon the band darkens, which
    // is what keeps the bottom of frame the darkest third.
    vec3 sky = mix(uHaze * 0.62, uHaze, smoothstep(0.30, 0.85, up)) * (0.55 + 0.85 * horizon);
    col += sky * uVoidSky;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 4. Depth of field — gentle, tilt-shift weighted. Focus is locked to the play
//    plane, so the player is mathematically incapable of going soft.
// ─────────────────────────────────────────────────────────────────────────────
export const DOF_COC_FRAG = /* glsl */`
precision highp float;
${COMMON}
${DEPTH}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform float uNear, uFar;
uniform float uFocus, uFocusRange, uFarRange, uNearRange;
uniform float uMaxBlur, uNearMax;
uniform float uTilt, uTiltCenter;
varying vec2 vUv;
void main(){
  float d = texture2D(tDepth, vUv).x;
  float z = (d >= 0.99999) ? uFar : linearDepth(d, uNear, uFar);
  float farC  = clamp((z - (uFocus + uFocusRange)) / max(1.0, uFarRange), 0.0, 1.0);
  float nearC = clamp(((uFocus - uFocusRange) - z) / max(1.0, uNearRange), 0.0, 1.0);
  float coc = max(farC * uMaxBlur, nearC * uNearMax);
  // tilt-shift: a soft horizontal band of sharpness across the play plane
  float ts = smoothstep(0.18, 0.55, abs(vUv.y - uTiltCenter)) * uTilt;
  coc = clamp(max(coc, ts), 0.0, 1.0);
  gl_FragColor = vec4(texture2D(tScene, vUv).rgb, coc);
}`;

export const DOF_BLUR_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uDir;         // texel-space direction * radius
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tSrc, vUv);
  float r = c.a;
  if(r < 0.004){ gl_FragColor = c; return; }
  vec3 sum = vec3(0.0); float wsum = 0.0; float acoc = 0.0;
  for(int i = -6; i <= 6; i++){
    float fi = float(i);
    vec4 s = texture2D(tSrc, vUv + uDir * fi * r);
    // only let equally-or-more defocused neighbours bleed in (stops halos on the player)
    float ok = smoothstep(r * 0.35, r * 0.9, s.a + 0.02);
    float w = exp(-fi * fi * 0.075) * mix(0.12, 1.0, ok);
    sum += s.rgb * w; wsum += w; acoc = max(acoc, s.a);
  }
  gl_FragColor = vec4(sum / max(1e-4, wsum), c.a);
}`;

export const DOF_COMBINE_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tScene;
uniform sampler2D tBlur;
varying vec2 vUv;
void main(){
  vec4 b = texture2D(tBlur, vUv);
  vec3 s = texture2D(tScene, vUv).rgb;
  gl_FragColor = vec4(mix(s, b.rgb, smoothstep(0.02, 0.34, b.a)), 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bloom — Karis-averaged bright pass, then a progressive mip pyramid.
// ─────────────────────────────────────────────────────────────────────────────
export const BLOOM_BRIGHT_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2  uTexel;      // texel size of the SOURCE
uniform float uThreshold, uKnee, uClamp;
varying vec2 vUv;
// FIREFLY CLAMP. A 13cm emissive gold bar seen from 26m is sub-pixel wide, so
// its HDR value spikes on ONE texel and the bright pass turns that into a
// crawling white string that no post-tonemap AA can touch. Clamping per-texel
// luminance before the threshold is what stops emissive aliasing from surviving
// into bloom (ART_DIRECTION §7 — unresolved shimmer).
vec3 T(vec2 o){
  vec3 c = max(vec3(0.0), texture2D(tSrc, vUv + o * uTexel).rgb);
  float l = max(c.r, max(c.g, c.b));
  return (l > uClamp) ? c * (uClamp / max(l, 1e-4)) : c;
}
float kw(vec3 c){ return 1.0 / (1.0 + luma(c)); }   // Karis average weight
void main(){
  vec3 a = T(vec2(-2.0, 2.0)), b = T(vec2(0.0, 2.0)), c = T(vec2(2.0, 2.0));
  vec3 dd= T(vec2(-1.0, 1.0)), e = T(vec2(1.0, 1.0));
  vec3 f = T(vec2(-2.0, 0.0)), g = T(vec2(0.0, 0.0)), h = T(vec2(2.0, 0.0));
  vec3 i = T(vec2(-1.0,-1.0)), j = T(vec2(1.0,-1.0));
  vec3 k = T(vec2(-2.0,-2.0)), l = T(vec2(0.0,-2.0)), m = T(vec2(2.0,-2.0));
  vec3 g0 = (dd + e + i + j) * 0.25;
  vec3 g1 = (a + b + f + g) * 0.25;
  vec3 g2 = (b + c + g + h) * 0.25;
  vec3 g3 = (f + g + k + l) * 0.25;
  vec3 g4 = (g + h + l + m) * 0.25;
  float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
  vec3 col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / max(1e-5, w0 + w1 + w2 + w3 + w4);
  // soft-knee high threshold: only genuine emissives get through
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(col * contrib, 1.0);
}`;

export const BLOOM_DOWN_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 T(vec2 o){ return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main(){
  vec3 a = T(vec2(-2.0, 2.0)), b = T(vec2(0.0, 2.0)), c = T(vec2(2.0, 2.0));
  vec3 dd= T(vec2(-1.0, 1.0)), e = T(vec2(1.0, 1.0));
  vec3 f = T(vec2(-2.0, 0.0)), g = T(vec2(0.0, 0.0)), h = T(vec2(2.0, 0.0));
  vec3 i = T(vec2(-1.0,-1.0)), j = T(vec2(1.0,-1.0));
  vec3 k = T(vec2(-2.0,-2.0)), l = T(vec2(0.0,-2.0)), m = T(vec2(2.0,-2.0));
  vec3 col = (dd + e + i + j) * 0.125
           + (a + c + k + m) * 0.03125
           + (b + f + h + l) * 0.0625
           +  g * 0.125;
  gl_FragColor = vec4(max(vec3(0.0), col), 1.0);
}`;

export const BLOOM_UP_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uRadius;
uniform float uScale;
varying vec2 vUv;
vec3 T(vec2 o){ return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }
void main(){
  // 3x3 tent
  vec3 col = T(vec2(-1.0, 1.0)) * 1.0 + T(vec2(0.0, 1.0)) * 2.0 + T(vec2(1.0, 1.0)) * 1.0
           + T(vec2(-1.0, 0.0)) * 2.0 + T(vec2(0.0, 0.0)) * 4.0 + T(vec2(1.0, 0.0)) * 2.0
           + T(vec2(-1.0,-1.0)) * 1.0 + T(vec2(0.0,-1.0)) * 2.0 + T(vec2(1.0,-1.0)) * 1.0;
  gl_FragColor = vec4(col * (1.0 / 16.0) * uScale, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 6. Volumetric shafts — screen-space radial-blur occlusion from the key light
//    and from any sufficiently bright emissive.
// ─────────────────────────────────────────────────────────────────────────────
export const GR_MASK_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform float uThreshold;
uniform float uOccludeGeo;
varying vec2 vUv;
void main(){
  vec3 c = max(vec3(0.0), texture2D(tSrc, vUv).rgb);
  float br = max(0.0, luma(c) - uThreshold);
  float d = texture2D(tDepth, vUv).x;
  // solid geometry occludes the shaft unless it is itself an emitter
  float geo = (d < 0.99999) ? mix(uOccludeGeo, 1.0, clamp(br * 0.8, 0.0, 1.0)) : 1.0;
  gl_FragColor = vec4(c * br * geo, 1.0);
}`;

export const GR_BLUR_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2  uLightUV;
uniform float uDensity, uDecay, uWeight, uStride;
varying vec2 vUv;
void main(){
  vec2 uv = vUv;
  vec2 delta = (uv - uLightUV) * (uDensity / float(GR_SAMPLES)) * uStride;
  vec3 acc = vec3(0.0);
  float illum = 1.0;
  for(int i = 0; i < GR_SAMPLES; i++){
    uv -= delta;
    acc += texture2D(tSrc, clamp(uv, vec2(0.0), vec2(1.0))).rgb * illum * uWeight;
    illum *= uDecay;
  }
  gl_FragColor = vec4(acc / float(GR_SAMPLES), 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 7. COMPOSITE + GRADE — where the Hades look is actually won.
// ─────────────────────────────────────────────────────────────────────────────
export const COMPOSITE_FRAG = /* glsl */`
precision highp float;
${COMMON}
${AGX}
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tGodrays;
uniform vec2  uRes;
uniform float uAspect;
uniform float uMaster;         // post.setIntensity()

uniform float uBloomIntensity; uniform vec3 uBloomTint;
uniform float uGRIntensity;    uniform vec3 uGRColor;

uniform float uChroma;         // radial chromatic aberration, in pixels at the corner
uniform float uRadial;         // radial blur kick (hit feedback)
uniform vec3  uFlashColor;     uniform float uFlashAmount, uFlashFalloff;

uniform float uExposure;
uniform vec3  uAgxSlope, uAgxPower; uniform float uAgxSat;

uniform vec3  uLift, uGamma, uGain;
uniform vec3  uCurve;          // per-channel gamma curves
uniform float uContrast, uLogPivot, uBlack, uWhite, uShoulder, uHiRoll;
uniform vec3  uShadowTint, uMidTint, uHighTint;
uniform float uTintStrength, uShadowMix, uHighMix;
uniform float uSatShadow, uSatMid, uSatHigh;
uniform vec3  uHueLobe0, uHueLobe1, uHueLobe2;   // (center, width, shift)

uniform float uVigAmount, uVigRadius, uVigSoft, uVigDepth; uniform vec3 uVigColor;
uniform float uGrainAmount, uGrainSize, uGrainDark, uGrainSeed;

varying vec2 vUv;

float hueDist(float a, float b){ float d = abs(a - b); return min(d, 1.0 - d); }

vec3 sampleScene(vec2 uv){ return texture2D(tScene, clamp(uv, vec2(0.0), vec2(1.0))).rgb; }

void main(){
  vec2 dir = vUv - 0.5;
  float r2 = dot(dir, dir);

  // ── chromatic aberration (radial, quadratic) ──────────────────────────────
  vec2 caOff = dir * r2 * (uChroma * 4.0) / uRes;
  vec3 col;
  col.r = sampleScene(vUv + caOff).r;
  col.g = sampleScene(vUv).g;
  col.b = sampleScene(vUv - caOff).b;

  // ── radial blur kick (impact feedback) ────────────────────────────────────
  if(uRadial > 0.0005){
    vec3 rb = vec3(0.0);
    for(int i = 1; i <= 6; i++){
      float t = float(i) / 6.0;
      rb += sampleScene(vUv - dir * t * uRadial * 0.16);
    }
    col = mix(col, rb / 6.0, clamp(uRadial * 1.4, 0.0, 0.85) * smoothstep(0.02, 0.35, r2));
  }

  // ── additive layers, still scene-referred so the tonemap can roll them off ─
  col += texture2D(tBloom,   vUv).rgb * uBloomIntensity * uBloomTint;
  col += texture2D(tGodrays, vUv).rgb * uGRIntensity   * uGRColor;
  // radial falloff keeps the ink corners alive during a hit flash
  col += uFlashColor * uFlashAmount * mix(1.0, clamp(1.0 - r2 * 2.6, 0.0, 1.0), uFlashFalloff);

  // ── filmic tonemap ────────────────────────────────────────────────────────
  vec3 t = agxTonemap(col, uExposure, uAgxSlope, uAgxPower, uAgxSat);

  // ── display-referred grade ───────────────────────────────────────────────
  // lift / gamma / gain
  t = uGain * (t + uLift * (1.0 - t));
  t = pow(max(t, vec3(0.0)), 1.0 / max(uGamma, vec3(0.05)));
  // per-channel curves
  t = pow(max(t, vec3(0.0)), uCurve);
  // black point / white point: this is what buys the ink shadows back from the
  // filmic curve's shadow lift, and it is the difference between "moody" and "milky"
  t = max((t - uBlack) / max(0.02, uWhite - uBlack), vec3(0.0));
  // ASC-style contrast: a power about a pivot, evaluated in log2 space. Unlike a
  // smoothstep S this has no zero-slope toe, so the void keeps painted detail
  // instead of collapsing to a dead flat black.
  vec3 lg = log2(max(t, vec3(1e-5)));
  lg = (lg - uLogPivot) * (1.0 + uContrast) + uLogPivot;
  t = max(exp2(lg), vec3(0.0));
  // HUE-PRESERVING HIGHLIGHT ROLLOFF — and it has to live HERE, after the
  // S-curve, because the S-curve is a pure power law with no shoulder: at
  // contrast 0.95 about a pivot of 0.34 every display value over 0.591
  // overshoots 1.0 and the clamp turns it into flat paper. Under a crimson key
  // a lit stone arrives with ~3.5x more red than green, so red pinned first and
  // the top of every lit surface collapsed into one bar of pure red with no
  // shape in it (measured: 6.7% of 05_floor sat at a hard 255). Rolling the MAX
  // CHANNEL off and scaling all three by the same factor keeps the ratio, and
  // therefore the hue, intact all the way up — so only genuine emissives ever
  // reach display white. uHiRoll = 1.0 disables it.
  if(uHiRoll < 0.999){
    float mx = max(t.r, max(t.g, t.b));
    if(mx > uHiRoll){
      float e = (mx - uHiRoll) / max(1e-4, 1.0 - uHiRoll);
      float rolled = uHiRoll + (1.0 - uHiRoll) * (e / (1.0 + e));
      t *= rolled / max(mx, 1e-4);
    }
  }
  t = clamp(t, 0.0, 1.0);
  // a gentle filmic shoulder on top (AgX already rolls off; this shapes the mids)
  t = mix(t, t * t * (3.0 - 2.0 * t), clamp(uShoulder, 0.0, 1.0));

  // luminance-masked tinting: ink shadows -> violet, highlights -> gold
  float l = luma(t);
  // The ink mask has to stay in the INK. Reaching up to l=0.44 meant that once
  // the frame's value structure was corrected (arena floor ~0.25) the shadow
  // re-hue caught almost every pixel and rotated the entire image on to one
  // violet axis — the "single hue family" failure, caused by the grade rather
  // than by the palette.
  // NOTE: l is LINEAR luma, so 0.24 reaches sRGB 0.53 — i.e. the shadow re-hue
  // was catching the entire ground plane and rotating a crimson floor on to an
  // indigo axis. The ink belongs in the INK: 0.085 linear is sRGB 0.32.
  float sm = 1.0 - smoothstep(0.006, 0.085, l);
  // and the gold has to be able to REACH the warm-white highlight tint.
  // NOTE: l is LINEAR luma, so a 0.46 threshold is sRGB 0.71 — i.e. the
  // highlight re-hue was gated ABOVE anything the frame actually contains and
  // never fired at all. §3 wants real content in the top 5% of the histogram;
  // 0.26 linear is sRGB 0.55, which is where the brazier pools and the gold
  // ornament live.
  float hm = smoothstep(0.28, 0.74, l);
  float mm = clamp(1.0 - sm - hm, 0.0, 1.0);
  // Luminance-preserving RE-HUE, not a multiply: this is what turns a red-black
  // into an ink-plum black and a hot white into molten gold.
  vec3 shadowRe = clamp(uShadowTint * (l / max(luma(uShadowTint), 0.04)), 0.0, 1.0);
  vec3 highRe   = clamp(uHighTint   * (l / max(luma(uHighTint),   0.04)), 0.0, 1.0);
  t = mix(t, shadowRe, sm * uTintStrength * uShadowMix);
  t = mix(t, highRe,   hm * uTintStrength * uHighMix);
  t *= mix(vec3(1.0), uMidTint, mm * uTintStrength * 0.26);

  // hue-vs-hue + saturation-by-luminance
  vec3 hsv = rgb2hsv(clamp(t, 0.0, 1.0));
  float shift = 0.0;
  shift += uHueLobe0.z * exp(-pow(hueDist(hsv.x, uHueLobe0.x) / max(0.01, uHueLobe0.y), 2.0));
  shift += uHueLobe1.z * exp(-pow(hueDist(hsv.x, uHueLobe1.x) / max(0.01, uHueLobe1.y), 2.0));
  shift += uHueLobe2.z * exp(-pow(hueDist(hsv.x, uHueLobe2.x) / max(0.01, uHueLobe2.y), 2.0));
  hsv.x = fract(hsv.x + shift);
  float lv = hsv.z;
  float sat = (lv < 0.5) ? mix(uSatShadow, uSatMid, smoothstep(0.0, 0.5, lv))
                         : mix(uSatMid,    uSatHigh, smoothstep(0.5, 1.0, lv));
  hsv.y = clamp(hsv.y * sat, 0.0, 1.0);
  t = hsv2rgb(hsv);

  // ── vignette: soft, warm-dark, multiplicative so it stays in the ink ramp ─
  float vd = length(dir * vec2(uAspect, 1.0)) / 0.7071;
  float v  = 1.0 - uVigAmount * smoothstep(uVigRadius, uVigRadius + uVigSoft, vd);
  t *= mix(uVigColor * uVigDepth, vec3(1.0), clamp(v, 0.0, 1.0));

  // ── film grain, heavier in the darks ─────────────────────────────────────
  float gl2 = luma(t);
  float g = grainNoise(floor(gl_FragCoord.xy / max(1.0, uGrainSize)) + uGrainSeed) - 0.5;
  float darkBoost = 1.0 + uGrainDark * (1.0 - smoothstep(0.0, 0.5, gl2));
  // fade grain out at true black: clipping the negative lobe against 0 would
  // otherwise leave a DC lift that turns the void milky
  float grainFloor = smoothstep(0.0, 0.055, gl2);
  t += g * uGrainAmount * darkBoost * grainFloor;

  t = clamp(t, 0.0, 1.0);
  // master intensity blends the whole grade back toward a plain tonemap
  if(uMaster < 0.999){
    vec3 raw = clamp(agxTonemap(sampleScene(vUv), uExposure, vec3(1.0), vec3(1.0), 1.0), 0.0, 1.0);
    t = mix(raw, t, clamp(uMaster, 0.0, 1.0));
  }
  gl_FragColor = vec4(srgbEncode(t), 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 8. Final resolve — 5-tap tent so supersampled frames downsample without
//    reintroducing shimmer on the gold filigree.
// ─────────────────────────────────────────────────────────────────────────────
export const BLIT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;      // 1 / source resolution
uniform float uTent;      // 0 = straight copy, else the supersample ratio
varying vec2 vUv;
void main(){
  if(uTent < 1.001){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  // 3x3 separable tent sized to the ACTUAL resample ratio. A fixed half-texel
  // kernel under a fractional ratio (e.g. 1.25x) leaves a beat pattern; this
  // scales the footprint so every output pixel integrates its whole source area.
  vec2 o = uTexel * uTent * 0.62;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + vec2( o.x, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2(-o.x, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2( 0.0, o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2( 0.0,-o.y)).rgb * 2.0;
  c += texture2D(tSrc, vUv + vec2( o.x, o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2( o.x,-o.y)).rgb;
  c += texture2D(tSrc, vUv + vec2(-o.x,-o.y)).rgb;
  gl_FragColor = vec4(c * (1.0 / 16.0), 1.0);
}`;

// Cheap FXAA for the low/med tiers (SMAA is reserved for high/ultra).
export const FXAA_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 rgbNW = texture2D(tSrc, vUv + vec2(-1.0,-1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tSrc, vUv + vec2( 1.0,-1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tSrc, vUv + vec2( 1.0, 1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tSrc, vUv).rgb;
  float lNW = lum(rgbNW), lNE = lum(rgbNE), lSW = lum(rgbSW), lSE = lum(rgbSE), lM = lum(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 d = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float dr = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 0.0078125);
  float rcp = 1.0 / (min(abs(d.x), abs(d.y)) + dr);
  d = clamp(d * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture2D(tSrc, vUv + d * (1.0/3.0 - 0.5)).rgb + texture2D(tSrc, vUv + d * (2.0/3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - d * 0.5).rgb + texture2D(tSrc, vUv + d * 0.5).rgb);
  float lB = lum(b);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 9. Camera reprojection motion blur (per-object free). OFF by default: it
//    trades readability for cinema, and readability wins in this genre.
// ─────────────────────────────────────────────────────────────────────────────
export const MOTION_FRAG = /* glsl */`
precision highp float;
${COMMON}
${DEPTH}
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;
uniform vec2  uRes;
uniform float uAmount, uMaxPx;
varying vec2 vUv;
void main(){
  float d = texture2D(tDepth, vUv).x;
  vec3 wp = worldFromDepth(vUv, d, uInvViewProj);
  vec4 pp = uPrevViewProj * vec4(wp, 1.0);
  vec2 puv = (pp.xy / max(1e-5, pp.w)) * 0.5 + 0.5;
  vec2 vel = (vUv - puv) * uAmount;
  float len = length(vel * uRes);
  if(len > uMaxPx) vel *= uMaxPx / max(len, 1e-4);
  if(len < 0.35){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); return; }
  vec3 acc = vec3(0.0);
  for(int i = 0; i < 8; i++){
    float t = float(i) / 7.0 - 0.5;
    acc += texture2D(tSrc, clamp(vUv + vel * t, vec2(0.0), vec2(1.0))).rgb;
  }
  gl_FragColor = vec4(acc / 8.0, 1.0);
}`;

// ─────────────────────────────────────────────────────────────────────────────
// 10. Metering — centre-weighted geometric-mean luminance, packed into RGBA8 so
//     the 1x1 readback needs no float-texture round trip.
//     .r = weight * normalised log2(luma)   .g = weight
// ─────────────────────────────────────────────────────────────────────────────
export const LUM_INIT_FRAG = /* glsl */`
precision highp float;
${COMMON}
uniform sampler2D tSrc;
uniform vec2  uTexel;
uniform float uCenterW;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(tSrc, vUv).rgb
         + texture2D(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb
         + texture2D(tSrc, vUv + vec2(0.0, uTexel.y)).rgb
         + texture2D(tSrc, vUv + uTexel).rgb;
  float L  = clamp(luma(max(c, vec3(0.0)) * 0.25), 0.00015, 60.0);
  float lg = clamp((log2(L) + 16.0) / 32.0, 0.0, 1.0);
  float d  = length(vUv - 0.5) * 1.42;
  float w  = mix(1.0, smoothstep(0.92, 0.10, d), uCenterW);
  gl_FragColor = vec4(lg * w, w, 0.0, 1.0);
}`;

export const BOX4_FRAG = /* glsl */`
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tSrc, vUv + vec2(-0.5, -0.5) * uTexel)
         + texture2D(tSrc, vUv + vec2( 0.5, -0.5) * uTexel)
         + texture2D(tSrc, vUv + vec2(-0.5,  0.5) * uTexel)
         + texture2D(tSrc, vUv + vec2( 0.5,  0.5) * uTexel);
  gl_FragColor = c * 0.25;
}`;
