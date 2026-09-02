import * as THREE from 'three';
import { keymap, PAD_BINDINGS, rebind as rebindTable, loadBindings, saveBindings } from './controls.js';

/**
 * Pure latch logic for TOGGLE actions (accessibility: "hold to block/charge"
 * becomes "press to start, press again to stop"). Returns the next latch
 * state and whether the action should be considered down.
 *   latched: was the action latched before this event
 *   kind:    'down' | 'up'
 */
export function toggleLatch(latched, kind) {
  if (kind === 'down') return { latched: !latched, down: !latched };
  return { latched, down: latched };            // key-up never releases a latch
}

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
    this.keymap = keymap();
    this.toggleActions = new Set();           // actions that latch (see toggleLatch)
    this._latched = new Set();
    this.capturing = null;                    // rebind listener: fn(code) -> handled
    this.onDevice = null;                     // fn('gamepad'|'keyboard') on device change
    this.lastDevice = 'keyboard';
    this.anyInputT = 0;                       // wall time of the last real input (onboarding)
    this._padDown = new Set();                // pad buttons currently held (edge detection)
  }
  /** Rebuild the code->action map after a rebind (or a stored table load). */
  refreshBindings(){ this.keymap = keymap(); }
  loadBindings(){ loadBindings(); this.refreshBindings(); return this; }
  rebind(action, code){ const r = rebindTable(action, code); if (r.ok) { this.refreshBindings(); saveBindings(); } return r; }
  setToggle(action, on){ if (on) this.toggleActions.add(action); else { this.toggleActions.delete(action); this._latched.delete(action); this._release(action); } }
  _press(a){ if(!this._down.has(a)){ this._down.add(a); this._pressed.add(a); } }
  _release(a){ if(this._down.has(a)){ this._down.delete(a); this._released.add(a); } }
  _device(kind){
    if (this.lastDevice === kind) return;
    this.lastDevice = kind; this.usingGamepad = kind === 'gamepad';
    if (this.onDevice) { try { this.onDevice(kind); } catch (e) { /* listener error must not eat input */ } }
  }
  _keyDown(a){
    if (this.toggleActions.has(a)) {
      const r = toggleLatch(this._latched.has(a), 'down');
      if (r.latched) this._latched.add(a); else this._latched.delete(a);
      if (r.down) this._press(a); else this._release(a);
      return;
    }
    this._press(a);
  }
  _keyUp(a){
    if (this.toggleActions.has(a) && this._latched.has(a)) return;   // latched: stays down
    this._release(a);
  }
  attach(dom){
    this.dom = dom;
    const kd = (e)=>{
      if (this.capturing) {                       // rebinding: swallow the key
        if (e.code === 'Escape') { this.capturing(null); }
        else if (!/^(Meta|Control|Alt|Shift)(Left|Right)?$/.test(e.code) || e.code === 'ShiftLeft') this.capturing(e.code);
        e.preventDefault(); return;
      }
      const a=this.keymap[e.code]; if(!a || !this.enabled) return; if(e.code==='Space' || e.code==='Tab') e.preventDefault();
      if(e.repeat) return;
      this._keyDown(a); this._device('keyboard'); this.anyInputT = performance.now(); };
    const ku = (e)=>{ const a=this.keymap[e.code]; if(!a) return; this._keyUp(a); };
    addEventListener('keydown',kd); addEventListener('keyup',ku);
    addEventListener('blur',()=>{ for(const a of this._down) this._released.add(a); this._down.clear(); this._latched.clear(); });
    const pm = (e)=>{ const r=dom.getBoundingClientRect();
      this.pointerPx.set(e.clientX-r.left, e.clientY-r.top);
      this.pointer.set((this.pointerPx.x/r.width)*2-1, -(this.pointerPx.y/r.height)*2+1); this._device('keyboard'); };
    dom.addEventListener('pointermove',pm);
    const mouseAction = (b)=> b===0?'attack': b===2?'special': b===1?'cast':null;
    dom.addEventListener('pointerdown',(e)=>{ if(!this.enabled) return; pm(e);
      const a = mouseAction(e.button);
      if(!a) return;
      this._keyDown(a); this.anyInputT = performance.now(); });
    addEventListener('pointerup',(e)=>{ const a = mouseAction(e.button);
      if(!a) return;
      this._keyUp(a); });
    dom.addEventListener('contextmenu',e=>e.preventDefault());
    addEventListener('gamepadconnected',()=>{ this._device('gamepad'); });
  }
  _pollPad(){
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp=null; for(const p of pads) if(p && p.connected){ gp=p; break; }
    this._gp = gp; if(!gp) return;
    const dz=(v)=> Math.abs(v)<0.22?0:(v-Math.sign(v)*0.22)/0.78;
    const lx=dz(gp.axes[0]||0), ly=dz(gp.axes[1]||0);
    const rx=dz(gp.axes[2]||0), ry=dz(gp.axes[3]||0);
    let any = !!(lx||ly||rx||ry);
    for (let i = 0; i < gp.buttons.length && !any; i++) if (gp.buttons[i] && gp.buttons[i].pressed) any = true;
    if(any) { this._device('gamepad'); this.anyInputT = performance.now(); }
    if(this.usingGamepad){ this.rawMove.set(lx,-ly);
      if(rx||ry) this.lookVec.set(rx,-ry).normalize(); }
    const btn=(i,a)=>{ const p=gp.buttons[i]&&gp.buttons[i].pressed;
      if(p&&!this._padDown.has(i)){ this._padDown.add(i); this._keyDown(a); }
      else if(!p&&this._padDown.has(i)){ this._padDown.delete(i); this._keyUp(a); } };
    for (const a in PAD_BINDINGS) if (a !== 'boons') btn(PAD_BINDINGS[a], a);
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
