// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// EREBUS palette — the authoritative colour tables from docs/ART_DIRECTION.md
// expressed as structured, multi-stop colour RAMPS plus a small colour-science
// kit (sRGB <-> Oklab) so every gradient we author interpolates perceptually
// instead of muddying through grey.
//
// Rule from the bible: colour NEVER comes from lerping two greys. Everything
// reads through a ramp with authored hue movement (warm highlight -> saturated
// mid -> ink/violet shadow).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Raw palette tables (verbatim from ART_DIRECTION.md §2)
// ---------------------------------------------------------------------------

/** Global ink / shadow ramp. Never use pure grey. */
export const INK = {
  void:   '#07060f',
  deep:   '#120b1e',
  plum:   '#241238',
  violet: '#3a1d52',
};

/** Gold / bronze — the ornament spine of the whole game. */
export const GOLD = {
  highlight: '#ffe9a8',
  core:      '#f2c14e',
  mid:       '#c98f2b',
  shadow:    '#6d4416',
  verdigris: '#3f8f7a',
};

/** Biome 1 — crimson stone, bone, blood. */
export const TARTARUS = {
  key:        '#ff5a3c',
  stoneLight: '#8c3b46',
  stoneMid:   '#5a2331',
  stoneDark:  '#2c1020',
  rim:        '#5fd0ff',
  blood:      '#c81d3c',
};

/** Biome 2 — obsidian isles on a lava sea. */
export const ASPHODEL = {
  lavaCore:      '#fff0b0',
  lavaHot:       '#ff8c1a',
  lavaDeep:      '#c22a06',
  obsidianLight: '#2a2740',
  obsidianDark:  '#0d0b18',
  rim:           '#33e0c0',
};

/** Biome 3 — marble, laurel, gold, verdant. */
export const ELYSIUM = {
  key:          '#ffe6a3',
  marbleLight:  '#efe3cf',
  marbleShadow: '#8a7f9c',
  verdant:      '#3fa86a',
  deepGreen:    '#14402f',
  rim:          '#ff5fa8',
};

/** God / boon identity colours. */
export const GODS = {
  zeus:      '#ffe14d',
  poseidon:  '#3fb8ff',
  athena:    '#c9b8ff',
  aphrodite: '#ff6fae',
  ares:      '#e01f2d',
  artemis:   '#7ee06a',
  dionysus:  '#a05fe0',
  hermes:    '#ff9a3c',
  hecate:    '#8ef0d0',
  selene:    '#dfe9ff',
};

// ---------------------------------------------------------------------------
// 2. Colour science — sRGB <-> linear <-> Oklab
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  if (typeof hex !== 'string') {
    if (Array.isArray(hex)) return [hex[0], hex[1], hex[2]];
    return [1, 0, 1];
  }
  let h = hex.trim();
  if (h[0] === '#') h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [1, 0, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r, g, b) {
  const c = (v) => {
    const x = Math.round(Math.max(0, Math.min(1, v)) * 255);
    return x < 16 ? '0' + x.toString(16) : x.toString(16);
  };
  return '#' + c(r) + c(g) + c(b);
}

export const srgbToLinear = (c) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
export const linearToSrgb = (c) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

const cbrt = Math.cbrt || ((x) => Math.sign(x) * Math.pow(Math.abs(x), 1 / 3));

/** sRGB (0..1, gamma) -> Oklab */
export function srgbToOklab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const l = cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Oklab -> sRGB (0..1, gamma), clipped */
export function oklabToSrgb(L, A, B) {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.2914855480 * B;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [
    Math.max(0, Math.min(1, linearToSrgb(r))),
    Math.max(0, Math.min(1, linearToSrgb(g))),
    Math.max(0, Math.min(1, linearToSrgb(b))),
  ];
}

/** Perceptual mix of two sRGB hex/array colours. Returns [r,g,b] 0..1 sRGB. */
export function mixOklab(a, b, t) {
  const A = Array.isArray(a) ? a : hexToRgb(a);
  const B = Array.isArray(b) ? b : hexToRgb(b);
  const la = srgbToOklab(A[0], A[1], A[2]);
  const lb = srgbToOklab(B[0], B[1], B[2]);
  return oklabToSrgb(
    la[0] + (lb[0] - la[0]) * t,
    la[1] + (lb[1] - la[1]) * t,
    la[2] + (lb[2] - la[2]) * t,
  );
}

/** Shift a colour's chroma/lightness. amount>1 = more saturated. */
export function saturate(color, amount = 1.2, lift = 0) {
  const c = Array.isArray(color) ? color : hexToRgb(color);
  const [L, A, B] = srgbToOklab(c[0], c[1], c[2]);
  return oklabToSrgb(Math.max(0, L + lift), A * amount, B * amount);
}

