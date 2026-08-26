// Deterministic seeded RNG (xoshiro128** ) with named forks.
function hashStr(s){ let h=2166136261>>>0; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;} return h>>>0; }
export class RNG {
  constructor(seed = 1){ this.reseed(seed); }
  reseed(seed){
    let s = (typeof seed === 'string') ? hashStr(seed) : (seed>>>0) || 1;
    this._s = new Uint32Array(4);
    for (let i=0;i<4;i++){ s = (s + 0x9E3779B9)>>>0; let z=s; z=(Math.imul(z^(z>>>16),0x21f0aaad))>>>0; z=(Math.imul(z^(z>>>15),0x735a2d97))>>>0; this._s[i]=(z^(z>>>15))>>>0||1; }
    this.seed = seed; this._children = new Map(); return this;
  }
  _next(){ const s=this._s; const r=(Math.imul(s[1]*5>>>0,9)>>>0); const result=(((r<<7)|(r>>>25))>>>0)*9>>>0;
    const t=(s[1]<<9)>>>0; s[2]^=s[0]; s[3]^=s[1]; s[1]^=s[2]; s[0]^=s[3]; s[2]^=t; s[3]=((s[3]<<11)|(s[3]>>>21))>>>0; return result>>>0; }
  f(){ return this._next()/4294967296; }
  range(a,b){ return a + (b-a)*this.f(); }
  int(a,b){ return a + Math.floor(this.f()*(b-a+1)); }
  pick(arr){ return arr[Math.floor(this.f()*arr.length)]; }
  sign(){ return this.f()<0.5?-1:1; }
  bool(p=0.5){ return this.f()<p; }
  gauss(mu=0,sd=1){ let u=0,v=0; while(!u)u=this.f(); while(!v)v=this.f(); return mu+sd*Math.sqrt(-2*Math.log(u))*Math.cos(6.283185307179586*v); }
  unit2(){ const a=this.f()*6.283185307179586; return [Math.cos(a),Math.sin(a)]; }
  shuffle(arr){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(this.f()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
  weighted(items, weightFn){ let total=0; for(const it of items) total+=weightFn(it); let r=this.f()*total; for(const it of items){ r-=weightFn(it); if(r<=0) return it; } return items[items.length-1]; }
  fork(label){ if(this._children.has(label)) return this._children.get(label);
    const c = new RNG(hashStr(String(this.seed)+'::'+label)); this._children.set(label,c); return c; }
}
export const makeRNG = (seed) => new RNG(seed);
