// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// library.js — MaterialLibrary (ARCHITECTURE.md §2.7)
//
//   mats.get(name, opts)   -> cached THREE.Material
//   mats.tex(name, opts)   -> cached THREE.Texture
//
// Every named material is synthesised at runtime from texgen.js: albedo +
// normal + roughness + AO (packed ORM) + emissive where it glows, then patched
// with the painterly shading model in painterly.js. Zero external assets.
//
// Extras other systems may use (all additive, nothing here breaks the contract):
//   mats.patch(mat, opts)        painterly-patch someone else's material
//   mats.character(opts)         a ready character-look MeshStandardMaterial
//   mats.setBiome(name)          retune rim / shadow tint for the whole scene
//   mats.env()                   the procedural PMREM the metals reflect
//   mats.ramp(name) / mats.color(name, t)
//   mats.detailTexture / mats.macroTexture
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import * as TG from './texgen.js';
import {
  RAMPS, INK, GOLD, TARTARUS, ASPHODEL, ELYSIUM, BIOMES,
  hexToRgb, rampAt,
} from './palette.js';
import {
  painterly, setPaint, setBiomeLook, updatePainterly, paintParams,
  ENVIRONMENT_LOOK, CHARACTER_LOOK,
} from './painterly.js';

const C255 = (hex) => { const c = hexToRgb(hex); return [c[0] * 255, c[1] * 255, c[2] * 255]; };
const clamp01 = TG.clamp01;
const F = (n) => new Float32Array(n * n);

// Nominal texture sizes. HERO = the surfaces a critic will stand next to and
// which therefore justify a 1024 synthesis budget; MID = large but usually seen
// at 3/4 distance; BASE = props. `ctx.quality.texScale` scales all of them.
// Synthesis cost is O(n^2) and the whole library is built during boot, so these
// are a real frame-budget decision, not a quality preference. 768/512/448 keeps
// the first chamber's build under ~3s at ultra while staying above the
// resolution where the brushwork starts to mush at the 'detail' camera pose.
const HERO = 768;
const MID = 512;
const BASE = 448;

