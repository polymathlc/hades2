// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// recipes.js — the material RECIPE book and the bake that turns one into the
// four byte buffers a THREE material needs (albedo / normal / ORM / emissive).
//
// This module deliberately imports NOTHING but texgen-core.js and palette.js —
// no three.js. That is what lets texworker.js run the whole bake off the main
// thread across every core the machine has: a worker that had to parse three.js
// first would hand most of the parallel win straight back, and the boot screen
// is exactly the moment we cannot afford to.
//
// library.js owns everything downstream of here: caching, the THREE materials,
// the painterly patch, biome retuning.
// ---------------------------------------------------------------------------

import * as TG from './texgen-core.js';
import {
  RAMPS, INK, GOLD, TARTARUS, ASPHODEL, ELYSIUM, BIOMES,
  hexToRgb, rampAt,
} from './palette.js';

// THREE.DoubleSide === 2. Spelled as a literal so this module stays free of
// three.js; library.js feeds it straight into the material params.
const DoubleSide = 2;

const C255 = (hex) => { const c = hexToRgb(hex); return [c[0] * 255, c[1] * 255, c[2] * 255]; };
const clamp01 = TG.clamp01;
const F = (n) => new Float32Array(n * n);

// Nominal texture sizes. HERO = the surfaces a critic will stand next to and
// which therefore justify the largest synthesis budget; MID = large but usually
// seen at 3/4 distance; BASE = props. `ctx.quality.texScale` scales all of them.
export const HERO = 768;
export const MID = 512;
export const BASE = 448;
const scaleField = (f, k) => { for (let i = 0; i < f.length; i++) f[i] *= k; return f; };
const biasField = (f, k) => { for (let i = 0; i < f.length; i++) f[i] += k; return f; };
const clampField = (f, lo = 0, hi = 1) => { for (let i = 0; i < f.length; i++) f[i] = f[i] < lo ? lo : f[i] > hi ? hi : f[i]; return f; };
const invField = (f) => { const o = new Float32Array(f.length); for (let i = 0; i < f.length; i++) o[i] = 1 - f[i]; return o; };
// pow() on a clamped 0..1 field is a 257-entry table, not 1M library calls.
const _powLUT = new Map();
const powLUTFor = (p) => {
  const k = Math.round(p * 1000);
  let t = _powLUT.get(k);
  if (t) return t;
  t = new Float32Array(258);
  for (let i = 0; i <= 257; i++) t[i] = Math.pow(Math.min(1, i / 256), p);
  _powLUT.set(k, t);
  return t;
};
const powField = (f, p) => {
  const o = new Float32Array(f.length), t = powLUTFor(p);
  for (let i = 0; i < f.length; i++) { const v = f[i]; o[i] = v <= 0 ? 0 : v >= 1 ? t[256] : t[(v * 256) | 0]; }
  return o;
};
/**
 * TOKSVIG normal-variance -> roughness.
 *
 * A busy normal map minified into a couple of screen pixels averages toward a
 * shorter normal, and a short average normal with an unchanged (narrow)
 * specular lobe is exactly what produces crawling white specular strings on a
 * floor at a grazing angle. Baking the variance back into roughness widens the
 * lobe where the geometry is noisy, which is the physically-motivated version
 * of "stop the medallion shimmering".
 */
function toksvig(rough, height, n, scale = 1) {
  const N = n * n;
  const nx = new Float32Array(N), ny = new Float32Array(N), nz = new Float32Array(N);
  // wrapped neighbour tables: a modulo in the inner loop of a 1024^2 pass is
  // several milliseconds of pure address arithmetic
  const xm = new Int32Array(n), xp = new Int32Array(n);
  for (let x = 0; x < n; x++) { xm[x] = x === 0 ? n - 1 : x - 1; xp[x] = x === n - 1 ? 0 : x + 1; }
  const g = n * 0.5 * scale;
  for (let y = 0; y < n; y++) {
    const row = y * n, up = (y === 0 ? n - 1 : y - 1) * n, dn = (y === n - 1 ? 0 : y + 1) * n;
    for (let x = 0; x < n; x++) {
      const dx = (height[row + xp[x]] - height[row + xm[x]]) * g;
      const dy = (height[dn + x] - height[up + x]) * g;
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = row + x;
      nx[i] = -dx * l; ny[i] = -dy * l; nz[i] = l;
    }
  }
  // 3x3 average of the normal, done SEPARABLY (two 3-taps instead of nine)
  const tx = new Float32Array(N), ty = new Float32Array(N), tz = new Float32Array(N);
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const a = row + xm[x], b = row + x, c = row + xp[x];
      tx[b] = nx[a] + nx[b] + nx[c]; ty[b] = ny[a] + ny[b] + ny[c]; tz[b] = nz[a] + nz[b] + nz[c];
    }
  }
  const out = new Float32Array(rough.length);
  const inv9 = 1 / 9;
  for (let y = 0; y < n; y++) {
    const row = y * n, up = (y === 0 ? n - 1 : y - 1) * n, dn = (y === n - 1 ? 0 : y + 1) * n;
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const ax = (tx[up + x] + tx[i] + tx[dn + x]) * inv9;
      const ay = (ty[up + x] + ty[i] + ty[dn + x]) * inv9;
      const az = (tz[up + x] + tz[i] + tz[dn + x]) * inv9;
      let len = Math.sqrt(ax * ax + ay * ay + az * az);
      if (len > 1) len = 1;
      const r = rough[i];
      const gl = Math.max(1e-3, 2 / Math.max(1e-4, r * r) - 2);   // roughness -> gloss
      const gp = (len * gl) / (len + gl * (1 - len) + 1e-5);
      const v = Math.sqrt(2 / (gp + 2));
      out[i] = clamp01(v > r ? v : r);
    }
  }
  return out;
}

/** Ornament emissive mask: the raised, edge-caught gold only — never the field. */
const mapGold = (relief, edge, cav) => {
  const o = new Float32Array(relief.length);
  for (let i = 0; i < o.length; i++) o[i] = clamp01(relief[i] * 0.72 + edge[i] * 0.55 - cav[i] * 0.85);
  return o;
};
const combine = (n, parts) => {
  const out = F(n);
  for (const [f, k] of parts) for (let i = 0; i < out.length; i++) out[i] += f[i] * k;
  return out;
};

const _ss = (a, b, x) => { const t = clamp01((x - a) / (b - a + 1e-9)); return t * t * (3 - 2 * t); };

/**
 * IRREGULAR FLAGSTONE BOND — the floor's whole reason for existing.
 *
 * WHY THIS EXISTS INSTEAD OF TG.tileGrid.
 * tileGrid lays a perfectly regular lattice: every course the same height,
 * every stone the same width, every joint dead straight and dead parallel. On
 * a floor that is the single loudest periodic signal a frame can carry, and the
 * project's answer to it had been to make the plate so large that a stone came
 * out 2.6m x 3.6m — i.e. to beat §7's tiling ban by making the stones too big
 * to read as stones. That trades away the most recognisable Supergiant
 * signature there is. §10 exactly: do not satisfy a rule by removing the thing
 * the rule exists to protect.
 *
 * A mason does not defeat repetition with scale, and neither does a painter.
 * They defeat it with IRREGULARITY, and that is what this generates:
 *   - courses of unequal height, each with its own stone count and its own
 *     phase, so no vertical joint is ever continuous across two courses;
 *   - stones of unequal width inside a course (0.72x .. 1.42x of nominal);
 *   - a small per-stone ROTATION (up to ~2.6 deg), so no joint is collinear
 *     with its neighbour and the bed reads as laid by hand rather than milled;
 *   - a per-stone INSET, so the joint width itself varies;
 *   - a per-stone RISE, so stones sit proud and sunk and the bed has relief;
 *   - BROKEN STONES: a sixth of the bed is split in two along its long axis,
 *     and a minority of the pieces are pale REPLACEMENTS, laid later;
 *   - a signed ARRIS field: the chamfer that faces the light is a hand-placed
 *     highlight, the chamfer that faces away is a dark channel with the ink
 *     ramp's colour in it. That is a carved edge; a single dark line is not.
 *
 * Everything wraps: courses tile in Y, the per-course phase is applied to the
 * sampling coordinate rather than to the edge table, and every stone rectangle
 * is inset far enough that its rotated corners stay inside its own cell.
 *
 * Returns { height, id, seam, lobe, arris, rise } — a superset of tileGrid's
 * contract, so the recipe below reads the same fields it always did.
 */
function flagBond(n, o = {}) {
  const rng = o.rng || TG.makeRng(9091);
  const courses = Math.max(2, Math.round(o.courses ?? 10));
  const perCourse = Math.max(2, Math.round(o.perCourse ?? 9));
  const jointPx = (o.joint ?? 0.0035) * n;        // half the mortar gap, in texels
  const bevelPx = (o.bevel ?? 0.0075) * n;        // the chamfer band, in texels
  const rotMax = o.rot ?? 0.046;                  // radians, ~2.6 deg
  const brokenFrac = o.broken ?? 0.17;
  const replaceFrac = o.replace ?? 0.11;
  // light direction for the hand-placed arris highlight, in texture space
  const LDX = o.lightX ?? 0.52, LDY = o.lightY ?? -0.85;
  const LDL = Math.hypot(LDX, LDY), LX = LDX / LDL, LY = LDY / LDL;

  // ---- course table (wraps in Y) ----------------------------------------
  const cw = [];
  for (let r = 0; r < courses; r++) cw.push(0.80 + rng() * 0.44);
  const ctot = cw.reduce((a, b) => a + b, 0);
  const cEdge = new Float32Array(courses + 1);
  for (let r = 0; r < courses; r++) cEdge[r + 1] = cEdge[r] + cw[r] / ctot;
  cEdge[courses] = 1;

  // ---- per-course stone table (wraps in X via the phase) ----------------
  const rows = [];
  for (let r = 0; r < courses; r++) {
    const c = Math.max(2, perCourse + (rng() < 0.5 ? 0 : (rng() < 0.5 ? -1 : 1)));
    const w = [];
    for (let i = 0; i < c; i++) w.push(0.75 + rng() * 0.55);
    const tot = w.reduce((a, b) => a + b, 0);
    const e = new Float32Array(c + 1);
    for (let i = 0; i < c; i++) e[i + 1] = e[i] + w[i] / tot;
    e[c] = 1;
    const tone = new Float32Array(c), rot = new Float32Array(c);
    const inX = new Float32Array(c), inY = new Float32Array(c);
    const rise = new Float32Array(c), brk = new Float32Array(c), brkAt = new Float32Array(c);
    for (let i = 0; i < c; i++) {
      // Per-stone VALUE. Hades' flagstones swing a full value step from one
      // stone to the next; a gentle per-tile tint was the old defence against
      // making the BOND legible, and with an irregular bond there is no bond
      // pitch left to make legible, so the swing can finally be honest.
      tone[i] = rng() < replaceFrac ? 0.80 + rng() * 0.20 : rng() * 0.86;
      rot[i] = (rng() * 2 - 1) * rotMax;
      inX[i] = rng() * jointPx * 0.9;
      inY[i] = rng() * jointPx * 0.9;
      rise[i] = (rng() * 2 - 1);
      brk[i] = rng() < brokenFrac ? 1 : 0;
      brkAt[i] = 0.36 + rng() * 0.28;
    }
    rows.push({ c, e, phase: rng(), tone, rot, inX, inY, rise, brk, brkAt });
  }

  // ---- chiselled joint wobble (already tileable) ------------------------
  const wr = Math.max(64, n >> 2);
  const wob = TG.resample(TG.fbm(wr, { freq: 7, octaves: 4, seed: 5150, type: 'grad' }), wr, n);
  const wobA = (o.wobble ?? 0.006) * n;

  const height = new Float32Array(n * n);
  const id = new Float32Array(n * n);
  const seam = new Float32Array(n * n);
  const lobe = new Float32Array(n * n);
  const arris = new Float32Array(n * n);
  const rise = new Float32Array(n * n);
  // the MORTAR GAP alone, with the chamfer excluded. seam covers gap+chamfer,
  // which is what the height field wants; the ink wants only the gap, or the
  // tint lands on the lit arris and the carved edge collapses back into a line.
  const joint = new Float32Array(n * n);

  for (let y = 0; y < n; y++) {
    const yw = ((y + 53) % n) * n;
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const wx = x + (wob[i] - 0.5) * 2 * wobA;
      const wy = y + (wob[yw + ((x + 17) % n)] - 0.5) * 2 * wobA;
      let v = wy / n; v -= Math.floor(v);
      let r = 0; while (r < courses - 1 && v >= cEdge[r + 1]) r++;
      const R = rows[r];
      const y0 = cEdge[r], y1 = cEdge[r + 1];
      const chPx = (y1 - y0) * n;
      let fy = (v - y0) / (y1 - y0);

      let u = wx / n + R.phase; u -= Math.floor(u);
      let c = 0; while (c < R.c - 1 && u >= R.e[c + 1]) c++;
      const u0 = R.e[c], u1 = R.e[c + 1];
      let fx = (u - u0) / (u1 - u0);
      let pieceW = (u1 - u0) * n, pieceH = chPx;
      let toneV = R.tone[c], riseV = R.rise[c], rotV = R.rot[c];
      let inX = R.inX[c], inY = R.inY[c];
      let axis = R.tone[c] * 6.2831853;

      // BROKEN STONE: split along its long axis; the two pieces then drift
      // apart in tone, tilt and rise, because a cracked flag is never re-laid
      // flush. A sixth of the bed is broken and a ninth of what is left is a
      // pale REPLACEMENT stone laid later — the two cues that stop a paved
      // floor reading as wallpaper.
      if (R.brk[c] > 0) {
        const at = R.brkAt[c];
        let sub = 0;
        if (pieceW >= pieceH) {
          if (fx < at) { pieceW *= at; fx /= at; }
          else { pieceW *= (1 - at); fx = (fx - at) / (1 - at); sub = 1; }
        } else if (fy < at) { pieceH *= at; fy /= at; }
        else { pieceH *= (1 - at); fy = (fy - at) / (1 - at); sub = 1; }
        const kh = (((c * 2654435761 + r * 40503 + sub * 668265263) >>> 0) / 4294967296);
        toneV = clamp01(toneV + (kh - 0.5) * 0.44);
        rotV += (kh - 0.5) * rotMax * 1.7;
        riseV = riseV * 0.6 + (kh - 0.5) * 1.3;
        inX += kh * jointPx * 0.55;
        axis += kh * 3.1;
      }

      const halfW = pieceW * 0.5, halfH = pieceH * 0.5;
      const px = (fx - 0.5) * pieceW;
      const py = (fy - 0.5) * pieceH;
      const ca = Math.cos(rotV), sa = Math.sin(rotV);
      const rx = px * ca + py * sa;
      const ry = -px * sa + py * ca;
      // inset far enough that the rotated corners never leave the cell, so the
      // whole bed still wraps
      const pad = jointPx + Math.abs(sa) * (halfW + halfH) * 0.5;
      const shw = Math.max(1, halfW - pad - inX);
      const shh = Math.max(1, halfH - pad - inY);
      const dX = shw - Math.abs(rx), dY = shh - Math.abs(ry);
      const d = dX < dY ? dX : dY;

      const m = d <= 0 ? 1 : 1 - _ss(0, bevelPx, d);
      seam[i] = m;
      joint[i] = d <= 0 ? 1 : 1 - _ss(0, bevelPx * 0.30, d);
      height[i] = (1 - m) * (1 + riseV * 0.13);
      id[i] = toneV;
      rise[i] = riseV;
      // the stone's OWN light/shade axis — a loaded stroke laid across it, with
      // a different direction on the stone next to it (§1.4 painted texture)
      lobe[i] = (fx - 0.5) * Math.cos(axis) + (fy - 0.5) * Math.sin(axis);
      // signed chamfer: + where the bevel faces the light (a hand-placed
      // highlight on the arris), - where it faces away (a channel that gets the
      // ink ramp's COLOUR, never absence)
      if (d > 0) {
        let nx, ny;
        if (dX < dY) { nx = rx < 0 ? -1 : 1; ny = 0; } else { nx = 0; ny = ry < 0 ? -1 : 1; }
        const tx = nx * ca - ny * sa, ty = nx * sa + ny * ca;
        arris[i] = m * (tx * LX + ty * LY);
      }
    }
  }
  return { height, id, seam, joint, lobe, arris, rise };
}

/**
 * The standard painterly value pass. This is where a noise field stops looking
 * like noise: crevice darkening, edge wear, two crossing glaze layers painted
 * with the brush engine, a HUE glaze into the warm/cool selector, crisp fine
 * hatching scaled by local value, and a few hand-placed highlight licks on the
 * convex crowns.
 */
