// The later biome bosses. Both use the shared Enemy/Brain contract, but their
// silhouettes and counterplay are deliberately unrelated to the Warden:
//   MINOTAUR  bull head + labrys; sidestep charges and punish wall crashes
//   HERACLES  lion pelt + club; evade targeted leaps and interrupt boulders

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU } from '../../core/math.js';
import { tubeGeo } from '../rig.js';
import { inDisc } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';
import * as PR from './props.js';

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

const HADES_PALETTE = {
  skin: '#c8bfd2', skinDeep: '#5a5066', hair: '#17121f', hairTip: '#51415d',
  cloth: '#35213f', clothDeep: '#100b18', cape: '#25152f', capeLine: '#8ef0d0',
  metal: '#a78648', metalHot: '#ffe8a0', metalDeep: '#3f2c19',
  blade: '#9cc8bd', bladeEdge: '#eafff8', leather: '#1c1424', glow: '#70e0b8',
};

const CHRONOS_PALETTE = {
  skin: '#d2c9b0', skinDeep: '#665f50', hair: '#191817', hairTip: '#5c5847',
  cloth: '#24231f', clothDeep: '#090a0b', cape: '#343027', capeLine: '#f0c86a',
  metal: '#c8a54d', metalHot: '#fff2ac', metalDeep: '#463916',
  blade: '#d4c990', bladeEdge: '#ffffe8', leather: '#201e18', glow: '#f0c86a',
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
  const P = MINOTAUR_PALETTE;
  const group = new THREE.Group();
  const skull = new THREE.SphereGeometry(0.43, 16, 12); skull.scale(0.96, 1.08, 0.92); skull.translate(0, 0.08, 0.05);
  const muzzle = new THREE.SphereGeometry(0.30, 14, 10); muzzle.scale(1.05, 0.62, 1.22); muzzle.translate(0, -0.13, 0.31);
  paintGeo(skull, '#5d3428', { y0: -0.5, y1: 0.65, aoLow: 0.46, top: '#a96243' });
  paintGeo(muzzle, '#8f5a43', { y0: -0.4, y1: 0.3, aoLow: 0.52, top: '#c28363' });
  group.add(mesh(skull, ctx, 'hair', 'minotaur'), mesh(muzzle, ctx, 'skin', 'minotaur'));

  // HORNS with growth rings, sweeping out, forward and up; ears as vanes; a
  // brass nose ring — the three things that say BULL from a thumbnail.
  const parts = [];
  for (const s of [-1, 1]) {
    parts.push(PR.horn({ from: [s * 0.30, 0.30, -0.02], ctrl: [s * 0.86, 0.34, -0.06], to: [s * 1.02, 0.98, 0.16], r0: 0.14, ripples: 12, n: 14 }));
    parts.push(PR.feather({ from: [s * 0.36, 0.10, -0.02], to: [s * 0.78, -0.08, -0.12], w: 0.11, bow: 0.06, n: 5 }));
  }
  parts.push(PR.xf(PR.ring({ y: 0, R: 0.10, th: 0.020, hh: 0.030, seg: 18 }), { p: [0, -0.30, 0.56], r: [Math.PI / 2, 0, 0] }));
  const horns = PR.tint(PR.merge(parts), (x, y, z) => (z > 0.5 ? P.metal : (y > 0.7 ? '#fff5d5' : (Math.abs(x) > 0.6 ? '#d7c095' : '#7a5a44'))),
    { y0: -0.2, y1: 1.1, aoLow: 0.58 });
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
  // THE LABRYS: two bevelled crescent blades on a chamfered langet collar, a
  // top spike, and a wrapped haft with iron ferrules.
  const P = MINOTAUR_PALETTE;
  const group = new THREE.Group();
  const haft = PR.merge([
    PR.tint(PR.shaft({ y0: -0.56, y1: 2.52, r0: 0.092, r1: 0.070, radial: 9 }), '#3a231c', { y0: -0.7, y1: 2.4, aoLow: 0.44 }),
    PR.tint(PR.grip({ y0: -0.12, y1: 0.52, r: 0.102 }), PR.wrapped('#281616', '#140a0a', 9)),
  ]);
  group.add(mesh(haft, ctx, 'hair', 'minotaurhaft'));
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push(PR.tint(PR.xf(PR.axeHead({ R: 0.64, span: 1.80, depth: 0.080, rIn: 0.17, side }), { p: [0, 2.18, 0] }),
      (x, y) => (Math.hypot(x, y - 2.18) > 0.56 ? P.bladeEdge : P.blade), { y0: 1.5, y1: 2.8, aoLow: 0.6 }));
  }
  parts.push(PR.tint(PR.ring({ y: 2.18, R: 0.17, th: 0.022, hh: 0.32, seg: 14 }), PR.chamfered(P.metalHot, P.metal, P.metalDeep)));
  parts.push(PR.tint(PR.ring({ y: 1.94, R: 0.11, th: 0.012, hh: 0.05, seg: 12 }), P.metalDeep));
  parts.push(PR.tint(PR.blade({ len: 0.42, w: 0.055, th: 0.055, profile: 'straight', base: [0, 2.42, 0], stations: 5, radial: 8 }), P.metalHot));
  group.add(mesh(PR.merge(parts), ctx, 'metal', 'minotaurblade'));
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
  // olive-wood: a bark-ridged trunk with a swollen head and a ring of knots
  const group = new THREE.Group();
  const trunk = tubeGeo([
    { p: [0, -0.40, 0], r: 0.13 }, { p: [0, 0.60, 0], r: 0.15 }, { p: [0, 1.50, 0], r: 0.20 },
    { p: [0, 2.10, 0], r: 0.27 }, { p: [0, 2.36, 0], r: 0.24 },
  ], { radial: 12, capStart: 'round', capEnd: 'round', shape: (th) => 1 + 0.05 * Math.cos(th * 7) });
  const knots = [];
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU;
    knots.push(PR.gem(0.10 + (i % 2) * 0.03, [Math.cos(a) * 0.24, 1.66 + i * 0.13, Math.sin(a) * 0.24]));
  }
  const geo = PR.tint(PR.merge([trunk, ...knots]), (x, y, z) => (Math.hypot(x, z) > 0.23 ? '#bd8242' : '#6d4023'), { y0: -0.5, y1: 2.8, aoLow: 0.42 });
  group.add(mesh(geo, ctx, 'hair', 'heraclesclub'));
  return group;
}

