// OWNER: AGENT-WORLD — STUB. Replace with full chamber generation + ornate architecture kit.
import * as THREE from 'three';
export class World {
  constructor(){ this.root=new THREE.Group(); this.colliders=[]; this.bounds={r:16}; this.biome='tartarus'; }
  async init(ctx){
    this.ctx=ctx; ctx.scene.add(this.root);
    this.build(ctx);
  }
  build(ctx){
    const floor = new THREE.Mesh(new THREE.CircleGeometry(16,96), ctx.mats.get('floor.tartarus'));
    floor.rotation.x = -Math.PI/2; floor.receiveShadow = true;
    this.root.add(floor);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(16,0.45,16,128), ctx.mats.get('gold.filigree'));
    ring.rotation.x = -Math.PI/2; ring.position.y=0.1; ring.castShadow=true;
    this.root.add(ring);
  }
  // world query API used by entities
  clampToArena(v3, radius=0.4){ const r=this.bounds.r-radius; const d=Math.hypot(v3.x,v3.z);
    if(d>r){ const k=r/d; v3.x*=k; v3.z*=k; } return v3; }
  heightAt(x,z){ return 0; }
  setBiome(name, ctx){ this.biome=name; }
  update(dt,ctx){}
}
