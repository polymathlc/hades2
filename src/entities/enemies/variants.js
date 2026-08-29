// Three specialist families that broaden encounter composition:
//   LANCER  commits to a long, narrow charge lane
//   SIREN   marks a destination, blinks, then performs a short flank strike
//   ORACLE  heals and briefly wards nearby enemies while pulsing the arena

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAU } from '../../core/math.js';
import { inDisc } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';

const LANCER_PALETTE = {
  skin: '#d7d0e8', skinDeep: '#716987', hair: '#17253b', hairTip: '#4d6680',
  cloth: '#2f6790', clothDeep: '#132942', cape: '#183c5e', capeLine: '#8ee8ff',
  metal: '#b9d9dc', metalHot: '#efffff', metalDeep: '#385d68',
  blade: '#c6f0f2', bladeEdge: '#ffffff', leather: '#1c2938', glow: '#77e5ff',
};

const SIREN_PALETTE = {
  skin: '#ead3d8', skinDeep: '#8e586d', hair: '#42152e', hairTip: '#a43f78',
  cloth: '#8b285e', clothDeep: '#351028', cape: '#4f1539', capeLine: '#ff8ac4',
  metal: '#d8b4ca', metalHot: '#fff0fa', metalDeep: '#69405a',
  blade: '#c8b6d8', bladeEdge: '#fff2ff', leather: '#32152b', glow: '#ff74ba',
};

const ORACLE_PALETTE = {
  skin: '#d7c7ef', skinDeep: '#75659a', hair: '#241644', hairTip: '#6f4da8',
  cloth: '#56418f', clothDeep: '#21183f', cape: '#30245d', capeLine: '#c9b8ff',
  metal: '#dfcc79', metalHot: '#fff6c7', metalDeep: '#6d5422',
  blade: '#b9b5ce', bladeEdge: '#ffffff', leather: '#2a2144', glow: '#c9b8ff',
};

function mesh(geo, ctx, slot, tag, opts) {
  const out = new THREE.Mesh(geo, charMaterial(ctx, slot, tag, opts));
  out.castShadow = true;
  out.frustumCulled = false;
  return out;
}

function attachOnce(a, key, boneName, build, ctx, transform) {
  let object = a.root.userData[key];
  if (!object) {
    const bone = a.visual.rig?.bones?.[boneName];
    if (!bone) return null;
    object = build(ctx);
    transform?.(object);
    bone.add(object);
    a.root.userData[key] = object;
  }
  object.visible = true;
  return object;
}

function buildLance(ctx) {
  const shaft = new THREE.CylinderGeometry(0.035, 0.048, 3.35, 8);
  shaft.translate(0, 0.68, 0);
  const butt = new THREE.ConeGeometry(0.07, 0.28, 7); butt.rotateZ(Math.PI); butt.translate(0, -1.13, 0);
  const collar = new THREE.TorusGeometry(0.075, 0.018, 6, 16); collar.rotateX(Math.PI / 2); collar.translate(0, 2.15, 0);
  const wood = mergeGeometries([shaft, butt, collar], false);
  paintGeo(wood, '#234861', { y0: -1.3, y1: 2.3, aoLow: 0.52, top: '#78bbca' });

  const tip = new THREE.ConeGeometry(0.14, 0.56, 7); tip.translate(0, 2.52, 0);
  const wings = [];
  for (const s of [-1, 1]) {
    const w = new THREE.ConeGeometry(0.07, 0.34, 5);
    w.rotateZ(s * 0.84); w.translate(s * 0.13, 2.24, 0); wings.push(w);
  }
  const head = mergeGeometries([tip, ...wings], false);
  paintGeo(head, '#b9d9dc', { y0: 2.0, y1: 2.9, aoLow: 0.64, top: '#ffffff' });

  const group = new THREE.Group();
  group.add(mesh(wood, ctx, 'hair', 'lancer'), mesh(head, ctx, 'metal', 'lancer'));
  return group;
}

