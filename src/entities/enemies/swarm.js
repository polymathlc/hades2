// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// swarm.js — the two NON-humanoid families: HOUND and BLOAT.
//
// The roster needs shapes that are not "a person". Two of the six are built
// from custom procedural meshes with hand-written procedural animation, and
// they are the two the black-shape test separates instantly:
//
//   HOUND  a HORIZONTAL. Low, long, four-legged, a spined back and a whipping
//          tail. It is the only wide-and-low shape in the game, it arrives in
//          THREES, and it lunges. Ember-orange so a pack reads as a moving
//          fire across a dark floor.
//   BLOAT  a CIRCLE ON STRINGS. A bloated hovering sac with four dangling
//          tendrils and a core that brightens as it arms. Sickly green — the
//          one hue nothing else in the roster uses — because the correct
//          response is not to fight it but to LEAVE, and that decision has to
//          be made from the shape alone.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, damp, TAU } from '../../core/math.js';
import { TELEGRAPH, inDisc } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';

// ═══════════════════════════════════════════════════════════════════════════
// a tiny visual driver for hand-animated procedural bodies
// ═══════════════════════════════════════════════════════════════════════════
class PartsVisual {
  constructor(root, height, parts, animate) {
    this.root = root; this.height = height; this.parts = parts;
    this._animate = animate; this.t = 0; this.clip = 'idle'; this.clipT = 0;
    this.base = parts.map(p => p.material);
  }
  play(name) { if (name !== this.clip) { this.clip = name; this.clipT = 0; } }
  duration() { return 0.5; }
  reset() { this.t = 0; this.clip = 'idle'; this.clipT = 0; }
  setFlash(mat) { for (let i = 0; i < this.parts.length; i++) this.parts[i].material = mat || this.base[i]; }
  update(dt, e) { this.t += dt; this.clipT += dt; this._animate(this, dt, e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// HOUND
// ═══════════════════════════════════════════════════════════════════════════
function houndGeo() {
  // BODY: a low, muscular canine barrel. Overlapping shoulder and haunch
  // masses keep the silhouette organic at gameplay distance instead of
  // collapsing into the old rectangular torso.
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector3(0, 0.63 + 0.09 * Math.sin(t * Math.PI), 0.63 - 1.34 * t));
  }
  const spine = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 18, 0.285, 12, false);
  const chest = new THREE.SphereGeometry(0.37, 18, 12); chest.scale(1.08, 1.02, 1.16); chest.translate(0, 0.64, 0.37);
  const haunch = new THREE.SphereGeometry(0.33, 16, 11); haunch.scale(1.14, 1.08, 1.02); haunch.translate(0, 0.60, -0.55);
  const neck = new THREE.CylinderGeometry(0.19, 0.23, 0.48, 12); neck.rotateX(1.12); neck.translate(0, 0.77, 0.72);
  const tailPts = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 9;
    tailPts.push(new THREE.Vector3(
      Math.sin(t * Math.PI * 1.35) * 0.20,
      0.59 + t * 0.25 + Math.sin(t * Math.PI) * 0.10,
      -0.67 - t * 0.72,
    ));
  }
  const tail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(tailPts), 12, 0.068, 8, false);
  const body = mergeGeometries([spine, chest, haunch, neck, tail], false);
  paintGeo(body, '#651d1c', { y0: 0.05, y1: 1.02, aoLow: 0.48, top: '#b64a2b' });

  // HEAD: cheek mass + broad muzzle, with a separate nose/ear/fang layer below.
  const skull = new THREE.SphereGeometry(0.23, 16, 11); skull.scale(1.12, 1.0, 1.28); skull.translate(0, 0.94, 0.91);
  const cheekL = new THREE.SphereGeometry(0.13, 12, 9); cheekL.scale(1.0, 0.92, 1.20); cheekL.translate(-0.14, 0.87, 1.00);
  const cheekR = cheekL.clone(); cheekR.translate(0.28, 0, 0);
  const snout = new THREE.CylinderGeometry(0.105, 0.155, 0.43, 10); snout.rotateX(Math.PI / 2); snout.translate(0, 0.86, 1.19);
  const jaw = new THREE.SphereGeometry(0.16, 12, 8); jaw.scale(0.92, 0.44, 1.42); jaw.translate(0, 0.78, 1.15);
  const head = mergeGeometries([skull, cheekL, cheekR, snout, jaw], false);
  paintGeo(head, '#74211d', { y0: 0.58, y1: 1.16, aoLow: 0.54, top: '#c65a31' });

  // LEGS: four chunky articulated limbs with shoulder/haunch bulbs, visible
  // hocks and broad paws. The former 7.5cm tubes read as sticks from above.
  const legs = [];
  for (const sx of [-1, 1]) for (const sz of [1, -1]) {
    const front = sz > 0;
    const z0 = front ? 0.38 : -0.52;
    const zend = front ? 0.51 : -0.30;
    const p = [
      new THREE.Vector3(sx * 0.24, 0.64, z0),
      new THREE.Vector3(sx * 0.29, 0.49, z0 + (front ? 0.02 : -0.03)),
      new THREE.Vector3(sx * 0.34, 0.30, z0 + (front ? 0.08 : 0.07)),
      new THREE.Vector3(sx * 0.35, 0.09, zend),
    ];
    const limb = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p), 10, 0.095, 8, false);
    const joint = new THREE.SphereGeometry(0.145, 10, 8); joint.scale(1.0, 1.15, 1.0); joint.translate(sx * 0.25, 0.55, z0);
    const paw = new THREE.SphereGeometry(0.12, 10, 7); paw.scale(1.18, 0.58, 1.55); paw.translate(sx * 0.35, 0.065, zend + 0.035);
    legs.push(limb, joint, paw);
  }
  const leg = mergeGeometries(legs, false);
  paintGeo(leg, '#1d1218', { y0: 0, y1: 0.72, aoLow: 0.56, top: '#68241f' });

  // SPINES: irregular layered keratin, tapered toward the tail.
  const spikes = [];
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const h = 0.14 + 0.22 * Math.sin(t * Math.PI);
    const c = new THREE.ConeGeometry(0.055 + 0.015 * Math.sin(t * Math.PI), h, 7);
    c.rotateX(-0.30 + 0.18 * t);
    c.translate(0, 0.89 + 0.07 * Math.sin(t * Math.PI), 0.52 - 1.16 * t);
    spikes.push(c);
  }
  const ridge = mergeGeometries(spikes, false);
  paintGeo(ridge, '#292126', { y0: 0.6, y1: 1.25, aoLow: 0.66, top: '#b9aa8e' });

  // READABLE CANINE FEATURES: tall ears, wet dark nose, aged bronze collar and
  // two lower fangs. Each source is painted before merging so the final mesh
  // retains material separation in vertex colour as well as atlas detail.
  const earL = new THREE.ConeGeometry(0.105, 0.34, 8); earL.rotateZ(-0.18); earL.translate(-0.13, 1.20, 0.84);
  const earR = new THREE.ConeGeometry(0.105, 0.34, 8); earR.rotateZ(0.18); earR.translate(0.13, 1.20, 0.84);
  paintGeo(earL, '#24171d', { y0: 0.95, y1: 1.40, aoLow: 0.60, top: '#715047' });
  paintGeo(earR, '#24171d', { y0: 0.95, y1: 1.40, aoLow: 0.60, top: '#715047' });
  const nose = new THREE.SphereGeometry(0.105, 12, 8); nose.scale(1.05, 0.75, 0.80); nose.translate(0, 0.87, 1.42);
  paintGeo(nose, '#08070d', { y0: 0.7, y1: 1.0, aoLow: 0.72, top: '#332735' });
  const collar = new THREE.CylinderGeometry(0.245, 0.235, 0.105, 14, 1, true); collar.rotateX(1.12); collar.translate(0, 0.76, 0.70);
  paintGeo(collar, '#6e4f2b', { y0: 0.45, y1: 1.05, aoLow: 0.60, top: '#b89555' });
  const fangL = new THREE.ConeGeometry(0.034, 0.15, 7); fangL.rotateZ(Math.PI); fangL.translate(-0.075, 0.73, 1.25);
  const fangR = new THREE.ConeGeometry(0.034, 0.15, 7); fangR.rotateZ(Math.PI); fangR.translate(0.075, 0.73, 1.25);
  paintGeo(fangL, '#a99b80', { y0: 0.62, y1: 0.82, aoLow: 0.68, top: '#e1d3b4' });
  paintGeo(fangR, '#a99b80', { y0: 0.62, y1: 0.82, aoLow: 0.68, top: '#e1d3b4' });
  const features = mergeGeometries([earL, earR, nose, collar, fangL, fangR], false);

  // EYES
  const e1 = new THREE.SphereGeometry(0.042, 10, 7); e1.translate(-0.105, 0.99, 1.08);
  const e2 = new THREE.SphereGeometry(0.042, 10, 7); e2.translate(0.105, 0.99, 1.08);
  const eyes = mergeGeometries([e1, e2], false);
  paintGeo(eyes, '#ffffff', { aoLow: 1 });

  return { body, head, leg, ridge, features, eyes };
}

