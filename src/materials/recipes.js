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
 * Fold a brush-relief field into a height field: zero-mean so the block's
 * average level (and therefore its AO and its mean normal) does not move, and
 * scaled so the ridges are a fraction of the carved relief, never its rival.
 */
function addRelief(h, relief, n, amount = 0.12) {
  let mean = 0;
  for (let i = 0; i < relief.length; i++) mean += relief[i];
  mean /= relief.length;
  for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + (relief[i] - mean) * amount);
  return h;
}

/**
 * THREE-LAYER EMISSIVE (ART_DIRECTION §1.6 / §5): a near-white CORE that is
 * tiny, a saturated BODY in the material's own ramp, and a wide, soft, low
 * GLOW. Every glowing surface used to be `ramp(v) * v^k` — one layer, so the
 * hottest point and the halo were the same hue and the mask either bloomed as
 * a fog or read as a flat orange decal. `heat` is the 0..1 driver.
 */
function glowLayers(heat, n, o = {}) {
  const N = n * n;
  const ramp = o.ramp || 'lava';
  const coreC = o.core || [255, 240, 176];
  const coreGate = o.coreGate ?? 0.72;
  const bodyPow = o.bodyPow ?? 1.4;
  const glowR = Math.max(2, Math.round((o.glowRadius ?? 0.02) * n));
  const glowK = o.glow ?? 0.45;
  const body = TG.applyRamp(clampField(biasField(scaleField(TG.copyField(heat), o.bodyScale ?? 0.9), o.bodyBias ?? 0.05)), n, ramp);
  const halo = TG.blurWrap(heat, n, glowR, 2);
  const haloC = TG.applyRamp(clampField(scaleField(TG.copyField(halo), 0.55)), n, ramp);
  const out = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const hv = clamp01(heat[i]);
    const b = Math.pow(hv, bodyPow);
    const c = _ss(coreGate, 1.0, hv);
    const g = clamp01(halo[i]) * glowK * (1 - b);
    const j = i * 3;
    out[j] = body[j] * b + coreC[0] * c * (1 - b * 0.4) + haloC[j] * g;
    out[j + 1] = body[j + 1] * b + coreC[1] * c * (1 - b * 0.4) + haloC[j + 1] * g;
    out[j + 2] = body[j + 2] * b + coreC[2] * c * (1 - b * 0.4) + haloC[j + 2] * g;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i] > 255 ? 255 : out[i];
  return out;
}

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
  // per-stone tooling direction (radians) and a face mask that excludes the
  // joint AND the chamfer, so the brush engine can lay claw-chisel marks
  // across each flag along its own axis without ever crossing a joint
  const axisF = new Float32Array(n * n);
  const face = new Float32Array(n * n);
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
      axisF[i] = axis + rotV;
      face[i] = d <= 0 ? 0 : _ss(bevelPx * 1.2, bevelPx * 2.6, d);
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
  return { height, id, seam, joint, lobe, arris, rise, axis: axisF, face };
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
  // ── BRUSH RELIEF ──────────────────────────────────────────────────────────
  // A loaded stroke leaves a RIDGE, and the light catches it. Every recipe
  // used to paint strokes into value only, so the normal map — built from the
  // height field — knew nothing about them: the brushwork was a value grain
  // on a surface whose relief came from a different, noise-shaped field, and
  // the paint and the lighting disagreed. `relief` accumulates the same
  // strokes so the recipe can add them to its height field; the normal, AO
  // and roughness then carry the brushwork the albedo shows (§1.4, and the
  // brief's "lighting agrees with the paint").
  const relief = o.relief;
  if (relief) for (let i = 0; i < relief.length; i++) relief[i] += up[i] * (o.reliefBroad ?? 0.6);

  // --- a HUE glaze: the same brush, painted into the warm/cool selector ---
  // `tempAmt` scales it: on a dressed masonry face a full-strength hue glaze
  // swirls warm and cool INSIDE one block and the block reads as a marble
  // print; a wall wants most of its temperature to change at the joint.
  if (o.temp) {
    const ta = o.tempAmt ?? 1;
    const th = new Float32Array(lo * lo);
    TG.strokes(th, lo, {
      rng, flow: TG.flowField(lo, { base: (o.flowBase ?? 0.35) - 0.8, swirl: swirl * 1.1, freq: 2, seed: (o.seed ?? 3) + 313 }),
      count: Math.round(lo * 1.0), len: [lo * 0.09, lo * 0.34], width: [lo * 0.010, lo * 0.030],
      value: [0.10 * ta, 0.34 * ta], curl: 0.35, bristle: 0.35, taper: 1.5, softness: 1.6,
    });
    TG.strokes(th, lo, {
      rng, flow: TG.flowField(lo, { base: (o.flowBase ?? 0.35) + 1.1, swirl: swirl * 1.1, freq: 3, seed: (o.seed ?? 3) + 511 }),
      count: Math.round(lo * 0.7), len: [lo * 0.07, lo * 0.26], width: [lo * 0.008, lo * 0.024],
      value: [-0.34 * ta, -0.10 * ta], curl: 0.35, bristle: 0.35, taper: 1.5, softness: 1.6,
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
  if (relief) for (let i = 0; i < relief.length; i++) relief[i] += fine[i] * (o.reliefFine ?? 1.0);

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
// rig.js paints the roster's identity hue into VERTEX COLOUR and the albedo
// multiplies it, so these stay MODULATORS: their job is value and material,
// and the family hue stays with the rig.
//
// WHAT THEY WERE, AND WHY IT WAS THE WRONG READING OF "MODULATOR". Measured on
// the shipped bake at n=128:
//     characterrig.skin   mean sRGB (240.3, 229.2, 224.2) = linear (.875,.785,.747)
//     characterrig.cloth  mean sRGB (202.9, 199.5, 207.1), chroma spread 7.6 counts
// A mean of 240 is not a modulator, it is a white primer. Multiplying the
// authored #e8bd93 skin (linear .807/.509/.331) by it leaves .706/.400/.247 —
// 88% of the vertex value survives, so the texture removed no energy, added no
// colour and did no work at all beyond a faint grain. The hero therefore
// arrived at the tonemap 6.2 stops over AgX middle grey with nothing but vertex
// colour carrying it, and at that level the transform converges skin, gold and
// steel onto one cream (see materials/painterly.js CHARACTER_LOOK.hiKnee).
//
// The correction is NOT "make it dark" — §9.2 is still the one unforgivable
// error. It is:
//   1. bring the mean down to ~0.72 sRGB so the texture has somewhere to swing,
//   2. WIDEN the swing so a fold or a crevice is a real value break, and
//   3. on SKIN ONLY, let the ramp carry subdermal temperature. Flesh is the one
//      surface where "hue lives in the vertex colour" is wrong: skin is not a
//      tint of one colour, it is a warm mid over a red core, and a modulator
//      that goes to a deep brick at its low end is what puts blood in it.
//      The cloth and hair ramps stay near-neutral, as before.
// ---------------------------------------------------------------------------
const R_ = (t, c) => ({ t, c });
const SKIN_WARM = [R_(0, '#7d4234'), R_(0.28, '#b2705a'), R_(0.56, '#d29e83'), R_(0.80, '#e9c7ab'), R_(1, '#f9e6d4')];
const SKIN_COOL = [R_(0, '#6d3d43'), R_(0.30, '#9c6b6c'), R_(0.60, '#c09a99'), R_(0.85, '#dcc0bd'), R_(1, '#f1dfda')];
const CLOTH_N   = [R_(0, '#4b4048'), R_(0.26, '#786a72'), R_(0.55, '#a599a0'), R_(0.80, '#cfc4c9'), R_(1, '#f2edef')];
const CLOTH_C   = [R_(0, '#41424f'), R_(0.28, '#6c6f81'), R_(0.58, '#9899aa'), R_(0.82, '#c5c7d4'), R_(1, '#edeff6')];
const HAIR_R    = [R_(0, '#3d343b'), R_(0.30, '#665a61'), R_(0.62, '#918389'), R_(0.86, '#bdb0b5'), R_(1, '#e8dfe1')];
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
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.62 + (deep[i] - 0.5) * 0.46 + (fine[i] - 0.5) * 0.16 - cav[i] * 0.40 + edge[i] * 0.14);
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
      v[i] = 0.70 + (slub[i] - 0.5) * 0.58 + (wv[i] - 0.5) * 0.34 - cav[i] * 0.52 + edge[i] * 0.28;
    }
    const temp = TG.lowFreq(n, (r) => TG.fbm(r, { freq: 2.6, octaves: 4, seed: seed + 8 }), n >> 2);
    // HAND-PLACED HIGHLIGHT. highlight 1.2 is deliberately past the value used
    // on architecture: a garment is the one surface on a character allowed a
    // scrubbed, obviously-brushed top light.
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 9, temp, cavity: cav, cavityAmt: 0.30, edge, edgeAmt: 0.26, flowBase: 0.42, swirl: 2.6, flowFreq: 2.1, highlight: 1.20, relief });
    // the loaded strokes leave ridges in the nap, so the rim and the key
    // catch the brushwork on the garment instead of a bare weave
    addRelief(h, relief, n, 0.06);
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
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.54 + (comb[i] - 0.5) * 0.74 - cav[i] * 0.42 + edge[i] * 0.34);
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
    // ── CHISELLED ASHLAR, NOT MARBLED BRICK ──────────────────────────────
    // The previous bed was 3x2 blocks whose faces were a warped fBm — at
    // inspection range that is a marble swirl, and the critic's word for it
    // was "printed". A Greek wall block is DRESSED: a smooth drafted margin
    // around the edge, and inside it a face worked over with a claw chisel in
    // one direction per block (TG.ashlar now returns the margin, the face and
    // the per-block tool angle). Three columns per tile instead of two puts a
    // joint every ~2m at the wall's triScale, which is a block a mason could
    // lift, and it is one more block of tone variation per period.
    const A = TG.ashlar(n, { rows: 3, cols: 3, rng, mortar: 0.016, bevel: 0.055, wobble: 0.015, margin: 0.085, seed: seed + 5 });
    let base = TG.fbm(n, { freq: 3, octaves: 5, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.085, freq: 2, seed: seed + 11 });
    const grit = TG.fbm(n, { freq: 26, octaves: 3, seed: seed + 2, ppc: 3 });
    const chisel = TG.ridged(n, { freq: 9, octaves: 4, seed: seed + 3, type: 'grad' });
    // claw-chisel tooling: parallel tapered marks along each block's own
    // angle, confined to the face, so every block carries its own direction
    // and the margin around it stays smooth. curl 0: a tool mark does not bend
    // toward its neighbour's angle across a joint.
    const tool = F(n);
    TG.strokes(tool, n, {
      rng, flow: A.tool, mask: A.face, seedGrid: true,
      count: Math.round(n * 2.6), len: [n * 0.018, n * 0.062], width: [1.1, 2.6],
      value: [0.10, 0.24], curl: 0.0, wobble: 0.015, bristle: 0.65, taper: 1.3, softness: 0.95,
    });
    // a sparser second pass, crossing at a shallow angle — a claw is dragged
    // twice over a stubborn patch
    {
      const cross = new Float32Array(A.tool.length);
      for (let i = 0; i < cross.length; i++) cross[i] = A.tool[i] + 0.55;
      TG.strokes(tool, n, {
        rng, flow: cross, mask: A.face,
        count: Math.round(n * 0.7), len: [n * 0.012, n * 0.040], width: [0.7, 1.5],
        value: [0.05, 0.13], curl: 0.0, wobble: 0.02, bristle: 0.7, taper: 1.4, softness: 0.95,
      });
    }
    clampField(tool);

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
    // The engraved channel has a ROUNDED bottom (a V-cut with a worn arris),
    // not a flat trench: a wider blur with a soft power gives the cut a real
    // cross-section so the gold inlay sits IN the stone with a lit lip.
    const ornSoft = powField(TG.blurWrap(orn, n, Math.max(1, n * 0.0045), 1), 0.72);

    // ---- height ---------------------------------------------------------
    // The tooled face is PROUD of the drafted margin (rusticated blocks more
    // so — A.boss), the margin is flat, and the tool marks are relief on the
    // face. The warped fBm drops to a minor role: it is now the quarry's own
    // bedding drift, not the whole surface.
    const h = combine(n, [[A.height, 0.52], [base, 0.12], [chisel, 0.05], [grit, 0.03]]);
    for (let i = 0; i < h.length; i++) {
      const proud = A.face[i] * (0.05 + A.boss[i] * 0.09) + A.dome[i] * A.boss[i] * 0.10;
      h[i] = clamp01(h[i] + 0.10 + proud + tool[i] * 0.16 - pits[i] * 0.10 - chips[i] * 0.30 - ornSoft[i] * 0.32);
    }

    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    // ---- value + temperature -------------------------------------------
    // ── ROUND-4 (§1.4 "painted texture, not photo texture") ────────────────
    // The relief-inspection shot measured the wall field between the meander and
    // the egg-and-dart at p50 0.641 / p95 0.714 — a 0.07 display spread across
    // 400 screen pixels, i.e. a dead flat plane. Two causes, both fixed here and
    // in world/chamber.js:
    //  (a) EXPOSURE. The band sat on the AgX shoulder, which compresses any
    //      authored variation into nothing. That is the chamber's roleOpts cut.
    //  (b) FREQUENCY. Every value term in this recipe was either per-ashlar
    //      (A.id / A.lobe, one step per ~2m block) or grain (freq 22-40, sub-mm
    //      at inspection range). There was NOTHING at the scale a brush actually
    //      works at — a 20-60cm drift ACROSS a block face — so a single ashlar
    //      really was one value plus noise. `wash` is that missing octave: a
    //      warped 2-octave field at freq 7-9, which at triScale 0.165 lands at
    //      ~65cm, laid on at +-0.11. It is the difference between a wall that is
    //      textured and a wall that is painted.
    const wash = TG.warp2(TG.fbm(n, { freq: 7, octaves: 2, seed: seed + 61, type: 'value' }), n,
      { amp: 0.13, freq: 3, seed: seed + 62 });
    const wash2 = TG.fbm(n, { freq: 3.4, octaves: 2, seed: seed + 63, type: 'value' });
    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      // the tool marks are the face's value structure now: each mark is a lit
      // ridge, the drafted margin is a smooth, slightly paler dressed band,
      // and the warped fBm is a quiet quarry drift under both
      v[i] = 0.22 + A.id[i] * 0.30 + A.lobe[i] * 0.22 + (base[i] - 0.5) * 0.22 + grit[i] * 0.06
        + chisel[i] * 0.05 + tool[i] * 0.40 + A.margin[i] * 0.11 + A.dome[i] * A.boss[i] * 0.10
        - pits[i] * 0.18 + chips[i] * 0.16
        + (wash[i] - 0.5) * 0.18 + (wash2[i] - 0.5) * 0.12;
    }
    const temp = TG.lowFreq(n, (r) => {
      const t = TG.warp(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), r, { amp: 0.08, freq: 2, seed: seed + 32 });
      for (let i = 0; i < t.length; i++) t[i] = clamp01((t[i] - 0.35) * 1.9);
      return t;
    }, n >> 2);
    // each block gets its own warm/cool bias — quarried from a different bed —
    // and the bias is mostly PER BLOCK: a warm/cool field that swirls inside
    // one block is a marble print, a warm block beside a cool one is masonry
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.30 + A.id[i] * 0.62 + A.lobe[i] * 0.34 + 0.05);
    const relief = F(n);
    paintValue(v, n, { rng, seed, temp, tempAmt: 0.30, cavity: cav, cavityAmt: 0.34, edge, edgeAmt: 0.17, flowBase: 0.12, swirl: 1.9, highlight: 0.75, relief,
      light: [0.02, 0.08], dark: [-0.08, -0.02] });
    addRelief(h, relief, n, 0.09);

    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus', 'stone.tartarus.cool');

    // mortar seams sink into ink-plum, not grey
    TG.tintRGB(rgb, n, powField(A.mortar, 1.4), C255(INK.plum), 0.85);
    // blood grime weeping out of the crevices
    const grime = TG.dirtMask(h, n, { seed: seed + 44, cavity: cav, streak: 0.055, streakStrength: 0.7 });
    TG.tintRGB(rgb, n, powField(grime, 1.6), C255('#2a0a14'), 0.62);
    // §1.3 / §1.4 the hue split: every recess drifts toward the ink ramp and
    // every tool-mark crest and chamfer drifts warm, at unchanged value
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(INK.violet), warm: C255('#ff9a6a'), inkAmount: 0.50, warmAmount: 0.26 });
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

    // ROUGHNESS AS AN ARTISTIC MAP: the drafted margin is honed (it catches a
    // broad soft sheen), the tooled face is dry, the tool-mark crests polish
    // where hands and shoulders have rubbed them, and the mortar is dust.
    const rough = TG.artisticRoughness(n, {
      base: 0.84, height: h, cavity: cav, edge, polish: 0.26, dry: 0.24, variation: 0.22,
      seed: seed + 7, min: 0.34, max: 0.99,
      strokes: { count: Math.round(n * 0.45), flow: TG.flowField(n, { base: 0.15, swirl: 0.6, freq: 3, seed: seed + 8 }), value: [0.1, 0.35], len: [n * 0.04, n * 0.12], width: [1.4, 3.4], rng },
      strokeAmount: 0.22,
    });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] - A.margin[i] * 0.18 + A.face[i] * 0.05 - tool[i] * 0.12 + A.mortar[i] * 0.08);
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) { metal[i] = clamp01(orn[i] * 1.15); rough[i] = clamp01(rough[i] * (1 - orn[i] * 0.62)); }

    // ── THE UNDERCUT GETS THE INK RAMP, NOT ABSENCE (§2 shadow plum #241238) ──
    // The intent above this line was right and the implementation could not
    // deliver it. A FLAT emissive of #241238 at 0.18 is 0.003 scene-linear;
    // measured on the shipped relief frame the meander channels came back at
    // p05 0.007 DISPLAY, i.e. pure black — the ink floor was roughly an order of
    // magnitude too weak to be a floor at all, and the critic's verdict ("the
    // channels are pure #000 holes") was simply correct.
    // Raising the flat value is the wrong fix: a constant lifts the lit faces
    // too and mists the whole wall. So the floor becomes a MAP — the ink is
    // concentrated where the geometry is CUT (deep cavity, and the engraved
    // ornament channel itself) and falls to nothing on any face that can catch
    // the key. Where a channel receives no light this is now the difference
    // between a dark violet interior and a black line drawn on stone, which is
    // the whole difference between carving and stencil line-art.
    // Kept well under the bloom gate: at 0.62 the deepest sample is ~0.012
    // scene-linear, a §2 "deep shadow" value, not a glow.
    const inkC = C255(INK.plum);
    const emissive = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
      const cut = clamp01(cav[i] * 1.25 - 0.10) * clamp01(1.0 - edge[i] * 1.6);
      const kk = clamp01(cut * 0.85 + ornSoft[i] * 0.45);
      const j = i * 3;
      emissive[j] = inkC[0] * kk; emissive[j + 1] = inkC[1] * kk; emissive[j + 2] = inkC[2] * kk;
    }
    return { rgb, height: h, rough, metal, normalScale: 0.75, aoFloor: 0.34,
      emissive, emissiveIntensity: 0.62,
      // MACRO SCALE. 0.0135 is a period of ~74 METRES: on a 2m wall panel the
      // whole macro layer resolved to one constant, so the one term in the
      // shader that could have broken up a large flat face contributed nothing.
      // 0.075 puts the base octave at ~13m and its x3.1 octave at ~4.3m, which
      // is a drift the eye reads across a bay without ever closing into a tile.
      // macroRough / detailBump / detailRough: the relief shot measured the wall
      // field at rmsContrast 0.137 with the bays reading as flat panels, and the
      // macro layer was sampling vPaintWPos.xz on a VERTICAL surface, i.e. it was
      // constant up the whole bay. Triplanar macro sampling plus real micro-relief
      // is what puts weathering on a wall two metres from the camera.
      paint: { triplanar: true, triScale: 0.165, macroStrength: 0.40, macroDrift: 0.40, macroScale: 0.075, macroTint: '#6b4a58',
        macroRough: 0.24, detailBump: 0.62, detailRough: 0.30,
        variation: 0.30, variationTint: TARTARUS.stoneLight } };
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
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(INK.violet), warm: C255('#ff9a6a'), inkAmount: 0.45, warmAmount: 0.24 });

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

    // ── PER-STONE TOOLING ────────────────────────────────────────────────
    // Each flag is dressed with a claw chisel along its OWN axis (the same
    // axis its light/shade lobe uses), and the marks stop at the chamfer. The
    // previous floor had brushwork only as a global glaze across the whole
    // bed, so at the play camera every stone was the same speckle; a mason's
    // floor changes tool direction at every joint, and so does a painter's.
    const tool = F(n);
    TG.strokes(tool, n, {
      rng, flow: T.axis, mask: T.face, seedGrid: true,
      count: Math.round(n * 3.0), len: [n * 0.008, n * 0.030], width: [0.8, 1.9],
      value: [0.08, 0.20], curl: 0.0, wobble: 0.02, bristle: 0.7, taper: 1.3, softness: 0.95,
    });
    clampField(tool);
    // ── WEAR PATHS ───────────────────────────────────────────────────────
    // A warped low-frequency band across the bed: where feet have crossed for
    // an age the stone is polished paler and the tooling is rubbed down;
    // elsewhere it stays dry and dark. It is the one value structure on the
    // floor that belongs to NO stone and NO course, so it is also the one that
    // can never line up with the bond.
    const wearPath = TG.lowFreq(n, (r) => {
      const w = TG.warp2(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 81, type: 'grad' }), r, { amp: 0.16, freq: 2, seed: seed + 82 });
      for (let i = 0; i < w.length; i++) w[i] = clamp01((w[i] - 0.50) * 3.2);
      return w;
    }, n >> 2);
    for (let i = 0; i < tool.length; i++) tool[i] *= 1 - wearPath[i] * 0.55;

    const h = combine(n, [[T.height, 0.40], [base, 0.26], [grit, 0.07]]);
    // per-stone RISE: flags that sit proud and flags that have settled. Without
    // it a bed of chamfered stones is still one perfectly flat plane with lines
    // scored in it, and the normal map has nothing to model.
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.12 + T.rise[i] * 0.045 + tool[i] * 0.09 - fissure[i] * 0.34);
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
      // 0.32 -> 0.38, together with macroDrift 0.44 below. A dark stage has
      // less room for value, so the value it does have has to be spent on the
      // thing that reads — stone-to-stone contrast — rather than on level.
      // Measured: cutting the plate's exposure alone (macroLevel 0.52) took the
      // frame's rms contrast down 15%; this is where it comes back, as
      // STRUCTURE instead of exposure, and structure is also what decorrelates
      // the joint lattice §7 bans.
      v[i] = 0.26 + T.id[i] * 0.38 + T.lobe[i] * 0.24 + (base[i] - 0.5) * 0.44 + grit[i] * 0.05
           + T.arris[i] * 0.30 + tool[i] * 0.30 + wearPath[i] * 0.12;
    }
    // and the lit side of each stone is also the WARM side — colour variation
    // within the material, not a uniform tint over noise
    // the lit chamfer is also the WARM one, the shaded chamfer the cool one:
    // colour separation across a 3cm arris is what makes carved stone read
    // PER-STONE temperature at 0.34 made whole flagstones warm or cool, and
    // with the cool ramp's chroma restored (§15, palette.js) that read as pink
    // stones laid beside cyan ones — the "heat map" failure floor.tartarus.cool
    // already records, arriving this time through the SELECTOR rather than
    // through the ramp. 0.24 keeps stone-to-stone drift a glaze rather than a
    // two-tone bed while still decorrelating the joint lattice — measured, 0.16
    // gave back most of the anti-tiling win the rest of this pass had bought.
    // The lobe and arris terms vary WITHIN one stone and carry the painted read.
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] + T.lobe[i] * 0.30 + (T.id[i] - 0.5) * 0.24 + T.arris[i] * 0.26);
    // A floor is seen at a grazing angle across a whole screen: any high-frequency
    // value noise turns into shimmering mottle once bloom gets hold of it. Broad
    // glazes stay, the hatching goes quiet.
    // Peak stroke amplitude of 0.07 in a 0-1 value field does not survive a
    // tonemap: the measured within-tile value std was 0.079 and the only
    // structure reaching the screen was geometric (seams, bevels). Hades'
    // painted stone carries 0.25-0.40 of value swing inside ONE block. Shimmer
    // is a mip/roughness problem, not an amplitude problem — the raised detail
    // is fed through the toksvig bake below instead of being flattened here.
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 3, temp, cavity: cav, cavityAmt: 0.44, edge, edgeAmt: 0.11,
      flowBase: 0.9, swirl: 2.3, light: [0.055, 0.185], dark: [-0.170, -0.052], fine: [-0.034, 0.034], highlight: 0.75, relief });
    // the brush ridges go into the height too — modest, because a floor is
    // seen at a grazing angle and every ridge is a specular line waiting to
    // crawl; the toksvig bake widens the lobe over them
    addRelief(h, relief, n, 0.06);
    const rgb = TG.applyRamp2(v, temp, n, 'floor.tartarus', 'floor.tartarus.cool');
    // hue split (§1.3): the joints and every settled hollow toward the ink
    // ramp, the lit chamfers and the worn crowns warm
    {
      const lit = F(n);
      for (let i = 0; i < lit.length; i++) lit[i] = clamp01(edge[i] * 0.7 + Math.max(0, T.arris[i]) * 0.8 + wearPath[i] * 0.35);
      TG.inkAndWarm(rgb, n, cav, lit, { ink: C255(INK.violet), warm: C255('#ff9c70'), inkAmount: 0.45, warmAmount: 0.24 });
    }

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
    // The anti-shimmer note above is right about the CAUSE and wrong about the
    // cure: min 0.78 with variation 0.13 left the whole plate inside a 0.2-wide
    // roughness band, which is one substance from edge to edge, and §1.4 wants
    // roughness varying as an artistic map. Shimmer is answered by the toksvig
    // bake in bakeSet (which widens the lobe exactly where the normal is busy)
    // and by this surface's specGain of 0.16, not by flattening the map. A
    // wider band lets a worn crown polish up and a dusty hollow stay dry, so
    // the floor reads as laid stone with wear paths across it.
    const rough = TG.artisticRoughness(n, {
      base: 0.88, height: h, cavity: cav, edge, polish: 0.14, dry: 0.22, variation: 0.20, seed: seed + 9, min: 0.62, max: 0.99,
    });
    // the wear paths are where the flags have been polished by feet; the
    // tool marks are dry; the joints are dust
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] - stainM[i] * 0.25 - wearPath[i] * 0.22 + tool[i] * 0.06 + T.joint[i] * 0.06);
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
        // ── THESE THREE ARE DEAD. MEASURED, ROUND-5. ─────────────────────────
        // world/chamber.js builds the ground plane with an explicit
        // `floorResponse` of { litGain: 1.02, ambGain: 1.35, specGain: 0.26 }
        // for every non-Elysium biome, and MaterialLibrary._material() lets the
        // caller's opts win over the recipe's paint config. So nothing this
        // recipe writes here has reached the screen since that block was added:
        // a cut from 1.00 to 0.82 was built, captured and measured as a
        // BRIGHTER floor, which is how it was found. The numbers are left at
        // their authored values rather than deleted, because they are still what
        // this surface asks for if the world ever stops overriding them — but do
        // not tune the ground plane here. Reported to AGENT-WORLD.
        litGain: 1.00, ambGain: 0.58, specGain: 0.16,
        // ── THE ONE EXPOSURE LEVER src/materials/** ACTUALLY RETAINS ─────────
        // uMacroLevel is the macro layer's MEAN multiply. Every other surface
        // seeds it with the exact legacy constant so nothing moves (see
        // painterly.js MACRO_LEGACY_MEAN); the ground plane sets it explicitly,
        // because it is the only art-directed value control on the floor that
        // the world does not overwrite.
        //
        // Why it has to be this low. 05_floor shipped at groundP90 0.466 against
        // §9's 0.42 ceiling, i.e. the floor was already over the law before this
        // pass — and part of what was holding it down was an accident:
        // generated-textures.js was lerping 20% of the plate toward a
        // mean-rgb(30,22,24) atlas cell, so ~11% of the floor's darkness was a
        // side effect of the same bleach that was costing it all its colour.
        // Fixing the bleach handed that value straight back (measured
        // 0.466 -> 0.508). 0.52 is a 0.60x linear trim on the albedo, measured
        // to land groundLuma back at ~0.24 and P90 at ~0.43 — both better than
        // the figures this pass started from — and it is what drags the plate
        // off AgX's shoulder so the lit stone reads as blood-stone rather than
        // as the salmon-pink the first iteration produced. §9.1: the floor is a
        // DARK STAGE, and it is the stage that pays for the actors, not the
        // other way round.
        // Swept against the shot sheet: 0.87 measured groundP90 0.522 (over both
        // §9's 0.42 ceiling and the 0.466 this pass started from), 0.52 measured
        // 0.415 but cost 15% of the frame's rms contrast, 0.66 measured 0.487.
        // 0.57 lands P90 at ~0.45 and groundLuma at ~0.245 — at or under the
        // figures this pass inherited — with the contrast paid back below as
        // structure rather than as exposure.
        macroLevel: 0.57,
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
        // With the macro layer re-centred (see painterly.js) this is finally a
        // +-30% value drift about the surface's own mean instead of a 1% ripple
        // riding a 15% darkening, and it now has octaves at ~9m and ~3.4m as
        // well as the 80m one — the band where a 17.9m plate's repeat reads.
        macroStrength: 0.30, macroDrift: 0.44, macroScale: 0.0125, macroTint: '#4a2c38',
        macroRough: 0.26,
        // belt AND braces with the ground-plane veto in painterly.js: a floor is
        // never a silhouette, so it never carries the art-directed rim
        rimStrength: 0.10,
        // fine grain at a scale incommensurate with the bond: it decorrelates
        // the floor at SHORT lags, which is the half of the tiling test that
        // plate size alone cannot answer
        // brush-scale relief and dry/polished patches, both riding the detail
        // fetch the albedo already pays for. The floor's baked normal is
        // deliberately flat (normalScale 0.40, so the bevels do not strobe at a
        // grazing angle); the bump is added after that scale, which is what
        // gives the plate surface without giving the bevels teeth.
        // Raised with the macroLevel cut. The detail layer is mean-preserving by
        // construction, so its amplitude buys local contrast and short-lag
        // decorrelation without touching the ground plane's value at all — which
        // is exactly the trade a dark stage needs. At the play camera one detail
        // period is ~1.6m against a 192-texel tile, i.e. close to 1:1 with the
        // screen, so this is the ceiling before the grain starts to alias.
        detailStrength: 0.82, detailScale: 11, detailBump: 0.48, detailRough: 0.34 } };
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
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(INK.violet), warm: C255('#ff9a6a'), inkAmount: 0.40, warmAmount: 0.20 });

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
    // drums with a drafted band at each bed joint and a claw-tooled face that
    // runs UP the shaft (toolFlip off keeps every drum's tooling vertical)
    const A = TG.ashlar(n, { rows: 6, cols: 1, rng, mortar: 0.010, bevel: 0.04, wobble: 0.006, margin: 0.10, toolBase: 1.52, toolSpread: 0.10, toolFlip: false, seed: seed + 5 });
    let base = TG.fbm(n, { freq: 3, octaves: 6, seed, type: 'value' });
    base = TG.warp2(base, n, { amp: 0.06, freq: 2, seed: seed + 11 });
    const grit = TG.fbm(n, { freq: 24, octaves: 3, seed: seed + 2, ppc: 3 });
    // vertical tooling: a quarried shaft is dressed with a claw chisel that runs
    // WITH the axis, which is also what stops a cylinder reading as a smooth tube
    const chisel = TG.ridged(n, { freq: 3, octaves: 4, seed: seed + 3, type: 'grad' });
    const tool = F(n);
    TG.strokes(tool, n, {
      rng, flow: A.tool, mask: A.face, seedGrid: true,
      count: Math.round(n * 2.4), len: [n * 0.02, n * 0.075], width: [0.9, 2.2],
      value: [0.08, 0.20], curl: 0.0, wobble: 0.012, bristle: 0.7, taper: 1.3, softness: 0.95,
    });
    clampField(tool);
    const pitRaw = TG.worleyField(n, { freq: 20, mode: 'f1', seed: seed + 4, jitter: 1, res: n >> 1 });
    const pits = F(n);
    for (let i = 0; i < pits.length; i++) pits[i] = clamp01((0.085 - pitRaw[i]) * 9.0);

    const h = combine(n, [[A.height, 0.46], [base, 0.16], [chisel, 0.10], [grit, 0.04]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.12 + tool[i] * 0.12 + A.face[i] * 0.04 - pits[i] * 0.10);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.32 + A.id[i] * 0.20 + A.lobe[i] * 0.22 + (base[i] - 0.5) * 0.30 + chisel[i] * 0.09 + tool[i] * 0.34 + A.margin[i] * 0.09 + grit[i] * 0.06 - pits[i] * 0.16;
    }
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.40), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.40 + A.id[i] * 0.52 + A.lobe[i] * 0.30);
    // flowBase ~PI/2 = strokes run UP the shaft; swirl held right down so they
    // stay parallel instead of curling into the marble-print look
    const relief = F(n);
    paintValue(v, n, { rng, seed, temp, tempAmt: 0.35, cavity: cav, cavityAmt: 0.30, edge, edgeAmt: 0.20,
      flowBase: 1.52, swirl: 0.34, flowFreq: 1.1, light: [0.03, 0.12], dark: [-0.12, -0.03], highlight: 0.9, relief });
    addRelief(h, relief, n, 0.07);
    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus.column', 'stone.tartarus.column.cool');
    TG.tintRGB(rgb, n, powField(A.mortar, 1.3), C255(INK.plum), 0.78);
    const grime = TG.dirtMask(h, n, { seed: seed + 44, cavity: cav, streak: 0.09, streakStrength: 0.85 });
    TG.tintRGB(rgb, n, powField(grime, 1.8), C255('#2a1224'), 0.42);
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(INK.violet), warm: C255('#ffb08a'), inkAmount: 0.45, warmAmount: 0.24 });

    const rough = TG.artisticRoughness(n, {
      base: 0.80, height: h, cavity: cav, edge, polish: 0.24, dry: 0.20, variation: 0.14,
      seed: seed + 7, min: 0.36, max: 0.98,
    });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] - A.margin[i] * 0.16 - tool[i] * 0.10);
    return { rgb, height: h, rough, metal: 0.0, normalScale: 0.9,
      // §1.9 CYLINDRICAL, NOT TRIPLANAR. On a 5.4m fluted shaft the surface
      // normal is horizontal everywhere, so a triplanar blend runs entirely
      // between the X and Z projections and sweeps as the cylinder curves — the
      // ashlar bed gets dragged into continuous vertical bands that read as
      // stained plywood. Unwrapping the angle keeps the courses horizontal.
      paint: { projection: 'cylinderY', triScale: 0.42, circScale: 4.0,
        macroStrength: 0.20, macroDrift: 0.26, macroScale: 0.02, macroTint: '#7a5f63', macroRough: 0.22,
        // a claw-chiselled shaft is the one surface in the room the camera can
        // stand next to, and it carried no relief below drum scale at all
        detailBump: 0.58, detailRough: 0.28,
        variation: 0.16, variationTint: '#9a6a63' } };
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

    // a bead-and-fillet along both arrises of the tube, and an egg-and-dart
    // echinus down the archivolt face between them — one egg per voussoir, so
    // the ornament and the masonry agree on the rhythm
    const orn = F(n);
    for (const y of [n * 0.19, n * 0.81]) {
      TG.drawLine(orn, n, 0, y, n, y, Math.max(2, n * 0.011), 1.0, 1.2);
      TG.beadRow(orn, n, { y, count: 30, r: n * 0.010, value: 0.85 });
    }
    TG.eggAndDart(orn, n, { y: n * 0.5, height: n * 0.105, count: 15, value: 0.92, lineW: Math.max(1.6, n * 0.006), dome: 0.6, soft: 1.2, rails: false, eggW: 0.40, eggH: 0.40 });
    const ornS = powField(TG.blurWrap(orn, n, Math.max(1, n * 0.0035), 1), 0.8);
    // radial claw tooling on each wedge (the tube's v axis is the arch's
    // radial direction), stopping at the joints
    const tool = F(n);
    {
      const face = F(n);
      for (let i = 0; i < face.length; i++) face[i] = clamp01((1 - T.seam[i]) * 1.3 - 0.3) * clamp01(1 - orn[i] * 2.0);
      TG.strokes(tool, n, { rng, flow: 1.52, mask: face, seedGrid: true, count: Math.round(n * 2.2), len: [n * 0.02, n * 0.06], width: [0.9, 2.0], value: [0.08, 0.20], curl: 0, wobble: 0.015, bristle: 0.7, taper: 1.3, softness: 0.95 });
      clampField(tool);
    }

    const h = combine(n, [[T.height, 0.50], [base, 0.16], [chisel, 0.08], [grit, 0.04]]);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.10 + ornS[i] * 0.24 + tool[i] * 0.11);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 5.0);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6.5);

    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = 0.27 + T.id[i] * 0.22 + T.lobe[i] * 0.24 + (base[i] - 0.5) * 0.32 + chisel[i] * 0.08 + tool[i] * 0.34 + grit[i] * 0.05;
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.36), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.4 + T.id[i] * 0.55 + T.lobe[i] * 0.32);
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 5, temp, tempAmt: 0.35, cavity: cav, cavityAmt: 0.36, edge, edgeAmt: 0.20,
      flowBase: 0.05, swirl: 0.5, light: [0.03, 0.13], dark: [-0.13, -0.03], highlight: 0.95, relief });
    addRelief(h, relief, n, 0.06);
    const rgb = TG.applyRamp2(v, temp, n, 'stone.tartarus', 'stone.tartarus.cool');
    TG.tintRGB(rgb, n, powField(T.seam, 1.2), C255(INK.deep), 0.80);
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(INK.violet), warm: C255('#ff9a6a'), inkAmount: 0.45, warmAmount: 0.24 });
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

    // three-layer glow: white-hot thread down the deepest seam, saturated
    // lava body, soft halo bleeding on to the glass either side
    const emissive = glowLayers(heat, n, { ramp: 'lava', core: C255(ASPHODEL.lavaCore), coreGate: 0.74, bodyPow: 1.4, glowRadius: 0.014, glow: 0.42 });
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(ASPHODEL.obsidianDark), warm: C255('#8fb4ff'), inkAmount: 0.40, warmAmount: 0.24 });

    const rough = TG.artisticRoughness(n, { base: 0.34, height: h, cavity: cav, edge, polish: 0.26, dry: 0.42, variation: 0.16, seed: seed + 9, min: 0.06, max: 0.92 });
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 0.16, normalScale: 1.25,
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
    const emissive = glowLayers(hot, n, { ramp: 'lava', core: C255(ASPHODEL.lavaCore), coreGate: 0.76, bodyPow: 1.4, glowRadius: 0.016, glow: 0.40 });
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(ASPHODEL.obsidianDark), warm: C255('#c9b8a0'), inkAmount: 0.40, warmAmount: 0.18 });

    const rough = TG.artisticRoughness(n, { base: 0.56, height: h, cavity: cav, edge, polish: 0.22, dry: 0.34, variation: 0.16, seed: seed + 8, min: 0.24, max: 0.96 });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] + ashM[i] * 0.35);
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 0.18, normalScale: 1.05,
      paint: { projection: 'planarY', triScale: 0.13, stochastic: 0.6, macroStrength: 0.45, macroTint: '#6a6688', detailStrength: 0.45, detailScale: 9 } };
  } },

  // ======================================================================
  // ELYSIUM — veined warm marble with gold leaf
  // ======================================================================
  'marble.elysium': { size: MID, build(n, rng, seed) {
    // ── VEINS WITH A BODY, NOT PENCIL SCRIBBLE ───────────────────────────
    // Twelve thin veins at full opacity read as hair on paper. Real statuary
    // marble carries two or three MAJOR veins — soft-edged ribbons a few
    // centimetres wide with a darker thread down the middle and a bruise of
    // colour either side — plus a faint secondary web, plus broad cloudy
    // patches (breccia) where the stone itself changes colour. Three layers,
    // three opacities, and the halo does most of the work.
    const major = TG.veinNetwork(n, { count: 3, seed, len: 2.4, width: [2.0, 6.5], meander: 0.42, jitter: 0.03, branch: 0.004 });
    const minor = TG.veinNetwork(n, { count: 4, seed: seed + 1, len: 1.3, width: [0.5, 1.5], meander: 0.85, jitter: 0.06, branch: 0.008 });
    const gold = TG.veinNetwork(n, { count: 2, seed: seed + 2, len: 1.6, width: [0.5, 1.4], meander: 0.7, jitter: 0.05, branch: 0.012 });
    const grain = TG.fbm(n, { freq: 22, octaves: 3, seed: seed + 3, ppc: 3 });
    const cloud = warpLo(n, { freq: 3, octaves: 5, seed: seed + 4 }, { amp: 0.09, freq: 2, seed: seed + 5 });
    const breccia = warpLo(n, { freq: 2, octaves: 4, seed: seed + 14, type: 'grad' }, { amp: 0.15, freq: 2, seed: seed + 15 });
    // the vein body is a soft ribbon; the core is the drawn line itself
    const body = TG.blurWrap(major, n, Math.max(2, n * 0.009), 2);
    for (let i = 0; i < body.length; i++) body[i] = clamp01(body[i] * 2.4);
    const core = powField(clampField(TG.copyField(major)), 1.3);
    const vMask = F(n), gMask = F(n);
    for (let i = 0; i < vMask.length; i++) {
      vMask[i] = clamp01(body[i] * 0.85 + clamp01(minor[i]) * 0.32);
      gMask[i] = clamp01(gold[i]) * clamp01((cloud[i] - 0.35) * 2.4);
    }
    // Every real marble vein carries a soft bruise of colour around it. Without
    // this halo the veins read as pencil lines drawn on paper.
    const halo = TG.blurWrap(vMask, n, Math.max(2, n * 0.016), 2);
    const halo2 = TG.blurWrap(vMask, n, Math.max(4, n * 0.050), 2);
    for (let i = 0; i < halo.length; i++) halo[i] = clamp01(halo[i] * 2.0 + halo2[i] * 3.6);
    // the sculptor's dressing: fine parallel tooth-chisel marks in one slowly
    // turning direction, low in the height so the statue reads as CARVED
    // stone under the polish rather than as cast plastic
    const tooling = F(n);
    TG.strokes(tooling, n, {
      rng, flow: TG.flowField(n, { base: 1.15, swirl: 0.30, freq: 2, seed: seed + 21 }),
      count: Math.round(n * 1.6), len: [n * 0.012, n * 0.040], width: [0.6, 1.3],
      value: [0.04, 0.11], curl: 0.2, wobble: 0.02, bristle: 0.6, taper: 1.3, softness: 0.95,
    });
    clampField(tooling);

    const h = F(n);
    for (let i = 0; i < h.length; i++) {
      h[i] = clamp01(0.62 + (cloud[i] - 0.5) * 0.18 + grain[i] * 0.06 - body[i] * 0.06 - core[i] * 0.07 + gMask[i] * 0.07 + tooling[i] * 0.07);
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.008), 4);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.003), 6);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.58 + (cloud[i] - 0.5) * 0.44 + (breccia[i] - 0.5) * 0.30 + grain[i] * 0.09 - halo[i] * 0.14 - body[i] * 0.10 + tooling[i] * 0.10;
    }
    // warm cream where the breccia is clean, cool grey-violet where it clouds
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 7 }), -0.42), 2.2)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.40 + (0.54 - breccia[i]) * 1.3 + halo[i] * 0.25);
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 6, temp, cavity: cav, cavityAmt: 0.18, edge, edgeAmt: 0.16, flowBase: 0.62, swirl: 1.15,
      light: [0.015, 0.06], dark: [-0.055, -0.012], highlight: 0.6, relief });
    addRelief(h, relief, n, 0.05);
    const rgb = TG.applyRamp2(v, temp, n, 'marble.elysium', 'floor.elysium');
    TG.compositeRamp(rgb, n, scaleField(powField(halo, 1.25), 0.50), clampField(biasField(scaleField(TG.copyField(v), 0.6), 0.22)), 'marble.vein', 0.70);
    TG.compositeRamp(rgb, n, powField(vMask, 1.1), clampField(biasField(scaleField(TG.copyField(v), 0.55), 0.10)), 'marble.vein', 0.80);
    TG.compositeRamp(rgb, n, core, clampField(scaleField(TG.copyField(v), 0.30)), 'marble.vein', 0.85);
    // verdant moss creeping out of the deepest crevices — the Elysium accent
    const moss = F(n);
    for (let i = 0; i < moss.length; i++) moss[i] = clamp01((cav[i] - 0.35) * 2.2) * clamp01((cloud[i] - 0.45) * 3.0);
    TG.compositeRamp(rgb, n, moss, clampField(scaleField(TG.copyField(cloud), 1.1)), 'verdant', 0.5);
    // gold leaf
    TG.compositeRamp(rgb, n, powField(gMask, 0.8), clampField(biasField(scaleField(TG.copyField(grain), 0.4), 0.55)), 'gold', 0.95);
    // hue split: recesses to the marble-shadow violet, crowns to the key's cream
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#6d6383'), warm: C255(ELYSIUM.key), inkAmount: 0.40, warmAmount: 0.22 });

    // ROUGHNESS: polished body, calcite-filled veins glossier still, the tooth
    // marks dry, and a crystalline sparkle — tiny facets of the stone's own
    // grain that catch the key as pin-points, which is what makes marble read
    // as marble at a glance
    const rough = TG.artisticRoughness(n, { base: 0.30, height: h, cavity: cav, edge, polish: 0.22, dry: 0.34, variation: 0.14, seed: seed + 8, min: 0.08, max: 0.85 });
    const sparkle = powField(invField(TG.worleyField(n, { freq: 64, mode: 'f1', seed: seed + 9, res: n >> 1 })), 4.0);
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      metal[i] = clamp01(gMask[i] * 0.8);
      rough[i] = clamp01(rough[i] * (1 - gMask[i] * 0.55) + moss[i] * 0.45 - vMask[i] * 0.10 + tooling[i] * 0.12 - sparkle[i] * 0.30);
    }
    // fake subsurface: a whisper of warm self-illumination in the clean stone
    const emissive = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
      const k = clamp01((1 - vMask[i]) * (0.35 + v[i] * 0.6)) * 0.9, j = i * 3;
      emissive[j] = 255 * k; emissive[j + 1] = 232 * k; emissive[j + 2] = 205 * k;
    }
    // 0.085 was an emissive floor NO lighting cap could reach: statuary is built
    // from this recipe, and §14's subject test kept failing on a figure whose
    // brightness was partly self-illumination. A whisper is 0.03; 0.085 was a lamp.
    return { rgb, height: h, rough, metal, emissive, emissiveIntensity: 0.030, normalScale: 0.85,
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
    // egg-and-dart above the laurel, an astragal below it, a key at the edge
    TG.eggAndDart(orn, n, { y: n * 0.5 - n * 0.115, height: n * 0.062, count: 12, value: 0.95, lineW: Math.max(1.2, n * 0.0035), dome: 0.6, soft: 1.1, rails: false });
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
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#514a63'), warm: C255(ELYSIUM.key), inkAmount: 0.40, warmAmount: 0.22 });
    TG.compositeRamp(rgb, n, powField(vM, 1.2), clampField(scaleField(TG.copyField(v), 0.7)), 'marble.vein', 0.62);
    TG.tintRGB(rgb, n, powField(T.seam, 1.8), C255('#514a63'), 0.72);
    const goldV = F(n);
    for (let i = 0; i < goldV.length; i++) goldV[i] = clamp01(0.5 + (grain[i] - 0.5) * 0.6 + edge[i] * 0.4);
    TG.compositeRamp(rgb, n, inlay, goldV, 'gold', 0.9);
    TG.compositeRamp(rgb, n, powField(orn, 0.9), goldV, 'gold', 0.85);
    // Elysium's green is a MATERIAL family, not a post-process wash.  Growth
    // starts in tile joints, then blooms into a few broad, broken patches on
    // the damper cloud lobes.  This creates the same large color-block rhythm
    // as painted Hades environments while staying entirely inside the one
    // existing texture bake (no extra draw calls or texture allocation).
    const moss = F(n);
    for (let i = 0; i < moss.length; i++) {
      const joint = clamp01((T.seam[i] - 0.42) * 2.5);
      const field = clamp01((cloud[i] - 0.48) * 3.1)
        * clamp01(0.28 + cav[i] * 1.35 + (1 - T.lobe[i]) * 0.18);
      moss[i] = clamp01(Math.max(joint * (0.34 + cloud[i] * 0.72), field));
    }
    TG.compositeRamp(rgb, n, moss, clampField(scaleField(TG.copyField(cloud), 1.15)), 'verdant', 0.86);

    // Floor marble is honed and weathered rather than mirror-polished.  A
    // higher roughness floor prevents its dielectric lobe from rebuilding the
    // white pedestal that the darker albedo removes; gold inlay is explicitly
    // polished back below, so focal ornament still flashes.
    const rough = TG.artisticRoughness(n, { base: 0.62, height: h, cavity: cav, edge, polish: 0.12, dry: 0.36, variation: 0.16, seed: seed + 7, min: 0.34, max: 0.97 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      const g = clamp01(inlay[i] + orn[i]);
      metal[i] = clamp01(g * 0.85);
      rough[i] = clamp01(rough[i] * (1 - g * 0.6) + moss[i] * 0.52);
    }
    return { rgb, height: h, rough, metal, normalScale: 0.9,
      params: { envMapIntensity: 0.8 },
      paint: { projection: 'planarY', triScale: 0.13, stochastic: 0.58, macroStrength: 0.40, macroTint: '#8d86a4', detailStrength: 0.45, detailScale: 9 } };
  } },

  // ======================================================================
  // Obsidian — conchoidal fracture glass
  // ======================================================================
  obsidian: { size: BASE, build(n, rng, seed) {
    // ── CONCHOIDAL, NOT HONEYCOMB ────────────────────────────────────────
    // A Worley bowl per cell gave a wall of chicken-wire: every plate a smooth
    // dimple, every boundary a bright line. Knapped glass breaks into shallow
    // SHELLS with ripple rings radiating from the blow, meeting at razor
    // arrises, and some plates flake again into smaller shells. TG.conchoidal
    // returns the shell, its rings and its arris from one lattice.
    const K = TG.conchoidal(n, { freq: 7, seed, rings: 4.5, warp: 0.55, arrisWidth: 0.05 });
    const K2 = TG.conchoidal(n, { freq: 15, seed: seed + 1, rings: 3, warp: 0.45, arrisWidth: 0.07, res: n >> 1 });
    // the rings fade toward the arris and are strongest near the blow: a
    // fingerprint-even ring field is the one thing that does not read as glass
    for (let i = 0; i < K.ripple.length; i++) { K.ripple[i] *= Math.pow(K.facet[i], 1.2); K2.ripple[i] *= Math.pow(K2.facet[i], 1.2); }
    const chip = TG.cracks(n, { levels: [{ freq: 14, width: 0.05, weight: 1 }], seed: seed + 2, warpAmp: 0.03 });
    // flow banding in the glass: the volcanic swirl a polished face shows
    const swirl = warpLo(n, { freq: 5, octaves: 4, seed: seed + 3, type: 'grad' }, { amp: 0.05, freq: 3, seed: seed + 4 });
    // which plates flake a second time
    const sub = F(n);
    for (let i = 0; i < sub.length; i++) sub[i] = clamp01((K.id[i] - 0.45) * 3.0);

    const h = F(n);
    for (let i = 0; i < h.length; i++) {
      const shell = Math.pow(K.facet[i], 0.72);
      h[i] = clamp01(0.36 + shell * 0.44 + K.ripple[i] * 0.045 * (1 - K.arris[i])
        + sub[i] * (K2.facet[i] * 0.14 + K2.ripple[i] * 0.025) - K.arris[i] * 0.08
        - chip[i] * 0.24 + (swirl[i] - 0.5) * 0.06);
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.003), 9);
    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = 0.18 + K.id[i] * 0.24 + K.facet[i] * 0.14 + K.ripple[i] * 0.07 * (1 - K.arris[i]) + edge[i] * 0.50
        + K.arris[i] * 0.12 + (swirl[i] - 0.5) * 0.20 - chip[i] * 0.20 + sub[i] * K2.ripple[i] * 0.04;
    }
    // per-plate temperature: some plates carry the steel-blue sheen, most
    // stay violet-black, and the flow banding drifts it within a plate
    const temp = F(n);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(K.id[i] * 1.25 - 0.28 + (swirl[i] - 0.5) * 0.5);
    paintValue(v, n, { rng, seed: seed + 5, temp, cavity: cav, cavityAmt: 0.30, edge, edgeAmt: 0.40, flowBase: 0.8, swirl: 1.5,
      light: [0.02, 0.08], dark: [-0.07, -0.02], fine: [-0.03, 0.03], highlight: 1.2 });
    const rgb = TG.applyRamp2(v, temp, n, 'obsidian', 'obsidian.sheen');
    // the arris catches a cold glint; the ring crests a fainter one
    TG.tintRGB(rgb, n, scaleField(powField(edge, 1.1), 0.6), C255('#9fbde8'), 0.34);
    TG.tintRGB(rgb, n, scaleField(powField(K.arris, 1.4), 0.5), C255('#7f9ecb'), 0.30);
    // shadow is blue-black glass, never grey; the lit shell drifts to the sheen
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#0d0b18'), warm: C255('#8fb4ff'), inkAmount: 0.45, warmAmount: 0.30 });
    // ROUGHNESS: glass. The shells are mirror-polished, the arrises and chips
    // are frosted where they have been struck, and the flow bands dull it.
    const rough = TG.artisticRoughness(n, { base: 0.22, height: h, cavity: cav, edge, polish: 0.16, dry: 0.5, variation: 0.13, seed: seed + 6, min: 0.04, max: 0.8 });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] * 0.55 + 0.06 + chip[i] * 0.45 + K.arris[i] * 0.22 + (1 - K.facet[i]) * 0.08);
    return { rgb, height: h, rough, metal: 0.12, normalScale: 1.3,
      params: { envMapIntensity: 0.85 },
      paint: { triplanar: true, triScale: 0.35, macroTint: ASPHODEL.obsidianLight, variation: 0.14, variationTint: '#3d3a5c' } };
  } },

  // ======================================================================
  // Gold filigree — real ornament, not a gold cube
  // ======================================================================
  'gold.filigree': { size: MID, build(n, rng, seed) {
    // ── CHASED RELIEF, NOT WIRE ON BROWN ─────────────────────────────────
    // The previous band drew every motif as a 1-2px line and blurred it by a
    // texel: at inspection range that is gold WIRE glued to a flat plaque, and
    // the critic read it as line art. Repoussé ornament is a RAISED BAND with
    // a half-round section standing on a MATTED ground — the goldsmith
    // punches the background with a ring punch and cross-hatches it so the
    // polished relief stands out against a dry, dark field. Three things
    // follow: the strokes are 40% fatter, the relief is a wide blur with a
    // soft power (a rounded crown, not a plateau), and the ground carries its
    // own punch + hatch texture in both height and roughness.
    const orn = F(n);
    const lw = Math.max(2.4, n * 0.0135);
    TG.meanderBand(orn, n, { y: n * 0.115, height: n * 0.145, cells: 6, lineW: lw, value: 1, soft: n * 0.0025 });
    TG.meanderBand(orn, n, { y: n * 0.885, height: n * 0.145, cells: 6, lineW: lw, value: 1, soft: n * 0.0025 });
    TG.guilloche(orn, n, { y: n * 0.5, amp: n * 0.052, cycles: 5, lineW: lw * 0.85, value: 0.94 });
    // egg-and-dart on the upper astragal line, beads on the lower one
    TG.eggAndDart(orn, n, { y: n * 0.285, height: n * 0.078, count: 14, value: 0.96, lineW: lw * 0.5, dome: 0.62, soft: 1.2 });
    TG.beadRow(orn, n, { y: n * 0.715, count: 34, r: n * 0.0095, value: 0.88 });
    for (let k = 0; k < 3; k++) {
      TG.palmette(orn, n, { x: ((k + 0.5) / 3) * n, y: n * 0.375, r: n * 0.075, petals: 9, value: 0.95, lineW: lw * 0.55 });
      TG.palmette(orn, n, { x: ((k + 1.0) / 3) * n, y: n * 0.625, r: n * 0.070, petals: 7, value: 0.9, lineW: lw * 0.5 });
    }
    // the half-round section: a wide soft blur, opened up with a power so the
    // band has a rounded crown and a fillet at its foot; `crest` is the very
    // top of the round where the burnisher touched it
    const relief = powField(TG.blurWrap(orn, n, Math.max(1.5, n * 0.0055), 2), 0.62);
    const crest = powField(TG.blurWrap(orn, n, Math.max(1, n * 0.0018), 1), 1.5);
    const ground = F(n);
    for (let i = 0; i < ground.length; i++) ground[i] = clamp01(1 - relief[i] * 1.6);
    const back = warpLo(n, { freq: 6, octaves: 5, seed }, { amp: 0.05, freq: 3, seed: seed + 1 });
    // MATTING: a ring punch (small inverted worley domes) and a fine cross
    // hatch, both confined to the ground
    const punch = powField(invField(TG.worleyField(n, { freq: 44, mode: 'f1', seed: seed + 2, res: n >> 1 })), 1.6);
    const hatch = F(n);
    TG.strokes(hatch, n, { rng, flow: 0.72, mask: ground, count: Math.round(n * 3.2), len: [n * 0.010, n * 0.030], width: [0.6, 1.2], value: [0.10, 0.22], curl: 0, wobble: 0.01, bristle: 0.5, taper: 1.2, softness: 0.9 });
    TG.strokes(hatch, n, { rng, flow: 0.72 + Math.PI * 0.5, mask: ground, count: Math.round(n * 2.4), len: [n * 0.010, n * 0.028], width: [0.6, 1.2], value: [0.08, 0.18], curl: 0, wobble: 0.01, bristle: 0.5, taper: 1.2, softness: 0.9 });
    clampField(hatch);
    // planished bench marks on the raised metal itself: a burnish direction
    const burnish = F(n);
    TG.strokes(burnish, n, { rng, flow: 0.15, mask: relief, count: Math.round(n * 1.4), len: [n * 0.012, n * 0.045], width: [0.7, 1.6], value: [-0.10, 0.12], curl: 0, wobble: 0.02, bristle: 0.75, taper: 1.8, softness: 1.1 });

    const h = F(n);
    for (let i = 0; i < h.length; i++) {
      h[i] = clamp01(0.20 + relief[i] * 0.60 + crest[i] * 0.10 + (back[i] - 0.5) * 0.10
        + ground[i] * (punch[i] * 0.09 + hatch[i] * 0.05) + burnish[i] * 0.03);
    }
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.009), 6);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.0035), 9);

    const v = F(n);
    for (let i = 0; i < v.length; i++) {
      v[i] = clamp01(0.16 + relief[i] * 0.42 + crest[i] * 0.18 + (back[i] - 0.5) * 0.26 + edge[i] * 0.52 - cav[i] * 0.62
        + ground[i] * (hatch[i] * 0.10 - punch[i] * 0.10) + burnish[i] * 0.10);
    }
    // the raised metal reads GOLD, the matted ground reads BRONZE
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 4, octaves: 4, seed: seed + 4 }), -0.42), 2.0)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.35 + ground[i] * 0.62);
    paintValue(v, n, { rng, seed: seed + 3, temp, edge, flowBase: 0.2, swirl: 0.9, light: [0.02, 0.08], dark: [-0.07, -0.015], highlight: 1.3 });
    const rgb = TG.applyRamp2(v, temp, n, 'gold', 'bronze');
    // tarnish and a breath of verdigris deep in the recesses — this is the
    // single detail that stops procedural gold looking like plastic
    const tarnish = F(n);
    for (let i = 0; i < tarnish.length; i++) tarnish[i] = clamp01(cav[i] * 1.35 * (0.35 + back[i]) + ground[i] * 0.22);
    TG.tintRGB(rgb, n, powField(tarnish, 1.4), C255('#20140a'), 0.62);
    const patina = F(n);
    for (let i = 0; i < patina.length; i++) patina[i] = clamp01((back[i] - 0.60) * 3.4) * tarnish[i];
    TG.compositeRamp(rgb, n, patina, clampField(scaleField(TG.copyField(back), 0.9)), 'verdigris', 0.55);
    // the shadow side of every bead and every meander channel goes to the
    // bronze shadow hue; the crests go to the pale gold highlight
    TG.inkAndWarm(rgb, n, cav, crest, { ink: C255('#4a2a12'), warm: C255(GOLD.highlight), inkAmount: 0.55, warmAmount: 0.40 });

    // ROUGHNESS: burnished crowns, dry matted ground, dust in the undercut
    const rough = TG.artisticRoughness(n, { base: 0.42, height: h, cavity: cav, edge, polish: 0.22, dry: 0.40, variation: 0.12, seed: seed + 5, min: 0.20, max: 0.90 });
    const metal = F(n);
    // Deliberately NOT 1.0: fully metallic gold has no diffuse term, so in a
    // dark room it reads as black chrome. Painted gold keeps a diffuse core.
    for (let i = 0; i < metal.length; i++) {
      metal[i] = clamp01(0.74 - patina[i] * 0.66 - ground[i] * 0.10);
      rough[i] = clamp01(rough[i] + patina[i] * 0.35 - crest[i] * 0.20 + ground[i] * 0.18);
    }

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
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#4a2a12'), warm: C255(GOLD.highlight), inkAmount: 0.50, warmAmount: 0.36 });
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
    // ── PLANISHED, WEEPING BRONZE ────────────────────────────────────────
    // Hammered bronze is a field of shallow FACETS meeting at soft arrises
    // (the planishing hammer leaves flats, not dimples), burnished in one
    // direction, with verdigris growing out of every recess and DRIPPING down
    // the form. The brazier bowls stand inside their own practical, so this
    // is the metal the player sees lit from below every frame.
    const K = TG.conchoidal(n, { freq: 12, seed, rings: 1.2, warp: 0.5, arrisWidth: 0.22, res: n >> 1 });
    const hammer = K.facet, arris = K.arris;
    // a planishing hammer leaves SHALLOW flats: soften the facet so the field
    // reads as beaten metal rather than as a honeycomb of cells
    for (let i = 0; i < hammer.length; i++) { hammer[i] = Math.pow(hammer[i], 0.55); arris[i] *= 0.55; }
    const grain = warpLo(n, { freq: 6, octaves: 5, seed: seed + 1 }, { amp: 0.06, freq: 3, seed: seed + 2 });
    const blot = warpLo(n, { freq: 5, octaves: 6, seed: seed + 3 }, { amp: 0.10, freq: 3, seed: seed + 4 });
    const burnish = F(n);
    TG.strokes(burnish, n, {
      rng, flow: TG.flowField(n, { base: 0.9, swirl: 0.35, freq: 2, seed: seed + 21 }),
      count: Math.round(n * 1.8), len: [n * 0.02, n * 0.07], width: [0.7, 1.7],
      value: [-0.08, 0.14], curl: 0.2, wobble: 0.02, bristle: 0.75, taper: 1.7, softness: 1.1,
    });
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.48 + hammer[i] * 0.16 + (grain[i] - 0.5) * 0.30 - arris[i] * 0.04 + burnish[i] * 0.05);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.005), 7);
    const patina = F(n);
    for (let i = 0; i < patina.length; i++) patina[i] = clamp01((blot[i] - 0.46) * 2.4 + cav[i] * 0.9 - edge[i] * 1.5) * clamp01(0.35 + blot[i] * 1.2);
    // the drips: verdigris streaked DOWN the form from every patch
    const drip = TG.dirtMask(h, n, { seed: seed + 31, cavity: patina, streak: 0.11, streakStrength: 0.9, freq: 5 });
    for (let i = 0; i < patina.length; i++) patina[i] = clamp01(Math.max(patina[i], drip[i] * 0.85 * clamp01((blot[i] - 0.30) * 2.5)));
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.40 + (grain[i] - 0.5) * 0.46 + edge[i] * 0.42 - cav[i] * 0.30 + hammer[i] * 0.10 + burnish[i] * 0.12);
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 5, edge, flowBase: 0.9, swirl: 1.1, light: [0.03, 0.12], dark: [-0.10, -0.02], highlight: 1.0, relief });
    addRelief(h, relief, n, 0.04);
    const rgb = TG.applyRamp(v, n, 'bronze');
    TG.compositeRamp(rgb, n, powField(patina, 1.35), clampField(biasField(scaleField(TG.copyField(blot), 1.1), -0.05)), 'verdigris', 0.80);
    // a chalky pale crust on the thickest patina
    const crust = F(n);
    for (let i = 0; i < crust.length; i++) crust[i] = Math.pow(patina[i], 2.4) * clamp01((grain[i] - 0.45) * 2.5);
    TG.tintRGB(rgb, n, crust, C255('#a2ddc8'), 0.22);
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#2a1408'), warm: C255(GOLD.highlight), inkAmount: 0.45, warmAmount: 0.30 });
    const rough = TG.artisticRoughness(n, { base: 0.50, height: h, cavity: cav, edge, polish: 0.26, dry: 0.36, variation: 0.16, seed: seed + 6, min: 0.20, max: 0.96 });
    const metal = F(n);
    for (let i = 0; i < metal.length; i++) {
      metal[i] = clamp01(0.80 - patina[i] * 0.72);
      rough[i] = clamp01(rough[i] + patina[i] * 0.40 + crust[i] * 0.15 - burnish[i] * 0.10 - edge[i] * 0.08);
    }
    return { rgb, height: h, rough, metal, normalScale: 1.2,
      params: { envMapIntensity: 1.0 }, paint: { triplanar: false, macroTint: GOLD.verdigris } };
  } },

  bone: { size: BASE, build(n, rng, seed) {
    // ── PITTED, NOT POLKA-DOTTED ─────────────────────────────────────────
    // An even Worley pore field is a sheet of dots. Old bone is pitted in
    // CLUSTERS of varied size, opens into spongy (cancellous) patches where
    // the cortex has worn through, and carries growth striations along its
    // length. Three scales of hole, one direction of grain.
    const cluster = TG.lowFreq(n, (r) => TG.warp(TG.fbm(r, { freq: 4, octaves: 5, seed: seed + 11 }), r, { amp: 0.10, freq: 3, seed: seed + 12 }), n >> 2);
    const poreRaw = TG.worleyField(n, { freq: 34, mode: 'f1', seed, res: n >> 1 });
    const poreFine = TG.fbm(n, { freq: 40, octaves: 2, seed: seed + 13, ppc: 3 });
    const pores = F(n);
    for (let i = 0; i < pores.length; i++) {
      const cl = clamp01((cluster[i] - 0.46) * 3.2);
      const size = 0.05 + 0.10 * cl + 0.04 * poreFine[i];
      pores[i] = clamp01((size - poreRaw[i]) * 8.0) * (0.18 + cl * 1.1);
    }
    const web = TG.worleyField(n, { freq: 46, mode: 'f2f1', seed: seed + 14, res: n >> 1 });
    const spongy = F(n);
    for (let i = 0; i < spongy.length; i++) spongy[i] = clamp01(1 - web[i] * 5.0) * clamp01((cluster[i] - 0.70) * 5.0);
    const crack = TG.veinNetwork(n, { count: 4, seed: seed + 1, len: 0.8, width: [0.4, 1.1], meander: 1.0, jitter: 0.09, branch: 0.010 });
    const grain = warpLo(n, { freq: 7, octaves: 5, seed: seed + 2 }, { amp: 0.055, freq: 3, seed: seed + 3 });
    // growth striations: long, faint, parallel strokes along the bone
    const stria = F(n);
    TG.strokes(stria, n, {
      rng, flow: TG.flowField(n, { base: 0.35, swirl: 0.28, freq: 2, seed: seed + 4 }),
      count: Math.round(n * 1.6), len: [n * 0.04, n * 0.14], width: [0.7, 1.8],
      value: [0.06, 0.16], curl: 0.3, wobble: 0.02, bristle: 0.7, taper: 1.6, softness: 1.1,
    });
    clampField(stria);
    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.62 + (grain[i] - 0.5) * 0.26 + stria[i] * 0.10 - pores[i] * 0.32 - spongy[i] * 0.30 - crack[i] * 0.34);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5.5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.56 + (grain[i] - 0.5) * 0.40 + stria[i] * 0.14 - pores[i] * 0.10 - spongy[i] * 0.14);
    // the pitted, weathered patches stain warm ochre; the clean cortex cools
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 3, octaves: 4, seed: seed + 6 }), -0.42), 1.9)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.7 + 0.35 - clamp01((cluster[i] - 0.46) * 3.2) * 0.45);
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 5, temp, cavity: cav, cavityAmt: 0.34, edge, edgeAmt: 0.22, flowBase: 0.35, swirl: 1.1,
      light: [0.015, 0.07], dark: [-0.07, -0.015], highlight: 0.9, relief });
    addRelief(h, relief, n, 0.05);
    const rgb = TG.applyRamp2(v, temp, n, 'bone', 'bone.cool');
    const grime = TG.dirtMask(h, n, { seed: seed + 7, cavity: cav, streak: 0.05 });
    TG.tintRGB(rgb, n, powField(grime, 2.0), C255('#6b4a24'), 0.38);
    TG.tintRGB(rgb, n, powField(crack, 1.1), C255('#4a3320'), 0.46);
    TG.tintRGB(rgb, n, powField(pores, 1.2), C255('#5a3a1c'), 0.45);
    TG.tintRGB(rgb, n, powField(spongy, 1.0), C255('#4e341e'), 0.55);
    // shadow toward a cool lilac-grey, crowns toward ivory
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#6a5a7a'), warm: C255('#fff2d6'), inkAmount: 0.40, warmAmount: 0.24 });
    const rough = TG.artisticRoughness(n, { base: 0.66, height: h, cavity: cav, edge, polish: 0.24, dry: 0.28, variation: 0.16, seed: seed + 8, min: 0.22, max: 0.96 });
    for (let i = 0; i < rough.length; i++) rough[i] = clamp01(rough[i] + pores[i] * 0.16 + spongy[i] * 0.22 - stria[i] * 0.06);
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
    // the flow direction is painted INTO the crust: strokes along the current
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 4, flowBase: 1.3, swirl: 1.4, count: Math.round(n * 0.9), light: [0.03, 0.14], dark: [-0.1, -0.02], relief });
    addRelief(h, relief, n, 0.06);
    const rgb = TG.applyRamp(v, n, 'lava');
    // §1.6 three-layer emissive: the fine cracks are the white-hot CORE, the
    // open melt is the saturated BODY, and a wide soft halo warms the crust
    // plates either side — the cooled crust itself stays dark and reads as
    // crust instead of as a dimmer orange
    const heat = F(n);
    for (let i = 0; i < heat.length; i++) heat[i] = clamp01(hot[i] * 0.80 + fine[i] * 0.55 * clamp01(0.3 + flow[i]) - 0.04);
    const emissive = glowLayers(heat, n, { ramp: 'lava', core: C255(ASPHODEL.lavaCore), coreGate: 0.70, bodyPow: 1.35, glowRadius: 0.028, glow: 0.55 });
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.01), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 6);
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#1c0400'), warm: C255(ASPHODEL.lavaHot), inkAmount: 0.35, warmAmount: 0.30 });
    const rough = TG.artisticRoughness(n, { base: 0.62, height: h, cavity: cav, edge, polish: 0.2, dry: 0.3, variation: 0.2, seed: seed + 5, min: 0.18, max: 0.95 });
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 2.0, normalScale: 0.9,
      animate: { scroll: [0.010, 0.006], pulse: 0.08 },
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
    // the glow is INSIDE the crystal: a soft body in the violet ramp with a
    // near-white core along the brightest inner veins and the facet arrises,
    // and a wide halo, so a shard reads as lit from within rather than as a
    // flat purple decal. bodyPow 2.1 keeps the mean where the old v^2 mask
    // put it, so the rig's emissiveIntensity does not need to move.
    const heat = F(n);
    for (let i = 0; i < heat.length; i++) heat[i] = clamp01(v[i] * 0.72 + inner[i] * 0.42 - 0.08 + edge[i] * 0.10);
    const emissive = glowLayers(heat, n, { ramp: 'crystal.violet', core: C255('#eddcff'), coreGate: 0.86, bodyPow: 2.1, glowRadius: 0.03, glow: 0.22 });
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255('#22073c'), warm: C255('#eddcff'), inkAmount: 0.40, warmAmount: 0.30 });
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
    // a woven DAMASK ground: a faint repeat of small palmettes in the cloth's
    // own weave, one value step darker where the thread is cut — the
    // brocade a Greek hanging actually has, and a second scale of ornament
    // under the embroidered gold
    const damask = F(n);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      TG.palmette(damask, n, { x: ((c + 0.5 + (r % 2) * 0.5) / 3) * n, y: ((r + 0.5) / 4) * n * 0.82, r: n * 0.055, petals: 7, value: 1, lineW: Math.max(1.0, n * 0.003) });
    }
    const damaskS = TG.blurWrap(damask, n, Math.max(1, n * 0.002), 1);

    const h = F(n);
    for (let i = 0; i < h.length; i++) h[i] = clamp01(0.42 + w[i] * 0.34 + (fold[i] - 0.5) * 0.30 + ornS[i] * 0.30 - damaskS[i] * 0.05);
    const cav = TG.cavityMask(h, n, Math.max(2, n * 0.012), 5);
    const edge = TG.edgeMask(h, n, Math.max(1, n * 0.004), 7);
    const v = F(n);
    for (let i = 0; i < v.length; i++) v[i] = clamp01(0.44 + (fold[i] - 0.5) * 0.62 + w[i] * 0.16 + (wear[i] - 0.5) * 0.22 - damaskS[i] * 0.11);
    const relief = F(n);
    paintValue(v, n, { rng, seed: seed + 4, cavity: cav, cavityAmt: 0.28, edge, edgeAmt: 0.18, flowBase: Math.PI / 2, swirl: 0.5,
      light: [0.025, 0.11], dark: [-0.10, -0.025], fine: [-0.02, 0.02], highlight: 0.5, relief });
    addRelief(h, relief, n, 0.05);
    const rgb = TG.applyRamp(v, n, 'banner.crimson');
    TG.inkAndWarm(rgb, n, cav, edge, { ink: C255(INK.plum), warm: C255('#ff8a70'), inkAmount: 0.45, warmAmount: 0.22 });
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

