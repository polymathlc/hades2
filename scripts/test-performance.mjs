import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { Engine } from '../src/core/engine.js';
import { chooseGraphicsTier } from '../src/core/quality.js';
import { ProjectileSystem, markDynamicRange, segmentCircleTOI } from '../src/entities/projectiles.js';
import { PostFX } from '../src/render/postfx.js';
import { TIERS } from '../src/render/renderer.js';
import { NectarDrop, TitanBloodDrop } from '../src/world/homebase.js';
import {
  Enemy, bossDeathBeat, usesAdditiveDeathDissolve,
  makeDeathDissolveMaterial, prewarmDeathDissolve, disposeDeathDissolveMaterial,
} from '../src/entities/enemies/base.js';
import { installPrebuilt } from '../src/materials/prebuild-cache.js';
import { Props } from '../src/world/props.js';
import { chamberAmbientCounts, isCaptureMode } from '../src/world/chamber.js';

const noop = () => {};

// The automatic browser tier must never double simulation work on a normal
// laptop. Ultra remains the explicit 120 Hz/capture path.
assert.equal(new Engine({ quality: { tier: 'high' } }).fixedDt, 1 / 60);
assert.equal(new Engine({ quality: { tier: 'ultra' } }).fixedDt, 1 / 120);
assert.equal(chooseGraphicsTier({ deviceMemory: 8, cores: 8, width: 1920, height: 1080 }), 'med');
assert.equal(chooseGraphicsTier({ deviceMemory: 16, cores: 12, width: 1920, height: 1080 }), 'high');
assert.equal(TIERS.low.shadows, false);
assert.equal(TIERS.med.shadows, false, 'automatic Medium tier regressed to a second scene submission');
assert.equal(TIERS.high.shadows, true);
assert.equal(isCaptureMode({ CAPTURE: false, capture: {} }), false);
assert.equal(isCaptureMode({ CAPTURE: true }), true);
assert.equal(bossDeathBeat('low'), null);
assert.equal(bossDeathBeat('med'), null);
assert.ok(bossDeathBeat('high').duration <= 0.3);
assert.ok(bossDeathBeat('ultra').scale >= 0.7);

// Low/Medium never create the additive death-shell program. High/Ultra warm
// both ordinary and skinned variants once, before a kill can reach rendering.
assert.equal(usesAdditiveDeathDissolve('low'), false);
assert.equal(usesAdditiveDeathDissolve('med'), false);
assert.equal(usesAdditiveDeathDissolve('high'), true);
assert.equal(usesAdditiveDeathDissolve('ultra'), true);
{
  let calls = 0;
  const targetScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const material = makeDeathDissolveMaterial();
  const renderer = {
    async compileAsync(root, usedCamera, scene) {
      calls++;
      assert.equal(usedCamera, camera);
      assert.equal(scene, targetScene);
      let meshes = 0, skinned = 0;
      root.traverse(object => {
        if (object.isMesh) meshes++;
        if (object.isSkinnedMesh) skinned++;
      });
      assert.equal(meshes, 2);
      assert.equal(skinned, 1);
    },
  };
  assert.equal(await prewarmDeathDissolve({ renderer, scene: targetScene, camera }, material), true);
  assert.equal(calls, 1, 'death dissolve programs were warmed more than once');
  assert.equal(material._deathDissolveWarmMaterials?.length, 1,
    'skinned program record was not retained after warmup');
  disposeDeathDissolveMaterial(material);
}
{
  const enemy = new Enemy({ kind: 'perf-contract', deathTime: 1 });
  enemy.root = new THREE.Group();
  enemy.flashMat = {};
  let applied = 'unset';
  enemy.visual = { setFlash: material => { applied = material; }, update: noop };
  enemy._deathT = 0;
  enemy._updateDeath(0.2, { world: { heightAt: () => 0 } });
  assert.equal(enemy._dissolveMat, null, 'Low/Med fallback lazily allocated a dissolve material');
  assert.equal(applied, null, 'Low/Med fallback still selected the additive shell path');
}
const materialSource = readFileSync(new URL('../src/materials/library.js', import.meta.url), 'utf8');
for (const key of ['characterrig.skin', 'characterrig.cloth', 'characterrig.hair'])
  assert.ok(materialSource.includes(`'${key}'`), `${key} fell back to a synchronous boot bake`);
assert.ok(materialSource.includes('prepareBiome(name)'), 'next-biome material prewarm is missing');

// A late worker result must not replace/leak a texture set that a chamber had
// to build synchronously while that worker was in flight.
{
  const cache = new Map();
  let installs = 0;
  const cacheKey = 'stone.asphodel|384';
  const live = { name: 'live-sync-set' };
  cache.set(cacheKey, live);
  installPrebuilt(cache, cacheKey, { name: 'late-worker-set' }, raw => { installs++; return raw; });
  assert.equal(cache.get(cacheKey), live);
  assert.equal(installs, 0, 'late worker result overwrote a live texture set');
}

