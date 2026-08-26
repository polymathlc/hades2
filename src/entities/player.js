// OWNER: AGENT-PLAYER — STUB. Replace with full Hades-style controller + procedural character.
import * as THREE from 'three';
import { damp, clamp } from '../core/math.js';
export class Player {
  constructor(){ this.position=new THREE.Vector3(0,0,0); this.velocity=new THREE.Vector3();
    this.radius=0.45; this.health=100; this.maxHealth=100; this.mana=100; this.maxMana=100;
    this.facing=new THREE.Vector2(0,1); this.speed=8.5; this.alive=true; this.iframes=0; }
  async init(ctx){
    this.ctx=ctx;
    this.root=new THREE.Group(); ctx.scene.add(this.root);
    const body=new THREE.Mesh(new THREE.CapsuleGeometry(0.42,0.9,8,16), ctx.mats.get('marble.elysium'));
    body.position.y=1.0; body.castShadow=true; this.root.add(body); this.body=body;
  }
  update(dt, ctx){
    if(!this.alive) return;
    const mv=ctx.input.move;
    // screen-space -> world-space (camera yaw 45deg)
    const yaw=ctx.cameraRig? ctx.cameraRig.yaw : Math.PI/4;
    const cs=Math.cos(yaw), sn=Math.sin(yaw);
    const wx = mv.x*cs + mv.y*sn, wz = -mv.x*sn + mv.y*cs;
    const want=new THREE.Vector3(wx,0,wz).multiplyScalar(this.speed);
    this.velocity.x=damp(this.velocity.x,want.x,18,dt);
    this.velocity.z=damp(this.velocity.z,want.z,18,dt);
    this.position.addScaledVector(this.velocity,dt);
    if(ctx.world) ctx.world.clampToArena(this.position,this.radius);
    if(mv.lengthSq()>0.001){ this.facing.set(wx,wz).normalize(); }
    this.iframes=Math.max(0,this.iframes-dt);
  }
  lateUpdate(alpha, ctx){ this.root.position.copy(this.position);
    this.root.rotation.y=Math.atan2(this.facing.x,this.facing.y); }
}
