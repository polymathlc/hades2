import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { textureProfileForTier } from '../src/materials/texture-budget.js';
import { RECIPES, ALIASES, bakeSet, resolveRecipe } from '../src/materials/recipes.js';

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
// Every recipe in the book must BAKE: no thrown error (bakeSet swallows one into
// `error` and ships the fallback), every byte of every map finite and in range,
// and the whole book inside a time ceiling. The bake is the same code path the
// worker pool runs at boot, at a small size so the test stays fast; a recipe
// that regresses by an order of magnitude still trips the ceiling here.
// ---------------------------------------------------------------------------
const N = 64;
// Measured: the whole book bakes in ~1.5s at n=64 on a LOADED CI container
// (~2.5s at n=256 quiet). 4000ms is ~2.6x headroom over that loaded figure —
// enough to absorb a noisy machine, not enough to hide a recipe going 3x slower.
const TOTAL_MS_CEILING = 4000;
const MUST_EXIST = [
  'stone.tartarus', 'stone.asphodel', 'marble.elysium', 'obsidian', 'gold.filigree',
  'bronze.verdigris', 'bone', 'lava', 'blood.pool', 'floor.tartarus', 'floor.asphodel',
  'floor.elysium', 'banner.crimson', 'wood.dark', 'iron.dark', 'crystal.violet', 'water.styx',
];
for (const name of MUST_EXIST) assert.ok(resolveRecipe(name), `ARCHITECTURE §2.7 material missing: ${name}`);
for (const [alias, target] of Object.entries(ALIASES)) assert.ok(RECIPES[target], `alias ${alias} -> ${target} points at nothing`);

const checkBytes = (buf, what, key) => {
  assert.ok(buf instanceof Uint8Array && buf.length === N * N * 4, `${key}: ${what} is not an RGBA8 ${N}x${N} buffer`);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (!(v >= 0 && v <= 255)) assert.fail(`${key}: ${what} has an invalid byte at ${i}: ${v}`);
  }
};
bakeSet('stone.tartarus', 32);            // warm the JIT so the ceiling measures the recipes, not V8
const keys = Object.keys(RECIPES);
const t0 = performance.now();
const timings = [];
for (const key of keys) {
  const t1 = performance.now();
  const b = bakeSet(key, N);
  timings.push([key, performance.now() - t1]);
  assert.ok(b && b.name === key && b.size === N, `${key}: bakeSet returned nothing`);
  assert.equal(b.error, null, `${key}: recipe threw (${b.error}) and shipped the fallback`);
  checkBytes(b.map, 'albedo', key);
  checkBytes(b.normalMap, 'normal', key);
  checkBytes(b.ormMap, 'orm', key);
  if (b.emissiveMap) checkBytes(b.emissiveMap, 'emissive', key);
  // a map that came out as one flat value is a recipe whose fields collapsed
  let lo = 255, hi = 0;
  for (let i = 0; i < b.map.length; i += 4) { const l = b.map[i] + b.map[i + 1] + b.map[i + 2]; if (l < lo) lo = l; if (l > hi) hi = l; }
  assert.ok(hi - lo > 12, `${key}: albedo is flat (range ${hi - lo}/765) — the recipe's value field collapsed`);
  assert.ok(Number.isFinite(b.emissiveIntensity) && b.emissiveIntensity >= 0, `${key}: emissiveIntensity is not a finite number`);
}
const total = performance.now() - t0;
timings.sort((a, b) => b[1] - a[1]);
assert.ok(total < TOTAL_MS_CEILING,
  `recipe book bake took ${total.toFixed(0)}ms at n=${N} against a ${TOTAL_MS_CEILING}ms ceiling; slowest: `
  + timings.slice(0, 5).map(([k, ms]) => `${k} ${ms.toFixed(0)}ms`).join(', '));
console.log(`recipe book ok: ${keys.length} recipes baked at ${N}x${N} in ${total.toFixed(0)}ms (slowest ${timings[0][0]} ${timings[0][1].toFixed(0)}ms)`);
