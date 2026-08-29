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
  ui: { setHealth() {}, setMana() {} },
};

const meta = new MetaProgression(ctx, storage).load();
ctx.meta = meta;
ctx.boons = new BoonState(ctx);

assert.equal(meta.nectar, 0, 'new save starts without Nectar');
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

const strike = BOONS.find(boon => boon.id === 'zeus.attack');
const offer = ctx.boons.offer(strike, 'common');
assert.equal(offer.values.dmg, 15, 'god boon mastery scales card and runtime values');
ctx.boons.grant(offer);
assert.equal(ctx.boons.mods.dmgMul, 1.02, 'permanent god passive applies to every run');
assert.equal(ctx.boons.rider('attack').bonus, 15, 'scaled boon value reaches the hit rider');

const failed = meta.upgrade('zeus', 'passive');
assert.equal(failed.ok, false, 'upgrade refuses an unaffordable offering');
assert.equal(failed.reason, 'nectar');

const saved = JSON.parse(storage.getItem(META_SAVE_KEY));
assert.equal(saved.nectar, 2);
assert.equal(saved.gods.zeus.boon, 1);
assert.equal(saved.gods.zeus.passive, 1);

const loaded = new MetaProgression(null, storage).load();
assert.equal(loaded.nectar, 2, 'Nectar survives reload');
assert.equal(loaded.rank('zeus', 'boon'), 1, 'boon mastery survives reload');
assert.equal(loaded.rank('zeus', 'passive'), 1, 'legacy passive survives reload');
assert.ok(emitted.some(event => event.name === 'nectar.awarded'));
assert.ok(emitted.some(event => event.name === 'meta.upgraded'));

console.log('meta ok: Nectar persistence, god boon mastery, and legacy passives verified');
