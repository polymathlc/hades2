// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// Ribbon trails that follow a moving transform (a weapon tip, a projectile, the
// hero during a dash). A ring buffer of world points is expanded into a
// camera-facing strip IN THE VERTEX SHADER — never on the CPU — so the ribbon
// is correct for whatever camera ends up drawing it. That matters here: the
// capture harness poses the camera after lateUpdate has already run, and a
// CPU-billboarded ribbon would be twisted in every shipped screenshot.
//
// Width tapers head->tail, colour runs head->tail through core/body/glow so the
// leading end is hot and the tail bleeds out into the god colour (§5).
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const VERT = /* glsl */`
precision highp float;
attribute vec3 aTan;
attribute vec3 aParam;     // x = side (-1/+1), y = u along the trail, z = width
varying vec2 vUv;
void main(){
  vec3 P = position;
  vec3 V = normalize(P - cameraPosition);
  vec3 S = cross(normalize(aTan), V);
  float l = length(S);
  S = l > 1e-4 ? S / l : vec3(0.0, 1.0, 0.0);
  P += S * aParam.x * aParam.z;
  vUv = vec2(aParam.y, aParam.x * 0.5 + 0.5);
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uOpacity;
uniform float uSeed;
void main(){
  float u = vUv.x;                 // 1 = head (newest), 0 = tail
  float v = abs(vUv.y * 2.0 - 1.0);
  float core = pow(max(0.0, 1.0 - v / 0.18), 1.7);
  float body = pow(max(0.0, 1.0 - v), 1.9);
  float glow = pow(max(0.0, 1.0 - v), 3.6) * 0.35;
  float head = smoothstep(0.30, 1.0, u);
  float fade = pow(u, 1.25);
  float grain = 0.84 + 0.16 * sin(u * 37.0 + uSeed);
  // the core is a hairline, not the whole ribbon: a fat white core turns any
  // trail into a ruled white line once AgX desaturates it
  vec3 c = uColor * (body * grain * 1.55 + glow * 0.45) + uCore * core * (0.14 + 0.62 * head);
  gl_FragColor = vec4(c * fade * uOpacity, 1.0);
}`;

const MAXP = 26;

