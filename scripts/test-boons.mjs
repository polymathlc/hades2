import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOONS, DUOS, BoonState, emptyMods, valuesFor } from '../src/game/boons.js';
import { CombatSystem } from '../src/entities/combat.js';

const noop = () => {};
const events = { emit: noop, on: noop };

function actor(team, x = 0, z = 0, health = 500) {
  return {
    team, faction: team, position: new THREE.Vector3(x, 0, z), radius: 0.5,
    health, maxHealth: health, alive: true, dead: false, iframes: 0,
    poiseMax: 0, poise: 0, armour: 0, resist: {}, critChance: 0, critMul: 2,
  };
}

function harness() {
  const player = actor('player', 0, 0, 300);
  player.maxMana = player.mana = 100;
  player.tune = { hurtIFrames: 0 };
  const enemy = actor('enemy', 3, 0, 1000);
  const ctx = {
    player, events, rng: { f: () => 0 }, world: { radiusAt: () => 20, bounds: { r: 20 } },
    ui: { setHealth: noop, setMana: noop, damageNumber: noop, toast: noop },
    vfx: { burst: noop, beam: noop, shockwave: noop, impact: noop, slash: noop },
    audio: { sfx: noop }, engine: { hitstop: noop }, CAPTURE: true,
  };
  ctx.boons = new BoonState(ctx);
  const combat = new CombatSystem();
  Object.assign(combat, {
    ctx, entities: new Set([player, enemy]), _list: [player, enemy], _dirty: false,
    _status: new Map(), _expose: new Map(), _critMark: new Map(), _knock: [], _boonPulses: [],
    _recentDamage: 0, rng: { f: () => 0 }, _v3a: new THREE.Vector3(), _v3b: new THREE.Vector3(),
    hitboxes: { cancelByOwner: noop, spawn: (d) => (combat.lastHitbox = d, 1) },
    projectiles: { fire: (d) => (combat.lastProjectile = d, 1), forEachIncoming: noop },
  });
  ctx.combat = combat;
  return { ctx, combat, player, enemy };
}

const grant = (ctx, id, rarity = 'common') => {
  const boon = [...BOONS, ...DUOS].find((b) => b.id === id);
  assert.ok(boon, `missing boon ${id}`);
  return ctx.boons.grant(ctx.boons.offer(boon, rarity));
};

// Every authored card must change modifier state and must never throw.
for (const boon of [...BOONS, ...DUOS]) {
  const before = JSON.stringify(emptyMods());
  const mods = emptyMods();
  boon.apply(mods, valuesFor(boon, 'common'));
  assert.notEqual(JSON.stringify(mods), before, `${boon.id} has no gameplay modifier`);
}

// Core slots replace instead of corrupting one shared status rider.
{
  const { ctx } = harness();
  for (const b of BOONS.filter((x) => x.slot === 'attack')) grant(ctx, b.id);
  assert.equal(ctx.boons.list().filter((x) => x.slot === 'attack').length, 1);
  assert.equal(ctx.boons.mods.rider.attack.god, BOONS.filter((x) => x.slot === 'attack').at(-1).god);
  assert.ok(ctx.boons.mods.rider.attack.stacks <= 3, 'cross-god status stacks leaked into the replacement');
}

// Athena exposure affects subsequent damage and her action window deflects.
{
  const { ctx, combat, player, enemy } = harness();
  grant(ctx, 'athena.attack');
  const rider = ctx.boons.mods.rider.attack;
  const a = combat.applyDamage({ target: enemy, amount: 10, source: player, expose: rider.expose });
  const b = combat.applyDamage({ target: enemy, amount: 10, source: player });
  assert.ok(b > a, 'Expose did not increase follow-up damage');
  combat.activateDeflect(player, 0.6);
  assert.equal(combat.applyDamage({ target: player, amount: 20, source: enemy }), 0);
}

// Zeus retaliation and Selene Call are live combat effects.
{
  const { ctx, combat, player, enemy } = harness();
  grant(ctx, 'zeus.passive', 'heroic');
  const hp = enemy.health;
  combat.applyDamage({ target: player, amount: 10, source: enemy });
  assert.ok(enemy.health < hp, 'retaliation did not strike the attacker');
  grant(ctx, 'selene.call');
  enemy.position.set(2, 0, 0);
  const before = enemy.health;
  assert.equal(combat.summon({ source: player, pos: player.position.clone(), dir: new THREE.Vector2(1, 0) }), true);
  assert.ok(enemy.health < before && player._boonCallCd > 0, 'Call did not damage or begin recharge');
}

