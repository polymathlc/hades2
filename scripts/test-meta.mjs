import assert from 'node:assert/strict';
import { MetaProgression, META_SAVE_KEY } from '../src/game/meta.js';
import { BoonState, BOONS } from '../src/game/boons.js';

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(key) { return this.data.has(key) ? this.data.get(key) : null; }
  setItem(key, value) { this.data.set(key, String(value)); }
}

const emitted = [];
const storage = new MemoryStorage();
const ctx = {
  events: { emit: (name, payload) => emitted.push({ name, payload }) },
  player: { maxHealth: 100, maxMana: 100, health: 100, mana: 100, critChance: 0, critMul: 2 },
  combat: { weaponId: 'blade' },
  ui: { setHealth() {}, setMana() {} },
};

const meta = new MetaProgression(ctx, storage).load();
ctx.meta = meta;
ctx.boons = new BoonState(ctx);

assert.equal(meta.nectar, 0, 'new save starts without Nectar');
assert.equal(meta.darkness, 0, 'new save starts without Darkness');
assert.equal(meta.awardNectar(5), 5, 'boss Nectar is banked');
assert.equal(meta.nectar, 5);

let result = meta.upgrade('zeus', 'boon');
assert.equal(result.ok, true);
assert.equal(result.cost, 1);
assert.equal(meta.rank('zeus', 'boon'), 1);
assert.equal(meta.nectar, 4);

result = meta.upgrade('zeus', 'passive');
assert.equal(result.ok, true);
assert.equal(result.cost, 2);
assert.equal(meta.rank('zeus', 'passive'), 1);
assert.equal(meta.nectar, 2);
assert.equal(meta.investment('zeus'), 2);
assert.equal(meta.appearanceBonus('zeus'), 0.4, 'each invested level must add divine gate favor');
assert.equal(meta.appearanceWeight('zeus'), 1.4);
assert.equal(meta.appearanceWeights().poseidon, 1);

const baseRareChance = meta.rareOrBetterChance('poseidon');
result = meta.upgrade('zeus', 'devotion');
assert.equal(result.ok, true);
assert.equal(result.cost, 2);
assert.equal(meta.rank('zeus', 'devotion'), 1);
assert.equal(meta.nectar, 0);
assert.equal(meta.investment('zeus'), 3);
assert.ok(Math.abs(meta.appearanceBonus('zeus') - 0.6) < 1e-9, 'Devotion also deepens divine gate favor');
assert.ok(meta.rareOrBetterChance('zeus') > baseRareChance, 'Devotion did not improve rarity odds');

assert.equal(meta.awardTitanBlood(4), 4, 'boss Titan Blood is banked');
result = meta.upgradeWeapon('blade', 'attack');
assert.equal(result.ok, true);
assert.equal(result.cost, 1);
result = meta.upgradeWeapon('blade', 'attack');
assert.equal(result.ok, true);
assert.equal(result.cost, 2);
assert.equal(meta.weaponRank('blade', 'attack'), 2);
assert.equal(meta.weaponMultiplier('blade', 'attack'), 1.1);
assert.equal(meta.titanBlood, 1);

assert.equal(meta.awardDarkness(10), 10, 'chamber Darkness is banked');
const beforeMirrorRarity = meta.rareOrBetterChance('poseidon');
result = meta.upgradeMirror('thickSkin');
assert.equal(result.ok, true); assert.equal(result.cost, 1);
result = meta.upgradeMirror('darkForesight');
assert.equal(result.ok, true); assert.equal(result.cost, 3);
result = meta.upgradeMirror('deepPockets');
assert.equal(result.ok, true); assert.equal(result.cost, 2);
assert.equal(meta.darkness, 4);
assert.equal(meta.mirrorRank('thickSkin'), 1);
assert.equal(meta.startingObols(), 15, 'Deep Pockets did not seed a descent');
assert.ok(meta.rareOrBetterChance('poseidon') > beforeMirrorRarity, 'Dark Foresight did not improve boon rarity');

