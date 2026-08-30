import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOONS, BoonState, GOD_INFO, GOD_KEYS } from '../src/game/boons.js';
import { WeaponRuntime, WEAPONS, WEAPON_IDS } from '../src/entities/weapons.js';
import { Player, WEAPON_ANIM } from '../src/entities/player.js';
import { buildClipData } from '../src/entities/anim.js';
import { CombatSystem } from '../src/entities/combat.js';
import { planDoorChoices } from '../src/world/doors.js';
import { HomeBase, HOME_ALTAR_POS, HOME_MIRROR_POS, TitanBloodDrop } from '../src/world/homebase.js';
import { RunState } from '../src/game/run.js';
import { Audio } from '../src/audio/index.js';
import { CONTROL_ROWS } from '../src/core/controls.js';
import { BIOMES, ARCHETYPES } from '../src/world/biomes.js';
import { World } from '../src/world/chamber.js';
import { Kit } from '../src/world/kit.js';
import { Engine } from '../src/core/engine.js';
import { chooseGraphicsTier, graphicsDprCap } from '../src/core/quality.js';
import { TIERS } from '../src/render/renderer.js';
import { GRADES } from '../src/render/shaders/grades.js';
import { ROSTER, ROSTER_IDS } from '../src/entities/enemies/index.js';
import { ENCOUNTER_POOLS, BOSS_SEQUENCE, FINAL_BOSSES, FINAL_BOSS_DEPTH, bossForDepth, Spawner } from '../src/entities/spawner.js';
import { lockModalInput, releaseModalInput } from '../src/ui/modal-input.js';
import { boonOfferComparison, advanceCardFocus, releaseGatedEdge } from '../src/ui/boon-choice.js';
import { CHARACTER_INFO, characterOwnsWeapon } from '../src/game/characters.js';
import { VFX } from '../src/vfx/index.js';

class Bus {
  constructor() { this.map = new Map(); }
  on(name, fn) { const a = this.map.get(name) || []; a.push(fn); this.map.set(name, a); return () => {}; }
  emit(name, data) { for (const fn of this.map.get(name) || []) fn(data); }
}

// The physical Mirror of Night opens its own persistent Darkness page.
{
  let opened = 0, interact = false;
  const player = { position: HOME_MIRROR_POS.clone(), radius: 0.45, velocity: new THREE.Vector3(), knock: new THREE.Vector3() };
  const home = new HomeBase({ player, input: { pressed: a => a === 'interact' && interact } }, { onMirror: () => opened++ });
  interact = true;
  home.update(1 / 60);
  assert.equal(opened, 1, 'Mirror of Night is not interactable at the Crossroads');
}
const noop = () => {};
const rng = { f: () => 0.314159, pick: a => a[0] };

// Specialist enemies must be real combat roles, registered in every biome,
// and expose the state transitions that make their counterplay distinct.
assert.equal(ROSTER_IDS.length, 15);
const specialistStates = {
  lancer: ['aim', 'charge'],
  siren: ['mark', 'blink', 'slash'],
  oracle: ['ritual', 'release'],
  riftstalker: ['mark', 'blink', 'slash'],
};
for (const [kind, states] of Object.entries(specialistStates)) {
  const def = ROSTER[kind];
  assert.equal(def.kind, kind);
  assert.ok(def.label && def.role && def.identity && def.cost >= 2);
  for (const state of states) assert.ok(def.brain.states[state], `${kind} is missing its ${state} behavior`);
  for (const [biome, pool] of Object.entries(ENCOUNTER_POOLS)) {
    const entry = pool.find(entry => entry.kind === kind);
    assert.ok(entry, `${kind} is absent from ${biome}`);
    assert.ok(entry.w(8) > 0, `${kind} can never spawn in ${biome}`);
  }
}

// Three regional bosses now lead to an heir-specific finale rather than an
// endlessly clamped Elysium sequence.
assert.deepEqual(BOSS_SEQUENCE, ['warden', 'minotaur', 'heracles']);
assert.deepEqual(FINAL_BOSSES, { zagreus: 'hades', melinoe: 'chronos' });
assert.equal(FINAL_BOSS_DEPTH, 20);
assert.equal(bossForDepth(5), 'warden');
assert.equal(bossForDepth(10), 'minotaur');
assert.equal(bossForDepth(15), 'heracles');
assert.equal(bossForDepth(20, 'zagreus'), 'hades');
assert.equal(bossForDepth(20, 'melinoe'), 'chronos');
for (const [kind, states] of Object.entries({
  minotaur: ['sweepTell', 'chargeTell', 'chargeGo', 'stompTell', 'exposed'],
  heracles: ['clubTell', 'boulderTell', 'leapTell', 'leapHit', 'exposed'],
  hades: ['sweepTell', 'castTell', 'warpTell', 'exposed'],
  chronos: ['sweepTell', 'castTell', 'warpTell', 'exposed'],
})) {
  const def = ROSTER[kind];
  assert.equal(def.boss, true);
  assert.equal(def.phases, 3);
  assert.ok(def.hp >= 1000 && def.spec && def.title);
  for (const state of states) assert.ok(def.brain.states[state], `${kind} is missing ${state}`);
}
{
  const director = new Spawner();
  director.depth = 10;
  assert.deepEqual(director._bossWaves()[0].list, ['minotaur']);
  director.depth = 15;
  assert.deepEqual(director._bossWaves()[0].list, ['heracles']);
  director.depth = 20;
  director.ctx = { run: { selectedCharacter: 'melinoe' } };
  assert.deepEqual(director._bossWaves()[0].list, ['chronos']);
}