function buildHound(ctx, e) {
  const G = houndGeo();
  const root = new THREE.Group();
  const mk = (g, slot, opts, parent = root) => {
    const m = new THREE.Mesh(g, charMaterial(ctx, slot, 'hound', opts));
    m.castShadow = true; m.frustumCulled = false; parent.add(m); return m;
  };
  const headRig = new THREE.Group(); root.add(headRig);
  const body = mk(G.body, 'cloth', { materialKey: 'characterrig.hound.hide' });
  const head = mk(G.head, 'cloth', { materialKey: 'characterrig.hound.hide' }, headRig);
  const legs = mk(G.leg, 'hair', { materialKey: 'characterrig.hound.limbs' });
  const ridge = mk(G.ridge, 'metal', { materialKey: 'characterrig.hound.keratin' });
  const features = mk(G.features, 'metal', { materialKey: 'characterrig.hound.keratin' }, headRig);
  const eyes = mk(G.eyes, 'glow', { glowKey: '#ffd080', glow: 0.34 }, headRig);
  const parts = [body, head, legs, ridge, features, eyes];

  return new PartsVisual(root, 1.15, parts, (V, dt, a) => {
    const t = V.t;
    const sp = Math.min(1.6, (a.speedNow || 0) / 5.5);
    const gait = t * (7.5 + 7 * sp);
    const k = a.tell.active ? a.tell.k : 0;
    // whole-body gallop bob + a hard crouch during the wind-up
    root.position.y = Math.abs(Math.sin(gait)) * 0.075 * sp - 0.13 * k;
    root.rotation.x = -0.10 * sp + 0.30 * k - Math.sin(gait * 2) * 0.045 * sp;
    root.scale.set(1 + 0.10 * k, 1 - 0.14 * k, 1 + 0.06 * k);
    // legs and ridge are one merged mesh each, so the animation is on the
    // TRANSFORMS — a shear-ish yaw wag reads as a gallop at play distance
    legs.rotation.z = Math.sin(gait) * 0.10 * sp;
    legs.position.z = Math.sin(gait * 2) * 0.05 * sp;
    headRig.position.y = Math.sin(gait + 0.8) * 0.035 * sp - 0.05 * k;
    headRig.rotation.x = 0.10 * Math.sin(gait * 0.5) - 0.34 * k;
    ridge.position.y = 0.04 * k + Math.sin(gait * 0.5) * 0.012;
    ridge.rotation.x = -0.22 * k;
    if (eyes.material.emissiveIntensity != null) eyes.material.emissiveIntensity = 0.34 + 1.7 * k;
  });
}

