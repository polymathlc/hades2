// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// Floor-projected decals: scorch, ichor, cracks, AOE telegraph rings, footfall
// scuffs. Two instanced meshes (one additive, one alpha) so the whole decal
// budget costs two draw calls.
//
// They are projected as flat quads on the arena plane rather than as real
// projected geometry: the play floor IS a plane (world/chamber.js builds a
// disc), so a quad is exact, costs nothing, and cannot z-fight against wall
// geometry the way a box projector would.
//
// BLENDING ONTO A PAINTERLY FLOOR (§9.1): the floor is the darkest large
// surface in the frame and must stay that way. Scorch and ichor therefore
// DARKEN (alpha over a dark tint) rather than adding light, and only the
// telegraph/energy decals are additive — and those are thin rings, not discs.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { SHAPE, GRID, shapeAtlas, ATLAS_UV_GLSL } from './shapes.js';

const VERT = /* glsl */`
precision highp float;
attribute vec3 iPos;
attribute vec4 iPar;    // x size, y rotation, z cell, w core boost
attribute vec4 iCol;    // rgb, a opacity
varying vec2 vUv;
varying vec4 vCol;
varying float vCore;
uniform vec2 uGrid;
${ATLAS_UV_GLSL}
void main(){
  float c = cos(iPar.y), s = sin(iPar.y);
  vec2 q = position.xy * iPar.x;
  vec3 wp = iPos + vec3(q.x * c - q.y * s, 0.0, q.x * s + q.y * c);
  vUv = atlasUV(position.xy + 0.5, iPar.z, uGrid);
  vCol = iCol;
  vCore = iPar.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vCol;
varying float vCore;
void main(){
  vec4 t = texture2D(uAtlas, vUv);
#ifdef ADD_BLEND
  vec3 c = vCol.rgb * t.r * 1.15 + vec3(1.0) * t.g * vCore * 1.75 + vCol.rgb * t.b * 0.25;
  float a = vCol.a;
  if(a <= 0.003) discard;
  gl_FragColor = vec4(c, a);
#else
  float m = t.a * vCol.a;
  if(m <= 0.004) discard;
  vec3 c = vCol.rgb * (0.55 + 0.45 * t.r);
  gl_FragColor = vec4(c, m);
#endif
}`;

