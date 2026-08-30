// Nine image-generated atlases supply the authored colour and brushwork for every
// named material recipe. The procedural baker still owns height-derived normals,
// roughness, metalness, AO, emissive masks, and the stochastic anti-tiling pass.
// Keeping those jobs separate gives the game hand-painted source art without
// losing the physically useful channels already tuned to each mesh.

import * as THREE from 'three';
// Browser builds use half-resolution, aggressively compressed atlas sources.
// Each cell remains 256² before the tier-specific slicer downsamples it again;
// the original 1536×1024 masters stay in the repository for future art edits.
import tartarusUrl from '../assets/textures/generated/web/tartarus-atlas-web.jpg';
import biomesUrl from '../assets/textures/generated/web/biomes-atlas-web.jpg';
import propsUrl from '../assets/textures/generated/web/props-atlas-web.jpg';
import charactersUrl from '../assets/textures/generated/web/characters-atlas-web.jpg';
import tartarusV2Url from '../assets/textures/generated/web/tartarus-materials-v2-atlas-web.jpg';
import creaturesPropsV3Url from '../assets/textures/generated/web/creatures-props-v3-atlas-web.jpg';
import arenaBoonsV4Url from '../assets/textures/generated/web/arena-boons-v4-atlas-web.jpg';
import asphodelVisibilityV5Url from '../assets/textures/generated/web/asphodel-visibility-v5-atlas-web.jpg';
import hephaestusForgeGatesV6Url from '../assets/textures/generated/web/hephaestus-forge-gates-v6-atlas-web.jpg';

const GRID_COLS = 3;
const GRID_ROWS = 2;

// Generated art is intentionally used as a DETAIL layer, not as a replacement
// palette. The procedural recipes already encode the biome's value hierarchy,
// material identity, and hand-authored ornament masks; replacing those RGB
// maps with an unconstrained atlas was what turned Tartarus into fluorescent
// orange/purple blocks. These profiles preserve the recipe colour while
// borrowing brushwork, wear, grain, and a restrained amount of local chroma.
// `detail` is the weight of the atlas's own structure (a ratio about its mean),
// `chroma` the extra weight on that structure's colour deviation, and
// `chromaGain` the §15 chroma expansion applied to the composited result. The
// gain is a straight vibrancy pass on the albedo: it preserves luminance
// exactly, so it adds colour without touching the value law.
// 1.45: measured meanSaturation after the first pass at this step was
// 0.246-0.258 across the three material shots, still far under §15's floor of
// 0.42, and §15 is explicit that a frame reading flat and washed is the worse
// failure. The gain preserves luma exactly, so there is no value-law cost to
// spending the headroom.
const DEFAULT_COMPOSITE = Object.freeze({ detail: 0.26, chroma: 0.10, chromaGain: 1.45 });

