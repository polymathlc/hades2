// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// melee.js — the two families that hold ground: SHADE and BRUTE.
//
// SILHOUETTE (the black-shape test, ART_DIRECTION §1.1):
//   SHADE  a THIN vertical needle. Narrow shoulders, no cape, no skirt, one
//          hooked blade held low and away from the leg so the arm cuts a
//          negative-space hole. Reads as "a person" and nothing else.
//   BRUTE  a WALL. Twice the shade's mass, and the read is dominated by a
//          rectangular tower shield carried on the leading arm — a hard
//          straight edge in a roster of organic curves. The shield is the
//          mechanic AND the silhouette: you cannot hit what is behind it, so
//          you flank it or you dash through it.
//
// This file also exports makeMeleeBrain(), the authoring demo for ai.js: a
// flat HSM whose guard clause (`any`) handles interruption once instead of in
// every leaf, and whose commit is gated on an ATTACK TOKEN so a pack of shades
// takes turns instead of dogpiling.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, damp } from '../../core/math.js';
import { TELEGRAPH, inCone } from '../ai.js';
import { charMaterial, paintGeo } from './base.js';
import { tubeGeo, prim } from '../rig.js';

// ═══════════════════════════════════════════════════════════════════════════
// THE REUSABLE MELEE BRAIN
// ═══════════════════════════════════════════════════════════════════════════
/**
 * makeMeleeBrain(o) -> a Brain definition.
 *
 *   o.standoff     ring radius held while waiting for a token
 *   o.range/arc    the committed swing
 *   o.windup       telegraph seconds (from TELEGRAPH; generous, data)
 *   o.strike       seconds from wind-up end to the damage frame
 *   o.recover      seconds of punishable recovery after the swing
 *   o.token        which pool to compete in
 *   o.approachAt   distance at which it stops circling and closes
 */
