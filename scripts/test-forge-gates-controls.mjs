import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOONS, BoonState, GOD_INFO, GOD_KEYS } from '../src/game/boons.js';
import { WeaponRuntime } from '../src/entities/weapons.js';
import { planDoorChoices } from '../src/world/doors.js';
import { Audio } from '../src/audio/index.js';
import { CONTROL_ROWS } from '../src/core/controls.js';

class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) { const a = this.map.get(name) || []; a.push(fn); this.map.set(name, a); return () => {}; }
  emit(name, data) { for (const fn of this.map.get(name) || []) fn(data); }
}
const noop = () => {};
const rng = { f: () => 0.314159, pick: a => a[0] };

// Every gate has a stable, distinct deity and keeps a build-defining boon exit.
const planA = planDoorChoices(3, () => 0.314159);
const planB = planDoorChoices(3, () => 0.314159);
assert.deepEqual(planA, planB);
assert.equal(new Set(planA.map(x => x.god)).size, 3);
assert.ok(planA.some(x => x.kind === 'boon'));
assert.ok(planA.every(x => GOD_INFO[x.god]));

// Even if a duo is unlocked and forced, an unrelated god gate cannot show it.
{
  const { ctx } = harness('blade');
  for (const id of ['ares.passive', 'artemis.passive']) {
    const boon = BOONS.find(b => b.id === id); ctx.boons.grant(ctx.boons.offer(boon));
  }
  const offers = ctx.boons.roll(rng, { count: 3, god: 'zeus', allowDuo: true, duoChance: 1 });
  assert.ok(offers.every(o => o.gods.includes('zeus')));
}

function harness(weaponId) {
  const events = new Bus();
  const player = {
    position: new THREE.Vector3(), facing: new THREE.Vector2(1, 0), radius: 0.5,
    health: 100, maxHealth: 100, mana: 100, maxMana: 100, state: 'move',
    onWeaponState: noop,
  };
  const fired = [], hitboxes = [];
  const ctx = {
    player, events, rng, CAPTURE: true,
    ui: { setHealth: noop, setMana: noop },
    vfx: { burst: noop, beam: noop, shockwave: noop, impact: noop, slash: noop },
    audio: { sfx: noop }, engine: { slowmo: noop },
    world: { collide: noop },
  };
  ctx.boons = new BoonState(ctx);
  const combat = {
    ctx, clamp01: x => Math.max(0, Math.min(1, x)), _v3a: new THREE.Vector3(), _v3b: new THREE.Vector3(),
    hitboxes: { spawn: d => (hitboxes.push(d), hitboxes.length), cancel: noop },
    projectiles: {
      fire: d => (fired.push(d), fired.length), forEachIncoming: noop,
      reflect: () => true,
    },
    activateDeflect: noop, hitstop: noop,
  };
  ctx.combat = combat;
  const runtime = new WeaponRuntime(combat, player, weaponId);
  return { ctx, player, combat, runtime, fired, hitboxes };
}

for (const weapon of ['blade', 'spear', 'bow', 'shield']) {
  const { ctx } = harness(weapon);
  const offers = ctx.boons.roll(rng, { count: 3, god: 'hephaestus', weapon, allowDuo: false });
  assert.equal(offers.length, 3, `${weapon} forge did not offer three cards`);
  assert.ok(offers.every(o => o.god === 'hephaestus' && o.boon.weapon === weapon));
  for (const offer of offers) ctx.boons.grant(offer);
  assert.equal(ctx.boons.list().filter(r => r.god === 'hephaestus').length, 3);
}

// Switching weapons must never surface an upgrade for the previous weapon.
{
  const { ctx } = harness('blade');
  const old = BOONS.find(b => b.id === 'hephaestus.blade.wave');
  ctx.boons.grant(ctx.boons.offer(old));
  const offers = ctx.boons.roll(rng, { count: 3, god: 'hephaestus', weapon: 'bow', allowDuo: false, preferUpgrade: true });
  assert.ok(offers.every(o => o.boon.weapon === 'bow'));
}