export const HOUND = {
  kind: 'hound',
  label: 'Ember Hound',
  role: 'fast swarmer — arrives in threes, lunges, forces you to keep moving',
  identity: '#ff8c1a', deathColor: '#ff8c1a', tellColor: '#ff5a3c',
  hp: 34, radius: 0.44, speed: 7.2, accel: 44, turn: 16,
  poise: 0, staggerTime: 0.2, knockResist: 0.0, crowdPad: 0.1,
  tokenPool: 'melee', threat: 1, cost: 1, packSize: 3,
  deathScale: 0.85, spawnTime: 0.5,
  perception: { range: 30, reaction: 0.2, aimLambda: 8.5 },
  buildVisual: buildHound,
  brain: {
    initial: 'idle',
    any(a, dt, ctx) {
      if (a.stagger > 0 && a.stateName !== 'hurt') {
        if (a.tell.active) a.endTell(false);
        a.committed = false; a.dropToken('melee', 0.5);
        return 'hurt';
      }
    },
    states: {
      idle: { update(a) { if (a.perc.aware) return 'circle'; } },
      circle: {
        enter(a) { a.mem.t = 0; },
        update(a, dt, ctx) {
          const p = a.perc;
          a.mem.t += dt;
          if (a.mem.t > 1.7) { a.mem.t = 0; a.orbitDir *= -1; }
          // hounds harry: they hold a TIGHT ring and dart in and out
          a.steer.begin(a.def.speed * 0.8)
            .orbit(p.aimX, p.aimZ, 4.4 + 0.7 * Math.sin(a.id * 1.7), a.orbitDir, 1.0, 1.15)
            .separation(a.mgr.list, 2.2).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 13 });
          if (a.attackCd <= 0 && p.dist < 7.5 && a.wantToken('melee', -p.dist + 0.5)) return 'crouch';
        },
      },
      // the LUNGE tell: a hard crouch and a lane drawn on the floor
      crouch: {
        enter(a, ctx) {
          a.committed = true;
          const p = a.perc;
          a.snapFace(p.dirX, p.dirZ);
          a.mem.lungeX = p.dirX; a.mem.lungeZ = p.dirZ;
          a.telegraph('lunge', 0.46, {
            shape: 'line', radius: 6.4, inner: 0.14, dirX: p.dirX, dirZ: p.dirZ,
            follow: true, color: '#ff5a3c',
          });
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.1).separation(a.mgr.list, 1.4);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 7);
          a.mem.lungeX = a.facing.x; a.mem.lungeZ = a.facing.z;
          if (a.tell.k >= 1) return 'lunge';
        },
      },
      lunge: {
        enter(a, ctx) { a.endTell(true); a.mem.hit = false; ctx.audio?.sfx?.('lunge', { pos: a.position }); },
        update(a, dt, ctx) {
          const s = a.def.speed * 2.35;
          a.steer.begin(s).add(a.mem.lungeX, a.mem.lungeZ, 1).separation(a.mgr.list, 0.8);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false, accel: 90 });
          if (!a.mem.hit && a.brain.t > 0.04) {
            if (inDisc(a.position.x, a.position.z, ctx.player, 1.05)) {
              a.mem.hit = true;
              a.strikeCone(ctx, { range: 1.5, arc: 160, damage: 9, knock: 6, color: '#ff8c1a', width: 0.22, shake: 0.04 });
            }
          }
          if (a.brain.t > 0.30) return 'recover';
        },
      },
      recover: {
        enter(a) { a.committed = false; },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.45).flee(a.perc.aimX, a.perc.aimZ, 1).separation(a.mgr.list, 2.0).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: a.perc.dirX, faceZ: a.perc.dirZ });
          if (a.brain.t > 0.42) { a.dropToken('melee'); a.attackCd = 1.15; return 'circle'; }
        },
      },
      hurt: {
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.25).separation(a.mgr.list, 2.2);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.stagger <= 0) return 'circle';
        },
      },
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BLOAT — the sacrificial detonator
// ═══════════════════════════════════════════════════════════════════════════
function buildBloat(ctx, e) {
  const root = new THREE.Group();
  const sac = new THREE.SphereGeometry(0.62, 18, 14);
  sac.scale(1.0, 0.86, 1.0); sac.translate(0, 1.28, 0);
  // lumps: the sac is not a ball, it is a BAG
  const lumps = [sac];
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU + 0.4;
    const s = new THREE.SphereGeometry(0.24 + 0.06 * ((i * 7) % 3), 10, 8);
    s.translate(Math.cos(a) * 0.46, 1.20 + 0.16 * Math.sin(a * 2), Math.sin(a) * 0.46);
    lumps.push(s);
  }
  const bag = mergeGeometries(lumps, false);
  paintGeo(bag, '#3f6a2a', { y0: 0.6, y1: 2.0, aoLow: 0.4, top: '#9ad86a' });

  // TENDRILS: the strings that make the circle read as a hanging thing
  const tend = [];
  for (let i = 0; i < 5; i++) {
    const a = i / 5 * TAU;
    const p = [];
    for (let j = 0; j <= 6; j++) {
      const t = j / 6;
      p.push(new THREE.Vector3(
        Math.cos(a) * (0.34 + 0.22 * t) + Math.sin(t * 5 + i) * 0.05,
        0.94 - 0.86 * t,
        Math.sin(a) * (0.34 + 0.22 * t)));
    }
    tend.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p), 8, 0.042 * (1 - 0.4), 5, false));
  }
  const tendrils = mergeGeometries(tend, false);
  paintGeo(tendrils, '#1e2e14', { y0: 0, y1: 1.0, aoLow: 0.5, top: '#5f8a30' });

  // the CORE — visible through the sac's silhouette because it sits proud
  const core = new THREE.IcosahedronGeometry(0.3, 1); core.translate(0, 1.28, 0);
  paintGeo(core, '#ffffff', { aoLow: 1 });

  // a crown of thorns so the top edge is not a smooth arc
  const th = [];
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * TAU + 0.2;
    const c = new THREE.ConeGeometry(0.05, 0.26, 5);
    c.rotateZ(-Math.cos(a) * 0.5); c.rotateX(Math.sin(a) * 0.5);
    c.translate(Math.cos(a) * 0.34, 1.86, Math.sin(a) * 0.34);
    th.push(c);
  }
  const thorns = mergeGeometries(th, false);
  paintGeo(thorns, '#c8e070', { y0: 1.6, y1: 2.1, aoLow: 0.6, top: '#f0ffb0' });

  const mk = (g, slot, opts) => { const m = new THREE.Mesh(g, charMaterial(ctx, slot, 'bloat', opts)); m.castShadow = true; m.frustumCulled = false; root.add(m); return m; };
  const mBag = mk(bag, 'cloth');
  const mTen = mk(tendrils, 'hair');
  const mThorn = mk(thorns, 'metal');
  const mCore = mk(core, 'glow', { glowKey: '#7ee06a', glow: 0.5 });
  const parts = [mBag, mTen, mThorn, mCore];

  return new PartsVisual(root, 1.9, parts, (V, dt, a) => {
    const t = V.t;
    const k = a.tell.active && a.tell.kind === 'detonate' ? a.tell.k : 0;
    // hover: a slow float, plus a violent shudder as the fuse burns down
    const shake = k * k * 0.055;
    root.position.y = 0.16 + Math.sin(t * 1.9) * 0.09
      + Math.sin(t * 41) * shake;
    root.position.x = Math.sin(t * 37 + 1) * shake;
    root.position.z = Math.cos(t * 43) * shake;
    const pulse = 1 + 0.05 * Math.sin(t * 2.6) + 0.30 * k * k;
    mBag.scale.set(pulse, pulse * (1 - 0.06 * k), pulse);
    mThorn.scale.setScalar(1 + 0.5 * k);
    mThorn.position.y = 0.12 * k;
    mCore.scale.setScalar(1 + 0.9 * k);
    if (mCore.material.emissiveIntensity != null) mCore.material.emissiveIntensity = 0.5 + 3.4 * k * k;
    mTen.rotation.y = Math.sin(t * 1.1) * 0.16;
    root.rotation.y += dt * 0.5;
  });
}

