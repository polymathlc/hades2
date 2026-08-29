// The later biome bosses. Both use the shared Enemy/Brain contract, but their
// silhouettes and counterplay are deliberately unrelated to the Warden:
//   MINOTAUR  bull head + labrys; sidestep charges and punish wall crashes
//   HERACLES  lion pelt + club; evade targeted leaps and interrupt boulders

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU } from '../../core/math.js';
import { inDisc } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';

const MINOTAUR_PALETTE = {
  skin: '#75412f', skinDeep: '#2c1716', hair: '#20151a', hairTip: '#5d3428',
  cloth: '#8a311d', clothDeep: '#35100d', cape: '#3c1210', capeLine: '#ff8a3d',
  metal: '#c58d3f', metalHot: '#fff0b0', metalDeep: '#493015',
  blade: '#9da8ad', bladeEdge: '#f4ffff', leather: '#281616', glow: '#ff6b32',
};

const HERACLES_PALETTE = {
  skin: '#d39b73', skinDeep: '#70432f', hair: '#3b2316', hairTip: '#8c5f2e',
  cloth: '#9e2f2b', clothDeep: '#3f1014', cape: '#9b6426', capeLine: '#ffe28a',
  metal: '#d9ad4f', metalHot: '#fff4c2', metalDeep: '#654113',
  blade: '#aeb5b8', bladeEdge: '#ffffff', leather: '#3a2417', glow: '#ffd56a',
};

const WEAK = { physical: -0.65, fire: -0.65, lightning: -0.65, frost: -0.65, poison: -0.65, arcane: -0.65 };
const PHASE_SPEED = [1, 0.84, 0.70];

function mesh(geo, ctx, slot, tag, opts) {
  const out = new THREE.Mesh(geo, charMaterial(ctx, slot, tag, opts));
  out.castShadow = true;
  out.frustumCulled = false;
  return out;
}

function attach(a, key, boneName, factory, ctx, transform) {
  let object = a.root.userData[key];
  if (!object) {
    const bone = a.visual.rig?.bones?.[boneName];
    if (!bone) return null;
    object = factory(ctx);
    transform?.(object);
    bone.add(object);
    a.root.userData[key] = object;
  }
  object.visible = true;
  a.mem[key] = object;
  return object;
}

function buildBullHead(ctx) {
  const group = new THREE.Group();
  const skull = new THREE.SphereGeometry(0.43, 16, 12); skull.scale(0.96, 1.08, 0.92); skull.translate(0, 0.08, 0.05);
  const muzzle = new THREE.SphereGeometry(0.30, 14, 10); muzzle.scale(1.05, 0.62, 1.22); muzzle.translate(0, -0.13, 0.31);
  paintGeo(skull, '#5d3428', { y0: -0.5, y1: 0.65, aoLow: 0.46, top: '#a96243' });
  paintGeo(muzzle, '#8f5a43', { y0: -0.4, y1: 0.3, aoLow: 0.52, top: '#c28363' });
  group.add(mesh(skull, ctx, 'hair', 'minotaur'), mesh(muzzle, ctx, 'skin', 'minotaur'));

  const hornParts = [];
  for (const side of [-1, 1]) {
    const horn = new THREE.ConeGeometry(0.16, 1.12, 9);
    horn.rotateZ(side * 1.04); horn.rotateY(side * 0.20); horn.translate(side * 0.66, 0.34, -0.02); hornParts.push(horn);
    const ear = new THREE.ConeGeometry(0.15, 0.46, 5);
    ear.rotateZ(side * 1.38); ear.translate(side * 0.44, 0.06, 0.00); hornParts.push(ear);
  }
  const horns = mergeGeometries(hornParts, false);
  paintGeo(horns, '#d7c095', { y0: -0.2, y1: 1.1, aoLow: 0.58, top: '#fff5d5' });
  group.add(mesh(horns, ctx, 'metal', 'minotaurhorn'));

  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.047, 8, 6);
    eye.translate(side * 0.17, 0.12, 0.40);
    paintGeo(eye, '#fff7db', { aoLow: 1 });
    group.add(mesh(eye, ctx, 'glow', 'minotaur', { glowKey: '#ff6b32', glow: 1.1 }));
  }
  return group;
}

