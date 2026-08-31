import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  BOONS, DUOS, LEGENDARIES, BoonState, GOD_INFO, GOD_KEYS, SLOTS,
  RARITIES, TIERS, RARITY_MUL, RARITY_LABEL, RARITY_COLOR,
  CURSES, curseForBoon, emptyMods, valuesFor,
} from '../src/game/boons.js';
import { upsertHudBoon, hudBoonGroups } from '../src/ui/hud-boons.js';
import { CombatSystem } from '../src/entities/combat.js';
import { RunState } from '../src/game/run.js';
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
  const boon = [...BOONS, ...DUOS, ...LEGENDARIES].find((b) => b.id === id);
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
  assert.equal(h.ctx.boons.get('duo.zeus.artemis').rarity, 'duo');

  h = harness();
  const longingRec = grant(h.ctx, 'duo.ares.aphrodite');
  assert.equal(longingRec.rarity, 'duo', 'a duo did not arrive at the Duo grade');
  h.combat.applyStatus(h.enemy, 'weak', 1, h.player);
  h.combat.applyStatus(h.enemy, 'doom', 1, h.player, 30);
  const longing = h.enemy.health; h.combat._statusTick(2);
  assert.equal(Math.round(longing - h.enemy.health), 30 + longingRec.values.dmg,
    'Curse of Longing ignored Weak, or its Duo-grade value never reached the tick');

  h = harness();
  const bladeRec = grant(h.ctx, 'duo.ares.artemis');
  const blades = h.enemy.health;
  h.combat.applyDamage({ target: h.enemy, amount: 10, type: 'physical', source: h.player, crit: true });
  assert.ok(blades - h.enemy.health >= bladeRec.values.dmg, 'Hunting Blades did not open a critical rift');

  h = harness(); grant(h.ctx, 'duo.dionysus.aphrodite');
  h.combat.applyStatus(h.enemy, 'weak', 1, h.player); h.combat.applyStatus(h.enemy, 'burn', 2, h.player, 8);
  assert.ok(h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player }) > 11, 'Low Tolerance ignored Hangover on Weak');

  h = harness();
  const moonRec = grant(h.ctx, 'duo.hecate.selene');
  const moon = h.enemy.health; h.combat.applyStatus(h.enemy, 'chill', 10, h.player);
  assert.ok(moon - h.enemy.health >= moonRec.values.dmg, 'Moonstruck did not add moonlight shatter damage');

  h = harness(); grant(h.ctx, 'duo.athena.hermes');
  assert.ok(h.ctx.boons.mods.deflectDodge > 0, 'Sure Footing did not create its deflect dodge window');

  h = harness(); grant(h.ctx, 'duo.poseidon.hermes');
  h.enemy.position.set(18, 0, 0);
  h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, knockback: 5, dir: new THREE.Vector3(1, 0, 0) });
  assert.ok(h.player._boonSlamT > 0 && h.ctx.boons.mods.slamSpeed > 0, 'Rip Current did not start its post-slam speed window');
}


// ═══════════════════════════════════════════════════════════════════════════
// THE SYSTEMS SUITE
// Everything below tests the boon *systems* rather than one boon's payoff:
// the rarity ladder, the fixed Duo/Legendary tiers, prerequisite gating, slot
// exclusivity, Poms, rerolls, and the promise that the number a card prints is
// the number the modifier engine will use.
// ═══════════════════════════════════════════════════════════════════════════

const ACTION = ['attack', 'special', 'cast', 'dash', 'call'];
const numbersIn = (text) => (String(text).match(/\d+(?:\.\d+)?/g) || []);
const state = () => new BoonState({ events, rng: { f: () => 0 } });

