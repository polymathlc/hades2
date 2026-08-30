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

function fistsModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.fists'; g.userData.design = 'malphon-lion-gauntlets';
  const cuffG = new THREE.CylinderGeometry(0.105, 0.085, 0.30, 10); geometries.add(cuffG);
  const cuff = addMesh(g, cuffG, mats.body, 'avatar.weapon.fists.cuff'); cuff.position.y = -0.05;
  const knuckleG = new THREE.BoxGeometry(0.30, 0.13, 0.16); geometries.add(knuckleG);
  const knuckle = addMesh(g, knuckleG, mats.edge, 'avatar.weapon.fists.knuckles'); knuckle.position.set(0, -0.23, 0.07);
  for (let i = -1; i <= 1; i++) {
    const clawG = new THREE.ConeGeometry(0.035, 0.24, 5); geometries.add(clawG);
    const claw = addMesh(g, clawG, mats.glow, `avatar.weapon.fists.claw.${i + 1}`);
    claw.position.set(i * 0.085, -0.41, 0.09); claw.rotation.z = Math.PI;
  }
  g.rotation.z = -0.05; return g;
}

function railModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.rail'; g.userData.design = 'adamant-rail-cannon';
  const bodyG = new THREE.BoxGeometry(0.18, 0.72, 0.16); geometries.add(bodyG);
  const body = addMesh(g, bodyG, mats.body, 'avatar.weapon.rail.body'); body.position.y = -0.30;
  const barrelG = new THREE.CylinderGeometry(0.055, 0.072, 0.72, 10); geometries.add(barrelG);
  const barrel = addMesh(g, barrelG, mats.edge, 'avatar.weapon.rail.barrel'); barrel.position.y = -0.82;
  const muzzleG = new THREE.TorusGeometry(0.075, 0.018, 6, 16); geometries.add(muzzleG);
  const muzzle = addMesh(g, muzzleG, mats.glow, 'avatar.weapon.rail.muzzle'); muzzle.rotation.x = Math.PI / 2; muzzle.position.y = -1.19;
  const stockG = new THREE.BoxGeometry(0.13, 0.30, 0.13); geometries.add(stockG);
  const stock = addMesh(g, stockG, mats.dark, 'avatar.weapon.rail.stock'); stock.position.set(0, 0.22, -0.03); stock.rotation.z = -0.18;
  return g;
}

function staffModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.staff'; g.userData.design = 'descura-crescent-staff';
  const shaftG = new THREE.CylinderGeometry(0.024, 0.032, 1.58, 9); geometries.add(shaftG);
  const shaft = addMesh(g, shaftG, mats.dark, 'avatar.weapon.staff.shaft'); shaft.position.y = -0.35;
  const crownG = new THREE.TorusGeometry(0.17, 0.025, 7, 24, Math.PI * 1.55); geometries.add(crownG);
  const crown = addMesh(g, crownG, mats.edge, 'avatar.weapon.staff.crescent'); crown.position.y = -1.18; crown.rotation.z = 0.72;
  const gemG = new THREE.OctahedronGeometry(0.085, 0); geometries.add(gemG);
  const gem = addMesh(g, gemG, mats.glow, 'avatar.weapon.staff.moonstone'); gem.position.y = -1.18;
  return g;
}

function bladesModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.blades'; g.userData.design = 'lim-oros-sister-knives';
  for (const [i, x] of [-0.065, 0.065].entries()) {
    const bladeG = new THREE.ConeGeometry(0.065, 0.62, 4); geometries.add(bladeG);
    const blade = addMesh(g, bladeG, i ? mats.edge : mats.body, `avatar.weapon.blades.sister.${i}`);
    blade.position.set(x, -0.40, i ? -0.025 : 0.025); blade.rotation.set(0, Math.PI / 4, Math.PI + (i ? -0.08 : 0.08));
    const gripG = new THREE.CylinderGeometry(0.025, 0.03, 0.19, 8); geometries.add(gripG);
    const grip = addMesh(g, gripG, mats.dark, `avatar.weapon.blades.grip.${i}`); grip.position.set(x, 0.0, i ? -0.025 : 0.025);
  }
  return g;
}

function flamesModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.flames'; g.userData.design = 'ygnium-umbral-torches';
  const handleG = new THREE.CylinderGeometry(0.035, 0.05, 0.46, 9); geometries.add(handleG);
  const handle = addMesh(g, handleG, mats.dark, 'avatar.weapon.flames.handle'); handle.position.y = -0.08;
  for (let i = 0; i < 3; i++) {
    const ringG = new THREE.TorusGeometry(0.10 + i * 0.035, 0.016, 6, 18); geometries.add(ringG);
    const ring = addMesh(g, ringG, i === 2 ? mats.glow : mats.body, `avatar.weapon.flames.ring.${i}`);
    ring.position.y = -0.38; ring.rotation.x = Math.PI / 2 + i * 0.22;
  }
  const fireG = new THREE.OctahedronGeometry(0.10, 1); geometries.add(fireG);
  const fire = addMesh(g, fireG, mats.glow, 'avatar.weapon.flames.core'); fire.position.y = -0.48; fire.scale.set(0.8, 1.5, 0.8);
  return g;
}

function axeModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.axe'; g.userData.design = 'zorephet-moonstone-axe';
  const shaftG = new THREE.CylinderGeometry(0.032, 0.040, 1.52, 9); geometries.add(shaftG);
  const shaft = addMesh(g, shaftG, mats.dark, 'avatar.weapon.axe.shaft'); shaft.position.y = -0.36;
  const headG = new THREE.BoxGeometry(0.54, 0.18, 0.10); geometries.add(headG);
  const head = addMesh(g, headG, mats.body, 'avatar.weapon.axe.head'); head.position.set(0.16, -1.11, 0); head.rotation.z = 0.20;
  const edgeG = new THREE.ConeGeometry(0.25, 0.48, 4); geometries.add(edgeG);
  const edge = addMesh(g, edgeG, mats.edge, 'avatar.weapon.axe.moon-edge'); edge.position.set(0.39, -1.09, 0); edge.rotation.set(0, Math.PI / 4, Math.PI / 2);
  const gemG = new THREE.OctahedronGeometry(0.075, 0); geometries.add(gemG);
  const gem = addMesh(g, gemG, mats.glow, 'avatar.weapon.axe.gem'); gem.position.set(0.10, -1.11, 0.07);
  return g;
}

function skullModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.skull'; g.userData.design = 'revaal-argent-skull';
  const skullG = new THREE.DodecahedronGeometry(0.22, 1); geometries.add(skullG);
  const skull = addMesh(g, skullG, mats.body, 'avatar.weapon.skull.cranium'); skull.position.y = -0.28; skull.scale.set(1, 1.1, 0.88);
  for (const s of [-1, 1]) {
    const eyeG = new THREE.OctahedronGeometry(0.045, 0); geometries.add(eyeG);
    const eye = addMesh(g, eyeG, mats.glow, `avatar.weapon.skull.eye.${s}`); eye.position.set(s * 0.075, -0.30, 0.18);
  }
  const jawG = new THREE.BoxGeometry(0.24, 0.10, 0.17); geometries.add(jawG);
  const jaw = addMesh(g, jawG, mats.edge, 'avatar.weapon.skull.jaw'); jaw.position.set(0, -0.48, 0.02);
  return g;
}

function coatModel(mats, geometries) {
  const g = new THREE.Group(); g.name = 'avatar.weapon.coat'; g.userData.design = 'xinth-jet-gauntlet';
  const armG = new THREE.CylinderGeometry(0.12, 0.095, 0.48, 10); geometries.add(armG);
  const arm = addMesh(g, armG, mats.body, 'avatar.weapon.coat.gauntlet'); arm.position.y = -0.12;
  const plateG = new THREE.BoxGeometry(0.32, 0.34, 0.10); geometries.add(plateG);
  const plate = addMesh(g, plateG, mats.edge, 'avatar.weapon.coat.shield-plate'); plate.position.set(0, -0.18, 0.10);
  for (const s of [-1, 1]) {
    const jetG = new THREE.ConeGeometry(0.055, 0.26, 8); geometries.add(jetG);
    const jet = addMesh(g, jetG, mats.glow, `avatar.weapon.coat.jet.${s}`); jet.position.set(s * 0.10, 0.18, -0.05);
  }
  return g;
}

const BUILDERS = {
  blade: bladeModel, spear: spearModel, bow: bowModel, shield: shieldModel,
  fists: fistsModel, rail: railModel, staff: staffModel, blades: bladesModel,
  flames: flamesModel, axe: axeModel, skull: skullModel, coat: coatModel,
};
const HAND = {
  blade: 'handR', spear: 'handR', bow: 'handL', shield: 'handL', fists: 'handR', rail: 'handR',
  staff: 'handR', blades: 'handR', flames: 'handL', axe: 'handR', skull: 'handL', coat: 'handL',
};

export const AVATAR_WEAPON_DESIGNS = Object.freeze({
  blade: 'leaf-xiphos',
  spear: 'dory-leaf-spear',
  bow: 'recurve-heart-bow',
  shield: 'chaos-hoplite-shield',
  fists: 'malphon-lion-gauntlets',
  rail: 'adamant-rail-cannon',
  staff: 'descura-crescent-staff',
  blades: 'lim-oros-sister-knives',
  flames: 'ygnium-umbral-torches',
  axe: 'zorephet-moonstone-axe',
  skull: 'revaal-argent-skull',
  coat: 'xinth-jet-gauntlet',
});

export function createAvatarWeapons(rig, initialId = 'blade', allowedIds = WEAPON_IDS) {
  if (!rig?.bones?.handR || !rig?.bones?.handL) throw new Error('Avatar weapons require handR and handL bones');
  const materials = new Set();
  const geometries = new Set();
  const groups = {};

  const ids = allowedIds.filter(id => WEAPONS[id] && BUILDERS[id]);
  for (const id of ids) {
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
      const next = groups[id] ? id : (groups.blade ? 'blade' : Object.keys(groups)[0]);
      for (const key of ids) groups[key].visible = key === next;
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