export class Trails {
  constructor(n = 8) {
    this.pool = [];
    for (let i = 0; i < n; i++) {
      const V = MAXP * 2;
      const pos = new Float32Array(V * 3);
      const tan = new Float32Array(V * 3);
      const par = new Float32Array(V * 3);
      const idx = new Uint16Array((MAXP - 1) * 6);
      for (let s = 0; s < MAXP - 1; s++) {
        const b = s * 2, o = s * 6;
        idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 3;
        idx[o + 3] = b; idx[o + 4] = b + 3; idx[o + 5] = b + 2;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aTan', new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aParam', new THREE.BufferAttribute(par, 3).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          uColor: { value: new THREE.Color('#5fd0ff') },
          uCore: { value: new THREE.Color('#ffffff') },
          uOpacity: { value: 0 }, uSeed: { value: i * 3.1 },
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false; m.visible = false; m.renderOrder = 29;
      m.name = 'vfx.trail' + i;
      this.pool.push({
        mesh: m, mat, geo: g, pos, tan, par,
        live: false, target: null, getPos: null, n: 0,
        px: new Float32Array(MAXP), py: new Float32Array(MAXP), pz: new Float32Array(MAXP),
        width: 0.14, life: 0.3, age: 0, ttl: 0, op: 1, minStep: 0.045, offY: 0,
      });
    }
    this._v = new THREE.Vector3();
  }
  addTo(root) { for (const p of this.pool) root.add(p.mesh); return this; }

  /**
   * attach(object3DOrFn, {color, core, width, life, ttl, opacity, offsetY})
   * `life` is how long a point survives in the ribbon (the tail length in
   * seconds); `ttl` is how long the trail keeps sampling (0 = until released).
   * Returns a handle with .release() and .setColor().
   */
  attach(target, o = {}) {
    let s = null, oldest = this.pool[0];
    for (const p of this.pool) { if (!p.live) { s = p; break; } if (p.age > oldest.age) oldest = p; }
    if (!s) { s = oldest; }
    s.live = true; s.n = 0; s.age = 0;
    s.target = (target && target.isObject3D) ? target : null;
    s.getPos = (typeof target === 'function') ? target : null;
    s.fixed = (!s.target && !s.getPos && target) ? target : null;
    s.width = o.width ?? 0.14;
    s.life = o.life ?? 0.30;
    s.ttl = o.ttl ?? 0;
    s.op = o.opacity ?? 1;
    s.offY = o.offsetY ?? 0;
    s.minStep = o.minStep ?? 0.04;
    s.fading = false;
    s.mat.uniforms.uColor.value.set(o.color || '#5fd0ff');
    s.mat.uniforms.uCore.value.set(o.core || '#ffffff');
    s.mat.uniforms.uOpacity.value = s.op;
    s.mesh.visible = true;
    const h = {
      release: () => { s.fading = true; },
      kill: () => { s.live = false; s.mesh.visible = false; },
      setColor: (c) => s.mat.uniforms.uColor.value.set(c),
      move: (x, y, z) => { if (s.fixed) { s.fixed.x = x; s.fixed.y = y; s.fixed.z = z; } },
      slot: s,
    };
    return h;
  }

  _sample(s) {
    const v = this._v;
    if (s.target) { s.target.getWorldPosition(v); }
    else if (s.getPos) { const r = s.getPos(v); if (r && r !== v) v.copy(r); }
    else if (s.fixed) { v.set(s.fixed.x, s.fixed.y, s.fixed.z); }
    else return false;
    v.y += s.offY;
    return true;
  }

  update(dt) {
    for (const s of this.pool) {
      if (!s.live) continue;
      s.age += dt;
      if (s.ttl > 0 && s.age > s.ttl) s.fading = true;

      if (!s.fading && this._sample(s)) {
        const v = this._v;
        const n = s.n;
        let push = n === 0;
        if (!push) {
          const dx = v.x - s.px[n - 1], dy = v.y - s.py[n - 1], dz = v.z - s.pz[n - 1];
          push = (dx * dx + dy * dy + dz * dz) > s.minStep * s.minStep;
        }
        if (push) {
          if (n >= MAXP) {
            for (let i = 1; i < MAXP; i++) { s.px[i - 1] = s.px[i]; s.py[i - 1] = s.py[i]; s.pz[i - 1] = s.pz[i]; }
            s.n = MAXP - 1;
          }
          s.px[s.n] = v.x; s.py[s.n] = v.y; s.pz[s.n] = v.z; s.n++;
        } else if (n > 0) {
          s.px[n - 1] = v.x; s.py[n - 1] = v.y; s.pz[n - 1] = v.z;
        }
      } else if (s.fading) {
        // eat the tail so the ribbon retracts instead of blinking out
        s.eat = (s.eat || 0) + dt / Math.max(0.02, s.life) * MAXP;
        while (s.eat >= 1 && s.n > 0) {
          s.eat -= 1;
          for (let i = 1; i < s.n; i++) { s.px[i - 1] = s.px[i]; s.py[i - 1] = s.py[i]; s.pz[i - 1] = s.pz[i]; }
          s.n--;
        }
        if (s.n <= 1) { s.live = false; s.mesh.visible = false; s.eat = 0; continue; }
      }
      this._build(s);
    }
  }

  _build(s) {
    const n = s.n;
    if (n < 2) { s.geo.setDrawRange(0, 0); return; }
    const pos = s.pos, tan = s.tan, par = s.par;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = s.px[i1] - s.px[i0], ty = s.py[i1] - s.py[i0], tz = s.pz[i1] - s.pz[i0];
      const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
      const u = n > 1 ? i / (n - 1) : 1;
      // taper: needle at the tail, full width just behind the head, rounded tip
      const w = s.width * Math.pow(u, 0.55) * (1 - 0.35 * Math.pow(Math.max(0, u - 0.82) / 0.18, 2));
      for (let k = 0; k < 2; k++) {
        const o3 = (i * 2 + k) * 3;
        pos[o3] = s.px[i]; pos[o3 + 1] = s.py[i]; pos[o3 + 2] = s.pz[i];
        tan[o3] = tx; tan[o3 + 1] = ty; tan[o3 + 2] = tz;
        par[o3] = k === 0 ? -1 : 1; par[o3 + 1] = u; par[o3 + 2] = w;
      }
    }
    s.geo.attributes.position.needsUpdate = true;
    s.geo.attributes.aTan.needsUpdate = true;
    s.geo.attributes.aParam.needsUpdate = true;
    s.geo.setDrawRange(0, (n - 1) * 6);
  }

  clear() { for (const s of this.pool) { s.live = false; s.n = 0; s.eat = 0; s.mesh.visible = false; } }
  dispose() { for (const s of this.pool) { s.geo.dispose(); s.mat.dispose(); } }
}

export default Trails;
