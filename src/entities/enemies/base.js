// OWNER: AGENT-ENEMY
// ---------------------------------------------------------------------------
// base.js — the shared body of every enemy in the roster.
//
// WHAT THIS FILE OWNS
//   * The Enemy entity itself: the fields ARCHITECTURE.md's combat contract
//     reads (position/radius/health/dead/alive/iframes) plus the AI plumbing
//     from ai.js (perception, steering, brain, attack tokens, telegraph).
//   * A SHARED-GEOMETRY CLONE of rig.buildHumanoid(). Building a skinned
//     humanoid costs real milliseconds (parametric geometry + a skin-weight
//     solve over ~20k vertices), and a wave spawns six at once. So each FAMILY
//     builds ONE template rig, and every instance gets its own bone hierarchy
//     and skeleton bound to the template's geometry and materials. Spawning is
//     then a bone-tree allocation, not a mesh build.
//   * The hurt flash, the death (§5: flash -> directional shade-wisps ->
//     dissolve upward) and the strike primitives every family calls.
//
// THE VALUE LAW (§9.2) APPLIES TO ENEMIES TOO. An enemy is a LIT SUBJECT on a
// dark stage. Every palette below sits above the stone albedo, every family has
// one hot identity colour on its silhouette-defining part, and the eyes/sigils
// are the only emissive. A dark enemy on a dark floor is not "moody", it is a
// bug the player pays for.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, dampAngle, shortAngle, smoothstep, TAU } from '../../core/math.js';
import { buildHumanoid, SLOT_PAINT, linRGB } from '../rig.js';
import { Animator } from '../anim.js';
import { setPaint, paintParams } from '../../materials/painterly.js';
import { Perception, Steer, Brain, beginTelegraph, endTelegraph, inCone, inDisc, orbitSign } from '../ai.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _out = { x: 0, z: 0 };
const _white = new THREE.Color(1, 1, 1);

let _uid = 1;

// ═══════════════════════════════════════════════════════════════════════════
// SHARED-GEOMETRY RIG CLONE
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Duplicate a built humanoid: new bones, new skeleton, SAME geometry and SAME
 * materials. Returns an object that quacks exactly like a rig, so Animator,
 * ClothSolver and LegIK all work on it unmodified.
 */