function paintValue(v, n, o = {}) {
  const rng = o.rng || TG.makeRng(5);
  if (o.cavity) for (let i = 0; i < v.length; i++) v[i] -= o.cavity[i] * (o.cavityAmt ?? 0.3);
  if (o.edge) for (let i = 0; i < v.length; i++) v[i] += o.edge[i] * (o.edgeAmt ?? 0.22);

  // --- broad loaded-brush glazes -----------------------------------------
  // Low frequency by nature, so painted at half resolution and upsampled:
  // same look, a quarter of the cost.
  const lo = Math.max(128, n >> 1);
  const swirl = o.swirl ?? 2.1;
  const flowLo = TG.flowField(lo, { base: o.flowBase ?? 0.35, swirl, freq: o.flowFreq ?? 1.6, seed: o.seed ?? 3 });
  const broad = new Float32Array(lo * lo);
  TG.strokes(broad, lo, {
    rng, flow: flowLo,
    count: o.count ?? Math.round(lo * 1.9),
    len: [lo * 0.09, lo * 0.34],
    width: [lo * 0.009, lo * 0.030],
    value: o.light || [0.03, 0.115],
    curl: 0.38, bristle: 0.42, taper: 1.6, softness: 1.6,
  });
  TG.strokes(broad, lo, {
    rng, flow: TG.flowField(lo, { base: (o.flowBase ?? 0.35) + 1.9, swirl: swirl * 0.8, freq: 3, seed: (o.seed ?? 3) + 91 }),
    count: o.count2 ?? Math.round(lo * 1.3),
    len: [lo * 0.06, lo * 0.26],
    width: [lo * 0.007, lo * 0.022],
    value: o.dark || [-0.115, -0.03],
    curl: 0.46, bristle: 0.5, taper: 1.8, softness: 1.45,
  });
  const up = TG.resample(broad, lo, n);
  for (let i = 0; i < v.length; i++) v[i] += up[i];

  // --- a HUE glaze: the same brush, painted into the warm/cool selector ---
  if (o.temp) {
    const th = new Float32Array(lo * lo);
    TG.strokes(th, lo, {
      rng, flow: TG.flowField(lo, { base: (o.flowBase ?? 0.35) - 0.8, swirl: swirl * 1.1, freq: 2, seed: (o.seed ?? 3) + 313 }),
      count: Math.round(lo * 1.0), len: [lo * 0.09, lo * 0.34], width: [lo * 0.010, lo * 0.030],
      value: [0.10, 0.34], curl: 0.35, bristle: 0.35, taper: 1.5, softness: 1.6,
    });
    TG.strokes(th, lo, {
      rng, flow: TG.flowField(lo, { base: (o.flowBase ?? 0.35) + 1.1, swirl: swirl * 1.1, freq: 3, seed: (o.seed ?? 3) + 511 }),
      count: Math.round(lo * 0.7), len: [lo * 0.07, lo * 0.26], width: [lo * 0.008, lo * 0.024],
      value: [-0.34, -0.10], curl: 0.35, bristle: 0.35, taper: 1.5, softness: 1.6,
    });
    const tu = TG.resample(th, lo, n);
    for (let i = 0; i < o.temp.length; i++) o.temp[i] = clamp01(o.temp[i] + tu[i]);
  }

  // --- crisp fine hatching at full resolution ----------------------------
  const flowHi = TG.flowField(n, { base: (o.flowBase ?? 0.35) + 0.7, swirl: swirl * 1.25, freq: (o.flowFreq ?? 1.6) * 3, seed: (o.seed ?? 3) + 17 });
  const fine = new Float32Array(n * n);
  TG.strokes(fine, n, {
    rng, flow: flowHi,
    count: o.fineCount ?? Math.round(n * 0.9),
    len: [n * 0.014, n * 0.06],
    width: [0.9, 2.3],
    value: o.fine || [-0.07, 0.07],
    curl: 0.55, bristle: 0.8, taper: 2.1, softness: 1.05,
  });
  // Scale the hatching by local value: on a near-black material a fixed offset
  // is a chalk scratch, because the ramp is steep down there.
  for (let i = 0; i < v.length; i++) v[i] += fine[i] * (0.28 + 1.05 * clamp01(v[i]));

  // --- hand-placed highlights: a few confident bright licks on the crowns -
  if (o.edge && (o.highlight ?? 1) > 0) {
    TG.strokes(v, n, {
      rng, flow: flowHi, mask: o.edge,
      count: Math.round(n * 0.30), len: [n * 0.008, n * 0.035], width: [0.9, 2.4],
      value: [0.10, 0.26 * (o.highlight ?? 1)],
      curl: 0.6, bristle: 0.4, taper: 2.4, softness: 1.1,
    });
  }
  return clampField(v);
}

/**
 * A warped fBm painted at HALF resolution and upsampled.
 *
 * Every one of these fields is freq 2-9 across the whole texture — one cell is
 * 60-250 px even at half resolution — so the octave that half resolution costs
 * carries about 3% amplitude and no legible shape. Domain warping is the most
 * expensive operator in the engine (two full-resolution bilinear resamples per
 * level), and paying for it at 2048^2 of work to describe a field whose finest
 * real feature is 100 px wide was most of the boot cost. The brushwork, grit,
 * cracks, joints and ornament that the eye actually reads at close range all
 * stay at full resolution.
 */
function warpLo(n, fbmOpts, warpOpts, div = 2) {
  const r = Math.max(192, Math.min(n, n / div | 0));
  if (r >= n) return TG.warp2(TG.fbm(n, fbmOpts), n, warpOpts);
  return TG.resample(TG.warp2(TG.fbm(r, fbmOpts), r, warpOpts), r, n);
}
function warp1Lo(n, fbmOpts, warpOpts, div = 2) {
  const r = Math.max(192, Math.min(n, n / div | 0));
  if (r >= n) return TG.warp(TG.fbm(n, fbmOpts), n, warpOpts);
  return TG.resample(TG.warp(TG.fbm(r, fbmOpts), r, warpOpts), r, n);
}

// ---------------------------------------------------------------------------
// RECIPES
// ---------------------------------------------------------------------------
// Each returns { rgb, height, rough, metal, ao?, emissive?, params?, paint? }
//   rgb      Float32Array n*n*3, 0..255 sRGB
//   height   Float32Array n*n, 0..1
//   rough    Float32Array n*n, 0..1
//   metal    number | Float32Array
//   emissive Float32Array n*n*3, 0..255 sRGB  (optional)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CHARACTER MODULATION RAMPS.
// Deliberately high-key and near-neutral: rig.js paints the roster's identity
// hue into VERTEX COLOUR and the albedo multiplies it, so a saturated ramp
// here would double the hue and a dark one would sink the hero below the
// floor — which §9.2 makes the one unforgivable error in this project.
// Mean value sits around 0.85 so the texture reads as material, not as a
// second shadow pass.
// ---------------------------------------------------------------------------
const R_ = (t, c) => ({ t, c });
const SKIN_WARM = [R_(0, '#a89086'), R_(0.30, '#d0b6a8'), R_(0.58, '#ecd6c8'), R_(0.80, '#f8ebe0'), R_(1, '#fffcf7')];
const SKIN_COOL = [R_(0, '#9a8a8c'), R_(0.32, '#c0b0b2'), R_(0.62, '#ded2d3'), R_(0.85, '#f2ebeb'), R_(1, '#fdfafa')];
const CLOTH_N   = [R_(0, '#6c626a'), R_(0.26, '#948890'), R_(0.55, '#b8acb2'), R_(0.80, '#dcd2d6'), R_(1, '#f8f4f5')];
const CLOTH_C   = [R_(0, '#5d5e6c'), R_(0.28, '#84869a'), R_(0.58, '#adaebf'), R_(0.82, '#d6d8e3'), R_(1, '#f4f6fb')];
const HAIR_R    = [R_(0, '#4d4249'), R_(0.30, '#786a71'), R_(0.62, '#a2939a'), R_(0.86, '#ccbec3'), R_(1, '#f2e9eb')];
const METAL_R   = [R_(0, '#41382f'), R_(0.24, '#75664f'), R_(0.52, '#a8957a'), R_(0.78, '#dbcdb2'), R_(1, '#fffaee')];