export function makeMeleeBrain(o = {}) {
  const STANDOFF = o.standoff ?? 3.4;
  const RANGE = o.range ?? 2.35;
  const ARC = o.arc ?? 105;
  const WIND = o.windup ?? TELEGRAPH.lightMelee;
  const STRIKE = o.strike ?? 0.10;
  const RECOVER = o.recover ?? 0.46;
  const TOKEN = o.token || 'melee';
  const COMMIT = o.commitRange ?? (RANGE + 0.55);

  return {
    initial: 'idle',
    // ── the hierarchy: one guard, evaluated before whichever leaf is active ──
    any(a, dt, ctx) {
      if (a.stagger > 0 && a.stateName !== 'hurt' && a.stateName !== 'stunned') {
        if (a.tell.active) a.endTell(false);
        a.committed = false;
        a.dropToken(TOKEN, 0.55);
        return 'hurt';
      }
      if (!ctx.player || ctx.player.alive === false) return a.stateName === 'idle' ? null : 'idle';
    },
    states: {
      idle: {
        enter(a) { a.play('idle', { fade: 0.18 }); },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.35).separation(a.mgr.list, 2.0).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out));
          if (a.perc.aware) return 'approach';
        },
      },

      // close the gap, but only into the standoff RING — the token decides
      // who actually steps inside it
      approach: {
        enter(a) { a.play('run', { fade: 0.14, speed: o.runSpeed ?? 1.05 }); },
        update(a, dt, ctx) {
          const p = a.perc;
          a.steer.begin(a.def.speed)
            .arrive(p.aimX, p.aimZ, STANDOFF * 0.9, 1.0)
            .separation(a.mgr.list, 1.9)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ });
          a.setRunSpeed(o.runSpeed ?? 1.05);
          if (p.dist < STANDOFF * 1.12) return 'circle';
        },
      },

      // the READABLE state: everyone without a token is here, moving laterally
      // at a fixed radius. A ring of circling enemies is what makes the one
      // that steps forward legible.
      circle: {
        enter(a) { a.play('run', { fade: 0.16, speed: 0.86 }); a.mem.circleT = 0; },
        update(a, dt, ctx) {
          const p = a.perc;
          a.mem.circleT += dt;
          // flip direction occasionally so the ring is not a carousel
          if (a.mem.circleT > 2.4) { a.mem.circleT = 0; a.orbitDir *= -1; }
          a.steer.begin(a.def.speed * 0.78)
            .orbit(p.aimX, p.aimZ, STANDOFF, a.orbitDir, 1.0, 0.85)
            .separation(a.mgr.list, 2.1)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 8 });
          a.setRunSpeed(0.86);
          if (p.dist > STANDOFF * 1.9) return 'approach';
          if (a.attackCd <= 0 && a.wantToken(TOKEN, -p.dist)) return 'commit';
        },
      },

      // token in hand: walk into range with intent. Still interruptible.
      commit: {
        enter(a) { a.play('run', { fade: 0.1, speed: 1.22 }); a.mem.commitT = 0; },
        update(a, dt, ctx) {
          const p = a.perc;
          a.mem.commitT += dt;
          a.steer.begin(a.def.speed * 1.12)
            .seek(p.aimX, p.aimZ, 1.0)
            .separation(a.mgr.list, 1.3)
            .avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { faceX: p.dirX, faceZ: p.dirZ, turn: 14 });
          a.setRunSpeed(1.22);
          if (p.dist <= COMMIT) return 'windup';
          if (a.mem.commitT > 2.6 || !a.hasToken(TOKEN)) { a.dropToken(TOKEN); return 'circle'; }
        },
      },

      // THE TELL. Generous, aimed at the LAGGED belief, and drawn on the floor.
      windup: {
        enter(a, ctx) {
          a.committed = true;
          a.play(o.windupClip || 'attack1', { fade: 0.06, restart: true, speed: (a.visual.duration(o.windupClip || 'attack1') || 0.46) / (WIND + STRIKE + 0.18) });
          const p = a.perc;
          a.snapFace(p.dirX, p.dirZ);
          a.telegraph(o.tellKind || 'melee', WIND, {
            shape: o.tellShape || 'arc', radius: RANGE * 1.05, arc: ARC,
            dirX: p.dirX, dirZ: p.dirZ, follow: true, color: a.tellColor,
          });
          if (o.onWindup) o.onWindup(a, ctx);
        },
        update(a, dt, ctx) {
          const p = a.perc;
          // creeps forward during the wind-up: commitment you can see
          a.steer.begin(a.def.speed * (o.windupDrift ?? 0.22)).seek(p.aimX, p.aimZ, 1).separation(a.mgr.list, 1.0);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          a.faceTowards(p.dirX, p.dirZ, dt, o.windupTurn ?? 3.2);
          if (a.tell.k >= 1) return 'strike';
        },
      },

      strike: {
        enter(a, ctx) {
          a.endTell(true);
          a.mem.struck = false;
          if (o.onStrikeStart) o.onStrikeStart(a, ctx);
        },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * (o.lunge ?? 0.9)).seek(a.position.x + a.facing.x, a.position.z + a.facing.z, 1);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false, accel: 60 });
          if (!a.mem.struck && a.brain.t >= STRIKE) {
            a.mem.struck = true;
            a.strikeCone(ctx, {
              range: RANGE, arc: ARC, damage: o.damage ?? 11, knock: o.knock ?? 5.5,
              color: a.tellColor, width: o.slashWidth ?? 0.32, shake: o.shake ?? 0.035,
              type: o.damageType || 'physical',
            });
            if (o.onStrike) o.onStrike(a, ctx);
          }
          if (a.brain.t >= STRIKE + 0.06) return 'recover';
        },
      },

      // the PUNISH window: slow, rooted, still holding the token so nobody
      // else piles in on top of the opening you just earned
      recover: {
        enter(a) { a.play('idle', { fade: 0.14 }); a.committed = false; },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.2).separation(a.mgr.list, 2.2).avoidWalls(ctx);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.brain.t >= RECOVER) {
            a.dropToken(TOKEN);
            a.attackCd = o.cooldown ?? 0.85;
            return 'circle';
          }
        },
      },

      hurt: {
        enter(a) { a.play('hurt', { fade: 0.04, restart: true }); },
        update(a, dt, ctx) {
          a.steer.begin(a.def.speed * 0.12).separation(a.mgr.list, 2.4);
          a.move(dt, ctx, a.steer.resolve(a.mgr.out), { face: false });
          if (a.stagger <= 0) return a.perc.dist < STANDOFF * 1.5 ? 'circle' : 'approach';
        },
      },
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SHADE — the numbers enemy
// ═══════════════════════════════════════════════════════════════════════════
const SHADE_PALETTE = {
  // §9.2: a shade is PALE. A dark wraith on a dark floor is invisible, and the
  // whole point of the basic melee unit is that you always know where it is.
  skin: '#cdbbe6', skinDeep: '#6d5a92',
  hair: '#2a1442', hairTip: '#5a2f86',
  cloth: '#6b2f86', clothDeep: '#2e1040',
  cape: '#2a1442', capeLine: '#8ef0d0',
  metal: '#e0b45a', metalHot: '#ffe0a0', metalDeep: '#6b3f14',
  blade: '#aab4d0', bladeEdge: '#e6ecff',
  leather: '#2b1a3a',
  glow: '#8ef0d0',
};