// ── 1. every card is a complete, renderable card ───────────────────────────
{
  const ids = new Set();
  for (const boon of [...BOONS, ...DUOS]) {
    assert.ok(typeof boon.id === 'string' && boon.id.length, 'a boon has no id');
    assert.ok(!ids.has(boon.id), `duplicate boon id ${boon.id}`);
    ids.add(boon.id);
    assert.ok(typeof boon.name === 'string' && boon.name.trim().length >= 3,
      `${boon.id} has no usable display name`);
    assert.ok(SLOTS[boon.slot || 'passive'], `${boon.id} sits in unknown slot ${boon.slot}`);
    assert.equal(typeof boon.apply, 'function', `${boon.id} has no apply()`);
    assert.ok(boon.base && typeof boon.base === 'object', `${boon.id} has no base table`);
    for (const rarity of RARITIES) {
      const text = boon.text(valuesFor(boon, rarity));
      assert.ok(typeof text === 'string' && text.trim().length >= 12,
        `${boon.id} has no description at ${rarity}`);
      assert.ok(!/undefined|NaN|\[object/.test(text), `${boon.id} description is broken at ${rarity}: ${text}`);
    }
  }
  assert.ok(LEGENDARIES.length >= 12, 'the Legendary tier is too thin to be a goal');
}

// ── 2. rarity is a real ladder: better tiers are never weaker ──────────────
{
  let scaled = 0;
  for (const boon of [...BOONS, ...DUOS]) {
    let grew = false;
    for (let i = 1; i < RARITIES.length; i++) {
      const lo = valuesFor(boon, RARITIES[i - 1]);
      const hi = valuesFor(boon, RARITIES[i]);
      for (const key of Object.keys(boon.base)) {
        if (typeof boon.base[key] !== 'number') continue;
        if (boon.base[key] === 0) continue;
        // Numbers move away from zero as the grade improves; a boon whose
        // authored value is a penalty must get *more* negative, never flip.
        if (boon.base[key] > 0) {
          assert.ok(hi[key] >= lo[key], `${boon.id}.${key} shrank from ${RARITIES[i - 1]} to ${RARITIES[i]}`);
          if (hi[key] > lo[key]) grew = true;
        } else {
          assert.ok(hi[key] <= lo[key], `${boon.id}.${key} weakened at a higher rarity`);
          if (hi[key] < lo[key]) grew = true;
        }
      }
    }
    const numeric = Object.keys(boon.base).some(k => typeof boon.base[k] === 'number' && boon.base[k] !== 0);
    if (numeric) { assert.ok(grew, `${boon.id} ignores rarity entirely`); scaled++; }
  }
  assert.ok(scaled > 300, `only ${scaled} boons actually scale with rarity`);
  // The two fixed tiers must outweigh a Common roll, or they are not payoffs.
  assert.ok(RARITY_MUL.duo > RARITY_MUL.rare, 'Duo boons are not worth building toward');
  assert.ok(RARITY_MUL.legendary > RARITY_MUL.heroic, 'Legendary must be the strongest grade');
  for (const tier of TIERS) {
    assert.ok(RARITY_LABEL[tier], `tier ${tier} has no label`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(RARITY_COLOR[tier]), `tier ${tier} has no colour`);
  }
}

// ── 3. the printed number is the number the engine uses ────────────────────
// A card that says "18 damage" while the rider carries 27 is a lie, and it is
// the single easiest bug to introduce when rarity multiplies authored values.
{
  let checked = 0;
  for (const boon of [...BOONS, ...DUOS]) {
    const lo = valuesFor(boon, 'common');
    const hi = valuesFor(boon, 'heroic');
    const hiText = boon.text(hi);
    const hiNums = numbersIn(hiText);
    if (!hiNums.length) continue;
    for (const key of Object.keys(boon.base)) {
      if (typeof lo[key] !== 'number' || lo[key] === hi[key]) continue;
      const stale = String(lo[key]);
      if (hiNums.includes(stale) && !hiNums.includes(String(hi[key]))) {
        assert.fail(`${boon.id} prints its Common ${key} (${stale}) on a Heroic card: "${hiText}"`);
      }
    }
    // and at least one printed number must come from the scaled value table
    const values = new Set(Object.values(hi).map(String));
    assert.ok(hiNums.some(n => values.has(n)),
      `${boon.id} prints numbers that no rarity-scaled value produced: "${hiText}"`);
    checked++;
  }
  assert.ok(checked > 300, `only ${checked} descriptions were number-checked`);
}

// ── 4. the offer engine never deals a broken hand ──────────────────────────
{
  let seed = 7;
  const rng = {
    f() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 100000) / 100000; },
    pick(list) { return list[Math.floor(this.f() * list.length) % list.length]; },
  };
  for (const god of GOD_KEYS) {
    for (let trial = 0; trial < 6; trial++) {
      const bs = state();
      // build a partial run first so the pool is not pristine
      for (let k = 0; k < trial; k++) {
        const pool = BOONS.filter(b => b.god === god && !b.legendary && !bs.has(b.id));
        if (pool.length) bs.grant(bs.offer(rng.pick(pool), RARITIES[k % RARITIES.length]));
      }
      const offers = bs.roll(rng, { count: 3, god, allowDuo: true, duoChance: 0.5 });
      assert.ok(offers.length > 0 && offers.length <= 3, `${god} produced ${offers.length} cards`);
      const seen = new Set();
      for (const o of offers) {
        assert.ok(!seen.has(o.id), `${god} offered ${o.id} twice in one hand`);
        seen.add(o.id);
        assert.ok(o.name && o.text, `${god} offered a card with no name or text`);
        assert.ok(TIERS.includes(o.rarity), `${god} offered unknown grade ${o.rarity}`);
        assert.ok(SLOTS[o.slot], `${god} offered unknown slot ${o.slot}`);
        assert.ok(o.gods.includes(god), `${god}'s gate offered a card from another pantheon`);
        if (o.duo) assert.equal(o.rarity, 'duo', 'a Duo rolled an ordinary rarity');
        if (o.legendary) assert.equal(o.rarity, 'legendary', 'a Legendary rolled an ordinary rarity');
        // a locked card must never reach the offer
        assert.ok(!o.locked, `${god} offered the locked card ${o.id}`);
      }
    }
  }
}

// ── 5. the five ability categories are exclusive ───────────────────────────
{
  const bs = state();
  for (const boon of BOONS.filter(b => ACTION.includes(b.slot) && !b.weapon && !b.legendary)) {
    bs.grant(bs.offer(boon, 'common'));
  }
  for (const slot of ACTION) {
    const held = bs.granted.filter(r => !r.duo && !r.boon.legendary && r.slot === slot);
    assert.equal(held.length, 1, `${slot} ended the run holding ${held.length} boons`);
  }
  const slots = bs.slotState();
  for (const slot of ACTION) {
    assert.equal(slots[slot].filled, true, `slotState() lost ${slot}`);
    assert.equal(slots[slot].name, bs.slotBoon(slot).boon.name);
  }
  assert.deepEqual(bs.freeSlots(), [], 'freeSlots() reported an occupied category as open');

  // and a fresh run reports every category as open, which is what drives the
  // offer engine's bias toward cards the player cannot yet use.
  const fresh = state();
  assert.deepEqual(fresh.freeSlots(), ACTION);
  const s2 = fresh.slotState();
  for (const slot of ACTION) assert.equal(s2[slot].filled, false);
}

