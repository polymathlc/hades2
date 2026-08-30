import { EventBus } from './events.js';
import { RNG } from './rng.js';
import { Input } from './input.js';
import { clamp } from './math.js';

export class Engine {
  constructor(opts={}){
    const tier = opts.quality?.tier || 'high';
    // Rendering quality must not silently double gameplay CPU cost.  High is
    // the automatic desktop tier, and 120 Hz made every AI, collision, status
    // and projectile system run twice per displayed 60 Hz frame.  Reserve the
    // 120 Hz simulation for explicitly selected Ultra/capture; all ordinary
    // browser tiers remain responsive at 60 Hz and have bounded catch-up work.
    this.fixedDt = tier === 'ultra' ? 1/120 : 1/60;
    this.maxSubSteps = tier === 'low' ? 3 : tier === 'med' ? 4 : tier === 'high' ? 5 : 8;
    this.systems = [];
    this._acc = 0; this._last = 0; this._raf = 0; this.running = false; this.skipRender = false;
    this.ctx = {
      engine: this,
      time: { t:0, dt:0, fixedDt:this.fixedDt, frame:0, scale:1, unscaledT:0, unscaledDt:0 },
      rng: new RNG(opts.seed ?? 1337),
      events: new EventBus(),
      input: new Input(),
      quality: opts.quality || {},
      capture: null,
      paused: false,
    };
    this._hitstop = 0; this._slowmo = { t:0, dur:0, scale:1 };
    this.ctx.events.on('hit.stop', ({ms})=> this.hitstop(ms));
    this.perf = { fps:60, ms:0, _acc:0, _n:0 };
  }
  add(system, name){ this.systems.push(system); if(name) this.ctx[name]=system; return system; }
  async initAll(){ for(const s of this.systems){ if(s.init) await s.init(this.ctx); } }
  hitstop(ms){
    // Hit-stop sets time.scale to 0, which is correct in play but wrong under the headless capture
    // harness: capture.step(seconds) advances the simulation by a fixed number of steps, so a
    // fight that lands hits silently delivers less simulated time than asked for and any
    // absolutely-scheduled capture scenario misses its shutter. Reported by AGENT-COMBAT.
    if (this.ctx.CAPTURE) return;
    this._hitstop = Math.max(this._hitstop, ms/1000);
  }
  slowmo(scale, dur){ if (this.ctx.CAPTURE) return; this._slowmo = { t:0, dur, scale }; }
  start(){ if(this.running) return; this.running=true; this._last = performance.now()/1000;
    const loop = ()=>{ this._raf = requestAnimationFrame(loop); this.frame(); };
    this._raf = requestAnimationFrame(loop); }
  stop(){ this.running=false; cancelAnimationFrame(this._raf); }

  // one real frame (variable dt) -> N fixed sim steps + 1 render
  frame(now){
    const T = (now ?? performance.now())/1000;
    let dt = clamp(T - this._last, 0, 0.25); this._last = T;
    this.step(dt);
  }
  // deterministic entry point used by the capture harness
  step(dt){
    const c = this.ctx, t = c.time;
    t.unscaledDt = dt; t.unscaledT += dt;
    let scale = 1;
    if(this._hitstop > 0){ this._hitstop -= dt; scale = 0; }
    else if(this._slowmo.dur > 0){ this._slowmo.t += dt;
      const k = Math.min(1, this._slowmo.t/this._slowmo.dur);
      scale = this._slowmo.scale + (1-this._slowmo.scale)*k*k;
      if(k>=1) this._slowmo.dur = 0; }
    if(c.paused) scale = 0;
    t.scale = scale;
    const sdt = dt*scale;
    c.input.begin();
    this._acc += sdt;
    let steps = 0;
    while(this._acc >= this.fixedDt && steps < this.maxSubSteps){
      this._acc -= this.fixedDt; steps++;
      t.dt = this.fixedDt; t.t += this.fixedDt; t.frame++;
      for(const s of this.systems) if(s.update) s.update(this.fixedDt, c);
      // Press/release edges belong to one simulation step, not one rendered
      // frame. A catch-up frame can run several fixed steps; exposing the same
      // edge to all of them queued duplicate attacks. Conversely, when a fast
      // render frame runs zero steps the edge must survive until simulation
      // actually consumes it.
      if(steps === 1) c.input.end();
    }
    if(steps >= this.maxSubSteps) this._acc = 0;
    const alpha = this._acc / this.fixedDt;
    t.alpha = alpha; t.renderDt = dt;
    for(const s of this.systems) if(s.lateUpdate) s.lateUpdate(alpha, c);
    if(!this.skipRender) for(const s of this.systems) if(s.render) s.render(c);
    this.perf._acc += dt; this.perf._n++;
    if(this.perf._acc >= 0.5){ this.perf.fps = this.perf._n/this.perf._acc; this.perf.ms = 1000*this.perf._acc/this.perf._n; this.perf._acc=0; this.perf._n=0; }
  }
  resize(w,h){ for(const s of this.systems) if(s.resize) s.resize(w,h,this.ctx); }
}
