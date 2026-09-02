// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// casters.js — the two families that never want to be near you: HEXER, HERALD.
//
// SILHOUETTE:
//   HEXER   a TRIANGLE. A wide skirted robe with no legs visible, a narrow
//           head, and a tall staff crowned by a floating ring that hangs
//           OUTSIDE the body outline. The only tall thin vertical in the
//           roster; you find it by looking for the ring.
//   HERALD  a CRESCENT. A hunched, gold-heavy body under a wide horned
//           headdress, with three shards orbiting it at head height. The
//           horns break the outline sideways where every other unit is
//           vertical, so it is the shape you can name in a crowd — which is
//           the entire design: it must be prioritised, so it must be found.
//
// The hexer's AOE is aimed at the perception's LAGGED belief and telegraphed
// for a full second: the counterplay is to walk, not to dash. The herald's
// summon is longer still and it retreats while casting, so killing it is a
// commitment the player has to choose to make.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, TAU } from '../../core/math.js';
import { TELEGRAPH } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';
import * as PR from './props.js';

// ═══════════════════════════════════════════════════════════════════════════
// HEXER — ranged ground AOE
// ═══════════════════════════════════════════════════════════════════════════
const HEXER_PALETTE = {
  skin: '#c9b8ff', skinDeep: '#5a4a8c',
  hair: '#1a1030', hairTip: '#3a2060',
  cloth: '#4a2f9a', clothDeep: '#180c34',
  cape: '#241a52', capeLine: '#c9b8ff',
  metal: '#dcc46a', metalHot: '#fff0c0', metalDeep: '#5a3d12',
  blade: '#9fa8c8', bladeEdge: '#e8e8ff',
  leather: '#22163c',
  glow: '#c9b8ff',
};

function buildStaff(ctx) {
  // A ROD, not a cylinder: an octagonal haft with a wrapped grip and iron
  // ferrules, a three-claw finial holding the ring, and the ring itself as a
  // chamfered band with a lit arris rather than a torus sausage.
  const P = HEXER_PALETTE;
  const wood = PR.merge([
    PR.tint(PR.shaft({ y0: -0.60, y1: 1.98, r0: 0.048, r1: 0.040, radial: 8 }),
      (x, y) => (y > 1.2 ? '#4a3468' : '#2b1a3f'), { y0: -0.6, y1: 2.1, aoLow: 0.5 }),
    PR.tint(PR.grip({ y0: -0.05, y1: 0.38, r: 0.056 }), PR.wrapped('#241838', '#0f0a1c', 7)),
  ]);
  const metal = PR.merge([
    PR.tint(PR.ring({ y: -0.56, R: 0.046, th: 0.010, hh: 0.050, seg: 12 }), P.metalDeep),
    PR.tint(PR.ring({ y: 1.86, R: 0.054, th: 0.011, hh: 0.070, seg: 12 }), PR.chamfered(P.metalHot, P.metal, P.metalDeep)),
    PR.tint(PR.claws({ n: 3, y: 1.90, R: 0.15, len: 0.40, r0: 0.046, tilt: 0.60, phase: 0.3 }),
      (x, y) => (y > 2.16 ? P.metalHot : P.metal), { y0: 1.8, y1: 2.35, aoLow: 0.6 }),
    PR.tint(PR.xf(PR.ring({ y: 0, R: 0.36, th: 0.030, hh: 0.062, seg: 36 }), { p: [0, 2.12, 0], r: [Math.PI / 2, 0, 0] }),
      PR.chamfered(P.metalHot, P.metal, P.metalDeep)),
    PR.tint(PR.xf(PR.ring({ y: 0, R: 0.20, th: 0.016, hh: 0.036, seg: 26 }), { p: [0, 2.12, 0], r: [0, 0, Math.PI / 2] }), P.metal),
  ]);

  const g = new THREE.Group();
  const mw = PR.mesh(ctx, wood, 'hair', 'hexerwood');
  const mm = PR.mesh(ctx, metal, 'metal', 'hexer');
  g.add(mw, mm);
  // the caged sigil — the only emissive on the family, sitting in the ring
  const core = new THREE.IcosahedronGeometry(0.13, 1); core.translate(0, 2.12, 0);
  paintGeo(core, '#ffffff', { aoLow: 1, y0: 2, y1: 2.3 });
  const mc = new THREE.Mesh(core, charMaterial(ctx, 'glow', 'hexer', { glowKey: '#c9b8ff', glow: 0.55 }));
  mc.frustumCulled = false;
  g.add(mc);
  g.userData.core = mc;
  return g;
}

