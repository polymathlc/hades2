// OWNER: AGENT-RENDER — HDR render pipeline root.
//
// Responsibilities
//   * create the WebGL2 context with correct colour management
//   * own the scene + camera
//   * own the shadow rig policy (PCF soft, tuned for a 3/4 iso camera)
//   * publish the quality-tier table that PostFX / LightRig / Atmosphere read
//   * hand the frame to PostFX, and guarantee the FINAL image lands on the
//     default framebuffer (the headless capture reads pixels straight off the
//     canvas — nothing may be left in an FBO)
//
// Tone mapping deliberately does NOT happen here: it is the last thing the post
// chain does, in the grade shader. The renderer only tone maps when the post
// chain is unavailable (fallback path), which is why `toneMapping` is switched
// dynamically instead of being fixed at construction.
import * as THREE from 'three';

/**
 * Quality tiers. Every downstream system reads `ctx.quality.render`.
 * Anything a critic might want to A/B is a plain number or boolean here.
 */
export const TIERS = {
  low: {
    renderScale: 0.85, hdr: true,
    shadows: false, shadowMap: 1024, shadowRadius: 1.2,
    ao: false, aoScale: 0.5, aoDirs: 3, aoSteps: 3,
    bloom: true, bloomMips: 4, bloomScale: 0.5,
    godrays: false, godraysScale: 0.25, godraysSamples: 16,
    dof: false, dofScale: 0.5,
    fog: true, aa: 'none', grain: true, chroma: true,
    motes: 260, dustLayers: 1, practicalLights: 4,
  },
  med: {
    renderScale: 1.0, hdr: true,
    shadows: true, shadowMap: 1024, shadowRadius: 1.3,
    ao: true, aoScale: 0.5, aoDirs: 4, aoSteps: 4,
    bloom: true, bloomMips: 5, bloomScale: 0.5,
    godrays: true, godraysScale: 0.25, godraysSamples: 20,
    dof: false, dofScale: 0.5,
    fog: true, aa: 'fxaa', grain: true, chroma: true,
    motes: 600, dustLayers: 2, practicalLights: 6,
  },
  high: {
    renderScale: 1.0, hdr: true,
    shadows: true, shadowMap: 2048, shadowRadius: 1.4,
    ao: true, aoScale: 0.5, aoDirs: 5, aoSteps: 5,
    bloom: true, bloomMips: 6, bloomScale: 0.5,
    godrays: true, godraysScale: 0.5, godraysSamples: 24,
    dof: true, dofScale: 0.5,
    fog: true, aa: 'smaa', grain: true, chroma: true,
    motes: 950, dustLayers: 3, practicalLights: 8,
  },
  ultra: {
    // 1.5x SSAA. SMAA runs post-tonemap and cannot recover a 2-pixel emissive
    // meander band or a sub-pixel gold spoke — that aliasing lives in HDR long
    // before AA sees it (ART_DIRECTION §7). Supersampling is the only thing
    // that actually resolves it; the final resolve tent is sized to the ratio
    // so a fractional factor does not leave a beat pattern.
    // 2.0x SSAA. 1.5x was not enough for a 2px emissive band against #000 —
    // the far-wall meander still broke into a dashed line and the thin
    // architrave slabs still stairstepped. The ultra tier is what the capture
    // harness uses (main.js:22), so this is the shot-sheet resolve path.
    renderScale: 2.0, hdr: true,
    shadows: true, shadowMap: 3072, shadowRadius: 1.5,
    ao: true, aoScale: 0.5, aoDirs: 6, aoSteps: 6,
    bloom: true, bloomMips: 7, bloomScale: 0.5,
    godrays: true, godraysScale: 0.5, godraysSamples: 28,
    dof: true, dofScale: 0.5,
    fog: true, aa: 'smaa', grain: true, chroma: true,
    motes: 1250, dustLayers: 3, practicalLights: 10,
  },
};

export class RenderSystem {
  constructor(){
    this.size = { w: 1, h: 1, dpr: 1 };
    this._scale = 1;
  }

