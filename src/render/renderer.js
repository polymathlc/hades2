// OWNER: AGENT-RENDER — STUB, replace with the full HDR pipeline.
import * as THREE from 'three';
export class RenderSystem {
  async init(ctx){
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const r = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance', alpha:false, stencil:false,
      preserveDrawingBuffer: !!ctx.quality.preserveDrawingBuffer });
    r.setPixelRatio(Math.min(devicePixelRatio||1, ctx.quality.dpr ?? 1.5));
    r.setSize(innerWidth, innerHeight, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    ctx.renderer = r;
    ctx.scene = new THREE.Scene();
    ctx.scene.background = new THREE.Color('#07060f');
    ctx.camera = new THREE.PerspectiveCamera(36, innerWidth/innerHeight, 0.5, 300);
    ctx.camera.position.set(14,17,14); ctx.camera.lookAt(0,1,0);
  }
  resize(w,h,ctx){ ctx.renderer.setSize(w,h,false); ctx.camera.aspect=w/h; ctx.camera.updateProjectionMatrix(); }
  render(ctx){ if(ctx.post && ctx.post.render) ctx.post.render(ctx); else ctx.renderer.render(ctx.scene, ctx.camera); }
}
