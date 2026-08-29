import assert from 'node:assert/strict';
import { upsertHudBoon, hudBoonSlotLabel } from '../src/ui/hud-boons.js';

const rec = (id, god, slot, rarity = 'common') => ({
  boon: { id, god, slot, name: id }, god, slot, rarity,
});

let rail = [];
rail = upsertHudBoon(rail, rec('poseidon.attack', 'poseidon', 'attack', 'rare'));
rail = upsertHudBoon(rail, rec('ares.passive.one', 'ares', 'passive'));
rail = upsertHudBoon(rail, rec('ares.passive.two', 'ares', 'passive'));
rail = upsertHudBoon(rail, rec('zeus.attack', 'zeus', 'attack', 'epic'));

assert.equal(rail.filter(x => x.slot === 'attack').length, 1, 'a replaced action boon remained on the rail');
assert.equal(rail.find(x => x.slot === 'attack').id, 'zeus.attack');
assert.equal(rail.filter(x => x.god === 'ares').length, 2, 'distinct same-god passives were collapsed');
assert.equal(rail[0].slot, 'attack', 'action slots should have a stable glance order');

rail = upsertHudBoon(rail, rec('zeus.attack', 'zeus', 'attack', 'heroic'));
assert.equal(rail.length, 3, 'upgrading an owned boon duplicated it');
assert.equal(rail[0].rarity, 'heroic');

for (let i = 0; i < 10; i++) rail = upsertHudBoon(rail, rec(`passive.${i}`, 'hermes', 'passive'), 8);
assert.equal(rail.length, 8);
assert.equal(rail.filter(x => x.slot === 'attack').length, 1, 'rail trimming discarded the live action boon');
assert.equal(hudBoonSlotLabel({ slot: 'special' }), 'SPECIAL');
assert.equal(hudBoonSlotLabel({ slot: 'passive', duo: true }), 'DUO');

console.log('ui hud ok: active slots replace stale entries; passives remain distinct; rail is bounded');
