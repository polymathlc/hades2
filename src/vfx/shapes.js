// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// THE SHAPE LANGUAGE (ART_DIRECTION §5, §7)
//
// Every sprite EREBUS draws comes out of one 1024² atlas generated once at
// boot. There are no gaussian blobs in here and no round white dots (§7 bans
// them outright). Each shape is authored as a signed-distance / stroke field
// evaluated per texel so the silhouette has *intentional edges*: tapered tips,
// asymmetric falloff, a hard "painted" outer edge on the smoke, sharp concave
// points on the sparkles.
//
// CHANNEL PACKING — this is what makes §5's 3-layer construction free:
//   R = BODY      the saturated mid. tinted by the god colour.
//   G = CORE      a small, hot, near-white region. tinted toward white.
//   B = GLOW      a wide, low-amplitude halo. tinted, used at low alpha.
//   A = COVERAGE  max(body, core) — the alpha-blended (smoke) mask.
// A fragment shader therefore reads   colour = tint*R + white*G*boost + tint*B*k
// and gets core/body/glow separation out of a single texture fetch.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { RNG } from '../core/rng.js';

export const CELL = 256;
export const GRID = 4;                       // 4x4 cells -> 1024²
export const ATLAS = CELL * GRID;

/** Cell indices. Order is the atlas layout, row-major from top-left. */
export const SHAPE = {
  crescent: 0,   // swept slash arc, sharp leading edge, tapered tips
  star: 1,       // four-point flare, unequal arms
  ring: 2,       // shockwave ring, hard outer edge, hand-drawn wobble
  glow: 3,       // the GLOW LAYER only — never used alone at full alpha
  ember: 4,      // hooked teardrop flame
  spark: 5,      // streak with a hot head and a vanishing tail
  puff: 6,       // painted-edge smoke, lumpy silhouette, internal brushwork
  rune: 7,       // greek sigil — broken circle, triangle, bars
  crack: 8,      // branching ground fracture (decal)
  splatter: 9,   // ichor blob + tailed droplets + specks (decal)
  shard: 10,     // angular wedge, crisp diagonal edges
  wisp: 11,      // S-curved shade wisp (death effect)
  chevron: 12,   // directional double-stroke arrow / speed line
  burst: 13,     // radial line-burst, anisotropic impact flash
  diamond: 14,   // concave 4-point sparkle (the anti-round-dot)
  speckle: 15,   // painterly dust flecks
};

export const SHAPE_NAMES = Object.keys(SHAPE);

// ── small math kit ─────────────────────────────────────────────────────────
const PI = Math.PI, TAU = PI * 2;
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };
/** 1 inside, 0 outside, with a `w`-wide painted edge. */
const band = (d, w) => 1 - sstep(-w, w, d);
/** distance from p to segment ab */
function segD(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 1e-9 ? (wx * vx + wy * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t, dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy);
}
/** distance to a *tapered* segment: width lerps wa->wb along it. Returns signed. */
function segTaper(px, py, ax, ay, bx, by, wa, wb) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const L2 = vx * vx + vy * vy;
  let t = L2 > 1e-9 ? (wx * vx + wy * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - vx * t, dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy) - (wa + (wb - wa) * t);
}

// ---------------------------------------------------------------------------
// Shape painters. Each writes body/core/glow for one texel at (x,y) in [-1,1].
// They return via the shared `out` triple to avoid per-texel allocation.
// ---------------------------------------------------------------------------
const out = { b: 0, c: 0, g: 0 };