const strike = BOONS.find(boon => boon.id === 'zeus.attack');
const offer = ctx.boons.offer(strike, 'common');
assert.equal(offer.values.dmg, 15, 'god boon mastery scales card and runtime values');
ctx.boons.grant(offer);
assert.equal(ctx.boons.mods.dmgMul, 1.02, 'permanent god passive applies to every run');
assert.equal(ctx.boons.mods.attackMul, 1.1, 'bound weapon Attack forge applies to every run');
assert.equal(ctx.boons.mods.maxHealthAdd, 5, 'Mirror Thick Skin does not reach the run modifier state');
assert.equal(ctx.boons.rider('attack').bonus, 15, 'scaled boon value reaches the hit rider');

const failed = meta.upgrade('zeus', 'passive');
assert.equal(failed.ok, false, 'upgrade refuses an unaffordable offering');
assert.equal(failed.reason, 'nectar');

const saved = JSON.parse(storage.getItem(META_SAVE_KEY));
assert.equal(saved.nectar, 0);
assert.equal(saved.titanBlood, 1);
assert.equal(saved.darkness, 4);
assert.equal(saved.gods.zeus.boon, 1);
assert.equal(saved.gods.zeus.passive, 1);
assert.equal(saved.gods.zeus.devotion, 1);
assert.equal(saved.weapons.blade.attack, 2);
assert.equal(saved.mirror.thickSkin, 1);
assert.equal(saved.mirror.darkForesight, 1);
assert.equal(saved.mirror.deepPockets, 1);

const loaded = new MetaProgression(null, storage).load();
assert.equal(loaded.nectar, 0, 'Nectar survives reload');
assert.equal(loaded.titanBlood, 1, 'Titan Blood survives reload');
assert.equal(loaded.darkness, 4, 'Darkness survives reload');
assert.equal(loaded.rank('zeus', 'boon'), 1, 'boon mastery survives reload');
assert.equal(loaded.rank('zeus', 'passive'), 1, 'legacy passive survives reload');
assert.equal(loaded.rank('zeus', 'devotion'), 1, 'Devotion survives reload');
assert.equal(loaded.weaponRank('blade', 'attack'), 2, 'weapon forge survives reload');
assert.equal(loaded.mirrorRank('thickSkin'), 1, 'Mirror talents survive reload');
assert.ok(emitted.some(event => event.name === 'nectar.awarded'));
assert.ok(emitted.some(event => event.name === 'titanBlood.awarded'));
assert.ok(emitted.some(event => event.name === 'meta.upgraded'));
assert.ok(emitted.some(event => event.name === 'weapon.metaUpgraded'));
assert.ok(emitted.some(event => event.name === 'darkness.awarded'));
assert.ok(emitted.some(event => event.name === 'mirror.upgraded'));

const legacyStorage = new MemoryStorage();
legacyStorage.setItem(META_SAVE_KEY, JSON.stringify({ version: 1, nectar: 7, gods: { zeus: { boon: 2, passive: 1 } } }));
const migrated = new MetaProgression(null, legacyStorage).load();
assert.equal(migrated.nectar, 7, 'version 1 Nectar was lost during migration');
assert.equal(migrated.rank('zeus', 'boon'), 2, 'version 1 mastery was lost during migration');
assert.equal(migrated.rank('zeus', 'devotion'), 0, 'new tracks must initialize safely for old saves');
assert.equal(migrated.weaponRank('blade', 'attack'), 0, 'old saves must receive a clean weapon forge tree');
assert.equal(migrated.darkness, 0, 'old saves must receive a safe Darkness balance');
assert.equal(migrated.mirrorRank('thickSkin'), 0, 'old saves must receive a clean Mirror tree');

console.log('meta ok: Nectar, Titan Blood, Darkness, Mirror talents, persistence, mastery, and legacies verified');