// Input edges survive render-only frames and are consumed by exactly one
// fixed step, even when a slow frame performs multiple catch-up steps.
{
  const engine = new Engine({ quality: { tier: 'low' } });
  engine.ctx.input.begin = noop;
  let presses = 0, updates = 0;
  engine.add({ update: () => {
    updates++;
    if (engine.ctx.input.pressed('attack')) presses++;
  } });
  engine.ctx.input._pressed.add('attack');
  engine.step(1 / 120);
  assert.equal(updates, 0);
  assert.equal(engine.ctx.input.pressed('attack'), true, 'render-only frame discarded an input edge');
  engine.step(1 / 120);
  assert.equal(presses, 1);
  engine.ctx.input._pressed.add('attack');
  engine.step(1 / 30);
  assert.equal(presses, 2, 'catch-up steps consumed one press more than once');
}

// A live auto-exposure meter may synchronize with the GPU at most 10 times per
// second. Capture deliberately samples every render for deterministic grading.
{
  const post = new PostFX();
  const ctx = { time: { unscaledT: 0, unscaledDt: 1 / 60 } };
  assert.equal(post._meterDue(ctx), true);
  ctx.time.unscaledT = 0.05;
  assert.equal(post._meterDue(ctx), false);
  ctx.time.unscaledT = 0.101;
  assert.equal(post._meterDue(ctx), true);
  assert.ok(post._meterDt >= 0.1 && post._meterDt < 0.11);
  ctx.CAPTURE = true;
  assert.equal(post._meterDue(ctx), true);
  assert.equal(post._meterDue(ctx), true);

  // A capture-shaped helper object must not disable throttling in live mode;
  // the explicit CAPTURE boolean is the sole mode authority.
  const live = new PostFX();
  const liveCtx = { CAPTURE: false, capture: {}, time: { unscaledT: 0, unscaledDt: 1 / 60 } };
  assert.equal(live._meterDue(liveCtx), true);
  liveCtx.time.unscaledT = 0.05;
  assert.equal(live._meterDue(liveCtx), false);
}

// Swept collision keeps 60 Hz simulation safe for the fastest rail bolt.
{
  assert.ok(segmentCircleTOI(0, 0, 0.7, 0, 0.35, 0, 0.08) >= 0,
    'minimum-radius target between rail endpoints was skipped');
  assert.equal(segmentCircleTOI(0, 0, 0.7, 0, 0.35, 0.2, 0.08), -1);

  const makeHarness = (world, onHit = noop, slots = 1) => {
    const ps = new ProjectileSystem();
    ps.pool = Array.from({ length: slots }, (_, i) => ps._blank(i));
    ps.ctx = {
      world, player: null,
      events: { emit: noop },
      vfx: { impact: noop, burst: noop, shockwave: noop },
    };
    ps.combat = {
      hitboxes: { teamOf: e => e?.team === 'player' ? 1 : 2 },
      projectileHit: onHit,
    };
    return ps;
  };
  const enemy = x => ({ team: 'enemy', position: new THREE.Vector3(x, 0, 0), radius: 0.04, height: 1.2, alive: true, dead: false });
  const source = { team: 'player' };

  // Entity centred between x=0 and the x=.7 endpoint is still struck.
  {
    let hit = 0;
    const ps = makeHarness({ bounds: { r: 10 }, collide: noop }, () => hit++);
    ps.fire({ x: 0, y: 0.6, z: 0, dx: 1, dz: 0, speed: 42, radius: 0.04, source });
    ps.update(1 / 60, ps.ctx, [enemy(0.35)]);
    assert.equal(hit, 1);
    assert.equal(ps.live.length, 0, 'single-hit rail bolt did not expire on swept contact');
  }

  // Endpoint hits and piercing through two in-step contacts retain semantics,
  // resolving by time of impact even when the targets array is reversed.
  {
    const struck = [];
    const ps = makeHarness({ bounds: { r: 10 }, collide: noop }, (_p, e) => struck.push(e));
    const a = enemy(0.22), b = enemy(0.70);
    ps.fire({ x: 0, y: 0.6, z: 0, dx: 1, dz: 0, speed: 42, radius: 0.04, source, pierce: 2 });
    ps.update(1 / 60, ps.ctx, [b, a]);
    assert.deepEqual(struck, [a, b]);
    assert.equal(ps.live.length, 0, 'piercing bolt survived after consuming both contacts');
  }

  // A non-piercing projectile must never shoot through the near target to hit
  // a farther target that happened to be earlier in storage order.
  {
    const struck = [];
    const ps = makeHarness({ bounds: { r: 10 }, collide: noop }, (_p, e) => struck.push(e));
    const near = enemy(0.22), far = enemy(0.62);
    ps.fire({ x: 0, y: 0.6, z: 0, dx: 1, dz: 0, speed: 42, radius: 0.04, source });
    ps.update(1 / 60, ps.ctx, [far, near]);
    assert.deepEqual(struck, [near]);
  }

  // Cast lodging resolves at swept contact and keeps the projectile alive.
  {
    let ps;
    const target = enemy(0.35);
    ps = makeHarness({ bounds: { r: 10 }, collide: noop }, p => ps.lodgeCastShard(p, target, 8));
    const id = ps.fire({ x: 0, y: 0.6, z: 0, dx: 1, dz: 0, speed: 42, radius: 0.04, source, castShard: true });
    ps.update(1 / 60, ps.ctx, [target]);
    assert.equal(ps.get(id)?.lodgedTarget, target);
    assert.equal(ps.live.length, 1, 'lodged Cast was incorrectly expired');
  }

  // A thin AABB between endpoints blocks the bolt even though the endpoint is
  // clear; collide() is sampled allocation-free at <= projectile-radius gaps.
  {
    let checks = 0;
    const world = { bounds: { r: 10 }, collide(v, r) {
      checks++;
      if (v.x >= 0.33 - r && v.x <= 0.37 + r && Math.abs(v.z) <= 0.04 + r) v.x = 0.33 - r;
    } };
    const ps = makeHarness(world);
    ps.fire({ x: 0, y: 0.6, z: 0, dx: 1, dz: 0, speed: 42, radius: 0.04, source });
    ps.update(1 / 60, ps.ctx, []);
    assert.ok(checks > 1, 'fast bolt only tested its world endpoint');
    assert.equal(ps.live.length, 0, 'fast bolt tunneled through thin world cover');
  }
}

