// Four image-generated atlases supply the authored colour and brushwork for every
// named material recipe. The procedural baker still owns height-derived normals,
// roughness, metalness, AO, emissive masks, and the stochastic anti-tiling pass.
// Keeping those jobs separate gives the game hand-painted source art without
// losing the physically useful channels already tuned to each mesh.

import * as THREE from 'three';
import tartarusUrl from '../assets/textures/generated/tartarus-atlas.jpg';
import biomesUrl from '../assets/textures/generated/biomes-atlas.jpg';
import propsUrl from '../assets/textures/generated/props-atlas.jpg';
import charactersUrl from '../assets/textures/generated/characters-atlas.jpg';

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

function sliceTile(image, tile, anisotropy) {
  const sourceWidth = image.naturalWidth || image.videoWidth || image.width;
  const sourceHeight = image.naturalHeight || image.videoHeight || image.height;
  const tileWidth = Math.floor(sourceWidth / GRID_COLS);
  const tileHeight = Math.floor(sourceHeight / GRID_ROWS);
  if (!tileWidth || !tileHeight || tileWidth !== tileHeight) {
    throw new Error(`Generated atlas must contain square cells; received ${sourceWidth}x${sourceHeight}`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = tileWidth; canvas.height = tileHeight;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable for generated texture slicing');
  ctx.drawImage(
    image,
    tile.col * tileWidth, tile.row * tileHeight, tileWidth, tileHeight,
    0, 0, tileWidth, tileHeight,
  );
  const pixels = ctx.getImageData(0, 0, tileWidth, tileHeight);
  if (tile.modulator) neutralise(pixels.data, tile.modulator[0], tile.modulator[1]);
  closeSeams(pixels.data, tileWidth, tileHeight);
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
  const out = new Uint8Array(base.length);

  for (let i = 0; i < out.length; i += 4) {
    const luma = src[i] * 0.2126 + src[i + 1] * 0.7152 + src[i + 2] * 0.0722;
    const z = Math.max(-1.65, Math.min(1.65, (luma - mean) / sigma));
    const valueMod = 1 + z * detail;
    for (let c = 0; c < 3; c++) {
      // Chroma is centred around generated luma, so it cannot lift the whole
      // surface or overwrite the recipe hue; it only introduces local colour.
      const v = base[i + c] * valueMod + (src[i + c] - luma) * chroma;
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

/** Load and slice the four project-bound atlases into recipe-addressable maps. */
export async function loadGeneratedAlbedos(anisotropy = 8) {
  if (typeof document === 'undefined') return new Map();
  const loader = new THREE.TextureLoader();
  const sources = await Promise.all(ATLASES.map((atlas) => loader.loadAsync(atlas.url)));
  const maps = new Map();
  for (let i = 0; i < ATLASES.length; i++) {
    const atlas = ATLASES[i], source = sources[i];
    for (const tile of atlas.tiles) {
      const texture = sliceTile(source.image, tile, anisotropy);
      for (const key of tile.keys) maps.set(key, texture);
    }
    source.dispose();
  }
  return maps;
}