function buildLabrys(ctx) {
  const group = new THREE.Group();
  const haft = new THREE.CylinderGeometry(0.07, 0.09, 2.85, 9); haft.translate(0, 0.86, 0);
  paintGeo(haft, '#3a231c', { y0: -0.7, y1: 2.4, aoLow: 0.44, top: '#875334' });
  group.add(mesh(haft, ctx, 'hair', 'minotaurhaft'));

  const blades = [];
  for (const side of [-1, 1]) {
    const blade = new THREE.ConeGeometry(0.50, 1.18, 4);
    blade.rotateZ(side * Math.PI / 2); blade.rotateY(Math.PI / 4); blade.translate(side * 0.48, 2.18, 0); blades.push(blade);
  }
  const collar = new THREE.CylinderGeometry(0.18, 0.18, 0.28, 10); collar.translate(0, 2.18, 0); blades.push(collar);
  const steel = mergeGeometries(blades, false);
  paintGeo(steel, '#9da8ad', { y0: 1.4, y1: 2.8, aoLow: 0.58, top: '#f4ffff' });
  group.add(mesh(steel, ctx, 'metal', 'minotaurblade'));
  return group;
}

function buildLionPelt(ctx) {
  const group = new THREE.Group();
  // Shoulder trophy, not a full circular collar: the face must read without
  // covering Heracles' own head or turning his silhouette into a ring.
  const mane = new THREE.TorusGeometry(0.30, 0.095, 8, 24);
  const face = new THREE.SphereGeometry(0.23, 14, 10); face.scale(0.92, 0.88, 0.62); face.translate(0, 0.01, 0.13);
  const pelt = mergeGeometries([mane, face], false);
  paintGeo(pelt, '#a86a27', { y0: -0.7, y1: 0.7, aoLow: 0.48, top: '#f0b84f' });
  group.add(mesh(pelt, ctx, 'cape', 'heracleslion'));
  for (const side of [-1, 1]) {
    const ear = new THREE.ConeGeometry(0.075, 0.20, 5); ear.rotateZ(side * 0.38); ear.translate(side * 0.16, 0.21, 0.10);
    const eye = new THREE.SphereGeometry(0.026, 7, 5); eye.translate(side * 0.075, 0.05, 0.28);
    paintGeo(ear, '#c28332', { aoLow: 0.6, top: '#f6cb71' }); paintGeo(eye, '#fff6c8', { aoLow: 1 });
    group.add(mesh(ear, ctx, 'cape', 'heracleslion'), mesh(eye, ctx, 'glow', 'heracles', { glowKey: '#ffd56a', glow: 0.7 }));
  }
  return group;
}

function buildClub(ctx) {
  const group = new THREE.Group();
  const trunk = new THREE.CylinderGeometry(0.15, 0.25, 2.75, 10); trunk.translate(0, 0.98, 0);
  const knots = [];
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU;
    const knot = new THREE.SphereGeometry(0.12 + (i % 2) * 0.035, 8, 6);
    knot.translate(Math.cos(a) * 0.19, 1.68 + i * 0.19, Math.sin(a) * 0.19); knots.push(knot);
  }
  const geo = mergeGeometries([trunk, ...knots], false);
  paintGeo(geo, '#6d4023', { y0: -0.5, y1: 2.8, aoLow: 0.42, top: '#bd8242' });
  group.add(mesh(geo, ctx, 'hair', 'heraclesclub'));
  return group;
}

function phaseFor(a) {
  const f = a.health / a.maxHealth;
  return f > 0.66 ? 0 : f > 0.33 ? 1 : 2;
}
function wind(a, seconds) { return seconds * PHASE_SPEED[a.mem.phase | 0]; }

function spawnBoss(a, ctx) {
  a.mem.phase = 0;
  a.mem.pendingPhase = false;
  a.vulnerable = false;
  a.resist = null;
  ctx.events.emit('boss.spawned', { entity: a, name: a.def.label, maxHealth: a.maxHealth, phases: 3 });
  ctx.ui?.toast?.(a.def.label.toUpperCase(), { color: a.def.identity, dur: 3 });
}

function tickBoss(a, dt, ctx) {
  const phase = phaseFor(a);
  if (phase !== a.mem.phase) {
    a.mem.phase = phase;
    a.mem.pendingPhase = true;
    ctx.events.emit('boss.phase', { entity: a, phase: phase + 1, health: a.health, maxHealth: a.maxHealth });
  }
  ctx.events.emit('boss.health', { entity: a, name: a.def.label, health: a.health, maxHealth: a.maxHealth, phase: phase + 1, phases: 3 });
}