// ── 6. an offer prefers a category the player has not filled ───────────────
{
  let seed = 31;
  const rng = {
    f() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 100000) / 100000; },
    pick(list) { return list[Math.floor(this.f() * list.length) % list.length]; },
  };
  let openHits = 0, trials = 60;
  for (let i = 0; i < trials; i++) {
    const bs = state();
    bs.grant(bs.offer(BOONS.find(b => b.id === 'zeus.attack'), 'common'));
    const offers = bs.roll(rng, { count: 3, god: 'zeus', allowDuo: false, upgradeChance: 0 });
    if (offers.some(o => ACTION.includes(o.slot) && o.slot !== 'attack')) openHits++;
  }
  assert.ok(openHits > trials * 0.7,
    `only ${openHits}/${trials} offers pointed at an unfilled category`);
}

// ── 7. Duo gating is a real requirement, not "you met both gods" ───────────
{
  const duo = DUOS.find(d => d.id === 'duo.canon.sea-storm') || DUOS[0];
  assert.ok(duo.requires, 'duos carry no prerequisite map');
  const [godA, godB] = duo.gods;

  const bs = state();
  assert.equal(bs.availableDuos().some(d => d.id === duo.id), false, 'a duo was available with no boons at all');

  // A passive from each god is NOT enough: the gate asks for action boons.
  const passiveA = BOONS.find(b => b.god === godA && b.slot === 'passive');
  const passiveB = BOONS.find(b => b.god === godB && b.slot === 'passive');
  if (passiveA && passiveB) {
    bs.grant(bs.offer(passiveA, 'common'));
    bs.grant(bs.offer(passiveB, 'common'));
    assert.equal(bs.availableDuos().some(d => d.id === duo.id), false,
      'passives alone unlocked a duo; the gate is not checking the prerequisite list');
  }

  // One qualifying boon: half the gate, and the card can say so. The two
  // prerequisites must occupy different categories, or the second grant would
  // simply evict the first — which is itself the slot rule working.
  const reqA = duo.requires[godA][0];
  const boonA = BOONS.find(b => b.id === reqA);
  bs.grant(bs.offer(boonA, 'common'));
  let status = bs.prerequisites(duo);
  assert.equal(status.met, false, 'one god satisfied the whole duo');
  assert.equal(status.gods.length, 2);
  assert.equal(status.gods.find(x => x.god === godA).met, true);
  assert.equal(status.gods.find(x => x.god === godB).met, false);
  assert.ok(bs.pendingDuos().some(x => x.duo.id === duo.id), 'a half-met duo is not reported as pending');
  assert.equal(bs.availableDuos().some(d => d.id === duo.id), false);

  // Both halves: unlocked, and it arrives at the Duo grade.
  const boonB = duo.requires[godB]
    .map(id => BOONS.find(b => b.id === id))
    .find(b => b && b.slot !== boonA.slot);
  assert.ok(boonB, 'the two patrons only offer one category between them');
  bs.grant(bs.offer(boonB, 'common'));
  status = bs.prerequisites(duo);
  assert.equal(status.met, true, 'a fully satisfied duo stayed locked');
  assert.ok(bs.availableDuos().some(d => d.id === duo.id));
  const offered = bs.offer(duo);
  assert.equal(offered.rarity, 'duo');
  assert.equal(offered.tier, 'duo');
  assert.equal(offered.locked, false);
  assert.ok(offered.values.dmg === undefined || offered.values.dmg >= (duo.base.dmg || 0));

  // and once held it must not be offered again
  bs.grant(offered);
  assert.equal(bs.availableDuos().some(d => d.id === duo.id), false, 'an owned duo stayed in the pool');
}

// ── 8. Legendary gating: deep investment in one god ────────────────────────
{
  const leg = LEGENDARIES.find(l => l.god === 'zeus');
  assert.ok(leg && leg.need >= 2, 'the Zeus Legendary asks for no investment');
  const bs = state();
  assert.equal(bs.availableLegendaries('zeus').length, 0);

  const pool = leg.requires.zeus;
  assert.ok(pool.length >= leg.need, 'a Legendary asks for more boons than its god offers');
  bs.grant(bs.offer(BOONS.find(b => b.id === pool[0]), 'common'));
  assert.equal(bs.prerequisites(leg).met, false, 'one boon unlocked a Legendary');
  assert.equal(bs.availableLegendaries('zeus').length, 0);
  assert.equal(bs.offer(leg).locked, true, 'a locked Legendary did not report itself locked');

  // A second Zeus action boon completes it. Note the second grant must not
  // replace the first: pick a different category.
  const second = pool.find(id => {
    const b = BOONS.find(x => x.id === id);
    return b && b.slot !== BOONS.find(x => x.id === pool[0]).slot;
  });
  bs.grant(bs.offer(BOONS.find(b => b.id === second), 'common'));
  assert.equal(bs.prerequisites(leg).met, true, 'two qualifying boons did not open the Legendary');
  assert.equal(bs.availableLegendaries('zeus')[0].id, leg.id);
  // ...and only for that god
  assert.equal(bs.availableLegendaries('ares').length, 0, 'Zeus investment opened another god’s Legendary');

  const offer = bs.offer(leg);
  assert.equal(offer.rarity, 'legendary');
  assert.equal(offer.locked, false);
  const rec = bs.grant(offer);
  assert.equal(rec.rarity, 'legendary');

  // A Legendary must never appear in an ordinary draw before it is earned.
  const clean = state();
  const rng = { f: () => 0.01, pick: list => list[0] };
  for (let i = 0; i < 20; i++) {
    const offers = clean.roll(rng, { count: 3, god: 'zeus', allowDuo: false });
    assert.ok(offers.every(o => !o.legendary), 'an unearned Legendary entered the ordinary pool');
  }
}

