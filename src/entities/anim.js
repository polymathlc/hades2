// OWNER: AGENT-PLAYER
// ---------------------------------------------------------------------------
// anim.js — procedural animation for the rig built by rig.js.
//
//   * CLIPS authored in code as keyframed bone poses: [{t, b, r:[deg,deg,deg],
//     p:[x,y,z], e:'easeName'}] plus an optional root-motion track.
//   * A base layer with crossfade + ADDITIVE layers (delta from the clip's
//     first frame) so a flinch or a lean rides on top of any locomotion.
//   * PROCEDURAL modifiers: breathing, lean-into-acceleration, head aim.
//   * SPRING-DRIVEN SECONDARY MOTION for cape / skirt / hair — verlet particle
//     chains solved in world space (so inertia is free) and converted back to
//     bone rotations.
//   * Two-bone IK for foot planting on the ground plane.
//
// Bind convention (see rig.js): every bone's bind rotation is IDENTITY, so a
// bone's local axes are the character's axes. +Z is forward, +X is the
// character's LEFT. Therefore, for the spine: rx+ = lean forward, rz+ = lean
// to the character's right, ry = twist. For a hanging limb (arms, thighs):
// rx- = swing forward, rz+ = swing toward +X. Knee/elbow flex: shin rx+,
// forearm rx-.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, lerp, smoothstep, ease, damp, TAU } from '../core/math.js';

const D2R = Math.PI / 180;
const EASE = {
  linear: t => t,
  smooth: smoothstep,
  ...ease,
};

const _e = new THREE.Euler();
const eq = (r) => new THREE.Quaternion().setFromEuler(_e.set(r[0] * D2R, r[1] * D2R, r[2] * D2R, 'YXZ'));
const _kv = new THREE.Vector3();

// ---------------------------------------------------------------------------
// CLIP
// ---------------------------------------------------------------------------

export class Clip {
  constructor(name, dur, keys, o = {}) {
    this.name = name; this.dur = dur; this.keys = keys;
    this.loop = o.loop ?? false;
    this.rootTrack = o.root || null;
    this.events = o.events || null;         // [{t, name}]
    this._compiled = null;
  }
  compile(indexOf, nBones) {
    const map = new Map();
    for (const k of this.keys) {
      const i = indexOf(k.b);
      if (i < 0 || i == null) continue;
      let tr = map.get(i);
      if (!tr) { tr = { i, rot: [], pos: [] }; map.set(i, tr); }
      if (k.r) tr.rot.push({ t: k.t, q: eq(k.r), e: k.e || 'smooth' });
      if (k.p) tr.pos.push({ t: k.t, v: new THREE.Vector3(k.p[0], k.p[1], k.p[2]), e: k.e || 'smooth' });
    }
    for (const tr of map.values()) { tr.rot.sort((a, b) => a.t - b.t); tr.pos.sort((a, b) => a.t - b.t); }
    this._compiled = [...map.values()];
    if (this.rootTrack) this._root = this.rootTrack.map(k => ({ t: k.t, v: new THREE.Vector3(...(k.p || [0, 0, 0])), e: k.e || 'smooth' }));
    return this;
  }
  _seg(list, t) {
    const n = list.length;
    if (!n) return null;
    if (t <= list[0].t) return [list[0], list[0], 0];
    if (t >= list[n - 1].t) return [list[n - 1], list[n - 1], 0];
    let i = 0; while (i < n - 1 && list[i + 1].t < t) i++;
    const a = list[i], b = list[i + 1];
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return [a, b, (EASE[b.e] || smoothstep)(u)];
  }
  /** write this clip's pose at time t into a Pose (bones not touched keep bind) */
  sample(t, pose) {
    if (!this._compiled) return pose;
    const tt = this.loop ? ((t % this.dur) + this.dur) % this.dur : clamp(t, 0, this.dur);
    for (const tr of this._compiled) {
      const i = tr.i;
      const R = this._seg(tr.rot, tt);
      if (R) { pose.q[i].copy(R[0].q); if (R[2] > 0) pose.q[i].slerp(R[1].q, R[2]); pose.mr[i] = 1; }
      // POSITION KEYS ARE OFFSETS FROM BIND, never absolute local positions —
      // authoring absolute bone offsets by hand is how you accidentally drop a
      // pelvis 0.95m into the floor.
      const P = this._seg(tr.pos, tt);
      if (P) {
        _kv.copy(P[0].v); if (P[2] > 0) _kv.lerp(P[1].v, P[2]);
        pose.p[i].add(_kv); pose.mp[i] = 1;
      }
    }
    return pose;
  }
  rootAt(t, out) {
    out.set(0, 0, 0);
    if (!this._root) return out;
    const tt = this.loop ? ((t % this.dur) + this.dur) % this.dur : clamp(t, 0, this.dur);
    const s = this._seg(this._root, tt);
    if (!s) return out;
    out.copy(s[0].v); if (s[2] > 0) out.lerp(s[1].v, s[2]);
    return out;
  }
}

function makePose(n) {
  return {
    q: Array.from({ length: n }, () => new THREE.Quaternion()),
    p: Array.from({ length: n }, () => new THREE.Vector3()),
    mr: new Uint8Array(n), mp: new Uint8Array(n),
  };
}
function resetPose(pose, bind) {
  for (let i = 0; i < pose.q.length; i++) {
    pose.q[i].copy(bind[i].q); pose.p[i].copy(bind[i].p);
    pose.mr[i] = 0; pose.mp[i] = 0;
  }
}
function blendPose(a, b, w, out) {
  for (let i = 0; i < out.q.length; i++) {
    out.q[i].copy(a.q[i]).slerp(b.q[i], w);
    out.p[i].copy(a.p[i]).lerp(b.p[i], w);
  }
}

// ---------------------------------------------------------------------------
// SECONDARY MOTION — verlet chains in WORLD space (inertia comes for free)
// ---------------------------------------------------------------------------

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

export class ClothSolver {
  constructor(rig) {
    this.rig = rig;
    this.chains = rig.chains.map(c => {
      const n = c.list.length;
      return {
        def: c,
        x: Array.from({ length: n + 1 }, () => new THREE.Vector3()),
        px: Array.from({ length: n + 1 }, () => new THREE.Vector3()),
        rest: Array.from({ length: n + 1 }, () => new THREE.Vector3()),
        init: false,
      };
    });
    this.gravity = new THREE.Vector3(0, -9.0, 0);
    this.wind = new THREE.Vector3();
    this.acc = 0;
    this.enabled = true;
    this.weight = 1;
  }
  reset() { for (const c of this.chains) c.init = false; }

