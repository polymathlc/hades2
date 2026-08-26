// OWNER: AGENT-UI — STUB.
export class UI {
  async init(ctx){ this.ctx=ctx;
    this.root=document.createElement('div'); this.root.id='ui';
    document.body.appendChild(this.root); }
  setHealth(){} setMana(){} setCast(){} damageNumber(){} toast(){} setRoom(){}
  async showBoonChoice(opts){ return opts && opts[0]; }
  screen(){}
  update(dt,ctx){} lateUpdate(a,ctx){} resize(){}
}
