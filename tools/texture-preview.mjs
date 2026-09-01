// OWNER: AGENT-ENVTEX
// ---------------------------------------------------------------------------
// texture-preview.mjs — render every generated environment surface to a PNG so
// a human (or a grader) can actually LOOK at the material system instead of
// reading numbers about it.
//
//     node tools/texture-preview.mjs                  # docs/texture-preview/
//     node tools/texture-preview.mjs --size 384       # bake resolution (default 176)
//     node tools/texture-preview.mjs --only floor.tartarus,marble.elysium
//     node tools/texture-preview.mjs --out some/dir
//
// Each surface gets one 4x2-panel sheet:
//
//   +---------------------------+----------+----------+
//   |                           |  ALBEDO  |  NORMAL  |
//   |   LIT, TILED 2x2          +----------+----------+
//   |   (the money shot)        | ROUGHNESS|    AO    |
//   +---------------------------+----------+----------+
//
// The lit panel is deliberately tiled 2x2: a seam, a repeating blotch or a
// lattice that survives the de-tiler shows up there and nowhere else. It is
// shaded with a small stand-in for the game's painterly model — a warm key, a
// cool fill, a soft terminator ramp, a cyan art-directed rim and the material's
// own emissive — because judging a normal map, a roughness map and an AO map by
// looking at them as greyscale images is not a thing anyone can do.
//
// No dependencies: the PNG encoder is tools/png.mjs, already in the repo.
// ---------------------------------------------------------------------------

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.mjs';
import { bakeSet, RECIPES, recipeSize } from '../src/materials/recipes.js';
import { ENV_SET } from '../scripts/test-textures-quality.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SIZE = Number(arg('--size', 176)) | 0;
const OUT = arg('--out', fileURLToPath(new URL('../docs/texture-preview/', import.meta.url)));
const only = arg('--only', null);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const lin2srgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// ---------------------------------------------------------------------------
// A compact stand-in for materials/painterly.js: a warm key, a cool hemisphere
// fill, a two-step terminator ramp, a GGX-ish specular whose width follows the
// roughness map, an art-directed cyan rim and the ink floor. Not the shipping
// shader — enough of it that a change to a normal, roughness or AO map is
// visible here in the same direction it will be visible in the frame.
// ---------------------------------------------------------------------------
// The key is a WARM WHITE rather than the biome's saturated #ff5a3c: this is a
// material reference render, and a key that saturated turns every surface in
// every biome the same orange, which is the one thing a comparison sheet must
// not do. The warm/cool separation the shipping rig relies on is kept — it is
// just carried by the key/fill CONTRAST rather than by a single hue.
const KEY = [1.00, 0.86, 0.74], KEY_I = 2.15;
const FILL = [0.40, 0.48, 0.80], FILL_I = 0.40;      // cool sky bounce
const RIM = [0.37, 0.81, 1.00], RIM_I = 0.55;        // #5fd0ff
const INKF = [0.16, 0.08, 0.26], INK_I = 0.05;       // shadow plum floor
const L = (() => { const v = [0.42, 0.78, 0.46]; const m = Math.hypot(...v); return v.map(c => c / m); })();
const V = [0, 0.62, 0.78];
const H = (() => { const v = [L[0] + V[0], L[1] + V[1], L[2] + V[2]]; const m = Math.hypot(...v); return v.map(c => c / m); })();
const RD = (() => { const v = [-0.62, 0.34, 0.70]; const m = Math.hypot(...v); return v.map(c => c / m); })();

function ramp(k) {
  // painterly.js paintRampCurve, with its shipping steps/levels
  const s = 0.16;
  const a = clamp01((k - (0.30 - s)) / (2 * s)); const as = a * a * (3 - 2 * a);
  const b = clamp01((k - (0.68 - s)) / (s * 2.4)); const bs = b * b * (3 - 2 * b);
  return (0.05 + (0.55 - 0.05) * as) * (1 - bs) + 1.0 * bs;
}

