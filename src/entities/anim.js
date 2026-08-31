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
  // ── TIMING AND SPACING ──────────────────────────────────────────────────
  // `drive` is the commit curve for every strike, and it exists because the
  // whole arsenal used to reach its contact pose with `outQuint`. Measured on
  // the right hand of attack1 (81 samples, world space): the anticipation key
  // sits at t=0.11 and the commit key at t=0.20, so the swing owns 90ms — 5.4
  // frames at 60fps. outQuint's first frame (u = 16.7/90 = 0.185) is already
  // 1-0.815^5 = 0.64 of the way there, i.e. the hand covered 0.98m in one
  // 10ms sample and then crept 4cm over the remaining eight frames. That is
  // not "fast in", it is a TELEPORT: no arc is drawn, no smear is possible,
  // and the blade is at rest for the whole of the runtime's active window.
  //   u*u*(2-u) has zero velocity at u=0 and unit velocity at u=1, peaking at
  // 1.33 around u=2/3. Frame-by-frame across the same 90ms it spends
  // 6 / 16 / 22 / 24 / 23 / 8 percent — an accelerating sweep across five
  // frames that is still moving when it arrives, which is what makes the
  // following HOLD read as an impact rather than as a pose change.
  drive: u => u * u * (2 - u),
};

const _e = new THREE.Euler();
const _segOut = { a: null, b: null, u: 0 };
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
    // DUPLICATE TIMES. Authoring is layered — `...stance(0)` lays down a whole
    // body and the lines after it override individual bones at the same time —
    // so a track can legitimately receive two keys at t. Before, both survived:
    // _seg's `t <= list[0].t` branch handed back the FIRST at exactly t, while
    // any t+e fell into a zero-length segment and snapped to the SECOND. The
    // idle's pelvis was the visible case: at t=0 it played STANCE's [0,5,2]
    // and from t=0.005 on it played the idle's own [0,9,4.6], which moved the
    // planted left ankle 3.7cm sideways in one frame — once per 2.8s loop, and
    // again on every clip entry. Later key wins, which is what the layering
    // reads as; sort is stable, so insertion order decides.
    const dedupe = (l) => l.filter((k, i) => i === l.length - 1 || l[i + 1].t !== k.t);
    for (const tr of map.values()) {
      tr.rot.sort((a, b) => a.t - b.t); tr.pos.sort((a, b) => a.t - b.t);
      tr.rot = dedupe(tr.rot); tr.pos = dedupe(tr.pos);
    }
    this._compiled = [...map.values()];
    if (this.rootTrack) this._root = this.rootTrack.map(k => ({ t: k.t, v: new THREE.Vector3(...(k.p || [0, 0, 0])), e: k.e || 'smooth' }));
    return this;
  }
  /**
   * Fills the shared `_seg` record with the bracketing keys and the eased
   * blend factor, and returns it (or null when the track is empty). It writes
   * into a module-scope record rather than returning a fresh array because
   * sample() calls it twice per animated track, on every character, on every
   * frame — that array was the single largest source of animation garbage.
   * The caller must consume the result before calling _seg again.
   */
  _seg(list, t) {
    const n = list.length;
    if (!n) return null;
    const S = _segOut;
    if (t <= list[0].t) { S.a = S.b = list[0]; S.u = 0; return S; }
    if (t >= list[n - 1].t) { S.a = S.b = list[n - 1]; S.u = 0; return S; }
    let i = 0; while (i < n - 1 && list[i + 1].t < t) i++;
    const a = list[i], b = list[i + 1];
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    S.a = a; S.b = b; S.u = (EASE[b.e] || smoothstep)(u);
    return S;
  }
  /** write this clip's pose at time t into a Pose (bones not touched keep bind) */
  sample(t, pose) {
    if (!this._compiled) return pose;
    const tt = this.loop ? ((t % this.dur) + this.dur) % this.dur : clamp(t, 0, this.dur);
    for (const tr of this._compiled) {
      const i = tr.i;
      const R = this._seg(tr.rot, tt);
      if (R) { pose.q[i].copy(R.a.q); if (R.u > 0) pose.q[i].slerp(R.b.q, R.u); pose.mr[i] = 1; }
      // POSITION KEYS ARE OFFSETS FROM BIND, never absolute local positions —
      // authoring absolute bone offsets by hand is how you accidentally drop a
      // pelvis 0.95m into the floor.
      const P = this._seg(tr.pos, tt);
      if (P) {
        _kv.copy(P.a.v); if (P.u > 0) _kv.lerp(P.b.v, P.u);
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
    out.copy(s.a.v); if (s.u > 0) out.lerp(s.b.v, s.u);
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
// cloth-only scratch. The chain solver used to build a fresh Quaternion for
// the chain root plus TWO per bone per frame; on this rig that is 54 objects
// every frame for every character wearing anything.
const _cqP = new THREE.Quaternion(), _cqW = new THREE.Quaternion();
const _cqQ = new THREE.Quaternion(), _cqL = new THREE.Quaternion();

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
      const pq = _cqP.setFromRotationMatrix(_m1.extractRotation(parent.matrixWorld));
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
      const parentWorldQ = _cqW.copy(pq);
      for (let i = 0; i < n; i++) {
        _v1.subVectors(C.x[i + 1], C.x[i]);
        if (_v1.lengthSq() < 1e-10) _v1.copy(d.axis[i].dir).applyQuaternion(RQ);
        _v1.normalize().applyQuaternion(RQi);          // -> rig space
        _cqQ.setFromUnitVectors(d.axis[i].dir, _v1).premultiply(RQ);   // bone's WORLD quat
        _cqL.copy(parentWorldQ).invert().multiply(_cqQ);
        d.list[i].quaternion.copy(_cqL);
        parentWorldQ.copy(_cqQ);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// TWO-BONE IK — foot planting on the ground plane
// ---------------------------------------------------------------------------

// SCRATCH for the IK. Every temporary the solver needs lives here and is
// reused: the old solve() built 12 fresh Vector3/Quaternions per call, and
// with both feet planted for most of most clips that was ~1400 short-lived
// objects per second PER CHARACTER on screen — a minor GC bought with nothing.
// The solver is not re-entrant, which is fine: it runs twice, in sequence,
// inside groundIK(). These are deliberately separate from the _v/_q cloth
// scratch above so that neither pass can ever alias the other's temporaries.
const _ikT = new THREE.Vector3(), _ikH = new THREE.Vector3(), _ikD = new THREE.Vector3();
const _ikAx = new THREE.Vector3(), _ikTh = new THREE.Vector3(), _ikKn = new THREE.Vector3();
const _ikSh = new THREE.Vector3(), _ikPole = new THREE.Vector3(0, 0, 1);
const _ikFw = new THREE.Quaternion(), _ikQT = new THREE.Quaternion(), _ikQS = new THREE.Quaternion();
const _ikPQ = new THREE.Quaternion(), _ikRQ = new THREE.Quaternion(), _ikTmp = new THREE.Quaternion();
const _ikM = new THREE.Matrix4();

export class LegIK {
  constructor(rig, side) {
    const S = side;
    this.hip = rig.bones['thigh' + S];
    this.knee = rig.bones['shin' + S];
    this.foot = rig.bones['foot' + S];
    // Ground contact is measured at two probes, not at the ankle: the heel
    // plane sits a fixed drop below the ankle, and the ball/tip rides in the
    // TOE bone's frame so it follows plantarflexion. `toeTip` is the local
    // offset from the toe joint to the toe's end — bind rotations are
    // identity, so the bind-space difference IS the local offset.
    this.toe = rig.bones['toe' + S] || null;
    const tseg = rig.byName.get('toe' + S), k = rig.height / 1.90;
    // lateral offsets as well as the centre line: a foot that ROLLS (the idle
    // stance carries 4.6deg of pelvis rz, and every strike rolls the pelvis
    // further) touches down on an outer edge, and a centre-line-only probe
    // reported that foot as clear of the ground while its edge was 2cm under.
    // The three probes are symmetric about the centre line and CONSTANT in
    // bone-local space, so the lowest of them is a closed form rather than
    // three matrix transforms: a point (dx,0,0) in the bone's frame lands at
    // world y = origin.y + dx*m[1], and the lowest over dx in {-h,0,+h} is
    // therefore origin.y - h*|m[1]|. `probeHalf` is that h; `probeX` is kept
    // for anything that wants the explicit list.
    this.probeHalf = 0.05 * k;
    this.probeX = [-this.probeHalf, 0, this.probeHalf];
    // DROPS, re-solved against the skinned mesh. Predicted sole vs the true
    // lowest foot vertex was gathered over all 27 clips x 40 frames x 2 feet
    // (2160 samples) and the three drops fitted by search. The previous
    // 0.098 / 0.045 / 0.013 carried a -0.41cm BIAS — the probe believed the
    // sole was 4mm lower than it really was, so a foot the IK had "planted"
    // still floated — with 0.63cm rms and a 3.4cm worst case. The unbiased fit
    // is 0.076/0.042/0.010 (rms 0.31cm, worst 1.18cm); these carry 4mm of
    // extra drop on top of it, chosen by sweeping the drop END TO END with the
    // IK running and reading the skinned sole: it is the point where the run's
    // support sole still reaches the floor (+0.8mm at its lowest) while the
    // deepest penetration anywhere in the 27 clips is 6mm.
    this.heelDrop = 0.0798 * k;                // sole under the ankle
    this.ballDrop = 0.0458 * k;                // sole under the toe joint
    this.tipDrop = 0.0138 * k;                 // sole under the toe's end
    this.toeTip = tseg ? tseg.b.clone().sub(tseg.a) : null;
    const a = rig.byName.get('thigh' + S), b = rig.byName.get('shin' + S), c = rig.byName.get('foot' + S);
    this.l1 = b.a.distanceTo(a.a);
    this.l2 = c.a.distanceTo(b.a);
    this.bindThigh = b.a.clone().sub(a.a).normalize();
    this.bindShin = c.a.clone().sub(b.a).normalize();
    this.rig = rig;
  }
  /**
   * Lowest point of this foot's sole in WORLD y, from the nine probes
   * described above collapsed to their closed form. Assumes the foot and toe
   * matrices are current.
   */
  soleY() {
    const fe = this.foot.matrixWorld.elements;
    let sole = fe[13] - this.heelDrop - this.probeHalf * Math.abs(fe[1]);
    if (this.toe && this.toeTip) {
      const te = this.toe.matrixWorld.elements;
      const edge = this.probeHalf * Math.abs(te[1]);
      const ball = te[13] - this.ballDrop - edge;
      if (ball < sole) sole = ball;
      const tip = _ikD.copy(this.toeTip).applyMatrix4(this.toe.matrixWorld).y - this.tipDrop - edge;
      if (tip < sole) sole = tip;
    }
    return sole;
  }
  /** target is in RIG-LOCAL space; pole points forward (+Z) */
  solve(target_, weight = 1) {
    if (weight <= 0.001) return;
    const rig = this.rig;
    const target = _ikT.copy(target_);
    // ANKLE ANGLE IS A SEPARATE FACT FROM ANKLE POSITION. This solver moves
    // the hip and the knee, and the foot rides on the knee — so lifting an
    // ankle by 1.4cm also pitched the foot forward by the same rotation and
    // drove the ball of the foot back down through the floor. Measured on the
    // idle: the right ankle rose 1.4cm and the right sole did not move at all.
    // Capture the foot's world orientation now and restore it after the solve,
    // so the sole keeps the angle the animator authored and the correction
    // reaches the ground.
    this.foot.updateMatrixWorld(true);
    _ikFw.setFromRotationMatrix(_ikM.extractRotation(this.foot.matrixWorld));
    _ikM.copy(rig.mesh.matrixWorld).invert();
    const hip = _ikH.setFromMatrixPosition(this.hip.matrixWorld).applyMatrix4(_ikM);
    _ikD.subVectors(target, hip);
    const L = this.l1 + this.l2;
    let d = _ikD.length();
    if (d < 1e-4) return;
    _ikD.multiplyScalar(1 / d);                          // unit hip -> target
    d = clamp(d, Math.abs(this.l1 - this.l2) + 0.02, L - 0.006);
    const cosA = clamp((this.l1 * this.l1 + d * d - this.l2 * this.l2) / (2 * this.l1 * d), -1, 1);
    const A = Math.acos(cosA);
    // cross(pole, dir), NOT cross(dir, pole): the sign decides whether the knee
    // bends forward or backward, and backward is a horror.
    _ikAx.crossVectors(_ikPole, _ikD);
    if (_ikAx.lengthSq() < 1e-8) _ikAx.set(1, 0, 0); else _ikAx.normalize();
    _ikTh.copy(_ikD).applyQuaternion(_ikTmp.setFromAxisAngle(_ikAx, -A));
    _ikKn.copy(hip).addScaledVector(_ikTh, this.l1);
    _ikSh.subVectors(target, _ikKn).normalize();

    _ikQT.setFromUnitVectors(this.bindThigh, _ikTh);
    _ikQS.setFromUnitVectors(this.bindShin, _ikSh);
    // rig-space -> local
    _ikPQ.setFromRotationMatrix(_ikM.extractRotation(this.hip.parent.matrixWorld));
    _ikRQ.setFromRotationMatrix(_ikM.extractRotation(rig.mesh.matrixWorld)).invert();
    _ikPQ.premultiply(_ikRQ);                            // parent, in rig space
    _ikTmp.copy(_ikPQ).invert().multiply(_ikQT);         // thigh, local
    this.hip.quaternion.slerp(_ikTmp, weight);
    _ikTmp.copy(_ikQT).invert().multiply(_ikQS);         // shin, local
    this.knee.quaternion.slerp(_ikTmp, weight);
    this.hip.updateMatrixWorld(true);
    _ikTmp.setFromRotationMatrix(_ikM.extractRotation(this.knee.matrixWorld)).invert();
    this.foot.quaternion.copy(_ikTmp.multiply(_ikFw));
    this.foot.updateMatrixWorld(true);
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
  // 21/-25 opened two holes; 25/-29 opens them wider without the arms reading
  // as held out. Measured on the 1/8 silhouette: the gap between the upper arm
  // and the ribcage went from 2px (i.e. closed) to 5px, which is the difference
  // between a figure with arms and a figure with a torso that has bumps.
  armL: [-6, 0, 25], foreL: [-25, 0, -6], handL: [-8, 0, 0],
  armR: [-4, 0, -29], foreR: [-19, 0, 8], handR: [-14, 0, 26],
  // CONTRAPPOSTO, and the feet have to be ON the floor for it to read.
  // Measured on the skinned mesh, the old stance planted the RIGHT sole at
  // 0.004 and left the LEFT sole 2.7cm in the air — while every comment in
  // this file, and the idle's own weight track, say the weight is carried on
  // the LEFT. The support leg was the bent one. It could not be fixed by IK
  // either: with thighL rz +4 the left ankle sat 10.3cm lateral of its hip, so
  // the straight-line hip-to-target distance was 0.896 against a leg that is
  // only 0.875 long — the foot was physically out of reach.
  // The support (left) leg is now the STRAIGHT, adducted one and its sole
  // reaches the floor; the free (right) leg keeps the soft knee, and the
  // pelvis rz tilt drops the right hip so that foot stays down as well.
  thighL: [-2, 0, 0.5], shinL: [3, 0, 0], footL: [-2, 4, 0],
  thighR: [1, 0, -3], shinR: [7, 0, 0], footR: [-3, -3, 0],
};
/** expand a pose object into keys at time t */
const pose = (t, o, e) => Object.entries(o).map(([b, r]) => ({ t, b, r, e }));
const stance = (t, e) => pose(t, STANCE, e);
/**
 * SPINE OVERLAP — the drag down the chain, for a whole authored pose.
 *
 * Every strike in the arsenal wrote pelvis, spine1, spine2, chest, neck and
 * head at the SAME time, so the entire trunk reached its extreme on exactly
 * one frame: the "broomstick" the run's comments warn about, alive and well in
 * the fighting clips. Measured as the spread of peak angular speed between
 * pelvis, chest and head inside the strike window, attack1/2/3 all sat at 0ms.
 *
 * A hip drives a strike; the ribcage follows it, the head arrives last. This
 * pushes each bone's key later by a fixed fraction of `dt`, using the same
 * profile the run cycle already uses (spine1 0.09, spine2 0.16, chest 0.24,
 * neck 0.29, head 0.34) so the two read as the same body. `dt` must be smaller
 * than the gap to the next key on the track — pass roughly the length of the
 * commit segment and the head lands ~a third of a segment late.
 *
 * Only the strike keys are dragged (anticipation, commit, hold). The recovery
 * and the closing stance stay where they are, because the clip must still
 * finish on its rest pose at exactly `dur` for the blend back to stance.
 */
const CHAIN_LAG = { spine1: 0.09, spine2: 0.16, chest: 0.24, neck: 0.29, head: 0.34 };
const lag = (keys, dt) => keys.map(k => {
  const f = CHAIN_LAG[k.b];
  return f === undefined ? k : { ...k, t: k.t + f * dt };
});

/**
 * RETURN. `f` of the way from a committed pose back to STANCE (f>1 overshoots
 * it, which is what settle() below is).
 *
 * A strike's tail used to be authored as one hand-placed key somewhere in the
 * middle and then a jump to stance, and with the commit curve slowed down to
 * `drive` that tail became the FASTEST thing in several clips: measured on the
 * weapon hand, cast peaked 19.9 m/s in its recovery against 10.4 m/s in the
 * actual strike, and its peak sat at 85% of the clip with 58ms of decay left.
 * A clip whose last frames are its quickest pops when the runtime blends it
 * back to stance. Building the return by interpolation lets the distance be
 * split evenly across the frames that are left, which is what makes it decay.
 */
const ret = (t, from, f, e = 'outQuad') =>
  Object.entries(from).map(([b, r]) => {
    const S = STANCE[b] || [0, 0, 0];
    return { t, b, e, r: [r[0] + (S[0] - r[0]) * f, r[1] + (S[1] - r[1]) * f, r[2] + (S[2] - r[2]) * f] };
  });

/**
 * FOLLOW-THROUGH. A body that stops exactly on its rest pose has no mass. The
 * recovery of every strike now OVERSHOOTS the stance by `k` of the distance it
 * has just travelled and settles back over the last few frames — the bones
 * listed are the ones the swing actually loaded, so the overshoot is in the
 * direction the momentum was going rather than a generic wobble.
 * `from` is the last committed pose; the returned keys sit at time `t`, which
 * must be between the recovery key and the clip's closing stance.
 */
const settle = (t, from, k, e = 'linear') =>
  Object.entries(from).map(([b, r]) => {
    const S = STANCE[b] || [0, 0, 0];
    return { t, b, e, r: [S[0] + (S[0] - r[0]) * k, S[1] + (S[1] - r[1]) * k, S[2] + (S[2] - r[2]) * k] };
  });

export function buildClipData() {
  const C = {};

  // ── IDLE — contrapposto, breath on its own clock, overlap on the ends ─────
  // WAS: every animated bone in this clip carried exactly three keys, at
  // t = 0 / 1.4 / 2.8. Pelvis, spine, neck, head and both arms therefore
  // reached their extreme on the SAME frame and returned on the same frame.
  // That is one sine wave played by nine bones in unison, and no amount of
  // pose quality survives it: the figure reads as a puppet bobbing on a stick,
  // which is exactly what §i calls "a symmetric T-stance with a sine bob".
  //
  // NOW there are three independent clocks inside one 2.8s loop:
  //   WEIGHT   pelvis 0 / 1.15 / 2.05 / 2.8 — the shift across is quicker than
  //            the settle back, because weight falls and is then carried.
  //   BREATH   chest + spine + clavicle at 0.62 / 1.48 / 2.26 — a ~0.85s
  //            in-breath against a ~0.78s out-breath, so it never lands on the
  //            weight keys.
  //   OVERLAP  neck/head lag the chest by ~0.30s, the upper arms lag the chest
  //            by ~0.23s and the forearms lag the upper arms again by ~0.17s.
  //            A limb whose whole length turns on one frame is a plank; the
  //            drag down the chain is what makes it read as an arm.
  C.idle = new Clip('idle', 2.8, [
    ...stance(0), ...stance(2.8),
    // WEIGHT — carried on the left leg, drifting toward centre and returning.
    // AMPLITUDE. The old shift was 1.6cm of hip travel and 1.1cm of vertical
    // on a 2.05m figure: 0.8% of body height, which at the 3/4 camera's scale
    // is about two pixels. The keys said contrapposto and the screen said
    // statue. This is 4.8cm across and 2.4cm of vertical — still small enough
    // to be a shift of weight rather than a sway, but now actually legible.
    //
    // The VERTICAL is also inverted from the old curve. Weight riding on one
    // straight leg is the HIGH point; passing through the middle both knees
    // soften and the hips SINK. The old track peaked in the middle of the
    // transfer, which reads as the character being lifted rather than
    // dropping between its own feet.
    { t: 0, b: 'pelvis', r: [0, 9.0, 4.6], p: [0.040, -0.018, 0] },
    { t: 1.15, b: 'pelvis', r: [0, 4.6, 0.6], p: [-0.008, -0.036, 0], e: 'outQuad' },
    { t: 2.05, b: 'pelvis', r: [0, 7.4, 3.2], p: [0.02, -0.027, 0] },
    { t: 2.8, b: 'pelvis', r: [0, 9.0, 4.6], p: [0.040, -0.018, 0] },
    // the legs trade roles with the weight: the loaded leg is the straight
    // one, the free leg carries the soft knee. Both soles stay down.
    // NOTE the easing: these MUST match the pelvis key's easing at the same
    // time. They did not, and a leg travelling on smoothstep under a pelvis
    // travelling on outQuad is a foot that swims mid-segment even though both
    // ends of the segment are correct.
    { t: 1.15, b: 'thighL', r: [-4.32, 0, 7.71], e: 'outQuad' }, { t: 1.15, b: 'shinL', r: [9, 0, 0], e: 'outQuad' },
    { t: 1.15, b: 'thighR', r: [2.25, 0, 3.82], e: 'outQuad' }, { t: 1.15, b: 'shinR', r: [3, 0, 0], e: 'outQuad' },
    { t: 2.05, b: 'thighL', r: [-3.02, 0, 3.22] }, { t: 2.05, b: 'shinL', r: [5.4, 0, 0] },
    { t: 2.05, b: 'thighR', r: [1.35, 0, -0.41] }, { t: 2.05, b: 'shinR', r: [5.6, 0, 0] },
    // BREATH — the ribcage lifts and the clavicles ride up with it
    { t: 0.62, b: 'spine1', r: [3.4, -2, -1.2] },
    { t: 1.48, b: 'spine1', r: [0.9, -2, -1.2] },
    { t: 2.26, b: 'spine1', r: [3.1, -2, -1.2] },
    { t: 0.62, b: 'spine2', r: [3.4, -3, -1.0] },
    { t: 1.48, b: 'spine2', r: [0.6, -3, -1.0] },
    { t: 2.26, b: 'spine2', r: [3.0, -3, -1.0] },
    // The chest ROLL is the other half of contrapposto: the shoulder line
    // tilts against the hip line. It also puts motion back into the head,
    // which the corrected hips had cancelled out — with the pelvis rolling
    // 4.6->0.6 under a rigid ribcage the head travelled 0.6cm across the whole
    // loop, i.e. it was nailed in place. 6deg of chest roll returns ~3cm of
    // head travel without the head leaving the base of support.
    { t: 0.62, b: 'chest', r: [-6.8, 12, -5.6] },
    { t: 1.48, b: 'chest', r: [-1.4, 12, 0.6] },
    { t: 2.26, b: 'chest', r: [-6.2, 12, -4.6] },
    { t: 0.62, b: 'clavL', r: [0, 0, 7.4] }, { t: 1.48, b: 'clavL', r: [0, 0, 3.6] }, { t: 2.26, b: 'clavL', r: [0, 0, 7.0] },
    { t: 0.62, b: 'clavR', r: [0, 0, -6.4] }, { t: 1.48, b: 'clavR', r: [0, 0, -2.8] }, { t: 2.26, b: 'clavR', r: [0, 0, -6.0] },
    // OVERLAP — head and neck trail the ribcage, and the head ARCS (it is not
    // allowed to travel back along the path it came out on)
    { t: 0.92, b: 'neck', r: [-4.0, 3.4, 0.2] },
    { t: 1.78, b: 'neck', r: [-0.9, 2.0, -0.2] },
    { t: 2.56, b: 'neck', r: [-3.4, 3.1, 0.1] },
    { t: 0.92, b: 'head', r: [1.4, 7.6, 2.1] },
    { t: 1.78, b: 'head', r: [5.8, 3.0, 0.8] },
    { t: 2.56, b: 'head', r: [3.0, 6.2, 1.7] },
    { t: 0.85, b: 'armL', r: [1.5, 0, 28.5] }, { t: 1.72, b: 'armL', r: [-4.5, 0, 23.5] }, { t: 2.5, b: 'armL', r: [-3.0, 0, 25.6] },
    { t: 0.85, b: 'armR', r: [2.2, 0, -33.5] }, { t: 1.72, b: 'armR', r: [-5.2, 0, -27.0] }, { t: 2.5, b: 'armR', r: [-3.4, 0, -29.6] },
    { t: 1.02, b: 'foreL', r: [-28.0, 0, -6] }, { t: 1.90, b: 'foreL', r: [-21.0, 0, -6] }, { t: 2.62, b: 'foreL', r: [-24.6, 0, -6] },
    { t: 1.02, b: 'foreR', r: [-21.5, 0, 8] }, { t: 1.90, b: 'foreR', r: [-15.0, 0, 8] }, { t: 2.62, b: 'foreR', r: [-18.4, 0, 8] },
    // the free hand settles last of all — the end of the chain always does
    { t: 1.20, b: 'handL', r: [-9.5, 0, 2.0] }, { t: 2.05, b: 'handL', r: [-6.0, 0, -1.5] },
    // the weapon hand swings the xiphos ~30deg clear of the leg line so the
    // blade draws its own edge instead of disappearing into the shin
    { t: 0, b: 'handR', r: [-14, 0, 30] },
    { t: 1.55, b: 'handR', r: [-14, 0, 34.5] },
    { t: 2.8, b: 'handR', r: [-14, 0, 30] },
  ], { loop: true });

  // ── RUN — lean, hip/shoulder counter-rotation, arm counter-swing ──────────
  const RT = [0, 0.145, 0.29, 0.435, 0.58];
  const runKeys = [];
  // `skip` drops one RT key: the stance-phase bones author their own keys at
  // LT/RTs and an RT key left inside that window freezes the joint for a frame
  // or two, which is exactly the stall a planted foot must not have.
  const rk = (b, arr, skip = -1) => { for (let i = 0; i < 5; i++) if (i !== skip) runKeys.push({ t: RT[i], b, r: arr[i] }); };
  // PHASE LAG (overlap / drag). A forearm does not reach its extreme on the
  // frame the upper arm does — it trails by a fraction of a step, and the hand
  // trails the forearm again. That drag is the difference between an arm and a
  // broomstick, and the run cycle had none: every joint in the chain turned in
  // perfect unison. Shifting a track's TIMES would break the loop (its first
  // key would no longer sit at t=0 and the sampler clamps outside the range),
  // so the shift is applied to the VALUES instead — each key is pulled back
  // toward the previous key's pose by `s` of a segment. Same phase, wrap-safe.
  const rkLag = (b, arr, s) => {
    for (let i = 0; i < 5; i++) {
      const q = arr[(i + 3) % 4], c = arr[i];
      runKeys.push({ t: RT[i], b, r: [lerp(q[0], c[0], 1 - s), lerp(q[1], c[1], 1 - s), lerp(q[2], c[2], 1 - s)] });
    }
  };
  // ── WHERE THE GROUND ACTUALLY IS ─────────────────────────────────────────
  // Measured on the CPU previewer (skinned mesh, world space, hero rig, 2.05m):
  // the sole of the support foot NEVER reached the floor anywhere in this
  // cycle. Lowest point of the whole loop was 3.2cm of air at t=0.12, and at
  // the key labelled "contact" (RT[0]) the sole was 12.1cm up. groundIK never
  // fired either, because it only tests the ANKLE and the ankle stayed above
  // its floor for all 0.58s. So the character ran on a cushion of air, which
  // is most of why the run read as gliding.
  //
  // The cause is phase, not height. RT[0] is authored as maximum forward
  // reach (thigh -40) and the foot is physically lowest around RT[1] — so the
  // entire ground contact was described by ONE key, and a plant cannot be
  // authored with one key. The stance now gets its own three keys either side
  // of RT[1] (TOUCHDOWN 0.06 / MID-STANCE 0.125 / TOE-OFF 0.19, mirrored at
  // +0.29 for the right leg), RT[0] keeps the reach, and the leg swings BACK
  // from the reach into the touchdown — the "negative foot speed" that stops a
  // planted foot from being dragged forwards under the body.
  const LT = [0.06, 0.125, 0.19];             // left stance: down / low / off
  const RTs = LT.map(t => t + 0.29);          // right stance
  const stanceKey = (b, t, r, e) => runKeys.push({ t, b, r, e });

  // ── PELVIS: the vertical is what carries the mass ────────────────────────
  // WAS: y = -0.012 at RT[0]/RT[2] and +0.026 at RT[1]/RT[3] — 3.8cm peak to
  // peak, and half a phase out of step with the legs. RT[1] is MID-STANCE (the
  // support knee at shin +6, i.e. straight), so the old curve put the hips at
  // their HIGHEST exactly where the support leg should be absorbing, and at
  // their lowest in mid-flight. That is a vaulting walk played at run speed;
  // it is why the run had no weight.
  // NOW the hips are lowest at TOUCHDOWN (t=0.06) and rise through the stance
  // to the flight apex (t=0.245), 9.6cm peak to peak = 4.7% of body height.
  // The values are not taste: they were solved numerically against the SKINNED
  // MESH so the sole sits on y=0 at every stance key (touchdown / mid-stance /
  // drive / toe-off), which is what puts the whole 29% duty of ground contact
  // actually on the ground. The rotation track still lives on the RT keys;
  // only the POSITION track is re-timed, and Clip keeps rot and pos in
  // separate lists so the two can disagree.
  runKeys.push(
    { t: RT[0], b: 'pelvis', r: [7, 10, 0] },
    { t: RT[1], b: 'pelvis', r: [7, 0, 4.5] },
    { t: RT[2], b: 'pelvis', r: [7, -10, 0] },
    { t: RT[3], b: 'pelvis', r: [7, 0, -4.5] },
    { t: RT[4], b: 'pelvis', r: [7, 10, 0] },
  );
  // p.x sways toward the support leg (+X is the character's LEFT), p.y is the
  // weight curve above. The last key must equal the first or the loop pops.
  for (const [t, x, y, e] of [
    [0.000, 0.006, -0.030, 'smooth'],    // falling out of the last flight
    [0.060, 0.013, -0.070, 'outQuad'],   // TOUCHDOWN — lowest; the drop lands
    [0.125, 0.015, -0.050, 'outQuad'],   // mid-stance, riding over the foot
    [0.158, 0.013, -0.002, 'linear'],    // the knee starts to drive
    [0.190, 0.010, 0.008, 'inQuad'],     // TOE-OFF — the push is spent
    [0.245, -0.002, 0.026, 'outQuad'],   // flight apex — highest
    [0.350, -0.013, -0.070, 'outQuad'],
    [0.415, -0.015, -0.050, 'outQuad'],
    [0.448, -0.013, -0.002, 'linear'],
    [0.480, -0.010, 0.008, 'inQuad'],
    [0.535, 0.002, 0.026, 'outQuad'],
    [0.580, 0.006, -0.030, 'smooth'],
  ]) runKeys.push({ t, b: 'pelvis', p: [x, y, 0], e });

  // ── SPINE: overlap, not a broomstick ─────────────────────────────────────
  // Every spine bone used to reach its extreme on the same frame as the
  // pelvis: rk() writes the raw value at RT[i], so pelvis, spine1, spine2 and
  // chest counter-rotated in perfect unison and the torso turned as one cast
  // block. The lag accumulates down the chain the way a real torso unwinds —
  // the hips lead, the ribcage arrives ~2 frames later, the head last.
  rkLag('spine1', [[6, -5, 0], [6, 0, 0], [6, 5, 0], [6, 0, 0], [6, -5, 0]], 0.09);
  rkLag('spine2', [[5, -7, 2], [5, 0, 0], [5, 7, -2], [5, 0, 0], [5, -7, 2]], 0.16);
  rkLag('chest', [[13, -13, 3], [13, 0, 0], [13, 13, -3], [13, 0, 0], [13, -13, 3]], 0.24);
  rkLag('neck', [[-6, 4, 0], [-6, 0, 0], [-6, -4, 0], [-6, 0, 0], [-6, 4, 0]], 0.29);
  // The head is the top of the chain, so it lags the chest by ~a fifth of a
  // step AND carries its own pitch arc: it drops on each foot plant (t=0,
  // t=0.29) and lifts through the passing position. A head that holds one
  // pitch through a run cycle is the classic "gliding" tell.
  rkLag('head', [[-12, 6, -2], [-7, 0, 0], [-12, -6, 2], [-7, 0, 0], [-12, 6, -2]], 0.34);
  rkLag('clavL', [[0, 0, 5], [0, 0, 2], [0, 0, -1], [0, 0, 2], [0, 0, 5]], 0.26);
  rkLag('clavR', [[0, 0, 1], [0, 0, -2], [0, 0, -5], [0, 0, -2], [0, 0, 1]], 0.26);

  // ── LEGS ─────────────────────────────────────────────────────────────────
  // RT[0] is the AIRBORNE REACH, not the plant: the thigh is at its maximum
  // forward swing and the foot is still ~9cm off the floor. Stance is the
  // three LT keys. Between the reach and the touchdown the thigh swings BACK
  // (-42 -> -25) so the foot is already travelling rearwards when it lands.
  //
  // The three stance keys are eased 'linear'. That matters more than it looks:
  // with the default smoothstep the support foot decelerated to a near stop at
  // every key it passed (measured 4.5 m/s of rearward travel falling to 1.1
  // m/s at mid-stance and then re-accelerating), so a planted foot stalled and
  // restarted twice per step. Linear through stance sweeps it back at one
  // rate, which is the only shape a foot that is stuck to the ground can have.
  rk('thighL', [[-42, 0, 3], [-6, 0, 2], [28, 0, 2], [-30, 0, 4], [-42, 0, 3]], 1);
  rk('shinL', [[18, 0, 0], [26, 0, 0], [36, 0, 0], [86, 0, 0], [18, 0, 0]], 1);
  stanceKey('thighL', LT[0], [-30, 0, 3], 'linear');
  stanceKey('thighL', LT[1], [-30, 0, 3], 'linear');
  stanceKey('thighL', LT[2], [9, 0, 2], 'linear');
  stanceKey('shinL', LT[0], [18, 0, 0], 'linear');
  stanceKey('shinL', LT[1], [44, 0, 0], 'linear');
  stanceKey('shinL', LT[2], [14, 0, 0], 'linear');
  rk('thighR', [[28, 0, -2], [-30, 0, -4], [-42, 0, -3], [-6, 0, -2], [28, 0, -2]], 3);
  rk('shinR', [[36, 0, 0], [86, 0, 0], [18, 0, 0], [26, 0, 0], [36, 0, 0]], 3);
  stanceKey('thighR', RTs[0], [-30, 0, -3], 'linear');
  stanceKey('thighR', RTs[1], [-30, 0, -3], 'linear');
  stanceKey('thighR', RTs[2], [9, 0, -2], 'linear');
  stanceKey('shinR', RTs[0], [18, 0, 0], 'linear');
  stanceKey('shinR', RTs[1], [44, 0, 0], 'linear');
  stanceKey('shinR', RTs[2], [14, 0, 0], 'linear');

  // FOOT PLANT. Heel-strike at touchdown (dorsiflexed), FLAT and held through
  // mid-stance, then a hard plantarflexed push at toe-off with the toe joint
  // supplying the last of it. The old track had one value near the plant and
  // interpolated straight through it, which is precisely the shape that reads
  // as skating.
  rk('footL', [[-18, 3, 0], [-6, 3, 0], [30, 3, 0], [-8, 3, 0], [-18, 3, 0]], 1);
  stanceKey('footL', LT[0], [-3, 3, 0], 'linear');
  stanceKey('footL', LT[1], [-1, 3, 0], 'linear');
  stanceKey('footL', LT[2], [22, 3, 0], 'linear');
  rk('footR', [[30, -3, 0], [-8, -3, 0], [-18, -3, 0], [-6, -3, 0], [30, -3, 0]], 3);
  stanceKey('footR', RTs[0], [-3, -3, 0], 'linear');
  stanceKey('footR', RTs[1], [-1, -3, 0], 'linear');
  stanceKey('footR', RTs[2], [22, -3, 0], 'linear');
  rk('toeL', [[0, 0, 0], [0, 0, 0], [10, 0, 0], [0, 0, 0], [0, 0, 0]], 1);
  stanceKey('toeL', LT[1], [0, 0, 0], 'linear');
  stanceKey('toeL', LT[2], [16, 0, 0], 'linear');
  rk('toeR', [[10, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 0, 0]], 3);
  stanceKey('toeR', RTs[1], [0, 0, 0], 'linear');
  stanceKey('toeR', RTs[2], [16, 0, 0], 'linear');
  rk('armL', [[30, 0, 9], [-4, 0, 10], [-38, 0, 11], [-4, 0, 10], [30, 0, 9]]);
  rkLag('foreL', [[-46, 0, -4], [-72, 0, -4], [-98, 0, -4], [-72, 0, -4], [-46, 0, -4]], 0.24);
  rkLag('handL', [[-6, 0, 0], [-16, 0, 0], [-24, 0, 0], [-16, 0, 0], [-6, 0, 0]], 0.42);
  rk('armR', [[-38, 0, -11], [-4, 0, -10], [30, 0, -9], [-4, 0, -10], [-38, 0, -11]]);
  rkLag('foreR', [[-98, 0, 4], [-72, 0, 4], [-46, 0, 4], [-72, 0, 4], [-98, 0, 4]], 0.24);
  rkLag('handR', [[-24, 0, 4], [-16, 0, 4], [-6, 0, 4], [-16, 0, 4], [-24, 0, 4]], 0.42);
  C.run = new Clip('run', 0.58, runKeys, { loop: true });

  // ── DASH — anticipation, hard lunge, trailing after-image pose, absorb ────
  C.dash = new Clip('dash', 0.42, [
    ...pose(0, {
      pelvis: [10, 0, 0], spine1: [4, 0, 0], chest: [-6, 0, 0], neck: [-2, 0, 0], head: [-4, 0, 0],
      thighL: [-18, 0, 3], shinL: [30, 0, 0], thighR: [-14, 0, -3], shinR: [26, 0, 0],
      armL: [16, 0, 12], foreL: [-40, 0, 0], armR: [18, 0, -12], foreR: [-36, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.048, 0] },
    ...pose(0.07, {
      pelvis: [26, 0, 0], spine1: [14, 0, 0], spine2: [10, 0, 0], chest: [16, 0, 0], neck: [-14, 0, 0], head: [-18, 0, 0],
      thighL: [-52, 0, 4], shinL: [18, 0, 0], footL: [-14, 0, 0],
      thighR: [36, 0, -4], shinR: [26, 0, 0], footR: [24, 0, 0],
      armL: [52, 0, 16], foreL: [-30, 0, 0], armR: [56, 0, -16], foreR: [-26, 0, 0],
      clavL: [0, 0, -6], clavR: [0, 0, 6],
    }, 'drive'),
    { t: 0.07, b: 'pelvis', p: [0, -0.066, 0], e: 'drive' },
    ...pose(0.20, {
      pelvis: [22, 0, 0], spine1: [12, 0, 0], chest: [14, 0, 0], head: [-16, 0, 0],
      thighL: [-44, 0, 4], shinL: [26, 0, 0], thighR: [30, 0, -4], shinR: [34, 0, 0],
      armL: [46, 0, 15], armR: [50, 0, -15],
    }),
    { t: 0.20, b: 'pelvis', p: [0, -0.056, 0] },
    ...pose(0.29, {
      pelvis: [8, 0, 0], spine1: [4, 0, 0], chest: [6, 0, 0], head: [-2, 0, 0],
      thighL: [-30, 0, 5], shinL: [46, 0, 0], footL: [-6, 0, 0],
      thighR: [-16, 0, -5], shinR: [38, 0, 0], footR: [-2, 0, 0],
      armL: [-8, 0, 16], foreL: [-52, 0, 0], armR: [-6, 0, -16], foreR: [-48, 0, 0],
      clavL: [0, 0, 4], clavR: [0, 0, -4],
    }, 'outQuad'),
    { t: 0.29, b: 'pelvis', p: [0, -0.093, 0], e: 'outQuad' },
    ...stance(0.42, 'outCubic'),
    { t: 0.42, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    { t: 0, b: 'pelvis', p: [0, -0.118, -0.08] },
    ...lag(pose(0.085, {
      pelvis: [30, -34, 2], spine1: [18, -22, 0], chest: [24, -42, -6], head: [-14, 34, 0],
      armR: [-52, 0, -96], foreR: [-30, 0, 12], handR: [-8, 0, 34],
      armL: [28, 0, 46], foreL: [-66, 0, -10], thighL: [-64, 0, 8], shinL: [42, 0, 0],
      thighR: [40, 0, -8], shinR: [30, 0, 0],
    }, 'outQuad'), 0.10),
    { t: 0.085, b: 'pelvis', p: [-0.02, -0.138, -0.10], e: 'outQuad' },
    ...lag(pose(0.155, {
      pelvis: [22, 62, -2], spine1: [14, 38, 0], spine2: [10, 28, 2], chest: [18, 72, 8], head: [-8, -42, 0],
      armR: [-66, 0, 78], foreR: [-8, 0, -8], handR: [2, 0, -26],
      armL: [34, 0, -58], foreL: [-48, 0, 8], thighL: [-48, 0, 8], shinL: [54, 0, 0],
      thighR: [18, 0, -8], shinR: [38, 0, 0],
    }, 'drive'), 0.10),
    { t: 0.155, b: 'pelvis', p: [0.03, -0.113, 0.12], e: 'drive' },
    // HOLD. Measured on the right hand, this clip went from peak speed to a
    // 88deg reversal inside one segment: the cut reached full extension and
    // started coming back on the very next frame. Art bible §5: fast in, HOLD,
    // slow out. 50ms of hold is 3 frames, which is where the hit lands.
    ...lag(pose(0.205, {
      pelvis: [22, 62, -2], spine1: [14, 38, 0], spine2: [10, 28, 2], chest: [18, 72, 8], head: [-8, -42, 0],
      armR: [-66, 0, 78], foreR: [-8, 0, -8], handR: [2, 0, -26],
      armL: [34, 0, -58], foreL: [-48, 0, 8], thighL: [-48, 0, 8], shinL: [54, 0, 0],
      thighR: [18, 0, -8], shinR: [38, 0, 0],
    }, 'linear'), 0.10),
    { t: 0.205, b: 'pelvis', p: [0.03, -0.113, 0.12], e: 'linear' },
    ...lag(pose(0.235, {
      pelvis: [16, 48, 0], chest: [14, 54, 5], head: [-4, -28, 0],
      armR: [-52, 0, 64], foreR: [-22, 0, -4], armL: [22, 0, -42], foreL: [-52, 0, 4],
      thighL: [-36, 0, 6], shinL: [44, 0, 0], thighR: [8, 0, -6], shinR: [34, 0, 0],
    }, 'linear'), 0.10),
    ...settle(0.30, { pelvis: [22, 62, -2], chest: [18, 72, 8], head: [-8, -42, 0], armR: [-66, 0, 78], foreR: [-8, 0, -8], armL: [34, 0, -58] }, 0.12),
    ...stance(0.36, 'outCubic'),
    { t: 0.36, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // Two-handed driving thrust: the weapon and both shoulders form one long
  // line, with a much lower centre of gravity than either standing spear poke.
  C.dashThrust = new Clip('dashThrust', 0.37, [
    ...pose(0, {
      pelvis: [28, -8, 0], spine1: [18, -5, 0], chest: [24, -10, 0], head: [-16, 10, 0],
      armR: [-62, 0, -42], foreR: [-88, 0, 12], armL: [-58, 0, 34], foreL: [-82, 0, -10],
      thighL: [-62, 0, 6], shinL: [42, 0, 0], thighR: [38, 0, -6], shinR: [28, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.128, -0.12] },
    ...lag(pose(0.09, {
      pelvis: [34, -12, 0], spine1: [22, -8, 0], chest: [30, -16, 0], head: [-18, 18, 0],
      armR: [-78, 0, -54], foreR: [-106, 0, 14], armL: [-72, 0, 46], foreL: [-102, 0, -12],
      thighL: [-70, 0, 7], shinL: [48, 0, 0], thighR: [44, 0, -7], shinR: [30, 0, 0],
    }, 'outQuad'), 0.10),
    { t: 0.09, b: 'pelvis', p: [0, -0.148, -0.15], e: 'outQuad' },
    ...lag(pose(0.16, {
      pelvis: [30, 4, 0], spine1: [20, 2, 0], chest: [28, 6, 0], head: [-14, -4, 0],
      clavR: [0, 8, -12], armR: [-102, 0, -10], foreR: [-4, 0, 0], handR: [8, 0, 0],
      clavL: [0, 6, 10], armL: [-98, 0, 12], foreL: [-6, 0, 0], handL: [8, 0, 0],
      thighL: [-66, 0, 7], shinL: [56, 0, 0], thighR: [32, 0, -7], shinR: [38, 0, 0],
    }, 'drive'), 0.10),
    { t: 0.16, b: 'pelvis', p: [0, -0.133, 0.16], e: 'drive' },
    ...lag(pose(0.215, {
      pelvis: [30, 4, 0], spine1: [20, 2, 0], chest: [28, 6, 0], head: [-14, -4, 0],
      clavR: [0, 8, -12], armR: [-102, 0, -10], foreR: [-4, 0, 0], handR: [8, 0, 0],
      clavL: [0, 6, 10], armL: [-98, 0, 12], foreL: [-6, 0, 0], handL: [8, 0, 0],
      thighL: [-66, 0, 7], shinL: [56, 0, 0], thighR: [32, 0, -7], shinR: [38, 0, 0],
    }, 'linear'), 0.10),
    { t: 0.215, b: 'pelvis', p: [0, -0.133, 0.16], e: 'linear' },
    ...lag(pose(0.245, {
      pelvis: [22, 3, 0], chest: [20, 5, 0], head: [-8, -3, 0],
      armR: [-90, 0, -14], foreR: [-18, 0, 2], armL: [-86, 0, 16], foreL: [-20, 0, -2],
      thighL: [-48, 0, 6], shinL: [46, 0, 0], thighR: [18, 0, -6], shinR: [34, 0, 0],
    }, 'linear'), 0.10),
    ...settle(0.31, { pelvis: [30, 4, 0], chest: [28, 6, 0], head: [-14, -4, 0], armR: [-102, 0, -10], armL: [-98, 0, 12], foreR: [-4, 0, 0], foreL: [-6, 0, 0] }, 0.11),
    ...stance(0.37, 'outCubic'),
    { t: 0.37, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // Rising Dash Attack for fists/gauntlets: a planted crouch explodes into a
  // full-body uppercut, rather than borrowing the shield-rush pose.
  C.dashUpper = new Clip('dashUpper', 0.34, [
    ...pose(0, {
      pelvis: [30, 18, 0], spine1: [20, 12, 0], chest: [28, 20, 0], head: [-18, -10, 0],
      armR: [24, 0, -42], foreR: [-112, 0, 8], armL: [38, 0, 32], foreL: [-72, 0, -6],
      thighL: [-70, 0, 8], shinL: [70, 0, 0], thighR: [-34, 0, -8], shinR: [56, 0, 0],
    }, 'outQuad'),
    { t: 0, b: 'pelvis', p: [0, -0.188, -0.08] },
    ...lag(pose(0.085, {
      pelvis: [38, 24, 0], spine1: [25, 16, 0], chest: [34, 30, 0], head: [-22, -16, 0],
      armR: [42, 0, -54], foreR: [-128, 0, 10], armL: [48, 0, 40], foreL: [-82, 0, -8],
      thighL: [-78, 0, 9], shinL: [82, 0, 0], thighR: [-42, 0, -9], shinR: [68, 0, 0],
    }, 'outQuad'), 0.10),
    { t: 0.085, b: 'pelvis', p: [0, -0.218, -0.10], e: 'outQuad' },
    ...lag(pose(0.155, {
      pelvis: [-12, -8, 0], spine1: [-8, -6, 0], chest: [-24, -12, 0], head: [14, 8, 0],
      armR: [-158, 0, -14], foreR: [-8, 0, 0], handR: [10, 0, 0],
      armL: [-72, 0, 28], foreL: [-30, 0, -4], thighL: [-26, 0, 7], shinL: [38, 0, 0],
      thighR: [22, 0, -7], shinR: [32, 0, 0],
    }, 'drive'), 0.10),
    { t: 0.155, b: 'pelvis', p: [0, 0.042, 0.14], e: 'drive' },
    ...lag(pose(0.200, {
      pelvis: [-12, -8, 0], spine1: [-8, -6, 0], chest: [-24, -12, 0], head: [14, 8, 0],
      armR: [-158, 0, -14], foreR: [-8, 0, 0], handR: [10, 0, 0],
      armL: [-72, 0, 28], foreL: [-30, 0, -4], thighL: [-26, 0, 7], shinL: [38, 0, 0],
      thighR: [22, 0, -7], shinR: [32, 0, 0],
    }, 'linear'), 0.10),
    { t: 0.200, b: 'pelvis', p: [0, 0.042, 0.14], e: 'linear' },
    ...lag(pose(0.225, {
      pelvis: [-8, -6, 0], chest: [-18, -10, 0], head: [10, 6, 0],
      armR: [-142, 0, -18], foreR: [-20, 0, 0], armL: [-58, 0, 24], foreL: [-42, 0, -4],
    }, 'linear'), 0.10),
    ...settle(0.285, { pelvis: [-12, -8, 0], chest: [-24, -12, 0], head: [14, 8, 0], armR: [-158, 0, -14], foreR: [-8, 0, 0], armL: [-72, 0, 28] }, 0.13),
    ...stance(0.34, 'outCubic'),
    { t: 0.34, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── ATTACK 1 — right-to-left horizontal slash ────────────────────────────
  C.attack1 = new Clip('attack1', 0.46, [
    ...stance(0),
    ...lag(pose(0.11, {
      pelvis: [0, -16, 1], spine1: [2, -9, 0], spine2: [0, -12, 0], chest: [-8, -26, -4], neck: [0, -8, 0], head: [0, -13, 0],
      clavR: [0, -8, -6], armR: [-38, 0, -30], foreR: [-58, 0, 10], handR: [-18, 0, 10],
      clavL: [0, 6, 4], armL: [-10, 0, 20], foreL: [-46, 0, -10],
      thighL: [-4, 0, 4], shinL: [8, 0, 0], thighR: [-8, 0, -4], shinR: [12, 0, 0],
    }, 'outQuad'), 0.15),
    { t: 0.11, b: 'pelvis', p: [-0.02, -0.018, -0.030], e: 'outQuad' },
    ...lag(pose(0.20, {
      pelvis: [4, 26, 0], spine1: [6, 16, 0], spine2: [4, 13, 2], chest: [8, 26, 6], neck: [0, 8, 0], head: [6, 17, 2],
      clavR: [0, 14, 10], armR: [-58, 0, 54], foreR: [-16, 0, -6], handR: [0, 0, -16],
      clavL: [0, -10, -6], armL: [26, 0, -26], foreL: [-58, 0, 0],
      thighL: [-26, 0, 6], shinL: [22, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -8], shinR: [30, 0, 0], footR: [16, 0, 0],
    }, 'drive'), 0.15),
    { t: 0.20, b: 'pelvis', p: [0.02, -0.03, 0.055], e: 'drive' },
    ...lag(pose(0.28, {
      pelvis: [4, 26, 0], spine1: [6, 16, 0], spine2: [4, 13, 2], chest: [8, 26, 6], neck: [0, 8, 0], head: [6, 17, 2],
      clavR: [0, 14, 10], armR: [-58, 0, 54], foreR: [-16, 0, -6], handR: [0, 0, -16],
      clavL: [0, -10, -6], armL: [26, 0, -26], foreL: [-58, 0, 0],
      thighL: [-26, 0, 6], shinL: [22, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -8], shinR: [30, 0, 0], footR: [16, 0, 0],
    }, 'linear'), 0.15),
    { t: 0.28, b: 'pelvis', p: [0.02, -0.03, 0.055], e: 'linear' },
    ...pose(0.35, {
      pelvis: [2, 19, 1], chest: [4, 21, 4], head: [4, 12, 2],
      armR: [-40, 0, 44], foreR: [-34, 0, 0], armL: [14, 0, -18], foreL: [-48, 0, 0],
      thighL: [-18, 0, 5], shinL: [18, 0, 0], thighR: [10, 0, -6], shinR: [22, 0, 0],
    }, 'outQuad'),
    ...settle(0.415, { pelvis: [4, 26, 0], chest: [8, 26, 6], head: [6, 17, 2], armR: [-58, 0, 54], foreR: [-16, 0, -6], armL: [26, 0, -26] }, 0.09),
    ...stance(0.46, 'outCubic'),
    { t: 0.46, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.12, p: [0, 0, 0] }, { t: 0.20, p: [0, 0, 0.34], e: 'drive' }, { t: 0.46, p: [0, 0, 0.36] }] });

  // ── ATTACK 2 — the backhand return, lower and faster ─────────────────────
  C.attack2 = new Clip('attack2', 0.44, [
    ...stance(0),
    ...lag(pose(0.09, {
      pelvis: [2, 20, 1], spine1: [4, 12, 0], chest: [-4, 26, 5], head: [2, 14, 0],
      clavR: [0, 12, 12], armR: [-64, 0, 58], foreR: [-30, 0, -10], handR: [-6, 0, -12],
      clavL: [0, -8, -4], armL: [18, 0, -22], foreL: [-52, 0, 0],
      thighL: [-8, 0, 4], shinL: [12, 0, 0], thighR: [0, 0, -4], shinR: [8, 0, 0],
    }, 'outQuad'), 0.15),
    { t: 0.09, b: 'pelvis', p: [0.02, -0.03, -0.02], e: 'outQuad' },
    ...lag(pose(0.18, {
      pelvis: [6, -26, -2], spine1: [8, -16, 0], spine2: [6, -12, -2], chest: [12, -28, -8], neck: [0, -8, 0], head: [8, -18, -2],
      clavR: [0, -14, -12], armR: [-30, 0, -46], foreR: [-22, 0, 8], handR: [-4, 0, 14],
      clavL: [0, 10, 6], armL: [-34, 0, 30], foreL: [-40, 0, -6],
      thighL: [14, 0, 8], shinL: [28, 0, 0], footL: [14, 0, 0],
      thighR: [-28, 0, -6], shinR: [24, 0, 0], footR: [-8, 0, 0],
    }, 'drive'), 0.15),
    { t: 0.18, b: 'pelvis', p: [-0.02, -0.032, 0.05], e: 'drive' },
    ...lag(pose(0.26, {
      pelvis: [6, -26, -2], spine1: [8, -16, 0], spine2: [6, -12, -2], chest: [12, -28, -8], neck: [0, -8, 0], head: [8, -18, -2],
      clavR: [0, -14, -12], armR: [-30, 0, -46], foreR: [-22, 0, 8], handR: [-4, 0, 14],
      clavL: [0, 10, 6], armL: [-34, 0, 30], foreL: [-40, 0, -6],
      thighL: [14, 0, 8], shinL: [28, 0, 0], footL: [14, 0, 0],
      thighR: [-28, 0, -6], shinR: [24, 0, 0], footR: [-8, 0, 0],
    }, 'linear'), 0.15),
    { t: 0.26, b: 'pelvis', p: [-0.02, -0.032, 0.05], e: 'linear' },
    ...pose(0.33, {
      pelvis: [4, -18, -1], chest: [8, -20, -5], head: [6, -12, -1],
      armR: [-32, 0, -34], foreR: [-38, 0, 6], armL: [-20, 0, 22], foreL: [-42, 0, -6],
    }, 'outQuad'),
    ...settle(0.395, { pelvis: [6, -26, -2], chest: [12, -28, -8], head: [8, -18, -2], armR: [-30, 0, -46], foreR: [-22, 0, 8], armL: [-34, 0, 30] }, 0.19),
    ...stance(0.44, 'outCubic'),
    { t: 0.44, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.10, p: [0, 0, 0] }, { t: 0.18, p: [0, 0, 0.30], e: 'drive' }, { t: 0.44, p: [0, 0, 0.32] }] });

  // ── ATTACK 3 — overhead finisher, the biggest hold in the combo ──────────
  // ESCALATION. Measured across the three (root track excluded — nothing
  // consumes Animator.rootDelta, so those tracks are decoration): the hold
  // runs 77 / 77 / 93ms, the recovery 0.18 / 0.18 / 0.29s and the pelvis drop
  // 1.2 / 1.4 / 9.9cm, all correctly ordered. The FOLLOW-THROUGH was not: the
  // settle gains ran 0.11 / 0.12 / 0.14 and measured 103 / 68 / 44mm of
  // overshoot on the weapon hand, i.e. the finisher recoiled LESS than the
  // opener. attack1/2 are now 0.09 / 0.19 and attack3 gets an authored
  // trunk-rebound key instead, so the recoil escalates with the blow.
  C.attack3 = new Clip('attack3', 0.68, [
    ...stance(0),
    ...lag(pose(0.17, {
      pelvis: [-9, -7, 1], spine1: [-6, -5, 0], spine2: [-6, -4, 0], chest: [-18, -10, 0], neck: [-6, 0, 0], head: [-15, -4, 0],
      clavR: [0, -4, 16], armR: [-142, 0, -20], foreR: [-34, 0, 0], handR: [-10, 0, 0],
      clavL: [0, 4, 12], armL: [-98, 0, 26], foreL: [-44, 0, 0],
      thighL: [-10, 0, 4], shinL: [16, 0, 0], thighR: [-16, 0, -4], shinR: [24, 0, 0],
    }, 'outQuad'), 0.18),
    { t: 0.17, b: 'pelvis', p: [0, -0.04, -0.035], e: 'outQuad' },
    ...lag(pose(0.29, {
      pelvis: [32, 0, 0], spine1: [17, 0, 0], spine2: [13, 0, 0], chest: [27, 0, 0], neck: [-9, 0, 0], head: [17, 0, 0],
      clavR: [0, 2, -14], armR: [-14, 0, -8], foreR: [-8, 0, 0], handR: [6, 0, 0],
      clavL: [0, -2, -8], armL: [10, 0, 30], foreL: [-70, 0, 0],
      thighL: [-46, 0, 6], shinL: [56, 0, 0], footL: [-10, 0, 0],
      thighR: [-20, 0, -8], shinR: [64, 0, 0], footR: [10, 0, 0],
    }, 'drive'), 0.18),
    { t: 0.29, b: 'pelvis', p: [0, -0.103, 0.10], e: 'drive' },
    ...lag(pose(0.39, {
      pelvis: [32, 0, 0], spine1: [17, 0, 0], spine2: [13, 0, 0], chest: [27, 0, 0], neck: [-9, 0, 0], head: [17, 0, 0],
      clavR: [0, 2, -14], armR: [-14, 0, -8], foreR: [-8, 0, 0], handR: [6, 0, 0],
      clavL: [0, -2, -8], armL: [10, 0, 30], foreL: [-70, 0, 0],
      thighL: [-46, 0, 6], shinL: [56, 0, 0], footL: [-10, 0, 0],
      thighR: [-20, 0, -8], shinR: [64, 0, 0], footR: [10, 0, 0],
    }, 'linear'), 0.18),
    { t: 0.39, b: 'pelvis', p: [0, -0.103, 0.10], e: 'linear' },
    ...pose(0.52, {
      pelvis: [16, 2, 1], spine1: [8, 0, 0], chest: [12, 4, 0], head: [8, 2, 0],
      armR: [-26, 0, -12], foreR: [-24, 0, 4], armL: [-2, 0, 22], foreL: [-52, 0, 0],
      thighL: [-26, 0, 5], shinL: [34, 0, 0], thighR: [-10, 0, -5], shinR: [30, 0, 0],
    }, 'outQuad'),
    // settle() cannot serve this one. It mirrors the committed pose through
    // STANCE, and attack3's committed pose already has the weapon arm nearly
    // at rest (armR -14 against a stance of -4), so there was almost no
    // distance for it to mirror: the finisher recoiled 44mm where the opener
    // recoiled 103. An overhead that buries itself recoils by pitching the
    // whole trunk BACK off the blow, so that is authored directly.
    ...pose(0.605, {
      pelvis: [-7, 1, 0], spine1: [-5, 0, 0], spine2: [-4, 0, 0], chest: [-11, 2, 0], neck: [3, 0, 0], head: [-8, 1, 0],
      clavR: [0, 0, 7], armR: [0, 0, -20], foreR: [-31, 0, 5], handR: [-13, 0, 23],
      clavL: [0, 0, 7], armL: [-16, 0, 31], foreL: [-40, 0, -3],
      thighL: [-11, 0, 5], shinL: [17, 0, 0], thighR: [5, 0, -4], shinR: [9, 0, 0],
    }, 'outQuad'),
    { t: 0.605, b: 'pelvis', p: [0.006, -0.004, -0.012], e: 'outQuad' },
    ...stance(0.68, 'outCubic'),
    { t: 0.68, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.18, p: [0, 0, -0.06] }, { t: 0.29, p: [0, 0, 0.56], e: 'drive' }, { t: 0.68, p: [0, 0, 0.58] }] });

  // ── SPECIAL — a committed two-handed shove ───────────────────────────────
  C.special = new Clip('special', 0.54, [
    ...stance(0),
    ...lag(pose(0.13, {
      pelvis: [-8, -4, 1], spine1: [-6, 0, 0], chest: [-18, -6, 0], head: [-10, -4, 0],
      armR: [-44, 0, -40], foreR: [-104, 0, 16], handR: [-16, 0, -10],
      armL: [-40, 0, 40], foreL: [-108, 0, -16], handL: [-16, 0, 10],
      thighL: [-6, 0, 5], shinL: [18, 0, 0], thighR: [-16, 0, -5], shinR: [30, 0, 0],
    }, 'outQuad'), 0.16),
    { t: 0.13, b: 'pelvis', p: [0, -0.063, -0.045], e: 'outQuad' },
    ...lag(pose(0.23, {
      pelvis: [22, 0, 0], spine1: [12, 0, 0], spine2: [10, 0, 0], chest: [20, 0, 0], neck: [-8, 0, 0], head: [10, 0, 0],
      clavL: [0, -12, -20], clavR: [0, 12, 20],
      armR: [-102, 0, -36], foreR: [-26, 0, 12], handR: [14, 0, -12],
      armL: [-100, 0, 36], foreL: [-26, 0, -12], handL: [14, 0, 12],
      thighL: [-34, 0, 10], shinL: [26, 0, 0], footL: [-6, 0, 0],
      thighR: [12, 0, -12], shinR: [22, 0, 0], footR: [12, 0, 0],
    }, 'drive'), 0.16),
    { t: 0.23, b: 'pelvis', p: [0, -0.048, 0.07], e: 'drive' },
    ...lag(pose(0.32, {
      pelvis: [22, 0, 0], spine1: [12, 0, 0], spine2: [10, 0, 0], chest: [20, 0, 0], neck: [-8, 0, 0], head: [10, 0, 0],
      clavL: [0, -12, -20], clavR: [0, 12, 20],
      armR: [-102, 0, -36], foreR: [-26, 0, 12], handR: [14, 0, -12],
      armL: [-100, 0, 36], foreL: [-26, 0, -12], handL: [14, 0, 12],
      thighL: [-34, 0, 10], shinL: [26, 0, 0], footL: [-6, 0, 0],
      thighR: [12, 0, -12], shinR: [22, 0, 0], footR: [12, 0, 0],
    }, 'linear'), 0.16),
    { t: 0.32, b: 'pelvis', p: [0, -0.048, 0.07], e: 'linear' },
    ...pose(0.40, {
      pelvis: [12, 0, 0], spine1: [7, 0, 0], chest: [12, 0, 0], head: [6, 0, 0],
      armR: [-66, 0, -30], foreR: [-40, 0, 8], armL: [-64, 0, 30], foreL: [-40, 0, -8],
      thighL: [-28, 0, 5], shinL: [26, 0, 0], thighR: [12, 0, -5], shinR: [22, 0, 0],
    }, 'outQuad'),
    { t: 0.40, b: 'pelvis', p: [0, -0.048, 0.05], e: 'outQuad' },
    ...settle(0.465, { pelvis: [22, 0, 0], chest: [20, 0, 0], head: [10, 0, 0], armR: [-102, 0, -36], armL: [-100, 0, 36], foreR: [-26, 0, 12], foreL: [-26, 0, -12] }, 0.13),
    ...stance(0.54, 'outCubic'),
    { t: 0.54, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ], { root: [{ t: 0, p: [0, 0, 0] }, { t: 0.14, p: [0, 0, -0.05] }, { t: 0.23, p: [0, 0, 0.46], e: 'drive' }, { t: 0.54, p: [0, 0, 0.48] }] });

  // ── CAST — plant, gather, release ────────────────────────────────────────
  const CAST_COMMIT = {
      pelvis: [10, 12, 0], spine1: [8, 8, 0], spine2: [6, 6, 0], chest: [12, 16, 2], neck: [-4, 4, 0], head: [4, 10, 0],
      clavL: [0, 8, -12], armL: [-104, 0, 10], foreL: [-6, 0, 0], handL: [12, 0, 0],
      armR: [12, 0, -22], foreR: [-46, 0, 12],
      thighL: [-34, 0, 6], shinL: [30, 0, 0], footL: [-8, 0, 0],
      thighR: [16, 0, -6], shinR: [26, 0, 0], footR: [16, 0, 0],
  };
  C.cast = new Clip('cast', 0.60, [
    ...stance(0),
    ...lag(pose(0.17, {
      pelvis: [-4, -12, 2], spine1: [-4, -8, 0], chest: [-14, -18, -2], neck: [0, -6, 0], head: [-6, -12, 0],
      clavL: [0, -6, 10], armL: [-72, 0, 34], foreL: [-104, 0, -22], handL: [-24, 0, 0],
      armR: [-6, 0, -14], foreR: [-30, 0, 10],
      thighL: [-4, 0, 5], shinL: [12, 0, 0], thighR: [-14, 0, -5], shinR: [26, 0, 0],
    }, 'outQuad'), 0.16),
    { t: 0.17, b: 'pelvis', p: [-0.01, -0.048, -0.03], e: 'outQuad' },
    ...lag(pose(0.30, CAST_COMMIT, 'drive'), 0.16),
    { t: 0.30, b: 'pelvis', p: [0.01, -0.038, 0.055], e: 'drive' },
    ...lag(pose(0.42, CAST_COMMIT, 'linear'), 0.16),
    { t: 0.42, b: 'pelvis', p: [0.01, -0.038, 0.055], e: 'linear' },
    // THE DECAY TAIL. Two evenly spaced returns instead of one late whip: 58%
    // of the distance by 0.495, the overshoot at 0.555, stance at 0.60.
    ...ret(0.490, CAST_COMMIT, 0.58, 'linear'),
    ...settle(0.545, { pelvis: [10, 12, 0], chest: [12, 16, 2], head: [4, 10, 0], armL: [-104, 0, 10], foreL: [-6, 0, 0], armR: [12, 0, -22] }, 0.09),
    ...stance(0.60, 'outCubic'),
    { t: 0.60, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── CAST SWEEP — tidal / radiant boons open both arms across the stage ───
  C.castSweep = new Clip('castSweep', 0.60, [
    ...stance(0),
    ...lag(pose(0.16, {
      pelvis: [-8, -22, 2], spine1: [-5, -14, 0], chest: [-12, -28, -2], head: [-5, -18, 1],
      clavL: [0, -10, 12], armL: [-58, 0, 42], foreL: [-94, 0, -18], handL: [-20, 0, 0],
      clavR: [0, 8, -8], armR: [-38, 0, -32], foreR: [-72, 0, 14], handR: [-14, 0, 0],
      thighL: [-8, 0, 6], shinL: [18, 0, 0], thighR: [-18, 0, -5], shinR: [30, 0, 0],
    }, 'outQuad'), 0.16),
    { t: 0.16, b: 'pelvis', p: [-0.025, -0.063, -0.035], e: 'outQuad' },
    ...lag(pose(0.30, {
      pelvis: [12, 18, 0], spine1: [8, 12, 0], spine2: [6, 10, 0], chest: [14, 28, 1], head: [5, 18, 0],
      clavL: [0, 12, -10], armL: [-88, 0, 30], foreL: [-18, 0, -10], handL: [10, 0, 0],
      clavR: [0, -12, 10], armR: [-90, 0, -28], foreR: [-16, 0, 10], handR: [10, 0, 0],
      thighL: [-34, 0, 7], shinL: [30, 0, 0], thighR: [16, 0, -6], shinR: [26, 0, 0],
    }, 'drive'), 0.16),
    { t: 0.30, b: 'pelvis', p: [0.025, -0.043, 0.07], e: 'drive' },
    ...pose(0.43, {
      pelvis: [10, 12, 0], spine1: [7, 8, 0], chest: [10, 18, 0], head: [3, 12, 0],
      armL: [-96, 0, 38], foreL: [-8, 0, -8], armR: [-96, 0, -36], foreR: [-8, 0, 8],
      thighL: [-28, 0, 6], shinL: [28, 0, 0], thighR: [12, 0, -5], shinR: [24, 0, 0],
    }, 'linear'),
    ...settle(0.525, { pelvis: [12, 18, 0], chest: [14, 28, 1], head: [5, 18, 0], armL: [-88, 0, 30], armR: [-90, 0, -28], foreL: [-18, 0, -10], foreR: [-16, 0, 10] }, 0.11),
    ...stance(0.60, 'outCubic'),
    { t: 0.60, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── CAST RITUAL — chthonic boons gather low, then invoke overhead ────────
  const RITUAL_INVOKE = {
    pelvis: [8, 0, 0], spine1: [7, 0, 0], chest: [12, 0, 0], head: [6, 0, 0],
    armL: [-148, 0, 28], foreL: [-18, 0, -10], armR: [-148, 0, -28], foreR: [-18, 0, 10],
    thighL: [-26, 0, 6], shinL: [28, 0, 0], thighR: [10, 0, -6], shinR: [24, 0, 0],
  };
  C.castRitual = new Clip('castRitual', 0.68, [
    ...stance(0),
    ...lag(pose(0.20, {
      pelvis: [-15, 0, 2], spine1: [-12, 0, 0], spine2: [-10, 0, 0], chest: [-18, 0, 0], head: [-10, 0, 0],
      clavL: [0, -8, 12], clavR: [0, 8, -12],
      armL: [-46, 0, 36], foreL: [-112, 0, -22], handL: [-26, 0, 0],
      armR: [-46, 0, -36], foreR: [-112, 0, 22], handR: [-26, 0, 0],
      thighL: [-20, 0, 7], shinL: [42, 0, 0], thighR: [-20, 0, -7], shinR: [42, 0, 0],
    }, 'outQuad'), 0.18),
    { t: 0.20, b: 'pelvis', p: [0, -0.118, -0.035], e: 'outQuad' },
    ...lag(pose(0.34, {
      pelvis: [9, 0, 0], spine1: [8, 0, 0], spine2: [8, 0, 0], chest: [15, 0, 0], neck: [-7, 0, 0], head: [8, 0, 0],
      clavL: [0, 0, -10], clavR: [0, 0, 10],
      armL: [-154, 0, 26], foreL: [-22, 0, -10], handL: [14, 0, 0],
      armR: [-154, 0, -26], foreR: [-22, 0, 10], handR: [14, 0, 0],
      thighL: [-32, 0, 7], shinL: [30, 0, 0], thighR: [12, 0, -7], shinR: [26, 0, 0],
    }, 'drive'), 0.18),
    { t: 0.34, b: 'pelvis', p: [0, -0.053, 0.055], e: 'drive' },
    // the invoke drifts a few degrees while the boon lands...
    ...pose(0.44, RITUAL_INVOKE, 'linear'),
    // ...and then unwinds in two even steps. Both arms are 148deg from stance
    // here, and taking all of that in the single 100ms segment this used to
    // have made the RECOVERY the fastest thing in the clip: 14.4 m/s at the
    // wrist against 10 m/s in the invoke itself, with the peak at 88% of the
    // clip. Two steps put the peak back in the strike and leave a real decay.
    ...ret(0.525, RITUAL_INVOKE, 0.55, 'linear'),
    ...settle(0.61, { pelvis: [9, 0, 0], chest: [15, 0, 0], head: [8, 0, 0], armL: [-154, 0, 26], armR: [-154, 0, -26], foreL: [-22, 0, -10], foreR: [-22, 0, 10] }, 0.05),
    ...stance(0.68, 'outCubic'),
    { t: 0.68, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    { t: 0.07, b: 'pelvis', p: [0, -0.063, -0.06], e: 'outQuint' },
    ...pose(0.18, {
      pelvis: [-6, 0, 0], chest: [-14, 2, 0], head: [-10, 4, 0],
      armL: [-24, 0, 22], foreL: [-62, 0, 0], armR: [-20, 0, -24], foreR: [-58, 0, 0],
      thighL: [-10, 0, 5], shinL: [20, 0, 0],
    }, 'outQuad'),
    { t: 0.18, b: 'pelvis', p: [0, -0.038, -0.03], e: 'outQuad' },
    ...stance(0.34, 'outCubic'),
    { t: 0.34, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    { t: 0.15, b: 'pelvis', p: [0, -0.068, -0.07], e: 'outQuint' },
    ...pose(0.45, {
      pelvis: [-4, -6, 6], spine1: [4, -4, 3], chest: [10, -8, 6], neck: [4, 0, 0], head: [8, -6, 4],
      armL: [-14, 0, 26], foreL: [-58, 0, 0], armR: [-10, 0, -28], foreR: [-50, 0, 0],
      thighL: [-44, 0, 8], shinL: [66, 0, 0], footL: [-16, 0, 0],
      thighR: [-34, 0, -8], shinR: [58, 0, 0], footR: [-12, 0, 0],
    }, 'outQuad'),
    { t: 0.45, b: 'pelvis', p: [0, -0.228, -0.02], e: 'outQuad' },
    ...pose(0.9, {
      pelvis: [10, -8, 8], spine1: [10, -5, 4], spine2: [10, -4, 4], chest: [22, -10, 8], neck: [6, 0, 0], head: [14, -8, 6],
      armL: [-6, 0, 22], foreL: [-46, 0, 0], armR: [-4, 0, -24], foreR: [-40, 0, 0],
      thighL: [-82, 0, 9], shinL: [104, 0, 0], footL: [24, 0, 0],
      thighR: [-76, 0, -9], shinR: [100, 0, 0], footR: [22, 0, 0],
    }, 'outQuad'),
    { t: 0.9, b: 'pelvis', p: [0, -0.488, 0.04], e: 'outQuad' },
    ...pose(1.7, {
      pelvis: [24, -10, 10], spine1: [18, -6, 5], spine2: [16, -5, 5], chest: [40, -12, 10], neck: [10, 0, 0], head: [30, -10, 8],
      clavL: [0, 0, -8], clavR: [0, 0, 8],
      armL: [-16, 0, 14], foreL: [-30, 0, 0], armR: [-12, 0, -16], foreR: [-26, 0, 0],
      thighL: [-92, 0, 10], shinL: [116, 0, 0], footL: [28, 0, 0],
      thighR: [-88, 0, -10], shinR: [112, 0, 0], footR: [26, 0, 0],
    }, 'outCubic'),
    { t: 1.7, b: 'pelvis', p: [0, -0.618, 0.11], e: 'outCubic' },
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

  // ── FOLLOW-THROUGH ───────────────────────────────────────────────────────
  // Only attack1/2/3 used to overshoot on the way out. Every other strike in
  // the arsenal went hold -> stance and stopped exactly on its rest pose,
  // which is the definition of a weightless hit: nothing that a body has just
  // thrown 100 degrees of shoulder into arrives at neutral and stays there.
  // settle() mirrors the committed pose through STANCE by `k` of the distance
  // just travelled, so the overshoot is along the momentum, and the closing
  // stance key pulls it back. `k` scales with how much mass the blow moved.

  // ── SPEAR: THRUST 1 — two-handed stab. The hitbox is a LINE, so the pose
  //    has to be a line: both hands on the shaft, shoulders square behind it.
  C.thrust1 = new Clip('thrust1', 0.405, [
    ...stance(0),
    ...lag(pose(0.135, {
      pelvis: [-4, -14, 1], spine1: [-4, -9, 0], spine2: [-3, -8, 0], chest: [-12, -20, -2], neck: [0, 14, 0], head: [-4, 30, 0],
      clavR: [0, -6, 6], armR: [-16, 0, -34], foreR: [-104, 0, 16], handR: [-12, 0, 8],
      clavL: [0, -4, 4], armL: [-30, 0, 26], foreL: [-96, 0, -14], handL: [-10, 0, 0],
      thighL: [-6, 0, 5], shinL: [14, 0, 0], thighR: [12, 0, -5], shinR: [32, 0, 0], footR: [10, 0, 0],
    }, 'outQuad'), 0.14),
    { t: 0.135, b: 'pelvis', p: [0, -0.048, -0.055], e: 'outQuad' },
    ...lag(pose(0.195, {
      pelvis: [18, 17, 0], spine1: [10, 11, 0], spine2: [8, 9, 0], chest: [14, 20, 0], neck: [-4, -8, 0], head: [6, -12, 0],
      clavR: [0, 10, -14], armR: [-93, 0, -3], foreR: [-6, 0, 2], handR: [2, 0, 0],
      clavL: [0, 8, 12], armL: [-89, 0, 5], foreL: [-10, 0, -2], handL: [2, 0, 0],
      thighL: [-50, 0, 6], shinL: [24, 0, 0], footL: [-12, 0, 0],
      thighR: [28, 0, -6], shinR: [24, 0, 0], footR: [22, 0, 0],
    }, 'drive'), 0.14),
    { t: 0.195, b: 'pelvis', p: [0, -0.073, 0.115], e: 'drive' },
    ...lag(pose(0.255, {
      pelvis: [18, 17, 0], spine1: [10, 11, 0], spine2: [8, 9, 0], chest: [14, 20, 0], neck: [-4, -8, 0], head: [6, -12, 0],
      clavR: [0, 10, -14], armR: [-93, 0, -3], foreR: [-6, 0, 2], handR: [2, 0, 0],
      clavL: [0, 8, 12], armL: [-89, 0, 5], foreL: [-10, 0, -2], handL: [2, 0, 0],
      thighL: [-50, 0, 6], shinL: [24, 0, 0], footL: [-12, 0, 0],
      thighR: [28, 0, -6], shinR: [24, 0, 0], footR: [22, 0, 0],
    }, 'linear'), 0.14),
    { t: 0.255, b: 'pelvis', p: [0, -0.073, 0.115], e: 'linear' },
    ...pose(0.328, {
      pelvis: [10, 3, 1], chest: [8, 5, 0], head: [4, 2, 0],
      armR: [-52, 0, -22], foreR: [-46, 0, 8], armL: [-50, 0, 20], foreL: [-52, 0, -6],
      thighL: [-26, 0, 5], shinL: [20, 0, 0], thighR: [10, 0, -5], shinR: [22, 0, 0],
    }, 'outQuad'),
    ...settle(0.362, { pelvis: [18, 17, 0], chest: [14, 20, 0], head: [6, -12, 0], armR: [-93, 0, -3], armL: [-89, 0, 5], foreR: [-6, 0, 2], foreL: [-10, 0, -2] }, 0.10),
    ...stance(0.405, 'outCubic'),
    { t: 0.405, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── SPEAR: THRUST 2 — the low return poke, shorter windup, dropped line.
  C.thrust2 = new Clip('thrust2', 0.375, [
    ...stance(0),
    ...lag(pose(0.115, {
      pelvis: [4, -10, -2], spine1: [2, -7, 0], chest: [-6, -16, -4], neck: [0, 12, 0], head: [-2, 22, 0],
      clavR: [0, -4, 2], armR: [-8, 0, -30], foreR: [-96, 0, 20], handR: [-10, 0, 10],
      clavL: [0, -2, 0], armL: [-20, 0, 24], foreL: [-88, 0, -16],
      thighL: [-2, 0, 5], shinL: [10, 0, 0], thighR: [8, 0, -5], shinR: [26, 0, 0],
    }, 'outQuad'), 0.14),
    { t: 0.115, b: 'pelvis', p: [0, -0.06, -0.040], e: 'outQuad' },
    ...lag(pose(0.175, {
      pelvis: [31, 2, -1], spine1: [16, 1, 0], spine2: [13, 1, 0], chest: [23, 3, -2], neck: [-4, 0, 0], head: [14, 0, 0],
      clavR: [0, 4, -4], armR: [-62, 0, -16], foreR: [-4, 0, 2], handR: [14, 0, 0],
      clavL: [0, 2, 14], armL: [-58, 0, 18], foreL: [-10, 0, -2],
      thighL: [-66, 0, 6], shinL: [38, 0, 0], footL: [-16, 0, 0],
      thighR: [36, 0, -6], shinR: [20, 0, 0], footR: [26, 0, 0],
    }, 'drive'), 0.14),
    { t: 0.175, b: 'pelvis', p: [0, -0.103, 0.120], e: 'drive' },
    ...lag(pose(0.235, {
      pelvis: [31, 2, -1], spine1: [16, 1, 0], spine2: [13, 1, 0], chest: [23, 3, -2], neck: [-4, 0, 0], head: [14, 0, 0],
      clavR: [0, 4, -4], armR: [-62, 0, -16], foreR: [-4, 0, 2], handR: [14, 0, 0],
      clavL: [0, 2, 14], armL: [-58, 0, 18], foreL: [-10, 0, -2],
      thighL: [-66, 0, 6], shinL: [38, 0, 0], footL: [-16, 0, 0],
      thighR: [36, 0, -6], shinR: [20, 0, 0], footR: [26, 0, 0],
    }, 'linear'), 0.14),
    { t: 0.235, b: 'pelvis', p: [0, -0.103, 0.120], e: 'linear' },
    ...pose(0.302, {
      pelvis: [13, 2, -1], chest: [10, 3, -1], head: [4, 0, 0],
      armR: [-44, 0, -22], foreR: [-48, 0, 10], armL: [-42, 0, 20], foreL: [-46, 0, -8],
      thighL: [-30, 0, 5], shinL: [22, 0, 0], thighR: [16, 0, -5], shinR: [20, 0, 0],
    }, 'outQuad'),
    { t: 0.302, b: 'pelvis', p: [0, -0.063, 0.058], e: 'outQuad' },
    ...settle(0.335, { pelvis: [31, 2, -1], chest: [23, 3, -2], head: [14, 0, 0], armR: [-62, 0, -16], armL: [-58, 0, 18], foreR: [-4, 0, 2], foreL: [-10, 0, -2] }, 0.10),
    ...stance(0.375, 'outCubic'),
    { t: 0.375, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── SPEAR: SPIN — a 360 sweep read entirely in the SPINE. The root never
  //    rotates (facing is gameplay state), so the whip has to live in the
  //    pelvis/chest counter-rotation and two horizontally extended arms.
  C.spin = new Clip('spin', 0.615, [
    ...stance(0),
    ...lag(pose(0.200, {
      pelvis: [-2, -30, 2], spine1: [-2, -18, 0], spine2: [-2, -15, 0], chest: [-10, -30, -4], neck: [0, 22, 0], head: [-4, 40, 0],
      clavR: [0, -10, -6], armR: [-24, 0, -62], foreR: [-56, 0, 6], handR: [-10, 0, 12],
      clavL: [0, 8, 10], armL: [-12, 0, 48], foreL: [-70, 0, -8],
      thighL: [-14, 0, 7], shinL: [26, 0, 0], thighR: [-4, 0, -7], shinR: [20, 0, 0],
    }, 'outQuad'), 0.16),
    { t: 0.200, b: 'pelvis', p: [0, -0.068, -0.020], e: 'outQuad' },
    ...lag(pose(0.295, {
      pelvis: [8, 55, 0], spine1: [6, 30, 0], spine2: [5, 26, 0], chest: [12, 48, 2], neck: [-2, -18, 0], head: [6, -34, 0],
      clavR: [0, 16, 12], armR: [-4, 0, -86], foreR: [-6, 0, 4], handR: [0, 0, -14],
      clavL: [0, -14, -10], armL: [-2, 0, 82], foreL: [-8, 0, -4],
      thighL: [-14, 0, 16], shinL: [18, 0, 0], footL: [-6, 0, 0],
      thighR: [-8, 0, -18], shinR: [16, 0, 0], footR: [-2, 0, 0],
    }, 'drive'), 0.16),
    { t: 0.295, b: 'pelvis', p: [0, -0.088, 0.045], e: 'drive' },
    ...lag(pose(0.385, {
      pelvis: [6, 70, 0], spine1: [5, 38, 0], spine2: [4, 32, 0], chest: [9, 62, 2], neck: [-2, -26, 0], head: [4, -46, 0],
      clavR: [0, 16, 12], armR: [-8, 0, -80], foreR: [-14, 0, 4], handR: [0, 0, -12],
      clavL: [0, -14, -10], armL: [-6, 0, 76], foreL: [-16, 0, -4],
      thighL: [-12, 0, 14], shinL: [20, 0, 0], thighR: [-6, 0, -16], shinR: [18, 0, 0],
    }, 'linear'), 0.16),
    { t: 0.385, b: 'pelvis', p: [0, -0.078, 0.030], e: 'linear' },
    ...pose(0.480, {
      pelvis: [4, 26, 1], spine1: [3, 14, 0], chest: [6, 22, 1], neck: [0, -12, 0], head: [2, -22, 0],
      armR: [-20, 0, -50], foreR: [-40, 0, 6], armL: [-16, 0, 46], foreL: [-44, 0, -6],
      thighL: [-14, 0, 8], shinL: [22, 0, 0], thighR: [-4, 0, -8], shinR: [18, 0, 0],
    }, 'outQuad'),
    ...settle(0.555, { pelvis: [6, 70, 0], chest: [9, 62, 2], head: [4, -46, 0], armR: [-8, 0, -80], armL: [-6, 0, 76], neck: [-2, -26, 0] }, 0.12),
    ...stance(0.615, 'outCubic'),
    { t: 0.615, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    { t: 0.16, b: 'pelvis', p: [0, -0.046, -0.045], e: 'outQuad' },
    ...pose(0.50, {
      pelvis: [-8, -18, 3], spine1: [-6, -12, 0], spine2: [-6, -10, 0], chest: [-20, -20, -3], neck: [0, 22, 0], head: [-8, 40, 0],
      clavR: [0, -8, 20], armR: [-152, 0, -26], foreR: [-48, 0, 4], handR: [-6, 0, 0],
      clavL: [0, 4, 12], armL: [-78, 0, 30], foreL: [-20, 0, -8], handL: [-6, 0, 0],
      thighL: [-14, 0, 6], shinL: [20, 0, 0], footL: [-4, 4, 0],
      thighR: [12, 0, -6], shinR: [40, 0, 0], footR: [14, -3, 0],
    }, 'outCubic'),
    { t: 0.50, b: 'pelvis', p: [0, -0.078, -0.085], e: 'outCubic' },
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
    { t: 0, b: 'pelvis', p: [0, -0.078, -0.085] },
    ...lag(pose(0.095, {
      pelvis: [22, 18, -2], spine1: [13, 12, 0], spine2: [11, 10, 0], chest: [24, 20, 4], neck: [-6, -16, 0], head: [10, -30, 0],
      clavR: [0, 12, -16], armR: [-34, 0, -12], foreR: [-12, 0, 0], handR: [8, 0, 0],
      clavL: [0, -8, -8], armL: [24, 0, -26], foreL: [-58, 0, 4],
      thighL: [-52, 0, 6], shinL: [34, 0, 0], footL: [-12, 0, 0],
      thighR: [30, 0, -6], shinR: [26, 0, 0], footR: [22, 0, 0],
    }, 'drive'), 0.12),
    { t: 0.095, b: 'pelvis', p: [0, -0.088, 0.120], e: 'drive' },
    ...pose(0.17, {
      pelvis: [18, 14, -1], chest: [20, 16, 3], neck: [0, -12, 0], head: [8, -22, 0],
      armR: [-28, 0, -20], foreR: [-30, 0, 4], armL: [8, 0, -18], foreL: [-52, 0, 4],
      thighL: [-38, 0, 6], shinL: [30, 0, 0], thighR: [18, 0, -6], shinR: [26, 0, 0],
    }, 'outQuad'),
    ...settle(0.255, { pelvis: [22, 18, -2], chest: [24, 20, 4], head: [10, -30, 0], armR: [-34, 0, -12], armL: [24, 0, -26], foreR: [-12, 0, 0] }, 0.13),
    ...stance(0.33, 'outCubic'),
    { t: 0.33, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    { t: 0.18, b: 'pelvis', p: [0, -0.04, -0.010], e: 'outQuad' },
    ...pose(0.55, {
      pelvis: [2, -22, 2], spine1: [1, -14, 0], spine2: [1, -12, 0], chest: [-4, -26, -1], neck: [-1, 28, 0], head: [2, 46, 0],
      clavL: [0, 8, 8], armL: [-86, 0, 12], foreL: [-6, 0, -2], handL: [-2, 0, 0],
      clavR: [0, -10, -16], armR: [-58, 0, -54], foreR: [-120, 0, 18], handR: [-4, 0, 14],
      thighL: [-18, 0, 7], shinL: [20, 0, 0], footL: [-4, 4, 0],
      thighR: [8, 0, -9], shinR: [16, 0, 0], footR: [2, -8, 0],
    }, 'outCubic'),
    { t: 0.55, b: 'pelvis', p: [0, -0.066, -0.020], e: 'outCubic' },
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
    { t: 0, b: 'pelvis', p: [0, -0.066, -0.020] },
    // THE RELEASE HAS TO BE A DIFFERENT POSE FROM THE DRAW. `loose` opens on
    // the full-draw pose by construction — it is the same key `draw` ends on —
    // so if the release is only a small unclench the two clips read as one
    // pose held for 0.8s, which is what the arsenal measurement caught (draw
    // and loose are the closest pair in the whole kit, in every version).
    // A loosed bow SNAPS OPEN: the chest unwinds square to the target, the
    // string hand flies back past the ear and up, and the bow arm follows the
    // arrow out and dips. That is a big, cheap, unmistakable second pose.
    ...pose(0.055, {
      pelvis: [2, -9, 2], spine1: [1, -4, 0], chest: [0, -5, -3], neck: [-1, 9, 0], head: [2, 19, 0],
      clavL: [0, 10, 10], armL: [-97, 0, 21], foreL: [-4, 0, -2],
      clavR: [0, -18, -30], armR: [-53, 0, -94], foreR: [-42, 0, 34], handR: [-30, 0, 40],
      thighL: [-16, 0, 7], shinL: [18, 0, 0], thighR: [6, 0, -9], shinR: [14, 0, 0],
    }, 'outQuint'),
    ...pose(0.14, {
      pelvis: [1, -7, 2], chest: [0, -4, -1], neck: [0, 7, 0], head: [2, 13, 0],
      armL: [-82, 0, 22], foreL: [-20, 0, -2], armR: [-38, 0, -78], foreR: [-38, 0, 28], handR: [-26, 0, 34],
    }, 'outQuad'),
    ...settle(0.215, { chest: [0, -5, -3], head: [2, 19, 0], armR: [-53, 0, -94], foreR: [-42, 0, 34], armL: [-97, 0, 21] }, 0.09),
    ...stance(0.28, 'outCubic'),
    { t: 0.28, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── SHIELD: BASH 1 — the shield arm (LEFT) drives; the sword arm stays
  //    cocked low behind so the silhouette keeps its two negative-space holes.
  C.bash1 = new Clip('bash1', 0.405, [
    ...stance(0),
    ...lag(pose(0.12, {
      pelvis: [-2, 16, 2], spine1: [-2, 10, 0], chest: [-10, 22, 4], neck: [0, -14, 0], head: [-4, -26, 0],
      clavL: [0, -8, 8], armL: [-32, 0, 34], foreL: [-98, 0, -16], handL: [-14, 0, 0],
      clavR: [0, 4, -4], armR: [-4, 0, -30], foreR: [-52, 0, 12],
      thighL: [-2, 0, 5], shinL: [12, 0, 0], thighR: [10, 0, -5], shinR: [28, 0, 0],
    }, 'outQuad'), 0.10),
    { t: 0.12, b: 'pelvis', p: [0, -0.05, -0.050], e: 'outQuad' },
    ...lag(pose(0.185, {
      pelvis: [20, -18, -1], spine1: [11, -12, 0], spine2: [9, -10, 0], chest: [16, -22, -5], neck: [-4, 22, 0], head: [8, 34, 0],
      clavL: [0, 12, -10], armL: [-94, 0, 10], foreL: [-18, 0, -4], handL: [-4, 0, 0],
      clavR: [0, -6, 6], armR: [-10, 0, -36], foreR: [-62, 0, 14],
      thighL: [-46, 0, 6], shinL: [26, 0, 0], footL: [-10, 0, 0],
      thighR: [24, 0, -6], shinR: [26, 0, 0], footR: [20, 0, 0],
    }, 'drive'), 0.10),
    { t: 0.185, b: 'pelvis', p: [0, -0.076, 0.100], e: 'drive' },
    ...lag(pose(0.255, {
      pelvis: [20, -18, -1], spine1: [11, -12, 0], spine2: [9, -10, 0], chest: [16, -22, -5], neck: [-4, 22, 0], head: [8, 34, 0],
      clavL: [0, 12, -10], armL: [-94, 0, 10], foreL: [-18, 0, -4], handL: [-4, 0, 0],
      clavR: [0, -6, 6], armR: [-10, 0, -36], foreR: [-62, 0, 14],
      thighL: [-46, 0, 6], shinL: [26, 0, 0], footL: [-10, 0, 0],
      thighR: [24, 0, -6], shinR: [26, 0, 0], footR: [20, 0, 0],
    }, 'linear'), 0.10),
    { t: 0.255, b: 'pelvis', p: [0, -0.076, 0.100], e: 'linear' },
    ...pose(0.31, {
      pelvis: [12, -11, -1], chest: [9, -13, -3], neck: [-2, 13, 0], head: [5, 20, 0],
      armL: [-66, 0, 18], foreL: [-46, 0, -8], armR: [-8, 0, -33], foreR: [-58, 0, 13],
      thighL: [-28, 0, 5], shinL: [22, 0, 0], thighR: [13, 0, -5], shinR: [22, 0, 0],
    }, 'outQuad'),
    { t: 0.31, b: 'pelvis', p: [0, -0.05, 0.052], e: 'outQuad' },
    ...settle(0.36, { pelvis: [20, -18, -1], chest: [16, -22, -5], head: [8, 34, 0], armL: [-94, 0, 10], foreL: [-18, 0, -4], armR: [-10, 0, -36] }, 0.12),
    ...stance(0.405, 'outCubic'),
    { t: 0.405, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
  ]);

  // ── SHIELD: BASH 2 — the shoulder-check. Whole body behind the boss of the
  //    shield, both feet leave the line, the biggest hold in the arm's kit.
  C.bash2 = new Clip('bash2', 0.505, [
    ...stance(0),
    ...lag(pose(0.14, {
      pelvis: [-10, 22, 3], spine1: [-8, 14, 0], spine2: [-7, 12, 0], chest: [-22, 30, 6], neck: [-2, -22, 0], head: [-10, -44, 0],
      clavL: [0, -10, 12], armL: [-40, 0, 38], foreL: [-104, 0, -18], handL: [-16, 0, 0],
      clavR: [0, 6, -6], armR: [-2, 0, -34], foreR: [-46, 0, 14],
      thighL: [-4, 0, 5], shinL: [16, 0, 0], thighR: [16, 0, -5], shinR: [38, 0, 0], footR: [14, 0, 0],
    }, 'outQuad'), 0.16),
    { t: 0.14, b: 'pelvis', p: [0, -0.08, -0.080], e: 'outQuad' },
    ...lag(pose(0.215, {
      pelvis: [34, -32, -2], spine1: [18, -20, 0], spine2: [15, -17, 0], chest: [30, -42, -9], neck: [-8, 40, 0], head: [16, 58, 0],
      clavL: [0, 26, -24], armL: [-72, 0, -6], foreL: [-64, 0, -8], handL: [-8, 0, 0],
      clavR: [0, -12, 12], armR: [-2, 0, -54], foreR: [-84, 0, 22],
      thighL: [-58, 0, 6], shinL: [32, 0, 0], footL: [-14, 0, 0],
      thighR: [34, 0, -6], shinR: [30, 0, 0], footR: [26, 0, 0],
    }, 'drive'), 0.16),
    { t: 0.215, b: 'pelvis', p: [0, -0.11, 0.150], e: 'drive' },
    ...lag(pose(0.305, {
      pelvis: [34, -32, -2], spine1: [18, -20, 0], spine2: [15, -17, 0], chest: [30, -42, -9], neck: [-8, 40, 0], head: [16, 58, 0],
      clavL: [0, 26, -24], armL: [-72, 0, -6], foreL: [-64, 0, -8], handL: [-8, 0, 0],
      clavR: [0, -12, 12], armR: [-2, 0, -54], foreR: [-84, 0, 22],
      thighL: [-58, 0, 6], shinL: [32, 0, 0], footL: [-14, 0, 0],
      thighR: [34, 0, -6], shinR: [30, 0, 0], footR: [26, 0, 0],
    }, 'linear'), 0.16),
    { t: 0.305, b: 'pelvis', p: [0, -0.11, 0.150], e: 'linear' },
    ...pose(0.39, {
      pelvis: [18, -12, -1], chest: [16, -16, -4], neck: [0, 12, 0], head: [8, 20, 0],
      armL: [-64, 0, 20], foreL: [-52, 0, -8], armR: [-4, 0, -32], foreR: [-58, 0, 14],
      thighL: [-32, 0, 6], shinL: [26, 0, 0], thighR: [16, 0, -6], shinR: [26, 0, 0],
    }, 'outQuad'),
    ...settle(0.452, { pelvis: [34, -32, -2], chest: [30, -42, -9], head: [16, 58, 0], armL: [-72, 0, -6], foreL: [-64, 0, -8], armR: [-2, 0, -54], thighL: [-58, 0, 6] }, 0.15),
    ...stance(0.505, 'outCubic'),
    { t: 0.505, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    { t: 0, b: 'pelvis', p: [0.012, -0.078, 0.010] },
    ...pose(0.65, {
      pelvis: [12, 5, 3], spine1: [8, 3, -1], spine2: [8, 3, -1], chest: [12, 7, -2], neck: [-7, -2, 0], head: [-5, -4, 1],
      clavL: [0, 2, 17], armL: [-77, 0, 25], foreL: [-95, 0, -18], handL: [-12, 0, 0],
      clavR: [0, -2, -8], armR: [-16, 0, -31], foreR: [-79, 0, 16], handR: [-12, 0, 25],
      thighL: [-24, 0, 7], shinL: [34, 0, 0], footL: [-6, 4, 0],
      thighR: [-9, 0, -8], shinR: [28, 0, 0], footR: [-2, -6, 0],
    }),
    { t: 0.65, b: 'pelvis', p: [0.010, -0.088, 0.014] },
    ...pose(1.30, {
      pelvis: [10, 6, 3], spine1: [7, 4, -1], spine2: [7, 3, -1], chest: [10, 8, -2], neck: [-6, -2, 0], head: [-4, -4, 1],
      clavL: [0, 2, 16], armL: [-74, 0, 24], foreL: [-92, 0, -18], handL: [-12, 0, 0],
      clavR: [0, -2, -8], armR: [-14, 0, -30], foreR: [-76, 0, 16], handR: [-12, 0, 24],
      thighL: [-22, 0, 7], shinL: [32, 0, 0], footL: [-6, 4, 0],
      thighR: [-8, 0, -8], shinR: [26, 0, 0], footR: [-2, -6, 0],
    }),
    { t: 1.30, b: 'pelvis', p: [0.012, -0.078, 0.010] },
  ], { loop: true });

  // ── SHIELD: RUSH — the charged bash dash. Two driving strides behind the
  //    shield; the runtime supplies the displacement, this supplies the effort.
  const RUSH_BRACE = {
    pelvis: [18, 0, 0], spine1: [10, 0, 0], chest: [12, 0, 0], neck: [-16, 0, 0], head: [-22, 0, 0],
    armL: [-70, 0, 18], foreL: [-46, 0, -8], armR: [-14, 0, -32], foreR: [-70, 0, 16],
    thighL: [-20, 0, 6], shinL: [40, 0, 0], thighR: [-26, 0, -6], shinR: [36, 0, 0],
  };
  C.rush = new Clip('rush', 0.50, [
    ...pose(0, {
      pelvis: [14, 4, 2], spine1: [9, 3, -1], chest: [14, 6, -2], neck: [-14, 0, 0], head: [-16, -2, 0],
      clavL: [0, 4, 14], armL: [-80, 0, 20], foreL: [-72, 0, -14], handL: [-10, 0, 0],
      clavR: [0, -2, -8], armR: [-16, 0, -30], foreR: [-74, 0, 16],
      thighL: [-26, 0, 6], shinL: [34, 0, 0], thighR: [-10, 0, -7], shinR: [28, 0, 0],
    }),
    { t: 0, b: 'pelvis', p: [0, -0.078, 0] },
    ...lag(pose(0.10, {
      pelvis: [34, 2, 1], spine1: [16, 2, 0], spine2: [14, 1, 0], chest: [20, 4, -1], neck: [-30, 0, 0], head: [-38, -2, 0],
      clavL: [0, 10, -6], armL: [-96, 0, 14], foreL: [-24, 0, -6], handL: [-4, 0, 0],
      clavR: [0, -6, 4], armR: [-8, 0, -42], foreR: [-88, 0, 20],
      thighL: [-60, 0, 6], shinL: [30, 0, 0], footL: [-16, 0, 0],
      thighR: [42, 0, -6], shinR: [44, 0, 0], footR: [26, 0, 0],
    }, 'drive'), 0.10),
    { t: 0.10, b: 'pelvis', p: [0, -0.108, 0.070], e: 'drive' },
    ...lag(pose(0.26, {
      pelvis: [34, -2, -1], spine1: [16, -2, 0], spine2: [14, -1, 0], chest: [20, -4, 1], neck: [-30, 0, 0], head: [-38, 2, 0],
      clavL: [0, 10, -6], armL: [-100, 0, 12], foreL: [-20, 0, -6], handL: [-4, 0, 0],
      clavR: [0, -6, 4], armR: [-4, 0, -44], foreR: [-92, 0, 22],
      thighL: [40, 0, 6], shinL: [42, 0, 0], footL: [26, 0, 0],
      thighR: [-58, 0, -6], shinR: [32, 0, 0], footR: [-16, 0, 0],
    }, 'linear'), 0.10),
    { t: 0.26, b: 'pelvis', p: [0, -0.104, 0.070], e: 'linear' },
    ...pose(0.345, RUSH_BRACE, 'outQuad'),
    // and the same two-step decay: the shield arm is 64deg from stance at the
    // brace and it used to cover all of it in one 75ms segment, which made the
    // recovery (10.2 m/s) half again as fast as the charge itself (6.5).
    ...ret(0.400, RUSH_BRACE, 0.60, 'linear'),
    ...settle(0.450, { pelvis: [34, 0, 0], chest: [20, 0, 0], neck: [-30, 0, 0], head: [-38, 0, 0], armL: [-100, 0, 12], armR: [-8, 0, -42] }, 0.05),
    ...stance(0.50, 'outCubic'),
    { t: 0.50, b: 'pelvis', p: [0.014, -0.018, 0], e: 'outCubic' },
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
    // 1.0, not 0.8: a partial weight leaves a permanent residual, and the
    // residual is a foot that lives underground. Measured on the idle at 0.8
    // the right sole rested at a CONSTANT -0.6 to -0.7cm — 7mm of boot inside
    // the floor on every frame of the loop — and castRitual / bash2 still
    // penetrated on 11% of their frames. The fade that stops a foot being
    // snapped belongs in the BAND (see plantCore), not in a global gain.
    this.ikWeight = 1.0;
    this.ikEnabled = true;
    // how far ABOVE the floor a foot is still considered planted (metres).
    // Wide enough to catch the authored stance, far narrower than the swing.
    this.plantBand = 0.07;
    // ...and how far above it the correction is still applied at FULL weight.
    // Inside the core the foot is planted and the error is closed completely;
    // from the core out to the band the weight smoothsteps to zero.
    this.plantCore = 0.022;
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

  /**
   * FOOT PLANT.
   *
   * This used to be a penetration clamp on the ANKLE and nothing more: it
   * pushed an ankle UP if it had gone below a fixed floor, and left it alone
   * otherwise. Measured on the previewer it essentially never ran. Two
   * separate reasons:
   *
   *  1. It tested the ANKLE against a constant, and the ankle-to-sole distance
   *     is not constant: measured across the run's toe-off roll it drifts by
   *     13cm, because the contact point migrates from the heel to the toe tip
   *     while the ankle itself climbs. A foot could be 3cm INTO the ground
   *     with its ankle 6cm clear, and the clamp saw nothing wrong.
   *  2. Even when it did fire it only pushed UP, so a foot that merely hovered
   *     was left hovering. In idle the ankles sit at 0.122..0.156 against a
   *     floor of 0.106: neither foot was ever touched, the soles floated
   *     0.4-4.3cm, and with nothing pinning them the ankles slid 3.0cm (left)
   *     and 4.4cm (right) sideways through the weight shift.
   *
   * It now measures the actual lowest contact point — the lower of the heel
   * plane (ankle - 0.098) and the toe tip (which rides in the TOE bone's own
   * frame, so it follows the roll), both scaled by rig height — and corrects
   * the ankle by exactly that error, in BOTH directions
   * inside a band. A foot at or under the floor is lifted as before; a foot
   * within `plantBand` above it is pulled DOWN onto it, with the weight faded
   * across the band (smoothstep) so a foot entering or leaving the plant is
   * never snapped on one frame. A swinging foot is far outside the band — the
   * run's swing sole peaks 33cm up against a 7cm band — so the swing is
   * untouched, and no clip needs to know the IK exists.
   */
  groundIK() {
    const rig = this.rig;
    rig.mesh.updateMatrixWorld(true);
    this._inv.copy(rig.mesh.matrixWorld).invert();
    // Nine sole probes per foot — heel plane, ball and toe tip, each at the
    // centre line and both edges — all constant in bone-local space so they
    // follow both the roll and the plantarflexion of the ankle, and collapsed
    // by LegIK.soleY() into two matrix reads plus one transform instead of
    // nine. The BALL matters most: the lowest vertex of this rig's foot sits
    // at foot-local (0, -0.113, +0.120), i.e. under the toe joint, not under
    // the ankle. Calibrated against the skinned mesh across idle, the whole
    // run cycle, guard, dash, attack1 and attack3: predicted sole vs measured
    // lowest foot vertex agrees to 0.31cm rms / 1.18cm worst case, where the
    // old ankle-only test was out by up to 13cm through the toe-off roll.
    for (let s = 0; s < 2; s++) {
      const ik = s ? this.ikR : this.ikL;
      ik.foot.updateMatrixWorld(true);        // force:true carries the toe too
      const over = ik.soleY() - this.groundY;
      if (over >= this.plantBand) continue;
      // PLANT WEIGHT. A foot inside `plantCore` of the floor — or through it —
      // is genuinely standing, and the correction is CLOSED: at 0.8 the error
      // never went away and the idle's right sole rested 7mm underground for
      // the whole loop. Outside the core the weight fades out to zero across
      // the rest of the band, so a foot entering or leaving the plant is
      // eased, never snapped, on one frame.
      const w = over <= this.plantCore ? this.ikWeight
        : this.ikWeight * (1 - smoothstep((over - this.plantCore) / (this.plantBand - this.plantCore)));
      if (w < 0.02) continue;
      // and nothing to do when the sole is already on the floor: below a third
      // of a millimetre the solve is a no-op that still costs two matrix
      // inversions and four slerps.
      if (over > -3e-4 && over < 3e-4) continue;
      _v2.setFromMatrixPosition(ik.foot.matrixWorld);
      _v2.y -= over;                       // move the ankle by the sole error
      _v2.applyMatrix4(this._inv);
      ik.solve(_v2, w);
    }
  }
}

export default { Animator, Clip, ClothSolver, LegIK, buildClipData };
