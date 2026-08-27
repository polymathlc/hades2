// OWNER: AGENT-RENDER — lighting/pipeline validation rig.
//
// Activated with `?renderdebug=1`. It builds a small set of plain, known-good
// primitives on LAYER 1 and switches the camera to that layer, together with the
// rig's own lights and atmosphere. Nothing outside src/render/** is touched:
// other agents' meshes simply are not on the layer, so they are not drawn.
//
// Why it exists: this pipeline has to be verifiable on its own. If a material,
// world or entity system is mid-refactor, `?renderdebug=1` still answers
// "is the LIGHT, CONTRAST, ATMOSPHERE and GRADE right?" — which is the only
// question this module owns.
import * as THREE from 'three';

export const DEBUG_LAYER = 1;

export class RenderDebugScene {
  constructor(){ this.root = null; this.enabled = false; }

  build(ctx){
    this.enabled = true;
    const rng = (ctx.rng && ctx.rng.fork) ? ctx.rng.fork('renderdebug') : { f: () => 0.5, range: (a, b) => (a + b) / 2 };
    const g = new THREE.Group();
    g.name = 'renderdebug';
    this.root = g;
    ctx.scene.add(g);

    const mk = (geo, opts, pos, cast = true, recv = false) => {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial(opts));
      m.position.set(pos[0], pos[1], pos[2]);
      m.castShadow = cast; m.receiveShadow = recv;
      g.add(m);
      return m;
    };

    // ── ground: a big matte plate so shadows and AO have somewhere to land ──
    const ground = mk(new THREE.CircleGeometry(17, 96),
      { color: '#3a1622', roughness: 0.88, metalness: 0.0 }, [0, 0, 0], false, true);
    ground.rotation.x = -Math.PI / 2;

    // low relief so the AO and the shadow terminator have real edges to bite on
    for(let i = 0; i < 26; i++){
      const a = (i / 26) * Math.PI * 2;
      const r = 6 + (i % 4) * 2.6;
      const h = 0.35 + (i % 3) * 0.28;
      const b = mk(new THREE.BoxGeometry(2.4, h, 2.4),
        { color: '#3a1622', roughness: 0.9, metalness: 0.0 },
        [Math.cos(a) * r, h / 2, Math.sin(a) * r], true, true);
      b.rotation.y = a;
    }

    // ── dielectric roughness sweep (validates the fill + rim + grade) ──────
    for(let i = 0; i < 5; i++){
      mk(new THREE.SphereGeometry(0.9, 32, 24),
        { color: '#8c3b46', roughness: 0.08 + i * 0.23, metalness: 0.0 },
        [-6 + i * 3, 0.9, -5]);
    }
    // ── metal roughness sweep (validates the procedural IBL) ──────────────
    for(let i = 0; i < 5; i++){
      mk(new THREE.SphereGeometry(0.9, 32, 24),
        { color: '#f2c14e', roughness: 0.10 + i * 0.20, metalness: 1.0 },
        [-6 + i * 3, 0.9, -8.5]);
    }

    // ── the "hero": a bright, high-chroma silhouette that must pop ────────
    const hero = mk(new THREE.CapsuleGeometry(0.46, 1.0, 12, 24),
      { color: '#efe3cf', roughness: 0.55, metalness: 0.0 }, [0, 1.0, 0]);
    hero.name = 'debug.hero';
    mk(new THREE.SphereGeometry(0.34, 24, 18),
      { color: '#c9b8ff', roughness: 0.3, metalness: 0.0 }, [0, 2.0, 0]);

    // ── gold ornament ring (filigree stand-in; shimmer / AA test) ─────────
    const ring = mk(new THREE.TorusGeometry(16, 0.42, 20, 160),
      { color: '#f2c14e', roughness: 0.26, metalness: 1.0 }, [0, 0.22, 0], true, false);
    ring.rotation.x = -Math.PI / 2;

    // slender columns: long readable shadows + vertical value structure
    for(let i = 0; i < 6; i++){
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const c = mk(new THREE.CylinderGeometry(0.55, 0.68, 6.4, 20),
        { color: '#5a2331', roughness: 0.8, metalness: 0.0 },
        [Math.cos(a) * 13.5, 3.2, Math.sin(a) * 13.5]);
      c.name = 'debug.column.' + i;
      mk(new THREE.BoxGeometry(1.7, 0.45, 1.7),
        { color: '#c98f2b', roughness: 0.3, metalness: 1.0 },
        [Math.cos(a) * 13.5, 6.6, Math.sin(a) * 13.5]);
    }

    // ── emissives: the only thing that should bloom ───────────────────────
    for(let i = 0; i < 4; i++){
      const a = (i / 4) * Math.PI * 2 + 0.8;
      const e = mk(new THREE.SphereGeometry(0.55, 24, 18),
        { color: '#2c1020', roughness: 0.5, metalness: 0.0,
          emissive: new THREE.Color('#ff7a30'), emissiveIntensity: 14.0 },
        [Math.cos(a) * 11, 1.7, Math.sin(a) * 11], false, false);
      e.name = 'debug.brazier.' + i;
    }
    // one cool emissive so the frame has a second hue
    mk(new THREE.IcosahedronGeometry(0.7, 1),
      { color: '#0d0b18', roughness: 0.2, metalness: 0.0,
        emissive: new THREE.Color('#5fd0ff'), emissiveIntensity: 9.0 },
      [0, 1.2, -13.0], false, false);

    // everything the rig owns goes on the debug layer
    g.traverse(o => o.layers.set(DEBUG_LAYER));
    if(ctx.lighting && ctx.lighting.group) ctx.lighting.group.traverse(o => o.layers.enable(DEBUG_LAYER));
    if(ctx.atmosphere && ctx.atmosphere.root) ctx.atmosphere.root.traverse(o => o.layers.enable(DEBUG_LAYER));
    ctx.camera.layers.set(DEBUG_LAYER);
    return this;
  }

  /** Called each frame: keep the rig's layers in sync as systems add lights. */
  sync(ctx){
    if(!this.enabled) return;
    if(ctx.lighting && ctx.lighting.group) ctx.lighting.group.traverse(o => o.layers.enable(DEBUG_LAYER));
    if(ctx.atmosphere && ctx.atmosphere.root) ctx.atmosphere.root.traverse(o => o.layers.enable(DEBUG_LAYER));
  }

  dispose(){
    if(!this.root) return;
    this.root.traverse(o => { if(o.isMesh){ o.geometry.dispose(); o.material.dispose(); } });
    this.root.parent?.remove(this.root);
    this.root = null;
  }
}
