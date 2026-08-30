import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HERO_SPEC, MELINOE_SPEC } from '../src/entities/rig.js';
import { AVATAR_WEAPON_DESIGNS, createAvatarWeapons } from '../src/entities/player-weapons.js';
import { WEAPON_IDS } from '../src/entities/weapons.js';
import { CHARACTER_INFO, characterOwnsWeapon } from '../src/game/characters.js';

assert.equal(HERO_SPEC.features.weapon, 'none', 'the hero body must not contain a permanently baked sword');
assert.equal(MELINOE_SPEC.features.weapon, 'none', 'Melinoe must use hand-mounted Nocturnal Arms');
assert.equal(MELINOE_SPEC.features.crown, 'moon');
assert.equal(MELINOE_SPEC.features.witchArm, 'left');

const rig = { bones: { handR: new THREE.Bone(), handL: new THREE.Bone() } };
rig.bones.handR.name = 'handR';
rig.bones.handL.name = 'handL';
const visual = createAvatarWeapons(rig, 'blade');

assert.deepEqual(Object.keys(visual.groups).sort(), WEAPON_IDS.slice().sort());
assert.equal(new Set(Object.values(AVATAR_WEAPON_DESIGNS)).size, WEAPON_IDS.length, 'each arm needs a distinct authored design');
assert.equal(CHARACTER_INFO.zagreus.weapons.length, 6);
assert.equal(CHARACTER_INFO.melinoe.weapons.length, 6);
assert.equal(new Set([...CHARACTER_INFO.zagreus.weapons, ...CHARACTER_INFO.melinoe.weapons]).size, 12);
assert.ok(characterOwnsWeapon('zagreus', 'rail') && !characterOwnsWeapon('zagreus', 'staff'));
assert.ok(characterOwnsWeapon('melinoe', 'staff') && !characterOwnsWeapon('melinoe', 'blade'));
assert.equal(visual.groups.blade.parent, rig.bones.handR);
assert.equal(visual.groups.spear.parent, rig.bones.handR);
assert.equal(visual.groups.bow.parent, rig.bones.handL);
assert.equal(visual.groups.shield.parent, rig.bones.handL);

const expectedParts = {
  blade: ['avatar.weapon.blade.leaf', 'avatar.weapon.blade.guard', 'avatar.weapon.blade.pommel'],
  spear: ['avatar.weapon.spear.shaft', 'avatar.weapon.spear.head', 'avatar.weapon.spear.butt'],
  bow: ['avatar.weapon.bow.limbs', 'avatar.weapon.bow.string.top', 'avatar.weapon.bow.heart'],
  shield: ['avatar.weapon.shield.disk', 'avatar.weapon.shield.rim', 'avatar.weapon.shield.boss'],
  fists: ['avatar.weapon.fists.cuff', 'avatar.weapon.fists.knuckles', 'avatar.weapon.fists.claw.1'],
  rail: ['avatar.weapon.rail.body', 'avatar.weapon.rail.barrel', 'avatar.weapon.rail.muzzle'],
  staff: ['avatar.weapon.staff.shaft', 'avatar.weapon.staff.crescent', 'avatar.weapon.staff.moonstone'],
  blades: ['avatar.weapon.blades.sister.0', 'avatar.weapon.blades.sister.1'],
  flames: ['avatar.weapon.flames.handle', 'avatar.weapon.flames.core'],
  axe: ['avatar.weapon.axe.shaft', 'avatar.weapon.axe.head', 'avatar.weapon.axe.moon-edge'],
  skull: ['avatar.weapon.skull.cranium', 'avatar.weapon.skull.jaw'],
  coat: ['avatar.weapon.coat.gauntlet', 'avatar.weapon.coat.shield-plate', 'avatar.weapon.coat.jet.1'],
};

for (const id of Object.keys(visual.groups)) {
  visual.equip(id);
  assert.equal(visual.currentId, id);
  for (const [other, group] of Object.entries(visual.groups)) {
    assert.equal(group.visible, other === id, `only ${id} should be visible`);
  }
  for (const name of expectedParts[id]) {
    assert.ok(visual.groups[id].getObjectByName(name), `${id} is missing ${name}`);
  }
}

visual.equip('not-a-weapon');
assert.equal(visual.currentId, 'blade', 'invalid ids safely fall back to Blade');

const spans = {};
for (const [id, group] of Object.entries(visual.groups)) {
  for (const other of Object.values(visual.groups)) other.visible = other === group;
  group.updateWorldMatrix(true, true);
  spans[id] = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
}
assert.ok(spans.blade.y > 0.75 && spans.blade.x < 0.4, 'Blade should read as a short leaf sword');
assert.ok(spans.spear.y > 1.7 && spans.spear.x < 0.35, 'Spear should be the longest, narrowest arm');
assert.ok(spans.bow.y > 1.2 && spans.bow.x > 0.25, 'Bow should have tall recurved limbs');
assert.ok(spans.shield.x > 0.65 && spans.shield.y > 0.65, 'Shield should read as a broad round hoplon');
assert.ok(spans.staff.y > 1.6, 'Staff should read as a long crescent polearm');
assert.ok(spans.axe.x > 0.5 && spans.axe.y > 1.5, 'Axe needs a broad heavy silhouette');
assert.ok(spans.skull.x > 0.3 && spans.skull.y > 0.3, 'Argent Skull needs a compact thrown-shell silhouette');

visual.dispose();
assert.equal(rig.bones.handR.children.length, 0);
assert.equal(rig.bones.handL.children.length, 0);

console.log('player weapon visuals ok: six Infernal and six Nocturnal Arms use distinct hand-mounted models');
