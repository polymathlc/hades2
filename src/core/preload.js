// OWNER: ORCHESTRATOR (boot & contracts)
// ---------------------------------------------------------------------------
// preload.js — load EVERYTHING at launch so nothing is loaded during play.
//
// THE PROBLEM THIS SOLVES, precisely.
//
//  1. TEXTURES. materials/library.js baked only the surfaces the FIRST chamber
//     asks for (BIOME_SETS[tartarus] + SHARED_SETS = 32 of the 46 recipes).
//     The other 14 — the whole Asphodel set, floor.elysium, the player's own
//     characterrig.skin/cloth/hair, armour.bronze, shield.brute — took
//     MaterialLibrary.set()'s synchronous main-thread bake on first use, which
//     the library itself logs as '[mats] sync bake (blocked main thread)' and
//     costs a few hundred ms of frozen game EACH. Worse, setBiome() fires
//     prebuild() WITHOUT awaiting it, so the world rebuild that follows races
//     the pool and loses. That race IS the between-rounds lag.
//     Fix: await mats.prebuild(every recipe) at boot, BEFORE the world builds.
//     prebuild() skips already-cached sets, so setBiome()'s un-awaited call
//     later becomes a no-op and the race cannot be lost.
//
//  2. GPU UPLOAD. A baked texture still stalls on its first bind while the
//     driver uploads it. renderer.initTexture() forces that upload up front.
//
//  3. SHADER PROGRAMS. Nothing in this codebase ever called renderer.compile().
//     Every material therefore compiled its program inside the first frame it
//     was rendered — which for a boss death is the frame a boss explodes.
//     Fix: build one of every enemy in the roster (so their materials exist),
//     then renderer.compileAsync(scene, camera) for the lit programs, then ONE
//     off-screen render with every pooled/hidden object temporarily visible so
//     three also builds the SHADOW-CASTER depth permutation and uploads every
//     vertex buffer. A program compiled for a static mesh does not cover the
//     skinned variant and one compiled without shadows does not cover the depth
//     variant, so both passes are needed. We warm the REAL materials — the ones
//     already in the scene graph — never lookalikes, so the program count the
//     scene uses does not move.
//
//  4. AUDIO. audio/** synthesises its impulse responses and Karplus-Strong
//     string banks on first use. audio.preload() renders every biome's IR and
//     primes every bank now instead of during a boss roar.
//
// Everything here is behind core/loading.js, which reports honest progress.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { RECIPES } from '../materials/recipes.js';
import { ROSTER, ROSTER_IDS } from '../entities/enemies/index.js';
import { humanoidTemplate } from '../entities/enemies/base.js';

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : 0);

/**
 * Is this a SOFTWARE rasteriser (SwiftShader, llvmpipe, Mesa softpipe)?
 *
 * This matters enormously and is not a detail. On a real GPU the driver
 * compiles one of this game's painterly programs in single-digit milliseconds,
 * so warming all ~75 of them at boot costs well under a second and is free
 * money. Under SwiftShader the "driver" is an LLVM JIT and ONE program costs
 * 10-25 SECONDS — measured: the first gameplay frame of the unmodified build
 * takes 20.9 s and the first combat frame 201 s, and that is nothing but
 * compilation. Warming the full roster there would push boot past the capture
 * harness's readiness budget (tools/shots.mjs waits 90 s for __EREBUS_READY)
 * and turn a working screenshot pipeline into a timeout.
 *
 * It is reported in the boot stats rather than used to switch behaviour: the
 * measured cost of the full warm-up even on SwiftShader (+36 s of boot) is
 * affordable, and the honest reading of every number in this file depends on
 * knowing whether a GPU was involved. `?warm=scene` is the manual escape hatch.
 */
export function isSoftwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
    return /swiftshader|llvmpipe|softpipe|software|microsoft basic/i.test(name);
  } catch (e) { return false; }
}

/** Recipe names sorted longest-job-first, so the worker pool stays saturated. */
export function allRecipeNames(mats) {
  const names = Object.keys(RECIPES);
  const size = (n) => (RECIPES[n] && RECIPES[n].size) || 0;
  return names.slice().sort((a, b) => size(b) - size(a));
}

