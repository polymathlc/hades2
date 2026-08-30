// OWNER: AGENT-WORLD
// ---------------------------------------------------------------------------
// CHAMBER EXITS — the spine of the Hades loop.
//
// Two or three ornate doorways stand at the arena rim. Each advertises what
// lies beyond with a REWARD SIGIL burning over its keystone (boon / health /
// gold). While enemies live the doors are SEALED: bronze leaves shut,
// the sigil banked down to a dull ember, the threshold dark. On `room.cleared`
// each door unseals — the sigil blooms to full chroma, the leaves swing, and a
// column of the biome's complement hue opens in the doorway.
//
// COMPOSITION NOTE (§9.5/§9.6): the sigils are the frame's single most reliable
// source of the mandated *secondary* hue. They are placed at eye-line height on
// the far rim, which is exactly where the value law wants the highlight band —
// on ornament, above the dark stage, never on the floor.
//
// API consumed by AGENT-RUN / AGENT-UI:
//   doors.getChoices()            -> [{ index, kind, label, color, position, anchor, sealed }]
//   doors.onEnter(cb) -> off      -> cb({ index, kind, door })
//   doors.promptAnchor(i)         -> THREE.Vector3 (world-space UI attach point)
//   doors.setSealed(bool)         -> force state (capture harness / debug)
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { Parts, Batcher, lathe, faceted, mergeGeos, ensureColor, TAU, DEG } from './kit.js';
import { GOD_INFO, GOD_KEYS } from '../game/boons.js';

const GOD_GLYPH = Object.freeze(Object.fromEntries(GOD_KEYS.map((god, i) => [god, i])));

export const REWARDS = {
  boon:   { label: 'Boon of the Gods', color: '#c9b8ff', core: '#ffffff', glyph: 0 },
  health: { label: 'Restoration',      color: '#ff5a7a', core: '#ffd8dd', glyph: 1 },
  gold:   { label: 'Obols',            color: '#ffd24d', core: '#fff3c0', glyph: 2 },
};
export const REWARD_KINDS = Object.keys(REWARDS);

function weightedGodOrder(random, weights, allowedGodKeys = GOD_KEYS) {
  const pool = (allowedGodKeys?.length ? allowedGodKeys : GOD_KEYS).filter(god => GOD_INFO[god]), order = [];
  while (pool.length) {
    let total = 0;
    for (const god of pool) total += Math.max(0.001, Number(weights?.[god]) || 1);
    let roll = Math.max(0, Math.min(0.999999999, Number(random()) || 0)) * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= Math.max(0.001, Number(weights?.[pool[i]]) || 1);
      if (roll < 0) { index = i; break; }
    }
    order.push(pool.splice(index, 1)[0]);
  }
  return order;
}

/** Pure, deterministic gate contract used by world construction and tests. */
export function planDoorChoices(count, random = () => 0.5, godWeights = null, allowedGodKeys = GOD_KEYS) {
  const n = Math.max(0, count | 0);
  const rest = ['gold', 'health'];
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
  // Infernal Arms are chosen once, physically, at the Crossroads. A chamber
  // gate can never replace the weapon bound to the current descent.
  const rewards = ['boon', ...rest];
  const bi = Math.floor(random() * Math.max(1, Math.min(n, rewards.length)));
  if (bi > 0) { const t = rewards[0]; rewards[0] = rewards[bi]; rewards[bi] = t; }
  // Nectar investment raises a god's selection weight. Sampling is without
  // replacement so a chamber still presents three different divine choices.
  const allowed = (allowedGodKeys?.length ? allowedGodKeys : GOD_KEYS).filter(god => GOD_INFO[god]);
  const gods = godWeights ? weightedGodOrder(random, godWeights, allowed) : allowed.slice();
  if (!godWeights) for (let i = gods.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); const t = gods[i]; gods[i] = gods[j]; gods[j] = t; }
  return Array.from({ length: n }, (_, i) => ({ kind: rewards[i % rewards.length], god: gods[i % gods.length] }));
}

