export class EventBus {
  constructor(){ this.map = new Map(); this._depth = 0; }
  on(name, fn){ let a = this.map.get(name); if(!a){ a=[]; this.map.set(name,a);} a.push(fn); return ()=>this.off(name,fn); }
  once(name, fn){ const off = this.on(name, (p)=>{ off(); fn(p); }); return off; }
  off(name, fn){ const a=this.map.get(name); if(!a) return; const i=a.indexOf(fn); if(i>=0) a.splice(i,1); }
  emit(name, payload){ const a=this.map.get(name); if(!a||!a.length) return;
    const list = a.slice();
    for(let i=0;i<list.length;i++){ try{ list[i](payload); }catch(e){ console.error('[event]',name,e); } } }
  clear(){ this.map.clear(); }
}
