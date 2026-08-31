// OWNER: AGENT-PERF
// ---------------------------------------------------------------------------
// scheduler.js — a frame-budgeted work queue.
//
// THE PROBLEM IT EXISTS FOR: a chamber rebuild is ~60-250ms of pure main-thread
// geometry synthesis. Run in one call it is a hard freeze; the browser drops
// ten to fifteen frames and the player reads it as "the game got stuck loading".
// Nothing about that work is urgent to the millisecond — it just has to be
// finished before the encounter opens.
//
// So: express the work as a GENERATOR whose yields are safe suspension points,
// hand it here, and pump it once per rendered frame with a millisecond budget.
// A 200ms job becomes ~15 frames that each run 1-6ms over, which is a soft
// ramp instead of a stall.
//
// Two lanes:
//   tasks — must finish, drained every frame until done (the chamber build).
//   idle  — nice to have, only pumped when the frame had headroom to spare
//           (GPU texture warm-up, shader pre-compilation, deferred disposal).
// ---------------------------------------------------------------------------

export const nowMs = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

let _id = 1;

/** One suspendable unit of work wrapped around a generator. */
export class SlicedTask {
  constructor(gen, opts = {}) {
    this.id = _id++;
    this.gen = gen;
    this.label = opts.label || 'task';
    this.onStep = opts.onStep || null;
    this.onDone = opts.onDone || null;
    this.done = false;
    this.cancelled = false;
    this.steps = 0;
    this.ms = 0;
    this.longestStepMs = 0;
  }

  /** Advance one yield-to-yield slice. Returns true while work remains. */
  step() {
    if (this.done) return false;
    const t0 = nowMs();
    let res;
    try {
      res = this.gen.next();
    } catch (e) {
      this.done = true;
      console.error('[scheduler] task failed:', this.label, e);
      return false;
    }
    const dt = nowMs() - t0;
    this.steps++;
    this.ms += dt;
    if (dt > this.longestStepMs) this.longestStepMs = dt;
    if (this.onStep) this.onStep(this, res && res.value, dt);
    if (res.done) {
      this.done = true;
      if (this.onDone) this.onDone(this);
      return false;
    }
    return true;
  }

  /** Run to completion right now — the synchronous fallback path. */
  finish() {
    let guard = 100000;
    while (!this.done && guard-- > 0) this.step();
    return this;
  }

  cancel() {
    if (this.done) return this;
    this.cancelled = true;
    this.done = true;
    try { this.gen.return?.(); } catch (e) { /* generator already closed */ }
    return this;
  }
}

export class FrameScheduler {
  constructor(opts = {}) {
    // 5ms leaves a 60Hz frame ~11ms of its own work before it slips a vsync,
    // and still drains a 200ms build in a third of a second.
    this.budgetMs = opts.budgetMs ?? 5;
    this.idleBudgetMs = opts.idleBudgetMs ?? 2;
    this.tasks = [];
    this.idle = [];
    this.stats = { steps: 0, ms: 0, longestPumpMs: 0 };
  }

  get busy() { return this.tasks.length > 0; }
  get pendingIdle() { return this.idle.length; }

  /** Queue a generator as a must-finish task. */
  add(gen, opts = {}) {
    const t = new SlicedTask(gen, opts);
    this.tasks.push(t);
    return t;
  }

  /** Queue a one-shot function that only runs when a frame has slack. */
  addIdle(fn, label = 'idle') {
    if (typeof fn === 'function') this.idle.push({ fn, label });
    return this;
  }

  cancelAll() {
    for (const t of this.tasks) t.cancel();
    this.tasks.length = 0;
    this.idle.length = 0;
    return this;
  }

  /**
   * Pump the must-finish lane. `budgetMs` is a soft budget: one slice always
   * runs (otherwise a task whose smallest slice is 8ms would never advance),
   * and the loop stops as soon as the budget is spent.
   */
  run(budgetMs = this.budgetMs) {
    if (!this.tasks.length) return 0;
    const t0 = nowMs();
    let spent = 0;
    while (this.tasks.length) {
      const task = this.tasks[0];
      if (task.done || task.cancelled) { this.tasks.shift(); continue; }
      task.step();
      this.stats.steps++;
      spent = nowMs() - t0;
      if (task.done) this.tasks.shift();
      if (spent >= budgetMs) break;
    }
    this.stats.ms += spent;
    if (spent > this.stats.longestPumpMs) this.stats.longestPumpMs = spent;
    return spent;
  }

  /** Pump the idle lane. Skipped entirely when the frame is already late. */
  runIdle(budgetMs = this.idleBudgetMs) {
    if (!this.idle.length || budgetMs <= 0) return 0;
    const t0 = nowMs();
    let spent = 0;
    while (this.idle.length) {
      const job = this.idle.shift();
      try { job.fn(); } catch (e) { console.warn('[scheduler] idle job failed:', job.label, e); }
      spent = nowMs() - t0;
      if (spent >= budgetMs) break;
    }
    return spent;
  }
}

export default FrameScheduler;
