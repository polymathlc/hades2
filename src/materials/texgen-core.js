// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// texgen.js — procedural texture SYNTHESIS engine.
//
// Everything here is pure JS operating on Float32Array scalar fields, and every
// operator is TOROIDAL (wrapped) so the result tiles seamlessly by construction.
//
//   noise            periodic value / gradient / worley
//   fbm              multi-resolution pyramid fBm, ridged, turbulence
//   warp             domain warping (the thing that kills "computer noise")
//   cracks           voronoi fracture / seam generator
//   strokes          directional tapered brush strokes along a flow field
//                    <- the single most important function in this file
//   ramp             authored multi-stop colour ramps (Oklab interpolated)
//   masks            cavity / convex-edge-wear / dirt / streaks from height
//   normal / ao      height -> tangent-space normal, height -> occlusion
//   ornament         vector rasteriser + Greek meander / palmette / guilloche
//   layout           ashlar block + tile grid generators
//
// Determinism: local seeded RNG (mulberry32) keyed by an explicit integer seed.
// Never Math.random(). Never ctx.rng (texture content must not depend on the
// order gameplay pulls random numbers).
// ---------------------------------------------------------------------------

import { rampLUT, RAMPS } from './palette.js';

const TAU = Math.PI * 2;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, deterministic. */
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (lo, hi) => lo + (hi - lo) * f();
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length) % arr.length];
  f.sign = () => (f() < 0.5 ? -1 : 1);
  f.gauss = (mu = 0, sd = 1) => {
    let u = 0, v = 0;
    while (!u) u = f(); while (!v) v = f();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  return f;
}

// integer hash -> uint32 (no table => unlimited lattice period)
function ihash(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const ihashf = (x, y, s) => ihash(x, y, s) / 4294967296;

// 16-way gradient table (avoids trig in the inner loop)
const GX = new Float32Array(16), GY = new Float32Array(16);
for (let i = 0; i < 16; i++) { const a = (i / 16) * TAU; GX[i] = Math.cos(a); GY[i] = Math.sin(a); }

const wrapi = (v, p) => { const m = v % p; return m < 0 ? m + p : m; };

// ---------------------------------------------------------------------------
// Periodic noise primitives
// ---------------------------------------------------------------------------

/** Seamless value noise with lattice period `per`. */
export function valueNoiseP(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = wrapi(xi, per), y0 = wrapi(yi, per);
  const x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
  const a = ihashf(x0, y0, seed), b = ihashf(x1, y0, seed);
  const c = ihashf(x0, y1, seed), d = ihashf(x1, y1, seed);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Seamless gradient (Perlin-style) noise, returns 0..1. */
export function gradNoiseP(x, y, per, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = wrapi(xi, per), y0 = wrapi(yi, per);
  const x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
  const g00 = ihash(x0, y0, seed) & 15, g10 = ihash(x1, y0, seed) & 15;
  const g01 = ihash(x0, y1, seed) & 15, g11 = ihash(x1, y1, seed) & 15;
  const n00 = GX[g00] * xf + GY[g00] * yf;
  const n10 = GX[g10] * (xf - 1) + GY[g10] * yf;
  const n01 = GX[g01] * xf + GY[g01] * (yf - 1);
  const n11 = GX[g11] * (xf - 1) + GY[g11] * (yf - 1);
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 0.7071 + 0.5;
}

/**
 * "Simplex-style" — two gradient lattices at 30 degrees, averaged. Removes the
 * axis-aligned grid signature of plain Perlin without a real simplex grid.
 * Period-safe: the rotated lattice uses the same period on an integer rotation
 * approximation (3-4-5 style) so it still tiles.
 */
export function simplexish(x, y, per, seed) {
  const a = gradNoiseP(x, y, per, seed);
  // 3/5, 4/5 rotation keeps lattice points on the torus
  const rx = (x * 0.8 - y * 0.6), ry = (x * 0.6 + y * 0.8);
  const b = gradNoiseP(rx, ry, per, seed ^ 0x9e3779b9);
  return a * 0.55 + b * 0.45;
}

/** Seamless Worley/cellular. Returns {f1,f2,id} with distances in cell units. */
export function worleyP(x, y, per, seed, jitter = 1) {
  const cx = Math.floor(x), cy = Math.floor(y);
  let f1 = 8, f2 = 8, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = wrapi(gx, per), wy = wrapi(gy, per);
      const h = ihash(wx, wy, seed);
      const px = gx + 0.5 + (((h & 1023) / 1023) - 0.5) * jitter;
      const py = gy + 0.5 + ((((h >>> 10) & 1023) / 1023) - 0.5) * jitter;
      const dx = px - x, dy = py - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < f1) { f2 = f1; f1 = d; id = h; }
      else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2, id };
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

export const field = (n, v = 0) => {
  const f = new Float32Array(n * n);
  if (v) f.fill(v);
  return f;
};

/** Wrapped bilinear sample of a field, coordinates in pixels. */
export function sampleWrap(src, n, x, y) {
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  x0 = wrapi(x0, n); y0 = wrapi(y0, n);
  const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const r0 = y0 * n, r1 = y1 * n;
  const a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
  const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

/** Wrapped bilinear splat (accumulate). */
export function splat(dst, n, x, y, v) {
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  x0 = wrapi(x0, n); y0 = wrapi(y0, n);
  const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const r0 = y0 * n, r1 = y1 * n;
  dst[r0 + x0] += v * (1 - fx) * (1 - fy);
  dst[r0 + x1] += v * fx * (1 - fy);
  dst[r1 + x0] += v * (1 - fx) * fy;
  dst[r1 + x1] += v * fx * fy;
}

export function normalize01(f, lo, hi) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < f.length; i++) { const v = f[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const d = mx - mn || 1;
  const a = lo === undefined ? 0 : lo, b = hi === undefined ? 1 : hi;
  for (let i = 0; i < f.length; i++) f[i] = a + ((f[i] - mn) / d) * (b - a);
  return f;
}

export function mapField(f, fn) { for (let i = 0; i < f.length; i++) f[i] = fn(f[i], i); return f; }
export function addField(a, b, k = 1) { for (let i = 0; i < a.length; i++) a[i] += b[i] * k; return a; }
export function mulField(a, b) { for (let i = 0; i < a.length; i++) a[i] *= b[i]; return a; }
export function maxField(a, b) { for (let i = 0; i < a.length; i++) a[i] = a[i] > b[i] ? a[i] : b[i]; return a; }
export function lerpField(a, b, t) { for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t; return a; }
export function copyField(a) { return new Float32Array(a); }

function upsample2(src, r) {
  const R = r * 2, out = new Float32Array(R * R);
  // 2x upsample weights are constant: 0.75 / 0.25 alternating
  const i0 = new Int32Array(R), i1 = new Int32Array(R);
  const fr = new Float32Array(R);
  for (let x = 0; x < R; x++) {
    const sx = x * 0.5 - 0.25;
    let a = Math.floor(sx);
    fr[x] = sx - a;
    a = wrapi(a, r);
    i0[x] = a; i1[x] = (a + 1) % r;
  }
  for (let y = 0; y < R; y++) {
    const r0 = i0[y] * r, r1 = i1[y] * r, fy = fr[y], o = y * R;
    for (let x = 0; x < R; x++) {
      const x0 = i0[x], x1 = i1[x], fx = fr[x];
      const a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
      const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
      out[o + x] = ab + (cd - ab) * fy;
    }
  }
  return out;
}

function resampleTo(src, r, n) {
  if (r === n) return src;
  const out = new Float32Array(n * n), s = r / n;
  const i0 = new Int32Array(n), i1 = new Int32Array(n), fr = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const sx = (x + 0.5) * s - 0.5;
    let a = Math.floor(sx);
    fr[x] = sx - a;
    a = wrapi(a, r);
    i0[x] = a; i1[x] = (a + 1) % r;
  }
  for (let y = 0; y < n; y++) {
    const r0 = i0[y] * r, r1 = i1[y] * r, fy = fr[y], o = y * n;
    for (let x = 0; x < n; x++) {
      const x0 = i0[x], x1 = i1[x], fx = fr[x];
      const a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
      const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
      out[o + x] = ab + (cd - ab) * fy;
    }
  }
  return out;
}

const pow2ceil = (v) => { let p = 1; while (p < v) p *= 2; return p; };

/** Public wrapped resample between two square resolutions. */
export const resample = (f, from, to) => resampleTo(f, from, to);

/**
 * Generate an inherently low-frequency field cheaply: build it at `res` and
 * upsample. Used for temperature/glaze/macro layers where full-res detail is
 * physically absent anyway.
 */
export function lowFreq(n, gen, res) {
  const r = Math.max(64, Math.min(n, res || (n >> 1)));
  return resampleTo(gen(r), r, n);
}

// ---------------------------------------------------------------------------
// fBm — multi-resolution pyramid (each octave evaluated at its own resolution)
// ---------------------------------------------------------------------------
/**
 * @param {number} n       output resolution (power of two)
 * @param {object} o
 *   freq       base frequency in tiles across the texture (integer!)
 *   octaves    number of octaves
 *   gain       amplitude falloff (0.5 = pink)
 *   lacunarity frequency growth (2 = standard, keeps seamlessness)
 *   type       'value' | 'grad' | 'simplex'
 *   mode       'fbm' | 'ridged' | 'turbulence'
 *   ppc        pixels per lattice cell at each level (detail vs speed, 4 default)
 *   seed
 */
export function fbm(n, o = {}) {
  const freq = Math.max(1, Math.round(o.freq ?? 4));
  const octaves = o.octaves ?? 6;
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  const ppc = o.ppc ?? 4;
  const seed = (o.seed ?? 1) | 0;
  const type = o.type || 'value';
  const mode = o.mode || 'fbm';
  const nf = type === 'grad' ? gradNoiseP : type === 'simplex' ? simplexish : valueNoiseP;

  let res = Math.min(n, Math.max(8, pow2ceil(freq * ppc)));
  let buf = new Float32Array(res * res);
  let amp = 1, norm = 0;

  const addOct = (b, r, f, a, sd) => {
    const s = f / r;
    for (let y = 0; y < r; y++) {
      const yy = (y + 0.5) * s, row = y * r;
      for (let x = 0; x < r; x++) {
        let v = nf((x + 0.5) * s, yy, f, sd);
        if (mode === 'ridged') v = 1 - Math.abs(v * 2 - 1);
        else if (mode === 'turbulence') v = Math.abs(v * 2 - 1);
        b[row + x] += v * a;
      }
    }
  };

  addOct(buf, res, freq, amp, seed);
  norm += amp;

  for (let i = 1; i < octaves; i++) {
    const f = Math.round(freq * Math.pow(lac, i));
    if (f * 2 > n) break;                            // beyond Nyquist for this texture
    const target = Math.min(n, Math.max(8, pow2ceil(f * ppc)));
    while (res < target) { buf = upsample2(buf, res); res *= 2; }
    amp *= gain;
    addOct(buf, res, f, amp, seed + i * 7919);
    norm += amp;
  }
  while (res < n) { buf = upsample2(buf, res); res *= 2; }
  if (res !== n) buf = resampleTo(buf, res, n);
  const inv = 1 / norm;
  for (let i = 0; i < buf.length; i++) buf[i] *= inv;
  if (mode === 'ridged') { for (let i = 0; i < buf.length; i++) buf[i] = buf[i] * buf[i]; }
  return buf;
}

/** Convenience: ridged fBm. */
export const ridged = (n, o = {}) => fbm(n, { ...o, mode: 'ridged' });
/** Convenience: turbulence (abs) fBm. */
export const turbulence = (n, o = {}) => fbm(n, { ...o, mode: 'turbulence' });

// ---------------------------------------------------------------------------
// Domain warping
// ---------------------------------------------------------------------------
/**
 * Resample `src` through an offset pair of noise fields. `amp` is in texture
 * fractions (0.08 = up to ~8% of the texture width of displacement).
 * This is what turns "computer noise" into something that looks drawn.
 */
export function warp(src, n, o = {}) {
  const amp = (o.amp ?? 0.06) * n;
  const freq = o.freq ?? 3;
  const oct = o.octaves ?? 4;
  const seed = (o.seed ?? 7) | 0;
  const wr = Math.max(64, Math.min(n, o.warpRes || (n >> 2)));
  // The offset field is low frequency by construction, so it stays at `wr` and
  // is sampled with a scale factor. Materialising it at n^2 first (which is
  // what this used to do) cost two full-resolution resamples per warp — four
  // per warp2 — for a field that has no detail at that resolution to carry.
  const wx = o.wx || fbm(wr, { freq, octaves: oct, seed, type: 'grad', ppc: 4 });
  const wy = o.wy || fbm(wr, { freq, octaves: oct, seed: seed + 3331, type: 'grad', ppc: 4 });
  const wxr = Math.round(Math.sqrt(wx.length)), wyr = Math.round(Math.sqrt(wy.length));
  const kx = wxr / n, ky = wyr / n;
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const ox = sampleWrap(wx, wxr, x * kx, y * kx);
      const oy = sampleWrap(wy, wyr, x * ky, y * ky);
      const sx = x + (ox - 0.5) * 2 * amp, sy = y + (oy - 0.5) * 2 * amp;
      let x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      x0 %= n; if (x0 < 0) x0 += n;
      y0 %= n; if (y0 < 0) y0 += n;
      const x1 = x0 + 1 === n ? 0 : x0 + 1, y1 = y0 + 1 === n ? 0 : y0 + 1;
      const r0 = y0 * n, r1 = y1 * n;
      const a = src[r0 + x0], b = src[r0 + x1], c = src[r1 + x0], d = src[r1 + x1];
      const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
      out[i] = ab + (cd - ab) * fy;
    }
  }
  return out;
}

