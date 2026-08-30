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
