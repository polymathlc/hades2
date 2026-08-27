// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// telegraph.js — THE TELL, drawn on the stage.
//
// The attack-token system decides WHO commits. This file is how the player
// finds out. It draws the ground marker for every wind-up in the roster:
//
//   'arc'   a wedge in front of a melee attacker         (shade, brute, boss)
//   'disc'  a ground circle that fills as the cast lands (caster, bomber)
//   'line'  a lane along a charge                        (brute charge, boss)
//   'ring'  an expanding annulus for a radial slam       (boss phase 2)
//
// ART DIRECTION (§5, §9): a marker is a SHAPE with three layers — a hot
// near-white leading arris, a saturated body in the attacker's identity colour,
// and a wide low-alpha glow. It is additive, it sits on the dark stage, and it
// supplies part of the frame's highlight band. Crucially the FILL SWEEPS: the
// bright region grows from the attacker outward and reaches the edge exactly on
// the frame the hit lands, so the tell encodes both "where" and "when" without
// a number on screen.
//
// PERF: one geometry, one program, a fixed pool of N meshes (default 14). A
// pooled marker is hidden, never destroyed; nothing allocates after init.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { hexToRgb } from '../../materials/palette.js';

const VERT = /* glsl */`
varying vec2 vP;
void main(){
  vP = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// p is in unit-disc space: |p| <= 1 is the marker footprint.
const FRAG = /* glsl */`
precision highp float;
varying vec2 vP;
uniform vec3  uBody;
uniform vec3  uCore;
uniform float uK;        // 0..1 wind-up progress
uniform float uShape;    // 0 arc, 1 disc, 2 line, 3 ring
uniform float uHalfArc;  // radians
uniform float uAim;      // facing angle in local space
uniform float uAlpha;
uniform float uInner;    // inner radius for ring / lane half-width for line
uniform float uPulse;

float aa(float e, float x){ float w = fwidth(x) * 1.4 + 1e-4; return smoothstep(e - w, e + w, x); }