/** Two-level recursive warp (Inigo Quilez style) — heavier, much more organic. */
export function warp2(src, n, o = {}) {
  const a1 = o.amp ?? 0.07;
  const one = warp(src, n, { amp: a1, freq: o.freq ?? 2, octaves: 4, seed: o.seed ?? 11 });
  return warp(one, n, { amp: a1 * 0.45, freq: (o.freq ?? 2) * 3, octaves: 3, seed: (o.seed ?? 11) + 977 });
}

/** fBm with domain warping baked in. */
export function fbmWarped(n, o = {}) {
  const base = fbm(n, o);
  return warp2(base, n, { amp: o.warpAmp ?? 0.06, freq: o.warpFreq ?? 2, seed: (o.seed ?? 1) + 4441 });
}

// ---------------------------------------------------------------------------
// Worley fields / cracks
// ---------------------------------------------------------------------------

export function worleyField(n, o = {}) {
  if (o.res && o.res < n) {
    const r = Math.max(64, o.res | 0);
    return resampleTo(worleyField(r, { ...o, res: 0 }), r, n);
  }
  const freq = Math.max(1, Math.round(o.freq ?? 8));
  const seed = (o.seed ?? 5) | 0;
  const jitter = o.jitter ?? 1;
  const mode = o.mode || 'f1';       // 'f1' | 'f2f1' | 'cell' | 'f2'
  const out = new Float32Array(n * n);
  const s = freq / n;
  const px = new Float32Array(freq * freq), py = new Float32Array(freq * freq);
  const cid = new Float32Array(freq * freq);
  for (let cy = 0; cy < freq; cy++) for (let cx = 0; cx < freq; cx++) {
    const h = ihash(cx, cy, seed), k = cy * freq + cx;
    px[k] = cx + 0.5 + (((h & 1023) / 1023) - 0.5) * jitter;
    py[k] = cy + 0.5 + ((((h >>> 10) & 1023) / 1023) - 0.5) * jitter;
    cid[k] = ((h >>> 20) & 1023) / 1023;
  }
  for (let y = 0; y < n; y++) {
    const gy = (y + 0.5) * s, row = y * n;
    const cy0 = Math.floor(gy);
    for (let x = 0; x < n; x++) {
      const gx = (x + 0.5) * s;
      const cx0 = Math.floor(gx);
      let f1 = 64, f2 = 64, id = 0;
      for (let j = -1; j <= 1; j++) {
        let wy = (cy0 + j) % freq; if (wy < 0) wy += freq;
        const off = (cy0 + j) - wy;               // integer cell offset for the torus
        for (let i = -1; i <= 1; i++) {
          let wx = (cx0 + i) % freq; if (wx < 0) wx += freq;
          const offx = (cx0 + i) - wx;
          const k = wy * freq + wx;
          const dx = (px[k] + offx) - gx, dy = (py[k] + off) - gy;
          const d = dx * dx + dy * dy;
          if (d < f1) { f2 = f1; f1 = d; id = cid[k]; }
          else if (d < f2) f2 = d;
        }
      }
      f1 = Math.sqrt(f1); f2 = Math.sqrt(f2);
      let v;
      if (mode === 'f1') v = f1 / 1.2;
      else if (mode === 'f2') v = f2 / 1.8;
      else if (mode === 'cell') v = id;
      else v = f2 - f1;
      out[row + x] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
  return out;
}

/**
 * Voronoi crack / fracture generator. Returns a 0..1 mask where 1 = deep in a
 * crack. Multi-level (big plates + sub-fractures), broken up by a noise mask so
 * the seams look chiselled rather than machine-drawn.
 */
export function cracks(n, o = {}) {
  const levels = o.levels || [{ freq: 6, width: 0.10, weight: 1 }, { freq: 13, width: 0.07, weight: 0.7 }];
  const seed = (o.seed ?? 21) | 0;
  const jitter = o.jitter ?? 0.95;
  const warpAmp = o.warpAmp ?? 0.035;
  const out = new Float32Array(n * n);
  const wr = Math.max(64, n >> 2);
  const wx = resampleTo(fbm(wr, { freq: 3, octaves: 4, seed: seed + 61, type: 'grad' }), wr, n);
  const wy = resampleTo(fbm(wr, { freq: 3, octaves: 4, seed: seed + 62, type: 'grad' }), wr, n);
  const A = warpAmp * n;
  for (let li = 0; li < levels.length; li++) {
    const L = levels[li];
    const freq = Math.max(1, Math.round(L.freq));
    const s = freq / n;
    const sd = seed + li * 4013;
    const width = L.width, weight = L.weight ?? 1;
    const cpx = new Float32Array(freq * freq), cpy = new Float32Array(freq * freq);
    for (let cy = 0; cy < freq; cy++) for (let cx = 0; cx < freq; cx++) {
      const h = ihash(cx, cy, sd), k = cy * freq + cx;
      cpx[k] = cx + 0.5 + (((h & 1023) / 1023) - 0.5) * jitter;
      cpy[k] = cy + 0.5 + ((((h >>> 10) & 1023) / 1023) - 0.5) * jitter;
    }
    for (let y = 0; y < n; y++) {
      const row = y * n;
      for (let x = 0; x < n; x++) {
        const i = row + x;
        const gx = (x + 0.5 + (wx[i] - 0.5) * 2 * A) * s;
        const gy = (y + 0.5 + (wy[i] - 0.5) * 2 * A) * s;
        const cx0 = Math.floor(gx), cy0 = Math.floor(gy);
        let f1 = 64, f2 = 64;
        for (let j = -1; j <= 1; j++) {
          let wyy = (cy0 + j) % freq; if (wyy < 0) wyy += freq;
          const offy = (cy0 + j) - wyy;
          for (let ii = -1; ii <= 1; ii++) {
            let wxx = (cx0 + ii) % freq; if (wxx < 0) wxx += freq;
            const offx = (cx0 + ii) - wxx;
            const k = wyy * freq + wxx;
            const dx = (cpx[k] + offx) - gx, dy = (cpy[k] + offy) - gy;
            const d = dx * dx + dy * dy;
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
          }
        }
        const e = 1 - smoothstep(0, width, Math.sqrt(f2) - Math.sqrt(f1));
        const v = e * weight;
        if (v > out[i]) out[i] = v;
      }
    }
  }
  if (o.breakUp !== false) {
    const m = fbm(n, { freq: 5, octaves: 4, seed: seed + 909 });
    for (let i = 0; i < out.length; i++) out[i] *= clamp01(0.35 + 1.25 * m[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Blur / masks
// ---------------------------------------------------------------------------

/** Wrapped separable box blur, O(n^2) per pass regardless of radius. */
export function blurWrap(src, n, radius, passes = 2) {
  if (radius < 1) return copyField(src);
  let a = copyField(src), b = new Float32Array(n * n);
  const r = Math.min(Math.max(1, Math.round(radius)), (n >> 1) - 1);
  const w = 2 * r + 1, inv = 1 / w;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let sum = 0;
      for (let k = -r; k <= r; k++) { let i = k; if (i < 0) i += n; sum += a[row + i]; }
      let ia = r + 1; if (ia >= n) ia -= n;
      let ib = -r; if (ib < 0) ib += n;
      for (let x = 0; x < n; x++) {
        b[row + x] = sum * inv;
        sum += a[row + ia] - a[row + ib];
        ia++; if (ia >= n) ia = 0;
        ib++; if (ib >= n) ib = 0;
      }
    }
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) { let i = k; if (i < 0) i += n; sum += b[i * n + x]; }
      let ia = r + 1; if (ia >= n) ia -= n;
      let ib = -r; if (ib < 0) ib += n;
      for (let y = 0; y < n; y++) {
        a[y * n + x] = sum * inv;
        sum += b[ia * n + x] - b[ib * n + x];
        ia++; if (ia >= n) ia = 0;
        ib++; if (ib >= n) ib = 0;
      }
    }
  }
  return a;
}

/** blur computed at half resolution and upsampled — for wide, soft radii. */
function blurFast(src, n, radius, passes = 2) {
  if (radius < 3 || n <= 128) return blurWrap(src, n, radius, passes);
  const half = n >> 1;
  const lo = resampleTo(src, n, half);
  const b = blurWrap(lo, half, Math.max(1, Math.round(radius * 0.5)), passes);
  return resampleTo(b, half, n);
}

/** Concave / crevice mask from a height field (0..1). */
export function cavityMask(h, n, radius = 6, gain = 6) {
  const b = blurFast(h, n, radius);
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = clamp01((b[i] - h[i]) * gain);
  return out;
}

/** Convex / edge-wear mask from a height field (0..1). */
export function edgeMask(h, n, radius = 4, gain = 7) {
  const b = blurFast(h, n, radius);
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = clamp01((h[i] - b[i]) * gain);
  return out;
}

/**
 * Dirt / grime: accumulates in cavities and smears downward (gravity streaks).
 * `dir` is in radians; default straight down the +v axis.
 */
export function dirtMask(h, n, o = {}) {
  const cav = o.cavity || cavityMask(h, n, o.radius ?? 8, o.gain ?? 5);
  const noise = lowFreq(n, (r) => fbm(r, { freq: o.freq ?? 6, octaves: 4, seed: (o.seed ?? 33) | 0 }), n >> 2);
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(cav[i] * (0.5 + noise[i]));
  const len = Math.round((o.streak ?? 0.06) * n);
  if (len > 1) {
    const half = Math.max(64, n >> 1);
    const lo = resampleTo(out, n, half);
    const ang = o.dir ?? -Math.PI / 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const sm = new Float32Array(half * half);
    const jitter = fbm(half, { freq: 12, octaves: 3, seed: (o.seed ?? 33) + 5 });
    const L = len * (half / n);
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const i = y * half + x;
        let acc = 0, wsum = 0;
        const l = L * (0.4 + 1.2 * jitter[i]);
        for (let t = 0; t < 6; t++) {
          const k = (t / 5) * l;
          const w = 1 - t / 6;
          acc += sampleWrap(lo, half, x - dx * k, y - dy * k) * w;
          wsum += w;
        }
        sm[i] = acc / wsum;
      }
    }
    const up = resampleTo(sm, half, n);
    const k2 = o.streakStrength ?? 0.8;
    for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], up[i] * k2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE BRUSH — directional tapered strokes along a flow field
// ---------------------------------------------------------------------------

/**
 * Build a flow-direction field (radians) used to steer brush strokes.
 *  base    dominant direction in radians
 *  swirl   how far the noise can rotate away from base (radians)
 *  freq    scale of the swirl
 */
export function flowField(n, o = {}) {
  const base = o.base ?? 0;
  const swirl = o.swirl ?? 0.9;
  const fr = Math.max(64, Math.min(n, o.res || (n >> 2)));
  const f = resampleTo(fbm(fr, { freq: o.freq ?? 3, octaves: o.octaves ?? 4, seed: (o.seed ?? 17) | 0, type: 'grad' }), fr, n);
  const out = new Float32Array(n * n);
  for (let i = 0; i < out.length; i++) out[i] = base + (f[i] - 0.5) * 2 * swirl;
  if (o.radial) {
    // add a radial/tangential component around the texture centre
    const c = n * 0.5;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const a = Math.atan2(y - c, x - c) + (o.radial === 'tangent' ? Math.PI / 2 : 0);
      const i = y * n + x;
      out[i] = out[i] * (1 - (o.radialMix ?? 0.7)) + a * (o.radialMix ?? 0.7);
    }
  }
  return out;
}