const RECIPES = {

  // ======================================================================
  // CHARACTER SURFACES  (§4, §1.4)
  // ----------------------------------------------------------------------
  // rig.js used to null out map/normalMap/roughnessMap/metalnessMap/aoMap on
  // every character material "rather than ship a texture we did not
  // art-direct". The result was exactly what the critic panel measured: at 3x
  // the hero is flat skin, flat charcoal cloth and a white contour, with no
  // weave, no grain, no wear, no painted crevice AO and no hand-placed
  // highlight anywhere on the figure.
  //
  // These four sets are that missing art direction. The critical design point
  // is that they are MODULATORS, not skins: the roster's colour identity lives
  // in VERTEX COLOUR (rig.js paints it per slot, per family), so the albedo
  // here is authored around neutral and its job is to swing VALUE — the way a
  // painted cloth fold does — while leaving hue to the rig. That is why one
  // cloth set can dress the hero, the shade, the brute and the hound without
  // any of them reading as the same character.
  //
  // They tile: rig.js's limb tubes carry a cylindrical 0..1 unwrap and ask for
  // a repeat, so every generator used here is periodic.
  // ======================================================================
  'characterrig.skin': { size: MID, build(n, rng, seed) {
    // These ramps are declared inline rather than by name: TG.lut() silently
    // falls back to the ASH ramp for an unknown key, so a typo'd ramp name
    // would dress the hero in dark violet and never raise an error.
    // dermis: a slow subsurface mottle, a fine pore break-up, and the
    // capillary warmth that keeps flesh from reading as painted plastic
    let deep = TG.fbm(n, { freq: 3, octaves: 5, seed, type: 'value' });
    deep = TG.warp2(deep, n, { amp: 0.12, freq: 2, seed: seed + 1 });
    const pore = TG.worleyField(n, { freq: 46, mode: 'f1', seed: seed + 2, jitter: 1, res: n >> 1 });
    const fine = TG.fbm(n, { freq: 30, octaves: 3, seed: seed + 3, ppc: 3 });
    const h = combine(n, [[deep, 0.62], [invField(pore), 0.20], [fine, 0.18]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] * 0.34 + 0.42);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.010), 4.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.005), 5.0);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.72 + (deep[i] - 0.5) * 0.30 + fine[i] * 0.10 - cav[i] * 0.26);
    // temperature: warm across the mass, cool where the form turns away
    const temp = TG.lowFreq(n, (r) => TG.warp(TG.fbm(r, { freq: 2.2, octaves: 4, seed: seed + 11 }), r, { amp: 0.10, freq: 2, seed: seed + 12 }), n >> 2);
    const rgb = TG.applyRamp2(v, temp, n, SKIN_WARM, SKIN_COOL);
    const rough = TG.artisticRoughness(n, {
      base: 0.62, height: h, cavity: cav, edge, polish: 0.34, dry: 0.08, variation: 0.14,
      seed: seed + 21, min: 0.30, max: 0.86,
    });
    return { rgb, height: h, rough, metal: 0, normalScale: 0.34,
      paint: { variant: 'character' } };
  } },

  'characterrig.cloth': { size: MID, build(n, rng, seed) {
    // A REAL WEAVE, then brushwork over it. The weave alone is a fabric
    // swatch; what makes a fold swing value the way a painted one does is the
    // loaded-brush pass laid along a flow field, which is what paintValue's
    // stroke layer does — so it is turned up hard here.
    const wv = TG.weave(n, { threads: 52, seed: seed + 1 });
    const slub = TG.fbm(n, { freq: 7, octaves: 4, seed: seed + 2, type: 'value' });
    const nap = TG.fbm(n, { freq: 44, octaves: 2, seed: seed + 3, ppc: 3 });
    const h = combine(n, [[wv, 0.52], [slub, 0.30], [nap, 0.18]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] * 0.62 + 0.20);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.009), 6.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7.0);
    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.66 + (slub[i] - 0.5) * 0.42 + (wv[i] - 0.5) * 0.30 - cav[i] * 0.40 + edge[i] * 0.24;
    }
    const temp = TG.lowFreq(n, (r) => TG.fbm(r, { freq: 2.6, octaves: 4, seed: seed + 8 }), n >> 2);
    // HAND-PLACED HIGHLIGHT. highlight 1.2 is deliberately past the value used
    // on architecture: a garment is the one surface on a character allowed a
    // scrubbed, obviously-brushed top light.
    paintValue(v, n, { rng, seed: seed + 9, temp, cavity: cav, cavityAmt: 0.30, edge, edgeAmt: 0.26, flowBase: 0.42, swirl: 2.6, flowFreq: 2.1, highlight: 1.20 });
    const rgb = TG.applyRamp2(v, temp, n, CLOTH_N, CLOTH_C);
    const rough = TG.artisticRoughness(n, {
      base: 0.90, height: h, cavity: cav, edge, polish: 0.10, dry: 0.26, variation: 0.20,
      seed: seed + 31, min: 0.52, max: 1.0,
      strokes: { count: Math.round(n * 0.55), flow: TG.flowField(n, { base: 0.40, swirl: 1.5, freq: 3, seed: seed + 32 }), value: [0.08, 0.30], len: [n * 0.05, n * 0.16], width: [1.4, 3.2], rng },
      strokeAmount: 0.30,
    });
    return { rgb, height: h, rough, metal: 0, normalScale: 0.85,
      paint: { variant: 'character' } };
  } },

  'characterrig.hair': { size: BASE, build(n, rng, seed) {
    // strands: a strongly anisotropic ridged noise combed along v, so a lock
    // reads as a lock and not as a lump
    const strand = TG.fbm(n, { freq: 3, octaves: 5, seed, type: 'grad' });
    const comb = F(n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const s = Math.sin((x / n) * Math.PI * 2 * 34 + strand[i] * 9.0);
        comb[i] = clamp01(0.5 + 0.5 * s);
      }
    }
    const h = combine(n, [[comb, 0.62], [strand, 0.38]]);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 6.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7.0);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.58 + (comb[i] - 0.5) * 0.62 - cav[i] * 0.34 + edge[i] * 0.30);
    const rgb = TG.applyRamp(v, n, HAIR_R);
    const rough = TG.artisticRoughness(n, { base: 0.50, height: h, cavity: cav, edge, polish: 0.42, variation: 0.16, seed: seed + 5, min: 0.22, max: 0.80 });
    return { rgb, height: h, rough, metal: 0, normalScale: 0.70, paint: { variant: 'character' } };
  } },

  // NOT wired to the rig's `metal` slot, deliberately. Routing metal through a
  // recipe took it out of MaterialLibrary.character(), which is the only path
  // that gives it envMapIntensity 0.6 — and a metalness-0.94 surface with a
  // whisper of IBL goes dead. Measured at 3x: the hero lost every gold glint
  // on the pauldron ridges and the crown, i.e. the character's entire
  // highlight band (§9.3/§9.5). Metal stays on the painterly character
  // material until someone can give it a proper prefiltered environment.
  'armour.bronze': { size: MID, build(n, rng, seed) {
    // hammered bronze: a planished dimple field, a brushed direction, edge
    // wear that goes bright and pitting that goes dark. Metal without wear is
    // the single loudest "this is a shader, not an object" tell.
    const dimple = TG.worleyField(n, { freq: 15, mode: 'f1', seed: seed + 1, jitter: 0.85, res: n >> 1 });
    const brush = TG.fbm(n, { freq: 60, octaves: 2, seed: seed + 2, ppc: 3 });
    const broad = TG.warp2(TG.fbm(n, { freq: 3, octaves: 5, seed: seed + 3 }), n, { amp: 0.09, freq: 2, seed: seed + 4 });
    const pit = TG.worleyField(n, { freq: 40, mode: 'f1', seed: seed + 5, jitter: 1, res: n >> 1 });
    const pits = F(n);
    for (let i = 0; i < pits.length; i++) pits[i] = clamp01((0.13 - pit[i]) * 8.0) * clamp01((broad[i] - 0.52) * 3.2);
    const h = combine(n, [[invField(dimple), 0.46], [broad, 0.34], [brush, 0.20]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] * 0.70 + 0.16 - pits[i] * 0.30);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.009), 6.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 8.0);
    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = clamp01(0.48 + (broad[i] - 0.5) * 0.34 + edge[i] * 0.46 - cav[i] * 0.42 - pits[i] * 0.30 + brush[i] * 0.10);
    }
    const rgb = TG.applyRamp(v, n, METAL_R);
    // verdigris creeping out of the crevices — bronze that has been underground
    const grime = TG.dirtMask(h, n, { seed: seed + 11, cavity: cav, streak: 0.04, streakStrength: 0.6 });
    TG.tintRGB(rgb, n, powField(grime, 1.7), C255(GOLD.verdigris), 0.34);
    TG.tintRGB(rgb, n, powField(pits, 1.2), C255('#20120a'), 0.55);
    const rough = TG.artisticRoughness(n, {
      base: 0.38, height: h, cavity: cav, edge, polish: 0.62, dry: 0.10, variation: 0.22,
      seed: seed + 21, min: 0.13, max: 0.78,
    });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) metal[i] = clamp01(0.94 - pits[i] * 0.5 - grime[i] * 0.30);
    return { rgb, height: h, rough, metal, normalScale: 0.55,
      paint: { variant: 'character' } };
  } },

  // ======================================================================
  // SHIELD FACE — the brute's tower shield (§7 "untextured programmer art")
  // ----------------------------------------------------------------------
  // This surface is authored in SHIELD-FACE SPACE, not as a tiling material:
  // u,v run 0..1 across the plate, so the ornament is PLACED — a fillet frame
  // on the rim, a meander band under the top rail, a bead ring around the
  // umbo, rivets on the quarters — instead of wallpapered. That is §1.5's
  // ornament hierarchy applied to a prop the eye lands on.
  //
  // Everything that reads as ornament is cut into the HEIGHT first and only
  // then filled with gold, so the arris catches the key and the undercut goes
  // dark. Ornament painted as light-on-dark line art is the failure this
  // replaces.
  // ======================================================================
  'shield.brute': { size: MID, build(n, rng, seed) {
    // ---- boiled-leather field over a timber core ------------------------
    let base = TG.fbm(n, { freq: 4, octaves: 6, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.10, freq: 3, seed: seed + 3 });
    // hide grain: stretched worley cells, elongated along the hide's stretch
    const grainA = TG.worleyField(n, { freq: 13, mode: 'f2f1', seed: seed + 5, jitter: 0.92, res: n >> 1 });
    const grainB = TG.fbm(n, { freq: 34, octaves: 3, seed: seed + 6, ppc: 3 });
    // planked backing showing through where the leather is worn thin
    const planks = TG.woodGrain(n, { rings: 9, stretch: 9, seed: seed + 7 });
    const wear = TG.lowFreq(n, (r) => TG.warp(TG.fbm(r, { freq: 3.4, octaves: 5, seed: seed + 8 }), r, { amp: 0.09, freq: 2, seed: seed + 9 }), n >> 2);

    // ---- ORNAMENT, placed in face space --------------------------------
    const orn = F(n);          // gold ornament mask (raised)
    const cut = F(n);          // engraved channels (sunken)
    const M = n * 0.055;       // rim inset
    // (1) a two-rail gold fillet following the whole rim
    const lw = Math.max(3, n * 0.017);
    TG.drawLine(orn, n, M, M, n - M, M, lw, 1.0, 1.4);
    TG.drawLine(orn, n, M, n - M, n - M, n - M, lw, 1.0, 1.4);
    TG.drawLine(orn, n, M, M, M, n - M, lw, 1.0, 1.4);
    TG.drawLine(orn, n, n - M, M, n - M, n - M, lw, 1.0, 1.4);
    // (2) a meander band inset under the top rail and above the foot
    const band = F(n);
    TG.meanderBand(band, n, { y: n * 0.145, height: n * 0.115, cells: 4, lineW: Math.max(3, n * 0.016), value: 1, soft: n * 0.0022 });
    TG.meanderBand(band, n, { y: n * 0.855, height: n * 0.115, cells: 4, lineW: Math.max(3, n * 0.016), value: 1, soft: n * 0.0022 });
    for (let i = 0; i < orn.length; i++) { cut[i] = band[i]; orn[i] = clamp01(orn[i] + band[i] * 0.85); }
    // (3) a bead row ringing the umbo — the small proud member that reads as
    //     ornament at 30 screen pixels when a flat disc reads as nothing
    const bead = F(n);
    const BR = n * 0.215, cx = n * 0.5, cy = n * 0.5;
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      TG.drawDisc(bead, n, cx + Math.cos(a) * BR, cy + Math.sin(a) * BR, n * 0.0165, 1, n * 0.010);
    }
    TG.drawArc(orn, n, cx, cy, n * 0.255, 0, Math.PI * 2, Math.max(3, n * 0.013), 0.92, 1.4);
    TG.drawArc(cut, n, cx, cy, n * 0.176, 0, Math.PI * 2, Math.max(3, n * 0.020), 0.85, 1.5);
    for (let i = 0; i < orn.length; i++) orn[i] = clamp01(orn[i] + bead[i]);
    // (4) rivets on the quarters
    const rivet = F(n);
    for (const [rx, ry] of [[0.155, 0.155], [0.845, 0.155], [0.155, 0.845], [0.845, 0.845], [0.5, 0.075], [0.5, 0.925]]) {
      TG.drawDisc(rivet, n, rx * n, ry * n, n * 0.020, 1, n * 0.011);
    }
    for (let i = 0; i < orn.length; i++) orn[i] = clamp01(orn[i] + rivet[i]);

    // ---- height: leather quilt, then ornament in relief -----------------
    const h = combine(n, [[base, 0.40], [grainA, 0.26], [grainB, 0.10], [planks, 0.10]]);
    for (let i = 0; i < h.length; i++) {
      const w = clamp01((wear[i] - 0.58) * 3.0);
      h[i] = clamp01(h[i] * (1 - w * 0.35) + 0.10 + orn[i] * 0.30 - cut[i] * 0.26 - rivet[i] * 0.0);
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    // ---- value + temperature -------------------------------------------
    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.30 + (base[i] - 0.5) * 0.46 + grainA[i] * 0.20 + grainB[i] * 0.08
        - cut[i] * 0.22 + clamp01((wear[i] - 0.62) * 2.8) * 0.22;
    }
    const temp = TG.lowFreq(n, (r) => {
      const t = TG.warp(TG.fbm(r, { freq: 2.4, octaves: 4, seed: seed + 21 }), r, { amp: 0.08, freq: 2, seed: seed + 22 });
      for (let i = 0; i < t.length; i++) t[i] = clamp01((t[i] - 0.40) * 2.0);
      return t;
    }, n >> 2);
    paintValue(v, n, { rng, seed, temp, cavity: cav, cavityAmt: 0.36, edge, edgeAmt: 0.20, flowBase: 0.16, swirl: 2.3, highlight: 0.85 });

    const rgb = TG.applyRamp2(v, temp, n, 'banner.crimson', 'blood');
    // the timber core reads through the worn patches — warm dead wood, not grey
    const worn = F(n);
    for (let i = 0; i < worn.length; i++) worn[i] = clamp01((wear[i] - 0.58) * 3.0);
    TG.tintRGB(rgb, n, powField(worn, 1.6), C255('#3a2016'), 0.38);
    // soot and dried ichor collecting in the quilting and the engraved channels
    const grime = TG.dirtMask(h, n, { seed: seed + 31, cavity: cav, streak: 0.05, streakStrength: 0.75 });
    TG.tintRGB(rgb, n, powField(grime, 1.5), C255('#1b0509'), 0.58);
    TG.tintRGB(rgb, n, powField(cut, 1.2), C255(INK.plum), 0.40);
    // ---- GOLD INLAY on the raised ornament ------------------------------
    const inlayV = F(n);
    for (let i = 0; i < inlayV.length; i++) {
      inlayV[i] = clamp01(0.36 + (base[i] - 0.5) * 0.28 + edge[i] * 0.34 + orn[i] * 0.16 - cav[i] * 0.52);
    }
    TG.compositeRamp(rgb, n, powField(orn, 1.25), inlayV, 'gold', 0.94);

    const rough = TG.artisticRoughness(n, {
      base: 0.72, height: h, cavity: cav, edge, polish: 0.30, dry: 0.14, variation: 0.16,
      seed: seed + 41, min: 0.24, max: 0.96,
      strokes: { count: Math.round(n * 0.40), flow: TG.flowField(n, { base: 0.14, swirl: 0.7, freq: 3, seed: seed + 42 }), value: [0.10, 0.34], len: [n * 0.05, n * 0.14], width: [1.6, 3.6], rng },
      strokeAmount: 0.24,
    });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(orn[i] * 1.2); rough[i] = clamp01(rough[i] * (1 - orn[i] * 0.64)); }

    return { rgb, height: h, rough, metal, normalScale: 0.95,
      paint: { variant: 'character', variation: 0.16, variationTint: '#8c1f2e', specGain: 0.8 } };
  } },

  // ======================================================================
  // TARTARUS — blood-dark carved stone with gold-inlaid meander seams
  // ======================================================================
  'stone.tartarus': { size: HERO, build(n, rng, seed, o = {}) {
    const A = TG.ashlar(n, { rows: 3, cols: 2, rng, mortar: 0.016, bevel: 0.07, wobble: 0.015 });
    let base = TG.fbm(n, { freq: 3, octaves: 6, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.085, freq: 2, seed: seed + 11 });
    const grit = TG.fbm(n, { freq: 26, octaves: 3, seed: seed + 2, ppc: 3 });
    const chisel = TG.ridged(n, { freq: 9, octaves: 4, seed: seed + 3, type: 'grad' });

    // Pitting must be CLUSTERED and varied in size. A plain inverted Worley is
    // a polka-dot grid, which is the loudest procedural tell at close range.
    const pitRaw = TG.worleyField(n, { freq: 24, mode: 'f1', seed: seed + 4, jitter: 1, res: n >> 1 });
    const pitVary = TG.lowFreq(n, (r) => TG.warp(TG.fbm(r, { freq: 6, octaves: 5, seed: seed + 41 }), r, { amp: 0.10, freq: 3, seed: seed + 42 }), n >> 2);
    const pitFine = TG.fbm(n, { freq: 40, octaves: 2, seed: seed + 43, ppc: 3 });
    const pits = F(n);
    for (let i = 0; i < pits.length; i++) {
      const cover = clamp01((pitVary[i] - 0.56) * 3.6);
      const size = 0.05 + 0.11 * pitVary[i] + 0.05 * pitFine[i];
      pits[i] = clamp01((size - pitRaw[i]) * 9.0) * cover;
    }
    // chipped block corners: erode the ashlar bevel where a noise says so
    const chipMask = TG.lowFreq(n, (r) => TG.warp(TG.fbm(r, { freq: 9, octaves: 5, seed: seed + 44 }), r, { amp: 0.07, freq: 4, seed: seed + 45 }), n >> 1);
    const chips = F(n);
    for (let i = 0; i < chips.length; i++) chips[i] = clamp01((chipMask[i] - 0.60) * 3.4) * clamp01((A.mortar[i] - 0.05) * 1.9);

    // ---- carved meander band (engraved, then filled with gold) ----------
    // §1.5 ORNAMENT HIERARCHY, both halves of it.
    // (a) SCALE: at the play camera this band spans ~14 screen pixels and a
    //     stroke authored at n*0.0105 landed sub-pixel, so mipping ate the key
    //     pattern and left a smeared gold-brown ribbon. Fewer, larger cells with
    //     a 60% fatter stroke is the same motif at a scale that survives.
    // (b) DISTRIBUTION: a meander at one intensity around the whole circumference
    //     is wallpaper and it destroys the eye path. Only the gate-flanking bays
    //     get the key; every other bay gets a plain two-rail gold fillet, so the
    //     ornament TELLS THE EYE WHERE THE DOOR IS.
    const orn = F(n);
    if (o.fillet) {
      const lw = Math.max(3, n * 0.013);
      TG.drawLine(orn, n, 0, n * 0.5 - n * 0.105, n, n * 0.5 - n * 0.105, lw, 1.0, 1.35);
      TG.drawLine(orn, n, 0, n * 0.5 + n * 0.105, n, n * 0.5 + n * 0.105, lw, 1.0, 1.35);
      TG.drawLine(orn, n, 0, n * 0.5, n, n * 0.5, lw * 0.45, 0.6, 1.2);
    } else {
      TG.meanderBand(orn, n, { y: n * 0.5, height: n * 0.20, cells: 3, lineW: Math.max(3, n * 0.017), value: 1, soft: n * 0.0022 });
    }
    const ornSoft = TG.blurWrap(orn, n, Math.max(1, n * 0.003), 1);

    // ---- height ---------------------------------------------------------
    const h = combine(n, [[A.height, 0.58], [base, 0.22], [chisel, 0.08], [grit, 0.035]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.09 - pits[i] * 0.10 - chips[i] * 0.30 - ornSoft[i] * 0.32);

    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    // ---- value + temperature -------------------------------------------
    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.24 + A.id[i] * 0.32 + A.lobe[i] * 0.26 + (base[i] - 0.5) * 0.50 + grit[i] * 0.07
        + chisel[i] * 0.09 - pits[i] * 0.18 + chips[i] * 0.16;
    }
    const temp = TG.lowFreq(n, (r) => {
      const t = TG.warp(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), r, { amp: 0.08, freq: 2, seed: seed + 32 });
      for (let i = 0; i < t.length; i++) t[i] = clamp01((t[i] - 0.35) * 1.9);
      return t;
    }, n >> 2);
    // each block also gets its own warm/cool bias — quarried from a different bed
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.62 + A.id[i] * 0.55 + A.lobe[i] * 0.38);
    paintValue(v, n, { rng, seed, temp, cavity: cav, cavityAmt: 0.34, edge, edgeAmt: 0.17, flowBase: 0.12, swirl: 1.9, highlight: 0.75 });

    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus', 'stone.tartarus.cool');

    // mortar seams sink into ink-plum, not grey
    TG.tintRGB(rgb, n, powField(A.mortar, 1.4), C255(INK.plum), 0.85);
    // blood grime weeping out of the crevices
    const grime = TG.dirtMask(h, n, { seed: seed + 44, cavity: cav, streak: 0.055, streakStrength: 0.7 });
    TG.tintRGB(rgb, n, powField(grime, 1.6), C255('#2a0a14'), 0.62);
    // gold inlay in the engraved meander
    // GOLD HAS A RAMP; USE IT. Biased to 0.56 with edge at 0.55 this field pinned
    // at 1.0 across most of the ornament, which addresses only the ramp's top
    // stop (#fff9e4) and throws the entire bronze half (#43280d..#a9721f) away.
    // Re-centred on 0.30-0.55 of the ramp so the field reads as BRONZE and the
    // 0.83+ band is reserved for genuine edge highlights.
    const inlayV = F(n);
    for (let i = 0; i < inlayV.length; i++) inlayV[i] = clamp01(0.34 + (base[i] - 0.5) * 0.30 + edge[i] * 0.32 + orn[i] * 0.18 - cav[i] * 0.50);
    TG.compositeRamp(rgb, n, powField(orn, 1.35), inlayV, 'gold', 0.42);
    // a warm bounce glaze along the upper faces of each block
    const upFace = TG.edgeMask(h, n, Math.max(2, n * 0.008), 3);
    TG.tintRGB(rgb, n, scaleField(TG.blurWrap(upFace, n, Math.max(2, n * 0.004), 1), 0.62), C255('#e08a6a'), 0.22);

    const rough = TG.artisticRoughness(n, {
      base: 0.84, height: h, cavity: cav, edge, polish: 0.22, dry: 0.18, variation: 0.14,
      seed: seed + 7, min: 0.34, max: 0.99,
      strokes: { count: Math.round(n * 0.45), flow: TG.flowField(n, { base: 0.15, swirl: 0.6, freq: 3, seed: seed + 8 }), value: [0.1, 0.35], len: [n * 0.04, n * 0.12], width: [1.4, 3.4], rng },
      strokeAmount: 0.22,
    });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(orn[i] * 1.15); rough[i] = clamp01(rough[i] * (1 - orn[i] * 0.62)); }

    return { rgb, height: h, rough, metal, normalScale: 0.75, aoFloor: 0.34,
      // THE UNDERCUT GETS THE INK RAMP, NOT ABSENCE (§2 shadow plum #241238).
      // A flat, unconditional 0.05-display floor in the ramp's own violet. It is
      // two full stops under the bloom gate and invisible on any lit face — but
      // where a carved channel receives no light at all it is the difference
      // between a dark interior and a black line drawn on stone, which is the
      // whole difference between carving and stencil line-art.
      params: { emissive: 0x241238, emissiveIntensity: 0.18 },
      paint: { triplanar: true, triScale: 0.165, macroStrength: 0.34, macroScale: 0.0135, macroTint: '#6b4a58', variation: 0.30, variationTint: TARTARUS.stoneLight } };
  } },

  // The plain-fillet perimeter bay. Same quarry, same bed, no meander (§1.5).
  'stone.tartarus.bay': { size: HERO, build(n, rng, seed) {
    return RECIPES['stone.tartarus'].build(n, rng, seed, { fillet: true });
  } },

  // ======================================================================
  // RUBBLE — the same quarry as the wall, but authored at PROP scale. The
  // debris used to share M(kit.wall), which meant a 0.6m broken block carried
  // wall-scale ashlar coursing and a meander band, and a fresh fracture face
  // was as weathered as the exterior. Coarse chisel facets, no coursing, no
  // ornament, and a much larger triScale so the features are prop-sized.
  // ======================================================================
  'rubble.tartarus': { size: MID, build(n, rng, seed) {
    let base = TG.fbm(n, { freq: 2.6, octaves: 6, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.10, freq: 2, seed: seed + 11 });
    const chisel = TG.ridged(n, { freq: 5.5, octaves: 4, seed: seed + 3, type: 'grad' });
    const grit = TG.fbm(n, { freq: 20, octaves: 3, seed: seed + 2, ppc: 3 });
    // big conchoidal facets: a broken stone is FLAT PLANES meeting at arrises,
    // not a lumpy field. Worley f2-f1 gives the plate boundaries for free.
    const facet = TG.worleyField(n, { freq: 6, mode: 'f2f1', seed: seed + 5, jitter: 1, res: n >> 1 });
    const facetId = TG.worleyField(n, { freq: 6, mode: 'cell', seed: seed + 5, jitter: 1, res: n >> 1 });
    const pitRaw = TG.worleyField(n, { freq: 17, mode: 'f1', seed: seed + 4, jitter: 1, res: n >> 1 });
    const pits = F(n);
    for (let i = 0; i < pits.length; i++) pits[i] = clamp01((0.11 - pitRaw[i]) * 8.0);

    const h = combine(n, [[base, 0.36], [chisel, 0.24], [grit, 0.05]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.30 + (1 - Math.min(1, facet[i] * 5.0)) * 0.16 - pits[i] * 0.12);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.010), 5.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.005), 6.0);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.26 + (facetId[i] - 0.5) * 0.30 + (base[i] - 0.5) * 0.46 + chisel[i] * 0.12 + grit[i] * 0.07 - pits[i] * 0.16;
    }
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.36), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.6 + facetId[i] * 0.5);
    paintValue(v, n, { rng, seed: seed + 2, temp, cavity: cav, cavityAmt: 0.38, edge, edgeAmt: 0.22,
      flowBase: 0.55, swirl: 1.6, light: [0.05, 0.17], dark: [-0.20, -0.05], fine: [-0.03, 0.03], highlight: 0.85 });
    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus', 'stone.tartarus.cool');
    // arrises catch a dusty bone highlight; the deep facet junctions go ink
    TG.tintRGB(rgb, n, powField(scaleField(TG.copyField(edge), 0.8), 1.3), C255('#c9a894'), 0.26);
    const seam = F(n);
    for (let i = 0; i < seam.length; i++) seam[i] = clamp01(1 - facet[i] * 4.5);
    TG.tintRGB(rgb, n, powField(seam, 1.5), C255(INK.plum), 0.60);
    const grime = TG.dirtMask(h, n, { seed: seed + 44, cavity: cav, streak: 0.05, streakStrength: 0.6 });
    TG.tintRGB(rgb, n, powField(grime, 1.6), C255('#2a0a14'), 0.48);

    const rough = TG.artisticRoughness(n, {
      base: 0.86, height: h, cavity: cav, edge, polish: 0.16, dry: 0.24, variation: 0.16,
      seed: seed + 7, min: 0.40, max: 0.99,
    });
    return { rgb, height: h, rough, metal: 0.0, normalScale: 1.05,
      // ~3x the wall's triScale: a 0.6m chunk must not wear 3m features
      // §7: a 0.5m chunk at triScale 0.52 shows one flat facet of a 1.9m feature
      // and reads as an untextured faceted blob. 1.6 = a 0.62m period, so a
      // single chunk carries real broken-stone detail.
      paint: { triplanar: true, triScale: 1.6, macroStrength: 0.26, macroScale: 0.05, macroTint: '#6b4a58',
        variation: 0.42, variationTint: TARTARUS.stoneLight } };
  } },

  // THE FLAGSTONE READ (round-3). The plate used to carry an 11x8 regular bond
  // over a 28.6m period, i.e. a single "flagstone" 2.6m x 3.6m. That is not a
  // flagstone; it is a slab the size of a car, and the review was right that it
  // had beaten §7's tiling ban by making the stones too large to be stones.
  //
  // The bond is now IRREGULAR (see flagBond above) and the plate carries 16
  // courses of ~15 stones. Projected at the chamber's triScale of 0.056 — a
  // 17.9m period, deliberately close to the period the tiling metric was
  // already tuned at — a course is 1.12m and a stone is 0.9-1.5m across, which
  // is a stone a person could have laid. What defeats the repeat is no longer
  // scale: it is unequal courses, unequal stones, per-stone rotation, per-stone
  // value, broken and replaced flags, and a macro multiply whose period is four
  // times the plate's.
  'floor.tartarus': { size: 1024, build(n, rng, seed) {
    const T = flagBond(n, {
      rng, courses: 16, perCourse: 15,
      joint: 0.0012, bevel: 0.0032, rot: 0.030, wobble: 0.0045,
      broken: 0.17, replace: 0.11,
    });
    // FULL resolution, deliberately. Everywhere else the warped fBm is a broad
    // glaze and half resolution is free; here it is the low-frequency value
    // drift that decorrelates one course of stones from the next, and it is the
    // only defence the floor has against §7's visible-repetition ban.
    const base = TG.warp2(TG.fbm(n, { freq: 4, octaves: 6, seed }), n, { amp: 0.07, freq: 2, seed: seed + 1 });
    const grit = TG.fbm(n, { freq: 30, octaves: 3, seed: seed + 2, ppc: 3 });
    // chipping, not crazing: cracks confined to a minority of the stones
    const rawCrack = TG.cracks(n, { levels: [{ freq: 9, width: 0.035, weight: 1 }], seed: seed + 5, warpAmp: 0.05 });
    const crackWhere = TG.lowFreq(n, (r) => TG.fbm(r, { freq: 3, octaves: 4, seed: seed + 51 }), n >> 2);
    const fissure = F(n);
    // §1.10: under 15% of stones should crack at all. At a 0.58 gate the crazing
    // was universal and became the single most legible detail in the close shots.
    for (let i = 0; i < fissure.length; i++) fissure[i] = rawCrack[i] * clamp01((crackWhere[i] - 0.72) * 4.2);

    const h = combine(n, [[T.height, 0.40], [base, 0.30], [grit, 0.08]]);
    // per-stone RISE: flags that sit proud and flags that have settled. Without
    // it a bed of chamfered stones is still one perfectly flat plane with lines
    // scored in it, and the normal map has nothing to model.
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.12 + T.rise[i] * 0.045 - fissure[i] * 0.34);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6);

    // biased toward the COOL end: large cold slate fields with warm crimson
    // patches reading through them is the two-hue structure §2 asks for
    // A bimodal warm/cool selector on a big floor reads as glowing magma patches
    // between slate patches. Keep the two-hue structure §2 asks for, but let the
    // field spend most of its range in the MIDDLE so the transition is a glaze.
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.warp(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 21 }), r, { amp: 0.1, freq: 2, seed: seed + 22 }), -0.38), 1.02)), n >> 2);
    const v = F(n);
    // per-stone tone is deliberately gentle: a strong per-tile tone pattern is
    // the single loudest tiling cue on a big floor.
    // Per-stone tone is now the LOUDEST anti-tiling cue rather than the quietest:
    // a regular joint lattice is only legible while the stones either side of a
    // joint agree in value, so 0.22 of per-stone swing is what breaks the row.
    // Per-stone TONE (id) plus the stone's own light/shade AXIS (lobe). A flat
    // per-tile tint plus noise reads as procedural speckle; a stone that is
    // measurably lighter on one side and sunk on the other, with a different
    // axis on its neighbour, is what a hand-laid painted floor looks like.
    // 0.22 id + 0.30 lobe + the glazes below puts the swing INSIDE one stone
    // at ~0.35 of value, which is the Hades figure.
    for (let i = 0; i < v.length; i++) {
      // 0.30 of lobe measured 0.805 on the tiling autocorrelation (§7 hard ban):
      // a strong gradient inside every stone makes the BOND pitch the loudest
      // periodic signal in the frame. 0.14 keeps the hand-laid read and puts
      // the repeat back under the 0.62 it started at.
      // §14's lesson applied in the other direction. Per-stone tone used to be
      // held DOWN to 0.22 because on a regular lattice a strong per-tile tone
      // makes the BOND the loudest periodic signal in the frame. There is no
      // bond pitch left to amplify, so the swing can finally be what Jen Zee
      // paints: a full value step from one stone to the next, plus the stone's
      // own light/shade axis across it, plus the chamfer that catches the light
      // on one side of every stone and drops into a channel on the other.
      v[i] = 0.28 + T.id[i] * 0.32 + T.lobe[i] * 0.24 + (base[i] - 0.5) * 0.52 + grit[i] * 0.05
           + T.arris[i] * 0.30;
    }
    // and the lit side of each stone is also the WARM side — colour variation
    // within the material, not a uniform tint over noise
    // the lit chamfer is also the WARM one, the shaded chamfer the cool one:
    // colour separation across a 3cm arris is what makes carved stone read
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] + T.lobe[i] * 0.30 + (T.id[i] - 0.5) * 0.34 + T.arris[i] * 0.26);
    // A floor is seen at a grazing angle across a whole screen: any high-frequency
    // value noise turns into shimmering mottle once bloom gets hold of it. Broad
    // glazes stay, the hatching goes quiet.
    // Peak stroke amplitude of 0.07 in a 0-1 value field does not survive a
    // tonemap: the measured within-tile value std was 0.079 and the only
    // structure reaching the screen was geometric (seams, bevels). Hades'
    // painted stone carries 0.25-0.40 of value swing inside ONE block. Shimmer
    // is a mip/roughness problem, not an amplitude problem — the raised detail
    // is fed through the toksvig bake below instead of being flattened here.
    paintValue(v, n, { rng, seed: seed + 3, temp, cavity: cav, cavityAmt: 0.44, edge, edgeAmt: 0.11,
      flowBase: 0.9, swirl: 2.3, light: [0.055, 0.185], dark: [-0.170, -0.052], fine: [-0.034, 0.034], highlight: 0.75 });
    const rgb = TG.applyRamp2(v, temp, n, 'floor.tartarus', 'floor.tartarus.cool');

    // The seam ink used to be a hard #07060f at 0.86 over a 0.0065 gap. Once the
    // plate was scaled up for the play camera those joints became finger-wide
    // black bands and the floor read as crazy paving rather than as laid stone.
    // THE JOINT IS A CHANNEL, NOT A LINE. Ink only the actual mortar gap — the
    // chamfer either side of it has just been painted light on one edge and
    // dark on the other, and tinting across the whole seam mask (gap AND
    // chamfer, which is what T.seam covers) is exactly the move that turns a
    // carved edge back into stencil line-art. And the gap gets the ink ramp's
    // COLOUR: plum first, deep second, so the deepest point of a joint sits at
    // §2's #241238/#120b1e and never at absolute zero.
    TG.tintRGB(rgb, n, powField(T.joint, 1.15), C255(INK.plum), 0.58);
    TG.tintRGB(rgb, n, powField(T.joint, 2.20), C255(INK.deep), 0.42);
    TG.tintRGB(rgb, n, powField(fissure, 1.2), C255('#180610'), 0.55);
    // spilled ichor pooling in the seams
    const stain = warpLo(n, { freq: 3, octaves: 5, seed: seed + 61 }, { amp: 0.12, freq: 2, seed: seed + 62 });
    const stainM = F(n);
    // deliberate spills, not mottling: a high threshold makes fewer, larger,
    // clearly shaped stains that read as painted rather than as noise
    // The 0.35 base term put ichor across the WHOLE surface, which is mottling,
    // not a spill: ~40% coverage at the same greyscale value as the floor under
    // it, in a competing warm hue. Gate it entirely on cavity so it exists only
    // in seams and low ground, and drop the opacity so it darkens rather than
    // recolours. Target coverage < 8% of texels.
    for (let i = 0; i < stainM.length; i++) stainM[i] = clamp01((stain[i] - 0.86) * 3.0) * (cav[i] * 0.9);
    TG.compositeRamp(rgb, n, stainM, v, 'blood', 0.28);
    TG.tintRGB(rgb, n, scaleField(powField(edge, 1.6), 0.5), C255('#b98a7c'), 0.20);
    // pale bone-dust drifted into the low ground: the floor's light accents
    const dust = TG.lowFreq(n, (r) => TG.warp(TG.fbm(r, { freq: 6, octaves: 5, seed: seed + 71 }), r, { amp: 0.09, freq: 3, seed: seed + 72 }), n >> 1);
    const dustM = F(n);
    for (let i = 0; i < dustM.length; i++) dustM[i] = clamp01((dust[i] - 0.60) * 3.4) * clamp01(0.25 + cav[i] * 1.5);
    TG.compositeRamp(rgb, n, dustM, clampField(biasField(scaleField(TG.copyField(grit), 0.5), 0.45)), 'bone', 0.42);

    // A floor seen at 52 degrees of pitch is one long grazing angle. Anything
    // that lets a specular lobe get narrow crawls; min 0.62 keeps the whole
    // plate matte enough that the bevel highlights stop strobing (§7).
    const rough = TG.artisticRoughness(n, {
      base: 0.90, height: h, cavity: cav, edge, polish: 0.07, dry: 0.16, variation: 0.13, seed: seed + 9, min: 0.78, max: 0.99,
    });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] - stainM[i] * 0.25);
    return { rgb, height: h, rough, metal: 0.0, normalScale: 0.40,
      // triScale halved => every authored feature is ~2x bigger in world space,
      // which is what the grazing play camera needs (a 7x5 grid now spans ~12u).
      // macroScale is deliberately incommensurate AND far lower frequency than
      // the tile: one macro period is 80u, so a full period never fits inside
      // the 32u arena and no blotch shape can appear twice.
      // macroTint was a 0.55-strength desaturated grey-violet plate over the
      // whole floor: it dragged the surface off the authored crimson ramp
      // (#66413f top stop) into a neutral lilac measuring hue 0.725 on screen.
      // §2 wants Tartarus stone at #5a2331 / #8c3b46. Keep the macro-scale
      // VALUE break-up that defeats tiling; take the hue off the tint.
      // triScale 0.085 put one texture period at 11.8m, so ~20m of a play-camera
      // frame contained the plate almost twice. 0.055 = an 18.2m period: the
      // visible floor never holds two full periods, and the stochastic rotation
      // above breaks what is left of the lattice.
      // 0.035 => a 28.6m period. The stochastic de-tiler is deliberately OFF
      // here: rotating a laid ashlar bed per patch does kill the lattice, but it
      // also rotates the JOINTS, and a floor whose courses run at three angles
      // reads as rubble rather than as masonry. Scale solves it without cost.
      // STOCHASTIC DE-TILING BACK ON. Plate size alone was measured at 0.53-0.59
      // autocorrelation: a 28.6m period does stop the same STONE recurring, but
      // it does nothing about a regular JOINT LATTICE, and the joints are the
      // signal the test is finding. The rotation is quantised to quarter turns
      // (see painterly.js paintStochFrame), so every course stays square to the
      // world and the bed still reads as laid masonry — what the per-cell
      // OFFSET kills is neighbouring patches agreeing on where the joints are.
      // 0.056 = a 17.9m period. With 16 courses that is a 1.12m course and a
      // 0.9-1.5m stone — a flagstone, not a slab. The period is deliberately
      // held near the 20m the tiling metric was last tuned at: the stone size
      // came from the bond count, NOT from shrinking the plate, so nothing that
      // was already passing had to be traded away to get the read back.
      paint: { projection: 'planarY', triScale: 0.056, stochastic: 0.85,
        // §9.1 THE FLOOR IS A DARK STAGE. This is the single most important
        // number in the frame: it is how much of the light rig the ground plane
        // is allowed to keep. A 100%-up-facing plane collects more key AND more
        // hemisphere than any other surface class in the chamber, which is why
        // an otherwise correct rig still produced a floor 62% brighter than the
        // frame median. Cutting it HERE rather than in render/lighting.js means
        // the columns, capitals, gold trim and brazier rims keep the full rig.
        // Do not "fix" a dark floor by raising the key — raise these instead,
        // and only if the measured groundLuma stays under 0.18.
        litGain: 1.00, ambGain: 0.58, specGain: 0.16,
        // TILING (§7). Measured autocorrelation was 0.535-0.592 at the ashlar
        // pitch. Plate size alone cannot answer a REGULAR JOINT LATTICE — the
        // seams repeat even when the stones do not. A much stronger macro layer
        // at two incommensurate scales puts a low-frequency value drift across
        // whole groups of stones, which is what decorrelates the row the
        // analyzer samples.
        // the macro layer now has real work to do: at a 17.9m period the arena
        // holds ~1.6 plates, so a low-frequency VALUE drift across whole groups
        // of stones (80m, 283m and 5.8m components, none commensurate with the
        // plate) is what stops the second plate reading as the first one again.
        macroStrength: 0.30, macroScale: 0.0125, macroTint: '#4a2c38',
        // belt AND braces with the ground-plane veto in painterly.js: a floor is
        // never a silhouette, so it never carries the art-directed rim
        rimStrength: 0.10,
        // fine grain at a scale incommensurate with the bond: it decorrelates
        // the floor at SHORT lags, which is the half of the tiling test that
        // plate size alone cannot answer
        detailStrength: 0.72, detailScale: 11 } };
  } },

  // ======================================================================
  // The chamber's central rosette. AUTHORED, not a noise field: a polar Greek
  // key running around the rim, sixteen anthemion petals aligned to the gold
  // spokes, and a solid emblem in the middle. Cell noise gets ZERO coverage
  // inside the emblem and is hard-gated everywhere else (§1.4).
  // ======================================================================
  'medallion.tartarus': { size: HERO, build(n, rng, seed) {
    const C = n * 0.5, R = n * 0.5;
    const P = (t) => t * R;                      // fraction of radius -> px
    const TAU = Math.PI * 2;
    const xy = (ang, rad) => [C + Math.cos(ang) * rad, C + Math.sin(ang) * rad];

    // ---- polar Greek key -------------------------------------------------
    // The straight meanderBand generator draws ACROSS a texture; a rosette
    // needs the key to run AROUND it, so the same cell path is authored in
    // (angle, radius) and subdivided on the arc.
    function polarMeander(dst, cells, r0, r1, w, v) {
      const D = TAU / cells, band = r1 - r0, ins = 0.16;
      const a = ins, b = 1 - ins, t = 1 - ins, bo = ins;
      const q = (b - a) * 0.22, qy = (t - bo) * 0.26, mid = (a + b) * 0.5;
      for (let c = 0; c < cells; c++) {
        const flip = (c % 2 === 0) ? 1 : -1;
        const Y = (yy) => (flip > 0 ? yy : (t + bo) - yy);
        const path = [
          [a, Y(bo)], [a, Y(t)], [b - q, Y(t)], [b - q, Y(bo + qy)],
          [a + q * 1.6, Y(bo + qy)], [a + q * 1.6, Y(t - qy * 1.5)],
          [mid + q * 0.2, Y(t - qy * 1.5)],
        ];
        path.push([b, Y(bo)], [b + ins * 1.8, Y(bo)]);      // connector
        for (let k = 0; k < path.length - 1; k++) {
          const [u0, t0] = path[k], [u1, t1] = path[k + 1];
          const steps = 10;
          let prev = xy(c * D + u0 * D, r0 + t0 * band);
          for (let sIdx = 1; sIdx <= steps; sIdx++) {
            const f = sIdx / steps;
            const cur = xy(c * D + (u0 + (u1 - u0) * f) * D, r0 + (t0 + (t1 - t0) * f) * band);
            TG.drawLine(dst, n, prev[0], prev[1], cur[0], cur[1], w, v, 1.2);
            prev = cur;
          }
        }
      }
      TG.drawArc(dst, n, C, C, r0 - band * 0.20, 0, TAU, w * 0.8, v * 0.9, 1.1);
      TG.drawArc(dst, n, C, C, r1 + band * 0.20, 0, TAU, w * 0.8, v * 0.9, 1.1);
    }

    // ---- one anthemion petal, pointing outward along `ang` ---------------
    function petal(dst, ang, rIn, rOut, v, w) {
      const L = rOut - rIn;
      const spine = [];
      for (let k = 0; k <= 10; k++) { const f = k / 10; spine.push(xy(ang, rIn + L * f)); }
      TG.drawPolyline(dst, n, spine, w * 1.15, v, 1.2);
      TG.drawDisc(dst, n, spine[10][0], spine[10][1], w * 1.5, v, 1.3);
      for (const sgn of [-1, 1]) {
        for (const [spread, len] of [[0.055, 0.94], [0.100, 0.70], [0.135, 0.44]]) {
          const lobe = [];
          for (let k = 0; k <= 9; k++) {
            const f = k / 9;
            lobe.push(xy(ang + sgn * spread * Math.sin(f * Math.PI * 0.72), rIn + L * len * f));
          }
          TG.drawPolyline(dst, n, lobe, w * (1.0 - 0.18 * len), v * 0.94, 1.2);
          TG.drawDisc(dst, n, lobe[9][0], lobe[9][1], w * 1.15, v * 0.9, 1.2);
        }
      }
      // volute foot: the petal must sit ON something, not float
      TG.drawArc(dst, n, C + Math.cos(ang) * rIn, C + Math.sin(ang) * rIn, L * 0.10, 0, TAU, w * 0.9, v * 0.85, 1.2);
    }

    const orn = F(n);
    const SPOKES = 16;
    const lw = Math.max(1.8, n * 0.0042);
    polarMeander(orn, 24, P(0.72), P(0.88), Math.max(2, n * 0.0046), 1.0);
    for (let i = 0; i < SPOKES; i++) petal(orn, (i / SPOKES) * TAU, P(0.30), P(0.68), 0.96, lw);
    // emblem: a bounded solid field, then a carved star inside it
    TG.drawArc(orn, n, C, C, P(0.28), 0, TAU, Math.max(2.4, n * 0.006), 1.0, 1.2);
    TG.drawArc(orn, n, C, C, P(0.235), 0, TAU, Math.max(1.6, n * 0.0035), 0.85, 1.2);
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * TAU;
      const p0 = xy(a0, P(0.055)), p1 = xy(a0, P(0.20));
      TG.drawLine(orn, n, p0[0], p0[1], p1[0], p1[1], lw * 1.25, 0.95, 1.2);
      const b0 = xy(a0 + TAU / 16, P(0.075)), b1 = xy(a0 + TAU / 16, P(0.145));
      TG.drawLine(orn, n, b0[0], b0[1], b1[0], b1[1], lw * 0.85, 0.8, 1.2);
    }
    TG.drawDisc(orn, n, C, C, P(0.055), 1.0, 2.0);
    const relief = TG.blurWrap(orn, n, Math.max(1, n * 0.0035), 1);

    // ---- ground: carved stone, not a Worley field ------------------------
    const base = warpLo(n, { freq: 3.5, octaves: 6, seed }, { amp: 0.09, freq: 2, seed: seed + 1 });
    const grit = TG.fbm(n, { freq: 24, octaves: 3, seed: seed + 2, ppc: 3 });
    // radial masks, in medallion-radius units
    const rad = F(n), emblem = F(n), field = F(n);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5 - C) / R, dy = (y + 0.5 - C) / R;
        const d = Math.sqrt(dx * dx + dy * dy);
        const i = y * n + x;
        rad[i] = d;
        emblem[i] = 1 - clamp01((d - 0.24) * 22);        // solid inside r<0.28
        field[i] = clamp01((d - 0.30) * 14);
      }
    }
    // cracks live ONLY where a low-frequency mask says so, and never on the
    // emblem — the same gate the floor uses for its fissures.
    const crackRaw = TG.cracks(n, { levels: [{ freq: 6, width: 0.045, weight: 1 }], seed: seed + 5, warpAmp: 0.06 });
    const where = TG.lowFreq(n, (r) => TG.fbm(r, { freq: 2.5, octaves: 4, seed: seed + 6 }), n >> 2);
    const crack = F(n);
    // GATE THE CRACK FIELD OUT OF THE METAL. The same fine dark scratch overlay
    // was reading on the gold inlay, on the flagstones and on the hero at three
    // different scales, so one noise was doing the job of four materials and the
    // whole frame read as one substance with three tints (§1.4). Gold dents and
    // burnishes; it does not craze. Cracks now live only in the stone bed.
    for (let i = 0; i < crack.length; i++) {
      crack[i] = crackRaw[i] * clamp01((where[i] - 0.66) * 4.2) * field[i] * 0.55 * (1 - clamp01(relief[i] * 1.35));
    }

    const h = F(n);
    for (let i = 0; i < h.length; i++) {
      h[i] = clamp01(0.44 + relief[i] * 0.44 + emblem[i] * 0.10 + (base[i] - 0.5) * 0.24 + grit[i] * 0.05 - crack[i] * 0.42);
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.0035), 6.0);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.20 + (base[i] - 0.5) * 0.44 + grit[i] * 0.05 + emblem[i] * 0.10 - crack[i] * 0.30;
    }
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.warp(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 8 }), r, { amp: 0.09, freq: 2, seed: seed + 9 }), -0.34), 1.7)), n >> 2);
    paintValue(v, n, { rng, seed: seed + 7, temp, cavity: cav, cavityAmt: 0.40, edge, edgeAmt: 0.12,
      flowBase: 0.5, swirl: 2.4, light: [0.02, 0.075], dark: [-0.10, -0.02], fine: [-0.02, 0.02], highlight: 0.35 });
    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus', 'stone.tartarus.cool');
    TG.tintRGB(rgb, n, powField(crack, 1.2), C255(INK.void), 0.72);

    // ---- gold inlay --------------------------------------------------------
    // MEASURED: 25.4% of gold pixels above 0.92 display luma at mean chroma
    // 0.46 — a quarter of the hero ornament was paper white with no shape, no
    // crevice and no bronze, because a 0.52 bias plus a 0.60 edge term pinned
    // the value field at 1.0 over large regions and only ever addressed the
    // ramp's top stop. Centre the field on 0.30-0.55 (#6d4416 -> #a9721f) and
    // let edge alone reach the #f2c14e / #ffe9a8 band. Cavity subtraction is
    // raised so the crevices genuinely bottom out at #43280d.
    const inlayV = F(n);
    for (let i = 0; i < inlayV.length; i++) inlayV[i] = clamp01(0.30 + (base[i] - 0.5) * 0.30 + edge[i] * 0.34 - cav[i] * 0.55);
    // BURNISH, not crazing: tool marks that follow the spoke direction, so the
    // metal carries its own directional brushwork (§1.4 "directional strokes").
    {
      const burnFlow = TG.flowField(n, { base: 0, swirl: 0.34, freq: 3, seed: seed + 61, radial: true, radialMix: 0.92 });
      TG.strokes(inlayV, n, {
        rng, flow: burnFlow, mask: powField(relief, 0.9),
        count: Math.round(n * 1.3), len: [n * 0.010, n * 0.055], width: [0.9, 2.6],
        value: [-0.12, 0.12], curl: 0.10, bristle: 0.72, taper: 1.9, softness: 1.15,
      });
      clampField(inlayV);
    }
    TG.compositeRamp(rgb, n, powField(relief, 0.80), inlayV, 'gold', 0.97);

    // ROUGHNESS: no per-cell white specular edge anywhere. The stone is matte,
    // only the inlay is allowed to catch a highlight.
    // §1.4 roughness is an ARTISTIC map, and §4 asks for "a small, bright, sharp
    // glint — jewellery and metal only". Flooring the WHOLE plate at 0.66 to stop
    // grazing-angle crawl killed every glint in the frame and left the image
    // waxy. Split it by mask instead: the stone bed goes properly matte, and the
    // inlay alone is carved down to 0.16-0.35 so the gold catches a tight
    // highlight. The Toksvig bake in set() then re-roughens wherever the normal
    // map is genuinely noisy, which is the correct cure for the crawl.
    const rough = TG.artisticRoughness(n, {
      base: 0.92, height: h, cavity: cav, polish: 0.0, dry: 0.14, variation: 0.10, seed: seed + 11, min: 0.80, max: 0.99,
    });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      const g = clamp01(relief[i] * 1.25);
      // metal 0.85: gold takes its colour from REFLECTION, not from a blown
      // albedo. At 0.55 it kept a huge diffuse term over a near-white field.
      metal[i] = g * 0.45;
      const gloss = 0.16 + 0.19 * clamp01(base[i]) + 0.10 * cav[i];
      rough[i] = clamp01(rough[i] * (1 - g) + gloss * g);
    }
    const em = clampField(mapGold(relief, edge, cav));
    const emissive = TG.applyRamp(em, n, 'gold');
    for (let i = 0; i < em.length; i++) {
      const k = Math.pow(em[i], 1.4), j = i * 3;
      emissive[j] *= k; emissive[j + 1] *= k * 0.95; emissive[j + 2] *= k * 0.76;
    }
    // §1.7 THE GOLD SPINE HAS TO REACH THE LIGHT BAND. Median display luma of
    // the ring arc measured 0.194 against a floor at 0.167 — the ornament sat at
    // floor value and read only by hue. A modest emissive floor in the AUTHORED
    // gold mid (#c98f2b) self-lights the filigree to the top band even where the
    // key does not reach it, without pushing it over the bloom gate.
    return { rgb, height: h, rough, metal, normalScale: 0.85, emissive, emissiveIntensity: 0.05,
      params: { envMapIntensity: 0.38 },
      // §9.2 THE CHARACTER OUT-VALUES THE FLOOR. The rosette is the ornament the
      // hero stands ON, so it is allowed to be the brightest thing in the play
      // area's stone — but not by so much that a 120px character cannot beat it.
      // Measured at the close poses it was reading 0.68 display over the whole
      // frame, i.e. the hero's plinth was the frame's white point. The gains
      // below sit ABOVE floor.tartarus (it is ornament, §9.5) and well under a
      // wall, and the specular cut is what stops a near-white sheen on a 3/4
      // camera from re-inflating it.
      paint: { triplanar: false, macroStrength: 0.16, macroTint: '#7a4f58',
        litGain: 0.22, ambGain: 0.16, specGain: 0.10 } };
  } },

  // ======================================================================
  // CHARACTER — the hero's surface (ART_DIRECTION §4, §7).
  //
  // AGENT-PLAYER: `ctx.mats.get('character.hero')` — NOT 'marble.elysium'.
  // Two §7 bans are live while the player is a raw CapsuleGeometry wearing an
  // Elysium ENVIRONMENT stone in a Tartarus chamber: it is an untextured
  // programmer-art primitive, and because its paintConfig variant is
  // 'environment' the hero never receives CHARACTER_LOOK, so it gets a 0.40 rim
  // instead of 0.85 and no banded terminator at all. This entry fixes both: it
  // resolves through the character shader (2-3 step ramp, hand AO, colour-
  // shifted inner contour, full-strength #5fd0ff complement rim) over a real
  // painted surface — crimson wool over dark leather with a gold hem.
  //
  // ALBEDO TARGET: linear luma 0.24. The Elysium marble it was wearing measures
  // ~0.75, which is why 22.8% of the capsule's own pixels clipped to featureless
  // white — the one bright object in the frame had no form and no terminator.
  // A mid albedo under a strong key is what gives a character a readable
  // terminator AND lets it sit at 0.70-0.85 display as a silhouette (§1.1).
  // ======================================================================
  'character.hero': { size: MID, build(n, rng, seed) {
    const weave = TG.weave(n, { threads: Math.max(40, Math.round(n / 6)), seed });
    const fold = warpLo(n, { freq: 2.4, octaves: 5, seed: seed + 1, type: 'grad' }, { amp: 0.10, freq: 2, seed: seed + 2 });
    const wear = warpLo(n, { freq: 7, octaves: 5, seed: seed + 3 }, { amp: 0.06, freq: 3, seed: seed + 4 });
    // a broad leather panel across the lower half, cloth above
    const panel = F(n);
    for (let y = 0; y < n; y++) {
      const t = clamp01((y / n - 0.46) * 5.0);
      for (let x = 0; x < n; x++) panel[y * n + x] = t * clamp01(0.55 + wear[y * n + x] * 0.9);
    }
    // gold hem + a beaded belt: the character's own ornament spine (§1.5)
    const orn = F(n);
    TG.meanderBand(orn, n, { y: n * 0.435, height: n * 0.075, cells: 4, lineW: Math.max(2, n * 0.010), value: 1, rails: true, soft: n * 0.002 });
    TG.beadRow(orn, n, { y: n * 0.955, count: 22, r: n * 0.008, value: 0.9 });
    const ornS = TG.blurWrap(orn, n, Math.max(1, n * 0.003), 1);

    const h = F(n);
    for (let i = 0; i < h.length; i++) {
      h[i] = clamp01(0.44 + weave[i] * 0.26 * (1 - panel[i]) + (fold[i] - 0.5) * 0.34 + panel[i] * 0.10 + ornS[i] * 0.26);
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.010), 5.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7.0);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = clamp01(0.40 + (fold[i] - 0.5) * 0.66 + weave[i] * 0.12 - panel[i] * 0.20 + (wear[i] - 0.5) * 0.16);
    }
    paintValue(v, n, { rng, seed: seed + 5, cavity: cav, cavityAmt: 0.34, edge, edgeAmt: 0.22,
      flowBase: Math.PI / 2, swirl: 0.55, light: [0.03, 0.13], dark: [-0.12, -0.03], fine: [-0.02, 0.02], highlight: 0.7 });
    const rgb = TG.applyRamp(v, n, 'banner.crimson');
    // leather: the same value field read through a dark bronze ramp
    TG.compositeRamp(rgb, n, powField(panel, 1.1), clampField(scaleField(TG.copyField(v), 0.72)), 'wood.dark', 0.86);
    // §4 hand AO: the crevices are DARKENED BY HAND into the albedo so the form
    // still reads when the light rig is not helping
    TG.tintRGB(rgb, n, powField(cav, 1.25), C255(INK.plum), 0.62);
    const goldV = F(n);
    for (let i = 0; i < goldV.length; i++) goldV[i] = clamp01(0.36 + (weave[i] - 0.5) * 0.28 + edge[i] * 0.34 - cav[i] * 0.52);
    TG.compositeRamp(rgb, n, powField(orn, 1.0), goldV, 'gold', 0.92);

    const rough = TG.artisticRoughness(n, {
      base: 0.74, height: h, cavity: cav, edge, polish: 0.22, dry: 0.20, variation: 0.16, seed: seed + 7, min: 0.30, max: 0.98,
    });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      const g = clamp01(orn[i]);
      metal[i] = g * 0.85;
      // §4 "specular is a small, bright, sharp glint — jewellery and metal only"
      rough[i] = clamp01(rough[i] * (1 - g) + 0.17 * g + panel[i] * 0.06);
    }
    return { rgb, height: h, rough, metal, normalScale: 1.05,
      params: { envMapIntensity: 0.45, emissive: 0x241238, emissiveIntensity: 0.18 },
      paint: {
        variant: 'character', triplanar: false,
        rimColor: '#5fd0ff', rimStrength: 1.0, rimPower: 1.4,
        rampSoftness: 0.12, rampSteps: [0.26, 0.60], rampLevels: [0.10, 0.60, 1.0],
        contourStrength: 0.55, contourColor: '#241238', shadowDepth: 0.72,
      } };
  } },

  // ======================================================================
  // COLUMN DRUM STONE — a DIFFERENT stone from the wall.
  //
  // §1.5: Hades holds marble, blood-stone, bronze, bone and cloth in one frame
  // and you can name each at a glance. Handing `stone.tartarus` to the wall, the
  // island skirt, the column shafts AND the gate arch, differentiated only by a
  // per-instance tint, is not a material hierarchy — it is one substance in four
  // places. This is quarried paler, bedded as stacked DRUMS (6 courses, no 3x2
  // wall bond), carries no meander, and its chisel field runs vertically with
  // the shaft instead of swirling.
  // ======================================================================
  'stone.tartarus.column': { size: MID, build(n, rng, seed) {
    const A = TG.ashlar(n, { rows: 6, cols: 1, rng, mortar: 0.010, bevel: 0.04, wobble: 0.006 });
    let base = TG.fbm(n, { freq: 3, octaves: 6, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.06, freq: 2, seed: seed + 11 });
    const grit = TG.fbm(n, { freq: 24, octaves: 3, seed: seed + 2, ppc: 3 });
    // vertical tooling: a quarried shaft is dressed with a claw chisel that runs
    // WITH the axis, which is also what stops a cylinder reading as a smooth tube
    const chisel = TG.ridged(n, { freq: 3, octaves: 4, seed: seed + 3, type: 'grad' });
    const pitRaw = TG.worleyField(n, { freq: 20, mode: 'f1', seed: seed + 4, jitter: 1, res: n >> 1 });
    const pits = F(n);
    for (let i = 0; i < pits.length; i++) pits[i] = clamp01((0.085 - pitRaw[i]) * 9.0);

    const h = combine(n, [[A.height, 0.46], [base, 0.24], [chisel, 0.16], [grit, 0.04]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.12 - pits[i] * 0.10);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.34 + A.id[i] * 0.20 + A.lobe[i] * 0.22 + (base[i] - 0.5) * 0.42 + chisel[i] * 0.13 + grit[i] * 0.06 - pits[i] * 0.16;
    }
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.40), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.66 + A.id[i] * 0.44 + A.lobe[i] * 0.30);
    // flowBase ~PI/2 = strokes run UP the shaft; swirl held right down so they
    // stay parallel instead of curling into the marble-print look
    paintValue(v, n, { rng, seed, temp, cavity: cav, cavityAmt: 0.30, edge, edgeAmt: 0.20,
      flowBase: 1.52, swirl: 0.34, flowFreq: 1.1, light: [0.03, 0.12], dark: [-0.12, -0.03], highlight: 0.9 });
    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus.column', 'stone.tartarus.column.cool');
    TG.tintRGB(rgb, n, powField(A.mortar, 1.3), C255(INK.plum), 0.78);
    const grime = TG.dirtMask(h, n, { seed: seed + 44, cavity: cav, streak: 0.09, streakStrength: 0.85 });
    TG.tintRGB(rgb, n, powField(grime, 1.8), C255('#2a1224'), 0.42);

    const rough = TG.artisticRoughness(n, {
      base: 0.80, height: h, cavity: cav, edge, polish: 0.24, dry: 0.20, variation: 0.14,
      seed: seed + 7, min: 0.36, max: 0.98,
    });
    return { rgb, height: h, rough, metal: 0.0, normalScale: 0.9,
      // §1.9 CYLINDRICAL, NOT TRIPLANAR. On a 5.4m fluted shaft the surface
      // normal is horizontal everywhere, so a triplanar blend runs entirely
      // between the X and Z projections and sweeps as the cylinder curves — the
      // ashlar bed gets dragged into continuous vertical bands that read as
      // stained plywood. Unwrapping the angle keeps the courses horizontal.
      paint: { projection: 'cylinderY', triScale: 0.42, circScale: 4.0,
        macroStrength: 0.20, macroScale: 0.02, macroTint: '#7a5f63', variation: 0.16, variationTint: '#9a6a63' } };
  } },

  // ======================================================================
  // VOUSSOIR STONE — for the gate arch only. The torus UV runs ALONG the
  // arc, so a 1-row grid lays real radial wedges instead of a smeared bed,
  // and a gold bead follows both arrises. §1.5: the door carries the room's
  // heaviest ornament, and nothing else gets this stone.
  // ======================================================================
  'stone.tartarus.arch': { size: MID, build(n, rng, seed) {
    const T = TG.tileGrid(n, { cols: 15, rows: 1, pattern: 'grid', gap: 0.006, bevel: 0.022, rng, wobble: 0.004 });
    let base = TG.fbm(n, { freq: 3.5, octaves: 6, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.07, freq: 2, seed: seed + 11 });
    const grit = TG.fbm(n, { freq: 26, octaves: 3, seed: seed + 2, ppc: 3 });
    const chisel = TG.ridged(n, { freq: 7, octaves: 4, seed: seed + 3, type: 'grad' });

    // a bead-and-fillet along both arrises of the tube
    const orn = F(n);
    for (const y of [n * 0.19, n * 0.81]) {
      TG.drawLine(orn, n, 0, y, n, y, Math.max(2, n * 0.011), 1.0, 1.2);
      TG.beadRow(orn, n, { y, count: 30, r: n * 0.010, value: 0.85 });
    }
    const ornS = TG.blurWrap(orn, n, Math.max(1, n * 0.003), 1);

    const h = combine(n, [[T.height, 0.50], [base, 0.24], [chisel, 0.10], [grit, 0.04]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.10 + ornS[i] * 0.22);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.28 + T.id[i] * 0.22 + T.lobe[i] * 0.24 + (base[i] - 0.5) * 0.46 + chisel[i] * 0.10 + grit[i] * 0.05;
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.36), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.6 + T.id[i] * 0.5 + T.lobe[i] * 0.32);
    paintValue(v, n, { rng, seed: seed + 5, temp, cavity: cav, cavityAmt: 0.36, edge, edgeAmt: 0.20,
      flowBase: 0.05, swirl: 0.5, light: [0.03, 0.13], dark: [-0.13, -0.03], highlight: 0.95 });
    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus', 'stone.tartarus.cool');
    TG.tintRGB(rgb, n, powField(T.seam, 1.2), C255(INK.deep), 0.80);
    const goldV = F(n);
    for (let i = 0; i < goldV.length; i++) goldV[i] = clamp01(0.34 + (base[i] - 0.5) * 0.26 + edge[i] * 0.34 - cav[i] * 0.52);
    TG.compositeRamp(rgb, n, powField(orn, 1.1), goldV, 'gold', 0.92);

    const rough = TG.artisticRoughness(n, {
      base: 0.86, height: h, cavity: cav, edge, polish: 0.18, dry: 0.18, variation: 0.14, seed: seed + 7, min: 0.34, max: 0.99,
    });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      const g = clamp01(orn[i] * 1.1);
      metal[i] = g * 0.85;
      rough[i] = clamp01(rough[i] * (1 - g) + (0.18 + 0.16 * clamp01(base[i])) * g);
    }
    return { rgb, height: h, rough, metal, normalScale: 0.85,
      params: { envMapIntensity: 0.55, emissive: 0x241238, emissiveIntensity: 0.18 },
      paint: { triplanar: false, macroStrength: 0.14, macroTint: '#7a4f58', rimStrength: 0.55 } };
  } },

  // ======================================================================
  // ASPHODEL — fractured obsidian with hot lava in the fissures
  // ======================================================================
  'stone.asphodel': { size: MID, build(n, rng, seed) {
    const frac = TG.cracks(n, {
      levels: [{ freq: 5, width: 0.10, weight: 1 }, { freq: 11, width: 0.065, weight: 0.72 }, { freq: 23, width: 0.04, weight: 0.4 }],
      seed, jitter: 0.95, warpAmp: 0.04,
    });
    const plate = TG.worleyField(n, { freq: 5, mode: 'cell', seed });
    const facet = TG.worleyField(n, { freq: 11, mode: 'f1', seed: seed + 2 });
    const base = warpLo(n, { freq: 4, octaves: 5, seed: seed + 3, type: 'grad' }, { amp: 0.06, freq: 3, seed: seed + 4 });

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.55 + (1 - facet[i]) * 0.28 + (base[i] - 0.5) * 0.30 - frac[i] * 0.55);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.007), 6);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.003), 8);

    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.30 + plate[i] * 0.18 + (base[i] - 0.5) * 0.55 + (1 - facet[i]) * 0.22;
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 3, octaves: 4, seed: seed + 6 }), -0.4), 2.1)), n >> 2);
    paintValue(v, n, { rng, seed: seed + 5, temp, cavity: cav, cavityAmt: 0.36, edge, edgeAmt: 0.36, flowBase: 1.1, swirl: 1.4, light: [0.02, 0.09], highlight: 1.1 });
    const rgb = TG.applyRamp2(v, temp, n, 'obsidian', 'obsidian.sheen');

    // lava in the seams: hot core, warm bleed on to the surrounding glass
    const hot = powField(frac, 1.35);
    const bleed = TG.blurWrap(hot, n, Math.max(2, n * 0.012), 2);
    const flick = TG.fbm(n, { freq: 7, octaves: 4, seed: seed + 8 });
    const heat = F(n);
    for (let i = 0; i < heat.length; i++) heat[i] = clamp01(hot[i] * (0.55 + 0.85 * flick[i]));
    TG.compositeRamp(rgb, n, scaleField(TG.copyField(bleed), 0.55), null, 'lava', 0.45);
    TG.compositeRamp(rgb, n, heat, clampField(biasField(scaleField(TG.copyField(flick), 0.5), 0.5)), 'lava', 1.0);

    const em = F(n);
    for (let i = 0; i < em.length; i++) em[i] = clamp01(heat[i] * 1.15 + bleed[i] * 0.30);
    const emissive = TG.applyRamp(em, n, 'lava');
    for (let i = 0; i < em.length; i++) {
      const k = Math.pow(em[i], 1.5), j = i * 3;
      emissive[j] *= k; emissive[j + 1] *= k; emissive[j + 2] *= k;
    }

    const rough = TG.artisticRoughness(n, { base: 0.34, height: h, cavity: cav, edge, polish: 0.26, dry: 0.42, variation: 0.16, seed: seed + 9, min: 0.06, max: 0.92 });
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 1.05, normalScale: 1.25,
      params: { envMapIntensity: 0.7 },
      paint: { triplanar: true, triScale: 0.24, macroTint: ASPHODEL.obsidianLight, variation: 0.12, variationTint: ASPHODEL.obsidianLight } };
  } },

  'floor.asphodel': { size: MID, build(n, rng, seed) {
    const frac = TG.cracks(n, { levels: [{ freq: 4, width: 0.085, weight: 1 }, { freq: 9, width: 0.05, weight: 0.6 }], seed, warpAmp: 0.05 });
    const plate = TG.worleyField(n, { freq: 4, mode: 'cell', seed });
    const shard = TG.worleyField(n, { freq: 9, mode: 'f1', seed: seed + 1 });
    const base = warpLo(n, { freq: 5, octaves: 5, seed: seed + 2 }, { amp: 0.06, freq: 3, seed: seed + 3 });
    const ash = warp1Lo(n, { freq: 7, octaves: 5, seed: seed + 4 }, { amp: 0.05, freq: 4, seed: seed + 5 });

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.58 + (1 - shard[i]) * 0.20 + (base[i] - 0.5) * 0.24 - frac[i] * 0.48);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.28 + plate[i] * 0.16 + (base[i] - 0.5) * 0.5 + (1 - shard[i]) * 0.16;
    const temp = clampField(scaleField(biasField(TG.copyField(ash), -0.38), 2.0));
    paintValue(v, n, { rng, seed: seed + 6, temp, cavity: cav, cavityAmt: 0.34, edge, edgeAmt: 0.28, flowBase: 0.5, swirl: 1.45, highlight: 0.9 });
    const rgb = TG.applyRamp2(v, temp, n, 'floor.asphodel', 'obsidian.sheen');
    // drifted ash
    const ashM = F(n);
    for (let i = 0; i < ashM.length; i++) ashM[i] = clamp01((ash[i] - 0.55) * 3.0) * (0.4 + cav[i] * 0.9);
    TG.compositeRamp(rgb, n, ashM, clampField(biasField(scaleField(TG.copyField(ash), 0.8), 0.1)), 'ash', 0.65);
    // molten seams
    const hot = powField(frac, 1.5);
    const bleed = TG.blurWrap(hot, n, Math.max(2, n * 0.014), 2);
    TG.compositeRamp(rgb, n, scaleField(TG.copyField(bleed), 0.5), null, 'lava', 0.4);
    TG.compositeRamp(rgb, n, hot, null, 'lava', 0.95);
    const em = F(n);
    for (let i = 0; i < em.length; i++) em[i] = clamp01(hot[i] * 1.1 + bleed[i] * 0.28);
    const emissive = TG.applyRamp(em, n, 'lava');
    for (let i = 0; i < em.length; i++) { const k = Math.pow(em[i], 1.5), j = i * 3; emissive[j] *= k; emissive[j + 1] *= k; emissive[j + 2] *= k; }

    const rough = TG.artisticRoughness(n, { base: 0.56, height: h, cavity: cav, edge, polish: 0.22, dry: 0.34, variation: 0.16, seed: seed + 8, min: 0.24, max: 0.96 });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] + ashM[i] * 0.35);
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 0.72, normalScale: 1.05,
      paint: { projection: 'planarY', triScale: 0.13, stochastic: 0.6, macroStrength: 0.45, macroTint: '#6a6688', detailStrength: 0.45, detailScale: 9 } };
  } },

  // ======================================================================
  // ELYSIUM — veined warm marble with gold leaf
  // ======================================================================
  'marble.elysium': { size: MID, build(n, rng, seed) {
    const veins = TG.veinNetwork(n, { count: 5, seed, len: 2.2, width: [0.9, 3.6], meander: 0.55, jitter: 0.045, branch: 0.005 });
    const veins2 = TG.veinNetwork(n, { count: 7, seed: seed + 1, len: 1.6, width: [0.5, 1.5], meander: 0.85, jitter: 0.06, branch: 0.008 });
    const gold = TG.veinNetwork(n, { count: 3, seed: seed + 2, len: 1.8, width: [0.5, 1.5], meander: 0.7, jitter: 0.05, branch: 0.012 });
    const grain = TG.fbm(n, { freq: 22, octaves: 3, seed: seed + 3, ppc: 3 });
    const cloud = warpLo(n, { freq: 3, octaves: 5, seed: seed + 4 }, { amp: 0.09, freq: 2, seed: seed + 5 });

    const vMask = F(n), gMask = F(n);
    for (let i = 0; i < vMask.length; i++) {
      vMask[i] = clamp01(veins[i]) * 0.85 + clamp01(veins2[i]) * 0.42;
      gMask[i] = clamp01(gold[i]) * clamp01((cloud[i] - 0.35) * 2.4);
    }
    // Every real marble vein carries a soft bruise of colour around it. Without
    // this halo the veins read as pencil lines drawn on paper.
    const halo = TG.blurWrap(vMask, n, Math.max(2, n * 0.014), 2);
    const halo2 = TG.blurWrap(vMask, n, Math.max(4, n * 0.045), 2);
    for (let i = 0; i < halo.length; i++) halo[i] = clamp01(halo[i] * 2.2 + halo2[i] * 3.4);

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.62 + (cloud[i] - 0.5) * 0.22 + grain[i] * 0.08 - vMask[i] * 0.10 + gMask[i] * 0.08);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 4);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.003), 6);

    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.56 + (cloud[i] - 0.5) * 0.60 + grain[i] * 0.11 - halo[i] * 0.16;
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 7 }), -0.42), 2.2)), n >> 2);
    paintValue(v, n, { rng, seed: seed + 6, temp, cavity: cav, cavityAmt: 0.18, edge, edgeAmt: 0.16, flowBase: 0.62, swirl: 1.15,
      light: [0.015, 0.06], dark: [-0.055, -0.012], highlight: 0.6 });
    const rgb = TG.applyRamp2(v, temp, n, 'marble.elysium', 'floor.elysium');
    TG.compositeRamp(rgb, n, scaleField(powField(halo, 1.25), 0.55), clampField(biasField(scaleField(TG.copyField(v), 0.6), 0.18)), 'marble.vein', 0.75);
    TG.compositeRamp(rgb, n, powField(vMask, 1.15), clampField(scaleField(TG.copyField(v), 0.55)), 'marble.vein', 0.88);
    // verdant moss creeping out of the deepest crevices — the Elysium accent
    const moss = F(n);
    for (let i = 0; i < moss.length; i++) moss[i] = clamp01((cav[i] - 0.35) * 2.2) * clamp01((cloud[i] - 0.45) * 3.0);
    TG.compositeRamp(rgb, n, moss, clampField(scaleField(TG.copyField(cloud), 1.1)), 'verdant', 0.5);
    // gold leaf
    TG.compositeRamp(rgb, n, powField(gMask, 0.8), clampField(biasField(scaleField(TG.copyField(grain), 0.4), 0.55)), 'gold', 0.95);

    const rough = TG.artisticRoughness(n, { base: 0.30, height: h, cavity: cav, edge, polish: 0.22, dry: 0.34, variation: 0.14, seed: seed + 8, min: 0.08, max: 0.85 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(gMask[i] * 0.8); rough[i] = clamp01(rough[i] * (1 - gMask[i] * 0.55) + moss[i] * 0.45); }
    // fake subsurface: a whisper of warm self-illumination in the clean stone
    const emissive = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
      const k = clamp01((1 - vMask[i]) * (0.35 + v[i] * 0.6)) * 0.9, j = i * 3;
      emissive[j] = 255 * k; emissive[j + 1] = 232 * k; emissive[j + 2] = 205 * k;
    }
    return { rgb, height: h, rough, metal, emissive, emissiveIntensity: 0.085, normalScale: 0.85,
      params: { envMapIntensity: 0.55 },
      paint: { triplanar: true, triScale: 0.20, macroTint: ELYSIUM.marbleLight, variation: 0.10, variationTint: ELYSIUM.marbleShadow } };
  } },

  'floor.elysium': { size: MID, build(n, rng, seed) {
    const T = TG.tileGrid(n, { cols: 4, rows: 4, pattern: 'grid', gap: 0.010, bevel: 0.014, rng, wobble: 0.004 });
    const veins = TG.veinNetwork(n, { count: 6, seed, len: 1.7, width: [0.6, 2.4], meander: 0.7, jitter: 0.05, branch: 0.007 });
    const cloud = warpLo(n, { freq: 4, octaves: 5, seed: seed + 1 }, { amp: 0.07, freq: 2, seed: seed + 2 });
    const grain = TG.fbm(n, { freq: 26, octaves: 3, seed: seed + 3, ppc: 3 });

    // gold inlay following the tile seams + a laurel band across the middle
    const inlay = F(n);
    for (let i = 0; i < inlay.length; i++) inlay[i] = clamp01((T.seam[i] - 0.30) * 2.2);
    const orn = F(n);
    TG.laurelBand(orn, n, { y: n * 0.5, leaves: 12, leafLen: n * 0.052, value: 1, lineW: Math.max(1.8, n * 0.004) });
    TG.beadRow(orn, n, { y: n * 0.5 - n * 0.105, count: 24, r: n * 0.0085, value: 0.95 });
    TG.beadRow(orn, n, { y: n * 0.5 + n * 0.105, count: 24, r: n * 0.0085, value: 0.95 });
    TG.meanderBand(orn, n, { y: n * 0.06, height: n * 0.085, cells: 5, lineW: Math.max(1.8, n * 0.0055), value: 0.9, rails: false, soft: n * 0.002 });

    const vM = F(n);
    for (let i = 0; i < vM.length; i++) vM[i] = clamp01(veins[i]) * 0.8;
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(T.height[i] * 0.55 + 0.30 + (cloud[i] - 0.5) * 0.16 + grain[i] * 0.06 - vM[i] * 0.05 + orn[i] * 0.10);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 4.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.003), 6);

    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.44 + T.id[i] * 0.07 + T.lobe[i] * 0.16 + (cloud[i] - 0.5) * 0.52 + grain[i] * 0.09;
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 5 }), -0.4), 2.0)), n >> 2);
    paintValue(v, n, { rng, seed: seed + 4, temp, cavity: cav, cavityAmt: 0.24, edge, edgeAmt: 0.16, flowBase: 1.0, swirl: 1.3,
      light: [0.015, 0.06], dark: [-0.06, -0.015], highlight: 0.7 });
    const rgb = TG.applyRamp2(v, temp, n, 'floor.elysium', 'marble.elysium');
    // warm the cream so it reads as sunlit stone, not bathroom tile
    TG.tintRGB(rgb, n, TG.mapField(TG.copyField(cloud), (x) => 0.30 + 0.35 * x), C255('#e8c98f'), 0.30);
    TG.compositeRamp(rgb, n, powField(vM, 1.2), clampField(scaleField(TG.copyField(v), 0.7)), 'marble.vein', 0.62);
    TG.tintRGB(rgb, n, powField(T.seam, 1.8), C255('#514a63'), 0.72);
    const goldV = F(n);
    for (let i = 0; i < goldV.length; i++) goldV[i] = clamp01(0.5 + (grain[i] - 0.5) * 0.6 + edge[i] * 0.4);
    TG.compositeRamp(rgb, n, inlay, goldV, 'gold', 0.9);
    TG.compositeRamp(rgb, n, powField(orn, 0.9), goldV, 'gold', 0.85);
    const moss = F(n);
    for (let i = 0; i < moss.length; i++) moss[i] = clamp01((T.seam[i] - 0.5) * 2.4) * clamp01((cloud[i] - 0.55) * 3.4);
    TG.compositeRamp(rgb, n, moss, clampField(scaleField(TG.copyField(cloud), 1.2)), 'verdant', 0.55);

    const rough = TG.artisticRoughness(n, { base: 0.48, height: h, cavity: cav, edge, polish: 0.18, dry: 0.30, variation: 0.14, seed: seed + 7, min: 0.22, max: 0.94 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      const g = clamp01(inlay[i] + orn[i]);
      metal[i] = clamp01(g * 0.85);
      rough[i] = clamp01(rough[i] * (1 - g * 0.6) + moss[i] * 0.4);
    }
    return { rgb, height: h, rough, metal, normalScale: 0.9,
      params: { envMapIntensity: 0.8 },
      paint: { projection: 'planarY', triScale: 0.13, stochastic: 0.58, macroStrength: 0.40, macroTint: '#8d86a4', detailStrength: 0.45, detailScale: 9 } };
  } },

  // ======================================================================
  // Obsidian — conchoidal fracture glass
  // ======================================================================
  obsidian: { size: BASE, build(n, rng, seed) {
    const facet = TG.worleyField(n, { freq: 8, mode: 'f1', seed, jitter: 1 });
    const facet2 = TG.worleyField(n, { freq: 17, mode: 'f1', seed: seed + 1, res: n >> 1 });
    const cell = TG.worleyField(n, { freq: 8, mode: 'cell', seed });
    const chip = TG.cracks(n, { levels: [{ freq: 14, width: 0.05, weight: 1 }], seed: seed + 2, warpAmp: 0.03 });
    const swirl = warpLo(n, { freq: 5, octaves: 4, seed: seed + 3, type: 'grad' }, { amp: 0.05, freq: 3, seed: seed + 4 });

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.42 + Math.pow(1 - facet[i], 0.65) * 0.52 + (1 - facet2[i]) * 0.12 + (swirl[i] - 0.5) * 0.10 - chip[i] * 0.30);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 8);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.24 + cell[i] * 0.20 + (1 - facet[i]) * 0.30 + (swirl[i] - 0.5) * 0.28;
    const temp = clampField(scaleField(biasField(TG.copyField(cell), -0.35), 1.8));
    paintValue(v, n, { rng, seed: seed + 5, temp, cavity: cav, cavityAmt: 0.30, edge, edgeAmt: 0.44, flowBase: 0.8, swirl: 1.5, light: [0.025, 0.10], highlight: 1.2 });
    const rgb = TG.applyRamp2(v, temp, n, 'obsidian', 'obsidian.sheen');
    TG.tintRGB(rgb, n, scaleField(powField(edge, 1.1), 0.6), C255('#7f9ecb'), 0.3);
    const rough = TG.artisticRoughness(n, { base: 0.22, height: h, cavity: cav, edge, polish: 0.16, dry: 0.5, variation: 0.13, seed: seed + 6, min: 0.04, max: 0.8 });
    return { rgb, height: h, rough, metal: 0.12, normalScale: 1.3,
      params: { envMapIntensity: 0.85 },
      paint: { triplanar: true, triScale: 0.35, macroTint: ASPHODEL.obsidianLight, variation: 0.14, variationTint: '#3d3a5c' } };
  } },

  // ======================================================================
  // Gold filigree — real ornament, not a gold cube
  // ======================================================================
  'gold.filigree': { size: MID, build(n, rng, seed) {
    const orn = F(n);
    // a composed band: meander top and bottom, guilloche core, beads, palmettes
    TG.meanderBand(orn, n, { y: n * 0.115, height: n * 0.145, cells: 6, lineW: Math.max(2, n * 0.0095), value: 1, soft: n * 0.0022 });
    TG.meanderBand(orn, n, { y: n * 0.885, height: n * 0.145, cells: 6, lineW: Math.max(2, n * 0.0095), value: 1, soft: n * 0.0022 });
    TG.guilloche(orn, n, { y: n * 0.5, amp: n * 0.052, cycles: 5, lineW: Math.max(2, n * 0.008), value: 0.92 });
    TG.beadRow(orn, n, { y: n * 0.285, count: 34, r: n * 0.0085, value: 0.85 });
    TG.beadRow(orn, n, { y: n * 0.715, count: 34, r: n * 0.0085, value: 0.85 });
    for (let k = 0; k < 3; k++) {
      TG.palmette(orn, n, { x: ((k + 0.5) / 3) * n, y: n * 0.375, r: n * 0.075, petals: 9, value: 0.95, lineW: Math.max(1.6, n * 0.0055) });
      TG.palmette(orn, n, { x: ((k + 1.0) / 3) * n, y: n * 0.625, r: n * 0.070, petals: 7, value: 0.9, lineW: Math.max(1.6, n * 0.005) });
    }
    const relief = TG.blurWrap(orn, n, Math.max(1, n * 0.0045), 1);
    const back = warpLo(n, { freq: 6, octaves: 5, seed }, { amp: 0.05, freq: 3, seed: seed + 1 });
    const hammer = TG.worleyField(n, { freq: 26, mode: 'f1', seed: seed + 2, res: n >> 1 });

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.22 + relief[i] * 0.75 + (back[i] - 0.5) * 0.16 + (1 - hammer[i]) * 0.10);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.009), 6);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.0035), 9);

    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.20 + relief[i] * 0.50 + (back[i] - 0.5) * 0.34 + edge[i] * 0.58 - cav[i] * 0.62);
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 4, octaves: 4, seed: seed + 4 }), -0.42), 2.0)), n >> 2);
    paintValue(v, n, { rng, seed: seed + 3, temp, edge, flowBase: 0.2, swirl: 0.9, light: [0.02, 0.08], dark: [-0.07, -0.015], highlight: 1.3 });
    const rgb = TG.applyRamp2(v, temp, n, 'gold', 'bronze');
    // tarnish and a breath of verdigris deep in the recesses — this is the
    // single detail that stops procedural gold looking like plastic
    const tarnish = F(n);
    for (let i = 0; i < tarnish.length; i++) tarnish[i] = clamp01(cav[i] * 1.35 * (0.35 + back[i]));
    TG.tintRGB(rgb, n, powField(tarnish, 1.4), C255('#20140a'), 0.62);
    const patina = F(n);
    for (let i = 0; i < patina.length; i++) patina[i] = clamp01((back[i] - 0.60) * 3.4) * tarnish[i];
    TG.compositeRamp(rgb, n, patina, clampField(scaleField(TG.copyField(back), 0.9)), 'verdigris', 0.55);

    const rough = TG.artisticRoughness(n, { base: 0.40, height: h, cavity: cav, edge, polish: 0.22, dry: 0.42, variation: 0.12, seed: seed + 5, min: 0.26, max: 0.88 });
    const metal = F(n);
    // Deliberately NOT 1.0: fully metallic gold has no diffuse term, so in a
    // dark room it reads as black chrome. Painted gold keeps a diffuse core.
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(0.72 - patina[i] * 0.66); rough[i] = clamp01(rough[i] + patina[i] * 0.35); }

    // §2 calls gold "the ornament spine of the whole game". A warm key times a
    // warm albedo lands metal gold at ~#ff7a30 — the brazier's hue — so the
    // filigree had no separation from the practicals. A self-lit gold core in
    // the AUTHORED hue (#f2c14e) anchors it: it survives the key, it sits about
    // one stop above the surrounding stone, and it stays under the bloom
    // threshold so it glows without fogging (§1.7).
    const emissive = TG.applyRamp(clampField(mapGold(relief, edge, cav)), n, 'gold');
    {
      const k = clampField(mapGold(relief, edge, cav));
      for (let i = 0; i < k.length; i++) {
        const g = Math.pow(k[i], 1.35), j = i * 3;
        emissive[j] *= g; emissive[j + 1] *= g * 0.95; emissive[j + 2] *= g * 0.78;
      }
    }
    return { rgb, height: h, rough, metal, normalScale: 1.5, emissive, emissiveIntensity: 0.50,
      params: { envMapIntensity: 0.75, emissive: 0x1a0f2c, emissiveIntensity: 0.16 },
      paint: { triplanar: false, macroStrength: 0.28, macroTint: GOLD.mid, rimStrength: 0.55 } };
  } },

  // Hammered gold LEAF — no meander, no guilloche. The filigree recipe is a
  // composed BAND; squeezing that band on to a 2.9 x 0.26 spoke turned it into
  // a stack of aliased stripes. Anything long and thin (inlay rings, medallion
  // spokes, an archivolt) gets this instead.
  'gold.leaf': { size: BASE, build(n, rng, seed) {
    const hammer = TG.worleyField(n, { freq: 13, mode: 'f1', seed, res: n >> 1 });
    const grain = warpLo(n, { freq: 5, octaves: 5, seed: seed + 1 }, { amp: 0.06, freq: 3, seed: seed + 2 });
    const scratch = TG.veinNetwork(n, { count: 5, seed: seed + 3, len: 1.5, width: [0.4, 1.2], meander: 0.9, jitter: 0.07, branch: 0.004 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.54 + (1 - hammer[i]) * 0.24 + (grain[i] - 0.5) * 0.26 - scratch[i] * 0.14);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.005), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.40 + (grain[i] - 0.5) * 0.34 + edge[i] * 0.34 - cav[i] * 0.52 - scratch[i] * 0.20);
    paintValue(v, n, { rng, seed: seed + 4, edge, flowBase: 0.4, swirl: 0.8, light: [0.02, 0.09], dark: [-0.08, -0.02], highlight: 1.1 });
    const rgb = TG.applyRamp(v, n, 'gold');
    const tarnish = F(n);
    for (let i = 0; i < tarnish.length; i++) tarnish[i] = clamp01(cav[i] * 1.2 * (0.30 + grain[i]));
    TG.tintRGB(rgb, n, powField(tarnish, 1.5), C255('#241608'), 0.55);
    const rough = TG.artisticRoughness(n, { base: 0.36, height: h, cavity: cav, edge, polish: 0.26, dry: 0.30, variation: 0.12, seed: seed + 5, min: 0.17, max: 0.84 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) metal[i] = 0.86;
    const em = F(n);
    for (let i = 0; i < em.length; i++) em[i] = clamp01(0.26 + edge[i] * 0.50 - cav[i] * 0.95);
    const emissive = TG.applyRamp(em, n, 'gold');
    // §1.5 gold "reaches near-white at the core and rolls off through #ffe9a8
    // into #c98f2b". Holding blue down at 0.58 forced every lit gold pixel to
    // the same saturated orange no matter how bright it got, so the ramp's top
    // two stops were unreachable. 0.80 lets the core go warm white while the
    // crevice keeps its #6d4416 bronze.
    for (let i = 0; i < em.length; i++) { const k = Math.pow(em[i], 1.5), j = i * 3; emissive[j] *= k; emissive[j + 1] *= k * 0.95; emissive[j + 2] *= k * 0.80; }
    // §1.5 gold filigree CATCHES light; it does not emit it. 16.4% of the
    // shipped floor frame had a channel pinned at 1.0 with a mean clipped
    // colour of (1.00, 0.68, 0.22) — every value above the ramp midpoint had
    // collapsed to one flat orange, so the bronze crevice, the body and the
    // #ffe9a8 highlight were all the same pixel. Emissive down, IBL up: the
    // specular now carries the read and the ramp survives to the display.
    return { rgb, height: h, rough, metal, normalScale: 0.9, emissive, emissiveIntensity: 0.60,
      params: { envMapIntensity: 0.70 },
      paint: { projection: 'triplanar', triScale: 0.55, triSharp: 5.0, macroStrength: 0.14, macroTint: GOLD.mid, rimStrength: 0.6 } };
  } },

  'bronze.verdigris': { size: BASE, build(n, rng, seed) {
    const hammer = TG.worleyField(n, { freq: 14, mode: 'f1', seed });
    const grain = warpLo(n, { freq: 6, octaves: 5, seed: seed + 1 }, { amp: 0.06, freq: 3, seed: seed + 2 });
    const blot = warpLo(n, { freq: 5, octaves: 6, seed: seed + 3 }, { amp: 0.10, freq: 3, seed: seed + 4 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.5 + (1 - hammer[i]) * 0.26 + (grain[i] - 0.5) * 0.3);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.005), 7);
    const patina = F(n);
    for (let i = 0; i < patina.length; i++) patina[i] = clamp01((blot[i] - 0.46) * 2.4 + cav[i] * 0.9 - edge[i] * 1.5) * clamp01(0.35 + blot[i] * 1.2);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.42 + (grain[i] - 0.5) * 0.5 + edge[i] * 0.42 - cav[i] * 0.3);
    paintValue(v, n, { rng, seed: seed + 5, edge, flowBase: 0.9, swirl: 1.1, light: [0.03, 0.12], dark: [-0.10, -0.02], highlight: 1.0 });
    const rgb = TG.applyRamp(v, n, 'bronze');
    TG.compositeRamp(rgb, n, powField(patina, 1.35), clampField(biasField(scaleField(TG.copyField(blot), 1.1), -0.05)), 'verdigris', 0.85);
    const rough = TG.artisticRoughness(n, { base: 0.52, height: h, cavity: cav, edge, polish: 0.26, dry: 0.36, variation: 0.16, seed: seed + 6, min: 0.22, max: 0.96 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(0.78 - patina[i] * 0.70); rough[i] = clamp01(rough[i] + patina[i] * 0.40); }
    return { rgb, height: h, rough, metal, normalScale: 1.2,
      params: { envMapIntensity: 1.0 }, paint: { triplanar: false, macroTint: GOLD.verdigris } };
  } },

  bone: { size: BASE, build(n, rng, seed) {
    const pore = powField(invField(TG.worleyField(n, { freq: 34, mode: 'f1', seed, res: n >> 1 })), 2.4);
    const crack = TG.veinNetwork(n, { count: 8, seed: seed + 1, len: 1.1, width: [0.5, 1.3], meander: 1.0, jitter: 0.09, branch: 0.014 });
    const grain = warpLo(n, { freq: 7, octaves: 5, seed: seed + 2 }, { amp: 0.055, freq: 3, seed: seed + 3 });
    const stria = TG.ridged(n, { freq: 5, octaves: 4, seed: seed + 4, type: 'grad' });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.62 + (grain[i] - 0.5) * 0.3 + stria[i] * 0.12 - pore[i] * 0.30 - crack[i] * 0.34);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.58 + (grain[i] - 0.5) * 0.42 + stria[i] * 0.12);
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 3, octaves: 4, seed: seed + 6 }), -0.42), 1.9)), n >> 2);
    paintValue(v, n, { rng, seed: seed + 5, temp, cavity: cav, cavityAmt: 0.34, edge, edgeAmt: 0.22, flowBase: 0.35, swirl: 1.1,
      light: [0.015, 0.07], dark: [-0.07, -0.015], highlight: 0.9 });
    const rgb = TG.applyRamp2(v, temp, n, 'bone', 'bone.cool');
    const grime = TG.dirtMask(h, n, { seed: seed + 7, cavity: cav, streak: 0.05 });
    TG.tintRGB(rgb, n, powField(grime, 2.0), C255('#6b4a24'), 0.38);
    TG.tintRGB(rgb, n, powField(crack, 1.1), C255('#4a3320'), 0.62);
    const rough = TG.artisticRoughness(n, { base: 0.66, height: h, cavity: cav, edge, polish: 0.24, dry: 0.28, variation: 0.16, seed: seed + 8, min: 0.22, max: 0.96 });
    return { rgb, height: h, rough, metal: 0.0, normalScale: 1.1, paint: { triplanar: false, macroTint: '#c9b894' } };
  } },

  // ======================================================================
  // Emissive / liquid
  // ======================================================================
  lava: { size: BASE, build(n, rng, seed) {
    const crust = TG.worleyField(n, { freq: 6, mode: 'f2f1', seed });
    const cell = TG.worleyField(n, { freq: 6, mode: 'cell', seed });
    const flow = warpLo(n, { freq: 4, octaves: 6, seed: seed + 1 }, { amp: 0.12, freq: 2, seed: seed + 2 });
    const fine = TG.cracks(n, { levels: [{ freq: 12, width: 0.07, weight: 1 }, { freq: 25, width: 0.045, weight: 0.6 }], seed: seed + 3, warpAmp: 0.06 });
    const hot = F(n);
    for (let i = 0; i < hot.length; i++) hot[i] = clamp01((1 - clamp01(crust[i] * 3.2)) * 0.85 + fine[i] * 0.75) * clamp01(0.35 + flow[i] * 1.3);
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.6 + cell[i] * 0.12 + (flow[i] - 0.5) * 0.3 - hot[i] * 0.42);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.10 + hot[i] * 0.92 + (flow[i] - 0.5) * 0.18 + cell[i] * 0.06);
    paintValue(v, n, { rng, seed: seed + 4, flowBase: 1.3, swirl: 1.4, count: Math.round(n * 0.9), light: [0.03, 0.14], dark: [-0.1, -0.02] });
    const rgb = TG.applyRamp(v, n, 'lava');
    const emissive = TG.applyRamp(v, n, 'lava');
    for (let i = 0; i < n * n; i++) {
      const k = Math.pow(clamp01(v[i]), 1.65), j = i * 3;
      emissive[j] *= k; emissive[j + 1] *= k; emissive[j + 2] *= k;
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6);
    const rough = TG.artisticRoughness(n, { base: 0.62, height: h, cavity: cav, edge, polish: 0.2, dry: 0.3, variation: 0.2, seed: seed + 5, min: 0.18, max: 0.95 });
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 8.0, normalScale: 0.9,
      animate: { scroll: [0.010, 0.006], pulse: 0.22 },
      paint: { triplanar: false, rimStrength: 0.12 } };
  } },

  'blood.pool': { size: BASE, build(n, rng, seed) {
    const swirl = warpLo(n, { freq: 3, octaves: 6, seed }, { amp: 0.14, freq: 2, seed: seed + 1 });
    const ripple = TG.ridged(n, { freq: 7, octaves: 4, seed: seed + 2, type: 'grad' });
    const skin = warp1Lo(n, { freq: 9, octaves: 4, seed: seed + 3 }, { amp: 0.06, freq: 4, seed: seed + 4 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.55 + (swirl[i] - 0.5) * 0.28 + ripple[i] * 0.14);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 4);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.005), 6);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.46 + (swirl[i] - 0.5) * 0.78 + edge[i] * 0.5 - cav[i] * 0.46);
    paintValue(v, n, { rng, seed: seed + 5, edge, edgeAmt: 0.3, flowBase: 1.6, swirl: 2.4,
      light: [0.03, 0.13], dark: [-0.12, -0.03], fine: [-0.008, 0.008], fineCount: 60, highlight: 0.5 });
    const rgb = TG.applyRamp(v, n, 'blood');
    // coagulated skin: duller, darker, slightly warm
    const skinM = F(n);
    for (let i = 0; i < skinM.length; i++) skinM[i] = clamp01((skin[i] - 0.58) * 3.2);
    TG.tintRGB(rgb, n, skinM, C255('#4a0a14'), 0.55);
    const rough = TG.artisticRoughness(n, { base: 0.14, height: h, cavity: cav, edge, polish: 0.1, dry: 0.5, variation: 0.1, seed: seed + 6, min: 0.04, max: 0.7 });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] + skinM[i] * 0.45);
    return { rgb, height: h, rough, metal: 0.0, normalScale: 0.7,
      params: { envMapIntensity: 1.2 },
      paint: { triplanar: false, rimStrength: 0.6, macroTint: TARTARUS.blood } };
  } },

  'water.styx': { size: BASE, build(n, rng, seed) {
    const a = warpLo(n, { freq: 5, octaves: 6, seed, type: 'grad' }, { amp: 0.09, freq: 3, seed: seed + 1 });
    const b = TG.warp(TG.ridged(n, { freq: 7, octaves: 5, seed: seed + 2, type: 'grad' }), n, { amp: 0.05, freq: 4, seed: seed + 22 });
    const swirl = warpLo(n, { freq: 2, octaves: 5, seed: seed + 3 }, { amp: 0.16, freq: 2, seed: seed + 4 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.5 + (a[i] - 0.5) * 0.5 + b[i] * 0.22 + (swirl[i] - 0.5) * 0.2);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 8);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.26 + (swirl[i] - 0.5) * 0.72 + b[i] * 0.40 + edge[i] * 0.62);
    paintValue(v, n, { rng, seed: seed + 5, flowBase: 0.2, swirl: 2.2, light: [0.03, 0.12], dark: [-0.1, -0.03], fine: [-0.008, 0.008], fineCount: 60 });
    const rgb = TG.applyRamp(v, n, 'water.styx');
    // drowned-soul glints — small violet sparks under the surface
    const glint = F(n);
    for (let i = 0; i < glint.length; i++) glint[i] = clamp01((b[i] - 0.72) * 7.0) * clamp01((swirl[i] - 0.35) * 2.8);
    TG.compositeRamp(rgb, n, glint, null, 'crystal.violet', 0.6);
    const emissive = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
      const k = Math.pow(clamp01(glint[i]), 1.2), j = i * 3;
      emissive[j] = 150 * k; emissive[j + 1] = 230 * k; emissive[j + 2] = 200 * k;
    }
    const rough = TG.artisticRoughness(n, { base: 0.10, height: h, edge, polish: 0.06, variation: 0.06, seed: seed + 6, min: 0.02, max: 0.4 });
    return { rgb, height: h, rough, metal: 0.10, emissive, emissiveIntensity: 1.4, normalScale: 0.55,
      params: { envMapIntensity: 1.25 },
      animate: { scroll: [0.014, -0.009], pulse: 0.12 },
      paint: { projection: 'planarY', triScale: 0.16, rimStrength: 0.85 } };
  } },

  'crystal.violet': { size: BASE, build(n, rng, seed) {
    const facet = TG.worleyField(n, { freq: 6, mode: 'f1', seed, jitter: 1 });
    const cell = TG.worleyField(n, { freq: 6, mode: 'cell', seed });
    const inner = warpLo(n, { freq: 4, octaves: 5, seed: seed + 1 }, { amp: 0.09, freq: 2, seed: seed + 2 });
    const flaw = TG.cracks(n, { levels: [{ freq: 10, width: 0.05, weight: 1 }], seed: seed + 3, warpAmp: 0.04 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.45 + (1 - facet[i]) * 0.5 + (inner[i] - 0.5) * 0.12 - flaw[i] * 0.22);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 8);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.18 + cell[i] * 0.16 + (1 - facet[i]) * 0.30 + inner[i] * 0.20 + edge[i] * 0.62);
    const temp = clampField(scaleField(biasField(TG.copyField(cell), -0.4), 1.6));
    paintValue(v, n, { rng, seed: seed + 4, temp, edge, edgeAmt: 0.34, flowBase: 0.9, swirl: 1.7,
      light: [0.04, 0.15], dark: [-0.09, -0.02], fine: [-0.02, 0.02], highlight: 1.2 });
    const rgb = TG.applyRamp(v, n, 'crystal.violet');
    const emissive = TG.applyRamp(v, n, 'crystal.violet');
    for (let i = 0; i < n * n; i++) {
      const k = Math.pow(clamp01(v[i] * 0.75 + inner[i] * 0.4), 2.0), j = i * 3;
      emissive[j] *= k; emissive[j + 1] *= k; emissive[j + 2] *= k;
    }
    const rough = TG.artisticRoughness(n, { base: 0.16, height: h, cavity: cav, edge, polish: 0.12, dry: 0.5, variation: 0.1, seed: seed + 5, min: 0.03, max: 0.7 });
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 20.0, normalScale: 1.35,
      params: { envMapIntensity: 1.4 },
      animate: { pulse: 0.3 },
      paint: { triplanar: false, rimStrength: 1.05, rimColor: '#c99cf2' } };
  } },

  // ======================================================================
  // Props
  // ======================================================================
  'banner.crimson': { size: BASE, build(n, rng, seed) {
    const w = TG.weave(n, { threads: Math.max(32, Math.round(n / 7)), seed });
    const fold = TG.fbm(n, { freq: 3, octaves: 3, seed: seed + 1, type: 'grad' });
    const wear = warpLo(n, { freq: 6, octaves: 5, seed: seed + 2 }, { amp: 0.06, freq: 3, seed: seed + 3 });
    // embroidered gold border + a meander hem
    const orn = F(n);
    TG.meanderBand(orn, n, { y: n * 0.90, height: n * 0.11, cells: 5, lineW: Math.max(1.6, n * 0.007), value: 1, rails: true, soft: n * 0.002 });
    TG.beadRow(orn, n, { y: n * 0.965, count: 30, r: n * 0.0065, value: 0.9 });
    for (let k = 0; k < 2; k++) TG.palmette(orn, n, { x: ((k + 0.5) / 2) * n, y: n * 0.42, r: n * 0.14, petals: 11, value: 0.95, lineW: Math.max(1.4, n * 0.005) });
    const ornS = TG.blurWrap(orn, n, Math.max(1, n * 0.004), 1);

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.42 + w[i] * 0.34 + (fold[i] - 0.5) * 0.30 + ornS[i] * 0.30);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.44 + (fold[i] - 0.5) * 0.62 + w[i] * 0.16 + (wear[i] - 0.5) * 0.22);
    paintValue(v, n, { rng, seed: seed + 4, cavity: cav, cavityAmt: 0.28, edge, edgeAmt: 0.18, flowBase: Math.PI / 2, swirl: 0.5,
      light: [0.025, 0.11], dark: [-0.10, -0.025], fine: [-0.02, 0.02], highlight: 0.5 });
    const rgb = TG.applyRamp(v, n, 'banner.crimson');
    const goldV = F(n);
    for (let i = 0; i < goldV.length; i++) goldV[i] = clamp01(0.48 + w[i] * 0.3 + edge[i] * 0.4 - cav[i] * 0.3);
    TG.compositeRamp(rgb, n, powField(orn, 0.9), goldV, 'gold', 0.92);
    // sun-bleached / dusty along the hanging edges
    TG.tintRGB(rgb, n, scaleField(powField(edge, 1.3), 0.45), C255('#e0a08e'), 0.22);
    const rough = TG.artisticRoughness(n, { base: 0.86, height: h, cavity: cav, edge, polish: 0.18, dry: 0.14, variation: 0.12, seed: seed + 5, min: 0.35, max: 0.99 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(orn[i] * 0.9); rough[i] = clamp01(rough[i] * (1 - orn[i] * 0.6)); }
    return { rgb, height: h, rough, metal, normalScale: 0.9,
      params: { side: DoubleSide }, paint: { triplanar: false, macroTint: '#8c1128' } };
  } },

  'wood.dark': { size: BASE, build(n, rng, seed) {
    const grain = TG.woodGrain(n, { rings: 22, seed, knots: 2 });
    const P = TG.tileGrid(n, { cols: 1, rows: 5, pattern: 'grid', gap: 0.012, bevel: 0.012, rng, wobble: 0.003 });
    const rough0 = TG.fbm(n, { freq: 18, octaves: 3, seed: seed + 1, ppc: 3 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(P.height[i] * 0.45 + 0.35 + grain[i] * 0.24 + rough0[i] * 0.07);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.34 + grain[i] * 0.40 + P.id[i] * 0.16 + rough0[i] * 0.08);
    paintValue(v, n, { rng, seed: seed + 2, cavity: cav, cavityAmt: 0.3, edge, edgeAmt: 0.24, flowBase: 0, swirl: 0.18,
      light: [0.02, 0.11], dark: [-0.1, -0.02], highlight: 0.8 });
    const rgb = TG.applyRamp(v, n, 'wood.dark');
    TG.tintRGB(rgb, n, powField(P.seam, 1.4), C255(INK.deep), 0.85);
    // iron nail heads at the plank ends
    const nails = F(n);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 2; c++) {
      TG.drawDisc(nails, n, (c ? 0.9 : 0.1) * n, ((r + 0.5) / 5) * n, Math.max(2, n * 0.012), 1, n * 0.006);
    }
    TG.compositeRamp(rgb, n, nails, clampField(biasField(scaleField(TG.copyField(rough0), 0.6), 0.35)), 'iron.dark', 0.9);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + nails[i] * 0.18);
    const rough = TG.artisticRoughness(n, { base: 0.78, height: h, cavity: cav, edge, polish: 0.26, dry: 0.2, variation: 0.16, seed: seed + 3, min: 0.24, max: 0.98 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(nails[i] * 0.85); rough[i] = clamp01(rough[i] * (1 - nails[i] * 0.4)); }
    return { rgb, height: h, rough, metal, normalScale: 1.0,
      params: { envMapIntensity: 0.6 }, paint: { triplanar: false, macroTint: '#3a2416' } };
  } },

  'iron.dark': { size: BASE, build(n, rng, seed) {
    const hammer = TG.worleyField(n, { freq: 11, mode: 'f1', seed });
    const pit = powField(invField(TG.worleyField(n, { freq: 30, mode: 'f1', seed: seed + 1, res: n >> 1 })), 2.6);
    const grain = warpLo(n, { freq: 7, octaves: 5, seed: seed + 2 }, { amp: 0.05, freq: 3, seed: seed + 3 });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.52 + (1 - hammer[i]) * 0.30 + (grain[i] - 0.5) * 0.26 - pit[i] * 0.22);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 8);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.40 + (grain[i] - 0.5) * 0.56 + edge[i] * 0.62 - cav[i] * 0.42);
    paintValue(v, n, { rng, seed: seed + 4, edge, flowBase: 0.5, swirl: 1.6, light: [0.03, 0.12], dark: [-0.09, -0.025], fine: [-0.035, 0.035], highlight: 0.8 });
    const rgb = TG.applyRamp(v, n, 'iron.dark');
    // rust weeping from the pits
    const rust = TG.dirtMask(h, n, { seed: seed + 5, cavity: cav, streak: 0.07, streakStrength: 0.9 });
    const rustM = F(n);
    for (let i = 0; i < rustM.length; i++) rustM[i] = clamp01(rust[i] * 1.3 * (0.4 + grain[i]));
    TG.compositeRamp(rgb, n, rustM, clampField(scaleField(TG.copyField(grain), 0.9)), 'bronze', 0.5);
    const rough = TG.artisticRoughness(n, { base: 0.55, height: h, cavity: cav, edge, polish: 0.28, dry: 0.32, variation: 0.16, seed: seed + 6, min: 0.20, max: 0.96 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(0.82 - rustM[i] * 0.62); rough[i] = clamp01(rough[i] + rustM[i] * 0.4); }
    return { rgb, height: h, rough, metal, normalScale: 1.15,
      params: { envMapIntensity: 0.85 }, paint: { triplanar: false, macroTint: '#332e3d' } };
  } },
};