function bossDied(a, info, ctx) {
  ctx.events.emit('boss.defeated', { entity: a, pos: a.position.clone(), name: a.def.label });
  ctx.engine?.slowmo?.(0.28, 1.4);
  for (let i = 0; i < 4; i++) ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.38), {
    radius: 4 + i * 2.3, color: a.def.identity, life: 0.7 + i * 0.15,
  });
}

function bossAny(a, dt, ctx) {
  if (!ctx.player || ctx.player.alive === false) return a.stateName === 'idle' ? null : 'idle';
  if (a.mem.pendingPhase && !a.committed && a.stateName !== 'phase' && a.stateName !== 'exposed') {
    a.mem.pendingPhase = false;
    return 'phase';
  }
}

function exposedState(color, next = 'hunt') {
  return {
    enter(a, ctx) {
      a.committed = false; a.vulnerable = true; a.resist = WEAK;
      a.mem.exposeDur = 2.05 - 0.20 * a.mem.phase;
      a.play('hurt', { fade: 0.12, restart: true, speed: 0.46 });
      ctx.events.emit('boss.exposed', { entity: a, pos: a.position.clone(), dur: a.mem.exposeDur });
      ctx.vfx?.burst?.(a.position.clone().setY(a.height * 0.62), { count: 22, color: '#fff5d4', speed: 6, spread: 1.25, kind: 'ember' });
      a.mgr.telegraphs.spawn({ x: a.position.x, z: a.position.z, radius: 2.8, shape: 'ring', inner: 0.72,
        dur: a.mem.exposeDur, color: '#8ef0d0', core: '#ecffff', owner: a, follow: true, alpha: 0.82 });
    },
    update(a, dt, ctx) {
      a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
      if (a.brain.t >= a.mem.exposeDur) return 'recover';
    },
    exit(a) { a.vulnerable = false; a.resist = null; },
  };
}

function recoverState(next = 'hunt') {
  return {
    enter(a) { a.attackCd = a.mem.phase >= 2 ? 0.55 : 0.9; a.play('idle', { fade: 0.18 }); },
    update(a) { if (a.brain.t > 0.42) return next; },
  };
}

