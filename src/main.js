import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { RenderSystem } from './render/renderer.js';
import { PostFX } from './render/postfx.js';
import { LightRig } from './render/lighting.js';
import { MaterialLibrary } from './materials/library.js';
import { World } from './world/chamber.js';
import { CameraRig } from './entities/camera.js';
import { Player } from './entities/player.js';
import { CombatSystem } from './entities/combat.js';
import { EnemyManager } from './entities/enemies/index.js';
import { VFX } from './vfx/index.js';
import { UI } from './ui/index.js';
import { Audio } from './audio/index.js';
import { RunState } from './game/run.js';
import {
  GRAPHICS_STORAGE_KEY, chooseGraphicsTier, graphicsChoiceSource,
  graphicsDprCap, isGraphicsTier,
} from './core/quality.js';

const qs = new URLSearchParams(location.search);
const CAPTURE = qs.has('capture');
const SEED = +(qs.get('seed') ?? 1337);

function detectQuality(){
  const requested = qs.get('q');
  let stored = null;
  try { stored = localStorage.getItem(GRAPHICS_STORAGE_KEY); } catch (_) { /* storage may be blocked */ }
  const nav = navigator || {};
  const rawDpr = devicePixelRatio || 1;
  const tier = chooseGraphicsTier({
    capture: CAPTURE,
    requested,
    stored,
    deviceMemory: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
    dpr: rawDpr,
    width: screen?.width || innerWidth,
    height: screen?.height || innerHeight,
    mobile: !!(nav.maxTouchPoints > 0 && matchMedia?.('(pointer: coarse)').matches),
    saveData: !!nav.connection?.saveData,
  });
  return {
    tier,
    source: graphicsChoiceSource({ capture: CAPTURE, requested, stored }),
    dpr: CAPTURE ? 1 : Math.min(rawDpr, graphicsDprCap(tier)),
    shadows: tier !== 'low',
    preserveDrawingBuffer: CAPTURE,
  };
}