/**
 * PHASE 1 — bake every recipe on the worker pool.
 *
 * Called from main.js the moment MaterialLibrary.init() returns and BEFORE any
 * other system initialises, so the world, the player rig and the enemies all
 * find a warm cache and nobody takes the sync path.
 *
 * The list is dispatched in one go (the pool orders by size, longest first, and
 * every job is queued before the first one finishes) but awaited in slices, so
 * the loading bar moves instead of sitting at 0% for the whole bake.
 * Resolution is whatever the quality tier already chose — a low-tier machine
 * bakes the same 46 SURFACES at ITS OWN sizes, never at ultra's.
 */
export async function preloadSurfaces(ctx, report) {
  const mats = ctx.mats;
  if (!mats || !mats.prebuild) return { baked: 0, ms: 0 };
  const t0 = nowMs();
  const names = allRecipeNames(mats);
  const before = mats.setCache.size;

  // No worker pool (no Worker constructor, a file:// page, a strict CSP): the
  // library would bake each of these synchronously on FIRST USE anyway, so bake
  // them here instead — same total work, but it happens behind the loading
  // screen with a progress bar rather than inside a frame of play. We yield to
  // the browser between recipes so the bar actually advances.
  if (!mats._pool || !mats._pool.available) {
    for (let i = 0; i < names.length; i++) {
      try { mats.set(names[i]); } catch (e) { /* fallbackMaps covers it */ }
      report && report((i + 1) / names.length, `${i + 1} of ${names.length} surfaces (no worker pool)`);
      await new Promise((r) => setTimeout(r, 0));
    }
    return { baked: mats.setCache.size - before, total: mats.setCache.size, ms: nowMs() - t0, workers: 0 };
  }

  // slice into chunks so progress is real; every chunk is dispatched
  // synchronously, so the pool sees the whole longest-first queue at once.
  const CHUNKS = 8;
  const per = Math.ceil(names.length / CHUNKS);
  const slices = [];
  for (let i = 0; i < names.length; i += per) slices.push(names.slice(i, i + per));
  const jobs = slices.map((s) => mats.prebuild(s));
  for (let i = 0; i < jobs.length; i++) {
    await jobs[i];
    report && report((i + 1) / jobs.length, `${mats.setCache.size} of ${names.length} surfaces`);
  }
  return {
    baked: mats.setCache.size - before, total: mats.setCache.size,
    ms: nowMs() - t0, workers: mats._pool.size,
  };
}

/** Every THREE.Texture reachable from a material, by property name. */
const TEX_SLOTS = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'envMap', 'specularMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap',
  'transmissionMap', 'thicknessMap', 'iridescenceMap', 'gradientMap', 'matcap',
];

function collectTextures(ctx) {
  const out = new Set();
  const add = (t) => { if (t && t.isTexture && !t.isRenderTargetTexture) out.add(t); };
  const mats = ctx.mats;
  if (mats) {
    for (const set of mats.setCache.values()) {
      add(set.map); add(set.proceduralMap); add(set.normalMap); add(set.ormMap); add(set.emissiveMap);
    }
    if (mats.generatedMaps) for (const t of mats.generatedMaps.values()) add(t);
    add(mats.detailTexture); add(mats.macroTexture);
  }
  const eat = (m) => {
    if (!m) return;
    for (const k of TEX_SLOTS) add(m[k]);
    if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; add(v); }
  };
  ctx.scene && ctx.scene.traverse((o) => {
    const m = o.material;
    if (Array.isArray(m)) m.forEach(eat); else eat(m);
  });
  return out;
}

