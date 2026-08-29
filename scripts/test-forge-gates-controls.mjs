import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOONS, BoonState, GOD_INFO, GOD_KEYS } from '../src/game/boons.js';
import { WeaponRuntime } from '../src/entities/weapons.js';
import { Player } from '../src/entities/player.js';
import { CombatSystem } from '../src/entities/combat.js';
import { planDoorChoices } from '../src/world/doors.js';
import { HomeBase, HOME_ALTAR_POS, HOME_MIRROR_POS, TitanBloodDrop } from '../src/world/homebase.js';
import { RunState } from '../src/game/run.js';
import { Audio } from '../src/audio/index.js';
import { CONTROL_ROWS } from '../src/core/controls.js';
import { BIOMES } from '../src/world/biomes.js';
import { Kit } from '../src/world/kit.js';
import { Engine } from '../src/core/engine.js';
import { chooseGraphicsTier, graphicsDprCap } from '../src/core/quality.js';
import { TIERS } from '../src/render/renderer.js';
import { GRADES } from '../src/render/shaders/grades.js';
import { ROSTER, ROSTER_IDS } from '../src/entities/enemies/index.js';
import { ENCOUNTER_POOLS, BOSS_SEQUENCE, bossForDepth, Spawner } from '../src/entities/spawner.js';
import { lockModalInput, releaseModalInput } from '../src/ui/modal-input.js';
import { boonOfferComparison, advanceCardFocus, releaseGatedEdge } from '../src/ui/boon-choice.js';

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
assert.equal(ROSTER_IDS.length, 12);
const specialistStates = {
  lancer: ['aim', 'charge'],
  siren: ['mark', 'blink', 'slash'],
  oracle: ['ritual', 'release'],
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

// Boss rooms advance from the Warden to two unique mythic fights. Later depths
// retain Heracles instead of wrapping back to an earlier boss.
assert.deepEqual(BOSS_SEQUENCE, ['warden', 'minotaur', 'heracles']);
assert.equal(bossForDepth(5), 'warden');
assert.equal(bossForDepth(10), 'minotaur');
assert.equal(bossForDepth(15), 'heracles');
assert.equal(bossForDepth(20), 'heracles');
for (const [kind, states] of Object.entries({
  minotaur: ['sweepTell', 'chargeTell', 'chargeGo', 'stompTell', 'exposed'],
  heracles: ['clubTell', 'boulderTell', 'leapTell', 'leapHit', 'exposed'],
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

for (const weapon of ['blade', 'spear', 'bow', 'shield']) {
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
  if (weapon === 'spear') assert.ok(shot.pierce > 3, 'Spear Cast did not gain pierce');
  if (weapon === 'bow') assert.equal(shot.kind, 'homing', 'Bow Cast did not seek');
  if (weapon === 'shield') assert.ok(shot.kind === 'bounce' && shot.bounces > 0, 'Shield Cast did not ricochet');
}

// Displayed controls are all live actions; dead debug/map bindings stay out.
const controlText = CONTROL_ROWS.flat().join(' ').toLowerCase();
for (const action of ['move', 'aim', 'attack', 'special', 'cast', 'dash', 'call', 'interact', 'pause']) assert.ok(controlText.includes(action));
assert.ok(!controlText.includes('debug') && !controlText.includes('map'));
assert.ok(controlText.includes('approach an arm at home'));
assert.ok(!controlText.includes('x/c cycle') && !controlText.includes('1–4'));

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

assert.equal(GOD_KEYS.length, 11);
console.log('features ok: 12 enemies, 3 unique bosses, 11 gods, god-locked gates, 20 Attack/Special/Cast forges, audio bridge');