function buildBident(ctx) {
  // THE BIDENT: two outward-bowed diamond-section tines off a chamfered
  // collar, a crossbar, a wrapped grip and a sauroter foot.
  const P = HADES_PALETTE;
  const group = new THREE.Group();
  const shaft = PR.merge([
    PR.tint(PR.shaft({ y0: -0.92, y1: 2.40, r0: 0.070, r1: 0.058, radial: 9 }), '#20162a', { y0: -0.9, y1: 2.6, aoLow: 0.40 }),
    PR.tint(PR.grip({ y0: -0.16, y1: 0.46, r: 0.078 }), PR.wrapped('#1c1424', '#0b0810', 9)),
  ]);
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push(PR.tint(PR.blade({ len: 1.02, w: 0.058, th: 0.024, profile: 'straight', base: [side * 0.19, 2.40, 0], dir: [side * 0.10, 1, 0], across: [1, 0, 0], curve: side * 0.09, stations: 9 }),
      PR.edged(P.blade, P.bladeEdge)));
  }
  parts.push(PR.tint(PR.crossguard({ y: 2.36, w: 0.56, r: 0.032, curl: -0.02 }), PR.chamfered(P.metalHot, P.metal, P.metalDeep)));
  parts.push(PR.tint(PR.ring({ y: 2.28, R: 0.085, th: 0.014, hh: 0.10, seg: 14 }), PR.chamfered(P.metalHot, P.metal, P.metalDeep)));
  parts.push(PR.tint(PR.gem(0.075, [0, 2.50, 0], [1, 1.5, 1]), P.metalHot));
  parts.push(PR.tint(PR.blade({ len: 0.30, w: 0.05, th: 0.05, profile: 'straight', base: [0, -0.90, 0], dir: [0, -1, 0], stations: 5, radial: 8 }), P.metalDeep));
  group.add(mesh(shaft, ctx, 'hair', 'hadesbident'), mesh(PR.merge(parts), ctx, 'metal', 'hadesbident'));
  return group;
}