  /** must run AFTER the pose has been written and root.updateMatrixWorld() called */
  solve(dt, t) {
    if (!this.enabled) return;
    const rig = this.rig;
    rig.mesh.updateMatrixWorld(true);
    const RQ = _q3.setFromRotationMatrix(_m1.extractRotation(rig.mesh.matrixWorld));
    const RQi = _q2.copy(RQ).invert();
    const FIXED = 1 / 120;
    this.acc = Math.min(this.acc + dt, 0.1);
    let steps = 0;
    while (this.acc >= FIXED && steps < 6) { this.acc -= FIXED; steps++; }

    for (const C of this.chains) {
      const d = C.def, n = d.list.length;
      // ---- rest positions: where the chain would sit with identity locals ---
      const b0 = d.list[0];
      const parent = b0.parent;
      parent.updateMatrixWorld(false);
      const pq = new THREE.Quaternion().setFromRotationMatrix(_m1.extractRotation(parent.matrixWorld));
      C.rest[0].setFromMatrixPosition(parent.matrixWorld).add(_v1.copy(b0.position).applyQuaternion(pq));
      for (let i = 0; i < n; i++) {
        C.rest[i + 1].copy(C.rest[i]).add(_v1.copy(d.axis[i].local).applyQuaternion(pq));
      }
      if (!C.init) {
        for (let i = 0; i <= n; i++) { C.x[i].copy(C.rest[i]); C.px[i].copy(C.rest[i]); }
        C.init = true;
      }
      C.x[0].copy(C.rest[0]); C.px[0].copy(C.rest[0]);

      // ---- verlet ----------------------------------------------------------
      // NOTE: the verlet velocity term must be a CONTRACTION (drag < 1). An
      // earlier version multiplied it by an `inertia` gain > 1, which turns the
      // integrator into an amplifier — the cape reached escape velocity in
      // about a second. Inertia is expressed by LOW stiffness, not by feeding
      // energy back in.
      const drag = Math.exp(-d.damp * FIXED);
      const stiffK = 1 - Math.exp(-d.stiff * FIXED);
      const gy = -d.grav;
      const VMAX = 0.055;                    // metres per substep, hard clamp
      for (let s = 0; s < steps; s++) {
        for (let i = 1; i <= n; i++) {
          const x = C.x[i], px = C.px[i];
          _v1.subVectors(x, px).multiplyScalar(drag);
          const vl = _v1.length();
          if (vl > VMAX) _v1.multiplyScalar(VMAX / vl);
          px.copy(x);
          x.add(_v1);
          x.y += gy * FIXED * FIXED;
          x.addScaledVector(this.wind, FIXED * FIXED);
          x.lerp(C.rest[i], stiffK);
        }
        // distance + angle constraints, root outward
        for (let i = 1; i <= n; i++) {
          const len = d.axis[i - 1].len;
          _v1.subVectors(C.x[i], C.x[i - 1]);
          if (_v1.lengthSq() < 1e-10) _v1.subVectors(C.rest[i], C.rest[i - 1]);
          _v1.normalize();
          _v2.subVectors(C.rest[i], C.rest[i - 1]).normalize();
          const cosMax = Math.cos(d.maxAng);
          const dot = _v1.dot(_v2);
          if (dot < cosMax) {
            // rotate back toward the rest direction until inside the cone
            const k = (cosMax - dot) / (1 - dot + 1e-6);
            _v1.lerp(_v2, clamp01(k * 1.05)).normalize();
          }
          C.x[i].copy(C.x[i - 1]).addScaledVector(_v1, len);
        }
      }

      // ---- chain -> bone rotations ----------------------------------------
      let parentWorldQ = _q1.copy(pq);
      for (let i = 0; i < n; i++) {
        _v1.subVectors(C.x[i + 1], C.x[i]);
        if (_v1.lengthSq() < 1e-10) _v1.copy(d.axis[i].dir).applyQuaternion(RQ);
        _v1.normalize().applyQuaternion(RQi);          // -> rig space
        const Q = new THREE.Quaternion().setFromUnitVectors(d.axis[i].dir, _v1);
        const world = Q.premultiply(RQ);               // Q is now the bone's WORLD quat
        const local = new THREE.Quaternion().copy(parentWorldQ).invert().multiply(world);
        d.list[i].quaternion.copy(local);
        parentWorldQ = _q1.copy(world);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TWO-BONE IK — foot planting on the ground plane
// ---------------------------------------------------------------------------

export class LegIK {
  constructor(rig, side) {
    const S = side;
    this.hip = rig.bones['thigh' + S];
    this.knee = rig.bones['shin' + S];
    this.foot = rig.bones['foot' + S];
    const a = rig.byName.get('thigh' + S), b = rig.byName.get('shin' + S), c = rig.byName.get('foot' + S);
    this.l1 = b.a.distanceTo(a.a);
    this.l2 = c.a.distanceTo(b.a);
    this.bindThigh = b.a.clone().sub(a.a).normalize();
    this.bindShin = c.a.clone().sub(b.a).normalize();
    this.rig = rig;
  }
  /** target is in RIG-LOCAL space; pole points forward (+Z) */
  solve(target_, weight = 1) {
    if (weight <= 0.001) return;
    const rig = this.rig;
    const target = this._t || (this._t = new THREE.Vector3());
    target.copy(target_);
    const inv = _m1.copy(rig.mesh.matrixWorld).invert();
    const hip = (this._h || (this._h = new THREE.Vector3())).setFromMatrixPosition(this.hip.matrixWorld).applyMatrix4(inv);
    _v1.subVectors(target, hip);
    const L = this.l1 + this.l2;
    let d = _v1.length();
    if (d < 1e-4) return;
    const dir = _v1.clone().multiplyScalar(1 / d);
    d = clamp(d, Math.abs(this.l1 - this.l2) + 0.02, L - 0.006);
    const cosA = clamp((this.l1 * this.l1 + d * d - this.l2 * this.l2) / (2 * this.l1 * d), -1, 1);
    const A = Math.acos(cosA);
    const pole = (this._p || (this._p = new THREE.Vector3())).set(0, 0, 1);
    // cross(pole, dir), NOT cross(dir, pole): the sign decides whether the knee
    // bends forward or backward, and backward is a horror.
    const axis = new THREE.Vector3().crossVectors(pole, dir);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();
    const thighDir = dir.clone().applyQuaternion(_q1.setFromAxisAngle(axis, -A));
    const kneePos = hip.clone().addScaledVector(thighDir, this.l1);
    const shinDir = target.clone().sub(kneePos).normalize();

    const qT = new THREE.Quaternion().setFromUnitVectors(this.bindThigh, thighDir);
    const qS = new THREE.Quaternion().setFromUnitVectors(this.bindShin, shinDir);
    // rig-space -> local
    const pq = new THREE.Quaternion().setFromRotationMatrix(_m1.extractRotation(this.hip.parent.matrixWorld));
    const RQ = new THREE.Quaternion().setFromRotationMatrix(_m1.extractRotation(rig.mesh.matrixWorld));
    const pqRig = pq.premultiply(RQ.clone().invert());
    const lT = pqRig.clone().invert().multiply(qT);
    const lS = qT.clone().invert().multiply(qS);
    this.hip.quaternion.slerp(lT, weight);
    this.knee.quaternion.slerp(lS, weight);
    this.hip.updateMatrixWorld(true);
  }
}

// ---------------------------------------------------------------------------
// CLIP LIBRARY — every pose authored in code, degrees, character space.
// ---------------------------------------------------------------------------

const STANCE = {
  pelvis: [0, 5, 2.0], spine1: [2, -2, -1.2], spine2: [2, -3, -1.0], chest: [-3, 12, -1.4],
  neck: [-2, 3, 0], head: [4, 5, 1.5], clavL: [0, 0, 5], clavR: [0, 0, -4],
  // §1.1 SILHOUETTE FIRST. At 8-11deg of abduction the arms are welded to the
  // torso and the figure squints down to a featureless vertical capsule — the
  // xiphos hangs parallel to the leg and merges into it. Hades heroes carve two
  // large negative-space holes with the weapon arm and the cloak so the figure
  // is identifiable mid-action; that costs ~20deg of abduction and ~30deg of
  // wrist swing, and nothing else in this file matters if the read fails.
  armL: [-6, 0, 21], foreL: [-24, 0, -6], handL: [-8, 0, 0],
  armR: [-4, 0, -25], foreR: [-18, 0, 8], handR: [-14, 0, 26],
  thighL: [-6, 0, 4], shinL: [10, 0, 0], footL: [-4, 4, 0],
  thighR: [2, 0, -3], shinR: [3, 0, 0], footR: [-1, -3, 0],
};
/** expand a pose object into keys at time t */
const pose = (t, o, e) => Object.entries(o).map(([b, r]) => ({ t, b, r, e }));
const stance = (t, e) => pose(t, STANCE, e);

export function buildClipData() {
  const C = {};

  // ── IDLE — contrapposto + breath + weight drift ───────────────────────────
  C.idle = new Clip('idle', 2.8, [
    ...stance(0), ...stance(2.8),
    { t: 0, b: 'pelvis', r: [0, 9.0, 4.5], p: [0.022, 0, 0] },
    { t: 1.4, b: 'pelvis', r: [0, 6.4, 3.4], p: [0.012, 0.009, 0] },
    { t: 2.8, b: 'pelvis', r: [0, 9.0, 4.5], p: [0.022, 0, 0] },
    { t: 1.4, b: 'spine2', r: [0.5, -3, -1.0] },
    { t: 1.4, b: 'chest', r: [-6.5, 12, -1.4] },
    { t: 1.4, b: 'neck', r: [-3.5, 3, 0] },
    { t: 1.4, b: 'head', r: [2, 6.5, 1.5] },
    { t: 1.4, b: 'armL', r: [1, 0, 24] },
    { t: 1.4, b: 'armR', r: [2, 0, -29] },
    { t: 1.4, b: 'foreL', r: [-27, 0, -6] },
    { t: 1.4, b: 'foreR', r: [-21, 0, 8] },
    // the weapon hand swings the xiphos ~30deg clear of the leg line so the
    // blade draws its own edge instead of disappearing into the shin
    { t: 0, b: 'handR', r: [-14, 0, 30] },
    { t: 1.4, b: 'handR', r: [-14, 0, 34] },
    { t: 2.8, b: 'handR', r: [-14, 0, 30] },
    { t: 1.4, b: 'thighL', r: [-7.5, 0, 4] },
    { t: 1.4, b: 'shinL', r: [12, 0, 0] },
  ], { loop: true });

  // ── RUN — lean, hip/shoulder counter-rotation, arm counter-swing ──────────
  const RT = [0, 0.145, 0.29, 0.435, 0.58];
  const runKeys = [];
  const rk = (b, arr) => { for (let i = 0; i < 5; i++) runKeys.push({ t: RT[i], b, r: arr[i] }); };
  runKeys.push(
    { t: RT[0], b: 'pelvis', r: [7, 10, 0], p: [0, -0.012, 0] },
    { t: RT[1], b: 'pelvis', r: [7, 0, 0], p: [0, 0.026, 0] },
    { t: RT[2], b: 'pelvis', r: [7, -10, 0], p: [0, -0.012, 0] },
    { t: RT[3], b: 'pelvis', r: [7, 0, 0], p: [0, 0.026, 0] },
    { t: RT[4], b: 'pelvis', r: [7, 10, 0], p: [0, -0.012, 0] },
  );
  rk('spine1', [[6, -5, 0], [6, 0, 0], [6, 5, 0], [6, 0, 0], [6, -5, 0]]);
  rk('spine2', [[5, -7, 2], [5, 0, 0], [5, 7, -2], [5, 0, 0], [5, -7, 2]]);
  rk('chest', [[13, -12, 3], [13, 0, 0], [13, 12, -3], [13, 0, 0], [13, -12, 3]]);
  rk('neck', [[-6, 4, 0], [-6, 0, 0], [-6, -4, 0], [-6, 0, 0], [-6, 4, 0]]);
  rk('head', [[-9, 6, -2], [-9, 0, 0], [-9, -6, 2], [-9, 0, 0], [-9, 6, -2]]);
  rk('clavL', [[0, 0, 5], [0, 0, 2], [0, 0, -1], [0, 0, 2], [0, 0, 5]]);
  rk('clavR', [[0, 0, 1], [0, 0, -2], [0, 0, -5], [0, 0, -2], [0, 0, 1]]);
  rk('thighL', [[-40, 0, 3], [-4, 0, 2], [28, 0, 2], [-30, 0, 4], [-40, 0, 3]]);
  rk('shinL', [[14, 0, 0], [6, 0, 0], [36, 0, 0], [86, 0, 0], [14, 0, 0]]);
  rk('footL', [[-10, 3, 0], [2, 3, 0], [26, 3, 0], [-6, 3, 0], [-10, 3, 0]]);
  rk('thighR', [[28, 0, -2], [-30, 0, -4], [-40, 0, -3], [-4, 0, -2], [28, 0, -2]]);
  rk('shinR', [[36, 0, 0], [86, 0, 0], [14, 0, 0], [6, 0, 0], [36, 0, 0]]);
  rk('footR', [[26, -3, 0], [-6, -3, 0], [-10, -3, 0], [2, -3, 0], [26, -3, 0]]);
  rk('armL', [[26, 0, 9], [-4, 0, 10], [-34, 0, 11], [-4, 0, 10], [26, 0, 9]]);
  rk('foreL', [[-52, 0, -4], [-74, 0, -4], [-92, 0, -4], [-74, 0, -4], [-52, 0, -4]]);
  rk('handL', [[-14, 0, 0], [-14, 0, 0], [-14, 0, 0], [-14, 0, 0], [-14, 0, 0]]);
  rk('armR', [[-34, 0, -11], [-4, 0, -10], [26, 0, -9], [-4, 0, -10], [-34, 0, -11]]);
  rk('foreR', [[-92, 0, 4], [-74, 0, 4], [-52, 0, 4], [-74, 0, 4], [-92, 0, 4]]);
  rk('handR', [[-14, 0, 4], [-14, 0, 4], [-14, 0, 4], [-14, 0, 4], [-14, 0, 4]]);
  C.run = new Clip('run', 0.58, runKeys, { loop: true });

  // ── DASH — anticipation, hard lunge, trailing after-image pose, absorb ────
  C.dash = new Clip('dash', 0.42, [
    ...pose(0, {
      pelvis: [10, 0, 0], spine1: [4, 0, 0], chest: [-6, 0, 0], neck: [-2, 0, 0], head: [-4, 0, 0],
      thighL: [-18, 0, 3], shinL: [30, 0, 0], thighR: [-14, 0, -3], shinR: [26, 0, 0],
      armL: [16, 0, 12], foreL: [-40, 0, 0], armR: [18, 0, -12], foreR: [-36, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.030, 0] },
    ...pose(0.07, {
      pelvis: [26, 0, 0], spine1: [14, 0, 0], spine2: [10, 0, 0], chest: [16, 0, 0], neck: [-14, 0, 0], head: [-18, 0, 0],
      thighL: [-52, 0, 4], shinL: [18, 0, 0], footL: [-14, 0, 0],
      thighR: [36, 0, -4], shinR: [26, 0, 0], footR: [24, 0, 0],
      armL: [52, 0, 16], foreL: [-30, 0, 0], armR: [56, 0, -16], foreR: [-26, 0, 0],
      clavL: [0, 0, -6], clavR: [0, 0, 6],
    }, 'outQuint'),
    { t: 0.07, b: 'pelvis', p: [0, -0.048, 0], e: 'outQuint' },
    ...pose(0.20, {
      pelvis: [22, 0, 0], spine1: [12, 0, 0], chest: [14, 0, 0], head: [-16, 0, 0],
      thighL: [-44, 0, 4], shinL: [26, 0, 0], thighR: [30, 0, -4], shinR: [34, 0, 0],
      armL: [46, 0, 15], armR: [50, 0, -15],
    }),
    { t: 0.20, b: 'pelvis', p: [0, -0.038, 0] },
    ...pose(0.29, {
      pelvis: [8, 0, 0], spine1: [4, 0, 0], chest: [6, 0, 0], head: [-2, 0, 0],
      thighL: [-30, 0, 5], shinL: [46, 0, 0], footL: [-6, 0, 0],
      thighR: [-16, 0, -5], shinR: [38, 0, 0], footR: [-2, 0, 0],
      armL: [-8, 0, 16], foreL: [-52, 0, 0], armR: [-6, 0, -16], foreR: [-48, 0, 0],
      clavL: [0, 0, 4], clavR: [0, 0, -4],
    }, 'outQuad'),
    { t: 0.29, b: 'pelvis', p: [0, -0.075, 0], e: 'outQuad' },
    ...stance(0.42, 'outCubic'),
    { t: 0.42, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── DASH ATTACKS — separate silhouettes, never recycled standing clips ──
  // Low sliding cross-cut: weapon trails during the plant, then draws a broad
  // horizontal line while the legs remain in a recognisable dash stance.
  C.dashSlash = new Clip('dashSlash', 0.36, [
    ...pose(0, {
      pelvis: [24, -18, 2], spine1: [15, -10, 0], chest: [18, -24, -4], head: [-12, 20, 0],
      armR: [-36, 0, -72], foreR: [-62, 0, 18], handR: [-18, 0, 26],
      armL: [38, 0, 32], foreL: [-54, 0, -8], thighL: [-56, 0, 7], shinL: [34, 0, 0],
      thighR: [34, 0, -7], shinR: [26, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.10, -0.08] },
    ...pose(0.085, {
      pelvis: [30, -34, 2], spine1: [18, -22, 0], chest: [24, -42, -6], head: [-14, 34, 0],
      armR: [-52, 0, -96], foreR: [-30, 0, 12], handR: [-8, 0, 34],
      armL: [28, 0, 46], foreL: [-66, 0, -10], thighL: [-64, 0, 8], shinL: [42, 0, 0],
      thighR: [40, 0, -8], shinR: [30, 0, 0],
    }, 'outQuad'),
    { t: 0.085, b: 'pelvis', p: [-0.02, -0.12, -0.10], e: 'outQuad' },
    ...pose(0.155, {
      pelvis: [22, 62, -2], spine1: [14, 38, 0], spine2: [10, 28, 2], chest: [18, 72, 8], head: [-8, -42, 0],
      armR: [-66, 0, 78], foreR: [-8, 0, -8], handR: [2, 0, -26],
      armL: [34, 0, -58], foreL: [-48, 0, 8], thighL: [-48, 0, 8], shinL: [54, 0, 0],
      thighR: [18, 0, -8], shinR: [38, 0, 0],
    }, 'outQuint'),
    { t: 0.155, b: 'pelvis', p: [0.03, -0.095, 0.12], e: 'outQuint' },
    ...pose(0.235, {
      pelvis: [16, 48, 0], chest: [14, 54, 5], head: [-4, -28, 0],
      armR: [-52, 0, 64], foreR: [-22, 0, -4], armL: [22, 0, -42], foreL: [-52, 0, 4],
      thighL: [-36, 0, 6], shinL: [44, 0, 0], thighR: [8, 0, -6], shinR: [34, 0, 0],
    }, 'linear'),
    ...stance(0.36, 'outCubic'),
    { t: 0.36, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // Two-handed driving thrust: the weapon and both shoulders form one long
  // line, with a much lower centre of gravity than either standing spear poke.
  C.dashThrust = new Clip('dashThrust', 0.37, [
    ...pose(0, {
      pelvis: [28, -8, 0], spine1: [18, -5, 0], chest: [24, -10, 0], head: [-16, 10, 0],
      armR: [-62, 0, -42], foreR: [-88, 0, 12], armL: [-58, 0, 34], foreL: [-82, 0, -10],
      thighL: [-62, 0, 6], shinL: [42, 0, 0], thighR: [38, 0, -6], shinR: [28, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.11, -0.12] },
    ...pose(0.09, {
      pelvis: [34, -12, 0], spine1: [22, -8, 0], chest: [30, -16, 0], head: [-18, 18, 0],
      armR: [-78, 0, -54], foreR: [-106, 0, 14], armL: [-72, 0, 46], foreL: [-102, 0, -12],
      thighL: [-70, 0, 7], shinL: [48, 0, 0], thighR: [44, 0, -7], shinR: [30, 0, 0],
    }, 'outQuad'),
    { t: 0.09, b: 'pelvis', p: [0, -0.13, -0.15], e: 'outQuad' },
    ...pose(0.16, {
      pelvis: [30, 4, 0], spine1: [20, 2, 0], chest: [28, 6, 0], head: [-14, -4, 0],
      clavR: [0, 8, -12], armR: [-102, 0, -10], foreR: [-4, 0, 0], handR: [8, 0, 0],
      clavL: [0, 6, 10], armL: [-98, 0, 12], foreL: [-6, 0, 0], handL: [8, 0, 0],
      thighL: [-66, 0, 7], shinL: [56, 0, 0], thighR: [32, 0, -7], shinR: [38, 0, 0],
    }, 'outQuint'),
    { t: 0.16, b: 'pelvis', p: [0, -0.115, 0.16], e: 'outQuint' },
    ...pose(0.245, {
      pelvis: [22, 3, 0], chest: [20, 5, 0], head: [-8, -3, 0],
      armR: [-90, 0, -14], foreR: [-18, 0, 2], armL: [-86, 0, 16], foreL: [-20, 0, -2],
      thighL: [-48, 0, 6], shinL: [46, 0, 0], thighR: [18, 0, -6], shinR: [34, 0, 0],
    }, 'linear'),
    ...stance(0.37, 'outCubic'),
    { t: 0.37, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // Rising Dash Attack for fists/gauntlets: a planted crouch explodes into a
  // full-body uppercut, rather than borrowing the shield-rush pose.
  C.dashUpper = new Clip('dashUpper', 0.34, [
    ...pose(0, {
      pelvis: [30, 18, 0], spine1: [20, 12, 0], chest: [28, 20, 0], head: [-18, -10, 0],
      armR: [24, 0, -42], foreR: [-112, 0, 8], armL: [38, 0, 32], foreL: [-72, 0, -6],
      thighL: [-70, 0, 8], shinL: [70, 0, 0], thighR: [-34, 0, -8], shinR: [56, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.17, -0.08] },
    ...pose(0.085, {
      pelvis: [38, 24, 0], spine1: [25, 16, 0], chest: [34, 30, 0], head: [-22, -16, 0],
      armR: [42, 0, -54], foreR: [-128, 0, 10], armL: [48, 0, 40], foreL: [-82, 0, -8],
      thighL: [-78, 0, 9], shinL: [82, 0, 0], thighR: [-42, 0, -9], shinR: [68, 0, 0],
    }, 'outQuad'),
    { t: 0.085, b: 'pelvis', p: [0, -0.20, -0.10], e: 'outQuad' },
    ...pose(0.155, {
      pelvis: [-12, -8, 0], spine1: [-8, -6, 0], chest: [-24, -12, 0], head: [14, 8, 0],
      armR: [-158, 0, -14], foreR: [-8, 0, 0], handR: [10, 0, 0],
      armL: [-72, 0, 28], foreL: [-30, 0, -4], thighL: [-26, 0, 7], shinL: [38, 0, 0],
      thighR: [22, 0, -7], shinR: [32, 0, 0],
    }, 'outQuint'),
    { t: 0.155, b: 'pelvis', p: [0, 0.06, 0.14], e: 'outQuint' },
    ...pose(0.225, {
      pelvis: [-8, -6, 0], chest: [-18, -10, 0], head: [10, 6, 0],
      armR: [-142, 0, -18], foreR: [-20, 0, 0], armL: [-58, 0, 24], foreL: [-42, 0, -4],
    }, 'linear'),
    ...stance(0.34, 'outCubic'),
    { t: 0.34, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── ATTACK 1 — right-to-left horizontal slash ────────────────────────────
  C.attack1 = new Clip('attack1', 0.46, [
    ...stance(0),
    ...pose(0.11, {
      pelvis: [0, -16, 1], spine1: [2, -9, 0], spine2: [0, -12, 0], chest: [-8, -26, -4], neck: [0, -8, 0], head: [0, -13, 0],
      clavR: [0, -8, -6], armR: [-38, 0, -30], foreR: [-58, 0, 10], handR: [-18, 0, 10],
      clavL: [0, 6, 4], armL: [-10, 0, 20], foreL: [-46, 0, -10],
      thighL: [-4, 0, 4], shinL: [8, 0, 0], thighR: [-8, 0, -4], shinR: [12, 0, 0],
    }, 'outQuad'),
    { t: 0.11, b: 'pelvis', p: [-0.02, -0.018, -0.030], e: 'outQuad' },
    ...pose(0.20, {
      pelvis: [4, 26, 0], spine1: [6, 16, 0], spine2: [4, 13, 2], chest: [8, 26, 6], neck: [0, 8, 0], head: [6, 17, 2],
      clavR: [0, 14, 10], armR: [-58, 0, 54], foreR: [-16, 0, -6], handR: [0, 0, -16],
      clavL: [0, -10, -6], armL: [26, 0, -26], foreL: [-58, 0, 0],
      thighL: [-26, 0, 6], shinL: [22, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -8], shinR: [30, 0, 0], footR: [16, 0, 0],
    }, 'outQuint'),
    { t: 0.20, b: 'pelvis', p: [0.02, -0.012, 0.055], e: 'outQuint' },
    ...pose(0.28, {
      pelvis: [4, 26, 0], spine1: [6, 16, 0], spine2: [4, 13, 2], chest: [8, 26, 6], neck: [0, 8, 0], head: [6, 17, 2],
      clavR: [0, 14, 10], armR: [-58, 0, 54], foreR: [-16, 0, -6], handR: [0, 0, -16],
      clavL: [0, -10, -6], armL: [26, 0, -26], foreL: [-58, 0, 0],
      thighL: [-26, 0, 6], shinL: [22, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -8], shinR: [30, 0, 0], footR: [16, 0, 0],
    }, 'linear'),
    { t: 0.28, b: 'pelvis', p: [0.02, -0.012, 0.055], e: 'linear' },
    ...pose(0.35, {
      pelvis: [2, 19, 1], chest: [4, 21, 4], head: [4, 12, 2],
      armR: [-40, 0, 44], foreR: [-34, 0, 0], armL: [14, 0, -18], foreL: [-48, 0, 0],
      thighL: [-18, 0, 5], shinL: [18, 0, 0], thighR: [10, 0, -6], shinR: [22, 0, 0],
    }, 'outQuad'),
    ...stance(0.46, 'outCubic'),
    { t: 0.46, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.12, p: [0, 0, 0] }, { t: 0.20, p: [0, 0, 0.34], e: 'outQuint' }, { t: 0.46, p: [0, 0, 0.36] }] });

  // ── ATTACK 2 — the backhand return, lower and faster ─────────────────────
  C.attack2 = new Clip('attack2', 0.44, [
    ...stance(0),
    ...pose(0.09, {
      pelvis: [2, 20, 1], spine1: [4, 12, 0], chest: [-4, 26, 5], head: [2, 14, 0],
      clavR: [0, 12, 12], armR: [-64, 0, 58], foreR: [-30, 0, -10], handR: [-6, 0, -12],
      clavL: [0, -8, -4], armL: [18, 0, -22], foreL: [-52, 0, 0],
      thighL: [-8, 0, 4], shinL: [12, 0, 0], thighR: [0, 0, -4], shinR: [8, 0, 0],
    }, 'outQuad'),
    { t: 0.09, b: 'pelvis', p: [0.02, -0.012, -0.02], e: 'outQuad' },
    ...pose(0.18, {
      pelvis: [6, -26, -2], spine1: [8, -16, 0], spine2: [6, -12, -2], chest: [12, -28, -8], neck: [0, -8, 0], head: [8, -18, -2],
      clavR: [0, -14, -12], armR: [-30, 0, -46], foreR: [-22, 0, 8], handR: [-4, 0, 14],
      clavL: [0, 10, 6], armL: [-34, 0, 30], foreL: [-40, 0, -6],
      thighL: [14, 0, 8], shinL: [28, 0, 0], footL: [14, 0, 0],
      thighR: [-28, 0, -6], shinR: [24, 0, 0], footR: [-8, 0, 0],
    }, 'outQuint'),
    { t: 0.18, b: 'pelvis', p: [-0.02, -0.014, 0.05], e: 'outQuint' },
    ...pose(0.26, {
      pelvis: [6, -26, -2], spine1: [8, -16, 0], spine2: [6, -12, -2], chest: [12, -28, -8], neck: [0, -8, 0], head: [8, -18, -2],
      clavR: [0, -14, -12], armR: [-30, 0, -46], foreR: [-22, 0, 8], handR: [-4, 0, 14],
      clavL: [0, 10, 6], armL: [-34, 0, 30], foreL: [-40, 0, -6],
      thighL: [14, 0, 8], shinL: [28, 0, 0], footL: [14, 0, 0],
      thighR: [-28, 0, -6], shinR: [24, 0, 0], footR: [-8, 0, 0],
    }, 'linear'),
    { t: 0.26, b: 'pelvis', p: [-0.02, -0.014, 0.05], e: 'linear' },
    ...pose(0.33, {
      pelvis: [4, -18, -1], chest: [8, -20, -5], head: [6, -12, -1],
      armR: [-32, 0, -34], foreR: [-38, 0, 6], armL: [-20, 0, 22], foreL: [-42, 0, -6],
    }, 'outQuad'),
    ...stance(0.44, 'outCubic'),
    { t: 0.44, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.10, p: [0, 0, 0] }, { t: 0.18, p: [0, 0, 0.30], e: 'outQuint' }, { t: 0.44, p: [0, 0, 0.32] }] });

  // ── ATTACK 3 — overhead finisher, the biggest hold in the combo ──────────
  C.attack3 = new Clip('attack3', 0.68, [
    ...stance(0),
    ...pose(0.17, {
      pelvis: [-9, -7, 1], spine1: [-6, -5, 0], spine2: [-6, -4, 0], chest: [-18, -10, 0], neck: [-6, 0, 0], head: [-15, -4, 0],
      clavR: [0, -4, 16], armR: [-142, 0, -20], foreR: [-34, 0, 0], handR: [-10, 0, 0],
      clavL: [0, 4, 12], armL: [-98, 0, 26], foreL: [-44, 0, 0],
      thighL: [-10, 0, 4], shinL: [16, 0, 0], thighR: [-16, 0, -4], shinR: [24, 0, 0],
    }, 'outQuad'),
    { t: 0.17, b: 'pelvis', p: [0, -0.022, -0.035], e: 'outQuad' },
    ...pose(0.29, {
      pelvis: [32, 0, 0], spine1: [17, 0, 0], spine2: [13, 0, 0], chest: [27, 0, 0], neck: [-9, 0, 0], head: [17, 0, 0],
      clavR: [0, 2, -14], armR: [-14, 0, -8], foreR: [-8, 0, 0], handR: [6, 0, 0],
      clavL: [0, -2, -8], armL: [10, 0, 30], foreL: [-70, 0, 0],
      thighL: [-46, 0, 6], shinL: [56, 0, 0], footL: [-10, 0, 0],
      thighR: [-20, 0, -8], shinR: [64, 0, 0], footR: [10, 0, 0],
    }, 'outQuint'),
    { t: 0.29, b: 'pelvis', p: [0, -0.085, 0.10], e: 'outQuint' },
    ...pose(0.39, {
      pelvis: [32, 0, 0], spine1: [17, 0, 0], spine2: [13, 0, 0], chest: [27, 0, 0], neck: [-9, 0, 0], head: [17, 0, 0],
      clavR: [0, 2, -14], armR: [-14, 0, -8], foreR: [-8, 0, 0], handR: [6, 0, 0],
      clavL: [0, -2, -8], armL: [10, 0, 30], foreL: [-70, 0, 0],
      thighL: [-46, 0, 6], shinL: [56, 0, 0], footL: [-10, 0, 0],
      thighR: [-20, 0, -8], shinR: [64, 0, 0], footR: [10, 0, 0],
    }, 'linear'),
    { t: 0.39, b: 'pelvis', p: [0, -0.085, 0.10], e: 'linear' },
    ...pose(0.52, {
      pelvis: [16, 2, 1], spine1: [8, 0, 0], chest: [12, 4, 0], head: [8, 2, 0],
      armR: [-26, 0, -12], foreR: [-24, 0, 4], armL: [-2, 0, 22], foreL: [-52, 0, 0],
      thighL: [-26, 0, 5], shinL: [34, 0, 0], thighR: [-10, 0, -5], shinR: [30, 0, 0],
    }, 'outQuad'),
    ...stance(0.68, 'outCubic'),
    { t: 0.68, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.18, p: [0, 0, -0.06] }, { t: 0.29, p: [0, 0, 0.56], e: 'outQuint' }, { t: 0.68, p: [0, 0, 0.58] }] });

  // ── SPECIAL — a committed two-handed shove ───────────────────────────────
  C.special = new Clip('special', 0.54, [
    ...stance(0),
    ...pose(0.13, {
      pelvis: [-8, -4, 1], spine1: [-6, 0, 0], chest: [-18, -6, 0], head: [-10, -4, 0],
      armR: [-48, 0, -26], foreR: [-96, 0, 12], handR: [-16, 0, 0],
      armL: [-44, 0, 26], foreL: [-100, 0, -12], handL: [-16, 0, 0],
      thighL: [-6, 0, 5], shinL: [18, 0, 0], thighR: [-16, 0, -5], shinR: [30, 0, 0],
    }, 'outQuad'),
    { t: 0.13, b: 'pelvis', p: [0, -0.045, -0.045], e: 'outQuad' },
    ...pose(0.23, {
      pelvis: [22, 0, 0], spine1: [12, 0, 0], spine2: [10, 0, 0], chest: [20, 0, 0], neck: [-8, 0, 0], head: [10, 0, 0],
      clavL: [0, -10, -10], clavR: [0, 10, 10],
      armR: [-96, 0, -14], foreR: [-10, 0, 0], handR: [10, 0, 0],
      armL: [-94, 0, 14], foreL: [-10, 0, 0], handL: [10, 0, 0],
      thighL: [-52, 0, 6], shinL: [40, 0, 0], footL: [-12, 0, 0],
      thighR: [26, 0, -6], shinR: [30, 0, 0], footR: [22, 0, 0],
    }, 'outQuint'),
    { t: 0.23, b: 'pelvis', p: [0, -0.055, 0.10], e: 'outQuint' },
    ...pose(0.32, {
      pelvis: [22, 0, 0], spine1: [12, 0, 0], spine2: [10, 0, 0], chest: [20, 0, 0], neck: [-8, 0, 0], head: [10, 0, 0],
      clavL: [0, -10, -10], clavR: [0, 10, 10],
      armR: [-96, 0, -14], foreR: [-10, 0, 0], handR: [10, 0, 0],
      armL: [-94, 0, 14], foreL: [-10, 0, 0], handL: [10, 0, 0],
      thighL: [-52, 0, 6], shinL: [40, 0, 0], footL: [-12, 0, 0],
      thighR: [26, 0, -6], shinR: [30, 0, 0], footR: [22, 0, 0],
    }, 'linear'),
    { t: 0.32, b: 'pelvis', p: [0, -0.055, 0.10], e: 'linear' },
    ...stance(0.54, 'outCubic'),
    { t: 0.54, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.14, p: [0, 0, -0.05] }, { t: 0.23, p: [0, 0, 0.46], e: 'outQuint' }, { t: 0.54, p: [0, 0, 0.48] }] });

  // ── CAST — plant, gather, release ────────────────────────────────────────
  C.cast = new Clip('cast', 0.60, [
    ...stance(0),
    ...pose(0.17, {
      pelvis: [-4, -12, 2], spine1: [-4, -8, 0], chest: [-14, -18, -2], neck: [0, -6, 0], head: [-6, -12, 0],
      clavL: [0, -6, 10], armL: [-72, 0, 34], foreL: [-104, 0, -22], handL: [-24, 0, 0],
      armR: [-6, 0, -14], foreR: [-30, 0, 10],
      thighL: [-4, 0, 5], shinL: [12, 0, 0], thighR: [-14, 0, -5], shinR: [26, 0, 0],
    }, 'outQuad'),
    { t: 0.17, b: 'pelvis', p: [-0.01, -0.03, -0.03], e: 'outQuad' },
    ...pose(0.30, {
      pelvis: [10, 12, 0], spine1: [8, 8, 0], spine2: [6, 6, 0], chest: [12, 16, 2], neck: [-4, 4, 0], head: [4, 10, 0],
      clavL: [0, 8, -12], armL: [-104, 0, 10], foreL: [-6, 0, 0], handL: [12, 0, 0],
      armR: [12, 0, -22], foreR: [-46, 0, 12],
      thighL: [-34, 0, 6], shinL: [30, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -6], shinR: [26, 0, 0], footR: [16, 0, 0],
    }, 'outQuint'),
    { t: 0.30, b: 'pelvis', p: [0.01, -0.02, 0.055], e: 'outQuint' },
    ...pose(0.42, {
      pelvis: [10, 12, 0], spine1: [8, 8, 0], spine2: [6, 6, 0], chest: [12, 16, 2], neck: [-4, 4, 0], head: [4, 10, 0],
      clavL: [0, 8, -12], armL: [-104, 0, 10], foreL: [-6, 0, 0], handL: [12, 0, 0],
      armR: [12, 0, -22], foreR: [-46, 0, 12],
      thighL: [-34, 0, 6], shinL: [30, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -6], shinR: [26, 0, 0], footR: [16, 0, 0],
    }, 'linear'),
    { t: 0.42, b: 'pelvis', p: [0.01, -0.02, 0.055], e: 'linear' },
    ...stance(0.60, 'outCubic'),
    { t: 0.60, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── CAST SWEEP — tidal / radiant boons open both arms across the stage ───
  C.castSweep = new Clip('castSweep', 0.60, [
    ...stance(0),
    ...pose(0.16, {
      pelvis: [-8, -22, 2], spine1: [-5, -14, 0], chest: [-12, -28, -2], head: [-5, -18, 1],
      clavL: [0, -10, 12], armL: [-58, 0, 42], foreL: [-94, 0, -18], handL: [-20, 0, 0],
      clavR: [0, 8, -8], armR: [-38, 0, -32], foreR: [-72, 0, 14], handR: [-14, 0, 0],
      thighL: [-8, 0, 6], shinL: [18, 0, 0], thighR: [-18, 0, -5], shinR: [30, 0, 0],
    }, 'outQuad'),
    { t: 0.16, b: 'pelvis', p: [-0.025, -0.045, -0.035], e: 'outQuad' },
    ...pose(0.30, {
      pelvis: [12, 18, 0], spine1: [8, 12, 0], spine2: [6, 10, 0], chest: [14, 28, 1], head: [5, 18, 0],
      clavL: [0, 12, -10], armL: [-88, 0, 30], foreL: [-18, 0, -10], handL: [10, 0, 0],
      clavR: [0, -12, 10], armR: [-90, 0, -28], foreR: [-16, 0, 10], handR: [10, 0, 0],
      thighL: [-34, 0, 7], shinL: [30, 0, 0], thighR: [16, 0, -6], shinR: [26, 0, 0],
    }, 'outQuint'),
    { t: 0.30, b: 'pelvis', p: [0.025, -0.025, 0.07], e: 'outQuint' },
    ...pose(0.43, {
      pelvis: [10, 12, 0], spine1: [7, 8, 0], chest: [10, 18, 0], head: [3, 12, 0],
      armL: [-96, 0, 38], foreL: [-8, 0, -8], armR: [-96, 0, -36], foreR: [-8, 0, 8],
      thighL: [-28, 0, 6], shinL: [28, 0, 0], thighR: [12, 0, -5], shinR: [24, 0, 0],
    }, 'linear'),
    ...stance(0.60, 'outCubic'),
    { t: 0.60, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── CAST RITUAL — chthonic boons gather low, then invoke overhead ────────
  C.castRitual = new Clip('castRitual', 0.68, [
    ...stance(0),
    ...pose(0.20, {
      pelvis: [-15, 0, 2], spine1: [-12, 0, 0], spine2: [-10, 0, 0], chest: [-18, 0, 0], head: [-10, 0, 0],
      clavL: [0, -8, 12], clavR: [0, 8, -12],
      armL: [-46, 0, 36], foreL: [-112, 0, -22], handL: [-26, 0, 0],
      armR: [-46, 0, -36], foreR: [-112, 0, 22], handR: [-26, 0, 0],
      thighL: [-20, 0, 7], shinL: [42, 0, 0], thighR: [-20, 0, -7], shinR: [42, 0, 0],
    }, 'outQuad'),
    { t: 0.20, b: 'pelvis', p: [0, -0.10, -0.035], e: 'outQuad' },
    ...pose(0.34, {
      pelvis: [9, 0, 0], spine1: [8, 0, 0], spine2: [8, 0, 0], chest: [15, 0, 0], neck: [-7, 0, 0], head: [8, 0, 0],
      clavL: [0, 0, -10], clavR: [0, 0, 10],
      armL: [-154, 0, 26], foreL: [-22, 0, -10], handL: [14, 0, 0],
      armR: [-154, 0, -26], foreR: [-22, 0, 10], handR: [14, 0, 0],
      thighL: [-32, 0, 7], shinL: [30, 0, 0], thighR: [12, 0, -7], shinR: [26, 0, 0],
    }, 'outQuint'),
    { t: 0.34, b: 'pelvis', p: [0, -0.035, 0.055], e: 'outQuint' },
    ...pose(0.50, {
      pelvis: [8, 0, 0], spine1: [7, 0, 0], chest: [12, 0, 0], head: [6, 0, 0],
      armL: [-148, 0, 28], foreL: [-18, 0, -10], armR: [-148, 0, -28], foreR: [-18, 0, 10],
      thighL: [-26, 0, 6], shinL: [28, 0, 0], thighR: [10, 0, -6], shinR: [24, 0, 0],
    }, 'linear'),
    ...stance(0.68, 'outCubic'),
    { t: 0.68, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── HURT ─────────────────────────────────────────────────────────────────
  C.hurt = new Clip('hurt', 0.34, [
    ...stance(0),
    ...pose(0.07, {
      pelvis: [-14, 0, 0], spine1: [-10, 0, 0], spine2: [-10, 0, 0], chest: [-26, 4, 0], neck: [-10, 0, 0], head: [-20, 6, 0],
      clavL: [0, 0, 14], clavR: [0, 0, -14],
      armL: [-40, 0, 30], foreL: [-84, 0, 0], armR: [-36, 0, -32], foreR: [-78, 0, 0],
      thighL: [-14, 0, 6], shinL: [30, 0, 0], thighR: [-6, 0, -6], shinR: [22, 0, 0],
    }, 'outQuint'),
    { t: 0.07, b: 'pelvis', p: [0, -0.045, -0.06], e: 'outQuint' },
    ...pose(0.18, {
      pelvis: [-6, 0, 0], chest: [-14, 2, 0], head: [-10, 4, 0],
      armL: [-24, 0, 22], foreL: [-62, 0, 0], armR: [-20, 0, -24], foreR: [-58, 0, 0],
      thighL: [-10, 0, 5], shinL: [20, 0, 0],
    }, 'outQuad'),
    { t: 0.18, b: 'pelvis', p: [0, -0.02, -0.03], e: 'outQuad' },
    ...stance(0.34, 'outCubic'),
    { t: 0.34, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── DEATH — stagger, buckle, slump. Holds the final pose. ────────────────
  C.death = new Clip('death', 1.7, [
    ...stance(0),
    ...pose(0.15, {
      pelvis: [-16, 0, 3], spine1: [-12, 0, 0], chest: [-30, 0, 4], neck: [-12, 0, 0], head: [-26, 0, 4],
      clavL: [0, 0, 18], clavR: [0, 0, -18],
      armL: [-52, 0, 34], foreL: [-40, 0, 0], armR: [-48, 0, -36], foreR: [-36, 0, 0],
      thighL: [-16, 0, 7], shinL: [26, 0, 0], thighR: [-6, 0, -7], shinR: [18, 0, 0],
    }, 'outQuint'),
    { t: 0.15, b: 'pelvis', p: [0, -0.05, -0.07], e: 'outQuint' },
    ...pose(0.45, {
      pelvis: [-4, -6, 6], spine1: [4, -4, 3], chest: [10, -8, 6], neck: [4, 0, 0], head: [8, -6, 4],
      armL: [-14, 0, 26], foreL: [-58, 0, 0], armR: [-10, 0, -28], foreR: [-50, 0, 0],
      thighL: [-44, 0, 8], shinL: [66, 0, 0], footL: [-16, 0, 0],
      thighR: [-34, 0, -8], shinR: [58, 0, 0], footR: [-12, 0, 0],
    }, 'outQuad'),
    { t: 0.45, b: 'pelvis', p: [0, -0.21, -0.02], e: 'outQuad' },
    ...pose(0.9, {
      pelvis: [10, -8, 8], spine1: [10, -5, 4], spine2: [10, -4, 4], chest: [22, -10, 8], neck: [6, 0, 0], head: [14, -8, 6],
      armL: [-6, 0, 22], foreL: [-46, 0, 0], armR: [-4, 0, -24], foreR: [-40, 0, 0],
      thighL: [-82, 0, 9], shinL: [104, 0, 0], footL: [24, 0, 0],
      thighR: [-76, 0, -9], shinR: [100, 0, 0], footR: [22, 0, 0],
    }, 'outQuad'),
    { t: 0.9, b: 'pelvis', p: [0, -0.47, 0.04], e: 'outQuad' },
    ...pose(1.7, {
      pelvis: [24, -10, 10], spine1: [18, -6, 5], spine2: [16, -5, 5], chest: [40, -12, 10], neck: [10, 0, 0], head: [30, -10, 8],
      clavL: [0, 0, -8], clavR: [0, 0, 8],
      armL: [-16, 0, 14], foreL: [-30, 0, 0], armR: [-12, 0, -16], foreR: [-26, 0, 0],
      thighL: [-92, 0, 10], shinL: [116, 0, 0], footL: [28, 0, 0],
      thighR: [-88, 0, -10], shinR: [112, 0, 0], footR: [26, 0, 0],
    }, 'outCubic'),
    { t: 1.7, b: 'pelvis', p: [0, -0.60, 0.11], e: 'outCubic' },
  ]);

  // ── LAND — an additive squash (frame 0 is the neutral delta) ─────────────
  C.land = new Clip('land', 0.32, [
    ...pose(0, { pelvis: [0, 0, 0], chest: [0, 0, 0], thighL: [0, 0, 0], thighR: [0, 0, 0], shinL: [0, 0, 0], shinR: [0, 0, 0], footL: [0, 0, 0], footR: [0, 0, 0] }),
    { t: 0, b: 'pelvis', p: [0, 0, 0] },
    ...pose(0.06, { pelvis: [6, 0, 0], chest: [8, 0, 0], thighL: [-26, 0, 0], thighR: [-22, 0, 0], shinL: [42, 0, 0], shinR: [38, 0, 0], footL: [-10, 0, 0], footR: [-8, 0, 0] }, 'outQuint'),
    { t: 0.06, b: 'pelvis', p: [0, -0.085, 0], e: 'outQuint' },
    ...pose(0.32, { pelvis: [0, 0, 0], chest: [0, 0, 0], thighL: [0, 0, 0], thighR: [0, 0, 0], shinL: [0, 0, 0], shinR: [0, 0, 0], footL: [0, 0, 0], footR: [0, 0, 0] }, 'outElastic'),
    { t: 0.32, b: 'pelvis', p: [0, 0, 0], e: 'outElastic' },
  ]);


  // ═══════════════════════════════════════════════════════════════════════
  // ARSENAL CLIPS — one pose language per weapon (§1.1 silhouette first).
  //
  // These are authored at a NOMINAL duration; player.js time-scales each clip
  // onto the weapon runtime's own step timeline (speed = clip.dur / step.dur),
  // so a designer retuning weapons.js retimes the animation for free and a
  // spear poke can never play at a blade's rhythm. That is the whole reason
  // the clips below carry NO root-motion track: the WeaponRuntime owns root
  // motion, and a clip that also translated would double every lunge.
  //
  // Every strike is authored as anticipation -> commit -> hold -> settle at
  // roughly (0.33, 0.48, 0.62, 1.0) of the clip so the time-scaling lands the
  // commit inside the runtime's ACTIVE window whatever the weapon's numbers.
  // ═══════════════════════════════════════════════════════════════════════

  // ── SPEAR: THRUST 1 — two-handed stab. The hitbox is a LINE, so the pose
  //    has to be a line: both hands on the shaft, shoulders square behind it.
  C.thrust1 = new Clip('thrust1', 0.405, [
    ...stance(0),
    ...pose(0.135, {
      pelvis: [-4, -14, 1], spine1: [-4, -9, 0], spine2: [-3, -8, 0], chest: [-12, -20, -2], neck: [0, 14, 0], head: [-4, 30, 0],
      clavR: [0, -6, 6], armR: [-16, 0, -34], foreR: [-104, 0, 16], handR: [-12, 0, 8],
      clavL: [0, -4, 4], armL: [-30, 0, 26], foreL: [-96, 0, -14], handL: [-10, 0, 0],
      thighL: [-6, 0, 5], shinL: [14, 0, 0], thighR: [12, 0, -5], shinR: [32, 0, 0], footR: [10, 0, 0],
    }, 'outQuad'),
    { t: 0.135, b: 'pelvis', p: [0, -0.030, -0.055], e: 'outQuad' },
    ...pose(0.195, {
      pelvis: [18, 6, 0], spine1: [10, 4, 0], spine2: [8, 3, 0], chest: [14, 8, 0], neck: [-4, 0, 0], head: [6, 2, 0],
      clavR: [0, 8, -10], armR: [-88, 0, -12], foreR: [-8, 0, 2], handR: [2, 0, 0],
      clavL: [0, 6, 8], armL: [-84, 0, 14], foreL: [-14, 0, -2], handL: [2, 0, 0],
      thighL: [-50, 0, 6], shinL: [24, 0, 0], footL: [-12, 0, 0],
      thighR: [28, 0, -6], shinR: [24, 0, 0], footR: [22, 0, 0],
    }, 'outQuint'),
    { t: 0.195, b: 'pelvis', p: [0, -0.055, 0.115], e: 'outQuint' },
    ...pose(0.255, {
      pelvis: [18, 6, 0], spine1: [10, 4, 0], spine2: [8, 3, 0], chest: [14, 8, 0], neck: [-4, 0, 0], head: [6, 2, 0],
      clavR: [0, 8, -10], armR: [-88, 0, -12], foreR: [-8, 0, 2], handR: [2, 0, 0],
      clavL: [0, 6, 8], armL: [-84, 0, 14], foreL: [-14, 0, -2], handL: [2, 0, 0],
      thighL: [-50, 0, 6], shinL: [24, 0, 0], footL: [-12, 0, 0],
      thighR: [28, 0, -6], shinR: [24, 0, 0], footR: [22, 0, 0],
    }, 'linear'),
    { t: 0.255, b: 'pelvis', p: [0, -0.055, 0.115], e: 'linear' },
    ...pose(0.315, {
      pelvis: [10, 3, 1], chest: [8, 5, 0], head: [4, 2, 0],
      armR: [-52, 0, -22], foreR: [-46, 0, 8], armL: [-50, 0, 20], foreL: [-52, 0, -6],
      thighL: [-26, 0, 5], shinL: [20, 0, 0], thighR: [10, 0, -5], shinR: [22, 0, 0],
    }, 'outQuad'),
    ...stance(0.405, 'outCubic'),
    { t: 0.405, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── SPEAR: THRUST 2 — the low return poke, shorter windup, dropped line.
  C.thrust2 = new Clip('thrust2', 0.375, [
    ...stance(0),
    ...pose(0.115, {
      pelvis: [4, -10, -2], spine1: [2, -7, 0], chest: [-6, -16, -4], neck: [0, 12, 0], head: [-2, 22, 0],
      clavR: [0, -4, 2], armR: [-8, 0, -30], foreR: [-96, 0, 20], handR: [-10, 0, 10],
      clavL: [0, -2, 0], armL: [-20, 0, 24], foreL: [-88, 0, -16],
      thighL: [-2, 0, 5], shinL: [10, 0, 0], thighR: [8, 0, -5], shinR: [26, 0, 0],
    }, 'outQuad'),
    { t: 0.115, b: 'pelvis', p: [0, -0.042, -0.040], e: 'outQuad' },
    ...pose(0.175, {
      pelvis: [24, 4, -1], spine1: [13, 3, 0], spine2: [10, 2, 0], chest: [18, 6, -2], neck: [-6, 0, 0], head: [8, 0, 0],
      clavR: [0, 6, -12], armR: [-76, 0, -14], foreR: [-6, 0, 2], handR: [4, 0, 0],
      clavL: [0, 4, 6], armL: [-72, 0, 16], foreL: [-12, 0, -2],
      thighL: [-58, 0, 6], shinL: [30, 0, 0], footL: [-14, 0, 0],
      thighR: [32, 0, -6], shinR: [22, 0, 0], footR: [24, 0, 0],
    }, 'outQuint'),
    { t: 0.175, b: 'pelvis', p: [0, -0.085, 0.120], e: 'outQuint' },
    ...pose(0.235, {
      pelvis: [24, 4, -1], spine1: [13, 3, 0], spine2: [10, 2, 0], chest: [18, 6, -2], neck: [-6, 0, 0], head: [8, 0, 0],
      clavR: [0, 6, -12], armR: [-76, 0, -14], foreR: [-6, 0, 2], handR: [4, 0, 0],
      clavL: [0, 4, 6], armL: [-72, 0, 16], foreL: [-12, 0, -2],
      thighL: [-58, 0, 6], shinL: [30, 0, 0], footL: [-14, 0, 0],
      thighR: [32, 0, -6], shinR: [22, 0, 0], footR: [24, 0, 0],
    }, 'linear'),
    { t: 0.235, b: 'pelvis', p: [0, -0.085, 0.120], e: 'linear' },
    ...stance(0.375, 'outCubic'),
    { t: 0.375, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── SPEAR: SPIN — a 360 sweep read entirely in the SPINE. The root never
  //    rotates (facing is gameplay state), so the whip has to live in the
  //    pelvis/chest counter-rotation and two horizontally extended arms.
  C.spin = new Clip('spin', 0.615, [
    ...stance(0),
    ...pose(0.200, {
      pelvis: [-2, -30, 2], spine1: [-2, -18, 0], spine2: [-2, -15, 0], chest: [-10, -30, -4], neck: [0, 22, 0], head: [-4, 40, 0],
      clavR: [0, -10, -6], armR: [-24, 0, -62], foreR: [-56, 0, 6], handR: [-10, 0, 12],
      clavL: [0, 8, 10], armL: [-12, 0, 48], foreL: [-70, 0, -8],
      thighL: [-14, 0, 7], shinL: [26, 0, 0], thighR: [-4, 0, -7], shinR: [20, 0, 0],
    }, 'outQuad'),
    { t: 0.200, b: 'pelvis', p: [0, -0.050, -0.020], e: 'outQuad' },
    ...pose(0.295, {
      pelvis: [8, 55, 0], spine1: [6, 30, 0], spine2: [5, 26, 0], chest: [12, 48, 2], neck: [-2, -18, 0], head: [6, -34, 0],
      clavR: [0, 16, 12], armR: [-4, 0, -86], foreR: [-6, 0, 4], handR: [0, 0, -14],
      clavL: [0, -14, -10], armL: [-2, 0, 82], foreL: [-8, 0, -4],
      thighL: [-14, 0, 16], shinL: [18, 0, 0], footL: [-6, 0, 0],
      thighR: [-8, 0, -18], shinR: [16, 0, 0], footR: [-2, 0, 0],
    }, 'outQuint'),
    { t: 0.295, b: 'pelvis', p: [0, -0.070, 0.045], e: 'outQuint' },
    ...pose(0.385, {
      pelvis: [6, 70, 0], spine1: [5, 38, 0], spine2: [4, 32, 0], chest: [9, 62, 2], neck: [-2, -26, 0], head: [4, -46, 0],
      clavR: [0, 16, 12], armR: [-8, 0, -80], foreR: [-14, 0, 4], handR: [0, 0, -12],
      clavL: [0, -14, -10], armL: [-6, 0, 76], foreL: [-16, 0, -4],
      thighL: [-12, 0, 14], shinL: [20, 0, 0], thighR: [-6, 0, -16], shinR: [18, 0, 0],
    }, 'linear'),
    { t: 0.385, b: 'pelvis', p: [0, -0.060, 0.030], e: 'linear' },
    ...pose(0.480, {
      pelvis: [4, 26, 1], spine1: [3, 14, 0], chest: [6, 22, 1], neck: [0, -12, 0], head: [2, -22, 0],
      armR: [-20, 0, -50], foreR: [-40, 0, 6], armL: [-16, 0, 46], foreL: [-44, 0, -6],
      thighL: [-14, 0, 8], shinL: [22, 0, 0], thighR: [-4, 0, -8], shinR: [18, 0, 0],
    }, 'outQuad'),
    ...stance(0.615, 'outCubic'),
    { t: 0.615, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── SPEAR: THROW WIND — overhead cock. Non-looping, so it HOLDS its final
  //    pose for as long as the charge is held. Right shoulder driven back
  //    (negative chest yaw), left arm out at the target: a javelin silhouette.
  C.throwWind = new Clip('throwWind', 0.50, [
    ...stance(0),
    ...pose(0.16, {
      pelvis: [-4, -8, 2], spine1: [-4, -6, 0], chest: [-14, -14, -2], neck: [0, 10, 0], head: [-6, 20, 0],
      clavR: [0, -4, 12], armR: [-96, 0, -24], foreR: [-70, 0, 6], handR: [-10, 0, 0],
      clavL: [0, -2, 8], armL: [-46, 0, 30], foreL: [-56, 0, -10],
      thighL: [-6, 0, 5], shinL: [14, 0, 0], thighR: [4, 0, -5], shinR: [24, 0, 0],
    }, 'outQuad'),
    { t: 0.16, b: 'pelvis', p: [0, -0.028, -0.045], e: 'outQuad' },
    ...pose(0.50, {
      pelvis: [-8, -18, 3], spine1: [-6, -12, 0], spine2: [-6, -10, 0], chest: [-20, -20, -3], neck: [0, 22, 0], head: [-8, 40, 0],
      clavR: [0, -8, 20], armR: [-152, 0, -26], foreR: [-48, 0, 4], handR: [-6, 0, 0],
      clavL: [0, 4, 12], armL: [-78, 0, 30], foreL: [-20, 0, -8], handL: [-6, 0, 0],
      thighL: [-14, 0, 6], shinL: [20, 0, 0], footL: [-4, 4, 0],
      thighR: [12, 0, -6], shinR: [40, 0, 0], footR: [14, -3, 0],
    }, 'outCubic'),
    { t: 0.50, b: 'pelvis', p: [0, -0.060, -0.085], e: 'outCubic' },
  ]);

  // ── SPEAR: THROW — the whip-through. Starts ON the cocked pose so the
  //    release reads as one continuous action, not a cut.
  C.throw = new Clip('throw', 0.33, [
    ...pose(0, {
      pelvis: [-8, -18, 3], spine1: [-6, -12, 0], spine2: [-6, -10, 0], chest: [-20, -20, -3], neck: [0, 22, 0], head: [-8, 40, 0],
      clavR: [0, -8, 20], armR: [-152, 0, -26], foreR: [-48, 0, 4], handR: [-6, 0, 0],
      clavL: [0, 4, 12], armL: [-78, 0, 30], foreL: [-20, 0, -8], handL: [-6, 0, 0],
      thighL: [-14, 0, 6], shinL: [20, 0, 0], thighR: [12, 0, -6], shinR: [40, 0, 0],
    }),
    { t: 0, b: 'pelvis', p: [0, -0.060, -0.085] },
    ...pose(0.095, {
      pelvis: [22, 18, -2], spine1: [13, 12, 0], spine2: [11, 10, 0], chest: [24, 20, 4], neck: [-6, -16, 0], head: [10, -30, 0],
      clavR: [0, 12, -16], armR: [-34, 0, -12], foreR: [-12, 0, 0], handR: [8, 0, 0],
      clavL: [0, -8, -8], armL: [24, 0, -26], foreL: [-58, 0, 4],
      thighL: [-52, 0, 6], shinL: [34, 0, 0], footL: [-12, 0, 0],
      thighR: [30, 0, -6], shinR: [26, 0, 0], footR: [22, 0, 0],
    }, 'outQuint'),
    { t: 0.095, b: 'pelvis', p: [0, -0.070, 0.120], e: 'outQuint' },
    ...pose(0.17, {
      pelvis: [18, 14, -1], chest: [20, 16, 3], neck: [0, -12, 0], head: [8, -22, 0],
      armR: [-28, 0, -20], foreR: [-30, 0, 4], armL: [8, 0, -18], foreL: [-52, 0, 4],
      thighL: [-38, 0, 6], shinL: [30, 0, 0], thighR: [18, 0, -6], shinR: [26, 0, 0],
    }, 'outQuad'),
    ...stance(0.33, 'outCubic'),
    { t: 0.33, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── BOW: DRAW — a real archer's blade. The left shoulder leads the target
  //    (negative chest yaw), the head counter-yaws so the eye stays on the
  //    line, the right elbow rides HIGH. Holds at full draw.
  C.draw = new Clip('draw', 0.55, [
    ...stance(0),
    ...pose(0.18, {
      pelvis: [0, -10, 2], spine1: [0, -7, 0], chest: [-6, -16, -1], neck: [0, 12, 0], head: [-2, 22, 0],
      clavL: [0, 2, 14], armL: [-54, 0, 26], foreL: [-56, 0, -8], handL: [-10, 0, 0],
      clavR: [0, -4, -6], armR: [-26, 0, -32], foreR: [-72, 0, 14], handR: [-10, 0, 12],
      thighL: [-10, 0, 6], shinL: [18, 0, 0], thighR: [0, 0, -6], shinR: [14, 0, 0],
    }, 'outQuad'),
    { t: 0.18, b: 'pelvis', p: [0, -0.022, -0.010], e: 'outQuad' },
    ...pose(0.55, {
      pelvis: [2, -22, 2], spine1: [1, -14, 0], spine2: [1, -12, 0], chest: [-4, -26, -1], neck: [-1, 28, 0], head: [2, 46, 0],
      clavL: [0, 8, 8], armL: [-86, 0, 12], foreL: [-6, 0, -2], handL: [-2, 0, 0],
      clavR: [0, -10, -16], armR: [-58, 0, -54], foreR: [-120, 0, 18], handR: [-4, 0, 14],
      thighL: [-18, 0, 7], shinL: [20, 0, 0], footL: [-4, 4, 0],
      thighR: [8, 0, -9], shinR: [16, 0, 0], footR: [2, -8, 0],
    }, 'outCubic'),
    { t: 0.55, b: 'pelvis', p: [0, -0.048, -0.020], e: 'outCubic' },
  ]);

  // ── BOW: LOOSE — the release. Starts on the full-draw pose; the string
  //    hand snaps open and back past the ear, the bow arm holds the line.
  C.loose = new Clip('loose', 0.28, [
    ...pose(0, {
      pelvis: [2, -22, 2], spine1: [1, -14, 0], spine2: [1, -12, 0], chest: [-4, -26, -1], neck: [-1, 28, 0], head: [2, 46, 0],
      clavL: [0, 8, 8], armL: [-86, 0, 12], foreL: [-6, 0, -2], handL: [-2, 0, 0],
      clavR: [0, -10, -16], armR: [-58, 0, -54], foreR: [-120, 0, 18], handR: [-4, 0, 14],
      thighL: [-18, 0, 7], shinL: [20, 0, 0], thighR: [8, 0, -9], shinR: [16, 0, 0],
    }),
    { t: 0, b: 'pelvis', p: [0, -0.048, -0.020] },
    ...pose(0.055, {
      pelvis: [2, -16, 2], spine1: [1, -10, 0], chest: [-2, -18, -1], neck: [-1, 20, 0], head: [2, 34, 0],
      clavL: [0, 6, 6], armL: [-90, 0, 14], foreL: [-10, 0, -2],
      clavR: [0, -12, -20], armR: [-44, 0, -72], foreR: [-64, 0, 26], handR: [-22, 0, 30],
      thighL: [-16, 0, 7], shinL: [18, 0, 0], thighR: [6, 0, -9], shinR: [14, 0, 0],
    }, 'outQuint'),
    ...pose(0.14, {
      pelvis: [1, -12, 2], chest: [-2, -14, -1], neck: [0, 16, 0], head: [2, 26, 0],
      armL: [-76, 0, 16], foreL: [-24, 0, -2], armR: [-32, 0, -60], foreR: [-56, 0, 20], handR: [-18, 0, 24],
    }, 'outQuad'),
    ...stance(0.28, 'outCubic'),
    { t: 0.28, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── SHIELD: BASH 1 — the shield arm (LEFT) drives; the sword arm stays
  //    cocked low behind so the silhouette keeps its two negative-space holes.
  C.bash1 = new Clip('bash1', 0.405, [
    ...stance(0),
    ...pose(0.12, {
      pelvis: [-2, 16, 2], spine1: [-2, 10, 0], chest: [-10, 22, 4], neck: [0, -14, 0], head: [-4, -26, 0],
      clavL: [0, -8, 8], armL: [-32, 0, 34], foreL: [-98, 0, -16], handL: [-14, 0, 0],
      clavR: [0, 4, -4], armR: [-4, 0, -30], foreR: [-52, 0, 12],
      thighL: [-2, 0, 5], shinL: [12, 0, 0], thighR: [10, 0, -5], shinR: [28, 0, 0],
    }, 'outQuad'),
    { t: 0.12, b: 'pelvis', p: [0, -0.032, -0.050], e: 'outQuad' },
    ...pose(0.185, {
      pelvis: [20, -18, -1], spine1: [11, -12, 0], spine2: [9, -10, 0], chest: [16, -22, -5], neck: [-4, 22, 0], head: [8, 34, 0],
      clavL: [0, 12, -10], armL: [-94, 0, 10], foreL: [-18, 0, -4], handL: [-4, 0, 0],
      clavR: [0, -6, 6], armR: [-10, 0, -36], foreR: [-62, 0, 14],
      thighL: [-46, 0, 6], shinL: [26, 0, 0], footL: [-10, 0, 0],
      thighR: [24, 0, -6], shinR: [26, 0, 0], footR: [20, 0, 0],
    }, 'outQuint'),
    { t: 0.185, b: 'pelvis', p: [0, -0.058, 0.100], e: 'outQuint' },
    ...pose(0.255, {
      pelvis: [20, -18, -1], spine1: [11, -12, 0], spine2: [9, -10, 0], chest: [16, -22, -5], neck: [-4, 22, 0], head: [8, 34, 0],
      clavL: [0, 12, -10], armL: [-94, 0, 10], foreL: [-18, 0, -4], handL: [-4, 0, 0],
      clavR: [0, -6, 6], armR: [-10, 0, -36], foreR: [-62, 0, 14],
      thighL: [-46, 0, 6], shinL: [26, 0, 0], footL: [-10, 0, 0],
      thighR: [24, 0, -6], shinR: [26, 0, 0], footR: [20, 0, 0],
    }, 'linear'),
    { t: 0.255, b: 'pelvis', p: [0, -0.058, 0.100], e: 'linear' },
    ...stance(0.405, 'outCubic'),
    { t: 0.405, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── SHIELD: BASH 2 — the shoulder-check. Whole body behind the boss of the
  //    shield, both feet leave the line, the biggest hold in the arm's kit.
  C.bash2 = new Clip('bash2', 0.505, [
    ...stance(0),
    ...pose(0.14, {
      pelvis: [-10, 22, 3], spine1: [-8, 14, 0], spine2: [-7, 12, 0], chest: [-22, 30, 6], neck: [-2, -22, 0], head: [-10, -44, 0],
      clavL: [0, -10, 12], armL: [-40, 0, 38], foreL: [-104, 0, -18], handL: [-16, 0, 0],
      clavR: [0, 6, -6], armR: [-2, 0, -34], foreR: [-46, 0, 14],
      thighL: [-4, 0, 5], shinL: [16, 0, 0], thighR: [16, 0, -5], shinR: [38, 0, 0], footR: [14, 0, 0],
    }, 'outQuad'),
    { t: 0.14, b: 'pelvis', p: [0, -0.062, -0.080], e: 'outQuad' },
    ...pose(0.215, {
      pelvis: [32, -24, -2], spine1: [17, -15, 0], spine2: [14, -13, 0], chest: [28, -30, -7], neck: [-8, 30, 0], head: [14, 46, 0],
      clavL: [0, 16, -14], armL: [-104, 0, 8], foreL: [-14, 0, -4], handL: [-2, 0, 0],
      clavR: [0, -8, 8], armR: [-6, 0, -44], foreR: [-70, 0, 18],
      thighL: [-58, 0, 6], shinL: [32, 0, 0], footL: [-14, 0, 0],
      thighR: [34, 0, -6], shinR: [30, 0, 0], footR: [26, 0, 0],
    }, 'outQuint'),
    { t: 0.215, b: 'pelvis', p: [0, -0.092, 0.150], e: 'outQuint' },
    ...pose(0.305, {
      pelvis: [32, -24, -2], spine1: [17, -15, 0], spine2: [14, -13, 0], chest: [28, -30, -7], neck: [-8, 30, 0], head: [14, 46, 0],
      clavL: [0, 16, -14], armL: [-104, 0, 8], foreL: [-14, 0, -4], handL: [-2, 0, 0],
      clavR: [0, -8, 8], armR: [-6, 0, -44], foreR: [-70, 0, 18],
      thighL: [-58, 0, 6], shinL: [32, 0, 0], footL: [-14, 0, 0],
      thighR: [34, 0, -6], shinR: [30, 0, 0], footR: [26, 0, 0],
    }, 'linear'),
    { t: 0.305, b: 'pelvis', p: [0, -0.092, 0.150], e: 'linear' },
    ...pose(0.39, {
      pelvis: [18, -12, -1], chest: [16, -16, -4], neck: [0, 12, 0], head: [8, 20, 0],
      armL: [-64, 0, 20], foreL: [-52, 0, -8], armR: [-4, 0, -32], foreR: [-58, 0, 14],
      thighL: [-32, 0, 6], shinL: [26, 0, 0], thighR: [16, 0, -6], shinR: [26, 0, 0],
    }, 'outQuad'),
    ...stance(0.505, 'outCubic'),
    { t: 0.505, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  // ── SHIELD: GUARD — the block stance. LOOPS with a braced tremor so a held
  //    guard is alive rather than frozen. Chin behind the rim, weight low and
  //    forward, sword arm cocked back: readable as "I am absorbing this".
  C.guard = new Clip('guard', 1.30, [
    ...pose(0, {
      pelvis: [10, 6, 3], spine1: [7, 4, -1], spine2: [7, 3, -1], chest: [10, 8, -2], neck: [-6, -2, 0], head: [-4, -4, 1],
      clavL: [0, 2, 16], armL: [-74, 0, 24], foreL: [-92, 0, -18], handL: [-12, 0, 0],
      clavR: [0, -2, -8], armR: [-14, 0, -30], foreR: [-76, 0, 16], handR: [-12, 0, 24],
      thighL: [-22, 0, 7], shinL: [32, 0, 0], footL: [-6, 4, 0],
      thighR: [-8, 0, -8], shinR: [26, 0, 0], footR: [-2, -6, 0],
    }),
    { t: 0, b: 'pelvis', p: [0.012, -0.060, 0.010] },
    ...pose(0.65, {
      pelvis: [12, 5, 3], spine1: [8, 3, -1], spine2: [8, 3, -1], chest: [12, 7, -2], neck: [-7, -2, 0], head: [-5, -4, 1],
      clavL: [0, 2, 17], armL: [-77, 0, 25], foreL: [-95, 0, -18], handL: [-12, 0, 0],
      clavR: [0, -2, -8], armR: [-16, 0, -31], foreR: [-79, 0, 16], handR: [-12, 0, 25],
      thighL: [-24, 0, 7], shinL: [34, 0, 0], footL: [-6, 4, 0],
      thighR: [-9, 0, -8], shinR: [28, 0, 0], footR: [-2, -6, 0],
    }),
    { t: 0.65, b: 'pelvis', p: [0.010, -0.070, 0.014] },
    ...pose(1.30, {
      pelvis: [10, 6, 3], spine1: [7, 4, -1], spine2: [7, 3, -1], chest: [10, 8, -2], neck: [-6, -2, 0], head: [-4, -4, 1],
      clavL: [0, 2, 16], armL: [-74, 0, 24], foreL: [-92, 0, -18], handL: [-12, 0, 0],
      clavR: [0, -2, -8], armR: [-14, 0, -30], foreR: [-76, 0, 16], handR: [-12, 0, 24],
      thighL: [-22, 0, 7], shinL: [32, 0, 0], footL: [-6, 4, 0],
      thighR: [-8, 0, -8], shinR: [26, 0, 0], footR: [-2, -6, 0],
    }),
    { t: 1.30, b: 'pelvis', p: [0.012, -0.060, 0.010] },
  ], { loop: true });

  // ── SHIELD: RUSH — the charged bash dash. Two driving strides behind the
  //    shield; the runtime supplies the displacement, this supplies the effort.
  C.rush = new Clip('rush', 0.50, [
    ...pose(0, {
      pelvis: [14, 4, 2], spine1: [9, 3, -1], chest: [14, 6, -2], neck: [-14, 0, 0], head: [-16, -2, 0],
      clavL: [0, 4, 14], armL: [-80, 0, 20], foreL: [-72, 0, -14], handL: [-10, 0, 0],
      clavR: [0, -2, -8], armR: [-16, 0, -30], foreR: [-74, 0, 16],
      thighL: [-26, 0, 6], shinL: [34, 0, 0], thighR: [-10, 0, -7], shinR: [28, 0, 0],
    }),
    { t: 0, b: 'pelvis', p: [0, -0.060, 0] },
    ...pose(0.10, {
      pelvis: [34, 2, 1], spine1: [16, 2, 0], spine2: [14, 1, 0], chest: [20, 4, -1], neck: [-30, 0, 0], head: [-38, -2, 0],
      clavL: [0, 10, -6], armL: [-96, 0, 14], foreL: [-24, 0, -6], handL: [-4, 0, 0],
      clavR: [0, -6, 4], armR: [-8, 0, -42], foreR: [-88, 0, 20],
      thighL: [-60, 0, 6], shinL: [30, 0, 0], footL: [-16, 0, 0],
      thighR: [42, 0, -6], shinR: [44, 0, 0], footR: [26, 0, 0],
    }, 'outQuint'),
    { t: 0.10, b: 'pelvis', p: [0, -0.090, 0.070], e: 'outQuint' },
    ...pose(0.26, {
      pelvis: [34, -2, -1], spine1: [16, -2, 0], spine2: [14, -1, 0], chest: [20, -4, 1], neck: [-30, 0, 0], head: [-38, 2, 0],
      clavL: [0, 10, -6], armL: [-100, 0, 12], foreL: [-20, 0, -6], handL: [-4, 0, 0],
      clavR: [0, -6, 4], armR: [-4, 0, -44], foreR: [-92, 0, 22],
      thighL: [40, 0, 6], shinL: [42, 0, 0], footL: [26, 0, 0],
      thighR: [-58, 0, -6], shinR: [32, 0, 0], footR: [-16, 0, 0],
    }, 'linear'),
    { t: 0.26, b: 'pelvis', p: [0, -0.086, 0.070], e: 'linear' },
    ...pose(0.36, {
      pelvis: [18, 0, 0], spine1: [10, 0, 0], chest: [12, 0, 0], neck: [-16, 0, 0], head: [-22, 0, 0],
      armL: [-70, 0, 18], foreL: [-46, 0, -8], armR: [-14, 0, -32], foreR: [-70, 0, 16],
      thighL: [-20, 0, 6], shinL: [40, 0, 0], thighR: [-26, 0, -6], shinR: [36, 0, 0],
    }, 'outQuad'),
    ...stance(0.50, 'outCubic'),
    { t: 0.50, b: 'pelvis', p: [0.014, 0, 0], e: 'outCubic' },
  ]);

  return C;
}

// ---------------------------------------------------------------------------
// ANIMATOR
// ---------------------------------------------------------------------------

const _tq = new THREE.Quaternion(), _tq2 = new THREE.Quaternion();
const _te = new THREE.Euler();
function addRot(bone, x, y, z) {
  if (!bone || (!x && !y && !z)) return;
  bone.quaternion.multiply(_tq.setFromEuler(_te.set(x * D2R, y * D2R, z * D2R, 'YXZ')));
}

export class Animator {
  constructor(rig) {
    this.rig = rig;
    this.n = rig.boneList.length;
    this.index = new Map(rig.boneList.map((b, i) => [b.name, i]));
    this.clips = buildClipData();
    const ix = (n) => (this.index.has(n) ? this.index.get(n) : -1);
    for (const c of Object.values(this.clips)) c.compile(ix, this.n);
    this.bind = rig.bind;
    this.poseA = makePose(this.n); this.poseB = makePose(this.n); this.out = makePose(this.n);
    this.tmp0 = makePose(this.n); this.tmp1 = makePose(this.n);
    this.cur = { clip: this.clips.idle, t: 0, speed: 1 };
    this.prev = null; this.fade = 0; this.fadeDur = 0.12;
    this.additive = [];
    this.cloth = new ClothSolver(rig);
    this.ikL = new LegIK(rig, 'L'); this.ikR = new LegIK(rig, 'R');
    this.ikWeight = 0.8;
    this.ikEnabled = true;
    this.mod = { leanX: 0, leanZ: 0, twist: 0, headYaw: 0, headPitch: 0 };
    this.rootDelta = new THREE.Vector3();
    this._rp = new THREE.Vector3(); this._rc = new THREE.Vector3();
    this._inv = new THREE.Matrix4();
    this.groundY = 0;
    this.time = 0;
  }

  get current() { return this.cur.clip.name; }
  duration(name) { const c = this.clips[name]; return c ? c.dur : 0; }
  /** normalised progress through the current clip */
  get phase() { return clamp01(this.cur.t / this.cur.clip.dur); }

  play(name, o = {}) {
    const clip = this.clips[name];
    if (!clip) return this;
    if (this.cur.clip === clip && !o.restart) { if (o.speed) this.cur.speed = o.speed; return this; }
    if (o.fade !== 0) { this.prev = { clip: this.cur.clip, t: this.cur.t, speed: this.cur.speed }; }
    else this.prev = null;
    this.cur = { clip, t: 0, speed: o.speed ?? 1 };
    this.fade = 0; this.fadeDur = Math.max(1e-4, o.fade ?? 0.12);
    clip.rootAt(0, this._rp);
    return this;
  }
  /** deterministic scrub — used by the capture harness for authored frames */
  freezeAt(name, t) {
    const clip = this.clips[name]; if (!clip) return this;
    this.cur = { clip, t, speed: 0 }; this.prev = null; this.additive.length = 0;
    clip.rootAt(t, this._rp);
    return this;
  }
  playAdditive(name, o = {}) {
    const clip = this.clips[name]; if (!clip) return this;
    this.additive = this.additive.filter(l => l.clip !== clip);
    this.additive.push({ clip, t: 0, w: o.weight ?? 1, speed: o.speed ?? 1 });
    return this;
  }

  update(dt) {
    this.time += dt;
    const c = this.cur;
    c.t += dt * c.speed;
    if (this.prev) {
      this.prev.t += dt * this.prev.speed;
      this.fade += dt;
      if (this.fade >= this.fadeDur) this.prev = null;
    }
    // ---- base ------------------------------------------------------------
    resetPose(this.poseA, this.bind);
    c.clip.sample(c.t, this.poseA);
    let src = this.poseA;
    if (this.prev) {
      resetPose(this.poseB, this.bind);
      this.prev.clip.sample(this.prev.t, this.poseB);
      blendPose(this.poseB, this.poseA, clamp01(this.fade / this.fadeDur), this.out);
      src = this.out;
    } else if (src !== this.out) {
      for (let i = 0; i < this.n; i++) { this.out.q[i].copy(this.poseA.q[i]); this.out.p[i].copy(this.poseA.p[i]); }
      src = this.out;
    }
    // ---- additive layers -------------------------------------------------
    for (let li = this.additive.length - 1; li >= 0; li--) {
      const L = this.additive[li];
      L.t += dt * L.speed;
      if (L.t >= L.clip.dur && !L.clip.loop) { this.additive.splice(li, 1); continue; }
      resetPose(this.tmp0, this.bind); L.clip.sample(0, this.tmp0);
      resetPose(this.tmp1, this.bind); L.clip.sample(L.t, this.tmp1);
      for (let i = 0; i < this.n; i++) {
        _tq.copy(this.tmp0.q[i]).invert().multiply(this.tmp1.q[i]);
        _tq2.identity().slerp(_tq, L.w);
        this.out.q[i].multiply(_tq2);
        _v1.subVectors(this.tmp1.p[i], this.tmp0.p[i]).multiplyScalar(L.w);
        this.out.p[i].add(_v1);
      }
    }
    // ---- write to bones --------------------------------------------------
    const BL = this.rig.boneList;
    for (let i = 0; i < this.n; i++) { BL[i].quaternion.copy(this.out.q[i]); BL[i].position.copy(this.out.p[i]); }
    // ---- procedural modifiers -------------------------------------------
    const m = this.mod, B = this.rig.bones;
    addRot(B.pelvis, m.leanX * 0.28, 0, m.leanZ * 0.28);
    addRot(B.spine1, m.leanX * 0.26, m.twist * 0.22, m.leanZ * 0.26);
    addRot(B.spine2, m.leanX * 0.26, m.twist * 0.26, m.leanZ * 0.26);
    addRot(B.chest, m.leanX * 0.34, m.twist * 0.36, m.leanZ * 0.34);
    addRot(B.head, m.headPitch - m.leanX * 0.42, m.headYaw - m.twist * 0.35, -m.leanZ * 0.30);
    // ---- root motion -----------------------------------------------------
    c.clip.rootAt(c.t, this._rc);
    this.rootDelta.subVectors(this._rc, this._rp);
    this._rp.copy(this._rc);
    // ---- world, then secondary motion, then IK ---------------------------
    this.rig.root.updateMatrixWorld(true);
    this.cloth.solve(dt, this.time);
    if (this.ikEnabled && this.ikWeight > 0.01) this.groundIK();
    this.rig.root.updateMatrixWorld(true);
    return this.rootDelta;
  }

  groundIK() {
    const rig = this.rig;
    rig.mesh.updateMatrixWorld(true);
    this._inv.copy(rig.mesh.matrixWorld).invert();
    for (const S of ['L', 'R']) {
      const ik = S === 'L' ? this.ikL : this.ikR;
      ik.foot.updateMatrixWorld(true);
      _v2.setFromMatrixPosition(ik.foot.matrixWorld);
      const floor = this.groundY + 0.098 * (rig.height / 1.90);
      if (_v2.y < floor) {
        _v2.y = floor;
        _v2.applyMatrix4(this._inv);
        ik.solve(_v2, this.ikWeight);
      }
    }
  }
}

export default { Animator, Clip, ClothSolver, LegIK, buildClipData };
