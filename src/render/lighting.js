// OWNER: AGENT-RENDER — STUB light rig.
import * as THREE from 'three';
export class LightRig {
  async init(ctx){
    this.group = new THREE.Group(); ctx.scene.add(this.group);
    this.key = new THREE.DirectionalLight('#ff8a5c', 2.2);
    this.key.position.set(8,14,6); this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048,2048);
    const d=22; Object.assign(this.key.shadow.camera,{left:-d,right:d,top:d,bottom:-d,near:1,far:60});
    this.key.shadow.bias = -0.0008; this.key.shadow.normalBias = 0.02;
    this.hemi = new THREE.HemisphereLight('#5a6cff','#1a0a18', 0.55);
    this.group.add(this.key, this.key.target, this.hemi);
    ctx.scene.fog = new THREE.FogExp2('#150b20', 0.018);
  }
  setBiome(name, ctx){ this.biome = name; }
  update(dt, ctx){}
}
