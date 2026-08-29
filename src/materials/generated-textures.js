// Nine image-generated atlases supply the authored colour and brushwork for every
// named material recipe. The procedural baker still owns height-derived normals,
// roughness, metalness, AO, emissive masks, and the stochastic anti-tiling pass.
// Keeping those jobs separate gives the game hand-painted source art without
// losing the physically useful channels already tuned to each mesh.

import * as THREE from 'three';
import tartarusUrl from '../assets/textures/generated/tartarus-atlas.jpg';
import biomesUrl from '../assets/textures/generated/biomes-atlas.jpg';
import propsUrl from '../assets/textures/generated/props-atlas.jpg';
import charactersUrl from '../assets/textures/generated/characters-atlas.jpg';
import tartarusV2Url from '../assets/textures/generated/tartarus-materials-v2-atlas.jpg';
import creaturesPropsV3Url from '../assets/textures/generated/creatures-props-v3-atlas.jpg';
import arenaBoonsV4Url from '../assets/textures/generated/arena-boons-v4-atlas.jpg';
import asphodelVisibilityV5Url from '../assets/textures/generated/asphodel-visibility-v5-atlas.jpg';
import hephaestusForgeGatesV6Url from '../assets/textures/generated/hephaestus-forge-gates-v6-atlas.png';

const GRID_COLS = 3;
const GRID_ROWS = 2;

// Generated art is intentionally used as a DETAIL layer, not as a replacement
// palette. The procedural recipes already encode the biome's value hierarchy,
// material identity, and hand-authored ornament masks; replacing those RGB
// maps with an unconstrained atlas was what turned Tartarus into fluorescent
// orange/purple blocks. These profiles preserve the recipe colour while
// borrowing brushwork, wear, grain, and a restrained amount of local chroma.
const DEFAULT_COMPOSITE = Object.freeze({ detail: 0.26, chroma: 0.10 });

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
      { col: 0, row: 0, name: 'expanded-tartarus-floor-v4', keys: ['floor.tartarus'], composite: { detail: 0.34, chroma: 0.07, sourceMix: 0.20 } },
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
      { col: 2, row: 0, name: 'cooled-obsidian-v5', keys: ['obsidian.asphodel'], composite: { detail: 0.36, chroma: 0.045, sourceMix: 0.25 } },
      { col: 0, row: 1, name: 'controlled-lava-v5', keys: ['lava.asphodel'], composite: { detail: 0.28, chroma: 0.055, sourceMix: 0.32 } },
      { col: 1, row: 1, name: 'pale-ash-rubble-v5', keys: ['rubble.asphodel', 'bone.asphodel'], composite: { detail: 0.34, chroma: 0.035, sourceMix: 0.29 } },
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
  texture.needsUpdate = true;
  return texture;
}

/**
 * Composite generated brushwork over a procedural albedo without surrendering
 * the procedural palette. Generated luma is standardised per tile, then used
 * as a bounded value modulation; only a small, zero-centred chroma residual is
 * admitted. The result retains the source texture's grain and wear without
 * allowing a saturated atlas to repaint every material orange or violet.
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

  let mean = 0;
  for (let i = 0; i < src.length; i += 4) {
    mean += src[i] * 0.2126 + src[i + 1] * 0.7152 + src[i + 2] * 0.0722;
  }
  const pixels = Math.max(1, src.length / 4);
  mean /= pixels;
  let variance = 0;
  for (let i = 0; i < src.length; i += 4) {
    const luma = src[i] * 0.2126 + src[i + 1] * 0.7152 + src[i + 2] * 0.0722;
    const d = luma - mean;
    variance += d * d;
  }
  const sigma = Math.max(18, Math.sqrt(variance / pixels));
  const profile = generated.userData.generatedComposite || DEFAULT_COMPOSITE;
  const detail = profile.detail ?? DEFAULT_COMPOSITE.detail;
  const chroma = profile.chroma ?? DEFAULT_COMPOSITE.chroma;
  const sourceMix = Math.max(0, Math.min(0.25, profile.sourceMix ?? 0));
  const out = new Uint8Array(base.length);

  for (let i = 0; i < out.length; i += 4) {
    const luma = src[i] * 0.2126 + src[i + 1] * 0.7152 + src[i + 2] * 0.0722;
    const z = Math.max(-1.65, Math.min(1.65, (luma - mean) / sigma));
    const valueMod = 1 + z * detail;
    for (let c = 0; c < 3; c++) {
      // Chroma is centred around generated luma, so it cannot lift the whole
      // surface or overwrite the recipe hue; it only introduces local colour.
      const layered = base[i + c] * valueMod + (src[i + c] - luma) * chroma;
      // A tightly-capped direct contribution is reserved for generated art
      // that was authored against the live game reference. It lets the new
      // oxblood/soot/wood palette read at gameplay distance while the recipe
      // remains the dominant colour source and prevents atlas-wide repainting.
      const v = layered * (1 - sourceMix) + src[i + c] * sourceMix;
      out[i + c] = Math.max(0, Math.min(255, Math.round(v)));
    }
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
