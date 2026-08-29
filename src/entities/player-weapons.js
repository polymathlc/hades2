// Player-held Infernal Arms. These are separate hand-mounted models rather
// than part of the skinned body, so changing the combat weapon changes the
// hero's silhouette as well as their move set.

import * as THREE from 'three';
import { WEAPONS, WEAPON_IDS } from './weapons.js';

const Y = new THREE.Vector3(0, 1, 0);

function finish(mesh, name) {
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

function addMesh(parent, geometry, material, name) {
  const mesh = finish(new THREE.Mesh(geometry, material), name);
  parent.add(mesh);
  return mesh;
}

function rod(parent, a, b, radius, material, name, sides = 8) {
  const delta = b.clone().sub(a);
  const mesh = addMesh(parent, new THREE.CylinderGeometry(radius, radius, delta.length(), sides), material, name);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(Y, delta.normalize());
  return mesh;
}

function materialsFor(id, owned) {
  const p = WEAPONS[id].palette;
  const make = (color, roughness, metalness, emissive = '#000000', emissiveIntensity = 0) => {
    const material = new THREE.MeshStandardMaterial({
      color, roughness, metalness, emissive, emissiveIntensity,
    });
    owned.add(material);
    return material;
  };
  return {
    edge: make(p.core, 0.18, 0.96, p.glow, 0.18),
    body: make(p.body, 0.32, 0.82, p.glow, 0.08),
    glow: make(p.glow, 0.22, 0.80, p.glow, 0.42),
    dark: make('#21182b', 0.76, 0.24),
    wood: make(id === 'spear' ? '#533c31' : '#462946', 0.82, 0.08),
  };
}

function bladeModel(mats, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.blade';
  g.userData.design = 'leaf-xiphos';

  const shape = new THREE.Shape();
  shape.moveTo(-0.050, 0);
  shape.lineTo(-0.088, -0.25);
  shape.lineTo(-0.054, -0.50);
  shape.lineTo(0, -0.66);
  shape.lineTo(0.054, -0.50);
  shape.lineTo(0.088, -0.25);
  shape.lineTo(0.050, 0);
  shape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006, bevelSegments: 1 });
  geometries.add(bladeGeo);
  const blade = addMesh(g, bladeGeo, mats.body, 'avatar.weapon.blade.leaf');
  blade.position.set(0, -0.155, -0.0125);

  const ridgeGeo = new THREE.BoxGeometry(0.018, 0.52, 0.038);
  geometries.add(ridgeGeo);
  const ridge = addMesh(g, ridgeGeo, mats.edge, 'avatar.weapon.blade.ridge');
  ridge.position.set(0, -0.405, 0);
  ridge.rotation.z = 0.012;

  const guardGeo = new THREE.BoxGeometry(0.31, 0.038, 0.075);
  geometries.add(guardGeo);
  const guard = addMesh(g, guardGeo, mats.glow, 'avatar.weapon.blade.guard');
  guard.position.set(0, -0.145, 0);

  const gripGeo = new THREE.CylinderGeometry(0.027, 0.031, 0.17, 8);
  geometries.add(gripGeo);
  const grip = addMesh(g, gripGeo, mats.dark, 'avatar.weapon.blade.grip');
  grip.position.y = -0.048;

  const pommelGeo = new THREE.OctahedronGeometry(0.050, 0);
  geometries.add(pommelGeo);
  const pommel = addMesh(g, pommelGeo, mats.glow, 'avatar.weapon.blade.pommel');
  pommel.position.y = 0.055;
  g.rotation.z = -0.08;
  return g;
}

function spearModel(mats, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.spear';
  g.userData.design = 'dory-leaf-spear';

  const shaftGeo = new THREE.CylinderGeometry(0.021, 0.026, 1.42, 8);
  geometries.add(shaftGeo);
  const shaft = addMesh(g, shaftGeo, mats.wood, 'avatar.weapon.spear.shaft');
  shaft.position.y = -0.30;

  const collarGeo = new THREE.CylinderGeometry(0.050, 0.035, 0.12, 8);
  geometries.add(collarGeo);
  const collar = addMesh(g, collarGeo, mats.glow, 'avatar.weapon.spear.collar');
  collar.position.y = -1.02;

  const headGeo = new THREE.ConeGeometry(0.105, 0.42, 4);
  geometries.add(headGeo);
  const head = addMesh(g, headGeo, mats.edge, 'avatar.weapon.spear.head');
  head.position.y = -1.27;
  head.rotation.set(0, Math.PI / 4, Math.PI);

  const buttGeo = new THREE.ConeGeometry(0.052, 0.22, 6);
  geometries.add(buttGeo);
  const butt = addMesh(g, buttGeo, mats.body, 'avatar.weapon.spear.butt');
  butt.position.y = 0.51;

  const gripGeo = new THREE.CylinderGeometry(0.033, 0.033, 0.24, 8);
  geometries.add(gripGeo);
  const grip = addMesh(g, gripGeo, mats.dark, 'avatar.weapon.spear.grip');
  grip.position.y = -0.035;

  g.rotation.z = 0.06;
  return g;
}