export const HEXER = {
  kind: 'hexer',
  label: 'Hexer of the Mire',
  role: 'ranged caster — telegraphs a ground AOE at where you were; walk out of it',
  identity: '#c9b8ff', deathColor: '#c9b8ff', tellColor: '#a05fe0',
  hp: 62, radius: 0.55, speed: 3.6, accel: 20, turn: 9,
  poise: 0, staggerTime: 0.30, knockResist: 0.0,
  tokenPool: 'ranged', threat: 2, cost: 2,
  perception: { range: 30, reaction: 0.42, aimLambda: 3.2 },
  spec: {
    name: 'erebus.hexer', height: 2.12,
    build: { shoulder: 0.9, limb: 0.98, bulk: 0.92 },
    palette: HEXER_PALETTE,
    // THE TRIANGLE: a cowl, a floor-length folded robe over the skirt bones,
    // and hanging sleeves. No legs, no bracers — a shape, then a staff.
    features: {
      pauldron: 'none', crown: 'none', cape: true, skirt: 10, greaves: false,
      bracers: false, harness: false, hair: 'none', eyes: true, weapon: 'none',
      hood: 'cowl', robe: true, sleeves: true, armlet: 'none',
    },
    gait: { idle: 'idleCaster' },
    glowIntensity: 0.62,
  },
  onSpawn(a, ctx) {
    if (!a.mem.staffBuilt) {
      const hand = a.visual.rig?.bones?.handR;
      if (hand) {
        const s = buildStaff(ctx);
        s.position.set(0.02, -0.02, 0.06);
        s.rotation.set(-0.18, 0, 0.12);
        s.scale.setScalar(0.86);
        hand.add(s);
        a.mem.staff = s;
      }
      a.mem.staffBuilt = true;
    }
  },
  tick(a, dt, ctx) {
    // the sigil in the ring pumps with the wind-up: the enemy itself tells you
    const c = a.mem.staff && a.mem.staff.userData.core;
    if (c && c.material) {
      const k = a.tell.active ? a.tell.k : 0;
      c.material.emissiveIntensity = 0.5 + 2.2 * k * k;
      c.scale.setScalar(1 + 0.7 * k);
    }
  },
  brain: {
    initial: 'idle',
    any(a, dt, ctx) {
      if (a.stagger > 0 && a.stateName !== 'hurt') {
        if (a.tell.active) a.endTell(false);
        a.committed = false; a.dropToken('ranged', 0.7);
        return 'hurt';
      }
      // never let the player stand on top of a caster
      if (a.perc.aware && a.perc.dist < 4.2 && a.stateName !== 'kite' && a.stateName !== 'cast' && a.stateName !== 'hurt') return 'kite';
    },
    states: {
      idle: {
        enter(a) { a.play('idle', { fade: 0.2 }); },
        update(a, dt, ctx) { if (a.perc.aware) return 'reposition'; },
      },
      reposition: {
        enter(a) { a.play('run', { fade: 0.16, speed: 0.9 }); a.mem.t = 0; },
        update(a, dt, ctx) {
          const p = a.perc;
          a.mem.t += dt;
          if (a.mem.t > 2.8) { a.mem.t = 0; a.orbitDir *= -1; }
          // SPACING: hold the far ring, but a hexer that has been pushed out
          // past its range walks back in rather than casting at nothing
          a.steer.begin(a.def.speed)
            .orbit(p.aimX, p.aimZ, p.dist > 14 ? 9.5 : 8.6, a.orbitDir, 1.0, 0.7)
            .separation(a.mgr.list, 2.0)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 9 });
          a.setRunSpeed(0.9);
          if (a.attackCd <= 0 && p.dist > 5.0 && p.dist < 17 && a.wantToken('ranged', -p.dist * 0.2)) {
            // TWO PATTERNS, chosen by the geometry: a direct bolt at mid range
            // (dodge sideways), the planted circle at long range (walk out).
            // Never the same one twice in a row.
            const mid = p.dist < 11;
            const pick = a.mem.last === 'bolt' ? 'cast' : a.mem.last === 'cast' ? (mid ? 'bolt' : 'cast') : (mid && a.mgr.rng.f() < 0.55 ? 'bolt' : 'cast');
            a.mem.last = pick;
            return pick;
          }
        },
      },
      // THE BOLT: a lane drawn from the staff, then a seeking bolt down it.
      // The seeking is weak on purpose — it curves toward where you WERE.
      bolt: {
        enter(a, ctx) {
          a.committed = true;
          a.play('cast', { fade: 0.08, restart: true, speed: 0.6 / TELEGRAPH.bolt });
          const p = a.perc;
          a.snapFace(p.dirX, p.dirZ);
          a.telegraph('bolt', TELEGRAPH.bolt, { shape: 'line', radius: Math.min(13, Math.max(8, p.dist + 3)), inner: 0.10, dirX: p.dirX, dirZ: p.dirZ, follow: true, color: a.tellColor, alpha: 0.8 });
        },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed * 0.12).separation(a.mgr.list, 2.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(p.aimX - a.position.x, p.aimZ - a.position.z, dt, 5);
          if (a.tell.k >= 1) return 'boltRelease';
        },
      },
      boltRelease: {
        enter(a, ctx) {
          a.endTell(true);
          const p = a.perc;
          // released down the lane at the lagged belief, led by a quarter
          // second of the hero's own velocity; the seek is stronger than it
          // was (1.3 -> 2.2) so a hero who merely strolls is found, and still
          // weak enough that a dash across the lane breaks it
          const pl = ctx.player;
          const dx = p.aimX + (pl?.velocity?.x || 0) * 0.25 - a.position.x, dz = p.aimZ + (pl?.velocity?.z || 0) * 0.25 - a.position.z;
          ctx.combat?.enemyProjectile?.(a, {
            x: a.position.x + a.facing.x * 0.9, y: 1.55, z: a.position.z + a.facing.z * 0.9, dx, dz,
            kind: 'homing', homing: 2.2, target: ctx.player, speed: 14.5, radius: 0.36, life: 2.6,
            damage: 15, type: 'arcane', knockback: 6, hitstop: 30, color: a.tellColor, size: 1.15, coreSize: 1.1, tag: 'enemy:hex-bolt',
          });
          ctx.vfx?.burst?.(new THREE.Vector3(a.position.x + a.facing.x * 0.9, 1.6, a.position.z + a.facing.z * 0.9), { count: 12, color: a.tellColor, speed: 6, spread: 0.5, kind: 'rune' });
          a.committed = false;
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.2).flee(a.perc.aimX, a.perc.aimZ, 0.6).separation(a.mgr.list, 2.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t > 0.42) { a.dropToken('ranged'); a.attackCd = 1.5; return 'reposition'; }
        },
      },
      kite: {
        enter(a) { a.play('run', { fade: 0.12, speed: 1.2 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed * 1.25)
            .flee(p.aimX, p.aimZ, 1.2)
            .orbit(p.aimX, p.aimZ, 8.0, a.orbitDir, 0.5, 1.0)
            .separation(a.mgr.list, 1.6)
            .avoidWalls(ctx, 2.4, 3.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 10 });
          a.setRunSpeed(1.2);
          if (p.dist > 6.4) return 'reposition';
        },
      },
      // THE TELL: a full second of ground circle, planted on the STALE belief
      // about the player's position. Standing still is what kills you.
      cast: {
        enter(a, ctx) {
          a.committed = true;
          a.play('cast', { fade: 0.1, restart: true, speed: 0.6 / (TELEGRAPH.rangedAOE) });
          const p = a.perc;
          a.snapFace(p.dirX, p.dirZ);
          // lead the belief slightly along the player's own velocity: a caster
          // that always aims behind you never threatens anything
          const pl = ctx.player;
          const lead = 0.24;
          a.mem.tx = p.aimX + (pl?.velocity?.x || 0) * lead;
          a.mem.tz = p.aimZ + (pl?.velocity?.z || 0) * lead;
          a.mem.r = a.def.aoeRadius ?? 3.1;
          a.telegraph('aoe', TELEGRAPH.rangedAOE, {
            shape: 'disc', radius: a.mem.r, x: a.mem.tx, z: a.mem.tz,
            follow: false, color: a.tellColor,
          });
        },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed * 0.15).separation(a.mgr.list, 2.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.mem.tx - a.position.x, a.mem.tz - a.position.z, dt, 6);
          if (a.tell.k >= 1) return 'release';
        },
      },
      release: {
        enter(a, ctx) {
          a.endTell(true);
          a.strikeDisc(ctx, a.mem.tx, a.mem.tz, a.mem.r, {
            damage: 20, type: 'arcane', knock: 7, color: a.tellColor, shake: 0.11, kind: 'rune',
          });
          ctx.vfx?.beam?.(
            new THREE.Vector3(a.position.x, 2.0, a.position.z),
            new THREE.Vector3(a.mem.tx, 0.15, a.mem.tz),
            { color: a.tellColor, width: 0.2, life: 0.3 });
          a.committed = false;
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.1).separation(a.mgr.list, 2.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t > 0.55) { a.dropToken('ranged'); a.attackCd = 2.1; return 'reposition'; }
        },
      },
      hurt: {
        enter(a) { a.play('hurt', { fade: 0.04, restart: true }); },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.3).flee(a.perc.aimX, a.perc.aimZ, 1).separation(a.mgr.list, 2.2);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.stagger <= 0) return 'kite';
        },
      },
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// HERALD — the summoner/support that must be prioritised
// ═══════════════════════════════════════════════════════════════════════════
const HERALD_PALETTE = {
  skin: '#f0d6a8', skinDeep: '#9a6a34',
  hair: '#2a1a10', hairTip: '#6a4020',
  cloth: '#c98f2b', clothDeep: '#5a3a0e',
  cape: '#3a2410', capeLine: '#ffe14d',
  metal: '#ffd24d', metalHot: '#fff6cf', metalDeep: '#7d4c17',
  blade: '#c8b070', bladeEdge: '#fff0b0',
  leather: '#3a2812',
  glow: '#ffe14d',
};