export const MINOTAUR = {
  kind: 'minotaur', label: 'Asterius, the Minotaur', title: 'Asterius, the Minotaur', phases: 3,
  role: 'BOSS — wall-crashing horn charge, labrys sweep, and arena stomp',
  identity: '#ff6b32', deathColor: '#ff6b32', tellColor: '#ff8a3d',
  hp: 1140, radius: 1.28, speed: 3.9, accel: 18, turn: 4.0,
  poise: 999, poiseMax: 290, staggerTime: 0, knockResist: 0.97, crowdPad: 0.9,
  tokenPool: 'boss', threat: 24, cost: 24, boss: true, captureState: 'sweepTell',
  deathScale: 2.8, deathShake: 0.34, deathTime: 1.55, spawnTime: 1.2,
  perception: { range: 60, reaction: 0.22, aimLambda: 4.4 },
  spec: {
    name: 'erebus.minotaur', height: 3.34,
    build: { shoulder: 1.70, limb: 1.16, bulk: 1.65 }, palette: MINOTAUR_PALETTE,
    features: { pauldron: 'both', crown: 'none', cape: false, skirt: 6, greaves: true, bracers: true, harness: true, hair: 'none', eyes: false, weapon: 'none' },
    glowIntensity: 0.78,
  },
  onSpawn(a, ctx) {
    spawnBoss(a, ctx);
    attach(a, 'minotaurHead', 'head', buildBullHead, ctx, o => { o.position.set(0, 0.10, 0.04); o.scale.setScalar(1.16); });
    attach(a, 'minotaurAxe', 'handR', buildLabrys, ctx, o => { o.position.set(0.02, -0.46, 0.08); o.rotation.set(-0.26, 0, 0.15); o.scale.setScalar(0.90); });
  },
  tick(a, dt, ctx) {
    tickBoss(a, dt, ctx);
    if (a.mem.minotaurAxe) a.mem.minotaurAxe.rotation.z = 0.15 - (a.tell.active ? a.tell.k * 0.26 : 0);
  },
  onDied: bossDied,
  brain: {
    initial: 'idle', any: bossAny,
    states: {
      idle: { enter(a) { a.play('idle', { fade: 0.18 }); }, update(a) { if (a.perc.aware) return 'hunt'; } },
      hunt: {
        enter(a) { a.committed = false; a.play('run', { fade: 0.16, speed: 0.76 + a.mem.phase * 0.12 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(3.9 + a.mem.phase * 0.55).arrive(p.aimX, p.aimZ, 4.2, 1).orbit(p.aimX, p.aimZ, 4.5, a.orbitDir, 0.38, 0.45).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 4.6 });
          if (a.attackCd > 0) return;
          const r = a.mgr.rng.f();
          if (a.mem.phase >= 1 && r < 0.30) return 'stompTell';
          if (p.dist > 5.2 || r < 0.58) return 'chargeTell';
          return 'sweepTell';
        },
      },
      sweepTell: {
        enter(a) { a.committed = true; a.play('attack2', { fade: 0.08, restart: true, speed: 0.58 }); a.snapFace(a.perc.dirX, a.perc.dirZ); a.telegraph('labrys', wind(a, 0.86), { shape: 'arc', radius: 5.5, arc: 210, follow: true, color: '#ff8a3d' }); },
        update(a, dt, ctx) { a.steer.begin(0.5); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 2.8); if (a.tell.k >= 1) return 'sweepHit'; },
      },
      sweepHit: {
        enter(a, ctx) { a.endTell(true); a.strikeCone(ctx, { range: 5.5, arc: 210, damage: 31, knock: 15, color: '#ff8a3d', width: 0.76, shake: 0.22 }); ctx.events.emit('hit.stop', { ms: 65 }); },
        update(a) { if (a.brain.t > 0.32) return 'exposed'; },
      },
      chargeTell: {
        enter(a) { a.committed = true; a.play('dash', { fade: 0.08, restart: true, speed: 0.5 }); a.snapFace(a.perc.dirX, a.perc.dirZ); a.mem.cx = a.perc.dirX; a.mem.cz = a.perc.dirZ; a.telegraph('gore', wind(a, 1.02), { shape: 'line', radius: 14.5, inner: 0.18, follow: true, color: '#ffb14d' }); },
        update(a, dt, ctx) { a.steer.begin(0.3); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 2.4); a.mem.cx = a.facing.x; a.mem.cz = a.facing.z; if (a.tell.k >= 1) return 'chargeGo'; },
      },
      chargeGo: {
        enter(a, ctx) { a.endTell(true); a.mem.hit = false; ctx.events.emit('camera.shake', { amp: 0.12, dur: 0.65, freq: 22 }); },
        update(a, dt, ctx) {
          a.steer.begin((18 + a.mem.phase * 2.2)).add(a.mem.cx, a.mem.cz, 1); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false, accel: 130 });
          a.mgr.dustAt(ctx, a.position, '#ff8a3d');
          if (!a.mem.hit && inDisc(a.position.x, a.position.z, ctx.player, 1.95)) { a.mem.hit = true; a._hitPlayer(ctx, 29, 'physical', a.mem.cx, a.mem.cz, 20); }
          const R = ctx.world?.radiusAt ? ctx.world.radiusAt(Math.atan2(a.position.z, a.position.x)) : 16;
          const wall = Math.hypot(a.position.x, a.position.z) > R - a.radius - 1.25;
          if (wall || a.brain.t > 0.92) return 'crash';
        },
      },
      crash: {
        enter(a, ctx) { a.strikeDisc(ctx, a.position.x, a.position.z, 3.1, { damage: 18, type: 'physical', knock: 12, color: '#ffb14d', shake: 0.30, kind: 'shard' }); ctx.events.emit('hit.stop', { ms: 80 }); },
        update(a) { if (a.brain.t > 0.30) return 'exposed'; },
      },
      stompTell: {
        enter(a) { a.committed = true; a.play('special', { fade: 0.08, restart: true, speed: 0.54 }); a.telegraph('stomp', wind(a, 0.96), { shape: 'ring', radius: 8.2, inner: 0.30, follow: true, color: '#ff6b32', core: '#fff0b0' }); },
        update(a, dt, ctx) { a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.tell.k >= 1) return 'stompHit'; },
      },
      stompHit: {
        enter(a, ctx) {
          a.endTell(true); ctx.vfx?.shockwave?.(a.position.clone().setY(0.04), { radius: 8.2, color: '#ff6b32', life: 0.62 });
          const p = ctx.player; if (p) { const dx = p.position.x - a.position.x, dz = p.position.z - a.position.z, d = Math.hypot(dx, dz); if (d > 2.5 && d < 8.5) a._hitPlayer(ctx, 27, 'physical', dx / (d || 1), dz / (d || 1), 15); }
        },
        update(a) { if (a.brain.t > 0.34) return 'exposed'; },
      },
      exposed: exposedState('#ff6b32'), recover: recoverState(),
      phase: {
        enter(a, ctx) { a.committed = true; a.iframes = 1.0; a.play('special', { fade: 0.1, restart: true, speed: 0.5 }); ctx.engine?.slowmo?.(0.45, 0.65); ctx.ui?.toast?.(a.mem.phase === 1 ? 'ASTERIUS BREAKS HIS CHAINS' : 'THE LABYRINTH TREMBLES', { color: '#ff8a3d' }); for (let i = 0; i < 3; i++) ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.45), { radius: 4.5 + i * 2.8, color: '#ff6b32', life: 0.55 + i * 0.18 }); },
        update(a, dt, ctx) { a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.brain.t > 1.0) { a.committed = false; return 'hunt'; } },
      },
    },
  },
};