export const SHADE = {
  kind: 'shade',
  label: 'Wretched Shade',
  role: 'basic melee — arrives in numbers, closes distance, dies fast',
  identity: '#8ef0d0', deathColor: '#8ef0d0', tellColor: '#ff5a3c',
  hp: 46, radius: 0.46, speed: 4.5, accel: 30, turn: 12,
  poise: 12, staggerTime: 0.24, knockResist: 0.1,
  tokenPool: 'melee', threat: 1, cost: 1,
  spec: {
    name: 'erebus.shade', height: 1.88,
    build: { shoulder: 0.84, limb: 0.82, bulk: 0.86 },
    palette: SHADE_PALETTE,
    features: {
      pauldron: 'none', crown: 'none', cape: false, skirt: 0, greaves: false,
      bracers: true, harness: false, hair: 'swept', eyes: true, weapon: 'xiphos',
    },
    glowIntensity: 0.5,
  },
  brain: makeMeleeBrain({
    standoff: 3.3, range: 2.35, arc: 104, windup: TELEGRAPH.lightMelee,
    strike: 0.09, recover: 0.44, cooldown: 0.8, damage: 11, knock: 5.5,
    token: 'melee', runSpeed: 1.12,
  }),
};

// ═══════════════════════════════════════════════════════════════════════════
// BRUTE — the shielded wall
// ═══════════════════════════════════════════════════════════════════════════
const BRUTE_PALETTE = {
  skin: '#d8a074', skinDeep: '#8a4a30',
  hair: '#1d1026', hairTip: '#3a1f4a',
  cloth: '#8c1f2e', clothDeep: '#3d0a14',
  cape: '#2a1020', capeLine: '#f2c14e',
  metal: '#f0bb52', metalHot: '#ffe9a8', metalDeep: '#6d4416',
  blade: '#9aa0b6', bladeEdge: '#e8e2c6',
  leather: '#301d24',
  glow: '#ff8c1a',
};