// Dynamic instance buffers upload only their live prefix, not the capacity of
// 384 projectiles / 3,072 trail segments.
{
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(96), 3);
  const before = attr.version;
  markDynamicRange(attr, 7);
  assert.ok(attr.version > before);
  assert.deepEqual(attr.updateRanges, [{ start: 0, count: 21 }]);
}

// Boss rewards must not change the scene's light count after a kill: doing so
// invalidates light-count shader permutations on standard materials.
{
  const scene = new THREE.Scene();
  const ctx = {
    scene, quality: { tier: 'high' },
    player: { position: new THREE.Vector3(99, 0, 99) },
    ui: { prompt: noop }, vfx: { burst: noop, shockwave: noop },
  };
  const drops = [
    new NectarDrop(ctx, new THREE.Vector3(), 2, noop),
    new TitanBloodDrop(ctx, new THREE.Vector3(1, 0, 0), 1, noop),
  ];
  let pointLights = 0;
  for (const drop of drops) drop.root.traverse(o => { if (o.isPointLight) pointLights++; });
  assert.equal(pointLights, 0);
for (const drop of drops) drop.dispose();
}

// Chamber practical lights are borrowed from LightRig and returned on every
// clear, so repeated room/biome rebuilds cannot silently exhaust the pool.
{
  const pool = Array.from({ length: 3 }, () => ({ free: true }));
  const lighting = {
    acquireLight() {
      const light = pool.find(candidate => candidate.free) || null;
      if (light) light.free = false;
      return light;
    },
    releaseLight(light) {
      assert.equal(light.free, false, 'same pooled light was released twice');
      light.free = true;
    },
  };
  const props = new Props();
  const ctx = { lighting };
  for (let cycle = 0; cycle < 4; cycle++) {
    assert.ok(props.borrowLight(ctx, {}));
    assert.ok(props.borrowLight(ctx, {}));
    assert.equal(pool.filter(light => light.free).length, 1);
    props.dispose();
    assert.equal(pool.filter(light => light.free).length, pool.length,
      `chamber rebuild ${cycle} leaked a pooled practical`);
  }
}

// Renderer quality must propagate to both ambient chamber fields. Low keeps
// materially fewer instances instead of treating every positive mote budget
// as a truthy full-quality toggle.
{
  const biome = { ember: { count: 90 } };
  const low = chamberAmbientCounts(biome, { tier: 'low', render: { motes: 120 } });
  const med = chamberAmbientCounts(biome, { tier: 'med', render: { motes: 350 } });
  const high = chamberAmbientCounts(biome, { tier: 'high', render: { motes: 700 } });
  assert.ok(low.drips <= high.drips * 0.5 && low.embers <= high.embers * 0.5,
    'Low did not materially reduce chamber ambient instances');
  assert.ok(low.drips < med.drips && med.drips < high.drips);
  assert.ok(low.embers < med.embers && med.embers < high.embers);
}

console.log('performance contracts: ok');