// aliases the world/props might reasonably ask for
const ALIASES = {
  character: 'character.hero',
  'character.painterly': 'character.hero',
  'character.player': 'character.hero',
  'stone.elysium': 'marble.elysium',
  marble: 'marble.elysium',
  stone: 'stone.tartarus',
  gold: 'gold.filigree',
  bronze: 'bronze.verdigris',
  wood: 'wood.dark',
  iron: 'iron.dark',
  crystal: 'crystal.violet',
  water: 'water.styx',
  blood: 'blood.pool',
  banner: 'banner.crimson',
  floor: 'floor.tartarus',
};

/** Emergency maps if a recipe ever throws — still painted, never flat grey. */
function fallbackMaps(n, key) {
  const seed = TG.hashString(key) & 0xffff;
  const base = warpLo(n, { freq: 4, octaves: 5, seed }, { amp: 0.08, freq: 2, seed: seed + 1 });
  const rgb = TG.applyRamp(base, n, 'stone.tartarus');
  const rough = TG.artisticRoughness(n, { base: 0.75, height: base, variation: 0.2, seed });
  return { rgb, height: base, rough, metal: 0 };
}

// ---------------------------------------------------------------------------
// THE BAKE
// ---------------------------------------------------------------------------
/** Resolve a requested name to a recipe key, tolerating aliases and suffixes. */
export function resolveRecipe(name) {
  if (RECIPES[name]) return name;
  if (ALIASES[name] && RECIPES[ALIASES[name]]) return ALIASES[name];
  const parts = String(name || '').split('.');
  while (parts.length > 1) {
    parts.pop();
    const k = parts.join('.');
    if (RECIPES[k]) return k;
    if (ALIASES[k] && RECIPES[ALIASES[k]]) return ALIASES[k];
  }
  return null;
}