function shCrescent(x, y, r, th) {
  // arc centred on +Y, half-extent A. Thickness tapers to a point at both tips
  // so the crescent ENDS, it does not get cut off (that is the difference
  // between a drawn slash and a clipped annulus).
  const A = 1.92;                                   // ~110°
  let a = Math.atan2(x, y);                         // 0 on +Y
  const u = (a + A) / (2 * A);
  if (u < 0 || u > 1) { out.b = out.c = out.g = 0; return; }
  const taper = Math.pow(Math.sin(u * PI), 0.55);
  const R = 0.635 + 0.012 * Math.sin(u * PI * 3.0);  // hand-drawn wobble
  const t = 0.255 * taper;
  const d = r - R;
  // asymmetric falloff: leading (outer) edge is sharp, trailing wash is soft
  const body = d > 0
    ? 1 - sstep(t * 0.30, t * 0.70, d)
    : 1 - sstep(t * 0.55, t * 1.35, -d);
  // the hot line rides just inside the leading edge
  const cd = Math.abs(d - t * 0.30);
  const core = (1 - sstep(t * 0.05, t * 0.26, cd)) * Math.pow(taper, 1.9);
  out.b = body * taper;
  out.c = core;
  out.g = (1 - sstep(t * 0.6, t * 3.2, Math.abs(d))) * taper * 0.85;
}

function arm(px, py, len, wid, p) {
  const f = 1 - Math.abs(px) / len;
  if (f <= 0) return 0;
  const w = wid * (0.25 + 0.75 * f);
  return Math.pow(f, p) * Math.exp(-(py * py) / (w * w));
}
function shStar(x, y, r) {
  const dx = (x + y) * 0.70710678, dy = (x - y) * 0.70710678;
  let b = Math.max(
    arm(x, y, 0.99, 0.052, 1.5),
    arm(y, x, 0.66, 0.046, 1.5),
  );
  b = Math.max(b, 0.46 * Math.max(arm(dx, dy, 0.40, 0.055, 1.6), arm(dy, dx, 0.40, 0.055, 1.6)));
  const hub = Math.pow(Math.max(0, 1 - r / 0.20), 2.2);
  out.b = clamp01(b + hub * 0.95);
  out.c = Math.pow(Math.max(0, 1 - r / 0.085), 1.4) + 0.35 * Math.max(arm(x, y, 0.55, 0.020, 1.2), arm(y, x, 0.40, 0.018, 1.2));
  out.c = clamp01(out.c);
  out.g = Math.pow(Math.max(0, 1 - r / 0.85), 2.6) * 0.8;
}

function shRing(x, y, r, th) {
  const R = 0.72 + 0.016 * Math.sin(th * 5 + 1.2) + 0.008 * Math.sin(th * 11 - 0.4);
  const t = 0.082 * (1 + 0.30 * Math.sin(th * 3 + 0.7) + 0.16 * Math.sin(th * 7 + 2.1));
  const d = r - R;
  const body = d > 0 ? 1 - sstep(t * 0.20, t * 0.85, d) : 1 - sstep(t * 0.9, t * 2.6, -d);
  out.b = body;
  out.c = 1 - sstep(t * 0.10, t * 0.42, Math.abs(d + t * 0.12));
  out.g = (1 - sstep(t * 1.0, t * 7.0, Math.abs(d))) * 0.7;
}

function shGlow(x, y, r) {
  // deliberately NOT a circle: squashed and softly lobed so it can never read
  // as the round white dot §7 bans, even at full opacity.
  const th = Math.atan2(y, x);
  const rr = r / (0.96 + 0.10 * Math.sin(th * 2 + 0.6) + 0.05 * Math.sin(th * 3 - 1.1));
  out.b = Math.pow(Math.max(0, 1 - rr), 2.3);
  out.c = Math.pow(Math.max(0, 1 - rr / 0.17), 1.8) * 0.9;
  out.g = Math.pow(Math.max(0, 1 - rr), 3.4);
}

function shEmber(x, y) {
  const t = clamp01((y + 0.62) / 1.42);             // 0 at the bulb, 1 at the tip
  const cx = 0.20 * t * t;                          // the flame hooks
  const w = 0.235 * Math.pow(1 - t, 0.72) * (0.35 + 0.65 * Math.pow(clamp01(t / 0.14), 0.7));
  const d = Math.abs(x - cx) - w;
  out.b = band(d, 0.030) * (0.55 + 0.45 * (1 - t));
  out.c = band(Math.abs(x - cx * 0.6) - w * 0.34, 0.020) * Math.pow(1 - t, 1.6);
  out.g = band(d - 0.09, 0.13) * 0.55;
}

