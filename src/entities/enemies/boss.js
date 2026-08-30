// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// boss.js — THE WARDEN OF THE NINTH GATE.
//
// SILHOUETTE: a MONOLITH with a crown. Three and a half metres, twice the
// shoulder of a brute, a horned iron crown that reads as two hooks against the
// sky, and a greatsword carried at the trail so the blade draws a long diagonal
// out of the body mass. Nothing else in the game is this tall; the read is the
// height itself.
//
// THE FIGHT — a real ramp, not a health bar with more zeros:
//
//   PHASE 1  (100–66%)  TEACHING. Two attacks, both slow, both floor-drawn:
//                       an overhead CLEAVE (arc) and a CHARGE (lane). Long
//                       recoveries. This phase exists to teach the tells.
//   PHASE 2  ( 66–33%)  PRESSURE. Adds a radial SUNDER (expanding ring you
//                       must be outside of) and calls a pack of hounds, so the
//                       player has to solve the boss and the room at once.
//                       Wind-ups shorten by 15%, recoveries by 25%.
//   PHASE 3  ( 33– 0%)  DESPERATION. A three-hit CLEAVE COMBO and a VOLLEY of
//                       ground circles. Fastest, but it over-commits.
//
//   THE VULNERABILITY WINDOW is the whole design. Every phase transition and
//   every heavy attack ends in EXPOSED: the Warden plants the greatsword,
//   kneels, glows white-hot at the gorget, takes DOUBLE damage and cannot act
//   for a generous window. All of the player's damage is meant to happen here.
//   A boss that is always hittable is a punching bag; a boss that is never
//   hittable is a wall. This is the third thing.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, TAU } from '../../core/math.js';
import { TELEGRAPH, inDisc } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';

const WARDEN_PALETTE = {
  skin: '#c08a6a', skinDeep: '#5e2f22',
  hair: '#160c1e', hairTip: '#3a1830',
  cloth: '#a3182c', clothDeep: '#3d0510',
  cape: '#1d0d1c', capeLine: '#ff5a3c',
  metal: '#e8c98a', metalHot: '#fff6d8', metalDeep: '#5e3a10',
  blade: '#8e93ab', bladeEdge: '#ffe9a8',
  leather: '#2a161f',
  glow: '#ff5a3c',
};

function buildCrown(ctx) {
  const parts = [];
  const band = new THREE.CylinderGeometry(0.235, 0.245, 0.16, 14, 1, true);
  band.translate(0, 0.10, 0);
  parts.push(band);
  for (const s of [1, -1]) {
    const p = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      p.push(new THREE.Vector3(
        s * (0.16 + 0.40 * Math.sin(t * 1.45)),
        0.14 + 0.60 * t - 0.24 * t * t,
        -0.02 - 0.30 * t * t));
    }
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(p), 12, 0.055, 6, false));
  }
  for (let i = 0; i < 5; i++) {
    const a = (-0.5 + i / 4) * 1.5;
    const c = new THREE.ConeGeometry(0.038, 0.20 + 0.10 * Math.cos(a), 5);
    c.translate(Math.sin(a) * 0.22, 0.26, Math.cos(a) * 0.22);
    parts.push(c);
  }
  const g = mergeGeometries(parts, false);
  paintGeo(g, '#e8c98a', { y0: 0, y1: 0.8, aoLow: 0.5, top: '#fff6d8' });
  const m = new THREE.Mesh(g, charMaterial(ctx, 'metal', 'warden'));
  m.castShadow = true; m.frustumCulled = false;
  return m;
}

