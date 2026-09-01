// OWNER: AGENT-ENVTEX
// ---------------------------------------------------------------------------
// test-textures-quality.mjs — OBJECTIVE quality metrics for the generated
// environment surfaces.  Run directly:
//
//     node scripts/test-textures-quality.mjs                 # the env set
//     node scripts/test-textures-quality.mjs --all           # every recipe
//     node scripts/test-textures-quality.mjs --size 384      # bake resolution
//     node scripts/test-textures-quality.mjs --json out.json # machine readable
//     node scripts/test-textures-quality.mjs --only stone.tartarus,floor.elysium
//
// It is NOT wired into package.json (this agent does not own that file), so it
// is invoked by path.  It bakes each recipe through the real `bakeSet()` path —
// the same code the worker pool runs — and measures the bytes that come out.
//
// WHAT EACH COLUMN MEANS, and why it is the right thing to measure for a
// PAINTERLY surface rather than a photographic one:
//
//   Lsd    stdev of albedo luminance.  A flat recolour of one noise field has a
//          low Lsd; a surface with real value structure (mortar, chips, glaze)
//          has a high one.  This is §9's "value first" made countable.
//   Ent    entropy of the 64-bin luminance histogram, in bits (max 6).  Lsd can
//          be bought cheaply with two flat tones; entropy cannot — it only goes
//          up when the surface occupies the whole value range CONTINUOUSLY.
//   LC     local contrast: mean |L - blur3(L)| x1000.  Detail the eye reads at
//          close range, independent of the broad value composition.
//   F/M/C  Laplacian-pyramid band energy (RMS x1000) at fine / mid / coarse
//          scales.  A good hand-painted surface has energy at ALL THREE: grain,
//          brushwork, and composition.  Procedural noise usually has one hump.
//   Chr    mean chroma (max-min channel) x1000.  "Shadow is a different colour,
//          never neutral grey" is only true if there IS chroma.
//   Chsd   stdev of chroma x1000 — hue/saturation VARIATION, i.e. whether the
//          surface was painted with more than one pigment.
//   Seam   tiling-seam error: mean |wrap-edge difference| divided by the mean
//          |interior adjacent difference|.  1.00 = the wrap edge is
//          statistically indistinguishable from anywhere else in the texture.
//          >1.3 is a visible seam line.
//   Rlf    relief: mean |xy| of the normal map x1000.  0 = a flat albedo-only
//          material pretending to be PBR.
//   Rsd    roughness stdev x1000 — a constant-roughness surface reads plastic.
//   AOd    AO depth: 1 - p05 of the AO channel, x1000.  0 = no occlusion map.
//   Rep    PERIODICITY: the largest normalised autocorrelation of the value
//          field at a 1/2, 1/3 or 1/4 texture offset (both axes and the
//          diagonal).  The Seam metric is blind to this BY CONSTRUCTION — it
//          only ever looks at the wrap column — so a texture whose content
//          repeats twice inside itself scores a perfect seam and still reads
//          as an obvious lattice the moment it is laid across a floor.  A
//          field with independent content at those offsets sits near 0; 1.0
//          would be an exact internal repeat.  Ornamented surfaces (a laurel
//          band, a bead row, a woven banner) are periodic BY DESIGN and are
//          exempted by name below rather than by fudging the threshold.
//   Em     fraction of texels with a non-zero emissive.
// ---------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { bakeSet, RECIPES, recipeSize } from '../src/materials/recipes.js';

// ---------------------------------------------------------------------------
// The environment set: the surfaces a player stands on, walks past, or fights
// in front of.  Characters, rigs and UI atlases are deliberately excluded.
// ---------------------------------------------------------------------------
export const ENV_SET = [
  'floor.tartarus', 'stone.tartarus', 'stone.tartarus.bay',
  'stone.tartarus.column', 'stone.tartarus.arch', 'rubble.tartarus',
  'medallion.tartarus',
  'stone.asphodel', 'stone.asphodel.column', 'stone.asphodel.arch',
  'floor.asphodel', 'obsidian', 'rubble.asphodel', 'lava',
  'marble.elysium', 'marble.elysium.column', 'marble.elysium.arch', 'floor.elysium',
  'bone', 'wood.dark', 'iron.dark', 'bronze.verdigris',
  'gold.filigree', 'crystal.violet', 'blood.pool', 'water.styx', 'banner.crimson',
];