function buildSirenWings(ctx) {
  const group = new THREE.Group();
  for (const s of [-1, 1]) {
    const feathers = [];
    for (let i = 0; i < 5; i++) {
      const f = new THREE.ConeGeometry(0.12 + i * 0.018, 0.72 + i * 0.16, 5);
      f.rotateZ(s * (0.68 + i * 0.12));
      f.rotateX(-0.24 + i * 0.05);
      f.translate(s * (0.34 + i * 0.16), 0.02 - i * 0.09, -0.10 - i * 0.04);
      feathers.push(f);
    }
    const geo = mergeGeometries(feathers, false);
    paintGeo(geo, iColor(s), { y0: -0.8, y1: 0.8, aoLow: 0.48, top: '#f4c7df' });
    group.add(mesh(geo, ctx, 'cloth', 'siren'));
  }
  return group;
}

function iColor(side) { return side < 0 ? '#591638' : '#7a2453'; }

function buildOracleHalo(ctx) {
  const group = new THREE.Group();
  const parts = [];
  const outer = new THREE.TorusGeometry(0.42, 0.04, 8, 30); parts.push(outer);
  const inner = new THREE.TorusGeometry(0.22, 0.026, 6, 22); inner.rotateY(Math.PI / 2); parts.push(inner);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU;
    const ray = new THREE.ConeGeometry(0.045, 0.30, 5);
    ray.rotateZ(-a); ray.translate(Math.cos(a) * 0.52, Math.sin(a) * 0.52, 0); parts.push(ray);
  }
  const halo = mergeGeometries(parts, false);
  paintGeo(halo, '#dfcc79', { y0: -0.7, y1: 0.7, aoLow: 0.60, top: '#fff6c7' });
  const core = new THREE.OctahedronGeometry(0.13, 0);
  paintGeo(core, '#ffffff', { aoLow: 1 });
  group.add(mesh(halo, ctx, 'metal', 'oracle'), mesh(core, ctx, 'glow', 'oracle', { glowKey: '#c9b8ff', glow: 0.72 }));
  return group;
}

function staggerTo(a, state, token) {
  if (a.stagger > 0 && a.stateName !== 'hurt') {
    if (a.tell.active) a.endTell(false);
    a.committed = false;
    a.dropToken(token, 0.65);
    return state;
  }
}