const ATLASES = [
  {
    name: 'tartarus', url: tartarusUrl,
    tiles: [
      { col: 0, row: 0, name: 'crimson-flagstone', keys: ['floor.tartarus'], composite: { detail: 0.22, chroma: 0.06 } },
      { col: 1, row: 0, name: 'carved-bloodstone', keys: [
        'stone.tartarus', 'stone.tartarus.bay', 'stone.tartarus.column', 'stone.tartarus.arch',
      ] },
      { col: 2, row: 0, name: 'crimson-rubble', keys: ['rubble.tartarus'] },
      { col: 0, row: 1, name: 'aged-bone', keys: ['bone'] },
      { col: 1, row: 1, name: 'blood-ichor', keys: ['blood.pool'], composite: { detail: 0.18, chroma: 0.08 } },
      { col: 2, row: 1, name: 'crimson-banner', keys: ['banner.crimson'] },
    ],
  },
  {
    name: 'biomes', url: biomesUrl,
    tiles: [
      { col: 0, row: 0, name: 'obsidian-basalt', keys: ['stone.asphodel', 'obsidian'] },
      { col: 1, row: 0, name: 'charred-flagstone', keys: ['floor.asphodel'] },
      { col: 2, row: 0, name: 'molten-lava', keys: ['lava'], composite: { detail: 0.18, chroma: 0.08 } },
      { col: 0, row: 1, name: 'elysium-marble', keys: ['marble.elysium'] },
      { col: 1, row: 1, name: 'elysium-laurel-floor', keys: ['floor.elysium'] },
      { col: 2, row: 1, name: 'styx-water', keys: ['water.styx'] },
    ],
  },
  {
    name: 'props', url: propsUrl,
    tiles: [
      { col: 0, row: 0, name: 'gold-filigree', keys: ['gold.filigree', 'medallion.tartarus'], composite: { detail: 0.20, chroma: 0.08 } },
      { col: 1, row: 0, name: 'hammered-gold-leaf', keys: ['gold.leaf'], composite: { detail: 0.20, chroma: 0.08 } },
      { col: 2, row: 0, name: 'verdigris-bronze', keys: ['bronze.verdigris'], composite: { detail: 0.24, chroma: 0.10 } },
      { col: 0, row: 1, name: 'dark-forged-iron', keys: ['iron.dark'] },
      { col: 1, row: 1, name: 'charred-wood', keys: ['wood.dark'] },
      { col: 2, row: 1, name: 'violet-crystal', keys: ['crystal.violet'] },
    ],
  },
  {
    name: 'characters', url: charactersUrl,
    tiles: [
      { col: 0, row: 0, name: 'skin-brushwork', keys: ['characterrig.skin'], modulator: [0.78, 1.0], composite: { detail: 0.16, chroma: 0.0 } },
      { col: 1, row: 0, name: 'cloth-weave', keys: ['characterrig.cloth'], modulator: [0.62, 1.0], composite: { detail: 0.20, chroma: 0.0 } },
      { col: 2, row: 0, name: 'hair-leather', keys: ['characterrig.hair'], modulator: [0.50, 0.98], composite: { detail: 0.20, chroma: 0.0 } },
      { col: 0, row: 1, name: 'bronze-armour', keys: ['armour.bronze'], composite: { detail: 0.20, chroma: 0.06 } },
      { col: 1, row: 1, name: 'brute-shield', keys: ['shield.brute'], composite: { detail: 0.22, chroma: 0.06 } },
      { col: 2, row: 1, name: 'hero-linen', keys: ['character.hero'], composite: { detail: 0.20, chroma: 0.04 } },
    ],
  },
  {
    // Second-pass art is last deliberately: it supersedes only Tartarus-facing
    // recipe bindings while leaving the original atlases available to the
    // other biomes. The recipes still supply normals, ORM and palette colour.
    name: 'tartarus-materials-v2', url: tartarusV2Url,
    tiles: [
      { col: 0, row: 0, name: 'oxblood-flagstone-v2', keys: ['floor.tartarus'], composite: { detail: 0.30, chroma: 0.08, sourceMix: 0.18 } },
      { col: 1, row: 0, name: 'carved-bloodstone-v2', keys: [
        'stone.tartarus', 'stone.tartarus.bay', 'stone.tartarus.column', 'stone.tartarus.arch',
      ], composite: { detail: 0.28, chroma: 0.08, sourceMix: 0.14 } },
      { col: 2, row: 0, name: 'guardian-stone-v2', keys: ['bone.tartarus'], composite: { detail: 0.24, chroma: 0.025, sourceMix: 0.12 } },
      { col: 0, row: 1, name: 'blackened-bronze-v2', keys: ['bronze.tartarus'], composite: { detail: 0.25, chroma: 0.08, sourceMix: 0.16 } },
      { col: 1, row: 1, name: 'charred-timber-v2', keys: ['wood.tartarus'], composite: { detail: 0.30, chroma: 0.065, sourceMix: 0.18 } },
      { col: 2, row: 1, name: 'tartarus-rubble-v2', keys: ['rubble.tartarus'], composite: { detail: 0.32, chroma: 0.08, sourceMix: 0.16 } },
    ],
  },
  {
    // Focused third pass: enemy-specific keys attach authored hide and keratin
    // directly to the moving hound meshes; the lower row replaces the few
    // remaining flat Tartarus prop surfaces without touching other biomes.
    name: 'creatures-props-v3', url: creaturesPropsV3Url,
    tiles: [
      { col: 0, row: 0, name: 'ember-hound-hide-v3', keys: ['characterrig.hound.hide'], modulator: [0.46, 0.96], composite: { detail: 0.34, chroma: 0.0 } },
      { col: 1, row: 0, name: 'ember-hound-limbs-v3', keys: ['characterrig.hound.limbs'], modulator: [0.40, 0.92], composite: { detail: 0.36, chroma: 0.0 } },
      { col: 2, row: 0, name: 'ember-hound-keratin-v3', keys: ['characterrig.hound.keratin'], modulator: [0.44, 0.98], composite: { detail: 0.38, chroma: 0.0 } },
      { col: 0, row: 1, name: 'tartarus-ceramic-v3', keys: ['ceramic.tartarus'], composite: { detail: 0.30, chroma: 0.07, sourceMix: 0.18 } },
      { col: 1, row: 1, name: 'black-forged-iron-v3', keys: ['iron.tartarus'], composite: { detail: 0.28, chroma: 0.05, sourceMix: 0.14 } },
      { col: 2, row: 1, name: 'charred-timber-v3', keys: ['wood.tartarus'], composite: { detail: 0.34, chroma: 0.055, sourceMix: 0.18 } },
    ],
  },
  {
    // Large-field materials are last so the enlarged arenas receive the broad
    // macro variation authored for their new scale. Shrine and divine-gold
    // keys are isolated to reward architecture instead of repainting the room.
    name: 'arena-boons-v4', url: arenaBoonsV4Url,
    tiles: [
      // chromaGain above the 1.45 default: the ground plane is the one surface
      // that pays a §9 value cut (see floor.tartarus's macroLevel), and HSL
      // saturation is scale-invariant below mid-grey, so chroma bought back at
      // the darker level costs nothing and is where §15's crimson has to live.
      { col: 0, row: 0, name: 'expanded-tartarus-floor-v4', keys: ['floor.tartarus'], composite: { detail: 0.34, chroma: 0.07, sourceMix: 0.20, chromaGain: 1.62 } },
      { col: 1, row: 0, name: 'tartarus-rim-masonry-v4', keys: ['stone.tartarus.rim'], composite: { detail: 0.32, chroma: 0.06, sourceMix: 0.18 } },
      { col: 2, row: 0, name: 'divine-shrine-stone-v4', keys: ['shrine.divine'], composite: { detail: 0.30, chroma: 0.07, sourceMix: 0.17 } },
      { col: 0, row: 1, name: 'divine-door-gold-v4', keys: ['gold.divine'], composite: { detail: 0.30, chroma: 0.08, sourceMix: 0.18 } },
      { col: 1, row: 1, name: 'expanded-asphodel-floor-v4', keys: ['floor.asphodel'], composite: { detail: 0.32, chroma: 0.07, sourceMix: 0.17 } },
      { col: 2, row: 1, name: 'expanded-elysium-floor-v4', keys: ['floor.elysium'], composite: { detail: 0.30, chroma: 0.07, sourceMix: 0.17 } },
    ],
  },
  {
    // Visibility-first Asphodel pass. These are biome-specific recipe keys so
    // the pale ash, cooled lava and lifted metal cannot leak into Tartarus.
    name: 'asphodel-visibility-v5', url: asphodelVisibilityV5Url,
    tiles: [
      { col: 0, row: 0, name: 'readable-basalt-floor-v5', keys: ['floor.asphodel'], composite: { detail: 0.38, chroma: 0.055, sourceMix: 0.30 } },
      { col: 1, row: 0, name: 'slate-plum-wall-v5', keys: ['stone.asphodel'], composite: { detail: 0.36, chroma: 0.055, sourceMix: 0.27 } },
      // Rubble is part of the volcanic architecture, not part of the skeleton
      // dressing. Sharing this already-decoded tile keeps the atlas/VRAM cost
      // unchanged while separating environmental debris from readable bone.
      { col: 2, row: 0, name: 'cooled-obsidian-v5', keys: ['obsidian.asphodel', 'rubble.asphodel'], composite: { detail: 0.36, chroma: 0.045, sourceMix: 0.25 } },
      { col: 0, row: 1, name: 'controlled-lava-v5', keys: ['lava.asphodel'], composite: { detail: 0.28, chroma: 0.055, sourceMix: 0.32 } },
      { col: 1, row: 1, name: 'pale-ash-bone-v5', keys: ['bone.asphodel'], composite: { detail: 0.34, chroma: 0.035, sourceMix: 0.29 } },
      { col: 2, row: 1, name: 'blackened-asphodel-metal-v5', keys: ['bronze.asphodel', 'iron.asphodel'], composite: { detail: 0.32, chroma: 0.045, sourceMix: 0.25 } },
    ],
  },
  {
    // The portrait occupies cell 0/0 and is consumed directly by the boon UI.
    // The remaining five cells bring the generated forge language into the
    // Crossroads, divine gates, metal props, lava and hero equipment.
    name: 'hephaestus-forge-gates-v6', url: hephaestusForgeGatesV6Url,
    tiles: [
      { col: 1, row: 0, name: 'crossroads-carved-slate-v6', keys: ['stone.tartarus.rim'], composite: { detail: 0.34, chroma: 0.045, sourceMix: 0.18 } },
      { col: 2, row: 0, name: 'divine-gate-bronze-v6', keys: ['shrine.divine', 'gold.divine'], composite: { detail: 0.34, chroma: 0.07, sourceMix: 0.20 } },
      { col: 0, row: 1, name: 'forge-blackened-iron-v6', keys: ['iron.dark', 'iron.tartarus'], composite: { detail: 0.38, chroma: 0.04, sourceMix: 0.20 } },
      { col: 1, row: 1, name: 'controlled-molten-bronze-v6', keys: ['lava'], composite: { detail: 0.24, chroma: 0.06, sourceMix: 0.12 } },
      { col: 2, row: 1, name: 'tempered-weapon-steel-v6', keys: ['armour.bronze', 'shield.brute'], composite: { detail: 0.34, chroma: 0.06, sourceMix: 0.16 } },
    ],
  },
];