/**
 * Paint N tapered brush strokes into `dst` (a Float32Array field), following
 * `flow`. Every write is toroidal so the stroke layer tiles.
 *
 * opts:
 *  count      number of strokes
 *  rng        seeded rng function
 *  flow       Float32Array angle field (from flowField) OR a constant angle
 *  len        [min,max] stroke length in px
 *  width      [min,max] half-width in px
 *  value      [min,max] signed peak amplitude (can be negative = dark strokes)
 *  curl       0..1 how strongly the stroke re-aligns to the flow as it travels
 *  wobble     per-step angular noise
 *  bristle    0..1 amount of streaky bristle modulation across the stroke
 *  taper      exponent of the end taper (higher = pointier)
 *  softness   cross-section falloff exponent
 *  mask       optional Float32Array 0..1 probability field for seeding
 *  jitterHue  unused here (see strokesRGB)
 */
export function strokes(dst, n, o = {}) {
  const rng = o.rng || makeRng(1234);
  const count = o.count ?? 900;
  const flow = o.flow;
  const constAngle = typeof flow === 'number' ? flow : null;
  const flowRes = (flow && flow.length) ? Math.round(Math.sqrt(flow.length)) : n;
  const flowK = flowRes / n;                 // flow may be authored at lower res
  const lenR = o.len || [n * 0.05, n * 0.16];
  const widR = o.width || [1.2, 3.2];
  const valR = o.value || [0.05, 0.16];
  const curl = o.curl ?? 0.35;
  const wobble = o.wobble ?? 0.06;
  const bristle = o.bristle ?? 0.55;
  const taper = o.taper ?? 1.6;
  const softness = o.softness ?? 1.4;
  const mask = o.mask;
  const maskRes = (mask && mask.length) ? Math.round(Math.sqrt(mask.length)) : n;
  const grid = o.seedGrid !== false;
  const gs = Math.max(1, Math.round(Math.sqrt(count)));

  // Every transcendental in the two inner loops is a function of a normalised
  // parameter and a per-call exponent, so it is a table, not a computation.
  // The brush is ~20% of all synthesis time; this is the difference between a
  // painterly library and a slow one, and it changes no pixel by more than
  // half a bit.
  const PROF = _profLUT(taper);
  const FALL = _fallLUT(softness);

  const angAt = (x, y) => (constAngle !== null ? constAngle
    : sampleWrap(flow, flowRes, x * flowK, y * flowK));

  for (let s = 0; s < count; s++) {
    let px, py;
    if (grid) {
      const gi = s % gs, gj = (s / gs) | 0;
      px = ((gi + rng()) / gs) * n;
      py = ((gj + rng()) / gs) * n;
    } else { px = rng() * n; py = rng() * n; }
    if (mask) {
      const m = sampleWrap(mask, maskRes, px * (maskRes / n), py * (maskRes / n));
      if (rng() > m) continue;
    }
    const L = Math.max(3, Math.round(lerp(lenR[0], lenR[1], rng() * rng() + 0.15)));
    const W = lerp(widR[0], widR[1], rng());
    const V = lerp(valR[0], valR[1], rng());
    const bfreq = lerp(1.1, 3.0, rng());
    const bphase = rng() * TAU;
    let ang = angAt(px, py) + (rng() - 0.5) * 0.5;
    const spin = (rng() - 0.5) * 0.02;
    const invL = 1 / L;

    for (let t = 0; t <= L; t++) {
      // painterly end-taper: loaded at the start, dry-brushed at the end
      const prof = PROF[(t * invL * 256) | 0];
      const ww = Math.max(0.6, W * (0.35 + 0.75 * prof));
      const aa = V * (0.25 + 0.9 * prof);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const nx = -dy, ny = dx;
      const steps = Math.max(1, Math.ceil(ww));
      const invS = 1 / steps;
      // bristle streak: cos(d*bfreq + bphase) marched by angle addition
      let bc = 1, bs = 0, cd = 1, sd = 0;
      if (bristle > 0) {
        const a0 = -ww * bfreq + bphase, da = ww * invS * bfreq;
        bc = Math.cos(a0); bs = Math.sin(a0);
        cd = Math.cos(da); sd = Math.sin(da);
      }
      for (let di = -steps; di <= steps; di++) {
        const d = di * invS * ww;
        let f = FALL[(((steps - (di < 0 ? -di : di)) * invS) * 256) | 0];
        if (bristle > 0) {
          f *= 1 - bristle * 0.25 * (1 + bc);
          const nc = bc * cd - bs * sd; bs = bs * cd + bc * sd; bc = nc;
        }
        if (f <= 0.0005) continue;
        splat(dst, n, px + nx * d, py + ny * d, aa * f);
      }
      const target = angAt(px, py);
      let dA = target - ang;
      while (dA > Math.PI) dA -= TAU; while (dA < -Math.PI) dA += TAU;
      ang += dA * curl * 0.25 + (rng() - 0.5) * wobble + spin;
      px += dx; py += dy;
    }
  }
  return dst;
}