// ---------------------------------------------------------------------------
// 3. Ramps
// ---------------------------------------------------------------------------
// A ramp is an ordered array of { t, c } stops (t in 0..1, c a hex string) plus
// an optional easing exponent between stops. Evaluation is done in Oklab.

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Evaluate a ramp at t (0..1). Returns [r,g,b] in gamma sRGB 0..1.
 * `ease`: 'smooth' (default) | 'linear' | 'hard'
 */
export function rampAt(stops, t, ease = 'smooth') {
  const n = stops.length;
  if (n === 0) return [1, 0, 1];
  if (t <= stops[0].t) return hexToRgb(stops[0].c);
  if (t >= stops[n - 1].t) return hexToRgb(stops[n - 1].c);
  let i = 0;
  while (i < n - 2 && t > stops[i + 1].t) i++;
  const a = stops[i], b = stops[i + 1];
  let k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  if (ease === 'smooth') k = smooth(k);
  else if (ease === 'hard') k = k < 0.5 ? 0 : 1;
  return mixOklab(a.c, b.c, k);
}

/**
 * Bake a ramp into a Uint8ClampedArray LUT of `size` sRGB triplets.
 * This is the fast path used per-texel by texgen.
 */
export function rampLUT(stops, size = 256, ease = 'smooth') {
  const out = new Uint8ClampedArray(size * 3);
  for (let i = 0; i < size; i++) {
    const c = rampAt(stops, i / (size - 1), ease);
    out[i * 3] = c[0] * 255;
    out[i * 3 + 1] = c[1] * 255;
    out[i * 3 + 2] = c[2] * 255;
  }
  return out;
}

const S = (t, c) => ({ t, c });

/**
 * The authored material ramps. Every one of these moves in HUE as well as
 * value: shadows drift toward ink/plum, highlights drift warm.
 */