function shade(alb, nx, ny, nz, rough, ao, em) {
  const nl = nx * L[0] + ny * L[1] + nz * L[2];
  const nh = Math.max(0, nx * H[0] + ny * H[1] + nz * H[2]);
  const nv = Math.max(0.04, nx * V[0] + ny * V[1] + nz * V[2]);
  // soft, ramped terminator instead of a hard N.L
  const wrapped = clamp01(nl * 0.5 + 0.5);
  const lit = ramp(wrapped);
  const a2 = Math.max(1e-3, rough * rough * rough * rough);
  const d = (nh * nh * (a2 - 1) + 1);
  const spec = Math.min(6, a2 / (Math.PI * d * d + 1e-6)) * Math.max(0, nl) * 0.055;
  // rim: a wide fresnel gated so it draws an edge, not a wash
  const fres = Math.pow(1 - nv, 2.4);
  const gate = clamp01((nx * RD[0] + ny * RD[1] + nz * RD[2] + 0.40) / 0.98);
  const rim = fres * gate * RIM_I;
  const up = clamp01(ny * 0.5 + 0.5);
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    // shadow is a HUE, not an absence: the fill is cool and the ink floor plum
    const diffuse = alb[c] * (KEY[c] * KEY_I * lit + FILL[c] * FILL_I * (0.35 + 0.65 * up) * ao);
    const dead = clamp01(1 - (lit * 2.2 + ao * 0.5));
    out[c] = diffuse + spec * KEY[c] * KEY_I * (0.25 + 0.75 * (1 - rough))
      + rim * RIM[c] + INKF[c] * INK_I * dead + em[c];
  }
  return out;
}

// AgX-ish shoulder so bright emissives roll off instead of clipping flat
const tone = (x) => { const a = x * (2.51 * x + 0.03), b = x * (2.43 * x + 0.59) + 0.14; return clamp01(a / b); };

function drawPanel(dst, W, ox, oy, w, h, sample) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = sample(x, y);
      const i = ((oy + y) * W + ox + x) * 4;
      dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = 255;
    }
  }
}

function label(dst, W, ox, oy, text, bright = 235) {
  // 3x5 pixel font, scaled 2x — enough to name a panel without a font file
  const F = {
    A: '111101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
    E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
    I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '101111111111101', O: '010101101101010', P: '110101110100100',
    Q: '010101101111011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101011', V: '101101101010010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111', '0': '010101101101010', '1': '010110010010111',
    '2': '110001010100111', '3': '110001010001110', '4': '101101111001001', '5': '111100110001110',
    '6': '011100110101010', '7': '111001010010010', '8': '010101010101010', '9': '010101011001110',
    '.': '000000000000010', '-': '000000111000000', ' ': '000000000000000', '/': '001001010100100',
  };
  const S = 2;
  let cx = ox;
  for (const ch of text.toUpperCase()) {
    const g = F[ch] || F[' '];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) {
      if (g[r * 3 + c] !== '1') continue;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const px = cx + c * S + sx, py = oy + r * S + sy;
        const i = (py * W + px) * 4;
        if (i < 0 || i + 3 >= dst.length) continue;
        dst[i] = bright; dst[i + 1] = bright; dst[i + 2] = bright; dst[i + 3] = 255;
      }
    }
    cx += 4 * S;
  }
}

