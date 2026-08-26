// OWNER: AGENT-RUN — STUB roguelite run state.
export class RunState {
  constructor(){ this.depth=0; this.biome='tartarus'; this.boons=[]; this.seed=1337; this.state='playing'; }
  async init(ctx){ this.ctx=ctx; }
  update(dt,ctx){}
}