async function boot(){
  const engine = new Engine({ seed: SEED, quality: detectQuality() });
  const ctx = engine.ctx;
  ctx.CAPTURE = CAPTURE;

  // Order matters: renderer -> materials -> lighting/post -> world -> entities -> fx -> ui
  const render   = engine.add(new RenderSystem(), 'renderSystem');
  const mats     = engine.add(new MaterialLibrary(), 'mats');
  const post     = engine.add(new PostFX(), 'post');
  const lighting = engine.add(new LightRig(), 'lighting');
  const world    = engine.add(new World(), 'world');
  const combat   = engine.add(new CombatSystem(), 'combat');
  const player   = engine.add(new Player(), 'player');
  const enemies  = engine.add(new EnemyManager(), 'enemies');
  // NOTE: the Spawner is deliberately NOT registered here. EnemyManager.init() constructs it,
  // calls init(ctx, this) with the manager, publishes ctx.spawner and ticks it from its own
  // update. Registering a second one here created a duplicate that raced the real encounter
  // director and double-spawned every wave.
  const camRig   = engine.add(new CameraRig(), 'cameraRig');
  const vfx      = engine.add(new VFX(), 'vfx');
  const ui       = engine.add(new UI(), 'ui');
  const audio    = engine.add(new Audio(), 'audio');
  const run      = engine.add(new RunState(), 'run');

  const tBoot = performance.now();
  await engine.initAll();
  ctx.input.attach(ctx.renderer.domElement);

  // Settings can be changed before a descent. At home a short reload is safe
  // and rebuilds textures, post effects and light pools at the selected cost.
  // During a run we save the choice for the next visit rather than discard play.
  ctx.events.on('quality.request', ({ tier } = {}) => {
    if (tier !== 'auto' && !isGraphicsTier(tier)) return;
    try {
      if (tier === 'auto') localStorage.removeItem(GRAPHICS_STORAGE_KEY);
      else localStorage.setItem(GRAPHICS_STORAGE_KEY, tier);
    } catch (_) { /* private browsing may reject persistence */ }
    const label = tier === 'auto' ? 'AUTO GRAPHICS' : `${tier.toUpperCase()} GRAPHICS`;
    if (ctx.run?.state === 'home') {
      ctx.ui?.toast?.(`${label} · APPLYING`);
      setTimeout(() => location.reload(), 180);
    } else {
      ctx.ui?.toast?.(`${label} SAVED · APPLIES NEXT LAUNCH`);
    }
  });

  // One-line boot budget report. Texture synthesis is the expensive half of
  // init and it is lazy, so this number is "everything the first chamber
  // actually asked for", which is the number that matters.
  const ms = ctx.mats && ctx.mats.stats ? ctx.mats.stats : null;
  console.info(`[erebus] boot ${(performance.now() - tBoot).toFixed(0)}ms | materials `
    + `${ms ? ms.built : 0} sets in ${ms ? ms.ms.toFixed(0) : 0}ms `
    + `(${ms ? (ms.texels / 1e6).toFixed(1) : 0} Mtexel) | tier ${ctx.quality.tier}`);

  addEventListener('resize', ()=> engine.resize(innerWidth, innerHeight));

  // switching biome retunes world materials, the light rig, the grade and the
  // air in one call — everything listens to 'biome.changed'
  const setBiome = (name) => {
    if(ctx.world && ctx.world.setBiome) ctx.world.setBiome(name, ctx);
    else ctx.events.emit('biome.changed', { name });
    if(ctx.run) ctx.run.biome = name;
    return name;
  };
  window.EREBUS = { engine, ctx, THREE, setBiome };

  if(CAPTURE){
    setupCapture(engine, ctx, setBiome);
  } else {
    const unlock = ()=>{ ctx.audio.unlock && ctx.audio.unlock(); removeEventListener('pointerdown',unlock); removeEventListener('keydown',unlock); };
    addEventListener('pointerdown',unlock); addEventListener('keydown',unlock);
    engine.start();
  }
  document.body.classList.add('booted');
}

