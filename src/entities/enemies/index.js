// OWNER: AGENT-ENEMY — STUB.
export class EnemyManager {
  constructor(){ this.list=[]; }
  async init(ctx){ this.ctx=ctx; }
  spawn(kind, pos){ return null; }
  update(dt,ctx){} lateUpdate(a,ctx){}
  get aliveCount(){ return this.list.filter(e=>!e.dead).length; }
}