function bowModel(mats, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.bow';
  g.userData.design = 'recurve-heart-bow';

  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.08, -0.66, 0),
    new THREE.Vector3(0.26, -0.48, 0),
    new THREE.Vector3(0.31, -0.24, 0),
    new THREE.Vector3(0.08, 0, 0),
    new THREE.Vector3(0.31, 0.24, 0),
    new THREE.Vector3(0.26, 0.48, 0),
    new THREE.Vector3(0.08, 0.66, 0),
  ]);
  const limbGeo = new THREE.TubeGeometry(curve, 24, 0.026, 7, false);
  geometries.add(limbGeo);
  addMesh(g, limbGeo, mats.body, 'avatar.weapon.bow.limbs');

  const top = new THREE.Vector3(0.08, 0.66, 0);
  const nock = new THREE.Vector3(-0.13, 0, 0.006);
  const bottom = new THREE.Vector3(0.08, -0.66, 0);
  const stringA = rod(g, top, nock, 0.006, mats.edge, 'avatar.weapon.bow.string.top', 6);
  const stringB = rod(g, nock, bottom, 0.006, mats.edge, 'avatar.weapon.bow.string.bottom', 6);
  geometries.add(stringA.geometry); geometries.add(stringB.geometry);

  const gripGeo = new THREE.CylinderGeometry(0.040, 0.040, 0.20, 8);
  geometries.add(gripGeo);
  const grip = addMesh(g, gripGeo, mats.dark, 'avatar.weapon.bow.grip');
  grip.position.set(0.08, 0, 0);

  const heartGeo = new THREE.OctahedronGeometry(0.046, 0);
  geometries.add(heartGeo);
  const heart = addMesh(g, heartGeo, mats.glow, 'avatar.weapon.bow.heart');
  heart.position.set(0.10, 0, 0.038);
  heart.scale.set(1.05, 1.25, 0.7);

  g.position.set(0, -0.08, 0.035);
  g.rotation.z = -0.10;
  return g;
}

function shieldModel(mats, geometries) {
  const g = new THREE.Group();
  g.name = 'avatar.weapon.shield';
  g.userData.design = 'chaos-hoplite-shield';

  const diskGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.065, 24);
  geometries.add(diskGeo);
  const disk = addMesh(g, diskGeo, mats.body, 'avatar.weapon.shield.disk');
  disk.rotation.x = Math.PI / 2;

  const rimGeo = new THREE.TorusGeometry(0.335, 0.035, 7, 28);
  geometries.add(rimGeo);
  const rim = addMesh(g, rimGeo, mats.edge, 'avatar.weapon.shield.rim');
  rim.position.z = 0.050;

  const bossGeo = new THREE.SphereGeometry(0.12, 12, 8);
  geometries.add(bossGeo);
  const boss = addMesh(g, bossGeo, mats.glow, 'avatar.weapon.shield.boss');
  boss.scale.z = 0.42;
  boss.position.z = 0.075;

  const barGeo = new THREE.BoxGeometry(0.31, 0.040, 0.028);
  geometries.add(barGeo);
  for (let i = 0; i < 3; i++) {
    const bar = addMesh(g, barGeo, i === 1 ? mats.edge : mats.dark, `avatar.weapon.shield.chaos.${i}`);
    bar.position.z = 0.126;
    bar.rotation.z = (i - 1) * Math.PI / 3;
  }

  const handleGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.28, 8);
  geometries.add(handleGeo);
  const handle = addMesh(g, handleGeo, mats.dark, 'avatar.weapon.shield.handle');
  handle.position.z = -0.075;

  g.position.set(0, -0.16, 0.06);
  g.rotation.set(-0.08, 0.16, 0.02);
  return g;
}

const BUILDERS = { blade: bladeModel, spear: spearModel, bow: bowModel, shield: shieldModel };
const HAND = { blade: 'handR', spear: 'handR', bow: 'handL', shield: 'handL' };

export const AVATAR_WEAPON_DESIGNS = Object.freeze({
  blade: 'leaf-xiphos',
  spear: 'dory-leaf-spear',
  bow: 'recurve-heart-bow',
  shield: 'chaos-hoplite-shield',
});

export function createAvatarWeapons(rig, initialId = 'blade') {
  if (!rig?.bones?.handR || !rig?.bones?.handL) throw new Error('Avatar weapons require handR and handL bones');
  const materials = new Set();
  const geometries = new Set();
  const groups = {};

  for (const id of WEAPON_IDS) {
    const mats = materialsFor(id, materials);
    const group = BUILDERS[id](mats, geometries);
    group.visible = false;
    group.userData.weaponId = id;
    group.userData.hand = HAND[id];
    rig.bones[HAND[id]].add(group);
    groups[id] = group;
  }

  const visual = {
    groups,
    currentId: null,
    equip(id) {
      const next = groups[id] ? id : 'blade';
      for (const key of WEAPON_IDS) groups[key].visible = key === next;
      visual.currentId = next;
      return groups[next];
    },
    dispose() {
      for (const group of Object.values(groups)) group.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
  visual.equip(initialId);
  return visual;
}

export default createAvatarWeapons;
