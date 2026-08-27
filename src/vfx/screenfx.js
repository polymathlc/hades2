// OWNER: AGENT-VFX
// ---------------------------------------------------------------------------
// THE FEEL LAYER (ART_DIRECTION §5 last bullet).
//
// Nothing here draws a pixel of its own. It listens to the combat event bus and
// converts damage into *time and camera* — the half of Hades' impact that is
// not a particle. Everything is emitted through the canonical events in
// ARCHITECTURE §2.5 so the engine and the camera rig stay the owners:
//
//   hit.stop      -> engine.hitstop()  (40–90 ms on heavy hits)
//   camera.shake  -> CameraRig.shake() (decaying NOISE, never a sine)
//   ctx.post.pulse / .flash            (chromatic + radial kick, damage flash)
//
// Every ctx.post call is guarded with ?. — the post stack is another agent's
// file and may not expose every method on any given build.
// ---------------------------------------------------------------------------

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export class ScreenFX {
  constructor() {
    this.enabled = true;
    this.lowHealth = 0;          // 0..1 how deep into the danger band we are
    this._vigBase = null;
    this._vigT = 0;
    this._slowmoCooldown = 0;
    this._shakeBudget = 0;       // stops a 10-hit combo stacking into a earthquake
    this._offs = [];
  }

  init(ctx) {
    this.ctx = ctx;
    const on = (n, f) => this._offs.push(ctx.events.on(n, f));

    on('damage.dealt', (d) => this.onDamage(d));
    on('entity.died', (d) => this.onDeath(d));
    on('room.cleared', () => this.onRoomCleared());
    on('player.hurt', (d) => this.onPlayerHurt(d));
    on('player.health', (d) => { if (d && d.max) this.setHealth(d.cur, d.max); });
    return this;
  }

  // ── primitives ───────────────────────────────────────────────────────────
  hitstop(ms) {
    if (!this.enabled || !(ms > 0)) return;
    this.ctx.events.emit('hit.stop', { ms: clamp(ms, 8, 140) });
  }
  shake(amp, dur = 0.24, freq = 30) {
    if (!this.enabled || !(amp > 0)) return;
    // budget: successive hits inside one combo add sub-linearly
    const k = 1 / (1 + this._shakeBudget * 0.9);
    this._shakeBudget += amp;
    this.ctx.events.emit('camera.shake', { amp: amp * k, dur, freq });
  }
  pulse(chroma = 1, radial = 0.5, dur = 0.18) {
    if (!this.enabled) return;
    this.ctx.post?.pulse?.({ chroma, radial, dur });
  }
  flash(color = '#ffffff', intensity = 0.5, dur = 0.2) {
    if (!this.enabled) return;
    this.ctx.post?.flash?.({ color, intensity, dur, falloff: 0.55 });
  }
  slowmo(scale = 0.35, dur = 0.5) {
    if (!this.enabled || this._slowmoCooldown > 0) return;
    this._slowmoCooldown = 2.5;
    this.ctx.engine?.slowmo?.(scale, dur);
  }

  // ── reactions ────────────────────────────────────────────────────────────
  /**
   * Weight of a hit, 0..1. Heavy hits get the full chromatic/radial treatment;
   * chip damage gets a frame of stop and nothing else, or the screen never
   * settles and the impact stops meaning anything.
   */
  onDamage(d) {
    if (!d || !this.enabled) return;
    const player = this.ctx.player;
    if (d.target === player) return;             // handled by onPlayerHurt
    const amt = d.amount || 0;
    const w = clamp(amt / 42, 0.12, 1) * (d.crit ? 1.45 : 1);
    // §5: 40–90 ms on heavy hits.
    this.hitstop(26 + 62 * w * w);
    this.shake(0.055 + 0.13 * w, 0.16 + 0.16 * w, 30 - 6 * w);
    if (w > 0.55 || d.crit) {
      this.pulse(0.85 * w, 0.45 * w, 0.13 + 0.09 * w);
    }
    if (d.crit) this.flash(d.color || '#fff2cf', 0.16 * w, 0.13);
  }

  onPlayerHurt(d) {
    const amt = (d && d.amount) || 0;
    const w = clamp(amt / 35, 0.2, 1);
    this.hitstop(30 + 40 * w);
    this.shake(0.10 + 0.16 * w, 0.30, 24);
    this.pulse(1.0, 0.8 * w, 0.26);
    this.flash('#c81d3c', 0.30 * w + 0.10, 0.30);
  }

  onDeath(d) {
    if (!d || d.entity === this.ctx.player) return;
    this.hitstop(52);
    this.shake(0.14, 0.34, 26);
    this.pulse(0.8, 0.5, 0.2);
  }

  /** The killing blow that empties a room gets the money slow-mo. */
  onRoomCleared() {
    this.slowmo(0.30, 0.85);
    this.pulse(1.0, 0.85, 0.42);
    this.flash('#ffe9a8', 0.18, 0.5);
    this.shake(0.10, 0.5, 18);
  }

  setHealth(cur, max) {
    if (!(max > 0)) return;
    const f = clamp(cur / max, 0, 1);
    this.lowHealth = f < 0.34 ? (0.34 - f) / 0.34 : 0;
  }

  update(dt) {
    this._shakeBudget = Math.max(0, this._shakeBudget - dt * 1.6);
    if (this._slowmoCooldown > 0) this._slowmoCooldown -= dt;

    // ── low-health vignette pulse ──
    // The post stack owns the vignette; we borrow its live parameter block and
    // always restore the value we found, so a build without it just no-ops.
    const p = this.ctx.post?.params?.vignette;
    if (p && typeof p.depth === 'number') {
      if (this._vigBase === null) this._vigBase = p.depth;
      if (this.lowHealth > 0.001) {
        this._vigT += dt * (2.0 + 3.4 * this.lowHealth);
        const beat = 0.5 + 0.5 * Math.sin(this._vigT);
        p.depth = this._vigBase + this.lowHealth * (0.10 + 0.16 * beat * beat);
      } else if (p.depth !== this._vigBase) {
        p.depth += (this._vigBase - p.depth) * Math.min(1, dt * 6);
        if (Math.abs(p.depth - this._vigBase) < 0.001) p.depth = this._vigBase;
      }
    }
  }

  dispose() { for (const off of this._offs) { try { off(); } catch (e) { /* noop */ } } this._offs.length = 0; }
}

export default ScreenFX;
