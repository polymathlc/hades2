// OWNER: AGENT-COMBAT — STUB damage router.
export class CombatSystem {
  async init(ctx){ this.ctx=ctx; this.entities=new Set(); }
  register(e){ this.entities.add(e); } unregister(e){ this.entities.delete(e); }
  applyDamage(info){
    const t=info.target; if(!t || t.dead) return 0;
    let amount=info.amount||0;
    if(t.iframes>0 && t===this.ctx.player) return 0;
    t.health=(t.health??1)-amount;
    this.ctx.events.emit('damage.dealt',{...info, amount});
    if(t.health<=0){ t.dead=true; t.alive=false; this.ctx.events.emit('entity.died',{entity:t, pos:info.pos||t.position}); }
    return amount;
  }
  update(dt,ctx){}
}
