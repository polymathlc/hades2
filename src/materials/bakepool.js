// OWNER: AGENT-MATERIAL
// ---------------------------------------------------------------------------
// bakepool.js — a tiny fixed worker pool for texture synthesis.
//
// Texture synthesis is pure CPU work on typed arrays with no shared state, so
// it is embarrassingly parallel; the only reason it ever blocked boot is that
// it was all on one thread. This hands each recipe to a free worker, longest
// job first, and resolves when the last one lands.
//
// It is deliberately paranoid: if Workers are unavailable, or a module worker
// fails to construct (older Safari, a file:// page, a strict CSP), `available`
// goes false and MaterialLibrary bakes on the main thread exactly as before.
// A slow boot is a bad frame; a missing texture is a broken game.
// ---------------------------------------------------------------------------

export class BakePool {
  constructor(size) {
    this.available = false;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this._id = 1;
    const hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    // Use every core. The main thread is *awaiting* this pool during boot, so a
    // core held back for it would simply idle; the world build that needs the
    // main thread does not start until the surfaces exist.
    const n = Math.max(1, Math.min(size || 8, hw));
    if (typeof Worker === 'undefined') return;
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('./texworker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this._onDone(w, e.data);
        w.onerror = () => this._fail(w);
        this.workers.push(w);
        this.idle.push(w);
      } catch (e) { break; }
    }
    this.available = this.workers.length > 0;
  }

  get size() { return this.workers.length; }

  /** Bake one recipe. Resolves with the raw byte-buffer set, or null on failure. */
  bake(key, n) {
    if (!this.available) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.queue.push({ key, n, resolve });
      this._pump();
    });
  }

  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop();
      const job = this.queue.shift();
      const id = this._id++;
      this.pending.set(id, { job, worker: w });
      try { w.postMessage({ id, key: job.key, n: job.n }); }
      catch (e) { this.pending.delete(id); this.idle.push(w); job.resolve(null); }
    }
  }

  _onDone(w, msg) {
    const rec = this.pending.get(msg && msg.id);
    if (!rec) return;
    this.pending.delete(msg.id);
    this.idle.push(w);
    rec.job.resolve(msg.ok ? msg.set : null);
    this._pump();
  }

  /** A worker died — retire it and let every job it owned fall back to sync. */
  _fail(w) {
    const i = this.workers.indexOf(w);
    if (i >= 0) this.workers.splice(i, 1);
    const j = this.idle.indexOf(w);
    if (j >= 0) this.idle.splice(j, 1);
    for (const [id, rec] of [...this.pending]) {
      if (rec.worker === w) { this.pending.delete(id); rec.job.resolve(null); }
    }
    if (!this.workers.length) {
      this.available = false;
      for (const job of this.queue.splice(0)) job.resolve(null);
    } else this._pump();
  }

  dispose() {
    for (const w of this.workers) { try { w.terminate(); } catch (e) { /* gone already */ } }
    this.workers.length = 0; this.idle.length = 0;
    this.available = false;
  }
}

export default BakePool;