// The regional route matches the five-depth boss cadence, then jumps from
// Heracles to the final encounter and terminates after the correct boss.
{
  const run = new RunState();
  assert.equal(run.biomeFor(5), 'tartarus');
  assert.equal(run.biomeFor(6), 'asphodel');
  assert.equal(run.biomeFor(10), 'asphodel');
  assert.equal(run.biomeFor(11), 'elysium');
  assert.equal(run.biomeFor(15), 'elysium');
  assert.equal(run.biomeFor(FINAL_BOSS_DEPTH), 'elysium');
  const bus = new Bus();
  run.ctx = { events: bus, world: {}, ui: {} };
  run.depth = 15;
  run._queueTransition({ index: 2, kind: 'boon' });
  assert.equal(run._pending.depth, FINAL_BOSS_DEPTH);

  let sealed = null, victory = null;
  bus.on('run.victory', e => { victory = e; });
  run.ctx = {
    CAPTURE: true, events: bus, world: { setCleared: value => { sealed = value; } },
    ui: { clearPrompts: noop, clearSigils: noop, toast: noop }, spawner: { stop: noop },
  };
  run.depth = FINAL_BOSS_DEPTH; run.state = 'playing'; run.roomCleared = false;
  run.selectedCharacter = 'melinoe'; run._pending = null;
  run._onCleared({ boss: true });
  assert.equal(run.state, 'victory');
  assert.equal(sealed, false);
  assert.equal(victory.boss, 'chronos');
}

// The rail remains a fast ranged arm, but no longer deletes a lane with a
// three-body pierce or clears a whole wave with one bombard.
{
  const rail = WEAPONS.rail;
  assert.ok(rail.charge.fullHold >= 0.48 && rail.charge.recoveryFull >= 0.23);
  assert.ok(rail.charge.projectile.damageFull <= 14);
  assert.equal(rail.charge.projectile.pierceFull, 1);
  assert.ok(rail.charge.projectile.speedFull <= 42);
  assert.ok(rail.special.damage <= 25 && rail.special.hitbox.radius <= 3.15);
  assert.deepEqual(rail.magazine, { capacity: 6, reload: 1.35 });
}

// The Oracle's release is not a cosmetic cast: it heals and wards nearby
// allies, ignores distant ones, and still creates the punishable arena pulse.
{
  const near = { alive: true, health: 20, maxHealth: 100, iframes: 0, height: 2, position: new THREE.Vector3(3, 0, 0) };
  const far = { alive: true, health: 20, maxHealth: 100, iframes: 0, height: 2, position: new THREE.Vector3(8, 0, 0) };
  let pulse = 0;
  const oracle = {
    alive: true, position: new THREE.Vector3(), mgr: { list: [] },
    endTell: noop, strikeDisc: () => pulse++,
  };
  oracle.mgr.list = [oracle, near, far];
  ROSTER.oracle.brain.states.release.enter(oracle, { vfx: { beam: noop } });
  assert.equal(near.health, 38);
  assert.equal(near.iframes, 0.22);
  assert.equal(far.health, 20);
  assert.equal(pulse, 1);
}

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

// Boss death keeps its authored three-metre visual footprint, but particle
// density is capped and follows the quality tier instead of multiplying every
// layer by deathScale. This guards the browser hitch reported on boss kills.
{
  const deathParticleCount = budget => {
    const fx = new VFX();
    const emitted = [];
    fx._budget = budget;
    fx.ctx = { time: { t: 0 } };
    fx.biome = { key: '#ffffff' };
    fx.rng = { range: () => 0 };
    fx.particles = { emit: (kind, count) => emitted.push({ kind, count }) };
    fx.rings = { spawn: noop }; fx.decals = { spawn: noop }; fx.beams = { spawn: noop };
    fx.death(new THREE.Vector3(0, 1, 0), { scale: 3, boss: true });
    for (const pending of fx._pending.splice(0)) pending.fn();
    return emitted.reduce((sum, e) => sum + e.count, 0);
  };
  assert.ok(deathParticleCount(0.38) <= 30, 'Low-tier boss death exceeded its particle budget');
  assert.ok(deathParticleCount(1) <= 72, 'boss deathScale still multiplies particle count without a cap');
}

