// OWNER: AGENT-PLAYER — STUB isometric follow camera.
import * as THREE from 'three';
import { springDamp, clamp, damp } from '../core/math.js';
export class CameraRig {
  constructor(){ this.target=new THREE.Vector3(); this.pos=new THREE.Vector3(0,0,0); this.vel=new THREE.Vector3();
    this.dist=26; this.pitch=52*Math.PI/180; this.yaw=Math.PI/4; this.shake=0; this.shakeT=0; }
  async init(ctx){ this.ctx=ctx; this.cam=ctx.camera;
    ctx.events.on('camera.shake',({amp,dur})=>{ this.shake=Math.max(this.shake,amp); this.shakeT=dur||0.35; }); }
  lateUpdate(alpha, ctx){
    const p = ctx.player && ctx.player.position ? ctx.player.position : new THREE.Vector3();
    const dt = ctx.time.renderDt || 1/60;
    for(const ax of ['x','y','z']){
      const [v,vel]=springDamp(this.pos[ax], this.vel[ax], p[ax], 0.22, dt);
      this.pos[ax]=v; this.vel[ax]=vel;
    }
    const d=this.dist, ph=this.pitch, yw=this.yaw;
    const off=new THREE.Vector3(Math.sin(yw)*Math.cos(ph), Math.sin(ph), Math.cos(yw)*Math.cos(ph)).multiplyScalar(d);
    this.cam.position.copy(this.pos).add(off);
    if(this.shakeT>0){ this.shakeT-=dt; const k=this.shake*Math.max(0,this.shakeT)/0.35;
      this.cam.position.x+=(Math.sin(ctx.time.unscaledT*61)*k); this.cam.position.y+=(Math.sin(ctx.time.unscaledT*47)*k);
      if(this.shakeT<=0) this.shake=0; }
    this.cam.lookAt(this.pos.x, this.pos.y+1.0, this.pos.z);
  }
}