export function cloneRig(t) {
  const bones = {}, list = [];
  for (let i = 0; i < t.boneList.length; i++) {
    const src = t.boneList[i];
    const b = new THREE.Bone();
    b.name = src.name;
    b.position.copy(t.bind[i].p);
    b.quaternion.copy(t.bind[i].q);
    bones[b.name] = b; list.push(b);
  }
  for (const [name, seg] of t.byName) {
    const p = seg.def && seg.def.parent;
    if (p && bones[p]) bones[p].add(bones[name]);
  }
  const mesh = new THREE.SkinnedMesh(t.mesh.geometry, t.mesh.material);
  mesh.name = t.spec.name + '.body';
  mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.name = t.spec.name;
  root.add(mesh);
  mesh.add(bones.root);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list, t.skeleton.boneInverses.map(m => m.clone()));
  mesh.bind(skeleton);
  skeleton.pose();

  // chains get their own objects; `axis` is read-only rest data and is shared.
  const chains = t.chains.map(c => ({
    ...c, list: c.bones.map(n => bones[n]), root: bones[c.bones[0]].parent,
  }));
  const bind = list.map(b => ({ p: b.position.clone(), q: b.quaternion.clone() }));

  return {
    spec: t.spec, height: t.height, root, mesh, skeleton, bones, boneList: list,
    byName: t.byName, chains, bind, materials: t.materials,
    socket(n) { const b = bones[n]; if (!b) return null; const o = new THREE.Object3D(); o.name = 'socket.' + n; b.add(o); return o; },
    setWeaponVisible() { }, retune() { }, dispose() { },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FAMILY RIM — §9.2 "the lit subjects out-value the stage"
// ═══════════════════════════════════════════════════════════════════════════
// Every character in the frame used to carry the SAME rim: rig.js's SLOT_PAINT
// publishes one constant #5fd0ff edge to hero and roster alike, and the library
// republishes the rig's constant over all of it. On a crimson Tartarus floor
// that reads as "some pink shapes on a pink floor" — you cannot name the family
// from the silhouette, which is the acceptance test the roster was written to.
//
// So each family now owns its rim: its IDENTITY hue, a stronger constant, and a
// slightly deeper colour-shifted inner contour (§4). The contour matters as
// much as the rim — it is the half of the separation that costs no light, and
// §9 will not have us buying legibility by brightening anything.
//
// HUE DISCIPLINE (§9.6, §1.2): a rim in the KEY's own hue is not a rim, it is
// camouflage. The families that would otherwise sit inside the Tartarus key are
// pushed off it — the warden especially, whose identity #ff5a3c IS the key, so
// the boss is rimmed COLD and is the one thing in the room edged in ice.
// PRE-COMPENSATION. painterly.js does NOT add uRimColor as authored — it adds
// `uRimColor * vec3(0.30, 1.22, 0.72)`, a deliberate channel weighting that
// makes the mandated #5fd0ff read as the measured pale edge. The side effect
// is that the rim's achievable gamut is heavily green-biased: feed it gold and
// the enemy comes back GREEN, not gold. So these are authored in that weighted
// space — what each one is worth on screen is the comment, not the hex.
//
// Strength is deliberately a SMALL lift over the slot base (~1.1x), not the
// 1.3-1.4x this pass first tried: the shader's `clamp(rimK * 5.0, 0, 1)` tint
// term saturates almost immediately, so past a point extra rim stops being a
// contour and starts flooding the whole body with the complement. Verified by
// looking: at 1.34x the roster read as green plastic.
const FAMILY_LOOK = {
  shade: { rim: '#5fd0ff', mul: 1.16 },   // -> teal. the basic shade
  brute: { rim: '#ffb84d', mul: 1.10 },   // -> warm yellow-green, the shield wall
  hexer: { rim: '#9a6bff', mul: 1.14 },   // -> blue-violet, the arcane caster
  herald: { rim: '#ffe14d', mul: 1.12 },  // -> hot yellow, the summoner
  hound: { rim: '#ff7a2a', mul: 1.16 },   // -> amber-olive, the swarmer
  bloat: { rim: '#8ef06a', mul: 1.16 },   // -> green, the detonator
  warden: { rim: '#3aa8ff', mul: 1.12 },  // -> ICE. the boss opposes its own room
};
const FAMILY_KINDS = Object.keys(FAMILY_LOOK);

/** 'wardenblade' -> 'warden', 'hexerwood' -> 'hexer'. */
function familyOf(tag) {
  if (!tag) return null;
  for (let i = 0; i < FAMILY_KINDS.length; i++) if (tag.indexOf(FAMILY_KINDS[i]) === 0) return FAMILY_KINDS[i];
  return null;
}

// Materials we own the rim on. MaterialLibrary.setBiome() -> setBiomeLook()
// rewrites uRimColor on EVERY registered painterly material without consulting
// userData.paintOverrides, so a family rim set once at build time is gone the
// first time the player changes chamber. We re-stamp on biome.changed.
const _familyMats = [];

/**
 * Stamp one material with its family's rim. Idempotent: the multiplied values
 * are computed once from the slot's authored base and cached, so re-applying
 * after a biome change can never compound.
 */
export function familyRim(mat, kind, slot) {
  const F = FAMILY_LOOK[kind];
  const U = mat && paintParams(mat);
  if (!F || !U) return mat;
  let tgt = mat.userData.familyRim;
  if (!tgt || tgt.kind !== kind) {
    const isGlow = slot === 'glow';
    tgt = mat.userData.familyRim = {
      kind, slot,
      rimColor: F.rim,
      rimStrength: (U.uRimStrength.value || 10) * (isGlow ? 1 : F.mul),
      contourStrength: isGlow ? U.uContourStrength.value
        : Math.min(1.30, (U.uContourStrength.value || 0.9) * 1.16),
    };
    _familyMats.push(mat);
  }
  setPaint(mat, { rimColor: tgt.rimColor, rimStrength: tgt.rimStrength, contourStrength: tgt.contourStrength });
  // declare them, so MaterialLibrary._applyRim leaves the family alone
  mat.userData.paintOverrides = {
    ...(mat.userData.paintOverrides || {}),
    rimColor: tgt.rimColor, rimStrength: tgt.rimStrength, contourStrength: tgt.contourStrength,
  };
  return mat;
}

/** Re-stamp every family rim (after a biome swap has trampled them). */
export function refreshFamilyRims() {
  for (let i = 0; i < _familyMats.length; i++) {
    const m = _familyMats[i], t = m.userData.familyRim;
    if (t) setPaint(m, { rimColor: t.rimColor, rimStrength: t.rimStrength, contourStrength: t.contourStrength });
  }
}

/**
 * A painterly CHARACTER material outside the rig builder — for the roster's
 * non-humanoid bodies (the hound, the bloat-sac, the boss's cage). Mirrors what
 * rig.js does per slot so a custom mesh is shaded by the same 2-3 step painted
 * ramp, ink shadow and art-directed rim as everything else on screen.
 */
export function charMaterial(ctx, slot, tag, opts = {}) {
  // MATERIAL SET BUDGET: every distinct key costs a full painterly texture
  // synthesis at boot (§9 of ARCHITECTURE puts that at seconds, not
  // milliseconds). The roster's colour identity lives in VERTEX COLOUR, not in
  // the texture set, so every family shares the hero's cloth/metal/hair
  // materials. Only `glow` is tagged, because the emissive hue IS the identity
  // (teal shade, amber hound, green bloat, gold herald) and that lives on the
  // material.
  // The tag is now part of the key for EVERY slot, not just `glow`. The
  // budget note above is about texture synthesis, and the character branch of
  // MaterialLibrary.get() bakes no textures at all — it patches a plain
  // MeshStandardMaterial — so a per-family material costs one uniform block
  // and no extra draw call (the bodies are already separate meshes). What it
  // buys is a per-family RIM, which §9.2 makes non-optional.
  const key = 'characterrig.' + slot + (tag ? '.' + tag : '');
  let m = ctx.mats && ctx.mats.get ? ctx.mats.get(key, {
    color: '#ffffff',
    roughness: opts.roughness ?? (slot === 'metal' ? 0.34 : 0.72),
    metalness: opts.metalness ?? (slot === 'metal' ? 0.92 : 0.04),
    ...(slot === 'glow' ? { glowKey: opts.glowKey || '#8ef0d0' } : {}),
  }) : null;
  if (!m) m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05 });
  if (m.map || m.normalMap || m.roughnessMap) { m.map = null; m.normalMap = null; m.roughnessMap = null; m.needsUpdate = true; }
  m.vertexColors = true;
  m.dithering = false;
  if (opts.doubleSide) { m.side = THREE.DoubleSide; m.shadowSide = THREE.DoubleSide; }
  const tune = SLOT_PAINT[slot];
  if (tune) {
    setPaint(m, tune);
    m.userData.paintOverrides = {
      ...(m.userData.paintOverrides || {}),
      rimStrength: tune.rimStrength, rimPower: tune.rimPower, rimColor: tune.rimColor, rimDir: tune.rimDir,
    };
  }
  if (slot === 'glow') {
    m.emissive.set(opts.glowKey || '#8ef0d0');
    m.emissiveIntensity = opts.glow ?? 0.9;
    m.toneMapped = true;
  }
  familyRim(m, familyOf(tag), slot);
  m.needsUpdate = true;
  return m;
}