// ---------------------------------------------------------------------------
// A NEGATIVE RESULT WORTH KEEPING (do not re-attempt without new evidence)
//
// Crossing into Asphodel for the first time compiles ~31 shader programs inside
// one frame; Elysium another ~31. That is the last real "between rounds" cost,
// and the obvious fix is to build those biomes' materials at boot.
//
// It was implemented and MEASURED, and it does not work. The approach was to
// wrap mats.get() during the Tartarus world build, record every (name, options)
// pair the chamber asked for, then replay each one under the other biomes' name
// for that role (world/biomes.js's `mats` table is the same role -> name map
// chamber.js reads) and hang the results on proxies borrowing the real meshes'
// geometry. It built 171 materials and compiled exactly ONE extra program: the
// programs a crossing actually compiles are not reachable that way, because
// they come from materials whose MAP SIGNATURE differs (an emissive map here, a
// missing one there) in combinations the Tartarus call sites never produce.
//
// Getting them would mean building the other biomes' chambers for real at boot,
// and that cannot be done here: world/chamber.js draws its geometry from
// `rngRoot.fork('chamber:' + biome + ':' + seed)`, and RNG.fork() returns a
// CACHED child, so building a chamber twice advances that stream and the room
// the player actually starts in stops being the room the seed says it is —
// along with every capture frame. The fix belongs in world/**: either build the
// three biomes' material sets from one shared descriptor at boot, or give
// build() a reseed so a throwaway build costs nothing. Reported, not bodged.
// ---------------------------------------------------------------------------

/**
 * PHASE 2 — force the GPU upload of every preloaded texture.
 * Without this the bake is merely in RAM and the first bind still stalls.
 */
export function uploadTextures(ctx) {
  const r = ctx.renderer;
  if (!r || !r.initTexture) return { uploaded: 0 };
  let n = 0;
  for (const t of collectTextures(ctx)) {
    try { r.initTexture(t); n++; } catch (e) { /* a texture type three cannot pre-init */ }
  }
  return { uploaded: n };
}

/**
 * PHASE 3 — build the visual TEMPLATE for every enemy in the roster.
 *
 * entities/enemies/base.js caches one built rig per family in
 * `humanoidTemplate(ctx, kind, spec)` and every later instance is a cloneRig()
 * of it. Building those templates now means the first spawn of a family costs a
 * clone instead of a full skinned-mesh build, and — the point of this pass —
 * its materials exist, so PHASE 4 can compile their programs.
 *
 * WHY NOT `EnemyManager.acquire()`. That was the first implementation and it
 * was wrong. acquire() constructs real Enemy instances, and Enemy's constructor
 * takes the next value of base.js's module-level `_uid`, which spawn() feeds to
 * `orbitSign(this.id + wave)`. Pre-building fifteen enemies therefore shifted
 * every later enemy's orbit direction, and the capture harness's 07_combat
 * frame came back with a different fight in it — proof, from the shot sheet,
 * that a "loading only" change had reached gameplay. Templates touch neither
 * the id counter nor the pools.
 *
 * hound and bloat build their own visuals (def.buildVisual) rather than from a
 * humanoid spec; their surfaces are in the library's SHARED_SETS already and
 * they are left to build at spawn.
 */
export function preloadRoster(ctx, report) {
  const scene = ctx.scene;
  if (!scene) return { built: 0 };
  const ids = ROSTER_IDS || [];
  const rigs = [];
  for (let i = 0; i < ids.length; i++) {
    const def = ROSTER[ids[i]];
    try {
      if (def && def.spec) {
        const t = humanoidTemplate(ctx, ids[i], def.spec);
        if (t && t.rig && t.rig.root) rigs.push({ kind: ids[i], rig: t.rig });
      }
    } catch (e) { console.warn('[preload] roster', ids[i], e && e.message); }
    report && report((i + 1) / ids.length, ids[i]);
  }
  // Park them in the graph, invisible, only for the duration of the warm-up.
  for (const r of rigs) { r.parent = r.rig.root.parent; r.rig.root.visible = false; scene.add(r.rig.root); }
  ctx.__warmRigs = rigs;
  return { built: rigs.length, of: ids.length };
}

/** Take the roster templates back out of the scene once they are warm. */
export function unparkRoster(ctx) {
  const rigs = ctx.__warmRigs;
  if (!rigs) return 0;
  for (const r of rigs) { if (r.rig.root.parent) r.rig.root.parent.remove(r.rig.root); }
  ctx.__warmRigs = null;
  return rigs.length;
}