export const GENERATED_ALBEDO_KEYS = Object.freeze(
  ATLASES.flatMap((atlas) => atlas.tiles.flatMap((tile) => tile.keys)),
);

/** Convert a generated colour tile into a high-key neutral value modulator.
 * Rig vertex colours carry character identity, so skin/cloth/hair must add
 * brushwork and material response without painting every family the same hue.
 */
function neutralise(data, floor, ceiling) {
  const span = ceiling - floor;
  for (let i = 0; i < data.length; i += 4) {
    const luma = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
    const value = Math.round(255 * (floor + span * Math.pow(luma, 0.88)));
    data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
  }
}

/** Cross-blend opposite borders so each generated tile is mathematically
 * seamless even if the image model left a small edge mismatch.
 */
function closeSeams(data, width, height, feather = 18) {
  const blendPair = (a, b, weight) => {
    for (let c = 0; c < 3; c++) {
      const av = data[a + c], bv = data[b + c], mid = (av + bv) * 0.5;
      data[a + c] = Math.round(av + (mid - av) * weight);
      data[b + c] = Math.round(bv + (mid - bv) * weight);
    }
    data[a + 3] = data[b + 3] = 255;
  };
  for (let k = 0; k < feather; k++) {
    const w = 1 - k / feather;
    for (let y = 0; y < height; y++) {
      blendPair((y * width + k) * 4, (y * width + width - 1 - k) * 4, w);
    }
    for (let x = 0; x < width; x++) {
      blendPair((k * width + x) * 4, ((height - 1 - k) * width + x) * 4, w);
    }
  }
}