// ── 8b. NO WRITE-ONLY MODIFIERS ───────────────────────────────────────────
// The bug this exists to kill: a card that prints "Gain 1 additional Dash",
// writes `mods.dashCharges`, and is read by nothing — a promise the engine
// cannot keep. The consumer set is DERIVED, by scanning every module outside
// the boon data for property access on a modifier object, so it keeps working
// as fields are added and cannot be satisfied by a hand-maintained allowlist.
const MOD_CONSUMERS = (() => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Everything that is not the boon data itself is a consumer. run.js is the
  // run system reading the loadout, not part of the modifier engine.
  const roots = ['src/entities', 'src/ui', 'src/world', 'src/render', 'src/vfx',
    'src/core', 'src/audio', 'src/materials', 'src/main.js', 'src/game/run.js'];
  const walk = (path, out = []) => {
    const st = statSync(path);
    if (st.isDirectory()) { for (const f of readdirSync(path)) walk(path + '/' + f, out); }
    else if (path.endsWith('.js')) out.push(path);
    return out;
  };
  let text = '';
  for (const r of roots) for (const f of walk(root + r)) text += readFileSync(f, 'utf8') + '\n';
  // BoonState._syncPlayer() publishes a few modifiers straight onto the hero,
  // so its body counts as a consumer too — and nothing else in src/game does.
  const engine = readFileSync(root + 'src/game/boons.js', 'utf8');
  const from = engine.indexOf('_syncPlayer() {');
  text += engine.slice(from, engine.indexOf('clear() {', from));
  // mods.x / playerMods?.x / sourceMods?.x / ctx.boons?.mods?.x
  const re = /\b\w*[Mm]ods\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return out;
})();

{
  // sanity: the scanner must actually find the well-known modifiers, or an
  // empty consumer set would make every assertion below vacuously true.
  for (const known of ['attackMul', 'rider', 'status', 'critChance', 'wallSlamDmg']) {
    assert.ok(MOD_CONSUMERS.has(known), `the modifier scan missed ${known} — the derivation is broken`);
  }
  const declared = Object.keys(emptyMods());
  const orphans = declared.filter(k => !MOD_CONSUMERS.has(k));
  assert.deepEqual(orphans, [],
    `emptyMods() declares fields nothing outside the boon data reads: ${orphans.join(', ')}`);

  // Both what changed AND what appeared: a boon writing `m.vsWeakAmpp` invents
  // a field, and an invented field is as dead as an unread one.
  const changedKeys = (boon, rarity) => {
    const before = emptyMods(), after = emptyMods();
    try { boon.apply(after, valuesFor(boon, rarity), null); } catch (e) { return []; }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  };

  // Every one of the fifteen, not one of them.
  assert.equal(LEGENDARIES.length, 15);
  for (const leg of LEGENDARIES) {
    const keys = changedKeys(leg, 'legendary');
    assert.ok(keys.length, `${leg.id} changes no modifier at all`);
    for (const k of keys) {
      assert.ok(MOD_CONSUMERS.has(k),
        `${leg.id} writes mods.${k}, which nothing outside src/game reads — the card prints an effect that never happens`);
    }
  }
  // and the same contract for every other card in the game
  for (const boon of [...BOONS, ...DUOS]) {
    for (const k of changedKeys(boon, 'common')) {
      assert.ok(MOD_CONSUMERS.has(k), `${boon.id} writes mods.${k}, which no consumer reads`);
    }
  }
}