/**
 * THE TOWER SHIELD.
 *
 * §7 bans "untextured programmer art boxes/cylinders left visible", and the
 * previous build shipped exactly that at the focal centre of the frame: a
 * BoxGeometry(1.34, 1.86, 0.13) painted one flat vertex colour with a
 * SphereGeometry stuck on the front. At 3x it was unmistakably a bevelled cube
 * with a ball on it, and it occupied ~8% of the shipped HUD frame.
 *
 * What replaces it, and why each piece is there:
 *
 *  1. A CHAMFERED PLATE, not a box. ExtrudeGeometry with a real bevel gives
 *     the rim an arris — a narrow 45-degree face that catches the key light
 *     as a bright line all the way round the silhouette. That single lit edge
 *     is what separates a carried object from a rendered primitive; a box has
 *     three flat faces and no transition between them.
 *  2. A DRAWN OUTLINE. The plate is not a rectangle: rounded shoulders, a
 *     waisted middle and a blunt point at the foot, so the silhouette is a
 *     shield rather than a door.
 *  3. A BAKED MATERIAL. `shield.brute` in materials/recipes.js is authored in
 *     FACE SPACE (u,v across the plate), so the meander band, the fillet
 *     frame, the bead ring and the rivets are PLACED ornament cut into the
 *     height and filled with gold — not a tiling swatch and not flat colour.
 *     The UVs are remapped below so that recipe lands where it was authored.
 *  4. RELIEF ON THE UMBO. The boss is a spun profile with a collar and a
 *     ring of proud beads around it, so it reads as a struck bronze umbo at
 *     3x instead of a sphere.
 */
function shieldOutline() {
  const s = new THREE.Shape();
  const W = 0.67, H = 0.93;                 // half extents
  const sh = 0.13;                          // shoulder round
  s.moveTo(-W + sh, H);
  s.lineTo(W - sh, H);
  s.quadraticCurveTo(W, H, W * 1.005, H - sh);
  s.bezierCurveTo(W * 1.02, H * 0.25, W * 0.99, -H * 0.18, W * 0.92, -H * 0.55);
  s.quadraticCurveTo(W * 0.86, -H * 0.86, 0, -H);
  s.quadraticCurveTo(-W * 0.86, -H * 0.86, -W * 0.92, -H * 0.55);
  s.bezierCurveTo(-W * 0.99, -H * 0.18, -W * 1.02, H * 0.25, -W * 1.005, H - sh);
  s.quadraticCurveTo(-W, H, -W + sh, H);
  return s;
}

/** Remap a geometry's UVs so its XY bounding box spans 0..1 — the face-space
 *  the `shield.brute` recipe is authored in. Without this ExtrudeGeometry's
 *  world-unit UVs would put the meander band somewhere off the plate. */
function faceUV(g) {
  g.computeBoundingBox();
  const b = g.boundingBox;
  const sx = 1 / Math.max(1e-4, b.max.x - b.min.x), sy = 1 / Math.max(1e-4, b.max.y - b.min.y);
  const p = g.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) - b.min.x) * sx;
    uv[i * 2 + 1] = (p.getY(i) - b.min.y) * sy;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** A spun umbo: collar, dome, and a nipple — a profile, not a sphere. */
function umboGeo() {
  const pts = [];
  const R = 0.30;
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    // flat collar out to 0.34, then a struck dome that flattens at the crown
    const r = R * (t < 0.22 ? (1 - t / 0.22) * 0.0 + 1.0 : Math.cos((t - 0.22) / 0.78 * Math.PI * 0.5));
    const y = t < 0.22 ? t * 0.10 : 0.022 + Math.sin((t - 0.22) / 0.78 * Math.PI * 0.5) * 0.17;
    pts.push(new THREE.Vector2(Math.max(0.004, r), y));
  }
  const g = new THREE.LatheGeometry(pts, 24);
  g.rotateX(-Math.PI / 2);                 // spin axis onto +Z (out of the face)
  return g;
}