function buildHadesCrown(ctx) {
  const P = HADES_PALETTE;
  const parts = [PR.ring({ y: 0, R: 0.33, th: 0.020, hh: 0.075, seg: 30 })];
  for (const side of [-1, 1]) {
    parts.push(PR.horn({ from: [side * 0.24, 0.05, -0.04], ctrl: [side * 0.50, 0.40, -0.10], to: [side * 0.42, 0.78, -0.02], r0: 0.070, ripples: 9, n: 11 }));
  }
  for (let i = 0; i < 5; i++) {
    const a = (-0.5 + i / 4) * 1.4;
    parts.push(PR.gem(0.040 + 0.014 * Math.cos(a), [Math.sin(a) * 0.30, 0.10 + 0.05 * Math.cos(a), Math.cos(a) * 0.30], [1, 2.4, 1]));
  }
  const geo = PR.tint(PR.merge(parts), (x, y) => (y > 0.55 ? P.metalHot : (y < 0.04 ? P.metalDeep : P.metal)), { y0: -0.3, y1: 0.9, aoLow: 0.58 });
  return mesh(geo, ctx, 'metal', 'hadescrown');
}

function buildChronosScythe(ctx) {
  // THE SCYTHE: a long curved scimitar-section blade off a chamfered tang
  // collar, on a snath with two grip wraps and an iron foot.
  const P = CHRONOS_PALETTE;
  const group = new THREE.Group();
  const shaft = PR.merge([
    PR.tint(PR.shaft({ y0: -1.05, y1: 2.46, r0: 0.062, r1: 0.056, radial: 9 }), '#27231a', { y0: -1.0, y1: 2.7, aoLow: 0.42 }),
    PR.tint(PR.grip({ y0: -0.18, y1: 0.36, r: 0.070 }), PR.wrapped('#201e18', '#0c0b08', 8)),
    PR.tint(PR.grip({ y0: 1.10, y1: 1.44, r: 0.070 }), PR.wrapped('#201e18', '#0c0b08', 6)),
  ]);
  const parts = [
    PR.tint(PR.blade({ len: 1.85, w: 0.150, th: 0.026, profile: 'scimitar', base: [0.06, 2.44, 0], dir: [1, -0.08, 0], across: [0, 1, 0], curve: -0.30, stations: 12, radial: 10 }),
      PR.edged(P.blade, P.bladeEdge), { y0: 1.6, y1: 3.4, aoLow: 0.62 }),
    PR.tint(PR.ring({ y: 2.38, R: 0.086, th: 0.014, hh: 0.14, seg: 14 }), PR.chamfered(P.metalHot, P.metal, P.metalDeep)),
    PR.tint(PR.ring({ y: -1.00, R: 0.060, th: 0.010, hh: 0.06, seg: 12 }), P.metalDeep),
    PR.tint(PR.gem(0.062, [0, 2.56, 0], [1, 1.5, 1]), P.metalHot),
  ];
  group.add(mesh(shaft, ctx, 'hair', 'chronosscythe'), mesh(PR.merge(parts), ctx, 'metal', 'chronosscythe'));
  return group;
}