// ── 8c. The Legendary payoffs, in combat, one by one ──────────────────────
// Each of these fields used to be written and never read. They are asserted
// through the damage authority rather than by inspecting `mods`, because the
// only thing that matters is whether the promise on the card resolves.
{
  const bump = (h) => { h.enemy.health = 5000; h.enemy.dead = false; h.enemy.alive = true; h.enemy.iframes = 0; };

  // vsWeakAmp — "Weak foes take 40% more damage from every source"
  {
    const h = harness();
    const plain = h.combat.applyDamage({ target: h.enemy, amount: 100, source: h.player });
    grant(h.ctx, 'legendary.broken-resolve', 'legendary');
    h.combat.applyStatus(h.enemy, 'weak', 1, h.player);
    bump(h);
    const amped = h.combat.applyDamage({ target: h.enemy, amount: 100, source: h.player });
    assert.ok(amped > plain * 1.3, 'Broken Resolve did not amplify damage against a Weak foe');
  }

  // status potency — mods.status[kind] must reach applyStatus, not just the rider
  {
    const h = harness();
    h.combat.applyStatus(h.enemy, 'shock', 2, h.player);
    assert.equal(h.combat._stack(h.enemy, 'shock'), 2);
    const h2 = harness();
    grant(h2.ctx, 'legendary.splitting-bolt', 'legendary');   // status.shock *= 1.35
    h2.combat.applyStatus(h2.enemy, 'shock', 2, h2.player);
    assert.ok(h2.combat._stack(h2.enemy, 'shock') > 2, 'a curse-potency boon never reached applyStatus');
  }

  // chainBonus — every Blitz discharge carries extra damage
  {
    const h = harness();
    h.combat.applyStatus(h.enemy, 'shock', 1, h.player);
    let before = h.enemy.health;
    h.combat._statusTick(0.7);
    const plainTick = before - h.enemy.health;
    const h2 = harness();
    grant(h2.ctx, 'legendary.splitting-bolt', 'legendary');
    h2.combat.applyStatus(h2.enemy, 'shock', 1, h2.player);
    before = h2.enemy.health;
    h2.combat._statusTick(0.7);
    assert.ok(before - h2.enemy.health > plainTick + 10, 'Splitting Bolt added nothing to a Blitz discharge');
  }

  // scorchCap — Scorch stacks past the authored ceiling
  {
    const h = harness();
    for (let i = 0; i < 12; i++) h.combat.applyStatus(h.enemy, 'burn', 1, h.player);
    assert.equal(h.combat._stack(h.enemy, 'burn'), 8, 'burn no longer caps where the data says it does');
    const h2 = harness();
    grant(h2.ctx, 'legendary.soot-sprite', 'legendary');
    for (let i = 0; i < 20; i++) h2.combat.applyStatus(h2.enemy, 'burn', 1, h2.player);
    assert.ok(h2.combat._stack(h2.enemy, 'burn') > 8, 'Soot Sprite did not raise the Scorch ceiling');
  }

  // doomEscalate — each Wither resolves harder than the last, five times
  {
    const h = harness();
    grant(h.ctx, 'legendary.vicious-cycle', 'legendary');
    const resolve = () => {
      h.enemy.health = 5000; h.enemy.dead = false; h.enemy.alive = true;
      h.combat.applyStatus(h.enemy, 'doom', 1, h.player);
      const before = h.enemy.health;
      h.combat._statusTick(1.4);
      return before - h.enemy.health;
    };
    const first = resolve(), second = resolve(), third = resolve();
    assert.ok(second > first && third > second, 'Vicious Cycle did not escalate');
  }

  // slamAmp — the wall, not the hit, is what gets stronger
  {
    const slam = (id) => {
      const h = harness();
      if (id) grant(h.ctx, id, 'legendary');
      else grant(h.ctx, 'poseidon.passive');
      h.enemy.position.set(18, 0, 0); h.enemy.health = 5000;
      const before = h.enemy.health;
      h.combat.applyDamage({ target: h.enemy, amount: 10, source: h.player, knockback: 5, dir: new THREE.Vector3(1, 0, 0) });
      return before - h.enemy.health;
    };
    assert.ok(slam('legendary.hydraulic-might') > slam(null), 'Hydraulic Might did not amplify the slam');
  }

  // hitchShare — everything wearing the curse bleeds together
  {
    const h = harness();
    const second = actor('enemy', -3, 0, 900);
    h.combat.entities.add(second); h.combat._dirty = true;
    grant(h.ctx, 'legendary.nexus-sting', 'legendary');
    h.combat.applyStatus(h.enemy, 'weak', 1, h.player);
    h.combat.applyStatus(second, 'weak', 1, h.player);
    const before = second.health;
    h.combat.applyDamage({ target: h.enemy, amount: 200, source: h.player });
    assert.ok(second.health < before, 'Nexus Sting never shared damage to a second Hitched foe');
  }

  // blastCinder — a forged Blast leaves something burning
  {
    const h = harness();
    grant(h.ctx, 'legendary.volcanic-ash', 'legendary');
    const second = actor('enemy', 3.4, 0, 900);
    h.combat.entities.add(second); h.combat._dirty = true;
    h.combat.projectileHit({
      damage: 20, type: 'fire', source: h.player, knockback: 0, poiseDamage: 0,
      hits: 0, forks: 0, skewer: 0, castTicks: 0, blastRadius: 3.0, cr: 1, cg: 0.5, cb: 0.2,
    }, h.enemy, 1, 0);
    assert.ok(h.combat._stack(second, 'burn') > 0, 'Volcanic Ash left no cinders in the blast');
  }

  // markPermanent — the mark's timer simply stops running
  {
    const h = harness();
    h.combat.runtimes = new Map();
    h.combat._cap = { on: false, t: 0, i: 0 };
    h.combat.hitboxes.update = () => {};
    h.combat.projectiles.update = () => {};
    grant(h.ctx, 'legendary.hunters-instinct', 'legendary');
    h.combat._critMark.set(h.enemy, { chance: 0.5, t: 4.0 });
    for (let i = 0; i < 12; i++) h.combat.update(0.6, h.ctx);
    assert.ok(h.combat._critMark.has(h.enemy), 'Hunter’s Instinct let a Critical mark expire');
  }
}