function shSpark(x, y) {
  const t = clamp01((x + 0.92) / 1.80);             // tail 0 -> head 1
  const y0 = 0.13 * (t - 1) * (t - 1);              // slight arc
  const w = 0.085 * Math.pow(t, 1.7) + 0.004;
  const head = Math.pow(Math.max(0, 1 - Math.sqrt((x - 0.80) * (x - 0.80) + (y - y0) * (y - y0)) / 0.10), 1.6);
  const d = Math.abs(y - y0) - w;
  out.b = clamp01(band(d, 0.016) * (0.35 + 0.65 * t) + head * 0.9);
  out.c = clamp01(band(Math.abs(y - y0) - w * 0.36, 0.012) * sstep(0.45, 0.85, t) + head);
  out.g = band(d - 0.05, 0.10) * 0.45 * t;
}

function shPuff(x, y, r, th) {
  const R = 0.615 + 0.125 * Math.sin(th * 3 + 0.9) + 0.070 * Math.sin(th * 5 + 2.4)
    + 0.045 * Math.sin(th * 8 + 4.1) + 0.022 * Math.sin(th * 13 - 1.7);
  const d = r - R;
  // a HARD painted edge — this is the single thing that stops smoke reading as sim-fog
  const m = 1 - sstep(-0.055, 0.012, d);
  const brush = 0.80 + 0.20 * Math.sin(x * 8.5 + y * 5.2) * Math.sin(y * 6.1 - x * 3.4);
  const lift = 0.45 + 0.55 * Math.pow(clamp01(1 - r / (R + 1e-4)), 0.65);
  out.b = m * brush * lift;
  const cdx = x + 0.14, cdy = y - 0.16;
  out.c = Math.pow(Math.max(0, 1 - Math.sqrt(cdx * cdx + cdy * cdy) / 0.34), 1.7) * 0.55 * m;
  out.g = (1 - sstep(-0.10, 0.30, d)) * 0.45;
}