const SRGB2LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// --- small field helpers ---------------------------------------------------
const mean = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i]; return s / f.length; };
const sd = (f) => { const m = mean(f); let s = 0; for (let i = 0; i < f.length; i++) { const d = f[i] - m; s += d * d; } return Math.sqrt(s / f.length); };

/** wrapped 3x3 box blur (separable) */
function box3(f, n) {
  const a = new Float32Array(n * n), b = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const r = y * n;
    for (let x = 0; x < n; x++) {
      a[r + x] = (f[r + (x === 0 ? n - 1 : x - 1)] + f[r + x] + f[r + (x === n - 1 ? 0 : x + 1)]) / 3;
    }
  }
  for (let y = 0; y < n; y++) {
    const r = y * n, u = (y === 0 ? n - 1 : y - 1) * n, d = (y === n - 1 ? 0 : y + 1) * n;
    for (let x = 0; x < n; x++) b[r + x] = (a[u + x] + a[r + x] + a[d + x]) / 3;
  }
  return b;
}

/** wrapped 2x box downsample */
function down2(f, n) {
  const h = n >> 1, o = new Float32Array(h * h);
  for (let y = 0; y < h; y++) {
    const r0 = (y * 2) * n, r1 = (y * 2 + 1) * n, r = y * h;
    for (let x = 0; x < h; x++) {
      const x0 = x * 2, x1 = x * 2 + 1;
      o[r + x] = (f[r0 + x0] + f[r0 + x1] + f[r1 + x0] + f[r1 + x1]) * 0.25;
    }
  }
  return o;
}
/** wrapped 2x bilinear upsample */
function up2(f, h) {
  const n = h * 2, o = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const sy = y * 0.5 - 0.25;
    let y0 = Math.floor(sy); const fy = sy - y0;
    y0 = ((y0 % h) + h) % h; const y1 = (y0 + 1) % h;
    const r0 = y0 * h, r1 = y1 * h, r = y * n;
    for (let x = 0; x < n; x++) {
      const sx = x * 0.5 - 0.25;
      let x0 = Math.floor(sx); const fx = sx - x0;
      x0 = ((x0 % h) + h) % h; const x1 = (x0 + 1) % h;
      const a = f[r0 + x0], b = f[r0 + x1], c = f[r1 + x0], d = f[r1 + x1];
      const ab = a + (b - a) * fx, cd = c + (d - c) * fx;
      o[r + x] = ab + (cd - ab) * fy;
    }
  }
  return o;
}

/** Laplacian-pyramid band RMS at `levels` octaves. */
function bands(f, n, levels = 3) {
  const out = [];
  let cur = f, res = n;
  for (let l = 0; l < levels && res >= 16; l++) {
    const lo = down2(cur, res);
    const back = up2(lo, res >> 1);
    let s = 0;
    for (let i = 0; i < cur.length; i++) { const d = cur[i] - back[i]; s += d * d; }
    out.push(Math.sqrt(s / cur.length));
    cur = lo; res >>= 1;
  }
  while (out.length < levels) out.push(0);
  return out;
}

/** Shannon entropy of a 64-bin histogram, in bits. */
function entropy(f, bins = 64) {
  const h = new Float64Array(bins);
  for (let i = 0; i < f.length; i++) {
    let b = (f[i] * bins) | 0; if (b < 0) b = 0; if (b >= bins) b = bins - 1;
    h[b]++;
  }
  let e = 0;
  for (let i = 0; i < bins; i++) { const p = h[i] / f.length; if (p > 0) e -= p * Math.log2(p); }
  return e;
}

/**
 * SEAM ERROR.  Every operator in texgen is supposed to be toroidal, so the
 * wrap edge should be no more discontinuous than any other pixel column.  The
 * ratio normalises out how contrasty the texture is in the first place.
 */
