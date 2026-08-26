// OWNER: AGENT-RENDER — STUB post chain (passthrough). Replace with HDR + bloom + GTAO + grade.
export class PostFX {
  async init(ctx){ this.enabled = true; }
  resize(w,h,ctx){}
  render(ctx){ ctx.renderer.render(ctx.scene, ctx.camera); }
}