class DecalBatch {
  constructor(cap, additive, atlas, order) {
    this.cap = cap; this.n = 0;
    this.iPos = new Float32Array(cap * 3);
    this.iPar = new Float32Array(cap * 4);
    this.iCol = new Float32Array(cap * 4);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (a, c) => { const x = new THREE.InstancedBufferAttribute(a, c); x.setUsage(THREE.DynamicDrawUsage); return x; };
    this.aPos = mk(this.iPos, 3); this.aPar = mk(this.iPar, 4); this.aCol = mk(this.iCol, 4);
    g.setAttribute('iPos', this.aPos); g.setAttribute('iPar', this.aPar); g.setAttribute('iCol', this.aCol);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: (additive ? '#define ADD_BLEND\n' : '') + FRAG,
      uniforms: { uAtlas: { value: atlas }, uGrid: { value: new THREE.Vector2(GRID, GRID) } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.name = additive ? 'vfx.decals.add' : 'vfx.decals.alpha';
    this.geo = g;
  }
  reset() { this.n = 0; }
  push(x, y, z, size, rot, cell, core, r, g, b, a) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    let o = i * 3; this.iPos[o] = x; this.iPos[o + 1] = y; this.iPos[o + 2] = z;
    o = i * 4;
    this.iPar[o] = size; this.iPar[o + 1] = rot; this.iPar[o + 2] = cell; this.iPar[o + 3] = core;
    this.iCol[o] = r; this.iCol[o + 1] = g; this.iCol[o + 2] = b; this.iCol[o + 3] = a;
  }
  flush() {
    const n = this.n;
    this.geo.instanceCount = n;
    if (!n) return;
    const up = (a, c) => { if (a.clearUpdateRanges) { a.clearUpdateRanges(); a.addUpdateRange(0, n * c); } a.needsUpdate = true; };
    up(this.aPos, 3); up(this.aPar, 4); up(this.aCol, 4);
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// ── authored decal kinds ───────────────────────────────────────────────────
const KINDS = {
  scorch: { cell: SHAPE.splatter, add: false, color: '#150a12', a0: 0.66, life: 14, fadeIn: 0.05, core: 0 },
  ichor: { cell: SHAPE.splatter, add: false, color: '#3a0713', a0: 0.72, life: 18, fadeIn: 0.05, core: 0 },
  crack: { cell: SHAPE.crack, add: false, color: '#0c0510', a0: 0.72, life: 16, fadeIn: 0.04, core: 0 },
  emberCrack: { cell: SHAPE.crack, add: true, color: '#ff8c1a', a0: 0.85, life: 1.5, fadeIn: 0.03, core: 1.1 },
  telegraph: { cell: SHAPE.ring, add: true, color: '#c81d3c', a0: 0.55, life: 1.0, fadeIn: 0.10, core: 0.5 },
  sigil: { cell: SHAPE.rune, add: true, color: '#8ef0d0', a0: 0.70, life: 1.4, fadeIn: 0.08, core: 0.9 },
  scuff: { cell: SHAPE.speckle, add: false, color: '#100813', a0: 0.40, life: 6, fadeIn: 0.05, core: 0 },
  burn: { cell: SHAPE.burst, add: true, color: '#ffb070', a0: 0.5, life: 0.8, fadeIn: 0.03, core: 0.8 },
};

const _c = new THREE.Color();

export class Decals {
  constructor(cap = 96) {
    this.cap = cap;
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.z = new Float32Array(cap);
    this.size = new Float32Array(cap); this.rot = new Float32Array(cap);
    this.cell = new Float32Array(cap); this.core = new Float32Array(cap);
    this.r = new Float32Array(cap); this.g = new Float32Array(cap); this.b = new Float32Array(cap);
    this.a0 = new Float32Array(cap); this.age = new Float32Array(cap); this.life = new Float32Array(cap);
    this.fadeIn = new Float32Array(cap); this.add = new Uint8Array(cap); this.alive = new Uint8Array(cap);
    this.head = 0; this.count = 0;
  }
  init(ctx, root) {
    this.ctx = ctx;
    const atlas = shapeAtlas();
    this.addB = new DecalBatch(this.cap, true, atlas, 24);
    this.alphaB = new DecalBatch(this.cap, false, atlas, 22);
    root.add(this.alphaB.mesh); root.add(this.addB.mesh);
    return this;
  }

  /** decal(x,y,z,{kind,size,color,rot,life,opacity}) — ring-buffer, oldest evicted. */
  spawn(x, y, z, o = {}) {
    const K = KINDS[o.kind] || KINDS.scorch;
    let i = -1;
    for (let k = 0; k < this.cap; k++) { const j = (this.head + k) % this.cap; if (!this.alive[j]) { i = j; break; } }
    if (i < 0) { i = this.head; }              // evict the oldest slot
    this.head = (i + 1) % this.cap;
    this.alive[i] = 1;
    this.x[i] = x; this.y[i] = (y ?? 0) + 0.018 + (i % 8) * 0.0016;
    this.z[i] = z;
    this.size[i] = o.size ?? 1.2;
    this.rot[i] = o.rot ?? 0;
    this.cell[i] = o.cell ?? K.cell;
    this.core[i] = o.core ?? K.core;
    _c.set(o.color || K.color);
    this.r[i] = _c.r; this.g[i] = _c.g; this.b[i] = _c.b;
    this.a0[i] = o.opacity ?? K.a0;
    this.age[i] = 0;
    this.life[i] = o.life ?? K.life;
    this.fadeIn[i] = K.fadeIn;
    this.add[i] = K.add ? 1 : 0;
    this.count++;
    return i;
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.alive[i] = 0; this.count--; }
    }
  }

  flush() {
    const A = this.addB, B = this.alphaB;
    A.reset(); B.reset();
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const u = this.age[i] / this.life[i];
      const fi = this.fadeIn[i] > 0 ? Math.min(1, this.age[i] / (this.life[i] * this.fadeIn[i])) : 1;
      // long-lived stains hold, then wash out over the last third
      const fo = u < 0.6 ? 1 : Math.pow(1 - (u - 0.6) / 0.4, 1.4);
      const a = this.a0[i] * fi * fo;
      if (a <= 0.005) continue;
      const t = this.add[i] ? A : B;
      const pop = 1 + 0.10 * (1 - fi);      // a touch of scale-in punch
      t.push(this.x[i], this.y[i], this.z[i], this.size[i] * pop, this.rot[i], this.cell[i],
        this.core[i], this.r[i], this.g[i], this.b[i], a);
    }
    A.flush(); B.flush();
  }

  clear() { for (let i = 0; i < this.cap; i++) this.alive[i] = 0; this.count = 0; this.addB.reset(); this.alphaB.reset(); this.addB.flush(); this.alphaB.flush(); }
  dispose() { this.addB.dispose(); this.alphaB.dispose(); }
}

export { KINDS as DECAL_KINDS };
export default Decals;
