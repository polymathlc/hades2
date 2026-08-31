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
// PROCEDURAL TEXTURE MEMORY.
//
// The checks above bound the AUTHORED atlases, which are bytes on disk. They
// say nothing about the synthesised set, which is where almost all of the GPU
// memory actually goes: one biome's working set is a few dozen surfaces, each
// carrying albedo + normal + ORM (+ emissive), each at a resolution the tier
// profile picks, each with a full mip chain. That is the number a texture
// budget is supposed to be about, and nothing was measuring it — so a material
// change could quietly triple the resident set and every test would still pass.
//
// This derives the real per-biome working set from world/biomes.js (the
// authoritative role -> material table) through the same size rule library.js
// uses, and holds it under a stated ceiling. It is deliberately computed rather
// than hard-coded per surface, so adding a material shows up here as a number
// rather than as a silent regression.
// ---------------------------------------------------------------------------
const { BIOMES } = await import('../src/world/biomes.js');
const { resolveRecipe, recipeSize } = await import('../src/materials/recipes.js');

// library.js _size(): nominal * profile.proceduralScale, snapped to 64.
const sizeFor = (nominal, scale) => Math.max(128, Math.round((nominal * scale) / 64) * 64);
// albedo + normal + ORM + emissive, RGBA8, with a full mip chain (x4/3).
const MAPS = 4, BPP = 4, MIP = 4 / 3;
const bytesFor = (n) => n * n * BPP * MAPS * MIP;

function biomeWorkingSet(biome, scale) {
  const keys = new Set();
  for (const name of Object.values(biome.mats)) {
    const k = resolveRecipe(name);
    // distinct NAMES get distinct baked sets even when they share a recipe
    // (that is how the generated atlases bind per-biome albedo), so the cache
    // key is the requested name, not the recipe it resolves to.
    if (k) keys.add(`${name}|${recipeSize(k)}`);
  }
  let bytes = 0;
  for (const e of keys) bytes += bytesFor(sizeFor(Number(e.split('|')[1]), scale));
  return { count: keys.size, bytes };
}

// Measured at the time of writing: tartarus (the largest working set, 22
// surfaces) is 14.1 / 26.5 / 53.0 / 84.6 MiB. The ceilings sit ~17% above that,
// which is room for a couple of new surfaces and NOT room for a new resolution
// policy or a doubled map count.
const TIER_CEILING_MB = { low: 17, med: 31, high: 62, ultra: 99 };
const report = [];
for (const [tier, profile] of Object.entries({ low, med, high, ultra })) {
  let worst = { id: '', mb: 0, count: 0 };
  for (const b of Object.values(BIOMES)) {
    const { count, bytes } = biomeWorkingSet(b, profile.proceduralScale);
    const mb = bytes / (1024 * 1024);
    if (mb > worst.mb) worst = { id: b.id, mb, count };
  }
  report.push(`${tier}: ${worst.mb.toFixed(1)} MiB across ${worst.count} surfaces (worst biome: ${worst.id})`);
  assert.ok(
    worst.mb <= TIER_CEILING_MB[tier],
    `procedural texture set for '${worst.id}' at tier '${tier}' is ${worst.mb.toFixed(1)} MiB, over the ${TIER_CEILING_MB[tier]} MiB ceiling`,
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