// Tartarus-specific aliases are real recipe keys rather than ALIASES entries.
// That lets them reuse the proven procedural PBR channels while receiving
// distinct generated albedo detail from tartarus-materials-v2-atlas.jpg.
RECIPES['bone.tartarus'] = RECIPES.bone;
RECIPES['bronze.tartarus'] = RECIPES['bronze.verdigris'];
RECIPES['wood.tartarus'] = RECIPES['wood.dark'];
RECIPES['iron.tartarus'] = RECIPES['iron.dark'];
RECIPES['ceramic.tartarus'] = RECIPES['rubble.tartarus'];

// Enemy-specific albedos reuse the proven character PBR support maps. Keeping
// real keys lets generated artwork bind to the hound alone instead of repainting
// every cloth, hair and bone surface in the roster.
RECIPES['characterrig.hound.hide'] = RECIPES['characterrig.cloth'];
RECIPES['characterrig.hound.limbs'] = RECIPES['characterrig.hair'];
RECIPES['characterrig.hound.keratin'] = RECIPES['characterrig.hair'];
RECIPES['stone.tartarus.rim'] = RECIPES['stone.tartarus'];
RECIPES['shrine.divine'] = RECIPES['stone.tartarus'];
RECIPES['gold.divine'] = RECIPES['gold.filigree'];