export const LANCER = {
  kind: 'lancer', label: 'Stygian Lancer',
  role: 'lane charger — a long spear line must be sidestepped, not outrun',
  identity: '#77e5ff', deathColor: '#77e5ff', tellColor: '#71d8ff',
  hp: 82, radius: 0.56, speed: 4.4, accel: 27, turn: 10,
  poise: 24, staggerTime: 0.24, knockResist: 0.25,
  tokenPool: 'heavy', threat: 2, cost: 2, spawnTime: 0.66,
  perception: { range: 32, reaction: 0.28, aimLambda: 5.2 },
  spec: {
    name: 'erebus.lancer', height: 2.10,
    build: { shoulder: 1.03, limb: 1.04, bulk: 0.98 }, palette: LANCER_PALETTE,
    features: { pauldron: 'left', crown: 'laurel', cape: true, skirt: 4, greaves: true, bracers: true, harness: true, hair: 'none', eyes: true, weapon: 'none' },
    glowIntensity: 0.56,
  },
  onSpawn(a, ctx) {
    a.mem.lance = attachOnce(a, 'lancerLance', 'handR', buildLance, ctx, (o) => {
      o.position.set(-0.03, -0.30, 0.08); o.rotation.set(-0.12, 0, 0.18); o.scale.setScalar(0.82);
    });
  },
  tick(a) {
    if (a.mem.lance) a.mem.lance.rotation.z = 0.18 - (a.tell.active ? a.tell.k * 0.30 : 0);
  },
  brain: {
    initial: 'idle',
    any(a) { return staggerTo(a, 'hurt', 'heavy'); },
    states: {
      idle: { enter(a) { a.play('idle', { fade: 0.18 }); }, update(a) { if (a.perc.aware) return 'circle'; } },
      circle: {
        enter(a) { a.play('run', { fade: 0.14, speed: 1.0 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed).orbit(p.aimX, p.aimZ, 6.2, a.orbitDir, 1.0, 0.72).separation(a.mgr.list, 2.0).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ });
          if (a.attackCd <= 0 && p.dist > 3.0 && p.dist < 10.0 && a.wantToken('heavy', -p.dist)) return 'aim';
        },
      },
      aim: {
        enter(a) {
          a.committed = true; a.play('attack3', { fade: 0.08, restart: true, speed: 0.65 });
          const p = a.perc; a.snapFace(p.dirX, p.dirZ); a.mem.dx = p.dirX; a.mem.dz = p.dirZ;
          a.telegraph('lance', 0.78, { shape: 'line', radius: 8.2, inner: 0.17, dirX: p.dirX, dirZ: p.dirZ, follow: true, color: '#71d8ff' });
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.08).separation(a.mgr.list, 1.4);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 4.0); a.mem.dx = a.facing.x; a.mem.dz = a.facing.z;
          if (a.tell.k >= 1) return 'charge';
        },
      },
      charge: {
        enter(a, ctx) { a.endTell(true); a.mem.hit = false; ctx.audio?.sfx?.('lunge', { pos: a.position }); },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 2.75).add(a.mem.dx, a.mem.dz, 1).separation(a.mgr.list, 0.5);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false, accel: 110 });
          if (!a.mem.hit && ctx.player && inDisc(a.position.x, a.position.z, ctx.player, 1.15)) {
            a.mem.hit = true; a._hitPlayer(ctx, 18, 'physical', a.mem.dx, a.mem.dz, 11);
          }
          if (a.brain.t > 0.42) return 'recover';
        },
      },
      recover: {
        enter(a) { a.committed = false; },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.42).flee(a.perc.aimX, a.perc.aimZ, 0.7).separation(a.mgr.list, 1.8).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: a.perc.dirX, faceZ: a.perc.dirZ });
          if (a.brain.t > 0.62) { a.dropToken('heavy'); a.attackCd = 1.75; return 'circle'; }
        },
      },
      hurt: { enter(a) { a.play('hurt', { fade: 0.04, restart: true }); }, update(a, dt, ctx) { a.steer.begin(0).separation(a.mgr.list, 2); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.stagger <= 0) return 'circle'; } },
    },
  },
};

