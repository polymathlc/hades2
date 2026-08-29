import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOONS, BoonState, GOD_INFO, GOD_KEYS } from '../src/game/boons.js';
import { WeaponRuntime } from '../src/entities/weapons.js';
import { CombatSystem } from '../src/entities/combat.js';
import { planDoorChoices } from '../src/world/doors.js';
import { HomeBase, HOME_ALTAR_POS } from '../src/world/homebase.js';
import { RunState } from '../src/game/run.js';
import { Audio } from '../src/audio/index.js';
import { CONTROL_ROWS } from '../src/core/controls.js';
import { BIOMES } from '../src/world/biomes.js';
import { Kit } from '../src/world/kit.js';
import { Engine } from '../src/core/engine.js';
import { chooseGraphicsTier, graphicsDprCap } from '../src/core/quality.js';
import { TIERS } from '../src/render/renderer.js';
import { GRADES } from '../src/render/shaders/grades.js';

class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) { const a = this.map.get(name) || []; a.push(fn); this.map.set(name, a); return () => {}; }
  emit(name, data) { for (const fn of this.map.get(name) || []) fn(data); }
}
const noop = () => {};
const rng = { f: () => 0.314159, pick: a => a[0] };

// Browser quality policy: explicit choices win, weak hardware starts low, and
// only capable machines default to the full high-cost pipeline.
assert.equal(chooseGraphicsTier({ capture: true, requested: 'low' }), 'ultra');
assert.equal(chooseGraphicsTier({ requested: 'low', stored: 'high' }), 'low');
assert.equal(chooseGraphicsTier({ stored: 'med', deviceMemory: 16, cores: 16 }), 'med');
assert.equal(chooseGraphicsTier({ deviceMemory: 4, cores: 4, width: 1920, height: 1080 }), 'low');
assert.equal(chooseGraphicsTier({ deviceMemory: 8, cores: 8, width: 1920, height: 1080 }), 'high');
assert.equal(chooseGraphicsTier({}), 'med');
assert.equal(graphicsDprCap('low'), 1);
assert.equal(graphicsDprCap('med'), 1.25);
assert.ok(TIERS.low.renderScale <= 0.7 && !TIERS.low.shadows && !TIERS.low.bloom && !TIERS.low.ao && TIERS.low.dustLayers === 0);
assert.ok(TIERS.med.renderScale < TIERS.high.renderScale && !TIERS.med.godrays);
assert.equal(new Engine({ quality: { tier: 'low' } }).fixedDt, 1 / 60);
assert.equal(new Engine({ quality: { tier: 'high' } }).fixedDt, 1 / 120);
for (const name of ['tartarus', 'asphodel', 'elysium']) {
  const grade = GRADES[name];
  assert.ok(grade.exposure >= (name === 'elysium' ? 0.95 : 1.2), `${name} exposure regressed into a gloomy range`);
  assert.ok(grade.black <= 0.002, `${name} black point crushes texture detail`);
  assert.ok(grade.vignette.amount <= 0.25 && grade.vignette.floor <= 0.2, `${name} vignette obscures the play area`);
}

// The Nectar altar is solid home geometry: entering its footprint must rescue
// the player to walkable floor, without making the altar impossible to use.
{
  let opened = 0, interact = false;
  const player = {
    position: HOME_ALTAR_POS.clone(), radius: 0.45,
    velocity: new THREE.Vector3(-2, 0, 0), knock: new THREE.Vector3(-1, 0, 0),
  };
  const home = new HomeBase({ player, input: { pressed: a => a === 'interact' && interact } }, { onAltar: () => opened++ });
  home.update(1 / 60);
  assert.ok(Number.isFinite(player.position.x) && Number.isFinite(player.position.z));
  assert.ok(Math.hypot(player.position.x - HOME_ALTAR_POS.x, player.position.z - HOME_ALTAR_POS.z) > 3.2);
  player.position.copy(HOME_ALTAR_POS).add(new THREE.Vector3(-3.35, 0, 0));
  interact = true;
  home.update(1 / 60);
  assert.equal(opened, 1, 'safe altar radius made Nectar interaction unreachable');
}