// --- brush LUTs (keyed by exponent; a recipe reuses the same few) ----------
const _profCache = new Map(), _fallCache = new Map();
function _profLUT(taper) {
  const k = Math.round(taper * 1000);
  let t = _profCache.get(k);
  if (t) return t;
  t = new Float32Array(257);
  for (let i = 0; i <= 256; i++) t[i] = Math.pow(Math.sin(Math.PI * Math.pow(i / 256, 0.62)), taper * 0.62);
  _profCache.set(k, t);
  return t;
}
function _fallLUT(softness) {
  const k = Math.round(softness * 1000);
  let t = _fallCache.get(k);
  if (t) return t;
  t = new Float32Array(257);
  for (let i = 0; i <= 256; i++) t[i] = Math.pow(i / 256, softness);
  _fallCache.set(k, t);
  return t;
}

/** Angle-safe wrapped sample (interpolates on the unit circle). */
function sampleWrapAngle(flow, n, x, y) {
  if (!flow) return 0;
  const a = sampleWrap(flow, n, x, y);
  return a;
}

/**
 * Colour brush layer: paints strokes straight into an RGB byte buffer using a
 * ramp LUT, with per-stroke ramp offsets so neighbouring strokes differ in HUE,
 * not just value. Used for glazes over an already-ramped albedo.
 */