export const SIREN = {
  kind: 'siren', label: 'Winged Siren',
  role: 'blink assassin — its landing mark reveals where the flank strike will begin',
  identity: '#ff74ba', deathColor: '#ff74ba', tellColor: '#ff76ba',
  hp: 66, radius: 0.50, speed: 5.0, accel: 34, turn: 15,
  poise: 8, staggerTime: 0.28, knockResist: 0.05,
  tokenPool: 'melee', threat: 2, cost: 2, spawnTime: 0.56,
  perception: { range: 34, reaction: 0.22, aimLambda: 7.2 },
  spec: {
    name: 'erebus.siren', height: 1.92,
    build: { shoulder: 0.88, limb: 0.90, bulk: 0.82 }, palette: SIREN_PALETTE,
    features: { pauldron: 'none', crown: 'none', cape: false, skirt: 8, greaves: false, bracers: true, harness: false, hair: 'swept', eyes: true, weapon: 'xiphos' },
    glowIntensity: 0.68,
  },
  onSpawn(a, ctx) {
    a.mem.wings = attachOnce(a, 'sirenWings', 'chest', buildSirenWings, ctx, (o) => { o.position.set(0, 0.05, -0.10); o.scale.setScalar(0.92); });
  },
  tick(a, dt, ctx) {
    if (!a.mem.wings) return;
    const k = a.tell.active ? a.tell.k : 0;
    a.mem.wings.rotation.z = Math.sin(ctx.time.t * 4.5) * (0.05 + 0.12 * k);
    a.mem.wings.scale.setScalar(0.92 + 0.16 * k);
  },
  brain: {
    initial: 'idle',
    any(a) { return staggerTo(a, 'hurt', 'melee'); },
    states: {
      idle: { update(a) { if (a.perc.aware) return 'circle'; } },
      circle: {
        enter(a) { a.play('run', { fade: 0.12, speed: 1.2 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed).orbit(p.aimX, p.aimZ, 6.8, a.orbitDir, 1.0, 1.0).separation(a.mgr.list, 2.0).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 14 });
          if (a.attackCd <= 0 && p.dist < 11 && a.wantToken('melee', -p.dist + 0.4)) return 'mark';
        },
      },
      mark: {
        enter(a, ctx) {
          a.committed = true;
          const pl = ctx.player, fx = pl?.facing?.x ?? a.perc.dirX, fz = pl?.facing?.z ?? a.perc.dirZ;
          const safe = a.mgr.safePoint((pl?.position.x || 0) - fx * 2.7, (pl?.position.z || 0) - fz * 2.7, { minPlayerDist: 1.8 });
          a.mem.tx = safe.x; a.mem.tz = safe.z;
          a.telegraph('blink', 0.72, { shape: 'disc', radius: 1.35, x: safe.x, z: safe.z, follow: false, color: '#ff76ba', core: '#fff0fa' });
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.2).orbit(a.perc.aimX, a.perc.aimZ, 6.5, a.orbitDir, 0.4, 0.8).separation(a.mgr.list, 1.5);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: a.perc.dirX, faceZ: a.perc.dirZ });
          if (a.tell.k >= 1) return 'blink';
        },
      },
      blink: {
        enter(a, ctx) {
          const from = a.position.clone().setY(1.0); a.endTell(true);
          a.position.set(a.mem.tx, 0, a.mem.tz); ctx.world?.collide?.(a.position, a.radius); a.iframes = Math.max(a.iframes, 0.18);
          const p = ctx.player?.position; if (p) a.snapFace(p.x - a.position.x, p.z - a.position.z);
          ctx.vfx?.beam?.(from, a.position.clone().setY(1.0), { color: '#ff76ba', width: 0.22, life: 0.22, opacity: 0.75 });
          a.telegraph('talon', 0.32, { shape: 'arc', radius: 2.6, arc: 150, follow: true, color: '#ff76ba' });
        },
        update(a, dt, ctx) {
          a.steer.begin(0).separation(a.mgr.list, 1.3); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 8); if (a.tell.k >= 1) return 'slash';
        },
      },
      slash: {
        enter(a, ctx) { a.endTell(true); a.play('attack2', { fade: 0.04, restart: true }); a.strikeCone(ctx, { range: 2.6, arc: 150, damage: 16, knock: 7, color: '#ff76ba', width: 0.34, shake: 0.07 }); },
        update(a, dt, ctx) { a.steer.begin(a.def.speed * 0.15).separation(a.mgr.list, 1.6); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.brain.t > 0.38) return 'recover'; },
      },
      recover: {
        enter(a) { a.committed = false; },
        update(a, dt, ctx) { a.steer.begin(a.def.speed * 1.15).flee(a.perc.aimX, a.perc.aimZ, 1).separation(a.mgr.list, 1.8).avoidWalls(ctx); a.move(dt, ctx, a.steer.resolve(a.mgr.out)); if (a.brain.t > 0.55) { a.dropToken('melee'); a.attackCd = 2.2; return 'circle'; } },
      },
      hurt: { enter(a) { a.play('hurt', { fade: 0.04, restart: true }); }, update(a, dt, ctx) { a.steer.begin(a.def.speed * 0.25).flee(a.perc.aimX, a.perc.aimZ, 0.5).separation(a.mgr.list, 2); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.stagger <= 0) return 'circle'; } },
    },
  },
};

