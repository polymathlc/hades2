// Headless rig audit: every roster body plan, both heirs and the hand-mounted
// arms are built against a stub context (no MaterialLibrary, no renderer) and
// checked for mesh / material counts, finite vertices, the character shader
// (render/shaders/character.js) on every material, and a hurt-flash twin that
// shares its source's program cache key (no extra shader program).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildHumanoid, HERO_SPEC, MELINOE_SPEC, ringSweep, DIAMOND, PLATE } from '../src/entities/rig.js';
import { createAvatarWeapons, createArmDisplay } from '../src/entities/player-weapons.js';
import { ROSTER, ROSTER_IDS } from '../src/entities/enemies/index.js';
import { humanoidTemplate, clearTemplates } from '../src/entities/enemies/base.js';
import * as PR from '../src/entities/enemies/props.js';
import { characterParams, flashVariant, flashVariants, setCharacterBiome, CHARACTER_RIM } from '../src/render/shaders/character.js';

// ---- a context stub: no material library, so every slot falls back to a
// plain MeshStandardMaterial and the character shader patches that directly.
const events = { _h: {}, on(n, f) { (this._h[n] ||= []).push(f); return () => {}; }, emit(n, p) { for (const f of this._h[n] || []) f(p); } };
let seed = 1234;
const rng = { f() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }, range(a, b) { return a + (b - a) * this.f(); }, int(a, b) { return a + Math.floor(this.f() * (b - a + 1)); }, pick(a) { return a[Math.floor(this.f() * a.length)]; }, sign() { return this.f() < 0.5 ? -1 : 1; }, fork() { return this; } };
const ctx = { mats: null, scene: new THREE.Scene(), events, rng, time: { t: 0, dt: 1 / 60, fixedDt: 1 / 60 }, quality: { tier: 'low' }, vfx: null, audio: null };

const finite = (geo, label) => {
  const p = geo.getAttribute('position');
  assert.ok(p && p.count > 0, `${label}: empty geometry`);
  const a = p.array;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) assert.fail(`${label}: NaN/Inf vertex at ${i}`);
  const n = geo.getAttribute('normal');
  if (n) for (let i = 0; i < n.array.length; i++) if (!Number.isFinite(n.array[i])) assert.fail(`${label}: NaN normal at ${i}`);
  const sw = geo.getAttribute('skinWeight');
  if (sw) for (let i = 0; i < sw.array.length; i++) if (!Number.isFinite(sw.array[i])) assert.fail(`${label}: NaN skin weight at ${i}`);
};

const stats = (root, label) => {
  let meshes = 0, tris = 0;
  const mats = new Set();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    finite(o.geometry, `${label}/${o.name || 'mesh'}`);
    const idx = o.geometry.index;
    tris += (idx ? idx.count : o.geometry.getAttribute('position').count) / 3;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
  });
  return { meshes, tris: Math.round(tris), mats: [...mats] };
};

const shaderLib = THREE.ShaderLib.standard;
const checkMaterial = (m, label) => {
  const U = characterParams(m);
  assert.ok(U, `${label}: material "${m.name}" is not patched by the character shader`);
  assert.ok(U.uChrRimColor.value.isColor && U.uChrRimDir.value.isVector3, `${label}: uniform bag malformed`);
  // the compile-time patch: three's real standard shader through onBeforeCompile
  const sh = { vertexShader: shaderLib.vertexShader, fragmentShader: shaderLib.fragmentShader, uniforms: {} };
  m.onBeforeCompile(sh, null);
  assert.ok(sh.fragmentShader.includes('uChrRimColor') && sh.fragmentShader.includes('chrRimK'), `${label}: rim code missing from the fragment shader`);
  assert.ok(sh.vertexShader.includes('vChrWPos'), `${label}: world-position varying missing from the vertex shader`);
  assert.equal(sh.fragmentShader.split('#include <opaque_fragment>').length, 2, `${label}: opaque_fragment must remain exactly once`);
  assert.ok(sh.uniforms.uChrFlash && sh.uniforms.uChrKeyRef, `${label}: uniforms not bound`);
  // the flash twin shares the program and every non-flash uniform object
  const t = flashVariant(m);
  assert.notEqual(t, m);
  assert.equal(t.customProgramCacheKey(), m.customProgramCacheKey(), `${label}: flash twin must not compile a new program`);
  assert.equal(characterParams(t).uChrFlash.value, 1);
  assert.equal(characterParams(t).uChrRimColor, U.uChrRimColor, `${label}: twin must share the rim uniform`);
  assert.equal(flashVariant(m), t, 'twin is cached');
};

let total = 0;
const report = [];