// Cast variants publish their mechanics into the projectile/pulse authority.
{
  const { ctx, combat, player } = harness();
  const origin = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3(1, 0, 0);
  grant(ctx, 'zeus.cast');
  combat.cast({ source: player, origin, dir });
  assert.ok(combat.lastProjectile.forks >= 2);
  grant(ctx, 'ares.cast');
  combat.cast({ source: player, origin, dir });
  assert.ok(combat.lastProjectile.castTicks >= 5);
  grant(ctx, 'selene.cast');
  combat.cast({ source: player, origin, dir });
  assert.equal(combat._boonPulses.at(-1).kind, 'beam');
}

// Authored Doom/Hangover power, extended Chill duration, and wall slams.
{
  const { ctx, combat, player, enemy } = harness();
  grant(ctx, 'ares.attack');
  combat.applyStatus(enemy, 'doom', 1, player, ctx.boons.mods.rider.attack.statusPower);
  const before = enemy.health;
  combat._statusTick(2);
  assert.equal(Math.round(before - enemy.health), 30, 'Doom ignored the card damage');

  ctx.boons.clear(); grant(ctx, 'hecate.passive'); grant(ctx, 'hecate.attack');
  combat.applyStatus(enemy, 'chill', 2, player);
  assert.equal(combat._status.get(enemy).find((x) => x.kind === 'chill').dur, 5);
  assert.ok(combat.slowOf(enemy) < 1, 'Chill did not slow movement');

  ctx.boons.clear(); grant(ctx, 'poseidon.passive');
  enemy.position.set(18, 0, 0); enemy.health = 500; enemy.dead = false; enemy.alive = true;
  const wallBefore = enemy.health;
  combat.applyDamage({ target: enemy, amount: 10, source: player, knockback: 5, dir: new THREE.Vector3(1, 0, 0) });
  assert.ok(wallBefore - enemy.health >= 22, 'wall-slam bonus did not resolve');
}

// Every duo's advertised condition reaches a combat payoff.
{
  let h = harness();
  grant(h.ctx, 'duo.zeus.poseidon');
  h.enemy.position.set(18, 0, 0);
  const sea = h.enemy.health;
  h.combat.applyDamage({ target: h.enemy, amount: 10, type: 'physical', source: h.player,
    knockback: 5, dir: new THREE.Vector3(1, 0, 0) });
  assert.ok(sea - h.enemy.health >= 50 && h.combat._stack(h.enemy, 'shock') > 0, 'Sea Storm did not strike a slammed foe');

  h = harness(); grant(h.ctx, 'duo.zeus.artemis');
  assert.equal(h.combat.applyDamage({ target: h.enemy, amount: 10, type: 'lightning', source: h.player }), 20, 'Fully Loaded did not crit lightning');

  h = harness(); grant(h.ctx, 'duo.ares.aphrodite');
  h.combat.applyStatus(h.enemy, 'weak', 1, h.player);
  h.combat.applyStatus(h.enemy, 'doom', 1, h.player, 30);
  const longing = h.enemy.health; h.combat._statusTick(2);
  assert.equal(Math.round(longing - h.enemy.health), 85, 'Curse of Longing ignored Weak');

  h = harness(); grant(h.ctx, 'duo.ares.artemis');
  const blades = h.enemy.health;
  h.combat.applyDamage({ target: h.enemy, amount: 10, type: 'physical', source: h.player, crit: true });
  assert.ok(blades - h.enemy.health >= 54, 'Hunting Blades did not open a critical rift');

  h = harness(); grant(h.ctx, 'duo.dionysus.aphrodite');
  h.combat.applyStatus(h.enemy, 'weak', 1, h.player); h.combat.applyStatus(h.enemy, 'burn', 2, h.player, 8);
  assert.ok(h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player }) > 11, 'Low Tolerance ignored Hangover on Weak');

  h = harness(); grant(h.ctx, 'duo.hecate.selene');
  const moon = h.enemy.health; h.combat.applyStatus(h.enemy, 'chill', 10, h.player);
  assert.ok(moon - h.enemy.health >= 73, 'Moonstruck did not add moonlight shatter damage');

  h = harness(); grant(h.ctx, 'duo.athena.hermes');
  assert.ok(h.ctx.boons.mods.deflectDodge > 0, 'Sure Footing did not create its deflect dodge window');

  h = harness(); grant(h.ctx, 'duo.poseidon.hermes');
  h.enemy.position.set(18, 0, 0);
  h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, knockback: 5, dir: new THREE.Vector3(1, 0, 0) });
  assert.ok(h.player._boonSlamT > 0 && h.ctx.boons.mods.slamSpeed > 0, 'Rip Current did not start its post-slam speed window');
}

console.log(`boons ok: ${BOONS.length} core, ${DUOS.length} duo, runtime hooks verified`);
