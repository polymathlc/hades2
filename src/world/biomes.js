// OWNER: AGENT-WORLD
// ---------------------------------------------------------------------------
// AUTHORED BIOME DEFINITIONS
//
// A biome is a *look contract*, not a data dump: it names the material for
// every architectural role, the light rig and grade to hand to render/, the
// treatment of the void the arena floats in, and the prop mix + density that
// makes one underworld read differently from the next.
//
// ART_DIRECTION §2 assigns each biome exactly two dominant hues plus gold plus
// the ink ramp. Everything below is chosen so a frame never drifts past that:
// `accent` is the mandated complement (§9.6), and it is spent on real emissive
// props (glyph shards, lava veins, laurel lanterns) rather than on a wash.
// ---------------------------------------------------------------------------

export const BIOMES = {

  // =========================================================================
  // TARTARUS — crimson stone, bone and blood over a bottomless dark.
  // key #ff5a3c   /  rim #5fd0ff
  // =========================================================================
  tartarus: {
    id: 'tartarus',
    title: 'Tartarus',
    lightRig: 'tartarus',
    grade: 'tartarus',

    mats: {
      floor: 'floor.tartarus',
      dais: 'floor.tartarus',
      wall: 'stone.tartarus',
      bay: 'stone.tartarus.bay',
      column: 'stone.tartarus.column',
      arch: 'stone.tartarus.arch',
      trim: 'gold.filigree',
      leaf: 'gold.leaf',
      metal: 'bronze.verdigris',
      iron: 'iron.dark',
      rock: 'obsidian',
      rubble: 'rubble.tartarus',
      bone: 'bone',
      cloth: 'banner.crimson',
      crystal: 'crystal.violet',
      ember: 'lava',
      medallion: 'medallion.tartarus',
      liquid: 'blood.pool',
      wood: 'wood.dark',
    },

    // §9.1 The floor is the DARK STAGE. These are multipliers baked into the
    // ground plane's vertex glaze; the material library keeps the physical
    // response, we only paint the value structure over it.
    floorGlaze: {
      // These are LUMINANCE multipliers on the floor albedo (the hue is carried
      // separately, see chamber.js hueOf). `base` is the single most consequen-
      // tial number in the frame: too high and the stage out-values the actors
      // (§9.1); at zero the arena reads as a pit rather than as dark stone.
      base: 0.62,          // unlit stone — dark, but you can read the masonry
      pool: 0.92,          // peak of a brazier pool
      // §1.8 'an island of light in a dark void' — and the measurable version
      // of it. The outer annulus of the floor is the frame's foreground
      // repoussoir in every pose the game ships; at 0.58 it was still a mid
      // value, which is what kept the bottom third of the wide shot at 0.09
      // and the measured depth spread at 0.10 against §9.4's 0.18. The gold
      // meander band and the orbit rail run through this ring, so it keeps
      // its drawn ornament while the stone under it falls away.
      rimFall: 0.84,       // how far the value drops at the arena edge
      warm: '#ffb070',     // hue the pools drift toward
      cool: '#2b83c4',     // hue the unlit stone drifts toward (§9.6 complement)
      ink: 0.13,
    },

    // The void beneath and beyond the island (§1.8).
    voidKind: 'abyss',
    voidColor: '#0a0713',
    voidRim: '#3a1330',
    ember: { color: '#ff8a44', accent: '#5fd0ff', count: 120, rise: false, speed: 0.55 },
    chains: { count: 12, drop: 13, sag: 1.6 },
    shards: { count: 34, spread: [4, 22], drop: [2, 14] },

    hazard: 'spikes',
    accent: '#5fd0ff',
    key: '#ff5a3c',

    props: {
      density: 1.0,
      mix: { chunk: 4.0, slab: 2.4, drum: 2.0, urn: 1.1, bones: 1.7, capital: 0.9 },
      banners: 6,
      censers: 3,
      statues: ['sentinel', 'shade', 'robed', 'hound'],
      focalStatue: 'hound',
      braziers: 'tripod',
    },
  },

  // =========================================================================
  // ASPHODEL — obsidian isles adrift on a lava sea.
  // key #ff8c1a   /  rim #33e0c0
  // =========================================================================
  asphodel: {
    id: 'asphodel',
    title: 'Asphodel',
    lightRig: 'asphodel',
    grade: 'asphodel',

    mats: {
      floor: 'floor.asphodel',
      dais: 'floor.asphodel',
      wall: 'stone.asphodel',
      bay: 'stone.asphodel',
      column: 'stone.asphodel',
      arch: 'stone.asphodel',
      trim: 'gold.filigree',
      leaf: 'gold.leaf',
      metal: 'bronze.verdigris',
      iron: 'iron.dark',
      rock: 'obsidian',
      rubble: 'obsidian',
      bone: 'bone',
      cloth: 'banner.crimson',
      crystal: 'crystal.violet',
      ember: 'lava',
      medallion: 'medallion.tartarus',
      liquid: 'lava',
      wood: 'wood.dark',
    },

    floorGlaze: {
      base: 0.52, pool: 0.90, rimFall: 0.72,
      warm: '#ff8c1a', cool: '#2fbfa8', ink: 0.10,
    },

    // A lava sea, not an abyss: the void UNDER the island glows, which is the
    // whole identity of the biome. Kept low-value and small in frame so it
    // never becomes the brightest large surface (§9.1 applies to it too).
    voidKind: 'lava',
    voidColor: '#1a0704',
    voidRim: '#c22a06',
    ember: { color: '#ffb247', accent: '#33e0c0', count: 170, rise: true, speed: 0.9 },
    chains: { count: 8, drop: 9, sag: 1.2 },
    shards: { count: 28, spread: [5, 26], drop: [1, 9] },

    hazard: 'lava',
    accent: '#33e0c0',
    key: '#ff8c1a',

    props: {
      density: 0.8,
      mix: { chunk: 5.0, slab: 1.6, drum: 1.2, urn: 0.5, bones: 2.2, capital: 0.5 },
      banners: 3,
      censers: 2,
      statues: ['shade', 'sentinel', 'shade'],
      focalStatue: 'shade',
      braziers: 'bowl',
    },
  },

  // =========================================================================
  // ELYSIUM — marble, laurel and gold over a verdant deep.
  // key #ffe6a3   /  rim #ff5fa8
  // =========================================================================
  elysium: {
    id: 'elysium',
    title: 'Elysium',
    lightRig: 'elysium',
    grade: 'elysium',

    mats: {
      floor: 'floor.elysium',
      dais: 'floor.elysium',
      wall: 'marble.elysium',
      bay: 'marble.elysium',
      column: 'marble.elysium',
      arch: 'marble.elysium',
      trim: 'gold.filigree',
      leaf: 'gold.leaf',
      metal: 'bronze.verdigris',
      iron: 'iron.dark',
      rock: 'obsidian',
      rubble: 'marble.elysium',
      bone: 'bone',
      cloth: 'banner.crimson',
      crystal: 'crystal.violet',
      ember: 'lava',
      medallion: 'medallion.tartarus',
      liquid: 'water.styx',
      wood: 'wood.dark',
    },

    floorGlaze: {
      base: 0.66, pool: 0.92, rimFall: 0.62,
      warm: '#ffe6a3', cool: '#a76fb0', ink: 0.14,
    },

    voidKind: 'abyss',
    voidColor: '#08110e',
    voidRim: '#14402f',
    ember: { color: '#ffe6a3', accent: '#ff5fa8', count: 90, rise: true, speed: 0.4 },
    chains: { count: 6, drop: 11, sag: 1.4 },
    shards: { count: 30, spread: [4, 24], drop: [2, 12] },

    hazard: 'blades',
    accent: '#ff5fa8',
    key: '#ffe6a3',

    props: {
      density: 0.95,
      mix: { chunk: 2.4, slab: 2.0, drum: 2.4, urn: 1.8, bones: 0.5, capital: 1.6 },
      banners: 8,
      censers: 4,
      statues: ['caryatid', 'robed', 'sentinel', 'caryatid'],
      focalStatue: 'caryatid',
      braziers: 'tripod',
    },
  },
};