function seamRatio(f, n) {
  // ── HOW TO MEASURE A TILING SEAM ON A STRUCTURED TEXTURE ──────────────────
  // The naive test — "is the wrap difference bigger than the average
  // difference?" — is useless here, and both of the obvious refinements are
  // worse. Every one of these surfaces is deliberately built out of CELLS
  // (flagstones, voussoirs, prisms, marble tiles), each of which reads its own
  // rotated patch of grain, so there is a real value step at every joint. If
  // the wrap happens to fall in a joint — and on a grid of 15 voussoirs it
  // usually does — a local-gradient baseline reports that intended step as a
  // tear, because the mortar either side of it is flat.
  //
  // So compare like with like. D(k) is the mean absolute difference between
  // column k-1 and column k over the whole texture; D(0) is the wrap. If the
  // wrap is a joint, D(0) simply takes its place among the other joints, and
  // the ratio against a high percentile of D lands near 1. A genuine tear —
  // content that does not meet — produces a D(0) far outside the whole
  // distribution, because no interior column pair anywhere in the texture is
  // that discontinuous. Validated against a synthetic torn field: a tileable
  // fBm scores 0.5, the same fBm with its columns rolled scores 10+.
  const colD = new Float32Array(n), rowD = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const xm = x === 0 ? n - 1 : x - 1;
    let s = 0;
    for (let y = 0; y < n; y++) s += Math.abs(f[y * n + x] - f[y * n + xm]);
    colD[x] = s / n;
  }
  for (let y = 0; y < n; y++) {
    const ym = (y === 0 ? n - 1 : y - 1) * n, r = y * n;
    let s = 0;
    for (let x = 0; x < n; x++) s += Math.abs(f[r + x] - f[ym + x]);
    rowD[y] = s / n;
  }
  const p99 = (a) => { const b = Float32Array.from(a).sort(); return b[Math.min(b.length - 1, Math.round(0.99 * (b.length - 1)))]; };
  const cx = p99(colD), ry = p99(rowD);
  if (cx < 1e-7 || ry < 1e-7) return 0;
  return 0.5 * (colD[0] / cx + rowD[0] / ry);
}

/**
 * INTERNAL PERIODICITY.
 *
 * Why this exists: `Seam` answers "does the wrap edge look like the rest of the
 * texture", and it answers it well — but a surface can pass it perfectly while
 * being built out of two copies of the same blob, because both copies are
 * equally continuous at the wrap. That is the failure a player actually sees
 * (a repeating lattice across a floor), it is invisible to every other column
 * in this table, and it is one Pearson correlation to catch.
 */
function repeatScore(f, n) {
  let m = 0; for (let i = 0; i < f.length; i++) m += f[i]; m /= f.length;
  const at = (dx, dy) => {
    let sa = 0, sb = 0, sab = 0;
    for (let y = 0; y < n; y++) {
      const y2 = ((y + dy) % n) * n, r = y * n;
      for (let x = 0; x < n; x++) {
        const a = f[r + x] - m, b = f[y2 + ((x + dx) % n)] - m;
        sa += a * a; sb += b * b; sab += a * b;
      }
    }
    return sab / Math.sqrt(sa * sb + 1e-12);
  };
  let best = 0;
  for (const d of [2, 3, 4]) {
    const s = Math.round(n / d);
    best = Math.max(best, at(s, 0), at(0, s), at(s, s));
  }
  return best;
}

function percentile(f, p) {
  const a = Float32Array.from(f).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
}

// ---------------------------------------------------------------------------
export function measure(key, n) {
  const b = bakeSet(key, n);
  if (!b) return null;
  const N = n * n;
  const lum = new Float32Array(N);
  const chroma = new Float32Array(N);
  const m = b.map;
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    const r = SRGB2LIN[m[j]], g = SRGB2LIN[m[j + 1]], bl = SRGB2LIN[m[j + 2]];
    // perceptual-ish: sqrt of linear luma keeps the metric from being dominated
    // by the handful of bright texels on a very dark underworld surface.
    lum[i] = Math.sqrt(Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * bl));
    const mx = Math.max(m[j], m[j + 1], m[j + 2]), mn = Math.min(m[j], m[j + 1], m[j + 2]);
    chroma[i] = (mx - mn) / 255;
  }
  const blur = box3(lum, n);
  let lc = 0; for (let i = 0; i < N; i++) lc += Math.abs(lum[i] - blur[i]);
  lc /= N;
  const bd = bands(lum, n, 3);

  // relief from the normal map (xy deviation from flat)
  const nm = b.normalMap;
  let relief = 0;
  for (let i = 0; i < N; i++) {
    const j = i * 4;
    const nx = nm[j] / 127.5 - 1, ny = nm[j + 1] / 127.5 - 1;
    relief += Math.sqrt(nx * nx + ny * ny);
  }
  relief /= N;

  // ORM: r = ao, g = roughness, b = metal
  const orm = b.ormMap;
  const ao = new Float32Array(N), rough = new Float32Array(N);
  for (let i = 0; i < N; i++) { ao[i] = orm[i * 4] / 255; rough[i] = orm[i * 4 + 1] / 255; }

  let emFrac = 0;
  if (b.emissiveMap) {
    const e = b.emissiveMap;
    for (let i = 0; i < N; i++) if (e[i * 4] > 2 || e[i * 4 + 1] > 2 || e[i * 4 + 2] > 2) emFrac++;
    emFrac /= N;
  }

  return {
    key, size: n,
    Lmean: mean(lum), Lsd: sd(lum), Ent: entropy(lum),
    LC: lc, F: bd[0], M: bd[1], C: bd[2],
    Chr: mean(chroma), Chsd: sd(chroma),
    Seam: seamRatio(lum, n),
    Rep: repeatScore(lum, n),
    Rlf: relief, Rsd: sd(rough), AOd: 1 - percentile(ao, 0.05),
    Em: emFrac,
    err: b.error || null,
  };
}

// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const size = Number(arg('--size', 256)) | 0;
  const only = arg('--only', null);
  const jsonOut = arg('--json', null);
  let keys = argv.includes('--all') ? Object.keys(RECIPES) : ENV_SET;
  if (only) keys = only.split(',').map(s => s.trim()).filter(Boolean);
  keys = keys.filter(k => RECIPES[k]);

  const rows = [];
  const t0 = Date.now();
  for (const k of keys) {
    const t = Date.now();
    const r = measure(k, Math.min(size, recipeSize(k)));
    if (!r) continue;
    r.ms = Date.now() - t;
    rows.push(r);
  }

  const F3 = (v) => (v * 1000).toFixed(0).padStart(4);
  const F2 = (v) => v.toFixed(2).padStart(5);
  const head = ['surface'.padEnd(24), 'Lmn', ' Lsd', '  Ent', '  LC', '   F', '   M', '   C', ' Chr', 'Chsd', ' Seam', '  Rep', ' Rlf', ' Rsd', ' AOd', '  Em', '  ms'];
  console.log(head.join(' '));
  console.log('-'.repeat(head.join(' ').length));
  for (const r of rows) {
    console.log([
      r.key.padEnd(24), F2(r.Lmean).slice(1), F3(r.Lsd), F2(r.Ent), F3(r.LC),
      F3(r.F), F3(r.M), F3(r.C), F3(r.Chr), F3(r.Chsd),
      F2(r.Seam), F2(r.Rep), F3(r.Rlf), F3(r.Rsd), F3(r.AOd), F2(r.Em),
      String(r.ms).padStart(4),
    ].join(' ') + (r.err ? `  ERROR: ${r.err}` : ''));
  }
  const avg = (f) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  console.log('-'.repeat(head.join(' ').length));
  console.log([
    'MEAN'.padEnd(24), F2(avg(r => r.Lmean)).slice(1), F3(avg(r => r.Lsd)), F2(avg(r => r.Ent)),
    F3(avg(r => r.LC)), F3(avg(r => r.F)), F3(avg(r => r.M)), F3(avg(r => r.C)),
    F3(avg(r => r.Chr)), F3(avg(r => r.Chsd)), F2(avg(r => r.Seam)), F2(avg(r => r.Rep)),
    F3(avg(r => r.Rlf)), F3(avg(r => r.Rsd)), F3(avg(r => r.AOd)), F2(avg(r => r.Em)),
    String(Date.now() - t0).padStart(4),
  ].join(' '));

  const bad = rows.filter(r => r.err);
  if (bad.length) { console.error(`\n${bad.length} recipe(s) threw and fell back.`); process.exitCode = 1; }
  // ── THE FLOORS, AND WHY THEY ARE WHERE THEY ARE ──────────────────────────
  //
  // The previous version of this block asserted Ent >= 2.4 against a set whose
  // historical worst was 2.40097, Rlf >= 0.004 against a set whose worst was
  // 0.0255, and Seam <= 1.35 against a worst of 1.17. Every one of those passes
  // on the ORIGINAL pre-branch code as well as on this one, which makes them
  // decoration with an `if` in front. A floor that cannot fail is worse than no
  // floor at all, because it reads as a guarantee.
  //
  // These are set JUST UNDER THE MEASURED WORST OF THE CURRENT SET, and the
  // worst is named beside each one so the next person can see the margin they
  // actually have. Three of the four FAIL on the pre-branch code, which is the
  // only test of whether a floor is binding.
  //
  // ── WHICH SURFACE EACH GATE IS PINNED TO, AND BY HOW MUCH ────────────────
  // A floor set just under the measured worst is a floor with almost no margin,
  // and the honest thing is to name the surface holding it up rather than to
  // widen the number until the margin looks comfortable. Every gate below lists
  // the surface it is currently pinned to and that surface's headroom; NONE of
  // these thresholds has ever been moved to buy margin.
  //
  //   Ent  >= 3.00   pinned to stone.tartarus.bay 3.113      headroom 3.8%
  //   Seam <= 1.00   pinned to marble.elysium.arch 0.939     headroom 6.1%
  //   Rlf  >= 0.060  pinned to blood.pool 0.0754             headroom 25.6%
  //   Rep  <= 0.80   pinned to stone.tartarus.arch 0.7294    headroom 8.8%
  //
  // TWO OF THESE ARE TIGHT AND ARE DECLARED AS SUCH.
  //
  //   * `Rep` is effectively pinned to a PAIR: stone.tartarus.arch 0.7294 and
  //     gold.filigree 0.7272, two thousandths apart. Both are legitimately
  //     periodic objects — a fifteen-voussoir arch and a drawn filigree grille —
  //     so their score is the ornament they are supposed to have, and there is
  //     no version of either that scores much lower while still being that
  //     object. If a future change to either pushes past 0.80 the right response
  //     is to look at the ornament pitch, not at this number.
  //   * `Seam` is pinned to marble.elysium.arch, which came into this round at
  //     0.97 — a 3% margin. It sits at 0.939 now because the brightness gate
  //     added to that recipe's aggregate term (see 'marble.elysium.arch' in
  //     materials/recipes.js) took energy out of the plate's brightest columns,
  //     which is where its wrap error lived. That is margin bought by work on
  //     the surface, not by moving the gate. It is still the tightest of the
  //     four and it is still one surface deep.
  //
  const FLOORS = {
    Ent: 3.00,    // worst now 3.11 stone.tartarus.bay | pre-branch 2.62 rubble.tartarus   -> FAILS
    Seam: 1.00,   // worst now 0.94 marble.elysium.arch | 1.0 = the wrap column is no worse
                  //   than the 99th percentile of the texture's own interior columns.
                  //   Pre-branch passes this; the version of THIS branch that shipped to
                  //   the last review did not (stone.asphodel.column 1.17).
    Rlf: 0.060,   // worst now 0.075 blood.pool | pre-branch 0.026 blood.pool              -> FAILS
    Rep: 0.80,    // worst now 0.73 stone.tartarus.arch | pre-branch 0.87, same surface    -> FAILS
                  //   No surface is exempted. Ornament (a bead row, a laurel band, a
                  //   filigree grille) IS periodic on purpose and lands at 0.47-0.73;
                  //   the ceiling is set above that on purpose, because the failure this
                  //   is here to catch is a whole texture built from two copies of one
                  //   blob, which scores far higher than any drawn ornament does.
                  //   THIS IS THE GATE WITH THE LEAST SLACK IN PRACTICE: see the
                  //   pinned-surface block above.
  };
  const flat = rows.filter(r => r.Rlf < FLOORS.Rlf);
  const seams = rows.filter(r => r.Seam > FLOORS.Seam);
  const dull = rows.filter(r => r.Ent < FLOORS.Ent);
  const repeats = rows.filter(r => r.Rep > FLOORS.Rep);
  if (flat.length) console.error(`\nlost relief (floor ${FLOORS.Rlf}): ${flat.map(r => `${r.key} ${r.Rlf.toFixed(3)}`).join(', ')}`);
  if (seams.length) console.error(`visible wrap seam (ceiling ${FLOORS.Seam}): ${seams.map(r => `${r.key} ${r.Seam.toFixed(2)}`).join(', ')}`);
  if (dull.length) console.error(`low value entropy (floor ${FLOORS.Ent}): ${dull.map(r => `${r.key} ${r.Ent.toFixed(2)}`).join(', ')}`);
  if (repeats.length) console.error(`internal repeat / tiling lattice (ceiling ${FLOORS.Rep}): ${repeats.map(r => `${r.key} ${r.Rep.toFixed(2)}`).join(', ')}`);
  if (flat.length || seams.length || dull.length || repeats.length) process.exitCode = 1;

  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