/** paint a geometry with a flat linear vertex colour + a cheap vertical AO ramp. */
export function paintGeo(g, hex, o = {}) {
  const p = g.getAttribute('position');
  const n = p.count;
  const c = new Float32Array(n * 3);
  const [r, gg, b] = linRGB(hex);
  const aoLow = o.aoLow ?? 0.42, y0 = o.y0 ?? 0, y1 = o.y1 ?? 1.6;
  const top = o.top ? linRGB(o.top) : null;
  for (let i = 0; i < n; i++) {
    const y = p.getY(i);
    const t = clamp01((y - y0) / (y1 - y0 || 1));
    const ao = lerp(aoLow, 1, smoothstep(t));
    const rr = top ? lerp(r, top[0], t) : r;
    const gv = top ? lerp(gg, top[1], t) : gg;
    const bv = top ? lerp(b, top[2], t) : b;
    c[i * 3] = rr * ao; c[i * 3 + 1] = gv * ao; c[i * 3 + 2] = bv * ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

// ═══════════════════════════════════════════════════════════════════════════
// HUMANOID VISUAL — template cache + per-instance animator
// ═══════════════════════════════════════════════════════════════════════════
const _templates = new Map();
export function humanoidTemplate(ctx, kind, spec) {
  let t = _templates.get(kind);
  if (!t) {
    // matTag keys the slot materials per FAMILY inside MaterialLibrary, so the
    // shade and the brute stop sharing the hero's single cyan rim.
    const rig = buildHumanoid({ ...spec, matTag: kind }, ctx);
    const mats = rig.materials || (Array.isArray(rig.mesh.material) ? rig.mesh.material : [rig.mesh.material]);
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      const n = (m && m.name) || '';
      const slot = n.startsWith('characterrig.') ? n.split('.')[1] : 'cloth';
      familyRim(m, kind, slot);
    }
    t = { rig, clips: null };
    _templates.set(kind, t);
  }
  return t;
}
export function clearTemplates() { _templates.clear(); }

class HumanoidVisual {
  constructor(ctx, kind, spec) {
    const t = humanoidTemplate(ctx, kind, spec);
    this.rig = cloneRig(t.rig);
    this.root = this.rig.root;
    this.anim = new Animator(this.rig);
    if (t.clips) { this.anim.clips = t.clips; this.anim.cur = { clip: t.clips.idle, t: 0, speed: 1 }; }
    else t.clips = this.anim.clips;
    this.anim.ikWeight = 0.55;
    this.anim.play('idle', { fade: 0 });
    this.baseMat = this.rig.mesh.material;
    this.height = this.rig.height;
  }
  play(name, o) { this.anim.play(name, o); }
  freeze(name, t) { this.anim.freezeAt(name, t); }
  get clipName() { return this.anim.current; }
  duration(n) { return this.anim.duration(n); }
  update(dt, e) {
    const a = this.anim;
    a.mod.leanX = clamp(e._leanX, -1, 1);
    a.mod.leanZ = clamp(e._leanZ, -1, 1);
    a.mod.headYaw = e._headYaw;
    a.groundY = 0;
    a.update(dt);
  }
  setFlash(mat) { this.rig.mesh.material = mat || this.baseMat; }
  dispose() { }
}

// ═══════════════════════════════════════════════════════════════════════════
// ENEMY
// ═══════════════════════════════════════════════════════════════════════════
export class Enemy {
  constructor(def) {
    this.def = def;
    this.kind = def.kind;
    this.id = _uid++;
    // ── combat contract (never rename) ──
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.radius = def.radius ?? 0.52;
    this.health = def.hp ?? 40; this.maxHealth = this.health;
    this.alive = true; this.dead = false;
    this.iframes = 0;
    this.faction = 'enemy';
    // ── AI ──
    this.facing = { x: 0, z: 1 };
    this.perc = new Perception(def.perception || {});
    this.steer = new Steer(this);
    this.brain = null;
    this.tell = { active: false, kind: '', t: 0, dur: 1, k: 0, color: def.tellColor || '#ff5a3c', shape: 'arc', radius: 2.4, arc: 90, x: 0, z: 0, dirX: 0, dirZ: 1, follow: false };
    this.tellColor = def.tellColor || '#ff5a3c';
    this.committed = false;
    this.stagger = 0;
    this.orbitDir = 1;
    this.crowdPad = def.crowdPad ?? 0;
    this.stateName = 'idle';
    this.attackCd = 0;
    this.spawnGrace = 0;
    this.mem = {};                 // per-family scratch, reset on spawn
    // ── presentation ──
    this.visual = null;
    this.root = null;
    this._flashT = 0;
    this._leanX = 0; this._leanZ = 0; this._headYaw = 0;
    this._deathT = -1;
    this._tellHandle = null;
    this._knock = new THREE.Vector3();
    this._light = null;
  }

  // ─────────────────────────────────────────────────────────────── build ──
  init(ctx, mgr) {
    this.ctx = ctx; this.mgr = mgr;
    this.root = new THREE.Group();
    this.root.name = 'enemy.' + this.kind;
    this.visual = this.def.buildVisual
      ? this.def.buildVisual(ctx, this)
      : new HumanoidVisual(ctx, this.kind, this.def.spec);
    this.root.add(this.visual.root);
    this.height = this.visual.height ?? 1.9;
    this.root.visible = false;
    ctx.scene.add(this.root);
    this.flashMat = mgr.flashMat;
    if (this.def.brain) this.brain = new Brain(this.def.brain, this);
    return this;
  }

  // ─────────────────────────────────────────────────────────────── spawn ──
  spawn(x, z, depth = 0, opts = {}) {
    const d = this.def;
    const scale = 1 + 0.13 * depth;
    this.maxHealth = Math.round((d.hp ?? 40) * scale * (opts.hpMul ?? 1));
    this.health = this.maxHealth;
    this.damageMul = (1 + 0.075 * depth) * (opts.dmgMul ?? 1);
    this.depth = depth;
    this.alive = true; this.dead = false;
    this.iframes = 0; this.stagger = 0; this.committed = false;
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this._knock.set(0, 0, 0);
    this.attackCd = d.firstAttackDelay ?? 0.5;
    this.spawnGrace = d.spawnTime ?? 0.62;
    this.orbitDir = orbitSign(this.id + (opts.wave || 0));
    this.perc.reset();
    this.tell.active = false;
    this._flashT = 0; this._deathT = -1;
    this._leanX = 0; this._leanZ = 0; this._headYaw = 0;
    for (const k in this.mem) delete this.mem[k];
    this.stateName = 'spawn';
    if (this.brain) { this.brain.state = null; this.brain.set(this.def.brain.initial || 'idle', this.ctx); }
    this.root.visible = true;
    this.root.position.copy(this.position);
    this.root.scale.setScalar(0.001);
    this.root.rotation.y = Math.atan2(this.facing.x, this.facing.z);
    if (this.visual.reset) this.visual.reset(this);
    if (this.visual.setFlash) this.visual.setFlash(null);
    if (this.visual.play) this.visual.play('idle', { fade: 0 });
    if (d.onSpawn) d.onSpawn(this, this.ctx);
    return this;
  }

  despawn() {
    this.alive = false; this.dead = true;
    this.root.visible = false;
    this.mgr.telegraphs.cancelOwner(this);
    this.mgr.tokens.releaseAll(this);
    if (this._light) { this.ctx.lighting?.releaseLight?.(this._light); this._light = null; }
  }

  // ─────────────────────────────────────────────────────── animation API ──
  play(name, o) { if (this.visual.play) this.visual.play(name, o); }
  /** retime a looping locomotion clip without restarting it */
  setRunSpeed(s) {
    const a = this.visual.anim;
    if (a && a.cur && a.cur.clip && a.cur.clip.loop) a.cur.speed = s;
  }

  // ────────────────────────────────────────────────────────────── tokens ──
  wantToken(name, score) { return this.mgr.tokens.request(name || this.def.tokenPool || 'melee', this, score ?? -this.perc.dist); }
  hasToken(name) { return this.mgr.tokens.has(name || this.def.tokenPool || 'melee', this); }
  dropToken(name, mul) { this.mgr.tokens.release(name || this.def.tokenPool || 'melee', this, mul); }
  onTokenLost() { /* families may override via def.onTokenLost */ if (this.def.onTokenLost) this.def.onTokenLost(this); }

  // ─────────────────────────────────────────────────────────── telegraph ──
  /**
   * The single call a family makes to declare intent. Broadcasts on the bus
   * (§2.5 style event, so VFX/audio can layer on it) AND draws the ground
   * marker, because a tell that only exists as an event is not a tell.
   */
  telegraph(kind, dur, o = {}) {
    const ctx = this.ctx;
    beginTelegraph(this, ctx, kind, dur, { ...o, color: o.color || this.tellColor });
    this.mgr.telegraphs.cancelOwner(this);
    this._tellHandle = this.mgr.telegraphs.spawn({
      x: o.x ?? this.position.x, z: o.z ?? this.position.z,
      radius: o.radius ?? 2.4, shape: o.shape || 'arc', arc: o.arc ?? 92,
      dirX: o.dirX ?? this.facing.x, dirZ: o.dirZ ?? this.facing.z,
      color: o.color || this.tellColor, core: o.core, dur, owner: this,
      follow: o.follow ?? (o.shape !== 'disc' && o.shape !== 'ring'),
      inner: o.inner, alpha: o.alpha,
    });
    ctx.audio?.sfx?.('telegraph', { pos: this.position, pitch: o.pitch ?? 1 });
    return this._tellHandle;
  }
  endTell(fired = true) {
    endTelegraph(this, this.ctx, fired);
    if (!fired) this.mgr.telegraphs.cancelOwner(this);
    this._tellHandle = null;
  }

  // ────────────────────────────────────────────────────────────── strike ──
  /** A cone swing. Everything goes through ctx.combat.applyDamage (§2.6). */
  strikeCone(ctx, o = {}) {
    const p = ctx.player;
    const dirX = o.dirX ?? this.facing.x, dirZ = o.dirZ ?? this.facing.z;
    const range = o.range ?? 2.3, arc = o.arc ?? 100;
    const pos = _v.set(this.position.x + dirX * range * 0.55, 1.0, this.position.z + dirZ * range * 0.55);
    ctx.vfx?.slash?.(pos.clone(), _v2.set(dirX, 0, dirZ), {
      arc, radius: range, color: o.color || this.tellColor, width: o.width ?? 0.3, life: 0.26,
    });
    ctx.events.emit('camera.shake', { amp: o.shake ?? 0.03, dur: 0.12, freq: 30 });
    if (p && p.alive !== false && inCone(this, p, range, arc, dirX, dirZ)) {
      this._hitPlayer(ctx, o.damage ?? 10, o.type || 'physical', dirX, dirZ, o.knock ?? 5);
      return true;
    }
    return false;
  }
  /** A ground disc — the caster's AOE and the bomber's detonation. */
  strikeDisc(ctx, x, z, radius, o = {}) {
    const p = ctx.player;
    ctx.vfx?.shockwave?.(_v.set(x, 0.02, z), { radius, color: o.color || this.tellColor, life: o.life ?? 0.42 });
    ctx.vfx?.burst?.(_v2.set(x, 0.5, z), { count: 16, color: o.color || this.tellColor, speed: 7, spread: 1.1, kind: o.kind || 'spark' });
    ctx.events.emit('camera.shake', { amp: o.shake ?? 0.09, dur: 0.24, freq: 26 });
    if (p && p.alive !== false && inDisc(x, z, p, radius)) {
      const dx = p.position.x - x, dz = p.position.z - z;
      const d = Math.hypot(dx, dz) || 1;
      this._hitPlayer(ctx, o.damage ?? 14, o.type || 'fire', dx / d, dz / d, o.knock ?? 6);
      return true;
    }
    return false;
  }
  _hitPlayer(ctx, amount, type, dirX, dirZ, knock) {
    ctx.combat?.applyDamage?.({
      target: ctx.player, amount: Math.round(amount * (this.damageMul || 1)), type, crit: false,
      dir: new THREE.Vector3(dirX, 0, dirZ), pos: ctx.player.position.clone(),
      source: this, knockback: knock,
    });
    ctx.vfx?.impact?.(ctx.player.position.clone().setY(1.0), _v.set(-dirX, 0, -dirZ), { type, scale: 0.9 });
  }

  // ──────────────────────────────────────────────────────────── movement ──
  /** Integrate the steering result with acceleration, collision and facing. */
  move(dt, ctx, out, o = {}) {
    const accel = o.accel ?? this.def.accel ?? 26;
    const vx = damp(this.velocity.x, out.x, accel * 0.34, dt);
    const vz = damp(this.velocity.z, out.z, accel * 0.34, dt);
    this.velocity.x = vx; this.velocity.z = vz;
    this.position.x += (vx + this._knock.x) * dt;
    this.position.z += (vz + this._knock.z) * dt;
    this._knock.x = damp(this._knock.x, 0, 9.5, dt);
    this._knock.z = damp(this._knock.z, 0, 9.5, dt);
    ctx.world?.collide?.(this.position, this.radius);
    this.speedNow = Math.hypot(vx, vz);
    if (o.face !== false) {
      const fx = o.faceX ?? (this.speedNow > 0.35 ? vx : null);
      const fz = o.faceZ ?? (this.speedNow > 0.35 ? vz : null);
      if (fx != null && fz != null) this.faceTowards(fx, fz, dt, o.turn ?? this.def.turn ?? 11);
    }
    this._leanX = damp(this._leanX, clamp((vx * this.facing.x + vz * this.facing.z) / 8, -1, 1), 8, dt);
    this._leanZ = damp(this._leanZ, clamp((vx * -this.facing.z + vz * this.facing.x) / 8, -1, 1), 8, dt);
  }
  faceTowards(x, z, dt, lambda = 11) {
    const d = Math.hypot(x, z); if (d < 1e-4) return;
    const cur = Math.atan2(this.facing.x, this.facing.z);
    const want = Math.atan2(x / d, z / d);
    const a = dampAngle(cur, want, lambda, dt);
    this.facing.x = Math.sin(a); this.facing.z = Math.cos(a);
  }
  snapFace(x, z) { const d = Math.hypot(x, z) || 1; this.facing.x = x / d; this.facing.z = z / d; }

  // ────────────────────────────────────────────────────────────── damage ──
  onDamaged(info) {
    const ctx = this.ctx;
    this._flashT = this.def.flashTime ?? 0.11;
    this._flashed = true;
    if (this.visual.setFlash) this.visual.setFlash(this.flashMat);
    ctx.ui?.damageNumber?.(_v.copy(this.position).setY(this.height * 0.85), info.amount, { crit: info.crit, type: info.type });
    const poise = this.def.poise ?? 0;
    if (!this.committed || info.amount > poise) {
      this.stagger = Math.max(this.stagger, this.def.staggerTime ?? 0.22);
    }
    const kb = (info.knockback ?? 0) * (this.def.knockResist != null ? (1 - this.def.knockResist) : 1);
    if (kb > 0 && info.dir) { this._knock.x += info.dir.x * kb; this._knock.z += info.dir.z * kb; }
    if (this.def.onDamaged) this.def.onDamaged(this, info, ctx);
  }

  /** §5 death: bright flash, directional burst of shade-wisps, dissolve upward. */
  onDied(info) {
    const ctx = this.ctx;
    this.alive = false; this.dead = true; this.committed = false;
    this.mgr.tokens.releaseAll(this);
    this.mgr.telegraphs.cancelOwner(this);
    this._deathT = 0;
    if (this.visual.setFlash) this.visual.setFlash(this.flashMat);
    if (this.visual.play) this.visual.play('death', { fade: 0.05, restart: true });
    const dir = info && info.dir ? info.dir : null;
    ctx.vfx?.death?.(_v.copy(this.position).setY(this.height * 0.5), {
      color: this.def.deathColor || this.def.identity || '#8ef0d0',
      scale: this.def.deathScale ?? 1, dir,
    });
    ctx.events.emit('camera.shake', { amp: this.def.deathShake ?? 0.05, dur: 0.2, freq: 27 });
    ctx.audio?.sfx?.('enemyDeath', { pos: this.position });
    if (this.def.onDied) this.def.onDied(this, info, ctx);
  }

  // ──────────────────────────────────────────────────────────── per-step ──
  update(dt, ctx) {
    if (this._deathT >= 0) return this._updateDeath(dt, ctx);
    if (!this.alive) return;

    if (this.iframes > 0) this.iframes -= dt;
    if (this.stagger > 0) this.stagger -= dt;
    if (this.attackCd > 0) this.attackCd -= dt;
    if (this._flashT > 0) {
      this._flashT -= dt;
      if (this._flashT <= 0 && this.visual.setFlash) this.visual.setFlash(null);
    } else if (this._flashed && this.visual.setFlash) { this._flashed = false; this.visual.setFlash(null); }

    // materialise: brief invulnerability + a scale-in so nothing ever appears
    // fully formed on top of the player (spawner.js guarantees the position;
    // this guarantees the moment).
    if (this.spawnGrace > 0) {
      this.spawnGrace -= dt;
      this.iframes = Math.max(this.iframes, 0.02);
      const k = clamp01(1 - this.spawnGrace / (this.def.spawnTime ?? 0.62));
      const s = k * k * (3 - 2 * k);
      this.root.scale.set(0.55 + 0.45 * s, 0.4 + 0.6 * s, 0.55 + 0.45 * s);
    } else if (this.root.scale.x !== 1) this.root.scale.setScalar(1);

    if (this.tell.active) {
      this.tell.t += dt;
      this.tell.k = clamp01(this.tell.t / this.tell.dur);
    }

    this.perc.update(dt, this, ctx.player, ctx);
    if (this.brain) this.brain.update(dt, ctx);
    if (this.def.tick) this.def.tick(this, dt, ctx);

    this.root.position.copy(this.position);
    this.root.position.y = ctx.world?.heightAt?.(this.position.x, this.position.z) ?? 0;
    this.root.rotation.y = Math.atan2(this.facing.x, this.facing.z);
    // animation runs on the FIXED step so capture frames reproduce exactly
    if (this.visual.update) this.visual.update(dt, this);
  }

  _updateDeath(dt, ctx) {
    this._deathT += dt;
    const T = this.def.deathTime ?? 0.85;
    const k = clamp01(this._deathT / T);
    // dissolve UPWARD (§5) — the body drifts up and shrinks into the wisps
    this.root.position.y = (ctx.world?.heightAt?.(this.position.x, this.position.z) ?? 0) + k * k * 1.15;
    const s = 1 - k * k * 0.85;
    this.root.scale.set(s * (1 + k * 0.22), s, s * (1 + k * 0.22));
    // THE DISSOLVE (§5). A solid white body rising is a paper cutout; what the
    // bible asks for is the figure coming APART into light. So the body swaps
    // to a per-instance additive shell whose opacity falls as it climbs — the
    // silhouette stays readable for two frames of flash and then becomes the
    // wisps it is shedding.
    if (this.visual.setFlash) {
      if (!this._dissolveMat) {
        this._dissolveMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(this.def.deathColor || '#8ef0d0'),
          transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false, fog: false,
        });
      }
      if (k < 0.16) this.visual.setFlash(this.flashMat);
      else {
        const m = this._dissolveMat;
        m.opacity = 0.95 * (1 - k) * (1 - k);
        m.color.setStyle(this.def.deathColor || '#8ef0d0').lerp(_white, Math.max(0, 0.55 - k));
        this.visual.setFlash(m);
      }
    }
    if (this.visual.update) this.visual.update(dt * 0.35, this);
    if (k >= 1) { this._deathT = -1; this.despawn(); }
  }

  lateUpdate(alpha, ctx) { if (this.visual.lateUpdate) this.visual.lateUpdate(alpha, this, ctx); }
}

export default { Enemy, cloneRig, charMaterial, paintGeo, humanoidTemplate, HumanoidVisual };
