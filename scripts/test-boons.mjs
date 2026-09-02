import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BOONS, DUOS, BoonState, GOD_INFO, GOD_KEYS, emptyMods, valuesFor, SKILL_BOONS, SKILL_DUOS } from '../src/game/boons.js';
import { CombatSystem } from '../src/entities/combat.js';
import { VFX } from '../src/vfx/index.js';
import { ProjectileSystem } from '../src/entities/projectiles.js';
import { buildClipData } from '../src/entities/anim.js';
import { CAST_SHARD_BASE_BONUS, CAST_SHARD_DURATION, castPresentation } from '../src/entities/cast.js';

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
  const doomMarks = [], doomStrikes = [];
  const ctx = {
    player, events, rng: { f: () => 0 }, world: { radiusAt: () => 20, bounds: { r: 20 } },
    ui: { setHealth: noop, setMana: noop, damageNumber: noop, toast: noop },
    vfx: {
      burst: noop, beam: noop, shockwave: noop, impact: noop, slash: noop,
      doomMark: (target, record) => doomMarks.push({ target, record }),
      doomStrike: target => doomStrikes.push(target),
    },
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
  return { ctx, combat, player, enemy, doomMarks, doomStrikes };
}

const grant = (ctx, id, rarity = 'common') => {
  const boon = [...BOONS, ...DUOS].find((b) => b.id === id);
  assert.ok(boon, `missing boon ${id}`);
  return ctx.boons.grant(ctx.boons.offer(boon, rarity));
};

// The visual authority owns exactly one tracking knife per doomed target.
// Reapplication strengthens that mark, and the last quarter of the timer
// moves it down from the hover point toward the enemy.
{
  const fx = new VFX();
  fx.root = new THREE.Group();
  fx._doomTemplate = fx._buildDoomKnife();
  const target = actor('enemy', 4, 2, 100);
  target.id = 42; target.height = 2;
  const rec = { kind: 'doom', t: 0, dur: 1.35, stacks: 1 };
  const first = fx.doomMark(target, rec);
  rec.stacks = 3;
  assert.equal(fx.doomMark(target, rec), first);
  assert.equal(fx._doom.size, 1, 'Doom spawned overlapping knives on reapplication');
  fx._updateDoom(1 / 60, { time: { t: 0.2 } });
  const hoverY = first.object.position.y;
  rec.t = 1.25;
  fx._updateDoom(1 / 60, { time: { t: 1.25 } });
  assert.ok(first.object.position.y < hoverY, 'Doom knife did not fall near expiry');
  fx.cancelDoom(target);
  assert.equal(fx._doom.size, 0);
  fx._doomTemplate.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
}

// Every authored card must change modifier state and must never throw.
for (const boon of [...BOONS, ...DUOS]) {
  const before = JSON.stringify(emptyMods());
  const mods = emptyMods();
  boon.apply(mods, valuesFor(boon, 'common'));
  assert.notEqual(JSON.stringify(mods), before, `${boon.id} has no gameplay modifier`);
}

// A replacement previews and receives one stronger rarity tier, with its
// potency recalculated at that tier. It inherits prior investment and caps at
// Heroic rather than ever downgrading an upgraded slot.
{
  let h = harness();
  grant(h.ctx, 'zeus.attack', 'common');
  const tempest = BOONS.find(x => x.id === 'poseidon.attack');
  const preview = h.ctx.boons.offer(tempest, 'common');
  assert.equal(preview.rarity, 'rare');
  assert.equal(preview.values.dmg, 18);
  assert.equal(preview.upgrade, true);
  assert.equal(preview.replaces, 'zeus.attack');
  const replacement = h.ctx.boons.grant(preview);
  assert.equal(replacement.rarity, 'rare');
  assert.equal(h.ctx.boons.mods.rider.attack.bonus, 18, 'replacement potency did not reach runtime');

  h = harness();
  grant(h.ctx, 'zeus.attack', 'rare');
  assert.equal(h.ctx.boons.offer(tempest, 'common').rarity, 'epic', 'replacement lost the old boon tier');
  h = harness();
  grant(h.ctx, 'zeus.attack', 'heroic');
  assert.equal(h.ctx.boons.offer(tempest, 'common').rarity, 'heroic', 'replacement exceeded the rarity cap');
}