/**
 * PHASE 4 — compile every shader program the game can show.
 *
 * Two passes, because they cover different permutations:
 *   a) compileAsync(scene, camera) walks the whole graph INCLUDING invisible
 *      pooled objects and builds each material's lit program, with this
 *      scene's real lights, fog and environment. Skinned meshes get the
 *      skinned program because the permutation is taken from the OBJECT.
 *   b) one real render with every hidden object temporarily visible, into a
 *      small off-screen target, so the shadow map pass builds the depth-caster
 *      permutation for everything that casts, and every vertex buffer is
 *      uploaded. compile() alone does neither.
 *  b2) the materials the game SWAPS IN at runtime (the hurt flash and the death
 *      dissolve, both assigned onto a skinned mesh) — see warmRuntimeSwaps().
 *   c) one frame through the render system, for the post-processing passes.
 * All of it operates on the materials the game itself created — no lookalikes,
 * so renderer.info.programs.length stays the count the game actually uses.
 */
export async function warmShaders(ctx, full = true, report = null) {
  const r = ctx.renderer, scene = ctx.scene, cam = ctx.camera;
  if (!r || !scene || !cam) return { programs: 0 };
  const t0 = nowMs();
  let swapsMs = null;

  // (a) lit programs for everything in the graph
  try {
    if (r.compileAsync) await r.compileAsync(scene, cam);
    else if (r.compile) r.compile(scene, cam);
  } catch (e) { console.warn('[preload] compile failed:', e && e.message); }
  const afterCompile = r.info.programs ? r.info.programs.length : 0;
  if (report) await report(0.45, `${afterCompile} programs`);
  const steps = { afterCompile };

  // (b) depth / shadow permutations + buffer upload, off-screen
  const hidden = [];
  const culled = [];
  scene.traverse((o) => {
    if (o.isScene) return;
    if (!o.visible) { hidden.push(o); o.visible = true; }
    // pooled objects sit at the origin or off-stage; without this the shadow
    // frustum and the camera frustum both cull them and nothing is compiled
    if (o.frustumCulled && (o.isMesh || o.isPoints || o.isLine || o.isSprite)) { culled.push(o); o.frustumCulled = false; }
  });

  // materials only built when a particular enemy spawns — added to the graph so
  // the render below compiles them like everything else, removed afterwards
  const deferred = warmDeferredMaterials(ctx, scene);

  const rt = new THREE.WebGLRenderTarget(64, 64);
  const prevTarget = r.getRenderTarget();
  const prevAutoReset = r.info.autoReset;
  const prevShadowAuto = r.shadowMap.autoUpdate;
  const prevTone = r.toneMapping;
  try {
    r.shadowMap.autoUpdate = true;
    r.shadowMap.needsUpdate = true;
    r.setRenderTarget(rt);
    r.render(scene, cam);
    steps.afterPlayCam = r.info.programs ? r.info.programs.length : 0;
    // A second pass from a wide overhead camera used to run here, on the theory
    // that the play camera's frustum might not contain everything. It was
    // measured adding exactly ZERO programs (afterWideCam === afterPlayCam),
    // because frustumCulled is already forced off above, so it was removed
    // rather than left in as boot time nobody could account for.
  } catch (e) {
    console.warn('[preload] warm render failed:', e && e.message);
  } finally {
    r.setRenderTarget(prevTarget);
    rt.dispose();
    r.shadowMap.autoUpdate = prevShadowAuto;
    r.toneMapping = prevTone;
    r.info.autoReset = prevAutoReset;
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
    if (deferred) { scene.remove(deferred.group); deferred.geo.dispose(); }
    r.info.reset();
  }

  if (report) await report(0.80, `${r.info.programs ? r.info.programs.length : 0} programs`);

  // (b2) THE MATERIALS THE GAME SWAPS IN AT RUNTIME.
  //
  // entities/enemies/base.js:343 does `this.rig.mesh.material = mat` — it
  // assigns EnemyManager's shared hurt-flash MeshBasicMaterial, and later a
  // per-enemy additive dissolve material, onto a SKINNED mesh. Neither pairing
  // exists anywhere in the scene graph at boot, so neither program is compiled
  // by (a) or (b): the first hit and the first DEATH each compile one inside
  // their own frame. Measured on the software rasteriser, with everything else
  // already warm, that is 128 s for the first hit and 108 s for the first
  // death — which is precisely the "the boss dies and it lags" report.
  //
  // We warm them by driving the game's OWN swap API on the pooled enemies and
  // rendering once. The dissolve material is created lazily by base.js; we
  // build it here to the same specification and hand it to the enemy, so the
  // death path finds it already made and already compiled rather than making
  // its own. Same class, same flags, therefore the same program cache key.
  if (full) swapsMs = warmRuntimeSwaps(ctx);
  if (report) await report(0.90, `${r.info.programs ? r.info.programs.length : 0} programs`);

  // (c) the post chain: its passes are ShaderMaterials that only compile on
  // the frame they first run. One real frame through the render system builds
  // every enabled pass, and it is the frame the loading screen is covering.
  try {
    if (ctx.renderSystem && ctx.renderSystem.render) ctx.renderSystem.render(ctx);
  } catch (e) { console.warn('[preload] post warm failed:', e && e.message); }

  steps.afterPost = r.info.programs ? r.info.programs.length : 0;
  return {
    programs: steps.afterPost,
    afterCompile,
    steps,
    swaps: swapsMs,
    deferred: deferred ? deferred.count : 0,
    unhidden: hidden.length,
    ms: nowMs() - t0,
  };
}