function buildChronosHalo(ctx) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.TorusGeometry(0.34 + i * 0.13, 0.026 + i * 0.006, 7, 28);
    ring.rotateX(i === 1 ? Math.PI / 2 : 0); ring.rotateY(i === 2 ? Math.PI / 2 : 0); parts.push(ring);
  }
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU;
    const tick = new THREE.BoxGeometry(0.035, 0.18, 0.045); tick.rotateZ(-a); tick.translate(Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0); parts.push(tick);
  }
  const geo = mergeGeometries(parts, false);
  paintGeo(geo, '#c8a54d', { y0: -0.8, y1: 0.8, aoLow: 0.62, top: '#fff2ac' });
  return mesh(geo, ctx, 'glow', 'chronoshalo', { glowKey: '#f0c86a', glow: 0.9 });
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
  // A short impact beat reads as intentional; the former 1.4 seconds at 28%
  // speed looked indistinguishable from a browser freeze on slower machines.
  ctx.engine?.slowmo?.(0.52, 0.62);
  for (let i = 0; i < 2; i++) ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.42), {
    radius: 4.5 + i * 4.2, color: a.def.identity, life: 0.62 + i * 0.16, density: 0.46,
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
    features: { pauldron: 'both', crown: 'none', cape: false, skirt: 6, greaves: true, bracers: true, harness: true, hair: 'none', eyes: false, weapon: 'none', spikes: true, armlet: 'none' },
    gait: { idle: 'idleBrace', run: 'runHeavy' },
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
    features: { pauldron: 'left', crown: 'laurel', cape: true, skirt: 6, greaves: true, bracers: true, harness: true, hair: 'swept', eyes: true, weapon: 'none', armlet: 'right' },
    gait: { idle: 'idleBrace', run: 'runHeavy' },
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

function makeFinalBossBrain() {
  return {
    initial: 'idle', any: bossAny,
    states: {
      idle: { enter(a) { a.play('idle', { fade: 0.18 }); }, update(a) { if (a.perc.aware) return 'hunt'; } },
      hunt: {
        enter(a) { a.committed = false; a.play('run', { fade: 0.14, speed: 0.82 + a.mem.phase * 0.12 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed + a.mem.phase * 0.45).arrive(p.aimX, p.aimZ, 5.0, 0.85)
            .orbit(p.aimX, p.aimZ, 5.8, a.orbitDir, 0.52, 0.62).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: a.def.turn });
          if (a.attackCd > 0) return;
          const r = a.mgr.rng.f();
          if (a.mem.phase >= 1 && r < 0.28) return 'warpTell';
          if (p.dist > 6.2 || r < 0.58) return 'castTell';
          return 'sweepTell';
        },
      },
      sweepTell: {
        enter(a) {
          a.committed = true; a.play('attack3', { fade: 0.06, restart: true, speed: 0.58 });
          a.snapFace(a.perc.dirX, a.perc.dirZ);
          a.telegraph(a.def.kind === 'chronos' ? 'time cleave' : 'bident sweep', wind(a, 0.84),
            { shape: 'arc', radius: 5.8, arc: 190, follow: true, color: a.def.identity });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.6); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 3.2); if (a.tell.k >= 1) return 'sweepHit';
        },
      },
      sweepHit: {
        enter(a, ctx) {
          a.endTell(true); a.strikeCone(ctx, { range: 5.8, arc: 190, damage: 34 + a.mem.phase * 3,
            type: a.def.finalType, knock: 18, color: a.def.identity, width: 0.78, shake: 0.25 });
          ctx.events.emit('hit.stop', { ms: 72 });
        },
        update(a) { if (a.brain.t > 0.32) return 'exposed'; },
      },
      castTell: {
        enter(a, ctx) {
          a.committed = true; a.play('cast', { fade: 0.08, restart: true, speed: 0.50 });
          const p = ctx.player, lead = a.def.kind === 'chronos' ? 0.62 : 0.40;
          a.mem.tx = a.perc.aimX + (p?.velocity?.x || 0) * lead;
          a.mem.tz = a.perc.aimZ + (p?.velocity?.z || 0) * lead;
          a.telegraph(a.def.kind === 'chronos' ? 'time fracture' : 'soul eruption', wind(a, 1.02),
            { shape: 'disc', radius: 3.3, x: a.mem.tx, z: a.mem.tz, follow: false, color: a.def.identity, core: '#fff3c0' });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.15); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 3); if (a.tell.k >= 1) return 'castHit';
        },
      },
      castHit: {
        enter(a, ctx) {
          a.endTell(true);
          ctx.vfx?.beam?.(a.position.clone().setY(a.height * 0.72), new THREE.Vector3(a.mem.tx, 0.28, a.mem.tz),
            { color: a.def.identity, width: 0.38, life: 0.30, opacity: 0.78 });
          a.strikeDisc(ctx, a.mem.tx, a.mem.tz, 3.3, { damage: 30 + a.mem.phase * 3, type: 'arcane',
            knock: 14, color: a.def.identity, shake: 0.22, kind: a.def.kind === 'chronos' ? 'shard' : 'ember' });
        },
        update(a) { if (a.brain.t > 0.36) return 'exposed'; },
      },
      warpTell: {
        enter(a, ctx) {
          a.committed = true; a.play('special', { fade: 0.06, restart: true, speed: 0.52 });
          const p = ctx.player, dx = a.perc.dirX, dz = a.perc.dirZ, side = a.orbitDir || 1;
          const safe = a.mgr.safePoint((p?.position.x || 0) - dx * 2.1 - dz * side * 1.2,
            (p?.position.z || 0) - dz * 2.1 + dx * side * 1.2, { minPlayerDist: 1.8, radius: a.radius });
          a.mem.tx = safe.x; a.mem.tz = safe.z;
          a.telegraph(a.def.kind === 'chronos' ? 'time step' : 'shadow gate', wind(a, 0.78),
            { shape: 'disc', radius: 3.7, x: safe.x, z: safe.z, follow: false, color: a.def.identity, core: '#fff3c0' });
        },
        update(a, dt, ctx) {
          a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.tell.k >= 1) return 'warpHit';
        },
      },
      warpHit: {
        enter(a, ctx) {
          const from = a.position.clone().setY(1.2); a.endTell(true); a.position.set(a.mem.tx, 0, a.mem.tz);
          ctx.world?.collide?.(a.position, a.radius);
          const p = ctx.player?.position; if (p) a.snapFace(p.x - a.position.x, p.z - a.position.z);
          ctx.vfx?.beam?.(from, a.position.clone().setY(1.2), { color: a.def.identity, width: 0.48, life: 0.28, opacity: 0.76 });
          a.strikeDisc(ctx, a.position.x, a.position.z, 3.7, { damage: 32 + a.mem.phase * 3, type: a.def.finalType,
            knock: 17, color: a.def.identity, shake: 0.28, kind: 'shard' });
        },
        update(a) { if (a.brain.t > 0.38) return 'exposed'; },
      },
      exposed: exposedState('#fff3c0'), recover: recoverState(),
      phase: {
        enter(a, ctx) {
          a.committed = true; a.iframes = 1.05; a.play('special', { fade: 0.1, restart: true, speed: 0.48 });
          ctx.engine?.slowmo?.(0.42, 0.72);
          ctx.ui?.toast?.(a.def.phaseLines?.[Math.max(0, a.mem.phase - 1)] || a.def.label.toUpperCase(), { color: a.def.identity });
          for (let i = 0; i < 4; i++) ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.42),
            { radius: 4.2 + i * 2.7, color: a.def.identity, life: 0.56 + i * 0.17 });
        },
        update(a, dt, ctx) {
          a.steer.begin(0); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t > 1.05) { a.committed = false; return 'hunt'; }
        },
      },
    },
  };
}