export function strokesRGB(rgb, n, o = {}) {
  const tmp = new Float32Array(n * n);
  const rng = o.rng || makeRng(99);
  const lut = o.lut;
  const count = o.count ?? 400;
  const alpha = o.alpha ?? 0.35;
  const range = o.range || [0.35, 0.85];
  // paint coverage and a per-stroke ramp coordinate at the same time
  const perStroke = [];
  for (let s = 0; s < count; s++) perStroke.push(lerp(range[0], range[1], rng()));
  let si = 0;
  const sub = Math.max(1, Math.round(count / 24));
  for (let g = 0; g < count; g += sub) {
    tmp.fill(0);
    strokes(tmp, n, { ...o, count: Math.min(sub, count - g), rng });
    const rc = perStroke[si++ % perStroke.length];
    for (let i = 0; i < tmp.length; i++) {
      if (tmp[i] > 0.001) {
        const a = clamp01(tmp[i]) * alpha;
        const li = Math.min(255, Math.max(0, Math.round(rc * 255))) * 3;
        rgb[i * 3] = rgb[i * 3] + (lut[li] - rgb[i * 3]) * a;
        rgb[i * 3 + 1] = rgb[i * 3 + 1] + (lut[li + 1] - rgb[i * 3 + 1]) * a;
        rgb[i * 3 + 2] = rgb[i * 3 + 2] + (lut[li + 2] - rgb[i * 3 + 2]) * a;
      }
    }
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// Ramp mapping
// ---------------------------------------------------------------------------

const _lutCache = new Map();
/** Get (and cache) a baked LUT for a named ramp or a stop array. */
export function lut(ramp, size = 256) {
  const key = typeof ramp === 'string' ? ramp + '|' + size : null;
  if (key && _lutCache.has(key)) return _lutCache.get(key);
  const stops = typeof ramp === 'string' ? (RAMPS[ramp] || RAMPS.ash) : ramp;
  const L = rampLUT(stops, size);
  if (key) _lutCache.set(key, L);
  return L;
}

/** Map a scalar field through a ramp LUT into a Float32 RGB buffer (0..255). */
export function applyRamp(f, n, ramp, out) {
  const L = typeof ramp === 'string' || Array.isArray(ramp) ? lut(ramp) : ramp;
  const rgb = out || new Float32Array(n * n * 3);
  for (let i = 0; i < f.length; i++) {
    let t = f[i]; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const li = (t * 255 + 0.5) | 0;
    const o = li * 3, j = i * 3;
    rgb[j] = L[o]; rgb[j + 1] = L[o + 1]; rgb[j + 2] = L[o + 2];
  }
  return rgb;
}

/**
 * Two-ramp mapping: value field selects position along BOTH ramps, a second
 * "temperature" field crossfades between them. This is how a single material
 * gets genuine hue variation instead of a monochrome value gradient.
 */
export function applyRamp2(f, temp, n, rampA, rampB, out, bias = 0) {
  const A = typeof rampA === 'string' || Array.isArray(rampA) ? lut(rampA) : rampA;
  const B = typeof rampB === 'string' || Array.isArray(rampB) ? lut(rampB) : rampB;
  const rgb = out || new Float32Array(n * n * 3);
  for (let i = 0; i < f.length; i++) {
    let t = f[i]; t = t < 0 ? 0 : t > 1 ? 1 : t;
    let m = temp[i] + bias; m = m < 0 ? 0 : m > 1 ? 1 : m;
    const li = ((t * 255 + 0.5) | 0) * 3, j = i * 3;
    rgb[j] = A[li] + (B[li] - A[li]) * m;
    rgb[j + 1] = A[li + 1] + (B[li + 1] - A[li + 1]) * m;
    rgb[j + 2] = A[li + 2] + (B[li + 2] - A[li + 2]) * m;
  }
  return rgb;
}

/** Composite a ramp-coloured layer over an RGB buffer using a 0..1 mask. */
export function compositeRamp(rgb, n, mask, valueField, ramp, strength = 1) {
  const L = typeof ramp === 'string' || Array.isArray(ramp) ? lut(ramp) : ramp;
  for (let i = 0; i < mask.length; i++) {
    const a = clamp01(mask[i]) * strength;
    if (a <= 0.002) continue;
    const t = valueField ? clamp01(valueField[i]) : 0.7;
    const li = ((t * 255 + 0.5) | 0) * 3, j = i * 3;
    rgb[j] += (L[li] - rgb[j]) * a;
    rgb[j + 1] += (L[li + 1] - rgb[j + 1]) * a;
    rgb[j + 2] += (L[li + 2] - rgb[j + 2]) * a;
  }
  return rgb;
}

/** Multiply an RGB buffer by a per-texel scalar (shading/dirt/AO glaze). */
export function shadeRGB(rgb, n, f, lo = 0.35, hi = 1.25) {
  for (let i = 0; i < f.length; i++) {
    const k = lo + (hi - lo) * clamp01(f[i]);
    const j = i * 3;
    rgb[j] *= k; rgb[j + 1] *= k; rgb[j + 2] *= k;
  }
  return rgb;
}

/** Tint toward a colour by a mask (colour given as [r,g,b] 0..255). */
export function tintRGB(rgb, n, mask, color, strength = 1) {
  for (let i = 0; i < mask.length; i++) {
    const a = clamp01(mask[i]) * strength;
    if (a <= 0.002) continue;
    const j = i * 3;
    rgb[j] += (color[0] - rgb[j]) * a;
    rgb[j + 1] += (color[1] - rgb[j + 1]) * a;
    rgb[j + 2] += (color[2] - rgb[j + 2]) * a;
  }
  return rgb;
}

// ---------------------------------------------------------------------------
// height -> normal, height -> AO, artistic roughness
// ---------------------------------------------------------------------------

/** Sobel height -> tangent-space normal, packed RGBA bytes (OpenGL +Y up). */
export function heightToNormal(h, n, strength = 2.0) {
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    const ym = wrapi(y - 1, n) * n, yp = wrapi(y + 1, n) * n, y0 = y * n;
    for (let x = 0; x < n; x++) {
      const xm = wrapi(x - 1, n), xp = wrapi(x + 1, n);
      const tl = h[ym + xm], t = h[ym + x], tr = h[ym + xp];
      const l = h[y0 + xm], r = h[y0 + xp];
      const bl = h[yp + xm], b = h[yp + x], br = h[yp + xp];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y0 + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Ambient occlusion from height. Multi-scale blurred-cavity approximation,
 * optionally refined with a horizon search. Cheap, wrapped, and it reads like
 * hand-painted crevice shadow.
 */
export function aoFromHeight(h, n, o = {}) {
  // Computed at half resolution and upsampled: occlusion is inherently low
  // frequency and this is 4x cheaper.
  const half = o.fullRes ? n : Math.max(64, n >> 1);
  const src = half === n ? h : resampleTo(h, n, half);
  const scale = half / n;
  const radii = (o.radii || [3, 10, 30]).map((r) => Math.max(1, Math.round(r * scale)));
  const weights = o.weights || [0.42, 0.34, 0.24];
  const gain = o.gain ?? 4.5;
  const acc = new Float32Array(half * half).fill(1);
  for (let k = 0; k < radii.length; k++) {
    const r = Math.min(radii[k], Math.max(1, (half / 8) | 0));
    const b = blurWrap(src, half, r, k === 0 ? 2 : 1);
    const w = (weights[k] ?? 0.2) * gain;
    for (let i = 0; i < acc.length; i++) acc[i] -= clamp01(b[i] - src[i]) * w;
  }
  const strength = o.strength ?? 1;
  const floorV = o.floor ?? 0.22;
  for (let i = 0; i < acc.length; i++) {
    const v = 1 - (1 - clamp01(acc[i])) * strength;
    acc[i] = floorV + (1 - floorV) * clamp01(v);
  }
  let out = half === n ? acc : resampleTo(acc, half, n);
  // re-introduce the crispest crevice darkening at full res
  if (o.micro !== 0) {
    const mb = blurWrap(h, n, Math.max(1, o.microRadius ?? 2), 1);
    const m = o.micro ?? 0.55;
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] - clamp01(mb[i] - h[i]) * 3.0 * m);
  }
  return out;
}

/**
 * ARTISTIC roughness synthesiser. Not physical: polished on convex/worn areas
 * where light will catch, rough and dry in crevices, plus painterly variation
 * so the specular breaks up into shapes instead of a uniform sheen.
 */
export function artisticRoughness(n, o = {}) {
  const base = o.base ?? 0.62;
  const out = new Float32Array(n * n).fill(base);
  const h = o.height;
  if (h) {
    const cav = o.cavity || cavityMask(h, n, o.cavityRadius ?? 6, 5);
    const edge = o.edge || edgeMask(h, n, 3, 6);
    const polish = o.polish ?? 0.3;   // how much convex edges polish up
    const dry = o.dry ?? 0.28;        // how much crevices roughen
    for (let i = 0; i < out.length; i++) out[i] = clamp01(base - edge[i] * polish + cav[i] * dry);
  }
  if (o.variation !== 0) {
    const v = lowFreq(n, (r) => fbm(r, { freq: o.varFreq ?? 5, octaves: 4, seed: (o.seed ?? 71) | 0 }), n >> 2);
    const amt = o.variation ?? 0.16;
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] + (v[i] - 0.5) * 2 * amt);
  }
  if (o.strokes) {
    const s = new Float32Array(n * n);
    strokes(s, n, { ...o.strokes, rng: o.strokes.rng || makeRng((o.seed ?? 71) + 5) });
    const amt = o.strokeAmount ?? 0.2;
    for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] - s[i] * amt);
  }
  const lo = o.min ?? 0.05, hi = o.max ?? 0.98;
  for (let i = 0; i < out.length; i++) out[i] = lo + (hi - lo) * clamp01(out[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Vector rasteriser (wrapped) — for ornament
// ---------------------------------------------------------------------------

export function drawDisc(dst, n, cx, cy, r, v, soft = 1) {
  const r0 = Math.ceil(r + 1);
  for (let dy = -r0; dy <= r0; dy++) {
    for (let dx = -r0; dx <= r0; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + 1) continue;
      const a = 1 - smoothstep(r - soft, r + 0.5, d);
      if (a <= 0.002) continue;
      const x = wrapi(Math.round(cx) + dx, n), y = wrapi(Math.round(cy) + dy, n);
      const i = y * n + x;
      dst[i] = Math.max(dst[i], v * a);
    }
  }
}

export function drawLine(dst, n, x0, y0, x1, y1, w, v, soft = 1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.ceil(len));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    drawDisc(dst, n, x0 + dx * t, y0 + dy * t, w, v, soft);
  }
}