// ── 8d. A reroll deals from the SAME gate ─────────────────────────────────
// The live bug: run.js handed the overlay `{ upgradeChance }` alone, so the
// reroll replayed a hand with no god, no weapon and no character — 93% of
// rerolled cards came from a god the player was not standing in front of.
{
  const rng = (() => {
    let seed = 991;
    const f = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 100000) / 100000; };
    return { f, pick: list => list[Math.floor(f() * list.length) % list.length] };
  })();
  for (const god of ['zeus', 'demeter', 'hera', 'hephaestus']) {
    const bs = state();
    bs.grantRerolls(4);
    const options = { count: 3, god, weapon: 'blade', character: 'zagreus', allowDuo: true, upgradeChance: 0.58 };
    bs.beginOffer();
    let hand = bs.roll(rng, options);
    for (let i = 0; i < 4 && hand.length; i++) {
      for (const o of hand) {
        assert.equal(o.god, god, `a rerolled card came from ${o.god} at a ${god} gate`);
        assert.ok(!o.boon.weapon || o.boon.weapon === 'blade', `a rerolled card was for the ${o.boon.weapon}, not the held arm`);
      }
      const next = bs.reroll(rng, options, hand);
      if (!next) break;
      hand = next;
    }
  }
  // and the forge gate keeps its shape across a reroll
  const forge = state();
  forge.grantRerolls(1);
  const options = { count: 3, god: 'hephaestus', weapon: 'spear', character: 'zagreus', allowDuo: true, upgradeChance: 0.58 };
  const first = forge.roll(rng, options);
  assert.deepEqual(first.map(o => o.boon.forgeAction), ['attack', 'special', 'cast'],
    'the forge gate is not an attack/special/cast triplet');
  const again = forge.reroll(rng, options, first);
  assert.deepEqual(again.map(o => o.boon.forgeAction), ['attack', 'special', 'cast'],
    'a reroll lost the forge gate’s shape');
  for (const o of again) assert.equal(o.boon.weapon, 'spear', 'a rerolled forge card was for another arm');
}

// ── 8e. The run system hands the overlay the options it rolled with ───────
// The overlay stores whatever it is given and replays it on reroll, so the
// two call sites must not drift apart. This is a source-level assertion
// precisely because that drift is invisible at runtime until a player rerolls.
{
  const src = readFileSync(fileURLToPath(new URL('../src/game/run.js', import.meta.url)), 'utf8');
  const rolled = src.match(/state\?\.roll\?\.\(rng,\s*([A-Za-z_$][\w$]*)\)/);
  const shown = src.match(/showBoonChoice\?\.\(offers,\s*([A-Za-z_$][\w$]*)\)/);
  assert.ok(rolled && shown, 'run.js no longer rolls and shows through named options');
  assert.equal(shown[1], rolled[1], 'run.js shows the offer with different options than it rolled');
  const decl = src.slice(src.indexOf(`const ${rolled[1]} = {`));
  const body = decl.slice(0, decl.indexOf('};') + 1);
  for (const key of ['god', 'weapon', 'character', 'count']) {
    assert.match(body, new RegExp(`\\b${key}\\s*[:,}]`), `the gate's roll options no longer carry ${key}`);
  }
}