export function recipeSize(key) { return (RECIPES[key] && RECIPES[key].size) || BASE; }

/**
 * Run one recipe end to end and return ONLY transferable byte buffers plus
 * plain-data descriptors. Nothing THREE, nothing that needs structured-cloning
 * cleverness — so this is exactly what a Worker posts back.
 */
export function bakeSet(key, n) {
  const rec = RECIPES[key];
  if (!rec) return null;
  const seed = TG.hashString('erebus:' + key) & 0x7fffffff;
  const rng = TG.makeRng(seed ^ 0x5bf03635);
  let m;
  try {
    m = rec.build(n, rng, seed);
  } catch (e) {
    // never lose a surface to a recipe bug — still painted, never flat grey
    m = fallbackMaps(n, key);
    m.__error = (e && e.message) || String(e);
  }
  // AO FLOOR. At 0.20 the deepest point of every carved channel kept a fifth of
  // an ambient term that the rig had already clamped, i.e. essentially nothing,
  // and the review's verdict on the relief pass followed directly: "relief
  // renders as stencil line-art" — the undercut beside a chamfered arris was not
  // a dark INTERIOR, it was absence. An ambient-occlusion map is an ARTISTIC map
  // (§1.4), not a physical one; its job is to make a recess read as a recess,
  // and a recess still has colour in it.
  const ao = m.ao || TG.aoFromHeight(m.height, n, { strength: m.aoStrength ?? 1, floor: m.aoFloor ?? 0.28 });
  let rough = m.rough;
  if (m.height && rough && m.toksvig !== false) {
    try { rough = toksvig(rough, m.height, n, m.normalScale ?? 1); }
    catch (e) { /* never lose a material over an anti-shimmer pass */ }
  }
  return {
    name: key,
    size: n,
    map: TG.packRGB8(m.rgb, n),
    normalMap: TG.heightToNormal(m.height, n, m.normalScale ?? 1.0),
    ormMap: TG.packORM8(ao, rough, m.metal ?? 0, n),
    emissiveMap: m.emissive ? TG.packRGB8(m.emissive, n) : null,
    emissiveIntensity: m.emissiveIntensity ?? 0,
    params: m.params || {},
    paint: m.paint || {},
    animate: m.animate || null,
    error: m.__error || null,
  };
}

/** The ArrayBuffers in a bake result, for postMessage transfer. */
export function bakeTransferables(b) {
  const t = [b.map.buffer, b.normalMap.buffer, b.ormMap.buffer];
  if (b.emissiveMap) t.push(b.emissiveMap.buffer);
  return t;
}

export { RECIPES, ALIASES };
