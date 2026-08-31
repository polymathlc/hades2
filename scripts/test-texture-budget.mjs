import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { textureProfileForTier } from '../src/materials/texture-budget.js';

const low = textureProfileForTier('low');
const med = textureProfileForTier('med');
const high = textureProfileForTier('high');
const ultra = textureProfileForTier('ultra');
assert.ok(low.proceduralScale <= 0.30 && med.proceduralScale <= 0.42);
assert.ok(high.proceduralScale < 0.60 && ultra.proceduralScale <= 0.75);
assert.ok(low.anisotropy < med.anisotropy && med.anisotropy < high.anisotropy);

const dir = fileURLToPath(new URL('../src/assets/textures/generated/web/', import.meta.url));
const atlases = readdirSync(dir).filter(name => name.endsWith('-web.jpg'));
assert.equal(atlases.length, 9, 'browser atlas set is incomplete');
const bytes = atlases.reduce((sum, name) => sum + statSync(`${dir}/${name}`).size, 0);
assert.ok(bytes < 600_000, `browser atlases exceed 600KB (${bytes})`);
assert.ok(atlases.every(name => statSync(`${dir}/${name}`).size < 90_000), 'one browser atlas was not compressed');
const uiAtlas = fileURLToPath(new URL('../src/assets/ui/generated/web/god-portraits-v1-web.jpg', import.meta.url));
const uiBytes = statSync(uiAtlas).size;
assert.ok(uiBytes < 90_000, `boon portrait atlas was not compressed (${uiBytes})`);

console.log(`texture budget ok: ${atlases.length} material atlases + boon portraits, ${((bytes + uiBytes) / 1024).toFixed(1)} KiB total`);

// ---------------------------------------------------------------------------
// PROCEDURAL TEXTURE MEMORY — the RESIDENT set, not the biggest biome.
//
// The checks above bound the AUTHORED atlases, which are bytes on disk. They
// say nothing about the synthesised set, which is where almost all of the GPU
// memory actually goes.
//
// THE PREVIOUS VERSION OF THIS BLOCK MEASURED THE WRONG NUMBER, and the note it
// shipped with said so out loud: "only one biome is resident at a time" and
// "the peak is unchanged". Both are false, and neither is a subtle call:
//
//   * `src/core/preload.js` -> `preloadSurfaces()` bakes EVERY recipe in
//     `RECIPES` at launch, deliberately, so that nothing takes a synchronous
//     bake during play. All 50 sets are resident from the loading screen on.
//   * `MaterialLibrary.dispose()` has no call site anywhere in `src/`. Nothing
//     is ever freed, so switching biome adds to the resident set and never
//     subtracts from it.
//
// So the honest figure is the sum over `Object.keys(RECIPES)`, and it is about
// twice what the per-biome figure claimed: 23.4 / 47.5 / 100.8 / 155.7 MiB at
// low / med / high / ultra, against a per-biome worst of 14.1 / 26.5 / 53.0 /
// 84.6. A budget test that reports half the resident set is not a budget test.
//
// The model: each cached set is albedo + normal + ORM + (emissive), RGBA8, at
// the resolution `library.js::_size()` picks for the tier, with a full mip
// chain (x4/3). Emissive is counted for every surface rather than only the ones
// that have it — that is the WORST case and a budget is a worst case, and it is
// also what the next surface to gain a glow will cost.
// ---------------------------------------------------------------------------
const { BIOMES } = await import('../src/world/biomes.js');
const { RECIPES, resolveRecipe, recipeSize } = await import('../src/materials/recipes.js');

// library.js _size(): nominal * profile.proceduralScale, snapped to 64, clamped.
const sizeFor = (nominal, scale) => Math.max(128, Math.min(2048, Math.round((nominal * scale) / 64) * 64));
// albedo + normal + ORM + emissive, RGBA8, with a full mip chain (x4/3).
const MAPS = 4, BPP = 4, MIP = 4 / 3;
const bytesFor = (n) => n * n * BPP * MAPS * MIP;

/** Everything preload.js bakes at launch and nothing ever disposes. */
function residentSet(scale) {
  let bytes = 0, count = 0;
  for (const key of Object.keys(RECIPES)) {
    bytes += bytesFor(sizeFor(recipeSize(key), scale));
    count++;
  }
  return { count, bytes };
}

/** One biome's working set — reported for context, no longer the assertion. */
function biomeWorkingSet(biome, scale) {
  const keys = new Set();
  for (const name of Object.values(biome.mats)) {
    const k = resolveRecipe(name);
    // distinct NAMES get distinct baked sets even when they share a recipe, so
    // the cache key is the requested name, not the recipe it resolves to.
    if (k) keys.add(`${name}|${recipeSize(k)}`);
  }
  let bytes = 0;
  for (const e of keys) bytes += bytesFor(sizeFor(Number(e.split('|')[1]), scale));
  return { count: keys.size, bytes };
}

// Measured, this commit: 23.4 / 47.5 / 100.8 / 155.7 MiB across all 50 recipes.
// The ceilings sit ~15% above that — room for a handful of new surfaces, and
// NOT room for a new resolution policy or a fifth map. If a change pushes past
// one of these the answer is to justify the memory, or to stop preloading every
// recipe, not to raise the number.
const TIER_CEILING_MB = { low: 27, med: 55, high: 116, ultra: 179 };
const report = [];
for (const [tier, profile] of Object.entries({ low, med, high, ultra })) {
  const { count, bytes } = residentSet(profile.proceduralScale);
  const mb = bytes / (1024 * 1024);
  let worst = { id: '', mb: 0 };
  for (const b of Object.values(BIOMES)) {
    const w = biomeWorkingSet(b, profile.proceduralScale).bytes / (1024 * 1024);
    if (w > worst.mb) worst = { id: b.id, mb: w };
  }
  report.push(`${tier}: ${mb.toFixed(1)} MiB resident across all ${count} recipes `
    + `(worst single biome for reference: ${worst.id} ${worst.mb.toFixed(1)} MiB)`);
  assert.ok(
    mb <= TIER_CEILING_MB[tier],
    `resident procedural texture set at tier '${tier}' is ${mb.toFixed(1)} MiB, over the ${TIER_CEILING_MB[tier]} MiB ceiling`,
  );
}
// Every architectural role must resolve to a real recipe: a typo in biomes.js
// silently falls through to the fallback painter, which still renders and is
// therefore invisible until someone looks closely at a wall.
for (const b of Object.values(BIOMES)) {
  for (const [role, name] of Object.entries(b.mats)) {
    assert.ok(resolveRecipe(name), `biome '${b.id}' role '${role}' names an unknown material '${name}'`);
  }
}
console.log('procedural texture budget ok:\n  ' + report.join('\n  '));