function buildHorns(ctx) {
  // The CRESCENT. Two ridged horns sweeping out and up off a chamfered diadem,
  // a central fin between them and a gem at the brow.
  const P = HERALD_PALETTE;
  const parts = [];
  for (const s of [1, -1]) parts.push(PR.horn({
    from: [s * 0.11, 0.02, -0.04], ctrl: [s * 0.55, 0.20, -0.18], to: [s * 0.74, 0.64, -0.34],
    r0: 0.072, ripples: 11, n: 13,
  }));
  parts.push(PR.ring({ y: 0.05, R: 0.19, th: 0.014, hh: 0.046, seg: 26 }));
  parts.push(PR.feather({ from: [0, 0.08, 0.02], to: [0, 0.54, -0.18], w: 0.075, bow: 0.05 }));
  parts.push(PR.gem(0.048, [0, 0.10, 0.20], [1, 1.4, 0.6]));
  const g = PR.tint(PR.merge(parts), (x, y, z) => (y > 0.42 || z > 0.16 ? P.metalHot : (y < 0.09 ? P.metalDeep : P.metal)),
    { y0: -0.1, y1: 0.7, aoLow: 0.55 });
  return PR.mesh(ctx, g, 'metal', 'herald');
}

function buildShards(ctx) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const s = new THREE.OctahedronGeometry(0.12, 0);
    s.scale(1, 1.9, 1);
    paintGeo(s, '#ffffff', { aoLow: 1 });
    const m = new THREE.Mesh(s, charMaterial(ctx, 'glow', 'herald', { glowKey: '#ffe14d', glow: 0.5 }));
    m.frustumCulled = false;
    g.add(m);
  }
  return g;
}