// Boss rewards are created after the death frame and on separate fixed steps.
{
  const run = new RunState();
  const scene = new THREE.Scene();
  run.ctx = {
    scene, quality: { tier: 'low' }, player: { position: new THREE.Vector3(99, 0, 99) },
    ui: { prompt: noop, toast: noop, setResources: noop }, events: new Bus(),
    vfx: { burst: noop, shockwave: noop },
  };
  run.meta = { nectar: 0, titanBlood: 0, darkness: 0, awardNectar: noop, awardTitanBlood: noop };
  run.state = 'playing'; run.depth = 5;
  const boss = { position: new THREE.Vector3(), def: { label: 'Test Boss' } };
  run._onBossDefeated({ entity: boss, pos: boss.position.clone() });
  assert.equal(run._drops.length, 0, 'reward geometry was allocated during the boss-death frame');
  assert.equal(run._bossRewardQueue.length, 2);
  run.update(0.27, run.ctx);
  assert.equal(run._drops.length, 1, 'Nectar did not spawn on its deferred step');
  run.update(0.23, run.ctx);
  assert.equal(run._drops.length, 2, 'Titan Blood did not spawn on its later deferred step');
  assert.ok(run._drops.every(drop => !drop.root.children.some(child => child.isPointLight)), 'Low-tier rewards created dynamic point lights');
  run._clearDrops();
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
  player.position.copy(HOME_ALTAR_POS);
  assert.equal(home.releaseAltar(), true);
  assert.ok(Math.hypot(player.position.x - HOME_ALTAR_POS.x, player.position.z - HOME_ALTAR_POS.z) >= 3.47);
  assert.equal(player.velocity.lengthSq(), 0);
  assert.equal(player.knock.lengthSq(), 0);
}

{
  const scene = new THREE.Scene();
  const drop = new TitanBloodDrop({ scene, player: { position: new THREE.Vector3(99, 0, 99) }, ui: { prompt: noop } }, new THREE.Vector3(), 1);
  assert.equal(drop.root.name, 'reward.titanBlood');
  assert.equal(drop.style.label, 'TITAN BLOOD');
  assert.ok(scene.children.includes(drop.root), 'Titan Blood was not spawned into the boss arena');
  drop.dispose();
}

// A duplicate altar-open event must preserve the pre-modal input state so one
// close restores movement instead of trapping the hero.
{
  const input = { enabled: true };
  const altar = { _inputLockHeld: false, _inputWasEnabled: true };
  assert.equal(lockModalInput(altar, input), true);
  assert.equal(lockModalInput(altar, input), false);
  assert.equal(input.enabled, false);
  assert.equal(releaseModalInput(altar, input, true), true);
  assert.equal(input.enabled, true, 'closing a repeated altar open left gameplay input disabled');
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

// Permanent investment biases divine gate appearances without allowing the
// same god to occupy multiple exits in one chamber.
{
  const simulate = weights => {
    let seed = 0x91e10da5, seen = 0;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 2400; i++) {
      const plan = planDoorChoices(3, random, weights);
      if (plan.some(choice => choice.god === 'zeus')) seen++;
      assert.equal(new Set(plan.map(choice => choice.god)).size, 3);
    }
    return seen;
  };
  const base = simulate(Object.fromEntries(GOD_KEYS.map(god => [god, 1])));
  const favored = simulate(Object.fromEntries(GOD_KEYS.map(god => [god, god === 'zeus' ? 3 : 1])));
  assert.ok(favored > base * 1.55, `invested god did not appear more often (${base} -> ${favored})`);
}

// Each heir has a disjoint six-arm arsenal and a distinct god gate pool.
assert.equal(CHARACTER_INFO.zagreus.weapons.length, 6);
assert.equal(CHARACTER_INFO.melinoe.weapons.length, 6);
assert.equal(new Set([...CHARACTER_INFO.zagreus.weapons, ...CHARACTER_INFO.melinoe.weapons]).size, 12);
for (const C of Object.values(CHARACTER_INFO)) {
  const plan = planDoorChoices(3, () => 0.314159, null, C.gods);
  assert.ok(plan.every(choice => C.gods.includes(choice.god)), `${C.name} received a cross-game god gate`);
}
assert.equal(BOONS.filter(b => b.hero === 'melinoe' && b.h2Core).length, 45);
assert.equal(BOONS.filter(b => b.hero === 'melinoe' && b.slot === 'gain').length, 9);
assert.equal(CHARACTER_INFO.melinoe.gods.length, 9, 'special encounters leaked into ordinary Melinoe gates');
for (const special of ['artemis', 'selene', 'hecate', 'hades', 'chaos']) {
  assert.ok(!CHARACTER_INFO.melinoe.gods.includes(special), `${special} became an ordinary Olympian door`);
}
{
  const state = new BoonState({ player: { characterId: 'melinoe' } });
  const offers = state.roll(rng, { count: 20, god: 'apollo', character: 'melinoe', allowDuo: false });
  const actionOffers = offers.filter(o => ['attack', 'special', 'cast', 'dash', 'gain'].includes(o.slot));
  assert.ok(actionOffers.length >= 5);
  assert.ok(actionOffers.every(o => o.boon.hero === 'melinoe' && o.boon.sourceGame === 'Hades II'),
    'a Zagreus-era core boon leaked into Melinoe offers');
}