export function drawArc(dst, n, cx, cy, r, a0, a1, w, v, soft = 1) {
  const steps = Math.max(3, Math.ceil(Math.abs(a1 - a0) * r));
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (a1 - a0) * (i / steps);
    drawDisc(dst, n, cx + Math.cos(a) * r, cy + Math.sin(a) * r, w, v, soft);
  }
}

export function drawPolyline(dst, n, pts, w, v, soft = 1) {
  for (let i = 0; i < pts.length - 1; i++) drawLine(dst, n, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, v, soft);
}

/** Filled axis-aligned rounded rect (wrapped). */
export function drawRect(dst, n, x, y, w, h, v, radius = 0, soft = 1) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  for (let j = 0; j < Math.ceil(h); j++) {
    for (let i = 0; i < Math.ceil(w); i++) {
      let a = 1;
      if (radius > 0) {
        const dx = Math.min(i, w - 1 - i), dy = Math.min(j, h - 1 - j);
        const d = Math.min(dx, dy);
        a = smoothstep(0, radius, d);
      }
      const px = wrapi(x0 + i, n), py = wrapi(y0 + j, n);
      const k = py * n + px;
      dst[k] = Math.max(dst[k], v * a);
    }
  }
}

// ---------------------------------------------------------------------------
// Greek ornament vocabulary
// ---------------------------------------------------------------------------

/**
 * Greek key / meander band. Drawn as a continuous stroked path so it reads as
 * carved relief. Runs horizontally at y0 with the given band height.
 */
export function meanderBand(dst, n, o = {}) {
  const y0 = o.y ?? n * 0.5;
  const H = o.height ?? n * 0.09;
  const cells = Math.max(2, Math.round(o.cells ?? 8));
  const w = o.lineW ?? Math.max(1.2, H * 0.13);
  const v = o.value ?? 1;
  const cw = n / cells;
  const inset = H * 0.16;
  for (let c = 0; c < cells; c++) {
    const x = c * cw;
    const a = x + inset, b = x + cw - inset;
    const t = y0 + H * 0.5 - inset, bo = y0 - H * 0.5 + inset;
    const mid = (a + b) * 0.5;
    const q = (b - a) * 0.22, qy = (t - bo) * 0.26;
    // classic single-cell meander spiral, mirrored every other cell
    const flip = (c % 2 === 0) ? 1 : -1;
    const Y = (yy) => (flip > 0 ? yy : (t + bo) - yy);
    const pts = [
      [a, Y(bo)], [a, Y(t)], [b - q, Y(t)], [b - q, Y(bo + qy)],
      [a + q * 1.6, Y(bo + qy)], [a + q * 1.6, Y(t - qy * 1.5)],
      [mid + q * 0.2, Y(t - qy * 1.5)],
    ];
    drawPolyline(dst, n, pts, w, v, o.soft ?? 1.2);
    // connector into the next cell
    drawLine(dst, n, b, Y(bo), b + inset * 2, Y(bo), w, v, o.soft ?? 1.2);
  }
  // rails
  if (o.rails !== false) {
    drawLine(dst, n, 0, y0 - H * 0.62, n, y0 - H * 0.62, w * 0.75, v * 0.9, 1.1);
    drawLine(dst, n, 0, y0 + H * 0.62, n, y0 + H * 0.62, w * 0.75, v * 0.9, 1.1);
  }
  return dst;
}

/** Radiating palmette / anthemion motif. */
export function palmette(dst, n, o = {}) {
  const cx = o.x ?? n * 0.5, cy = o.y ?? n * 0.5;
  const R = o.r ?? n * 0.12;
  const petals = o.petals ?? 9;
  const v = o.value ?? 1;
  const w = o.lineW ?? Math.max(1.2, R * 0.07);
  const spread = o.spread ?? Math.PI * 0.92;
  for (let i = 0; i < petals; i++) {
    const t = petals === 1 ? 0.5 : i / (petals - 1);
    const a = -Math.PI / 2 - spread * 0.5 + spread * t;
    const l = R * (0.55 + 0.45 * Math.sin(Math.PI * t));
    // each petal is a slightly curved lobe
    const pts = [];
    const bend = (t - 0.5) * 0.5;
    for (let k = 0; k <= 8; k++) {
      const kk = k / 8;
      const aa = a + bend * kk * kk;
      pts.push([cx + Math.cos(aa) * l * kk, cy + Math.sin(aa) * l * kk]);
    }
    drawPolyline(dst, n, pts, w * (1 - 0.3 * Math.abs(t - 0.5) * 2) + 0.4, v, 1.1);
    drawDisc(dst, n, pts[8][0], pts[8][1], w * 1.5, v * 0.95, 1.2);
  }
  // volute base
  drawArc(dst, n, cx - R * 0.34, cy + R * 0.14, R * 0.2, -0.4, Math.PI * 1.5, w, v, 1.1);
  drawArc(dst, n, cx + R * 0.34, cy + R * 0.14, R * 0.2, Math.PI * 1.5, Math.PI * 3.4, w, v, 1.1);
  drawDisc(dst, n, cx, cy + R * 0.1, w * 2.2, v, 1.4);
  return dst;
}

/** Guilloche — interwoven sine bands. */
export function guilloche(dst, n, o = {}) {
  const y0 = o.y ?? n * 0.5;
  const amp = o.amp ?? n * 0.035;
  const cycles = Math.max(1, Math.round(o.cycles ?? 6));
  const w = o.lineW ?? 2;
  const v = o.value ?? 1;
  for (let s = 0; s < 2; s++) {
    const ph = s * Math.PI;
    let px = 0, py = y0 + Math.sin(ph) * amp;
    for (let x = 1; x <= n; x++) {
      const a = (x / n) * TAU * cycles + ph;
      const y = y0 + Math.sin(a) * amp;
      drawLine(dst, n, px, py, x, y, w, v, 1.1);
      px = x; py = y;
    }
  }
  if (o.beads !== false) {
    for (let c = 0; c < cycles; c++) drawDisc(dst, n, ((c + 0.5) / cycles) * n, y0, w * 2.0, v * 0.85, 1.3);
  }
  return dst;
}