// ---------------------------------------------------------------------------
// Deterministic capture driver — the eyes of the critic agents.
// ---------------------------------------------------------------------------
function setupCapture(engine, ctx, setBiome){
  const DT = 1/60;
  let resolveReady;
  const drv = {
    ready: new Promise(r=>{ resolveReady=r; }),
    seed(n){ ctx.rng.reseed(n); },
    // advance the simulation deterministically and render the final frame
    step(seconds){
      const n = Math.max(1, Math.round(seconds/DT));
      engine.skipRender = true;
      for(let i=0;i<n;i++) engine.step(DT);
      engine.skipRender = false;
      return n;
    },
    // freeze the camera at an authored pose (disables the follow rig).
    //
    // ANCHORING: a pose may carry `anchor:'player'`, in which case pos/target
    // are offsets from the hero's feet on the ground plane. The shot list used
    // to hard-code world coordinates aimed at the origin, so every "gameplay"
    // frame was pointed at the middle of the room while the character stood
    // somewhere else — the critic never actually saw the subject. Anchored
    // poses frame whatever the player is doing, which is the framing the game
    // itself uses. `anchor:'rig'` goes further and reproduces the live camera
    // rig's own geometry (pitch/yaw/distance/fov) so the shot IS the play
    // camera rather than an approximation of it.
    pose(p){
      if(!p){ ctx.cameraRig.enabled = true; return; }
      ctx.cameraRig.enabled = false;
      const cam = ctx.camera;
      const pl = ctx.player && ctx.player.position ? ctx.player.position : null;
      if(p.anchor === 'rig' && ctx.cameraRig){
        const rig = ctx.cameraRig;
        const dist = p.distance ?? rig.tune.distance;
        const pitch = (p.pitchDeg != null ? p.pitchDeg : rig.tune.pitchDeg) * Math.PI/180;
        const yaw   = (p.yawDeg   != null ? p.yawDeg   : rig.tune.yawDeg)   * Math.PI/180;
        const o = p.at ? new THREE.Vector3(...p.at) : (pl ? pl.clone() : new THREE.Vector3());
        if(p.offset) o.add(new THREE.Vector3(...p.offset));
        const cp = Math.cos(pitch);
        cam.position.set(o.x + Math.sin(yaw)*cp*dist, o.y + Math.sin(pitch)*dist, o.z + Math.cos(yaw)*cp*dist);
        cam.lookAt(o.x, o.y + (p.lookHeight ?? rig.tune.lookHeight), o.z);
        cam.fov = p.fov ?? rig.tune.fov;
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);
        return;
      }
      const ax = (p.anchor === 'player' && pl) ? pl.x : 0;
      const az = (p.anchor === 'player' && pl) ? pl.z : 0;
      if(p.pos) cam.position.set(p.pos[0]+ax, p.pos[1], p.pos[2]+az);
      if(p.target) cam.lookAt(p.target[0]+ax, p.target[1], p.target[2]+az);
      if(p.fov){ cam.fov=p.fov; cam.updateProjectionMatrix(); }
      cam.updateMatrixWorld(true);
    },
    state(name, args){ ctx.events.emit('capture.state', {name, args}); },
    // deterministic biome switch for the critic loop: capture.biome('elysium')
    biome(name){ setBiome(name); drv.step(0.2); return name; },
    hide(list){ for(const n of list||[]){ const o=ctx.scene.getObjectByName(n); if(o) o.visible=false; } },
    hud(v){ const el=document.getElementById('ui'); if(el) el.style.display = v?'':'none'; },
    render(){
      // go through the render system so the frame is counted and the fallback
      // path (no post) still tone maps
      if(ctx.renderSystem && ctx.renderSystem.render) ctx.renderSystem.render(ctx);
      else if(ctx.post && ctx.post.render) ctx.post.render(ctx);
      else ctx.renderer.render(ctx.scene, ctx.camera);
    },
    // Render a linear view-depth pass to the canvas so the analyzer can bucket luma by TRUE scene
    // depth instead of by screen position. Screen-thirds is not depth: in a wide pose the top third
    // is mostly void, so a band metric built on it improves when you brighten the sky, which is
    // exactly the wrong incentive.
    depth(){
      const r = ctx.renderer, scene = ctx.scene, cam = ctx.camera;
      const prevOverride = scene.overrideMaterial, prevBg = scene.background;
      const prevTone = r.toneMapping, prevCS = r.outputColorSpace;
      const mat = new THREE.ShaderMaterial({
        vertexShader: 'varying float vD; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vD = -mv.z; gl_Position = projectionMatrix*mv; }',
        fragmentShader: 'varying float vD; uniform float uNear; uniform float uFar; void main(){ float d = clamp((vD-uNear)/(uFar-uNear),0.0,1.0); gl_FragColor = vec4(d,d,d,1.0); }',
        uniforms: { uNear:{value:cam.near}, uFar:{value:cam.far} },
        side: THREE.DoubleSide,
      });
      scene.overrideMaterial = mat;
      scene.background = new THREE.Color(0xffffff);   // nothing there = infinitely far
      r.toneMapping = THREE.NoToneMapping;
      r.outputColorSpace = THREE.LinearSRGBColorSpace;
      r.render(scene, cam);
      scene.overrideMaterial = prevOverride; scene.background = prevBg;
      r.toneMapping = prevTone; r.outputColorSpace = prevCS;
      mat.dispose();
      return document.querySelector('canvas').toDataURL('image/png');
    },
    // Camera + arena parameters so the analyzer can reconstruct WORLD position per pixel from the
    // depth pass, and therefore bucket value bands by distance from the arena centre (play area /
    // perimeter architecture / background void) rather than by pixel-count quantiles, which
    // collapse in a close pose where most of the frame is floor.
    // A colour frame WITHOUT the HUD overlay, for measurement only. Critics look at the real
    // frame; the analyzer measures this one, so screen-space UI is never counted as scene content.
    clean(){
      const ui = ctx.ui;
      const had = ui && ui.suppressForMetrics;
      if (ui) ui.suppressForMetrics = true;
      if (ctx.renderSystem && ctx.renderSystem.render) ctx.renderSystem.render(ctx);
      else if (ctx.post && ctx.post.render) ctx.post.render(ctx);
      else ctx.renderer.render(ctx.scene, ctx.camera);
      const url = document.querySelector('canvas').toDataURL('image/png');
      if (ui) ui.suppressForMetrics = had;
      return url;
    },
    sceneMeta(){
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      return {
        fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far,
        matrixWorld: cam.matrixWorld.elements.slice(),
        arenaR: (ctx.world && ctx.world.bounds && ctx.world.bounds.r) || 16,
      };
    },
    info(){ const ms = ctx.mats && ctx.mats.stats ? ctx.mats.stats : null;
            return { fps: engine.perf.fps, calls: ctx.renderer.info.render.calls, tris: ctx.renderer.info.render.triangles,
                     progs: ctx.renderer.info.programs ? ctx.renderer.info.programs.length : 0,
                     geoms: ctx.renderer.info.memory.geometries, texs: ctx.renderer.info.memory.textures,
                     matSets: ms ? ms.built : 0, matMs: ms ? +ms.ms.toFixed(1) : 0,
                     mtexel: ms ? +(ms.texels/1e6).toFixed(2) : 0,
                     player: ctx.player && ctx.player.position ? [ +ctx.player.position.x.toFixed(2), +ctx.player.position.y.toFixed(2), +ctx.player.position.z.toFixed(2) ] : null,
                     t: ctx.time.t, frame: ctx.time.frame }; },
  };
  ctx.capture = drv;
  window.EREBUS.capture = drv;
  const captureParams = new URLSearchParams(location.search);
  const requestedState = captureParams.get('state');
  const requestedBiome = captureParams.get('biome');
  const requestedBoss = captureParams.get('boss');
  const requestedWeapon = captureParams.get('weapon');
  const requestedCharacter = captureParams.get('character');
  const requestedGod = captureParams.get('god');
  const requestedPage = captureParams.get('page');
  const requestedDepthRaw = captureParams.get('depth');
  const requestedDepth = requestedDepthRaw == null ? NaN : Number(requestedDepthRaw);
  // let one frame settle so async material/geometry work completes
  requestAnimationFrame(()=>{
    engine.skipRender=true; engine.step(DT); engine.skipRender=false;
    if(requestedBiome) drv.biome(requestedBiome);
    if(requestedState){
      let args = requestedState === 'boss' && (requestedBoss || Number.isFinite(requestedDepth))
        ? { kind: requestedBoss || undefined, depth: Number.isFinite(requestedDepth) ? requestedDepth : undefined }
        : requestedState === 'altar' && requestedPage ? { page: requestedPage } : undefined;
      if (requestedWeapon) args = { ...(args || {}), weapon: requestedWeapon };
      if (requestedCharacter) args = { ...(args || {}), character: requestedCharacter };
      if (requestedGod) args = { ...(args || {}), god: requestedGod };
      drv.state(requestedState, args); drv.step(0.8); drv.render();
    }
    resolveReady(); window.__EREBUS_READY = true;
  });
}

boot().catch(e=>{
  console.error('BOOT FAILURE', e);
  const d=document.createElement('pre');
  d.style.cssText='position:fixed;inset:0;color:#f66;background:#100;padding:20px;font:12px monospace;z-index:99999;white-space:pre-wrap';
  d.textContent='BOOT FAILURE\n'+(e&&e.stack||e); document.body.appendChild(d);
});