// ---------------------------------------------------------------------------
// small field helpers
// ---------------------------------------------------------------------------
const scaleField = (f, k) => { for (let i = 0; i < f.length; i++) f[i] *= k; return f; };
const biasField = (f, k) => { for (let i = 0; i < f.length; i++) f[i] += k; return f; };
const clampField = (f, lo = 0, hi = 1) => { for (let i = 0; i < f.length; i++) f[i] = f[i] < lo ? lo : f[i] > hi ? hi : f[i]; return f; };
const invField = (f) => { const o = new Float32Array(f.length); for (let i = 0; i < f.length; i++) o[i] = 1 - f[i]; return o; };
const powField = (f, p) => { const o = new Float32Array(f.length); for (let i = 0; i < f.length; i++) o[i] = Math.pow(clamp01(f[i]), p); return o; };
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
  const nx = new Float32Array(n * n), ny = new Float32Array(n * n), nz = new Float32Array(n * n);
  const w = (x, y) => ((y % n) + n) % n * n + (((x % n) + n) % n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (height[w(x + 1, y)] - height[w(x - 1, y)]) * n * 0.5 * scale;
      const dy = (height[w(x, y + 1)] - height[w(x, y - 1)]) * n * 0.5 * scale;
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = y * n + x;
      nx[i] = -dx * l; ny[i] = -dy * l; nz[i] = l;
    }
  }
  const R = 1;                                   // 3x3 footprint
  const out = new Float32Array(rough.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let ax = 0, ay = 0, az = 0, c = 0;
      for (let j = -R; j <= R; j++) for (let i2 = -R; i2 <= R; i2++) {
        const k = w(x + i2, y + j); ax += nx[k]; ay += ny[k]; az += nz[k]; c++;
      }
      ax /= c; ay /= c; az /= c;
      const len = Math.min(1, Math.sqrt(ax * ax + ay * ay + az * az));
      const i = y * n + x;
      const g = Math.max(1e-3, 2 / Math.max(1e-4, rough[i] * rough[i]) - 2);   // roughness -> gloss
      const gp = (len * g) / (len + g * (1 - len) + 1e-5);
      out[i] = clamp01(Math.max(rough[i], Math.sqrt(2 / (gp + 2))));
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

const RECIPES = {

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
      v[i] = 0.24 + A.id[i] * 0.32 + (base[i] - 0.5) * 0.50 + grit[i] * 0.07 + chisel[i] * 0.09 - pits[i] * 0.18 + chips[i] * 0.16;
    }
    const temp = TG.lowFreq(n, (r) => {
      const t = TG.warp(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), r, { amp: 0.08, freq: 2, seed: seed + 32 });
      for (let i = 0; i < t.length; i++) t[i] = clamp01((t[i] - 0.35) * 1.9);
      return t;
    }, n >> 2);
    // each block also gets its own warm/cool bias — quarried from a different bed
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.62 + A.id[i] * 0.55);
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

    return { rgb, height: h, rough, metal, normalScale: 0.75,
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

  // The single largest surface in the game gets the largest plate: at 1024 with
  // an 11x8 bond, one texture period is 28.6 world metres, so the ~30m of floor
  // a play-camera frame can see never contains two full periods and no two
  // flagstones in the visible arena are the same flagstone. That is the actual
  // cure for §7's tiling ban; a de-tiler is a patch over too small a plate.
  'floor.tartarus': { size: 1024, build(n, rng, seed) {
    const T = TG.tileGrid(n, { cols: 11, rows: 8, pattern: 'offset', gap: 0.0030, bevel: 0.012, rng, wobble: 0.030 });
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
    for (let i = 0; i < h.length; i++) h[i] = clamp01(h[i] + 0.12 - fissure[i] * 0.34);
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
    for (let i = 0; i < v.length; i++) v[i] = 0.30 + T.id[i] * 0.22 + (base[i] - 0.5) * 0.60 + grit[i] * 0.05;
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
      flowBase: 0.9, swirl: 2.3, light: [0.045, 0.150], dark: [-0.135, -0.042], fine: [-0.030, 0.030], highlight: 0.55 });
    const rgb = TG.applyRamp2(v, temp, n, 'floor.tartarus', 'floor.tartarus.cool');

    // The seam ink used to be a hard #07060f at 0.86 over a 0.0065 gap. Once the
    // plate was scaled up for the play camera those joints became finger-wide
    // black bands and the floor read as crazy paving rather than as laid stone.
    TG.tintRGB(rgb, n, powField(T.seam, 1.30), C255(INK.deep), 0.62);
    TG.tintRGB(rgb, n, powField(fissure, 1.2), C255('#180610'), 0.55);
    // spilled ichor pooling in the seams
    const stain = TG.warp2(TG.fbm(n, { freq: 3, octaves: 5, seed: seed + 61 }), n, { amp: 0.12, freq: 2, seed: seed + 62 });
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
      paint: { projection: 'planarY', triScale: 0.035, stochastic: 0.85,
        // §9.1 THE FLOOR IS A DARK STAGE. This is the single most important
        // number in the frame: it is how much of the light rig the ground plane
        // is allowed to keep. A 100%-up-facing plane collects more key AND more
        // hemisphere than any other surface class in the chamber, which is why
        // an otherwise correct rig still produced a floor 62% brighter than the
        // frame median. Cutting it HERE rather than in render/lighting.js means
        // the columns, capitals, gold trim and brazier rims keep the full rig.
        // Do not "fix" a dark floor by raising the key — raise these instead,
        // and only if the measured groundLuma stays under 0.18.
        litGain: 0.42, ambGain: 0.26,
        // TILING (§7). Measured autocorrelation was 0.535-0.592 at the ashlar
        // pitch. Plate size alone cannot answer a REGULAR JOINT LATTICE — the
        // seams repeat even when the stones do not. A much stronger macro layer
        // at two incommensurate scales puts a low-frequency value drift across
        // whole groups of stones, which is what decorrelates the row the
        // analyzer samples.
        macroStrength: 0.15, macroScale: 0.0125, macroTint: '#4a2c38',
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
    const base = TG.warp2(TG.fbm(n, { freq: 3.5, octaves: 6, seed }), n, { amp: 0.09, freq: 2, seed: seed + 1 });
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
    return { rgb, height: h, rough, metal, normalScale: 0.85, emissive, emissiveIntensity: 0.78,
      params: { envMapIntensity: 0.38 },
      paint: { triplanar: false, macroStrength: 0.16, macroTint: '#7a4f58' } };
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
    const fold = TG.warp2(TG.fbm(n, { freq: 2.4, octaves: 5, seed: seed + 1, type: 'grad' }), n, { amp: 0.10, freq: 2, seed: seed + 2 });
    const wear = TG.warp2(TG.fbm(n, { freq: 7, octaves: 5, seed: seed + 3 }), n, { amp: 0.06, freq: 3, seed: seed + 4 });
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
      params: { envMapIntensity: 0.45 },
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
      v[i] = 0.34 + A.id[i] * 0.20 + (base[i] - 0.5) * 0.42 + chisel[i] * 0.13 + grit[i] * 0.06 - pits[i] * 0.16;
    }
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.40), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.66 + A.id[i] * 0.44);
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
    for (let i = 0; i < v.length; i++) v[i] = 0.28 + T.id[i] * 0.22 + (base[i] - 0.5) * 0.46 + chisel[i] * 0.10 + grit[i] * 0.05;
    const temp = TG.lowFreq(n, (r) => clampField(scaleField(biasField(TG.fbm(r, { freq: 2, octaves: 4, seed: seed + 31 }), -0.36), 1.8)), n >> 2);
    for (let i = 0; i < temp.length; i++) temp[i] = clamp01(temp[i] * 0.6 + T.id[i] * 0.5);
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
      params: { envMapIntensity: 0.55 },
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
    const base = TG.warp2(TG.fbm(n, { freq: 4, octaves: 5, seed: seed + 3, type: 'grad' }), n, { amp: 0.06, freq: 3, seed: seed + 4 });

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
    const base = TG.warp2(TG.fbm(n, { freq: 5, octaves: 5, seed: seed + 2 }), n, { amp: 0.06, freq: 3, seed: seed + 3 });
    const ash = TG.warp(TG.fbm(n, { freq: 7, octaves: 5, seed: seed + 4 }), n, { amp: 0.05, freq: 4, seed: seed + 5 });

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
    const cloud = TG.warp2(TG.fbm(n, { freq: 3, octaves: 5, seed: seed + 4 }), n, { amp: 0.09, freq: 2, seed: seed + 5 });

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
    const cloud = TG.warp2(TG.fbm(n, { freq: 4, octaves: 5, seed: seed + 1 }), n, { amp: 0.07, freq: 2, seed: seed + 2 });
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
    for (let i = 0; i < v.length; i++) v[i] = 0.44 + T.id[i] * 0.07 + (cloud[i] - 0.5) * 0.52 + grain[i] * 0.09;
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
    const swirl = TG.warp2(TG.fbm(n, { freq: 5, octaves: 4, seed: seed + 3, type: 'grad' }), n, { amp: 0.05, freq: 3, seed: seed + 4 });

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
    const back = TG.warp2(TG.fbm(n, { freq: 6, octaves: 5, seed }), n, { amp: 0.05, freq: 3, seed: seed + 1 });
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
    return { rgb, height: h, rough, metal, normalScale: 1.5, emissive, emissiveIntensity: 0.62,
      params: { envMapIntensity: 0.75 },
      paint: { triplanar: false, macroStrength: 0.28, macroTint: GOLD.mid, rimStrength: 0.55 } };
  } },

  // Hammered gold LEAF — no meander, no guilloche. The filigree recipe is a
  // composed BAND; squeezing that band on to a 2.9 x 0.26 spoke turned it into
  // a stack of aliased stripes. Anything long and thin (inlay rings, medallion
  // spokes, an archivolt) gets this instead.
  'gold.leaf': { size: BASE, build(n, rng, seed) {
    const hammer = TG.worleyField(n, { freq: 13, mode: 'f1', seed, res: n >> 1 });
    const grain = TG.warp2(TG.fbm(n, { freq: 5, octaves: 5, seed: seed + 1 }), n, { amp: 0.06, freq: 3, seed: seed + 2 });
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
    return { rgb, height: h, rough, metal, normalScale: 0.9, emissive, emissiveIntensity: 0.80,
      params: { envMapIntensity: 0.70 },
      paint: { projection: 'triplanar', triScale: 0.55, triSharp: 5.0, macroStrength: 0.14, macroTint: GOLD.mid, rimStrength: 0.6 } };
  } },

  'bronze.verdigris': { size: BASE, build(n, rng, seed) {
    const hammer = TG.worleyField(n, { freq: 14, mode: 'f1', seed });
    const grain = TG.warp2(TG.fbm(n, { freq: 6, octaves: 5, seed: seed + 1 }), n, { amp: 0.06, freq: 3, seed: seed + 2 });
    const blot = TG.warp2(TG.fbm(n, { freq: 5, octaves: 6, seed: seed + 3 }), n, { amp: 0.10, freq: 3, seed: seed + 4 });
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
    const grain = TG.warp2(TG.fbm(n, { freq: 7, octaves: 5, seed: seed + 2 }), n, { amp: 0.055, freq: 3, seed: seed + 3 });
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
    const flow = TG.warp2(TG.fbm(n, { freq: 4, octaves: 6, seed: seed + 1 }), n, { amp: 0.12, freq: 2, seed: seed + 2 });
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
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 5.8, normalScale: 0.9,
      animate: { scroll: [0.010, 0.006], pulse: 0.22 },
      paint: { triplanar: false, rimStrength: 0.12 } };
  } },

  'blood.pool': { size: BASE, build(n, rng, seed) {
    const swirl = TG.warp2(TG.fbm(n, { freq: 3, octaves: 6, seed }), n, { amp: 0.14, freq: 2, seed: seed + 1 });
    const ripple = TG.ridged(n, { freq: 7, octaves: 4, seed: seed + 2, type: 'grad' });
    const skin = TG.warp(TG.fbm(n, { freq: 9, octaves: 4, seed: seed + 3 }), n, { amp: 0.06, freq: 4, seed: seed + 4 });
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
    const a = TG.warp2(TG.fbm(n, { freq: 5, octaves: 6, seed, type: 'grad' }), n, { amp: 0.09, freq: 3, seed: seed + 1 });
    const b = TG.warp(TG.ridged(n, { freq: 7, octaves: 5, seed: seed + 2, type: 'grad' }), n, { amp: 0.05, freq: 4, seed: seed + 22 });
    const swirl = TG.warp2(TG.fbm(n, { freq: 2, octaves: 5, seed: seed + 3 }), n, { amp: 0.16, freq: 2, seed: seed + 4 });
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
    const inner = TG.warp2(TG.fbm(n, { freq: 4, octaves: 5, seed: seed + 1 }), n, { amp: 0.09, freq: 2, seed: seed + 2 });
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
    return { rgb, height: h, rough, metal: 0.0, emissive, emissiveIntensity: 3.9, normalScale: 1.35,
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
    const wear = TG.warp2(TG.fbm(n, { freq: 6, octaves: 5, seed: seed + 2 }), n, { amp: 0.06, freq: 3, seed: seed + 3 });
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
      params: { side: THREE.DoubleSide }, paint: { triplanar: false, macroTint: '#8c1128' } };
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
    const grain = TG.warp2(TG.fbm(n, { freq: 7, octaves: 5, seed: seed + 2 }), n, { amp: 0.05, freq: 3, seed: seed + 3 });
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

// ---------------------------------------------------------------------------
// MaterialLibrary
// ---------------------------------------------------------------------------

export class MaterialLibrary {
  constructor() {
    this.cache = new Map();       // materialKey -> THREE.Material
    this.texCache = new Map();    // texKey -> THREE.Texture
    this.setCache = new Map();    // name|size -> texture set
    this.animated = [];
    this.stats = { ms: 0, built: 0, texels: 0 };
    this.biome = 'tartarus';
    this.scale = 1;
    this._t = 0;
  }

  async init(ctx) {
    this.ctx = ctx;
    const tier = (ctx.quality && ctx.quality.tier) || 'high';
    this.scale = tier === 'low' ? 0.5 : tier === 'med' ? 0.75 : 1.0;
    if (ctx.quality && ctx.quality.texScale) this.scale = ctx.quality.texScale;
    // shared layers used by every world-projected surface
    this.detailTexture = this._detail();
    this.macroTexture = this._macro();
    setBiomeLook(this.biome);
    if (ctx.events && ctx.events.on) ctx.events.on('biome.changed', ({ name }) => this.setBiome(name));
  }

  // ---- procedural environment (metals must have something to reflect) ------
  /**
   * A tiny painted equirect sky -> PMREM. Without this every metal in the game
   * renders as a black mirror, which is the loudest "programmer art" tell there
   * is. It is authored from the biome ramp so the reflections stay in palette.
   */
  env(biome = this.biome) {
    // The light rig authors and prefilters the biome sky (lighting.js
    // _buildEnvironment) and publishes it as `ctx.lighting.envTexture`. If it is
    // there we bind THAT — one PMREM for the whole game means the reflection in
    // the gold matches the light that is actually hitting it. We only synthesise
    // our own when the rig is absent (unit tests, tools, a stubbed rig).
    const rigEnv = this.ctx && this.ctx.lighting && this.ctx.lighting.envTexture;
    if (rigEnv) return rigEnv;
    if (!this._envCache) this._envCache = new Map();
    if (this._envCache.has(biome)) return this._envCache.get(biome);
    let tex = null;
    try {
      const r = this.ctx && this.ctx.renderer;
      if (r) {
        const B = BIOMES[biome] || BIOMES.tartarus;
        const lin = (hex, k = 1) => {
          const c = hexToRgb(hex);
          const f = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * k;
          return [f(c[0]), f(c[1]), f(c[2])];
        };
        const sky = lin(INK.violet, 0.30);
        const zen = lin(INK.deep, 0.16);
        const horiz = lin(B.fog, 0.55);
        const ground = lin(B.bounce, 0.42);
        const keyC = lin(B.key, 7.0);
        const accC = lin(B.accent, 2.2);
        const W = 128, H = 64;
        const data = new Float32Array(W * H * 4);
        const kd = B.keyDir, klen = Math.hypot(kd[0], kd[1], kd[2]) || 1;
        const kx = kd[0] / klen, ky = kd[1] / klen, kz = kd[2] / klen;
        for (let y = 0; y < H; y++) {
          const theta = (y + 0.5) / H * Math.PI;          // 0 = up
          const cy = Math.cos(theta), sy = Math.sin(theta);
          for (let x = 0; x < W; x++) {
            const phi = (x + 0.5) / W * Math.PI * 2;
            const dx = sy * Math.cos(phi), dz = sy * Math.sin(phi), dy = cy;
            let R, G, Bc;
            if (dy >= 0) {
              const t = Math.pow(dy, 0.65);
              R = horiz[0] + (zen[0] + sky[0] - horiz[0]) * t;
              G = horiz[1] + (zen[1] + sky[1] - horiz[1]) * t;
              Bc = horiz[2] + (zen[2] + sky[2] - horiz[2]) * t;
            } else {
              const t = Math.pow(-dy, 0.55);
              R = horiz[0] + (ground[0] - horiz[0]) * t;
              G = horiz[1] + (ground[1] - horiz[1]) * t;
              Bc = horiz[2] + (ground[2] - horiz[2]) * t;
            }
            // the key light, as a soft warm disc
            const kdot = dx * kx + dy * ky + dz * kz;
            const kb = Math.pow(Math.max(0, kdot), 26) + Math.pow(Math.max(0, kdot), 3) * 0.10;
            R += keyC[0] * kb; G += keyC[1] * kb; Bc += keyC[2] * kb;
            // a cool accent bounce opposite it, so metal has a two-tone reflection
            const ab = Math.pow(Math.max(0, -kdot), 5) * 0.30;
            R += accC[0] * ab * 0.4; G += accC[1] * ab; Bc += accC[2] * ab * 1.2;
            const i = (y * W + x) * 4;
            data[i] = R; data[i + 1] = G; data[i + 2] = Bc; data[i + 3] = 1;
          }
        }
        const src = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
        src.mapping = THREE.EquirectangularReflectionMapping;
        src.colorSpace = THREE.NoColorSpace;
        src.minFilter = src.magFilter = THREE.LinearFilter;
        src.needsUpdate = true;
        const pm = new THREE.PMREMGenerator(r);
        tex = pm.fromEquirectangular(src).texture;
        pm.dispose(); src.dispose();
      }
    } catch (e) { tex = null; }
    this._envCache.set(biome, tex);
    return tex;
  }

  // ---- shared layers ------------------------------------------------------
  _detail() {
    if (this._detailTex) return this._detailTex;
    const n = 256;
    const rng = TG.makeRng('detail');
    const g = TG.fbm(n, { freq: 16, octaves: 4, seed: 1201, ppc: 3 });
    const flow = TG.flowField(n, { base: 0.5, swirl: 1.4, freq: 4, seed: 1202 });
    const s = new Float32Array(n * n);
    TG.strokes(s, n, { rng, flow, count: 900, len: [n * 0.03, n * 0.10], width: [0.9, 2.0], value: [0.05, 0.16], bristle: 0.75, taper: 1.9 });
    TG.strokes(s, n, { rng, flow: TG.flowField(n, { base: 2.0, swirl: 1.1, freq: 5, seed: 1203 }), count: 700, len: [n * 0.02, n * 0.08], width: [0.8, 1.6], value: [-0.14, -0.04], bristle: 0.8, taper: 2.1 });
    const out = new Float32Array(n * n);
    for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + (g[i] - 0.5) * 0.42 + s[i] * 1.05);
    this._detailTex = TG.fieldTexture(out, n, { anisotropy: 8 });
    this._detailTex.name = 'detail.grain';
    return this._detailTex;
  }

  _macro() {
    if (this._macroTex) return this._macroTex;
    const n = 256;
    const a = TG.warp2(TG.fbm(n, { freq: 2, octaves: 5, seed: 2201 }), n, { amp: 0.12, freq: 2, seed: 2202 });
    const b = TG.warp2(TG.fbm(n, { freq: 3, octaves: 5, seed: 2203 }), n, { amp: 0.10, freq: 2, seed: 2204 });
    const rgbF = new Float32Array(n * n * 3);
    for (let i = 0; i < n * n; i++) {
      // biased slightly below 0.5 so the `* 2` in the shader creates large
      // SHADED regions, not only bright ones — that is the value banding
      const v = 0.455 + (a[i] - 0.5) * 0.50;
      const t = 0.5 + (b[i] - 0.5) * 0.34;
      const j = i * 3;
      rgbF[j] = (v * 1.04 + t * 0.05) * 255;
      rgbF[j + 1] = v * 255;
      rgbF[j + 2] = (v * 0.96 + (1 - t) * 0.06) * 255;
    }
    this._macroTex = TG.rgbTexture(rgbF, n, { linear: true, anisotropy: 4 });
    this._macroTex.name = 'macro.variation';
    return this._macroTex;
  }

  // ---- texture set --------------------------------------------------------
  _size(rec) {
    // Multiples of 64, NOT powers of two: WebGL2 mipmaps NPOT textures fine and
    // snapping down to the previous power of two threw away up to 44% of the
    // authored resolution (a nominal 768 silently became 512).
    const nominal = rec.size || BASE;
    const n = Math.round(nominal * this.scale / 64) * 64;
    return Math.max(128, Math.min(2048, n));
  }

  _resolve(name) {
    if (RECIPES[name]) return name;
    if (ALIASES[name] && RECIPES[ALIASES[name]]) return ALIASES[name];
    // tolerate 'stone.tartarus.wall' style suffixes from other systems
    const parts = String(name || '').split('.');
    while (parts.length > 1) {
      parts.pop();
      const k = parts.join('.');
      if (RECIPES[k]) return k;
      if (ALIASES[k] && RECIPES[ALIASES[k]]) return ALIASES[k];
    }
    return null;
  }

  /** Build (or fetch) the cached texture set for a named material. */
  set(name) {
    const key = this._resolve(name);
    if (!key) return null;
    const rec = RECIPES[key];
    const n = this._size(rec);
    const ck = key + '|' + n;
    if (this.setCache.has(ck)) return this.setCache.get(ck);

    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const seed = TG.hashString('erebus:' + key) & 0x7fffffff;
    const rng = TG.makeRng(seed ^ 0x5bf03635);
    let m;
    try {
      m = rec.build(n, rng, seed);
    } catch (e) {
      console.warn('[mats] recipe failed:', key, e && e.message);
      m = fallbackMaps(n, key);
    }
    const ao = m.ao || TG.aoFromHeight(m.height, n, { strength: m.aoStrength ?? 1, floor: 0.20 });
    if (m.height && m.rough && m.toksvig !== false) {
      try { m.rough = toksvig(m.rough, m.height, n, m.normalScale ?? 1); }
      catch (e) { /* never lose a material over an anti-shimmer pass */ }
    }
    const set = {
      name: key, size: n,
      map: TG.rgbTexture(m.rgb, n, { anisotropy: 16 }),
      normalMap: TG.normalTexture(m.height, n, m.normalScale ?? 1.0, { anisotropy: 16 }),
      ormMap: TG.ormTexture(ao, m.rough, m.metal ?? 0, n, { anisotropy: 16 }),
      emissiveMap: m.emissive ? TG.rgbTexture(m.emissive, n, { anisotropy: 4 }) : null,
      emissiveIntensity: m.emissiveIntensity ?? 0,
      params: m.params || {},
      paint: m.paint || {},
      animate: m.animate || null,
    };
    set.map.name = key + '.albedo';
    set.normalMap.name = key + '.normal';
    set.ormMap.name = key + '.orm';
    if (set.emissiveMap) set.emissiveMap.name = key + '.emissive';
    const dt = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.stats.ms += dt; this.stats.built++; this.stats.texels += n * n;
    this.setCache.set(ck, set);
    return set;
  }

  // ---- the contract -------------------------------------------------------
  /** mats.get(name, opts) -> cached THREE.Material */
  get(name, opts = {}) {
    const key = name + '|' + stableKey(opts);
    if (this.cache.has(key)) return this.cache.get(key);
    // ART_DIRECTION §4: characters are NOT lit like environment. Any name in the
    // `character.*` namespace resolves to the painterly character shader —
    // 2-3 step ramp, hand AO, fresnel rim bound to the light rig's constant and
    // a colour-shifted inner contour — instead of an environment texture set.
    // (AGENT-PLAYER / AGENT-ENEMY: ask for 'character.painterly', not a stone.)
    if (typeof name === 'string' && name.startsWith('character') && !this._resolve(name)) {
      const m = this.character(opts);
      m.name = name;
      this.cache.set(key, m);
      this._applyRim(m);
      return m;
    }
    const set = this.set(name);
    const m = set ? this._material(set, opts) : this._fallbackMaterial(name, opts);
    m.name = name;
    this.cache.set(key, m);
    return m;
  }

  /** mats.tex(name, opts) -> cached THREE.Texture (never throws, never null) */
  tex(name, opts = {}) {
    const which = opts.map || opts.channel || 'albedo';
    const key = 'tex:' + name + '|' + which + '|' + stableKey(opts);
    if (this.texCache.has(key)) return this.texCache.get(key);
    let t = null;
    if (name === 'detail' || name === 'detail.grain') t = this._detail();
    else if (name === 'macro' || name === 'macro.variation') t = this._macro();
    else {
      const set = this.set(name);
      if (set) {
        t = which === 'normal' ? set.normalMap
          : (which === 'orm' || which === 'roughness' || which === 'ao' || which === 'metalness') ? set.ormMap
            : which === 'emissive' ? (set.emissiveMap || set.map)
              : set.map;
      }
    }
    if (!t) t = this._neutral();
    if (opts.repeat) { t = t.clone(); t.repeat.set(opts.repeat, opts.repeat); t.needsUpdate = true; }
    this.texCache.set(key, t);
    return t;
  }

  _neutral() {
    if (this._neutralTex) return this._neutralTex;
    const d = new Uint8Array(4 * 4 * 4).fill(200);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    const t = new THREE.DataTexture(d, 4, 4, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
    t.name = 'neutral';
    this._neutralTex = t;
    return t;
  }

  _material(set, opts) {
    const paintOpts = { ...set.paint };
    const own = {};
    // split THREE material params from our own options
    const MINE = ['triplanar', 'projection', 'triScale', 'triSharp', 'stochastic', 'circScale',
      'detail', 'detailScale', 'detailStrength',
      'macro', 'macroScale', 'macroStrength', 'macroTint', 'variation', 'variationTint',
      'variant', 'rimColor', 'rimPower', 'rimStrength', 'rimDir', 'rimGate', 'shadowTint',
      'shadowDepth', 'rampSoftness', 'rampStrength', 'rampSteps', 'rampLevels', 'keyRef',
      'contourColor', 'contourStrength', 'contourStart', 'repeat', 'size', 'painterly', 'tint', 'envMap',
      'litGain', 'ambGain'];
    const three = {};
    for (const k in opts) {
      if (MINE.indexOf(k) >= 0) own[k] = opts[k];
      else three[k] = opts[k];
    }
    Object.assign(paintOpts, own);

    const repeat = opts.repeat;
    const worldProj = paintOpts.triplanar || paintOpts.projection === 'triplanar' || paintOpts.projection === 'planarY';
    const tx = (t) => {
      if (!t) return null;
      if (!repeat || worldProj) return t;
      const c = t.clone(); c.repeat.set(repeat, repeat); c.needsUpdate = true; return c;
    };

    const params = {
      map: tx(set.map),
      normalMap: tx(set.normalMap),
      normalScale: new THREE.Vector2(1, 1),
      roughnessMap: tx(set.ormMap),
      metalnessMap: tx(set.ormMap),
      aoMap: tx(set.ormMap),
      aoMapIntensity: 1.0,
      roughness: 1.0,
      metalness: 1.0,
      envMapIntensity: 1.0,
      dithering: true,
      ...set.params,
    };
    if (set.emissiveMap) {
      params.emissiveMap = tx(set.emissiveMap);
      params.emissive = new THREE.Color(0xffffff);
      params.emissiveIntensity = set.emissiveIntensity;
    }
    if (opts.envMap !== false) {
      const e = this.env();
      if (e) {
        params.envMap = e;
        // Dielectrics only get a whisper of IBL — enough to keep the shadow
        // side from going dead, not enough to fight the authored light rig.
        params.envMapIntensity = (set.params && set.params.envMapIntensity) != null ? set.params.envMapIntensity : 0.13;
      }
    }
    const mat = new THREE.MeshStandardMaterial(params);
    if (opts.tint) mat.color.setRGB(...hexToRgb(opts.tint), THREE.SRGBColorSpace);
    // remaining THREE params (side, transparent, opacity, depthWrite, ...)
    try { mat.setValues(three); } catch (e) { /* ignore hostile opts */ }

    if (paintOpts.painterly !== false) {
      painterly(mat, {
        detail: this.detailTexture,
        macro: this.macroTexture,
        keyRef: this._keyRef(),
        ...BIOME_PAINT(this.biome),
        ...paintOpts,
      });
    }
    mat.userData.paintOverrides = paintOpts;
    this._applyRim(mat);
    if (set.animate) this.animated.push({ mat, set, cfg: set.animate });
    return mat;
  }

  _fallbackMaterial(name, opts) {
    // Never ship an untextured grey primitive (ART_DIRECTION §7). Unknown names
    // get the biome's stone so the frame still reads as painted.
    const set = this.set('stone.tartarus');
    if (set) return this._material(set, opts);
    return new THREE.MeshStandardMaterial({ color: new THREE.Color(0x5a2331), roughness: 0.8 });
  }

  /**
   * The irradiance a fully-lit surface receives from the key. The painterly
   * ramp divides by this, and the rim is now scaled by it, so it has to track
   * the key's COLOUR as well as its intensity: a saturated #ff7a52 key delivers
   * 1.6x less luminance than a bleached #ffb894 one at the same intensity, and
   * ignoring that slides the whole terminator the moment the palette is
   * corrected back toward §2.
   */
  _keyRef() {
    const L = this.ctx && this.ctx.lighting;
    const i = (L && L.key && L.key.intensity) || 3.6;
    const c = L && L.key && L.key.color;
    const lum = c ? (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) : 0.62;
    return Math.max(0.8, i * Math.max(0.12, lum) * 1.07);
  }

  // ---- extras other systems may use --------------------------------------
  /** Painterly-patch a material owned by another system. */
  patch(mat, opts = {}) {
    if (!mat) return mat;
    painterly(mat, { keyRef: this._keyRef(), ...BIOME_PAINT(this.biome), ...opts });
    return mat;
  }

  /** A ready-to-use character-look material (stronger rim, flatter ramp). */
  character(opts = {}) {
    const { color = '#c9b8ff', roughness = 0.62, metalness = 0.0, ...rest } = opts;
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(...hexToRgb(color), THREE.SRGBColorSpace),
      roughness, metalness, dithering: true,
    });
    if (metalness > 0) {
      const e = this.env();
      if (e) { m.envMap = e; m.envMapIntensity = 0.6; }
    }
    painterly(m, { variant: 'character', keyRef: this._keyRef(), ...BIOME_PAINT(this.biome), ...rest });
    return m;
  }

  /** Retune rim / shadow tint for a biome across every patched material. */
  setBiome(name) {
    if (!BIOMES[name]) return this;
    this.biome = name;
    setBiomeLook(name);                       // palette rim / shadow tint / contour
    const e = this.env();
    for (const m of this.cache.values()) {
      if (e && m.envMap && m.envMap !== e) { m.envMap = e; m.needsUpdate = true; }
      this._applyRim(m);                      // the light rig's constant wins over the palette
    }
    return this;
  }

  // ---- the light rig <-> material handshake -------------------------------
  /**
   * The light rig publishes its ART-DIRECTED rim constant (and the biome's ink
   * colour + key reference) here; lighting.js calls this from setBiome(). We
   * BIND it — we never reimplement rim shading on the render side, and the
   * render side never reaches into our uniforms.
   *
   * payload = { color, dir, intensity, power, wrap, keyDir, keyColor, ink, biome }
   */
  setRim(payload) {
    if (!payload) return this;
    this._rim = payload;
    if (payload.env) this._bindEnv(payload.env);
    if (payload.biome && BIOMES[payload.biome] && payload.biome !== this.biome) return this.setBiome(payload.biome);
    for (const m of this.cache.values()) this._applyRim(m);
    return this;
  }

  /** Re-point every metal at the current prefiltered sky. */
  _bindEnv(tex) {
    if (!tex) return this;
    for (const m of this.cache.values()) {
      if (m.envMap && m.envMap !== tex) { m.envMap = tex; m.needsUpdate = true; }
    }
    return this;
  }

  /** Alias — some rigs call setLighting(). */
  setLighting(payload) { return this.setRim(payload); }

  /**
   * Push the published rim onto one material. A recipe that authored its own
   * rim (crystal, lava, blood) keeps its colour: hero materials are allowed to
   * disagree with the biome constant, everything else follows the rig.
   */
  _applyRim(mat) {
    const U = paintParams(mat);
    if (!U) return mat;
    if (U.uKeyRef) U.uKeyRef.value = this._keyRef();
    const rim = this._rim;
    if (!rim) return mat;
    const ov = mat.userData.paintOverrides || {};
    const cfg = mat.userData.paintConfig || {};
    const isChar = cfg.variant === 'character';
    if (rim.color && !ov.rimColor) U.uRimColor.value.copy(rim.color);
    if (rim.dir && !ov.rimDir) U.uRimDir.value.copy(rim.dir).normalize();
    if (rim.power && !ov.rimPower) U.uRimPower.value = rim.power;
    if (rim.intensity != null && ov.rimStrength == null) {
      const base = isChar ? CHARACTER_LOOK.rimStrength : ENVIRONMENT_LOOK.rimStrength;
      // The old mapping SATURATED at rim.intensity 2.2 (0.45 + 2.2*0.62 = 1.81
      // vs a 1.8 cap), so raising the rig's rim from 2.4 to 5.0 changed nothing
      // at all — which is exactly why the mandated #5fd0ff edge never appeared
      // no matter what the rig authored. Normalise around the reference 2.4 and
      // leave real headroom above it.
      // Headroom raised again with §9.6: the rim is now the frame's designated
      // COMPLEMENT source, and it also has to survive a key that was cut from
      // 52 to 34 (rimE is anchored to uKeyRef, so a smaller key silently makes
      // a smaller rim unless the strength moves the other way).
      const k = Math.min(isChar ? 1.45 : 1.75, Math.max(0.55, rim.intensity / 2.4));
      U.uRimStrength.value = base * k;
    }
    // the grade's AO ink is the same ink the contour should be drawn in
    if (rim.ink && !ov.contourColor) U.uContourColor.value.copy(rim.ink);
    return mat;
  }

  ramp(name) { return RAMPS[name] || RAMPS.ash; }
  color(name, t = 0.7) { const r = RAMPS[name]; return r ? rampAt(r, t) : [1, 0, 1]; }

  // ---- lifecycle ----------------------------------------------------------
  update(dt, ctx) { /* fixed-step sim: nothing to do */ }

  lateUpdate(alpha, ctx) {
    const t = (ctx && ctx.time && ctx.time.t) || 0;
    this._t = t;
    updatePainterly(t);
    // Defensive: if the light rig never called setRim() (stubbed rig, or a
    // different boot order) pull its published constant once, so the rim can
    // never be stale relative to the lighting.
    if (!this._rim && ctx && ctx.lighting && ctx.lighting.rim) {
      const L = ctx.lighting;
      this.setRim({
        color: L.rim.color, dir: L.rim.dir, intensity: L.rim.intensity, power: L.rim.power,
        ink: L.rimUniforms && L.rimUniforms.uInkColor && L.rimUniforms.uInkColor.value,
        biome: L.biome,
      });
    }
    for (const a of this.animated) {
      const c = a.cfg, m = a.mat;
      if (c.scroll) {
        const sx = c.scroll[0] * t, sy = c.scroll[1] * t;
        if (m.map) m.map.offset.set(sx, sy);
        if (m.emissiveMap && m.emissiveMap !== m.map) m.emissiveMap.offset.set(sx * 1.35, sy * 1.35);
        if (m.normalMap) m.normalMap.offset.set(sx * 0.7, sy * 0.7);
      }
      if (c.pulse && a.set.emissiveIntensity) {
        const p = 1 + c.pulse * (Math.sin(t * 1.7) * 0.5 + Math.sin(t * 0.61 + 1.3) * 0.35);
        m.emissiveIntensity = a.set.emissiveIntensity * p;
      }
    }
  }

  dispose() {
    for (const m of this.cache.values()) m.dispose();
    for (const s of this.setCache.values()) {
      if (s.map) s.map.dispose();
      if (s.normalMap) s.normalMap.dispose();
      if (s.ormMap) s.ormMap.dispose();
      if (s.emissiveMap) s.emissiveMap.dispose();
    }
    this.cache.clear(); this.texCache.clear(); this.setCache.clear(); this.animated.length = 0;
  }
}