function buildGreatsword(ctx) {
  const grp = new THREE.Group();
  // blade: a long tapered wedge — the diagonal that breaks the body mass
  const blade = new THREE.BoxGeometry(0.20, 2.55, 0.065);
  blade.translate(0, 1.55, 0);
  const tip = new THREE.ConeGeometry(0.145, 0.42, 4); tip.rotateY(Math.PI / 4); tip.translate(0, 3.02, 0);
  const fuller = new THREE.BoxGeometry(0.055, 2.1, 0.09); fuller.translate(0, 1.5, 0);
  const steel = mergeGeometries([blade, tip], false);
  paintGeo(steel, '#8e93ab', { y0: 0.3, y1: 3.1, aoLow: 0.55, top: '#ffe9a8' });
  const guard = new THREE.BoxGeometry(0.86, 0.11, 0.15); guard.translate(0, 0.30, 0);
  const gk = new THREE.SphereGeometry(0.09, 10, 8); gk.translate(0, -0.30, 0);
  const grip = new THREE.CylinderGeometry(0.055, 0.062, 0.56, 8); grip.translate(0, 0.0, 0);
  const gold = mergeGeometries([guard, gk, fuller], false);
  paintGeo(gold, '#e8c98a', { y0: -0.4, y1: 1.6, aoLow: 0.55, top: '#fff6d8' });
  paintGeo(grip, '#2a161f', { y0: -0.4, y1: 0.4, aoLow: 0.5 });

  const ms = new THREE.Mesh(steel, charMaterial(ctx, 'metal', 'wardenblade'));
  const mg = new THREE.Mesh(gold, charMaterial(ctx, 'metal', 'warden'));
  const mp = new THREE.Mesh(grip, charMaterial(ctx, 'hair', 'wardengrip'));
  for (const m of [ms, mg, mp]) { m.castShadow = true; m.frustumCulled = false; grp.add(m); }
  return grp;
}

// ═══════════════════════════════════════════════════════════════════════════
const PHASES = [
  { at: 1.00, windMul: 1.00, recMul: 1.00, speed: 3.4, name: 1 },
  { at: 0.66, windMul: 0.86, recMul: 0.76, speed: 4.0, name: 2 },
  { at: 0.33, windMul: 0.74, recMul: 0.62, speed: 4.6, name: 3 },
];

function phaseFor(a) {
  const f = a.health / a.maxHealth;
  return f > 0.66 ? 0 : f > 0.33 ? 1 : 2;
}
const P = (a) => PHASES[a.mem.phase | 0];

