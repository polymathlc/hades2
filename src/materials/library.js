// OWNER: AGENT-MATERIAL — STUB. Replace with full procedural painterly PBR synthesis.
import * as THREE from 'three';
const FALLBACK = {
  'stone.tartarus':{color:'#5a2331',rough:0.85,metal:0.0},
  'stone.asphodel':{color:'#2a2740',rough:0.7,metal:0.0},
  'marble.elysium':{color:'#efe3cf',rough:0.45,metal:0.0},
  'obsidian':{color:'#0d0b18',rough:0.25,metal:0.1},
  'gold.filigree':{color:'#f2c14e',rough:0.28,metal:1.0},
  'bronze.verdigris':{color:'#3f8f7a',rough:0.55,metal:0.8},
  'bone':{color:'#e8dcc0',rough:0.7,metal:0.0},
  'lava':{color:'#ff8c1a',rough:0.6,metal:0.0,emissive:'#ff5a00',ei:2.5},
  'blood.pool':{color:'#5c0d1c',rough:0.15,metal:0.0},
  'floor.tartarus':{color:'#3a1622',rough:0.8,metal:0.0},
  'floor.asphodel':{color:'#191830',rough:0.6,metal:0.0},
  'floor.elysium':{color:'#d9cdb8',rough:0.5,metal:0.0},
  'banner.crimson':{color:'#8c1128',rough:0.9,metal:0.0},
  'wood.dark':{color:'#3a2416',rough:0.85,metal:0.0},
  'iron.dark':{color:'#2a2630',rough:0.5,metal:0.9},
  'crystal.violet':{color:'#a05fe0',rough:0.1,metal:0.0,emissive:'#7a2fd0',ei:1.2},
  'water.styx':{color:'#0d2a26',rough:0.05,metal:0.2},
};
export class MaterialLibrary {
  constructor(){ this.cache=new Map(); this.texCache=new Map(); }
  async init(ctx){ this.ctx=ctx; }
  get(name, opts={}){
    const key = name + JSON.stringify(opts);
    if(this.cache.has(key)) return this.cache.get(key);
    const d = FALLBACK[name] || {color:'#888888',rough:0.7,metal:0};
    const m = new THREE.MeshStandardMaterial({
      color:new THREE.Color(d.color), roughness:d.rough, metalness:d.metal,
      emissive:d.emissive?new THREE.Color(d.emissive):new THREE.Color(0),
      emissiveIntensity:d.ei||0, ...opts,
    });
    m.name = name; this.cache.set(key,m); return m;
  }
  tex(name, opts={}){ return null; }
  dispose(){ for(const m of this.cache.values()) m.dispose(); this.cache.clear(); }
}
