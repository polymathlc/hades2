import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HERO_SPEC } from '../src/entities/rig.js';
import { AVATAR_WEAPON_DESIGNS, createAvatarWeapons } from '../src/entities/player-weapons.js';

assert.equal(HERO_SPEC.features.weapon, 'none', 'the hero body must not contain a permanently baked sword');

const rig = { bones: { handR: new THREE.Bone(), handL: new THREE.Bone() } };
rig.bones.handR.name = 'handR';
rig.bones.handL.name = 'handL';
const visual = createAvatarWeapons(rig, 'blade');

assert.deepEqual(Object.keys(visual.groups).sort(), ['blade', 'bow', 'shield', 'spear']);
assert.equal(new Set(Object.values(AVATAR_WEAPON_DESIGNS)).size, 4, 'each arm needs a distinct authored design');
assert.equal(visual.groups.blade.parent, rig.bones.handR);
assert.equal(visual.groups.spear.parent, rig.bones.handR);
assert.equal(visual.groups.bow.parent, rig.bones.handL);
assert.equal(visual.groups.shield.parent, rig.bones.handL);

const expectedParts = {
  blade: ['avatar.weapon.blade.leaf', 'avatar.weapon.blade.guard', 'avatar.weapon.blade.pommel'],
  spear: ['avatar.weapon.spear.shaft', 'avatar.weapon.spear.head', 'avatar.weapon.spear.butt'],
  bow: ['avatar.weapon.bow.limbs', 'avatar.weapon.bow.string.top', 'avatar.weapon.bow.heart'],
  shield: ['avatar.weapon.shield.disk', 'avatar.weapon.shield.rim', 'avatar.weapon.shield.boss'],
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

visual.dispose();
assert.equal(rig.bones.handR.children.length, 0);
assert.equal(rig.bones.handL.children.length, 0);

console.log('player weapon visuals ok: Blade, Spear, Bow, and Shield use distinct hand-mounted models');