// stroke sets built once, then evaluated per texel
function buildRune() {
  const segs = [];
  // broken outer circle (3 arcs)
  const R = 0.80;
  for (const [a0, a1] of [[0.25, 2.05], [2.45, 4.25], [4.65, 6.05]]) {
    const N = 7;
    for (let i = 0; i < N; i++) {
      const t0 = a0 + (a1 - a0) * (i / N), t1 = a0 + (a1 - a0) * ((i + 1) / N);
      segs.push([Math.cos(t0) * R, Math.sin(t0) * R, Math.cos(t1) * R, Math.sin(t1) * R, 0.030, 0.030]);
    }
  }
  // inscribed triangle
  const tri = [[0, 0.52], [-0.45, -0.26], [0.45, -0.26]];
  for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3];
    segs.push([a[0], a[1], b[0], b[1], 0.026, 0.026]);
  }
  // vertical bar + ticks
  segs.push([0, -0.44, 0, 0.40, 0.030, 0.014]);
  segs.push([-0.20, 0.10, 0.20, 0.10, 0.018, 0.018]);
  segs.push([-0.13, -0.10, 0.13, -0.10, 0.015, 0.015]);
  return segs;
}
function buildCrack() {
  const rng = new RNG('erebus:crack');
  const segs = [];
  const grow = (x, y, ang, len, w, depth) => {
    let px = x, py = y, a = ang, ww = w;
    const steps = depth === 0 ? 5 : 3;
    for (let i = 0; i < steps; i++) {
      a += rng.range(-0.42, 0.42);
      const l = len * rng.range(0.7, 1.15);
      const nx = px + Math.cos(a) * l, ny = py + Math.sin(a) * l;
      const w2 = ww * 0.72;
      segs.push([px, py, nx, ny, ww, w2]);
      if (depth === 0 && i >= 1 && i <= 3 && rng.bool(0.85)) {
        grow(nx, ny, a + rng.sign() * rng.range(0.5, 1.0), l * 0.62, w2 * 0.62, 1);
      }
      px = nx; py = ny; ww = w2;
    }
  };
  for (let k = 0; k < 6; k++) grow(rng.range(-0.05, 0.05), rng.range(-0.05, 0.05), k * TAU / 6 + rng.range(-0.3, 0.3), 0.20, 0.040, 0);
  return segs;
}
function buildSplatter() {
  const rng = new RNG('erebus:splat');
  const segs = [], blobs = [];
  blobs.push([0, 0, 0.30, 1]);
  for (let i = 0; i < 11; i++) {
    const a = rng.range(0, TAU), d = rng.range(0.36, 0.82);
    const x = Math.cos(a) * d, y = Math.sin(a) * d, rr = rng.range(0.045, 0.125) * (1 - d * 0.5);
    blobs.push([x, y, rr, 0.9]);
    segs.push([Math.cos(a) * d * 0.55, Math.sin(a) * d * 0.55, x, y, rr * 0.35, rr * 0.9]);
  }
  for (let i = 0; i < 16; i++) {
    const a = rng.range(0, TAU), d = rng.range(0.55, 0.97);
    blobs.push([Math.cos(a) * d, Math.sin(a) * d, rng.range(0.012, 0.034), 0.8]);
  }
  return { segs, blobs };
}
function buildSpeckle() {
  const rng = new RNG('erebus:speckle');
  const flecks = [];
  for (let i = 0; i < 26; i++) {
    const a = rng.range(0, TAU), d = Math.sqrt(rng.f()) * 0.82;
    flecks.push([Math.cos(a) * d, Math.sin(a) * d, rng.range(0.020, 0.070), rng.range(0, PI), rng.range(0.35, 1.0)]);
  }
  return flecks;
}
function buildBurst() {
  const rng = new RNG('erebus:burst');
  const rays = [];
  for (let i = 0; i < 15; i++) {
    const a = i * TAU / 15 + rng.range(-0.10, 0.10);
    rays.push([a, rng.range(0.42, 0.95), rng.range(0.030, 0.062)]);
  }
  return rays;
}

const RUNE_SEGS = buildRune();
const CRACK_SEGS = buildCrack();
const SPLAT = buildSplatter();
const SPECKS = buildSpeckle();
const RAYS = buildBurst();

function shStrokes(x, y, segs, edge, coreK) {
  let d = 1e9;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const v = segTaper(x, y, s[0], s[1], s[2], s[3], s[4], s[5]);
    if (v < d) d = v;
  }
  out.b = band(d, edge);
  out.c = band(d + coreK, edge * 0.7);
  out.g = band(d - 0.055, 0.075) * 0.5;
}

function shSplatter(x, y) {
  let d = 1e9;
  for (let i = 0; i < SPLAT.segs.length; i++) {
    const s = SPLAT.segs[i];
    const v = segTaper(x, y, s[0], s[1], s[2], s[3], s[4], s[5]);
    if (v < d) d = v;
  }
  for (let i = 0; i < SPLAT.blobs.length; i++) {
    const b = SPLAT.blobs[i];
    const dx = x - b[0], dy = y - b[1];
    const th = Math.atan2(dy, dx);
    const rr = b[2] * (1 + 0.22 * Math.sin(th * 3 + b[0] * 9) + 0.12 * Math.sin(th * 5 - b[1] * 7));
    const v = Math.sqrt(dx * dx + dy * dy) - rr;
    if (v < d) d = v;
  }
  out.b = band(d, 0.016) * (0.72 + 0.28 * Math.sin(x * 11 + y * 7));
  out.c = band(d + 0.030, 0.014) * 0.5;
  out.g = band(d - 0.05, 0.07) * 0.35;
}