export const ORACLE = {
  kind: 'oracle', label: 'Moirai Oracle',
  role: 'healer/ward — its long ritual restores nearby enemies and must be interrupted',
  identity: '#c9b8ff', deathColor: '#c9b8ff', tellColor: '#d8c8ff',
  hp: 76, radius: 0.58, speed: 3.5, accel: 19, turn: 8,
  poise: 0, staggerTime: 0.34, knockResist: 0.1,
  tokenPool: 'ranged', threat: 4, cost: 3, priority: true, spawnTime: 0.74,
  perception: { range: 34, reaction: 0.38, aimLambda: 3.4 },
  spec: {
    name: 'erebus.oracle', height: 2.20,
    build: { shoulder: 0.94, limb: 1.02, bulk: 0.98 }, palette: ORACLE_PALETTE,
    features: { pauldron: 'both', crown: 'none', cape: true, skirt: 12, greaves: false, bracers: true, harness: true, hair: 'none', eyes: true, weapon: 'none' },
    glowIntensity: 0.72,
  },
  onSpawn(a, ctx) {
    a.mem.halo = attachOnce(a, 'oracleHalo', 'head', buildOracleHalo, ctx, (o) => { o.position.set(0, 0.28, -0.06); o.scale.setScalar(0.96); });
  },
  tick(a, dt, ctx) {
    if (!a.mem.halo) return;
    const k = a.tell.active ? a.tell.k : 0;
    a.mem.halo.rotation.z += dt * (0.7 + 2.2 * k);
    a.mem.halo.scale.setScalar(0.96 + 0.22 * k);
    const core = a.mem.halo.children[1];
    if (core?.material?.emissiveIntensity != null) core.material.emissiveIntensity = 0.7 + 2.4 * k * k;
  },
  brain: {
    initial: 'idle',
    any(a) { return staggerTo(a, 'hurt', 'ranged'); },
    states: {
      idle: { update(a) { if (a.perc.aware) return 'reposition'; } },
      reposition: {
        enter(a) { a.play('run', { fade: 0.16, speed: 0.86 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed).orbit(p.aimX, p.aimZ, 10.0, a.orbitDir, 1.0, 0.58).separation(a.mgr.list, 2.2).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 8 });
          const wounded = a.mgr.list.some(e => e !== a && e.alive && e.health < e.maxHealth * 0.82 && e.position.distanceToSquared(a.position) < 64);
          if (a.attackCd <= 0 && (wounded || a.brain.t > 4.2) && a.wantToken('ranged', wounded ? 4 : 1)) return 'ritual';
        },
      },
      ritual: {
        enter(a) {
          a.committed = true; a.play('cast', { fade: 0.08, restart: true, speed: 0.54 });
          a.telegraph('ward', 1.18, { shape: 'ring', radius: 6.2, inner: 0.72, follow: true, color: '#d8c8ff', core: '#fff7cf' });
        },
        update(a, dt, ctx) { a.steer.begin(0).separation(a.mgr.list, 2.2); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.tell.k >= 1) return 'release'; },
      },
      release: {
        enter(a, ctx) {
          a.endTell(true); a.committed = false;
          for (const ally of a.mgr.list) {
            if (!ally.alive || ally === a || ally.position.distanceToSquared(a.position) > 6.2 * 6.2) continue;
            const healed = Math.max(8, Math.round(ally.maxHealth * 0.18));
            ally.health = Math.min(ally.maxHealth, ally.health + healed);
            ally.iframes = Math.max(ally.iframes, 0.22);
            ctx.vfx?.beam?.(a.position.clone().setY(1.7), ally.position.clone().setY(ally.height * 0.6), { color: '#d8c8ff', width: 0.12, life: 0.35, opacity: 0.65 });
          }
          a.strikeDisc(ctx, a.position.x, a.position.z, 6.2, { damage: 10, type: 'arcane', knock: 6, color: '#d8c8ff', shake: 0.07, kind: 'rune', life: 0.48 });
        },
        update(a, dt, ctx) { a.steer.begin(a.def.speed * 0.2).flee(a.perc.aimX, a.perc.aimZ, 0.5).separation(a.mgr.list, 2); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.brain.t > 0.64) { a.dropToken('ranged'); a.attackCd = 5.6; return 'reposition'; } },
      },
      hurt: { enter(a) { a.play('hurt', { fade: 0.04, restart: true }); }, update(a, dt, ctx) { a.steer.begin(a.def.speed * 0.5).flee(a.perc.aimX, a.perc.aimZ, 1).separation(a.mgr.list, 2); a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false }); if (a.stagger <= 0) return 'reposition'; } },
    },
  },
};

export default { LANCER, SIREN, ORACLE };
