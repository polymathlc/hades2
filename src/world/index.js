// OWNER: AGENT-WORLD — public surface of the world module.
//
//   World      the chamber system registered on ctx.world (chamber.js)
//   Kit        the ornate architecture kit (kit.js)
//   Doors      chamber exits + reward sigils (doors.js)
//   Props      scatter + animated dressing (props.js)
//   BIOMES     authored biome look contracts (biomes.js)
//   ARCHETYPES the room plan vocabulary (biomes.js)
//
// Other systems should reach the world through `ctx.world`; these exports exist
// for tooling, tests and any agent that wants to build a piece of the kit
// (a column, a brazier, a banner) inside its own scene.
export { World, World as default } from './chamber.js';
export { Kit, Batcher, Parts, mergeGeos, faceted, lathe, taperedTube, catenary,
         prism, flutedShaft, acanthusLeaf, volute, meanderPeriod, meanderRail,
         eggAndDartUnit, beadAndReelUnit, dentilUnit, clothGeo, foldify,
         reliefShade, chamferedPrism, ensureColor,
         columnDrumGeo, rubbleChunkGeo, slabGeo, amphoraGeo, bonePileGeo,
         brokenCapitalGeo, TAU, DEG } from './kit.js';
export { Doors, REWARDS, REWARD_KINDS } from './doors.js';
export { Props } from './props.js';
export { BIOMES, ARCHETYPES, ARCHETYPE_IDS, DEFAULT_BIOME, getBiome, getArchetype, isBiome } from './biomes.js';