// ---- the heirs --------------------------------------------------------------
for (const [name, spec] of [['zagreus', HERO_SPEC], ['melinoe', MELINOE_SPEC]]) {
  const rig = buildHumanoid(spec, ctx);
  const s = stats(rig.root, name);
  assert.ok(rig.mesh.isSkinnedMesh, `${name}: body must be skinned`);
  assert.ok(rig.materials.length >= 4 && rig.materials.length <= 5, `${name}: expected 4-5 slot materials, got ${rig.materials.length}`);
  assert.ok(s.tris > 20000, `${name}: suspiciously few triangles (${s.tris})`);
  for (const m of rig.materials) checkMaterial(m, name);
  assert.ok(rig.bones.head && rig.bones.handR && rig.bones.handL, `${name}: skeleton incomplete`);
  // the arms: one mesh per slot, every one patched
  const weapons = createAvatarWeapons(rig, 'blade');
  for (const [id, g] of Object.entries(weapons.groups)) {
    const ws = stats(g, `${name}/${id}`);
    assert.ok(ws.meshes >= 2 && ws.meshes <= 5, `${id}: expected 2-5 slot meshes, got ${ws.meshes}`);
    for (const m of ws.mats) checkMaterial(m, `${name}/${id}`);
  }
  weapons.dispose();
  report.push(`${name.padEnd(12)} meshes ${String(s.meshes).padStart(2)}  mats ${rig.materials.length}  tris ${s.tris}`);
  total++;
  rig.dispose();
}

// ---- the roster -------------------------------------------------------------
clearTemplates();
for (const kind of ROSTER_IDS) {
  const def = ROSTER[kind];
  let root, mats;
  if (def.buildVisual) {
    const e = { kind, def, position: new THREE.Vector3(), facing: { x: 0, z: 1 }, mem: {} };
    const v = def.buildVisual(ctx, e);
    assert.ok(v && v.root, `${kind}: buildVisual returned no root`);
    assert.ok(typeof v.setFlash === 'function', `${kind}: visual has no setFlash`);
    root = v.root;
    const s = stats(root, kind);
    mats = s.mats;
    // the flash swaps every part to its twin and back
    v.setFlash({ userData: { rimFlash: true } });
    root.traverse((o) => { if (o.isMesh) assert.equal(characterParams(o.material).uChrFlash.value, 1, `${kind}: part did not flash`); });
    v.setFlash(null);
    root.traverse((o) => { if (o.isMesh) assert.equal(characterParams(o.material).uChrFlash.value, 0, `${kind}: part stuck flashing`); });
    report.push(`${kind.padEnd(12)} meshes ${String(s.meshes).padStart(2)}  mats ${mats.length}  tris ${s.tris}  (parts)`);
  } else {
    assert.ok(def.spec, `${kind}: no spec and no buildVisual`);
    const t = humanoidTemplate(ctx, kind, def.spec);
    root = t.rig.root;
    const s = stats(root, kind);
    mats = t.rig.materials;
    assert.ok(t.rig.mesh.isSkinnedMesh, `${kind}: body must be skinned`);
    assert.ok(mats.length >= 3, `${kind}: expected >= 3 slot materials`);
    const twins = flashVariants(t.rig.mesh.material);
    assert.equal(twins.length, t.rig.mesh.material.length);
    assert.equal(flashVariants(t.rig.mesh.material), twins, 'array twins are cached');
    report.push(`${kind.padEnd(12)} meshes ${String(s.meshes).padStart(2)}  mats ${mats.length}  tris ${s.tris}`);
  }
  for (const m of mats) checkMaterial(m, kind);
  total++;
}

// ---- the armory display uses the same bake as the hand ---------------------
for (const id of ['blade', 'spear', 'shield', 'staff']) {
  const d = createArmDisplay(id);
  assert.ok(d && d.group, `${id}: no display`);
  const s = stats(d.group, `display/${id}`);
  assert.ok(s.meshes >= 2, `${id}: display has no slot meshes`);
  for (const m of s.mats) checkMaterial(m, `display/${id}`);
  d.dispose();
}

// ---- the shared sweeps ------------------------------------------------------
finite(ringSweep({ y: 0, R: 0.1, th: 0.01, hh: 0.02, seg: 16 }), 'ringSweep');
finite(PR.ring({ y: 0.2, R: 0.3, a0: 0, a1: 180 }), 'props.ring');
assert.equal(PR.DIAMOND, DIAMOND, 'one DIAMOND section');
assert.equal(PR.PLATE, PLATE, 'one PLATE section');
assert.ok(Math.abs(DIAMOND(0) - 1) < 1e-9 && Math.abs(PLATE(Math.PI / 2) - 1) < 1e-9, 'sections are unit on the axes');

// ---- biome complement -------------------------------------------------------
const probe = buildHumanoid(HERO_SPEC, ctx);
const U = characterParams(probe.materials[0]);
setCharacterBiome('elysium');
const ely = new THREE.Color().setStyle(CHARACTER_RIM.elysium);
assert.ok(U.uChrRimColor.value.distanceTo ? true : true);
assert.ok(Math.abs(U.uChrRimColor.value.r - ely.r) < 1e-6 && Math.abs(U.uChrRimColor.value.b - ely.b) < 1e-6, 'rim follows the biome');
setCharacterBiome('tartarus');
probe.dispose();

console.log(report.join('\n'));
console.log(`rig audit ok: ${total} bodies built headless, every material carries the character shader, flash twins share programs`);
