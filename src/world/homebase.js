// The Crossroads: a quiet, persistent hub layered onto the existing chamber
// architecture. The ring starts a run by physically walking through it; the
// altar opens permanent god progression with the Interact key.

import * as THREE from 'three';
import { GOD_INFO, GOD_KEYS } from '../game/boons.js';
import { WEAPONS, WEAPON_IDS } from '../entities/weapons.js';
import { CHARACTER_INFO, CHARACTER_IDS, characterInfo, weaponIdsForCharacter } from '../game/characters.js';

const PORTAL_POS = new THREE.Vector3(0, 0, -7.0);
const ALTAR_POS = new THREE.Vector3(6.4, 0, 0.2);
const MIRROR_POS = new THREE.Vector3(-6.35, 0, -1.9);
// The altar's widest plinth is 2.65m. Keep the hero capsule outside it while
// leaving the interaction range comfortably reachable from the floor.
const ALTAR_SAFE_RADIUS = 3.22;
const ALTAR_RELEASE_RADIUS = 3.48;
const ALTAR_INTERACT_RADIUS = 3.65;
const ARMORY_POS = {
  blade:  new THREE.Vector3(-6.3, 0, 4.3),
  spear:  new THREE.Vector3(-2.25, 0, 6.75),
  bow:    new THREE.Vector3(2.25, 0, 6.75),
  shield: new THREE.Vector3(6.3, 0, 4.3),
  fists:  new THREE.Vector3(-4.8, 0, 6.55),
  rail:   new THREE.Vector3(4.8, 0, 6.55),
};
const CHARACTER_POS = {
  zagreus: new THREE.Vector3(-2.65, 0, 2.75),
  melinoe: new THREE.Vector3(2.65, 0, 2.75),
};

function standard(color, emissive = 0x000000, emissiveIntensity = 0) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.58, metalness: 0.22, emissive, emissiveIntensity });
}

export class HomeBase {
  constructor(ctx, o = {}) {
    this.ctx = ctx;
    this.onPortal = o.onPortal || (() => {});
    this.onAltar = o.onAltar || (() => {});
    this.onMirror = o.onMirror || (() => {});
    this.onWeapon = o.onWeapon || (() => false);
    this.onCharacter = o.onCharacter || (() => false);
    this.selectedCharacter = characterInfo(o.character).id;
    this.root = new THREE.Group();
    this.root.name = 'home.base';
    this._geo = [];
    this._ownedMats = [];
    this._portalTriggered = false;
    this.armory = [];
    this.characterStations = [];
    this.selectedWeapon = null;
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
    this._buildMirror(stone, bronze, dark);
    this._armoryMats = { stone, bronze, dark };
    this._buildCharacters(stone, bronze, dark);
    this._buildArmory(stone, bronze, dark, this.selectedCharacter);

    // Crossroads lighting is subject-first: a broad cool fill preserves the
    // hero silhouette while a small warm forge bounce separates the altar.
    const fill = new THREE.PointLight('#d4e5ff', 8.0, 32, 1.7);
    fill.position.set(-4.5, 7.5, 5.5); this.root.add(fill);
    const forgeBounce = new THREE.PointLight('#ffb46e', 6.0, 20, 1.9);
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

    this._publishPrompts();
    ctx.ui?.setRoom?.(0, 'crossroads');
    ctx.ui?.toast?.('THE CROSSROADS · CHOOSE YOUR HEIR AND ARM', { color: '#d8b6ff', dur: 3.0 });
    return this;
  }