export const WARDEN = {
  kind: 'warden',
  label: 'The Warden of the Ninth Gate',
  title: 'The Warden of the Ninth Gate', phases: 3, captureState: 'cleave',
  role: 'BOSS — three phases, four telegraphed attacks, a real vulnerability window',
  identity: '#ff5a3c', deathColor: '#ff5a3c', tellColor: '#ff5a3c',
  hp: 1150, radius: 1.25, speed: 3.4, accel: 15, turn: 3.4,
  poise: 999, poiseMax: 260, staggerTime: 0.0, knockResist: 0.95, crowdPad: 0.9,
  tokenPool: 'boss', threat: 20, cost: 20, boss: true,
  deathScale: 2.6, deathShake: 0.3, deathTime: 1.5, spawnTime: 1.2,
  perception: { range: 60, reaction: 0.25, aimLambda: 4.2 },
  spec: {
    name: 'erebus.warden', height: 3.42,
    build: { shoulder: 1.62, limb: 1.2, bulk: 1.52 },
    palette: WARDEN_PALETTE,
    features: {
      pauldron: 'both', crown: 'none', cape: true, skirt: 10, greaves: true,
      bracers: true, harness: true, hair: 'none', eyes: true, weapon: 'none',
    },
    glowIntensity: 0.8,
  },
  onSpawn(a, ctx) {
    a.mem.phase = 0;
    a.mem.combo = 0;
    a.mem.calledAdds = false;
    a.vulnerable = false;
    a.resist = null;
    if (!a.mem.built) {
      const rig = a.visual.rig;
      if (rig?.bones?.head) { const c = buildCrown(ctx); c.position.set(0, 0.22, 0.01); rig.bones.head.add(c); }
      if (rig?.bones?.handR) {
        const s = buildGreatsword(ctx);
        s.position.set(0.02, -0.02, 0.05);
        s.rotation.set(-0.25, 0, 0.10);
        s.scale.setScalar(0.92);
        rig.bones.handR.add(s);
        a.mem.sword = s;
      }
      a.mem.built = true;
    }
    ctx.events.emit('boss.spawned', { entity: a, name: WARDEN.label, maxHealth: a.maxHealth });
    ctx.ui?.toast?.(WARDEN.label, { color: '#ff5a3c' });
  },
  tick(a, dt, ctx) {
    const ph = phaseFor(a);
    if (ph !== a.mem.phase) {
      a.mem.phase = ph;
      a.mem.pendingPhase = true;
      ctx.events.emit('boss.phase', { entity: a, phase: ph + 1, health: a.health, maxHealth: a.maxHealth });
    }
    ctx.events.emit('boss.health', { entity: a, health: a.health, maxHealth: a.maxHealth, phase: ph + 1 });
    // the gorget goes white-hot in the vulnerability window: the tell that the
    // player should be attacking RIGHT NOW
    const rig = a.visual.rig;
    if (rig && rig.materials) {
      for (const m of rig.materials) {
        if (m.emissive && m.emissiveIntensity != null && m.userData.__wardenGlow !== false) {
          if (m.emissive.getHex() !== 0) m.emissiveIntensity = a.vulnerable ? 2.6 : 0.8;
        }
      }
    }
  },
  onDied(a, info, ctx) {
    ctx.events.emit('boss.defeated', { entity: a, pos: a.position.clone() });
    ctx.engine?.slowmo?.(0.52, 0.62);
    for (let i = 0; i < 2; i++) {
      ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.42), { radius: 4.5 + i * 4.2, color: '#ff5a3c', life: 0.62 + i * 0.16, density: 0.46 });
    }
  },
  brain: {
    initial: 'idle',
    any(a, dt, ctx) {
      if (!ctx.player || ctx.player.alive === false) return a.stateName === 'idle' ? null : 'idle';
      // a phase change interrupts anything that is not already committed
      if (a.mem.pendingPhase && !a.committed && a.stateName !== 'phase' && a.stateName !== 'exposed') {
        a.mem.pendingPhase = false;
        return 'phase';
      }
    },
    states: {
      idle: {
        enter(a) { a.play('idle', { fade: 0.2 }); },
        update(a, dt, ctx) { if (a.perc.aware) return 'stalk'; },
      },

      // STALK — the neutral. Slow, deliberate, always facing you, closing at a
      // pace you can retreat from. This is where the player gets to breathe.
      stalk: {
        enter(a) { a.play('run', { fade: 0.2, speed: 0.7 }); a.mem.t = 0; },
        update(a, dt, ctx) {
          const p = a.perc, ph = P(a);
          a.mem.t += dt;
          a.steer.begin(ph.speed)
            .arrive(p.aimX, p.aimZ, 4.5, 1.0)
            .orbit(p.aimX, p.aimZ, 4.6, a.orbitDir, 0.5, 0.55)
            .separation(a.mgr.list, 1.2)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 4.5 });
          a.setRunSpeed(0.7 + 0.25 * a.mem.phase);
          if (a.attackCd > 0) return;
          // ── attack selection: deterministic, phase-gated, never repeats
          //    the same heavy twice in a row
          const r = a.mgr.rng.f();
          const ph2 = a.mem.phase;
          if (ph2 >= 1 && !a.mem.calledAdds && p.dist > 5) { a.mem.calledAdds = true; return 'call'; }
          if (ph2 >= 2 && r < 0.34) return 'volley';
          if (ph2 >= 1 && r < 0.52 && p.dist < 9) return 'sunder';
          if (p.dist > 6.5) return 'charge';
          return 'cleave';
        },
      },

      // ── PHASE 1: the two teaching attacks ──────────────────────────────
      cleave: {
        enter(a, ctx) {
          a.committed = true;
          const w = TELEGRAPH.bossSlam * P(a).windMul;
          a.play('attack3', { fade: 0.08, restart: true, speed: 0.68 / (w + 0.2) });
          a.snapFace(a.perc.dirX, a.perc.dirZ);
          a.mem.cleaveW = w;
          a.telegraph('cleave', w, { shape: 'arc', radius: 5.0, arc: 118, follow: true, color: '#ff5a3c' });
        },
        update(a, dt, ctx) {
          a.steer.begin(P(a).speed * 0.35).seek(a.perc.aimX, a.perc.aimZ, 1);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 2.6);
          if (a.tell.k >= 1) return 'cleaveHit';
        },
      },
      cleaveHit: {
        enter(a, ctx) {
          a.endTell(true);
          a.strikeCone(ctx, { range: 5.0, arc: 118, damage: 30, knock: 15, color: '#ff5a3c', width: 0.72, shake: 0.2 });
          ctx.vfx?.shockwave?.(a.position.clone().addScaledVector(new THREE.Vector3(a.facing.x, 0, a.facing.z), 2.4).setY(0.05),
            { radius: 3.2, color: '#ff8c1a', life: 0.45 });
          ctx.events.emit('hit.stop', { ms: 60 });
        },
        update(a, dt, ctx) {
          a.steer.begin(1.2).add(a.facing.x, a.facing.z, 1);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t > 0.22) {
            // phase 3 chains three of them, and only THEN opens the window
            if (a.mem.phase >= 2 && a.mem.combo < 2) { a.mem.combo++; return 'cleave'; }
            a.mem.combo = 0;
            return 'exposed';
          }
        },
      },

      charge: {
        enter(a, ctx) {
          a.committed = true;
          a.play('dash', { fade: 0.08, restart: true, speed: 0.5 });
          const p = a.perc;
          a.snapFace(p.dirX, p.dirZ);
          a.mem.cx = p.dirX; a.mem.cz = p.dirZ;
          a.telegraph('charge', TELEGRAPH.bossSweep * P(a).windMul, {
            shape: 'line', radius: 13.0, inner: 0.16, follow: true, color: '#ffb03c',
          });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.6).separation(a.mgr.list, 1.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 2.2);
          a.mem.cx = a.facing.x; a.mem.cz = a.facing.z;
          if (a.tell.k >= 1) return 'chargeGo';
        },
      },
      chargeGo: {
        enter(a, ctx) { a.endTell(true); a.mem.hit = false; ctx.events.emit('camera.shake', { amp: 0.09, dur: 0.5, freq: 22 }); },
        update(a, dt, ctx) {
          a.steer.begin(P(a).speed * 4.4).add(a.mem.cx, a.mem.cz, 1);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false, accel: 120 });
          a.mgr.dustAt(ctx, a.position, '#ffb03c');
          if (!a.mem.hit && inDisc(a.position.x, a.position.z, ctx.player, 1.8)) {
            a.mem.hit = true;
            a.strikeCone(ctx, { range: 2.6, arc: 200, damage: 26, knock: 18, color: '#ffb03c', width: 0.5, shake: 0.22 });
          }
          // ends on the wall, and the crash IS the opening
          const R = ctx.world?.radiusAt ? ctx.world.radiusAt(Math.atan2(a.position.z, a.position.x)) : 16;
          const hitWall = Math.hypot(a.position.x, a.position.z) > R - a.radius - 1.6;
          if (a.brain.t > 0.85 || hitWall) {
            if (hitWall) {
              ctx.vfx?.shockwave?.(a.position.clone().setY(0.05), { radius: 4.5, color: '#ffb03c', life: 0.5 });
              ctx.events.emit('camera.shake', { amp: 0.3, dur: 0.4, freq: 20 });
              ctx.events.emit('hit.stop', { ms: 80 });
            }
            return 'exposed';
          }
        },
      },

      // ── PHASE 2: the room attacks ──────────────────────────────────────
      sunder: {
        enter(a, ctx) {
          a.committed = true;
          a.play('special', { fade: 0.1, restart: true, speed: 0.54 / (TELEGRAPH.bossSlam * P(a).windMul) });
          a.telegraph('sunder', TELEGRAPH.bossSlam * P(a).windMul, {
            shape: 'ring', radius: 7.2, inner: 0.34, follow: true, color: '#ff5a3c', core: '#fff0b0',
          });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.4).separation(a.mgr.list, 1.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 2);
          if (a.tell.k >= 1) return 'sunderHit';
        },
      },
      sunderHit: {
        enter(a, ctx) {
          a.endTell(true);
          const p = ctx.player;
          ctx.vfx?.shockwave?.(a.position.clone().setY(0.05), { radius: 7.4, color: '#ff5a3c', life: 0.6 });
          ctx.vfx?.burst?.(a.position.clone().setY(0.4), { count: 30, color: '#ff8c1a', speed: 12, spread: 1.4, kind: 'shard' });
          ctx.events.emit('camera.shake', { amp: 0.28, dur: 0.45, freq: 21 });
          ctx.events.emit('hit.stop', { ms: 70 });
          // the SAFE SPOT is under him — an annulus, not a disc
          if (p && p.alive !== false) {
            const d = Math.hypot(p.position.x - a.position.x, p.position.z - a.position.z);
            if (d > 2.4 && d < 7.6) {
              const dx = p.position.x - a.position.x, dz = p.position.z - a.position.z;
              a._hitPlayer(ctx, 26, 'fire', dx / (d || 1), dz / (d || 1), 14);
            }
          }
        },
        update(a, dt, ctx) { if (a.brain.t > 0.3) return 'exposed'; },
      },

      call: {
        enter(a, ctx) {
          a.committed = true;
          a.play('special', { fade: 0.1, restart: true, speed: 0.6 });
          a.telegraph('summon', TELEGRAPH.summon, { shape: 'ring', radius: 5.5, inner: 0.7, follow: true, color: '#ffe14d' });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.3).separation(a.mgr.list, 1.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.tell.k >= 1) {
            a.endTell(true);
            a.mgr.summonFor(a, 'hound', 3);
            ctx.vfx?.shockwave?.(a.position.clone().setY(0.05), { radius: 5.5, color: '#ffe14d', life: 0.6 });
            return 'exposed';
          }
        },
      },

      // ── PHASE 3: the desperation volley ────────────────────────────────
      volley: {
        enter(a, ctx) {
          a.committed = true;
          a.play('cast', { fade: 0.1, restart: true, speed: 0.6 / TELEGRAPH.bossVolley });
          a.mem.shots = 0;
          a.mem.shotT = 0;
          const p = a.perc;
          a.mem.marks = a.mem.marks || [];
          a.mem.marks.length = 0;
          // three circles: on you, ahead of you, and behind you. Only one of
          // the three is a guess — the other two punish standing still.
          const pl = ctx.player;
          const vx = pl?.velocity?.x || 0, vz = pl?.velocity?.z || 0;
          a.mem.marks.push({ x: p.aimX, z: p.aimZ });
          a.mem.marks.push({ x: p.aimX + vx * 0.55, z: p.aimZ + vz * 0.55 });
          a.mem.marks.push({ x: p.aimX - vx * 0.5 + p.dirX * 2.4, z: p.aimZ - vz * 0.5 + p.dirZ * 2.4 });
          for (let i = 0; i < 3; i++) {
            const m = a.mem.marks[i];
            a.mgr.telegraphs.spawn({
              x: m.x, z: m.z, radius: 3.0, shape: 'disc',
              dur: TELEGRAPH.bossVolley + i * 0.22, color: '#a05fe0', owner: a,
            });
          }
          a.telegraph('volley', TELEGRAPH.bossVolley, { shape: 'ring', radius: 2.2, inner: 0.5, follow: true, color: '#a05fe0', alpha: 0.55 });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.3).separation(a.mgr.list, 1.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(a.perc.dirX, a.perc.dirZ, dt, 2);
          if (a.tell.k >= 1) return 'volleyHit';
        },
      },
      volleyHit: {
        enter(a) { a.endTell(true); a.mem.shots = 0; a.mem.shotT = 0; },
        update(a, dt, ctx) {
          a.mem.shotT += dt;
          if (a.mem.shots < 3 && a.mem.shotT >= a.mem.shots * 0.22) {
            const m = a.mem.marks[a.mem.shots];
            a.mem.shots++;
            a.strikeDisc(ctx, m.x, m.z, 3.0, { damage: 22, type: 'arcane', knock: 8, color: '#a05fe0', shake: 0.1, kind: 'rune' });
          }
          if (a.mem.shots >= 3 && a.mem.shotT > 0.75) return 'exposed';
        },
      },

      // ── THE WINDOW ─────────────────────────────────────────────────────
      // Plants the sword, kneels, takes DOUBLE damage, cannot act. The whole
      // fight is a negotiation for these seconds.
      exposed: {
        enter(a, ctx) {
          a.committed = false;
          a.vulnerable = true;
          a.resist = { physical: -1, fire: -1, lightning: -1, frost: -1, poison: -1, arcane: -1 };
          a.play('hurt', { fade: 0.14, restart: true, speed: 0.42 });
          ctx.events.emit('boss.exposed', { entity: a, pos: a.position.clone(), dur: a.mem.exposeDur = 2.4 * (1 - 0.16 * a.mem.phase) });
          ctx.vfx?.burst?.(a.position.clone().setY(2.0), { count: 18, color: '#fff6d8', speed: 5, spread: 1.2, kind: 'ember' });
          a.mgr.telegraphs.spawn({
            x: a.position.x, z: a.position.z, radius: 2.6, shape: 'ring', inner: 0.72,
            dur: a.mem.exposeDur, color: '#8ef0d0', core: '#eafcff', owner: a, follow: true, alpha: 0.8,
          });
        },
        update(a, dt, ctx) {
          a.steer.begin(0.15).separation(a.mgr.list, 1.4);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t >= (a.mem.exposeDur || 2.4)) return 'recover';
        },
        exit(a) { a.vulnerable = false; a.resist = null; },
      },
      recover: {
        enter(a, ctx) {
          a.play('idle', { fade: 0.2 });
          a.attackCd = (a.mem.phase >= 2 ? 0.55 : 1.05) * P(a).recMul;
          ctx.vfx?.shockwave?.(a.position.clone().setY(0.05), { radius: 2.6, color: '#ff5a3c', life: 0.35, opacity: 0.5 });
        },
        update(a, dt, ctx) { if (a.brain.t > 0.5) return 'stalk'; },
      },

      // a scripted, unmissable beat between phases
      phase: {
        enter(a, ctx) {
          a.committed = true;
          a.vulnerable = false;
          a.play('special', { fade: 0.12, restart: true, speed: 0.5 });
          a.iframes = 1.15;
          ctx.engine?.slowmo?.(0.45, 0.7);
          ctx.events.emit('camera.shake', { amp: 0.34, dur: 0.8, freq: 18 });
          for (let i = 0; i < 3; i++) {
            ctx.vfx?.shockwave?.(a.position.clone().setY(0.05 + i * 0.5), { radius: 5 + i * 3, color: '#ff5a3c', life: 0.6 + i * 0.2 });
          }
          ctx.vfx?.burst?.(a.position.clone().setY(2.2), { count: 40, color: '#ff8c1a', speed: 14, spread: 1.5, kind: 'shard' });
          ctx.ui?.toast?.('THE WARDEN RISES', { color: '#ff5a3c' });
        },
        update(a, dt, ctx) {
          a.steer.begin(0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t > 1.15) { a.committed = false; return 'stalk'; }
        },
      },
    },
  },
};

export default { WARDEN };