// ---------------------------------------------------------------------------
// The sigil: a burning emblem inside a gold ring. Authored as SDF shapes so it
// stays razor sharp at every distance and costs one quad.
// ---------------------------------------------------------------------------
const SIGIL_VERT = /* glsl */`
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const SIGIL_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform vec3 uColor, uCore;
  uniform float uTime, uOpen, uGlyph, uSeed;

  float sdCircle(vec2 p, float r){ return length(p) - r; }
  float sdBox(vec2 p, vec2 b){ vec2 d = abs(p) - b; return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)); }
  float sdRing(vec2 p, float r, float w){ return abs(length(p) - r) - w; }
  mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  // petal / laurel star used by the boon glyph
  float sdStar(vec2 p, float r, float n, float sharp){
    float a = atan(p.y, p.x);
    float rr = r * (1.0 - sharp + sharp * abs(cos(a * n * 0.5)));
    return length(p) - rr;
  }

  float glyph(vec2 p, float which){
    if(which < 0.5){
      // BOON — an eight-point radiant with a laurel ring
      float d = sdStar(p, 0.30, 8.0, 0.55);
      d = min(d, sdRing(p, 0.36, 0.017));
      d = min(d, sdCircle(p, 0.085));
      return d;
    } else if(which < 1.5){
      // HEALTH — a pomegranate: a round body, a crown, a stem
      vec2 q = p - vec2(0.0, -0.03);
      float d = sdCircle(q, 0.24);
      d = min(d, sdBox(p - vec2(0.0, 0.255), vec2(0.035, 0.075)));
      for(int i = 0; i < 5; i++){
        float a = (float(i) - 2.0) * 0.42;
        vec2 c = rot(a) * (p - vec2(0.0, 0.20));
        d = min(d, sdBox(c - vec2(0.0, 0.07), vec2(0.022, 0.075)));
      }
      return d;
    } else if(which < 2.5){
      // GOLD — an obol: a coin with a square die-punch and a milled edge
      float d = sdRing(p, 0.28, 0.055);
      d = min(d, sdBox(rot(0.785) * p, vec2(0.085, 0.085)));
      for(int i = 0; i < 12; i++){
        float a = float(i) / 12.0 * 6.28318;
        d = min(d, sdCircle(p - vec2(cos(a), sin(a)) * 0.355, 0.020));
      }
      return d;
    }
    // WEAPON — crossed blades over a shield boss
    float d = 1e3;
    for(int i = 0; i < 2; i++){
      float a = (i == 0 ? 0.72 : -0.72);
      vec2 c = rot(a) * p;
      d = min(d, sdBox(c - vec2(0.0, 0.06), vec2(0.030, 0.28)));       // blade
      d = min(d, sdBox(c - vec2(0.0, -0.19), vec2(0.115, 0.024)));     // guard
      d = min(d, sdBox(c - vec2(0.0, -0.28), vec2(0.030, 0.075)));     // grip
    }
    d = min(d, sdRing(p, 0.135, 0.024));
    return d;
  }

  // Compact SDF versions of the same identities drawn by the boon UI.
  // They are deliberately bold: a gate logo must survive the isometric camera.
  float godGlyph(vec2 p, float which){
    float d = 1e3;
    if(which < 0.5){ // Zeus — lightning bolt
      vec2 q = rot(-0.38) * p;
      d = min(sdBox(q - vec2(-0.08,-0.12), vec2(0.10,0.30)), sdBox(q - vec2(0.08,0.18), vec2(0.10,0.30)));
    } else if(which < 1.5){ // Poseidon — trident
      d = sdBox(p - vec2(0.0,0.08), vec2(0.035,0.34));
      d = min(d, sdBox(p - vec2(0.0,-0.20), vec2(0.28,0.035)));
      d = min(d, sdBox(p - vec2(-0.25,-0.31), vec2(0.035,0.15)));
      d = min(d, sdBox(p - vec2(0.25,-0.31), vec2(0.035,0.15)));
      d = min(d, sdBox(p - vec2(0.0,-0.34), vec2(0.035,0.18)));
    } else if(which < 2.5){ // Athena — aegis
      d = max(sdCircle(p - vec2(0.0,-0.03),0.34), p.y - 0.25);
      d = min(d, sdCircle(p - vec2(0.0,-0.04),0.08));
    } else if(which < 3.5){ // Aphrodite — heart
      vec2 q = vec2(p.x, p.y + 0.06);
      float a = q.x*q.x + q.y*q.y - 0.105;
      d = (a*a*a - q.x*q.x*q.y*q.y*q.y) * 5.0;
    } else if(which < 4.5){ // Ares — crossed blades
      d = min(sdBox(rot(0.68)*p,vec2(0.035,0.37)), sdBox(rot(-0.68)*p,vec2(0.035,0.37)));
      d = min(d, sdCircle(p,0.08));
    } else if(which < 5.5){ // Artemis — bow and arrow
      float ring = abs(length(p - vec2(-0.16,0.0)) - 0.34) - 0.025;
      d = max(ring, p.x - 0.18);
      d = min(d, sdBox(p - vec2(0.02,0.0),vec2(0.34,0.025)));
    } else if(which < 6.5){ // Dionysus — grapes
      for(int i=0;i<3;i++) for(int j=0;j<3;j++){
        vec2 q=vec2((float(i)-1.0)*0.13 + (float(j)-1.0)*0.035,(float(j)-1.0)*0.13);
        d=min(d,sdCircle(p-q,0.075));
      }
      d=min(d,sdBox(rot(-0.45)*(p-vec2(0.12,-0.28)),vec2(0.12,0.045)));
    } else if(which < 7.5){ // Hermes — winged staff
      d=sdBox(p-vec2(0.0,0.08),vec2(0.035,0.33));
      d=min(d,sdBox(rot(0.55)*(p-vec2(-0.16,-0.12)),vec2(0.20,0.045)));
      d=min(d,sdBox(rot(-0.55)*(p-vec2(0.16,-0.12)),vec2(0.20,0.045)));
    } else if(which < 8.5){ // Hecate — triple moon
      d=sdCircle(p,0.16);
      d=min(d,abs(sdCircle(p-vec2(-0.27,0.0),0.16))-0.025);
      d=min(d,abs(sdCircle(p-vec2(0.27,0.0),0.16))-0.025);
    } else if(which < 9.5){ // Selene — crescent
      d=max(sdCircle(p,0.34),-sdCircle(p-vec2(0.14,-0.02),0.29));
    } else if(which < 10.5){ // Hephaestus — hammer and anvil
      vec2 q=rot(-0.55)*p;
      d=min(sdBox(q-vec2(0.0,0.05),vec2(0.045,0.31)),sdBox(q-vec2(0.0,-0.25),vec2(0.22,0.075)));
      d=min(d,sdBox(p-vec2(0.0,0.27),vec2(0.30,0.055)));
      d=min(d,sdBox(p-vec2(-0.10,0.34),vec2(0.16,0.055)));
    } else if(which < 11.5){ // Demeter — wheat
      d=sdBox(p-vec2(0.0,0.05),vec2(0.025,0.36));
      for(int i=0;i<4;i++){
        float y=-0.25+float(i)*0.16;
        d=min(d,sdBox(rot(0.62)*(p-vec2(-0.12,y)),vec2(0.12,0.035)));
        d=min(d,sdBox(rot(-0.62)*(p-vec2(0.12,y)),vec2(0.12,0.035)));
      }
    } else if(which < 12.5){ // Apollo — sun
      d=sdCircle(p,0.16);
      for(int i=0;i<12;i++){ float a=float(i)/12.0*6.28318; d=min(d,sdBox(rot(a)*(p-vec2(0.0,0.30)),vec2(0.025,0.11))); }
    } else if(which < 13.5){ // Hera — crown
      d=sdBox(p-vec2(0.0,0.20),vec2(0.30,0.08));
      d=min(d,sdBox(rot(0.42)*(p-vec2(-0.20,-0.06)),vec2(0.055,0.25)));
      d=min(d,sdBox(p-vec2(0.0,-0.10),vec2(0.055,0.28)));
      d=min(d,sdBox(rot(-0.42)*(p-vec2(0.20,-0.06)),vec2(0.055,0.25)));
    } else if(which < 14.5){ // Hestia — flame
      vec2 q=p; q.y+=0.04;
      d=min(sdCircle(q-vec2(0.0,0.08),0.25),sdCircle(q-vec2(-0.09,-0.17),0.15));
      d=max(d,-sdCircle(q-vec2(0.08,0.11),0.11));
    } else if(which < 15.5){ // Chaos — nested spiral
      d=abs(length(p)-0.32)-0.035;
      d=min(d,abs(length(p-vec2(0.08,0.0))-0.18)-0.030);
      d=min(d,sdCircle(p-vec2(0.05,0.0),0.055));
    } else { // Hades — helm
      d=max(sdCircle(p-vec2(0.0,-0.03),0.34),p.y-0.24);
      d=min(d,sdBox(p-vec2(-0.24,0.19),vec2(0.055,0.20)));
      d=min(d,sdBox(p-vec2(0.24,0.19),vec2(0.055,0.20)));
      d=max(d,-sdBox(p-vec2(0.0,0.16),vec2(0.09,0.20)));
    }
    return d;
  }

  float hash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y); }

  void main(){
    vec2 p = vUv - 0.5;
    float d = godGlyph(p, uGlyph);

    // a slow, non-periodic breath so a sealed sigil still feels alive
    float br = 0.55 + 0.45 * vn(vec2(uTime * 0.35 + uSeed * 7.0, uSeed));

    // 3-LAYER CONSTRUCTION (§5): core / body / glow
    float core = smoothstep(0.012, -0.012, d);
    float body = smoothstep(0.055, 0.0, d);
    float glow = exp(-max(0.0, d) * 11.0);
    float halo = exp(-max(0.0, length(p) - 0.16) * 5.2) * 0.35;

    // the surrounding ring of the mount, always lit a little
    float ring = smoothstep(0.016, 0.0, abs(length(p) - 0.455) - 0.010);

    float open = mix(0.14, 1.0, uOpen);
    // ROUND-2: halo 0.8 + a near-white core turned every sigil into a blown
    // DISC with no glyph left in it — §5 asks an effect to read as a SHAPE at
    // 1/8 resolution, and a white circle is not a shape. The drawn emblem
    // keeps its energy; the featureless fill loses two thirds of it.
    vec3 c = uColor * (body * 1.45 + glow * 0.60 + halo * 0.30) * open * (0.75 + 0.45 * br);
    c += uCore * core * (0.42 + 0.24 * br) * open;
    c += uColor * ring * 0.45 * open;

    // when the door unseals the sigil throws a burst of radial spokes
    float spokes = 0.0;
    if(uOpen > 0.01){
      float a = atan(p.y, p.x);
      spokes = pow(max(0.0, sin(a * 12.0 + uTime * 0.5)), 8.0)
             * exp(-max(0.0, length(p) - 0.20) * 4.0) * uOpen * 0.55;
    }
    c += uCore * spokes * 0.5;

    // roll off on the MAX channel so the hue survives (a per-channel Reinhard
    // pulls every ratio toward 1, i.e. it desaturates the accent)
    float pk = max(c.r, max(c.g, c.b));
    c *= (pk / (1.0 + pk * 0.38)) / max(pk, 1e-4);
    // QUAD-EDGE MASK. This is an ADDITIVE 2.5m plane: the halo term is small
    // but non-zero right out to the corners, so over a dark tympanum the whole
    // QUAD read as a pale rectangle sitting behind the emblem — a hard-edged
    // card, which is the §7 'programmer art left visible' failure at the one
    // place in the room the eye is meant to travel to. Fade to nothing well
    // inside the geometry so only the drawn emblem ever exists.
    float quadFade = 1.0 - smoothstep(0.30, 0.495, length(p));
    gl_FragColor = vec4(c * quadFade, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// The threshold: what you see THROUGH the doorway. Sealed, it is near-black
// stone; open, it is a corridor of the biome complement receding into depth.
// ---------------------------------------------------------------------------
const THRESH_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform vec3 uBody, uCore, uInk;
  uniform float uTime, uOpen, uSeed;
  float hash(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x), mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for(int i = 0; i < 4; i++){ s += a * vn(p); p *= 2.03; a *= 0.5; } return s / 0.9375; }
  void main(){
    vec2 p = vec2((vUv.x - 0.5) * 1.6, vUv.y);
    // a receding corridor: brightness climbs toward a vanishing slot
    float corridor = exp(-abs(p.x) * 5.2) * smoothstep(0.0, 0.34, vUv.y) * smoothstep(0.98, 0.58, vUv.y);
    // drifting motes of light rising through it
    float n = fbm(vec2(p.x * 3.0 + uSeed * 11.0, vUv.y * 2.2 - uTime * 0.22));
    float veil = corridor * (0.35 + 0.95 * n);
    // A THRESHOLD IS A SLOT OF LIGHT IN THE DARK, not a lit panel. The first
    // pass wrote ~1.0 straight into the HDR buffer across the whole opening and
    // the doorway read as a glowing white slab bolted to the wall — the exact
    // "bloom fog" §7 bans, at the one place in the room the eye is supposed to
    // travel TO rather than bounce off.
    vec3 c = uInk;
    c += uBody * veil * 0.52;
    c += uCore * pow(corridor, 4.5) * 0.42;
    c *= mix(0.05, 1.0, uOpen);
    // the lintel occludes the top, the sill bites the bottom
    c *= mix(0.10, 1.0, smoothstep(0.02, 0.34, 1.0 - vUv.y));
    c *= mix(0.30, 1.0, smoothstep(0.0, 0.10, vUv.y));
    float pk = max(c.r, max(c.g, c.b));
    c *= (pk / (1.0 + pk * 0.42)) / max(pk, 1e-4);
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * An arch-headed quad with UVs normalised 0..1 over its bounding box, so the
 * threshold shader's `vUv` contract is unchanged. Built as a triangle fan of
 * columns rather than a THREE.Shape so the UV mapping is exact and the mesh
 * carries no triangulation artefacts along the springing line.
 */
function archedQuad(w, springY, seg = 28) {
  const hw = w * 0.5, top = springY + hw;
  const pos = [], uv = [], idx = [];
  const N = seg + 1;
  for (let i = 0; i < N; i++) {
    const u = i / seg;
    const x = -hw + u * w;
    // head profile: semicircle of radius hw sitting on the springing
    const k = Math.max(0, 1 - (x / hw) * (x / hw));
    const yTop = springY + hw * Math.sqrt(k);
    for (let j = 0; j < 2; j++) {
      const y = j === 0 ? 0 : yTop;
      pos.push(x, y, 0);
      uv.push(u, j === 0 ? 0 : yTop / top);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Doors {
  constructor() {
    this.root = new THREE.Group();
    this.root.name = 'doors';
    this.list = [];
    this._cbs = [];
    this.sealed = true;
    this._t = 0;
    this._mats = [];
    this._geo = [];
    this._entered = -1;
  }

  // -------------------------------------------------------------------------
  /**
   * build(ctx, kit, { anchors, biome, rng })
   * `anchors` come from the chamber: [{x, z, angle, y}] at the arena rim, in
   * world space, `angle` pointing OUTWARD from the arena centre.
   */
  build(ctx, kit, opts = {}) {
    this.ctx = ctx;
    this.kit = kit;
    this.biome = opts.biome;
    const rng = opts.rng;
    const f = rng && rng.f ? () => rng.f() : () => 0.5;
    const anchors = opts.anchors || [];

    // Reward mix. A run must always be offered at least one BOON — that is the
    // build-defining choice — and no two doorways in the same chamber may
    // advertise the same reward, or the choice the room exists to pose stops
    // being a choice. Deterministic from the world stream.
    // §9.6 TWO HUES. The gate sigils are the biggest, brightest ornament in the
    // top band of every composition frame, and they are the cheapest place in
    // the room to put the biome's COMPLEMENT at real scale. `weapon` is the
    // cool one (#7ee0ff), so a chamber is guaranteed to advertise it alongside
    // the boon rather than leaving the whole gate arc salmon-on-plum.
    const plan = planDoorChoices(anchors.length, f, ctx.meta?.appearanceWeights?.(), ctx.run?.godPool?.());

    const stone = kit.mat('shrine');
    // §9.5 relief pass: the jamb fret is the ornament closest to camera in the
    // whole room, so it is the one that most has to read as CUT stone. Mid
    // albedo + a hot specular arris + the moulding units' baked contact
    // occlusion (kit.js reliefShade) instead of white-on-black line-art.
    const trim = kit.mat('divine', {
      vertexColors: true, tint: '#f4ece0', litGain: 1.02, ambGain: 0.60, specGain: 1.95,
    });
    const metal = kit.mat('metal');

    // The static half of every doorway (piers, voussoirs, mouldings, sigil
    // mount, step) is identical geometry at three different transforms, so it
    // collapses into one instanced draw per part instead of ~40 per door.
    const batch = new Batcher(this.root);
    anchors.forEach((a, i) => {
      const { kind, god } = plan[i];
      const door = this._buildOne(ctx, kit, a, kind, i, { stone, trim, metal, seed: f(), batch, god });
      this.list.push(door);
      this.root.add(door.group);
    });
    batch.build();
    return this;
  }

  _buildOne(ctx, kit, anchor, kind, index, o) {
    const R = REWARDS[kind] || REWARDS.boon;
    const god = o.god || GOD_KEYS[index % GOD_KEYS.length];
    const G = GOD_INFO[god] || GOD_INFO.zeus;
    const g = new THREE.Group();                      // the ANIMATED half
    g.name = 'door.' + kind;
    g.position.set(anchor.x, anchor.y || 0, anchor.z);
    // local +Z looks INTO the arena: the sigil, the step and the fluted jamb
    // faces all live on +Z, and a doorway that advertises its reward to the
    // void behind it is worse than no doorway at all.
    g.rotation.y = -anchor.angle - Math.PI / 2;
    const stat = new THREE.Group();                   // the STATIC half (batched)

    const W = anchor.width ?? 4.0;                    // clear opening
    const H = anchor.height ?? 4.4;                   // springing height
    const JW = 1.20, JD = 1.60;                       // jamb width / depth

    // ---- the mass: two moulded piers + a plinth course --------------------
    const pierGeo = kit.geo(`door.pier:${W.toFixed(2)}:${H.toFixed(2)}`, () => {
      const p = new Parts();
      p.box(JW, H, JD, [0, H * 0.5, 0]);
      // base mouldings
      p.box(JW * 1.28, 0.30, JD * 1.20, [0, 0.15, 0]);
      p.box(JW * 1.16, 0.16, JD * 1.10, [0, 0.38, 0]);
      // a recessed fluted panel on the face
      for (let k = -1; k <= 1; k++) {
        p.add(new THREE.CylinderGeometry(0.085, 0.085, H * 0.66, 8, 1, false, 0, Math.PI),
          { p: [k * JW * 0.26, H * 0.52, JD * 0.5], r: [0, Math.PI, 0] });
      }
      // impost / capital block
      p.box(JW * 1.30, 0.34, JD * 1.22, [0, H - 0.17, 0]);
      p.box(JW * 1.44, 0.14, JD * 1.34, [0, H + 0.05, 0]);
      return faceted(p.merge());
    });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(pierGeo, o.stone);
      m.name = 'door.pier';
      m.position.x = s * (W * 0.5 + JW * 0.5);
      m.castShadow = true; m.receiveShadow = true;
      stat.add(m);
    }

    // ---- the arch ---------------------------------------------------------
    const arch = kit.arch({ span: W + JW, rise: (W + JW) * 0.5, thickness: 0.80, depth: JD, voussoirs: 15, springY: H + 0.12, ornate: true });
    stat.add(arch);

    // ---- tympanum: the panel the sigil is mounted on ----------------------
    const tympY = H + (W + JW) * 0.30;
    const tymGeo = kit.geo(`door.tympanum:${W.toFixed(2)}`, () => {
      const p = new Parts();
      const r = (W + JW) * 0.5 - 0.55;
      // a half-round infill behind the arch
      p.add(new THREE.CylinderGeometry(r, r, 0.55, 26, 1, false, 0, Math.PI), { p: [0, 0, 0], r: [Math.PI / 2, 0, 0] });
      return faceted(p.merge());
    });
    const tym = new THREE.Mesh(tymGeo, o.stone);
    tym.name = 'door.tympanum';
    tym.position.set(0, H + 0.12, -0.10);
    tym.rotation.z = 0;
    tym.castShadow = true; tym.receiveShadow = true;
    stat.add(tym);

    // ---- the sigil --------------------------------------------------------
    const sigilMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(G.color) },
        uCore: { value: new THREE.Color(R.core) },
        uTime: { value: 0 }, uOpen: { value: 0 }, uGlyph: { value: GOD_GLYPH[god] ?? 0 }, uSeed: { value: o.seed },
      },
      vertexShader: SIGIL_VERT, fragmentShader: SIGIL_FRAG,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: false, side: THREE.FrontSide,
    });
    this._mats.push(sigilMat);
    const sigGeo = kit.geo('door.sigilquad', () => new THREE.PlaneGeometry(2.5, 2.5));
    const sig = new THREE.Mesh(sigGeo, sigilMat);
    sig.name = 'door.sigil';
    const sigY = H + 0.12 + (W + JW) * 0.175;
    sig.position.set(0, sigY, JD * 0.5 + 0.24);
    sig.renderOrder = 8;
    g.add(sig);

    // the mount: a gold ring + a pair of scroll brackets holding it proud
    const mountGeo = kit.geo('door.sigilmount', () => {
      const p = new Parts();
      p.add(new THREE.TorusGeometry(1.02, 0.085, 8, 36), { p: [0, 0, 0] });
      p.add(new THREE.TorusGeometry(1.16, 0.048, 6, 36), { p: [0, 0, -0.05] });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        p.add(new THREE.BoxGeometry(0.14, 0.26, 0.09), { p: [Math.cos(a) * 1.09, Math.sin(a) * 1.09, -0.03], r: [0, 0, a] });
      }
      return p.merge();
    });
    const mount = new THREE.Mesh(ensureColor(mountGeo), o.trim);
    mount.name = 'door.sigilmount';
    mount.position.set(0, sigY, JD * 0.5 + 0.14);
    mount.castShadow = true;
    stat.add(mount);

    // ---- the threshold plane ---------------------------------------------
    const rimC = (ctx.lighting && ctx.lighting.rim && ctx.lighting.rim.color)
      ? ctx.lighting.rim.color.clone() : new THREE.Color('#5fd0ff');
    const threshMat = new THREE.ShaderMaterial({
      uniforms: {
        uBody: { value: rimC },
        uCore: { value: new THREE.Color(G.color) },
        uInk: { value: new THREE.Color('#05040b') },
        uTime: { value: 0 }, uOpen: { value: 0 }, uSeed: { value: o.seed },
      },
      vertexShader: SIGIL_VERT, fragmentShader: THRESH_FRAG,
      toneMapped: false, side: THREE.FrontSide, depthWrite: true,
    });
    this._mats.push(threshMat);
    // ── ROUND-2 §7 HARD BAN FIX ───────────────────────────────────────────
    // This was a bare `PlaneGeometry(W, H + (W+JW)*0.42)` sitting only
    // JD*0.45 behind the door plane, so its RECTANGLE was the silhouette: the
    // top corners of the quad projected outside the semicircular arch and the
    // doorway read, at 3x, as a hard-edged teal-to-black gradient CARD cutting
    // across the stone. Three corrections:
    //   1. the quad now takes the shape of the OPENING (jambs + semicircular
    //      head), so no straight edge of it can ever cross the arch;
    //   2. it is inset a full jamb-depth behind the stone and undersized
    //      against the reveal below, so the stone always overlaps its border;
    //   3. a real REVEAL — two side returns and a soffit ring in the wall
    //      material — gives the opening architectural thickness, which is what
    //      makes a Hades doorway read as cut through a wall rather than
    //      painted on one.
    const OPW = W * 0.90;                        // opening clear width
    const OPS = H * 0.86;                        // springing of the head
    const thGeo = kit.geo(`door.thresh2:${W.toFixed(2)}:${H.toFixed(2)}`, () => archedQuad(OPW, OPS, 28));
    const th = new THREE.Mesh(thGeo, threshMat);
    th.name = 'door.threshold';
    th.position.set(0, 0, -JD * 0.95);
    g.add(th);

    // ---- the reveal: the wall's own thickness around the opening ----------
    const revGeo = kit.geo(`door.reveal:${W.toFixed(2)}:${H.toFixed(2)}`, () => {
      const p = new Parts();
      const d = JD * 1.05, t = 0.34;
      // side returns
      for (const sx of [-1, 1]) {
        p.box(t, OPS + 0.1, d, [sx * (OPW * 0.5 + t * 0.5), (OPS + 0.1) * 0.5, -d * 0.5]);
        // a bead running down the arris of each return — §9.5, a lit edge
        p.add(new THREE.CylinderGeometry(0.055, 0.055, OPS, 7),
          { p: [sx * (OPW * 0.5 + 0.03), OPS * 0.5, -0.02] });
      }
      // soffit: a half-annulus following the head of the arch
      const seg = 22;
      for (let i = 0; i < seg; i++) {
        const a = Math.PI * (i + 0.5) / seg;
        const r = OPW * 0.5 + t * 0.5;
        p.box(t, (Math.PI * OPW * 0.5 / seg) * 1.35, d,
          [Math.cos(a) * r, OPS + Math.sin(a) * r, -d * 0.5], [0, 0, a]);
      }
      // sill
      p.box(OPW + t * 2.2, 0.16, d, [0, 0.08, -d * 0.5]);
      return faceted(p.merge());
    });
    const rev = new THREE.Mesh(revGeo, o.stone);
    rev.name = 'door.reveal';
    rev.castShadow = true; rev.receiveShadow = true;
    stat.add(rev);

    // ---- a gold meander running up the jamb faces (§2, §9.5) --------------
    // The jambs were the widest unornamented stone in the room and they frame
    // the one place the eye is meant to travel to. A real extruded fret on
    // them puts gold at eye-line on the far arc, which is exactly where §9.3
    // wants the highlight band to live.
    for (const sx of [-1, 1]) {
      const band = kit.meanderBand({ h: JW * 0.52, length: H * 0.80, depth: 0.20, mat: o.trim });
      band.rotation.z = Math.PI / 2;
      band.rotation.y = Math.PI / 2;
      band.position.set(sx * (W * 0.5 + JW * 0.5), H * 0.46, JD * 0.5 + 0.02);
      stat.add(band);
    }

    // ---- the seal: two bronze leaves with a meander relief ----------------
    const leafGeo = kit.geo(`door.leaf:${W.toFixed(2)}:${H.toFixed(2)}`, () => {
      const lw = W * 0.5, lh = H + (W + JW) * 0.30;
      const p = new Parts();
      p.box(lw, lh, 0.24, [lw * 0.5, lh * 0.5, 0]);
      // raised frame + a boss grid so the leaf is not a slab
      p.box(lw * 0.98, 0.14, 0.34, [lw * 0.5, lh * 0.06, 0.05]);
      p.box(lw * 0.98, 0.14, 0.34, [lw * 0.5, lh * 0.94, 0.05]);
      for (let r = 0; r < 4; r++) {
        p.box(lw * 0.94, 0.10, 0.32, [lw * 0.5, lh * (0.18 + r * 0.20), 0.04]);
        for (let c = 0; c < 2; c++) {
          const b = new THREE.SphereGeometry(0.075, 8, 6);
          b.scale(1, 1, 0.55);
          p.add(b, { p: [lw * (0.26 + c * 0.48), lh * (0.28 + r * 0.20), 0.14] });
        }
      }
      return faceted(p.merge());
    });
    const leaves = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.name = 'door.leafpivot';
      pivot.position.set(s * W * 0.5, 0, -JD * 0.22);
      const m = new THREE.Mesh(leafGeo, o.metal);
      m.name = 'door.leaf';
      m.scale.x = -s;
      m.castShadow = true; m.receiveShadow = true;
      pivot.add(m);
      g.add(pivot);
      leaves.push({ pivot, sign: s });
    }
    // ring handles
    const ringGeo = kit.geo('door.handle', () => {
      const p = new Parts();
      p.add(new THREE.TorusGeometry(0.24, 0.045, 7, 18), { p: [0, 0, 0] });
      p.add(lathe([[0.10, 0], [0.16, 0.05], [0.09, 0.11]], 10), { p: [0, 0.26, 0.05], r: [Math.PI / 2, 0, 0] });
      return p.merge();
    });
    for (const l of leaves) {
      const m = new THREE.Mesh(ensureColor(ringGeo), o.trim);
      m.name = 'door.handle';
      m.position.set(-l.sign * W * 0.30, (H + (W + JW) * 0.30) * 0.42, 0.20);
      m.castShadow = true;
      l.pivot.add(m);
    }

    // ---- the step out to the threshold -----------------------------------
    const stepGeo = kit.geo(`door.step:${W.toFixed(2)}`, () => {
      const p = new Parts();
      p.box(W + JW * 1.6, 0.22, 1.5, [0, 0.11, 0]);
      p.box(W + JW * 1.9, 0.13, 1.9, [0, 0.065, 0.22]);
      return faceted(p.merge());
    });
    const step = new THREE.Mesh(stepGeo, o.stone);
    step.name = 'door.step';
    step.position.set(0, 0, JD * 0.30);
    step.receiveShadow = true; step.castShadow = true;
    stat.add(step);

    if (o.batch) {
      const wm = new THREE.Matrix4().compose(
        new THREE.Vector3(anchor.x, anchor.y || 0, anchor.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -anchor.angle - Math.PI / 2, 0)),
        new THREE.Vector3(1, 1, 1));
      o.batch.addTemplate(stat, wm, { name: 'door.static' });
      stat.clear();
    } else { g.add(stat); }

    const worldAnchor = new THREE.Vector3(
      anchor.x - Math.cos(anchor.angle) * 2.6, 2.4, anchor.z - Math.sin(anchor.angle) * 2.6);
    const trigger = new THREE.Vector3(
      anchor.x - Math.cos(anchor.angle) * 1.1, 0, anchor.z - Math.sin(anchor.angle) * 1.1);

    return {
      index, kind, god, godName: G.name, label: `${G.name} · ${R.label}`, color: G.color,
      group: g, sigilMat, threshMat, leaves,
      angle: anchor.angle,
      position: new THREE.Vector3(anchor.x, 0, anchor.z),
      anchor: worldAnchor,
      trigger,
      open: 0, target: 0, seed: o.seed,
    };
  }

  // -------------------------------------------------------------------------
  // public API
  // -------------------------------------------------------------------------
  getChoices() {
    return this.list.map((d) => ({
      index: d.index, kind: d.kind, god: d.god, godName: d.godName, label: d.label, color: d.color,
      position: d.position.clone(), anchor: d.anchor.clone(), sealed: this.sealed,
    }));
  }
  promptAnchor(i) {
    const d = this.list[i];
    return d ? d.anchor.clone() : new THREE.Vector3();
  }
  onEnter(cb) {
    this._cbs.push(cb);
    return () => { const i = this._cbs.indexOf(cb); if (i >= 0) this._cbs.splice(i, 1); };
  }
  /**
   * setSealed(v, snap) — snap skips the animation and lands on the end state.
   * The shot sheet steps some frames only 0.35s, which is halfway through the
   * unseal: the sigils are at half chroma and the thresholds are half dark, so
   * the captured frame shows a state the player never actually sees.
   */
  setSealed(v, snap = false) {
    this.sealed = !!v;
    for (const d of this.list) {
      d.target = this.sealed ? 0 : 1;
      if (snap) {
        d.open = d.target;
        for (const l of d.leaves) l.pivot.rotation.y = l.sign * d.open * 1.52;
        d.sigilMat.uniforms.uOpen.value = d.open;
        d.threshMat.uniforms.uOpen.value = d.open;
      }
    }
    return this;
  }
  unseal() { return this.setSealed(false); }

  // -------------------------------------------------------------------------
  update(dt, ctx) {
    this._t += dt;
    for (const d of this.list) {
      // ease-out open: fast in, slow settle (§5 motion doctrine)
      const k = d.target > d.open ? 1.9 : 4.5;
      d.open += (d.target - d.open) * Math.min(1, dt * k);
      const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, d.open)), 3);
      for (const l of d.leaves) l.pivot.rotation.y = l.sign * e * 1.52;
      d.sigilMat.uniforms.uOpen.value = e;
      d.sigilMat.uniforms.uTime.value = this._t;
      d.threshMat.uniforms.uOpen.value = e;
      d.threshMat.uniforms.uTime.value = this._t;
    }
    // enter detection
    if (!this.sealed && ctx && ctx.player && ctx.player.position) {
      const p = ctx.player.position;
      for (const d of this.list) {
        const dx = p.x - d.trigger.x, dz = p.z - d.trigger.z;
        if (dx * dx + dz * dz < 2.25) {
          if (this._entered !== d.index) {
            this._entered = d.index;
            const payload = { index: d.index, kind: d.kind, god: d.god, godName: d.godName, door: d };
            for (const cb of this._cbs.slice()) { try { cb(payload); } catch (e) { console.error('[doors]', e); } }
            ctx.events?.emit?.('door.entered', payload);
          }
          return;
        }
      }
      this._entered = -1;
    }
  }

  dispose() {
    for (const m of this._mats) m.dispose?.();
    this._mats.length = 0;
    this.list.length = 0;
    this._cbs.length = 0;
    this.root.clear();
  }
}

export default Doors;