export const HERACLES = {
  kind: 'heracles', label: 'Heracles, Champion of Olympus', title: 'Heracles, Champion of Olympus', phases: 3,
  role: 'BOSS — club combo, lion leap, and targeted boulder cast',
  identity: '#ffd56a', deathColor: '#ffd56a', tellColor: '#ffd56a',
  hp: 1020, radius: 1.12, speed: 4.5, accel: 24, turn: 6.2,
  poise: 999, poiseMax: 260, staggerTime: 0, knockResist: 0.94, crowdPad: 0.8,
  tokenPool: 'boss', threat: 28, cost: 28, boss: true, captureState: 'clubTell',
  deathScale: 2.7, deathShake: 0.34, deathTime: 1.6, spawnTime: 1.2,
  perception: { range: 60, reaction: 0.18, aimLambda: 5.5 },
  spec: {
    name: 'erebus.heracles', height: 3.08,
    build: { shoulder: 1.58, limb: 1.12, bulk: 1.48 }, palette: HERACLES_PALETTE,
    features: { pauldron: 'left', crown: 'laurel', cape: true, skirt: 6, greaves: true, bracers: true, harness: true, hair: 'swept', eyes: true, weapon: 'none' },
    glowIntensity: 0.72,
  },
  onSpawn(a, ctx) {
    spawnBoss(a, ctx);
    attach(a, 'heraclesPelt', 'chest', buildLionPelt, ctx, o => { o.position.set(-0.42, 0.25, 0.14); o.rotation.set(0, 0.16, -0.28); o.scale.setScalar(0.86); });
    attach(a, 'heraclesClub', 'handR', buildClub, ctx, o => { o.position.set(0.02, -0.42, 0.06); o.rotation.set(-0.18, 0, 0.18); o.scale.setScalar(0.92); });
  },
  tick(a, dt, ctx) {
    tickBoss(a, dt, ctx);
    if (a.mem.heraclesClub) a.mem.heraclesClub.rotation.z = 0.18 - (a.tell.active ? a.tell.k * 0.32 : 0);
  },
  onDied: bossDied,
  brain: {
    initial: 'idle', any: bossAny,
    states: {
      idle: { enter(a) { a.play('idle', { fade: 0.18 }); }, update(a) { if (a.perc.aware) return 'hunt'; } },
      hunt: {
        enter(a) { a.committed = false; a.play('run', { fade: 0.14, speed: 0.9 + a.mem.phase * 0.14 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(4.5 + a.mem.phase * 0.55).arrive(p.aimX, p.aimZ, 4.6, 0.9).orbit(p.aimX, p.aimZ, 5.2, a.orbitDir, 0.48, 0.62).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 6.5 });
          if (a.attackCd > 0) return;
          const r = a.mgr.rng.f();
          if (p.dist > 7 || r < 0.27) return 'boulderTell';
          if (a.mem.phase >= 1 && r < 0.54) return 'leapTell';
          return 'clubTell';
        },
      },
      clubTell: {
        enter(a) { a.committed = true; a.play('attack3', { fade: 0.06, restart: true, speed: 0.62 }); a.snapFace(a.perc.dirX, a.perc.dirZ); a.telegraph('club', wind(a, 0.78), { shape: 'arc', radius: 5.0, arc: 138, follow: true, color: '#ffd56a' }); },
        update(a, dt, ctx) { a.steer.begin(1.0).seek(a.perc.aimX, a.perc.aimZ, 1); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 3.5); if (a.tell.k >= 1) return 'clubHit'; },
      },
      clubHit: {
        enter(a, ctx) { a.endTell(true); a.strikeCone(ctx, { range: 5.0, arc: 138, damage: 32, knock: 17, color: '#ffd56a', width: 0.70, shake: 0.24 }); ctx.events.emit('hit.stop', { ms: 70 }); },
        update(a) { if (a.brain.t > 0.30) return 'exposed'; },
      },
      boulderTell: {
        enter(a, ctx) {
          a.committed = true; a.play('cast', { fade: 0.08, restart: true, speed: 0.52 });
          const p = ctx.player, vx = p?.velocity?.x || 0, vz = p?.velocity?.z || 0;
          a.mem.tx = a.perc.aimX + vx * 0.45; a.mem.tz = a.perc.aimZ + vz * 0.45;
          a.telegraph('boulder', wind(a, 1.0), { shape: 'disc', radius: 3.2, x: a.mem.tx, z: a.mem.tz, follow: false, color: '#f0b84f', core: '#fff1b5' });
        },
        update(a, dt, ctx) { a.steer.begin(0.2); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 3); if (a.tell.k >= 1) return 'boulderHit'; },
      },
      boulderHit: {
        enter(a, ctx) {
          a.endTell(true);
          ctx.vfx?.beam?.(a.position.clone().setY(a.height * 0.75), new THREE.Vector3(a.mem.tx, 0.35, a.mem.tz), { color: '#f0b84f', width: 0.36, life: 0.28, opacity: 0.72 });
          a.strikeDisc(ctx, a.mem.tx, a.mem.tz, 3.2, { damage: 29, type: 'physical', knock: 13, color: '#f0b84f', shake: 0.20, kind: 'shard' });
        },
        update(a) { if (a.brain.t > 0.34) return 'exposed'; },
      },
      leapTell: {
        enter(a) {
          a.committed = true; a.play('special', { fade: 0.06, restart: true, speed: 0.55 });
          const p = a.perc;
          const safe = a.mgr.safePoint(p.aimX - p.dirX * 1.7, p.aimZ - p.dirZ * 1.7, { minPlayerDist: 0, radius: a.radius });
          a.mem.tx = safe.x; a.mem.tz = safe.z;
          a.telegraph('lion leap', wind(a, 0.88), { shape: 'disc', radius: 3.5, x: safe.x, z: safe.z, follow: false, color: '#ffe28a', core: '#fff8dc' });
        },
        update(a, dt, ctx) { a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.tell.k >= 1) return 'leapHit'; },
      },
      leapHit: {
        enter(a, ctx) {
          const from = a.position.clone().setY(0.4); a.endTell(true); a.position.set(a.mem.tx, 0, a.mem.tz); ctx.world?.collide?.(a.position, a.radius);
          ctx.vfx?.beam?.(from, a.position.clone().setY(1.2), { color: '#ffe28a', width: 0.42, life: 0.22, opacity: 0.65 });
          a.strikeDisc(ctx, a.position.x, a.position.z, 3.5, { damage: 31, type: 'physical', knock: 16, color: '#ffe28a', shake: 0.28, kind: 'shard' });
        },
        update(a) { if (a.brain.t > 0.36) return 'exposed'; },
      },
      exposed: exposedState('#ffd56a'), recover: recoverState(),
      phase: {
        enter(a, ctx) { a.committed = true; a.iframes = 1.0; a.play('special', { fade: 0.1, restart: true, speed: 0.5 }); ctx.engine?.slowmo?.(0.43, 0.68); ctx.ui?.toast?.(a.mem.phase === 1 ? 'THE LION PELT BLAZES' : 'OLYMPUS CLAIMS ITS CHAMPION', { color: '#ffd56a' }); for (let i = 0; i < 3; i++) ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.48), { radius: 4.5 + i * 3.0, color: '#ffd56a', life: 0.56 + i * 0.2 }); },
        update(a, dt, ctx) { a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.brain.t > 1.02) { a.committed = false; return 'hunt'; } },
      },
    },
  },
};

export default { MINOTAUR, HERACLES };