/** Row of beads (astragal). */
export function beadRow(dst, n, o = {}) {
  const y0 = o.y ?? n * 0.5;
  const count = Math.max(2, Math.round(o.count ?? 24));
  const r = o.r ?? (n / count) * 0.32;
  const v = o.value ?? 1;
  for (let i = 0; i < count; i++) {
    const x = ((i + 0.5) / count) * n;
    drawDisc(dst, n, x, y0, r, v, r * 0.6);
    if (o.spacers) drawDisc(dst, n, x + n / count / 2, y0, r * 0.35, v * 0.8, r * 0.3);
  }
  return dst;
}

/** Laurel / olive band — paired leaves along a stem. */
export function laurelBand(dst, n, o = {}) {
  const y0 = o.y ?? n * 0.5;
  const leaves = Math.max(4, Math.round(o.leaves ?? 18));
  const L = o.leafLen ?? n * 0.045;
  const v = o.value ?? 1;
  const w = o.lineW ?? 1.6;
  drawLine(dst, n, 0, y0, n, y0, w * 0.9, v * 0.8, 1.1);
  for (let i = 0; i < leaves; i++) {
    const x = ((i + 0.5) / leaves) * n;
    for (const s of [-1, 1]) {
      const a = s * (Math.PI * 0.32) - Math.PI * 0.0;
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const kk = k / 6;
        pts.push([x + Math.cos(a * (1 - kk * 0.3)) * L * kk * 1.15, y0 + Math.sin(a) * L * kk]);
      }
      drawPolyline(dst, n, pts, w * 1.2, v, 1.2);
      // leaf body
      for (let k = 1; k <= 6; k++) {
        const kk = k / 6;
        const wid = w * 2.4 * Math.sin(Math.PI * kk);
        drawDisc(dst, n, pts[k][0], pts[k][1], Math.max(0.8, wid), v * 0.95, 1.2);
      }
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Layout generators
// ---------------------------------------------------------------------------

/**
 * Ashlar block layout (running-bond masonry).
 * Returns { height, id, mortar, block } fields.
 *   height  bevelled block surface (0 in mortar, ~1 in block centre)
 *   id      per-block 0..1 random value (for per-block tone variation)
 *   mortar  0..1 mask of the recessed seam
 */
export function ashlar(n, o = {}) {
  const rows = Math.max(1, Math.round(o.rows ?? 5));
  const cols = Math.max(1, Math.round(o.cols ?? 3));
  const rng = o.rng || makeRng(4242);
  const mortar = (o.mortar ?? 0.022) * n;
  const bevel = (o.bevel ?? 0.05) * (n / rows);
  const height = new Float32Array(n * n);
  const id = new Float32Array(n * n);
  const seam = new Float32Array(n * n);
  const lobe = new Float32Array(n * n);
  // per-block light/shade axis — see tileGrid
  const LX = new Float32Array(256), LY = new Float32Array(256);
  for (let k = 0; k < 256; k++) { const a = (k / 256) * TAU; LX[k] = Math.cos(a); LY[k] = Math.sin(a); }
  const rh = n / rows;

  // pre-roll per-row column splits so the layout is deterministic
  const layout = [];
  for (let r = 0; r < rows; r++) {
    const c = Math.max(1, cols + (rng() < 0.4 ? 1 : 0));
    const edges = [0];
    let acc = 0;
    const wts = [];
    for (let i = 0; i < c; i++) wts.push(0.6 + rng() * 0.9);
    const tot = wts.reduce((a, b) => a + b, 0);
    for (let i = 0; i < c; i++) { acc += wts[i] / tot; edges.push(acc); }
    layout.push({ edges, offset: rng(), tone: Array.from({ length: c }, () => rng()) });
  }

  // wobble the seams so they are chiselled, not CAD
  const wr = Math.max(64, n >> 2);
  const wob = resampleTo(fbm(wr, { freq: 6, octaves: 4, seed: 813, type: 'grad' }), wr, n);
  const wobA = (o.wobble ?? 0.012) * n;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const wx = x + (wob[i] - 0.5) * 2 * wobA;
      const wy = y + (wob[(wrapi(y + 37, n) * n + wrapi(x + 91, n))] - 0.5) * 2 * wobA;
      const ry = wy / rh;
      const r = wrapi(Math.floor(ry), rows);
      const fy = ry - Math.floor(ry);
      const L = layout[r];
      const u = (((wx / n) + L.offset) % 1 + 1) % 1;
      let c = 0;
      while (c < L.edges.length - 2 && u > L.edges[c + 1]) c++;
      const u0 = L.edges[c], u1 = L.edges[c + 1];
      const bw = (u1 - u0) * n;
      const fx = (u - u0) / (u1 - u0);
      // distance to nearest seam, in px
      const dEdgeX = Math.min(fx, 1 - fx) * bw;
      const dEdgeY = Math.min(fy, 1 - fy) * rh;
      const d = Math.min(dEdgeX, dEdgeY);
      const m = 1 - smoothstep(mortar * 0.5, mortar * 0.5 + bevel, d);
      seam[i] = m;
      height[i] = 1 - m;
      id[i] = L.tone[c % L.tone.length];
      // see tileGrid: the block's own light/shade axis, hand-painted per block
      const lk = ihash(c, r, 4409) & 255;
      lobe[i] = (fx - 0.5) * LX[lk] + (fy - 0.5) * LY[lk];
    }
  }
  return { height, id, mortar: seam, lobe };
}

/**
 * Tile grid for floors. pattern: 'grid' | 'offset' | 'herringbone' | 'diamond'
 * Returns { height, id, seam }.
 */
export function tileGrid(n, o = {}) {
  const cols = Math.max(1, Math.round(o.cols ?? 4));
  const rows = Math.max(1, Math.round(o.rows ?? cols));
  const pattern = o.pattern || 'grid';
  const gap = (o.gap ?? 0.012) * n;
  const bevel = (o.bevel ?? 0.02) * n;
  const rng = o.rng || makeRng(777);
  const tone = [];
  for (let i = 0; i < cols * rows * 2 + 8; i++) tone.push(rng());
  const height = new Float32Array(n * n);
  const id = new Float32Array(n * n);
  const seam = new Float32Array(n * n);
  // Per-cell directional VALUE LOBE. A painter does not fill a flagstone with
  // one tone and add noise: they lay a loaded stroke across it and the stone
  // ends up light on one side and shaded on the other, with a different axis
  // on the stone next to it. That is what carries the 0.3 of value swing
  // *inside a single stone* that a procedural per-cell tint cannot. Free here:
  // the cell-local coordinates already exist in this loop and were thrown away.
  const lobe = new Float32Array(n * n);
  const lx = new Float32Array(tone.length), ly = new Float32Array(tone.length);
  for (let k = 0; k < tone.length; k++) {
    const a = tone[(k * 7 + 3) % tone.length] * TAU;
    lx[k] = Math.cos(a); ly[k] = Math.sin(a);
  }
  const wr = Math.max(64, n >> 2);
  const wob = resampleTo(fbm(wr, { freq: 8, octaves: 3, seed: 5150, type: 'grad' }), wr, n);
  const wobA = (o.wobble ?? 0.004) * n;
  const cw = n / cols, ch = n / rows;

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const wx = x + (wob[i] - 0.5) * 2 * wobA;
      const wy = y + (wob[wrapi(y + 53, n) * n + wrapi(x + 17, n)] - 0.5) * 2 * wobA;
      let cx, cy, dx, dy, key;
      if (pattern === 'diamond') {
        cx = (wx + wy) / cw; cy = (wy - wx) / ch;
      } else if (pattern === 'offset') {
        cy = wy / ch;
        const rowI = Math.floor(cy);
        cx = wx / cw + (rowI % 2 ? 0.5 : 0);
      } else {
        cx = wx / cw; cy = wy / ch;
      }
      const ix = Math.floor(cx), iy = Math.floor(cy);
      dx = cx - ix; dy = cy - iy;
      key = wrapi(ix * 7 + iy * 13, tone.length);
      const dEdge = Math.min(Math.min(dx, 1 - dx) * cw, Math.min(dy, 1 - dy) * ch);
      const m = 1 - smoothstep(gap * 0.5, gap * 0.5 + bevel, dEdge);
      seam[i] = m;
      height[i] = 1 - m;
      id[i] = tone[key];
      lobe[i] = (dx - 0.5) * lx[key] + (dy - 0.5) * ly[key];
    }
  }
  return { height, id, seam, lobe };
}