export const RAMPS = {
  // ---- Tartarus: blood-dark carved stone -----------------------------------
  'stone.tartarus': [
    S(0.00, '#0b0410'), S(0.16, '#1f0b18'), S(0.34, '#33121f'),
    S(0.52, '#451a26'), S(0.70, '#5c2430'), S(0.85, '#6e2e37'),
    // §2 puts Tartarus "stone light" at #8c3b46. The old top stops (#8b4f4c /
    // #ad7d6c) were a desaturated putty, and under a warm key that is exactly
    // what reads as PINK CHALK — the single-hue-family failure §9.6 bans, but
    // caused by the albedo rather than by the light.
    S(0.94, '#8c3b46'), S(1.00, '#a1595c'),
  ],
  // cool glaze pass — mixed against the warm ramp for hue variety
  'stone.tartarus.cool': [
    S(0.00, '#06060c'), S(0.20, '#0f0e1a'), S(0.42, '#191a2a'),
    S(0.64, '#262b3c'), S(0.82, '#39434f'), S(0.94, '#556069'),
    S(1.00, '#7b858a'),
  ],
  // §2 two-hue rule. The warm crimson ramp alone put every large surface on one
  // magenta-to-orange axis with no complement anywhere in the frame. The floor's
  // cool glaze is now a blue-slate that belongs to the same family as the
  // mandated #5fd0ff accent, so the ground plane itself carries the cold note.
  // §9.1 THE VALUE LAW: a Hades flagstone sits at 0.10-0.16 DISPLAY luma with a
  // key on it, which puts its albedo far lower than any of these stops used to
  // sit. The cool glaze keeps the two-hue structure §2 asks for; it just no
  // longer reaches slate-grey mid values that a strong key can push to 0.30.
  'floor.tartarus.cool': [
    S(0.00, '#04050b'), S(0.20, '#080c13'), S(0.42, '#0e1720'),
    S(0.62, '#16242e'), S(0.80, '#1f333c'), S(0.93, '#2d444d'),
    S(1.00, '#40575f'),
  ],
  // VALUE, NOT JUST HUE. The old ramp centred near #210e18 — about 1% linear
  // reflectance. No light rig can pull a 1%-albedo floor up to the 0.34-0.42
  // display luma §1.1 needs for the foreground band, so the frame was condemned
  // to one flat dark plane before a single light was placed. Re-centred on §2's
  // Stone mid #5a2331 with the ink ramp still owning the bottom two stops.
  // VALUE, NOT JUST HUE — and the correction runs the other way now. The
  // previous re-centring on §2's Stone mid #5a2331 was reasoning about ALBEDO
  // in isolation; with a 34-unit key at 38deg on a 100%-up-facing plane it
  // produced a ground plane measuring 0.31 display luma against a frame median
  // of 0.19 (§9.1 requires < 0.18, and BELOW the frame median). The floor is a
  // DARK STAGE: these stops are ~40% down and the top stop no longer reaches a
  // value the architecture has to compete with. The lit look is bought back
  // where §9.5 wants it — on edges, trim and emissives.
  // Warmer and slightly richer: a stone that owns a red-brown identity reads as stone under any
  // light, where a near-neutral plum just becomes whatever colour is shining on it.
  'floor.tartarus': [
    S(0.00, '#0d0710'), S(0.18, '#1b0e15'), S(0.38, '#2b151c'),
    S(0.58, '#3e1f26'), S(0.76, '#552b31'), S(0.90, '#6b3a3c'),
    S(0.97, '#7d4747'), S(1.00, '#8d5654'),
  ],

  // The column shafts are a DIFFERENT stone from the wall: quarried paler, less
  // blood-stained, drifting cooler as it rises. One material for the whole
  // building is what made the arch, the columns, the frieze and the wall read as
  // the same brown-violet substance (§1.5).
  'stone.tartarus.column': [
    S(0.00, '#100a18'), S(0.16, '#241723'), S(0.34, '#3b2530'),
    S(0.52, '#54343c'), S(0.70, '#6e4749'), S(0.85, '#7d4d4c'),
    // still a PALER stone than the wall (§1.5 material hierarchy) — just not a
    // near-neutral putty that the key can only turn salmon.
    S(0.94, '#96685e'), S(1.00, '#b08578'),
  ],
  'stone.tartarus.column.cool': [
    S(0.00, '#0a0b14'), S(0.20, '#151824'), S(0.42, '#242a38'),
    S(0.64, '#36404e'), S(0.82, '#4d5a66'), S(0.94, '#6c7a84'),
    S(1.00, '#93a0a6'),
  ],

  // ---- Asphodel: obsidian + lava ------------------------------------------
  obsidian: [
    S(0.00, '#050510'), S(0.22, '#0d0b18'), S(0.44, '#181a2e'),
    S(0.64, '#2a2740'), S(0.80, '#3d3a5c'), S(0.92, '#57527e'),
    S(1.00, '#8b84b4'),
  ],
  'obsidian.sheen': [
    S(0.00, '#06070f'), S(0.30, '#101a2c'), S(0.55, '#1c2f4a'),
    S(0.78, '#2b4a63'), S(1.00, '#4f7d92'),
  ],
  lava: [
    S(0.00, '#1c0400'), S(0.16, '#4d0d02'), S(0.32, '#8d1a04'),
    S(0.48, '#c22a06'), S(0.64, '#f2500c'), S(0.78, '#ff8c1a'),
    S(0.90, '#ffc96a'), S(1.00, '#fff0b0'),
  ],
  'floor.asphodel': [
    S(0.00, '#050510'), S(0.24, '#0f0d1c'), S(0.48, '#191830'),
    S(0.70, '#262444'), S(0.86, '#3a3660'), S(1.00, '#5f5a8a'),
  ],

  // ---- Elysium: marble, gold, verdant --------------------------------------
  'marble.elysium': [
    S(0.00, '#6d6383'), S(0.18, '#8a7f9c'), S(0.36, '#b3a8ae'),
    S(0.54, '#d4c6bd'), S(0.72, '#e6d9c8'), S(0.86, '#efe3cf'),
    S(0.95, '#f8efdd'), S(1.00, '#fffaf0'),
  ],
  'marble.vein': [
    S(0.00, '#4b4361'), S(0.35, '#6d6383'), S(0.70, '#9a8fa6'), S(1.00, '#c3b6b8'),
  ],
  'floor.elysium': [
    S(0.00, '#6a6080'), S(0.20, '#8f8496'), S(0.42, '#bfb2ad'),
    S(0.62, '#d9cbb9'), S(0.80, '#e9dcc6'), S(0.92, '#f3e8d4'),
    S(1.00, '#fdf5e6'),
  ],
  verdant: [
    S(0.00, '#0a1f16'), S(0.28, '#14402f'), S(0.55, '#246f4c'),
    S(0.78, '#3fa86a'), S(0.92, '#79cf90'), S(1.00, '#c6efc4'),
  ],

  // ---- Metals ---------------------------------------------------------------
  gold: [
    S(0.00, '#20120a'), S(0.16, '#43280d'), S(0.32, '#6d4416'),
    S(0.50, '#a9721f'), S(0.68, '#c98f2b'), S(0.83, '#f2c14e'),
    S(0.94, '#ffe9a8'), S(1.00, '#fff9e4'),
  ],
  bronze: [
    S(0.00, '#170d06'), S(0.24, '#3a2410'), S(0.48, '#6d4416'),
    S(0.70, '#96652a'), S(0.88, '#c08a3e'), S(1.00, '#e2b673'),
  ],
  verdigris: [
    S(0.00, '#0a1c18'), S(0.24, '#15352d'), S(0.48, '#235448'),
    S(0.70, '#3f8f7a'), S(0.86, '#63b79c'), S(1.00, '#a2ddc8'),
  ],
  'iron.dark': [
    S(0.00, '#08070c'), S(0.22, '#141219'), S(0.44, '#221f2a'),
    S(0.66, '#332e3d'), S(0.84, '#4f4859'), S(0.95, '#786f86'),
    S(1.00, '#a49bb2'),
  ],

  // ---- Organics -------------------------------------------------------------
  bone: [
    S(0.00, '#231a16'), S(0.20, '#4a3d31'), S(0.42, '#7d6c53'),
    S(0.62, '#ab9878'), S(0.80, '#d0bf9c'), S(0.92, '#e8dcc0'),
    S(1.00, '#f7f1e0'),
  ],
  'bone.cool': [
    S(0.00, '#1e1a18'), S(0.22, '#403a34'), S(0.46, '#6e6559'),
    S(0.66, '#9b9080'), S(0.84, '#c2b7a3'), S(1.00, '#e6dcc8'),
  ],
  blood: [
    S(0.00, '#180209'), S(0.20, '#380611'), S(0.40, '#5f0c1c'),
    S(0.60, '#8e1327'), S(0.78, '#c81d3c'), S(0.90, '#e14257'),
    S(1.00, '#ff8a90'),
  ],
  'wood.dark': [
    S(0.00, '#0f0805'), S(0.20, '#221409'), S(0.42, '#3a2416'),
    S(0.64, '#523320'), S(0.82, '#71492b'), S(0.94, '#9a6b43'),
    S(1.00, '#c39a6c'),
  ],
  'banner.crimson': [
    S(0.00, '#1c0209'), S(0.20, '#3f0713'), S(0.42, '#6d0d1f'),
    S(0.62, '#8c1128'), S(0.80, '#b02138'), S(0.92, '#cf4a58'),
    S(1.00, '#ef9a9a'),
  ],

  // ---- Exotic ---------------------------------------------------------------
  'crystal.violet': [
    S(0.00, '#0b0216'), S(0.22, '#22073c'), S(0.44, '#3f1069'),
    S(0.64, '#6320b4'), S(0.82, '#8f45d8'), S(0.93, '#bd85ef'),
    S(1.00, '#eddcff'),
  ],
  'water.styx': [
    S(0.00, '#02070a'), S(0.22, '#051312'), S(0.44, '#0a211f'),
    S(0.64, '#10322c'), S(0.80, '#1a4a3e'), S(0.92, '#2f7460'),
    S(1.00, '#6ab79f'),
  ],
  ash: [
    S(0.00, '#0b0910'), S(0.28, '#181521'), S(0.55, '#2a2434'),
    S(0.78, '#413a4d'), S(1.00, '#6b6178'),
  ],
};