// Core slots replace instead of corrupting one shared status rider.
{
  const { ctx } = harness();
  for (const b of BOONS.filter((x) => x.slot === 'attack')) grant(ctx, b.id);
  assert.equal(ctx.boons.list().filter((x) => x.slot === 'attack').length, 1);
  assert.equal(ctx.boons.mods.rider.attack.god, BOONS.filter((x) => x.slot === 'attack').at(-1).god);
  const final = ctx.boons.list().find(x => x.slot === 'attack');
  const expectedStacks = final.boon.status ? (final.values.stacks ?? final.values.chill ?? 1) : 0;
  assert.equal(ctx.boons.mods.rider.attack.stacks, expectedStacks, 'cross-god status stacks leaked into the replacement');
}

// An Epic/Heroic action slot is protected from different boons in the same
// category. The exact Epic boon may still be promoted to Heroic.
{
  const h = harness();
  grant(h.ctx, 'zeus.attack', 'epic');
  const rng = { f: () => 0.75, pick: list => list[0] };
  const fresh = h.ctx.boons.roll(rng, { count: 3, god: 'zeus', allowDuo: false, upgradeChance: 0 });
  assert.equal(fresh.length, 3);
  assert.ok(fresh.every(o => o.slot !== 'attack'), 'Epic Attack allowed a different Attack replacement card');
  const promoted = h.ctx.boons.roll(rng, { count: 3, god: 'zeus', allowDuo: false, preferUpgrade: true });
  assert.ok(promoted.some(o => o.id === 'zeus.attack' && o.rarity === 'heroic'), 'Epic boon could not advance to Heroic');

  const hh = harness();
  grant(hh.ctx, 'zeus.attack', 'heroic');
  const locked = hh.ctx.boons.roll(rng, { count: 3, god: 'zeus', allowDuo: false, preferUpgrade: true });
  assert.ok(locked.every(o => o.slot !== 'attack'), 'Heroic Attack produced a redundant or weaker Attack offer');
}

assert.ok(BOONS.length >= 130, 'boon expansion is not substantial');
assert.ok(DUOS.length >= 20, 'duo expansion is not substantial');
assert.equal(new Set([...BOONS, ...DUOS].map(b => b.id)).size, BOONS.length + DUOS.length, 'duplicate boon ids entered the expanded pool');

// The combined Hades/Hades II translation must stay broad enough to support
// a real Codex, not regress to a handful of representative cards. New core
// Olympians each own a complete browser-game action family.
assert.ok(BOONS.length >= 270, 'combined pantheon lost authored boon breadth');
assert.ok(DUOS.length >= 80, 'combined pantheon lost duo breadth');
assert.equal(GOD_KEYS.length, 17, 'expanded divine roster changed unexpectedly');
for (const god of GOD_KEYS) {
  assert.ok(GOD_INFO[god], `missing god metadata for ${god}`);
  assert.ok(BOONS.filter(b => b.god === god).length >= 5, `${god} has too few playable boons`);
}
for (const god of ['demeter', 'apollo', 'hera', 'hestia']) {
  for (const slot of ['attack', 'special', 'cast', 'dash', 'call']) {
    assert.ok(BOONS.some(b => b.god === god && b.slot === slot), `${god} is missing a ${slot} boon`);
  }
}

// Re-taking an exact gift is a Pom-style level: the record and its live
// numeric potency both rise, independently from rarity.
{
  const h = harness();
  const first = grant(h.ctx, 'zeus.attack', 'rare');
  const base = first.values.dmg;
  const second = h.ctx.boons.grant(h.ctx.boons.offer(first.boon, 'rare'));
  assert.equal(second.level, 2);
  assert.ok(second.values.dmg > base, 'boon level did not increase potency');
}