/** Woven cloth weave (warp/weft) height field. */
export function weave(n, o = {}) {
  const threads = Math.max(4, Math.round(o.threads ?? 64));
  const out = new Float32Array(n * n);
  const s = threads / n;
  const jitter = lowFreq(n, (r) => fbm(r, { freq: 5, octaves: 3, seed: (o.seed ?? 60) | 0 }), n >> 2);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = (x + 0.5) * s, v = (y + 0.5) * s;
      const cu = Math.floor(u), cv = Math.floor(v);
      const fu = u - cu, fv = v - cv;
      const over = ((cu + cv) & 1) === 0;
      const a = Math.sin(Math.PI * fu), b = Math.sin(Math.PI * fv);
      const val = over ? 0.35 + 0.65 * a : 0.35 + 0.65 * b;
      out[i] = val * (0.82 + 0.36 * jitter[i]);
    }
  }
  return out;
}

/** Wood grain: stretched, warped rings with knots. */
export function woodGrain(n, o = {}) {
  const rings = o.rings ?? 26;
  const seed = (o.seed ?? 91) | 0;
  const stretch = o.stretch ?? 7;
  const base = fbm(n, { freq: Math.max(1, Math.round(rings / 3)), octaves: 5, seed, type: 'grad' });
  const along = fbm(n, { freq: 2, octaves: 4, seed: seed + 5, type: 'grad' });
  const out = new Float32Array(n * n);
  const knots = [];
  const rng = makeRng(seed + 31);
  const kc = o.knots ?? 3;
  for (let i = 0; i < kc; i++) knots.push([rng() * n, rng() * n, n * (0.03 + rng() * 0.05)]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      // ring coordinate runs along +x, compressed; warped by noise
      let t = (y / n) * rings + (base[i] - 0.5) * 3.2 + (along[i] - 0.5) * 1.4;
      for (const k of knots) {
        let dx = x - k[0], dy = y - k[1];
        dx = ((dx % n) + n * 1.5) % n - n * 0.5;
        dy = ((dy % n) + n * 1.5) % n - n * 0.5;
        dy *= stretch * 0.25;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < k[2] * 9) t += Math.exp(-d / (k[2] * 2.2)) * 6.0;
      }
      const f = t - Math.floor(t);
      out[i] = 0.5 + 0.5 * Math.cos(f * TAU) * (0.6 + 0.4 * base[i]);
    }
  }
  return out;
}

/**
 * A DRAWN vein / hairline-crack network: long meandering polylines with
 * branches, rasterised with wrapped soft discs. Noise-thresholded "veins" always
 * read as blobs; drawing them like a painter would is what makes marble read as
 * marble and bone read as bone.
 */
export function veinNetwork(n, o = {}) {
  const dst = new Float32Array(n * n);
  const rng = o.rng || makeRng(o.seed ?? 7);
  const count = Math.max(1, Math.round(o.count ?? 8));
  const lenK = o.len ?? 1.6;
  const wid = o.width || [0.7, 2.6];
  const meander = o.meander ?? 0.75;     // how far the vein swings off its heading
  const jitter = o.jitter ?? 0.05;       // per-step tremble
  const branch = o.branch ?? 0.006;
  const scale = n / 512;
  for (let i = 0; i < count; i++) {
    let x = rng() * n, y = rng() * n;
    // A vein keeps a HEADING and meanders around it on two slow sines. Random
    // walking alone curls into loops, which reads as scribble, not stone.
    const base = rng() * TAU;
    const f1 = 0.0035 + rng() * 0.0075, f2 = 0.014 + rng() * 0.022;
    const p1 = rng() * TAU, p2 = rng() * TAU;
    const a1 = meander * (0.6 + rng() * 0.6), a2 = meander * (0.15 + rng() * 0.2);
    const steps = Math.round(n * lenK * (0.6 + rng() * 0.8));
    const wa = wid[0] * scale, wb = wid[1] * scale;
    let tremble = 0;
    for (let s = 0; s < steps; s++) {
      const k = s / steps;
      const taper = Math.pow(Math.sin(Math.PI * Math.min(1, k * 1.02)), 0.4);
      const w = Math.max(0.45, (wa + (wb - wa) * taper) * (0.7 + rng() * 0.6));
      const strength = (0.55 + 0.45 * taper) * (1 - 0.22 * rng());
      drawDisc(dst, n, x, y, w, strength, w * 0.95);
      tremble += (rng() - 0.5) * jitter;
      tremble *= 0.86;
      const a = base + Math.sin(s * f1 + p1) * a1 + Math.sin(s * f2 + p2) * a2 + tremble;
      x += Math.cos(a); y += Math.sin(a);
      if (rng() < branch) {
        let bx = x, by = y, ba = a + (rng() < 0.5 ? 1 : -1) * (0.45 + rng() * 0.55);
        const bl = Math.max(6, Math.round(steps * 0.16 * rng()));
        for (let t = 0; t < bl; t++) {
          const bw = Math.max(0.45, w * 0.55 * (1 - t / bl));
          drawDisc(dst, n, bx, by, bw, 0.7 * (1 - t / bl) + 0.2, bw * 0.95);
          ba += (rng() - 0.5) * 0.16; bx += Math.cos(ba); by += Math.sin(ba);
        }
      }
    }
  }
  return dst;
}

/** Marble veining: turbulence-warped stripes (classic, still the best). */
export function marbleVeins(n, o = {}) {
  // The stripe direction must be an INTEGER frequency vector or the veins will
  // not wrap. (fx, fy) = cycles across the texture in x and y.
  const fx = Math.round(o.fx ?? 2), fy = Math.round(o.fy ?? 3);
  const seed = (o.seed ?? 12) | 0;
  const turb = turbulence(n, { freq: o.turbFreq ?? 4, octaves: 6, seed, type: 'grad' });
  const turb2 = turbulence(n, { freq: 9, octaves: 4, seed: seed + 77, type: 'grad' });
  const out = new Float32Array(n * n);
  const amp = o.amp ?? 5.0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = (x / n) * fx + (y / n) * fy;
      const v = Math.sin((u + turb[i] * amp + turb2[i] * amp * 0.35) * TAU);
      out[i] = clamp01(0.5 + 0.5 * v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Byte packing (pure — no THREE). These produce exactly the buffers the
// DataTextures in texgen.js upload, so they can be produced inside a Worker and
// transferred as raw ArrayBuffers instead of blocking the main thread.
// ---------------------------------------------------------------------------

/** Float RGB (0..255) -> RGBA8 bytes. */
export function packRGB8(rgb, n) {
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const j = i * 3, k = i * 4;
    data[k] = rgb[j] < 0 ? 0 : rgb[j] > 255 ? 255 : rgb[j];
    data[k + 1] = rgb[j + 1] < 0 ? 0 : rgb[j + 1] > 255 ? 255 : rgb[j + 1];
    data[k + 2] = rgb[j + 2] < 0 ? 0 : rgb[j + 2] > 255 ? 255 : rgb[j + 2];
    data[k + 3] = 255;
  }
  return data;
}

/** ao / rough / metal -> packed ORM RGBA8 bytes (glTF convention). */
export function packORM8(ao, rough, metal, n) {
  const data = new Uint8Array(n * n * 4);
  const isNum = typeof metal === 'number';
  for (let i = 0; i < n * n; i++) {
    const k = i * 4;
    data[k] = clamp01(ao ? ao[i] : 1) * 255;
    data[k + 1] = clamp01(rough ? rough[i] : 0.7) * 255;
    data[k + 2] = clamp01(isNum ? metal : (metal ? metal[i] : 0)) * 255;
    data[k + 3] = 255;
  }
  return data;
}

/** Single-channel field -> greyscale RGBA8 bytes. */
export function packField8(f, n) {
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const v = clamp01(f[i]) * 255, k = i * 4;
    data[k] = v; data[k + 1] = v; data[k + 2] = v; data[k + 3] = 255;
  }
  return data;
}