/**
 * Materials the game only builds when a specific enemy SPAWNS, not when its
 * pool instance is constructed.
 *
 * Measured: `capture.state('combat')` adds 10 materials to the scene but only
 * ONE new shader program — the brute's shield plate, whose painterly key
 * `paint3:character:uv:-:d:m:v:c` nothing else in the game uses. The other nine
 * (characterrig.metal.*, characterrig.glow.* per family) all land on keys the
 * roster already warmed. So warming this one entry closes the whole residual.
 *
 * The options below are copied verbatim from the code that owns them —
 * entities/enemies/melee.js `shieldFaceMaterial()` — INCLUDING the
 * `vertexColors = true` it sets afterwards, because that flag is part of the
 * program cache key. MaterialLibrary caches by name+opts, so this returns the
 * very object the brute will later be handed: not a lookalike, the material
 * itself, simply created early.
 */
const DEFERRED = [
  { name: 'shield.brute',
    opts: { variant: 'character', roughness: 1.0, metalness: 1.0, specGain: 0.8 },
    vertexColors: true },
];

export function warmDeferredMaterials(ctx, scene) {
  const mats = ctx.mats;
  if (!mats || !mats.get) return null;
  const group = new THREE.Group();
  group.name = 'preload.deferred';
  // position + normal + uv + color: the attribute set the real meshes carry,
  // and colour matters because vertexColors only reaches the program when the
  // geometry actually has the attribute.
  const geo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
  geo.setAttribute('color', new THREE.BufferAttribute(
    new Float32Array(geo.attributes.position.count * 3).fill(1), 3));
  let n = 0;
  for (const d of DEFERRED) {
    try {
      const m = mats.get(d.name, d.opts);
      if (!m) continue;
      if (d.vertexColors) { m.vertexColors = true; m.needsUpdate = true; }
      const mesh = new THREE.Mesh(geo, m);
      mesh.name = 'preload.deferred.' + d.name;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      n++;
    } catch (e) { /* the library will bake it lazily, as before */ }
  }
  if (!n) return null;
  scene.add(group);
  return { group, geo, count: n };
}

/**
 * Warm the two materials the enemy code swaps onto a SKINNED mesh at runtime:
 * the shared hurt flash and the per-enemy death dissolve. Renders each state
 * once off-screen, then puts every enemy back exactly as it was.
 */
