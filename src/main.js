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

const qs = new URLSearchParams(location.search);
const CAPTURE = qs.has('capture');
const SEED = +(qs.get('seed') ?? 1337);

function detectQuality(){
  const tier = qs.get('q') || (CAPTURE ? 'ultra' : 'high');
  return { tier, dpr: CAPTURE ? 1 : Math.min(devicePixelRatio||1, 2), shadows:true, preserveDrawingBuffer: CAPTURE };
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
  const camRig   = engine.add(new CameraRig(), 'cameraRig');
  const vfx      = engine.add(new VFX(), 'vfx');
  const ui       = engine.add(new UI(), 'ui');
  const audio    = engine.add(new Audio(), 'audio');
  const run      = engine.add(new RunState(), 'run');

  await engine.initAll();
  ctx.input.attach(ctx.renderer.domElement);

  addEventListener('resize', ()=> engine.resize(innerWidth, innerHeight));

  window.EREBUS = { engine, ctx, THREE };

  if(CAPTURE){
    setupCapture(engine, ctx);
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
function setupCapture(engine, ctx){
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
    // freeze the camera at an authored pose (disables the follow rig)
    pose(p){
      if(!p){ ctx.cameraRig.enabled = true; return; }
      ctx.cameraRig.enabled = false;
      const cam = ctx.camera;
      if(p.pos) cam.position.set(...p.pos);
      if(p.target) cam.lookAt(...p.target);
      if(p.fov){ cam.fov=p.fov; cam.updateProjectionMatrix(); }
      ctx.renderer.render(ctx.scene, ctx.camera);
    },
    state(name, args){ ctx.events.emit('capture.state', {name, args}); },
    hide(list){ for(const n of list||[]){ const o=ctx.scene.getObjectByName(n); if(o) o.visible=false; } },
    hud(v){ const el=document.getElementById('ui'); if(el) el.style.display = v?'':'none'; },
    render(){ if(ctx.post&&ctx.post.render) ctx.post.render(ctx); else ctx.renderer.render(ctx.scene,ctx.camera); },
    info(){ return { fps: engine.perf.fps, calls: ctx.renderer.info.render.calls, tris: ctx.renderer.info.render.triangles,
                     t: ctx.time.t, frame: ctx.time.frame }; },
  };
  ctx.capture = drv;
  window.EREBUS.capture = drv;
  // let one frame settle so async material/geometry work completes
  requestAnimationFrame(()=>{ engine.skipRender=true; engine.step(DT); engine.skipRender=false; resolveReady(); window.__EREBUS_READY = true; });
}

boot().catch(e=>{
  console.error('BOOT FAILURE', e);
  const d=document.createElement('pre');
  d.style.cssText='position:fixed;inset:0;color:#f66;background:#100;padding:20px;font:12px monospace;z-index:99999;white-space:pre-wrap';
  d.textContent='BOOT FAILURE\n'+(e&&e.stack||e); document.body.appendChild(d);
});