// The Crossroads builds only the selected heir's six compatible hovering arms.
{
  let selected = null, selections = 0;
  const home = new HomeBase({}, { onWeapon: id => (selected = id, selections++, true) });
  const stone = new THREE.MeshStandardMaterial(), bronze = new THREE.MeshStandardMaterial(), dark = new THREE.MeshStandardMaterial();
  home._buildArmory(stone, bronze, dark);
  assert.deepEqual(home.armory.map(a => a.id).sort(), ['blade', 'bow', 'fists', 'rail', 'shield', 'spear']);
  assert.ok(home.armory.every(a => a.hover.position.y > 1.5), 'an Infernal Arm is not hovering');
  assert.equal(home._selectWeapon('bow'), true);
  assert.equal(selected, 'bow');
  assert.equal(home.selectedWeapon, 'bow');
  assert.equal(home.armory.filter(a => a.selected).length, 1);
  home._selectWeapon('bow');
  assert.equal(selections, 1, 'holding Interact repeated the same home equip');
  home.dispose(); stone.dispose(); bronze.dispose(); dark.dispose();
}

{
  let character = null;
  const home = new HomeBase({}, { character: 'zagreus', onCharacter: id => (character = id, true), onWeapon: () => true });
  const stone = new THREE.MeshStandardMaterial(), bronze = new THREE.MeshStandardMaterial(), dark = new THREE.MeshStandardMaterial();
  home._armoryMats = { stone, bronze, dark };
  home._buildArmory(stone, bronze, dark, 'zagreus');
  assert.equal(home._selectCharacter('melinoe'), true);
  assert.equal(character, 'melinoe');
  assert.deepEqual(home.armory.map(a => a.id), CHARACTER_INFO.melinoe.weapons);
  assert.equal(home.selectedWeapon, null);
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

{
  const events = new Bus();
  const combat = Object.create(CombatSystem.prototype);
  combat.ctx = { player: { characterId: 'melinoe' }, events, ui: { toast: noop } };
  combat.runtimes = new Map(); combat.weaponId = 'staff'; combat.weaponLocked = false;
  assert.equal(combat.equip('blade'), null, 'Melinoe equipped an Infernal Arm');
  assert.ok(characterOwnsWeapon('melinoe', combat.equip('axe')?.id));
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

function harness(weaponId, actor = null) {
  const events = new Bus();
  const player = actor || {
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

// Adamant Rail has a real finite magazine. The sixth projectile empties it,
// forces a non-firing reload window, then restores exactly one magazine.
{
  const { ctx, runtime, fired } = harness('rail');
  let reloads = 0, reloadEnds = 0;
  ctx.events.on('weapon.reload.begin', () => reloads++);
  ctx.events.on('weapon.reload.end', () => reloadEnds++);
  for (let shot = 0; shot < runtime.ammoMax; shot++) {
    runtime.press('attack');
    runtime.update(runtime.weapon.charge.fullHold + 0.01);
    runtime.release('attack');
    runtime.update(runtime.weapon.charge.recoveryFull + 0.01);
  }
  assert.equal(fired.length, 6);
  assert.equal(runtime.ammo, 0);
  assert.equal(runtime.state, 'reload');
  assert.equal(reloads, 1);
  runtime.press('attack');
  runtime.update(runtime.weapon.magazine.reload - 0.02);
  assert.equal(fired.length, 6, 'empty Rail fired during reload');
  assert.equal(runtime.state, 'reload');
  runtime.update(0.03);
  assert.equal(runtime.state, 'idle');
  assert.equal(runtime.ammo, runtime.ammoMax);
  assert.equal(reloadEnds, 1);
}

// A full Nocturnal Arm charge is an Ω move: it spends Magick, announces the
// action, and still resolves through the selected weapon's normal boon path.
{
  const melinoe = {
    characterId: 'melinoe', position: new THREE.Vector3(), facing: new THREE.Vector2(1, 0), radius: 0.5,
    health: 100, maxHealth: 100, mana: 100, maxMana: 100, state: 'move', onWeaponState: noop,
  };
  const { ctx, runtime, fired } = harness('staff', melinoe);
  let omega = null;
  ctx.events.on('weapon.omega', e => { omega = e; });
  runtime.press('special');
  runtime.update(1.0);
  runtime.release('special');
  assert.equal(melinoe.mana, 80);
  assert.equal(omega?.weapon, 'staff');
  assert.ok(fired.length > 0 && fired[0].damage >= 54, 'Staff Ω Special did not release its full projectile');
}

// Melinoe's Cast is a cursor-positioned binding circle, not a lodged Zagreus
// Bloodstone projectile.
{
  const hitboxes = [];
  const player = {
    characterId: 'melinoe', position: new THREE.Vector3(), aimPoint: new THREE.Vector3(7, 0, 2),
    radius: 0.5, maxHealth: 100, health: 100, maxMana: 100, mana: 100,
  };
  const ctx = { player, events: new Bus(), ui: { setHealth: noop, setMana: noop }, vfx: { shockwave: noop, burst: noop } };
  ctx.boons = new BoonState(ctx);
  const combat = Object.create(CombatSystem.prototype);
  combat.ctx = ctx; combat.weaponId = 'staff'; combat._v3a = new THREE.Vector3(); combat._v3b = new THREE.Vector3();
  combat.hitboxes = { spawn: spec => (hitboxes.push(spec), hitboxes.length) };
  combat.projectiles = { fire: () => { throw new Error('Melinoe binding Cast incorrectly fired a shard'); } };
  const result = combat.cast({ source: player, origin: new THREE.Vector3(0, 1.1, 0), dir: new THREE.Vector3(1, 0, 0) });
  assert.equal(result, 1);
  assert.equal(hitboxes[0].tag, 'melinoe:binding-circle');
  assert.ok(hitboxes[0].x > 6 && hitboxes[0].z > 1 && hitboxes[0].radius >= 2.75);
}

// Hades-style Dash-Strike routing: the authored blade dashcut used to be dead
// data. A standing press must still start cut1, while a same-frame Dash+Attack
// is preserved through the movement dash and released only after it ends.
{
  const { runtime } = harness('blade');
  runtime.press('attack');
  runtime.update(1 / 120);
  assert.equal(runtime.step?.name, 'cut1', 'standing Attack no longer starts the blade combo');
  assert.equal(runtime.stepIndex, 0);
}

{
  const { ctx, player, runtime, hitboxes } = harness('blade');
  const hermes = BOONS.find(b => b.id === 'hermes.attack');
  const ember = BOONS.find(b => b.id === 'hephaestus.blade.ember');
  ctx.boons.grant(ctx.boons.offer(hermes));
  ctx.boons.grant(ctx.boons.offer(ember));
  player._boonPostDash = true;
  let weaponStates = 0;
  player.onWeaponState = () => weaponStates++;
  player.state = 'dash';
  const start = player.position.clone();

  // This is the exact order Player uses when both edges arrive in one frame.
  runtime.press('attack');
  runtime.press('dash');
  assert.equal(runtime.queueDashAttack(), true);
  // Hold the actor in its real dash state longer than the normal input buffer.
  // Intent must survive, but no attack state, animation hook, root or hit may.
  for (let i = 0; i < 36; i++) runtime.update(1 / 120);
  assert.equal(runtime.state, 'idle', 'dashcut began while the actor was still dashing');
  assert.equal(runtime.step, null);
  assert.equal(weaponStates, 0, 'weapon animation began under the dash animation');
  assert.equal(hitboxes.length, 0, 'dashcut fired during the movement dash');
  assert.equal(player.position.distanceTo(start), 0, 'dashcut root motion began during the movement dash');
  assert.ok(runtime.buffer > 0 && runtime.dashQueued, 'dash-strike intent expired before dash exit');

  player.state = 'move';
  runtime.update(1 / 120);
  assert.equal(runtime.state, 'dashAttack', 'dashcut reused the standing Attack state');
  assert.equal(runtime.step?.name, 'dashcut', 'Dash+Attack fell back to standing cut1');
  assert.equal(runtime.stepIndex, -2, 'dashcut was misidentified as a combo step');
  assert.equal(runtime.t, 0, 'dashcut skipped its visible windup on dash exit');
  assert.equal(weaponStates, 1, 'dashcut weapon animation did not begin after dash exit');
  assert.equal(hitboxes.length, 0);
  assert.equal(player.position.distanceTo(start), 0);
  assert.equal(runtime.queueDashAttack(), false, 'active dashcut accepted stale dash intent');
  assert.equal(runtime.dashQueued, false, 'rejected dashcut requeue leaked intent');

  runtime.update(runtime.step.t0 + 1 / 120);
  const strike = hitboxes.find(x => x.tag === 'blade:dashcut');
  assert.ok(strike, 'dashcut never produced its authored hitbox');
  assert.equal(strike.boonGod, 'hermes', 'dashcut did not inherit the Attack boon');
  assert.equal(strike.boonSlot, 'attack');
  assert.equal(strike.status, 'burn', 'dashcut did not inherit the Blade Ember forge');
  assert.equal(player._boonPostDash, false, 'dash attack did not consume the post-dash rider window');

  runtime.update(runtime.step.dur + 1 / 120);
  assert.equal(runtime.state, 'idle');
  assert.equal(runtime.dashQueued, false, 'dash intent survived attack completion');
  runtime.press('attack');
  runtime.update(1 / 120);
  assert.equal(runtime.step?.name, 'cut1', 'standing Attack after dashcut became another dashcut');
}

// An unconsumed dash intent that is no longer protected by an active dash must
// expire cleanly rather than contaminating a later standing Attack.
{
  const { player, runtime } = harness('blade');
  player.state = 'move';
  assert.equal(runtime.queueDashAttack(), true);
  runtime.state = 'attack';
  runtime.step = { name: 'recovery', t0: 0, t1: 0, dur: 1, cancel: 1, chain: 1, root: null };
  runtime.t = 0; runtime.fired = true;
  runtime.update(runtime.weapon.buffer + 0.01);
  assert.equal(runtime.dashQueued, false, 'expired buffer retained dash intent');
  runtime.state = 'idle'; runtime.step = null;
  runtime.press('attack');
  runtime.update(1 / 120);
  assert.equal(runtime.step?.name, 'cut1', 'expired dash intent changed a later standing Attack');
}

// The Spear has its own long, narrow Dash-Strike rather than borrowing the
// Blade's arc. It must preserve Attack boons and the post-dash payoff while
// leaving the standing three-hit sequence untouched.
{
  const { runtime } = harness('spear');
  runtime.press('attack');
  runtime.update(1 / 120);
  assert.equal(runtime.step?.name, 'poke1', 'standing Spear Attack no longer starts poke1');
}

{
  const { ctx, player, runtime, hitboxes } = harness('spear');
  const hermes = BOONS.find(b => b.id === 'hermes.attack');
  ctx.boons.grant(ctx.boons.offer(hermes));
  player._boonPostDash = true;
  player.state = 'dash';
  const start = player.position.clone();

  runtime.press('attack');
  assert.equal(runtime.queueDashAttack(), true, 'Spear rejected its authored Dash-Strike');
  for (let i = 0; i < 36; i++) runtime.update(1 / 120);
  assert.equal(runtime.state, 'idle', 'Spear Dash-Strike began inside the movement dash');
  assert.equal(hitboxes.length, 0, 'Spear Dash-Strike hit during the movement dash');
  assert.equal(player.position.distanceTo(start), 0, 'Spear Dash-Strike root motion began during the movement dash');

  player.state = 'move';
  runtime.update(1 / 120);
  assert.equal(runtime.state, 'dashAttack', 'Spear Dash-Strike reused the standing Attack state');
  assert.equal(runtime.step?.name, 'dashthrust', 'Spear Dash+Attack fell back to poke1');
  assert.equal(runtime.stepIndex, -2, 'Spear Dash-Strike entered the standing combo chain');
  runtime.update(runtime.step.t0 + 1 / 120);

  const strike = hitboxes.find(x => x.tag === 'spear:dashthrust');
  assert.ok(strike, 'Spear Dash-Strike never produced its hitbox');
  assert.equal(strike.shape, 'capsule', 'Spear Dash-Strike lost its precise line identity');
  assert.equal(strike.length, 4.65);
  assert.equal(strike.boonGod, 'hermes', 'Spear Dash-Strike did not inherit the Attack boon');
  assert.equal(strike.boonSlot, 'attack');
  assert.equal(player._boonPostDash, false, 'Spear Dash-Strike did not consume the post-dash payoff');
}

// Dash Attacks have their own authored silhouettes. They must never map back
// to a standing slash, standing thrust, or the locomotion dash clip.
{
  const clips = buildClipData();
  for (const clip of ['dashSlash', 'dashThrust', 'dashUpper']) assert.ok(clips[clip], `${clip} clip is missing`);
  assert.equal(WEAPON_ANIM.blade.dashcut, 'dashSlash');
  assert.equal(WEAPON_ANIM.spear.dashthrust, 'dashThrust');
  assert.equal(WEAPON_ANIM.fists.dashupper, 'dashUpper');
  assert.notEqual(WEAPON_ANIM.blade.dashcut, WEAPON_ANIM.blade.cut1);
  assert.notEqual(WEAPON_ANIM.spear.dashthrust, WEAPON_ANIM.spear.poke1);
}

// Player-level direction handoff: moving north while aiming east must keep
// the movement dash north, then snap both Blade and Spear Dash-Strikes to the
// live cursor before the runtime emits root motion or a hitbox. This catches
// the controller/runtime ordering bug that a runtime-only distance check did
// not: a wrong-way strike still moved a non-zero distance.
for (const [weaponId, tag] of [['blade', 'blade:dashcut'], ['spear', 'spear:dashthrust']]) {
  const player = new Player();
  const { ctx, runtime, hitboxes } = harness(weaponId, player);
  player.weapon = runtime;
  player.animator = { playAdditive: noop };
  player.state = 'dash';
  player.dash.dir.set(0, 1);                 // movement input: north
  player.dash.t = 0;
  player.dash.travelled = 0;
  player.aimDir.set(1, 0);                  // live cursor: east
  player._mouseSeen = true;

  runtime.press('attack');
  assert.equal(runtime.queueDashAttack(), true);
  runtime.update(0.30);                     // intent survives the live dash
  player._dashStep(player.tune.dashTime, ctx);

  const dashExit = player.position.clone();
  assert.ok(Math.abs(dashExit.x) < 1e-9, `${weaponId} dash drifted toward cursor before exit`);
  assert.ok(Math.abs(dashExit.z - player.tune.dashDistance) < 1e-9, `${weaponId} dash no longer follows movement input`);
  assert.ok(player.facing.dot(player.aimDir) > 0.999999, `${weaponId} Dash-Strike did not snap to live cursor aim`);

  runtime.update(1 / 120);
  assert.equal(runtime.step, runtime.weapon.dashAttack);
  runtime.update(runtime.step.t0 + 1 / 120);
  const strike = hitboxes.find(x => x.tag === tag);
  assert.ok(strike, `${weaponId} Dash-Strike did not emit its hitbox`);
  assert.ok(strike.owner.facing.dot(player.aimDir) > 0.999999, `${weaponId} hitbox owner faced away from cursor`);

  const root = new THREE.Vector2(player.position.x - dashExit.x, player.position.z - dashExit.z);
  assert.ok(root.length() > 0.01, `${weaponId} Dash-Strike emitted no root motion`);
  assert.ok(root.normalize().dot(player.aimDir) > 0.999999, `${weaponId} root motion diverged from cursor aim`);
}

// No queued attack means no aim snap: a plain movement dash still ends facing
// the direction it travelled.
{
  const player = new Player();
  const { ctx, runtime } = harness('shield', player);
  player.weapon = runtime;
  player.animator = { playAdditive: noop };
  player.state = 'dash';
  player.dash.dir.set(0, 1);
  player.aimDir.set(1, 0);
  player._mouseSeen = true;
  player._dashStep(player.tune.dashTime, ctx);
  assert.ok(player.facing.dot(player.dash.dir) > 0.999999, 'ordinary dash facing was redirected to cursor');
}

{
  const { runtime } = harness('shield');
  runtime.press('attack');
  assert.equal(runtime.queueDashAttack(), false, 'an arm without Dash-Strike data accepted the route');
  runtime.update(1 / 120);
  assert.equal(runtime.step?.name, 'punch1', 'unsupported dash route swallowed the Shield attack');
}

for (const weapon of WEAPON_IDS) {
  const { ctx } = harness(weapon);
  const offers = ctx.boons.roll(rng, { count: 3, god: 'hephaestus', weapon, allowDuo: false });
  assert.equal(offers.length, 3, `${weapon} forge did not offer three cards`);
  assert.ok(offers.every(o => o.god === 'hephaestus' && o.boon.weapon === weapon));
  assert.deepEqual(new Set(offers.map(o => o.boon.forgeAction)), new Set(['attack', 'special', 'cast']), `${weapon} forge did not cover every action path`);
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
  assert.ok(ctx.boons.mods.forge.blade.specialMul > 1 && ctx.boons.mods.forge.blade.castMul > 1);
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
  assert.ok(ctx.boons.mods.forge[weapon].castMul > 1);
  if (weapon === 'spear') assert.ok(ctx.boons.mods.forge.spear.attackMul > 1);
  else assert.ok(ctx.boons.mods.forge.bow.specialMul > 1);
  runtime._loose(runtime.weapon.charge, 1, true);
  assert.equal(fired.length, 3, `${weapon} full shot did not split three ways`);
  assert.ok(fired.every(x => x.kind === 'homing'), `${weapon} homing forge was not consumed`);
  if (weapon === 'bow') assert.ok(fired.every(x => x.blastRadius > 0), 'bow blast forge was not consumed');
  else {
    runtime.press('special');
    const returning = fired.at(-1);
    assert.equal(runtime.stuck, null, 'second Special press did not recall the thrown spear');
    assert.equal(returning.kind, 'homing');
    assert.equal(returning.target, runtime.actor);
    assert.equal(returning.returnTarget, runtime.actor);
    assert.ok(returning.returnRadius > runtime.actor.radius);
    assert.ok(returning.damage >= runtime.weapon.charge.recall.damageFull, 'full-charge recall damage was discarded');
    assert.ok(returning.blastRadius > 0, 'spear recall blast was not consumed');
  }
}

{
  const { ctx, runtime, hitboxes } = harness('shield');
  for (const boon of BOONS.filter(b => b.god === 'hephaestus' && b.weapon === 'shield')) ctx.boons.grant(ctx.boons.offer(boon));
  assert.ok(ctx.boons.mods.forge.shield.attackMul > 1 && ctx.boons.mods.forge.shield.castMul > 1);
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

// Every arm now has a real Hephaestus Cast path, each with a distinct weapon
// rule on top of the shared damage temper.
for (const weapon of ['blade', 'spear', 'bow', 'shield']) {
  const events = new Bus(), fired = [];
  const player = { position: new THREE.Vector3(), facing: new THREE.Vector2(1, 0), maxHealth: 100, maxMana: 100, health: 100, mana: 100 };
  const ctx = {
    player, events, CAPTURE: true,
    ui: { setHealth: noop, setMana: noop },
    vfx: { burst: noop, beam: noop, shockwave: noop },
  };
  ctx.boons = new BoonState(ctx);
  const combat = Object.create(CombatSystem.prototype);
  Object.assign(combat, {
    ctx, weaponId: weapon, projectiles: { fire: spec => (fired.push(spec), fired.length) },
    _v3a: new THREE.Vector3(), _boonPulses: [],
  });
  ctx.combat = combat;
  for (const boon of BOONS.filter(b => b.god === 'hephaestus' && b.weapon === weapon)) ctx.boons.grant(ctx.boons.offer(boon));
  combat.cast({ source: player, origin: new THREE.Vector3(0, 1, 0), dir: new THREE.Vector3(1, 0, 0), power: 1 });
  const shot = fired.at(-1);
  assert.ok(shot && shot.damage > 26, `${weapon} Cast temper did not improve damage`);
  if (weapon === 'blade') assert.ok(shot.blastRadius > 0, 'Blade Cast did not erupt');
  if (weapon === 'spear') assert.ok(shot.pierce === 1 && shot.skewer >= 2, 'Spear Cast did not turn its old pass-through pierce into lodged-shard skewers');
  if (weapon === 'bow') assert.equal(shot.kind, 'homing', 'Bow Cast did not seek');
  if (weapon === 'shield') assert.ok(shot.kind === 'bounce' && shot.bounces > 0, 'Shield Cast did not ricochet');
}

// Displayed controls are all live actions; dead debug/map bindings stay out.
const controlText = CONTROL_ROWS.flat().join(' ').toLowerCase();
for (const action of ['move', 'aim', 'attack', 'special', 'cast', 'dash', 'call', 'interact', 'pause']) assert.ok(controlText.includes(action));
assert.ok(!controlText.includes('debug') && !controlText.includes('map'));
assert.ok(controlText.includes('choose heir / weapon') && controlText.includes('approach at home'));
assert.ok(controlText.includes('view current boons') && controlText.includes('b / tab'));
assert.ok(!controlText.includes('x/c cycle') && !controlText.includes('1–4'));

// Combat chambers are 50% larger and discard perimeter blockers, while sparse
// tagged mid-arena steles remain as deliberate projectile cover.
{
  const expected = {
    rotunda: 24.6, oblong: 25.8, cruciform: 25.8, terrace: 24.0,
    causeway: 27.3, hypostyle: 24.9, ossuary: 24.6,
  };
  for (const [id, radius] of Object.entries(expected)) assert.equal(ARCHETYPES[id].radius, radius, `${id} arena is not 50% larger`);
  const world = new World();
  world.bounds.r = 24.6;
  world.profile.fill(24.6);
  world.colliders.push(
    { kind: 'circle', x: 22, z: 0, r: 1 },
    { kind: 'circle', x: 5, z: 0, r: 1.02, combatCover: true },
  );
  world._finishColliders(null, {});
  assert.equal(world.colliders.length, 1, 'central cover was removed or perimeter clutter survived');
  assert.equal(world.colliders[0].combatCover, true);
  const insideCover = new THREE.Vector3(5, 0, 0);
  world.collide(insideCover, 0.2);
  assert.ok(Math.hypot(insideCover.x - 5, insideCover.z) > 1.0, 'central stele does not block movement/projectile collision');
  const shotLane = world.raycastWalk(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0), 0.16);
  assert.equal(shotLane.hit, true, 'central stele did not break the straight firing lane');
  const edge = new THREE.Vector3(40, 0, 0);
  world.collide(edge, 0.6);
  assert.ok(edge.x < 24.0 && edge.x > 23.0, 'arena boundary stopped constraining movement');
}

// Boon decisions expose slot replacement before confirmation, and the same
// focus path works for keyboard and gamepad instead of trapping pad users.
{
  const old = { id: 'old.attack', name: 'Old Attack', slot: 'attack' };
  const next = { id: 'new.attack', name: 'New Attack', slot: 'attack' };
  const owned = { boon: old, rarity: 'rare', slot: 'attack', god: 'zeus' };
  const state = { byId: new Map([[old.id, owned]]), granted: [owned] };
  assert.deepEqual(boonOfferComparison({ boon: next, rarity: 'epic', replaces: old.id }, state), {
    kind: 'replace', fromName: 'Old Attack', fromRarity: 'rare', toRarity: 'epic',
  });
  assert.deepEqual(boonOfferComparison({ boon: old, rarity: 'epic' }, state), {
    kind: 'upgrade', fromName: 'Old Attack', fromRarity: 'rare', toRarity: 'epic',
  });
  assert.equal(boonOfferComparison({ boon: { id: 'passive', slot: 'passive' }, rarity: 'rare' }, state), null);

  let focus = advanceCardFocus(-1, 1, 3);
  assert.equal(focus, 0);
  focus = advanceCardFocus(focus, 1, 3);
  assert.equal(focus, 1);
  focus = advanceCardFocus(focus, -1, 3);
  assert.equal(focus, 0);
  focus = advanceCardFocus(focus, -1, 3);
  assert.equal(focus, 2, 'boon focus should wrap across the card row');

  // Holding the dash/accept button as the modal opens cannot claim card one.
  // Only a complete release followed by a fresh edge is accepted.
  let gate = releaseGatedEdge(false, true, true);
  assert.deepEqual(gate, { armed: false, trigger: false });
  gate = releaseGatedEdge(gate.armed, true, false);
  assert.equal(gate.trigger, false, 'held A retriggered inside the boon modal');
  gate = releaseGatedEdge(gate.armed, false, false);
  assert.deepEqual(gate, { armed: true, trigger: false });
  gate = releaseGatedEdge(gate.armed, true, true);
  assert.deepEqual(gate, { armed: true, trigger: true });
}

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

assert.equal(GOD_KEYS.length, 17);
for (const god of ['demeter', 'apollo', 'hera', 'hestia', 'chaos', 'hades']) assert.ok(GOD_INFO[god], `missing expanded god ${god}`);
console.log('features ok: 15 enemies, 5 unique bosses, heir-specific finales, 17 gods, 12 arms, 44 Attack/Special/Cast forges, audio bridge');