export const HADES = {
  kind: 'hades', label: 'Hades, God of the Dead', title: 'Hades, God of the Dead', phases: 3,
  role: 'FINAL BOSS — bident sweeps, soul eruptions, and shadow gates',
  identity: '#70e0b8', deathColor: '#70e0b8', tellColor: '#70e0b8', finalType: 'physical',
  hp: 1480, radius: 1.14, speed: 4.25, accel: 22, turn: 5.8,
  poise: 999, poiseMax: 330, staggerTime: 0, knockResist: 0.97, crowdPad: 0.9,
  tokenPool: 'boss', threat: 32, cost: 32, boss: true, captureState: 'sweepTell',
  deathScale: 2.9, deathShake: 0.38, deathTime: 1.7, spawnTime: 1.3,
  phaseLines: ['THE DEAD ANSWER THEIR KING', 'THERE IS NO ESCAPE'],
  perception: { range: 64, reaction: 0.16, aimLambda: 5.4 },
  spec: {
    name: 'erebus.hades', height: 3.18,
    build: { shoulder: 1.62, limb: 1.14, bulk: 1.52 }, palette: HADES_PALETTE,
    features: { pauldron: 'both', crown: 'none', cape: true, skirt: 10, greaves: true, bracers: true, harness: true, hair: 'swept', eyes: true, weapon: 'none', robe: true, armlet: 'none' },
    gait: { idle: 'idleBrace' },
    glowIntensity: 0.82,
  },
  onSpawn(a, ctx) {
    spawnBoss(a, ctx);
    attach(a, 'hadesCrown', 'head', buildHadesCrown, ctx, o => { o.position.set(0, 0.20, 0); o.scale.setScalar(1.05); });
    attach(a, 'hadesBident', 'handR', buildBident, ctx, o => { o.position.set(0.02, -0.48, 0.08); o.rotation.set(-0.18, 0, 0.14); o.scale.setScalar(0.92); });
  },
  tick(a, dt, ctx) {
    tickBoss(a, dt, ctx);
    if (a.mem.hadesBident) a.mem.hadesBident.rotation.z = 0.14 - (a.tell.active ? a.tell.k * 0.28 : 0);
  },
  onDied: bossDied,
  brain: makeFinalBossBrain(),
};