function shShard(x, y) {
  // intersection of four half-planes -> a crisp asymmetric wedge
  const hp = (nx, ny, c) => (x * nx + y * ny) - c;
  const d = Math.max(
    hp(0.94, 0.34, 0.30),
    hp(-0.62, 0.78, 0.16),
    hp(-0.30, -0.95, 0.62),
    hp(0.88, -0.47, 0.72),
  );
  out.b = band(d, 0.014);
  out.c = band(d + 0.075, 0.020) * 0.85;
  out.g = band(d - 0.06, 0.09) * 0.4;
}

function shWisp(x, y) {
  const t = clamp01((y + 0.92) / 1.84);
  const cx = 0.30 * Math.sin(t * 3.4 - 0.7) * (0.35 + 0.65 * t);
  const w = 0.145 * Math.pow(Math.sin(clamp01(t) * PI), 0.75) * Math.pow(1 - t * 0.55, 0.8);
  const d = Math.abs(x - cx) - w;
  out.b = band(d, 0.026) * (0.45 + 0.55 * (1 - t));
  out.c = band(Math.abs(x - cx) - w * 0.30, 0.018) * Math.pow(1 - t, 2.0) * 0.9;
  out.g = band(d - 0.075, 0.11) * 0.5;
}

function shChevron(x, y) {
  const d = Math.min(
    segTaper(x, y, -0.62, 0.70, 0.55, 0.02, 0.020, 0.085),
    segTaper(x, y, -0.62, -0.70, 0.55, -0.02, 0.020, 0.085),
  );
  out.b = band(d, 0.020);
  out.c = band(d + 0.038, 0.016) * 0.9;
  out.g = band(d - 0.05, 0.08) * 0.45;
}

function shBurst(x, y, r, th) {
  let b = 0, c = 0;
  for (let i = 0; i < RAYS.length; i++) {
    const R = RAYS[i];
    let da = th - R[0];
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const f = 1 - r / R[1];
    if (f <= 0) continue;
    const w = R[2] * (0.20 + 0.80 * f);
    const v = Math.exp(-(da * da * r * r) / (w * w)) * Math.pow(f, 0.9);
    if (v > b) b = v;
    if (r < R[1] * 0.42 && v > c) c = v;
  }
  const hub = Math.pow(Math.max(0, 1 - r / 0.17), 2.0);
  out.b = clamp01(b + hub);
  out.c = clamp01(c * 0.6 + Math.pow(Math.max(0, 1 - r / 0.085), 1.5));
  out.g = Math.pow(Math.max(0, 1 - r / 0.9), 3.0) * 0.7;
}

function shDiamond(x, y, r, th) {
  // astroid: concave edges, four needle points. The opposite of a round dot.
  const p = 0.62;
  const k = Math.pow(Math.abs(Math.cos(th)), p) + Math.pow(Math.abs(Math.sin(th)), p);
  const R = 0.94 / Math.max(k, 1e-4);
  const d = r - Math.min(R, 1.2);
  out.b = band(d, 0.020);
  out.c = band(d + 0.30, 0.055) * 0.95;
  out.g = band(d - 0.06, 0.10) * 0.45;
}

function shSpeckle(x, y) {
  let b = 0, c = 0;
  for (let i = 0; i < SPECKS.length; i++) {
    const f = SPECKS[i];
    const dx = x - f[0], dy = y - f[1];
    const ca = Math.cos(f[3]), sa = Math.sin(f[3]);
    const rx = (dx * ca + dy * sa) / f[2], ry = (-dx * sa + dy * ca) / (f[2] * 0.42);
    const d = Math.max(Math.abs(rx), Math.abs(ry) * 0.9) + 0.25 * Math.abs(rx * ry) - 1;
    const v = band(d * f[2], 0.010) * f[4];
    if (v > b) b = v;
    if (v * 0.55 > c) c = v * 0.5;
  }
  out.b = b; out.c = c; out.g = b * 0.35;
}