function buildShield(ctx) {
  const group = new THREE.Group();

  // ── 1. the chamfered plate ────────────────────────────────────────────
  const plate = new THREE.ExtrudeGeometry(shieldOutline(), {
    depth: 0.10, bevelEnabled: true, bevelThickness: 0.030, bevelSize: 0.036,
    bevelSegments: 3, curveSegments: 14, steps: 1,
  });
  plate.translate(0, 0, -0.05);
  plate.computeVertexNormals();
  faceUV(plate);
  // a gentle vertical AO in vertex colour under the painted albedo: the plate
  // is carried low and its foot never sees the key.
  paintGeo(plate, '#ffffff', { y0: -1.0, y1: 1.0, aoLow: 0.58, top: '#ffffff' });
  const plateMat = shieldFaceMaterial(ctx);
  const pm = new THREE.Mesh(plate, plateMat);
  pm.castShadow = true; pm.frustumCulled = false;
  group.add(pm);

  // ── 2. the proud metal: rails, umbo, beads ────────────────────────────
  const metalParts = [];
  // top and foot rails — chamfered bars, sitting PROUD of the face so they
  // throw their own contact shadow instead of being a painted stripe
  const railT = new THREE.ExtrudeGeometry(roundedBar(1.30, 0.085), {
    depth: 0.055, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.020, bevelSegments: 2, steps: 1,
  });
  railT.translate(0, 0.845, 0.052);
  const railB = railT.clone(); railB.translate(0, -1.62, 0);
  metalParts.push(railT, railB);
  // the umbo and its collar
  const umbo = umboGeo(); umbo.translate(0, 0.02, 0.055);
  metalParts.push(umbo);
  const collar = new THREE.TorusGeometry(0.335, 0.030, 8, 30);
  collar.translate(0, 0.02, 0.062);
  metalParts.push(collar);
  // a ring of proud beads — the ornament the recipe also draws, in real relief
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const b = new THREE.SphereGeometry(0.037, 8, 6);
    b.scale(1, 1, 0.72);
    b.translate(Math.cos(a) * 0.455, 0.02 + Math.sin(a) * 0.455, 0.048);
    metalParts.push(b);
  }
  // rivets on the quarters
  for (const [rx, ry] of [[-0.44, 0.66], [0.44, 0.66], [-0.44, -0.62], [0.44, -0.62]]) {
    const r = new THREE.SphereGeometry(0.048, 8, 6);
    r.scale(1, 1, 0.62); r.translate(rx, ry, 0.052);
    metalParts.push(r);
  }
  // mergeGeometries refuses a mixed batch: ExtrudeGeometry is NON-indexed while
  // Sphere/Torus/Lathe are indexed, and the mismatch returns null (which would
  // then throw in paintGeo). Normalise everything to non-indexed first.
  const metal = mergeGeometries(metalParts.map((g) => (g.index ? g.toNonIndexed() : g)), false);
  paintGeo(metal, '#c98f2b', { y0: -0.95, y1: 0.95, aoLow: 0.52, top: '#ffe9a8' });
  const mm = new THREE.Mesh(metal, charMaterial(ctx, 'metal', 'brute'));
  mm.castShadow = true; mm.frustumCulled = false;
  group.add(mm);

  group.scale.setScalar(0.92);
  return group;
}

/** a bar with rounded ends, for the shield rails */
function roundedBar(len, thick) {
  const s = new THREE.Shape();
  const hx = len * 0.5, hy = thick * 0.5;
  s.moveTo(-hx + hy, -hy);
  s.lineTo(hx - hy, -hy);
  s.quadraticCurveTo(hx, -hy, hx, 0);
  s.quadraticCurveTo(hx, hy, hx - hy, hy);
  s.lineTo(-hx + hy, hy);
  s.quadraticCurveTo(-hx, hy, -hx, 0);
  s.quadraticCurveTo(-hx, -hy, -hx + hy, -hy);
  return s;
}

/**
 * The plate's material: the baked `shield.brute` recipe (albedo + normal +
 * ORM) through the painterly CHARACTER variant, so it keeps the roster's rim
 * and 3-step ramp while finally carrying real texture. If the library cannot
 * supply it for any reason we fall back to the old painted-vertex-colour path
 * rather than dropping to grey.
 */
