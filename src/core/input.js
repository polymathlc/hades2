import * as THREE from 'three';
const KEYMAP = {
  KeyW:'up', KeyS:'down', KeyA:'left', KeyD:'right',
  ArrowUp:'up', ArrowDown:'down', ArrowLeft:'left', ArrowRight:'right',
  Space:'dash', ShiftLeft:'dash', KeyE:'special', KeyQ:'cast', KeyR:'summon',
  KeyF:'interact', Escape:'pause', KeyH:'help',
};
export class Input {
  constructor(){
    this.move = new THREE.Vector2();
    this.rawMove = new THREE.Vector2();
    this.aim = new THREE.Vector3();
    this.aimDir = new THREE.Vector2(0,1);
    this.pointer = new THREE.Vector2();       // NDC
    this.pointerPx = new THREE.Vector2();
    this._down = new Set(); this._pressed = new Set(); this._released = new Set();
    this._gp = null; this.usingGamepad = false; this.enabled = true;
    this.lookVec = new THREE.Vector2(0,1);    // right-stick / mouse-derived aim direction
  }
  attach(dom){
    this.dom = dom;
    const kd = (e)=>{ const a=KEYMAP[e.code]; if(!a || !this.enabled) return; if(e.code==='Space') e.preventDefault();
      if(!this._down.has(a)){ this._down.add(a); this._pressed.add(a); } this.usingGamepad=false; };
    const ku = (e)=>{ const a=KEYMAP[e.code]; if(!a) return; if(this._down.has(a)){ this._down.delete(a); this._released.add(a);} };
    addEventListener('keydown',kd); addEventListener('keyup',ku);
    addEventListener('blur',()=>{ for(const a of this._down) this._released.add(a); this._down.clear(); });
    const pm = (e)=>{ const r=dom.getBoundingClientRect();
      this.pointerPx.set(e.clientX-r.left, e.clientY-r.top);
      this.pointer.set((this.pointerPx.x/r.width)*2-1, -(this.pointerPx.y/r.height)*2+1); this.usingGamepad=false; };
    dom.addEventListener('pointermove',pm);
    dom.addEventListener('pointerdown',(e)=>{ if(!this.enabled) return; pm(e);
      const a = e.button===0?'attack': e.button===2?'special':e.button===1?'cast':null;
      if(!a) return;
      if(!this._down.has(a)){ this._down.add(a); this._pressed.add(a);} });
    addEventListener('pointerup',(e)=>{ const a = e.button===0?'attack': e.button===2?'special':e.button===1?'cast':null;
      if(!a) return;
      if(this._down.has(a)){ this._down.delete(a); this._released.add(a);} });
    dom.addEventListener('contextmenu',e=>e.preventDefault());
    addEventListener('gamepadconnected',()=>{ this.usingGamepad=true; });
  }
  _pollPad(){
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp=null; for(const p of pads) if(p && p.connected){ gp=p; break; }
    this._gp = gp; if(!gp) return;
    const dz=(v)=> Math.abs(v)<0.22?0:(v-Math.sign(v)*0.22)/0.78;
    const lx=dz(gp.axes[0]||0), ly=dz(gp.axes[1]||0);
    const rx=dz(gp.axes[2]||0), ry=dz(gp.axes[3]||0);
    if(lx||ly||rx||ry) this.usingGamepad=true;
    if(this.usingGamepad){ this.rawMove.set(lx,-ly);
      if(rx||ry) this.lookVec.set(rx,-ry).normalize(); }
    const btn=(i,a)=>{ const p=gp.buttons[i]&&gp.buttons[i].pressed;
      if(p&&!this._down.has(a)){this._down.add(a);this._pressed.add(a);} else if(!p&&this._down.has(a)){this._down.delete(a);this._released.add(a);} };
    btn(2,'attack'); btn(3,'special'); btn(7,'cast'); btn(0,'dash'); btn(1,'summon'); btn(5,'interact'); btn(9,'pause');
  }
  // called once per frame BEFORE systems update
  begin(){
    if(!this.enabled){ this.move.set(0,0); return; }
    this._pollPad();
    if(!this.usingGamepad){
      const x=(this._down.has('right')?1:0)-(this._down.has('left')?1:0);
      const y=(this._down.has('up')?1:0)-(this._down.has('down')?1:0);
      this.rawMove.set(x,y);
    }
    this.move.copy(this.rawMove); if(this.move.lengthSq()>1) this.move.normalize();
  }
  end(){ this._pressed.clear(); this._released.clear(); }
  down(a){ return this._down.has(a); }
  pressed(a){ return this._pressed.has(a); }
  released(a){ return this._released.has(a); }
  // capture/scripted override
  inject(state){ Object.assign(this, state); }
}