// ---------------------------------------------------------------------------
function paintCell(data, cell, fn) {
  const cx = (cell % GRID) * CELL, cy = Math.floor(cell / GRID) * CELL;
  for (let j = 0; j < CELL; j++) {
    const y = 1 - 2 * ((j + 0.5) / CELL);
    const row = (cy + j) * ATLAS;
    for (let i = 0; i < CELL; i++) {
      const x = 2 * ((i + 0.5) / CELL) - 1;
      const r = Math.sqrt(x * x + y * y);
      out.b = 0; out.c = 0; out.g = 0;
      if (r < 1.34) fn(x, y, r, Math.atan2(y, x));
      const o = (row + cx + i) * 4;
      const b = clamp01(out.b), c = clamp01(out.c), g = clamp01(out.g);
      data[o] = b * 255;
      data[o + 1] = c * 255;
      data[o + 2] = g * 255;
      data[o + 3] = Math.max(b, c) * 255;
    }
  }
}

let _atlas = null;

/**
 * Build (once) and return the shape atlas as a THREE.DataTexture.
 * ~35 ms of pure JS at boot; nothing is fetched and nothing is async.
 */
export function shapeAtlas() {
  if (_atlas) return _atlas;
  const data = new Uint8ClampedArray(ATLAS * ATLAS * 4);
  paintCell(data, SHAPE.crescent, (x, y, r, t) => shCrescent(x, y, r, t));
  paintCell(data, SHAPE.star, (x, y, r) => shStar(x, y, r));
  paintCell(data, SHAPE.ring, (x, y, r, t) => shRing(x, y, r, t));
  paintCell(data, SHAPE.glow, (x, y, r) => shGlow(x, y, r));
  paintCell(data, SHAPE.ember, (x, y) => shEmber(x, y));
  paintCell(data, SHAPE.spark, (x, y) => shSpark(x, y));
  paintCell(data, SHAPE.puff, (x, y, r, t) => shPuff(x, y, r, t));
  paintCell(data, SHAPE.rune, (x, y) => shStrokes(x, y, RUNE_SEGS, 0.014, 0.012));
  paintCell(data, SHAPE.crack, (x, y) => shStrokes(x, y, CRACK_SEGS, 0.012, 0.010));
  paintCell(data, SHAPE.splatter, (x, y) => shSplatter(x, y));
  paintCell(data, SHAPE.shard, (x, y) => shShard(x, y));
  paintCell(data, SHAPE.wisp, (x, y) => shWisp(x, y));
  paintCell(data, SHAPE.chevron, (x, y) => shChevron(x, y));
  paintCell(data, SHAPE.burst, (x, y, r, t) => shBurst(x, y, r, t));
  paintCell(data, SHAPE.diamond, (x, y, r, t) => shDiamond(x, y, r, t));
  paintCell(data, SHAPE.speckle, (x, y) => shSpeckle(x, y));

  const tex = new THREE.DataTexture(new Uint8Array(data.buffer), ATLAS, ATLAS, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;         // these are MASKS, not colour
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  tex.name = 'vfx.shapeAtlas';
  _atlas = tex;
  return tex;
}

/** GLSL snippet: map a unit quad uv + cell index to atlas uv. */
export const ATLAS_UV_GLSL = /* glsl */`
vec2 atlasUV(vec2 q, float cell, vec2 grid){
  float col = mod(cell, grid.x);
  float row = floor(cell / grid.x);
  // inset by half a texel-block so mip bleeding cannot pull in a neighbour
  vec2 uv = clamp(q, 0.002, 0.998);
  return (uv + vec2(col, row)) / grid;
}`;

export default { SHAPE, SHAPE_NAMES, shapeAtlas, CELL, GRID, ATLAS, ATLAS_UV_GLSL };