export const HERALD = {
  kind: 'herald',
  label: 'Gilded Herald',
  role: 'summoner/support — calls reinforcements and hastens allies; kill it first',
  identity: '#ffe14d', deathColor: '#ffe14d', tellColor: '#ffd24d',
  hp: 88, radius: 0.58, speed: 3.9, accel: 22, turn: 8,
  poise: 0, staggerTime: 0.32, knockResist: 0.15,
  tokenPool: 'ranged', threat: 4, cost: 3, priority: true,
  perception: { range: 32, reaction: 0.36, aimLambda: 3.6 },
  spec: {
    name: 'erebus.herald', height: 2.04,
    build: { shoulder: 1.06, limb: 0.94, bulk: 1.08 },
    palette: HERALD_PALETTE,
    features: {
      pauldron: 'both', crown: 'none', cape: true, skirt: 8, greaves: false,
      bracers: true, harness: true, hair: 'none', eyes: true, weapon: 'none',
      tabard: true, armlet: 'none',
    },
    gait: { idle: 'idleCaster' },
    glowIntensity: 0.7,
  },
  onSpawn(a, ctx) {
    if (!a.mem.built) {
      const head = a.visual.rig?.bones?.head;
      if (head) { const h = buildHorns(ctx); h.position.set(0, 0.20, 0.02); head.add(h); }
      const sh = buildShards(ctx);
      a.root.add(sh);
      a.mem.shards = sh;
      a.mem.built = true;
    }
    if (a.mem.shards) a.mem.shards.visible = true;
  },
  tick(a, dt, ctx) {
    const sh = a.mem.shards;
    if (!sh) return;
    const t = ctx.time.t;
    const k = a.tell.active ? a.tell.k : 0;
    const r = 0.95 + 0.55 * k;
    for (let i = 0; i < sh.children.length; i++) {
      const ang = t * (1.7 + 0.9 * k) + i * (TAU / 3);
      const c = sh.children[i];
      c.position.set(Math.cos(ang) * r, 1.85 + Math.sin(t * 2.2 + i) * 0.12 + 0.5 * k, Math.sin(ang) * r);
      c.rotation.y = ang * 1.6; c.rotation.x = t * 1.1 + i;
      if (c.material) c.material.emissiveIntensity = 0.5 + 1.8 * k;
    }
  },
  brain: {
    initial: 'idle',
    any(a, dt, ctx) {
      if (a.stagger > 0 && a.stateName !== 'hurt') {
        if (a.tell.active) a.endTell(false);
        a.committed = false; a.dropToken('ranged', 0.8);
        return 'hurt';
      }
      if (a.perc.aware && a.perc.dist < 5.0 && a.stateName !== 'kite' && a.stateName !== 'summon' && a.stateName !== 'hurt') return 'kite';
    },
    states: {
      idle: { enter(a) { a.play('idle', { fade: 0.2 }); }, update(a) { if (a.perc.aware) return 'reposition'; } },
      reposition: {
        enter(a) { a.play('run', { fade: 0.16, speed: 0.92 }); a.mem.t = 0; },
        update(a, dt, ctx) {
          const p = a.perc;
          a.mem.t += dt;
          if (a.mem.t > 3.2) { a.mem.t = 0; a.orbitDir *= -1; }
          a.steer.begin(a.def.speed)
            .orbit(p.aimX, p.aimZ, 10.2, a.orbitDir, 1.0, 0.62)
            .separation(a.mgr.list, 2.0)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 8 });
          a.setRunSpeed(0.92);
          if (a.attackCd <= 0 && (a.mgr.canSummon(a) || p.dist < 18) && a.wantToken('ranged', 3)) {
            // summon while the room has space; when it is saturated (or every
            // other call) the shards it carries become a homing VOLLEY, so
            // the herald is never a passenger
            if (a.mgr.canSummon(a) && (a.mem.calls || 0) % 2 === 0) return 'summon';
            if (p.dist < 18) return 'volley';
          }
        },
      },
      volley: {
        enter(a, ctx) {
          a.committed = true;
          a.mem.shots = 0; a.mem.shotT = 0;
          a.play('cast', { fade: 0.1, restart: true, speed: 0.6 / TELEGRAPH.volley });
          a.snapFace(a.perc.dirX, a.perc.dirZ);
          a.telegraph('volley', TELEGRAPH.volley, { shape: 'arc', radius: 3.0, arc: 70, follow: true, color: '#ffe14d', alpha: 0.85 });
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.1).separation(a.mgr.list, 1.8);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 5);
          if (a.tell.k >= 1) return 'volleyRelease';
        },
      },
      volleyRelease: {
        enter(a) { a.endTell(true); a.mem.shots = 0; a.mem.shotT = 0; },
        update(a, dt, ctx) {
          a.mem.shotT += dt;
          // three shards, one every 0.16s, fanned so the middle one is the
          // honest guess and the outer two punish standing still
          if (a.mem.shots < 3 && a.mem.shotT >= a.mem.shots * 0.16) {
            const i = a.mem.shots++;
            const ang = (i - 1) * 0.30;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const dx = a.facing.x * ca - a.facing.z * sa, dz = a.facing.x * sa + a.facing.z * ca;
            ctx.combat?.enemyProjectile?.(a, {
              x: a.position.x + dx * 1.0, y: 1.85, z: a.position.z + dz * 1.0, dx, dz,
              kind: 'homing', homing: 1.6, target: ctx.player, speed: 10.5, radius: 0.28, life: 3.4,
              damage: 9, type: 'arcane', knockback: 4, hitstop: 22, color: '#ffe14d', size: 1.0, coreSize: 1.0, tag: 'enemy:herald-shard',
            });
          }
          a.steer.begin(a.def.speed * 0.2).flee(a.perc.aimX, a.perc.aimZ, 0.8).separation(a.mgr.list, 2.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.mem.shots >= 3 && a.mem.shotT > 0.85) { a.committed = false; a.dropToken('ranged'); a.attackCd = 3.2; a.mem.calls = (a.mem.calls || 0) + 1; return 'reposition'; }
        },
      },
      kite: {
        enter(a) { a.play('run', { fade: 0.12, speed: 1.25 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed * 1.3).flee(p.aimX, p.aimZ, 1.4)
            .orbit(p.aimX, p.aimZ, 9.5, a.orbitDir, 0.4, 1.0)
            .separation(a.mgr.list, 1.6).avoidWalls(ctx, 2.4, 3.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 10 });
          a.setRunSpeed(1.25);
          if (p.dist > 7.2) return 'reposition';
        },
      },
      summon: {
        enter(a, ctx) {
          a.committed = true;
          a.play('special', { fade: 0.1, restart: true, speed: 0.54 / TELEGRAPH.summon });
          // the ring on the FLOOR under the herald: the tell is "something is
          // about to arrive here", and it is placed where the adds will land
          a.telegraph('summon', TELEGRAPH.summon, {
            shape: 'ring', radius: 3.4, inner: 0.62, x: a.position.x, z: a.position.z,
            follow: false, color: '#ffe14d',
          });
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.1).separation(a.mgr.list, 1.8);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 4);
          if (a.tell.k >= 1) return 'release';
        },
      },
      release: {
        enter(a, ctx) {
          a.endTell(true);
          a.committed = false;
          a.mgr.summonFor(a, a.def.summonKind || 'shade', a.def.summonCount ?? 2);
          ctx.vfx?.shockwave?.(a.position.clone().setY(0.05), { radius: 3.4, color: '#ffe14d', life: 0.5 });
          ctx.events.emit('camera.shake', { amp: 0.07, dur: 0.2, freq: 24 });
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.2).flee(a.perc.aimX, a.perc.aimZ, 1).separation(a.mgr.list, 2.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t > 0.7) { a.dropToken('ranged'); a.attackCd = a.def.summonCooldown ?? 6.0; a.mem.calls = (a.mem.calls || 0) + 1; return 'reposition'; }
        },
      },
      hurt: {
        enter(a) { a.play('hurt', { fade: 0.04, restart: true }); },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.35).flee(a.perc.aimX, a.perc.aimZ, 1).separation(a.mgr.list, 2.2);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.stagger <= 0) return 'kite';
        },
      },
    },
  },
};

export default { HEXER, HERALD };
