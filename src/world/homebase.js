// The Crossroads: a quiet, persistent hub layered onto the existing chamber
// architecture. The ring starts a run by physically walking through it; the
// altar opens permanent god progression with the Interact key.

import * as THREE from 'three';
import { GOD_INFO, GOD_KEYS } from '../game/boons.js';

const PORTAL_POS = new THREE.Vector3(0, 0, -7.0);
const ALTAR_POS = new THREE.Vector3(6.4, 0, 0.2);

function standard(color, emissive = 0x000000, emissiveIntensity = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.22, emissive, emissiveIntensity });
}

export class HomeBase {
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.onPortal = o.onPortal || (() => {});
    this.onAltar = o.onAltar || (() => {});
    this.root = new THREE.Group();
    this.root.name = 'home.base';
    this._geo = [];
    this._ownedMats = [];
    this._portalTriggered = false;
    this.t = 0;
  }

  _g(geometry) { this._geo.push(geometry); return geometry; }
  _m(material) { this._ownedMats.push(material); return material; }
  _mesh(geometry, material, parent = this.root) {
    const mesh = new THREE.Mesh(this._g(geometry), material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  enter() {
    const ctx = this.ctx;
    const world = ctx.world;
    world?.root?.add?.(this.root);
    world?.setCleared?.(false);
    ctx.spawner?.stop?.();
    ctx.enemies?.clear?.();

    const stone = ctx.mats?.get?.('stone.tartarus.rim', { variation: 0.18, litGain: 0.82, ambGain: 1.05 }) || standard(0x302542);
    const shrine = ctx.mats?.get?.('shrine.divine', { variation: 0.12, litGain: 0.88, ambGain: 1.0 }) || stone;
    const bronze = ctx.mats?.get?.('bronze.tartarus', { roughness: 0.38, metalness: 0.88 }) || standard(0x9c6a2f);
    const dark = ctx.mats?.get?.('iron.tartarus', { roughness: 0.65, metalness: 0.7 }) || standard(0x171224);

    this._buildPortal(stone, bronze, dark);
    this._buildAltar(shrine, bronze, dark);

    // Crossroads lighting is subject-first: a broad cool fill preserves the
    // hero silhouette while a small warm forge bounce separates the altar.
    const fill = new THREE.PointLight('#b9d7ff', 5.5, 28, 1.7);
    fill.position.set(-4.5, 7.5, 5.5); this.root.add(fill);
    const forgeBounce = new THREE.PointLight('#ff9b42', 4.2, 17, 1.9);
    forgeBounce.position.set(ALTAR_POS.x - 1.2, 3.2, ALTAR_POS.z + 1.8); this.root.add(forgeBounce);

    const p = ctx.player;
    if (p) {
      p.position.set(0, 0, 4.6);
      p.velocity?.set?.(0, 0, 0);
      p.knock?.set?.(0, 0, 0);
      p.facing?.set?.(0, -1);
      p.state = 'move';
      p.iframes = Math.max(p.iframes || 0, 0.8);
      p._resolve?.(ctx);
      ctx.cameraRig?.snap?.(p.position);
    }

    ctx.ui?.clearPrompts?.();
    ctx.ui?.prompt?.(PORTAL_POS, 'WALK THROUGH · BEGIN THE DESCENT', { key: 'W', height: 4.75, dur: 1e9 });
    ctx.ui?.prompt?.(ALTAR_POS, 'OFFER NECTAR · ALTAR OF THE GODS', { key: 'F', height: 3.0, dur: 1e9 });
    ctx.ui?.prompt?.(new THREE.Vector3(-5.8, 0, 3.8), 'CONTROLS & AUDIO SETTINGS', { key: 'H', height: 2.0, dur: 1e9 });
    ctx.ui?.setRoom?.(0, 'crossroads');
    ctx.ui?.toast?.('THE CROSSROADS · HOME', { color: '#d8b6ff', dur: 3.0 });
    return this;
  }

  _buildPortal(stone, bronze, dark) {
    const g = new THREE.Group();
    g.name = 'home.portal';
    g.position.copy(PORTAL_POS);
    this.root.add(g);

    const base = this._mesh(new THREE.CylinderGeometry(2.75, 3.1, 0.44, 32), stone, g);
    base.position.y = 0.22;
    const step = this._mesh(new THREE.CylinderGeometry(2.25, 2.62, 0.25, 32), bronze, g);
    step.position.set(0, 0.48, 0);

    const ring = this._mesh(new THREE.TorusGeometry(2.05, 0.24, 14, 64), bronze, g);
    ring.position.y = 2.55;
    const innerRing = this._mesh(new THREE.TorusGeometry(1.72, 0.08, 10, 64), dark, g);
    innerRing.position.y = 2.55;

    const portalMat = this._m(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColorA: { value: new THREE.Color('#3d1f91') }, uColorB: { value: new THREE.Color('#a775ff') } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        varying vec2 vUv; uniform float uTime; uniform vec3 uColorA; uniform vec3 uColorB;
        void main(){
          vec2 p=vUv-0.5; float r=length(p)*2.0; float a=atan(p.y,p.x);
          float flow=0.5+0.5*sin(a*6.0-r*11.0+uTime*2.4);
          float veil=smoothstep(1.0,0.74,r)*(0.32+flow*0.34)+smoothstep(1.0,0.1,r)*0.18;
          vec3 c=mix(uColorA,uColorB,flow+0.15*(1.0-r)); gl_FragColor=vec4(c,veil);
        }`,
    }));
    this.portalCore = this._mesh(new THREE.CircleGeometry(1.66, 64), portalMat, g);
    this.portalCore.position.y = 2.55;
    this.portalCore.castShadow = false; this.portalCore.receiveShadow = false;

    this.runes = new THREE.Group();
    this.runes.position.y = 2.55;
    g.add(this.runes);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      const rune = this._mesh(new THREE.BoxGeometry(0.24, 0.36, 0.12), i % 2 ? bronze : dark, this.runes);
      rune.position.set(Math.cos(a) * 2.48, Math.sin(a) * 2.48, 0);
      rune.rotation.z = a;
    }

    const light = new THREE.PointLight('#8c5cff', 10.5, 13, 2);
    light.position.set(0, 2.5, 0.7);
    g.add(light);
    this.portalLight = light;
  }

  _buildAltar(stone, bronze, dark) {
    const g = new THREE.Group();
    g.name = 'home.altar';
    g.position.copy(ALTAR_POS);
    this.root.add(g);

    const p0 = this._mesh(new THREE.CylinderGeometry(2.35, 2.65, 0.35, 10), stone, g); p0.position.y = 0.18;
    const p1 = this._mesh(new THREE.CylinderGeometry(1.75, 2.08, 0.55, 10), dark, g); p1.position.y = 0.62;
    const table = this._mesh(new THREE.CylinderGeometry(1.82, 1.65, 0.22, 10), bronze, g); table.position.y = 1.0;
    const bowl = this._mesh(new THREE.TorusGeometry(0.62, 0.13, 10, 36), bronze, g); bowl.rotation.x = Math.PI / 2; bowl.position.y = 1.25;
    const nectar = this._m(new THREE.MeshStandardMaterial({ color: '#ad72ff', emissive: '#6b2ccf', emissiveIntensity: 2.0, roughness: 0.18, transparent: true, opacity: 0.82 }));
    const pool = this._mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.08, 32), nectar, g); pool.position.y = 1.25;
    this.altarPool = pool;

    this.godLights = new THREE.Group();
    this.godLights.position.y = 1.23;
    g.add(this.godLights);
    for (let i = 0; i < GOD_KEYS.length; i++) {
      const god = GOD_KEYS[i], a = i / GOD_KEYS.length * Math.PI * 2;
      const mat = this._m(new THREE.MeshStandardMaterial({ color: GOD_INFO[god].color, emissive: GOD_INFO[god].color, emissiveIntensity: 1.2, roughness: 0.28, metalness: 0.28 }));
      const gem = this._mesh(new THREE.OctahedronGeometry(0.16, 0), mat, this.godLights);
      gem.position.set(Math.cos(a) * 1.32, 0.18, Math.sin(a) * 1.32);
      gem.userData.phase = a;
    }
    const light = new THREE.PointLight('#ffb166', 4.8, 10, 2);
    light.position.y = 2.0;
    g.add(light);
  }

  update(dt) {
    this.t += dt;
    if (this.portalCore?.material?.uniforms) this.portalCore.material.uniforms.uTime.value = this.t;
    if (this.portalCore) {
      const s = 1 + Math.sin(this.t * 2.2) * 0.025;
      this.portalCore.scale.setScalar(s);
    }
    if (this.runes) this.runes.rotation.z = this.t * 0.10;
    if (this.portalLight) this.portalLight.intensity = 9.5 + Math.sin(this.t * 3.1) * 1.4;
    if (this.altarPool) this.altarPool.rotation.y = this.t * 0.32;
    if (this.godLights) {
      for (const gem of this.godLights.children) {
        gem.rotation.y += dt * 0.8;
        gem.position.y = 0.18 + Math.sin(this.t * 2 + gem.userData.phase) * 0.06;
      }
    }

    const p = this.ctx.player?.position;
    if (!p) return;
    const pd = Math.hypot(p.x - PORTAL_POS.x, p.z - PORTAL_POS.z);
    if (!this._portalTriggered && pd < 1.18) {
      this._portalTriggered = true;
      this.onPortal();
      return;
    }
    const ad = Math.hypot(p.x - ALTAR_POS.x, p.z - ALTAR_POS.z);
    if (ad < 2.5 && this.ctx.input?.pressed?.('interact')) this.onAltar();
  }

  dispose() {
    this.ctx.ui?.clearPrompts?.();
    this.root.removeFromParent();
    for (const geometry of this._geo) geometry.dispose?.();
    for (const material of this._ownedMats) material.dispose?.();
    this._geo.length = 0; this._ownedMats.length = 0;
  }
}

/** A boss reward that visibly drops, then homes to the hero and is banked. */
export class NectarDrop {
  constructor(ctx, pos, amount = 2, onCollect = () => {}) {
    this.ctx = ctx;
    this.amount = amount;
    this.onCollect = onCollect;
    this.t = 0;
    this.dead = false;
    this.root = new THREE.Group();
    this.root.name = 'reward.nectar';
    this.root.position.copy(pos || new THREE.Vector3()).setY(0.45);
    this.geo = [];
    this.mats = [];
    const purple = new THREE.MeshStandardMaterial({ color: '#b884ff', emissive: '#6b2ccf', emissiveIntensity: 2.4, roughness: 0.2, transparent: true, opacity: 0.88 });
    const gold = new THREE.MeshStandardMaterial({ color: '#f2c14e', emissive: '#6d4416', emissiveIntensity: 0.45, metalness: 0.8, roughness: 0.3 });
    this.mats.push(purple, gold);
    const profile = [new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.28, 0.04), new THREE.Vector2(0.34, 0.34), new THREE.Vector2(0.24, 0.68), new THREE.Vector2(0.14, 0.82), new THREE.Vector2(0.14, 1.02), new THREE.Vector2(0.0, 1.06)];
    const bodyG = new THREE.LatheGeometry(profile, 20); this.geo.push(bodyG);
    const body = new THREE.Mesh(bodyG, purple); body.castShadow = true; this.root.add(body);
    const capG = new THREE.CylinderGeometry(0.20, 0.16, 0.18, 16); this.geo.push(capG);
    const cap = new THREE.Mesh(capG, gold); cap.position.y = 1.08; this.root.add(cap);
    const haloG = new THREE.TorusGeometry(0.52, 0.045, 8, 32); this.geo.push(haloG);
    const halo = new THREE.Mesh(haloG, gold); halo.rotation.x = Math.PI / 2; halo.position.y = 0.45; this.root.add(halo);
    this.halo = halo;
    const light = new THREE.PointLight('#b884ff', 8, 7, 2); light.position.y = 0.65; this.root.add(light);
    ctx.scene?.add?.(this.root);
    ctx.ui?.prompt?.(this.root.position, `NECTAR ×${amount}`, { key: '✦', height: 2.1, dur: 4 });
  }

  update(dt) {
    if (this.dead) return true;
    this.t += dt;
    this.root.rotation.y += dt * 1.4;
    this.root.position.y = 0.5 + Math.sin(this.t * 4) * 0.12;
    if (this.halo) this.halo.rotation.z += dt * 0.6;
    const p = this.ctx.player?.position;
    if (p && this.t > 0.65) {
      const dx = p.x - this.root.position.x, dz = p.z - this.root.position.z;
      const d = Math.hypot(dx, dz);
      const speed = 2.5 + this.t * 3.5;
      if (d > 0.001) {
        const step = Math.min(d, speed * dt);
        this.root.position.x += dx / d * step;
        this.root.position.z += dz / d * step;
      }
      if (d < 0.8) {
        this.ctx.vfx?.burst?.(p.clone().setY(1.1), { count: 24, color: '#b884ff', speed: 8, spread: 1.0, kind: 'shard' });
        this.ctx.vfx?.shockwave?.(p.clone().setY(0.06), { radius: 2.4, color: '#d8b6ff', life: 0.55 });
        this.onCollect(this.amount);
        this.dispose();
        return true;
      }
    }
    return false;
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    this.root.removeFromParent();
    for (const geometry of this.geo) geometry.dispose?.();
    for (const material of this.mats) material.dispose?.();
  }
}

export const HOME_PORTAL_POS = PORTAL_POS;
export const HOME_ALTAR_POS = ALTAR_POS;

export default HomeBase;
