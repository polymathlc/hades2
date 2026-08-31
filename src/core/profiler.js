// OWNER: AGENT-PERF
// ---------------------------------------------------------------------------
// profiler.js — main-thread frame-time instrumentation.
//
// "The game feels laggy" is not a bug report you can act on. This turns it into
// numbers: the longest single frame, the p95, how many frames blew the 16.7ms
// budget, and named SPANS (a chamber transition) plus named SECTIONS (a chamber
// build step, a synchronous texture bake) so a spike can be attributed to the
// thing that caused it rather than guessed at.
//
// It is deliberately allocation-free per frame (one push into a ring buffer)
// and is safe to leave enabled in a shipping build; scripts/test-perf.mjs reads
// exactly the same counters the browser does.
// ---------------------------------------------------------------------------

import { nowMs } from './scheduler.js';

export class Profiler {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.capacity = opts.capacity || 4096;
    this.frames = new Float64Array(this.capacity);
    this.n = 0;
    this.sections = new Map();   // name -> { calls, ms, max }
    this.spans = new Map();      // name -> { t0, ms, frames, longestFrameMs, closed }
    this._open = new Map();
  }

  reset() {
    this.n = 0;
    this.sections.clear();
    this.spans.clear();
    this._open.clear();
    return this;
  }

  /** Record one rendered frame's main-thread busy time, in ms. */
  frame(ms) {
    if (!this.enabled) return;
    if (this.n < this.capacity) this.frames[this.n++] = ms;
    for (const s of this._open.values()) {
      s.frames++;
      if (ms > s.longestFrameMs) s.longestFrameMs = ms;
    }
  }

  /** Accumulate time against a named section (build step, bake, dispose…). */
  section(name, ms) {
    if (!this.enabled) return;
    let s = this.sections.get(name);
    if (!s) this.sections.set(name, s = { calls: 0, ms: 0, max: 0 });
    s.calls++; s.ms += ms;
    if (ms > s.max) s.max = ms;
  }

  /** Time `fn` into a named section and return its result. */
  measure(name, fn) {
    if (!this.enabled) return fn();
    const t0 = nowMs();
    try { return fn(); } finally { this.section(name, nowMs() - t0); }
  }

  /** Open a wall-clock span (e.g. a boss-death -> next-chamber transition). */
  spanStart(name) {
    if (!this.enabled) return;
    const s = { t0: nowMs(), ms: 0, frames: 0, longestFrameMs: 0, closed: false };
    this.spans.set(name, s);
    this._open.set(name, s);
  }

  spanEnd(name) {
    if (!this.enabled) return null;
    const s = this._open.get(name);
    if (!s) return null;
    s.ms = nowMs() - s.t0;
    s.closed = true;
    this._open.delete(name);
    return s;
  }

  spanActive(name) { return this._open.has(name); }

  /** Frame statistics over everything recorded since the last reset. */
  frameStats() {
    const n = this.n;
    if (!n) return { frames: 0, longestMs: 0, p50: 0, p95: 0, p99: 0, meanMs: 0, over16: 0, over33: 0 };
    const a = Array.prototype.slice.call(this.frames.subarray(0, n)).sort((x, y) => x - y);
    let sum = 0, over16 = 0, over33 = 0;
    for (let i = 0; i < n; i++) { sum += a[i]; if (a[i] > 16.7) over16++; if (a[i] > 33.3) over33++; }
    const q = (p) => a[Math.min(n - 1, Math.floor(p * (n - 1)))];
    return {
      frames: n, longestMs: a[n - 1], p50: q(0.5), p95: q(0.95), p99: q(0.99),
      meanMs: sum / n, over16, over33,
    };
  }

  report() {
    const sections = {};
    for (const [k, v] of this.sections) sections[k] = { calls: v.calls, ms: +v.ms.toFixed(2), max: +v.max.toFixed(2) };
    const spans = {};
    for (const [k, v] of this.spans) {
      spans[k] = {
        ms: +(v.closed ? v.ms : nowMs() - v.t0).toFixed(2),
        frames: v.frames, longestFrameMs: +v.longestFrameMs.toFixed(2), closed: v.closed,
      };
    }
    return { frame: this.frameStats(), sections, spans };
  }
}

/** The process-wide instance every system reports into. */
export const profiler = new Profiler();

export default profiler;