function sliceTile(image, tile, anisotropy, scale = 1) {
  const sourceWidth = image.naturalWidth || image.videoWidth || image.width;
  const sourceHeight = image.naturalHeight || image.videoHeight || image.height;
  const sourceTileWidth = Math.floor(sourceWidth / GRID_COLS);
  const sourceTileHeight = Math.floor(sourceHeight / GRID_ROWS);
  if (!sourceTileWidth || !sourceTileHeight || sourceTileWidth !== sourceTileHeight) {
    throw new Error(`Generated atlas must contain square cells; received ${sourceWidth}x${sourceHeight}`);
  }
  const tileWidth = Math.max(64, Math.round(sourceTileWidth * Math.max(0.25, Math.min(1, scale))));
  const tileHeight = tileWidth;
  const canvas = document.createElement('canvas');
  canvas.width = tileWidth; canvas.height = tileHeight;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable for generated texture slicing');
  ctx.drawImage(
    image,
    tile.col * sourceTileWidth, tile.row * sourceTileHeight, sourceTileWidth, sourceTileHeight,
    0, 0, tileWidth, tileHeight,
  );
  const pixels = ctx.getImageData(0, 0, tileWidth, tileHeight);
  if (tile.modulator) neutralise(pixels.data, tile.modulator[0], tile.modulator[1]);
  closeSeams(pixels.data, tileWidth, tileHeight, Math.max(6, Math.round(18 * scale)));
  ctx.putImageData(pixels, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `generated.${tile.name}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.userData.generatedComposite = tile.composite || DEFAULT_COMPOSITE;
  // a neutralised modulator must not gain chroma: the roster's hue identity is
  // painted into VERTEX COLOUR by rig.js and the albedo only swings value
  texture.userData.generatedIsModulator = !!tile.modulator;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Composite generated brushwork over a procedural albedo without surrendering
 * the procedural palette.
 *
 * ── WHAT WAS MEASURED, AND WHY THIS WAS REWRITTEN ─────────────────────────────
 * The header above and the `sourceMix` note below both assume the atlases carry
 * "the new oxblood/soot/wood palette". Decoded and averaged, cell by cell, they
 * do not. The tiles bound to the two largest surfaces in the game are:
 *
 *   arena-boons-v4 (0,0) 'expanded-tartarus-floor-v4' -> floor.tartarus
 *        mean rgb(30,22,24), HSL saturation 0.16
 *   tartarus-materials-v2 (1,0) 'carved-bloodstone-v2' -> stone.tartarus + bay
 *        + column + arch,  mean rgb(25,16,17), saturation 0.20
 *
 * Those are near-neutral dark greys. `sourceMix` was lerping 20% of the floor
 * and 14% of every Tartarus wall TOWARDS a grey, and `chroma` (a residual
 * centred on the source's own luma) could not put any back because the source
 * has almost none. Measured on the shipped build, 04_material / 05_floor /
 * 11_relief_detail returned meanSaturation 0.228 / 0.211 / 0.240 against
 * ART_DIRECTION §15's floor of 0.42 — "the game has very faded colours", and
 * this compositing step is a large part of where the colour went. §15 is
 * explicit that chroma is ADDED, never removed, and it supersedes the earlier
 * restraint notes that this function was written under.
 *
 * The rewrite keeps everything the old one was trying to keep and drops the
 * only thing it was doing wrong:
 *
 *   1. The atlas is applied as a per-channel RATIO around ITS OWN MEAN. That
 *      transfers all of its structure — value, wear, grain AND its local hue
 *      shifts — while leaving the recipe's mean colour exactly where it was.
 *      A grey tile can no longer grey a crimson floor; it can only mottle it.
 *   2. `sourceMix` survives as a knob but now mixes toward a MEAN-CORRECTED
 *      source, so a direct contribution from the authored art is still
 *      possible and still cannot bleach the surface.
 *   3. The old lerp-to-raw also cost (1 - sourceMix) of the PROCEDURAL layer's
 *      local contrast — the atlas cell is 256 square upscaled to a 768-square
 *      floor map, i.e. three times softer than the map it was diluting. The
 *      ratio form multiplies instead of lerping, so 100% of the procedural
 *      high frequency survives.
 *   4. A final chroma expansion about the pixel's own luma (§15), which cannot
 *      move luminance and therefore cannot touch the value law (§9).
 */
export function compositeGeneratedAlbedo(procedural, generated, anisotropy = 8) {
  if (typeof document === 'undefined' || !procedural?.image?.data || !generated?.image) return procedural;
  const width = procedural.image.width;
  const height = procedural.image.height;
  const base = procedural.image.data;
  if (!width || !height || !base) return procedural;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) return procedural;
  ctx.drawImage(generated.image, 0, 0, width, height);
  const source = ctx.getImageData(0, 0, width, height);
  const src = source.data;

  const pixels = Math.max(1, src.length / 4);
  // PER-CHANNEL means. The old code took only a luma mean, which is exactly why
  // it could not tell a dark crimson tile from a dark grey one.
  const sMean = [0, 0, 0];
  const bMean = [0, 0, 0];
  for (let i = 0; i < src.length; i += 4) {
    sMean[0] += src[i]; sMean[1] += src[i + 1]; sMean[2] += src[i + 2];
    bMean[0] += base[i]; bMean[1] += base[i + 1]; bMean[2] += base[i + 2];
  }
  for (let c = 0; c < 3; c++) { sMean[c] /= pixels; bMean[c] /= pixels; }

  const profile = generated.userData.generatedComposite || DEFAULT_COMPOSITE;
  const detail = profile.detail ?? DEFAULT_COMPOSITE.detail;
  const chroma = profile.chroma ?? DEFAULT_COMPOSITE.chroma;
  const sourceMix = Math.max(0, Math.min(0.25, profile.sourceMix ?? 0));
  // §15. 1.0 leaves the recipe's chroma untouched; the default adds a third.
  // Modulators (skin/cloth/hair) are neutralised on purpose — they must not
  // fight the rig's vertex colour — so they opt out with chromaGain 1.
  const chromaGain = profile.chromaGain
    ?? (generated.userData.generatedIsModulator ? 1 : DEFAULT_COMPOSITE.chromaGain);
  const out = new Uint8Array(base.length);

  // ratio = src / srcMean, so the tile contributes only its DEVIATION from its
  // own average. Clamped: a jpeg cell that goes to near-black would otherwise
  // punch a hole in the surface rather than shade it.
  const inv = [1 / Math.max(6, sMean[0]), 1 / Math.max(6, sMean[1]), 1 / Math.max(6, sMean[2])];
  // the mean-corrected source used by sourceMix: the atlas repainted into the
  // recipe's own average colour, so a direct contribution is structure only
  const corr = [bMean[0] * inv[0], bMean[1] * inv[1], bMean[2] * inv[2]];

  const px = [0, 0, 0], ratio = [0, 0, 0];
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      ratio[c] = Math.max(0.30, Math.min(2.60, src[i + c] * inv[c]));
    }
    // the achromatic part of the ratio triple, so `ratio - rLum` is exactly the
    // atlas's local COLOUR deviation with its value deviation removed
    const rLum = ratio[0] * 0.2126 + ratio[1] * 0.7152 + ratio[2] * 0.0722;
    for (let c = 0; c < 3; c++) {
      // `detail` is the weight of the atlas's structure, on the same 0..1 scale
      // the tiles were already authored against.
      const mod = 1 + (ratio[c] - 1) * detail + (ratio[c] - rLum) * chroma;
      px[c] = base[i + c] * mod * (1 - sourceMix) + src[i + c] * corr[c] * sourceMix;
    }
    let r = px[0], g = px[1], b = px[2];
    if (chromaGain !== 1) {
      // expand chroma about the pixel's own luminance: hue and value are both
      // invariant, so this cannot break §9's value law in either direction
      const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
      r = l + (r - l) * chromaGain;
      g = l + (g - l) * chromaGain;
      b = l + (b - l) * chromaGain;
    }
    out[i] = Math.max(0, Math.min(255, Math.round(r)));
    out[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
    out[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    out[i + 3] = 255;
  }

  const texture = new THREE.DataTexture(out, width, height, THREE.RGBAFormat);
  texture.name = `${procedural.name || 'albedo'}+${generated.name || 'generated'}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Load and slice the project-bound atlases into recipe-addressable maps. */
export async function loadGeneratedAlbedos(anisotropy = 8, scale = 1) {
  if (typeof document === 'undefined') return new Map();
  const loader = new THREE.TextureLoader();
  const sources = await Promise.all(ATLASES.map((atlas) => loader.loadAsync(atlas.url)));
  const maps = new Map();
  for (let i = 0; i < ATLASES.length; i++) {
    const atlas = ATLASES[i], source = sources[i];
    for (const tile of atlas.tiles) {
      const texture = sliceTile(source.image, tile, anisotropy, scale);
      for (const key of tile.keys) maps.set(key, texture);
    }
    source.dispose();
  }
  return maps;
}