function shieldFaceMaterial(ctx) {
  let m = null;
  if (ctx && ctx.mats && ctx.mats.get) {
    m = ctx.mats.get('shield.brute', { variant: 'character', roughness: 1.0, metalness: 1.0, specGain: 0.8 });
  }
  if (!m || !m.map) return charMaterial(ctx, 'cloth', 'brute');
  m.vertexColors = true;
  m.dithering = false;
  m.needsUpdate = true;
  return m;
}

export const BRUTE = {
  kind: 'brute',
  label: 'Bronze Bulwark',
  role: 'shielded — frontal damage is nullified; must be flanked or dashed through',
  identity: '#f2c14e', deathColor: '#ff8c1a', tellColor: '#ffb03c',
  hp: 168, radius: 0.82, speed: 2.9, accel: 16, turn: 4.6,
  poise: 999, staggerTime: 0.14, knockResist: 0.86, crowdPad: 0.35,
  tokenPool: 'heavy', threat: 3, cost: 3,
  deathScale: 1.5, deathShake: 0.11, spawnTime: 0.8,
  spec: {
    name: 'erebus.brute', height: 2.42,
    build: { shoulder: 1.46, limb: 1.14, bulk: 1.42 },
    palette: BRUTE_PALETTE,
    features: {
      pauldron: 'both', crown: 'none', cape: false, skirt: 6, greaves: true,
      bracers: true, harness: true, hair: 'none', eyes: true, weapon: 'xiphos',
    },
    glowIntensity: 0.55,
  },
  onSpawn(a, ctx) {
    if (!a.mem.shieldBuilt) {
      const rig = a.visual.rig;
      const hand = rig && rig.bones && rig.bones.handL;
      if (hand) {
        const sh = buildShield(ctx);
        sh.position.set(0.16, -0.08, 0.30);
        sh.rotation.set(0.16, 0.1, -0.06);
        hand.add(sh);
        a.mem.shield = sh;
      }
      a.mem.shieldBuilt = true;
    }
    a.shielded = true;
  },
  /**
   * THE MECHANIC. Damage arriving inside the shield's frontal arc is reduced to
   * a chip and the hit rings off the bronze — the player is told, loudly, to go
   * around. Dash-through and back-hits land in full.
   */
  onDamaged(a, info, ctx) {
    if (!info.dir) return;
    const facing = (-info.dir.x) * a.facing.x + (-info.dir.z) * a.facing.z;
    if (facing > 0.32) {
      a.mem.blocked = (a.mem.blocked || 0) + 1;
      ctx.vfx?.impact?.(a.position.clone().setY(1.25).addScaledVector(new THREE.Vector3(a.facing.x, 0, a.facing.z), 0.7),
        info.dir, { type: 'physical', scale: 1.15, color: '#ffe9a8' });
      ctx.events.emit('camera.shake', { amp: 0.05, dur: 0.14, freq: 34 });
      ctx.audio?.sfx?.('block', { pos: a.position });
      a.stagger = 0;
    }
  },
  brain: makeMeleeBrain({
    standoff: 3.9, range: 3.0, arc: 118, windup: TELEGRAPH.heavyMelee,
    strike: 0.14, recover: 0.86, cooldown: 1.15, damage: 24, knock: 11,
    token: 'heavy', runSpeed: 0.82, windupClip: 'attack3', windupDrift: 0.4,
    windupTurn: 1.8, lunge: 1.6, slashWidth: 0.5, shake: 0.11, tellKind: 'heavy',
    commitRange: 3.4,
  }),
};

/**
 * THE SHIELD'S DAMAGE GATE. The stub CombatSystem applies damage before any
 * family sees it, so the reduction is applied here, in the manager's
 * pre-damage hook (see enemies/index.js). Returns a multiplier.
 */
export function brutePreDamage(a, info) {
  if (!info.dir) return 1;
  const facing = (-info.dir.x) * a.facing.x + (-info.dir.z) * a.facing.z;
  return facing > 0.32 ? 0.12 : 1;
}

export default { SHADE, BRUTE, makeMeleeBrain, brutePreDamage };