// Asphodel-only aliases receive their own generated albedo tiles while keeping
// the proven procedural normal/roughness/emissive support maps underneath.
RECIPES['obsidian.asphodel'] = RECIPES.obsidian;
RECIPES['lava.asphodel'] = RECIPES.lava;
// Asphodel rubble used to reuse `bone` byte-for-byte. Large debris chunks then
// arrived at character value and shared the same ivory grain as the skeleton
// dressing, so neither material had a distinct role. Reuse the existing
// obsidian synthesis instead (same number/size of baked sets and draw calls),
// but temper its glass into rough, ash-lifted volcanic slag. The generated
// albedo binding above shares the already-decoded cooled-obsidian tile too.
RECIPES['rubble.asphodel'] = {
  size: BASE,
  build(n, rng, seed) {
    const slag = RECIPES.obsidian.build(n, rng, seed);
    for (let i = 0; i < slag.height.length; i++) {
      const j = i * 3;
      // Lift only enough for silhouette and facet readability; bone remains
      // roughly 2.5x brighter and therefore keeps its authored gameplay cue.
      slag.rgb[j] = clamp01((slag.rgb[j] / 255) * 1.16 + 0.030) * 255;
      slag.rgb[j + 1] = clamp01((slag.rgb[j + 1] / 255) * 1.14 + 0.027) * 255;
      slag.rgb[j + 2] = clamp01((slag.rgb[j + 2] / 255) * 1.12 + 0.040) * 255;
      slag.rough[i] = clamp01(slag.rough[i] + 0.26);
    }
    slag.params = { ...slag.params, envMapIntensity: 0.52 };
    slag.paint = {
      ...slag.paint,
      triScale: 0.42,
      macroTint: '#454052',
      variation: 0.10,
      variationTint: '#5b5263',
    };
    return slag;
  },
};
RECIPES['bone.asphodel'] = RECIPES.bone;
RECIPES['bronze.asphodel'] = RECIPES['bronze.verdigris'];
RECIPES['iron.asphodel'] = RECIPES['iron.dark'];

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
