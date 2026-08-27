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
// ART DIRECTION (§5, §9): a marker is a DRAWN SHAPE, not a lit surface. Its
// energy lives in a bold ~2px outline on the footprint boundary and in the hot
// arris of a sweep that reaches the edge exactly on the frame the hit lands —
// so the tell encodes both "where" and "when" without a number on screen. The
// interior is a translucent tint at a few percent of scene linear. It is
// additive, it sits on the dark stage, it contributes to the frame's highlight
// band through its LINES, and it is never allowed to out-value the character
// standing on it. See the note above FRAG for what this replaced and why.
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
//
// ── REBUILT (AGENT-PLAYABLE, §7 hard ban / §9 THE VALUE LAW) ───────────────
// The previous build painted the whole threatened area as a filled wash at
// ~0.37 linear and let the sweep add another 0.29 on top. Under Tartarus'
// exposure of 2.9 that is a near-white slab: measured groundP90 on 07_combat
// was 0.769 against a 0.42 ceiling, and in the frame the hero's legs
// disappeared into an orange wedge. A tell that eats the character has
// destroyed the very reading it exists to provide.
//
// The rebuild moves ALL of the marker's energy out of its area and into its
// LINES, which is how a drawn tell works and how Hades draws one:
//
//   OUTLINE   a ~2px screen-space stroke on the entire footprint boundary —
//             the outer arc, the two cheeks, the inner cut, the lane sides.
//             This is the bright layer. It is where the highlight band (§9.3)
//             comes from and it costs a fraction of a percent of the frame.
//   INTERIOR  a translucent tint, 0.005-0.018 scene-linear. Over the dark
//             stage that lands around 0.3-0.38 display against a 0.22 floor:
//             clearly hostile ground, never a lit surface, and always
//             out-valued by the character standing on it.
//   SWEEP     the fill grows from the attacker to the edge, reaching it
//             exactly at uK == 1, led by a hot thin arris. The arris is the
//             "when"; the outline is the "where".
//   SNAP      on the last ~16% of the wind-up the OUTLINE flashes, not the
//             fill — the frame goes hot along the edges instead of blooming
//             a slab.
//
// Everything is computed as the colour ADDED to the frame (alpha is left at
// the footprint mask and the blend is additive), so a level in this shader
// means what it says instead of being squared by premultiplication.
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

const float PI  = 3.14159265;
const float TAU = 6.28318531;

void main(){
  float r = length(vP);
  float a = atan(vP.y, vP.x);
  float da = abs(mod(a - uAim + PI, TAU) - PI);

  // one screen-pixel, measured in footprint units, so every stroke below is
  // the same weight on screen whether the marker is 1.2m or 6m across
  float px = max(fwidth(r), 1e-4);

  // ---- signed distance to the footprint boundary (+ = inside) -------------
  float d;        // distance to the nearest edge
  float sweep;    // the coordinate the fill runs along, 0 at the attacker
  float areaK;    // ink budget: a disc covers ~6x an arc, a lane ~2x

  if(uShape < 0.5){                        // ARC wedge
    float ri = 0.15;
    float side = (uHalfArc - da) * max(r, 0.10);   // arc length, not angle
    d = min(min(1.0 - r, r - ri), side);
    sweep = r; areaK = 1.0;
  } else if(uShape < 1.5){                 // DISC
    d = 1.0 - r;
    sweep = r; areaK = 0.58;
  } else if(uShape < 2.5){                 // LINE lane, aimed along uAim
    vec2 dir = vec2(cos(uAim), sin(uAim));
    float along  = dot(vP, dir);
    float across = abs(dot(vP, vec2(-dir.y, dir.x)));
    d = min(min(uInner - across, along), 1.0 - along);
    sweep = along; areaK = 0.80;
  } else {                                 // RING annulus
    d = min(1.0 - r, r - uInner);
    sweep = r; areaK = 0.90;
  }

  float m = smoothstep(0.0, px * 1.6, d);
  if(m <= 0.002) discard;

  // ---- INTERIOR: a tint, never a surface ---------------------------------
  float filled = 1.0 - smoothstep(uK - px * 1.6, uK + px * 1.6, sweep);
  float body = (0.0050 + 0.0050 * uK) + filled * (0.0080 + 0.0100 * uK);
  body *= areaK;

  // ---- OUTLINE: the drawn stroke that carries the read -------------------
  float sw   = px * 1.7;
  float line = exp(-pow(d / sw, 2.0));
  // a wide, very low bleed just inside the stroke so the edge has a glow
  // shoulder instead of an aliased hairline (§5 three-layer construction)
  float halo = exp(-d / (px * 16.0)) * 0.020;

  // ---- SWEEP ARRIS: the hot leading edge of the fill ---------------------
  float arris = exp(-pow((sweep - uK) / (px * 2.6), 2.0)) * step(0.03, uK);

  // ---- SNAP: the last frames flash the EDGES, not the area ---------------
  float snap = smoothstep(0.84, 1.0, uK);
  float edge = line  * (0.26 + 0.30 * uK + 0.34 * snap * uPulse)
             + arris * (0.16 + 0.26 * uK);

  vec3 col = uBody * (body + halo + edge * 0.62) + uCore * edge * 0.40;
  gl_FragColor = vec4(col * (m * uAlpha), m * uAlpha);
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
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendEquation: THREE.AddEquation, side: THREE.DoubleSide,
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