void main(){
  float r = length(vP);
  float a = atan(vP.y, vP.x);
  float da = abs(mod(a - uAim + 3.14159265, 6.2831853) - 3.14159265);

  // ---- footprint mask -----------------------------------------------------
  float m = 1.0;
  float edgeR = 1.0;                       // where the outer arris sits
  if(uShape < 0.5){                        // ARC wedge
    m *= 1.0 - aa(uHalfArc, da);
    m *= 1.0 - aa(1.0, r);
    m *= aa(0.16, r);
  } else if(uShape < 1.5){                 // DISC
    m *= 1.0 - aa(1.0, r);
  } else if(uShape < 2.5){                 // LINE lane, aimed along uAim
    vec2 d = vec2(cos(uAim), sin(uAim));
    float along = dot(vP, d);
    float across = abs(dot(vP, vec2(-d.y, d.x)));
    m *= 1.0 - aa(uInner, across);
    m *= aa(0.0, along) * (1.0 - aa(1.0, along));
    r = along;                             // sweep runs down the lane
  } else {                                 // RING annulus
    m *= 1.0 - aa(1.0, r);
    m *= aa(uInner, r);
  }
  if(m <= 0.001) discard;

  // ---- three-layer build (§5) --------------------------------------------
  // LEVELS ARE LOW ON PURPOSE. This draws into a linear HDR buffer that is
  // then bloomed and tone-mapped: at the values a naive "additive marker"
  // wants (~1.0 core) every tell became a blown white slab and the frame
  // failed §7's "bloom fog" ban outright. The marker's job is to be the
  // brightest thing ON THE FLOOR, not the brightest thing in the frame — the
  // hero and the practicals outrank it.
  //
  // BODY: a low, saturated wash over the whole threatened area so the shape
  // reads even at 1/8 resolution.
  float areaK = (uShape > 0.5 && uShape < 1.5) ? 0.55 : 1.0;  // a disc covers 6x an arc's area
  float body = (0.090 + 0.050 * uK) * areaK;

  // SWEEP: the filled region, growing to the edge exactly at uK == 1.
  float fill = 1.0 - aa(uK * edgeR, r);
  body += fill * (0.130 + 0.160 * uK) * areaK;

  // CORE: the hot leading arris of the sweep, plus the static outer rule that
  // tells you where the danger stops. Thin, so it reads as a drawn line.
  float lead  = exp(-pow((r - uK * edgeR) * 14.0, 2.0)) * (0.16 + 0.28 * uK);
  float rule  = exp(-pow((r - edgeR) * 18.0, 2.0)) * 0.30;
  float cheek = (uShape < 0.5) ? exp(-pow((da - uHalfArc) * 30.0, 2.0)) * 0.16 : 0.0;

  float core = lead + rule + cheek;
  // the strike flash: the sweep goes hot for the last few frames
  float snap = smoothstep(0.86, 1.0, uK);
  core += snap * (0.18 + 0.14 * uPulse) * fill;

  vec3 col = uBody * body + uCore * core;
  float al = (body * 0.85 + core) * uAlpha * m;
  gl_FragColor = vec4(col * al, al);
}`;

const _c = new THREE.Color();
function lin(hex, out) {
  _c.setRGB(...hexToRgb(hex), THREE.SRGBColorSpace);
  out.set(_c.r, _c.g, _c.b);
  return out;
}

export class Telegraphs {
  constructor(max = 14) { this.max = max; this.pool = []; this.live = []; }

  init(ctx) {
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'enemy.telegraphs';
    this.group.renderOrder = 6;
    ctx.scene.add(this.group);

    // a unit quad laid flat: XZ in [-1,1]
    const g = new THREE.PlaneGeometry(2, 2, 1, 1);
    g.rotateX(-Math.PI / 2);
    this.geo = g;

    for (let i = 0; i < this.max; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          uBody: { value: new THREE.Vector3(1, 0.4, 0.2) },
          uCore: { value: new THREE.Vector3(1, 1, 1) },
          uK: { value: 0 }, uShape: { value: 0 }, uHalfArc: { value: 0.9 },
          uAim: { value: 0 }, uAlpha: { value: 1 }, uInner: { value: 0.3 }, uPulse: { value: 0 },
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        toneMapped: false,
      });
      const m = new THREE.Mesh(this.geo, mat);
      m.frustumCulled = false;
      m.visible = false;
      m.renderOrder = 6;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.pool.push({ mesh: m, u: mat.uniforms, busy: false, t: 0, dur: 1, hold: 0, owner: null, follow: false, r: 1 });
    }
    return this;
  }

  /**
   * spawn(o) — o: { x, z, radius, shape, arc, dirX, dirZ, color, core, dur,
   *                 hold, owner, follow }
   * Returns a handle you can cancel(); the marker also self-expires so a dead
   * caster never leaves a tell burning on the floor.
   */
  spawn(o = {}) {
    let s = null;
    for (let i = 0; i < this.pool.length; i++) if (!this.pool[i].busy) { s = this.pool[i]; break; }
    if (!s) {                       // steal the oldest
      let best = 0, bt = -1;
      for (let i = 0; i < this.pool.length; i++) { const p = this.pool[i]; const k = p.t / p.dur; if (k > bt) { bt = k; best = i; } }
      s = this.pool[best]; this._retire(s);
    }
    s.busy = true; s.t = 0;
    s.dur = Math.max(0.05, o.dur ?? 0.6);
    s.hold = o.hold ?? 0.11;                 // linger after the strike
    s.owner = o.owner || null;
    s.follow = !!o.follow;
    s.r = Math.max(0.4, o.radius ?? 2.4);
    const shape = o.shape === 'disc' ? 1 : o.shape === 'line' ? 2 : o.shape === 'ring' ? 3 : 0;
    s.u.uShape.value = shape;
    s.u.uHalfArc.value = (o.arc ?? 92) * 0.5 * Math.PI / 180;
    s.u.uInner.value = o.inner ?? (shape === 2 ? 0.16 : 0.55);
    s.u.uAlpha.value = o.alpha ?? 1;
    s.u.uK.value = 0;
    s.u.uPulse.value = 0;
    lin(o.color || '#ff5a3c', s.u.uBody.value);
    lin(o.core || '#fff3d6', s.u.uCore.value);
    const dx = o.dirX ?? 0, dz = o.dirZ ?? 1;
    // local aim: the quad is unrotated in world XZ, so vP.x = world X and
    // vP.y = world Z. atan2(z, x) is therefore the correct local angle.
    s.u.uAim.value = Math.atan2(dz, dx);
    s.mesh.position.set(o.x ?? 0, (o.y ?? 0) + 0.045, o.z ?? 0);
    s.mesh.scale.set(s.r, 1, s.r);
    s.mesh.updateMatrix();
    s.mesh.visible = true;
    this.live.push(s);
    return s;
  }

  cancel(handle) { if (handle && handle.busy) this._retire(handle); }
  cancelOwner(owner) {
    for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i].owner === owner) this._retire(this.live[i]);
  }

  _retire(s) {
    s.busy = false; s.owner = null; s.mesh.visible = false;
    const i = this.live.indexOf(s); if (i >= 0) this.live.splice(i, 1);
  }

  update(dt, ctx) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      s.t += dt;
      const k = s.t / s.dur;
      s.u.uK.value = k < 1 ? k : 1;
      // after the strike the marker snaps hot then dies fast
      if (k >= 1) {
        const over = (s.t - s.dur) / Math.max(1e-3, s.hold);
        s.u.uPulse.value = 1;
        s.u.uAlpha.value = Math.max(0, 1 - over);
        if (over >= 1) { this._retire(s); continue; }
      } else {
        s.u.uPulse.value = 0.5 + 0.5 * Math.sin(k * 42);
      }
      const own = s.owner;
      if (own && (own.dead || own.alive === false)) { this._retire(s); continue; }
      if (s.follow && own) {
        s.mesh.position.set(own.position.x, 0.045, own.position.z);
        s.u.uAim.value = Math.atan2(own.facing.z, own.facing.x);
        s.mesh.updateMatrix();
      }
    }
  }

  clear() { for (let i = this.live.length - 1; i >= 0; i--) this._retire(this.live[i]); }
  dispose() {
    this.clear();
    for (const p of this.pool) p.mesh.material.dispose();
    this.geo.dispose();
    if (this.group && this.group.parent) this.group.parent.remove(this.group);
  }
}

export default Telegraphs;