export const BLOAT = {
  kind: 'bloat',
  label: 'Bloated Sacrifice',
  role: 'exploding unit — walks in and detonates; forces the player to move',
  identity: '#7ee06a', deathColor: '#7ee06a', tellColor: '#9ad86a',
  hp: 40, radius: 0.62, speed: 3.2, accel: 14, turn: 6,
  poise: 999, staggerTime: 0.0, knockResist: 0.5, crowdPad: 0.25,
  tokenPool: 'free', threat: 2, cost: 2,
  deathScale: 1.2, spawnTime: 0.7,
  perception: { range: 34, reaction: 0.30, aimLambda: 4.0 },
  blastRadius: 3.6, blastDamage: 26,
  buildVisual: buildBloat,
  /** dying while armed still detonates — killing it is not a free answer */
  onDied(a, info, ctx) {
    if (a.mem.armed) a.mem.armed = false;
    ctx.vfx?.shockwave?.(a.position.clone().setY(0.05), { radius: a.def.blastRadius, color: '#7ee06a', life: 0.5 });
    const p = ctx.player;
    if (p && p.alive !== false && inDisc(a.position.x, a.position.z, p, a.def.blastRadius * 0.82)) {
      const dx = p.position.x - a.position.x, dz = p.position.z - a.position.z;
      const d = Math.hypot(dx, dz) || 1;
      a._hitPlayer(ctx, a.def.blastDamage * 0.55, 'poison', dx / d, dz / d, 7);
    }
  },
  brain: {
    initial: 'idle',
    // NOTE: no `hurt` state. The bloat never flinches — that is the threat.
    any(a, dt, ctx) { if (!ctx.player || ctx.player.alive === false) return 'idle'; },
    states: {
      idle: { update(a) { if (a.perc.aware) return 'chase'; } },
      chase: {
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed)
            .seek(p.aimX, p.aimZ, 1.0)
            .separation(a.mgr.list, 1.4)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 6 });
          if (p.dist < a.def.blastRadius * 0.78) return 'arm';
        },
      },
      // A LONG fuse, a big circle, and it keeps walking. The answer is to
      // leave, and the player is given 1.35s to decide that.
      arm: {
        enter(a, ctx) {
          a.committed = true; a.mem.armed = true;
          a.telegraph('detonate', TELEGRAPH.detonate, {
            shape: 'disc', radius: a.def.blastRadius, follow: true, color: '#7ee06a', core: '#eaffcf',
          });
          ctx.events.emit('camera.shake', { amp: 0.02, dur: 0.2, freq: 40 });
        },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed * 0.72).seek(p.aimX, p.aimZ, 1).separation(a.mgr.list, 1.2).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 4 });
          if (a.tell.k >= 1) return 'detonate';
        },
      },
      detonate: {
        enter(a, ctx) {
          a.endTell(true);
          a.mem.armed = false;
          a.strikeDisc(ctx, a.position.x, a.position.z, a.def.blastRadius, {
            damage: a.def.blastDamage, type: 'poison', knock: 12, color: '#7ee06a', shake: 0.2, kind: 'ember', life: 0.55,
          });
          ctx.events.emit('hit.stop', { ms: 55 });
          // it kills itself: sacrificial by contract, through the damage router
          ctx.combat?.applyDamage?.({
            target: a, amount: a.health + 1000, type: 'poison', crit: false,
            dir: new THREE.Vector3(0, 0, 1), pos: a.position.clone(), source: a, knockback: 0,
          });
        },
        update(a) { },
      },
    },
  },
};

export default { HOUND, BLOAT };
