// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// texgen.js — the THREE-facing face of the synthesis engine.
//
// All the actual synthesis lives in ./texgen-core.js, which imports NOTHING but
// palette.js. That split is load-bearing: the recipe bake runs inside a Worker
// (texworker.js) and a worker that had to parse the whole of three.js before it
// could paint a single stroke would give most of the parallel win straight back.
// This file adds only the four functions that need THREE — the DataTexture
// wrappers — and re-exports the core so `import * as TG from './texgen.js'`
// keeps working unchanged everywhere else.
//
// See texgen-core.js for the engine itself.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import * as CORE from './texgen-core.js';
import { heightToNormal, packRGB8, packORM8, packField8 } from './texgen-core.js';

export * from './texgen-core.js';

// ---------------------------------------------------------------------------
// Texture construction
// ---------------------------------------------------------------------------

function configure(tex, o = {}) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = o.anisotropy ?? 8;
  if (o.repeat) tex.repeat.set(o.repeat, o.repeat);
  tex.needsUpdate = true;
  return tex;
}

/** Raw RGBA8 bytes -> configured DataTexture. The worker path lands here. */
export function byteTexture(data, n, o = {}) {
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = o.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return configure(t, o);
}

/** Float RGB (0..255) -> sRGB DataTexture (albedo/emissive). */
export function rgbTexture(rgb, n, o = {}) {
  return byteTexture(packRGB8(rgb, n), n, { ...o, srgb: !o.linear });
}

/** Height -> normal DataTexture (linear). */
export function normalTexture(h, n, strength = 2, o = {}) {
  return byteTexture(heightToNormal(h, n, strength), n, { ...o, srgb: false });
}

/**
 * Pack occlusion / roughness / metalness into one RGB texture (glTF ORM
 * convention: three reads .r for aoMap, .g for roughnessMap, .b for
 * metalnessMap), so a full PBR set costs 3 textures instead of 5.
 */
export function ormTexture(ao, rough, metal, n, o = {}) {
  return byteTexture(packORM8(ao, rough, metal, n), n, { ...o, srgb: false });
}

/** Single-channel field -> greyscale texture (masks, detail, macro). */
export function fieldTexture(f, n, o = {}) {
  return byteTexture(packField8(f, n), n, o);
}

export default {
  ...CORE,
  byteTexture, rgbTexture, normalTexture, ormTexture, fieldTexture,
};