// A clear publishes one fresh set; choosing any gate removes that whole set
// before the boon overlay/next chamber can show behind it.
{
  let prompts = ['old'], sigils = ['old'];
  const exits = [
    { god: 'zeus', kind: 'boon', anchor: new THREE.Vector3(1, 0, 0) },
    { god: 'poseidon', kind: 'gold', anchor: new THREE.Vector3(-1, 0, 0) },
  ];
  const run = new RunState();
  run.ctx = {
    world: { setCleared: noop, getExits: () => exits },
    ui: {
      clearPrompts: () => { prompts = []; }, clearSigils: () => { sigils = []; },
      prompt: (_p, text) => prompts.push(text), sigil: (_p, o) => sigils.push(o.god),
    },
    boons: { mods: {} }, events: new Bus(), player: null,
  };
  run.state = 'playing'; run.roomCleared = false;
  run._onCleared({});
  assert.deepEqual(prompts, ['Zeus · BOON', 'Poseidon · GOLD']);
  assert.deepEqual(sigils, ['zeus', 'poseidon']);
  run._claimBoon = () => new Promise(() => {});
  run._onDoor({ kind: 'boon', god: 'zeus' });
  assert.deepEqual(prompts, []);
  assert.deepEqual(sigils, []);
}

// Each biome owns exactly one distinct divine landmark. The chained shade and
// repeated perimeter statues must never return through biome configuration.
const landmarks = { tartarus: 'hades', asphodel: 'poseidon', elysium: 'zeus' };
const statueKit = Object.create(Kit.prototype);
for (const [biome, god] of Object.entries(landmarks)) {
  assert.deepEqual(BIOMES[biome].props.statues, []);
  assert.equal(BIOMES[biome].props.focalStatue, god);
  const body = statueKit[`_${god}Geo`]();
  const trim = statueKit[`_${god}TrimGeo`]();
  assert.ok(body.attributes.position.count > 500, `${god} statue body is missing`);
  assert.ok(trim.attributes.position.count > 100, `${god} divine attribute is missing`);
  body.dispose(); trim.dispose();
}

// Every gate has a stable, distinct deity and keeps a build-defining boon exit.
const planA = planDoorChoices(3, () => 0.314159);
const planB = planDoorChoices(3, () => 0.314159);
assert.deepEqual(planA, planB);
assert.equal(new Set(planA.map(x => x.god)).size, 3);
assert.ok(planA.some(x => x.kind === 'boon'));
assert.ok(planA.every(x => GOD_INFO[x.god]));
assert.ok(planA.every(x => x.kind !== 'weapon'), 'a chamber gate can replace the run-bound weapon');

// The Crossroads owns four physical, hovering arms and reports the selected
// one through its interaction callback.
{
  let selected = null, selections = 0;
  const home = new HomeBase({}, { onWeapon: id => (selected = id, selections++, true) });
  const stone = new THREE.MeshStandardMaterial(), bronze = new THREE.MeshStandardMaterial(), dark = new THREE.MeshStandardMaterial();
  home._buildArmory(stone, bronze, dark);
  assert.deepEqual(home.armory.map(a => a.id).sort(), ['blade', 'bow', 'shield', 'spear']);
  assert.ok(home.armory.every(a => a.hover.position.y > 1.5), 'an Infernal Arm is not hovering');
  assert.equal(home._selectWeapon('bow'), true);
  assert.equal(selected, 'bow');
  assert.equal(home.selectedWeapon, 'bow');
  assert.equal(home.armory.filter(a => a.selected).length, 1);
  home._selectWeapon('bow');
  assert.equal(selections, 1, 'holding Interact repeated the same home equip');
  home.dispose(); stone.dispose(); bronze.dispose(); dark.dispose();
}

// Once the portal binds an arm, every central swap path rejects a new one
// until the hero returns home and unlocks the arsenal.
{
  const events = new Bus();
  let equippedEvents = 0;
  events.on('weapon.equipped', () => equippedEvents++);
  const combat = Object.create(CombatSystem.prototype);
  combat.ctx = { player: {}, events, ui: { toast: noop } };
  combat.runtimes = new Map(); combat.weaponId = 'blade'; combat.weaponLocked = false;
  assert.equal(combat.lockWeapon('spear')?.name, 'Eternal Spear');
  assert.equal(equippedEvents, 1, 'one equip produced duplicate runtime events');
  assert.equal(combat.weaponLocked, true);
  assert.equal(combat.equip('bow'), null);
  assert.equal(combat.cycleWeapon(), null);
  assert.equal(combat.weaponId, 'spear');
  combat.unlockWeapon();
  assert.equal(combat.equip('bow')?.name, 'Heart-Seeking Bow');
  assert.equal(equippedEvents, 2);
}

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
assert.ok(controlText.includes('approach an arm at home'));
assert.ok(!controlText.includes('x/c cycle') && !controlText.includes('1–4'));

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