export function warmRuntimeSwaps(ctx) {
  const r = ctx.renderer, scene = ctx.scene, cam = ctx.camera, em = ctx.enemies;
  const rigs = ctx.__warmRigs;
  if (!r || !em || !em.flashMat || !rigs || !rigs.length) return null;
  const t0 = nowMs();
  const rt = new THREE.WebGLRenderTarget(64, 64);
  const prevTarget = r.getRenderTarget();
  const restore = [];
  const dissolve = new THREE.MeshBasicMaterial({
    // built to entities/enemies/base.js's own specification, so its program
    // cache key is the one the real per-enemy dissolve material will ask for
    color: new THREE.Color('#8ef0d0'),
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false, fog: false,
  });
  try {
    for (const { rig } of rigs) {
      if (!rig.mesh) continue;
      restore.push([rig, rig.mesh.material, rig.root.visible]);
      rig.root.visible = true;
    }
    if (!restore.length) return null;
    r.setRenderTarget(rt);
    for (const [rig] of restore) rig.mesh.material = em.flashMat;
    r.render(scene, cam);
    for (const [rig] of restore) rig.mesh.material = dissolve;
    r.render(scene, cam);
  } catch (e) {
    console.warn('[preload] runtime-swap warm failed:', e && e.message);
  } finally {
    for (const [rig, mat, vis] of restore) { rig.mesh.material = mat; rig.root.visible = vis; }
    r.setRenderTarget(prevTarget);
    rt.dispose();
    r.info.reset();
  }
  // the dissolve twin is kept alive on purpose: it is the refcount that stops
  // the additive skinned program dying with the first enemy that finishes
  // dissolving and disposes its own copy
  ctx.__dissolvePin = dissolve;
  return { ms: +(nowMs() - t0).toFixed(0), rigs: restore.length };
}

/**
 * A faithful stand-in for a material.
 *
 * NOT `material.clone()`: THREE's Material.copy() deliberately copies a curated
 * list of properties and skips `onBeforeCompile`, `customProgramCacheKey` and
 * anything a system hung on the object itself — every one of which can feed the
 * program cache key. Measured, `clone()` produced a different key for 75 of 107
 * materials, i.e. it was manufacturing lookalikes rather than pins.
 *
 * A shallow copy of every own property onto a fresh instance of the same class
 * reproduces the key exactly. Uniform objects and textures are shared by
 * reference, which is what we want: the twin is a REFCOUNT, never rendered.
 */
function twin(m) {
  const c = new m.constructor();
  for (const k of Object.keys(m)) {
    if (k === 'uuid' || k === 'id' || k === 'version' || k === '_listeners') continue;
    try { c[k] = m[k]; } catch (e) { /* a read-only accessor */ }
  }
  if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) c.onBeforeCompile = m.onBeforeCompile;
  if (Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')) c.customProgramCacheKey = m.customProgramCacheKey;
  c.needsUpdate = true;
  return c;
}

export function pinPrograms(ctx) {
  const r = ctx.renderer, scene = ctx.scene, cam = ctx.camera;
  if (!r || !r.compile || !scene) return { pinned: 0 };
  const pins = new THREE.Scene();
  pins.name = 'preload.programPins';
  const before = r.info.programs ? r.info.programs.length : 0;
  const seen = new Set();
  const candidates = [];
  scene.traverse((o) => {
    if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
    const list = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of list) {
      if (!m || seen.has(m.uuid)) continue;
      seen.add(m.uuid);
      // SKIP the painterly library materials. Two reasons, both hard:
      //   1. MaterialLibrary caches them by name+opts and never disposes them,
      //      so their programs are already safe — a pin would buy nothing.
      //   2. THREE's Material.copy() does NOT copy onBeforeCompile or
      //      customProgramCacheKey, so a clone of a painterly material has a
      //      DIFFERENT cache key from its original and would compile a program
      //      the game never uses.
      if (m.userData && m.userData.paint) continue;
      candidates.push([o, m]);
    }
  });

  // Pin one at a time and CHECK. A clone is supposed to have an identical
  // program cache key, but several object-level flags feed that key too
  // (instancing colour, morph texture, sprite-ness), and a clone that misses
  // one is not a pin — it is a lookalike that compiles a program the game will
  // never render and inflates the budget. So: compile, and if the program count
  // moved, throw the clone away again. This loop cannot inflate the count.
  let kept = 0, rejected = 0;
  let count = before;
  for (const [o, m] of candidates) {
    let proxy = null;
    try {
      const c = twin(m);
      if (o.isSprite) proxy = new THREE.Sprite(c);
      else if (o.isInstancedMesh) {
        proxy = new THREE.InstancedMesh(o.geometry, c, 1);
        // both of these are read by WebGLPrograms.getParameters
        proxy.instanceColor = o.instanceColor || null;
        proxy.morphTexture = o.morphTexture || null;
      } else if (o.isSkinnedMesh) proxy = new THREE.SkinnedMesh(o.geometry, c);
      else if (o.isPoints) proxy = new THREE.Points(o.geometry, c);
      else if (o.isLine) proxy = new THREE.Line(o.geometry, c);
      else proxy = new THREE.Mesh(o.geometry, c);
      proxy.frustumCulled = false;
      pins.add(proxy);
      r.compile(pins, cam, scene);
      const now = r.info.programs.length;
      if (now !== count) {           // a lookalike — undo it
        pins.remove(proxy); c.dispose(); rejected++;
        count = r.info.programs.length;
      } else kept++;
    } catch (e) {
      if (proxy) { pins.remove(proxy); try { proxy.material.dispose(); } catch (x) { /* gone */ } }
      rejected++;
      count = r.info.programs ? r.info.programs.length : count;
    }
  }
  // held for the life of the page: this reference IS the refcount
  ctx.__programPins = pins;
  const after = r.info.programs ? r.info.programs.length : 0;
  if (after !== before) console.warn(`[preload] program pins moved the count by ${after - before}`);
  return { pinned: kept, rejected, programsBefore: before, programsAfter: after, added: after - before };
}