{
  const { ctx, runtime, fired, hitboxes } = harness('blade');
  for (const boon of BOONS.filter(b => b.god === 'hephaestus' && b.weapon === 'blade')) ctx.boons.grant(ctx.boons.offer(boon));
  runtime.stepIndex = runtime.weapon.combo.length - 1;
  runtime._fire(runtime.weapon.combo.at(-1));
  assert.ok(fired.some(x => x.tag === 'forge:blade-wave'));
  assert.ok(hitboxes.some(x => x.tag === 'forge:blade-echo'));
  assert.ok(hitboxes.some(x => x.status === 'burn'));
  const zeus = BOONS.find(b => b.id === 'zeus.attack');
  ctx.boons.grant(ctx.boons.offer(zeus));
  hitboxes.length = 0;
  runtime._fire(runtime.weapon.combo.at(-1));
  assert.ok(hitboxes.some(x => x.tag === 'forge:blade-ember' && x.status === 'burn'), 'Emberbrand was suppressed by an Olympian status');
}

for (const weapon of ['spear', 'bow']) {
  const { ctx, runtime, fired } = harness(weapon);
  for (const boon of BOONS.filter(b => b.god === 'hephaestus' && b.weapon === weapon)) ctx.boons.grant(ctx.boons.offer(boon));
  runtime._loose(runtime.weapon.charge, 1, true);
  assert.equal(fired.length, 3, `${weapon} full shot did not split three ways`);
  assert.ok(fired.every(x => x.kind === 'homing'), `${weapon} homing forge was not consumed`);
  if (weapon === 'bow') assert.ok(fired.every(x => x.blastRadius > 0), 'bow blast forge was not consumed');
  else { runtime.recall(); assert.ok(fired.at(-1).blastRadius > 0, 'spear recall blast was not consumed'); }
}

{
  const { ctx, runtime, hitboxes } = harness('shield');
  for (const boon of BOONS.filter(b => b.god === 'hephaestus' && b.weapon === 'shield')) ctx.boons.grant(ctx.boons.offer(boon));
  runtime.state = 'block'; runtime.t = 0.01;
  assert.equal(runtime.absorb({ amount: 20, dir: { x: -1, z: 0 } }), 0);
  assert.ok(runtime._forgeBank > 0, 'perfect block did not bank forge damage');
  runtime._beginRush(true);
  assert.ok(hitboxes.some(x => x.tag === 'forge:shield-ram'));
  assert.ok(hitboxes.some(x => x.tag === 'shield:rush' && x.damage > runtime.weapon.charge.damageFull));
  runtime.state = 'block'; runtime.t = runtime.weapon.block.raise;
  runtime.combat.projectiles.forEachIncoming = (_a, _r, fn) => fn({ x: 1, z: 0 });
  runtime._stepBlock(0.01);
  assert.ok(hitboxes.some(x => x.tag === 'forge:shield-reflect'));
}

// Displayed controls are all live actions; dead debug/map bindings stay out.
const controlText = CONTROL_ROWS.flat().join(' ').toLowerCase();
for (const action of ['move', 'aim', 'attack', 'special', 'cast', 'dash', 'call', 'interact', 'pause']) assert.ok(controlText.includes(action));
assert.ok(!controlText.includes('debug') && !controlText.includes('map'));

// Canvas sliders reach the real audio authority, including before unlock.
{
  const events = new Bus();
  const menus = { settings: {} };
  const audio = new Audio();
  await audio.init({ CAPTURE: false, events, ui: { menus }, rng: { fork: () => ({ f: () => 0.5 }) } });
  events.emit('settings.volume', { channel: 'master', value: 0.21 });
  events.emit('settings.volume', { channel: 'music', value: 0.34 });
  events.emit('settings.volume', { channel: 'sfx', value: 0.56 });
  assert.equal(audio.getVolume('master'), 0.21);
  assert.equal(audio.getVolume('music'), 0.34);
  assert.equal(audio.getVolume('sfx'), 0.56);
  assert.equal(typeof menus.settings.master, 'number');
  audio.dispose();
}

assert.equal(GOD_KEYS.length, 11);
console.log('forge/gates/controls ok: 11 gods, god-locked gates, 12 live forges, audio bridge');