// biome-specific painterly defaults
function BIOME_PAINT(biome) {
  const B = BIOMES[biome] || BIOMES.tartarus;
  return { rimColor: B.rim, rimDir: B.rimDir, shadowTint: B.shadowTint, contourColor: B.contour };
}

function stableKey(o) {
  if (!o) return '';
  const keys = Object.keys(o).sort();
  let s = '';
  for (const k of keys) {
    const v = o[k];
    s += k + '=' + (v && v.isTexture ? (v.name || v.uuid) : v && v.isColor ? v.getHexString() : Array.isArray(v) ? v.join(',') : String(v)) + ';';
  }
  return s;
}

/** Emergency maps if a recipe ever throws — still painted, never flat grey. */
function fallbackMaps(n, key) {
  const seed = TG.hashString(key) & 0xffff;
  const base = TG.warp2(TG.fbm(n, { freq: 4, octaves: 5, seed }), n, { amp: 0.08, freq: 2, seed: seed + 1 });
  const rgb = TG.applyRamp(base, n, 'stone.tartarus');
  const rough = TG.artisticRoughness(n, { base: 0.75, height: base, variation: 0.2, seed });
  return { rgb, height: base, rough, metal: 0 };
}

export { RECIPES, painterly, setPaint, setBiomeLook };
export default MaterialLibrary;
