// OWNER: AGENT-RENDER — shared GLSL chunks for the EREBUS post pipeline.
// Everything here is pure string data; no THREE import so it stays cheap.

/** Fullscreen-triangle vertex shader (matches three's FullscreenTriangleGeometry). */
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Colour + hash + noise helpers. */
export const COMMON = /* glsl */`
#define EPS 1e-6
const float PI  = 3.141592653589793;
const float TAU = 6.283185307179586;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 srgbEncode(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 srgbDecode(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

// hue/sat/value round trip (Sam Hocevar, branchless)
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + EPS)), d / (q.x + EPS), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float s = 0.0, a = 0.5, n = 0.0;
  for(int i = 0; i < 5; i++){ s += a * vnoise(p); n += a; p = p * 2.03 + 17.1; a *= 0.5; }
  return s / n;
}
// Interleaved gradient noise — the cheapest good per-pixel dither/rotation source.
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// White noise for film grain. hash12 decorrelates badly on large integer screen
// coordinates (its fract(p * 0.1031) term loses mantissa above ~1000), which
// shows up as a faint regular dot lattice in flat dark areas. Two rounds of a
// wrapped sin-hash have no such structure.
float grainNoise(vec2 p){
  p = mod(p, 512.0);
  float a = fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
  return fract(sin(dot(p.yx + a * 37.0, vec2(39.3468, 11.1357))) * 24634.6345);
}
`;

/** Depth reconstruction helpers. Requires uniforms uNear/uFar/uInvProj/uInvViewProj. */
export const DEPTH = /* glsl */`
float linearDepth(float d, float near, float far){
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}
vec3 viewFromDepth(vec2 uv, float d, mat4 invProj){
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProj * ndc;
  return v.xyz / v.w;
}
vec3 worldFromDepth(vec2 uv, float d, mat4 invViewProj){
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = invViewProj * ndc;
  return w.xyz / w.w;
}
`;

/**
 * AgX tonemap (Filament/Blender formulation, ported from three's tonemapping chunk)
 * plus the standard log-space "look" controls so the grade can be pushed filmic.
 */
export const AGX = /* glsl */`
const mat3 AGX_LIN_SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956)
);
const mat3 AGX_REC2020_TO_LIN_SRGB = mat3(
  vec3( 1.6605, -0.1246, -0.0182),
  vec3(-0.5876,  1.1329, -0.1006),
  vec3(-0.0728, -0.0083,  1.1187)
);
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
);
const mat3 AGX_OUTSET = mat3(
  vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323,  1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
);
vec3 agxContrast(vec3 x){
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
// look: slope (gain), power (contrast), sat (chroma) applied in the AgX log domain
vec3 agxLook(vec3 c, vec3 slope, vec3 power, float sat){
  float l = luma(c);
  vec3 v = pow(max(vec3(0.0), c * slope), power);
  return max(vec3(0.0), l + sat * (v - l));
}
vec3 agxTonemap(vec3 color, float exposure, vec3 slope, vec3 power, float sat){
  const float MinEv = -12.47393;
  const float MaxEv = 4.026069;
  color *= exposure;
  color = AGX_LIN_SRGB_TO_REC2020 * color;
  color = AGX_INSET * color;
  color = max(color, 1e-10);
  color = log2(color);
  color = (color - MinEv) / (MaxEv - MinEv);
  color = clamp(color, 0.0, 1.0);
  color = agxContrast(color);
  color = agxLook(color, slope, power, sat);
  color = AGX_OUTSET * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = AGX_REC2020_TO_LIN_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
`;