  _publishPrompts() {
    const ctx = this.ctx;
    ctx.ui?.clearPrompts?.();
    ctx.ui?.prompt?.(PORTAL_POS, 'WALK THROUGH · BEGIN THE DESCENT', { key: 'W', height: 4.75, dur: 1e9, maxDistance: 3.4 });
    ctx.ui?.prompt?.(ALTAR_POS, 'OFFER NECTAR · ALTAR OF THE GODS', { key: 'F', height: 3.0, dur: 1e9, maxDistance: 2.7 });
    ctx.ui?.prompt?.(MIRROR_POS, 'MIRROR OF NIGHT · SPEND DARKNESS', { key: 'F', height: 3.25, dur: 1e9, maxDistance: 2.7 });
    ctx.ui?.prompt?.(new THREE.Vector3(0, 0, -2.5), 'CONTROLS & AUDIO SETTINGS', { key: 'H', height: 2.0, dur: 1e9, maxDistance: 2.5 });
    for (const arm of this.armory) {
      ctx.ui?.prompt?.(arm.position, `${WEAPONS[arm.id].name.toUpperCase()} · EQUIP FOR THIS DESCENT`, { key: 'E', height: 3.35, dur: 1e9, maxDistance: 2.25 });
    }
    for (const station of this.characterStations) {
      const C = CHARACTER_INFO[station.id];
      ctx.ui?.prompt?.(station.position, `${C.name.toUpperCase()} · ${C.game.toUpperCase()} HERO`, { key: 'E', height: 3.45, dur: 1e9, maxDistance: 2.25 });
    }
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

  _buildMirror(stone, bronze, dark) {
    const g = new THREE.Group();
    g.name = 'home.mirrorOfNight';
    g.position.copy(MIRROR_POS);
    g.rotation.y = Math.PI * 0.42;
    this.root.add(g);

    const base = this._mesh(new THREE.CylinderGeometry(1.05, 1.28, 0.34, 10), stone, g);
    base.position.y = 0.17;
    const stem = this._mesh(new THREE.BoxGeometry(0.32, 1.1, 0.34), dark, g);
    stem.position.y = 0.92;
    const frameMat = this._m(new THREE.MeshStandardMaterial({
      color: '#8b6332', emissive: '#5c2b82', emissiveIntensity: 0.42,
      metalness: 0.82, roughness: 0.34,
    }));
    const outer = this._mesh(new THREE.TorusGeometry(1.12, 0.15, 10, 48), frameMat, g);
    outer.position.y = 2.28;
    const crown = this._mesh(new THREE.ConeGeometry(0.34, 0.62, 5), bronze, g);
    crown.position.y = 3.58;
    for (const sx of [-1, 1]) {
      const wing = this._mesh(new THREE.BoxGeometry(0.52, 0.09, 0.16), frameMat, g);
      wing.position.set(sx * 0.93, 3.18, 0);
      wing.rotation.z = sx * 0.42;
    }

    const mirrorMat = this._m(new THREE.ShaderMaterial({
      transparent: true, depthWrite: true, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uDark: { value: new THREE.Color('#120821') }, uGlow: { value: new THREE.Color('#9f67ff') } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec2 vUv; uniform float uTime; uniform vec3 uDark; uniform vec3 uGlow;
        void main(){ vec2 p=vUv-.5; float r=length(p); float veil=.12+.08*sin((p.y+p.x)*18.0-uTime*1.4);
          float stars=pow(max(0.0,sin(p.x*91.0+p.y*57.0+uTime)*sin(p.y*73.0-p.x*41.0)),18.0);
          vec3 c=mix(uDark,uGlow,veil+stars*.75+(1.0-r)*.08); gl_FragColor=vec4(c,.96); }`,
    }));
    const surface = this._mesh(new THREE.CircleGeometry(0.96, 48), mirrorMat, g);
    surface.name = 'home.mirrorOfNight.surface';
    surface.position.set(0, 2.28, 0.055);
    surface.castShadow = false;
    this.mirrorSurface = surface;
    const light = new THREE.PointLight('#8c5cff', 4.2, 8, 2);
    light.position.set(0, 2.35, 0.8);
    g.add(light);
    this.mirrorLight = light;
  }

  _buildCharacters(stone, bronze, dark) {
    for (let i = 0; i < CHARACTER_IDS.length; i++) {
      const id = CHARACTER_IDS[i], C = CHARACTER_INFO[id];
      const station = new THREE.Group();
      station.name = `home.character.${id}`;
      station.position.copy(CHARACTER_POS[id]);
      this.root.add(station);
      const base = this._mesh(new THREE.CylinderGeometry(1.05, 1.25, 0.28, 16), stone, station); base.position.y = 0.14;
      const haloMat = this._m(new THREE.MeshStandardMaterial({ color: C.color, emissive: C.color, emissiveIntensity: 1.15, roughness: 0.25, metalness: 0.55 }));
      const halo = this._mesh(new THREE.TorusGeometry(0.75, 0.055, 8, 36), haloMat, station); halo.rotation.x = Math.PI / 2; halo.position.y = 0.38;
      const figure = new THREE.Group(); figure.name = `home.character.${id}.figure`; figure.position.y = 0.42; station.add(figure);
      const body = this._mesh(new THREE.CylinderGeometry(0.24, 0.34, 1.10, 9), id === 'melinoe' ? dark : bronze, figure); body.position.y = 0.84;
      const head = this._mesh(new THREE.SphereGeometry(0.24, 14, 10), haloMat, figure); head.position.y = 1.56;
      if (id === 'zagreus') {
        const crown = this._mesh(new THREE.TorusGeometry(0.26, 0.035, 7, 24), bronze, figure); crown.rotation.x = Math.PI / 2; crown.position.y = 1.74;
        const shoulder = this._mesh(new THREE.SphereGeometry(0.26, 12, 8), bronze, figure); shoulder.scale.set(1.2, 0.45, 0.8); shoulder.position.set(-0.25, 1.28, 0);
      } else {
        const moon = this._mesh(new THREE.TorusGeometry(0.25, 0.035, 7, 24, Math.PI * 1.5), haloMat, figure); moon.rotation.z = 0.78; moon.position.y = 1.79;
        const arm = this._mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.72, 8), haloMat, figure); arm.position.set(0.30, 1.08, 0); arm.rotation.z = -0.18;
        const mantle = this._mesh(new THREE.ConeGeometry(0.48, 1.05, 9, 1, true), dark, figure); mantle.position.y = 0.83;
      }
      const light = new THREE.PointLight(C.color, id === this.selectedCharacter ? 4.8 : 2.0, 6.5, 2); light.position.y = 1.7; station.add(light);
      this.characterStations.push({ id, position: CHARACTER_POS[id], station, figure, halo, light, phase: i * Math.PI, selected: id === this.selectedCharacter });
    }
  }

  _armoryPosition(index, count) {
    if (count === 6) {
      const x = [-7.0, -4.4, -1.55, 1.55, 4.4, 7.0][index];
      const z = [4.0, 6.25, 7.25, 7.25, 6.25, 4.0][index];
      return new THREE.Vector3(x, 0, z);
    }
    return new THREE.Vector3(-6.3 + index * (12.6 / Math.max(1, count - 1)), 0, index === 0 || index === count - 1 ? 4.3 : 6.75);
  }

  _rod(a, b, radius, material, parent) {
    const delta = b.clone().sub(a), length = delta.length();
    const mesh = this._mesh(new THREE.CylinderGeometry(radius, radius, length, 10), material, parent);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    return mesh;
  }

  _buildWeaponModel(id, parent, core, body, dark) {
    if (id === 'blade') {
      const blade = this._mesh(new THREE.BoxGeometry(0.20, 1.55, 0.10), core, parent); blade.position.y = 0.24;
      const tip = this._mesh(new THREE.ConeGeometry(0.145, 0.38, 4), core, parent); tip.position.y = 1.205; tip.rotation.y = Math.PI / 4;
      const guard = this._mesh(new THREE.BoxGeometry(0.88, 0.13, 0.18), body, parent); guard.position.y = -0.60;
      const grip = this._mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.58, 10), dark, parent); grip.position.y = -0.94;
      const pommel = this._mesh(new THREE.OctahedronGeometry(0.17, 0), body, parent); pommel.position.y = -1.28;
      parent.rotation.z = -0.16;
    } else if (id === 'spear') {
      const shaft = this._mesh(new THREE.CylinderGeometry(0.065, 0.075, 2.45, 10), dark, parent); shaft.position.y = -0.05;
      const collar = this._mesh(new THREE.CylinderGeometry(0.16, 0.11, 0.30, 8), body, parent); collar.position.y = 1.26;
      const head = this._mesh(new THREE.ConeGeometry(0.25, 0.72, 4), core, parent); head.position.y = 1.74; head.rotation.y = Math.PI / 4;
      const butt = this._mesh(new THREE.ConeGeometry(0.12, 0.35, 6), body, parent); butt.position.y = -1.48; butt.rotation.z = Math.PI;
      parent.rotation.z = 0.12;
    } else if (id === 'bow') {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0.18, -1.12, 0), new THREE.Vector3(0.52, -0.62, 0),
        new THREE.Vector3(0.05, 0, 0), new THREE.Vector3(0.52, 0.62, 0), new THREE.Vector3(0.18, 1.12, 0),
      ]);
      this._mesh(new THREE.TubeGeometry(curve, 28, 0.085, 8, false), body, parent);
      this._rod(new THREE.Vector3(0.18, -1.12, 0), new THREE.Vector3(0.18, 1.12, 0), 0.018, core, parent);
      this._rod(new THREE.Vector3(-0.58, -0.04, 0.05), new THREE.Vector3(0.72, -0.04, 0.05), 0.025, dark, parent);
      const arrow = this._mesh(new THREE.ConeGeometry(0.09, 0.28, 6), core, parent); arrow.position.set(0.81, -0.04, 0.05); arrow.rotation.z = -Math.PI / 2;
      parent.rotation.z = -0.08;
    } else if (id === 'shield') {
      const disk = this._mesh(new THREE.CylinderGeometry(0.86, 0.86, 0.18, 32), body, parent); disk.rotation.x = Math.PI / 2;
      const rim = this._mesh(new THREE.TorusGeometry(0.78, 0.10, 10, 36), core, parent); rim.position.z = 0.11;
      const boss = this._mesh(new THREE.SphereGeometry(0.28, 16, 10), core, parent); boss.scale.z = 0.55; boss.position.z = 0.18;
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2;
        const stud = this._mesh(new THREE.SphereGeometry(0.055, 8, 6), dark, parent);
        stud.position.set(Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0.22);
      }
      parent.rotation.x = -0.10;
    } else if (id === 'fists' || id === 'coat') {
      const cuff = this._mesh(new THREE.CylinderGeometry(id === 'coat' ? 0.34 : 0.25, 0.22, 0.85, 10), body, parent); cuff.position.y = -0.15;
      const plate = this._mesh(new THREE.BoxGeometry(id === 'coat' ? 0.85 : 0.65, 0.34, 0.28), core, parent); plate.position.set(0, 0.25, 0.10);
      for (const sx of [-1, 1]) {
        const spike = this._mesh(new THREE.ConeGeometry(0.10, 0.48, 6), body, parent); spike.position.set(sx * 0.25, 0.60, 0); spike.rotation.z = Math.PI;
      }
    } else if (id === 'rail') {
      const bodyM = this._mesh(new THREE.BoxGeometry(0.38, 1.45, 0.32), body, parent); bodyM.position.y = -0.2;
      const barrel = this._mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.10, 10), core, parent); barrel.position.y = 0.95;
      const muzzle = this._mesh(new THREE.TorusGeometry(0.18, 0.045, 8, 20), core, parent); muzzle.rotation.x = Math.PI / 2; muzzle.position.y = 1.52;
    } else if (id === 'staff') {
      const shaft = this._mesh(new THREE.CylinderGeometry(0.06, 0.075, 2.65, 10), dark, parent); shaft.position.y = -0.10;
      const moon = this._mesh(new THREE.TorusGeometry(0.36, 0.075, 9, 30, Math.PI * 1.55), core, parent); moon.position.y = 1.45; moon.rotation.z = 0.76;
      const gem = this._mesh(new THREE.OctahedronGeometry(0.17, 0), body, parent); gem.position.y = 1.45;
    } else if (id === 'blades') {
      for (const sx of [-1, 1]) {
        const knife = this._mesh(new THREE.ConeGeometry(0.15, 1.20, 4), sx > 0 ? core : body, parent); knife.position.set(sx * 0.18, 0.18, 0); knife.rotation.set(0, Math.PI / 4, sx > 0 ? 0.12 : -0.12);
        const grip = this._mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.46, 8), dark, parent); grip.position.set(sx * 0.18, -0.65, 0);
      }
    } else if (id === 'flames') {
      const grip = this._mesh(new THREE.CylinderGeometry(0.08, 0.11, 1.1, 10), dark, parent); grip.position.y = -0.25;
      for (let i = 0; i < 3; i++) {
        const ring = this._mesh(new THREE.TorusGeometry(0.24 + i * 0.09, 0.045, 8, 24), i === 2 ? core : body, parent); ring.position.y = 0.45; ring.rotation.x = Math.PI / 2 + i * 0.2;
      }
      const ember = this._mesh(new THREE.OctahedronGeometry(0.22, 1), core, parent); ember.position.y = 0.55;
    } else if (id === 'axe') {
      const shaft = this._mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.45, 10), dark, parent); shaft.position.y = -0.1;
      const head = this._mesh(new THREE.BoxGeometry(1.20, 0.38, 0.22), body, parent); head.position.set(0.28, 1.22, 0); head.rotation.z = 0.18;
      const edge = this._mesh(new THREE.ConeGeometry(0.45, 0.82, 4), core, parent); edge.position.set(0.82, 1.20, 0); edge.rotation.set(0, Math.PI / 4, Math.PI / 2);
    } else if (id === 'skull') {
      const skull = this._mesh(new THREE.DodecahedronGeometry(0.58, 1), body, parent); skull.scale.set(1, 1.12, 0.88);
      for (const sx of [-1, 1]) {
        const eye = this._mesh(new THREE.OctahedronGeometry(0.11, 0), core, parent); eye.position.set(sx * 0.18, 0.08, 0.48);
      }
      const jaw = this._mesh(new THREE.BoxGeometry(0.62, 0.22, 0.38), core, parent); jaw.position.y = -0.47;
    }
  }

  _buildArmory(stone, bronze, dark, characterId = this.selectedCharacter) {
    const ids = weaponIdsForCharacter(characterId);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i], weapon = WEAPONS[id], position = this._armoryPosition(i, ids.length);
      const station = new THREE.Group();
      station.name = `home.armory.${id}`;
      station.position.copy(position);
      this.root.add(station);

      const plinth = this._mesh(new THREE.CylinderGeometry(1.12, 1.35, 0.34, 12), stone, station); plinth.position.y = 0.17;
      const top = this._mesh(new THREE.CylinderGeometry(0.92, 1.06, 0.16, 12), dark, station); top.position.y = 0.42;
      const ringMat = this._m(new THREE.MeshStandardMaterial({
        color: weapon.palette.body, emissive: weapon.palette.glow, emissiveIntensity: 0.72,
        roughness: 0.28, metalness: 0.72, transparent: true, opacity: 0.72,
      }));
      const ring = this._mesh(new THREE.TorusGeometry(0.78, 0.055, 8, 36), ringMat, station);
      ring.rotation.x = Math.PI / 2; ring.position.y = 0.54;

      const hover = new THREE.Group();
      hover.name = `infernal-arm.${id}`;
      hover.position.y = 2.05;
      station.add(hover);
      const core = this._m(new THREE.MeshStandardMaterial({ color: weapon.palette.core, emissive: weapon.palette.core, emissiveIntensity: 0.52, roughness: 0.22, metalness: 0.92 }));
      const body = this._m(new THREE.MeshStandardMaterial({ color: weapon.palette.body, emissive: weapon.palette.glow, emissiveIntensity: 0.72, roughness: 0.35, metalness: 0.82 }));
      const grip = this._m(new THREE.MeshStandardMaterial({ color: '#17111f', emissive: weapon.palette.glow, emissiveIntensity: 0.16, roughness: 0.72, metalness: 0.35 }));
      this._buildWeaponModel(id, hover, core, body, grip);

      const light = new THREE.PointLight(weapon.palette.glow, 2.6, 6.5, 2);
      light.position.y = 2.15; station.add(light);
      this.armory.push({ id, position, station, hover, ring, light, phase: i * Math.PI * 0.5, selected: false });
    }
  }

  _clearArmory() {
    for (const arm of this.armory) arm.station.removeFromParent();
    this.armory.length = 0;
    this.selectedWeapon = null;
  }

  _selectCharacter(id) {
    if (!CHARACTER_INFO[id]) return false;
    if (id !== this.selectedCharacter) {
      if (this.onCharacter(id) === false) return false;
      this.selectedCharacter = id;
      this._clearArmory();
      const mats = this._armoryMats;
      this._buildArmory(mats.stone, mats.bronze, mats.dark, id);
      this._publishPrompts();
    }
    for (const station of this.characterStations) station.selected = station.id === id;
    return true;
  }

  _selectWeapon(id) {
    if (id === this.selectedWeapon) return true;
    if (!WEAPONS[id] || this.onWeapon(id) === false) return false;
    this.selectedWeapon = id;
    for (const arm of this.armory) arm.selected = arm.id === id;
    return true;
  }

  _resolveAltar(p, minRadius = ALTAR_SAFE_RADIUS) {
    let dx = p.x - ALTAR_POS.x, dz = p.z - ALTAR_POS.z;
    let distance = Math.hypot(dx, dz);
    if (distance >= minRadius) return distance;
    // Exact-centre recovery points toward the arena, never farther into the
    // perimeter. This also repairs saves/frames already trapped in the mesh.
    if (distance < 1e-5) { dx = -1; dz = 0; distance = 1; }
    const nx = dx / distance, nz = dz / distance;
    p.x = ALTAR_POS.x + nx * minRadius;
    p.z = ALTAR_POS.z + nz * minRadius;
    const v = this.ctx.player?.velocity;
    if (v) {
      const inward = v.x * nx + v.z * nz;
      if (inward < 0) { v.x -= nx * inward; v.z -= nz * inward; }
    }
    const knock = this.ctx.player?.knock;
    if (knock) {
      const inward = knock.x * nx + knock.z * nz;
      if (inward < 0) { knock.x -= nx * inward; knock.z -= nz * inward; }
    }
    return minRadius;
  }

  /** Put the hero on clear floor after the full-screen offering panel closes. */
  releaseAltar() {
    const hero = this.ctx.player;
    if (!hero?.position) return false;
    this._resolveAltar(hero.position, ALTAR_RELEASE_RADIUS);
    hero.velocity?.set?.(0, 0, 0);
    hero.knock?.set?.(0, 0, 0);
    if (hero.state !== 'dead') hero.state = 'move';
    hero._resolve?.(this.ctx);
    return true;
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
    if (this.mirrorSurface?.material?.uniforms) this.mirrorSurface.material.uniforms.uTime.value = this.t;
    if (this.mirrorLight) this.mirrorLight.intensity = 3.8 + Math.sin(this.t * 2.3) * 0.7;
    if (this.godLights) {
      for (const gem of this.godLights.children) {
        gem.rotation.y += dt * 0.8;
        gem.position.y = 0.18 + Math.sin(this.t * 2 + gem.userData.phase) * 0.06;
      }
    }
    for (const arm of this.armory) {
      arm.hover.position.y = 2.05 + Math.sin(this.t * 2.0 + arm.phase) * 0.16;
      arm.hover.rotation.y += dt * (arm.selected ? 1.05 : 0.42);
      const targetScale = arm.selected ? 1.14 : 1;
      const scale = THREE.MathUtils.lerp(arm.hover.scale.x, targetScale, Math.min(1, dt * 8));
      arm.hover.scale.setScalar(scale);
      arm.ring.rotation.z -= dt * (arm.selected ? 1.4 : 0.35);
      arm.ring.material.emissiveIntensity = arm.selected ? 3.1 : 0.72;
      arm.ring.material.opacity = arm.selected ? 1 : 0.72;
      arm.light.intensity = (arm.selected ? 6.2 : 2.6) + Math.sin(this.t * 3.2 + arm.phase) * 0.45;
    }
    for (const station of this.characterStations) {
      station.figure.position.y = 0.42 + Math.sin(this.t * 1.7 + station.phase) * 0.08;
      station.figure.rotation.y += dt * (station.selected ? 0.55 : 0.18);
      station.halo.rotation.z -= dt * (station.selected ? 1.1 : 0.3);
      station.halo.material.emissiveIntensity = station.selected ? 2.8 : 1.15;
      station.light.intensity = (station.selected ? 5.2 : 2.0) + Math.sin(this.t * 2.4 + station.phase) * 0.35;
    }

    const p = this.ctx.player?.position;
    if (!p) return;
    const ad = this._resolveAltar(p);
    const pd = Math.hypot(p.x - PORTAL_POS.x, p.z - PORTAL_POS.z);
    // The visible threshold is a 2.05m ring on a broad plinth. The old 1.18m
    // trigger sat behind the plinth approach, so a hero could visibly stand
    // in the portal without crossing. Match the interaction to its footprint.
    if (!this._portalTriggered && pd < 1.88) {
      this._portalTriggered = true;
      this.onPortal();
      return;
    }
    if (pd > 2.45) this._portalTriggered = false;
    if (this.ctx.input?.pressed?.('interact')) {
      const md = Math.hypot(p.x - MIRROR_POS.x, p.z - MIRROR_POS.z);
      if (md < 2.15) {
        this.onMirror();
        return;
      }
      let nearestCharacter = null, characterDistance = Infinity;
      for (const station of this.characterStations) {
        const d = Math.hypot(p.x - station.position.x, p.z - station.position.z);
        if (d < characterDistance) { nearestCharacter = station; characterDistance = d; }
      }
      let nearest = null, distance = Infinity;
      for (const arm of this.armory) {
        const d = Math.hypot(p.x - arm.position.x, p.z - arm.position.z);
        if (d < distance) { nearest = arm; distance = d; }
      }
      if (nearestCharacter && characterDistance < 1.75 && characterDistance <= distance) {
        this._selectCharacter(nearestCharacter.id);
        return;
      }
      if (nearest && distance < 2.05) {
        this._selectWeapon(nearest.id);
        return;
      }
    }
    if (ad < ALTAR_INTERACT_RADIUS && this.ctx.input?.pressed?.('interact')) this.onAltar();
  }

  dispose() {
    this.ctx.ui?.clearPrompts?.();
    this.root.removeFromParent();
    for (const geometry of this._geo) geometry.dispose?.();
    for (const material of this._ownedMats) material.dispose?.();
    this._geo.length = 0; this._ownedMats.length = 0;
  }
}

// All boss drops share these immutable meshes. Rebuilding a LatheGeometry and
// TorusGeometry at the moment a boss dies caused needless CPU/driver churn.
let _rewardGeometry = null;
function rewardGeometry() {
  if (_rewardGeometry) return _rewardGeometry;
  const profile = [new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.28, 0.04), new THREE.Vector2(0.34, 0.34), new THREE.Vector2(0.24, 0.68), new THREE.Vector2(0.14, 0.82), new THREE.Vector2(0.14, 1.02), new THREE.Vector2(0.0, 1.06)];
  _rewardGeometry = {
    body: new THREE.LatheGeometry(profile, 20),
    cap: new THREE.CylinderGeometry(0.20, 0.16, 0.18, 16),
    halo: new THREE.TorusGeometry(0.52, 0.045, 8, 32),
  };
  return _rewardGeometry;
}

/** A boss reward that visibly drops, then homes to the hero and is banked. */
export class NectarDrop {
  constructor(ctx, pos, amount = 2, onCollect = () => {}, style = {}) {
    this.ctx = ctx;
    this.amount = amount;
    this.onCollect = onCollect;
    this.style = {
      name: style.name || 'reward.nectar', label: style.label || 'NECTAR', key: style.key || '✦',
      color: style.color || '#b884ff', emissive: style.emissive || '#6b2ccf', glow: style.glow || '#d8b6ff',
      metal: style.metal || '#f2c14e', metalEmissive: style.metalEmissive || '#6d4416', kind: style.kind || 'shard',
    };
    this.t = 0;
    this.dead = false;
    this.root = new THREE.Group();
    this.root.name = this.style.name;
    this.root.position.copy(pos || new THREE.Vector3()).setY(0.45);
    this.geo = [];
    this.mats = [];
    const purple = new THREE.MeshStandardMaterial({ color: this.style.color, emissive: this.style.emissive, emissiveIntensity: 2.4, roughness: 0.2, transparent: true, opacity: 0.88 });
    const gold = new THREE.MeshStandardMaterial({ color: this.style.metal, emissive: this.style.metalEmissive, emissiveIntensity: 0.45, metalness: 0.8, roughness: 0.3 });
    this.mats.push(purple, gold);
    const shared = rewardGeometry();
    const bodyG = shared.body;
    const body = new THREE.Mesh(bodyG, purple); body.castShadow = true; this.root.add(body);
    const capG = shared.cap;
    const cap = new THREE.Mesh(capG, gold); cap.position.y = 1.08; this.root.add(cap);
    const haloG = shared.halo;
    const halo = new THREE.Mesh(haloG, gold); halo.rotation.x = Math.PI / 2; halo.position.y = 0.45; this.root.add(halo);
    this.halo = halo;
    // On Low the emissive mesh is sufficient; another per-object point light
    // would cost more than the reward's three tiny meshes.
    if (ctx.quality?.tier !== 'low') {
      const light = new THREE.PointLight(this.style.color, 8, 7, 2); light.position.y = 0.65; this.root.add(light);
    }
    ctx.scene?.add?.(this.root);
    ctx.ui?.prompt?.(this.root.position, `${this.style.label} ×${amount}`, { key: this.style.key, height: 2.1, dur: 4 });
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
        this.ctx.vfx?.burst?.(p.clone().setY(1.1), { count: 24, color: this.style.color, speed: 8, spread: 1.0, kind: this.style.kind });
        this.ctx.vfx?.shockwave?.(p.clone().setY(0.06), { radius: 2.4, color: this.style.glow, life: 0.55 });
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

/** Blood of the Titans: a rarer boss forge resource, banked independently. */
export class TitanBloodDrop extends NectarDrop {
  constructor(ctx, pos, amount = 1, onCollect = () => {}) {
    super(ctx, pos, amount, onCollect, {
      name: 'reward.titanBlood', label: 'TITAN BLOOD', key: '◆',
      color: '#ff4f5e', emissive: '#8f0718', glow: '#ff9a6b',
      metal: '#d9a64c', metalEmissive: '#5a230e', kind: 'sparkFine',
    });
  }
}

export const HOME_PORTAL_POS = PORTAL_POS;
export const HOME_ALTAR_POS = ALTAR_POS;
export const HOME_MIRROR_POS = MIRROR_POS;

export default HomeBase;