export const DEFAULT_BIOME = 'tartarus';

export function getBiome(name) {
  return BIOMES[name] || BIOMES[DEFAULT_BIOME];
}

export function isBiome(name) { return !!BIOMES[name]; }

/**
 * Room archetypes. Each is a plan, not a decoration list: the shape function,
 * how many doors it can carry, and which dressing programme suits it.
 * chamber.js consumes these; biomes.js owns them so a designer can read the
 * whole vocabulary of the game's rooms in one place.
 */
// ROOM SCALE (integration pass). The plans were authored at r=16.5..19, i.e.
// 33-38m across. The play camera (entities/camera.js: fov 37, pitch 52,
// distance 21.5) frames ~26m at the player's plane, so at that scale the
// chamber's walls, colonnade and doors were ALWAYS outside the frame: every
// gameplay shot was a hero standing on an unbounded floor with nothing behind
// them, and the character had to be ~90px tall for any of the room to show.
// Hades chambers read as ROOMS — you can see the boundary on three sides while
// the character stays ~1/7 of frame height. The radii below are the authored
// plans scaled by ~0.74 so the room fits the camera it is played through.
// Everything else in world/ derives from bounds.r, so the whole kit follows.
export const ARCHETYPES = {
  rotunda: {
    id: 'rotunda',
    title: 'The Rotunda',
    shape: 'circle',
    radius: 12.6,
    doors: 3,
    peristyle: { count: 14, order: 'doric', h: 8.9, gapAtDoors: true },
    wall: { arcs: 'back', height: 5.4, storeys: 2 },
    dais: null,
    focal: 'apse',
    weight: 1.2,
  },
  oblong: {
    id: 'oblong',
    title: 'The Long Hall',
    shape: 'oblong',
    radius: 13.2,
    aspect: 0.66,
    doors: 2,
    peristyle: { count: 16, order: 'corinthian', h: 8.6, sides: true },
    wall: { arcs: 'sides', height: 6.0, storeys: 2 },
    dais: null,
    focal: 'colonnade',
    weight: 1.0,
  },
  cruciform: {
    id: 'cruciform',
    title: 'The Cross Chamber',
    shape: 'cruciform',
    radius: 13.2,
    doors: 3,
    peristyle: { count: 8, order: 'doric', h: 7.2, atCorners: true },
    wall: { arcs: 'back', height: 5.0, storeys: 1 },
    dais: null,
    focal: 'crossing',
    weight: 0.9,
  },
  terrace: {
    id: 'terrace',
    title: 'The Raised Dais',
    shape: 'circle',
    radius: 12.3,
    doors: 2,
    peristyle: { count: 12, order: 'corinthian', h: 8.8 },
    wall: { arcs: 'back', height: 6.4, storeys: 2 },
    dais: { r: 5.3, h: 1.35, steps: 3, at: [0, -4.4] },
    focal: 'throne',
    weight: 1.0,
  },
  causeway: {
    id: 'causeway',
    title: 'The Causeway',
    shape: 'causeway',
    radius: 14.4,
    aspect: 0.42,
    doors: 2,
    peristyle: { count: 10, order: 'doric', h: 6.8, sides: true },
    wall: { arcs: 'none', height: 0, storeys: 0 },
    dais: null,
    focal: 'bridge',
    parapet: 'full',
    weight: 0.8,
  },
  hypostyle: {
    id: 'hypostyle',
    title: 'The Pillared Hall',
    shape: 'rounded-square',
    radius: 12.6,
    doors: 3,
    peristyle: { count: 12, order: 'corinthian', h: 9.2, grid: true },
    wall: { arcs: 'back', height: 6.8, storeys: 2 },
    dais: null,
    focal: 'grid',
    weight: 1.1,
  },
  ossuary: {
    id: 'ossuary',
    title: 'The Ossuary Shelf',
    shape: 'lobed',
    radius: 12.6,
    doors: 2,
    peristyle: { count: 9, order: 'doric', h: 6.4, ruined: true },
    wall: { arcs: 'back', height: 4.6, storeys: 1, ruined: true },
    dais: null,
    focal: 'ruin',
    weight: 0.9,
  },
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES);

export function getArchetype(name) {
  return ARCHETYPES[name] || ARCHETYPES.rotunda;
}