// ---------------------------------------------------------------------------
// 4. Biome look table — consumed by painterly.js and available to any system
// ---------------------------------------------------------------------------

export const BIOMES = {
  tartarus: {
    key:        TARTARUS.key,
    keyDir:     [0.42, 0.78, 0.46],
    rim:        TARTARUS.rim,      // cyan complement of the crimson key
    rimDir:     [-0.62, 0.34, 0.70],
    shadow:     INK.plum,
    shadowTint: [0.72, 0.60, 1.14],
    contour:    '#2a0f2e',
    fog:        '#150b20',
    bounce:     TARTARUS.stoneMid,
    accent:     TARTARUS.blood,
  },
  asphodel: {
    key:        ASPHODEL.lavaHot,
    keyDir:     [0.30, 0.66, 0.69],
    rim:        ASPHODEL.rim,      // teal
    rimDir:     [-0.66, 0.32, 0.68],
    shadow:     ASPHODEL.obsidianDark,
    shadowTint: [0.62, 0.72, 1.20],
    contour:    '#101a2e',
    fog:        '#120a16',
    bounce:     ASPHODEL.lavaDeep,
    accent:     ASPHODEL.lavaCore,
  },
  elysium: {
    key:        ELYSIUM.key,
    keyDir:     [0.50, 0.72, 0.48],
    rim:        ELYSIUM.rim,       // magenta / rose
    rimDir:     [-0.58, 0.40, 0.71],
    shadow:     ELYSIUM.marbleShadow,
    shadowTint: [0.86, 0.78, 1.10],
    contour:    '#3a2a52',
    fog:        '#1a1626',
    bounce:     ELYSIUM.verdant,
    accent:     GOLD.core,
  },
};

/** Look up a god colour tolerantly (case/space insensitive). */
export function godColor(name, fallback = GOLD.core) {
  if (!name) return fallback;
  const k = String(name).toLowerCase().replace(/[^a-z]/g, '');
  return GODS[k] || fallback;
}

/** All raw tables in one bag for systems that want to introspect. */
export const PALETTE = { INK, GOLD, TARTARUS, ASPHODEL, ELYSIUM, GODS, RAMPS, BIOMES };
export default PALETTE;