/** PHASE 5 — every procedural impulse response and instrument bank. */
export async function preloadAudio(ctx) {
  const a = ctx.audio;
  if (!a || !a.preload) return { audio: false };
  try { return await a.preload(); } catch (e) { return { audio: false, error: String(e && e.message) }; }
}

/**
 * The whole descent-gate sequence. Phase weights are the measured share of the
 * work, so the bar moves at roughly constant speed rather than jumping.
 */
export async function preloadAll(ctx, screen, opts = {}) {
  const t0 = nowMs();
  const soft = isSoftwareRenderer(ctx.renderer);
  // FULL is the default everywhere, including the software rasteriser the
  // capture harness uses: measured there, the complete warm-up (46 sets, the
  // 15-strong roster, every program, the runtime swaps) takes boot from 15.4 s
  // to 51.7 s on a container also running two other agents' captures, which is
  // comfortably inside tools/shots.mjs's 90 s readiness budget. `?warm=scene`
  // is the escape hatch if that ever stops being true on some machine: it warms
  // the live scene and skips the runtime-swap pass.
  const full = opts.warm !== 'scene';
  const stats = { software: soft, warm: full ? 'full' : 'scene' };
  const step = async (from, to, label, fn) => {
    screen && screen.set(from, label, '');
    if (screen) await screen.flush();
    // The reporter RETURNS a promise: a phase that wants its progress actually
    // painted has to await it, because the browser cannot repaint while a
    // synchronous compile is holding the main thread.
    const out = await fn(async (p, note) => {
      if (!screen) return;
      screen.set(from + (to - from) * p, label, note);
      await screen.flush();
    });
    screen && screen.set(to, label, '');
    if (screen) await screen.flush();
    return out;
  };

  // Band widths follow where the time actually goes. Measured on a software
  // rasteriser the shader warm-up is 93% of the added boot cost, so it owns
  // most of the bar and reports its own sub-steps from inside; on a real GPU it
  // is nearly instant and the bar simply sweeps through it.
  stats.upload = await step(0.62, 0.66, 'Uploading surfaces', () => uploadTextures(ctx));
  stats.roster = await step(0.66, 0.72, 'Waking the roster', (rp) => preloadRoster(ctx, rp));
  // the roster added materials to the graph, so re-upload what they brought
  stats.upload2 = uploadTextures(ctx);
  stats.shaders = await step(0.72, 0.94, 'Compiling shaders', (rp) => warmShaders(ctx, full, rp));
  stats.pins = await step(0.94, 0.96, 'Pinning programs', () => pinPrograms(ctx));
  stats.audio = await step(0.96, 0.99, 'Tuning the strings', () => preloadAudio(ctx));
  // the roster templates were only in the graph so the passes above could see
  // them; the game clones them from base.js's own cache, not from the scene
  stats.unparked = unparkRoster(ctx);
  stats.ms = nowMs() - t0;
  return stats;
}

export default preloadAll;