function sheet(key, n) {
  const b = bakeSet(key, n);
  if (!b) return null;
  const T = n;
  const W = T * 4, Hh = T * 2;
  const px = Buffer.alloc(W * Hh * 4, 0);
  const map = b.map, nm = b.normalMap, orm = b.ormMap, emm = b.emissiveMap;
  const eI = b.emissiveIntensity || 0;

  // --- lit, tiled 2x2 (the panel that exposes seams and repetition) --------
  drawPanel(px, W, 0, 0, T * 2, T * 2, (x, y) => {
    const sx = x % T, sy = y % T, i = sy * T + sx, j = i * 4;
    const alb = [SRGB2LIN[map[j]], SRGB2LIN[map[j + 1]], SRGB2LIN[map[j + 2]]];
    let nx = nm[j] / 127.5 - 1, nz = nm[j + 1] / 127.5 - 1, ny = nm[j + 2] / 127.5 - 1;
    // the tangent frame here is a flat ground plane: +Y up, so the normal map's
    // green channel drives Z and its blue drives Y
    const ml = 1 / Math.max(1e-4, Math.hypot(nx, ny, nz));
    nx *= ml; ny *= ml; nz *= ml;
    const ao = orm[j] / 255, rough = Math.max(0.045, orm[j + 1] / 255);
    const em = emm
      ? [SRGB2LIN[emm[j]] * eI, SRGB2LIN[emm[j + 1]] * eI, SRGB2LIN[emm[j + 2]] * eI]
      : [0, 0, 0];
    const c = shade(alb, nx, ny, nz, rough, ao, em);
    return [tone(c[0]) * 255, tone(c[1]) * 255, tone(c[2]) * 255];
  });

  // --- the four raw channels ----------------------------------------------
  const chan = (buf, o, gain = 1) => (x, y) => {
    const j = (y * T + x) * 4;
    const v = Math.min(255, buf[j + o] * gain);
    return [v, v, v];
  };
  drawPanel(px, W, T * 2, 0, T, T, (x, y) => {
    const j = (y * T + x) * 4;
    return [map[j], map[j + 1], map[j + 2]];
  });
  drawPanel(px, W, T * 3, 0, T, T, (x, y) => {
    const j = (y * T + x) * 4;
    return [nm[j], nm[j + 1], nm[j + 2]];
  });
  drawPanel(px, W, T * 2, T, T, T, chan(orm, 1));   // roughness
  drawPanel(px, W, T * 3, T, T, T, chan(orm, 0));   // ao

  label(px, W, 8, 8, key);
  label(px, W, T * 2 + 6, 6, 'albedo');
  label(px, W, T * 3 + 6, 6, 'normal');
  label(px, W, T * 2 + 6, T + 6, 'roughness');
  label(px, W, T * 3 + 6, T + 6, 'occlusion');
  label(px, W, 8, T * 2 - 20, 'lit / tiled 2x2', 200);
  return { png: encodePNG({ width: W, height: Hh, data: px }), W, H: Hh, buf: px };
}

// ---------------------------------------------------------------------------
let keys = only ? only.split(',').map(s => s.trim()) : ENV_SET;
keys = keys.filter(k => RECIPES[k]);
mkdirSync(OUT, { recursive: true });

const thumbs = [];
for (const k of keys) {
  const n = Math.min(SIZE, recipeSize(k));
  const t0 = Date.now();
  const r = sheet(k, n);
  if (!r) continue;
  const file = `${OUT}/${k.replace(/\./g, '_')}.png`;
  writeFileSync(file, r.png);
  // keep the lit quadrant for the contact sheet
  thumbs.push({ key: k, n, buf: r.buf, W: r.W });
  console.log(`${k.padEnd(26)} ${n}px  ${Date.now() - t0}ms  -> ${file.split('/').slice(-2).join('/')}`);
}

// --- contact sheet of every lit preview, 4 across -------------------------
if (thumbs.length) {
  const TH = 176, COLS = 4;
  const rowsN = Math.ceil(thumbs.length / COLS);
  const CW = TH * COLS, CH = TH * rowsN;
  const px = Buffer.alloc(CW * CH * 4, 0);
  for (let t = 0; t < thumbs.length; t++) {
    const { buf, W, n } = thumbs[t];
    const ox = (t % COLS) * TH, oy = ((t / COLS) | 0) * TH;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TH; x++) {
      // the lit panel is 2n x 2n at the origin of the sheet
      const sx = Math.min(2 * n - 1, ((x / TH) * 2 * n) | 0);
      const sy = Math.min(2 * n - 1, ((y / TH) * 2 * n) | 0);
      const s = (sy * W + sx) * 4, d = ((oy + y) * CW + ox + x) * 4;
      px[d] = buf[s]; px[d + 1] = buf[s + 1]; px[d + 2] = buf[s + 2]; px[d + 3] = 255;
    }
    label(px, CW, ox + 5, oy + 5, thumbs[t].key);
  }
  const f = `${OUT}/_contact-sheet.png`;
  writeFileSync(f, encodePNG({ width: CW, height: CH, data: px }));
  console.log(`\ncontact sheet -> ${f}`);
}