// ── 8f. The gate, end to end: a boss mints a Pom, the next gate spends it ─
// Poms used to be a complete API with no caller: `bs.poms` was assigned 0 in
// two places and incremented in none, and `showPomChoice` had no gameplay call
// site at all. This drives the real RunState methods against a stub context.
{
  const seen = [];
  const run = new RunState();
  const bs = new BoonState({ events });
  run.ctx = {
    boons: bs, events, combat: { weaponId: 'blade' },
    ui: {
      toast: noop,
      // the real overlay grants on choose(); the stub stands in for that
      showBoonChoice: (offers, opts) => { seen.push({ kind: 'boon', offers, opts }); bs.grant(offers[0]); return Promise.resolve(offers[0]); },
      showPomChoice: (o) => { seen.push({ kind: 'pom', offers: o.offers }); bs.applyPom(o.offers[0].id, 1); return Promise.resolve(o.offers[0]); },
    },
  };
  run.depth = 6;
  run.selectedCharacter = 'zagreus';
  run.state = 'choosing';
  run._rng = { f: () => 0.42, pick: l => l[0], fork() { return this; } };
  run._queueTransition = () => {};                    // no chamber to build here

  await run._claimBoon({ god: 'zeus', index: 0, kind: 'boon' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'boon', 'the first gate should be an ordinary audience');
  // the options the overlay is handed are the ones the hand was rolled with
  assert.equal(seen[0].opts.god, 'zeus');
  assert.equal(seen[0].opts.weapon, 'blade');
  assert.equal(seen[0].opts.character, 'zagreus');
  assert.equal(seen[0].opts.allowDuo, true, 'duos are switched off at the only live gate');

  // a boss mints both currencies
  run._rewardedBosses = new Set();
  run.meta = null; run.obols = 0; run._bossRewardQueue = [];
  run._onBossDefeated({ entity: { def: { label: 'HYDRA' }, position: { x: 0, y: 0, z: 0, clone: () => ({ x: 0, y: 0, z: 0 }) } } });
  assert.equal(bs.poms, 1, 'a regional boss minted no Pom of Power');
  assert.equal(bs.rerolls, 1, 'a regional boss minted no Fated Persuasion');

  // ...and the next gate spends the Pom instead of rolling a god's hand
  await run._claimBoon({ god: 'zeus', index: 1, kind: 'boon' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'pom', 'a banked Pom was never offered at a gate');
  assert.ok(seen[1].offers.length >= 1 && seen[1].offers[0].pom, 'the Pom gate offered ordinary boons');
  assert.equal(bs.poms, 0, 'the Pom was not spent');
  assert.ok(bs.list().some(r => (r.level || 1) > 1), 'the Pom raised nothing');

  // with the bank empty the gate is an ordinary audience again
  await run._claimBoon({ god: 'zeus', index: 2, kind: 'boon' });
  assert.equal(seen[2].kind, 'boon');
}

// ── 9. Poms of Power: the potency axis, orthogonal to rarity ──────────────
{
  const bs = state();
  const rec = bs.grant(bs.offer(BOONS.find(b => b.id === 'zeus.attack'), 'rare'));
  const base = rec.values.dmg;
  const runtime = bs.mods.rider.attack.bonus;
  assert.equal(runtime, base, 'the granted value did not reach the rider');

  const levelled = bs.applyPom('zeus.attack', 1);
  assert.equal(levelled.level, 2);
  assert.equal(levelled.rarity, 'rare', 'a Pom changed the boon’s rarity');
  assert.ok(levelled.values.dmg > base, 'a Pom did not increase potency');
  assert.equal(bs.mods.rider.attack.bonus, levelled.values.dmg, 'the Pom level never reached combat');

  // applyPom mutates the held record in place, so snapshot before stacking.
  const atTwo = levelled.values.dmg;
  const further = bs.applyPom('zeus.attack', 3);
  assert.equal(further.level, 5);
  assert.ok(further.values.dmg > atTwo, 'stacked Poms stopped mattering');
  assert.equal(bs.applyPom('nope.nothing'), null, 'a Pom applied to a boon that is not held');

  // Pom offers describe the *next* level and are routed by kind, not by luck.
  const offers = bs.pomOffers({ f: () => 0.5 }, 3);
  assert.ok(offers.length >= 1);
  for (const o of offers) {
    assert.equal(o.pom, true);
    assert.equal(o.kind, 'pom');
    assert.ok(o.level > o.fromLevel, 'a Pom offer did not advance the level');
    assert.ok(o.text && o.name, 'a Pom offer is not renderable');
  }
}

// ── 10. Rerolls: a token buys a genuinely different hand ──────────────────
{
  const bs = state();
  assert.equal(bs.canReroll(), false, 'a run began with rerolls it did not earn');
  assert.equal(bs.reroll({ f: () => 0.4, pick: l => l[0] }, { god: 'zeus' }, []), null,
    'reroll succeeded with no tokens');

  bs.grantRerolls(2);
  assert.equal(bs.rerolls, 2);
  let seed = 3;
  const rng = {
    f() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed % 100000) / 100000; },
    pick(list) { return list[Math.floor(this.f() * list.length) % list.length]; },
  };
  bs.beginOffer();
  const first = bs.roll(rng, { count: 3, god: 'zeus', allowDuo: false });
  const second = bs.reroll(rng, { count: 3, god: 'zeus', allowDuo: false }, first);
  assert.ok(second && second.length === 3, 'a reroll returned a short hand');
  assert.equal(bs.rerolls, 1, 'a reroll did not cost a token');
  const firstIds = new Set(first.map(o => o.id));
  for (const o of second) assert.ok(!firstIds.has(o.id), `reroll returned the refused card ${o.id}`);

  const third = bs.reroll(rng, { count: 3, god: 'zeus', allowDuo: false }, second);
  assert.equal(bs.rerolls, 0);
  for (const o of third) assert.ok(!firstIds.has(o.id), 'the second reroll forgot the first hand');
  assert.equal(bs.reroll(rng, { count: 3, god: 'zeus' }, third), null, 'rerolls went negative');

  // The Mirror seeds them, and a new descent restores that seed.
  const withMirror = new BoonState({ events, meta: { startingRerolls: () => 3 } });
  withMirror.seedRun();
  assert.equal(withMirror.rerolls, 3, 'Fated Persuasion did not reach the descent');
  withMirror.grantRerolls(-1);
  withMirror.clear();
  assert.equal(withMirror.rerolls, 3, 'a new descent did not restore the Mirror seed');
}