// Call is a core category too: an Epic call cannot be crowded out by a lower
// replacement, while its exact card may still promote to Heroic.
{
  const h = harness();
  grant(h.ctx, 'demeter.canon.call', 'epic');
  const rng = { f: () => 0.75, pick: list => list[0] };
  const fresh = h.ctx.boons.roll(rng, { count: 3, god: 'apollo', allowDuo: false, upgradeChance: 0 });
  assert.ok(fresh.every(o => o.slot !== 'call'), 'Epic Call allowed a lower replacement Call');
  const promoted = h.ctx.boons.roll(rng, { count: 3, god: 'demeter', allowDuo: false, preferUpgrade: true });
  assert.ok(promoted.some(o => o.id === 'demeter.canon.call' && o.rarity === 'heroic'), 'Epic Call could not promote');
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

// Zeus retaliation and the rebalanced Selene Call are live combat effects.
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
  assert.equal(before - enemy.health, 42, 'Common Moon Water damage drifted from its nerfed value');
  assert.equal(player._boonCallCd, 14, 'Moon Water must use the longer Call recharge');
  assert.equal(combat.summon({ source: player, pos: player.position.clone(), dir: new THREE.Vector2(1, 0) }), false);
  assert.equal(before - enemy.health, 42, 'Call dealt damage while recharging');
}

// The fallback R summon cannot be spammed or pierce an entire room anymore.
{
  const { combat, player } = harness();
  const fired = [];
  combat.projectiles.fire = d => (fired.push(d), fired.length);
  assert.equal(combat.summon({ source: player, pos: player.position.clone(), dir: new THREE.Vector2(1, 0) }), true);
  assert.equal(fired.length, 3);
  assert.ok(fired.every(p => p.damage === 7 && p.life === 4.5 && p.pierce === 3));
  assert.equal(player._boonCallCd, 14, 'Fallback summon must begin recharge');
  assert.equal(combat.summon({ source: player, pos: player.position.clone(), dir: new THREE.Vector2(1, 0) }), false);
  assert.equal(fired.length, 3, 'Fallback summon spawned more motes while recharging');
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

// Cast is a three-shard lodge/return loop, not a generic piercing bolt. The
// embedded mark buffs only weapon Attack/Special damage, drops on release, and
// every divine animation family resolves to a real authored clip.
{
  const clips = buildClipData();
  const storm = castPresentation('zeus'), tide = castPresentation('poseidon'), ritual = castPresentation('hecate');
  assert.ok(clips[storm.clip] && clips[tide.clip] && clips[ritual.clip], 'a divine Cast selected a missing animation');
  assert.equal(new Set([storm.clip, tide.clip, ritual.clip]).size, 3, 'Cast boons all retained the same player animation');
  assert.notDeepEqual(storm.core, tide.core, 'divine Cast projectiles retained one shard silhouette');

  const owner = actor('player', 0, 0, 100);
  owner.castStock = 1; owner.castMax = 3;
  owner.restoreCastShard = function (n = 1) { this.castStock = Math.min(this.castMax, this.castStock + n); };
  const target = actor('enemy', 2, 0, 100);
  target.height = 2;
  const projectiles = new ProjectileSystem();
  projectiles.ctx = { events: { emit: noop }, vfx: { burst: noop, impact: noop } };
  projectiles.combat = { hitboxes: { teamOf: e => e.team === 'player' ? 1 : 2 } };
  projectiles.pool = [projectiles._blank(0)];
  const id = projectiles.fire({ x: 1.6, y: 1, z: 0, dx: 1, dz: 0, source: owner, castShard: true, castDuration: CAST_SHARD_DURATION });
  const shard = projectiles.get(id);
  assert.ok(projectiles.lodgeCastShard(shard, target, CAST_SHARD_DURATION));
  assert.equal(target._castShardCount, 1);
  assert.equal(shard.lodgedTarget, target);
  assert.ok(projectiles.dropCastShard(shard, 'expired'));
  assert.equal(target._castShardCount, 0);
  assert.equal(owner.castStock, 2, 'a fallen Cast shard did not return to stock');
  projectiles.kill(shard, 'expire');
  assert.equal(owner.castStock, 2, 'a returned Cast shard was restored twice');

  owner.castStock = 2;
  const missId = projectiles.fire({ x: 0, y: 1, z: 0, dx: 1, dz: 0, source: owner, castShard: true });
  projectiles.kill(projectiles.get(missId), 'expire');
  assert.equal(owner.castStock, 3, 'a missed Cast shard did not return');

  const h = harness();
  h.enemy._castShardCount = 1;
  assert.equal(h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, boonSlot: 'attack' }), 10 * (1 + CAST_SHARD_BASE_BONUS));
  assert.equal(h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, boonSlot: 'special' }), 10 * (1 + CAST_SHARD_BASE_BONUS));
  assert.equal(h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, boonSlot: 'cast' }), 10, 'the lodged shard incorrectly amplified Cast itself');
}