export const CHRONOS = {
  kind: 'chronos', label: 'Chronos, Titan of Time', title: 'Chronos, Titan of Time', phases: 3,
  role: 'FINAL BOSS — scythe cleaves, time fractures, and temporal steps',
  identity: '#f0c86a', deathColor: '#f0c86a', tellColor: '#f0c86a', finalType: 'arcane',
  hp: 1580, radius: 1.16, speed: 4.45, accel: 23, turn: 6.1,
  poise: 999, poiseMax: 350, staggerTime: 0, knockResist: 0.98, crowdPad: 0.9,
  tokenPool: 'boss', threat: 34, cost: 34, boss: true, captureState: 'castTell',
  deathScale: 3.0, deathShake: 0.40, deathTime: 1.75, spawnTime: 1.35,
  phaseLines: ['THE HOUR IS MINE', 'TIME DEVOURS ALL'],
  perception: { range: 66, reaction: 0.14, aimLambda: 5.8 },
  spec: {
    name: 'erebus.chronos', height: 3.24,
    build: { shoulder: 1.56, limb: 1.15, bulk: 1.44 }, palette: CHRONOS_PALETTE,
    features: { pauldron: 'both', crown: 'none', cape: true, skirt: 12, greaves: true, bracers: false, harness: true, hair: 'none', eyes: true, weapon: 'none', hood: 'deep', robe: true, sleeves: true, armlet: 'none' },
    gait: { idle: 'idleCaster' },
    glowIntensity: 0.90,
  },
  onSpawn(a, ctx) {
    spawnBoss(a, ctx);
    attach(a, 'chronosHalo', 'head', buildChronosHalo, ctx, o => { o.position.set(0, 0.18, -0.06); o.scale.setScalar(1.08); });
    attach(a, 'chronosScythe', 'handR', buildChronosScythe, ctx, o => { o.position.set(0.02, -0.52, 0.08); o.rotation.set(-0.20, 0, 0.12); o.scale.setScalar(0.92); });
  },
  tick(a, dt, ctx) {
    tickBoss(a, dt, ctx);
    if (a.mem.chronosHalo) a.mem.chronosHalo.rotation.z += dt * (0.8 + a.mem.phase * 0.7);
    if (a.mem.chronosScythe) a.mem.chronosScythe.rotation.z = 0.12 - (a.tell.active ? a.tell.k * 0.30 : 0);
  },
  onDied: bossDied,
  brain: makeFinalBossBrain(),
};

export default { MINOTAUR, HERACLES, HADES, CHRONOS };