  async init(ctx){
    THREE.ColorManagement.enabled = true;

    const canvas = document.createElement('canvas');
    canvas.id = 'erebus-canvas';
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;background:#07060f';
    // prepend: the capture harness grabs document.querySelector('canvas'),
    // so ours must be the first canvas in the document no matter what else boots.
    document.body.prepend(canvas);

    const tier = (ctx.quality && ctx.quality.tier) || 'high';
    const q = TIERS[tier] || TIERS.high;
    ctx.quality.render = { ...q, tier };

    const r = new THREE.WebGLRenderer({
      canvas,
      antialias: false,                 // we do SMAA/FXAA + optional SSAA in post
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      // NON-NEGOTIABLE: the headless capture reads the drawing buffer directly.
      preserveDrawingBuffer: !!ctx.quality.preserveDrawingBuffer,
    });

    const dpr = Math.min(devicePixelRatio || 1, ctx.quality.dpr ?? 1.5);
    r.setPixelRatio(dpr);
    r.setSize(innerWidth, innerHeight, false);

    // Colour management: everything internal is scene-linear, the canvas is sRGB.
    r.outputColorSpace = THREE.SRGBColorSpace;
    // The post chain tone maps. Three only applies renderer tone mapping when the
    // destination is the canvas, so this value is purely the no-post fallback.
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;

    // Shadows: PCF, tuned in lighting.js for the fixed 3/4 iso frustum.
    // (PCFSoftShadowMap is deprecated in three 0.185 and logs a warning on every
    // boot — the softening now comes from light.shadow.radius instead.)
    r.shadowMap.enabled = !!q.shadows && (ctx.quality.shadows !== false);
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = true;

    r.autoClear = true;
    // Per-FRAME stats, not per-render-call: the post chain issues ~25 blits and
    // the shadow map another pass, so with autoReset the capture harness only
    // ever saw the last one (calls: 1). We reset once at the top of the frame
    // instead, which makes ctx.renderer.info a real draw-call budget.
    r.info.autoReset = false;

    ctx.renderer = r;
    this.renderer = r;

    // ── scene ────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.name = 'erebus';
    // Void black. atmosphere.js draws a painted backdrop over this every frame.
    scene.background = new THREE.Color('#07060f');
    ctx.scene = scene;
    this.scene = scene;

    // ── camera: long lens, 3/4 iso (ART_DIRECTION §8) ────────────────────────
    const cam = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.5, 420);
    cam.name = 'main';
    cam.position.set(18, 22, 18);
    cam.lookAt(0, 1.2, 0);
    ctx.camera = cam;
    this.camera = cam;

    this._scale = q.renderScale;
    this.size = { w: innerWidth, h: innerHeight, dpr };

    // let anyone query the internal render resolution (post RTs, AO, etc.)
    ctx.renderSize = () => this.internalSize();

    // capture harness may want to force a deterministic pixel ratio
    if(ctx.quality.preserveDrawingBuffer) r.setPixelRatio(ctx.quality.dpr ?? 1);
  }

  /** Internal (pre-resolve) render resolution, including the SSAA factor. */
  internalSize(){
    const r = this.renderer;
    const scale = (this._scale ?? 1);
    const v = new THREE.Vector2();
    r.getDrawingBufferSize(v);
    return { w: Math.max(2, Math.round(v.x * scale)), h: Math.max(2, Math.round(v.y * scale)) };
  }

  resize(w, h, ctx){
    if(!ctx.renderer) return;
    ctx.renderer.setSize(w, h, false);
    ctx.camera.aspect = w / h;
    ctx.camera.updateProjectionMatrix();
    this.size.w = w; this.size.h = h;
  }

  /**
   * Frame entry point. The post chain owns the final blit to the default
   * framebuffer; if it is missing or disabled we fall back to a direct,
   * tone-mapped render so the screen is never black.
   */
  render(ctx){
    const r = ctx.renderer;
    if(!r) return;
    if(r.info.autoReset === false) r.info.reset();
    const post = ctx.post;
    const usePost = !!(post && post.ready && post.enabled && post.render);
    if(usePost){
      if(r.toneMapping !== THREE.NoToneMapping){ r.toneMapping = THREE.NoToneMapping; }
      post.render(ctx);
      // Belt and braces: whatever post did, we must end on the screen.
      if(r.getRenderTarget() !== null) r.setRenderTarget(null);
    } else {
      if(r.toneMapping !== THREE.ACESFilmicToneMapping){ r.toneMapping = THREE.ACESFilmicToneMapping; }
      r.setRenderTarget(null);
      r.render(ctx.scene, ctx.camera);
    }
  }

  dispose(){
    if(this.renderer) this.renderer.dispose();
  }
}