// ── 11. curses: display vocabulary over the five combat primitives ────────
{
  const engines = new Set(['burn', 'chill', 'shock', 'doom', 'weak']);
  for (const key of Object.keys(CURSES)) {
    const c = CURSES[key];
    assert.equal(c.id, key);
    assert.ok(engines.has(c.engine), `curse ${key} maps to an engine status combat cannot apply`);
    assert.ok(c.name && c.blurb && /^#[0-9a-f]{6}$/i.test(c.color), `curse ${key} is incomplete`);
  }
  // every status-bearing boon names a curse, and that curse drives the very
  // status the boon applies — this is what keeps card wording honest.
  let tagged = 0;
  for (const boon of BOONS) {
    if (!boon.status) continue;
    const curse = curseForBoon(boon);
    assert.ok(curse, `${boon.id} inflicts ${boon.status} under no named curse`);
    assert.equal(curse.engine, boon.status,
      `${boon.id} advertises ${curse.name} but applies ${boon.status}`);
    tagged++;
  }
  assert.ok(tagged > 80, `only ${tagged} boons carry a curse identity`);
  // every god that afflicts has a signature curse, and gods that do not, do not
  for (const god of GOD_KEYS) {
    const info = GOD_INFO[god];
    assert.ok(info.identity && info.identity.length > 20, `${god} has no stated identity`);
    if (info.curse) assert.ok(CURSES[info.curse], `${god} claims unknown curse ${info.curse}`);
  }
  // three gods share the `weak` primitive but must not share its name
  const names = ['hera', 'apollo', 'aphrodite'].map(g => CURSES[GOD_INFO[g].curse].name);
  assert.equal(new Set(names).size, 3, 'gods sharing a primitive collapsed into one curse name');

  // ...and the difference must survive the trip into combat. A curse that is
  // only a rename shows the same colour and does the same thing.
  const afflict = (id, slot) => {
    const h = harness();
    grant(h.ctx, id, 'epic');
    const rider = h.ctx.boons.mods.rider[slot];
    assert.ok(rider && rider.status === 'weak', `${id} is not a weak-bearing ${slot} boon`);
    h.combat.applyStatus(h.enemy, 'weak', 2, h.player, 0, slot);
    return h;
  };
  const hera = afflict('h2.hera.attack', 'attack');
  const apollo = afflict('h2.apollo.attack', 'attack');
  assert.equal(hera.combat.curseOn(hera.enemy, 'weak'), 'hitch', 'Hera’s affliction lost its name');
  assert.equal(apollo.combat.curseOn(apollo.enemy, 'weak'), 'blind', 'Apollo’s affliction lost its name');
  const colour = (h) => h.combat._status.get(h.enemy).find(r => r.kind === 'weak').color;
  assert.equal(colour(hera), CURSES.hitch.color, 'a Hitch was painted in the engine’s colour');
  assert.equal(colour(apollo), CURSES.blind.color, 'a Blind was painted in the engine’s colour');
  assert.notEqual(colour(hera), colour(apollo));
  // Hera BINDS: the step drags. Apollo DAZZLES: the blow is never seen coming.
  assert.ok(hera.combat.slowOf(hera.enemy) < 1, 'Hitch did not drag its foe');
  assert.equal(apollo.combat.slowOf(apollo.enemy), 1, 'Blind slowed a foe it never promised to slow');
  const hit = (h) => { h.enemy.health = 5000; h.enemy.iframes = 0; return h.combat.applyDamage({ target: h.enemy, amount: 100, source: h.player }); };
  assert.ok(hit(apollo) > hit(hera), 'Blind and Hitch are still the same mechanic under two names');
}

// ── 12. the loadout report the Codex renders ──────────────────────────────
{
  const bs = state();
  bs.grant(bs.offer(BOONS.find(b => b.id === 'zeus.attack'), 'epic'));
  bs.grant(bs.offer(BOONS.find(b => b.id === 'ares.cast'), 'rare'));
  bs.applyPom('ares.cast', 2);
  const list = bs.loadout();
  assert.equal(list.length, 2);
  assert.equal(list[0].slot, 'attack', 'the loadout is not ordered by ability category');
  for (const entry of list) {
    assert.ok(entry.name && entry.text && entry.color, 'a loadout entry is not renderable');
    assert.ok(TIERS.includes(entry.tier));
    const held = bs.get(entry.id);
    // the Codex must print the numbers actually in play, level included
    assert.equal(entry.text, held.boon.text(held.values),
      `${entry.id} shows authored text instead of its live values`);
  }
  assert.equal(bs.get('ares.cast').level, 3);
  assert.ok(list.find(e => e.id === 'ares.cast').text.includes(String(bs.get('ares.cast').values.dmg)));
}

// ── 13. HUD tray grouping mirrors the same slot contract ─────────────────
{
  const bs = state();
  bs.grant(bs.offer(BOONS.find(b => b.id === 'zeus.attack'), 'epic'));
  bs.grant(bs.offer(BOONS.find(b => b.id === 'ares.dash'), 'rare'));
  let tray = [];
  for (const rec of bs.list()) tray = upsertHudBoon(tray, rec, 8);
  const { abilities, extras } = hudBoonGroups(tray);
  assert.equal(abilities.length, 5, 'the tray lost an ability category');
  assert.equal(abilities.find(a => a.slot === 'attack').boon.name, 'Lightning Strike');
  assert.equal(abilities.find(a => a.slot === 'cast').boon, null, 'an empty category was not reported as empty');
  assert.equal(extras.length, 0);
  // and the row carries enough to render a tooltip without asking the engine
  const row = abilities.find(a => a.slot === 'attack').boon;
  assert.ok(row.text && row.text.length > 10, 'the tray row has no description to show');
  assert.equal(row.level, 1);
}

console.log(`boons ok: ${BOONS.length} core (${LEGENDARIES.length} legendary), ${DUOS.length} duo — rarity ladder, gating, slots, Poms, rerolls and curses verified`);