// Authored Doom/Hangover power, extended Chill duration, and wall slams.
{
  const { ctx, combat, player, enemy, doomMarks, doomStrikes } = harness();
  grant(ctx, 'ares.attack');
  combat.applyStatus(enemy, 'doom', 1, player, ctx.boons.mods.rider.attack.statusPower);
  assert.equal(doomMarks.length, 1, 'Doom did not hang a knife over its target');
  assert.equal(doomMarks[0].record.kind, 'doom');
  const before = enemy.health;
  combat._statusTick(1.0);
  assert.equal(enemy.health, before, 'Doom dealt damage before the knife dropped');
  assert.equal(doomStrikes.length, 0);
  combat._statusTick(0.4);
  assert.equal(doomStrikes.length, 1, 'Doom damage did not coincide with the knife strike');
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

// SKILL BOONS pay for how you fight. Each mechanic reaches combat.applyDamage.
assert.ok(SKILL_BOONS.length >= 8, 'skill boon set is not substantial');
assert.ok(SKILL_DUOS.length >= 4, 'skill duo set is not substantial');
for (const b of [...SKILL_BOONS, ...SKILL_DUOS]) assert.ok(b.mechanic, `${b.id} is not tagged with its mechanic`);
assert.ok(new Set([...SKILL_BOONS, ...SKILL_DUOS].map(b => b.mechanic)).size >= 4, 'skill boons cover too few mechanics');
{
  // backstab: the hit direction agrees with the victim's facing
  let h = harness(); grant(h.ctx, 'artemis.passive.flank');
  h.enemy.facing = { x: 1, z: 0 };
  const behind = h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, dir: new THREE.Vector3(1, 0, 0) });
  const front = h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, dir: new THREE.Vector3(-1, 0, 0) });
  assert.ok(behind > front && behind >= 12, 'Exposed Flank did not pay for a backstab');
  // execute: below the threshold
  h = harness(); grant(h.ctx, 'ares.passive.merciless');
  const healthy = h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player });
  h.enemy.health = 100;
  const dying = h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player });
  assert.ok(dying > healthy, 'Merciless did not pay below the threshold');
  // stagger: a staggered foe takes more
  h = harness(); grant(h.ctx, 'athena.passive.riposte');
  h.enemy.stagger = 0.4;
  assert.ok(h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player }) > 12, 'Divine Riposte ignored the stagger');
  // perfect dodge duo: the riposte strike is a guaranteed crit
  h = harness(); grant(h.ctx, 'duo.hermes.ares');
  h.player._perfectDodgeT = 1;
  const crit = h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, boonSlot: 'attack' });
  assert.ok(crit >= 20, `Split Second did not crit the riposte (${crit})`);
  h = harness(); grant(h.ctx, 'zeus.passive.static');
  h.player.state = 'dash'; h.player.iframes = 0.2; h.player.dash = { t: 0.05 }; h.player.tune = { dashIFrames: [0.015, 0.215], hurtIFrames: 0 };
  const hp = h.enemy.health;
  h.combat.applyDamage({ target: h.player, amount: 10, source: h.enemy });
  assert.ok(h.enemy.health < hp && h.combat._stack(h.enemy, 'shock') > 0, 'Static Step did not strike the attacker on a perfect dodge');
}

console.log(`boons ok: ${BOONS.length} core, ${DUOS.length} duo, ${SKILL_BOONS.length} skill boons, runtime hooks verified`);
